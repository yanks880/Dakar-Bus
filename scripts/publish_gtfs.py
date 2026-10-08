#!/usr/bin/env python3
"""Publish, inspect and roll back immutable GTFS snapshots.

Publication is the third gate after staging and review, and the only step that
makes transport data readable by the app. `publish` freezes an approved version
into a hashed snapshot and appends one hash-chained entry to the publication
journal; `revert` appends another entry and serves nothing again. No command in
this file edits a staging manifest, a review journal or a published snapshot.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.publish_gtfs` and as a file script.
    from .catalog_gtfs import DATASET_ID_RE
    from .network_graph import GraphError, graph_status, rebuild_graph
    from .publication_ledger import (
        PublicationError,
        PublicationLockTimeout,
        append_publication_entry,
        build_publication_entry,
        current_publication_state,
        effective_publication,
        previous_hash_for,
        publication_lock,
        read_publication_journal,
    )
    from .snapshot_gtfs import (
        SnapshotError,
        build_snapshot,
        inspect_snapshot,
        list_snapshots,
        show_snapshot,
        verify_snapshot,
    )
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE
    from network_graph import GraphError, graph_status, rebuild_graph
    from publication_ledger import (
        PublicationError,
        PublicationLockTimeout,
        append_publication_entry,
        build_publication_entry,
        current_publication_state,
        effective_publication,
        previous_hash_for,
        publication_lock,
        read_publication_journal,
    )
    from snapshot_gtfs import (
        SnapshotError,
        build_snapshot,
        inspect_snapshot,
        list_snapshots,
        show_snapshot,
        verify_snapshot,
    )


def _rebuild_graph_after_publish(published_root: Path, snapshot_id: str, *, now: datetime) -> dict[str, Any]:
    """Keep the routing graph aligned with what is published.

    A publication is valid even if the graph cannot be built: the journal is the
    truth. The caller reports the graph state instead of hiding a failure, and
    the API refuses to serve journeys until the graph matches the snapshot.
    """
    try:
        rebuilt = rebuild_graph(published_root, snapshot_id, now=now)
    except (GraphError, OSError, ValueError) as error:
        return {
            "usable": False,
            "reason": f"Le graphe d’itinéraires n’a pas pu être reconstruit : {error}",
            "rebuilt": False,
        }
    return {
        "usable": True,
        "rebuilt": True,
        "built_at": rebuilt["built_at"],
        "stats": rebuilt["stats"],
        "capabilities": rebuilt["capabilities"],
        "graph_sha256": rebuilt["graph_sha256"],
        "graph_bytes": rebuilt["graph_bytes"],
        "warnings": rebuilt["warnings"],
    }


PUBLICATION_NOTE = (
    "Publier ne modifie ni le staging, ni la revue, ni l’archive : le snapshot est une copie "
    "gelée et le journal des publications reste append-only."
)


def _checked_now(now: datetime | None) -> datetime:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError("now doit être une date/heure avec fuseau horaire.")
    return current.astimezone(timezone.utc)


def _journal_entries(published_root: Path) -> list[dict[str, Any]]:
    journal = read_publication_journal(published_root)
    if journal["integrity"] == "INVALID":
        issue = journal.get("issue") or {}
        raise PublicationError(
            "JOURNAL_INVALID",
            f"Le journal des publications est altéré ({issue.get('code', 'cause inconnue')}) ; aucune écriture n’est possible.",
        )
    return list(journal["entries"])


def _discard_snapshot(snapshot_directory: Path) -> bool:
    """Remove a snapshot this process just built and never published."""
    if not snapshot_directory.exists() or snapshot_directory.name.startswith("."):
        return False
    shutil.rmtree(snapshot_directory, ignore_errors=True)
    return not snapshot_directory.exists()


def publish_dataset(
    staging_root: str | Path,
    published_root: str | Path,
    dataset_id: str,
    *,
    publisher_id: str,
    note: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Freeze an approved version into a snapshot and make it the served one."""
    current_time = _checked_now(now)
    if not DATASET_ID_RE.fullmatch(dataset_id):
        raise PublicationError("INVALID_DATASET_ID", "dataset_id contient des caractères interdits.")
    root = Path(published_root)

    # Integrity first: never build an artefact we would not be allowed to list.
    entries = _journal_entries(root)
    active = effective_publication(entries)["active"]

    try:
        built = build_snapshot(Path(staging_root) / dataset_id, root, now=current_time)
    except SnapshotError as error:
        # The build gate and the publication gate speak with one voice.
        raise PublicationError(error.code, str(error), list(error.blockers)) from error
    snapshot_directory = Path(str(built["snapshot_directory"]))
    manifest = built["manifest"]
    assert isinstance(manifest, dict)
    dataset = manifest["dataset"]
    review = manifest["review"]

    try:
        with publication_lock(root):
            fresh_entries = _journal_entries(root)
            fresh_active = effective_publication(fresh_entries)["active"]
            if (
                isinstance(fresh_active, dict)
                and fresh_active.get("dataset_id") == dataset_id
                and fresh_active.get("dataset_sha256") == dataset.get("archive_sha256")
            ):
                raise PublicationError(
                    "ALREADY_PUBLISHED",
                    "Cette version est déjà publiée ; annuler la publication active ou publier une nouvelle version.",
                )
            entry = build_publication_entry(
                sequence=len(fresh_entries) + 1,
                action="PUBLISH",
                snapshot_id=str(built["snapshot_id"]),
                dataset_id=dataset_id,
                dataset_sha256=str(dataset.get("archive_sha256")),
                database_sha256=str(built["database_sha256"]),
                publisher_id=publisher_id,
                recorded_at=current_time,
                note=note,
                previous_hash=previous_hash_for(fresh_entries),
                review_entry_id=review.get("review_entry_id"),
                review_entry_hash=review.get("review_entry_hash"),
                reviewer_id=review.get("reviewer_id"),
                record_count=manifest.get("record_count") or {},
            )
            append_publication_entry(root, entry)
    except BaseException:
        _discard_snapshot(snapshot_directory)
        raise

    graph = _rebuild_graph_after_publish(root, str(built["snapshot_id"]), now=current_time)

    return {
        "snapshot_id": built["snapshot_id"],
        "dataset_id": dataset_id,
        "dataset_version": dataset.get("dataset_version"),
        "publication_status": "PUBLISHED",
        "realtime": False,
        "graph": graph,
        "journal_entry": entry,
        "previous_active_snapshot": active.get("snapshot_id") if isinstance(active, dict) else None,
        "snapshot": {
            "integrity": "OK",
            "built_at": manifest.get("built_at"),
            "valid_from": dataset.get("valid_from"),
            "valid_until": dataset.get("valid_until"),
            "record_count": manifest.get("record_count"),
            "bounds": manifest.get("bounds"),
            "database_sha256": manifest["store"]["sha256"],
        },
        "message": "Snapshot publié : l’API de lecture sert cette version datée, sans temps réel.",
        "note": PUBLICATION_NOTE,
    }


def revert_publication(
    published_root: str | Path,
    *,
    publisher_id: str,
    reason: str,
    snapshot_id: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Stop serving the active snapshot; files and journal entries stay in place."""
    current_time = _checked_now(now)
    root = Path(published_root)
    with publication_lock(root):
        entries = _journal_entries(root)
        state = effective_publication(entries)
        active = state["active"]
        if not isinstance(active, dict):
            raise PublicationError("NOTHING_PUBLISHED", "Aucune publication active : il n’y a rien à annuler.")
        if snapshot_id is not None and str(active.get("snapshot_id")) != snapshot_id:
            raise PublicationError(
                "NOT_ACTIVE",
                f"Le snapshot « {snapshot_id} » n’est pas celui qui est publié ; seul le snapshot actif peut être annulé.",
            )
        entry = build_publication_entry(
            sequence=len(entries) + 1,
            action="REVERT",
            snapshot_id=str(active.get("snapshot_id")),
            dataset_id=str(active.get("dataset_id")),
            dataset_sha256=str(active.get("dataset_sha256")),
            database_sha256=None,
            publisher_id=publisher_id,
            recorded_at=current_time,
            note=reason,
            previous_hash=previous_hash_for(entries),
            reverted_entry_id=str(active.get("entry_id")),
        )
        append_publication_entry(root, entry)

    return {
        "snapshot_id": active.get("snapshot_id"),
        "dataset_id": active.get("dataset_id"),
        "publication_status": "NOT_PUBLISHED",
        "realtime": False,
        "journal_entry": entry,
        "reverted_entry_id": active.get("entry_id"),
        "files_deleted": False,
        "message": "Publication annulée : l’API de lecture ne sert plus rien. Le snapshot reste sur disque et le journal garde les deux entrées.",
    }


def publications_summary(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    current_time = _checked_now(now)
    state = current_publication_state(published_root)
    return {
        "generated_at": current_time.isoformat(),
        "journal_integrity": state["journal_integrity"],
        "journal_issue": state.get("journal_issue"),
        "publication_status": state["publication_status"],
        "entry_count": state["entry_count"],
        "active": state.get("active"),
        "history": state.get("history"),
        "replay_issues": state.get("replay_issues"),
        "snapshots": list_snapshots(published_root, now=current_time),
        "graph": graph_status(published_root, now=current_time),
        "realtime": False,
    }


def verify_published_snapshot(published_root: str | Path, snapshot_id: str) -> dict[str, Any]:
    directory = Path(published_root) / snapshot_id
    verification = verify_snapshot(directory)
    state = current_publication_state(published_root)
    active = state.get("active")
    verification["publication_status"] = (
        "ACTIVE"
        if isinstance(active, dict) and active.get("snapshot_id") == snapshot_id
        else ("UNLISTED" if state["journal_integrity"] != "INVALID" else "UNKNOWN")
    )
    verification["publication_journal_integrity"] = state["journal_integrity"]
    verification["served"] = verification["publication_status"] == "ACTIVE" and verification["verified"]
    return verification


def _emit(result: object) -> None:
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _parse_now(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as error:
        raise argparse.ArgumentTypeError("--now doit être une date/heure ISO 8601.") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise argparse.ArgumentTypeError("--now doit inclure un fuseau horaire, par exemple +00:00.")
    return parsed.astimezone(timezone.utc)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Publication de snapshots GTFS : gel d’une version approuvée, journal append-only, retour arrière tracé.",
    )
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    parser.add_argument("--published-root", type=Path, default=Path("data/published"), help="Répertoire des snapshots publiés")
    parser.add_argument("--now", type=_parse_now, default=None, help="Horodatage à utiliser (ISO 8601, tests et rejeu)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    publish_parser = subparsers.add_parser("publish", help="Geler une version approuvée et la publier")
    publish_parser.add_argument("dataset_id")
    publish_parser.add_argument("--publisher", required=True, help="Identifiant nominatif de la personne qui publie")
    publish_parser.add_argument("--note", required=True, help="Motif ou contexte de la publication")

    revert_parser = subparsers.add_parser("revert", help="Annuler la publication active sans rien effacer")
    revert_parser.add_argument("--snapshot-id", default=None, help="Snapshot attendu comme actif (garde-fou)")
    revert_parser.add_argument("--publisher", required=True)
    revert_parser.add_argument("--reason", required=True)

    subparsers.add_parser("list", help="Lister les snapshots, leur intégrité et leur état de publication")
    graph_parser = subparsers.add_parser("graph-rebuild", help="Reconstruire le graphe d’itinéraires depuis le snapshot actif")
    graph_parser.add_argument("--snapshot-id", default=None, help="Snapshot à utiliser (par défaut : le snapshot actif)")
    subparsers.add_parser("graph-status", help="Dire si le graphe d’itinéraires correspond bien au snapshot publié")
    subparsers.add_parser("journal", help="Relire le journal des publications et sa chaîne d’empreintes")
    show_parser = subparsers.add_parser("show", help="Afficher un snapshot et son état de publication")
    show_parser.add_argument("snapshot_id")
    verify_parser = subparsers.add_parser("verify", help="Recompter et rehacher un snapshot publié")
    verify_parser.add_argument("snapshot_id")

    args = parser.parse_args()

    try:
        if args.command == "publish":
            result = publish_dataset(
                args.root, args.published_root, args.dataset_id,
                publisher_id=args.publisher, note=args.note, now=args.now,
            )
            _emit(result)
            return 0
        if args.command == "revert":
            result = revert_publication(
                args.published_root, publisher_id=args.publisher, reason=args.reason,
                snapshot_id=args.snapshot_id, now=args.now,
            )
            _emit(result)
            return 0
        if args.command == "graph-status":
            _emit(graph_status(args.published_root, now=args.now))
            return 0
        if args.command == "graph-rebuild":
            result = rebuild_graph(args.published_root, args.snapshot_id, now=args.now)
            _emit({**result, "graph": None, "status": graph_status(args.published_root, now=args.now)})
            return 0
        if args.command == "list":
            result = publications_summary(args.published_root, now=args.now)
            _emit(result)
            healthy = result["journal_integrity"] in {"OK", "EMPTY"} and all(
                entry["integrity"] == "OK" for entry in result["snapshots"]
            )
            return 0 if healthy else 1
        if args.command == "journal":
            journal = read_publication_journal(args.published_root)
            state = current_publication_state(args.published_root)
            _emit(
                {
                    "path": journal["path"],
                    "journal_integrity": journal["integrity"],
                    "journal_issue": journal["issue"],
                    "entry_count": len(journal["entries"]),
                    "publication_status": state["publication_status"],
                    "active": state["active"],
                    "replay_issues": state["replay_issues"],
                    "entries": journal["entries"],
                    "realtime": False,
                }
            )
            return 0 if journal["integrity"] in {"OK", "EMPTY"} else 1
        if args.command == "show":
            result = show_snapshot(args.published_root, args.snapshot_id, now=args.now)
            _emit(result)
            return 0 if result["integrity"] == "OK" else 1
        result = verify_published_snapshot(args.published_root, args.snapshot_id)
        _emit(result)
        return 0 if result["verified"] else 1
    except (PublicationError, PublicationLockTimeout, SnapshotError) as error:
        payload = {
            "error": getattr(error, "code", "PUBLICATION_REFUSED"),
            "message": str(error),
            "blockers": getattr(error, "blockers", []),
            "publication_status": current_publication_state(args.published_root)["publication_status"],
        }
        _emit(payload)
        return 1
    except ValueError as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
