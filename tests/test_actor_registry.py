from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scripts.actor_registry import (
    GENERIC_IDS,
    REGISTRY_FILENAME,
    SCRYPT_N,
    SESSION_COOKIE,
    ActorError,
    SessionStore,
    create_actor,
    issue_token,
    list_actors,
    read_registry,
    registry_summary,
    require_active_actor,
    revoke_actor,
    verify_secret,
    verify_token,
)
from test_stage_gtfs import NOW

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
SECRET = "secret-de-test-1234"
OTHER_SECRET = "autre-secret-5678"


class RegistryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self._temporary.cleanup)
        self.root = Path(self._temporary.name) / "actors"

    def reviewer(self, actor_id: str = "fatou.ndiaye", *, secret: str = SECRET, **overrides: object) -> dict:
        return create_actor(
            actor_id,
            display_name=overrides.pop("display_name", "Fatou Ndiaye"),
            role=overrides.pop("role", "reviewer"),
            secret=secret,
            created_by=overrides.pop("created_by", "awa.mainteneur"),
            root=self.root,
            **overrides,
        )


class AccountCreationTests(RegistryTestCase):
    def test_a_secret_is_only_ever_stored_as_a_scrypt_hash(self) -> None:
        created = self.reviewer()
        self.assertTrue(created["created"])
        self.assertEqual(created["actor_id"], "fatou.ndiaye")
        self.assertEqual(created["role"], "reviewer")
        self.assertNotIn(SECRET, json.dumps(created))

        raw = (self.root / REGISTRY_FILENAME).read_text(encoding="utf-8")
        self.assertNotIn(SECRET, raw)
        stored = json.loads(raw)["actors"][0]["secret"]
        self.assertEqual(stored["algorithm"], "scrypt")
        self.assertEqual(stored["n"], SCRYPT_N)
        self.assertGreaterEqual(len(stored["salt"]), 16)
        self.assertGreaterEqual(len(stored["hash"]), 32)

        # The registry and the signing key are private to the operator.
        self.assertEqual(stat.S_IMODE((self.root / REGISTRY_FILENAME).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)

    def test_two_accounts_never_share_a_salt_or_a_hash(self) -> None:
        self.reviewer("fatou.ndiaye")
        self.reviewer("ousmane.fall", role="publisher")
        actors = read_registry(self.root)["actors"]
        secrets = {(actor["secret"]["salt"], actor["secret"]["hash"]) for actor in actors}
        self.assertEqual(len(secrets), 2)

    def test_the_listing_never_carries_secret_material(self) -> None:
        self.reviewer()
        listing = list_actors(root=self.root)
        self.assertEqual(len(listing), 1)
        self.assertEqual(listing[0]["actor_id"], "fatou.ndiaye")
        self.assertNotIn("secret", json.dumps(listing))
        self.assertNotIn(SECRET, json.dumps(listing))

    def test_generic_invalid_and_weak_accounts_are_refused(self) -> None:
        for generic in sorted(GENERIC_IDS):
            with self.assertRaises(ActorError) as refused:
                self.reviewer(generic)
            # Short generic names fail the shape check first; both refusals are honest.
            self.assertIn(refused.exception.code, {"GENERIC_ACTOR_ID", "INVALID_ACTOR_ID"}, generic)
        for named in ("admin", "anonymous", "system", "utilisateur", "demo"):
            with self.assertRaises(ActorError) as refused:
                self.reviewer(named)
            self.assertEqual(refused.exception.code, "GENERIC_ACTOR_ID", named)
        for invalid in ("ab", "fatou ndiaye", "fatou@ndiaye", "fatou/ndiaye", "-fatou", "fatou" + "n" * 40):
            with self.assertRaises(ActorError) as refused:
                self.reviewer(invalid)
            self.assertEqual(refused.exception.code, "INVALID_ACTOR_ID", invalid)
        with self.assertRaises(ActorError) as weak:
            self.reviewer("fatou.ndiaye", secret="court")
        self.assertEqual(weak.exception.code, "WEAK_SECRET")
        with self.assertRaises(ActorError) as unknown_role:
            self.reviewer("fatou.ndiaye", role="correcteur")
        self.assertEqual(unknown_role.exception.code, "INVALID_ROLE")
        # No account exists yet: nothing was written by any of those refusals.
        self.assertFalse((self.root / REGISTRY_FILENAME).exists())

    def test_identifiers_are_case_insensitive_but_never_generic(self) -> None:
        created = create_actor(
            "Fatou.Ndiaye", display_name="Fatou Ndiaye", role="reviewer",
            secret=SECRET, created_by="awa.mainteneur", root=self.root,
        )
        self.assertEqual(created["actor_id"], "fatou.ndiaye")
        self.assertEqual(verify_secret("FATOU.NDIAYE", SECRET, root=self.root)["actor_id"], "fatou.ndiaye")

    def test_nobody_enrols_themselves_and_no_duplicate_is_accepted(self) -> None:
        with self.assertRaises(ActorError) as self_enrolment:
            self.reviewer("fatou.ndiaye", created_by="fatou.ndiaye")
        self.assertEqual(self_enrolment.exception.code, "SELF_ENROLMENT")
        self.reviewer()
        with self.assertRaises(ActorError) as duplicate:
            self.reviewer()
        self.assertEqual(duplicate.exception.code, "ACTOR_EXISTS")
        self.assertEqual(len(read_registry(self.root)["actors"]), 1)

    def test_two_writers_at_once_do_not_lose_an_account(self) -> None:
        errors: list[BaseException] = []
        start = threading.Barrier(4)

        def worker(index: int) -> None:
            start.wait()
            try:
                self.reviewer(f"acteur.{index}", display_name=f"Acteur {index}")
            except BaseException as error:  # noqa: BLE001 - reported below
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(index,)) for index in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(actor["actor_id"] for actor in list_actors(root=self.root)), [f"acteur.{index}" for index in range(4)])


class SecretVerificationTests(RegistryTestCase):
    def test_the_right_secret_authenticates_and_nothing_else_does(self) -> None:
        self.reviewer()
        actor = verify_secret("fatou.ndiaye", SECRET, root=self.root)
        self.assertEqual(actor["role"], "reviewer")

        for actor_id, secret in (("fatou.ndiaye", OTHER_SECRET), ("fatou.ndiaye", ""), ("inconnu.acteur", SECRET)):
            with self.assertRaises(ActorError) as refused:
                verify_secret(actor_id, secret, root=self.root)
            self.assertEqual(refused.exception.code, "AUTHENTICATION_FAILED")
            # Identical wording: the registry never says which half was wrong.
            self.assertEqual(refused.exception.message, "Identifiant ou secret incorrect.")

    def test_a_revoked_account_can_no_longer_authenticate(self) -> None:
        self.reviewer()
        revoke_actor(
            "fatou.ndiaye",
            revoked_by="awa.mainteneur",
            reason="Compte remplacé après un soupçon de fuite du secret.",
            root=self.root,
        )
        with self.assertRaises(ActorError) as refused:
            verify_secret("fatou.ndiaye", SECRET, root=self.root)
        self.assertEqual(refused.exception.code, "ACTOR_REVOKED")
        self.assertEqual(list_actors(root=self.root), [])
        self.assertEqual(len(list_actors(root=self.root, include_revoked=True)), 1)
        self.assertEqual(registry_summary(root=self.root)["active"], 0)

    def test_a_revocation_needs_another_actor_and_a_motive(self) -> None:
        self.reviewer()
        with self.assertRaises(ActorError) as short_reason:
            revoke_actor("fatou.ndiaye", revoked_by="awa.mainteneur", reason="trop court", root=self.root)
        self.assertEqual(short_reason.exception.code, "INVALID_FIELD")
        with self.assertRaises(ActorError) as self_revocation:
            revoke_actor(
                "fatou.ndiaye",
                revoked_by="fatou.ndiaye",
                reason="Je préfère effacer mes traces complètement.",
                root=self.root,
            )
        self.assertEqual(self_revocation.exception.code, "SELF_REVOCATION")
        with self.assertRaises(ActorError) as unknown:
            revoke_actor(
                "inconnu.acteur", revoked_by="awa.mainteneur", reason="Compte inconnu du registre local.", root=self.root
            )
        self.assertEqual(unknown.exception.code, "ACTOR_UNKNOWN")
        # The account is untouched by all three refusals.
        self.assertEqual(verify_secret("fatou.ndiaye", SECRET, root=self.root)["role"], "reviewer")

    def test_only_an_active_actor_may_keep_acting(self) -> None:
        self.reviewer()
        self.assertEqual(require_active_actor("fatou.ndiaye", role="reviewer", root=self.root)["role"], "reviewer")
        with self.assertRaises(ActorError) as changed:
            require_active_actor("fatou.ndiaye", role="publisher", root=self.root)
        self.assertEqual(changed.exception.code, "ROLE_CHANGED")
        revoke_actor(
            "fatou.ndiaye", revoked_by="awa.mainteneur", reason="Compte compromis, remplacé par un nouveau.", root=self.root
        )
        with self.assertRaises(ActorError) as revoked:
            require_active_actor("fatou.ndiaye", root=self.root)
        self.assertEqual(revoked.exception.code, "ACTOR_REVOKED")


class TokenTests(RegistryTestCase):
    def test_a_token_names_its_actor_its_role_and_its_expiry(self) -> None:
        self.reviewer()
        issued = issue_token("fatou.ndiaye", SECRET, role="reviewer", ttl_seconds=3600, root=self.root, now=NOW)
        self.assertTrue(issued["token"].startswith("dkr1."))
        self.assertNotIn(SECRET, json.dumps(issued))
        proof = verify_token(issued["token"], required_role="reviewer", root=self.root, now=NOW)
        self.assertEqual(proof.actor_id, "fatou.ndiaye")
        self.assertEqual(proof.role, "reviewer")
        self.assertEqual(proof.method, "cli-token")
        self.assertEqual(proof.as_proof()["realtime"], False)

        # The signing key is private to the operator.
        self.assertEqual(stat.S_IMODE((self.root / "server.key").stat().st_mode), 0o600)

    def test_tokens_expire_and_cannot_be_forged_or_promoted(self) -> None:
        self.reviewer()
        issued = issue_token("fatou.ndiaye", SECRET, ttl_seconds=3600, root=self.root, now=NOW)
        later = NOW + timedelta(seconds=3601)
        with self.assertRaises(ActorError) as expired:
            verify_token(issued["token"], root=self.root, now=later)
        self.assertEqual(expired.exception.code, "TOKEN_EXPIRED")

        with self.assertRaises(ActorError) as forged:
            verify_token("dkr1.cHV0ZS5kZWNvZGUK.signature-inventee", root=self.root, now=NOW)
        self.assertEqual(forged.exception.code, "TOKEN_INVALID")

        with self.assertRaises(ActorError) as empty:
            verify_token("", root=self.root, now=NOW)
        self.assertEqual(empty.exception.code, "TOKEN_REQUIRED")

        with self.assertRaises(ActorError) as wrong_role:
            verify_token(issued["token"], required_role="publisher", root=self.root, now=NOW)
        self.assertEqual(wrong_role.exception.code, "ROLE_FORBIDDEN")

    def test_a_role_cannot_be_chosen_by_the_token_holder(self) -> None:
        self.reviewer()
        with self.assertRaises(ActorError) as mismatch:
            issue_token("fatou.ndiaye", SECRET, role="publisher", root=self.root, now=NOW)
        self.assertEqual(mismatch.exception.code, "ROLE_MISMATCH")

    def test_a_revoked_account_invalidates_the_tokens_already_issued(self) -> None:
        self.reviewer()
        issued = issue_token("fatou.ndiaye", SECRET, root=self.root, now=NOW)
        revoke_actor(
            "fatou.ndiaye", revoked_by="awa.mainteneur", reason="Départ de la personne, compte clos.", root=self.root
        )
        with self.assertRaises(ActorError) as revoked:
            verify_token(issued["token"], root=self.root, now=NOW)
        self.assertEqual(revoked.exception.code, "ACTOR_REVOKED")

    def test_a_token_from_another_registry_is_refused(self) -> None:
        self.reviewer()
        issued = issue_token("fatou.ndiaye", SECRET, root=self.root, now=NOW)
        with tempfile.TemporaryDirectory() as directory:
            other_root = Path(directory) / "actors"
            create_actor(
                "fatou.ndiaye", display_name="Fatou Ndiaye", role="reviewer",
                secret=SECRET, created_by="awa.mainteneur", root=other_root,
            )
            # The other registry has its own signing key, so the same actor id
            # with the same secret still cannot replay a token from elsewhere.
            issue_token("fatou.ndiaye", SECRET, root=other_root, now=NOW)
            with self.assertRaises(ActorError) as foreign:
                verify_token(issued["token"], root=other_root, now=NOW)
            self.assertEqual(foreign.exception.code, "TOKEN_INVALID")

    def test_a_token_needs_a_registry_key(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing_root = Path(directory) / "actors"
            with self.assertRaises(ActorError) as missing:
                verify_token("dkr1.cHV0ZS5kZWNvZGUK.c2lnbmF0dXJl", root=missing_root, now=NOW)
            self.assertEqual(missing.exception.code, "KEY_MISSING")


class SessionStoreTests(RegistryTestCase):
    def test_a_session_is_created_with_its_own_csrf_token_and_expires(self) -> None:
        store = SessionStore(ttl_seconds=600)
        session = store.open("fatou.ndiaye", "reviewer", now=NOW)
        self.assertTrue(session.csrf_token)
        self.assertNotEqual(store.open("fatou.ndiaye", "reviewer", now=NOW).csrf_token, session.csrf_token)
        self.assertEqual(store.get(session.session_id, now=NOW).actor_id, "fatou.ndiaye")
        self.assertEqual(session.as_authentication().method, "console-session")
        self.assertEqual(session.as_authentication().as_proof()["actor_id"], "fatou.ndiaye")

        self.assertIsNone(store.get(session.session_id, now=NOW + timedelta(seconds=601)))
        self.assertIsNone(store.get(None, now=NOW))
        self.assertIsNone(store.get("identifiant-inventé", now=NOW))

    def test_closing_a_session_stops_it_immediately(self) -> None:
        store = SessionStore()
        first = store.open("fatou.ndiaye", "reviewer", now=NOW)
        second = store.open("fatou.ndiaye", "reviewer", now=NOW)
        store.open("ousmane.fall", "publisher", now=NOW)
        self.assertEqual(store.count(), 3)
        self.assertTrue(store.close(first.session_id))
        self.assertFalse(store.close(first.session_id))
        self.assertIsNone(store.get(first.session_id, now=NOW))
        self.assertEqual(store.close_for_actor("fatou.ndiaye"), 1)
        self.assertIsNone(store.get(second.session_id, now=NOW))
        self.assertEqual(store.count(), 1)

    def test_failed_logins_are_counted_per_account_in_a_short_window(self) -> None:
        store = SessionStore()
        for _ in range(3):
            store.register_failure("fatou.ndiaye", now=NOW)
        self.assertEqual(store.failures("fatou.ndiaye", now=NOW), 3)
        self.assertEqual(store.failures("fatou.ndiaye", now=NOW + timedelta(seconds=301)), 0)
        self.assertEqual(store.failures("ousmane.fall", now=NOW), 0)
        store.clear_failures("fatou.ndiaye")
        self.assertEqual(store.failures("fatou.ndiaye", now=NOW), 0)


class RegistryCliTests(RegistryTestCase):
    def run_cli(self, *arguments: str) -> tuple[int, dict]:
        completed = subprocess.run(
            [sys.executable, str(SCRIPTS / "actor_registry.py"), "--root", str(self.root), *arguments],
            capture_output=True, text=True, check=False,
        )
        payload = json.loads(completed.stdout) if completed.stdout.strip() else {}
        return completed.returncode, payload

    def test_the_command_line_creates_lists_tokens_and_revokes(self) -> None:
        code, created = self.run_cli(
            "create", "fatou.ndiaye", "--name", "Fatou Ndiaye", "--role", "reviewer",
            "--created-by", "awa.mainteneur", "--secret", SECRET,
        )
        self.assertEqual(code, 0, created)
        self.assertEqual(created["role_label"], "relecteur")
        self.assertEqual(created["secret_stored"], "hash scrypt uniquement (aucun secret en clair sur le disque)")

        code, listed = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertEqual([actor["actor_id"] for actor in listed["actors"]], ["fatou.ndiaye"])
        self.assertNotIn(SECRET, json.dumps(listed))

        code, refused = self.run_cli(
            "create", "admin", "--name", "Administrateur", "--role", "publisher",
            "--created-by", "awa.mainteneur", "--secret", SECRET,
        )
        self.assertEqual(code, 1)
        self.assertEqual(refused["error"], "GENERIC_ACTOR_ID")

        code, issued = self.run_cli("token", "fatou.ndiaye", "--secret", SECRET, "--ttl", "900")
        self.assertEqual(code, 0)
        self.assertEqual(issued["role"], "reviewer")
        self.assertEqual(issued["ttl_seconds"], 900)
        self.assertTrue(issued["token"].startswith("dkr1."))

        code, summary = self.run_cli("summary")
        self.assertEqual(code, 0)
        self.assertEqual(summary["active"], 1)
        self.assertEqual(summary["roles"][0], {"role": "reviewer", "label": "relecteur", "count": 1})

        code, revoked = self.run_cli(
            "revoke", "fatou.ndiaye", "--revoked-by", "awa.mainteneur",
            "--reason", "Compte remplacé après un départ de l’équipe.",
        )
        self.assertEqual(code, 0, revoked)
        self.assertTrue(revoked["revoked"])
        code, after = self.run_cli("list")
        self.assertEqual(after["actors"], [])
        self.assertEqual(self.run_cli("list", "--all")[1]["actors"][0]["revoked_at"], revoked["revoked_at"])

    def test_the_command_line_reports_a_broken_registry_without_writing(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        registry = self.root / REGISTRY_FILENAME
        registry.write_text("{ ce n’est pas du JSON", encoding="utf-8")
        os.chmod(registry, 0o600)
        code, payload = self.run_cli("list")
        self.assertEqual(code, 1)
        self.assertEqual(payload["error"], "REGISTRY_UNREADABLE")
        self.assertEqual(registry.read_text(encoding="utf-8"), "{ ce n’est pas du JSON")


class SessionCookieTests(unittest.TestCase):
    def test_the_cookie_name_is_the_one_the_console_reads_back(self) -> None:
        # The console only ever echoes the CSRF token; the session itself is
        # HttpOnly, so the browser's JavaScript can never read it.
        self.assertEqual(SESSION_COOKIE, "dakar_session")
        self.assertLess(datetime.now(timezone.utc).timestamp(), float("inf"))


if __name__ == "__main__":
    unittest.main()
