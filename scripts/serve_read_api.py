#!/usr/bin/env python3
"""Public read API over the published snapshot, mounted by the admin server.

Everything here answers from the active published snapshot and nothing else:
when no snapshot is published, when the journal is broken or when the file no
longer matches the recorded hash, the API says so instead of serving something
else. The routes are GET-only, relative-URL friendly and free of any realtime
claim.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

try:  # Works both as `python -m scripts.serve_read_api` and as a file script.
    from .network_graph import (
        GraphError,
        find_direct_journeys,
        graph_status,
        load_graph,
        resolve_place,
    )
    from .publish_gtfs import publications_summary
    from .snapshot_gtfs import (
        DATA_POLICY,
        SnapshotError,
        connect_read_only,
        list_routes,
        resolve_active_snapshot,
        route_detail,
        search_stops,
        stop_detail,
        stops_near,
    )
except ImportError:  # pragma: no cover - exercised by the direct CLI entry point
    from network_graph import (
        GraphError,
        find_direct_journeys,
        graph_status,
        load_graph,
        resolve_place,
    )
    from publish_gtfs import publications_summary
    from snapshot_gtfs import (
        DATA_POLICY,
        SnapshotError,
        connect_read_only,
        list_routes,
        resolve_active_snapshot,
        route_detail,
        search_stops,
        stop_detail,
        stops_near,
    )


PUBLIC_ROUTES = (
    "/api/network",
    "/api/publications",
    "/api/routes",
    "/api/routes/<route_id>",
    "/api/stops/search",
    "/api/stops/near",
    "/api/stops/<stop_id>",
    "/api/journeys",
)

JOURNEY_LIMITATIONS = (
    "Le moteur ne propose que des courses directes déclarées dans le flux : une seule montée, une seule descente, "
    "et un cheminement à pied uniquement par correspondances déclarées, stations parentes ou arrêts proches. "
    "Les itinéraires à correspondance, les positions de véhicules et les estimations temps réel ne sont pas implémentés."
)

MAX_IDENTIFIER_LENGTH = 120


class ApiError(Exception):
    """A request was refused; the body explains why without inventing data."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _not_found(message: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", message)


def _not_published(publication_status: str) -> ApiError:
    return ApiError(
        404,
        "NOT_PUBLISHED",
        "Aucun snapshot publié n’est servi pour le moment : "
        f"l’état de publication vaut « {publication_status} ».",
    )


def _generated_at(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()


def _integer(parameters: dict[str, list[str]], name: str, default: int, minimum: int, maximum: int) -> int:
    raw = parameters.get(name)
    if not raw:
        return default
    try:
        value = int(raw[0])
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {name} » doit être un entier.") from None
    if not minimum <= value <= maximum:
        raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {name} » doit être compris entre {minimum} et {maximum}.")
    return value


def _number(parameters: dict[str, list[str]], name: str, default: float, minimum: float, maximum: float) -> float:
    raw = parameters.get(name)
    if not raw:
        return default
    try:
        value = float(raw[0])
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {name} » doit être un nombre.") from None
    if not minimum <= value <= maximum:
        raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {name} » doit être compris entre {minimum} et {maximum}.")
    return value


def _single_text(parameters: dict[str, list[str]], name: str, *, required: bool = True) -> str:
    raw = parameters.get(name)
    if not raw or not raw[0].strip():
        if required:
            raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {name} » est obligatoire.")
        return ""
    return raw[0]


def _identifier(raw: str, label: str) -> str:
    candidate = raw.strip()
    if not candidate or len(candidate) > MAX_IDENTIFIER_LENGTH or "/" in candidate or "\\" in candidate:
        raise _not_found(f"{label} invalide.")
    return candidate


def _active(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    active = resolve_active_snapshot(published_root, now=now)
    if not active["available"]:
        raise _not_published(str(active["publication_status"]))
    return active


def _open(published_root: str | Path, active: dict[str, Any]) -> Any:
    snapshot = active["snapshot"]
    assert isinstance(snapshot, dict)
    return connect_read_only(Path(published_root) / str(snapshot["snapshot_id"]))


def network_payload(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """What the app may show right now, including the honest « nothing yet » state."""
    active = resolve_active_snapshot(published_root, now=now)
    payload: dict[str, Any] = {
        "generated_at": _generated_at(now),
        "available": active["available"],
        "publication_status": active["publication_status"],
        "publication_journal_integrity": active["publication_journal_integrity"],
        "published_at": active.get("published_at"),
        "publisher_id": active.get("publisher_id"),
        "separation_of_duties": active.get("separation_of_duties"),
        "snapshot": active.get("snapshot"),
        "dataset": active.get("dataset"),
        "review": active.get("review"),
        "blocked_reason": active.get("blocked_reason"),
        "graph": graph_status(published_root, now=now),
        "data_policy": DATA_POLICY,
        "realtime": False,
    }
    if not active["available"]:
        payload["message"] = (
            "Aucun jeu de données n’est publié : la carte reste une carte de fond OpenStreetMap "
            "et le calcul d’itinéraire reste indisponible."
        )
    else:
        payload["message"] = "Snapshot publié servi en lecture seule ; horaires théoriques, aucun temps réel."
    return payload


def publications_payload(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    summary = publications_summary(published_root, now=now)
    summary["data_policy"] = DATA_POLICY
    return summary


def stops_search_payload(published_root: str | Path, parameters: dict[str, list[str]], *, now: datetime | None = None) -> dict[str, Any]:
    query = _single_text(parameters, "q")
    if len(query) > 120:
        raise ApiError(400, "INVALID_QUERY", "La recherche est limitée à 120 caractères.")
    limit = _integer(parameters, "limit", 20, 1, 100)
    active = _active(published_root, now=now)
    connection = _open(published_root, active)
    try:
        results = search_stops(connection, query, limit=limit)
    except SnapshotError as error:
        raise ApiError(400, error.code, str(error)) from error
    finally:
        connection.close()
    return {
        "generated_at": _generated_at(now),
        "query": query,
        "count": len(results),
        "results": results,
        "snapshot_id": active["snapshot"]["snapshot_id"],
        "publication_status": active["publication_status"],
        "data_policy": DATA_POLICY,
        "realtime": False,
    }


def stops_near_payload(published_root: str | Path, parameters: dict[str, list[str]], *, now: datetime | None = None) -> dict[str, Any]:
    latitude = _number(parameters, "lat", 0.0, -90.0, 90.0)
    longitude = _number(parameters, "lon", 0.0, -180.0, 180.0)
    if not parameters.get("lat") or not parameters.get("lon"):
        raise ApiError(400, "INVALID_QUERY", "Les paramètres « lat » et « lon » sont obligatoires.")
    radius = _number(parameters, "radius", 800.0, 1.0, 5000.0)
    limit = _integer(parameters, "limit", 20, 1, 100)
    active = _active(published_root, now=now)
    connection = _open(published_root, active)
    try:
        results = stops_near(connection, latitude, longitude, radius_m=radius, limit=limit)
    except SnapshotError as error:
        raise ApiError(400, error.code, str(error)) from error
    finally:
        connection.close()
    return {
        "generated_at": _generated_at(now),
        "origin": {"lat": latitude, "lon": longitude},
        "radius_m": radius,
        "count": len(results),
        "results": results,
        "snapshot_id": active["snapshot"]["snapshot_id"],
        "publication_status": active["publication_status"],
        "data_policy": DATA_POLICY,
        "realtime": False,
    }


def stop_payload(published_root: str | Path, stop_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    identifier = _identifier(stop_id, "Identifiant d’arrêt")
    active = _active(published_root, now=now)
    connection = _open(published_root, active)
    try:
        detail = stop_detail(connection, identifier)
    except SnapshotError as error:
        raise ApiError(400, error.code, str(error)) from error
    finally:
        connection.close()
    if detail is None:
        raise _not_found(f"Aucun arrêt « {identifier} » dans le snapshot publié.")
    return {
        "generated_at": _generated_at(now),
        "stop": detail,
        "snapshot_id": active["snapshot"]["snapshot_id"],
        "publication_status": active["publication_status"],
        "data_policy": DATA_POLICY,
        "realtime": False,
    }


def route_payload(published_root: str | Path, route_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    identifier = _identifier(route_id, "Identifiant de ligne")
    active = _active(published_root, now=now)
    connection = _open(published_root, active)
    try:
        detail = route_detail(connection, identifier)
    except SnapshotError as error:
        raise ApiError(400, error.code, str(error)) from error
    finally:
        connection.close()
    if detail is None:
        raise _not_found(f"Aucune ligne « {identifier} » dans le snapshot publié.")
    return {
        "generated_at": _generated_at(now),
        "route": detail,
        "snapshot_id": active["snapshot"]["snapshot_id"],
        "publication_status": active["publication_status"],
        "data_policy": DATA_POLICY,
        "realtime": False,
    }


def routes_payload(published_root: str | Path, parameters: dict[str, list[str]], *, now: datetime | None = None) -> dict[str, Any]:
    limit = _integer(parameters, "limit", 100, 1, 500)
    active = _active(published_root, now=now)
    connection = _open(published_root, active)
    try:
        results = list_routes(connection, limit=limit)
    except SnapshotError as error:
        raise ApiError(400, error.code, str(error)) from error
    finally:
        connection.close()
    return {
        "generated_at": _generated_at(now),
        "count": len(results),
        "results": results,
        "snapshot_id": active["snapshot"]["snapshot_id"],
        "publication_status": active["publication_status"],
        "data_policy": DATA_POLICY,
        "realtime": False,
    }


def _coordinates(parameters: dict[str, list[str]], prefix: str) -> tuple[float, float] | None:
    latitude_raw = parameters.get(f"{prefix}_lat")
    longitude_raw = parameters.get(f"{prefix}_lon")
    if not latitude_raw and not longitude_raw:
        return None
    if not latitude_raw or not longitude_raw:
        raise ApiError(400, "INVALID_QUERY", f"« {prefix}_lat » et « {prefix}_lon » doivent être fournis ensemble.")
    latitude = _number(parameters, f"{prefix}_lat", 0.0, -90.0, 90.0)
    longitude = _number(parameters, f"{prefix}_lon", 0.0, -180.0, 180.0)
    return latitude, longitude


def _parse_at(parameters: dict[str, list[str]]) -> datetime | None:
    raw = parameters.get("at")
    if not raw or not raw[0].strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw[0].strip().replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, "INVALID_QUERY", "Le paramètre « at » doit être une date/heure ISO 8601.") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ApiError(400, "INVALID_QUERY", "Le paramètre « at » doit inclure un fuseau horaire, par exemple +00:00.")
    return parsed.astimezone(timezone.utc)


def _endpoint(graph: dict[str, Any], parameters: dict[str, list[str]], prefix: str, label: str) -> dict[str, Any]:
    """Either a place name from the feed, or explicit coordinates, never a guess."""
    coordinates = _coordinates(parameters, prefix)
    query = parameters.get(prefix)
    if coordinates is None and (not query or not query[0].strip()):
        raise ApiError(400, "INVALID_QUERY", f"Indiquez « {prefix} » (nom ou identifiant) ou « {prefix}_lat/{prefix}_lon ».")
    if coordinates is not None:
        return {
            "input": f"{coordinates[0]:.5f}, {coordinates[1]:.5f}",
            "origin": "coordinates",
            "coordinates": {"lat": coordinates[0], "lon": coordinates[1]},
            "place": None,
            "alternatives": [],
            "point": coordinates,
        }
    text = str(query[0]).strip()
    if len(text) > 120:
        raise ApiError(400, "INVALID_QUERY", f"Le paramètre « {prefix} » est limité à 120 caractères.")
    try:
        places = resolve_place(graph, text)
    except GraphError as error:
        raise ApiError(400, error.code, str(error)) from error
    if not places:
        raise ApiError(
            404,
            "PLACE_NOT_FOUND",
            f"Aucun arrêt publié ne correspond à « {text} » ({label}). Aucun lieu n’est deviné.",
        )
    chosen = places[0]
    latitude = chosen.get("lat")
    longitude = chosen.get("lon")
    if not isinstance(latitude, (int, float)) or not isinstance(longitude, (int, float)):
        raise ApiError(409, "PLACE_UNUSABLE", f"Le lieu « {chosen.get('label')} » n’a pas de coordonnées déclarées.")
    return {
        "input": text,
        "origin": "published-stop",
        "coordinates": {"lat": latitude, "lon": longitude},
        "place": {
            "place_id": chosen.get("place_id"),
            "label": chosen.get("label"),
            "kind": chosen.get("kind"),
            "stop_ids": chosen.get("stop_ids"),
        },
        "alternatives": [
            {"place_id": place.get("place_id"), "label": place.get("label"), "kind": place.get("kind")}
            for place in places[1:5]
        ],
        "point": (float(latitude), float(longitude)),
    }


def journeys_payload(published_root: str | Path, parameters: dict[str, list[str]], *, now: datetime | None = None) -> dict[str, Any]:
    """Direct journeys between two published places, at a stated time."""
    active = _active(published_root, now=now)
    status = graph_status(published_root, now=now)
    try:
        graph = load_graph(published_root, now=now)
    except GraphError as error:
        raise ApiError(
            409,
            error.code,
            f"{error} Reconstruire le graphe avec « npm run publish:gtfs -- graph-rebuild ».",
        ) from error

    origin = _endpoint(graph, parameters, "origin", "départ")
    destination = _endpoint(graph, parameters, "destination", "arrivée")
    at = _parse_at(parameters)
    max_walk = _number(parameters, "max_walk_m", 900.0, 50.0, 2000.0)
    if origin["point"] == destination["point"]:
        raise ApiError(400, "INVALID_QUERY", "Le départ et l’arrivée sont au même endroit.")

    journey = find_direct_journeys(
        graph,
        origin["point"],
        destination["point"],
        at=at,
        max_walk_m=max_walk,
    )
    snapshot = active["snapshot"]
    assert isinstance(snapshot, dict)
    payload = {
        "generated_at": _generated_at(now),
        "snapshot_id": snapshot["snapshot_id"],
        "publication_status": active["publication_status"],
        "graph": {
            "built_at": graph.get("built_at"),
            "snapshot_id": (graph.get("snapshot") or {}).get("snapshot_id"),
            "stats": graph.get("stats"),
            "capabilities": graph.get("capabilities"),
            "parameters": graph.get("parameters"),
        },
        "origin": {key: value for key, value in origin.items() if key != "point"},
        "destination": {key: value for key, value in destination.items() if key != "point"},
        "requested_at": journey["requested_at"],
        "local_day": journey["local_day"],
        "max_walk_m": max_walk,
        "start_walk_m": journey["start_walk_m"],
        "reason": journey["reason"],
        "boarding_stops": journey["boarding_stops"],
        "alighting_stops": journey["alighting_stops"],
        "days_checked": journey["days_checked"],
        "results": journey["results"],
        "result_count": len(journey["results"]),
        "result_date": journey["result_date"],
        "exhausted_today": journey["exhausted_today"],
        "next_service_date": journey["next_service_date"],
        "message": journey["message"],
        "limitations": JOURNEY_LIMITATIONS,
        "data_policy": DATA_POLICY,
        "realtime": False,
    }
    if journey["results"] and journey["results"][0].get("date") != journey["local_day"]:
        payload["message"] = (
            "Plus aucune course directe ne part aujourd’hui : la première course déclarée est proposée "
            f"le {journey['results'][0]['date']}, avec sa date explicite."
        )
    return payload


def resolve_public_route(path: str, query: str, published_root: str | Path) -> Callable[[], dict[str, Any]] | None:
    """Match one public route, or return None so the caller reports a 404."""
    parameters = parse_qs(query, keep_blank_values=True)
    if path == "/api/network":
        return lambda: network_payload(published_root)
    if path == "/api/publications":
        return lambda: publications_payload(published_root)
    if path == "/api/routes":
        return lambda: routes_payload(published_root, parameters)
    if path == "/api/stops/search":
        return lambda: stops_search_payload(published_root, parameters)
    if path == "/api/stops/near":
        return lambda: stops_near_payload(published_root, parameters)
    if path.startswith("/api/stops/"):
        return lambda: stop_payload(published_root, path[len("/api/stops/"):])
    if path.startswith("/api/routes/"):
        return lambda: route_payload(published_root, path[len("/api/routes/"):])
    if path == "/api/journeys":
        return lambda: journeys_payload(published_root, parameters)
    return None
