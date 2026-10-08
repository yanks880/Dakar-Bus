#!/usr/bin/env python3
"""Construit une archive GTFS Static « réseau de référence » TER + BRT.

Objet : alimenter le pipeline de gouvernance local (staging → revue →
publication) avec les corridors de référence déjà utilisés par l'interface
(`src/domain/corridors.ts`) : 13 gares TER (positions OpenStreetMap/SETER,
liste sentersa.sn) et 23 stations BRT (liste CETUD/SunuBRT, positions de
référence approximatives).

HONNÊTETÉ : ce GTFS est une SYNTHÈSE locale à but de démonstration du
pipeline — horaires cadencés déduits des fréquences annoncées publiquement,
géométrie simplifiée reliant les arrêts. Ce n'est PAS un flux publié par les
opérateurs. Le `feed_info.txt` le dit explicitement, et la fiche de staging
doit porter une provenance et une confiance fidèles (source_type UNKNOWN,
confiance modérée). La publication reste un acte humain : ce script ne publie
rien et n'approuve rien.

Usage :
    python3 tools/build_reference_gtfs.py --out data/reference/dakar-bus-reference.zip
"""

from __future__ import annotations

import argparse
import math
import zipfile
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

TIMEZONE = "Africa/Dakar"

FEED_PUBLISHER = "Dakar Bus — données de référence locales (synthèse)"
FEED_LICENSE = (
    "Synthèse locale à but de démonstration du pipeline de gouvernance. "
    "Listes d'arrêts : Sen TER (sentersa.sn), CETUD/SunuBRT, OpenStreetMap (ODbL). "
    "Ce fichier n'est pas un flux GTFS officiel des opérateurs."
)


@dataclass(frozen=True)
class Stop:
    stop_id: str
    name: str
    lat: float
    lon: float


# Les 13 gares et haltes TER (Dakar → Diamniadio) — positions OSM/SETER.
TER_STOPS = [
    Stop("TER-01", "Dakar", 14.6759856, -17.4335181),
    Stop("TER-02", "Colobane", 14.7003482, -17.4416523),
    Stop("TER-03", "Hann", 14.7220913, -17.4320723),
    Stop("TER-04", "Dalifort", 14.7342483, -17.4189983),
    Stop("TER-05", "Baux Maraîchers", 14.7397124, -17.4036081),
    Stop("TER-06", "Pikine", 14.7498644, -17.3916937),
    Stop("TER-07", "Thiaroye", 14.758771, -17.3802989),
    Stop("TER-08", "Yeumbeul", 14.764913, -17.3565049),
    Stop("TER-09", "Mbao", 14.744079, -17.3138934),
    Stop("TER-10", "PNR", 14.7231692, -17.2839425),
    Stop("TER-11", "Rufisque", 14.7159649, -17.2699985),
    Stop("TER-12", "Bargny", 14.6981798, -17.2292043),
    Stop("TER-13", "Diamniadio", 14.7160641, -17.1984512),
]

# Les 23 stations BRT (Petersen → Préfecture de Guédiawaye) — positions de
# référence approximatives alignées sur le tracé officiel.
BRT_STOPS = [
    Stop("BRT-01", "Petersen – Papa Gueye Fall", 14.6785, -17.4443),
    Stop("BRT-02", "Grande Mosquée", 14.6890, -17.4460),
    Stop("BRT-03", "Place de la Nation", 14.6946, -17.4488),
    Stop("BRT-04", "Dial Diop", 14.6970, -17.4432),
    Stop("BRT-05", "Grand Dakar", 14.6992, -17.4386),
    Stop("BRT-06", "Sacré-Cœur", 14.7070, -17.4332),
    Stop("BRT-07", "Liberté 6", 14.7156, -17.4269),
    Stop("BRT-08", "Liberté 5", 14.7196, -17.4233),
    Stop("BRT-09", "Liberté 1", 14.7236, -17.4181),
    Stop("BRT-10", "Khar Yallah", 14.7280, -17.4131),
    Stop("BRT-11", "Scat Urbam", 14.7330, -17.4076),
    Stop("BRT-12", "Grand Médine", 14.7370, -17.4011),
    Stop("BRT-13", "Croisement 22", 14.7410, -17.3966),
    Stop("BRT-14", "Police des Parcelles", 14.7450, -17.3921),
    Stop("BRT-15", "Parcelles", 14.7500, -17.3881),
    Stop("BRT-16", "Ndingala", 14.7560, -17.3831),
    Stop("BRT-17", "Golf Sud", 14.7630, -17.3751),
    Stop("BRT-18", "Cardinal Hyacinthe Thiandoum", 14.7710, -17.3651),
    Stop("BRT-19", "Dalal Jam", 14.7800, -17.3521),
    Stop("BRT-20", "Golf Nord", 14.7850, -17.3441),
    Stop("BRT-21", "Gueule Tapée", 14.7910, -17.3391),
    Stop("BRT-22", "Fith Mith", 14.7960, -17.3341),
    Stop("BRT-23", "Préfecture de Guédiawaye", 14.8060, -17.3271),
]


@dataclass(frozen=True)
class LineSpec:
    route_id: str
    agency_id: str
    short_name: str
    long_name: str
    route_type: int
    stops: list[Stop]
    speed_kph: float
    dwell_min: float
    headway_min: int
    first_departure_min: int  # minutes après minuit
    last_departure_min: int
    service_id: str
    shape_id: str


LINES = [
    LineSpec("TER", "SETER", "TER", "Dakar ↔ Diamniadio", 2, TER_STOPS, 55.0, 1.0, 15, 5 * 60 + 45, 21 * 60, "REF-DAILY", "TER-SHAPE"),
    LineSpec("B1", "DAKARMOB", "B1", "Petersen – Papa Gueye Fall ↔ Préfecture de Guédiawaye", 700, BRT_STOPS, 25.0, 0.5, 6, 6 * 60, 20 * 60 + 54, "REF-DAILY", "B1-SHAPE"),
]

TRANSFERS = [
    ("TER-01", "BRT-01", 2, "Correspondance de référence Gare TER Dakar ↔ Gare routière de Petersen (~1,2 km à pied)."),
    ("BRT-01", "TER-01", 2, "Correspondance de référence Gare routière de Petersen ↔ Gare TER Dakar (~1,2 km à pied)."),
    ("TER-02", "BRT-02", 2, "Correspondance de référence Gare TER Colobane ↔ station BRT Grande Mosquée (~1,35 km à pied)."),
    ("BRT-02", "TER-02", 2, "Correspondance de référence station BRT Grande Mosquée ↔ Gare TER Colobane (~1,35 km à pied)."),
]


def haversine_m(a: Stop, b: Stop) -> float:
    radius = 6_371_000.0
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlon = math.radians(b.lon - a.lon)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def format_time(total_minutes: int) -> str:
    hours, minutes = divmod(int(round(total_minutes)), 60)
    return f"{hours:02d}:{minutes:02d}:00"


def trip_stop_times(line: LineSpec) -> list[int]:
    """Minutes cumulées le long du parcours (départ à 0)."""
    times = [0.0]
    for index in range(1, len(line.stops)):
        segment_km = haversine_m(line.stops[index - 1], line.stops[index]) / 1000
        times.append(times[-1] + segment_km / line.speed_kph * 60 + line.dwell_min)
    return times


def csv_escape(value: str) -> str:
    if any(character in value for character in [',', '"', '\n']):
        return '"' + value.replace('"', '""') + '"'
    return value


def build_tables(valid_from: date, valid_until: date) -> dict[str, str]:
    tables: dict[str, list[str]] = {}

    tables["agency.txt"] = [
        "agency_id,agency_name,agency_url,agency_timezone,agency_lang",
        f"SETER,{csv_escape('SETER (Sen TER)')},https://www.senersa.sn,{TIMEZONE},fr",
        f"DAKARMOB,{csv_escape('Dakar Mobilité (SunuBRT / CETUD)')},https://www.sunubrt.sn,{TIMEZONE},fr",
    ]

    stops = ["stop_id,stop_name,stop_lat,stop_lon"]
    for stop in [*TER_STOPS, *BRT_STOPS]:
        stops.append(f"{stop.stop_id},{csv_escape(stop.name)},{stop.lat:.7f},{stop.lon:.7f}")
    tables["stops.txt"] = stops

    routes = ["route_id,agency_id,route_short_name,route_long_name,route_type,route_color"]
    routes.append('TER,SETER,TER,"Dakar ↔ Diamniadio",2,2F6FB3')
    routes.append('B1,DAKARMOB,B1,"Petersen – Papa Gueye Fall ↔ Préfecture de Guédiawaye",700,0F8F66')
    tables["routes.txt"] = routes

    tables["calendar.txt"] = [
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date",
        f"REF-DAILY,1,1,1,1,1,1,1,{valid_from:%Y%m%d},{valid_until:%Y%m%d}",
    ]

    trips: list[str] = ["route_id,service_id,trip_id,shape_id,trip_headsign"]
    stop_times: list[str] = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"]
    for line in LINES:
        offsets = trip_stop_times(line)
        trip_count = 0
        departure = line.first_departure_min
        while departure <= line.last_departure_min:
            for direction in (0, 1):
                trip_count += 1
                trip_id = f"{line.route_id}-{direction}-{trip_count:04d}"
                headsign = line.stops[-1 if direction == 0 else 0].name
                trips.append(f"{line.route_id},{line.service_id},{trip_id},{line.shape_id},{csv_escape(headsign)}")
                ordered = offsets if direction == 0 else [offsets[-1] - value for value in reversed(offsets)]
                stops_seq = line.stops if direction == 0 else list(reversed(line.stops))
                for sequence, (stop, offset) in enumerate(zip(stops_seq, ordered), start=1):
                    when = format_time(departure + offset)
                    stop_times.append(f"{trip_id},{when},{when},{stop.stop_id},{sequence}")
            departure += line.headway_min
    tables["trips.txt"] = trips
    tables["stop_times.txt"] = stop_times

    shapes = ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence"]
    for line in LINES:
        for sequence, stop in enumerate(line.stops, start=1):
            shapes.append(f"{line.shape_id},{stop.lat:.7f},{stop.lon:.7f},{sequence}")
    tables["shapes.txt"] = shapes

    transfers = ["from_stop_id,to_stop_id,transfer_type,min_transfer_time"]
    for from_id, to_id, transfer_type, _note in TRANSFERS:
        transfers.append(f"{from_id},{to_id},{transfer_type},{15 * 60}")
    tables["transfers.txt"] = transfers

    tables["feed_info.txt"] = [
        "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_license",
        f"{csv_escape(FEED_PUBLISHER)},https://github.com/yanks880/Dakar-Bus,fr,"
        f"{valid_from:%Y%m%d},{valid_until:%Y%m%d},reference-2026.10.08,{csv_escape(FEED_LICENSE)}",
    ]

    return {name: "\n".join(rows) + "\n" for name, rows in tables.items()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("data/reference/dakar-bus-reference.zip"))
    parser.add_argument("--valid-from", type=date.fromisoformat, default=date(2026, 7, 1))
    parser.add_argument("--valid-until", type=date.fromisoformat, default=date(2027, 6, 30))
    args = parser.parse_args()

    tables = build_tables(args.valid_from, args.valid_until)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in tables.items():
            archive.writestr(name, content)

    rows = {name: content.count("\n") - 1 for name, content in tables.items()}
    print(f"Archive de référence écrite : {args.out}")
    for name, count in rows.items():
        print(f"  {name}: {count} lignes")
    print("Rappel : ceci est une synthèse locale de démonstration — le staging,")
    print("la revue et la publication restent des étapes humaines distinctes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
