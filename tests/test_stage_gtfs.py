from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive


NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)
VALID_METADATA = IngestMetadata(
    source="Test source for unit tests",
    source_type="GTFS",
    source_url="https://example.invalid/feed",
    operator="Test operator",
    dataset_version="test-v1",
    date_source="2026-10-08",
    verified_at="2026-10-08T11:00:00Z",
    valid_from="2026-10-01T00:00:00Z",
    valid_until="2026-10-31T23:59:59Z",
    confidence=0.5,
    service_status="UNKNOWN",
)

VALID_TABLES = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n,Test Agency,https://example.invalid,Africa/Dakar\n",
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon\n"
        "S1,Stop One,14.7000,-17.4500\n"
        "S2,Stop Two,14.7100,-17.4600\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,,1,Test Route,3\n",
    "trips.txt": "route_id,service_id,trip_id\nR1,WK,T1\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,08:00:00,08:00:00,S1,1\n"
        "T1,08:10:00,08:10:00,S2,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260101,20261231\n"
    ),
}


class GTFSStagingTests(unittest.TestCase):
    def create_archive(self, directory: str, tables: dict[str, str] | None = None) -> Path:
        path = Path(directory) / "feed.zip"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in (tables or VALID_TABLES).items():
                archive.writestr(name, content)
        return path

    def test_stages_current_feed_with_checksum_and_pending_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            result = stage_gtfs_archive(archive, output, VALID_METADATA, now=NOW)

            self.assertTrue(result["staged"])
            self.assertFalse(result["publication_ready"])
            manifest = result["manifest"]
            self.assertEqual(manifest["review_status"], "PENDING_REVIEW")  # type: ignore[index]
            self.assertEqual(manifest["publication_status"], "NOT_PUBLISHED")  # type: ignore[index]
            self.assertEqual(manifest["validity_status"], "CURRENT")  # type: ignore[index]
            self.assertEqual(manifest["confidence_basis"], "Déclarée par l’importateur ; non recalculée ni vérifiée indépendamment.")  # type: ignore[index]
            dataset_dir = Path(str(result["staged_directory"]))
            self.assertEqual((dataset_dir / "feed.zip").read_bytes(), archive.read_bytes())
            self.assertTrue((dataset_dir / "manifest.json").is_file())
            loaded_manifest = json.loads((dataset_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(loaded_manifest["dataset_id"], result["dataset_id"])

    def test_cli_stages_to_json_manifest_without_marking_publication_ready(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            script = Path(__file__).resolve().parents[1] / "scripts" / "stage_gtfs.py"
            cli_now = datetime.now(timezone.utc)
            completed = subprocess.run(
                [
                    sys.executable, str(script),
                    "--archive", str(archive),
                    "--output-dir", str(output),
                    "--source", VALID_METADATA.source,
                    "--source-type", VALID_METADATA.source_type,
                    "--source-url", str(VALID_METADATA.source_url),
                    "--operator", VALID_METADATA.operator,
                    "--dataset-version", VALID_METADATA.dataset_version,
                    "--date-source", cli_now.date().isoformat(),
                    "--verified-at", cli_now.isoformat(),
                    "--valid-from", "2000-01-01T00:00:00Z",
                    "--valid-until", "2099-01-01T00:00:00Z",
                    "--confidence", str(VALID_METADATA.confidence),
                    "--service-status", VALID_METADATA.service_status,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertTrue(result["staged"])
            self.assertFalse(result["publication_ready"])
            self.assertEqual(result["publication_status"], "NOT_PUBLISHED")

    def test_invalid_gtfs_is_not_copied_to_staging(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bad_tables = dict(VALID_TABLES)
            bad_tables.pop("routes.txt")
            archive = self.create_archive(directory, bad_tables)
            output = Path(directory) / "staging"
            result = stage_gtfs_archive(archive, output, VALID_METADATA, now=NOW)
            self.assertFalse(result["staged"])
            self.assertEqual(result["stage_error"], "GTFS_STRUCTURE_INVALID")
            self.assertFalse(output.exists())

    def test_expired_dataset_is_kept_stale_but_never_published(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            expired = IngestMetadata(
                **{**VALID_METADATA.__dict__, "valid_until": "2026-10-07T23:59:59Z"},
            )
            result = stage_gtfs_archive(archive, output, expired, now=NOW)
            self.assertTrue(result["staged"])
            self.assertFalse(result["publication_ready"])
            manifest = result["manifest"]
            self.assertEqual(manifest["validity_status"], "STALE")  # type: ignore[index]
            self.assertIn("La période de validité déclarée n’est pas en cours.", manifest["publication_blockers"])  # type: ignore[index]

    def test_metadata_requires_timezone_and_confidence_in_range(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            no_timezone = IngestMetadata(**{**VALID_METADATA.__dict__, "valid_from": "2026-10-01T00:00:00"})
            with self.assertRaisesRegex(ValueError, "fuseau horaire"):
                stage_gtfs_archive(archive, output, no_timezone, now=NOW)
            bad_confidence = IngestMetadata(**{**VALID_METADATA.__dict__, "confidence": 1.01})
            with self.assertRaisesRegex(ValueError, "entre 0 et 1"):
                stage_gtfs_archive(archive, output, bad_confidence, now=NOW)
            self.assertFalse(output.exists())

    def test_duplicate_identical_version_is_not_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            first = stage_gtfs_archive(archive, output, VALID_METADATA, now=NOW)
            second = stage_gtfs_archive(archive, output, VALID_METADATA, now=NOW)
            self.assertTrue(first["staged"])
            self.assertFalse(second["staged"])
            self.assertEqual(second["stage_error"], "DATASET_VERSION_EXISTS")
            self.assertEqual(len(list(output.iterdir())), 1)

    def test_unknown_operator_or_service_status_stays_unpublishable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = self.create_archive(directory)
            output = Path(directory) / "staging"
            metadata = IngestMetadata(
                **{
                    **VALID_METADATA.__dict__,
                    "source_type": "UNKNOWN",
                    "operator": "UNKNOWN",
                    "service_status": "UNKNOWN",
                }
            )
            result = stage_gtfs_archive(archive, output, metadata, now=NOW)
            self.assertTrue(result["staged"])
            self.assertFalse(result["publication_ready"])
            manifest = result["manifest"]
            self.assertIn("Le type de source n’est pas confirmé.", manifest["publication_blockers"])  # type: ignore[index]
            self.assertEqual(manifest["operator"], "UNKNOWN")  # type: ignore[index]


if __name__ == "__main__":
    unittest.main()
