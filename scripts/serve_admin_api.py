#!/usr/bin/env python3
"""Read-only HTTP API over the staged GTFS catalog and its review ledger.

This server never writes: approvals, rejections and rollbacks stay on the
review CLI, where a named reviewer is required. The API only exposes what the
catalog already verifies, so a console can display governance state without
being able to alter it.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

try:  # Works both as `python -m scripts.serve_admin_api` and as a file script.
    from .catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from .review_gtfs import review_dossier
    from .review_ledger import current_review_state
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from review_gtfs import review_dossier
    from review_ledger import current_review_state


API_PREFIX = "/api"
DATASET_ROUTE_PREFIX = f"{API_PREFIX}/datasets/"
DATA_POLICY = (
    "Lecture seule : aucune donnée de transport n’est publiée et aucune décision de revue "
    "ne peut être enregistrée via cette API."
)


def pipeline_summary(root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Count datasets per governance stage. Publication is always zero here."""
    entries = list_staged_datasets(root, now=now)
    counts = {
        "staged": len(entries),
        "integrity_invalid": 0,
        "pending_review": 0,
        "approved": 0,
        "rejected": 0,
        "review_unknown": 0,
        "published": 0,
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

    return {
        "generated_at": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "counts": counts,
        "stages": [
            {"id": "staged", "label": "Staging", "count": counts["staged"], "note": "Archive copiée avec provenance déclarée."},
            {"id": "pending_review", "label": "En revue", "count": counts["pending_review"], "note": "En attente d’une décision humaine nominative."},
            {"id": "approved", "label": "Approuvé", "count": counts["approved"], "note": "Attestations complètes ; publication toujours séparée."},
            {"id": "rejected", "label": "Refusé", "count": counts["rejected"], "note": "Motif enregistré dans le journal."},
            {"id": "published", "label": "Publié", "count": counts["published"], "note": "La publication n’est pas encore implémentée."},
        ],
        "integrity_invalid": counts["integrity_invalid"],
        "review_unknown": counts["review_unknown"],
        "data_policy": DATA_POLICY,
        "publication_status": "NOT_PUBLISHED",
    }


def catalog_payload(root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    return {
        "generated_at": (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "root": Path(root).name or str(root),
        "datasets": list_staged_datasets(root, now=now),
        "data_policy": DATA_POLICY,
        "publication_status": "NOT_PUBLISHED",
    }


class AdminApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _not_found(message: str) -> AdminApiError:
    return AdminApiError(404, "NOT_FOUND", message)


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


def make_router(root: Path) -> dict[str, Callable[[], dict[str, Any]]]:
    """Exact-match routes only; identifiers are validated before touching disk."""
    return {
        "/healthz": lambda: {"status": "ok", "service": "dakar-bus-admin-api", "mode": "read-only"},
        f"{API_PREFIX}/pipeline": lambda: pipeline_summary(root),
        f"{API_PREFIX}/catalog": lambda: catalog_payload(root),
    }


class AdminApiHandler(BaseHTTPRequestHandler):
    server_version = "DakarBusAdminApi/1.0"
    root: Path
    base_router: dict[str, Callable[[], dict[str, Any]]]

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _resolve(self, path: str) -> dict[str, Any]:
        route = self.base_router.get(path)
        if route is None and path.startswith(DATASET_ROUTE_PREFIX):
            route = dataset_loader(self.root, path[len(DATASET_ROUTE_PREFIX):])
        if route is None:
            raise _not_found(
                "Ressource inconnue ; l’API n’expose que /healthz, /api/pipeline, /api/catalog et /api/datasets/<dataset_id>."
            )
        return route()

    def _handle(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            self._send(200, self._resolve(path))
        except AdminApiError as error:
            self._send(error.status, {"error": error.code, "message": error.message, "publication_status": "NOT_PUBLISHED"})
        except ValueError as error:
            self._send(500, {"error": "CATALOG_UNAVAILABLE", "message": str(error), "publication_status": "NOT_PUBLISHED"})

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    def do_HEAD(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    def _refuse_write(self) -> None:
        self._send(
            405,
            {
                "error": "READ_ONLY_API",
                "message": "Cette API est en lecture seule ; les décisions de revue passent par scripts/review_gtfs.py.",
                "publication_status": "NOT_PUBLISHED",
            },
        )

    do_POST = do_PUT = do_PATCH = do_DELETE = _refuse_write  # noqa: N815 - http.server API

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - http.server API
        if getattr(self.server, "quiet", False):
            return
        super().log_message(format, *args)


def create_server(root: str | Path, host: str, port: int, *, quiet: bool = False) -> ThreadingHTTPServer:
    resolved_root = Path(root)
    handler_class = type(
        "BoundAdminApiHandler",
        (AdminApiHandler,),
        {"root": resolved_root, "base_router": make_router(resolved_root)},
    )
    server = ThreadingHTTPServer((host, port), handler_class)
    server.daemon_threads = True
    server.quiet = quiet  # type: ignore[attr-defined]
    return server


def main() -> int:
    parser = argparse.ArgumentParser(description="Sert le catalogue et l’état de revue en lecture seule.")
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    parser.add_argument("--host", default="127.0.0.1", help="Interface d’écoute (0.0.0.0 pour un aperçu distant)")
    parser.add_argument("--port", type=int, default=8787, help="Port d’écoute")
    parser.add_argument("--quiet", action="store_true", help="Ne pas journaliser les requêtes")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("le port doit être compris entre 0 et 65535")

    server = create_server(args.root, args.host, args.port, quiet=args.quiet)
    bound_host, bound_port = server.server_address[0], server.server_address[1]
    print(f"API admin en lecture seule sur http://{bound_host}:{bound_port} (racine : {args.root})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - interactive stop
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
