from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import patch

from scripts.actor_registry import ActorError, create_actor
from scripts.publication_ledger import (
    PublicationError,
    PublicationLockTimeout,
    current_publication_state,
    read_publication_journal,
)
from scripts.publish_gtfs import (
    publish_dataset,
    publications_summary,
    revert_publication,
    verify_published_snapshot,
)
from scripts.review_gtfs import ReviewError, approve_dataset
from scripts.snapshot_gtfs import (
    build_snapshot,
    connect_read_only,
    dataset_tables,
    list_routes,
    list_snapshots,
    resolve_active_snapshot,
    route_detail,
    search_stops,
    stop_detail,
    stops_near,
    verify_snapshot,
)
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_stage_gtfs import NOW, VALID_METADATA

from auth_helpers import actor_token, proof

PUBLISH_TABLES: dict[str, str] = {
    "agency.txt": (
        "agency_id,agency_name,agency_url,agency_timezone\n"
        "DKS,Réseau de démonstration,https://example.invalid,Africa/Dakar\n"
    ),
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type\n"
        "S1,Place de la Nation,14.7200,-17.4500,0\n"
        "S2,Gare Routière Leclerc,14.7050,-17.4600,0\n"
        "S3,Palais de Justice,14.7300,-17.4400,0\n"
        "S4,Terminus Yoff,14.7500,-17.4800,1\n"
    ),
    "routes.txt": (
        "route_id,agency_id,route_short_name,route_long_name,route_type\n"
        "R1,DKS,1,Nation - Yoff,3\n"
        "R2,DKS,2,Leclerc - Palais,3\n"
    ),
    "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,WK,T1,0,SH1\nR1,WK,T2,1,\nR2,WK,T3,0,\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,S1,1\n"
        "T1,08:20:00,08:20:00,S4,2\n"
        "T2,09:00:00,09:00:00,S4,1\n"
        "T2,09:25:00,09:25:00,S1,2\n"
        "T3,10:00:00,10:00:00,S2,1\n"
        "T3,10:15:00,10:15:00,S3,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260101,20261231\n"
    ),
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH1,14.7200,-17.4500,1\nSH1,14.7500,-17.4800,2\n",
}

FULL_ATTESTATIONS: dict[str, dict[str, str | None]] = {
    "source_identity": {"evidence": "Source confirmée auprès de l’éditeur du flux.", "reference": "https://example.invalid/feed"},
    "reuse_rights": {"evidence": "Licence ouverte vérifiée sur la page de la source.", "reference": None},
    "operator_confirmed": {"evidence": "Opérateur confirmé, réseau distinct d’AFTU.", "reference": None},
    "service_operational": {"evidence": "Service exploité constaté aux dates déclarées.", "reference": None},
    "freshness_confirmed": {"evidence": "Période de validité confirmée avec la source.", "reference": None},
}
REVIEWER = "fatou.ndiaye"
PUBLISHER = "ousmane.fall"
NOTE = "Première publication du jeu de démonstration."
REASON = "Période de validité contestée par la source."


class PublishFixtures(unittest.TestCase):
    """Shared staging helpers: every test builds its own throwaway store."""

    def stage_feed(
        self,
        directory: str,
        *,
        version: str = "publish-v1",
        tables: dict[str, str] | None = None,
        approved: bool = True,
        **overrides: Any,
    ) -> tuple[Path, Path, str]:
        archive_path = Path(directory) / f"{version}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in (tables or PUBLISH_TABLES).items():
                archive.writestr(name, content)
        metadata = IngestMetadata(
            **{
                **VALID_METADATA.__dict__,
                "dataset_version": version,
                "source_type": "OFFICIAL",
                "operator": "Réseau de démonstration",
                "service_status": "ACTIVE",
                **overrides,
            }
        )
        staging = Path(directory) / "staging"
        staged = stage_gtfs_archive(archive_path, staging, metadata, now=NOW)
        self.assertTrue(staged["staged"], staged)
        dataset_id = str(staged["dataset_id"])
        if approved:
            approve_dataset(staging, dataset_id, proof=proof(REVIEWER, "reviewer"), attestations=FULL_ATTESTATIONS, now=NOW)
        return staging, Path(directory) / "published", dataset_id

    def published_feed(self, directory: str, **overrides: Any) -> tuple[Path, Path, str, str]:
        staging, published, dataset_id = self.stage_feed(directory, **overrides)
        result = publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
        return staging, published, dataset_id, str(result["snapshot_id"])


class GTFSPublicationTests(PublishFixtures):
    def test_publishing_freezes_a_hashed_snapshot_and_records_one_entry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory)
            result = publish_dataset(
                staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW
            )

            self.assertEqual(result["publication_status"], "PUBLISHED")
            self.assertFalse(result["realtime"])
            snapshot_id = str(result["snapshot_id"])
            snapshot_dir = published / snapshot_id
            self.assertTrue((snapshot_dir / "network.sqlite").is_file())
            manifest = json.loads((snapshot_dir / "manifest.json").read_text(encoding="utf-8"))
            # Building a snapshot is not publishing it: the journal decides.
            self.assertEqual(manifest["publication_status"], "NOT_PUBLISHED")
            self.assertFalse(manifest["realtime"])
            self.assertEqual(manifest["dataset"]["dataset_id"], dataset_id)
            self.assertEqual(manifest["review"]["reviewer_id"], REVIEWER)

            journal = read_publication_journal(published)
            self.assertEqual(journal["integrity"], "OK")
            self.assertEqual(len(journal["entries"]), 1)
            entry = journal["entries"][0]
            self.assertEqual(entry["action"], "PUBLISH")
            self.assertEqual(entry["entry_id"], "pub-000001")
            self.assertEqual(entry["publisher_id"], PUBLISHER)
            self.assertEqual(entry["reviewer_id"], REVIEWER)
            self.assertTrue(entry["separation_of_duties"])
            self.assertEqual(entry["database_sha256"], manifest["store"]["sha256"])
            self.assertEqual(entry["publication_status"], "PUBLISHED")

            verification = verify_published_snapshot(published, snapshot_id)
            self.assertTrue(verification["verified"])
            self.assertEqual(verification["publication_status"], "ACTIVE")
            self.assertTrue(verification["served"])

            # The staging manifest is never rewritten by a publication.
            staged_manifest = json.loads((staging / dataset_id / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(staged_manifest["publication_status"], "NOT_PUBLISHED")
            self.assertEqual(staged_manifest["review_status"], "PENDING_REVIEW")

    def test_publish_refuses_a_version_that_is_not_approved_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory, approved=False)
            with self.assertRaises(PublicationError) as caught:
                publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)

            self.assertEqual(caught.exception.code, "DATASET_NOT_PUBLISHABLE")
            self.assertIn("REVIEW_NOT_APPROVED", caught.exception.blockers)
            self.assertFalse((published / "publication.jsonl").exists())
            self.assertFalse(published.exists())

    def test_publish_refuses_a_stale_period_a_tampered_archive_and_an_unknown_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id, _ = self.published_feed(directory)
            # Re-publication after the declared window closed is refused.
            with self.assertRaises(PublicationError) as stale:
                publish_dataset(
                    staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE,
                    now=NOW + timedelta(days=120),
                )
            self.assertIn("VALIDITY_NOT_CURRENT", stale.exception.blockers)

            # A byte-flipped staged archive is refused before any snapshot exists.
            published_second = Path(directory) / "published-2"
            archive = staging / dataset_id / "feed.zip"
            content = bytearray(archive.read_bytes())
            content[10] ^= 0xFF
            archive.write_bytes(bytes(content))
            with self.assertRaises(PublicationError) as tampered:
                publish_dataset(staging, published_second, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
            self.assertEqual(tampered.exception.code, "DATASET_NOT_INTACT")
            self.assertFalse(published_second.exists())

        with tempfile.TemporaryDirectory() as directory:
            # An UNKNOWN source type must stay unplausible even if a review slipped through.
            staging, published, dataset_id = self.stage_feed(directory, approved=False, source_type="UNKNOWN")
            state = {
                "review_status": "APPROVED",
                "ledger_integrity": "OK",
                "decision": {"entry_id": "rv-000001", "entry_hash": "0" * 64, "reviewer_id": REVIEWER, "recorded_at": NOW.isoformat()},
            }
            with patch("scripts.snapshot_gtfs.current_review_state", return_value=state):
                with self.assertRaises(PublicationError) as caught:
                    publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
            self.assertIn("SOURCE_TYPE_UNKNOWN", caught.exception.blockers)

    def test_generic_accounts_cannot_publish_and_a_forged_proof_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory)
            actors_root = Path(directory) / "actors"
            for account in ("admin", "ci", "anonymous"):
                # 1. Un compte générique ne peut même pas être enregistré.
                with self.assertRaises(ActorError) as refused_account:
                    create_actor(
                        account,
                        display_name="Compte générique",
                        role="publisher",
                        secret="secret-assez-long",
                        created_by="awa.mainteneur",
                        root=actors_root,
                    )
                self.assertIn(refused_account.exception.code, {"GENERIC_ACTOR_ID", "INVALID_ACTOR_ID"})

                # 2. Une preuve fabriquée à la main pour ce nom ne publie rien.
                with self.assertRaises(ReviewError) as caught:
                    publish_dataset(staging, published, dataset_id, proof=proof(account, "publisher"), note=NOTE, now=NOW)
                self.assertEqual(caught.exception.code, "AUTHENTICATION_INVALID")

            self.assertFalse((published / "publication.jsonl").exists())
            self.assertEqual(
                [path.name for path in published.iterdir() if path.is_dir()] if published.exists() else [], []
            )

    def test_the_same_actor_cannot_approve_then_publish_a_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory, approved=False)
            # Le même acteur reçoit une preuve de relecteur puis une preuve de publieur.
            approve_dataset(staging, dataset_id, proof=proof(REVIEWER, "reviewer"), attestations=FULL_ATTESTATIONS, now=NOW)
            with self.assertRaises(PublicationError) as caught:
                publish_dataset(staging, published, dataset_id, proof=proof(REVIEWER, "publisher"), note=NOTE, now=NOW)
            self.assertEqual(caught.exception.code, "SEPARATION_OF_DUTIES")
            self.assertFalse((published / "publication.jsonl").exists())
            self.assertEqual(
                [path.name for path in published.iterdir() if path.is_dir()] if published.exists() else [], []
            )

    def test_a_decision_without_an_authenticated_actor_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory, approved=False)
            expected_codes = {
                # Rien du tout, ou une preuve sans acteur : une preuve est exigée.
                "none": "AUTHENTICATION_REQUIRED",
                "no_actor": "AUTHENTICATION_INVALID",
                "no_role": "ROLE_FORBIDDEN",
                "no_method": "AUTHENTICATION_INVALID",
            }
            malformed = {
                "none": None,
                "no_actor": {},
                "no_role": {"actor_id": "fatou.ndiaye"},
                "no_method": {"actor_id": "fatou.ndiaye", "role": "reviewer", "authenticated_at": "2026-10-08T09:00:00+00:00"},
            }
            for label, missing_proof in malformed.items():
                with self.assertRaises(ReviewError) as approve_refusal:
                    approve_dataset(staging, dataset_id, proof=missing_proof, attestations=FULL_ATTESTATIONS, now=NOW)
                self.assertEqual(approve_refusal.exception.code, expected_codes[label], label)
            # Un horodatage sans fuseau ne prouve rien.
            with self.assertRaises(ReviewError) as naive_timestamp:
                approve_dataset(
                    staging,
                    dataset_id,
                    proof={"actor_id": "fatou.ndiaye", "role": "reviewer", "method": "cli-token", "authenticated_at": "2026-10-08T09:00:00"},
                    attestations=FULL_ATTESTATIONS,
                    now=NOW,
                )
            self.assertEqual(naive_timestamp.exception.code, "AUTHENTICATION_INVALID")
            # Un rôle insuffisant est refusé sans rien écrire.
            with self.assertRaises(ReviewError) as wrong_role:
                approve_dataset(staging, dataset_id, proof=proof(REVIEWER, "publisher"), attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertEqual(wrong_role.exception.code, "ROLE_FORBIDDEN")
            with self.assertRaises(ReviewError) as publish_refusal:
                publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "reviewer"), note=NOTE, now=NOW)
            self.assertEqual(publish_refusal.exception.code, "ROLE_FORBIDDEN")
            self.assertFalse((published / "publication.jsonl").exists())
            self.assertEqual(
                [path.name for path in published.iterdir() if path.is_dir()] if published.exists() else [], []
            )

    def test_a_refused_publication_leaves_no_orphan_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id, _ = self.published_feed(directory)
            with self.assertRaises(PublicationError) as caught:
                publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
            self.assertEqual(caught.exception.code, "ALREADY_PUBLISHED")

            snapshot_dirs = [path.name for path in published.iterdir() if path.is_dir()]
            self.assertEqual(len(snapshot_dirs), 1)
            self.assertEqual(len(read_publication_journal(published)["entries"]), 1)

    def test_a_busy_journal_is_reported_and_the_new_snapshot_is_discarded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory)
            with patch("scripts.publish_gtfs.publication_lock", side_effect=PublicationLockTimeout("Verrou tenu par une autre publication.")):
                with self.assertRaises(PublicationLockTimeout):
                    publish_dataset(staging, published, dataset_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
            self.assertFalse((published / "publication.jsonl").exists())
            self.assertEqual(
                [path.name for path in published.iterdir() if path.is_dir()] if published.exists() else [], []
            )

    def test_unlisted_snapshots_are_listed_but_never_served(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory)
            built = build_snapshot(staging / dataset_id, published, now=NOW)

            listing = list_snapshots(published, now=NOW)
            self.assertEqual([entry["snapshot_id"] for entry in listing], [built["snapshot_id"]])
            self.assertEqual(listing[0]["publication_status"], "UNLISTED")
            active = resolve_active_snapshot(published, now=NOW)
            self.assertFalse(active["available"])
            self.assertEqual(active["publication_status"], "NOT_PUBLISHED")
            self.assertIn("Aucun snapshot publié", str(active["blocked_reason"]))

    def test_a_newer_version_supersedes_the_previous_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, first_id = self.stage_feed(directory, version="publish-v1")
            first = publish_dataset(staging, published, first_id, proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW)
            _, _, second_id = self.stage_feed(
                directory, version="publish-v2",
                tables={**PUBLISH_TABLES, "stops.txt": PUBLISH_TABLES["stops.txt"].replace("Terminus Yoff", "Terminus Yoff Nord")},
            )
            second = publish_dataset(
                staging, published, second_id, proof=proof(PUBLISHER, "publisher"), note=NOTE,
                now=NOW + timedelta(hours=1),
            )
            self.assertEqual(second["previous_active_snapshot"], first["snapshot_id"])

            summary = publications_summary(published, now=NOW + timedelta(hours=1))
            self.assertEqual(summary["publication_status"], "PUBLISHED")
            self.assertEqual(summary["active"]["snapshot_id"], second["snapshot_id"])
            positions = {entry["snapshot_id"]: entry["publication_status"] for entry in summary["snapshots"]}
            self.assertEqual(positions[str(second["snapshot_id"])], "ACTIVE")
            self.assertEqual(positions[str(first["snapshot_id"])], "SUPERSEDED")
            self.assertEqual(len(summary["snapshots"]), 2)

    def test_revert_stops_the_service_without_deleting_anything(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, dataset_id, snapshot_id = self.published_feed(directory)
            before = {path.name: path.stat().st_mtime for path in (published / snapshot_id).iterdir()}

            result = revert_publication(published, proof=proof("awa.diop", "publisher"), reason=REASON, now=NOW + timedelta(hours=2))
            self.assertEqual(result["publication_status"], "NOT_PUBLISHED")
            self.assertFalse(result["files_deleted"])
            self.assertEqual(result["reverted_entry_id"], "pub-000001")

            journal = read_publication_journal(published)
            self.assertEqual(journal["integrity"], "OK")
            self.assertEqual([entry["action"] for entry in journal["entries"]], ["PUBLISH", "REVERT"])
            self.assertEqual(journal["entries"][1]["reverted_entry_id"], "pub-000001")

            after = {path.name: path.stat().st_mtime for path in (published / snapshot_id).iterdir()}
            self.assertEqual(before, after)
            state = current_publication_state(published)
            self.assertFalse(state["available"])
            self.assertEqual(state["publication_status"], "NOT_PUBLISHED")
            listing = list_snapshots(published, now=NOW)
            self.assertEqual(listing[0]["publication_status"], "REVOKED")
            self.assertFalse(resolve_active_snapshot(published, now=NOW)["available"])

            with self.assertRaises(PublicationError) as caught:
                revert_publication(published, proof=proof("awa.diop", "publisher"), reason=REASON, now=NOW)
            self.assertEqual(caught.exception.code, "NOTHING_PUBLISHED")

    def test_only_the_active_snapshot_can_be_reverted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, first_snapshot = self.published_feed(directory, version="publish-v1")
            _, _, second_id = self.stage_feed(directory, version="publish-v2")
            second = publish_dataset(
                published.parent / "staging", published, second_id,
                proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW + timedelta(hours=1),
            )

            with self.assertRaises(PublicationError) as caught:
                revert_publication(
                    published, proof=proof(PUBLISHER, "publisher"), reason=REASON,
                    snapshot_id=first_snapshot, now=NOW + timedelta(hours=2),
                )
            self.assertEqual(caught.exception.code, "NOT_ACTIVE")
            self.assertEqual(len(read_publication_journal(published)["entries"]), 2)

            with self.assertRaises(PublicationError) as wrong_snapshot:
                revert_publication(
                    published, proof=proof(PUBLISHER, "publisher"), reason=REASON,
                    snapshot_id="snap-20260101t000000z-inconnu", now=NOW + timedelta(hours=2),
                )
            self.assertEqual(wrong_snapshot.exception.code, "NOT_ACTIVE")
            self.assertEqual(current_publication_state(published)["active"]["snapshot_id"], second["snapshot_id"])

    def test_a_corrupted_publication_journal_blocks_publishing_and_serving(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id, _ = self.published_feed(directory)
            journal_file = published / "publication.jsonl"
            entry = json.loads(journal_file.read_text(encoding="utf-8").strip())
            entry["publisher_id"] = "quelqu.un"
            journal_file.write_text(json.dumps(entry, ensure_ascii=False) + "\n", encoding="utf-8")

            state = current_publication_state(published)
            self.assertEqual(state["journal_integrity"], "INVALID")
            self.assertEqual(state["journal_issue"]["code"], "JOURNAL_HASH_MISMATCH")
            self.assertEqual(state["publication_status"], "UNKNOWN")
            self.assertFalse(state["available"])
            self.assertFalse(resolve_active_snapshot(published, now=NOW)["available"])

            _, _, second_id = self.stage_feed(directory, version="publish-v2")
            with self.assertRaises(PublicationError) as caught:
                publish_dataset(
                    published.parent / "staging", published, second_id,
                    proof=proof(PUBLISHER, "publisher"), note=NOTE, now=NOW,
                )
            self.assertEqual(caught.exception.code, "JOURNAL_INVALID")
            self.assertEqual(len(list_snapshots(published, now=NOW)), 1)

    def test_verification_detects_a_modified_database_and_a_modified_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            database = published / snapshot_id / "network.sqlite"
            # A same-size edit is only caught by the deep hash.
            content = bytearray(database.read_bytes())
            content[len(content) // 2] ^= 0xFF
            database.write_bytes(bytes(content))
            verification = verify_snapshot(published / snapshot_id)
            codes = {issue["code"] for issue in verification["issues"]}
            self.assertEqual(verification["integrity"], "INVALID")
            self.assertFalse(verification["verified"])
            self.assertIn("DATABASE_CHECKSUM_MISMATCH", codes)
            self.assertFalse(resolve_active_snapshot(published, now=NOW)["available"])

            # A size change is caught earlier, by the cheap manifest check.
            database.write_bytes(bytes(content) + b"trailing")
            cheap = verify_snapshot(published / snapshot_id)
            self.assertEqual({issue["code"] for issue in cheap["issues"]}, {"DATABASE_SIZE_MISMATCH"})

        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            manifest_path = published / snapshot_id / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["record_count"]["stops"] = 99
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            verification = verify_published_snapshot(published, snapshot_id)
            codes = {issue["code"] for issue in verification["issues"]}
            self.assertIn("RECORD_COUNT_MISMATCH", codes)
            self.assertFalse(verification["served"])
            self.assertIsNone(verification["integrity_issue"])  # hashes still match; only the counts disagree

    def test_cli_publishes_reverts_and_verifies_with_json_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id = self.stage_feed(directory)
            actors_root = Path(directory) / "actors"
            publisher_token = actor_token(actors_root, PUBLISHER, "publisher")
            script = Path(__file__).resolve().parents[1] / "scripts" / "publish_gtfs.py"
            base = [
                sys.executable,
                str(script),
                "--root", str(staging),
                "--published-root", str(published),
                "--actors-root", str(actors_root),
                "--now", "2026-10-08T12:00:00Z",
            ]

            # Un jeton fabriqué ne publie rien, même avec un nom plausible.
            forged = subprocess.run(
                [*base, "publish", dataset_id, "--token", "dkr1.faux.jeton", "--note", NOTE],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(forged.returncode, 1, forged.stderr)
            self.assertEqual(json.loads(forged.stdout)["error"], "TOKEN_INVALID")

            # Sans jeton, la commande refuse d’écrire un nom à la main.
            missing = subprocess.run(
                [*base, "publish", dataset_id, "--note", NOTE],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(missing.returncode, 2, missing.stderr)
            self.assertIn("--token", missing.stderr)

            published_run = subprocess.run(
                [*base, "publish", dataset_id, "--token", publisher_token, "--note", NOTE],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(published_run.returncode, 0, published_run.stderr)
            payload = json.loads(published_run.stdout)
            snapshot_id = payload["snapshot_id"]
            self.assertEqual(payload["publication_status"], "PUBLISHED")
            self.assertEqual(payload["authentication"]["actor_id"], PUBLISHER)
            self.assertEqual(payload["authentication"]["method"], "cli-token")
            self.assertEqual(payload["journal_entry"]["authentication"]["actor_id"], PUBLISHER)
            self.assertTrue(payload["separation_of_duties"])

            listed = subprocess.run([*base, "list"], capture_output=True, text=True, check=False)
            self.assertEqual(listed.returncode, 0, listed.stderr)
            self.assertEqual(json.loads(listed.stdout)["active"]["snapshot_id"], snapshot_id)

            verified = subprocess.run([*base, "verify", snapshot_id], capture_output=True, text=True, check=False)
            self.assertEqual(verified.returncode, 0, verified.stderr)
            self.assertTrue(json.loads(verified.stdout)["served"])

            reverted = subprocess.run(
                [*base, "revert", "--token", publisher_token, "--reason", REASON],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(reverted.returncode, 0, reverted.stderr)
            self.assertEqual(json.loads(reverted.stdout)["publication_status"], "NOT_PUBLISHED")
            self.assertEqual(len(read_publication_journal(published)["entries"]), 2)


class SnapshotReadTests(PublishFixtures):
    def test_read_api_answers_from_the_published_snapshot_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, dataset_id, snapshot_id = self.published_feed(directory)
            active = resolve_active_snapshot(published, now=NOW)
            self.assertTrue(active["available"])
            self.assertEqual(active["snapshot"]["snapshot_id"], snapshot_id)
            self.assertEqual(active["snapshot"]["validity_status"], "CURRENT")
            self.assertEqual(active["dataset"]["dataset_id"], dataset_id)
            self.assertEqual(active["dataset"]["operator"], "Réseau de démonstration")
            self.assertFalse(active["realtime"])
            self.assertEqual(active["snapshot"]["timezone"], "Africa/Dakar")

            connection = connect_read_only(published / snapshot_id)
            try:
                self.assertEqual(dataset_tables(connection)["stops"], 4)
                # Accents and case are folded for search, names stay as declared.
                self.assertEqual([stop["stop_name"] for stop in search_stops(connection, "ROUTIERE")], ["Gare Routière Leclerc"])
                self.assertEqual([stop["stop_name"] for stop in search_stops(connection, "yoff")], ["Terminus Yoff"])
                # Every word must appear: « gare leclerc » still finds the declared name.
                self.assertEqual(
                    [stop["stop_name"] for stop in search_stops(connection, "gare leclerc")],
                    ["Gare Routière Leclerc"],
                )
                self.assertEqual(search_stops(connection, "gare yoff"), [])
                nearby = stops_near(connection, 14.7051, -17.4602, radius_m=1000)
                self.assertEqual([stop["stop_name"] for stop in nearby], ["Gare Routière Leclerc"])
                self.assertLessEqual(nearby[0]["distance_m"], 100)

                detail = stop_detail(connection, "S1")
                self.assertEqual(detail["stop_name"], "Place de la Nation")
                self.assertEqual([route["route_short_name"] for route in detail["routes"]], ["1"])
                self.assertEqual(detail["scheduled_time_window"]["first_declared_departure"], "08:00:00")
                self.assertIn("temps réel", detail["scheduled_time_window"]["note"])
                self.assertIsNone(stop_detail(connection, "S-INCONNU"))

                route = route_detail(connection, "R1")
                self.assertEqual(route["agency_name"], "Réseau de démonstration")
                self.assertEqual(route["trip_count"], 2)
                self.assertEqual(route["stop_count"], 2)
                self.assertTrue(route["has_shapes"])
                self.assertFalse(route["realtime"])
                self.assertIsNone(route_detail(connection, "R-INCONNUE"))
                self.assertEqual(len(list_routes(connection)), 2)
            finally:
                connection.close()

    def test_read_api_refuses_invalid_positions_limits_and_queries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            connection = connect_read_only(published / snapshot_id)
            try:
                with self.assertRaises(ValueError):
                    search_stops(connection, "   ")
                with self.assertRaises(ValueError):
                    stops_near(connection, 200.0, 10.0)
                with self.assertRaises(ValueError):
                    stops_near(connection, 14.7, -17.4, radius_m=50_000)
                with self.assertRaises(ValueError):
                    stops_near(connection, 14.7, -17.4, limit=1_000)
                with self.assertRaises(ValueError):
                    route_detail(connection, "")
            finally:
                connection.close()

    def test_the_store_is_read_only_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            connection = connect_read_only(published / snapshot_id)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("CREATE TABLE intrusion (x TEXT)")
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
