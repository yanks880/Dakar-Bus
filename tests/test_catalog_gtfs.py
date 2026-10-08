from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from scripts.catalog_gtfs import compare_staged_datasets, list_staged_datasets, show_staged_dataset
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_stage_gtfs import NOW, VALID_METADATA, VALID_TABLES


class GTFSCatalogTests(unittest.TestCase):
    def create_staged_dataset(
        self,
        directory: str,
        *,
        version: str = "test-v1",
        tables: dict[str, str] | None = None,
        valid_until: str | None = None,
    ) -> tuple[Path, dict[str, object]]:
        archive_path = Path(directory) / f"{version}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in (tables or VALID_TABLES).items():
                archive.writestr(name, content)
        metadata = IngestMetadata(
            **{
                **VALID_METADATA.__dict__,
                "dataset_version": version,
                "valid_until": valid_until or VALID_METADATA.valid_until,
            }
        )
        output = Path(directory) / "staging"
        result = stage_gtfs_archive(archive_path, output, metadata, now=NOW)
        self.assertTrue(result["staged"], result)
        return output, result

    def test_list_verifies_hash_and_shows_current_unpublished_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, staged = self.create_staged_dataset(directory)
            entries = list_staged_datasets(output, now=NOW)
            self.assertEqual(len(entries), 1)
            entry = entries[0]
            self.assertEqual(entry["dataset_id"], staged["dataset_id"])
            self.assertEqual(entry["integrity"], "OK")
            self.assertEqual(entry["effective_validity_status"], "CURRENT")
            self.assertEqual(entry["publication_status"], "NOT_PUBLISHED")

    def test_catalog_recomputes_expiration_instead_of_trusting_old_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, staged = self.create_staged_dataset(directory)
            later = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)
            entry = show_staged_dataset(output, str(staged["dataset_id"]), now=later)
            self.assertEqual(entry["integrity"], "OK")
            self.assertEqual(entry["effective_validity_status"], "STALE")
            # Original staging-time snapshot remains available for audit.
            self.assertEqual(entry["manifest"]["validity_status"], "CURRENT")  # type: ignore[index]

    def test_catalog_accepts_subsecond_verified_timestamp_at_ingest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory) / "subsecond.zip"
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name, content in VALID_TABLES.items():
                    archive.writestr(name, content)
            precise_now = datetime(2026, 10, 8, 12, 0, 0, 500_000, tzinfo=timezone.utc)
            metadata = IngestMetadata(
                **{
                    **VALID_METADATA.__dict__,
                    "verified_at": "2026-10-08T12:00:00.400Z",
                }
            )
            output = Path(directory) / "staging"
            staged = stage_gtfs_archive(archive_path, output, metadata, now=precise_now)
            self.assertTrue(staged["staged"], staged)
            catalog_entry = show_staged_dataset(output, str(staged["dataset_id"]), now=precise_now)
            self.assertEqual(catalog_entry["integrity"], "OK")

            # Manifests written before microsecond precision rounded this value down.
            dataset_dir = Path(str(staged["staged_directory"]))
            manifest_path = dataset_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["ingested_at"] = "2026-10-08T12:00:00+00:00"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            legacy_entry = show_staged_dataset(output, str(staged["dataset_id"]), now=precise_now)
            self.assertEqual(legacy_entry["integrity"], "OK")

    def test_catalog_detects_tampered_archive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, staged = self.create_staged_dataset(directory)
            dataset_dir = Path(str(staged["staged_directory"]))
            with (dataset_dir / "feed.zip").open("ab") as archive:
                archive.write(b"tampered")
            entry = show_staged_dataset(output, str(staged["dataset_id"]), now=NOW)
            self.assertEqual(entry["integrity"], "INVALID")
            self.assertEqual(entry["integrity_issue"]["code"], "ARCHIVE_SIZE_MISMATCH")  # type: ignore[index]

    def test_catalog_refuses_manifest_archive_path_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, staged = self.create_staged_dataset(directory)
            dataset_dir = Path(str(staged["staged_directory"]))
            manifest_path = dataset_dir / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["archive"]["stored_as"] = "../outside.zip"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            entry = show_staged_dataset(output, str(staged["dataset_id"]), now=NOW)
            self.assertEqual(entry["integrity"], "INVALID")
            self.assertEqual(entry["integrity_issue"]["code"], "UNSAFE_ARCHIVE_REFERENCE")  # type: ignore[index]

    def test_compare_reports_record_count_delta_not_a_fake_row_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, before = self.create_staged_dataset(directory, version="test-v1")
            expanded_tables = dict(VALID_TABLES)
            expanded_tables["stops.txt"] += "S3,Stop Three,14.7200,-17.4700\n"
            expanded_tables["stop_times.txt"] += "T1,08:20:00,08:20:00,S3,3\n"
            _output, after = self.create_staged_dataset(directory, version="test-v2", tables=expanded_tables)

            comparison = compare_staged_datasets(
                output,
                str(before["dataset_id"]),
                str(after["dataset_id"]),
                now=NOW,
            )
            self.assertTrue(comparison["comparable"])
            self.assertEqual(comparison["record_count_delta"]["stops.txt"], 1)  # type: ignore[index]
            self.assertEqual(comparison["record_count_delta"]["stop_times.txt"], 1)  # type: ignore[index]
            self.assertIn("no row-by-row", comparison["comparison_scope"])

    def test_empty_catalog_and_path_traversal_identifier(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(list_staged_datasets(Path(directory) / "missing", now=NOW), [])
            with self.assertRaisesRegex(ValueError, "caractères interdits"):
                show_staged_dataset(directory, "../outside")

    def test_cli_emits_machine_readable_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output, _staged = self.create_staged_dataset(directory)
            script = Path(__file__).resolve().parents[1] / "scripts" / "catalog_gtfs.py"
            completed = subprocess.run(
                [sys.executable, str(script), "--root", str(output), "list"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            catalog = json.loads(completed.stdout)
            self.assertEqual(len(catalog), 1)
            self.assertEqual(catalog[0]["integrity"], "OK")


if __name__ == "__main__":
    unittest.main()
