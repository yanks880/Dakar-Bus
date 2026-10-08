#!/usr/bin/env python3
"""Stage a validated GTFS archive with explicit, unverified provenance metadata.

Staging is not publication. This command never exposes records to the app and
always leaves human/source review pending.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

try:  # Works both as `python -m scripts.stage_gtfs` and as a file script.
    from .validate_gtfs import validate_gtfs_archive
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from validate_gtfs import validate_gtfs_archive


SOURCE_TYPES = {"OFFICIAL", "GTFS", "VERIFIED", "COMMUNITY", "UNKNOWN"}
SERVICE_STATUSES = {"ACTIVE", "PLANNED", "SUSPENDED", "UNKNOWN"}


@dataclass(frozen=True)
class IngestMetadata:
    source: str
    source_type: str
    date_source: str
    verified_at: str
    valid_from: str
    valid_until: str
    confidence: float
    operator: str
    dataset_version: str
    service_status: str = "UNKNOWN"
    source_url: str | None = None


def _parse_instant(value: str, field_name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field_name} doit être une date/heure ISO 8601 avec fuseau horaire.") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field_name} doit inclure un fuseau horaire, par exemple +00:00 ou Z.")
    return parsed.astimezone(timezone.utc)


def _validate_metadata(metadata: IngestMetadata, now: datetime) -> dict[str, object]:
    source = metadata.source.strip()
    operator = metadata.operator.strip()
    version = metadata.dataset_version.strip()
    source_type = metadata.source_type.strip().upper()
    service_status = metadata.service_status.strip().upper()

    if not source:
        raise ValueError("source est obligatoire.")
    if not operator:
        raise ValueError("operator est obligatoire ; utiliser UNKNOWN si l’opérateur reste à confirmer.")
    if not version:
        raise ValueError("dataset_version est obligatoire.")
    if source_type not in SOURCE_TYPES:
        raise ValueError(f"source_type doit être l’une de : {', '.join(sorted(SOURCE_TYPES))}.")
    if service_status not in SERVICE_STATUSES:
        raise ValueError(f"service_status doit être l’une de : {', '.join(sorted(SERVICE_STATUSES))}.")
    if not math.isfinite(metadata.confidence) or not 0 <= metadata.confidence <= 1:
        raise ValueError("confidence doit être un nombre fini compris entre 0 et 1.")

    source_date_value = metadata.date_source.strip()
    try:
        source_date_value = date.fromisoformat(source_date_value).isoformat()
    except ValueError:
        try:
            source_date_value = _parse_instant(source_date_value, "date_source").isoformat()
        except ValueError as error:
            raise ValueError("date_source doit être une date ISO (YYYY-MM-DD) ou une date/heure ISO 8601.") from error

    verified_at = _parse_instant(metadata.verified_at, "verified_at")
    valid_from = _parse_instant(metadata.valid_from, "valid_from")
    valid_until = _parse_instant(metadata.valid_until, "valid_until")
    now_utc = now.astimezone(timezone.utc)
    if verified_at > now_utc:
        raise ValueError("verified_at ne peut pas être dans le futur.")
    if valid_until <= valid_from:
        raise ValueError("valid_until doit être postérieur à valid_from.")

    source_url = metadata.source_url.strip() if metadata.source_url else None
    if source_url:
        parsed_url = urlsplit(source_url)
        if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
            raise ValueError("source_url doit être une URL HTTP(S) absolue.")
        if parsed_url.username or parsed_url.password:
            raise ValueError("source_url ne doit pas contenir d’identifiants d’accès.")

    return {
        "source": source,
        "source_type": source_type,
        "date_source": source_date_value,
        "verified_at": verified_at.isoformat(),
        "valid_from": valid_from.isoformat(),
        "valid_until": valid_until.isoformat(),
        "confidence": float(metadata.confidence),
        "operator": operator,
        "dataset_version": version,
        "service_status": service_status,
        "source_url": source_url,
    }


def _slug(value: str, fallback: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return result[:40] or fallback


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as archive:
        for chunk in iter(lambda: archive.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stage_gtfs_archive(
    archive_path: str | Path,
    output_dir: str | Path,
    metadata: IngestMetadata,
    *,
    now: datetime | None = None,
) -> dict[str, object]:
    """Validate and copy a source ZIP into a versioned, unpublished staging folder."""
    source_path = Path(archive_path)
    staging_root = Path(output_dir)
    current_time = now or datetime.now(timezone.utc)
    if current_time.tzinfo is None or current_time.utcoffset() is None:
        raise ValueError("now doit être une date/heure avec fuseau horaire.")
    normalized = _validate_metadata(metadata, current_time)

    if source_path.is_symlink():
        raise ValueError("Une archive symbolique n’est pas acceptée ; fournir un fichier local explicite.")
    validation = validate_gtfs_archive(source_path)
    if not validation["structure_valid"]:
        return {
            "staged": False,
            "stage_error": "GTFS_STRUCTURE_INVALID",
            "message": "L’archive n’a pas été copiée : corriger les erreurs de structure avant le staging.",
            "validation": validation,
        }

    archive_info = validation["dataset"]
    archive_hash = archive_info.get("sha256")  # type: ignore[union-attr]
    if not isinstance(archive_hash, str) or len(archive_hash) != 64:
        return {
            "staged": False,
            "stage_error": "CHECKSUM_UNAVAILABLE",
            "message": "L’empreinte SHA-256 du flux n’a pas pu être calculée ; aucun staging n’a été créé.",
            "validation": validation,
        }

    dataset_id = f"{_slug(str(normalized['operator']), 'operator')}-{_slug(str(normalized['dataset_version']), 'version')}-{archive_hash[:12]}"
    try:
        staging_root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return {
            "staged": False,
            "stage_error": "STAGING_ROOT_UNAVAILABLE",
            "message": f"Le répertoire de staging ne peut pas être créé : {error}",
            "dataset_id": dataset_id,
            "validation": validation,
        }
    final_dir = staging_root / dataset_id
    if final_dir.exists() or final_dir.is_symlink():
        return {
            "staged": False,
            "stage_error": "DATASET_VERSION_EXISTS",
            "message": "Cette version (même opérateur, version déclarée et contenu) est déjà en staging ; aucune donnée n’a été écrasée.",
            "dataset_id": dataset_id,
            "validation": validation,
        }

    now_utc = current_time.astimezone(timezone.utc)
    valid_from = datetime.fromisoformat(str(normalized["valid_from"]))
    valid_until = datetime.fromisoformat(str(normalized["valid_until"]))
    if now_utc < valid_from:
        validity_status = "NOT_YET_VALID"
    elif now_utc >= valid_until:
        validity_status = "STALE"
    else:
        validity_status = "CURRENT"

    review_reasons = ["Revue humaine et vérification indépendante de la source requises avant toute publication."]
    if normalized["source_type"] == "UNKNOWN":
        review_reasons.append("Le type de source n’est pas confirmé.")
    if normalized["service_status"] != "ACTIVE":
        review_reasons.append("Le statut du service n’est pas déclaré ACTIVE.")
    if validity_status != "CURRENT":
        review_reasons.append("La période de validité déclarée n’est pas en cours.")
    if normalized["source_type"] == "COMMUNITY":
        review_reasons.append("Une donnée communautaire doit rester explicitement identifiée comme telle.")

    validation_counts = validation["counts"]
    manifest: dict[str, object] = {
        "schema_version": "1.0",
        "dataset_id": dataset_id,
        "dataset_version": normalized["dataset_version"],
        "ingested_at": now_utc.isoformat(),
        "operator": normalized["operator"],
        "source": normalized["source"],
        "source_type": normalized["source_type"],
        "source_url": normalized["source_url"],
        "date_source": normalized["date_source"],
        "verified_at": normalized["verified_at"],
        "valid_from": normalized["valid_from"],
        "valid_until": normalized["valid_until"],
        "validity_status": validity_status,
        "confidence": normalized["confidence"],
        "confidence_basis": "Déclarée par l’importateur ; non recalculée ni vérifiée indépendamment.",
        "service_status": normalized["service_status"],
        "service_status_basis": "Déclaré par l’importateur ; non vérifié par cet outil.",
        "archive": {
            "filename": source_path.name,
            "stored_as": "feed.zip",
            "bytes": archive_info.get("archive_bytes"),  # type: ignore[union-attr]
            "sha256": archive_hash,
        },
        "record_count": validation["tables"],
        "validation": {
            "status": "STRUCTURALLY_VALID",
            "validator": "dakar-bus-gtfs-static/1.0",
            "errors": validation_counts.get("errors"),  # type: ignore[union-attr]
            "warnings": validation_counts.get("warnings"),  # type: ignore[union-attr]
            "report": validation,
        },
        "review_status": "PENDING_REVIEW",
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "publication_blockers": review_reasons,
    }

    temporary_dir: Path | None = None
    try:
        temporary_dir = Path(tempfile.mkdtemp(prefix=".staging-", dir=staging_root))
        stored_archive = temporary_dir / "feed.zip"
        with source_path.open("rb") as source, stored_archive.open("xb") as destination:
            shutil.copyfileobj(source, destination, length=1024 * 1024)
            destination.flush()
            os.fsync(destination.fileno())
        if _sha256(stored_archive) != archive_hash:
            raise OSError("L’archive source a changé pendant sa copie ; son empreinte ne correspond plus au contrôle.")

        manifest_path = temporary_dir / "manifest.json"
        with manifest_path.open("x", encoding="utf-8", newline="\n") as file:
            json.dump(manifest, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())

        if final_dir.exists() or final_dir.is_symlink():
            raise FileExistsError(f"La version « {dataset_id} » a été créée simultanément par un autre import.")
        os.rename(temporary_dir, final_dir)
        temporary_dir = None
    except (OSError, shutil.Error) as error:
        return {
            "staged": False,
            "stage_error": "STAGING_WRITE_FAILED",
            "message": f"Le staging a échoué sans publication : {error}",
            "dataset_id": dataset_id,
            "validation": validation,
        }
    finally:
        if temporary_dir is not None:
            shutil.rmtree(temporary_dir, ignore_errors=True)

    return {
        "staged": True,
        "dataset_id": dataset_id,
        "staged_directory": str(final_dir),
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": False,
        "manifest": manifest,
        "validation": validation,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Valide puis stage une archive GTFS avec provenance, sans la publier.")
    parser.add_argument("--archive", type=Path, required=True, help="Archive GTFS Static .zip")
    parser.add_argument("--output-dir", type=Path, default=Path("data/staging"), help="Répertoire de staging local, ignoré par Git")
    parser.add_argument("--source", required=True, help="Nom de la source tel que documenté")
    parser.add_argument("--source-type", required=True, choices=sorted(SOURCE_TYPES), help="Type de source déclaré")
    parser.add_argument("--source-url", help="URL de la source, si connue")
    parser.add_argument("--operator", required=True, help="Opérateur déclaré ; ne pas déduire AFTU/TATA")
    parser.add_argument("--dataset-version", required=True, help="Version déclarée du dataset")
    parser.add_argument("--date-source", required=True, help="Date de la source : YYYY-MM-DD ou timestamp ISO")
    parser.add_argument("--verified-at", required=True, help="Horodatage de vérification ISO 8601 avec fuseau")
    parser.add_argument("--valid-from", required=True, help="Début de validité ISO 8601 avec fuseau")
    parser.add_argument("--valid-until", required=True, help="Fin de validité ISO 8601 avec fuseau")
    parser.add_argument("--confidence", type=float, required=True, help="Confiance déclarée entre 0 et 1")
    parser.add_argument("--service-status", default="UNKNOWN", choices=sorted(SERVICE_STATUSES), help="Statut déclaré ; UNKNOWN par défaut")
    args = parser.parse_args()

    metadata = IngestMetadata(
        source=args.source,
        source_type=args.source_type,
        source_url=args.source_url,
        operator=args.operator,
        dataset_version=args.dataset_version,
        date_source=args.date_source,
        verified_at=args.verified_at,
        valid_from=args.valid_from,
        valid_until=args.valid_until,
        confidence=args.confidence,
        service_status=args.service_status,
    )
    try:
        result = stage_gtfs_archive(args.archive, args.output_dir, metadata)
    except ValueError as error:
        parser.error(str(error))
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if result["staged"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
