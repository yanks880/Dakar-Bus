#!/usr/bin/env python3
"""Read-only HTTP API: governance on the staging side, published data on the other.

The governance routes describe staged versions and their review state; the
public routes serve the active published snapshot, and nothing else. This
server never writes: approvals stay on the review CLI, publications on the
publish CLI. Both route groups are GET-only and report honestly when the store
or the journal is unusable.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:  # Works both as `python -m scripts.serve_admin_api` and as a file script.
    from .catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from .publication_ledger import current_publication_state
    from .review_gtfs import review_dossier
    from .review_ledger import current_review_state
    from .serve_read_api import PUBLIC_ROUTES, ApiError, resolve_public_route
    from .snapshot_gtfs import DATA_POLICY, list_snapshots
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE, list_staged_datasets
    from publication_ledger import current_publication_state
    from review_gtfs import review_dossier
    from review_ledger import current_review_state
    from serve_read_api import PUBLIC_ROUTES, ApiError, resolve_public_route
    from snapshot_gtfs import DATA_POLICY, list_snapshots


API_PREFIX = "/api"
DATASET_ROUTE_PREFIX = f"{API_PREFIX}/datasets/"
GOVERNANCE_ROUTES = ("/healthz", "/api/pipeline", "/api/catalog", "/api/datasets/<dataset_id>")

# Kept for callers that imported the older name.
AdminApiError = ApiError


def _known_routes() -> str:
    return ", ".join((*GOVERNANCE_ROUTES, *PUBLIC_ROUTES))


def _not_found(message: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


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
        "/healthz": lambda: {
            "status": "ok",
            "service": "dakar-bus-read-api",
            "mode": "read-only",
            "governance_root": str(root),
            "published_root": str(published_root),
        },
        f"{API_PREFIX}/pipeline": lambda: pipeline_summary(root, published_root=published_root),
        f"{API_PREFIX}/catalog": lambda: catalog_payload(root, published_root=published_root),
    }


class AdminApiHandler(BaseHTTPRequestHandler):
    server_version = "DakarBusReadApi/1.1"
    root: Path
    published_root: Path
    base_router: dict[str, Callable[[], dict[str, Any]]]

    def _publication_status(self) -> str:
        try:
            return str(current_publication_state(self.published_root)["publication_status"])
        except (ValueError, OSError):  # pragma: no cover - unreadable store
            return "UNKNOWN"

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

    def _resolve(self, path: str, query: str) -> dict[str, Any]:
        route = self.base_router.get(path)
        if route is not None:
            return route()
        if path.startswith(DATASET_ROUTE_PREFIX):
            return dataset_loader(self.root, path[len(DATASET_ROUTE_PREFIX):])()
        public = resolve_public_route(path, query, self.published_root)
        if public is not None:
            return public()
        raise _not_found(f"Ressource inconnue ; l’API en lecture seule expose : {_known_routes()}.")

    def _handle(self) -> None:
        raw_path, _, query = self.path.partition("?")
        path = raw_path.rstrip("/") or "/"
        try:
            self._send(200, self._resolve(path, query))
        except ApiError as error:
            self._send(
                error.status,
                {"error": error.code, "message": error.message, "publication_status": self._publication_status()},
            )
        except ValueError as error:
            self._send(
                500,
                {"error": "CATALOG_UNAVAILABLE", "message": str(error), "publication_status": self._publication_status()},
            )

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    def do_HEAD(self) -> None:  # noqa: N802 - http.server API
        self._handle()

    def _refuse_write(self) -> None:
        self._send(
            405,
            {
                "error": "READ_ONLY_API",
                "message": (
                    "Cette API est en lecture seule ; les décisions de revue passent par scripts/review_gtfs.py "
                    "et les publications par scripts/publish_gtfs.py."
                ),
                "publication_status": self._publication_status(),
            },
        )

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = _refuse_write  # noqa: N815 - http.server API

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
    quiet: bool = False,
) -> ThreadingHTTPServer:
    resolved_root = Path(root)
    resolved_published = Path(published_root) if published_root is not None else resolved_root.parent / "published"
    handler_class = type(
        "BoundAdminApiHandler",
        (AdminApiHandler,),
        {
            "root": resolved_root,
            "published_root": resolved_published,
            "base_router": make_router(resolved_root, resolved_published),
        },
    )
    server = ThreadingHTTPServer((host, port), handler_class)
    server.daemon_threads = True
    server.quiet = quiet  # type: ignore[attr-defined]
    return server


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sert en lecture seule la gouvernance du staging et les données du snapshot publié."
    )
    parser.add_argument("--root", type=Path, default=Path("data/staging"), help="Répertoire local de staging")
    parser.add_argument("--published-root", type=Path, default=Path("data/published"), help="Répertoire des snapshots publiés")
    parser.add_argument("--host", default="127.0.0.1", help="Interface d’écoute (0.0.0.0 pour un aperçu distant)")
    parser.add_argument("--port", type=int, default=8787, help="Port d’écoute")
    parser.add_argument("--quiet", action="store_true", help="Ne pas journaliser les requêtes")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("le port doit être compris entre 0 et 65535")

    server = create_server(args.root, args.host, args.port, published_root=args.published_root, quiet=args.quiet)
    bound_host, bound_port = server.server_address[0], server.server_address[1]
    print(
        f"API en lecture seule sur http://{bound_host}:{bound_port} "
        f"(staging : {args.root} ; publié : {args.published_root})",
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
