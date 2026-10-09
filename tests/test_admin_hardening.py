"""Garde-fous de sécurité de l'API : Host, types de contenu, origines, cookies,
secrets trop longs, décodage des identifiants publics et registre de sessions."""

from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.actor_registry import SessionStore
from scripts.serve_admin_api import (
    MAX_SECRET_CHARS,
    CSRF_HEADER,
    cleared_session_cookie,
    create_server,
    host_allowed,
    session_cookie,
)
from scripts.serve_read_api import ApiError, resolve_public_route

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)


class HostAllowlistTests(unittest.TestCase):
    def test_only_loopback_and_declared_hosts_are_accepted(self) -> None:
        self.assertTrue(host_allowed("127.0.0.1:8787"))
        self.assertTrue(host_allowed("localhost"))
        self.assertTrue(host_allowed("[::1]:8787"))
        self.assertFalse(host_allowed("evil.example"))
        self.assertFalse(host_allowed("evil.example:8787"))
        self.assertFalse(host_allowed(""))
        self.assertFalse(host_allowed(None))

    def test_declared_host_is_accepted_without_its_port(self) -> None:
        self.assertTrue(host_allowed("console.test:9000", ["Console.Test"]))
        self.assertFalse(host_allowed("autre.test", ["console.test"]))


class SessionCookieTests(unittest.TestCase):
    def test_cookie_is_secure_only_when_requested(self) -> None:
        session = SessionStore().open("fatou.ndiaye", "reviewer", now=NOW)
        plain = session_cookie(session, ttl_seconds=600)
        secure = session_cookie(session, ttl_seconds=600, secure=True)
        for cookie in (plain, secure):
            self.assertIn("HttpOnly", cookie)
            self.assertIn("SameSite=Strict", cookie)
            self.assertIn("Path=/api", cookie)
        self.assertNotIn("Secure", plain)
        self.assertTrue(secure.endswith("; Secure"))
        self.assertTrue(cleared_session_cookie(secure=True).endswith("; Secure"))
        self.assertIn("Max-Age=0", cleared_session_cookie())


class SessionStoreTests(unittest.TestCase):
    def test_failures_are_pruned_once_outside_the_window(self) -> None:
        store = SessionStore()
        for index in range(50):
            store.register_failure(f"inconnu-{index}", now=NOW)
        later = NOW + timedelta(seconds=SessionStore.FAILURE_WINDOW_SECONDS + 1)
        store.register_failure("autre.acteur", now=later)
        self.assertEqual(set(store._failures), {"autre.acteur"})
        self.assertEqual(store.failures("inconnu-3", now=later), 0)

    def test_concurrent_sessions_are_all_recorded(self) -> None:
        store = SessionStore()
        threads = [threading.Thread(target=store.open, args=(f"acteur-{i}", "reviewer"), kwargs={"now": NOW}) for i in range(40)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(store.count(), 40)


class PublicIdentifierTests(unittest.TestCase):
    def test_encoded_separators_are_refused_after_decoding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for encoded in ("%2F..%2Fsecret", "a%5Cb", "%2e%2e%2F", "x%0ay"):
                route = resolve_public_route(f"/api/stops/{encoded}", "", Path(directory))
                self.assertIsNotNone(route)
                with self.assertRaises(ApiError) as caught:
                    route()  # type: ignore[misc]
                self.assertEqual(caught.exception.status, 404, encoded)


class AdminHttpHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name) / "staging"
        self.server = create_server(self.root, "127.0.0.1", 0, quiet=True)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self._directory.cleanup()

    def request(self, method: str, path: str, *, headers: dict[str, str] | None = None, body: bytes | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw
        finally:
            connection.close()

    def test_foreign_host_header_is_refused_before_any_route(self) -> None:
        status, _, raw = self.request("GET", "/healthz", headers={"Host": "rebinding.example"})
        self.assertEqual(status, 421)
        self.assertEqual(json.loads(raw)["error"], "HOST_REFUSED")

    def test_loopback_host_header_is_served(self) -> None:
        status, _, raw = self.request("GET", "/healthz", headers={"Host": f"localhost:{self.port}"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["status"], "ok")

    def test_health_check_publishes_folder_names_not_absolute_paths(self) -> None:
        _, _, raw = self.request("GET", "/healthz")
        body = raw.decode("utf-8")
        self.assertIn('"governance_root": "staging"', body)
        self.assertNotIn(str(self.root), body)

    def test_api_responses_forbid_framing_and_loading_resources(self) -> None:
        _, headers, _ = self.request("GET", "/healthz")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertIn("frame-ancestors 'none'", headers.get("Content-Security-Policy", ""))

    def test_body_must_be_json(self) -> None:
        status, _, raw = self.request(
            "POST",
            "/api/session",
            headers={"Content-Type": "text/plain", "Content-Length": "16"},
            body=b'{"actor_id":"a"}',
        )
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(raw)["error"], "UNSUPPORTED_MEDIA_TYPE")

    def test_login_from_a_foreign_origin_is_refused(self) -> None:
        payload = json.dumps({"actor_id": "fatou.ndiaye", "secret": "x" * 12}).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/api/session",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(len(payload)),
                "Origin": "https://site-malveillant.invalid",
            },
            body=payload,
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(raw)["error"], "CROSS_ORIGIN_REFUSED")

    def test_oversized_secret_is_refused_before_hashing(self) -> None:
        payload = json.dumps({"actor_id": "fatou.ndiaye", "secret": "s" * (MAX_SECRET_CHARS + 1)}).encode("utf-8")
        status, _, raw = self.request(
            "POST",
            "/api/session",
            headers={"Content-Type": "application/json", "Content-Length": str(len(payload))},
            body=payload,
        )
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["error"], "INVALID_REQUEST")

    def test_csrf_header_name_is_unchanged(self) -> None:
        self.assertEqual(CSRF_HEADER, "X-Dakar-CSRF")


if __name__ == "__main__":
    unittest.main()
