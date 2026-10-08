#!/usr/bin/env python3
"""Append-only, hash-chained review ledger for staged GTFS datasets.

The ledger is the only place a human decision is recorded. It never edits the
staging manifest, never deletes an entry, and never publishes a dataset: an
approval is a traceable statement by a named reviewer, not a deployment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:  # POSIX only; on other platforms the lock degrades to a documented no-op.
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX platform
    fcntl = None  # type: ignore[assignment]

LEDGER_SCHEMA_VERSION = "1.0"
REVIEW_SUBDIR = "review"
JOURNAL_FILENAME = "journal.jsonl"
LOCK_FILENAME = "journal.lock"
DEFAULT_LOCK_TIMEOUT_SECONDS = 10.0
GENESIS_HASH = "0" * 64
ENTRY_ID_RE = re.compile(r"^rv-[0-9]{6}$")
REVIEWER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")

DECISION_ACTIONS = ("APPROVE", "REJECT")
LEDGER_ACTIONS = (*DECISION_ACTIONS, "REVERT")
REVIEW_STATUSES = ("PENDING_REVIEW", "APPROVED", "REJECTED")

PLACEHOLDER_REVIEWERS = {
    "unknown", "anon", "anonymous", "system", "auto", "bot", "ci",
    "todo", "tbd", "test", "tester", "admin", "root", "nobody",
}

MIN_TEXT_LENGTH = 12
MAX_TEXT_LENGTH = 600

REQUIRED_ATTESTATIONS: dict[str, str] = {
    "source_identity": "Identité de la source et URL vérifiées auprès de l’éditeur.",
    "reuse_rights": "Droit de réutilisation confirmé (licence et conditions d’usage).",
    "operator_confirmed": "Opérateur confirmé, réseaux distincts non confondus (AFTU / TATA séparés).",
    "service_operational": "Service réellement exploité aux dates déclarées.",
    "freshness_confirmed": "Fraîcheur et période de validité confirmées avec la source.",
}


def _clean_text(value: str, field: str) -> str:
    text = " ".join(value.split())
    if len(text) < MIN_TEXT_LENGTH:
        raise ValueError(f"{field} doit contenir au moins {MIN_TEXT_LENGTH} caractères utiles.")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"{field} doit rester sous {MAX_TEXT_LENGTH} caractères.")
    return text


def validate_reviewer_id(reviewer_id: str) -> str:
    """A decision must name an identifiable human, not a generic account."""
    candidate = reviewer_id.strip().casefold()
    if not REVIEWER_ID_RE.fullmatch(candidate):
        raise ValueError("reviewer_id doit être un identifiant lisible de 3 à 64 caractères (lettres, chiffres, . _ -).")
    if candidate in PLACEHOLDER_REVIEWERS:
        raise ValueError("reviewer_id doit identifier une personne précise ; les comptes génériques ne sont pas acceptés.")
    return candidate


def validate_reference(reference: str, field: str) -> str:
    url = reference.strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"{field} doit être une URL HTTP(S) absolue servant de preuve.")
    if parsed.username or parsed.password:
        raise ValueError(f"{field} ne doit pas contenir d’identifiants d’accès.")
    return url


def canonical_payload(entry: dict[str, Any]) -> str:
    """Stable serialisation of an entry, excluding its own hash."""
    payload = {key: value for key, value in entry.items() if key != "entry_hash"}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def compute_entry_hash(entry: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_payload(entry).encode("utf-8")).hexdigest()


def ledger_dir(dataset_dir: str | Path) -> Path:
    return Path(dataset_dir) / REVIEW_SUBDIR


def journal_path(dataset_dir: str | Path) -> Path:
    return ledger_dir(dataset_dir) / JOURNAL_FILENAME


class LedgerLockTimeout(RuntimeError):
    """Another reviewer is writing; the ledger was left untouched."""


@contextmanager
def file_lock(
    lock_path: Path,
    *,
    subject: str,
    timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS,
    message: str | None = None,
    error_class: type[RuntimeError] = LedgerLockTimeout,
) -> Iterator[Path]:
    """Serialise writers with an advisory flock, released by the kernel on exit.

    Callers must read the journal *inside* the lock, otherwise two writers can
    both compute the same sequence number and break the hash chain. A crashed
    process cannot leave the lock stuck: the kernel drops it.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+b")
    acquired = False
    try:
        if fcntl is None:  # pragma: no cover - non-POSIX platform
            yield lock_path
            return
        deadline = time.monotonic() + max(timeout, 0.0)
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise error_class(
                        message or f"Le journal de « {subject} » est verrouillé par une autre écriture ; rien n’a été écrit."
                    ) from None
                time.sleep(0.02)
        yield lock_path
    finally:
        if acquired and fcntl is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            except OSError:  # pragma: no cover - lock already released
                pass
        handle.close()


@contextmanager
def ledger_lock(dataset_dir: str | Path, *, timeout: float = DEFAULT_LOCK_TIMEOUT_SECONDS) -> Iterator[Path]:
    """Serialise reviewers on one dataset for the whole read-decide-append cycle."""
    ledger = ledger_dir(dataset_dir)
    with file_lock(ledger / LOCK_FILENAME, subject=Path(dataset_dir).name, timeout=timeout) as path:
        yield path


def _issue(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def read_chain(
    path: Path,
    *,
    entry_id_re: re.Pattern[str],
    label: str = "journal",
    schema_version: str = LEDGER_SCHEMA_VERSION,
    entry_id_field: str = "entry_id",
) -> dict[str, Any]:
    """Read one append-only chain and verify it without repairing anything.

    The review ledger and the publication journal share this rule: every line is
    JSON, numbered from one, linked to the previous entry by SHA-256 and must
    match its own hash. Shared here so both journals are checked identically.
    """
    if not path.exists():
        return {"integrity": "EMPTY", "issue": None, "entries": [], "path": str(path)}
    if path.is_symlink() or not path.is_file():
        return {
            "integrity": "INVALID",
            "issue": _issue("JOURNAL_UNSAFE", f"Le {label} est un lien symbolique ou n’est pas un fichier."),
            "entries": [],
            "path": str(path),
        }
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        return {
            "integrity": "INVALID",
            "issue": _issue("JOURNAL_UNREADABLE", f"Le {label} ne peut pas être lu : {error}"),
            "entries": [],
            "path": str(path),
        }

    entries: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        if not line.strip():
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_EMPTY_LINE", f"Le {label} contient une ligne vide (ligne {line_number})."),
                "entries": [],
                "path": str(path),
            }
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_NOT_JSON", f"La ligne {line_number} du {label} n’est pas du JSON : {error}"),
                "entries": [],
                "path": str(path),
            }
        if not isinstance(entry, dict) or entry.get("schema_version") != schema_version:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_SCHEMA_UNSUPPORTED", f"La ligne {line_number} n’utilise pas le schéma {schema_version}."),
                "entries": [],
                "path": str(path),
            }
        entries.append(entry)

    expected_previous = GENESIS_HASH
    for index, entry in enumerate(entries, start=1):
        entry_id = entry.get(entry_id_field)
        if not isinstance(entry_id, str) or not entry_id_re.fullmatch(entry_id):
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_ENTRY_ID_INVALID", f"{entry_id_field} manquant ou invalide à la ligne {index}."),
                "entries": entries,
                "path": str(path),
            }
        if entry.get("sequence") != index:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_SEQUENCE_BROKEN", f"La séquence est interrompue à la ligne {index} ({entry_id})."),
                "entries": entries,
                "path": str(path),
            }
        if entry.get("previous_hash") != expected_previous:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_CHAIN_BROKEN", f"Le chaînage est rompu à la ligne {index} ({entry_id})."),
                "entries": entries,
                "path": str(path),
            }
        recorded_hash = entry.get("entry_hash")
        if not isinstance(recorded_hash, str) or recorded_hash != compute_entry_hash(entry):
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_HASH_MISMATCH", f"L’empreinte de la ligne {index} ({entry_id}) ne correspond pas à son contenu."),
                "entries": entries,
                "path": str(path),
            }
        expected_previous = recorded_hash

    if not entries:
        return {"integrity": "EMPTY", "issue": None, "entries": [], "path": str(path)}
    return {"integrity": "OK", "issue": None, "entries": entries, "path": str(path)}


def read_journal(dataset_dir: str | Path) -> dict[str, Any]:
    """Read the review journal and verify its hash chain without repairing it."""
    return read_chain(journal_path(dataset_dir), entry_id_re=ENTRY_ID_RE, label="journal")


def effective_review(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Replay the journal to derive the current review state.

    A REVERT never erases the decision it cancels: the entry stays in the chain
    and the dataset simply returns to PENDING_REVIEW.
    """
    status = "PENDING_REVIEW"
    decision: dict[str, Any] | None = None
    reverted: list[str] = []
    replay_issues: list[str] = []

    for entry in entries:
        action = entry.get("action")
        if action in DECISION_ACTIONS:
            status = "APPROVED" if action == "APPROVE" else "REJECTED"
            decision = entry
            continue
        if action == "REVERT":
            target = entry.get("reverted_entry_id")
            if decision is None or target != decision.get("entry_id"):
                replay_issues.append(
                    f"REVERT {entry.get('entry_id')} ne cible pas la dernière décision active."
                )
                continue
            reverted.append(str(target))
            status = "PENDING_REVIEW"
            decision = None

    return {
        "status": status,
        "decision": decision,
        "reverted_entry_ids": reverted,
        "replay_issues": replay_issues,
        "entry_count": len(entries),
    }


def current_review_state(dataset_dir: str | Path) -> dict[str, Any]:
    """Ledger integrity plus effective review state, read-only."""
    journal = read_journal(dataset_dir)
    if journal["integrity"] == "INVALID":
        return {
            "review_status": "UNKNOWN",
            "ledger_integrity": "INVALID",
            "ledger_issue": journal["issue"],
            "decision": None,
            "reverted_entry_ids": [],
            "replay_issues": [],
            "entry_count": 0,
            "reviewed_at": None,
            "reviewer_id": None,
            "entry_count_total": 0,
        }

    state = effective_review(journal["entries"])
    decision = state["decision"]
    return {
        "review_status": state["status"],
        "ledger_integrity": journal["integrity"],
        "ledger_issue": None,
        "decision": decision,
        "reverted_entry_ids": state["reverted_entry_ids"],
        "replay_issues": state["replay_issues"],
        "entry_count": len(journal["entries"]),
        "reviewed_at": decision.get("recorded_at") if isinstance(decision, dict) else None,
        "reviewer_id": decision.get("reviewer_id") if isinstance(decision, dict) else None,
    }


def next_entry_id(entries: list[dict[str, Any]]) -> str:
    return f"rv-{len(entries) + 1:06d}"


def build_entry(
    *,
    sequence: int,
    action: str,
    dataset_id: str,
    dataset_sha256: str,
    reviewer_id: str,
    recorded_at: datetime,
    note: str,
    previous_hash: str,
    attestations: dict[str, dict[str, str | None]] | None = None,
    reverted_entry_id: str | None = None,
    decision_basis: dict[str, Any] | None = None,
    authentication: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if action not in LEDGER_ACTIONS:
        raise ValueError(f"action doit être l’une de : {', '.join(LEDGER_ACTIONS)}.")
    if recorded_at.tzinfo is None or recorded_at.utcoffset() is None:
        raise ValueError("recorded_at doit être une date/heure avec fuseau horaire.")

    entry: dict[str, Any] = {
        "schema_version": LEDGER_SCHEMA_VERSION,
        "entry_id": f"rv-{sequence:06d}",
        "sequence": sequence,
        "action": action,
        "dataset_id": dataset_id,
        "dataset_sha256": dataset_sha256,
        "reviewer_id": reviewer_id,
        "recorded_at": recorded_at.astimezone(timezone.utc).isoformat(),
        "note": note,
        "attestations": attestations or {},
        "reverted_entry_id": reverted_entry_id,
        "decision_basis": decision_basis or {},
        # None when a decision was recorded without an authenticated actor: the
        # absence is visible in the chain instead of being silently assumed.
        "authentication": authentication,
        "previous_hash": previous_hash,
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
    }
    entry["entry_hash"] = compute_entry_hash(entry)
    return entry


def append_entry(dataset_dir: str | Path, entry: dict[str, Any]) -> Path:
    """Append an entry, fsync it, and keep the previous content untouched."""
    path = journal_path(dataset_dir)
    ledger = ledger_dir(dataset_dir)
    ledger.mkdir(parents=True, exist_ok=True)
    with open(path, "ab") as handle:
        handle.write((json.dumps(entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    return path
