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

from scripts.actor_registry import create_actor, revoke_actor
from scripts.publish_gtfs import publish_dataset, revert_publication
from scripts.review_gtfs import approve_dataset
from scripts.serve_admin_api import CSRF_HEADER, catalog_payload, create_server, pipeline_summary
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_publish_gtfs import PUBLISH_TABLES
from test_stage_gtfs import NOW, VALID_METADATA, VALID_TABLES

from auth_helpers import TEST_SECRET, proof

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

    def call(
        self,
        base_url: str,
        path: str,
        *,
        method: str = "GET",
        body: dict[str, Any] | None = None,
        cookie: str | None = None,
        csrf: str | None = None,
        origin: str | None = None,
    ) -> tuple[int, dict[str, Any], Any]:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(base_url + path, data=data, method=method)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if cookie:
            request.add_header("Cookie", cookie)
        if csrf:
            request.add_header(CSRF_HEADER, csrf)
        if origin:
            request.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310 - fixed http URL
                raw = response.read().decode("utf-8")
                return response.status, json.loads(raw) if raw else {}, response
        except urllib.error.HTTPError as error:
            try:
                raw = error.read().decode("utf-8")
            finally:
                error.close()
            return error.code, json.loads(raw) if raw else {}, error

    def get(self, base_url: str, path: str, method: str = "GET") -> tuple[int, dict[str, Any], HTTPResponse]:
        return self.call(base_url, path, method=method)

    def open_session(self, base_url: str, actor_id: str, secret: str = TEST_SECRET) -> tuple[str, str]:
        """Log in from the console: returns (cookie, csrf token), as the browser keeps them."""
        status, payload, response = self.call(
            base_url, "/api/session", method="POST", body={"actor_id": actor_id, "secret": secret}
        )
        self.assertEqual(status, 200, payload)
        cookie = str(response.headers["Set-Cookie"]).split(";")[0]
        return cookie, str(payload["csrf_token"])

    def publish_feed(self, directory: str, version: str = "api-v1") -> tuple[Path, Path, str, str]:
        # The published fixture needs named stops and routes to search for.
        root, dataset_id = self.stage_feed(directory, version, tables=PUBLISH_TABLES)
        approve_dataset(root, dataset_id, proof=proof("fatou.ndiaye", "reviewer"), attestations=FULL_ATTESTATIONS, now=NOW)
        published = Path(directory) / "published"
        result = publish_dataset(
            root, published, dataset_id,
            proof=proof("ousmane.fall", "publisher"), note="Publication de test pour l’API de lecture.", now=NOW,
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

            approve_dataset(root, dataset_id, proof=proof("fatou.ndiaye", "reviewer"), attestations=FULL_ATTESTATIONS, now=NOW)
            approved = pipeline_summary(root, now=NOW)
            self.assertEqual(approved["counts"]["approved"], 1)
            self.assertEqual(approved["counts"]["pending_review"], 0)
            self.assertEqual(approved["counts"]["published"], 0)

            catalog = catalog_payload(root, now=NOW)
            self.assertEqual(len(catalog["datasets"]), 1)
            self.assertEqual(catalog["datasets"][0]["review_status"], "APPROVED")

    def test_server_serves_catalog_and_refuses_strange_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            server = create_server(root, "127.0.0.1", 0, quiet=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            try:
                status, health, _ = self.get(base_url, "/healthz")
                self.assertEqual(status, 200)
                self.assertEqual(health["mode"], "governance-console")
                self.assertTrue(health["read_only_public_data"])

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
                published, proof=proof("awa.diop", "publisher"), reason="Période de validité contestée par la source.", now=NOW,
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


class ConsoleSessionTests(ApiTestSupport):
    """The console decides with a local account, a session cookie and a CSRF token."""

    def serve(self, root: Path, published: Path, actors_root: Path) -> tuple[Any, str, threading.Thread]:
        server = create_server(
            root, "127.0.0.1", 0, published_root=published, actors_root=actors_root, quiet=True
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, f"http://127.0.0.1:{server.server_address[1]}", thread

    def accounts(self, directory: str) -> Path:
        """Two named accounts in one temporary registry: one reviewer, one publisher."""
        actors_root = Path(directory) / "actors"
        create_actor(
            "fatou.ndiaye", display_name="Fatou Ndiaye", role="reviewer",
            secret=TEST_SECRET, created_by="awa.mainteneur", root=actors_root,
        )
        create_actor(
            "ousmane.fall", display_name="Ousmane Fall", role="publisher",
            secret=TEST_SECRET, created_by="awa.mainteneur", root=actors_root,
        )
        return actors_root

    def test_login_opens_a_session_and_never_echoes_the_secret(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            server, base_url, thread = self.serve(root, Path(directory) / "published", actors_root)
            try:
                status, anonymous, _ = self.get(base_url, "/api/session")
                self.assertEqual(status, 200)
                self.assertFalse(anonymous["authenticated"])
                self.assertIsNone(anonymous["csrf_token"])

                status, incomplete, _ = self.call(base_url, "/api/session", method="POST", body={"actor_id": "fatou.ndiaye"})
                self.assertEqual(status, 400)
                self.assertEqual(incomplete["error"], "INVALID_REQUEST")

                status, wrong, _ = self.call(
                    base_url, "/api/session", method="POST", body={"actor_id": "fatou.ndiaye", "secret": "mauvais-secret-1234"}
                )
                self.assertEqual(status, 401)
                self.assertEqual(wrong["error"], "AUTHENTICATION_FAILED")
                self.assertNotIn("mauvais-secret-1234", json.dumps(wrong))

                status, unknown, _ = self.call(
                    base_url, "/api/session", method="POST", body={"actor_id": "inconnu.acteur", "secret": TEST_SECRET}
                )
                self.assertEqual(status, 401)
                self.assertEqual(unknown["error"], "AUTHENTICATION_FAILED")

                cookie, csrf = self.open_session(base_url, "fatou.ndiaye")
                self.assertTrue(cookie.startswith("dakar_session="))
                self.assertNotIn(TEST_SECRET, cookie)

                status, opened, response = self.call(
                    base_url, "/api/session", method="POST", body={"actor_id": "fatou.ndiaye", "secret": TEST_SECRET}
                )
                self.assertEqual(status, 200)
                header = str(response.headers["Set-Cookie"])
                self.assertIn("HttpOnly", header)
                self.assertIn("SameSite=Strict", header)
                self.assertIn("Path=/api", header)
                self.assertIn("Max-Age=", header)
                self.assertEqual(opened["session"]["role"], "reviewer")
                self.assertEqual(opened["session"]["display_name"], "Fatou Ndiaye")
                self.assertEqual(opened["method"], "console-session")
                self.assertNotIn(TEST_SECRET, json.dumps(opened))

                status, me, _ = self.call(base_url, "/api/session", cookie=cookie)
                self.assertEqual(status, 200)
                self.assertTrue(me["authenticated"])
                self.assertEqual(me["actor"]["actor_id"], "fatou.ndiaye")
                self.assertEqual(me["csrf_token"], csrf)

                # The account list is only served to a session, without any secret material.
                status, refused_actors, _ = self.call(base_url, "/api/actors")
                self.assertEqual(status, 401)
                self.assertEqual(refused_actors["error"], "AUTHENTICATION_REQUIRED")
                status, actors, _ = self.call(base_url, "/api/actors", cookie=cookie)
                self.assertEqual(status, 200)
                self.assertEqual(actors["active"], 2)
                self.assertNotIn(TEST_SECRET, json.dumps(actors))
                self.assertNotIn("secret", json.dumps(actors["accounts"]))

                status, closed, response = self.call(base_url, "/api/session", method="DELETE", cookie=cookie, csrf=csrf)
                self.assertEqual(status, 200)
                self.assertFalse(closed["authenticated"])
                self.assertIn("Max-Age=0", str(response.headers["Set-Cookie"]))
                status, after, _ = self.call(base_url, "/api/session", cookie=cookie)
                self.assertEqual(after["authenticated"], False)
                status, gone, _ = self.call(base_url, "/api/datasets/%s/decision" % dataset_id, method="POST", body={"decision": "approve"}, cookie=cookie, csrf=csrf)
                self.assertEqual(status, 401)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_bytes_the_lockout_after_repeated_failures(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            server, base_url, thread = self.serve(root, Path(directory) / "published", actors_root)
            try:
                for attempt in range(8):
                    status, payload, _ = self.call(
                        base_url, "/api/session", method="POST",
                        body={"actor_id": "fatou.ndiaye", "secret": "mauvais-secret-%04d" % attempt},
                    )
                    self.assertEqual(status, 401, payload)
                status, blocked, _ = self.call(
                    base_url, "/api/session", method="POST", body={"actor_id": "fatou.ndiaye", "secret": TEST_SECRET}
                )
                self.assertEqual(status, 429)
                self.assertEqual(blocked["error"], "TOO_MANY_ATTEMPTS")
                # Another account is not punished for it.
                cookie, _ = self.open_session(base_url, "ousmane.fall")
                self.assertTrue(cookie.startswith("dakar_session="))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_a_write_needs_a_session_a_csrf_token_and_the_right_role(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            server, base_url, thread = self.serve(root, Path(directory) / "published", actors_root)
            action = f"/api/datasets/{dataset_id}/decision"
            attestations = {item: dict(value) for item, value in FULL_ATTESTATIONS.items()}
            try:
                status, anonymous, _ = self.call(base_url, action, method="POST", body={"decision": "approve"})
                self.assertEqual(status, 401)
                self.assertEqual(anonymous["error"], "AUTHENTICATION_REQUIRED")
                self.assertTrue(anonymous["blockers"])

                reviewer_cookie, reviewer_csrf = self.open_session(base_url, "fatou.ndiaye")
                publisher_cookie, publisher_csrf = self.open_session(base_url, "ousmane.fall")

                status, no_token, _ = self.call(
                    base_url, action, method="POST", body={"decision": "approve"}, cookie=reviewer_cookie
                )
                self.assertEqual(status, 403)
                self.assertEqual(no_token["error"], "CSRF_REQUIRED")

                status, bad_token, _ = self.call(
                    base_url, action, method="POST", body={"decision": "approve"}, cookie=reviewer_cookie, csrf="faux"
                )
                self.assertEqual(status, 403)
                self.assertEqual(bad_token["error"], "CSRF_INVALID")

                status, foreign, _ = self.call(
                    base_url, action, method="POST", body={"decision": "approve"},
                    cookie=reviewer_cookie, csrf=reviewer_csrf, origin="https://exemple-malveillant.invalid",
                )
                self.assertEqual(status, 403)
                self.assertEqual(foreign["error"], "CROSS_ORIGIN_REFUSED")

                # A publisher cannot approve, and a reviewer cannot publish.
                status, wrong_role, _ = self.call(
                    base_url, action, method="POST", body={"decision": "approve"},
                    cookie=publisher_cookie, csrf=publisher_csrf,
                )
                self.assertEqual(status, 403)
                self.assertEqual(wrong_role["error"], "ROLE_FORBIDDEN")
                status, wrong_role_again, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/publication", method="POST",
                    body={"note": "Publication tentée par la mauvaise personne."},
                    cookie=reviewer_cookie, csrf=reviewer_csrf,
                )
                self.assertEqual(status, 403)
                self.assertEqual(wrong_role_again["error"], "ROLE_FORBIDDEN")

                # Read-only routes stay untouched: they answer 405, with the way forward.
                for path, method in (("/api/pipeline", "POST"), ("/api/catalog", "POST"), ("/api/stops/search?q=place", "POST"), ("/api/pipeline", "PUT")):
                    status, refused, _ = self.call(base_url, path, method=method, cookie=reviewer_cookie, csrf=reviewer_csrf)
                    self.assertEqual(status, 405, path)
                    self.assertEqual(refused["error"], "READ_ONLY_API")

                # The origin header of the console itself is accepted.
                status, approved, _ = self.call(
                    base_url, action, method="POST",
                    body={"decision": "approve", "attestations": attestations, "note": "Dossier complet vérifié le 8 octobre."},
                    cookie=reviewer_cookie, csrf=reviewer_csrf, origin=base_url,
                )
                self.assertEqual(status, 200, approved)
                self.assertEqual(approved["review_status"], "APPROVED")
                self.assertEqual(approved["action"], "APPROVE")
                self.assertEqual(approved["authentication"]["actor_id"], "fatou.ndiaye")
                self.assertEqual(approved["authentication"]["method"], "console-session")
                self.assertEqual(approved["entry"]["authentication"]["method"], "console-session")
                self.assertEqual(approved["decided_by"], "fatou.ndiaye")
                self.assertEqual(approved["publication_status"], "NOT_PUBLISHED")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_attestations_and_rejections_are_explained_not_invented(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            server, base_url, thread = self.serve(root, Path(directory) / "published", actors_root)
            action = f"/api/datasets/{dataset_id}/decision"
            try:
                cookie, csrf = self.open_session(base_url, "fatou.ndiaye")

                # No attestation at all: the publication gate stays closed, and says why.
                status, blocked, _ = self.call(
                    base_url, action, method="POST", body={"decision": "approve"}, cookie=cookie, csrf=csrf
                )
                self.assertEqual(status, 409)
                self.assertEqual(blocked["error"], "APPROVAL_BLOCKED")
                self.assertEqual(len(blocked["blockers"]), len(FULL_ATTESTATIONS))
                self.assertTrue(any("source_identity" in blocker for blocker in blocked["blockers"]))

                status, unknown, _ = self.call(
                    base_url, action, method="POST",
                    body={"decision": "approve", "attestations": {"attestation_inventee": {"evidence": "Rien."}}},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 422)
                self.assertEqual(unknown["error"], "ATTESTATION_UNKNOWN")

                status, empty_evidence, _ = self.call(
                    base_url, action, method="POST",
                    body={"decision": "approve", "attestations": {"source_identity": {"evidence": "   "}}},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 400)

                status, bad_decision, _ = self.call(
                    base_url, action, method="POST", body={"decision": "peut-être"}, cookie=cookie, csrf=csrf
                )
                self.assertEqual(status, 400)

                # A refusal needs a motive, and it is recorded with the session's actor.
                status, too_short, _ = self.call(
                    base_url, action, method="POST", body={"decision": "reject", "reason": "non"}, cookie=cookie, csrf=csrf
                )
                self.assertEqual(status, 400)

                status, rejected, _ = self.call(
                    base_url, action, method="POST",
                    body={"decision": "reject", "reason": "Source non identifiée auprès de l’éditeur du flux."},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 200)
                self.assertEqual(rejected["review_status"], "REJECTED")
                self.assertEqual(rejected["action"], "REJECT")
                self.assertEqual(rejected["reviewer_id"], "fatou.ndiaye")
                self.assertEqual(rejected["entry"]["authentication"]["actor_id"], "fatou.ndiaye")
                self.assertEqual(rejected["entry"]["authentication"]["method"], "console-session")

                # A refusal is active: the journal says so, and the way forward is a traced revert.
                status, conflict, _ = self.call(
                    base_url, action, method="POST",
                    body={"decision": "approve", "attestations": {item: dict(value) for item, value in FULL_ATTESTATIONS.items()}},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 409, conflict)
                self.assertEqual(conflict["error"], "APPROVAL_BLOCKED")
                self.assertTrue(any("refus" in blocker for blocker in conflict["blockers"]))

                # The reversal is traced, then the version can be approved again.
                entry_id = rejected["entry"]["entry_id"]
                status, reverted, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/revert", method="POST",
                    body={"entry_id": entry_id, "reason": "Motif de refus erroné, source confirmée ensuite."},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 200, reverted)
                self.assertEqual(reverted["review_status"], "PENDING_REVIEW")
                self.assertEqual(reverted["action"], "REVERT_DECISION")

                status, unknown_entry, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/revert", method="POST",
                    body={"entry_id": "rv-000009", "reason": "Décision inexistante dans le journal."},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 409)
                self.assertEqual(unknown_entry["error"], "NO_ACTIVE_DECISION")

                status, missing, _ = self.call(
                    base_url, "/api/datasets/version-inexistante/decision", method="POST",
                    body={"decision": "approve", "attestations": {item: dict(value) for item, value in FULL_ATTESTATIONS.items()}},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 404)
                self.assertEqual(missing["error"], "NOT_FOUND")
                self.assertIn("Version inconnue", missing["message"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_a_revoked_account_loses_its_session_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            server, base_url, thread = self.serve(root, Path(directory) / "published", actors_root)
            try:
                cookie, csrf = self.open_session(base_url, "fatou.ndiaye")
                revoke_actor(
                    "fatou.ndiaye", revoked_by="awa.mainteneur",
                    reason="Compte remplacé après un soupçon de fuite du secret.", root=actors_root,
                )
                status, revoked, _ = self.call(base_url, "/api/session", cookie=cookie)
                self.assertEqual(status, 403)
                self.assertEqual(revoked["error"], "ACTOR_REVOKED")

                status, closed, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/decision", method="POST",
                    body={"decision": "approve"}, cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 401)
                self.assertEqual(closed["error"], "AUTHENTICATION_REQUIRED")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_the_console_approval_is_the_same_journal_entry_as_the_CLI(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root, dataset_id = self.stage_feed(directory)
            actors_root = self.accounts(directory)
            published = Path(directory) / "published"
            server, base_url, thread = self.serve(root, published, actors_root)
            try:
                cookie, csrf = self.open_session(base_url, "fatou.ndiaye")
                status, approved, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/decision", method="POST",
                    body={
                        "decision": "approve",
                        "attestations": {item: dict(value) for item, value in FULL_ATTESTATIONS.items()},
                    },
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 200, approved)
                journal_entry = approved["entry"]

                # The same version is then published from the command line, with a
                # publisher token: the separation of duties is enforced by the same code.
                status, published_result, _ = self.call(
                    base_url, f"/api/datasets/{dataset_id}/publication", method="POST",
                    body={"note": "Publication après approbation de la console."},
                    cookie=None, csrf=None,
                )
                self.assertEqual(status, 401)

                published_payload = publish_dataset(
                    root, published, dataset_id, proof=proof("ousmane.fall", "publisher"),
                    note="Publication après approbation de la console.", now=NOW,
                )
                self.assertTrue(published_payload["separation_of_duties"])
                self.assertNotEqual(journal_entry["authentication"]["actor_id"], "ousmane.fall")
                self.assertEqual(published_payload["journal_entry"]["authentication"]["actor_id"], "ousmane.fall")

                # And the console can take the publication back, with the publisher session.
                publisher_cookie, publisher_csrf = self.open_session(base_url, "ousmane.fall")
                status, reverted, _ = self.call(
                    base_url, "/api/publication/revert", method="POST",
                    body={"reason": "Période de validité contestée par la source du flux."},
                    cookie=publisher_cookie, csrf=publisher_csrf,
                )
                self.assertEqual(status, 200, reverted)
                self.assertEqual(reverted["publication_status"], "NOT_PUBLISHED")
                self.assertEqual(reverted["action"], "REVERT_PUBLICATION")
                self.assertEqual(reverted["authentication"]["actor_id"], "ousmane.fall")

                # A reviewer session cannot undo a publication.
                status, wrong_role, _ = self.call(
                    base_url, "/api/publication/revert", method="POST",
                    body={"reason": "Retour arrière tenté par la mauvaise personne."},
                    cookie=cookie, csrf=csrf,
                )
                self.assertEqual(status, 403)
                self.assertEqual(wrong_role["error"], "ROLE_FORBIDDEN")
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
