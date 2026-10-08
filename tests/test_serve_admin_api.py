from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.client import HTTPResponse
from pathlib import Path
from typing import Any

from scripts.review_gtfs import approve_dataset
from scripts.serve_admin_api import catalog_payload, create_server, pipeline_summary
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_stage_gtfs import NOW, VALID_METADATA, VALID_TABLES

FULL_ATTESTATIONS: dict[str, dict[str, str | None]] = {
    "source_identity": {"evidence": "Source confirmée par l’éditeur du flux.", "reference": "https://example.invalid/feed"},
    "reuse_rights": {"evidence": "Licence ouverte vérifiée sur la page de la source.", "reference": None},
    "operator_confirmed": {"evidence": "Opérateur confirmé, réseau distinct d’AFTU.", "reference": None},
    "service_operational": {"evidence": "Service exploité constaté aux dates déclarées.", "reference": None},
    "freshness_confirmed": {"evidence": "Période de validité confirmée avec la source.", "reference": None},
}


class AdminApiTests(unittest.TestCase):
    def stage_feed(self, directory: str, version: str = "api-v1") -> tuple[Path, str]:
        archive_path = Path(directory) / f"{version}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in VALID_TABLES.items():
                archive.writestr(name, content)
        metadata = IngestMetadata(
            **{**VALID_METADATA.__dict__, "dataset_version": version, "source_type": "OFFICIAL", "service_status": "ACTIVE"}
        )
        output = Path(directory) / "staging"
        result = stage_gtfs_archive(archive_path, output, metadata, now=NOW)
        self.assertTrue(result["staged"], result)
        return output, str(result["dataset_id"])

    def get(self, base_url: str, path: str, method: str = "GET") -> tuple[int, dict[str, Any], HTTPResponse]:
        request = urllib.request.Request(base_url + path, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed http URL
                body = response.read().decode("utf-8")
                return response.status, json.loads(body) if body else {}, response
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8")
            return error.code, json.loads(body) if body else {}, error

    def test_payload_helpers_report_review_state_and_never_publish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            summary = pipeline_summary(root, now=NOW)
            self.assertEqual(summary["counts"]["staged"], 1)
            self.assertEqual(summary["counts"]["pending_review"], 1)
            self.assertEqual(summary["counts"]["published"], 0)
            self.assertEqual(summary["publication_status"], "NOT_PUBLISHED")

            approve_dataset(root, dataset_id, reviewer_id="fatou.ndiaye", attestations=FULL_ATTESTATIONS, now=NOW)
            approved = pipeline_summary(root, now=NOW)
            self.assertEqual(approved["counts"]["approved"], 1)
            self.assertEqual(approved["counts"]["pending_review"], 0)
            self.assertEqual(approved["counts"]["published"], 0)

            catalog = catalog_payload(root, now=NOW)
            self.assertEqual(len(catalog["datasets"]), 1)
            self.assertEqual(catalog["datasets"][0]["review_status"], "APPROVED")

    def test_server_serves_catalog_and_refuses_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            server = create_server(root, "127.0.0.1", 0, quiet=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                status, health, _ = self.get(base_url, "/healthz")
                self.assertEqual(status, 200)
                self.assertEqual(health["mode"], "read-only")

                status, pipeline, response = self.get(base_url, "/api/pipeline")
                self.assertEqual(status, 200)
                self.assertEqual(pipeline["counts"]["pending_review"], 1)
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertIn("charset=utf-8", response.headers["Content-Type"])

                status, catalog, _ = self.get(base_url, "/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(catalog["datasets"][0]["dataset_id"], dataset_id)

                status, dossier, _ = self.get(base_url, f"/api/datasets/{dataset_id}")
                self.assertEqual(status, 200)
                self.assertEqual(dossier["review_status"], "PENDING_REVIEW")
                self.assertFalse(dossier["publication_ready"])

                status, missing, _ = self.get(base_url, "/api/datasets/does-not-exist")
                self.assertEqual(status, 404)
                self.assertEqual(missing["error"], "NOT_FOUND")

                status, traversal, _ = self.get(base_url, "/api/datasets/..%2F..%2Fetc")
                self.assertEqual(status, 404)
                self.assertEqual(traversal["error"], "NOT_FOUND")

                status, unknown, _ = self.get(base_url, "/api/nothing-here")
                self.assertEqual(status, 404)
                self.assertEqual(unknown["error"], "NOT_FOUND")

                status, refused, _ = self.get(base_url, "/api/pipeline", method="POST")
                self.assertEqual(status, 405)
                self.assertEqual(refused["error"], "READ_ONLY_API")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_empty_catalog_is_served_honestly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "staging"
            summary = pipeline_summary(root, now=NOW)
            self.assertEqual(summary["counts"]["staged"], 0)
            self.assertEqual(summary["counts"]["published"], 0)
            self.assertEqual(catalog_payload(root, now=NOW)["datasets"], [])


if __name__ == "__main__":
    unittest.main()
