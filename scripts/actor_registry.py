#!/usr/bin/env python3
"""Local actor registry: who may decide, and with what proof.

The console and the command line both act through a *local account*: an actor
id, a role, and a secret that is only ever stored as a scrypt hash. A decision
without an authenticated actor is refused — the free-text reviewer/publisher
name that used to be typed by hand no longer authenticates anything.

Three pieces live here:

- the registry (`data/actors/actors.json`, ignored by Git): actor id, display
  name, role, scrypt parameters, hash, salt, creation and revocation trail;
- the signing key (`data/actors/server.key`, ignored by Git), used for the
  short-lived bearer tokens the command line uses;
- in-memory sessions for the console: a login creates a random session id, the
  browser keeps it in an `HttpOnly` `SameSite=Strict` cookie, and the server
  keeps the mapping in memory only — nothing is written to disk.

What this module deliberately does not do: no default account, no shared
password, no "admin" bypass, no session persisted across a restart. If no
account exists, nothing can be decided, and the error says how to create one.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.actor_registry` and as a file script.
    from .review_ledger import file_lock
except ImportError:  # pragma: no cover - direct CLI entry point
    from review_ledger import file_lock

ACTOR_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,39}$")
ROLES = ("reviewer", "publisher")
ROLE_LABELS = {"reviewer": "relecteur", "publisher": "publieur"}
REGISTRY_SCHEMA_VERSION = "1.0"
REGISTRY_DIRECTORY = Path("data/actors")
REGISTRY_FILENAME = "actors.json"
SERVER_KEY_FILENAME = "server.key"

MIN_SECRET_LENGTH = 12
MAX_SECRET_LENGTH = 200
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32

TOKEN_PREFIX = "dkr1"
DEFAULT_TOKEN_TTL_SECONDS = 8 * 3600
MAX_TOKEN_TTL_SECONDS = 24 * 3600
SESSION_TTL_SECONDS = 12 * 3600
SESSION_COOKIE = "dakar_session"

# Generic identities cannot be authenticated: same rule as the ledgers.
GENERIC_IDS = {
    "admin",
    "administrator",
    "root",
    "system",
    "ci",
    "bot",
    "anonymous",
    "anonyme",
    "public",
    "test",
    "tests",
    "demo",
    "utilisateur",
    "user",
}


class ActorError(RuntimeError):
    """An authentication or account-management request that must be refused."""

    def __init__(self, code: str, message: str, blockers: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.blockers = blockers or []


class ActorLockTimeout(ActorError):
    """Another writer holds the registry lock; nothing was written."""

    def __init__(self, message: str) -> None:
        super().__init__("REGISTRY_LOCKED", message)


@dataclass(frozen=True)
class Authentication:
    """Proof that a named actor authenticated, at a known time, in a known way."""

    actor_id: str
    role: str
    method: str  # "cli-token" | "console-session"
    authenticated_at: str

    def as_proof(self) -> dict[str, Any]:
        return {
            "actor_id": self.actor_id,
            "role": self.role,
            "method": self.method,
            "authenticated_at": self.authenticated_at,
            "realtime": False,
        }


def _now(now: datetime | None = None) -> datetime:
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ActorError("INVALID_TIMESTAMP", "L’horodatage doit inclure un fuseau horaire.")
    return moment.astimezone(timezone.utc)


def _clean(value: str, field: str, minimum: int, maximum: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) < minimum:
        raise ActorError("INVALID_FIELD", f"« {field} » doit contenir au moins {minimum} caractères.")
    if len(text) > maximum:
        raise ActorError("INVALID_FIELD", f"« {field} » ne peut pas dépasser {maximum} caractères.")
    return text


def validate_actor_id(actor_id: str) -> str:
    candidate = (actor_id or "").strip().lower()
    if not ACTOR_ID_RE.fullmatch(candidate):
        raise ActorError(
            "INVALID_ACTOR_ID",
            "L’identifiant d’acteur doit être en minuscules (lettres, chiffres, « . », « _ », « - »), 3 à 40 caractères.",
        )
    if candidate in GENERIC_IDS:
        raise ActorError(
            "GENERIC_ACTOR_ID",
            f"« {candidate} » est un identifiant générique : un acteur nominatif est exigé pour tracer une décision.",
        )
    return candidate


def validate_role(role: str) -> str:
    candidate = (role or "").strip().lower()
    if candidate not in ROLES:
        raise ActorError("INVALID_ROLE", f"Rôle inconnu : attendu l’un de {', '.join(ROLES)}.")
    return candidate


def validate_secret(secret: str) -> str:
    if not isinstance(secret, str) or len(secret) < MIN_SECRET_LENGTH:
        raise ActorError("WEAK_SECRET", f"Le secret doit contenir au moins {MIN_SECRET_LENGTH} caractères.")
    if len(secret) > MAX_SECRET_LENGTH:
        raise ActorError("WEAK_SECRET", f"Le secret ne peut pas dépasser {MAX_SECRET_LENGTH} caractères.")
    if secret.strip() != secret:
        raise ActorError("WEAK_SECRET", "Le secret ne doit pas commencer ni finir par un espace.")
    return secret


def registry_directory(root: str | Path | None = None) -> Path:
    return Path(root) if root is not None else REGISTRY_DIRECTORY


def registry_path(root: str | Path | None = None) -> Path:
    return registry_directory(root) / REGISTRY_FILENAME


def server_key_path(root: str | Path | None = None) -> Path:
    return registry_directory(root) / SERVER_KEY_FILENAME


# --------------------------------------------------------------------------- #
# Registry file
# --------------------------------------------------------------------------- #


def _empty_registry() -> dict[str, Any]:
    return {"schema_version": REGISTRY_SCHEMA_VERSION, "actors": [], "realtime": False}


def read_registry(root: str | Path | None = None) -> dict[str, Any]:
    """Read the registry as-is; a missing file simply means no account exists yet."""
    path = registry_path(root)
    if not path.exists():
        return _empty_registry()
    if path.is_symlink() or not path.is_file():
        raise ActorError("REGISTRY_UNREADABLE", "Le registre d’acteurs n’est pas un fichier régulier.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ActorError("REGISTRY_UNREADABLE", f"Le registre d’acteurs est illisible : {error}.") from error
    if not isinstance(payload, dict) or payload.get("schema_version") != REGISTRY_SCHEMA_VERSION:
        raise ActorError("REGISTRY_UNREADABLE", "La version du registre d’acteurs n’est pas prise en charge.")
    actors = payload.get("actors")
    if not isinstance(actors, list):
        raise ActorError("REGISTRY_UNREADABLE", "Le registre d’acteurs ne contient pas de liste d’acteurs.")
    for actor in actors:
        if not isinstance(actor, dict) or not isinstance(actor.get("actor_id"), str) or actor.get("role") not in ROLES:
            raise ActorError("REGISTRY_UNREADABLE", "Une entrée du registre d’acteurs est incomplète.")
    return payload


def _write_registry(payload: dict[str, Any], root: str | Path | None = None) -> None:
    directory = registry_directory(root)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, stat.S_IRWXU)
    except OSError:  # pragma: no cover - some filesystems refuse chmod
        pass
    path = registry_path(root)
    temporary = path.with_name(f"{path.name}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, path)


def _lock(root: str | Path | None):
    """Serialise registry writers with the same advisory-lock helper as the ledgers."""
    directory = registry_directory(root)
    directory.mkdir(parents=True, exist_ok=True)
    return file_lock(
        directory / "actors.lock",
        subject="registre d’acteurs",
        error_class=ActorLockTimeout,
    )


# --------------------------------------------------------------------------- #
# Secrets
# --------------------------------------------------------------------------- #


def _hash_secret(secret: str, salt: bytes) -> bytes:
    return hashlib.scrypt(
        secret.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
    )


def _actor_by_id(payload: dict[str, Any], actor_id: str) -> dict[str, Any] | None:
    for actor in payload.get("actors", []):
        if actor.get("actor_id") == actor_id:
            return actor
    return None


def create_actor(
    actor_id: str,
    *,
    display_name: str,
    role: str,
    secret: str,
    created_by: str,
    root: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create one local account. The secret is never stored, only its scrypt hash."""
    current_time = _now(now)
    identifier = validate_actor_id(actor_id)
    validated_role = validate_role(role)
    name = _clean(display_name, "display_name", 3, 80)
    validated_secret = validate_secret(secret)
    author = _clean(created_by, "created_by", 3, 40)
    if identifier == author.strip().lower():
        raise ActorError("SELF_ENROLMENT", "Un acteur ne peut pas se créer lui-même : un autre acteur doit l’enregistrer.")

    salt = secrets.token_bytes(16)
    digest = _hash_secret(validated_secret, salt)
    with _lock(root):
        payload = read_registry(root)
        existing = _actor_by_id(payload, identifier)
        if existing is not None:
            raise ActorError("ACTOR_EXISTS", f"L’acteur « {identifier} » existe déjà ; révoquez-le avant d’en créer un autre.")
        payload["actors"].append(
            {
                "actor_id": identifier,
                "display_name": name,
                "role": validated_role,
                "secret": {
                    "algorithm": "scrypt",
                    "n": SCRYPT_N,
                    "r": SCRYPT_R,
                    "p": SCRYPT_P,
                    "dklen": SCRYPT_DKLEN,
                    "salt": base64.b64encode(salt).decode("ascii"),
                    "hash": base64.b64encode(digest).decode("ascii"),
                },
                "created_at": current_time.isoformat(),
                "created_by": author,
                "revoked_at": None,
                "revoked_by": None,
                "revoked_reason": None,
            }
        )
        payload["updated_at"] = current_time.isoformat()
        _write_registry(payload, root)

    return {
        "created": True,
        "actor_id": identifier,
        "display_name": name,
        "role": validated_role,
        "role_label": ROLE_LABELS[validated_role],
        "created_at": current_time.isoformat(),
        "created_by": author,
        "secret_stored": "hash scrypt uniquement (aucun secret en clair sur le disque)",
        "registry": str(registry_path(root)),
    }


def revoke_actor(
    actor_id: str,
    *,
    revoked_by: str,
    reason: str,
    root: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Revoke an account: the entry stays, the trail stays, the account stops working."""
    current_time = _now(now)
    identifier = validate_actor_id(actor_id)
    author = _clean(revoked_by, "revoked_by", 3, 40)
    motive = _clean(reason, "reason", 12, 400)
    with _lock(root):
        payload = read_registry(root)
        actor = _actor_by_id(payload, identifier)
        if actor is None:
            raise ActorError("ACTOR_UNKNOWN", f"Aucun acteur « {identifier} » dans le registre.")
        if actor.get("revoked_at"):
            raise ActorError("ACTOR_REVOKED", f"L’acteur « {identifier} » est déjà révoqué.")
        if identifier == author.strip().lower():
            raise ActorError("SELF_REVOCATION", "Un acteur ne peut pas se révoquer lui-même.")
        actor["revoked_at"] = current_time.isoformat()
        actor["revoked_by"] = author
        actor["revoked_reason"] = motive
        payload["updated_at"] = current_time.isoformat()
        _write_registry(payload, root)
    return {
        "revoked": True,
        "actor_id": identifier,
        "revoked_at": current_time.isoformat(),
        "revoked_by": author,
        "reason": motive,
        "note": "Le compte reste dans le registre pour la traçabilité ; il ne peut plus authentifier personne.",
    }


def list_actors(*, root: str | Path | None = None, include_revoked: bool = False) -> list[dict[str, Any]]:
    """Accounts without any secret material, safe to display."""
    payload = read_registry(root)
    actors: list[dict[str, Any]] = []
    for actor in payload.get("actors", []):
        if actor.get("revoked_at") and not include_revoked:
            continue
        actors.append(
            {
                "actor_id": actor.get("actor_id"),
                "display_name": actor.get("display_name"),
                "role": actor.get("role"),
                "role_label": ROLE_LABELS.get(str(actor.get("role")), str(actor.get("role"))),
                "created_at": actor.get("created_at"),
                "created_by": actor.get("created_by"),
                "revoked_at": actor.get("revoked_at"),
                "revoked_by": actor.get("revoked_by"),
                "revoked_reason": actor.get("revoked_reason"),
            }
        )
    return actors


def verify_secret(actor_id: str, secret: str, *, root: str | Path | None = None) -> dict[str, Any]:
    """Check a secret against the stored scrypt hash, in constant time."""
    identifier = (actor_id or "").strip().lower()
    payload = read_registry(root)
    actor = _actor_by_id(payload, identifier)
    if actor is None:
        # Same message and comparable work whether the actor exists or not.
        _hash_secret(str(secret or "x"), b"dakar-bus-unknown-actor")
        raise ActorError("AUTHENTICATION_FAILED", "Identifiant ou secret incorrect.")
    if actor.get("revoked_at"):
        raise ActorError("ACTOR_REVOKED", f"L’acteur « {identifier} » a été révoqué le {actor['revoked_at']}.")
    stored = actor.get("secret") or {}
    try:
        salt = base64.b64decode(str(stored.get("salt")), validate=True)
        expected = base64.b64decode(str(stored.get("hash")), validate=True)
    except (TypeError, ValueError) as error:
        raise ActorError("REGISTRY_UNREADABLE", "L’empreinte du secret est illisible dans le registre.") from error
    candidate = _hash_secret(secret or "", salt)
    if not hmac.compare_digest(candidate, expected):
        raise ActorError("AUTHENTICATION_FAILED", "Identifiant ou secret incorrect.")
    return actor


# --------------------------------------------------------------------------- #
# Bearer tokens (command line)
# --------------------------------------------------------------------------- #


def _server_key(root: str | Path | None = None, *, create: bool = True) -> bytes:
    path = server_key_path(root)
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise ActorError("KEY_UNREADABLE", "La clé de signature n’est pas un fichier régulier.")
        key = base64.b64decode(path.read_text(encoding="ascii").strip(), validate=True)
        if len(key) < 32:
            raise ActorError("KEY_UNREADABLE", "La clé de signature est trop courte.")
        return key
    if not create:
        raise ActorError("KEY_MISSING", "Aucune clé de signature : aucun jeton ne peut être vérifié.")
    directory = registry_directory(root)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(directory, stat.S_IRWXU)
    except OSError:  # pragma: no cover
        pass
    key = secrets.token_bytes(48)
    temporary = path.with_name(f"{path.name}.tmp")
    with open(temporary, "w", encoding="ascii") as handle:
        handle.write(base64.b64encode(key).decode("ascii"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(temporary, path)
    return key


def issue_token(
    actor_id: str,
    secret: str,
    *,
    role: str | None = None,
    ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS,
    root: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Exchange a secret for a short-lived bearer token, valid for one role."""
    current_time = _now(now)
    if not 60 <= int(ttl_seconds) <= MAX_TOKEN_TTL_SECONDS:
        raise ActorError("INVALID_TTL", f"La durée de vie doit être comprise entre 60 et {MAX_TOKEN_TTL_SECONDS} secondes.")
    actor = verify_secret(actor_id, secret, root=root)
    requested_role = validate_role(role) if role else str(actor["role"])
    if requested_role != actor["role"]:
        raise ActorError(
            "ROLE_MISMATCH",
            f"L’acteur « {actor['actor_id']} » a le rôle « {actor['role']} » : il ne peut pas agir comme « {requested_role} ».",
        )
    expires_at = int(current_time.timestamp()) + int(ttl_seconds)
    body = {
        "actor_id": actor["actor_id"],
        "role": requested_role,
        "issued_at": int(current_time.timestamp()),
        "expires_at": expires_at,
        "nonce": secrets.token_hex(8),
    }
    encoded = base64.urlsafe_b64encode(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(_server_key(root), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return {
        "token": f"{TOKEN_PREFIX}.{encoded}.{signature}",
        "actor_id": actor["actor_id"],
        "display_name": actor.get("display_name"),
        "role": requested_role,
        "role_label": ROLE_LABELS[requested_role],
        "issued_at": current_time.isoformat(),
        "expires_at": datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat(),
        "ttl_seconds": int(ttl_seconds),
        "realtime": False,
    }


def verify_token(
    token: str,
    *,
    required_role: str | None = None,
    root: str | Path | None = None,
    now: datetime | None = None,
) -> Authentication:
    """Validate a bearer token: signature, expiry, account still active, role."""
    current_time = _now(now)
    if not isinstance(token, str) or not token.strip():
        raise ActorError("TOKEN_REQUIRED", "Aucun jeton fourni : authentifiez-vous avec un compte local.")
    parts = token.strip().split(".")
    if len(parts) != 3 or parts[0] != TOKEN_PREFIX:
        raise ActorError("TOKEN_INVALID", "Jeton illisible.")
    encoded, signature = parts[1], parts[2]
    expected = hmac.new(_server_key(root, create=False), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ActorError("TOKEN_INVALID", "La signature du jeton ne correspond pas.")
    try:
        padded = encoded + "=" * (-len(encoded) % 4)
        body = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, json.JSONDecodeError) as error:
        raise ActorError("TOKEN_INVALID", "Contenu du jeton illisible.") from error
    if not isinstance(body, dict):
        raise ActorError("TOKEN_INVALID", "Contenu du jeton illisible.")
    expires_at = body.get("expires_at")
    if not isinstance(expires_at, int) or expires_at <= int(current_time.timestamp()):
        raise ActorError("TOKEN_EXPIRED", "Le jeton a expiré : demandez-en un nouveau.")
    actor_id = str(body.get("actor_id") or "")
    role = str(body.get("role") or "")
    payload = read_registry(root)
    actor = _actor_by_id(payload, actor_id)
    if actor is None:
        raise ActorError("ACTOR_UNKNOWN", f"Aucun acteur « {actor_id} » dans le registre.")
    if actor.get("revoked_at"):
        raise ActorError("ACTOR_REVOKED", f"L’acteur « {actor_id} » a été révoqué : le jeton ne vaut plus rien.")
    if actor.get("role") != role:
        raise ActorError("ROLE_CHANGED", "Le rôle de l’acteur a changé depuis l’émission du jeton.")
    if required_role is not None and role != validate_role(required_role):
        raise ActorError(
            "ROLE_FORBIDDEN",
            f"Rôle « {role} » insuffisant : cette action exige le rôle « {required_role} ».",
        )
    return Authentication(
        actor_id=actor_id,
        role=role,
        method="cli-token",
        authenticated_at=current_time.isoformat(),
    )


# --------------------------------------------------------------------------- #
# Console sessions (in memory only)
# --------------------------------------------------------------------------- #


@dataclass
class Session:
    session_id: str
    actor_id: str
    role: str
    created_at: datetime
    expires_at: datetime
    csrf_token: str

    def as_authentication(self) -> Authentication:
        """The proof an action carries when it comes from the console."""
        return Authentication(
            actor_id=self.actor_id,
            role=self.role,
            method="console-session",
            authenticated_at=self.created_at.isoformat(),
        )


class SessionStore:
    """Sessions live in memory: a restart ends them, nothing is written to disk."""

    def __init__(self, *, ttl_seconds: int = SESSION_TTL_SECONDS) -> None:
        self._sessions: dict[str, Session] = {}
        self._failures: dict[str, list[float]] = {}
        self.ttl_seconds = ttl_seconds

    def _purge(self, now: datetime) -> None:
        for session_id, session in list(self._sessions.items()):
            if session.expires_at <= now:
                del self._sessions[session_id]

    def open(self, actor_id: str, role: str, *, now: datetime | None = None) -> Session:
        current_time = _now(now)
        self._purge(current_time)
        session = Session(
            session_id=secrets.token_urlsafe(32),
            actor_id=actor_id,
            role=role,
            created_at=current_time,
            expires_at=current_time + timedelta(seconds=self.ttl_seconds),
            csrf_token=secrets.token_urlsafe(24),
        )
        self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str | None, *, now: datetime | None = None) -> Session | None:
        if not session_id:
            return None
        current_time = _now(now)
        self._purge(current_time)
        return self._sessions.get(session_id)

    def close(self, session_id: str | None) -> bool:
        if not session_id:
            return False
        return self._sessions.pop(session_id, None) is not None

    def close_for_actor(self, actor_id: str) -> int:
        doomed = [session_id for session_id, session in self._sessions.items() if session.actor_id == actor_id]
        for session_id in doomed:
            del self._sessions[session_id]
        return len(doomed)

    def count(self) -> int:
        return len(self._sessions)

    # A small brake against online guessing, per account.
    def register_failure(self, actor_id: str, *, now: datetime | None = None) -> int:
        current_time = _now(now)
        window_start = current_time.timestamp() - 300
        attempts = [attempt for attempt in self._failures.get(actor_id, []) if attempt >= window_start]
        attempts.append(current_time.timestamp())
        self._failures[actor_id] = attempts
        return len(attempts)

    def failures(self, actor_id: str, *, now: datetime | None = None) -> int:
        current_time = _now(now)
        window_start = current_time.timestamp() - 300
        return len([attempt for attempt in self._failures.get(actor_id, []) if attempt >= window_start])

    def clear_failures(self, actor_id: str) -> None:
        self._failures.pop(actor_id, None)


MAX_LOGIN_FAILURES = 8


def require_active_actor(actor_id: str, *, role: str | None = None, root: str | Path | None = None) -> dict[str, Any]:
    """Re-read the registry so a revoked account cannot keep acting through an old session."""
    payload = read_registry(root)
    actor = _actor_by_id(payload, actor_id)
    if actor is None:
        raise ActorError("ACTOR_UNKNOWN", f"Aucun acteur « {actor_id} » dans le registre.")
    if actor.get("revoked_at"):
        raise ActorError("ACTOR_REVOKED", f"L’acteur « {actor_id} » a été révoqué le {actor['revoked_at']}.")
    if role is not None and actor.get("role") != role:
        raise ActorError(
            "ROLE_CHANGED",
            f"Le rôle de « {actor_id} » est désormais « {actor.get('role')} » : reconnectez-vous.",
        )
    return actor


def authenticate_for_role(
    token: str | None,
    *,
    role: str,
    root: str | Path | None = None,
    now: datetime | None = None,
) -> Authentication:
    """Convenience wrapper used by the command line: a token, a role, or nothing."""
    return verify_token(token or "", required_role=role, root=root, now=now)


def registry_summary(*, root: str | Path | None = None, now: datetime | None = None) -> dict[str, Any]:
    """What the console may show about the accounts, without any secret material."""
    current_time = _now(now)
    payload = read_registry(root)
    actors = payload.get("actors", [])
    return {
        "registry": str(registry_path(root)),
        "exists": registry_path(root).exists(),
        "active": sum(1 for actor in actors if not actor.get("revoked_at")),
        "revoked": sum(1 for actor in actors if actor.get("revoked_at")),
        "roles": [{"role": role, "label": ROLE_LABELS[role], "count": sum(1 for actor in actors if actor.get("role") == role and not actor.get("revoked_at"))} for role in ROLES],
        "accounts": list_actors(root=root, include_revoked=True),
        "checked_at": current_time.isoformat(),
        "realtime": False,
    }


def _read_secret_interactively(prompt: str) -> str:
    import getpass

    return getpass.getpass(prompt)


def _emit(result: object) -> None:
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Comptes locaux, jetons et sessions de la console Dakar Bus.")
    parser.add_argument("--root", type=Path, default=REGISTRY_DIRECTORY, help="Répertoire du registre d’acteurs")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Créer un compte local (secret haché, jamais stocké en clair)")
    create.add_argument("actor_id")
    create.add_argument("--name", required=True, help="Nom affiché de l’acteur")
    create.add_argument("--role", required=True, choices=ROLES)
    create.add_argument("--created-by", required=True, help="Identifiant de l’acteur qui enregistre ce compte")
    create.add_argument("--secret", help="Secret (sinon demandé de façon masquée)")

    revoke = subparsers.add_parser("revoke", help="Révoquer un compte sans effacer sa trace")
    revoke.add_argument("actor_id")
    revoke.add_argument("--revoked-by", required=True)
    revoke.add_argument("--reason", required=True)

    subparsers.add_parser("list", help="Lister les comptes sans aucun secret")
    list_parser = subparsers.choices["list"]
    list_parser.add_argument("--all", action="store_true", help="Inclure les comptes révoqués")

    token = subparsers.add_parser("token", help="Émettre un jeton Bearer court pour le CLI")
    token.add_argument("actor_id")
    token.add_argument("--secret")
    token.add_argument("--ttl", type=int, default=DEFAULT_TOKEN_TTL_SECONDS)

    subparsers.add_parser("summary", help="État du registre (comptes actifs, rôles)")

    args = parser.parse_args()
    try:
        if args.command == "create":
            secret = args.secret or _read_secret_interactively(f"Secret pour {args.actor_id} : ")
            _emit(
                create_actor(
                    args.actor_id,
                    display_name=args.name,
                    role=args.role,
                    secret=secret,
                    created_by=args.created_by,
                    root=args.root,
                )
            )
            return 0
        if args.command == "revoke":
            _emit(revoke_actor(args.actor_id, revoked_by=args.revoked_by, reason=args.reason, root=args.root))
            return 0
        if args.command == "list":
            _emit({"actors": list_actors(root=args.root, include_revoked=args.all), "realtime": False})
            return 0
        if args.command == "token":
            secret = args.secret or _read_secret_interactively(f"Secret pour {args.actor_id} : ")
            _emit(issue_token(args.actor_id, secret, ttl_seconds=args.ttl, root=args.root))
            return 0
        _emit(registry_summary(root=args.root))
        return 0
    except ActorError as error:
        _emit({"error": error.code, "message": error.message, "blockers": error.blockers})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
