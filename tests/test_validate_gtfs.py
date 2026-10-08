from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.validate_gtfs import ValidationLimits, validate_gtfs_archive


VALID_TABLES = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\n,Test Agency,https://example.invalid, Africa/Dakar\n",
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        "S1,Stop One,14.7000,-17.4500,0,\n"
        "S2,Stop Two,14.7100,-17.4600,0,\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,,1,Test Route,3\n",
    "trips.txt": "route_id,service_id,trip_id,direction_id,shape_id\nR1,WK,T1,0,\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T1,25:10:00,25:10:00,S1,1\n"
        "T1,25:20:00,25:20:00,S2,2\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260101,20261231\n"
    ),
}


class GTFSValidatorTests(unittest.TestCase):
    def make_archive(self, tables: dict[str, str], wrapper: str | None = None) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        archive_path = Path(directory.name) / "feed.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for filename, content in tables.items():
                name = f"{wrapper}/{filename}" if wrapper else filename
                archive.writestr(name, content.encode("utf-8"))
        return archive_path

    @staticmethod
    def issue_codes(report: dict[str, object]) -> set[str]:
        return {str(issue["code"]) for issue in report["issues"]}  # type: ignore[index]

    def test_valid_feed_accepts_gtfs_times_after_midnight(self) -> None:
        report = validate_gtfs_archive(self.make_archive(VALID_TABLES))
        self.assertTrue(report["structure_valid"])
        self.assertFalse(report["production_ready"])
        self.assertEqual(report["counts"], {"errors": 0, "warnings": 0})
        self.assertEqual(report["tables"]["stop_times.txt"], 2)  # type: ignore[index]
        self.assertIn("sha256", report["dataset"])  # type: ignore[operator]

    def test_accepts_a_single_enclosing_directory_in_the_zip(self) -> None:
        report = validate_gtfs_archive(self.make_archive(VALID_TABLES, wrapper="provider-export"))
        self.assertTrue(report["structure_valid"])

    def test_cli_emits_json_and_success_exit_code_for_a_valid_feed(self) -> None:
        archive = self.make_archive(VALID_TABLES)
        script = Path(__file__).resolve().parents[1] / "scripts" / "validate_gtfs.py"
        completed = subprocess.run([sys.executable, str(script), str(archive)], capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["structure_valid"])

    def test_calendar_dates_can_be_the_only_service_calendar(self) -> None:
        tables = {name: value for name, value in VALID_TABLES.items() if name != "calendar.txt"}
        tables["calendar_dates.txt"] = "service_id,date,exception_type\nWK,20261008,1\n"
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertTrue(report["structure_valid"])

    def test_missing_required_table_is_an_error(self) -> None:
        tables = {name: value for name, value in VALID_TABLES.items() if name != "routes.txt"}
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertFalse(report["structure_valid"])
        self.assertIn("MISSING_REQUIRED_TABLE", self.issue_codes(report))

    def test_duplicate_stop_id_and_invalid_coordinates_are_reported(self) -> None:
        tables = dict(VALID_TABLES)
        tables["stops.txt"] = (
            "stop_id,stop_name,stop_lat,stop_lon\n"
            "S1,Stop One,91,-17.45\n"
            "S1,Duplicate,14.70,-17.45\n"
        )
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertIn("DUPLICATE_ID", self.issue_codes(report))
        self.assertIn("COORDINATE_OUT_OF_RANGE", self.issue_codes(report))

    def test_unknown_stop_and_trip_references_are_reported(self) -> None:
        tables = dict(VALID_TABLES)
        tables["stop_times.txt"] = (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "MISSING,08:00:00,08:00:00,UNKNOWN_STOP,1\n"
        )
        report = validate_gtfs_archive(self.make_archive(tables))
        codes = self.issue_codes(report)
        self.assertIn("UNKNOWN_TRIP_REFERENCE", codes)
        self.assertIn("UNKNOWN_STOP_REFERENCE", codes)
        self.assertIn("TRIP_WITHOUT_STOP_TIMES", codes)

    def test_trip_service_must_exist_in_a_calendar(self) -> None:
        tables = dict(VALID_TABLES)
        tables["trips.txt"] = "route_id,service_id,trip_id\nR1,UNKNOWN,T1\n"
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertIn("UNKNOWN_SERVICE_REFERENCE", self.issue_codes(report))

    def test_non_monotonic_trip_times_are_rejected(self) -> None:
        tables = dict(VALID_TABLES)
        tables["stop_times.txt"] = (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "T1,08:10:00,08:10:00,S1,1\n"
            "T1,08:09:00,08:09:00,S2,2\n"
        )
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertIn("TIME_BEFORE_PREVIOUS_STOP", self.issue_codes(report))

    def test_frequency_rows_are_checked_and_never_promoted_to_realtime(self) -> None:
        tables = dict(VALID_TABLES)
        tables["frequencies.txt"] = "trip_id,start_time,end_time,headway_secs,exact_times\nT1,25:00:00,25:30:00,300,0\n"
        valid_report = validate_gtfs_archive(self.make_archive(tables))
        self.assertTrue(valid_report["structure_valid"])
        self.assertFalse(valid_report["production_ready"])

        tables["frequencies.txt"] = "trip_id,start_time,end_time,headway_secs\nUNKNOWN,25:30:00,25:00:00,0\n"
        invalid_report = validate_gtfs_archive(self.make_archive(tables))
        codes = self.issue_codes(invalid_report)
        self.assertIn("INVALID_HEADWAY", codes)
        self.assertIn("INVALID_FREQUENCY_RANGE", codes)
        self.assertIn("UNKNOWN_TRIP_REFERENCE", codes)

    def test_unchecked_optional_tables_are_explicitly_reported(self) -> None:
        tables = dict(VALID_TABLES)
        tables["fare_rules.txt"] = "route_id\nR1\n"
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertTrue(report["structure_valid"])
        self.assertIn("OPTIONAL_TABLE_NOT_VALIDATED", self.issue_codes(report))

    def test_unsafe_archive_paths_are_rejected_without_extraction(self) -> None:
        tables = dict(VALID_TABLES)
        tables["../outside.txt"] = "should_not_be_written\n"
        report = validate_gtfs_archive(self.make_archive(tables))
        self.assertFalse(report["structure_valid"])
        self.assertIn("UNSAFE_ARCHIVE_PATH", self.issue_codes(report))

    def test_archive_size_limit_is_enforced(self) -> None:
        archive = self.make_archive(VALID_TABLES)
        report = validate_gtfs_archive(archive, ValidationLimits(max_archive_bytes=8))
        self.assertFalse(report["structure_valid"])
        self.assertIn("ARCHIVE_TOO_LARGE", self.issue_codes(report))

    def test_non_zip_input_returns_a_structured_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "not-a-zip.zip"
            path.write_text("not a zip", encoding="utf-8")
            report = validate_gtfs_archive(path)
        self.assertFalse(report["structure_valid"])
        self.assertIn("INVALID_ZIP", self.issue_codes(report))


if __name__ == "__main__":
    unittest.main()
