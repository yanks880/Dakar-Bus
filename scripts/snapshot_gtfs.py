#!/usr/bin/env python3
"""Immutable, published snapshots of a reviewed GTFS version.

A snapshot is the only artefact the app may read transport data from. It is
built from a staged archive whose review is approved and whose validity is
current, then frozen: one SQLite store plus one manifest, both hashed. The
builder never decides that something is published — the publication journal
does, and a snapshot that is not in the journal is never served.

Nothing here invents data. Tables are copied as declared by the feed, indexes
are rebuilt, and every payload carries its snapshot, its source and its
declared validity window. No realtime claim is ever derived from static data.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import shutil
import sqlite3
import uuid
import zipfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterator
from urllib.parse import quote

try:  # Works both as `python -m scripts.snapshot_gtfs` and as a file script.
    from .catalog_gtfs import DATASET_ID_RE, inspect_staged_dataset
    from .publication_ledger import current_publication_state
    from .review_ledger import current_review_state
    from .validate_gtfs import KNOWN_TABLES, REQUIRED_TABLES, ValidationLimits
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE, inspect_staged_dataset
    from publication_ledger import current_publication_state
    from review_ledger import current_review_state
    from validate_gtfs import KNOWN_TABLES, REQUIRED_TABLES, ValidationLimits


SNAPSHOT_SCHEMA_VERSION = "1.0"
MANIFEST_FILENAME = "manifest.json"
DATABASE_FILENAME = "network.sqlite"
SNAPSHOT_ID_RE = re.compile(r"^snap-[a-z0-9][a-z0-9-]{2,79}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
BUILD_PREFIX = ".building-"
SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")

# Tables stored in the snapshot, in insertion order. Anything the validator
# accepts but this list omits stays out of the store instead of being guessed.
STORE_TABLES: tuple[str, ...] = (
    "agency.txt",
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt",
    "calendar.txt",
    "calendar_dates.txt",
    "frequencies.txt",
    "shapes.txt",
    "transfers.txt",
    "feed_info.txt",
)

INDEXES: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_stops_stop_id ON stops(stop_id)",
    "CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name)",
    "CREATE INDEX IF NOT EXISTS idx_stops_position ON stops(stop_lat, stop_lon)",
    "CREATE INDEX IF NOT EXISTS idx_routes_route_id ON routes(route_id)",
    "CREATE INDEX IF NOT EXISTS idx_trips_trip_id ON trips(trip_id)",
    "CREATE INDEX IF NOT EXISTS idx_trips_route_id ON trips(route_id)",
    "CREATE INDEX IF NOT EXISTS idx_trips_service_id ON trips(service_id)",
    "CREATE INDEX IF NOT EXISTS idx_stop_times_stop_id ON stop_times(stop_id)",
    "CREATE INDEX IF NOT EXISTS idx_stop_times_trip_id ON stop_times(trip_id)",
    "CREATE INDEX IF NOT EXISTS idx_shapes_shape_id ON shapes(shape_id)",
)

DATA_POLICY = (
    "Données GTFS Static publiées depuis un snapshot daté et immuable : horaires théoriques, "
    "aucune position de véhicule, aucun temps réel, aucune donnée inventée."
)

STORE_LIMITS = ValidationLimits()

_ACCENTS = str.maketrans(
    "àâäáãåçéèêëìíîïñòóôöõùúûüýÿ",
    "aaaaaaceeeeiiiinooooouuuuyy",
)


def fold_text(value: str) -> str:
    """Case- and accent-insensitive form used for place-name search."""
    return value.casefold().translate(_ACCENTS)


class SnapshotError(ValueError):
    """A snapshot could not be built, read or verified; nothing was guessed."""

    def __init__(self, code: str, message: str, blockers: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.blockers = blockers or []


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _slug(value: str, fallback: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return result[:40] or fallback


def snapshot_id_for(dataset_id: str, now: datetime) -> str:
    stamp = now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ").lower()
    return f"snap-{stamp}-{_slug(dataset_id, 'feed')}"


def _quote_identifier(name: str) -> str:
    if not SQL_IDENTIFIER_RE.fullmatch(name):
        raise SnapshotError("INVALID_COLUMN", f"Nom de colonne refusé dans le flux : « {name} ».")
    return f'"{name}"'


def _parse_number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _validity_status(valid_from: datetime | None, valid_until: datetime | None, now: datetime) -> str:
    if valid_from is None or valid_until is None:
        return "UNKNOWN"
    if now < valid_from:
        return "NOT_YET_VALID"
    if now >= valid_until:
        return "STALE"
    return "CURRENT"


def _parse_utc(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


@dataclass(frozen=True)
class PublishCheck:
    """Everything the publication gate verified before a snapshot was built."""

    dataset_dir: Path
    dataset_id: str
    manifest: dict[str, Any]
    review: dict[str, Any]
    inspection: dict[str, Any]


def check_publishable(dataset_dir: str | Path, *, now: datetime | None = None) -> PublishCheck:
    """Refuse to build a snapshot unless the staged version passed every gate."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    directory = Path(dataset_dir)
    inspection = inspect_staged_dataset(directory, now=current_time)
    blockers: list[str] = []

    if inspection["integrity"] != "OK":
        issue = inspection.get("integrity_issue") or {}
        raise SnapshotError(
            "DATASET_NOT_INTACT",
            f"La version stagée n’est pas intègre : {issue.get('message', 'cause inconnue')}",
            blockers=["DATASET_NOT_INTACT"],
        )
    manifest = inspection["manifest"]
    assert isinstance(manifest, dict)
    dataset_id = str(inspection["dataset_id"])

    review = current_review_state(directory)
    if review["ledger_integrity"] == "INVALID":
        raise SnapshotError(
            "REVIEW_LEDGER_INVALID",
            "Le journal de revue est altéré ; la publication est bloquée.",
            blockers=["REVIEW_LEDGER_INVALID"],
        )
    if review["review_status"] != "APPROVED":
        blockers.append("REVIEW_NOT_APPROVED")
    if inspection["effective_validity_status"] != "CURRENT":
        blockers.append("VALIDITY_NOT_CURRENT")
    if manifest.get("source_type") == "UNKNOWN":
        blockers.append("SOURCE_TYPE_UNKNOWN")
    if manifest.get("service_status") != "ACTIVE":
        blockers.append("SERVICE_NOT_ACTIVE")

    if blockers:
        raise SnapshotError(
            "DATASET_NOT_PUBLISHABLE",
            "Cette version ne remplit pas les conditions de publication.",
            blockers=blockers,
        )
    return PublishCheck(
        dataset_dir=directory,
        dataset_id=dataset_id,
        manifest=manifest,
        review=review,
        inspection=inspection,
    )


def _select_feed_tables(archive: zipfile.ZipFile, limits: ValidationLimits) -> dict[str, zipfile.ZipInfo]:
    """Pick one canonical entry per stored table, mirroring the validator rules."""
    infos = archive.infolist()
    if len(infos) > limits.max_entries:
        raise SnapshotError("TOO_MANY_ENTRIES", "L’archive contient trop d’entrées pour être publiée.")
    candidates: list[zipfile.ZipInfo] = []
    total_uncompressed = 0
    for info in infos:
        member = PurePosixPath(info.filename)
        if (
            member.is_absolute()
            or ".." in member.parts
            or "\\" in info.filename
            or info.is_dir()
            or info.flag_bits & 0x1
        ):
            continue
        if member.suffix.lower() != ".txt" or member.name.lower() not in KNOWN_TABLES:
            continue
        if info.file_size > limits.max_member_bytes:
            raise SnapshotError("ENTRY_TOO_LARGE", f"L’entrée « {info.filename} » dépasse la limite de taille.")
        total_uncompressed += info.file_size
        candidates.append(info)
    if total_uncompressed > limits.max_total_uncompressed_bytes:
        raise SnapshotError("FEED_TOO_LARGE", "La taille décompressée de l’archive dépasse la limite autorisée.")

    paths = [PurePosixPath(info.filename) for info in candidates]
    root_files = {path.name.lower() for path in paths if len(path.parts) == 1}
    core = {"agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"}
    if core.intersection(root_files):
        root = PurePosixPath(".")
    else:
        parents = {path.parent for path in paths}
        if len(parents) == 1:
            root = next(iter(parents))
        else:
            first_parts = {path.parts[0] for path in paths}
            if len(first_parts) != 1:
                raise SnapshotError("AMBIGUOUS_FEED_ROOT", "Plusieurs dossiers racine possibles dans l’archive.")
            root = PurePosixPath(next(iter(first_parts)))

    selected: dict[str, zipfile.ZipInfo] = {}
    for info in candidates:
        try:
            relative = PurePosixPath(info.filename).relative_to(root)
        except ValueError:
            continue
        if len(relative.parts) != 1:
            continue
        name = relative.name
        if name != name.lower() or name not in STORE_TABLES:
            continue
        if name in selected:
            raise SnapshotError("DUPLICATE_TABLE_FILE", f"Plusieurs entrées représentent « {name} ».")
        selected[name] = info

    for filename in REQUIRED_TABLES:
        if filename not in selected:
            raise SnapshotError("MISSING_REQUIRED_TABLE", f"La table obligatoire « {filename} » est absente de l’archive.")
    return selected


@contextmanager
def _table_reader(
    archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int
) -> Iterator[tuple[list[str], Iterator[dict[str, str]]]]:
    """Read one CSV member once: validated headers plus a row iterator."""
    with archive.open(info, "r") as binary:
        with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as text:
            reader = csv.DictReader(text, strict=True)
            headers = reader.fieldnames
            if not headers:
                raise SnapshotError("EMPTY_TABLE", f"La table « {info.filename} » n’a pas d’en-tête.")
            for name in headers:
                _quote_identifier(name)

            def rows() -> Iterator[dict[str, str]]:
                count = 0
                for row in reader:
                    count += 1
                    if count > limit:
                        raise SnapshotError("TOO_MANY_ROWS", f"La table « {info.filename} » dépasse la limite de lignes.")
                    if None in row or any(value is None for value in row.values()):
                        raise SnapshotError("CSV_INCONSISTENT", f"La ligne {count + 1} de « {info.filename} » est incohérente.")
                    yield {name: (row[name] or "") for name in headers}

            yield headers, rows()


def _write_table(connection: sqlite3.Connection, table: str, headers: list[str], rows: Iterator[dict[str, str]]) -> int:
    columns = ", ".join(_quote_identifier(name) for name in headers)
    placeholders = ", ".join("?" for _ in headers)
    connection.execute(f'CREATE TABLE "{table}" ({columns})')  # noqa: S608 - identifiers are validated
    statement = f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})'  # noqa: S608 - identifiers are validated
    batch: list[tuple[str, ...]] = []
    count = 0
    for row in rows:
        batch.append(tuple(row[name] for name in headers))
        count += 1
        if len(batch) >= 500:
            connection.executemany(statement, batch)
            batch.clear()
    if batch:
        connection.executemany(statement, batch)
    return count


def _build_database(archive_path: Path, target: Path, limits: ValidationLimits) -> dict[str, Any]:
    """Copy the feed tables into a fresh SQLite store, without extracting the ZIP."""
    counts: dict[str, int] = {}
    bounds: dict[str, float] = {}
    stop_coordinates = 0
    timezone_name: str | None = None

    with zipfile.ZipFile(archive_path, "r") as archive:
        selected = _select_feed_tables(archive, limits)
        connection = sqlite3.connect(target)
        try:
            connection.execute("PRAGMA journal_mode = DELETE")
            connection.execute("PRAGMA synchronous = FULL")
            for filename in STORE_TABLES:
                info = selected.get(filename)
                if info is None:
                    continue
                table = filename[: -len(".txt")]
                with _table_reader(archive, info, limits.max_rows_per_table) as (headers, rows):
                    counts[table] = _write_table(connection, table, headers, rows)
                if table == "agency" and "agency_timezone" in headers:
                    first = connection.execute('SELECT "agency_timezone" FROM "agency" LIMIT 1').fetchone()
                    if first and isinstance(first[0], str) and first[0].strip():
                        timezone_name = first[0].strip()
                if table == "stops":
                    for lat, lon in connection.execute('SELECT "stop_lat", "stop_lon" FROM "stops"'):
                        latitude = _parse_number(lat)
                        longitude = _parse_number(lon)
                        if latitude is None or longitude is None:
                            continue
                        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                            continue
                        stop_coordinates += 1
                        bounds["min_lat"] = min(bounds.get("min_lat", latitude), latitude)
                        bounds["max_lat"] = max(bounds.get("max_lat", latitude), latitude)
                        bounds["min_lon"] = min(bounds.get("min_lon", longitude), longitude)
                        bounds["max_lon"] = max(bounds.get("max_lon", longitude), longitude)
            for statement in INDEXES:
                table = statement.split(" ON ")[1].split("(")[0].strip()
                if table in counts:
                    connection.execute(statement)
            connection.commit()
        finally:
            connection.close()

    return {
        "counts": counts,
        "bounds": (
            {
                "min_lat": bounds["min_lat"],
                "min_lon": bounds["min_lon"],
                "max_lat": bounds["max_lat"],
                "max_lon": bounds["max_lon"],
                "stops_with_coordinates": stop_coordinates,
            }
            if bounds
            else None
        ),
        "timezone": timezone_name,
    }


def build_snapshot(
    dataset_dir: str | Path,
    published_root: str | Path,
    *,
    now: datetime | None = None,
    limits: ValidationLimits | None = None,
) -> dict[str, Any]:
    """Freeze one approved staged version into an unpublished, hashed snapshot.

    The snapshot is written under the published root but is not published: only
    the publication journal makes it readable. Nothing is overwritten, and the
    staged archive is only read.
    """
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    check = check_publishable(dataset_dir, now=current_time)
    root = Path(published_root)
    root.mkdir(parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise SnapshotError("UNSAFE_PUBLISHED_ROOT", "Le répertoire de publication doit être un dossier local non symbolique.")

    snapshot_id = snapshot_id_for(check.dataset_id, current_time)
    suffix = 1
    while (root / snapshot_id).exists() or (root / snapshot_id).is_symlink():
        suffix += 1
        snapshot_id = f"{snapshot_id_for(check.dataset_id, current_time)}-{suffix}"

    archive_path = check.dataset_dir / "feed.zip"
    staging_manifest_path = check.dataset_dir / "manifest.json"
    building = root / f"{BUILD_PREFIX}{uuid.uuid4().hex[:12]}"
    building.mkdir()
    try:
        database = building / DATABASE_FILENAME
        store = _build_database(archive_path, database, limits or STORE_LIMITS)
        database_digest = _sha256_file(database)
        database_bytes = database.stat().st_size

        decision = check.review.get("decision") or {}
        manifest = {
            "schema_version": SNAPSHOT_SCHEMA_VERSION,
            "snapshot_id": snapshot_id,
            "built_at": current_time.isoformat(),
            "dataset": {
                "dataset_id": check.dataset_id,
                "dataset_version": check.manifest.get("dataset_version"),
                "operator": check.manifest.get("operator"),
                "source": check.manifest.get("source"),
                "source_type": check.manifest.get("source_type"),
                "source_url": check.manifest.get("source_url"),
                "service_status": check.manifest.get("service_status"),
                "confidence": check.manifest.get("confidence"),
                "date_source": check.manifest.get("date_source"),
                "valid_from": check.manifest.get("valid_from"),
                "valid_until": check.manifest.get("valid_until"),
                "declared_ingested_at": check.manifest.get("ingested_at"),
                "declared_verified_at": check.manifest.get("verified_at"),
                "archive_sha256": (check.manifest.get("archive") or {}).get("sha256"),
                "archive_bytes": (check.manifest.get("archive") or {}).get("bytes"),
                "staged_manifest_sha256": _sha256_file(staging_manifest_path),
            },
            "review": {
                "review_entry_id": decision.get("entry_id"),
                "review_entry_hash": decision.get("entry_hash"),
                "reviewer_id": decision.get("reviewer_id"),
                "reviewed_at": decision.get("recorded_at"),
            },
            "store": {
                "database": DATABASE_FILENAME,
                "sha256": database_digest,
                "bytes": database_bytes,
                "engine": "sqlite3",
            },
            "record_count": store["counts"],
            "bounds": store["bounds"],
            "timezone": store["timezone"],
            "publication_status": "NOT_PUBLISHED",
            "publication_ready": True,
            "realtime": False,
            "data_policy": DATA_POLICY,
            "truth_notes": [
                "Copie des tables GTFS telles que déclarées ; aucune géométrie ni aucun horaire n’est calculé.",
                "Le manifeste de staging n’est jamais modifié ; la provenance reste celle déclarée par l’importateur.",
                "Une approbation de revue et un snapshot ne publient rien : seul le journal des publications décide.",
            ],
            "limits": {
                "max_entries": (limits or STORE_LIMITS).max_entries,
                "max_member_bytes": (limits or STORE_LIMITS).max_member_bytes,
                "max_total_uncompressed_bytes": (limits or STORE_LIMITS).max_total_uncompressed_bytes,
                "max_rows_per_table": (limits or STORE_LIMITS).max_rows_per_table,
            },
        }
        (building / MANIFEST_FILENAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.replace(building, root / snapshot_id)
    except BaseException:
        shutil.rmtree(building, ignore_errors=True)
        raise

    snapshot_dir = root / snapshot_id
    return {
        "snapshot_id": snapshot_id,
        "snapshot_directory": str(snapshot_dir),
        "dataset_id": check.dataset_id,
        "database_sha256": manifest["store"]["sha256"],  # type: ignore[index]
        "manifest": manifest,
        "publication_status": "NOT_PUBLISHED",
        "publication_ready": True,
        "realtime": False,
        "message": "Snapshot construit mais non listé : seul le journal des publications le rend lisible.",
    }


def _invalid_snapshot(snapshot_id: str, code: str, message: str) -> dict[str, Any]:
    return {
        "snapshot_id": snapshot_id,
        "integrity": "INVALID",
        "integrity_issue": {"code": code, "message": message},
        "manifest": None,
        "validity_status": "UNKNOWN",
    }


def inspect_snapshot(snapshot_dir: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Read a snapshot manifest and its cheap integrity facts (no full hashing)."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    directory = Path(snapshot_dir)
    snapshot_id = directory.name
    if not SNAPSHOT_ID_RE.fullmatch(snapshot_id):
        return _invalid_snapshot(snapshot_id, "INVALID_SNAPSHOT_ID", "Le nom du dossier n’est pas un identifiant de snapshot.")
    if directory.is_symlink() or not directory.is_dir():
        return _invalid_snapshot(snapshot_id, "UNSAFE_SNAPSHOT_DIRECTORY", "Le dossier du snapshot est absent, symbolique ou invalide.")

    manifest_path = directory / MANIFEST_FILENAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        return _invalid_snapshot(snapshot_id, "MANIFEST_MISSING", "Le manifeste du snapshot est absent ou symbolique.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return _invalid_snapshot(snapshot_id, "MANIFEST_INVALID", f"Le manifeste du snapshot n’est pas lisible : {error}.")
    if not isinstance(manifest, dict) or manifest.get("schema_version") != SNAPSHOT_SCHEMA_VERSION:
        return _invalid_snapshot(snapshot_id, "UNSUPPORTED_MANIFEST_SCHEMA", "La version du schéma du snapshot n’est pas prise en charge.")
    if manifest.get("snapshot_id") != snapshot_id:
        return _invalid_snapshot(snapshot_id, "SNAPSHOT_ID_MISMATCH", "L’identifiant du manifeste ne correspond pas au dossier.")
    if manifest.get("realtime") is not False:
        return _invalid_snapshot(snapshot_id, "REALTIME_CLAIM", "Un snapshot statique ne peut pas prétendre au temps réel.")
    store = manifest.get("store")
    if not isinstance(store, dict) or store.get("database") != DATABASE_FILENAME:
        return _invalid_snapshot(snapshot_id, "UNSAFE_DATABASE_REFERENCE", "Le manifeste ne référence pas la base network.sqlite du dossier.")
    digest = store.get("sha256")
    size = store.get("bytes")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        return _invalid_snapshot(snapshot_id, "INVALID_CHECKSUM", "L’empreinte du snapshot est absente ou mal formée.")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        return _invalid_snapshot(snapshot_id, "INVALID_DATABASE_SIZE", "La taille déclarée de la base est invalide.")
    counts = manifest.get("record_count")
    if not isinstance(counts, dict) or any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts.values()):
        return _invalid_snapshot(snapshot_id, "RECORD_COUNTS_INVALID", "record_count doit être une table de comptages entiers non négatifs.")

    database = directory / DATABASE_FILENAME
    if database.is_symlink() or not database.is_file():
        return _invalid_snapshot(snapshot_id, "DATABASE_MISSING", "La base network.sqlite est absente ou symbolique.")
    try:
        actual_size = database.stat().st_size
    except OSError as error:
        return _invalid_snapshot(snapshot_id, "DATABASE_READ_ERROR", f"La base ne peut pas être lue : {error}.")
    if actual_size != size:
        return _invalid_snapshot(snapshot_id, "DATABASE_SIZE_MISMATCH", "La taille de la base ne correspond pas au manifeste.")

    dataset = manifest.get("dataset") if isinstance(manifest.get("dataset"), dict) else {}
    valid_from = _parse_utc(dataset.get("valid_from"))
    valid_until = _parse_utc(dataset.get("valid_until"))
    return {
        "snapshot_id": snapshot_id,
        "integrity": "OK",
        "integrity_issue": None,
        "manifest": manifest,
        "valid_from": dataset.get("valid_from"),
        "valid_until": dataset.get("valid_until"),
        "validity_status": _validity_status(valid_from, valid_until, current_time),
    }


def verify_snapshot(snapshot_dir: str | Path) -> dict[str, Any]:
    """Recompute every hash and count; report honestly, never repair."""
    inspection = inspect_snapshot(snapshot_dir)
    if inspection["integrity"] != "OK":
        return {**inspection, "verified": False, "issues": [inspection["integrity_issue"]]}

    manifest = inspection["manifest"]
    assert isinstance(manifest, dict)
    directory = Path(snapshot_dir)
    issues: list[dict[str, str]] = []

    actual_digest = _sha256_file(directory / DATABASE_FILENAME)
    if actual_digest != manifest["store"]["sha256"]:
        issues.append({"code": "DATABASE_CHECKSUM_MISMATCH", "message": "Le SHA-256 de la base ne correspond pas au manifeste."})
    if manifest["store"].get("bytes") != (directory / DATABASE_FILENAME).stat().st_size:
        issues.append({"code": "DATABASE_SIZE_MISMATCH", "message": "La taille de la base ne correspond pas au manifeste."})

    counted: dict[str, int] = {}
    try:
        connection = connect_read_only(directory)
        try:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            for table in sorted(manifest.get("record_count") or {}):
                if table not in tables:
                    issues.append({"code": "TABLE_MISSING", "message": f"La table « {table} » déclarée au manifeste est absente de la base."})
                    continue
                counted[table] = int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])  # noqa: S608 - name from manifest
                if counted[table] != manifest["record_count"][table]:
                    issues.append(
                        {
                            "code": "RECORD_COUNT_MISMATCH",
                            "message": f"« {table} » : {counted[table]} lignes trouvées, {manifest['record_count'][table]} déclarées.",
                        }
                    )
        finally:
            connection.close()
    except (SnapshotError, sqlite3.Error) as error:
        issues.append({"code": "DATABASE_UNREADABLE", "message": f"La base publiée n’est pas lisible : {error}."})

    return {
        "snapshot_id": inspection["snapshot_id"],
        "integrity": "OK" if not issues else "INVALID",
        "integrity_issue": None,
        "manifest": manifest,
        "validity_status": inspection["validity_status"],
        "verified": not issues,
        "checked": {"database_sha256": manifest["store"]["sha256"], "record_count": counted},
        "issues": issues,
    }


def _publication_lookup(published_root: str | Path) -> dict[str, Any]:
    state = current_publication_state(published_root)
    active = state.get("active") or {}
    positions: dict[str, str] = {}
    for entry in state.get("history") or []:
        snapshot_id = entry.get("snapshot_id")
        if isinstance(snapshot_id, str):
            positions[snapshot_id] = "REVOKED" if entry.get("action") == "REVERT" else "PUBLISHED"
    active_id = active.get("snapshot_id") if isinstance(active, dict) else None
    return {"state": state, "active_id": active_id, "positions": positions}


def list_snapshots(published_root: str | Path, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """List snapshot directories with the publication state read from the journal."""
    root = Path(published_root)
    if not root.exists():
        return []
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Le répertoire publié doit être un dossier local non symbolique.")
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    lookup = _publication_lookup(root)

    entries: list[dict[str, Any]] = []
    for child in sorted(root.iterdir(), key=lambda path: path.name.casefold()):
        if child.name.startswith(".") or child.name in {MANIFEST_FILENAME, DATABASE_FILENAME}:
            continue
        if child.is_file() and child.name in {"publication.jsonl", "publication.lock"}:
            continue
        if not child.is_dir() and not child.is_symlink():
            continue
        inspection = inspect_snapshot(child, now=current_time)
        manifest = inspection.get("manifest") if isinstance(inspection.get("manifest"), dict) else {}
        dataset = (manifest or {}).get("dataset") or {}
        position = lookup["positions"].get(inspection["snapshot_id"], "UNLISTED")
        if position == "PUBLISHED":
            publication_status = "ACTIVE" if inspection["snapshot_id"] == lookup["active_id"] else "SUPERSEDED"
        else:
            publication_status = position
        valid_from = _parse_utc(dataset.get("valid_from"))
        valid_until = _parse_utc(dataset.get("valid_until"))
        entries.append(
            {
                "snapshot_id": inspection["snapshot_id"],
                "integrity": inspection["integrity"],
                "integrity_issue": inspection["integrity_issue"],
                "publication_status": publication_status,
                "validity_status": _validity_status(valid_from, valid_until, current_time),
                "dataset_id": dataset.get("dataset_id"),
                "dataset_version": dataset.get("dataset_version"),
                "operator": dataset.get("operator"),
                "source": dataset.get("source"),
                "source_type": dataset.get("source_type"),
                "valid_from": dataset.get("valid_from"),
                "valid_until": dataset.get("valid_until"),
                "built_at": manifest.get("built_at") if manifest else None,
                "record_count": manifest.get("record_count") if manifest else None,
                "bounds": manifest.get("bounds") if manifest else None,
                "realtime": False,
            }
        )
    return entries


def show_snapshot(published_root: str | Path, snapshot_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    if not SNAPSHOT_ID_RE.fullmatch(snapshot_id):
        raise ValueError("snapshot_id contient des caractères interdits.")
    inspection = inspect_snapshot(Path(published_root) / snapshot_id, now=now)
    lookup = _publication_lookup(published_root)
    position = lookup["positions"].get(snapshot_id, "UNLISTED")
    if position == "PUBLISHED":
        position = "ACTIVE" if snapshot_id == lookup["active_id"] else "SUPERSEDED"
    return {
        **inspection,
        "publication_status": position,
        "publication_journal_integrity": lookup["state"]["journal_integrity"],
        "realtime": False,
    }


# Published databases are hashed once per process and then trusted only while
# size and mtime stay identical, so any write forces a fresh hash.
_VERIFIED_DATABASES: dict[str, tuple[int, int, str]] = {}


def _database_matches_journal(database: Path, expected_sha256: str) -> bool:
    try:
        stat = database.stat()
    except OSError:
        return False
    key = str(database)
    cached = _VERIFIED_DATABASES.get(key)
    if cached is not None and cached[0] == stat.st_size and cached[1] == stat.st_mtime_ns:
        return cached[2] == expected_sha256
    try:
        digest = _sha256_file(database)
    except OSError:
        return False
    _VERIFIED_DATABASES[key] = (stat.st_size, stat.st_mtime_ns, digest)
    return digest == expected_sha256


def resolve_active_snapshot(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Return what the app may read right now, or explain why it may read nothing."""
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    root = Path(published_root)
    state = current_publication_state(root)
    result: dict[str, Any] = {
        "available": False,
        "publication_status": state["publication_status"],
        "publication_journal_integrity": state["journal_integrity"],
        "journal_issue": state.get("journal_issue"),
        "active": state.get("active"),
        "snapshot": None,
        "evaluated_at": current_time.isoformat(),
        "realtime": False,
        "blocked_reason": state.get("blocked_reason"),
    }
    if not state["available"]:
        result["blocked_reason"] = result["blocked_reason"] or "Aucun snapshot publié : rien n’est servi à l’application."
        return result

    active = state["active"]
    assert isinstance(active, dict)
    inspection = inspect_snapshot(root / str(active["snapshot_id"]), now=current_time)
    if inspection["integrity"] != "OK":
        result["blocked_reason"] = "Le snapshot actif est absent ou invalide ; rien n’est servi."
        result["snapshot_integrity_issue"] = inspection["integrity_issue"]
        return result

    manifest = inspection["manifest"]
    assert isinstance(manifest, dict)
    if manifest["store"]["sha256"] != active.get("database_sha256"):
        result["blocked_reason"] = "Le contenu du snapshot ne correspond pas à l’entrée de publication ; rien n’est servi."
        return result
    if not _database_matches_journal(root / str(active["snapshot_id"]) / DATABASE_FILENAME, str(active.get("database_sha256"))):
        result["blocked_reason"] = (
            "Le fichier publié ne correspond plus à l’empreinte enregistrée dans le journal ; rien n’est servi."
        )
        return result

    dataset = manifest.get("dataset") or {}
    valid_from = _parse_utc(dataset.get("valid_from"))
    valid_until = _parse_utc(dataset.get("valid_until"))
    result.update(
        {
            "available": True,
            "published_at": active.get("published_at"),
            "publisher_id": active.get("publisher_id"),
            "separation_of_duties": active.get("separation_of_duties"),
            "snapshot": {
                "snapshot_id": inspection["snapshot_id"],
                "built_at": manifest.get("built_at"),
                "integrity": "OK",
                "validity_status": _validity_status(valid_from, valid_until, current_time),
                "valid_from": dataset.get("valid_from"),
                "valid_until": dataset.get("valid_until"),
                "timezone": manifest.get("timezone"),
                "record_count": manifest.get("record_count"),
                "bounds": manifest.get("bounds"),
                "database_sha256": manifest["store"]["sha256"],
                "database_bytes": manifest["store"]["bytes"],
            },
            "dataset": {
                "dataset_id": dataset.get("dataset_id"),
                "dataset_version": dataset.get("dataset_version"),
                "operator": dataset.get("operator"),
                "source": dataset.get("source"),
                "source_type": dataset.get("source_type"),
                "service_status": dataset.get("service_status"),
                "confidence": dataset.get("confidence"),
            },
            "review": manifest.get("review"),
            "blocked_reason": None,
        }
    )
    return result


def connect_read_only(snapshot_dir: str | Path) -> sqlite3.Connection:
    """Open a published snapshot read-only and immutable; never create or lock it."""
    database = Path(snapshot_dir) / DATABASE_FILENAME
    if not database.is_file() or database.is_symlink():
        raise SnapshotError("DATABASE_MISSING", "La base du snapshot publié est absente.")
    uri = f"file:{quote(str(database.resolve()))}?mode=ro&immutable=1"
    try:
        connection = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:  # pragma: no cover - depends on the filesystem
        raise SnapshotError("DATABASE_UNAVAILABLE", f"La base publiée ne peut pas être ouverte : {error}.") from error
    connection.row_factory = sqlite3.Row
    connection.create_function("dakar_fold", 1, fold_text, deterministic=True)
    return connection


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _require_tables(connection: sqlite3.Connection, *names: str) -> None:
    available = _tables(connection)
    missing = [name for name in names if name not in available]
    if missing:
        raise SnapshotError("TABLE_MISSING", f"Tables absentes du snapshot publié : {', '.join(missing)}.")


def _row_value(row: sqlite3.Row, column: str) -> Any:
    return row[column] if column in row.keys() else None


def _stop_payload(row: sqlite3.Row) -> dict[str, Any]:
    latitude = _parse_number(_row_value(row, "stop_lat"))
    longitude = _parse_number(_row_value(row, "stop_lon"))
    return {
        "stop_id": _row_value(row, "stop_id"),
        "stop_name": _row_value(row, "stop_name"),
        "stop_code": _row_value(row, "stop_code"),
        "stop_lat": latitude,
        "stop_lon": longitude,
        "location_type": _row_value(row, "location_type"),
        "parent_station": _row_value(row, "parent_station"),
        "wheelchair_boarding": _row_value(row, "wheelchair_boarding"),
    }


def _like_pattern(query: str) -> str:
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


MAX_SEARCH_TOKENS = 8


def search_stops(connection: sqlite3.Connection, query: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """Search stop names as declared by the feed, accents and case folded.

    Every word of the query must appear in the declared name, so « demo yoff »
    finds « Démo — Yoff Aéroport » without any synonym table or place guess.
    """
    _require_tables(connection, "stops")
    text = " ".join(query.split())
    if not text:
        raise SnapshotError("EMPTY_QUERY", "Une recherche exige au moins un caractère.")
    if not 1 <= limit <= 100:
        raise SnapshotError("INVALID_LIMIT", "limit doit être compris entre 1 et 100.")
    tokens = fold_text(text).split()[:MAX_SEARCH_TOKENS]
    if not tokens:
        raise SnapshotError("EMPTY_QUERY", "Une recherche exige au moins un caractère utile.")
    conditions = " AND ".join("dakar_fold(stop_name) LIKE ? ESCAPE '\\'" for _ in tokens)
    parameters: list[Any] = [_like_pattern(token) for token in tokens]
    parameters.append(limit)
    rows = connection.execute(
        f"SELECT * FROM stops WHERE {conditions} ORDER BY stop_name, stop_id LIMIT ?",  # noqa: S608 - fixed clause, bound values
        tuple(parameters),
    ).fetchall()
    return [_stop_payload(row) for row in rows]


def stops_near(
    connection: sqlite3.Connection,
    latitude: float,
    longitude: float,
    *,
    radius_m: float = 800.0,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Stops within a radius, computed from the declared coordinates only."""
    _require_tables(connection, "stops")
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise SnapshotError("INVALID_POSITION", "Position hors des bornes terrestres.")
    if not 1 <= limit <= 100:
        raise SnapshotError("INVALID_LIMIT", "limit doit être compris entre 1 et 100.")
    if not 1 <= radius_m <= 5000:
        raise SnapshotError("INVALID_RADIUS", "radius doit être compris entre 1 et 5000 mètres.")

    degrees_lat = radius_m / 111_320.0
    degrees_lon = radius_m / max(111_320.0 * math.cos(math.radians(latitude)), 1e-6)
    rows = connection.execute(
        "SELECT * FROM stops WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL "
        "AND CAST(stop_lat AS REAL) BETWEEN ? AND ? AND CAST(stop_lon AS REAL) BETWEEN ? AND ?",
        (latitude - degrees_lat, latitude + degrees_lat, longitude - degrees_lon, longitude + degrees_lon),
    ).fetchall()

    found: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        stop_latitude = _parse_number(_row_value(row, "stop_lat"))
        stop_longitude = _parse_number(_row_value(row, "stop_lon"))
        if stop_latitude is None or stop_longitude is None:
            continue
        distance = haversine_m(latitude, longitude, stop_latitude, stop_longitude)
        if distance is None or distance > radius_m:
            continue
        payload = _stop_payload(row)
        payload["distance_m"] = round(distance)
        found.append((distance, payload))
    found.sort(key=lambda item: (item[0], str(item[1].get("stop_name") or "")))
    return [payload for _, payload in found[:limit]]


def haversine_m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float | None:
    """Great-circle distance in metres; None when a coordinate is not a number."""
    for value in (lat_a, lon_a, lat_b, lon_b):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            return None
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    delta_phi = phi_b - phi_a
    delta_lambda = math.radians(lon_b - lon_a)
    haversine = math.sin(delta_phi / 2) ** 2 + math.cos(phi_a) * math.cos(phi_b) * math.sin(delta_lambda / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(min(1.0, math.sqrt(haversine)))


def stop_detail(connection: sqlite3.Connection, stop_id: str) -> dict[str, Any] | None:
    """One stop with the routes the feed declares serving it."""
    _require_tables(connection, "stops")
    identifier = stop_id.strip()
    if not identifier or len(identifier) > 120:
        raise SnapshotError("INVALID_STOP_ID", "Identifiant d’arrêt invalide.")
    row = connection.execute("SELECT * FROM stops WHERE stop_id = ?", (identifier,)).fetchone()
    if row is None:
        return None

    payload = _stop_payload(row)
    payload["parent_station_name"] = None
    parent = payload.get("parent_station")
    if isinstance(parent, str) and parent:
        parent_row = connection.execute("SELECT stop_name FROM stops WHERE stop_id = ?", (parent,)).fetchone()
        if parent_row is not None:
            payload["parent_station_name"] = parent_row["stop_name"]

    routes: list[dict[str, Any]] = []
    scheduled: dict[str, Any] | None = None
    if {"stop_times", "trips", "routes"}.issubset(_tables(connection)):
        rows = connection.execute(
            "SELECT r.route_id AS route_id, r.route_short_name AS route_short_name, r.route_long_name AS route_long_name, "
            "r.route_type AS route_type, COUNT(DISTINCT t.trip_id) AS trip_count "
            "FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id JOIN routes r ON r.route_id = t.route_id "
            "WHERE st.stop_id = ? GROUP BY r.route_id ORDER BY r.route_short_name, r.route_id",
            (identifier,),
        ).fetchall()
        routes = [
            {
                "route_id": item["route_id"],
                "route_short_name": item["route_short_name"],
                "route_long_name": item["route_long_name"],
                "route_type": item["route_type"],
                "trip_count": item["trip_count"],
            }
            for item in rows
        ]
        window = connection.execute(
            'SELECT MIN(NULLIF("departure_time", \'\')) AS first_departure, MAX(NULLIF("departure_time", \'\')) AS last_departure '
            "FROM stop_times WHERE stop_id = ?",
            (identifier,),
        ).fetchone()
        if window is not None and (window["first_departure"] or window["last_departure"]):
            scheduled = {
                "first_declared_departure": window["first_departure"],
                "last_declared_departure": window["last_departure"],
                "note": "Heures théoriques déclarées dans stop_times (GTFS Static) ; ce n’est ni une position, ni un temps réel.",
            }

    payload["routes"] = routes
    payload["scheduled_time_window"] = scheduled
    payload["realtime"] = False
    return payload


def route_detail(connection: sqlite3.Connection, route_id: str) -> dict[str, Any] | None:
    """One route with declared agencies, service ids and stop count."""
    _require_tables(connection, "routes")
    identifier = route_id.strip()
    if not identifier or len(identifier) > 120:
        raise SnapshotError("INVALID_ROUTE_ID", "Identifiant de ligne invalide.")
    row = connection.execute("SELECT * FROM routes WHERE route_id = ?", (identifier,)).fetchone()
    if row is None:
        return None

    payload: dict[str, Any] = {
        "route_id": _row_value(row, "route_id"),
        "route_short_name": _row_value(row, "route_short_name"),
        "route_long_name": _row_value(row, "route_long_name"),
        "route_type": _row_value(row, "route_type"),
        "route_color": _row_value(row, "route_color"),
        "route_text_color": _row_value(row, "route_text_color"),
        "agency_id": _row_value(row, "agency_id"),
        "agency_name": None,
        "trip_count": None,
        "stop_count": None,
        "service_ids": [],
        "has_shapes": False,
        "directions": [],
        "realtime": False,
    }

    tables = _tables(connection)
    if "agency" in tables:
        agency_row = None
        if payload["agency_id"]:
            agency_row = connection.execute("SELECT * FROM agency WHERE agency_id = ?", (payload["agency_id"],)).fetchone()
        if agency_row is None:
            # Only unambiguous when the feed declares exactly one agency.
            total = connection.execute("SELECT COUNT(*) FROM agency").fetchone()[0]
            if total == 1:
                agency_row = connection.execute("SELECT * FROM agency LIMIT 1").fetchone()
        if agency_row is not None:
            payload["agency_name"] = _row_value(agency_row, "agency_name")
    if "trips" in tables:
        summary = connection.execute(
            'SELECT COUNT(*) AS trip_count, COUNT(DISTINCT "service_id") AS service_count, '
            'COUNT(DISTINCT NULLIF("direction_id", \'\')) AS direction_count, '
            'SUM(CASE WHEN NULLIF("shape_id", \'\') IS NOT NULL THEN 1 ELSE 0 END) AS shaped_trips '
            'FROM "trips" WHERE "route_id" = ?',
            (identifier,),
        ).fetchone()
        if summary is not None:
            payload["trip_count"] = summary["trip_count"]
            payload["has_shapes"] = bool(summary["shaped_trips"])
        services = connection.execute(
            'SELECT DISTINCT "service_id" FROM "trips" WHERE "route_id" = ? ORDER BY "service_id"', (identifier,)
        ).fetchall()
        payload["service_ids"] = [item[0] for item in services]
        directions = connection.execute(
            'SELECT DISTINCT "direction_id" FROM "trips" WHERE "route_id" = ? '
            'AND NULLIF("direction_id", \'\') IS NOT NULL ORDER BY "direction_id"',
            (identifier,),
        ).fetchall()
        payload["directions"] = [item[0] for item in directions]
        if "stop_times" in tables:
            counted = connection.execute(
                "SELECT COUNT(DISTINCT st.stop_id) AS stop_count FROM stop_times st "
                "JOIN trips t ON t.trip_id = st.trip_id WHERE t.route_id = ?",
                (identifier,),
            ).fetchone()
            if counted is not None:
                payload["stop_count"] = counted["stop_count"]
    return payload


def list_routes(connection: sqlite3.Connection, *, limit: int = 100) -> list[dict[str, Any]]:
    """Declared routes with their trip counts; no ordering by popularity."""
    _require_tables(connection, "routes")
    if not 1 <= limit <= 500:
        raise SnapshotError("INVALID_LIMIT", "limit doit être compris entre 1 et 500.")
    tables = _tables(connection)
    if "trips" in tables:
        rows = connection.execute(
            'SELECT r.*, (SELECT COUNT(*) FROM "trips" t WHERE t."route_id" = r."route_id") AS trip_count '
            'FROM "routes" r ORDER BY r."route_short_name", r."route_id" LIMIT ?',
            (limit,),
        ).fetchall()
    else:
        rows = connection.execute('SELECT *, NULL AS trip_count FROM "routes" ORDER BY "route_id" LIMIT ?', (limit,)).fetchall()
    return [
        {
            "route_id": _row_value(row, "route_id"),
            "route_short_name": _row_value(row, "route_short_name"),
            "route_long_name": _row_value(row, "route_long_name"),
            "route_type": _row_value(row, "route_type"),
            "trip_count": _row_value(row, "trip_count"),
        }
        for row in rows
    ]


def dataset_tables(connection: sqlite3.Connection) -> dict[str, int]:
    """Row counts per table, read from the store itself."""
    counts: dict[str, int] = {}
    for table in sorted(_tables(connection)):
        counts[table] = int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])  # noqa: S608 - table from the store
    return counts
