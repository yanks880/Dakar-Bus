from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.review_gtfs import (
    ReviewError,
    approve_dataset,
    parse_attestations,
    pending_datasets,
    reject_dataset,
    revert_decision,
    review_dossier,
)
from scripts.review_ledger import (
    GENESIS_HASH,
    REQUIRED_ATTESTATIONS,
    compute_entry_hash,
    read_journal,
    validate_reviewer_id,
)
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_stage_gtfs import NOW, VALID_METADATA, VALID_TABLES


FULL_ATTESTATIONS: dict[str, dict[str, str | None]] = {
    "source_identity": {"evidence": "Source confirmée par courriel de l’éditeur le 2026-10-08.", "reference": "https://example.invalid/feed"},
    "reuse_rights": {"evidence": "Licence ouverte publiée sur la page de la source.", "reference": "https://example.invalid/licence"},
    "operator_confirmed": {"evidence": "Opérateur confirmé ; réseau distinct, non confondu avec AFTU.", "reference": None},
    "service_operational": {"evidence": "Service exploité constaté sur le terrain aux dates déclarées.", "reference": None},
    "freshness_confirmed": {"evidence": "Période de validité confirmée avec la source le 2026-10-08.", "reference": "https://example.invalid/maj"},
}
REVIEWER = "fatou.ndiaye"


def attestations_without(*items: str) -> dict[str, dict[str, str | None]]:
    return {
        item: {**value} if item not in items else {"evidence": None, "reference": None}
        for item, value in FULL_ATTESTATIONS.items()
    }


class GTFSReviewTests(unittest.TestCase):
    def create_staged_dataset(
        self,
        directory: str,
        *,
        version: str = "review-v1",
        valid_until: str | None = None,
        **overrides: Any,
    ) -> tuple[Path, dict[str, Any]]:
        archive_path = Path(directory) / f"{version}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in VALID_TABLES.items():
                archive.writestr(name, content)
        metadata = IngestMetadata(
            **{
                **VALID_METADATA.__dict__,
                "dataset_version": version,
                "valid_until": valid_until or VALID_METADATA.valid_until,
                **overrides,
            }
        )
        output = Path(directory) / "staging"
        result = stage_gtfs_archive(archive_path, output, metadata, now=NOW)
        self.assertTrue(result["staged"], result)
        return output, result

    def stage_active_feed(self, directory: str, **overrides: Any) -> tuple[Path, str]:
        defaults: dict[str, Any] = {
            "source_type": "OFFICIAL",
            "operator": "Test operator",
            "service_status": "ACTIVE",
        }
        defaults.update(overrides)
        output, staged = self.create_staged_dataset(directory, **defaults)
        return output, str(staged["dataset_id"])

    def test_full_attestations_record_a_traceable_approval_without_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            result = approve_dataset(
                root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW
            )

            self.assertTrue(result["recorded"])
            self.assertEqual(result["review_status"], "APPROVED")
            self.assertEqual(result["publication_status"], "NOT_PUBLISHED")
            self.assertFalse(result["publication_ready"])
            self.assertEqual(result["entry_id"], "rv-000001")

            journal = read_journal(root / dataset_id)
            self.assertEqual(journal["integrity"], "OK")
            self.assertEqual(len(journal["entries"]), 1)
            entry = journal["entries"][0]
            self.assertEqual(entry["previous_hash"], GENESIS_HASH)
            self.assertEqual(entry["entry_hash"], compute_entry_hash(entry))
            self.assertEqual(set(entry["attestations"]), set(REQUIRED_ATTESTATIONS))
            self.assertEqual(entry["publication_status"], "NOT_PUBLISHED")

            # The staging manifest stays a frozen import snapshot.
            manifest = json.loads((root / dataset_id / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["review_status"], "PENDING_REVIEW")
            self.assertEqual(manifest["publication_status"], "NOT_PUBLISHED")

    def test_approval_is_refused_until_every_attestation_is_signed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            with self.assertRaises(ReviewError) as caught:
                approve_dataset(
                    root,
                    dataset_id,
                    reviewer_id=REVIEWER,
                    attestations=attestations_without("reuse_rights", "freshness_confirmed"),
                    now=NOW,
                )
            self.assertEqual(caught.exception.code, "APPROVAL_BLOCKED")
            self.assertEqual(len(caught.exception.blockers), 2)
            self.assertTrue(all("Attestation manquante" in item for item in caught.exception.blockers))
            self.assertFalse((root / dataset_id / "review").exists())

    def test_unconfirmed_provenance_cannot_be_approved_even_with_attestations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory, source_type="UNKNOWN", operator="UNKNOWN")
            with self.assertRaises(ReviewError) as caught:
                approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertIn("Le type de source déclaré est UNKNOWN.", caught.exception.blockers)
            self.assertIn("L’opérateur n’est pas confirmé.", caught.exception.blockers)

    def test_declared_inactive_or_expired_service_stays_out_of_review_approval(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, planned = self.stage_active_feed(directory, version="review-planned", service_status="PLANNED")
            with self.assertRaises(ReviewError) as caught:
                approve_dataset(root, planned, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertIn("Le statut de service déclaré n’est pas ACTIVE.", caught.exception.blockers)

            root_expired, expired = self.stage_active_feed(
                directory, version="review-expired", valid_until="2026-10-07T23:59:59Z"
            )
            with self.assertRaises(ReviewError) as caught_expired:
                approve_dataset(root_expired, expired, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertTrue(
                any("STALE" in blocker for blocker in caught_expired.exception.blockers),
                caught_expired.exception.blockers,
            )

    def test_tampered_archive_blocks_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            with (root / dataset_id / "feed.zip").open("ab") as archive:
                archive.write(b"tampered")
            with self.assertRaises(ReviewError) as caught:
                approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertEqual(caught.exception.code, "DATASET_INTEGRITY_INVALID")

    def test_generic_reviewer_accounts_are_refused(self) -> None:
        for reviewer in ("admin", "test", "anonymous", "AB"):
            with self.assertRaises(ValueError):
                validate_reviewer_id(reviewer)
        self.assertEqual(validate_reviewer_id("Fatou.Ndiaye"), "fatou.ndiaye")

    def test_revert_is_an_appended_rollback_that_keeps_the_original_decision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            approval = approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)

            revert = revert_decision(
                root,
                dataset_id,
                reviewer_id="ousmane.fall",
                entry_id=str(approval["entry_id"]),
                reason="Licence annoncée mais non confirmée par l’éditeur.",
                now=NOW,
            )
            self.assertEqual(revert["review_status"], "PENDING_REVIEW")
            self.assertEqual(revert["reverted_entry_id"], approval["entry_id"])

            journal = read_journal(root / dataset_id)
            self.assertEqual(journal["integrity"], "OK")
            self.assertEqual([entry["action"] for entry in journal["entries"]], ["APPROVE", "REVERT"])
            self.assertEqual(journal["entries"][1]["previous_hash"], approval["entry_hash"])

            # A second approval is allowed after a revert and stays unpublished.
            second = approve_dataset(
                root, dataset_id, reviewer_id="ousmane.fall", attestations=FULL_ATTESTATIONS, now=NOW
            )
            self.assertEqual(second["entry_id"], "rv-000003")
            self.assertEqual(second["publication_status"], "NOT_PUBLISHED")

    def test_only_the_active_decision_can_be_reverted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            with self.assertRaises(ReviewError) as caught:
                revert_decision(
                    root, dataset_id, reviewer_id=REVIEWER, entry_id="rv-000001", reason="Aucune décision encore active.", now=NOW
                )
            self.assertEqual(caught.exception.code, "NO_ACTIVE_DECISION")

            approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            with self.assertRaises(ReviewError) as mismatch:
                revert_decision(
                    root, dataset_id, reviewer_id=REVIEWER, entry_id="rv-000009", reason="Mauvais identifiant de décision.", now=NOW
                )
            self.assertEqual(mismatch.exception.code, "REVERT_TARGET_MISMATCH")

    def test_rejection_requires_a_reason_and_is_not_repeatable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            result = reject_dataset(
                root, dataset_id, reviewer_id=REVIEWER, reason="Source non identifiée auprès de l’éditeur.", now=NOW
            )
            self.assertEqual(result["review_status"], "REJECTED")
            with self.assertRaises(ReviewError) as caught:
                reject_dataset(root, dataset_id, reviewer_id=REVIEWER, reason="Refus déjà enregistré pour cette version.", now=NOW)
            self.assertEqual(caught.exception.code, "ALREADY_REJECTED")
            with self.assertRaises(ReviewError) as approval:
                approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertEqual(approval.exception.code, "APPROVAL_BLOCKED")

    def test_corrupted_ledger_blocks_new_decisions_and_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            journal_file = root / dataset_id / "review" / "journal.jsonl"
            tampered = json.loads(journal_file.read_text(encoding="utf-8").strip())
            tampered["note"] = "Approbation modifiée après coup, sans nouvelle signature."
            journal_file.write_text(json.dumps(tampered, ensure_ascii=False) + "\n", encoding="utf-8")

            with self.assertRaises(ReviewError) as caught:
                approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            self.assertEqual(caught.exception.code, "JOURNAL_HASH_MISMATCH")

            dossier = review_dossier(root, dataset_id, now=NOW)
            self.assertEqual(dossier["review_status"], "UNKNOWN")
            self.assertEqual(dossier["ledger_integrity"], "INVALID")
            self.assertEqual(dossier["ledger_issue"]["code"], "JOURNAL_HASH_MISMATCH")

    def test_pending_queue_and_dossier_expose_declared_provenance_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            queue = pending_datasets(root, now=NOW)
            self.assertEqual(len(queue), 1)
            self.assertEqual(queue[0]["dataset_id"], dataset_id)
            self.assertEqual(queue[0]["review_status"], "PENDING_REVIEW")
            self.assertEqual(queue[0]["publication_status"], "NOT_PUBLISHED")

            dossier = review_dossier(root, dataset_id, now=NOW)
            self.assertEqual(dossier["declared"]["source_type"], "OFFICIAL")
            self.assertEqual(dossier["declared"]["service_status"], "ACTIVE")
            self.assertEqual(len(dossier["pending_blockers"]), len(REQUIRED_ATTESTATIONS))
            self.assertFalse(dossier["publication_ready"])

    def test_attestation_parsing_rejects_unknown_items_and_bad_references(self) -> None:
        attestations = parse_attestations(
            ["source_identity=Source confirmée par téléphone"],
            ["source_identity=https://example.invalid/preuve"],
        )
        self.assertEqual(attestations["source_identity"]["reference"], "https://example.invalid/preuve")
        self.assertIsNone(attestations["reuse_rights"]["evidence"])

        with self.assertRaises(ReviewError):
            parse_attestations(["invented_item=Une preuve quelconque"], None)
        with self.assertRaises(ReviewError):
            parse_attestations(None, ["source_identity=ftp://example.invalid/preuve"])
        with self.assertRaises(ValueError):
            parse_attestations(["source_identity=court"], None)

    def test_cli_records_an_approval_and_reports_blockers_as_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            script = Path(__file__).resolve().parents[1] / "scripts" / "review_gtfs.py"

            blocked = subprocess.run(
                [sys.executable, str(script), "--root", str(root), "approve", dataset_id, "--reviewer", REVIEWER],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(blocked.returncode, 1, blocked.stderr)
            blocked_result = json.loads(blocked.stdout)
            self.assertFalse(blocked_result["recorded"])
            self.assertEqual(blocked_result["error"], "APPROVAL_BLOCKED")
            self.assertEqual(len(blocked_result["blockers"]), len(REQUIRED_ATTESTATIONS))

            command = [sys.executable, str(script), "--root", str(root), "approve", dataset_id, "--reviewer", REVIEWER]
            for item, value in FULL_ATTESTATIONS.items():
                command += ["--attest", f"{item}={value['evidence']}"]
                if value["reference"]:
                    command += ["--reference", f"{item}={value['reference']}"]
            approved = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(approved.returncode, 0, approved.stderr)
            approved_result = json.loads(approved.stdout)
            self.assertEqual(approved_result["review_status"], "APPROVED")
            self.assertEqual(approved_result["publication_status"], "NOT_PUBLISHED")

            pending = subprocess.run(
                [sys.executable, str(script), "--root", str(root), "pending"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(pending.returncode, 0, pending.stderr)
            self.assertEqual(json.loads(pending.stdout)["pending"][0]["review_status"], "APPROVED")

    def test_catalog_surfaces_review_state_without_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_active_feed(directory)
            approve_dataset(root, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)

            script = Path(__file__).resolve().parents[1] / "scripts" / "catalog_gtfs.py"
            completed = subprocess.run(
                [sys.executable, str(script), "--root", str(root), "list"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            entry = json.loads(completed.stdout)[0]
            self.assertEqual(entry["review_status"], "APPROVED")
            self.assertEqual(entry["ledger_integrity"], "OK")
            self.assertEqual(entry["publication_status"], "NOT_PUBLISHED")
            self.assertEqual(entry["reviewer_id"], REVIEWER)

            # A corrupted ledger fails the catalog integrity gate.
            journal_file = root / dataset_id / "review" / "journal.jsonl"
            journal_file.write_text("not-json\n", encoding="utf-8")
            corrupted = subprocess.run(
                [sys.executable, str(script), "--root", str(root), "list"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(corrupted.returncode, 1)
            self.assertEqual(json.loads(corrupted.stdout)[0]["ledger_integrity"], "INVALID")


if __name__ == "__main__":
    unittest.main()
