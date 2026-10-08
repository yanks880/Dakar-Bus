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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

LEDGER_SCHEMA_VERSION = "1.0"
REVIEW_SUBDIR = "review"
JOURNAL_FILENAME = "journal.jsonl"
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


def _issue(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def read_journal(dataset_dir: str | Path) -> dict[str, Any]:
    """Read the journal and verify its hash chain without repairing anything."""
    path = journal_path(dataset_dir)
    if not path.exists():
        return {"integrity": "EMPTY", "issue": None, "entries": [], "path": str(path)}
    if path.is_symlink() or not path.is_file():
        return {
            "integrity": "INVALID",
            "issue": _issue("JOURNAL_UNSAFE", "Le journal est un lien symbolique ou n’est pas un fichier."),
            "entries": [],
            "path": str(path),
        }
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        return {
            "integrity": "INVALID",
            "issue": _issue("JOURNAL_UNREADABLE", f"Le journal ne peut pas être lu : {error}"),
            "entries": [],
            "path": str(path),
        }

    entries: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        if not line.strip():
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_EMPTY_LINE", f"Le journal contient une ligne vide (ligne {line_number})."),
                "entries": [],
                "path": str(path),
            }
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_NOT_JSON", f"La ligne {line_number} du journal n’est pas du JSON : {error}"),
                "entries": [],
                "path": str(path),
            }
        if not isinstance(entry, dict) or entry.get("schema_version") != LEDGER_SCHEMA_VERSION:
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_SCHEMA_UNSUPPORTED", f"La ligne {line_number} n’utilise pas le schéma {LEDGER_SCHEMA_VERSION}."),
                "entries": [],
                "path": str(path),
            }
        entries.append(entry)

    expected_previous = GENESIS_HASH
    for index, entry in enumerate(entries, start=1):
        entry_id = entry.get("entry_id")
        if not isinstance(entry_id, str) or not ENTRY_ID_RE.fullmatch(entry_id):
            return {
                "integrity": "INVALID",
                "issue": _issue("JOURNAL_ENTRY_ID_INVALID", f"entry_id manquant ou invalide à la ligne {index}."),
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
