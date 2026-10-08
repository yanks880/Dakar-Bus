#!/usr/bin/env python3
"""Read-only GTFS Static structure and cross-reference validator.

This tool does not certify a feed's source, licence, operator authority, active
service, schedule freshness, or suitability for public routing. A structurally
valid feed is never marked production-ready by this script.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import sqlite3
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable
from zoneinfo import available_timezones


REQUIRED_TABLES = {
    "agency.txt": {"agency_name", "agency_url", "agency_timezone"},
    "stops.txt": {"stop_id", "stop_name", "stop_lat", "stop_lon"},
    "routes.txt": {"route_id", "route_type"},
    "trips.txt": {"route_id", "service_id", "trip_id"},
    "stop_times.txt": {"trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"},
}
CALENDAR_TABLES = {"calendar.txt", "calendar_dates.txt"}
EXTENDED_TABLES = {
    "frequencies.txt", "pathways.txt", "levels.txt", "translations.txt",
    "fare_attributes.txt", "fare_rules.txt", "attributions.txt",
}
OPTIONAL_HEADERS = {
    "frequencies.txt": {"trip_id", "start_time", "end_time", "headway_secs"},
    "calendar.txt": {"service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"},
    "calendar_dates.txt": {"service_id", "date", "exception_type"},
    "shapes.txt": {"shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"},
    "transfers.txt": {"from_stop_id", "to_stop_id", "transfer_type"},
    "feed_info.txt": {"feed_publisher_name", "feed_publisher_url", "feed_lang"},
}
KNOWN_TABLES = set(REQUIRED_TABLES) | CALENDAR_TABLES | set(OPTIONAL_HEADERS) | EXTENDED_TABLES
SUPPORTED_TABLES = set(REQUIRED_TABLES) | CALENDAR_TABLES | {"frequencies.txt", "shapes.txt", "transfers.txt", "feed_info.txt"}

TIME_RE = re.compile(r"^(\d{1,3}):(\d{2}):(\d{2})$")


@dataclass(frozen=True)
class ValidationLimits:
    max_archive_bytes: int = 100 * 1024 * 1024
    max_entries: int = 1_000
    max_member_bytes: int = 200 * 1024 * 1024
    max_total_uncompressed_bytes: int = 500 * 1024 * 1024
    max_rows_per_table: int = 2_000_000
    max_issue_details: int = 200


class Report:
    def __init__(self, filename: str, limits: ValidationLimits) -> None:
        self.filename = filename
        self.limits = limits
        self.errors = 0
        self.warnings = 0
        self.issues: list[dict[str, object]] = []
        self.tables: dict[str, int] = {}
        self.archive_bytes: int | None = None
        self.sha256: str | None = None

    def add(self, severity: str, code: str, message: str, table: str | None = None, row: int | None = None) -> None:
        if severity == "ERROR":
            self.errors += 1
        else:
            self.warnings += 1
        if len(self.issues) < self.limits.max_issue_details:
            issue: dict[str, object] = {"severity": severity, "code": code, "message": message}
            if table:
                issue["table"] = table
            if row is not None:
                issue["row"] = row
            self.issues.append(issue)

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": "1.0",
            "dataset": {
                "filename": self.filename,
                "archive_bytes": self.archive_bytes,
                "sha256": self.sha256,
            },
            "validated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "structure_valid": self.errors == 0,
            "production_ready": False,
            "scope": "GTFS Static structure and reference checks only; this does not verify provenance, reuse rights, operator approval, current service, schedule freshness, or production readiness.",
            "counts": {"errors": self.errors, "warnings": self.warnings},
            "tables": self.tables,
            "issues": self.issues,
            "limits": {
                "max_archive_bytes": self.limits.max_archive_bytes,
                "max_entries": self.limits.max_entries,
                "max_member_bytes": self.limits.max_member_bytes,
                "max_total_uncompressed_bytes": self.limits.max_total_uncompressed_bytes,
                "max_rows_per_table": self.limits.max_rows_per_table,
                "max_issue_details": self.limits.max_issue_details,
            },
        }


class GTFSValidator:
    def __init__(self, archive_path: Path, limits: ValidationLimits | None = None) -> None:
        self.path = archive_path
        self.limits = limits or ValidationLimits()
        self.report = Report(archive_path.name, self.limits)
        try:
            self.timezone_names = available_timezones()
        except OSError:
            self.timezone_names = set()
        self.archive: zipfile.ZipFile | None = None
        self.table_infos: dict[str, zipfile.ZipInfo] = {}
        self.agency_ids: set[str] = set()
        self.agency_missing_id_rows: list[int] = []
        self.agency_rows = 0
        self.stop_ids: set[str] = set()
        self.stop_types: dict[str, int] = {}
        self.parent_stations: list[tuple[int, str, str]] = []
        self.route_ids: set[str] = set()
        self.route_agencies: dict[str, str] = {}
        self.route_trip_counts: dict[str, int] = {}
        self.trip_rows: dict[str, tuple[str, str, str]] = {}
        self.trip_ids_with_stop_times: set[str] = set()
        self.calendar_ids: set[str] = set()
        self.calendar_date_ids: set[str] = set()
        self.calendar_date_keys: set[tuple[str, str]] = set()
        self.trip_last_time: dict[str, tuple[int, int | None]] = {}
        self.unsorted_trip_lines: dict[str, int] = {}
        self.validation_db: sqlite3.Connection | None = None
        self.stop_time_trip_ids: set[str] = set()
        self.stop_time_stop_ids: set[str] = set()
        self.frequency_trip_ids: list[tuple[int, str]] = []
        self.shape_ids: set[str] = set()
        self.trip_shape_ids: list[tuple[int, str, str]] = []
        self.transfer_stop_ids: list[tuple[int, str, str]] = []

    def validate(self) -> dict[str, object]:
        try:
            with tempfile.TemporaryDirectory(prefix="dakar-bus-gtfs-") as temporary_dir:
                self.validation_db = sqlite3.connect(Path(temporary_dir) / "validation-index.sqlite")
                self.validation_db.execute("PRAGMA journal_mode=OFF")
                self.validation_db.execute("PRAGMA synchronous=OFF")
                self.validation_db.execute("PRAGMA cache_size=-8192")
                self.validation_db.execute("CREATE TABLE stop_sequences (trip_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (trip_id, sequence))")
                self.validation_db.execute("CREATE TABLE shape_sequences (shape_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY (shape_id, sequence))")
                try:
                    return self._validate_archive()
                finally:
                    self.validation_db.close()
                    self.validation_db = None
        except (OSError, sqlite3.Error) as error:
            self.report.add("ERROR", "VALIDATION_STORAGE_ERROR", f"Impossible de préparer l’index temporaire de validation : {error}.")
            return self.report.to_dict()

    def _validate_archive(self) -> dict[str, object]:
        if not self.path.is_file():
            self.report.add("ERROR", "ARCHIVE_NOT_FOUND", "Le fichier GTFS indiqué n’existe pas ou n’est pas un fichier.")
            return self.report.to_dict()

        try:
            self.report.archive_bytes = self.path.stat().st_size
        except OSError as error:
            self.report.add("ERROR", "ARCHIVE_READ_ERROR", f"Impossible de lire les métadonnées du fichier : {error}.")
            return self.report.to_dict()

        if self.report.archive_bytes > self.limits.max_archive_bytes:
            self.report.add("ERROR", "ARCHIVE_TOO_LARGE", f"L’archive dépasse la limite de {self.limits.max_archive_bytes} octets.")
            return self.report.to_dict()

        self.report.sha256 = self._sha256()
        if self.report.errors:
            return self.report.to_dict()

        try:
            self.archive = zipfile.ZipFile(self.path, "r")
        except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
            self.report.add("ERROR", "INVALID_ZIP", f"Archive ZIP illisible : {error}.")
            return self.report.to_dict()

        with self.archive:
            if not self._inspect_archive():
                return self.report.to_dict()
            self._scan_tables()
            self._check_references()
            self._warn_unsupported_tables()

        return self.report.to_dict()

    def _sha256(self) -> str | None:
        digest = hashlib.sha256()
        try:
            with self.path.open("rb") as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError as error:
            self.report.add("ERROR", "ARCHIVE_READ_ERROR", f"Impossible de calculer l’empreinte du fichier : {error}.")
            return None
        return digest.hexdigest()

    def _inspect_archive(self) -> bool:
        assert self.archive is not None
        try:
            infos = self.archive.infolist()
        except (OSError, zipfile.BadZipFile, RuntimeError) as error:
            self.report.add("ERROR", "INVALID_ZIP_DIRECTORY", f"Répertoire ZIP invalide : {error}.")
            return False

        if len(infos) > self.limits.max_entries:
            self.report.add("ERROR", "TOO_MANY_ENTRIES", f"L’archive dépasse la limite de {self.limits.max_entries} entrées.")
            return False

        total_uncompressed = 0
        seen_names: set[str] = set()
        valid_infos: list[zipfile.ZipInfo] = []
        for info in infos:
            if info.filename in seen_names:
                self.report.add("ERROR", "DUPLICATE_ARCHIVE_ENTRY", f"L’entrée ZIP « {info.filename} » apparaît plusieurs fois.")
                continue
            seen_names.add(info.filename)

            member_path = PurePosixPath(info.filename)
            unix_mode = info.external_attr >> 16
            if (
                member_path.is_absolute()
                or ".." in member_path.parts
                or "\\" in info.filename
                or stat.S_ISLNK(unix_mode)
            ):
                self.report.add("ERROR", "UNSAFE_ARCHIVE_PATH", f"Chemin ZIP refusé : « {info.filename} ».")
                continue
            if info.flag_bits & 0x1:
                self.report.add("ERROR", "ENCRYPTED_ENTRY", f"L’entrée chiffrée « {info.filename} » ne peut pas être inspectée.")
                continue
            if info.is_dir():
                continue
            if info.file_size > self.limits.max_member_bytes:
                self.report.add("ERROR", "ENTRY_TOO_LARGE", f"L’entrée « {info.filename} » dépasse la limite de taille décompressée.")
                continue
            total_uncompressed += info.file_size
            valid_infos.append(info)

        if total_uncompressed > self.limits.max_total_uncompressed_bytes:
            self.report.add("ERROR", "FEED_TOO_LARGE", "La taille décompressée totale de l’archive dépasse la limite autorisée.")

        if self.report.errors:
            return False

        text_infos = [info for info in valid_infos if PurePosixPath(info.filename).suffix.lower() == ".txt"]
        known_infos = [info for info in text_infos if PurePosixPath(info.filename).name.lower() in KNOWN_TABLES]
        if not known_infos:
            self.report.add("ERROR", "NO_GTFS_TABLES", "Aucun nom de table GTFS reconnu n’a été trouvé dans l’archive.")
            return False

        root = self._find_feed_root(known_infos)
        if root is None:
            return False

        for info in text_infos:
            path = PurePosixPath(info.filename)
            try:
                relative = path.relative_to(root)
            except ValueError:
                continue
            if len(relative.parts) != 1:
                continue
            name = relative.name
            canonical = name.lower()
            if canonical in KNOWN_TABLES:
                if name != canonical:
                    self.report.add("ERROR", "NONCANONICAL_FILENAME", f"Nom de table non canonique « {name} » ; GTFS attend « {canonical} ».")
                    continue
                if canonical in self.table_infos:
                    self.report.add("ERROR", "DUPLICATE_TABLE_FILE", f"Plusieurs entrées représentent la table « {canonical} ».", canonical)
                    continue
                self.table_infos[canonical] = info

        for filename in sorted(REQUIRED_TABLES):
            if filename not in self.table_infos:
                self.report.add("ERROR", "MISSING_REQUIRED_TABLE", f"La table obligatoire « {filename} » est absente.", filename)
        if not any(filename in self.table_infos for filename in CALENDAR_TABLES):
            self.report.add("ERROR", "MISSING_SERVICE_CALENDAR", "Il faut au moins une table calendar.txt ou calendar_dates.txt.")

        return self.report.errors == 0

    def _find_feed_root(self, infos: list[zipfile.ZipInfo]) -> PurePosixPath | None:
        paths = [PurePosixPath(info.filename) for info in infos]
        root_files = {path.name.lower() for path in paths if len(path.parts) == 1}
        core = {"agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"}
        if core.intersection(root_files):
            return PurePosixPath(".")

        parents = {path.parent for path in paths}
        if len(parents) == 1:
            return next(iter(parents))

        # Accept a single wrapper folder, but don't guess between multiple feeds.
        first_parts = {path.parts[0] for path in paths if path.parts}
        if len(first_parts) == 1 and all(len(path.parts) >= 2 for path in paths):
            root = PurePosixPath(next(iter(first_parts)))
            if all(path.is_relative_to(root) for path in paths):
                return root

        self.report.add("ERROR", "AMBIGUOUS_FEED_ROOT", "Impossible d’identifier une racine GTFS unique dans l’archive.")
        return None

    def _scan_tables(self) -> None:
        self._scan("agency.txt", REQUIRED_TABLES["agency.txt"], self._agency_row)
        self._scan("stops.txt", REQUIRED_TABLES["stops.txt"], self._stop_row)
        self._scan("routes.txt", REQUIRED_TABLES["routes.txt"], self._route_row)
        self._scan("trips.txt", REQUIRED_TABLES["trips.txt"], self._trip_row)
        if "calendar.txt" in self.table_infos:
            self._scan("calendar.txt", OPTIONAL_HEADERS["calendar.txt"], self._calendar_row)
        if "calendar_dates.txt" in self.table_infos:
            self._scan("calendar_dates.txt", OPTIONAL_HEADERS["calendar_dates.txt"], self._calendar_date_row)
        if "frequencies.txt" in self.table_infos:
            self._scan("frequencies.txt", OPTIONAL_HEADERS["frequencies.txt"], self._frequency_row)
        if "shapes.txt" in self.table_infos:
            self._scan("shapes.txt", OPTIONAL_HEADERS["shapes.txt"], self._shape_row)
        self._scan("stop_times.txt", REQUIRED_TABLES["stop_times.txt"], self._stop_time_row)
        if "transfers.txt" in self.table_infos:
            self._scan("transfers.txt", OPTIONAL_HEADERS["transfers.txt"], self._transfer_row)
        if "feed_info.txt" in self.table_infos:
            self._scan("feed_info.txt", OPTIONAL_HEADERS["feed_info.txt"], self._feed_info_row)

    def _scan(self, filename: str, required_headers: set[str], handler: Callable[[dict[str, str | None], int], None]) -> None:
        assert self.archive is not None
        info = self.table_infos.get(filename)
        if info is None:
            self.report.tables[filename] = 0
            return

        count = 0
        try:
            with self.archive.open(info, "r") as binary:
                with io.TextIOWrapper(binary, encoding="utf-8-sig", newline="") as text:
                    reader = csv.DictReader(text, strict=True)
                    headers = reader.fieldnames
                    if not headers:
                        self.report.add("ERROR", "EMPTY_TABLE", "La table ne contient pas de ligne d’en-tête.", filename)
                        self.report.tables[filename] = 0
                        return
                    if len(headers) != len(set(headers)):
                        self.report.add("ERROR", "DUPLICATE_COLUMN", "La table contient des noms de colonnes dupliqués.", filename, 1)
                    missing_headers = sorted(required_headers.difference(headers))
                    if missing_headers:
                        self.report.add("ERROR", "MISSING_COLUMNS", f"Colonnes requises absentes : {', '.join(missing_headers)}.", filename, 1)
                        self.report.tables[filename] = 0
                        return

                    for row_number, row in enumerate(reader, start=2):
                        count += 1
                        if count > self.limits.max_rows_per_table:
                            self.report.add("ERROR", "TOO_MANY_ROWS", f"La table dépasse la limite de {self.limits.max_rows_per_table} lignes.", filename, row_number)
                            break
                        if None in row:
                            self.report.add("ERROR", "CSV_EXTRA_FIELDS", "La ligne contient plus de champs que l’en-tête.", filename, row_number)
                            continue
                        if any(value is None for value in row.values()):
                            self.report.add("ERROR", "CSV_MISSING_FIELDS", "La ligne contient moins de champs que l’en-tête.", filename, row_number)
                            continue
                        handler(row, row_number)
        except (UnicodeDecodeError, csv.Error, OSError, RuntimeError, zipfile.BadZipFile) as error:
            self.report.add("ERROR", "TABLE_READ_ERROR", f"Erreur de lecture CSV : {error}.", filename)
        self.report.tables[filename] = count
        if count == 0 and filename in REQUIRED_TABLES:
            self.report.add("ERROR", "EMPTY_TABLE", "La table ne contient aucune donnée.", filename)

    def _agency_row(self, row: dict[str, str | None], line: int) -> None:
        self.agency_rows += 1
        agency_id = self._value(row, "agency_id")
        if agency_id:
            if agency_id in self.agency_ids:
                self.report.add("ERROR", "DUPLICATE_ID", f"agency_id « {agency_id} » dupliqué.", "agency.txt", line)
            self.agency_ids.add(agency_id)
        else:
            self.agency_missing_id_rows.append(line)
        for column in ("agency_name", "agency_url", "agency_timezone"):
            value = self._value(row, column)
            if not value:
                self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", f"La valeur « {column} » est vide.", "agency.txt", line)
            elif column == "agency_timezone" and self.timezone_names and value not in self.timezone_names:
                self.report.add("ERROR", "INVALID_TIMEZONE", f"agency_timezone « {value} » n’est pas un fuseau IANA reconnu.", "agency.txt", line)
            elif column == "agency_timezone" and not self.timezone_names:
                self.report.add("WARNING", "TIMEZONE_DATABASE_UNAVAILABLE", "La base IANA des fuseaux n’est pas disponible ; agency_timezone n’a pas pu être vérifié.", "agency.txt", line)

    def _stop_row(self, row: dict[str, str | None], line: int) -> None:
        stop_id = self._value(row, "stop_id")
        if not stop_id:
            self.report.add("ERROR", "EMPTY_ID", "stop_id est vide.", "stops.txt", line)
        elif stop_id in self.stop_ids:
            self.report.add("ERROR", "DUPLICATE_ID", f"stop_id « {stop_id} » dupliqué.", "stops.txt", line)
        else:
            self.stop_ids.add(stop_id)

        location_type_raw = self._value(row, "location_type")
        location_type = self._integer(location_type_raw, "location_type", "stops.txt", line, required=False)
        if location_type is None:
            location_type = 0
        elif location_type not in range(0, 5):
            self.report.add("ERROR", "INVALID_LOCATION_TYPE", "location_type doit être compris entre 0 et 4.", "stops.txt", line)
        if location_type != 3 and not self._value(row, "stop_name"):
            self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", "stop_name est requis sauf pour un generic node (location_type=3).", "stops.txt", line)
        coordinates_required = location_type != 3
        self._coordinate(row, "stop_lat", -90, 90, "stops.txt", line, required=coordinates_required)
        self._coordinate(row, "stop_lon", -180, 180, "stops.txt", line, required=coordinates_required)
        if stop_id:
            self.stop_types[stop_id] = location_type
            parent = self._value(row, "parent_station")
            if parent:
                self.parent_stations.append((line, stop_id, parent))
                if location_type == 1:
                    self.report.add("ERROR", "STATION_HAS_PARENT", "Une station (location_type=1) ne doit pas avoir de parent_station.", "stops.txt", line)
            elif location_type in {2, 3, 4}:
                self.report.add("ERROR", "MISSING_PARENT_STATION", "Cette location_type doit référencer son parent station.", "stops.txt", line)

    def _route_row(self, row: dict[str, str | None], line: int) -> None:
        route_id = self._value(row, "route_id")
        if not route_id:
            self.report.add("ERROR", "EMPTY_ID", "route_id est vide.", "routes.txt", line)
        elif route_id in self.route_ids:
            self.report.add("ERROR", "DUPLICATE_ID", f"route_id « {route_id} » dupliqué.", "routes.txt", line)
        else:
            self.route_ids.add(route_id)

        if not self._value(row, "route_short_name") and not self._value(row, "route_long_name"):
            self.report.add("ERROR", "MISSING_ROUTE_NAME", "route_short_name et route_long_name sont tous deux vides.", "routes.txt", line)
        route_type = self._integer(self._value(row, "route_type"), "route_type", "routes.txt", line, required=True)
        if route_type is not None and not (route_type in range(0, 8) or route_type in {11, 12} or 100 <= route_type <= 1700):
            self.report.add("ERROR", "INVALID_ROUTE_TYPE", "route_type n’est pas une valeur GTFS reconnue.", "routes.txt", line)
        if route_id:
            self.route_agencies[route_id] = self._value(row, "agency_id")

    def _trip_row(self, row: dict[str, str | None], line: int) -> None:
        trip_id = self._value(row, "trip_id")
        route_id = self._value(row, "route_id")
        service_id = self._value(row, "service_id")
        shape_id = self._value(row, "shape_id")
        if not trip_id:
            self.report.add("ERROR", "EMPTY_ID", "trip_id est vide.", "trips.txt", line)
        elif trip_id in self.trip_rows:
            self.report.add("ERROR", "DUPLICATE_ID", f"trip_id « {trip_id} » dupliqué.", "trips.txt", line)
        else:
            self.trip_rows[trip_id] = (route_id, service_id, shape_id)
        if not route_id:
            self.report.add("ERROR", "EMPTY_ROUTE_REFERENCE", "route_id est vide.", "trips.txt", line)
        if not service_id:
            self.report.add("ERROR", "EMPTY_SERVICE_REFERENCE", "service_id est vide.", "trips.txt", line)
        direction = self._value(row, "direction_id")
        if direction and direction not in {"0", "1"}:
            self.report.add("ERROR", "INVALID_DIRECTION_ID", "direction_id doit valoir 0 ou 1 lorsqu’il est renseigné.", "trips.txt", line)
        if route_id:
            self.route_trip_counts[route_id] = self.route_trip_counts.get(route_id, 0) + 1
        if shape_id:
            self.trip_shape_ids.append((line, trip_id, shape_id))

    def _calendar_row(self, row: dict[str, str | None], line: int) -> None:
        service_id = self._value(row, "service_id")
        if not service_id:
            self.report.add("ERROR", "EMPTY_ID", "service_id est vide.", "calendar.txt", line)
        elif service_id in self.calendar_ids:
            self.report.add("ERROR", "DUPLICATE_ID", f"service_id « {service_id} » dupliqué dans calendar.txt.", "calendar.txt", line)
        else:
            self.calendar_ids.add(service_id)
        for day_name in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"):
            value = self._value(row, day_name)
            if value not in {"0", "1"}:
                self.report.add("ERROR", "INVALID_CALENDAR_DAY", f"{day_name} doit valoir 0 ou 1.", "calendar.txt", line)
        start = self._date(self._value(row, "start_date"), "start_date", "calendar.txt", line)
        end = self._date(self._value(row, "end_date"), "end_date", "calendar.txt", line)
        if start and end and end < start:
            self.report.add("ERROR", "INVALID_DATE_RANGE", "end_date précède start_date.", "calendar.txt", line)

    def _calendar_date_row(self, row: dict[str, str | None], line: int) -> None:
        service_id = self._value(row, "service_id")
        service_date = self._value(row, "date")
        self._date(service_date, "date", "calendar_dates.txt", line)
        exception = self._value(row, "exception_type")
        if exception not in {"1", "2"}:
            self.report.add("ERROR", "INVALID_EXCEPTION_TYPE", "exception_type doit valoir 1 ou 2.", "calendar_dates.txt", line)
        key = (service_id, service_date)
        if not service_id:
            self.report.add("ERROR", "EMPTY_ID", "service_id est vide.", "calendar_dates.txt", line)
        elif key in self.calendar_date_keys:
            self.report.add("ERROR", "DUPLICATE_CALENDAR_EXCEPTION", f"service_id/date dupliqué : « {service_id} / {service_date} ».", "calendar_dates.txt", line)
        self.calendar_date_keys.add(key)
        if service_id:
            self.calendar_date_ids.add(service_id)

    def _stop_time_row(self, row: dict[str, str | None], line: int) -> None:
        trip_id = self._value(row, "trip_id")
        stop_id = self._value(row, "stop_id")
        sequence_raw = self._value(row, "stop_sequence")
        sequence = self._integer(sequence_raw, "stop_sequence", "stop_times.txt", line, required=True)
        if sequence is not None and sequence < 0:
            self.report.add("ERROR", "INVALID_STOP_SEQUENCE", "stop_sequence ne peut pas être négatif.", "stop_times.txt", line)
        if not trip_id:
            self.report.add("ERROR", "EMPTY_TRIP_REFERENCE", "trip_id est vide.", "stop_times.txt", line)
        else:
            self.stop_time_trip_ids.add(trip_id)
            self.trip_ids_with_stop_times.add(trip_id)
        if not stop_id:
            self.report.add("ERROR", "EMPTY_STOP_REFERENCE", "stop_id est vide.", "stop_times.txt", line)
        else:
            self.stop_time_stop_ids.add(stop_id)

        if sequence is not None and trip_id and self._sequence_seen("stop_sequences", trip_id, sequence):
            self.report.add("ERROR", "DUPLICATE_STOP_SEQUENCE", f"stop_sequence {sequence} répété pour le trip « {trip_id} ».", "stop_times.txt", line)

        arrival = self._time(self._value(row, "arrival_time"), "arrival_time", line)
        departure = self._time(self._value(row, "departure_time"), "departure_time", line)
        timepoint = self._value(row, "timepoint")
        if timepoint and timepoint not in {"0", "1"}:
            self.report.add("ERROR", "INVALID_TIMEPOINT", "timepoint doit valoir 0 ou 1 lorsqu’il est renseigné.", "stop_times.txt", line)
        if arrival is not None and departure is not None and departure < arrival:
            self.report.add("ERROR", "DEPARTURE_BEFORE_ARRIVAL", "departure_time précède arrival_time au même arrêt.", "stop_times.txt", line)
        if arrival is None and departure is None and timepoint != "0":
            self.report.add("WARNING", "MISSING_STOP_TIME", "Aucun horaire à cet arrêt ; timepoint=0 est nécessaire pour indiquer une heure interpolée.", "stop_times.txt", line)

        if sequence is not None and trip_id:
            previous = self.trip_last_time.get(trip_id)
            if previous is None:
                self.trip_last_time[trip_id] = (sequence, departure if departure is not None else arrival)
            elif sequence < previous[0]:
                self.unsorted_trip_lines.setdefault(trip_id, line)
            elif sequence > previous[0]:
                current_arrival = arrival if arrival is not None else departure
                if previous[1] is not None and current_arrival is not None and current_arrival < previous[1]:
                    self.report.add("ERROR", "TIME_BEFORE_PREVIOUS_STOP", "L’heure du passage recule par rapport à l’arrêt précédent du même trip.", "stop_times.txt", line)
                current_time = departure if departure is not None else arrival
                self.trip_last_time[trip_id] = (sequence, current_time if current_time is not None else previous[1])

    def _frequency_row(self, row: dict[str, str | None], line: int) -> None:
        trip_id = self._value(row, "trip_id")
        if not trip_id:
            self.report.add("ERROR", "EMPTY_TRIP_REFERENCE", "trip_id est vide.", "frequencies.txt", line)
        else:
            self.frequency_trip_ids.append((line, trip_id))
        start = self._time(self._value(row, "start_time"), "start_time", line, "frequencies.txt")
        end = self._time(self._value(row, "end_time"), "end_time", line, "frequencies.txt")
        if start is None:
            self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", "start_time est vide.", "frequencies.txt", line)
        if end is None:
            self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", "end_time est vide.", "frequencies.txt", line)
        if start is not None and end is not None and end <= start:
            self.report.add("ERROR", "INVALID_FREQUENCY_RANGE", "end_time doit être postérieur à start_time.", "frequencies.txt", line)
        headway = self._integer(self._value(row, "headway_secs"), "headway_secs", "frequencies.txt", line, required=True)
        if headway is not None and headway <= 0:
            self.report.add("ERROR", "INVALID_HEADWAY", "headway_secs doit être strictement positif.", "frequencies.txt", line)
        exact_times = self._value(row, "exact_times")
        if exact_times and exact_times not in {"0", "1"}:
            self.report.add("ERROR", "INVALID_EXACT_TIMES", "exact_times doit valoir 0 ou 1 lorsqu’il est renseigné.", "frequencies.txt", line)

    def _shape_row(self, row: dict[str, str | None], line: int) -> None:
        shape_id = self._value(row, "shape_id")
        sequence = self._integer(self._value(row, "shape_pt_sequence"), "shape_pt_sequence", "shapes.txt", line, required=True)
        if sequence is not None and sequence < 0:
            self.report.add("ERROR", "INVALID_SHAPE_SEQUENCE", "shape_pt_sequence ne peut pas être négatif.", "shapes.txt", line)
        self._coordinate(row, "shape_pt_lat", -90, 90, "shapes.txt", line)
        self._coordinate(row, "shape_pt_lon", -180, 180, "shapes.txt", line)
        if not shape_id:
            self.report.add("ERROR", "EMPTY_ID", "shape_id est vide.", "shapes.txt", line)
        elif sequence is not None:
            self.shape_ids.add(shape_id)
            if self._sequence_seen("shape_sequences", shape_id, sequence):
                self.report.add("ERROR", "DUPLICATE_SHAPE_SEQUENCE", f"shape_pt_sequence {sequence} répété pour « {shape_id} ».", "shapes.txt", line)

    def _transfer_row(self, row: dict[str, str | None], line: int) -> None:
        from_stop = self._value(row, "from_stop_id")
        to_stop = self._value(row, "to_stop_id")
        transfer_type = self._integer(self._value(row, "transfer_type"), "transfer_type", "transfers.txt", line, required=True)
        if transfer_type is not None and transfer_type not in {0, 1, 2, 3, 4, 5}:
            self.report.add("ERROR", "INVALID_TRANSFER_TYPE", "transfer_type doit être une valeur GTFS reconnue (0 à 5).", "transfers.txt", line)
        self.transfer_stop_ids.append((line, from_stop, to_stop))

    def _feed_info_row(self, row: dict[str, str | None], line: int) -> None:
        for column in ("feed_publisher_name", "feed_publisher_url", "feed_lang"):
            if not self._value(row, column):
                self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", f"La valeur « {column} » est vide.", "feed_info.txt", line)
        start = self._date(self._value(row, "feed_start_date"), "feed_start_date", "feed_info.txt", line, required=False)
        end = self._date(self._value(row, "feed_end_date"), "feed_end_date", "feed_info.txt", line, required=False)
        if start and end and end < start:
            self.report.add("ERROR", "INVALID_DATE_RANGE", "feed_end_date précède feed_start_date.", "feed_info.txt", line)

    def _check_references(self) -> None:
        if self.agency_rows > 1:
            for line in self.agency_missing_id_rows:
                self.report.add("ERROR", "MISSING_AGENCY_ID", "agency_id est requis lorsque plusieurs agences sont définies.", "agency.txt", line)

        if "routes.txt" in self.table_infos:
            for route_id, agency_id in self.route_agencies.items():
                if agency_id and agency_id not in self.agency_ids:
                    self.report.add("ERROR", "UNKNOWN_AGENCY_REFERENCE", f"La route « {route_id} » référence une agence inconnue « {agency_id} ».", "routes.txt")
                elif not agency_id and self.agency_rows > 1:
                    self.report.add("ERROR", "MISSING_AGENCY_REFERENCE", f"La route « {route_id} » doit indiquer agency_id lorsque plusieurs agences existent.", "routes.txt")

        for trip_id, (route_id, service_id, _shape_id) in self.trip_rows.items():
            if route_id and route_id not in self.route_ids:
                self.report.add("ERROR", "UNKNOWN_ROUTE_REFERENCE", f"Le trip « {trip_id} » référence une route inconnue « {route_id} ».", "trips.txt")
            if service_id and service_id not in self.calendar_ids and service_id not in self.calendar_date_ids:
                self.report.add("ERROR", "UNKNOWN_SERVICE_REFERENCE", f"Le trip « {trip_id} » référence un service absent des calendriers : « {service_id} ».", "trips.txt")
            if trip_id not in self.trip_ids_with_stop_times:
                self.report.add("ERROR", "TRIP_WITHOUT_STOP_TIMES", f"Le trip « {trip_id} » n’a aucune ligne dans stop_times.txt.", "trips.txt")

        for trip_id in self.stop_time_trip_ids:
            if trip_id not in self.trip_rows:
                self.report.add("ERROR", "UNKNOWN_TRIP_REFERENCE", f"stop_times.txt référence un trip inconnu « {trip_id} ».", "stop_times.txt")
        for line, trip_id in self.frequency_trip_ids:
            if trip_id not in self.trip_rows:
                self.report.add("ERROR", "UNKNOWN_TRIP_REFERENCE", f"frequencies.txt référence un trip inconnu « {trip_id} ».", "frequencies.txt", line)
        for stop_id in self.stop_time_stop_ids:
            if stop_id not in self.stop_ids:
                self.report.add("ERROR", "UNKNOWN_STOP_REFERENCE", f"stop_times.txt référence un arrêt inconnu « {stop_id} ».", "stop_times.txt")

        for line, child_id, parent_id in self.parent_stations:
            if parent_id not in self.stop_ids:
                self.report.add("ERROR", "UNKNOWN_PARENT_STATION", f"L’arrêt « {child_id} » référence un parent inconnu « {parent_id} ».", "stops.txt", line)
            elif self.stop_types.get(parent_id) != 1:
                self.report.add("ERROR", "INVALID_PARENT_STATION", f"Le parent « {parent_id} » de « {child_id} » n’est pas une station (location_type=1).", "stops.txt", line)

        for line, trip_id, shape_id in self.trip_shape_ids:
            if shape_id not in self.shape_ids:
                self.report.add("ERROR", "UNKNOWN_SHAPE_REFERENCE", f"Le trip « {trip_id} » référence un tracé absent « {shape_id} ».", "trips.txt", line)

        for line, from_stop, to_stop in self.transfer_stop_ids:
            if from_stop not in self.stop_ids:
                self.report.add("ERROR", "UNKNOWN_TRANSFER_STOP", f"from_stop_id « {from_stop} » est inconnu.", "transfers.txt", line)
            if to_stop not in self.stop_ids:
                self.report.add("ERROR", "UNKNOWN_TRANSFER_STOP", f"to_stop_id « {to_stop} » est inconnu.", "transfers.txt", line)

        for route_id in self.route_ids:
            if self.route_trip_counts.get(route_id, 0) == 0:
                self.report.add("WARNING", "ROUTE_WITHOUT_TRIPS", f"La route « {route_id} » ne contient aucun trip.", "routes.txt")
        for stop_id in self.stop_ids.difference(self.stop_time_stop_ids):
            self.report.add("WARNING", "STOP_WITHOUT_SERVICE", f"L’arrêt « {stop_id} » n’est référencé par aucun stop_time.", "stops.txt")
        for trip_id, line in self.unsorted_trip_lines.items():
            self.report.add("WARNING", "STOP_TIMES_NOT_SORTED", f"Les lignes stop_times du trip « {trip_id} » ne sont pas ordonnées par stop_sequence ; le contrôle chronologique complet est limité.", "stop_times.txt", line)

    def _warn_unsupported_tables(self) -> None:
        for filename in sorted(set(self.table_infos).difference(SUPPORTED_TABLES)):
            self.report.add("WARNING", "OPTIONAL_TABLE_NOT_VALIDATED", f"La table optionnelle « {filename} » est présente mais n’est pas encore contrôlée par cet outil.", filename)

    def _sequence_seen(self, table: str, object_id: str, sequence: int) -> bool:
        if table not in {"stop_sequences", "shape_sequences"}:
            raise ValueError("Unexpected sequence index table")
        if self.validation_db is None:
            raise RuntimeError("Validation index is not initialized")
        cursor = self.validation_db.execute(
            f"INSERT OR IGNORE INTO {table} (trip_id, sequence) VALUES (?, ?)" if table == "stop_sequences" else
            f"INSERT OR IGNORE INTO {table} (shape_id, sequence) VALUES (?, ?)",
            (object_id, sequence),
        )
        return cursor.rowcount == 0

    def _coordinate(self, row: dict[str, str | None], column: str, lower: float, upper: float, table: str, line: int, required: bool = True) -> float | None:
        raw = self._value(row, column)
        if not raw:
            if required:
                self.report.add("ERROR", "INVALID_COORDINATE", f"{column} n’est pas renseigné.", table, line)
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            self.report.add("ERROR", "INVALID_COORDINATE", f"{column} n’est pas un nombre valide.", table, line)
            return None
        if not math.isfinite(value) or value < lower or value > upper:
            self.report.add("ERROR", "COORDINATE_OUT_OF_RANGE", f"{column} doit être compris entre {lower} et {upper}.", table, line)
            return None
        return value

    def _integer(self, raw: str, column: str, table: str, line: int, required: bool) -> int | None:
        if not raw:
            if required:
                self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", f"La valeur « {column} » est vide.", table, line)
            return None
        try:
            return int(raw)
        except ValueError:
            self.report.add("ERROR", "INVALID_INTEGER", f"{column} n’est pas un entier valide.", table, line)
            return None

    def _date(self, raw: str, column: str, table: str, line: int, required: bool = True) -> date | None:
        if not raw:
            if required:
                self.report.add("ERROR", "EMPTY_REQUIRED_VALUE", f"La date « {column} » est vide.", table, line)
            return None
        try:
            return datetime.strptime(raw, "%Y%m%d").date()
        except ValueError:
            self.report.add("ERROR", "INVALID_DATE", f"{column} doit suivre le format GTFS YYYYMMDD et être une date valide.", table, line)
            return None

    def _time(self, raw: str, column: str, line: int, table: str = "stop_times.txt") -> int | None:
        if not raw:
            return None
        match = TIME_RE.fullmatch(raw)
        if not match:
            self.report.add("ERROR", "INVALID_TIME", f"{column} doit suivre le format HH:MM:SS (les heures après minuit peuvent dépasser 24).", table, line)
            return None
        hours, minutes, seconds = (int(value) for value in match.groups())
        if minutes > 59 or seconds > 59:
            self.report.add("ERROR", "INVALID_TIME", f"{column} contient des minutes ou secondes hors plage.", table, line)
            return None
        return hours * 3600 + minutes * 60 + seconds

    @staticmethod
    def _value(row: dict[str, str | None], column: str) -> str:
        value = row.get(column)
        return value.strip() if isinstance(value, str) else ""


def validate_gtfs_archive(path: str | Path, limits: ValidationLimits | None = None) -> dict[str, object]:
    """Validate a GTFS zip without extracting it to disk."""
    return GTFSValidator(Path(path), limits).validate()


def main() -> int:
    parser = argparse.ArgumentParser(description="Valide la structure d’une archive GTFS Static sans l’extraire.")
    parser.add_argument("archive", type=Path, help="Chemin vers une archive GTFS .zip")
    parser.add_argument("--max-archive-mb", type=int, default=100, help="Taille ZIP maximale (MiB, défaut : 100)")
    parser.add_argument("--max-total-mb", type=int, default=500, help="Taille décompressée maximale (MiB, défaut : 500)")
    args = parser.parse_args()
    if args.max_archive_mb <= 0 or args.max_total_mb <= 0:
        parser.error("les limites de taille doivent être des nombres positifs")

    limits = ValidationLimits(
        max_archive_bytes=args.max_archive_mb * 1024 * 1024,
        max_total_uncompressed_bytes=args.max_total_mb * 1024 * 1024,
    )
    result = validate_gtfs_archive(args.archive, limits)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if result["structure_valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
