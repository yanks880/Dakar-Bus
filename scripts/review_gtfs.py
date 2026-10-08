#!/usr/bin/env python3
"""Human review workflow for staged GTFS datasets.

Review is the second gate after staging and the last one before publication.
This tool records traceable decisions in an append-only ledger, refuses to
approve a dataset whose provenance is not attested, and never publishes:
`publication_status` stays `NOT_PUBLISHED` whatever the outcome.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.review_gtfs` and as a file script.
    from .catalog_gtfs import inspect_staged_dataset, list_staged_datasets
    from .review_ledger import (
        GENESIS_HASH,
        REQUIRED_ATTESTATIONS,
        LedgerLockTimeout,
        append_entry,
        build_entry,
        current_review_state,
        effective_review,
        ledger_lock,
        read_journal,
        validate_reference,
        validate_reviewer_id,
        _clean_text,
    )
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import inspect_staged_dataset, list_staged_datasets
    from review_ledger import (
        GENESIS_HASH,
        REQUIRED_ATTESTATIONS,
        LedgerLockTimeout,
        append_entry,
        build_entry,
        current_review_state,
        effective_review,
        ledger_lock,
        read_journal,
        validate_reference,
        validate_reviewer_id,
        _clean_text,
    )


class ReviewError(ValueError):
    """A review decision was refused; the ledger is left untouched."""

    def __init__(self, code: str, message: str, blockers: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.blockers = blockers or []


def _require_intact_dataset(inspection: dict[str, Any]) -> tuple[dict[str, Any], str]:
    if inspection["integrity"] != "OK":
        issue = inspection.get("integrity_issue") or {}
        raise ReviewError(
            "DATASET_INTEGRITY_INVALID",
            "La version stagée n’est pas intègre ; aucune décision de revue n’est enregistrée.",
            [f"{issue.get('code')}: {issue.get('message')}"],
        )
    manifest = inspection["manifest"]
    if not isinstance(manifest, dict):
        raise ReviewError("MANIFEST_MISSING", "Le manifeste du dataset est illisible.")
    archive = manifest.get("archive")
    checksum = archive.get("sha256") if isinstance(archive, dict) else None
    if not isinstance(checksum, str):
        raise ReviewError("CHECKSUM_UNAVAILABLE", "L’empreinte SHA-256 du dataset est absente du manifeste.")
    return manifest, checksum


def approval_blockers(
    manifest: dict[str, Any],
    *,
    integrity: str,
    validity_status: str,
    review_status: str,
    ledger_integrity: str,
    attestations: dict[str, dict[str, str | None]],
) -> list[str]:
    """Everything that must be resolved before an approval can be recorded."""
    blockers: list[str] = []
    if integrity != "OK":
        blockers.append("L’intégrité du dataset n’est pas vérifiée (empreinte ou manifeste invalide).")
    if ledger_integrity == "INVALID":
        blockers.append("Le journal de revue est corrompu ; restaurer une sauvegarde avant toute décision.")
    if review_status == "APPROVED":
        blockers.append("Cette version est déjà approuvée ; utiliser revert pour revenir en arrière.")
    if review_status == "REJECTED":
        blockers.append("Un refus est actif ; utiliser revert pour rouvrir la revue avant une nouvelle décision.")
    if validity_status != "CURRENT":
        blockers.append(f"La période de validité effective est {validity_status} ; une version non courante ne peut pas être approuvée.")
    if manifest.get("source_type") == "UNKNOWN":
        blockers.append("Le type de source déclaré est UNKNOWN.")
    if str(manifest.get("operator", "")).strip().casefold() in {"", "unknown"}:
        blockers.append("L’opérateur n’est pas confirmé.")
    if manifest.get("service_status") != "ACTIVE":
        blockers.append("Le statut de service déclaré n’est pas ACTIVE.")
    for item in REQUIRED_ATTESTATIONS:
        if not str(attestations.get(item, {}).get("evidence") or "").strip():
            blockers.append(f"Attestation manquante : {item} — {REQUIRED_ATTESTATIONS[item]}")
    return blockers


def parse_attestations(raw_items: list[str] | None, raw_references: list[str] | None) -> dict[str, dict[str, str | None]]:
    """Turn `--attest item=text` and `--reference item=url` pairs into a mapping."""

    def split_pair(raw: str, flag: str) -> tuple[str, str]:
        if "=" not in raw:
            raise ReviewError("ATTESTATION_FORMAT", f"{flag} attend le format item=valeur.")
        key, _, value = raw.partition("=")
        key = key.strip().casefold()
        if key not in REQUIRED_ATTESTATIONS:
            raise ReviewError(
                "ATTESTATION_UNKNOWN",
                f"« {key} » n’est pas un item d’attestation attendu : {', '.join(sorted(REQUIRED_ATTESTATIONS))}.",
            )
        return key, value

    attestations: dict[str, dict[str, str | None]] = {
        item: {"evidence": None, "reference": None} for item in REQUIRED_ATTESTATIONS
    }
    for raw in raw_items or []:
        key, value = split_pair(raw, "--attest")
        try:
            attestations[key]["evidence"] = _clean_text(value, f"attestation {key}")
        except ValueError as error:
            raise ReviewError("ATTESTATION_INVALID", str(error)) from error
    for raw in raw_references or []:
        key, value = split_pair(raw, "--reference")
        try:
            attestations[key]["reference"] = validate_reference(value, f"référence {key}")
        except ValueError as error:
            raise ReviewError("ATTESTATION_INVALID", str(error)) from error
    return attestations


def _dataset_directory(root: str | Path, dataset_id: str) -> Path:
    return Path(root) / dataset_id


def review_dossier(root: str | Path, dataset_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    """Full read-only review file: declared provenance, integrity, review state."""
    dataset_dir = _dataset_directory(root, dataset_id)
    inspection = inspect_staged_dataset(dataset_dir, now=now)
    review = current_review_state(dataset_dir)
    manifest = inspection.get("manifest") or {}
    archive = manifest.get("archive") if isinstance(manifest, dict) else None
    checksum = archive.get("sha256") if isinstance(archive, dict) else None

    blockers = approval_blockers(
        manifest if isinstance(manifest, dict) else {},
        integrity=inspection["integrity"],
        validity_status=inspection["effective_validity_status"],
        review_status=review["review_status"],
        ledger_integrity=review["ledger_integrity"],
        attestations={},
    )
    return {
        "dataset_id": dataset_id,
        "integrity": inspection["integrity"],
        "integrity_issue": inspection.get("integrity_issue"),
        "effective_validity_status": inspection["effective_validity_status"],
        "review_status": review["review_status"],
        "ledger_integrity": review["ledger_integrity"],
        "ledger_issue": review.get("ledger_issue"),
        "entry_count": review["entry_count"],
        "reviewer_id": review.get("reviewer_id"),
        "reviewed_at": review.get("reviewed_at"),
        "reverted_entry_ids": review.get("reverted_entry_ids", []),
        "decision": review.get("decision"),
        "declared": {
            "operator": manifest.get("operator") if isinstance(manifest, dict) else None,
            "source": manifest.get("source") if isinstance(manifest, dict) else None,
            "source_type": manifest.get("source_type") if isinstance(manifest, dict) else None,
            "source_url": manifest.get("source_url") if isinstance(manifest, dict) else None,
            "dataset_version": manifest.get("dataset_version") if isinstance(manifest, dict) else None,
            "date_source": manifest.get("date_source") if isinstance(manifest, dict) else None,
            "verified_at": manifest.get("verified_at") if isinstance(manifest, dict) else None,
            "valid_from": manifest.get("valid_from") if isinstance(manifest, dict) else None,
            "valid_until": manifest.get("valid_until") if isinstance(manifest, dict) else None,
            "service_status": manifest.get("service_status") if isinstance(manifest, dict) else None,
            "confidence": manifest.get("confidence") if isinstance(manifest, dict) else None,
            "sha256": checksum,
            "record_count": manifest.get("record_count") if isinstance(manifest, dict) else None,
        },
        "required_attestations": REQUIRED_ATTESTATIONS,
        "pending_blockers": blockers,
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "staged_directory": str(dataset_dir),
    }


def review_journal(root: str | Path, dataset_id: str) -> dict[str, Any]:
    """Dump the whole verified chain: every entry, hash-checked, nothing hidden."""
    dataset_dir = _dataset_directory(root, dataset_id)
    journal = read_journal(dataset_dir)
    state = effective_review(journal["entries"]) if journal["integrity"] != "INVALID" else None
    return {
        "dataset_id": dataset_id,
        "ledger_integrity": journal["integrity"],
        "ledger_issue": journal["issue"],
        "journal_path": journal["path"],
        "review_status": state["status"] if state else "UNKNOWN",
        "reverted_entry_ids": state["reverted_entry_ids"] if state else [],
        "entry_count": len(journal["entries"]),
        "entries": journal["entries"],
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
    }


def pending_datasets(root: str | Path, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Datasets waiting for a human decision, in catalog order."""
    queue: list[dict[str, Any]] = []
    for entry in list_staged_datasets(root, now=now):
        state = current_review_state(_dataset_directory(root, str(entry["dataset_id"])))
        queue.append(
            {
                "dataset_id": entry["dataset_id"],
                "integrity": entry["integrity"],
                "effective_validity_status": entry["effective_validity_status"],
                "review_status": state["review_status"],
                "ledger_integrity": state["ledger_integrity"],
                "operator": entry.get("operator"),
                "dataset_version": entry.get("dataset_version"),
                "source": entry.get("source"),
                "source_type": entry.get("source_type"),
                "service_status": entry.get("service_status"),
                "publication_status": "NOT_PUBLISHED",
            }
        )
    return queue


@contextmanager
def _locked_journal(root: str | Path, dataset_id: str) -> Iterator[tuple[Path, dict[str, Any], list[dict[str, Any]], str]]:
    """Hold the exclusive ledger lock across a whole read-decide-append cycle.

    Reading the journal outside the lock would let two reviewers compute the
    same sequence number and break the hash chain.
    """
    dataset_dir = _dataset_directory(root, dataset_id)
    try:
        with ledger_lock(dataset_dir):
            journal = read_journal(dataset_dir)
            if journal["integrity"] == "INVALID":
                raise ReviewError(
                    str(journal["issue"]["code"]),
                    "Le journal de revue est invalide ; aucune écriture n’est ajoutée tant qu’il n’est pas restauré.",
                    [f"{journal['issue']['code']}: {journal['issue']['message']}"],
                )
            entries = journal["entries"]
            previous_hash = entries[-1]["entry_hash"] if entries else GENESIS_HASH
            yield dataset_dir, journal, entries, previous_hash
    except LedgerLockTimeout as error:
        raise ReviewError("LEDGER_LOCKED", str(error)) from error


def approve_dataset(
    root: str | Path,
    dataset_id: str,
    *,
    reviewer_id: str,
    attestations: dict[str, dict[str, str | None]],
    note: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record a traceable approval. Never publishes the dataset."""
    current_time = _checked_now(now)
    reviewer = validate_reviewer_id(reviewer_id)
    inspection = inspect_staged_dataset(_dataset_directory(root, dataset_id), now=current_time)
    manifest, checksum = _require_intact_dataset(inspection)

    with _locked_journal(root, dataset_id) as (dataset_dir, journal, entries, previous_hash):
        review = current_review_state(dataset_dir)
        blockers = approval_blockers(
            manifest,
            integrity=inspection["integrity"],
            validity_status=inspection["effective_validity_status"],
            review_status=review["review_status"],
            ledger_integrity=journal["integrity"],
            attestations=attestations,
        )
        if blockers:
            raise ReviewError(
                "APPROVAL_BLOCKED",
                "L’approbation est refusée : des vérifications obligatoires ne sont pas attestées.",
                blockers,
            )

        entry = build_entry(
            sequence=len(entries) + 1,
            action="APPROVE",
            dataset_id=dataset_id,
            dataset_sha256=checksum,
            reviewer_id=reviewer,
            recorded_at=current_time,
            note=_clean_text(note, "note") if note else "Approbation après vérification des attestations obligatoires.",
            previous_hash=previous_hash,
            attestations=attestations,
            decision_basis={
                "source_type": manifest.get("source_type"),
                "service_status": manifest.get("service_status"),
                "validity_status": inspection["effective_validity_status"],
                "archive_sha256": checksum,
                "validator": manifest.get("validation", {}).get("validator") if isinstance(manifest.get("validation"), dict) else None,
            },
        )
        append_entry(dataset_dir, entry)

    return {
        "recorded": True,
        "action": "APPROVE",
        "dataset_id": dataset_id,
        "review_status": "APPROVED",
        "reviewer_id": reviewer,
        "entry_id": entry["entry_id"],
        "entry_hash": entry["entry_hash"],
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "publication_note": "Une approbation ne publie rien : la publication reste une étape séparée, tracée et réversible.",
        "entry": entry,
    }


def reject_dataset(
    root: str | Path,
    dataset_id: str,
    *,
    reviewer_id: str,
    reason: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Record a rejection with a mandatory explanation."""
    current_time = _checked_now(now)
    reviewer = validate_reviewer_id(reviewer_id)
    inspection = inspect_staged_dataset(_dataset_directory(root, dataset_id), now=current_time)
    _manifest, checksum = _require_intact_dataset(inspection)

    with _locked_journal(root, dataset_id) as (dataset_dir, _journal, entries, previous_hash):
        review = current_review_state(dataset_dir)
        if review["review_status"] == "APPROVED":
            raise ReviewError(
                "APPROVAL_ALREADY_RECORDED",
                "La version est déjà approuvée ; utiliser revert avant d’enregistrer un refus.",
            )
        if review["review_status"] == "REJECTED":
            raise ReviewError("ALREADY_REJECTED", "Un refus est déjà enregistré pour cette version.")

        entry = build_entry(
            sequence=len(entries) + 1,
            action="REJECT",
            dataset_id=dataset_id,
            dataset_sha256=checksum,
            reviewer_id=reviewer,
            recorded_at=current_time,
            note=_clean_text(reason, "motif de refus"),
            previous_hash=previous_hash,
            decision_basis={"archive_sha256": checksum},
        )
        append_entry(dataset_dir, entry)

    return {
        "recorded": True,
        "action": "REJECT",
        "dataset_id": dataset_id,
        "review_status": "REJECTED",
        "reviewer_id": reviewer,
        "entry_id": entry["entry_id"],
        "entry_hash": entry["entry_hash"],
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "entry": entry,
    }


def revert_decision(
    root: str | Path,
    dataset_id: str,
    *,
    reviewer_id: str,
    entry_id: str,
    reason: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Cancel the active decision by appending a REVERT entry (nothing is erased)."""
    current_time = _checked_now(now)
    reviewer = validate_reviewer_id(reviewer_id)
    inspection = inspect_staged_dataset(_dataset_directory(root, dataset_id), now=current_time)
    _manifest, checksum = _require_intact_dataset(inspection)

    with _locked_journal(root, dataset_id) as (dataset_dir, _journal, entries, previous_hash):
        review = current_review_state(dataset_dir)
        decision = review.get("decision")
        if not isinstance(decision, dict):
            raise ReviewError("NO_ACTIVE_DECISION", "Aucune décision active à annuler pour cette version.")
        if decision.get("entry_id") != entry_id:
            raise ReviewError(
                "REVERT_TARGET_MISMATCH",
                "Seule la dernière décision active peut être annulée ; le journal reste inchangé.",
                [f"Décision active : {decision.get('entry_id')} ; demandé : {entry_id}"],
            )

        entry = build_entry(
            sequence=len(entries) + 1,
            action="REVERT",
            dataset_id=dataset_id,
            dataset_sha256=checksum,
            reviewer_id=reviewer,
            recorded_at=current_time,
            note=_clean_text(reason, "motif d’annulation"),
            previous_hash=previous_hash,
            reverted_entry_id=str(entry_id),
            decision_basis={"reverted_action": decision.get("action"), "archive_sha256": checksum},
        )
        append_entry(dataset_dir, entry)

    return {
        "recorded": True,
        "action": "REVERT",
        "dataset_id": dataset_id,
        "review_status": "PENDING_REVIEW",
        "reviewer_id": reviewer,
        "entry_id": entry["entry_id"],
        "reverted_entry_id": entry_id,
        "entry_hash": entry["entry_hash"],
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "entry": entry,
    }


def _checked_now(now: datetime | None) -> datetime:
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None or current_time.utcoffset() is None:
        raise ValueError("now doit être une date/heure avec fuseau horaire.")
    return current_time.astimezone(timezone.utc)


def _emit(result: object) -> None:
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Revue humaine traçable des versions GTFS stagées (aucune publication)."
    )
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("pending", help="Lister la file d’attente de revue")
    show_parser = subparsers.add_parser("show", help="Afficher le dossier de revue d’une version")
    show_parser.add_argument("dataset_id")
    journal_parser = subparsers.add_parser("journal", help="Afficher la chaîne de décisions vérifiée")
    journal_parser.add_argument("dataset_id")

    approve_parser = subparsers.add_parser("approve", help="Approuver une version avec attestations nominatives")
    approve_parser.add_argument("dataset_id")
    approve_parser.add_argument("--reviewer", required=True, help="Identifiant nominatif du relecteur")
    approve_parser.add_argument("--attest", action="append", metavar="ITEM=PREUVE", help="Attestation obligatoire (répétable)")
    approve_parser.add_argument("--reference", action="append", metavar="ITEM=URL", help="Preuve URL d’une attestation (répétable)")
    approve_parser.add_argument("--note", help="Note libre du relecteur")

    reject_parser = subparsers.add_parser("reject", help="Refuser une version avec un motif")
    reject_parser.add_argument("dataset_id")
    reject_parser.add_argument("--reviewer", required=True, help="Identifiant nominatif du relecteur")
    reject_parser.add_argument("--reason", required=True, help="Motif du refus")

    revert_parser = subparsers.add_parser("revert", help="Annuler la dernière décision (retour arrière traçable)")
    revert_parser.add_argument("dataset_id")
    revert_parser.add_argument("--reviewer", required=True, help="Identifiant nominatif du relecteur")
    revert_parser.add_argument("--entry-id", required=True, help="Identifiant de la décision à annuler")
    revert_parser.add_argument("--reason", required=True, help="Motif de l’annulation")

    args = parser.parse_args()

    try:
        if args.command == "pending":
            queue = pending_datasets(args.root)
            _emit({"root": str(args.root), "pending": queue, "publication_status": "NOT_PUBLISHED"})
            return 0
        if args.command == "show":
            _emit(review_dossier(args.root, args.dataset_id))
            return 0
        if args.command == "journal":
            journal = review_journal(args.root, args.dataset_id)
            _emit(journal)
            return 0 if journal["ledger_integrity"] != "INVALID" else 1
        if args.command == "approve":
            attestations = parse_attestations(args.attest, args.reference)
            result = approve_dataset(
                args.root,
                args.dataset_id,
                reviewer_id=args.reviewer,
                attestations=attestations,
                note=args.note,
            )
        elif args.command == "reject":
            result = reject_dataset(args.root, args.dataset_id, reviewer_id=args.reviewer, reason=args.reason)
        else:
            result = revert_decision(
                args.root,
                args.dataset_id,
                reviewer_id=args.reviewer,
                entry_id=args.entry_id,
                reason=args.reason,
            )
        _emit(result)
        return 0
    except ReviewError as error:
        _emit(
            {
                "recorded": False,
                "error": error.code,
                "message": error.message,
                "blockers": error.blockers,
                "publication_status": "NOT_PUBLISHED",
                "publication_ready": False,
            }
        )
        return 1
    except ValueError as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
