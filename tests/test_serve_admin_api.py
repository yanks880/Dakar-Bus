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

from scripts.publish_gtfs import publish_dataset, revert_publication
from scripts.review_gtfs import approve_dataset
from scripts.serve_admin_api import catalog_payload, create_server, pipeline_summary
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_publish_gtfs import PUBLISH_TABLES
from test_stage_gtfs import NOW, VALID_METADATA, VALID_TABLES

FULL_ATTESTATIONS: dict[str, dict[str, str | None]] = {
    "source_identity": {"evidence": "Source confirmée par l’éditeur du flux.", "reference": "https://example.invalid/feed"},
    "reuse_rights": {"evidence": "Licence ouverte vérifiée sur la page de la source.", "reference": None},
    "operator_confirmed": {"evidence": "Opérateur confirmé, réseau distinct d’AFTU.", "reference": None},
    "service_operational": {"evidence": "Service exploité constaté aux dates déclarées.", "reference": None},
    "freshness_confirmed": {"evidence": "Période de validité confirmée avec la source.", "reference": None},
}


class ApiTestSupport(unittest.TestCase):
    def stage_feed(
        self, directory: str, version: str = "api-v1", tables: dict[str, str] | None = None
    ) -> tuple[Path, str]:
        archive_path = Path(directory) / f"{version}.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in (tables or VALID_TABLES).items():
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

    def publish_feed(self, directory: str, version: str = "api-v1") -> tuple[Path, Path, str, str]:
        # The published fixture needs named stops and routes to search for.
        root, dataset_id = self.stage_feed(directory, version, tables=PUBLISH_TABLES)
        approve_dataset(root, dataset_id, reviewer_id="fatou.ndiaye", attestations=FULL_ATTESTATIONS, now=NOW)
        published = Path(directory) / "published"
        result = publish_dataset(
            root, published, dataset_id,
            publisher_id="ousmane.fall", note="Publication de test pour l’API de lecture.", now=NOW,
        )
        return root, published, dataset_id, str(result["snapshot_id"])


class AdminApiTests(ApiTestSupport):
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


class PublicReadApiTests(ApiTestSupport):
    def serve(self, root: Path, published: Path) -> tuple["Any", str, threading.Thread]:
        server = create_server(root, "127.0.0.1", 0, published_root=published, quiet=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, f"http://127.0.0.1:{server.server_address[1]}", thread

    def test_public_routes_serve_the_published_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, published, dataset_id, snapshot_id = self.publish_feed(directory)
            server, base_url, thread = self.serve(root, published)
            try:
                status, network, _ = self.get(base_url, "/api/network")
                self.assertEqual(status, 200)
                self.assertTrue(network["available"])
                self.assertEqual(network["publication_status"], "PUBLISHED")
                self.assertEqual(network["snapshot"]["snapshot_id"], snapshot_id)
                self.assertFalse(network["realtime"])

                status, search, _ = self.get(base_url, "/api/stops/search?q=routiere")
                self.assertEqual(status, 200)
                self.assertEqual([stop["stop_name"] for stop in search["results"]], ["Gare Routière Leclerc"])
                self.assertEqual(search["snapshot_id"], snapshot_id)

                status, empty, _ = self.get(base_url, "/api/stops/search?q=zzz-inconnu")
                self.assertEqual(status, 200)
                self.assertEqual(empty["results"], [])

                status, nearby, _ = self.get(base_url, "/api/stops/near?lat=14.7051&lon=-17.4602&radius=1000")
                self.assertEqual(status, 200)
                self.assertEqual(nearby["results"][0]["stop_name"], "Gare Routière Leclerc")
                self.assertLessEqual(nearby["results"][0]["distance_m"], 100)

                status, stop, _ = self.get(base_url, "/api/stops/S1")
                self.assertEqual(status, 200)
                self.assertEqual(stop["stop"]["stop_name"], "Place de la Nation")
                self.assertEqual(stop["stop"]["routes"][0]["route_short_name"], "1")
                self.assertIn("temps réel", stop["stop"]["scheduled_time_window"]["note"])

                status, missing_stop, _ = self.get(base_url, "/api/stops/S-INCONNU")
                self.assertEqual(status, 404)
                self.assertEqual(missing_stop["error"], "NOT_FOUND")

                status, routes, _ = self.get(base_url, "/api/routes")
                self.assertEqual(status, 200)
                self.assertEqual(routes["count"], 2)

                status, route, _ = self.get(base_url, "/api/routes/R1")
                self.assertEqual(status, 200)
                self.assertEqual(route["route"]["trip_count"], 2)
                self.assertFalse(route["route"]["realtime"])

                status, publications, _ = self.get(base_url, "/api/publications")
                self.assertEqual(status, 200)
                self.assertEqual(publications["entry_count"], 1)
                self.assertEqual(publications["active"]["snapshot_id"], snapshot_id)

                status, pipeline, _ = self.get(base_url, "/api/pipeline")
                self.assertEqual(status, 200)
                self.assertEqual(pipeline["counts"]["published"], 1)
                self.assertEqual(pipeline["publication_status"], "PUBLISHED")
                self.assertEqual(pipeline["active_snapshot_id"], snapshot_id)

                status, refused, _ = self.get(base_url, "/api/stops/search?q=nation", method="POST")
                self.assertEqual(status, 405)
                self.assertEqual(refused["error"], "READ_ONLY_API")

                status, traversal, _ = self.get(base_url, "/api/stops/..%2F..%2Fetc")
                self.assertEqual(status, 404)

                status, dataset, _ = self.get(base_url, f"/api/datasets/{dataset_id}")
                self.assertEqual(status, 200)
                self.assertEqual(dataset["review_status"], "APPROVED")

                # The staging manifest never leaves NOT_PUBLISHED; the journal does.
                status, catalog, _ = self.get(base_url, "/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(catalog["datasets"][0]["publication_status"], "PUBLISHED")
                self.assertEqual(catalog["datasets"][0]["publication_snapshot_id"], snapshot_id)
                self.assertEqual(catalog["active_snapshot_id"], snapshot_id)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_public_routes_stay_honest_without_a_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.stage_feed(directory)
            published = Path(directory) / "published"
            server, base_url, thread = self.serve(root, published)
            try:
                status, network, _ = self.get(base_url, "/api/network")
                self.assertEqual(status, 200)
                self.assertFalse(network["available"])
                self.assertEqual(network["publication_status"], "NOT_PUBLISHED")
                self.assertIsNone(network["snapshot"])
                self.assertIn("Aucun jeu de données n’est publié", network["message"])

                for path in ("/api/stops/search?q=nation", "/api/stops/S1", "/api/routes", "/api/routes/R1"):
                    status, payload, _ = self.get(base_url, path)
                    self.assertEqual(status, 404, path)
                    self.assertEqual(payload["error"], "NOT_PUBLISHED", path)

                status, missing_query, _ = self.get(base_url, "/api/stops/search")
                self.assertEqual(status, 400)
                self.assertEqual(missing_query["error"], "INVALID_QUERY")

                status, bad_position, _ = self.get(base_url, "/api/stops/near?lat=200&lon=0")
                self.assertEqual(status, 400)
                self.assertEqual(bad_position["error"], "INVALID_QUERY")

                status, bad_limit, _ = self.get(base_url, "/api/stops/search?q=nation&limit=0")
                self.assertEqual(status, 400)
                self.assertEqual(bad_limit["error"], "INVALID_QUERY")

                status, publications, _ = self.get(base_url, "/api/publications")
                self.assertEqual(status, 200)
                self.assertEqual(publications["entry_count"], 0)
                self.assertEqual(publications["snapshots"], [])

                status, catalog, _ = self.get(base_url, "/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(catalog["datasets"][0]["publication_status"], "NOT_PUBLISHED")
                self.assertIsNone(catalog["datasets"][0]["publication_snapshot_id"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_public_routes_stop_serving_after_a_revert(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, published, _, snapshot_id = self.publish_feed(directory)
            revert_publication(
                published, publisher_id="awa.diop", reason="Période de validité contestée par la source.", now=NOW,
            )
            server, base_url, thread = self.serve(root, published)
            try:
                status, network, _ = self.get(base_url, "/api/network")
                self.assertEqual(status, 200)
                self.assertFalse(network["available"])
                self.assertEqual(network["publication_status"], "NOT_PUBLISHED")

                status, stop, _ = self.get(base_url, "/api/stops/S1")
                self.assertEqual(status, 404)
                self.assertEqual(stop["error"], "NOT_PUBLISHED")

                status, publications, _ = self.get(base_url, "/api/publications")
                self.assertEqual(status, 200)
                self.assertEqual(publications["snapshots"][0]["snapshot_id"], snapshot_id)
                self.assertEqual(publications["snapshots"][0]["publication_status"], "REVOKED")

                status, pipeline, _ = self.get(base_url, "/api/pipeline")
                self.assertEqual(status, 200)
                self.assertEqual(pipeline["counts"]["published"], 0)
                self.assertEqual(pipeline["counts"]["snapshots"], 1)

                status, catalog, _ = self.get(base_url, "/api/catalog")
                self.assertEqual(status, 200)
                self.assertEqual(catalog["datasets"][0]["publication_status"], "REVOKED")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
