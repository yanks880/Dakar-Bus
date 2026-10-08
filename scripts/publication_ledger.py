#!/usr/bin/env python3
"""Append-only, hash-chained publication journal for the published snapshots.

Publication is the third gate. It is the only step that makes a reviewed and
approved GTFS version readable by the app, and it is deliberately boring: this
module never edits a staging manifest, never edits the review ledger and never
rewrites a published snapshot. Every action appends an entry, and a rollback is
another entry that leaves the previous one in place.

Only a named human can publish: the publisher is validated with the same rule
as a reviewer, so generic accounts stay out of the chain.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.publication_ledger` and as a file script.
    from .catalog_gtfs import DATASET_ID_RE
    from .review_ledger import (
        GENESIS_HASH,
        MAX_TEXT_LENGTH,
        MIN_TEXT_LENGTH,
        LedgerLockTimeout,
        compute_entry_hash,
        file_lock,
        read_chain,
        validate_reviewer_id,
    )
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE
    from review_ledger import (
        GENESIS_HASH,
        MAX_TEXT_LENGTH,
        MIN_TEXT_LENGTH,
        LedgerLockTimeout,
        compute_entry_hash,
        file_lock,
        read_chain,
        validate_reviewer_id,
    )

PUBLICATION_SCHEMA_VERSION = "1.0"
JOURNAL_FILENAME = "publication.jsonl"
LOCK_FILENAME = "publication.lock"
DEFAULT_LOCK_TIMEOUT_SECONDS = 10.0
ENTRY_ID_RE = re.compile(r"^pub-[0-9]{6}$")
SNAPSHOT_ID_RE = re.compile(r"^snap-[a-z0-9][a-z0-9-]{2,79}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
PUBLICATION_ACTIONS = ("PUBLISH", "REVERT")


class PublicationError(RuntimeError):
    """A publication decision was refused; nothing was written."""

    def __init__(self, code: str, message: str, blockers: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.blockers = blockers or []


class PublicationLockTimeout(LedgerLockTimeout):
    """Another publisher is writing; the journal was left untouched."""


def journal_path(root: str | Path) -> Path:
    return Path(root) / JOURNAL_FILENAME


def lock_path(root: str | Path) -> Path:
    return Path(root) / LOCK_FILENAME


def validate_snapshot_id(snapshot_id: str) -> str:
    candidate = snapshot_id.strip()
    if not SNAPSHOT_ID_RE.fullmatch(candidate):
        raise PublicationError(
            "INVALID_SNAPSHOT_ID",
            "snapshot_id doit ressembler à « snap-<horodatage>-<jeu> » (lettres minuscules, chiffres et tirets).",
        )
    return candidate


def validate_publisher_id(publisher_id: str) -> str:
    """A publication must name a person, never a generic account."""
    try:
        return validate_reviewer_id(publisher_id)
    except ValueError as error:
        raise PublicationError("INVALID_PUBLISHER", str(error)) from error


def validate_sha256(value: str, field: str) -> str:
    candidate = value.strip().lower()
    if not SHA256_RE.fullmatch(candidate):
        raise PublicationError("INVALID_CHECKSUM", f"{field} doit être un SHA-256 hexadécimal minuscule.")
    return candidate


def _clean_text(value: str, field: str) -> str:
    text = " ".join(value.split())
    if len(text) < MIN_TEXT_LENGTH:
        raise PublicationError("INVALID_NOTE", f"{field} doit contenir au moins {MIN_TEXT_LENGTH} caractères utiles.")
    if len(text) > MAX_TEXT_LENGTH:
        raise PublicationError("INVALID_NOTE", f"{field} doit rester sous {MAX_TEXT_LENGTH} caractères.")
    return text


def _clean_identifier(value: str, field: str) -> str:
    text = value.strip()
    if not text or len(text) > 120 or any(character.isspace() for character in text):
        raise PublicationError("INVALID_REFERENCE", f"{field} doit être un identifiant non vide sans espace.")
    return text


@contextmanager
def publication_lock(root: str | Path, *, timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS) -> Iterator[Path]:
    """Serialise publishers around one read-decide-append cycle."""
    with file_lock(
        lock_path(root),
        subject=f"publications ({Path(root).name or root})",
        timeout=timeout,
        message=(
            "Le journal des publications est verrouillé par une autre écriture ; "
            "rien n’a été écrit et aucun statut n’a changé."
        ),
        error_class=PublicationLockTimeout,
    ) as path:
        yield path


def read_publication_journal(root: str | Path) -> dict[str, Any]:
    """Read the publication journal and verify its chain without repairing it."""
    return read_chain(
        journal_path(root),
        entry_id_re=ENTRY_ID_RE,
        label="journal des publications",
        schema_version=PUBLICATION_SCHEMA_VERSION,
    )


def effective_publication(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Replay the journal to derive which snapshot is currently published.

    A REVERT never erases the publication it cancels: the entry stays in the
    chain, the snapshot stays on disk, and the store simply has no active
    snapshot again.
    """
    active: dict[str, Any] | None = None
    reverted: list[str] = []
    replay_issues: list[str] = []

    for entry in entries:
        action = entry.get("action")
        if action == "PUBLISH":
            active = entry
            continue
        if action == "REVERT":
            target = entry.get("reverted_entry_id")
            if active is None or target != active.get("entry_id"):
                replay_issues.append(
                    f"REVERT {entry.get('entry_id')} ne cible pas la publication active."
                )
                continue
            reverted.append(str(target))
            active = None

    return {
        "active": active,
        "reverted_entry_ids": reverted,
        "replay_issues": replay_issues,
        "entry_count": len(entries),
    }


def _history_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "entry_id": entry.get("entry_id"),
        "action": entry.get("action"),
        "snapshot_id": entry.get("snapshot_id"),
        "dataset_id": entry.get("dataset_id"),
        "publisher_id": entry.get("publisher_id"),
        "recorded_at": entry.get("recorded_at"),
        "reverted_entry_id": entry.get("reverted_entry_id"),
    }


def current_publication_state(root: str | Path) -> dict[str, Any]:
    """Journal integrity plus the currently published snapshot, read-only."""
    journal = read_publication_journal(root)
    if journal["integrity"] == "INVALID":
        return {
            "journal_integrity": "INVALID",
            "journal_issue": journal["issue"],
            "entry_count": 0,
            "publication_status": "UNKNOWN",
            "active": None,
            "history": [],
            "replay_issues": [],
            "available": False,
            "blocked_reason": "Le journal des publications est illisible ou altéré ; aucun snapshot n’est servi.",
        }

    state = effective_publication(journal["entries"])
    active = state["active"]
    return {
        "journal_integrity": journal["integrity"],
        "journal_issue": None,
        "entry_count": len(journal["entries"]),
        "publication_status": "PUBLISHED" if active else "NOT_PUBLISHED",
        "active": (
            {
                "snapshot_id": active.get("snapshot_id"),
                "dataset_id": active.get("dataset_id"),
                "dataset_sha256": active.get("dataset_sha256"),
                "database_sha256": active.get("database_sha256"),
                "publisher_id": active.get("publisher_id"),
                "published_at": active.get("recorded_at"),
                "review_entry_id": active.get("review_entry_id"),
                "reviewer_id": active.get("reviewer_id"),
                "separation_of_duties": active.get("separation_of_duties"),
                "realtime": False,
            }
            if isinstance(active, dict)
            else None
        ),
        "history": [_history_entry(entry) for entry in journal["entries"]],
        "replay_issues": state["replay_issues"],
        "available": active is not None,
        "blocked_reason": None,
    }


def next_entry_id(entries: list[dict[str, Any]]) -> str:
    return f"pub-{len(entries) + 1:06d}"


def build_publication_entry(
    *,
    sequence: int,
    action: str,
    snapshot_id: str,
    dataset_id: str,
    dataset_sha256: str,
    database_sha256: str | None,
    publisher_id: str,
    recorded_at: datetime,
    note: str,
    previous_hash: str,
    review_entry_id: str | None = None,
    review_entry_hash: str | None = None,
    reviewer_id: str | None = None,
    record_count: dict[str, int] | None = None,
    reverted_entry_id: str | None = None,
    authentication: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build one hashed journal entry; nothing is written here."""
    if action not in PUBLICATION_ACTIONS:
        raise PublicationError("INVALID_ACTION", f"action doit être l’une de : {', '.join(PUBLICATION_ACTIONS)}.")
    if recorded_at.tzinfo is None or recorded_at.utcoffset() is None:
        raise PublicationError("INVALID_TIMESTAMP", "recorded_at doit être une date/heure avec fuseau horaire.")
    if not DATASET_ID_RE.fullmatch(dataset_id):
        raise PublicationError("INVALID_DATASET_ID", "dataset_id contient des caractères interdits.")
    snapshot = validate_snapshot_id(snapshot_id)
    dataset_digest = validate_sha256(dataset_sha256, "dataset_sha256")
    database_digest = validate_sha256(database_sha256, "database_sha256") if database_sha256 else None
    publisher = validate_publisher_id(publisher_id)
    cleaned_note = _clean_text(note, "note")

    if action == "PUBLISH":
        if database_digest is None:
            raise PublicationError("INVALID_CHECKSUM", "database_sha256 est obligatoire pour publier.")
        review_id = _clean_identifier(review_entry_id or "", "review_entry_id")
        review_hash = validate_sha256(review_entry_hash or "", "review_entry_hash")
        reviewer = validate_publisher_id(reviewer_id or "")
        entry: dict[str, Any] = {
            "schema_version": PUBLICATION_SCHEMA_VERSION,
            "entry_id": f"pub-{sequence:06d}",
            "sequence": sequence,
            "action": "PUBLISH",
            "snapshot_id": snapshot,
            "dataset_id": dataset_id,
            "dataset_sha256": dataset_digest,
            "database_sha256": database_digest,
            "review_entry_id": review_id,
            "review_entry_hash": review_hash,
            "reviewer_id": reviewer,
            "publisher_id": publisher,
            "separation_of_duties": reviewer != publisher,
            "record_count": record_count or {},
            "note": cleaned_note,
            "authentication": authentication,
            "reverted_entry_id": None,
            "recorded_at": recorded_at.astimezone(timezone.utc).isoformat(),
            "publication_status": "PUBLISHED",
            "realtime": False,
        }
    else:
        if database_digest is not None:
            raise PublicationError("INVALID_REVERT", "Une annulation ne réécrit pas l’empreinte du snapshot.")
        entry = {
            "schema_version": PUBLICATION_SCHEMA_VERSION,
            "entry_id": f"pub-{sequence:06d}",
            "sequence": sequence,
            "action": "REVERT",
            "snapshot_id": snapshot,
            "dataset_id": dataset_id,
            "dataset_sha256": dataset_digest,
            "database_sha256": None,
            "review_entry_id": None,
            "review_entry_hash": None,
            "reviewer_id": None,
            "publisher_id": publisher,
            "separation_of_duties": None,
            "record_count": {},
            "note": cleaned_note,
            "authentication": authentication,
            "reverted_entry_id": _clean_identifier(reverted_entry_id or "", "reverted_entry_id"),
            "recorded_at": recorded_at.astimezone(timezone.utc).isoformat(),
            "publication_status": "NOT_PUBLISHED",
            "realtime": False,
        }

    entry["previous_hash"] = previous_hash
    entry["entry_hash"] = compute_entry_hash(entry)
    return entry


def append_publication_entry(root: str | Path, entry: dict[str, Any]) -> Path:
    """Append an entry, fsync it, and leave the previous content untouched."""
    path = journal_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "ab") as handle:
        handle.write((json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    return path


def publication_journal_digest(root: str | Path) -> str | None:
    """SHA-256 of the journal file as it stands, or None when it does not exist."""
    path = journal_path(root)
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def previous_hash_for(entries: list[dict[str, Any]]) -> str:
    if not entries:
        return GENESIS_HASH
    last = entries[-1].get("entry_hash")
    return last if isinstance(last, str) else GENESIS_HASH
