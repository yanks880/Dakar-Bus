from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from scripts.network_graph import (
    GraphError,
    build_graph,
    default_graph_path,
    find_direct_journeys,
    graph_status,
    load_graph,
    parse_gtfs_time,
    reachable_walk,
    rebuild_graph,
    resolve_place,
    search_places,
    walk_edges,
)
from scripts.publish_gtfs import publish_dataset, publications_summary
from scripts.review_gtfs import approve_dataset
from scripts.serve_read_api import journeys_payload
from scripts.stage_gtfs import IngestMetadata, stage_gtfs_archive
from test_publish_gtfs import FULL_ATTESTATIONS, PUBLISH_TABLES, PUBLISHER, REVIEWER
from test_stage_gtfs import NOW, VALID_METADATA

# One station with two child platforms, so the walk graph has something real to
# follow, plus a timetable whose last departure is at 08:00 local time.
GRAPH_TABLES: dict[str, str] = {
    **PUBLISH_TABLES,
    "agency.txt": (
        "agency_id,agency_name,agency_url,agency_timezone\n"
        "DKS,Réseau de démonstration,https://example.invalid,Africa/Dakar\n"
    ),
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        "S10,Gare de Démonstration,14.6800,-17.4400,1,\n"
        "S11,Gare de Démonstration — Quai A,14.6802,-17.4402,0,S10\n"
        "S12,Gare de Démonstration — Quai B,14.6804,-17.4404,0,S10\n"
        "S20,Arrêt Nord,14.7000,-17.4500,0,\n"
        "S30,Arrêt Sud,14.6600,-17.4300,0,\n"
        "S40,Arrêt Est,14.6800,-17.4200,0,\n"
    ),
    "routes.txt": (
        "route_id,agency_id,route_short_name,route_long_name,route_type\n"
        "L1,DKS,1,Nord - Sud,3\n"
        "L2,DKS,2,Est - Ouest,3\n"
    ),
    "trips.txt": "route_id,service_id,trip_id,direction_id\nL1,WK,T-NORD,0\nL1,WK,T-SUD,1\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T-NORD,06:00:00,06:00:00,S20,1\n"
        "T-NORD,06:04:00,06:04:00,S11,2\n"
        "T-NORD,06:30:00,06:30:00,S30,3\n"
        "T-SUD,07:30:00,07:30:00,S30,1\n"
        "T-SUD,07:34:00,07:34:00,S12,2\n"
        "T-SUD,08:00:00,08:00:00,S20,3\n"
    ),
    "calendar.txt": (
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20260101,20271231\n"
    ),
    # Saturday 2026-10-10 is only served through an added exception date.
    "calendar_dates.txt": "service_id,date,exception_type\nWK,20261010,1\n",
    "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n",
}


TRANSFER_TABLES: dict[str, str] = {
    **GRAPH_TABLES,
    "stops.txt": (
        "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n"
        "T1,Gare de Démonstration,14.6800,-17.4400,1,\n"
        "T1P,Quai de la Gare,14.6802,-17.4402,0,T1\n"
        "T2,Correspondance Déclarée,14.6845,-17.4400,0,\n"
        "T3,Terminus Nord,14.6980,-17.4400,0,\n"
    ),
    "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nL1,DKS,1,Nord,3\n",
    "trips.txt": "route_id,service_id,trip_id,direction_id\nL1,WK,T-TRANSFER,0\n",
    "stop_times.txt": (
        "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
        "T-TRANSFER,06:00:00,06:00:00,T2,1\n"
        "T-TRANSFER,06:20:00,06:20:00,T3,2\n"
    ),
    "calendar_dates.txt": "service_id,date,exception_type\n",
    "transfers.txt": "from_stop_id,to_stop_id,transfer_type\nT1,T2,2\n",
}


class GraphFixtures(unittest.TestCase):
    def published_feed(self, directory: str, **overrides: Any) -> tuple[Path, Path, str, str]:
        archive_path = Path(directory) / "graph-feed.zip"
        tables = overrides.pop("tables", GRAPH_TABLES)
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in tables.items():
                archive.writestr(name, content)
        metadata = IngestMetadata(
            **{
                **VALID_METADATA.__dict__,
                "dataset_version": "graph-v1",
                "source_type": "OFFICIAL",
                "operator": "Réseau de démonstration",
                "service_status": "ACTIVE",
                **overrides,
            }
        )
        staging = Path(directory) / "staging"
        staged = stage_gtfs_archive(archive_path, staging, metadata, now=NOW)
        self.assertTrue(staged["staged"], staged)
        dataset_id = str(staged["dataset_id"])
        approve_dataset(staging, dataset_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
        published = Path(directory) / "published"
        result = publish_dataset(
            staging, published, dataset_id, publisher_id=PUBLISHER,
            note="Publication du jeu de test du graphe.", now=NOW,
        )
        return staging, published, dataset_id, str(result["snapshot_id"])


class GraphBuildTests(GraphFixtures):
    def test_publishing_rebuilds_a_graph_matching_the_published_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)

            status = graph_status(published, now=NOW)
            self.assertTrue(status["usable"])
            self.assertTrue(status["matches_active_snapshot"])
            self.assertEqual(status["snapshot_id"], snapshot_id)
            self.assertIsNone(status["reason"])

            graph = load_graph(published, now=NOW)
            self.assertEqual(graph["schema_version"], "1.0")
            self.assertFalse(graph["realtime"])
            self.assertEqual(graph["snapshot"]["snapshot_id"], snapshot_id)
            self.assertTrue(graph["capabilities"]["direct_rides"])
            self.assertFalse(graph["capabilities"]["transfers_itinerary"])

            # The station and its two platforms form one place, from the feed alone.
            station_places = [place for place in graph["places"] if place["kind"] == "station"]
            self.assertEqual(len(station_places), 1)
            self.assertEqual(sorted(station_places[0]["stop_ids"]), ["S10", "S11", "S12"])
            edge_kinds = {edge["source"] for edge in graph["edges"]}
            self.assertEqual(edge_kinds, {"parent", "nearby"})
            # The declared parent link is never downgraded to a mere proximity edge.
            parent_edges = [edge for edge in graph["edges"] if edge["source"] == "parent"]
            self.assertEqual(len(parent_edges), 4)
            self.assertEqual(
                {(edge["from_stop_id"], edge["to_stop_id"]): edge["walk_m"] for edge in parent_edges},
                {("S10", "S11"): 31, ("S10", "S12"): 62, ("S11", "S10"): 31, ("S12", "S10"): 62},
            )

    def test_the_graph_is_refused_when_it_does_not_match_the_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph_path = default_graph_path(published)
            payload = json.loads(graph_path.read_text(encoding="utf-8"))
            payload["snapshot"]["snapshot_id"] = "snap-20200101t000000z-autre"
            graph_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

            status = graph_status(published, now=NOW)
            self.assertFalse(status["usable"])
            self.assertFalse(status["matches_active_snapshot"])
            self.assertIn("reconstruit", str(status["reason"]))
            with self.assertRaises(GraphError) as caught:
                load_graph(published, now=NOW)
            self.assertEqual(caught.exception.code, "GRAPH_UNAVAILABLE")

            rebuilt = rebuild_graph(published, now=NOW)
            self.assertEqual(rebuilt["snapshot_id"], status["active_snapshot_id"])
            self.assertTrue(graph_status(published, now=NOW)["usable"])

    def test_a_corrupted_graph_file_is_reported_and_never_used(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            default_graph_path(published).write_text("{ pas du json", encoding="utf-8")
            status = graph_status(published, now=NOW)
            self.assertFalse(status["usable"])
            self.assertIn("lisible", str(status["reason"]))

    def test_no_publication_means_no_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            published = Path(directory) / "published"
            published.mkdir()
            status = graph_status(published, now=NOW)
            self.assertFalse(status["usable"])
            self.assertIn("Aucun snapshot publié", str(status["reason"]))
            with self.assertRaises(GraphError) as caught:
                rebuild_graph(published, now=NOW)
            self.assertEqual(caught.exception.code, "NOTHING_PUBLISHED")


class DirectJourneyTests(GraphFixtures):
    def test_a_direct_ride_is_found_from_declared_timetables_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)
            journey = find_direct_journeys(
                graph,
                (14.7000, -17.4500),   # Arrêt Nord
                (14.6600, -17.4300),   # Arrêt Sud
                at=datetime(2026, 10, 8, 5, 30, tzinfo=timezone.utc),
            )

            self.assertEqual(len(journey["results"]), 1)
            result = journey["results"][0]
            self.assertEqual(result["kind"], "direct")
            self.assertEqual(result["route"]["short_name"], "1")
            self.assertEqual(result["board"]["stop_id"], "S20")
            self.assertEqual(result["board"]["departure"], "06:00:00")
            self.assertEqual(result["alight"]["stop_id"], "S30")
            self.assertEqual(result["alight"]["arrival"], "06:30:00")
            self.assertEqual(result["duration_min"], 30)
            self.assertEqual(result["date"], "2026-10-08")
            self.assertIn("temps réel", result["note"])
            self.assertFalse(journey["realtime"])

    def test_the_walk_graph_uses_station_links_to_reach_a_ride(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)
            # Standing in front of the station: the ride leaves from platform A,
            # 31 m away, measured from declared coordinates.
            journey = find_direct_journeys(
                graph,
                (14.6800, -17.4400),
                (14.6600, -17.4300),
                at=datetime(2026, 10, 8, 5, 40, tzinfo=timezone.utc),
            )
            self.assertEqual(len(journey["results"]), 1)
            result = journey["results"][0]
            self.assertEqual(result["board"]["stop_id"], "S11")
            self.assertEqual(result["board"]["walk_path"], ["S11"])
            self.assertEqual(result["board"]["walk_m"], 31)
            self.assertTrue(result["board"]["walk_m_known"])

    def test_departures_already_passed_are_never_offered_as_today(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)
            journey = find_direct_journeys(
                graph,
                (14.7000, -17.4500),
                (14.6600, -17.4300),
                at=datetime(2026, 10, 8, 6, 5, tzinfo=timezone.utc),
            )
            self.assertEqual(len(journey["results"]), 1)
            self.assertEqual(journey["results"][0]["date"], "2026-10-09")  # next service day
            self.assertEqual(journey["reason"], "DIRECT_RIDE_FOUND")
            self.assertTrue(journey["exhausted_today"])
            self.assertEqual(journey["local_day"], "2026-10-08")
            self.assertIsNone(journey["next_service_date"])

    def test_a_weekend_only_exception_date_is_taken_into_account(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)
            # Saturday 2026-10-10 is only served through calendar_dates (exception 1).
            added_day = find_direct_journeys(
                graph,
                (14.7000, -17.4500),
                (14.6600, -17.4300),
                at=datetime(2026, 10, 10, 5, 0, tzinfo=timezone.utc),
            )
            self.assertEqual(added_day["results"][0]["date"], "2026-10-10")
            self.assertFalse(added_day["exhausted_today"])

            # A Sunday without any exception: the next served day is Monday.
            sunday = find_direct_journeys(
                graph,
                (14.7000, -17.4500),
                (14.6600, -17.4300),
                at=datetime(2026, 10, 11, 5, 0, tzinfo=timezone.utc),
            )
            self.assertEqual(sunday["results"][0]["date"], "2026-10-12")
            self.assertTrue(sunday["exhausted_today"])

    def test_walking_beyond_the_requested_radius_finds_nothing_and_says_so(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)
            journey = find_direct_journeys(
                graph,
                (14.9000, -17.6000),  # far outside Dakar
                (14.6600, -17.4300),
                at=datetime(2026, 10, 8, 5, 30, tzinfo=timezone.utc),
                max_walk_m=200,
            )
            self.assertEqual(journey["results"], [])
            self.assertEqual(journey["boarding_stops"], 0)
            self.assertEqual(journey["reason"], "NO_NEARBY_STOPS")
            self.assertEqual(journey["days_checked"], 0)
            self.assertIsNone(journey["next_service_date"])
            self.assertIn("à moins de 200 m", str(journey["message"]))
            self.assertNotIn("correspondances", str(journey["message"]))

    def test_a_declared_transfer_is_needed_to_reach_a_feeder_stop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory, tables=TRANSFER_TABLES)
            graph = load_graph(published, now=NOW)
            origin = (14.6800, -17.4400)   # Gare de Démonstration, no departure of its own
            destination = (14.6980, -17.4400)  # Terminus Nord

            # Without the declared transfer, the feeder stop 500 m away is not walkable.
            without_transfer = {**TRANSFER_TABLES}
            without_transfer.pop("transfers.txt")
            _, bare_published, _, _ = self.published_feed(
                tempfile.mkdtemp(dir=directory), tables=without_transfer
            )
            bare_graph = load_graph(bare_published, now=NOW)
            bare_walk = reachable_walk(bare_graph, origin)
            self.assertEqual(sorted(bare_walk), ["T1", "T1P"])
            refused = find_direct_journeys(
                bare_graph, origin, destination, at=datetime(2026, 10, 8, 5, 0, tzinfo=timezone.utc)
            )
            self.assertEqual(refused["results"], [])
            self.assertEqual(refused["reason"], "NO_DIRECT_SERVICE")
            self.assertIn("Aucune course directe déclarée", str(refused["message"]))

            # With it, the walk follows the declared link and the ride is offered.
            walk = reachable_walk(graph, origin)
            self.assertEqual(sorted(walk), ["T1", "T1P", "T2"])
            self.assertTrue(walk["T2"]["walk_m_known"])
            self.assertAlmostEqual(walk["T2"]["walk_m"], 501, delta=6)
            self.assertEqual(walk["T2"]["path"], ["T1", "T2"])

            journey = find_direct_journeys(
                graph, origin, destination, at=datetime(2026, 10, 8, 5, 0, tzinfo=timezone.utc)
            )
            self.assertEqual(journey["reason"], "DIRECT_RIDE_FOUND")
            result = journey["results"][0]
            self.assertEqual(result["board"]["stop_id"], "T2")
            self.assertEqual(result["board"]["walk_path"], ["T1", "T2"])
            self.assertAlmostEqual(result["board"]["walk_m"], 501, delta=6)
            self.assertTrue(result["board"]["walk_m_known"])
            self.assertEqual(result["alight"]["stop_id"], "T3")
            self.assertEqual(result["alight"]["walk_m"], 0)

    def test_a_declared_link_without_coordinates_never_invents_a_distance(self) -> None:
        # The publishing validator already refuses a stop without coordinates, so
        # this branch is defensive: if a stop ever appears without coordinates in
        # the persisted snapshot, the walk distance is reported as unknown.
        stops = [
            {"stop_id": "A", "stop_name": "A", "lat": 14.6800, "lon": -17.4400, "location_type": "0", "parent_station": None},
            {"stop_id": "B", "stop_name": "B", "lat": None, "lon": None, "location_type": "0", "parent_station": None},
        ]
        edges = walk_edges(stops, [], [("A", "B")], cluster_radius_m=250.0, nearby_walk_radius_m=400.0)
        self.assertEqual(
            {(edge["from_stop_id"], edge["to_stop_id"], edge["walk_m"], edge["source"]) for edge in edges},
            {("A", "B", None, "transfer"), ("B", "A", None, "transfer")},
        )

    def test_places_are_resolved_from_published_names_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            graph = load_graph(published, now=NOW)

            exact = resolve_place(graph, "Arrêt Nord")
            self.assertEqual([place["place_id"] for place in exact], ["stop-S20"])
            by_stop_id = resolve_place(graph, "S30")
            self.assertEqual(by_stop_id[0]["label"], "Arrêt Sud")
            partial = resolve_place(graph, "demonstration")
            self.assertEqual(partial[0]["kind"], "station")
            self.assertEqual(resolve_place(graph, "lieu inexistant"), [])
            found_stops = search_places(graph, "arrêt")
            self.assertEqual({place["stop_ids"][0] for place in found_stops}, {"S20", "S30", "S40"})
            self.assertTrue(all(place["kind"] == "stop" for place in found_stops))
            with self.assertRaises(GraphError):
                resolve_place(graph, "   ")

    def test_gtfs_times_after_midnight_stay_supported(self) -> None:
        self.assertEqual(parse_gtfs_time("25:30:00"), 91800)
        self.assertEqual(parse_gtfs_time("06:00:00"), 21600)
        self.assertIsNone(parse_gtfs_time("06:00"))
        self.assertIsNone(parse_gtfs_time(None))


class JourneyApiTests(GraphFixtures):
    def test_the_api_answers_direct_journeys_from_the_published_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            from urllib.parse import parse_qs

            payload = journeys_payload(
                published,
                parse_qs(
                    "origin=Arrêt Nord&destination=Arrêt Sud&at=2026-10-08T05:30:00Z&max_walk_m=900",
                    keep_blank_values=True,
                ),
            )
            self.assertEqual(payload["snapshot_id"], snapshot_id)
            self.assertEqual(payload["result_count"], 1)
            self.assertEqual(payload["reason"], "DIRECT_RIDE_FOUND")
            self.assertEqual(payload["start_walk_m"], 400.0)
            self.assertEqual(payload["results"][0]["board"]["walk_m_known"], True)
            self.assertEqual(payload["origin"]["place"]["place_id"], "stop-S20")
            self.assertEqual(payload["destination"]["place"]["place_id"], "stop-S30")
            self.assertFalse(payload["realtime"])
            self.assertEqual(payload["graph"]["snapshot_id"], snapshot_id)
            self.assertIn("correspondance", payload["limitations"].lower())
            self.assertIsNone(payload["message"])

    def test_the_api_explains_a_missing_graph_and_an_unknown_place(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            from urllib.parse import parse_qs

            from scripts.serve_read_api import ApiError

            default_graph_path(published).unlink()
            with self.assertRaises(ApiError) as missing_graph:
                journeys_payload(published, parse_qs("origin=S20&destination=S30", keep_blank_values=True))
            self.assertEqual(missing_graph.exception.status, 409)
            self.assertEqual(missing_graph.exception.code, "GRAPH_UNAVAILABLE")
            self.assertIn("graph-rebuild", missing_graph.exception.message)

            rebuild_graph(published, now=NOW)
            with self.assertRaises(ApiError) as unknown_place:
                journeys_payload(published, parse_qs("origin=Gare de Lyon&destination=S30", keep_blank_values=True))
            self.assertEqual(unknown_place.exception.status, 404)
            self.assertEqual(unknown_place.exception.code, "PLACE_NOT_FOUND")

            with self.assertRaises(ApiError) as same_point:
                journeys_payload(published, parse_qs("origin=S20&destination=S20", keep_blank_values=True))
            self.assertEqual(same_point.exception.code, "INVALID_QUERY")

    def test_coordinates_are_accepted_as_an_origin_without_any_geocoding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            from urllib.parse import parse_qs

            payload = journeys_payload(
                published,
                parse_qs(
                    "origin_lat=14.7000&origin_lon=-17.4500&destination=S30&at=2026-10-08T05:30:00Z",
                    keep_blank_values=True,
                ),
            )
            self.assertEqual(payload["origin"]["origin"], "coordinates")
            self.assertIsNone(payload["origin"]["place"])
            self.assertEqual(payload["result_count"], 1)

            from scripts.serve_read_api import ApiError

            with self.assertRaises(ApiError) as incomplete:
                journeys_payload(published, parse_qs("origin_lat=14.7&destination=S30", keep_blank_values=True))
            self.assertEqual(incomplete.exception.code, "INVALID_QUERY")

    def test_the_api_reports_why_it_proposes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, _ = self.published_feed(directory)
            from urllib.parse import parse_qs

            far_away = journeys_payload(
                published,
                parse_qs("origin_lat=14.9&origin_lon=-17.6&destination=S30&max_walk_m=200", keep_blank_values=True),
            )
            self.assertEqual(far_away["reason"], "NO_NEARBY_STOPS")
            self.assertEqual(far_away["result_count"], 0)
            self.assertIsNone(far_away["next_service_date"])
            self.assertEqual(far_away["start_walk_m"], 200.0)
            self.assertIn("aucun itinéraire n’est proposé plutôt qu’un trajet inventé", far_away["message"])
            self.assertFalse(far_away["realtime"])

            # A published stop exists nearby, but no declared departure serves the pair:
            # the stop is walkable, so this is not a distance problem.
            no_ride = journeys_payload(
                published,
                parse_qs("origin=S40&destination=S20&at=2026-10-08T05:00:00Z", keep_blank_values=True),
            )
            self.assertEqual(no_ride["reason"], "NO_DIRECT_SERVICE")
            self.assertEqual(no_ride["result_count"], 0)
            self.assertIsNone(no_ride["next_service_date"])
            self.assertIn("Aucune course directe déclarée", str(no_ride["message"]))
            self.assertIn("correspondances n’est pas implémenté", str(no_ride["message"]))
            self.assertEqual(no_ride["boarding_stops"], 1)  # l’arrêt de départ est bien à portée

    def test_listing_publications_reports_the_graph_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            _, published, _, snapshot_id = self.published_feed(directory)
            summary = publications_summary(published, now=NOW)
            self.assertTrue(summary["graph"]["usable"])
            self.assertEqual(summary["graph"]["snapshot_id"], snapshot_id)

            default_graph_path(published).unlink()
            without_graph = publications_summary(published, now=NOW)
            self.assertFalse(without_graph["graph"]["usable"])
            self.assertIn("Aucun graphe", str(without_graph["graph"]["reason"]))

    def test_a_new_publication_supersedes_the_previous_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            staging, published, dataset_id, first_snapshot = self.published_feed(directory)
            first_graph = load_graph(published, now=NOW)
            self.assertEqual(first_graph["snapshot"]["snapshot_id"], first_snapshot)

            # Stage and publish a second version with one more stop.
            second_tables = {
                **GRAPH_TABLES,
                "stops.txt": GRAPH_TABLES["stops.txt"] + "S50,Arrêt Ouest,14.6800,-17.4600,0,\n",
            }
            archive_path = Path(directory) / "graph-feed-v2.zip"
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for name, content in second_tables.items():
                    archive.writestr(name, content)
            metadata = IngestMetadata(**{**VALID_METADATA.__dict__, "dataset_version": "graph-v2", "source_type": "OFFICIAL", "operator": "Réseau de démonstration", "service_status": "ACTIVE"})
            staged = stage_gtfs_archive(archive_path, staging, metadata, now=NOW)
            second_id = str(staged["dataset_id"])
            approve_dataset(staging, second_id, reviewer_id=REVIEWER, attestations=FULL_ATTESTATIONS, now=NOW)
            second = publish_dataset(
                staging, published, second_id, publisher_id=PUBLISHER, note="Deuxième version du jeu du graphe.",
                now=NOW + timedelta(hours=1),
            )

            second_graph = load_graph(published, now=NOW + timedelta(hours=1))
            self.assertEqual(second_graph["snapshot"]["snapshot_id"], second["snapshot_id"])
            self.assertEqual(second_graph["stats"]["stops"], first_graph["stats"]["stops"] + 1)
            self.assertEqual(second["graph"]["usable"], True)


if __name__ == "__main__":
    unittest.main()
