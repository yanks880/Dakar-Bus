#!/usr/bin/env python3
"""Persistent routing graph built from a published snapshot.

The graph is derived data: it is rebuilt only from the active published
snapshot, it records the revision it came from, and it is refused the moment it
does not match what is published. That keeps the honest rule of this project:
one published truth, no guessed network.

What the graph supports today:

- a network walk from a point: the stops within 400 m of the point are the
  starting points, and the walk then follows explicit `transfers.txt` rows, stays
  inside the same parent station, or extends to stops whose declared coordinates
  are within the short-walk radius, up to the requested walking radius;
- direct rides: the first declared departure from the boarding cluster, the
  earliest declared arrival at the destination cluster, with the trip's service
  calendar checked against the requested date.

What it does not do — and never simulates — is a multi-leg itinerary with
guaranteed correspondences, vehicle positions, or any realtime estimate.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from .catalog_gtfs import DATASET_ID_RE
    from .snapshot_gtfs import DATABASE_FILENAME, connect_read_only
except ImportError:  # pragma: no cover - direct CLI entry point
    from catalog_gtfs import DATASET_ID_RE
    from snapshot_gtfs import DATABASE_FILENAME, connect_read_only

GRAPH_SCHEMA_VERSION = "1.0"
GRAPH_FILENAME = "network.graph.json"
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
TIME_RE = re.compile(r"^(\d{1,3}):([0-5]\d):([0-5]\d)$")
WEEKDAY_KEYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

DEFAULT_CLUSTER_RADIUS_M = 250.0
DEFAULT_NEARBY_WALK_RADIUS_M = 400.0
DEFAULT_START_WALK_M = 400.0
DEFAULT_MAX_WALK_M = 900.0
MAX_PLACES = 20000
EARTH_RADIUS_M = 6_371_008.8

DATA_POLICY = (
    "Graphe dérivé du snapshot publié : arrêts et horaires théoriques déclarés dans le flux. "
    "Aucune position de véhicule, aucune estimation temps réel, aucune correspondance inventée."
)


class GraphError(ValueError):
    """The graph cannot be built or used; nothing is guessed."""

    def __init__(self, code: str, message: str, blockers: list[str] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.blockers = blockers or []


def default_graph_path(published_root: str | Path) -> Path:
    return Path(published_root) / GRAPH_FILENAME


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def haversine_m(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    phi_a, phi_b = math.radians(lat_a), math.radians(lat_b)
    delta_phi = phi_b - phi_a
    delta_lambda = math.radians(lon_b - lon_a)
    inner = math.sin(delta_phi / 2) ** 2 + math.cos(phi_a) * math.cos(phi_b) * math.sin(delta_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(inner)))


def parse_gtfs_time(value: str | None) -> int | None:
    """GTFS times may exceed 24:00:00; they are kept as seconds since noon-12h."""
    if not value:
        return None
    match = TIME_RE.fullmatch(value.strip())
    if not match:
        return None
    hours, minutes, seconds = (int(part) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


def format_gtfs_time(seconds: int | None) -> str | None:
    if seconds is None or seconds < 0:
        return None
    return f"{seconds // 3600:02d}:{(seconds % 3600) // 60:02d}:{seconds % 60:02d}"


def _fold(value: str) -> str:
    accents = str.maketrans("àâäáãåçéèêëìíîïñòóôöõùúûüýÿ", "aaaaaaceeeeiiiinooooouuuuyy")
    return value.casefold().translate(accents)


def _row_or_none(row: sqlite3.Row, column: str) -> str | None:
    value = row[column] if column in row.keys() else None
    return value if isinstance(value, str) and value.strip() else None


def _table_exists(connection: sqlite3.Connection, name: str) -> bool:
    return connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def _rows(connection: sqlite3.Connection, statement: str, parameters: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    return connection.execute(statement, parameters).fetchall()


def _read_snapshot_revision(snapshot_dir: Path) -> dict[str, Any]:
    manifest_path = snapshot_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GraphError("SNAPSHOT_UNREADABLE", f"Le manifeste du snapshot n’est pas lisible : {error}.") from error
    if not isinstance(manifest, dict):
        raise GraphError("SNAPSHOT_UNREADABLE", "Le manifeste du snapshot n’est pas un objet JSON.")
    store = manifest.get("store") or {}
    digest = store.get("sha256") if isinstance(store, dict) else None
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        raise GraphError("SNAPSHOT_UNREADABLE", "Le manifeste du snapshot ne contient pas d’empreinte exploitable.")
    return {
        "snapshot_id": manifest.get("snapshot_id"),
        "database_sha256": digest,
        "built_at": manifest.get("built_at"),
        "dataset": manifest.get("dataset") or {},
        "timezone": manifest.get("timezone"),
        "record_count": manifest.get("record_count") or {},
    }


def _load_calendars(connection: sqlite3.Connection) -> tuple[dict[str, dict[str, Any]], dict[tuple[str, int], int]]:
    services: dict[str, dict[str, Any]] = {}
    if _table_exists(connection, "calendar"):
        for row in _rows(connection, 'SELECT * FROM "calendar"'):
            service_id = _row_or_none(row, "service_id")
            if not service_id:
                continue
            entry: dict[str, Any] = {}
            for key in WEEKDAY_KEYS:
                raw = _row_or_none(row, key)
                entry[key] = 1 if raw and raw.strip() in {"1"} else 0
            entry["start_date"] = _row_or_none(row, "start_date")
            entry["end_date"] = _row_or_none(row, "end_date")
            services[service_id] = entry
    exceptions: dict[tuple[str, int], int] = {}
    if _table_exists(connection, "calendar_dates"):
        for row in _rows(connection, 'SELECT * FROM "calendar_dates"'):
            service_id = _row_or_none(row, "service_id")
            raw_date = _row_or_none(row, "date")
            raw_type = _row_or_none(row, "exception_type")
            if not service_id or not raw_date or not raw_type:
                continue
            try:
                day = int(raw_date)
                kind = int(raw_type)
            except ValueError:
                continue
            exceptions[(service_id, day)] = kind
    return services, exceptions


def _service_active(
    service_id: str,
    day: date,
    services: dict[str, dict[str, Any]],
    exceptions: dict[tuple[str, int], int],
) -> bool:
    """GTFS rule: calendar_dates wins over calendar, and both are required."""
    key = (service_id, int(day.strftime("%Y%m%d")))
    exception = exceptions.get(key)
    if exception == 1:
        return True
    if exception == 2:
        return False
    service = services.get(service_id)
    if not service:
        return False
    start = service.get("start_date")
    end = service.get("end_date")
    if isinstance(start, str):
        try:
            if day < datetime.strptime(start, "%Y%m%d").date():
                return False
        except ValueError:
            return False
    if isinstance(end, str):
        try:
            if day > datetime.strptime(end, "%Y%m%d").date():
                return False
        except ValueError:
            return False
    return service.get(WEEKDAY_KEYS[day.weekday()], 0) == 1


def _read_stops(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    stops: list[dict[str, Any]] = []
    has_parent = False
    headers = {row[1] for row in connection.execute('PRAGMA table_info("stops")')}
    has_parent = "parent_station" in headers
    for row in _rows(connection, 'SELECT * FROM "stops"'):
        stop_id = _row_or_none(row, "stop_id")
        if not stop_id:
            continue
        stops.append(
            {
                "stop_id": stop_id,
                "stop_name": _row_or_none(row, "stop_name") or stop_id,
                "lat": _as_float(_row_or_none(row, "stop_lat")),
                "lon": _as_float(_row_or_none(row, "stop_lon")),
                "location_type": _row_or_none(row, "location_type"),
                "parent_station": _row_or_none(row, "parent_station") if has_parent else None,
            }
        )
    return stops


def _as_float(value: Any) -> float | None:
    try:
        number = float(str(value))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and -400 <= number <= 400 else None


def _read_routes(connection: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    routes: dict[str, dict[str, Any]] = {}
    for row in _rows(connection, 'SELECT * FROM "routes"'):
        route_id = _row_or_none(row, "route_id")
        if not route_id:
            continue
        routes[route_id] = {
            "route_id": route_id,
            "short_name": _row_or_none(row, "route_short_name"),
            "long_name": _row_or_none(row, "route_long_name"),
            "route_type": _row_or_none(row, "route_type"),
        }
    return routes


def _read_trips(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    trips: list[dict[str, Any]] = []
    for row in _rows(connection, 'SELECT * FROM "trips"'):
        trip_id = _row_or_none(row, "trip_id")
        route_id = _row_or_none(row, "route_id")
        service_id = _row_or_none(row, "service_id")
        if not trip_id or not route_id or not service_id:
            continue
        trips.append(
            {
                "trip_id": trip_id,
                "route_id": route_id,
                "service_id": service_id,
                "direction_id": _row_or_none(row, "direction_id"),
            }
        )
    return trips


def _read_stop_times(connection: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
    by_trip: dict[str, list[dict[str, Any]]] = {}
    statement = 'SELECT * FROM "stop_times"'
    for row in _rows(connection, statement):
        trip_id = _row_or_none(row, "trip_id")
        stop_id = _row_or_none(row, "stop_id")
        if not trip_id or not stop_id:
            continue
        arrival = parse_gtfs_time(_row_or_none(row, "arrival_time"))
        departure = parse_gtfs_time(_row_or_none(row, "departure_time"))
        sequence = _row_or_none(row, "stop_sequence")
        try:
            order = int(sequence) if sequence is not None else len(by_trip.get(trip_id, []))
        except ValueError:
            order = len(by_trip.get(trip_id, []))
        by_trip.setdefault(trip_id, []).append(
            {
                "stop_id": stop_id,
                "sequence": order,
                "arrival": arrival,
                "departure": departure if departure is not None else arrival,
            }
        )
    for entries in by_trip.values():
        entries.sort(key=lambda item: item["sequence"])
    return by_trip


def _cluster_stops(stops: list[dict[str, Any]], radius_m: float) -> list[dict[str, Any]]:
    """Group stops into walkable places: stations, explicit clusters, lone stops.

    Clustering is purely geometric and always recorded as such: a cluster is a
    grouping of declared coordinates, never an assertion that a station exists.
    """
    by_id = {stop["stop_id"]: stop for stop in stops}
    grouped: dict[str, list[str]] = {}
    assigned: set[str] = set()

    stations = [stop for stop in stops if stop.get("location_type") == "1"]
    children: dict[str, list[str]] = {}
    for stop in stops:
        parent = stop.get("parent_station")
        if parent and parent in by_id:
            children.setdefault(parent, []).append(stop["stop_id"])

    places: list[dict[str, Any]] = []
    for station in stations:
        members = [station["stop_id"], *children.get(station["stop_id"], [])]
        coordinates = _place_coordinates(members, by_id)
        if coordinates is None:
            continue
        assigned.update(members)
        places.append(
            {
                "place_id": f"station-{station['stop_id']}",
                "kind": "station",
                "label": station["stop_name"],
                "lat": coordinates[0],
                "lon": coordinates[1],
                "stop_ids": sorted(members),
            }
        )

    remaining = [
        stop
        for stop in stops
        if stop["stop_id"] not in assigned
        and stop.get("location_type") not in {"1", "3", "4"}
        and stop["lat"] is not None
        and stop["lon"] is not None
    ]
    remaining.sort(key=lambda stop: (stop["lat"], stop["lon"]))  # type: ignore[arg-type,return-value]

    radius_deg = radius_m / 111_320.0
    for stop in remaining:
        if stop["stop_id"] in assigned:
            continue
        cluster = [stop]
        for other in remaining:
            if other["stop_id"] == stop["stop_id"] or other["stop_id"] in assigned:
                continue
            if abs(other["lat"] - stop["lat"]) > radius_deg:  # type: ignore[operator]
                continue
            if haversine_m(stop["lat"], stop["lon"], other["lat"], other["lon"]) <= radius_m:  # type: ignore[arg-type]
                cluster.append(other)
        members = [member["stop_id"] for member in cluster]
        assigned.update(members)
        latitude = sum(member["lat"] for member in cluster) / len(cluster)  # type: ignore[misc]
        longitude = sum(member["lon"] for member in cluster) / len(cluster)  # type: ignore[misc]
        if len(cluster) == 1:
            places.append(
                {
                    "place_id": f"stop-{stop['stop_id']}",
                    "kind": "stop",
                    "label": stop["stop_name"],
                    "lat": latitude,
                    "lon": longitude,
                    "stop_ids": members,
                }
            )
            continue
        # A cluster keeps a real name from the feed: the member with the most
        # characters is never used as a fabricated station name.
        named = sorted(cluster, key=lambda member: (len(member["stop_name"]), member["stop_name"]))[0]
        places.append(
            {
                "place_id": f"cluster-{named['stop_id']}",
                "kind": "cluster",
                "label": named["stop_name"],
                "lat": latitude,
                "lon": longitude,
                "stop_ids": sorted(members),
            }
        )

    # Stops without usable coordinates stay addressable but are not places.
    grouped = {}
    for place in places:
        for stop_id in place["stop_ids"]:
            grouped[stop_id] = place["place_id"]
    return places


def _place_coordinates(members: Iterable[str], by_id: dict[str, dict[str, Any]]) -> tuple[float, float] | None:
    points = [
        (by_id[member]["lat"], by_id[member]["lon"])
        for member in members
        if member in by_id and by_id[member]["lat"] is not None and by_id[member]["lon"] is not None
    ]
    if not points:
        return None
    return (sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points))


def _walk_edges(
    stops: list[dict[str, Any]],
    places: list[dict[str, Any]],
    transfer_rows: list[tuple[str, str]],
    *,
    cluster_radius_m: float,
    nearby_walk_radius_m: float,
) -> list[dict[str, Any]]:
    """Explicit transfers, parent links and short declared walks — nothing else.

    A declared link between two stops can be traversed even when the two stops
    are further apart than the short-walk radius; its distance is then measured
    from the declared coordinates and reported as unknown when they are missing.
    """
    edges: dict[tuple[str, str], dict[str, Any]] = {}
    measured: dict[tuple[str, str], float] = {}
    # A declared transfer or a parent link explains the walk better than the fact
    # that two coordinates happen to be close: it wins whenever the distances agree.
    priority = {"transfer": 0, "parent": 1, "nearby": 2}

    def add(source: str, target: str, meters: float | None, kind: str) -> None:
        if source == target:
            return
        for a, b in ((source, target), (target, source)):
            key = (a, b)
            candidate = 0.0 if meters is None else meters
            previous = measured.get(key)
            if previous is not None:
                same_walk = abs(candidate - previous) < 0.5
                if candidate > previous and not same_walk:
                    continue
                if same_walk and priority[kind] >= priority[str(edges[key]["source"])]:
                    continue
            measured[key] = candidate
            edges[key] = {
                "from_stop_id": a,
                "to_stop_id": b,
                "walk_m": None if meters is None else round(meters),
                "source": kind,
            }

    by_id = {stop["stop_id"]: stop for stop in stops}

    def declared_distance(first: str, second: str) -> float | None:
        first_point = _place_coordinates([first], by_id)
        second_point = _place_coordinates([second], by_id)
        if first_point is None or second_point is None:
            return None
        return haversine_m(first_point[0], first_point[1], second_point[0], second_point[1])

    for source, target in transfer_rows:
        if source not in by_id or target not in by_id:
            continue
        add(source, target, declared_distance(source, target), "transfer")

    child_index: dict[str, list[str]] = {}
    for stop in stops:
        parent = stop.get("parent_station")
        if parent and parent in by_id:
            child_index.setdefault(parent, []).append(stop["stop_id"])
    for parent, children in child_index.items():
        for child in children:
            add(parent, child, declared_distance(parent, child), "parent")

    positioned = [stop for stop in stops if stop["lat"] is not None and stop["lon"] is not None]
    radius_deg = nearby_walk_radius_m / 111_320.0
    positioned.sort(key=lambda stop: (float(stop["lat"]), float(stop["lon"])))
    for index, stop in enumerate(positioned):
        for other in positioned[index + 1:]:
            if float(other["lat"]) - float(stop["lat"]) > radius_deg:
                break
            meters = haversine_m(float(stop["lat"]), float(stop["lon"]), float(other["lat"]), float(other["lon"]))
            if meters <= nearby_walk_radius_m:
                add(str(stop["stop_id"]), str(other["stop_id"]), meters, "nearby")
    return sorted(edges.values(), key=lambda edge: (edge["from_stop_id"], edge["to_stop_id"]))


def walk_edges(
    stops: list[dict[str, Any]],
    places: list[dict[str, Any]],
    transfer_rows: list[tuple[str, str]],
    *,
    cluster_radius_m: float = DEFAULT_CLUSTER_RADIUS_M,
    nearby_walk_radius_m: float = DEFAULT_NEARBY_WALK_RADIUS_M,
) -> list[dict[str, Any]]:
    """Public entry point for the walk links of a set of stops."""
    return _walk_edges(
        stops,
        places,
        transfer_rows,
        cluster_radius_m=cluster_radius_m,
        nearby_walk_radius_m=nearby_walk_radius_m,
    )


def build_graph(
    snapshot_dir: str | Path,
    *,
    now: datetime | None = None,
    cluster_radius_m: float = DEFAULT_CLUSTER_RADIUS_M,
    nearby_walk_radius_m: float = DEFAULT_NEARBY_WALK_RADIUS_M,
) -> dict[str, Any]:
    """Build the routing payload from one published snapshot directory."""
    directory = Path(snapshot_dir)
    if directory.is_symlink() or not directory.is_dir():
        raise GraphError("SNAPSHOT_MISSING", "Le dossier du snapshot publié est absent ou symbolique.")
    revision = _read_snapshot_revision(directory)
    current_time = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)

    connection = connect_read_only(directory)
    try:
        stops = _read_stops(connection)
        routes = _read_routes(connection)
        trips = _read_trips(connection)
        stop_times = _read_stop_times(connection)
        services, exceptions = _load_calendars(connection)
        transfers = [
            (source, target)
            for source, target in (
                (_row_or_none(row, "from_stop_id"), _row_or_none(row, "to_stop_id"))
                for row in (_rows(connection, 'SELECT * FROM "transfers"') if _table_exists(connection, "transfers") else [])
            )
            if source and target
        ]
    finally:
        connection.close()

    places = _cluster_stops(stops, cluster_radius_m)
    if len(places) > MAX_PLACES:
        raise GraphError("TOO_MANY_PLACES", f"Le graphe dépasserait {MAX_PLACES} lieux ; publier un flux plus petit.")
    edges = _walk_edges(
        stops,
        places,
        transfers,
        cluster_radius_m=cluster_radius_m,
        nearby_walk_radius_m=nearby_walk_radius_m,
    )

    place_by_stop: dict[str, str] = {}
    for place in places:
        for stop_id in place["stop_ids"]:
            place_by_stop[stop_id] = place["place_id"]

    stop_routes: dict[str, set[str]] = {}
    graph_trips: list[dict[str, Any]] = []
    warnings: list[str] = []
    timed_trips = 0
    for trip in trips:
        entries = stop_times.get(trip["trip_id"])
        if not entries or len(entries) < 2:
            continue
        if trip["service_id"] not in services and (trip["service_id"], 0) not in exceptions:
            warnings.append(f"Service « {trip['service_id']} » absent du calendrier : courses ignorées.")
        route_id = trip["route_id"]
        if route_id not in routes:
            continue
        graph_trips.append(
            {
                "trip_id": trip["trip_id"],
                "route_id": route_id,
                "service_id": trip["service_id"],
                "stop_times": [[entry["stop_id"], entry["sequence"], entry["arrival"], entry["departure"]] for entry in entries],
            }
        )
        for entry in entries:
            stop_routes.setdefault(entry["stop_id"], set()).add(route_id)
        if any(entry["arrival"] is not None or entry["departure"] is not None for entry in entries):
            timed_trips += 1

    graph = {
        "schema_version": GRAPH_SCHEMA_VERSION,
        "built_at": current_time.isoformat(),
        "snapshot": {
            "snapshot_id": revision["snapshot_id"],
            "database_sha256": revision["database_sha256"],
            "built_at": revision["built_at"],
        },
        "source": {
            "dataset_id": revision["dataset"].get("dataset_id"),
            "dataset_version": revision["dataset"].get("dataset_version"),
            "operator": revision["dataset"].get("operator"),
            "source": revision["dataset"].get("source"),
            "source_type": revision["dataset"].get("source_type"),
            "valid_from": revision["dataset"].get("valid_from"),
            "valid_until": revision["dataset"].get("valid_until"),
        },
        "timezone": revision["timezone"],
        "parameters": {
            "cluster_radius_m": cluster_radius_m,
            "nearby_walk_radius_m": nearby_walk_radius_m,
        },
        "capabilities": {
            "network_walk": True,
            "direct_rides": timed_trips > 0,
            "transfers_itinerary": False,
            "realtime": False,
        },
        "warnings": sorted(set(warnings))[:20],
        "services": services,
        "calendar_dates": [
            {"service_id": service_id, "date": day, "exception_type": kind}
            for (service_id, day), kind in sorted(exceptions.items())
        ],
        "routes": routes,
        "stops": {
            stop["stop_id"]: {
                "stop_name": stop["stop_name"],
                "lat": stop["lat"],
                "lon": stop["lon"],
                "location_type": stop["location_type"],
                "parent_station": stop["parent_station"],
                "place_id": place_by_stop.get(stop["stop_id"]),
            }
            for stop in stops
        },
        "places": places,
        "stop_routes": {stop_id: sorted(ids) for stop_id, ids in sorted(stop_routes.items())},
        "edges": edges,
        "trips": graph_trips,
        "stats": {
            "stops": len(stops),
            "places": len(places),
            "trips": len(graph_trips),
            "timed_trips": timed_trips,
            "edges": len(edges),
            "transfers": sum(1 for edge in edges if edge["source"] == "transfer"),
        },
        "data_policy": DATA_POLICY,
        "realtime": False,
    }
    return graph


def write_graph(graph: dict[str, Any], destination: str | Path) -> dict[str, Any]:
    """Write the graph atomically; never leave a half-written file behind."""
    path = Path(destination)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
    payload = json.dumps(graph, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(temporary, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return {
        "path": str(path),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "graph": graph,
    }


def rebuild_graph(
    published_root: str | Path,
    snapshot_id: str | None = None,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Rebuild the persisted graph from a snapshot (the active one by default)."""
    try:
        from .publication_ledger import current_publication_state
    except ImportError:  # pragma: no cover - direct CLI entry point
        from publication_ledger import current_publication_state

    root = Path(published_root)
    target = snapshot_id
    active_id: str | None = None
    if target is None:
        state = current_publication_state(root)
        if not state["available"]:
            raise GraphError(
                "NOTHING_PUBLISHED",
                "Aucun snapshot publié : le graphe ne peut pas être construit.",
                blockers=["NOTHING_PUBLISHED"],
            )
        active = state["active"]
        assert isinstance(active, dict)
        target = str(active["snapshot_id"])
        active_id = target

    graph = build_graph(root / target, now=now)
    written = write_graph(graph, default_graph_path(root))
    return {
        "graph_path": written["path"],
        "graph_bytes": written["bytes"],
        "graph_sha256": written["sha256"],
        "snapshot_id": graph["snapshot"]["snapshot_id"],
        "built_from_active_snapshot": active_id is not None,
        "built_at": graph["built_at"],
        "stats": graph["stats"],
        "capabilities": graph["capabilities"],
        "warnings": graph["warnings"],
        "realtime": False,
    }


def inspect_graph(path: str | Path) -> dict[str, Any]:
    """Cheap facts about the persisted graph: presence, schema, declared revision."""
    graph_file = Path(path)
    if not graph_file.exists():
        return {"exists": False, "readable": False, "reason": "Aucun graphe n’a encore été construit.", "graph": None}
    if graph_file.is_symlink() or not graph_file.is_file():
        return {"exists": True, "readable": False, "reason": "Le fichier de graphe est symbolique ou n’est pas un fichier.", "graph": None}
    try:
        payload = json.loads(graph_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return {"exists": True, "readable": False, "reason": f"Le graphe n’est pas lisible : {error}.", "graph": None}
    if not isinstance(payload, dict) or payload.get("schema_version") != GRAPH_SCHEMA_VERSION:
        return {"exists": True, "readable": False, "reason": "La version du schéma de graphe n’est pas prise en charge.", "graph": None}
    if payload.get("realtime") is not False:
        return {"exists": True, "readable": False, "reason": "Un graphe statique ne peut pas prétendre au temps réel.", "graph": None}
    return {"exists": True, "readable": True, "reason": None, "graph": payload}


def graph_status(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Is the persisted graph usable for what is published right now?"""
    try:
        from .publication_ledger import current_publication_state
    except ImportError:  # pragma: no cover - direct CLI entry point
        from publication_ledger import current_publication_state

    root = Path(published_root)
    state = current_publication_state(root)
    inspected = inspect_graph(default_graph_path(root))
    result: dict[str, Any] = {
        "publication_status": state["publication_status"],
        "exists": inspected["exists"],
        "usable": False,
        "reason": inspected["reason"],
        "built_at": None,
        "stats": None,
        "capabilities": None,
        "snapshot_id": None,
        "matches_active_snapshot": False,
        "realtime": False,
    }
    if not state["available"]:
        result["reason"] = "Aucun snapshot publié : rien n’est servi, donc aucun graphe n’est utilisé."
        return result
    active = state["active"]
    assert isinstance(active, dict)
    result["active_snapshot_id"] = active["snapshot_id"]
    if not inspected["readable"]:
        return result
    graph = inspected["graph"]
    assert isinstance(graph, dict)
    snapshot = graph.get("snapshot") or {}
    result["snapshot_id"] = snapshot.get("snapshot_id")
    result["built_at"] = graph.get("built_at")
    result["stats"] = graph.get("stats")
    result["capabilities"] = graph.get("capabilities")
    result["matches_active_snapshot"] = snapshot.get("snapshot_id") == active["snapshot_id"] and snapshot.get(
        "database_sha256"
    ) == active.get("database_sha256")
    if not result["matches_active_snapshot"]:
        result["reason"] = (
            "Le graphe ne correspond pas au snapshot publié ; il doit être reconstruit avant de servir un itinéraire."
        )
        return result
    result["usable"] = True
    result["reason"] = None
    return result


def load_graph(published_root: str | Path, *, now: datetime | None = None) -> dict[str, Any]:
    """Return the graph only when it matches the active published snapshot."""
    status = graph_status(published_root, now=now)
    if not status["usable"]:
        raise GraphError(
            "GRAPH_UNAVAILABLE",
            str(status["reason"] or "Le graphe d’itinéraires n’est pas disponible."),
            blockers=["GRAPH_UNAVAILABLE"],
        )
    inspected = inspect_graph(default_graph_path(published_root))
    graph = inspected["graph"]
    assert isinstance(graph, dict)
    return graph


def _place_indexes(graph: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    places = {place["place_id"]: place for place in graph.get("places", []) if isinstance(place, dict) and place.get("place_id")}
    by_stop: dict[str, str] = {}
    for place in places.values():
        for stop_id in place.get("stop_ids", []):
            by_stop[str(stop_id)] = str(place["place_id"])
    return places, by_stop


def search_places(graph: dict[str, Any], query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """Search derived places by name, folding case and accents."""
    text = " ".join(query.split())
    if not text:
        raise GraphError("EMPTY_QUERY", "Une recherche exige au moins un caractère.")
    tokens = _fold(text).split()[:8]
    results: list[dict[str, Any]] = []
    for place in graph.get("places", []):
        label = _fold(str(place.get("label") or ""))
        if all(token in label for token in tokens):
            results.append(place)
    results.sort(key=lambda place: (len(str(place.get("label") or "")), str(place.get("label") or "")))
    return results[:limit]


def resolve_place(graph: dict[str, Any], query: str) -> list[dict[str, Any]]:
    """Resolve a query to places: identifier first, then exact name, then prefix search."""
    text = " ".join(query.split())
    if not text:
        raise GraphError("EMPTY_QUERY", "Un lieu de départ ou d’arrivée est obligatoire.")
    places, _ = _place_indexes(graph)
    exact: list[dict[str, Any]] = []
    for place in places.values():
        if place["place_id"] == text or text in [str(stop_id) for stop_id in place.get("stop_ids", [])]:
            exact.append(place)
    if exact:
        return exact[:5]
    folded = _fold(text)
    named = [place for place in places.values() if _fold(str(place.get("label") or "")) == folded]
    if named:
        return named[:5]

    # A stop identifier that is not part of any place still has to be usable.
    stops = graph.get("stops") or {}
    if text in stops:
        stop = stops[text]
        if stop.get("lat") is not None and stop.get("lon") is not None:
            return [
                {
                    "place_id": f"stop-{text}",
                    "kind": "stop",
                    "label": stop.get("stop_name") or text,
                    "lat": stop.get("lat"),
                    "lon": stop.get("lon"),
                    "stop_ids": [text],
                }
            ]
    return search_places(graph, text, limit=5)


def _adjacency(graph: dict[str, Any]) -> dict[str, list[tuple[str, float]]]:
    neighbours: dict[str, list[tuple[str, float]]] = {}
    for edge in graph.get("edges", []):
        source = str(edge["from_stop_id"])
        target = str(edge["to_stop_id"])
        raw_meters = edge.get("walk_m")
        meters = float(raw_meters) if isinstance(raw_meters, (int, float)) else 0.0
        neighbours.setdefault(source, []).append((target, meters))
        neighbours.setdefault(target, []).append((source, meters))
    return neighbours


def reachable_walk(
    graph: dict[str, Any],
    origin: tuple[float, float],
    *,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
) -> dict[str, dict[str, Any]]:
    """Stops reachable on foot from a point, following declared network edges only.

    Walking starts on the stops the point is really next to (400 m at most, or
    the requested radius when it is smaller) and then follows `transfers.txt`
    rows, parent/child links and short declared walks, up to `max_walk_m`.
    Straight-line detours to unconnected stops are never invented, and a
    declared link whose stops have no coordinates is reported as an unknown
    distance rather than a made-up zero.
    """
    stops = graph.get("stops") or {}
    start_radius_m = min(max_walk_m, DEFAULT_START_WALK_M)
    located = [
        (stop_id, float(stop["lat"]), float(stop["lon"]))
        for stop_id, stop in stops.items()
        if isinstance(stop, dict) and stop.get("lat") is not None and stop.get("lon") is not None
    ]
    start_distances: dict[str, float] = {}
    for stop_id, latitude, longitude in located:
        meters = haversine_m(origin[0], origin[1], latitude, longitude)
        if meters <= start_radius_m:
            start_distances[stop_id] = meters
    if not start_distances:
        return {}

    neighbours = _adjacency(graph)
    unmeasured = {
        (str(edge["from_stop_id"]), str(edge["to_stop_id"]))
        for edge in graph.get("edges", [])
        if isinstance(edge, dict) and not isinstance(edge.get("walk_m"), (int, float))
    }
    best: dict[str, float] = {}
    previous: dict[str, str | None] = {}
    inexact: dict[str, bool] = {}
    queue: list[tuple[float, str]] = []
    for stop_id, meters in start_distances.items():
        best[stop_id] = meters
        previous[stop_id] = None
        inexact[stop_id] = False
        queue.append((meters, stop_id))

    heapq.heapify(queue)
    while queue:
        distance, stop_id = heapq.heappop(queue)
        if distance > best.get(stop_id, float("inf")) + 1e-9:
            continue
        for neighbour, meters in neighbours.get(stop_id, []):
            candidate = distance + meters
            if candidate > max_walk_m:
                continue
            if candidate + 1e-9 < best.get(neighbour, float("inf")):
                best[neighbour] = candidate
                previous[neighbour] = stop_id
                inexact[neighbour] = inexact.get(stop_id, False) or (stop_id, neighbour) in unmeasured
                heapq.heappush(queue, (candidate, neighbour))

    reachable: dict[str, dict[str, Any]] = {}
    for stop_id, meters in best.items():
        path: list[str] = []
        cursor: str | None = stop_id
        while cursor is not None:
            path.append(cursor)
            cursor = previous.get(cursor)
        path.reverse()
        reachable[stop_id] = {
            "walk_m": round(meters),
            "walk_m_known": not inexact.get(stop_id, False),
            "path": path,
        }
    return reachable


def _local_day(graph: dict[str, Any], moment: datetime) -> tuple[date, int]:
    """Feed-local calendar day and seconds since that local midnight.

    GTFS times are local to the agency timezone, so a request made in UTC must
    be compared with the same clock the feed declares.
    """
    timezone_name = graph.get("timezone")
    if isinstance(timezone_name, str) and timezone_name:
        try:
            from zoneinfo import ZoneInfo

            local = moment.astimezone(ZoneInfo(timezone_name))
        except (KeyError, ValueError, OSError):  # pragma: no cover - unknown timezone in feed
            return moment.date(), moment.hour * 3600 + moment.minute * 60 + moment.second
        return local.date(), local.hour * 3600 + local.minute * 60 + local.second
    return moment.date(), moment.hour * 3600 + moment.minute * 60 + moment.second


def find_direct_journeys(
    graph: dict[str, Any],
    origin: tuple[float, float],
    destination: tuple[float, float],
    *,
    at: datetime | None = None,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
    max_results: int = 3,
) -> dict[str, Any]:
    """Find direct rides: one boarding, one alighting, no transfer invented."""
    moment = (at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    services = graph.get("services") or {}
    exceptions = {
        (str(entry["service_id"]), int(entry["date"])): int(entry["exception_type"])
        for entry in graph.get("calendar_dates") or []
        if isinstance(entry, dict) and "service_id" in entry and "date" in entry
    }
    routes = graph.get("routes") or {}
    departures = reachable_walk(graph, origin, max_walk_m=max_walk_m)
    arrivals = reachable_walk(graph, destination, max_walk_m=max_walk_m)
    reachable_boarding = set(departures)
    reachable_alighting = set(arrivals)

    # « Depuis maintenant » is compared on the clock the feed declares.
    day, seconds_now = _local_day(graph, moment)

    if not reachable_boarding or not reachable_alighting:
        return {
            "requested_at": moment.isoformat(),
            "local_day": day.isoformat(),
            "walk_radius_m": max_walk_m,
            "start_walk_m": min(max_walk_m, DEFAULT_START_WALK_M),
            "boarding_stops": len(reachable_boarding),
            "alighting_stops": len(reachable_alighting),
            "days_checked": 0,
            "results": [],
            "result_date": None,
            "next_service_date": None,
            "exhausted_today": False,
            "reason": "NO_NEARBY_STOPS",
            "message": (
                f"Aucun arrêt publié ne se trouve à moins de {round(max_walk_m)} m du départ ou de l’arrivée "
                "dans le réseau déclaré : aucun itinéraire n’est proposé plutôt qu’un trajet inventé."
            ),
            "realtime": False,
        }

    candidates: list[dict[str, Any]] = []
    day_with_results: date | None = None
    days_checked = 0

    def rides_on(candidate_day: date, *, after_seconds: int | None) -> list[dict[str, Any]]:
        """Declared direct rides for one service day; `after_seconds` excludes past departures."""
        found: list[dict[str, Any]] = []
        for trip in graph.get("trips") or []:
            service_id = str(trip.get("service_id"))
            if not _service_active(service_id, candidate_day, services, exceptions):
                continue
            entries = trip.get("stop_times") or []
            boarding: dict[str, Any] | None = None
            alighting: dict[str, Any] | None = None
            for entry in entries:
                stop_id = str(entry[0])
                arrival = entry[2]
                departure = entry[3]
                if boarding is None and stop_id in reachable_boarding:
                    departure_seconds = departure if isinstance(departure, int) else arrival
                    if departure_seconds is None:
                        continue
                    if after_seconds is not None and departure_seconds < after_seconds:
                        continue  # already gone: never offered as a future departure
                    boarding = {"stop_id": stop_id, "departure": departure_seconds}
                    continue
                if boarding is not None and stop_id in reachable_alighting:
                    arrival_seconds = arrival if isinstance(arrival, int) else departure
                    if arrival_seconds is None:
                        continue
                    alighting = {"stop_id": stop_id, "arrival": arrival_seconds}
                    break
            if boarding is None or alighting is None:
                continue
            route = routes.get(str(trip.get("route_id"))) or {}
            boarding_walk = departures[boarding["stop_id"]]
            alighting_walk = arrivals[alighting["stop_id"]]
            found.append(
                {
                    "kind": "direct",
                    "transfers": 0,
                    "trip_id": trip.get("trip_id"),
                    "service_id": service_id,
                    "route": route,
                    "board": {
                        "stop_id": boarding["stop_id"],
                        "stop_name": (graph.get("stops") or {}).get(boarding["stop_id"], {}).get("stop_name"),
                        "departure": format_gtfs_time(boarding["departure"]),
                        "walk_m": boarding_walk["walk_m"],
                        "walk_m_known": boarding_walk["walk_m_known"],
                        "walk_path": boarding_walk["path"],
                    },
                    "alight": {
                        "stop_id": alighting["stop_id"],
                        "stop_name": (graph.get("stops") or {}).get(alighting["stop_id"], {}).get("stop_name"),
                        "arrival": format_gtfs_time(alighting["arrival"]),
                        "walk_m": alighting_walk["walk_m"],
                        "walk_m_known": alighting_walk["walk_m_known"],
                        "walk_path": alighting_walk["path"],
                    },
                    "departure_seconds": boarding["departure"],
                    "arrival_seconds": alighting["arrival"],
                    "duration_min": max(0, round((alighting["arrival"] - boarding["departure"]) / 60)),
                    "date": candidate_day.isoformat(),
                    "note": "Horaire théorique déclaré dans le flux GTFS Static ; ni position ni estimation temps réel.",
                }
            )
        return found

    for offset in range(0, 8):
        candidate_day = day + timedelta(days=offset)
        days_checked += 1
        day_candidates = rides_on(candidate_day, after_seconds=seconds_now if offset == 0 else None)
        if day_candidates:
            candidates = day_candidates
            day_with_results = candidate_day
            break

    candidates.sort(key=lambda item: (item["date"], item["arrival_seconds"], item["departure_seconds"]))
    deduplicated: list[dict[str, Any]] = []
    seen_routes: set[str] = set()
    for candidate in candidates:
        route_id = str((candidate.get("route") or {}).get("route_id"))
        if route_id in seen_routes:
            continue
        seen_routes.add(route_id)
        deduplicated.append(candidate)
        if len(deduplicated) >= max_results:
            break

    next_service_date: str | None = None
    if not deduplicated:
        # Nothing today (or in the next week): look further, but only for a day
        # that really carries a declared direct ride between these two places.
        for offset in range(0, 15):
            candidate_day = day + timedelta(days=offset)
            if rides_on(candidate_day, after_seconds=seconds_now if offset == 0 else None):
                if offset > 0:
                    next_service_date = candidate_day.isoformat()
                break

    later_day = day_with_results is not None and day_with_results != day
    message: str | None = None
    reason = "DIRECT_RIDE_FOUND" if deduplicated else "NO_DIRECT_SERVICE"
    if not deduplicated:
        message = "Aucune course directe déclarée ne relie ces deux lieux dans le rayon de marche demandé. "
        if next_service_date:
            message += f"La première course directe déclarée est le {next_service_date}. "
        message += "Le moteur à correspondances n’est pas implémenté : aucun trajet indirect n’est proposé."
    return {
        "requested_at": moment.isoformat(),
        "local_day": day.isoformat(),
        "walk_radius_m": max_walk_m,
        "start_walk_m": min(max_walk_m, DEFAULT_START_WALK_M),
        "boarding_stops": len(reachable_boarding),
        "alighting_stops": len(reachable_alighting),
        "days_checked": days_checked,
        "results": deduplicated,
        "result_date": day_with_results.isoformat() if day_with_results else None,
        "next_service_date": next_service_date,
        "exhausted_today": later_day,
        "reason": reason,
        "message": message,
        "realtime": False,
    }

