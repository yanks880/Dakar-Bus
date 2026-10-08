#!/usr/bin/env python3
"""Read-only catalog for staged GTFS versions.

This tool verifies the staged archive checksum, exposes declared metadata, and
reports the current review state read from the append-only review ledger. It
does not approve, publish, delete, or alter datasets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.catalog_gtfs` and as a file script.
    from .review_ledger import current_review_state
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from review_ledger import current_review_state

SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
DATASET_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,100}$")
SOURCE_TYPES = {"OFFICIAL", "GTFS", "VERIFIED", "COMMUNITY", "UNKNOWN"}
SERVICE_STATUSES = {"ACTIVE", "PLANNED", "SUSPENDED", "UNKNOWN"}


def _parse_utc(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _invalid_entry(dataset_id: str, code: str, message: str) -> dict[str, Any]:
    return {
        "dataset_id": dataset_id,
        "integrity": "INVALID",
        "integrity_issue": {"code": code, "message": message},
        "manifest": None,
        "effective_validity_status": "UNKNOWN",
        "review": {"review_status": "UNKNOWN", "ledger_integrity": "UNKNOWN", "ledger_issue": None, "entry_count": 0},
    }


def inspect_staged_dataset(directory: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Read a staged manifest and verify its archive without extracting it."""
    dataset_dir = Path(directory)
    dataset_id = dataset_dir.name
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None or current_time.utcoffset() is None:
        raise ValueError("now doit être une date/heure avec fuseau horaire.")
    current_time = current_time.astimezone(timezone.utc)

    if not DATASET_ID_RE.fullmatch(dataset_id):
        return _invalid_entry(dataset_id, "INVALID_DATASET_ID", "Le nom du dossier du dataset contient des caractères interdits.")
    if dataset_dir.is_symlink() or not dataset_dir.is_dir():
        return _invalid_entry(dataset_id, "UNSAFE_DATASET_DIRECTORY", "Le dossier du dataset est absent, invalide ou symbolique.")

    manifest_path = dataset_dir / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        return _invalid_entry(dataset_id, "MANIFEST_MISSING", "Le manifeste est absent ou symbolique.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return _invalid_entry(dataset_id, "MANIFEST_INVALID", f"Le manifeste n’est pas un JSON lisible : {error}.")
    if not isinstance(manifest, dict):
        return _invalid_entry(dataset_id, "MANIFEST_INVALID", "Le manifeste doit être un objet JSON.")
    if manifest.get("schema_version") != "1.0":
        return _invalid_entry(dataset_id, "UNSUPPORTED_MANIFEST_SCHEMA", "La version du schéma du manifeste n’est pas prise en charge.")
    if manifest.get("dataset_id") != dataset_id:
        return _invalid_entry(dataset_id, "DATASET_ID_MISMATCH", "L’identifiant du manifeste ne correspond pas au dossier.")
    if manifest.get("publication_status") != "NOT_PUBLISHED" or manifest.get("publication_ready") is not False:
        return _invalid_entry(dataset_id, "PUBLICATION_POLICY_VIOLATION", "Le manifeste ne respecte pas la règle de staging non publié.")
    if manifest.get("review_status") != "PENDING_REVIEW":
        return _invalid_entry(dataset_id, "REVIEW_POLICY_VIOLATION", "Le catalogue CLI ne modifie pas le statut de revue ; une version stagée doit rester PENDING_REVIEW.")
    for field in ("dataset_version", "operator", "source"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            return _invalid_entry(dataset_id, "MANIFEST_METADATA_INVALID", f"Le champ requis « {field} » est absent ou vide.")
    source_type = manifest.get("source_type")
    if not isinstance(source_type, str) or source_type not in SOURCE_TYPES:
        return _invalid_entry(dataset_id, "MANIFEST_METADATA_INVALID", "source_type est absent ou non reconnu.")
    service_status = manifest.get("service_status")
    if not isinstance(service_status, str) or service_status not in SERVICE_STATUSES:
        return _invalid_entry(dataset_id, "MANIFEST_METADATA_INVALID", "service_status est absent ou non reconnu.")
    confidence = manifest.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
        return _invalid_entry(dataset_id, "MANIFEST_METADATA_INVALID", "confidence doit être numérique et compris entre 0 et 1.")
    record_counts = manifest.get("record_count")
    if not isinstance(record_counts, dict) or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in record_counts.values()):
        return _invalid_entry(dataset_id, "MANIFEST_RECORD_COUNTS_INVALID", "record_count doit être une table de comptages entiers non négatifs.")
    if not isinstance(manifest.get("validation"), dict) or manifest["validation"].get("status") != "STRUCTURALLY_VALID":
        return _invalid_entry(dataset_id, "MANIFEST_VALIDATION_INVALID", "Le manifeste ne contient pas un résultat de validation structurelle valide.")

    archive_metadata = manifest.get("archive")
    if not isinstance(archive_metadata, dict) or archive_metadata.get("stored_as") != "feed.zip":
        return _invalid_entry(dataset_id, "UNSAFE_ARCHIVE_REFERENCE", "Le manifeste doit référencer uniquement l’archive feed.zip du dossier.")
    archive_path = dataset_dir / "feed.zip"
    if archive_path.is_symlink() or not archive_path.is_file():
        return _invalid_entry(dataset_id, "ARCHIVE_MISSING", "L’archive feed.zip est absente ou symbolique.")

    expected_hash = archive_metadata.get("sha256")
    if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
        return _invalid_entry(dataset_id, "INVALID_CHECKSUM", "Le SHA-256 du manifeste est absent ou mal formé.")
    expected_size = archive_metadata.get("bytes")
    if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size < 0:
        return _invalid_entry(dataset_id, "INVALID_ARCHIVE_SIZE", "La taille déclarée de l’archive est absente ou invalide.")

    try:
        actual_size = archive_path.stat().st_size
        actual_hash = _sha256(archive_path)
    except OSError as error:
        return _invalid_entry(dataset_id, "ARCHIVE_READ_ERROR", f"L’archive ne peut pas être contrôlée : {error}.")
    if actual_size != expected_size:
        return _invalid_entry(dataset_id, "ARCHIVE_SIZE_MISMATCH", "La taille de l’archive ne correspond pas au manifeste.")
    if actual_hash != expected_hash:
        return _invalid_entry(dataset_id, "ARCHIVE_CHECKSUM_MISMATCH", "Le SHA-256 de l’archive ne correspond pas au manifeste.")

    valid_from = _parse_utc(manifest.get("valid_from"))
    valid_until = _parse_utc(manifest.get("valid_until"))
    if valid_from is None or valid_until is None or valid_until <= valid_from:
        return _invalid_entry(dataset_id, "MANIFEST_VALIDITY_INVALID", "valid_from/valid_until sont absents, mal formés ou incohérents.")
    ingested_at = _parse_utc(manifest.get("ingested_at"))
    verified_at = _parse_utc(manifest.get("verified_at"))
    # Older staging manifests rounded ingested_at down to seconds; allow their
    # sub-second precision loss while keeping newer precise timestamps strict.
    timestamp_tolerance = timedelta(seconds=1) if ingested_at is not None and ingested_at.microsecond == 0 else timedelta(0)
    if ingested_at is None or verified_at is None or verified_at > ingested_at + timestamp_tolerance:
        return _invalid_entry(dataset_id, "MANIFEST_TIMESTAMP_INVALID", "ingested_at/verified_at sont absents, mal formés ou incohérents.")
    if current_time < valid_from:
        validity_status = "NOT_YET_VALID"
    elif current_time >= valid_until:
        validity_status = "STALE"
    else:
        validity_status = "CURRENT"

    return {
        "dataset_id": dataset_id,
        "integrity": "OK",
        "integrity_issue": None,
        "effective_validity_status": validity_status,
        "review": current_review_state(dataset_dir),
        "manifest": manifest,
    }


def list_staged_datasets(root: str | Path, *, now: datetime | None = None) -> list[dict[str, Any]]:
    catalog_root = Path(root)
    if not catalog_root.exists():
        return []
    if catalog_root.is_symlink() or not catalog_root.is_dir():
        raise ValueError("Le répertoire du catalogue doit être un dossier local non symbolique.")

    entries: list[dict[str, Any]] = []
    for child in sorted(catalog_root.iterdir(), key=lambda path: path.name.casefold()):
        if child.name.startswith("."):
            continue  # Ignore an interrupted temporary staging directory.
        if not child.is_dir() and not child.is_symlink():
            continue
        inspected = inspect_staged_dataset(child, now=now)
        manifest = inspected.get("manifest")
        review = inspected.get("review") or {}
        summary = {
            "dataset_id": inspected["dataset_id"],
            "integrity": inspected["integrity"],
            "integrity_issue": inspected["integrity_issue"],
            "effective_validity_status": inspected["effective_validity_status"],
            "review_status": review.get("review_status", "UNKNOWN"),
            "ledger_integrity": review.get("ledger_integrity", "UNKNOWN"),
            "reviewer_id": review.get("reviewer_id"),
            "reviewed_at": review.get("reviewed_at"),
            "publication_status": "NOT_PUBLISHED",
        }
        if isinstance(manifest, dict):
            # review_status and publication_status are reported from the review
            # ledger and the staging policy, never copied from the frozen manifest.
            for key in (
                "dataset_version", "operator", "source", "source_type", "confidence",
                "service_status", "record_count", "ingested_at",
            ):
                summary[key] = manifest.get(key)
        entries.append(summary)
    return entries


def show_staged_dataset(root: str | Path, dataset_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    if not DATASET_ID_RE.fullmatch(dataset_id):
        raise ValueError("dataset_id contient des caractères interdits.")
    return inspect_staged_dataset(Path(root) / dataset_id, now=now)


def compare_staged_datasets(root: str | Path, before_id: str, after_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    if before_id == after_id:
        raise ValueError("Choisir deux dataset_id différents pour comparer des versions.")
    before = show_staged_dataset(root, before_id, now=now)
    after = show_staged_dataset(root, after_id, now=now)
    if before["integrity"] != "OK" or after["integrity"] != "OK":
        return {
            "comparable": False,
            "message": "Une version est absente, altérée ou invalide ; la comparaison est bloquée.",
            "before": before,
            "after": after,
        }

    before_manifest = before["manifest"]
    after_manifest = after["manifest"]
    before_counts = before_manifest.get("record_count", {})
    after_counts = after_manifest.get("record_count", {})
    if not isinstance(before_counts, dict):
        before_counts = {}
    if not isinstance(after_counts, dict):
        after_counts = {}
    table_names = sorted(set(before_counts) | set(after_counts))
    count_delta: dict[str, int | None] = {}
    for table_name in table_names:
        previous = before_counts.get(table_name)
        current = after_counts.get(table_name)
        if isinstance(previous, int) and isinstance(current, int):
            count_delta[table_name] = current - previous
        else:
            count_delta[table_name] = None

    return {
        "comparable": True,
        "comparison_scope": "Record counts and manifest metadata only; no row-by-row timetable or geometry diff is performed.",
        "before": {
            "dataset_id": before_id,
            "dataset_version": before_manifest.get("dataset_version"),
            "checksum": before_manifest.get("archive", {}).get("sha256"),
            "validity_status": before["effective_validity_status"],
        },
        "after": {
            "dataset_id": after_id,
            "dataset_version": after_manifest.get("dataset_version"),
            "checksum": after_manifest.get("archive", {}).get("sha256"),
            "validity_status": after["effective_validity_status"],
        },
        "record_count_delta": count_delta,
        "metadata_changed": {
            key: before_manifest.get(key) != after_manifest.get(key)
            for key in (
                "dataset_version", "operator", "source", "source_type", "source_url", "date_source",
                "valid_from", "valid_until", "service_status", "confidence",
            )
        },
    }


def _emit(result: object) -> None:
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Catalogue GTFS local en lecture seule : versions, intégrité et différences de comptage.")
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list", help="Lister les versions et vérifier leurs empreintes")
    show_parser = subparsers.add_parser("show", help="Afficher le manifeste et son intégrité")
    show_parser.add_argument("dataset_id")
    compare_parser = subparsers.add_parser("compare", help="Comparer les comptages de deux versions")
    compare_parser.add_argument("before_id")
    compare_parser.add_argument("after_id")
    args = parser.parse_args()

    try:
        if args.command == "list":
            result = list_staged_datasets(args.root)
            _emit(result)
            healthy = all(
                entry["integrity"] == "OK" and entry.get("ledger_integrity") in {"OK", "EMPTY"}
                for entry in result
            )
            return 0 if healthy else 1
        if args.command == "show":
            result = show_staged_dataset(args.root, args.dataset_id)
            _emit(result)
            return 0 if result["integrity"] == "OK" else 1
        result = compare_staged_datasets(args.root, args.before_id, args.after_id)
        _emit(result)
        return 0 if result["comparable"] else 1
    except ValueError as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
