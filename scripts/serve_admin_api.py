#!/usr/bin/env python3
"""HTTP API: public read routes, governance console, and the decisions it records.

Two things live here.

*Read*: the public routes serve the active published snapshot and nothing else,
and the governance routes describe staged versions and their review state. Both
are GET-only and report honestly when the store or a journal is unusable.

*Decide*: the console authenticates a local account, then records approvals,
refusals, reversals and publications. A decision always goes through the same
functions as the command line (`approve_dataset`, `reject_dataset`,
`revert_decision`, `publish_dataset`, `revert_publication`), so the rules —
attestations, separation of duties between reviewer and publisher, journal
chaining — are enforced in one place whichever entry point is used.

Authentication is a local account, never a free-text name: the console gets a
session cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api`) plus a CSRF token it
must echo in `X-Dakar-CSRF`, and the command line uses a short-lived bearer
token. Sessions live in memory only, so restarting this server disconnects
everyone and nothing about a session is ever written to disk.
"""

from __future__ import annotations

import argparse
import hmac
import json
import re
from collections.abc import Callable, Iterable
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

try:  # Works both as `python -m scripts.serve_admin_api` and as a file script.
    from .actor_registry import (
        MAX_LOGIN_FAILURES,
        REGISTRY_DIRECTORY,
        SESSION_COOKIE,
        SESSION_TTL_SECONDS,
        ActorError,
        Session,
        SessionStore,
        require_active_actor,
        registry_summary,
        verify_secret,
    )
    from .catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from .publication_ledger import PublicationError, current_publication_state
    from .review_ledger import LedgerLockTimeout
    from .publish_gtfs import publish_dataset, revert_publication
    from .review_gtfs import (
        ReviewError,
        approve_dataset,
        parse_attestations,
        reject_dataset,
        review_dossier,
        revert_decision,
    )
    from .review_ledger import current_review_state
    from .serve_read_api import PUBLIC_ROUTES, ApiError, resolve_public_route
    from .snapshot_gtfs import DATA_POLICY, SnapshotError, list_snapshots
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from actor_registry import (
        MAX_LOGIN_FAILURES,
        REGISTRY_DIRECTORY,
        SESSION_COOKIE,
        SESSION_TTL_SECONDS,
        ActorError,
        Session,
        SessionStore,
        require_active_actor,
        registry_summary,
        verify_secret,
    )
    from catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from publication_ledger import PublicationError, current_publication_state
    from review_ledger import LedgerLockTimeout
    from publish_gtfs import publish_dataset, revert_publication
    from review_gtfs import (
        ReviewError,
        approve_dataset,
        parse_attestations,
        reject_dataset,
        review_dossier,
        revert_decision,
    )
    from review_ledger import current_review_state
    from serve_read_api import PUBLIC_ROUTES, ApiError, resolve_public_route
    from snapshot_gtfs import DATA_POLICY, SnapshotError, list_snapshots


API_PREFIX = "/api"
DATASET_ROUTE_PREFIX = f"{API_PREFIX}/datasets/"
GOVERNANCE_ROUTES = (
    "/healthz",
    f"{API_PREFIX}/pipeline",
    f"{API_PREFIX}/catalog",
    f"{API_PREFIX}/datasets/<dataset_id>",
    f"{API_PREFIX}/session",
    f"{API_PREFIX}/actors",
    f"{API_PREFIX}/datasets/<dataset_id>/decision",
    f"{API_PREFIX}/datasets/<dataset_id>/revert",
    f"{API_PREFIX}/datasets/<dataset_id>/publication",
    f"{API_PREFIX}/publication/revert",
)

# Kept for callers that imported the older name.
AdminApiError = ApiError

CSRF_HEADER = "X-Dakar-CSRF"
MAX_BODY_BYTES = 256 * 1024
# Un secret de compte ne dépasse jamais quelques dizaines de caractères : au-delà,
# on refuse avant le calcul scrypt (protection contre un déni de service).
MAX_SECRET_CHARS = 1024
# Délai de lecture d'une connexion : évite qu'un client lent immobilise un thread.
HANDLER_TIMEOUT_SECONDS = 15
# Seuls ces noms d'hôte (plus ceux passés à --allowed-host) sont acceptés dans l'en-tête Host.
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
# Politique appliquée à toutes les réponses JSON de l'API : aucune ressource chargeable.
API_CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
DATASET_ACTION_RE = re.compile(
    rf"^{re.escape(API_PREFIX)}/datasets/(?P<dataset_id>[^/]+)/(?P<action>decision|revert|publication)$"
)
PUBLICATION_REVERT_PATH = f"{API_PREFIX}/publication/revert"
DECISIONS = ("approve", "reject")

# Refusals are categorised so the console can tell "you may not" from "not yet":
# 401 nobody is authenticated, 403 authenticated but not allowed, 404 unknown
# resource, 409 the current state forbids it, 422 the request itself is incomplete.
TOO_MANY_ATTEMPTS = 429

UNAUTHENTICATED_CODES = {
    "AUTHENTICATION_REQUIRED",
    "AUTHENTICATION_FAILED",
    "SESSION_REQUIRED",
    "SESSION_UNKNOWN",
    "TOKEN_REQUIRED",
}
FORBIDDEN_CODES = {
    "ACTOR_REVOKED",
    "ACTOR_UNKNOWN",
    "AUTHENTICATION_INVALID",
    "CROSS_ORIGIN_REFUSED",
    "CSRF_INVALID",
    "CSRF_REQUIRED",
    "GENERIC_ACTOR_ID",
    "INVALID_PUBLISHER",
    "ROLE_CHANGED",
    "ROLE_FORBIDDEN",
    "SEPARATION_OF_DUTIES",
}
CONFLICT_CODES = {
    "ALREADY_REJECTED",
    "APPROVAL_BLOCKED",
    "APPROVAL_ALREADY_RECORDED",
    "DATASET_INTEGRITY_INVALID",
    "DATASET_NOT_PUBLISHABLE",
    "LEDGER_LOCKED",
    "NO_ACTIVE_DECISION",
    "NOTHING_PUBLISHED",
    "REVERT_TARGET_MISMATCH",
    "SNAPSHOT_UNKNOWN",
}
MISSING_CODES = {
    "DATASET_UNKNOWN",
    "MANIFEST_MISSING",
    "SNAPSHOT_MISSING",
    "UNSAFE_PUBLISHED_ROOT",
}
UNPROCESSABLE_CODES = {
    "ATTESTATION_FORMAT",
    "ATTESTATION_INVALID",
    "ATTESTATION_UNKNOWN",
    "CHECKSUM_UNAVAILABLE",
    "INVALID_ACTION",
    "INVALID_CHECKSUM",
    "INVALID_DATASET_ID",
    "INVALID_NOTE",
    "INVALID_REFERENCE",
    "INVALID_REVERT",
    "INVALID_TIMESTAMP",
    "WEAK_SECRET",
}


def _host_name(value: str) -> str:
    """Nom d'hôte seul, sans port, en minuscules (gère « [::1]:8787 »)."""
    candidate = value.strip().lower()
    if candidate.startswith("["):
        return candidate[1:candidate.find("]")] if "]" in candidate else ""
    if candidate.count(":") == 1:
        return candidate.split(":", 1)[0]
    return candidate


def host_allowed(host_header: str | None, extra_hosts: Iterable[str] = ()) -> bool:
    """Protège contre le « DNS rebinding » : seul l'hôte de la console est accepté."""
    name = _host_name(host_header or "")
    if not name:
        return False
    return name in LOOPBACK_HOSTS or name in {_host_name(host) for host in extra_hosts}


def _known_routes() -> str:
    return ", ".join((*GOVERNANCE_ROUTES, *PUBLIC_ROUTES))


def _not_found(message: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def status_for_code(code: str) -> int:
    """Map a domain refusal onto an HTTP status the console can act on."""
    if code == "TOO_MANY_ATTEMPTS":
        return TOO_MANY_ATTEMPTS
    if code in UNAUTHENTICATED_CODES:
        return 401
    if code in FORBIDDEN_CODES:
        return 403
    if code in CONFLICT_CODES:
        return 409
    if code in MISSING_CODES:
        return 404
    if code in UNPROCESSABLE_CODES:
        return 422
    return 400


def refusal(code: str, message: str, blockers: list[str] | None = None) -> ApiError:
    """One refusal, with its blockers, ready to be sent as JSON."""
    error = ApiError(status_for_code(code), code, message)
    error.blockers = list(blockers or [])  # type: ignore[attr-defined]
    return error


def _publication_overview(published_root: str | Path, *, now: datetime | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    state = current_publication_state(published_root)
    try:
        snapshots = list_snapshots(published_root, now=now)
    except ValueError:
        snapshots = []
    return state, snapshots


def pipeline_summary(
    root: str | Path,
    *,
    now: datetime | None = None,
    published_root: str | Path | None = None,
) -> dict[str, Any]:
    """Count datasets per governance stage, publication included."""
    entries = list_staged_datasets(root, now=now)
    counts = {
        "staged": len(entries),
        "integrity_invalid": 0,
        "pending_review": 0,
        "approved": 0,
        "rejected": 0,
        "review_unknown": 0,
        "published": 0,
        "snapshots": 0,
    }
    for entry in entries:
        if entry["integrity"] != "OK":
            counts["integrity_invalid"] += 1
        status = current_review_state(Path(root) / str(entry["dataset_id"]))["review_status"]
        if status == "APPROVED":
            counts["approved"] += 1
        elif status == "REJECTED":
            counts["rejected"] += 1
        elif status == "PENDING_REVIEW":
            counts["pending_review"] += 1
        else:
            counts["review_unknown"] += 1

    store = Path(published_root) if published_root is not None else Path(root).parent / "published"
    publication, snapshots = _publication_overview(store, now=now)
    counts["snapshots"] = len(snapshots)
    counts["published"] = sum(1 for snapshot in snapshots if snapshot["publication_status"] == "ACTIVE")

    return {
        "generated_at": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "counts": counts,
        "stages": [
            {"id": "staged", "label": "Staging", "count": counts["staged"], "note": "Archive copiée avec provenance déclarée."},
            {"id": "pending_review", "label": "En revue", "count": counts["pending_review"], "note": "En attente d’une décision humaine nominative."},
            {"id": "approved", "label": "Approuvé", "count": counts["approved"], "note": "Attestations complètes ; publication toujours séparée."},
            {"id": "rejected", "label": "Refusé", "count": counts["rejected"], "note": "Motif enregistré dans le journal."},
            {
                "id": "published",
                "label": "Publié",
                "count": counts["published"],
                "note": "Snapshot daté, immuable et servi en lecture seule ; retour arrière tracé dans le journal.",
            },
        ],
        "integrity_invalid": counts["integrity_invalid"],
        "review_unknown": counts["review_unknown"],
        "data_policy": DATA_POLICY,
        "publication_status": publication["publication_status"],
        "publication_journal_integrity": publication["journal_integrity"],
        "active_snapshot_id": (publication.get("active") or {}).get("snapshot_id") if isinstance(publication.get("active"), dict) else None,
    }


def catalog_payload(
    root: str | Path,
    *,
    now: datetime | None = None,
    published_root: str | Path | None = None,
) -> dict[str, Any]:
    """Staged versions, with the publication state read from the journal.

    The staging manifest always says `NOT_PUBLISHED` — it is frozen at import
    time. What a version is *today* is decided by the publication journal, so
    the console reads it from there rather than from the manifest.
    """
    store = Path(published_root) if published_root is not None else Path(root).parent / "published"
    publication = current_publication_state(store)
    _, snapshots = _publication_overview(store, now=now)
    active = publication.get("active")
    active_snapshot_id = active.get("snapshot_id") if isinstance(active, dict) else None

    published_by_dataset: dict[str, list[dict[str, Any]]] = {}
    for snapshot in snapshots:
        published_by_dataset.setdefault(str(snapshot.get("dataset_id")), []).append(snapshot)

    datasets = list_staged_datasets(root, now=now)
    for entry in datasets:
        related = published_by_dataset.get(str(entry["dataset_id"]), [])
        if any(snapshot["snapshot_id"] == active_snapshot_id for snapshot in related):
            entry["publication_status"] = "PUBLISHED"
        elif any(snapshot["publication_status"] == "REVOKED" for snapshot in related):
            entry["publication_status"] = "REVOKED"
        elif related:
            entry["publication_status"] = "SUPERSEDED"
        entry["publication_snapshot_id"] = related[-1]["snapshot_id"] if related else None

    return {
        "generated_at": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "root": Path(root).name or str(root),
        "datasets": datasets,
        "data_policy": DATA_POLICY,
        "publication_status": publication["publication_status"],
        "publication_journal_integrity": publication["journal_integrity"],
        "active_snapshot_id": active_snapshot_id,
    }


def dataset_loader(root: Path, dataset_id: str) -> Callable[[], dict[str, Any]]:
    """Load one review dossier, refusing identifiers that could escape the root."""

    def load() -> dict[str, Any]:
        if not DATASET_ID_RE.fullmatch(dataset_id):
            raise _not_found("Identifiant de dataset invalide.")
        dossier = review_dossier(root, dataset_id)
        issue = dossier.get("integrity_issue") or {}
        if dossier["integrity"] == "INVALID" and issue.get("code") in {
            "MANIFEST_MISSING",
            "UNSAFE_DATASET_DIRECTORY",
            "INVALID_DATASET_ID",
        }:
            raise _not_found("Version inconnue dans le catalogue local.")
        return dossier

    return load


def make_router(root: Path, published_root: Path) -> dict[str, Callable[[], dict[str, Any]]]:
    """Exact-match governance routes; identifiers are validated before touching disk."""
    return {
        # Seuls les noms des dossiers sont publiés, jamais leur chemin absolu sur la machine.
        "/healthz": lambda: {
            "status": "ok",
            "service": "dakar-bus-admin-api",
            "mode": "governance-console",
            "read_only_public_data": True,
            "decisions": "compte local authentifié (session console ou jeton CLI)",
            "authentication": "sessions en mémoire + jeton Bearer pour le CLI ; aucune décision anonyme",
            "governance_root": Path(root).name,
            "published_root": Path(published_root).name,
        },
        f"{API_PREFIX}/pipeline": lambda: pipeline_summary(root, published_root=published_root),
        f"{API_PREFIX}/catalog": lambda: catalog_payload(root, published_root=published_root),
    }


def _cookie_value(header: str | None, name: str) -> str | None:
    """Read one cookie from the request header without trusting the rest of it."""
    for chunk in (header or "").split(";"):
        key, separator, value = chunk.strip().partition("=")
        if separator and key == name:
            return value.strip() or None
    return None


def session_cookie(session: Session, *, ttl_seconds: int, secure: bool = False) -> str:
    """`HttpOnly` + `SameSite=Strict` + `Path=/api`: the browser cannot read it back to JS.

    `Secure` is added when the console is reached over HTTPS, so the cookie never travels in clear.
    """
    attributes = f"{SESSION_COOKIE}={session.session_id}; Path={API_PREFIX}; HttpOnly; SameSite=Strict; Max-Age={int(ttl_seconds)}"
    return f"{attributes}; Secure" if secure else attributes


def cleared_session_cookie(*, secure: bool = False) -> str:
    attributes = f"{SESSION_COOKIE}=; Path={API_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0"
    return f"{attributes}; Secure" if secure else attributes


class AdminApiHandler(BaseHTTPRequestHandler):
    server_version = "DakarBusAdminApi/2.0"
    # Délai par connexion (secondes) : un client lent ne bloque pas le serveur.
    timeout = HANDLER_TIMEOUT_SECONDS
    root: Path
    published_root: Path
    actors_root: Path
    sessions: SessionStore
    base_router: dict[str, Callable[[], dict[str, Any]]]
    allowed_hosts: tuple[str, ...] = ()

    def parse_request(self) -> bool:
        """Refuse toute requête dont l'en-tête Host n'est pas celui de la console."""
        if not super().parse_request():
            return False
        if host_allowed(self.headers.get("Host"), self.allowed_hosts):
            return True
        self.close_connection = True
        self._send(
            421,
            {
                "error": "HOST_REFUSED",
                "message": "En-tête Host non autorisé : la console n’accepte que son propre hôte (boucle locale ou --allowed-host).",
            },
        )
        return False

    def _is_secure_context(self) -> bool:
        """Vrai quand le navigateur est en HTTPS (son en-tête Origin le dit)."""
        return (self.headers.get("Origin") or "").lower().startswith("https://")

    # ------------------------------------------------------------------ read #

    def _publication_status(self) -> str:
        try:
            return str(current_publication_state(self.published_root)["publication_status"])
        except (ValueError, OSError):  # pragma: no cover - unreadable store
            return "UNKNOWN"

    def _send(self, status: int, payload: dict[str, Any], *, cookies: list[str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", API_CONTENT_SECURITY_POLICY)
        for cookie in cookies or []:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_refusal(self, error: ApiError) -> None:
        payload: dict[str, Any] = {
            "error": error.code,
            "message": error.message,
            "publication_status": self._publication_status(),
        }
        blockers = getattr(error, "blockers", None)
        if blockers:
            payload["blockers"] = list(blockers)
        self._send(error.status, payload)

    def _resolve(self, path: str, query: str) -> dict[str, Any]:
        route = self.base_router.get(path)
        if route is not None:
            return route()
        if path == f"{API_PREFIX}/session":
            return self._session_view()
        if path == f"{API_PREFIX}/actors":
            self._require_session()
            return dict(registry_summary(root=self.actors_root), sessions=self.sessions.count())
        if path.startswith(DATASET_ROUTE_PREFIX):
            return dataset_loader(self.root, path[len(DATASET_ROUTE_PREFIX):])()
        public = resolve_public_route(path, query, self.published_root)
        if public is not None:
            return public()
        raise _not_found(f"Ressource inconnue ; cette API expose : {_known_routes()}.")

    def _handle(self) -> None:
        raw_path, _, query = self.path.partition("?")
        path = raw_path.rstrip("/") or "/"
        try:
            self._send(200, self._resolve(path, query))
        except ApiError as error:
            self._send_refusal(error)
        except ValueError as error:
            # Le détail reste dans le journal serveur ; le navigateur ne reçoit qu'un message générique.
            self.log_error("catalogue indisponible : %s", error)
            self._send(
                500,
                {
                    "error": "CATALOG_UNAVAILABLE",
                    "message": "Le catalogue local est indisponible. Consultez le journal du serveur.",
                    "publication_status": self._publication_status(),
                },
            )

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    def do_HEAD(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    # ----------------------------------------------------------------- write #

    def _refuse_write(self) -> None:
        self._send(
            405,
            {
                "error": "READ_ONLY_API",
                "message": (
                    "Cette route est en lecture seule. Les décisions passent par "
                    f"POST {API_PREFIX}/datasets/<dataset_id>/decision|revert|publication avec une session "
                    "console authentifiée, ou par scripts/review_gtfs.py et scripts/publish_gtfs.py avec un jeton."
                ),
                "publication_status": self._publication_status(),
            },
        )

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError as error:
            raise ApiError(400, "INVALID_REQUEST", "En-tête Content-Length illisible.") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise ApiError(413, "REQUEST_TOO_LARGE", f"Corps de requête trop volumineux (maximum {MAX_BODY_BYTES} octets).")
        if length == 0:
            return {}
        # Type exigé dès qu'il y a un corps : un formulaire ou un texte brut ne passe pas.
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Le corps de la requête doit être du JSON (application/json).")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ApiError(400, "INVALID_REQUEST", "Le corps de la requête n’est pas un JSON valide.") from error
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_REQUEST", "Le corps de la requête doit être un objet JSON.")
        return payload

    def _current_session(self) -> Session | None:
        return self.sessions.get(_cookie_value(self.headers.get("Cookie"), SESSION_COOKIE))

    def _session_view(self) -> dict[str, Any]:
        session = self._current_session()
        if session is None:
            return {
                "authenticated": False,
                "actor": None,
                "csrf_token": None,
                "expires_at": None,
                "sessions": self.sessions.count(),
                "realtime": False,
            }
        try:
            actor = require_active_actor(session.actor_id, role=session.role, root=self.actors_root)
        except ActorError as error:
            self.sessions.close(session.session_id)
            raise refusal(error.code, error.message, error.blockers) from error
        return {
            "authenticated": True,
            "actor": {
                "actor_id": session.actor_id,
                "display_name": actor.get("display_name"),
                "role": session.role,
            },
            "csrf_token": session.csrf_token,
            "expires_at": session.expires_at.isoformat(),
            "sessions": self.sessions.count(),
            "realtime": False,
        }

    def _refuse_foreign_origin(self) -> None:
        """Une requête issue d'une autre origine (page tierce) n'est jamais acceptée."""
        origin = self.headers.get("Origin")
        if origin:
            host = (self.headers.get("Host") or "").strip()
            if not host or urlparse(origin).netloc.lower() != host.lower():
                raise ApiError(
                    403,
                    "CROSS_ORIGIN_REFUSED",
                    f"Écriture refusée : origine « {origin} » différente de l’hôte « {host} ».",
                )

    def _csrf_proof(self, session: Session) -> None:
        """A write must carry the session's CSRF token and come from this origin."""
        self._refuse_foreign_origin()
        supplied = self.headers.get(CSRF_HEADER) or ""
        if not supplied:
            raise refusal(
                "CSRF_REQUIRED",
                f"Écriture refusée : l’en-tête {CSRF_HEADER} est exigé pour toute action authentifiée.",
            )
        if not hmac.compare_digest(supplied, session.csrf_token):
            raise refusal("CSRF_INVALID", "Écriture refusée : le jeton CSRF ne correspond pas à la session.")

    def _require_session(self, *, role: str | None = None, write: bool = False) -> Session:
        session = self._current_session()
        if session is None:
            raise refusal(
                "AUTHENTICATION_REQUIRED",
                "Aucune session console active. Connectez-vous avec un compte local, ou utilisez un jeton de la CLI.",
                [
                    "Créez un compte : npm run actors -- create <identifiant> --name \"<nom>\" --role reviewer|publisher --created-by <autre.acteur>",
                    "Émettez un jeton court : npm run actors -- token <identifiant> --ttl 3600",
                    "Console : POST /api/session avec { actor_id, secret }.",
                ],
            )
        if write:
            self._csrf_proof(session)
        try:
            require_active_actor(session.actor_id, role=session.role, root=self.actors_root)
        except ActorError as error:
            self.sessions.close(session.session_id)
            raise refusal(error.code, error.message, error.blockers) from error
        if role is not None and session.role != role:
            raise refusal(
                "ROLE_FORBIDDEN",
                f"Rôle « {session.role} » insuffisant : cette action exige le rôle « {role} ».",
            )
        return session

    def _login(self) -> dict[str, Any]:
        self._refuse_foreign_origin()
        payload = self._read_json()
        actor_id = str(payload.get("actor_id") or "").strip().casefold()
        secret = payload.get("secret")
        if not actor_id or not isinstance(secret, str) or not secret:
            raise ApiError(400, "INVALID_REQUEST", "Identifiant et secret sont exigés pour ouvrir une session.")
        if len(secret) > MAX_SECRET_CHARS:
            raise ApiError(400, "INVALID_REQUEST", f"Le secret ne peut pas dépasser {MAX_SECRET_CHARS} caractères.")
        if self.sessions.failures(actor_id) >= MAX_LOGIN_FAILURES:
            raise refusal(
                "TOO_MANY_ATTEMPTS",
                f"Trop de tentatives pour « {actor_id} » : réessayez dans quelques minutes.",
            )
        try:
            actor = verify_secret(actor_id, secret, root=self.actors_root)
        except ActorError as error:
            if error.code in {"AUTHENTICATION_FAILED", "INVALID_ACTOR_ID", "ACTOR_UNKNOWN"}:
                self.sessions.register_failure(actor_id)
            raise refusal(error.code, error.message, error.blockers) from error
        self.sessions.clear_failures(actor_id)
        session = self.sessions.open(str(actor["actor_id"]), str(actor["role"]))
        self._send(
            200,
            {
                "authenticated": True,
                "actor": {
                    "actor_id": session.actor_id,
                    "display_name": actor.get("display_name"),
                    "role": session.role,
                },
                "csrf_token": session.csrf_token,
                "sessions": self.sessions.count(),
                "realtime": False,
                "session": {
                    "actor_id": session.actor_id,
                    "display_name": actor.get("display_name"),
                    "role": session.role,
                    "role_label": actor.get("role_label"),
                    "opened_at": session.created_at.isoformat(),
                    "expires_at": session.expires_at.isoformat(),
                },
                "method": "console-session",
                "secret_stored": "hash scrypt uniquement (aucun secret en clair sur le disque)",
            },
            cookies=[session_cookie(session, ttl_seconds=self.sessions.ttl_seconds, secure=self._is_secure_context())],
        )
        return {}

    def _logout(self) -> dict[str, Any]:
        session = self._require_session(write=True)
        closed = self.sessions.close(session.session_id)
        self._send(
            200,
            {
                "authenticated": False,
                "closed": closed,
                "actor_id": session.actor_id,
                "message": "Session fermée ; le cookie a été effacé.",
                "realtime": False,
            },
            cookies=[cleared_session_cookie(secure=self._is_secure_context())],
        )
        return {}

    def _dataset_action(self, path: str, match: re.Match[str]) -> dict[str, Any]:
        dataset_id = unquote(match.group("dataset_id"))
        action = match.group("action")
        if not DATASET_ID_RE.fullmatch(dataset_id):
            raise _not_found("Identifiant de dataset invalide.")
        payload = self._read_json()
        if action == "decision":
            return self._record_decision(dataset_id, payload)
        if action == "revert":
            return self._revert_decision(dataset_id, payload)
        return self._publish(dataset_id, payload)

    def _require_dataset(self, dataset_id: str) -> None:
        """Refuse a version that does not exist, exactly like the read routes do.

        A staged version that is present but damaged is not the same thing: the
        decision functions report that themselves, with their own blockers.
        """
        dataset_loader(self.root, dataset_id)()

    def _record_decision(self, dataset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        decision = str(payload.get("decision") or "").strip().lower()
        if decision not in DECISIONS:
            raise ApiError(400, "INVALID_REQUEST", "Le champ « decision » doit valoir « approve » ou « reject ».")
        session = self._require_session(role="reviewer", write=True)
        self._require_dataset(dataset_id)
        proof = session.as_authentication().as_proof()
        try:
            if decision == "approve":
                attestations = self._attestations_from_payload(payload.get("attestations"))
                result = approve_dataset(
                    self.root,
                    dataset_id,
                    proof=proof,
                    attestations=attestations,
                    note=self._optional_text(payload.get("note"), "note", 400),
                )
                return self._settle(result, "APPROVE")
            return self._settle(
                reject_dataset(
                    self.root,
                    dataset_id,
                    proof=proof,
                    reason=self._required_text(payload.get("reason"), "reason", 12, 400),
                ),
                "REJECT",
            )
        except ReviewError as error:
            raise refusal(error.code, error.message, error.blockers) from error

    def _revert_decision(self, dataset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(role="reviewer", write=True)
        self._require_dataset(dataset_id)
        try:
            result = revert_decision(
                self.root,
                dataset_id,
                proof=session.as_authentication().as_proof(),
                entry_id=self._required_text(payload.get("entry_id"), "entry_id", 3, 64),
                reason=self._required_text(payload.get("reason"), "reason", 12, 400),
            )
        except ReviewError as error:
            raise refusal(error.code, error.message, error.blockers) from error
        return self._settle(result, "REVERT_DECISION")

    def _publish(self, dataset_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(role="publisher", write=True)
        self._require_dataset(dataset_id)
        try:
            result = publish_dataset(
                self.root,
                self.published_root,
                dataset_id,
                proof=session.as_authentication().as_proof(),
                note=self._required_text(payload.get("note"), "note", 12, 400),
            )
        except (PublicationError, LedgerLockTimeout, ReviewError, SnapshotError) as error:
            raise refusal(error.code, error.message, getattr(error, "blockers", [])) from error
        return self._settle(result, "PUBLISH")

    def _revert_publication(self, payload: dict[str, Any]) -> dict[str, Any]:
        session = self._require_session(role="publisher", write=True)
        snapshot_id = payload.get("snapshot_id")
        if snapshot_id is not None and not isinstance(snapshot_id, str):
            raise ApiError(400, "INVALID_REQUEST", "« snapshot_id » doit être une chaîne ou absent.")
        try:
            result = revert_publication(
                self.published_root,
                proof=session.as_authentication().as_proof(),
                reason=self._required_text(payload.get("reason"), "reason", 12, 400),
                snapshot_id=(snapshot_id or None),
            )
        except (PublicationError, LedgerLockTimeout, ReviewError, SnapshotError) as error:
            raise refusal(error.code, error.message, getattr(error, "blockers", [])) from error
        return self._settle(result, "REVERT_PUBLICATION")

    def _attestations_from_payload(self, raw: Any) -> dict[str, dict[str, str | None]]:
        """Accept the same `item=preuve` pairs as `--attest`, and validate them the same way."""
        if raw is None:
            return parse_attestations(None, None)
        if not isinstance(raw, dict):
            raise ApiError(400, "INVALID_REQUEST", "« attestations » doit être un objet { item: { evidence, reference } }.")
        items: list[str] = []
        references: list[str] = []
        for item, value in raw.items():
            if not isinstance(value, dict):
                raise ApiError(400, "INVALID_REQUEST", f"L’attestation « {item} » doit être un objet.")
            evidence = value.get("evidence")
            if not isinstance(evidence, str) or not evidence.strip():
                raise ApiError(400, "INVALID_REQUEST", f"L’attestation « {item} » doit porter une preuve.")
            items.append(f"{item}={evidence}")
            reference = value.get("reference")
            if reference:
                references.append(f"{item}={reference}")
        try:
            return parse_attestations(items, references)
        except ReviewError as error:
            raise refusal(error.code, error.message, error.blockers) from error

    def _required_text(self, value: Any, field: str, minimum: int, maximum: int) -> str:
        if not isinstance(value, str):
            raise ApiError(400, "INVALID_REQUEST", f"Le champ « {field} » est exigé.")
        text = " ".join(value.split())
        if len(text) < minimum:
            raise ApiError(400, "INVALID_REQUEST", f"« {field} » doit contenir au moins {minimum} caractères.")
        if len(text) > maximum:
            raise ApiError(400, "INVALID_REQUEST", f"« {field} » ne peut pas dépasser {maximum} caractères.")
        return text

    def _optional_text(self, value: Any, field: str, maximum: int) -> str | None:
        if value in (None, ""):
            return None
        return self._required_text(value, field, 3, maximum)

    def _settle(self, result: dict[str, Any], action: str) -> dict[str, Any]:
        """Wrap a domain result with what the console needs to show next."""
        return {
            **result,
            "action": action,
            "publication_status": self._publication_status(),
            "decided_by": (result.get("authentication") or {}).get("actor_id"),
        }

    def _handle_write(self) -> None:
        raw_path, _, _query = self.path.partition("?")
        path = raw_path.rstrip("/") or "/"
        match = DATASET_ACTION_RE.match(path)
        try:
            if self.command == "POST" and path == f"{API_PREFIX}/session":
                self._login()
                return
            if self.command == "DELETE" and path == f"{API_PREFIX}/session":
                self._logout()
                return
            if self.command == "POST" and match is not None:
                self._send(200, self._dataset_action(path, match))
                return
            if self.command == "POST" and path == PUBLICATION_REVERT_PATH:
                self._send(200, self._revert_publication(self._read_json()))
                return
            self._refuse_write()
        except ApiError as error:
            self._send_refusal(error)
        except (ReviewError, PublicationError, LedgerLockTimeout, SnapshotError, ActorError) as error:
            self._send_refusal(refusal(error.code, error.message, getattr(error, "blockers", [])))
        except ValueError as error:
            self.log_error("gouvernance indisponible : %s", error)
            self._send(
                500,
                {
                    "error": "GOVERNANCE_UNAVAILABLE",
                    "message": "La gouvernance locale est indisponible. Consultez le journal du serveur.",
                    "publication_status": self._publication_status(),
                },
            )

    do_POST = _handle_write  # noqa: N815 - http.server API
    do_DELETE = _handle_write  # noqa: N815 - http.server API

    def do_PUT(self) -> None:  # noqa: N802 - http.server API
        self._refuse_write()

    do_PATCH = do_PUT  # noqa: N815 - http.server API
    do_OPTIONS = do_PUT  # noqa: N815 - http.server API

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - http.server API
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)


def create_server(
    root: str | Path,
    host: str,
    port: int,
    *,
    published_root: str | Path | None = None,
    actors_root: str | Path | None = None,
    session_ttl_seconds: int = SESSION_TTL_SECONDS,
    allowed_hosts: Iterable[str] = (),
    quiet: bool = False,
) -> ThreadingHTTPServer:
    resolved_root = Path(root)
    resolved_published = Path(published_root) if published_root is not None else resolved_root.parent / "published"
    resolved_actors = Path(actors_root) if actors_root is not None else REGISTRY_DIRECTORY
    handler_class = type(
        "BoundAdminApiHandler",
        (AdminApiHandler,),
        {
            "root": resolved_root,
            "published_root": resolved_published,
            "actors_root": resolved_actors,
            "sessions": SessionStore(ttl_seconds=session_ttl_seconds),
            "base_router": make_router(resolved_root, resolved_published),
            "allowed_hosts": tuple(allowed_hosts),
        },
    )
    server = ThreadingHTTPServer((host, port), handler_class)
    server.daemon_threads = True
    server.quiet = quiet  # type: ignore[attr-defined]
    return server


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Sert les données publiées en lecture seule et enregistre les décisions de la console "
            "avec un compte local authentifié."
        )
    )
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    parser.add_argument("--published-root", type=Path, default=Path("data/published"), help="Répertoire des snapshots publiés")
    parser.add_argument(
        "--actors-root",
        type=Path,
        default=REGISTRY_DIRECTORY,
        help="Répertoire du registre d’acteurs (comptes locaux, ignoré par Git)",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Interface d’écoute (0.0.0.0 pour un aperçu distant)")
    parser.add_argument("--port", type=int, default=8787, help="Port d’écoute")
    parser.add_argument(
        "--session-ttl",
        type=int,
        default=SESSION_TTL_SECONDS,
        help="Durée de vie d’une session console, en secondes (300 à 86400)",
    )
    parser.add_argument(
        "--allowed-host",
        action="append",
        default=[],
        metavar="HOTE",
        help="Nom d’hôte supplémentaire accepté dans l’en-tête Host (répétable ; la boucle locale est toujours acceptée)",
    )
    parser.add_argument("--quiet", action="store_true", help="Ne pas journaliser les requêtes")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("le port doit être compris entre 0 et 65535")
    if not 300 <= args.session_ttl <= 24 * 3600:
        parser.error("la durée de session doit être comprise entre 300 et 86400 secondes")

    server = create_server(
        args.root,
        args.host,
        args.port,
        published_root=args.published_root,
        actors_root=args.actors_root,
        session_ttl_seconds=args.session_ttl,
        allowed_hosts=args.allowed_host,
        quiet=args.quiet,
    )
    bound_host, bound_port = server.server_address[0], server.server_address[1]
    print(
        f"API publique en lecture seule + console de gouvernance sur http://{bound_host}:{bound_port} "
        f"(staging : {args.root} ; publié : {args.published_root} ; comptes : {args.actors_root})",
        flush=True,
    )
    print(
        "Les décisions exigent une session console (POST /api/session) ou un jeton CLI ; "
        "aucune décision anonyme n’est enregistrée.",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive stop
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
