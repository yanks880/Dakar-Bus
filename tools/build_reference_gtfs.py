#!/usr/bin/env python3
"""Construit une archive GTFS Static « réseau de référence » TER + BRT.

Objet : alimenter le pipeline de gouvernance local (staging → revue →
publication) avec les corridors de référence déjà utilisés par l'interface
(`src/domain/corridors.ts`) : 13 gares TER (positions OpenStreetMap/SETER,
liste sentersa.sn) et 23 stations BRT (liste CETUD/SunuBRT ; positions associées
aux nœuds OpenStreetMap de la relation B1, network=SunuBRT ; leur date de
vérification externe n'est pas documentée dans le dépôt).

HONNÊTETÉ : ce GTFS est une SYNTHÈSE locale à but de démonstration du
pipeline — horaires cadencés déduits des fréquences annoncées publiquement,
géométrie reliant les arrêts dans l'ordre de desserte (pas le tracé métrique
des voies). Ce n'est PAS un flux publié par les opérateurs. Le `feed_info.txt`
le dit explicitement, et la fiche de staging doit porter une provenance et une
confiance fidèles (source_type UNKNOWN, confiance modérée). La publication
reste un acte humain : ce script ne publie rien et n'approuve rien.

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
    Stop("TER-09", "Keur Mbaye Fall", 14.744079, -17.3138934),
    Stop("TER-10", "PNR", 14.7231692, -17.2839425),
    Stop("TER-11", "Rufisque", 14.7159649, -17.2699985),
    Stop("TER-12", "Bargny", 14.6981798, -17.2292043),
    Stop("TER-13", "Diamniadio", 14.7160641, -17.1984512),
]

# Les 23 stations BRT (Petersen – Papa Gueye Fall → Préfecture de Guédiawaye).
# Ordre de desserte verrouillé sur la relation OpenStreetMap B1 « Omnibus »
# (relations 19961937 sens Guédiawaye → Petersen et 19961993 sens inverse,
# network=SunuBRT), parcourue ici dans le sens Plateau → Guédiawaye.
# Coordonnées associées aux nœuds `stop_position` OSM indiqués en commentaire ;
# la date de vérification externe n'est pas documentée — aucune interpolation.
BRT_STOPS = [
    Stop("BRT-01", "Petersen – Papa Gueye Fall", 14.6766438, -17.4406354),  # 13376764678
    Stop("BRT-02", "Grande Mosquée", 14.6824846, -17.4443248),  # 13376766853
    Stop("BRT-03", "Place de la Nation", 14.6960909, -17.4506369),  # 11739960199
    Stop("BRT-04", "Dial Diop", 14.6993790, -17.4535498),  # 11739960196
    Stop("BRT-05", "Grand Dakar", 14.7049934, -17.4583342),  # 11739960194
    Stop("BRT-06", "Liberté 1", 14.7099321, -17.4624955),  # 11739960190
    Stop("BRT-07", "Sacré-Cœur", 14.7169687, -17.4665407),  # 11739960188
    Stop("BRT-08", "Liberté 5", 14.7210415, -17.4640450),  # 11739960184
    Stop("BRT-09", "Liberté 6", 14.7263088, -17.4591976),  # 11739960181
    Stop("BRT-10", "Khar Yalla", 14.7320392, -17.4564326),  # 11738664241
    Stop("BRT-11", "Scat Urbam", 14.7369859, -17.4552396),  # 11738664176
    Stop("BRT-12", "Cardinal Hyacinthe Thiandoum", 14.7415853, -17.4513360),  # 11739848237
    Stop("BRT-13", "Grand Médine", 14.7481903, -17.4444326),  # 11739848234
    Stop("BRT-14", "Police des Parcelles", 14.7510760, -17.4387907),  # 11739848233
    Stop("BRT-15", "Croisement 22", 14.7539779, -17.4332535),  # 11739848217
    Stop("BRT-16", "Parcelles", 14.7626996, -17.4242946),  # 11739850196
    Stop("BRT-17", "Ndingala", 14.7646271, -17.4196781),  # 11739850112
    Stop("BRT-18", "Golf Sud", 14.7675735, -17.4134425),  # 11739850115
    Stop("BRT-19", "Dalal Jamm", 14.7719783, -17.4082010),  # 11739850118
    Stop("BRT-20", "Fith Mith", 14.7753280, -17.4055188),  # 11739850121
    Stop("BRT-21", "Golf Nord", 14.7763179, -17.3984054),  # 11739850125
    Stop("BRT-22", "Gueule Tapée", 14.7756271, -17.3921489),  # 11739850126
    Stop("BRT-23", "Préfecture de Guédiawaye", 14.7719791, -17.3868591),  # 11739850129
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
    ("TER-01", "BRT-01", 2, "Correspondance de référence Gare TER Dakar ↔ station BRT Petersen – Papa Gueye Fall (~1 km à pied)."),
    ("BRT-01", "TER-01", 2, "Correspondance de référence station BRT Petersen – Papa Gueye Fall ↔ Gare TER Dakar (~1 km à pied)."),
    ("TER-02", "BRT-03", 2, "Correspondance de référence Gare TER Colobane ↔ station BRT Place de la Nation (~1,4 km à pied)."),
    ("BRT-03", "TER-02", 2, "Correspondance de référence station BRT Place de la Nation ↔ Gare TER Colobane (~1,4 km à pied)."),
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
