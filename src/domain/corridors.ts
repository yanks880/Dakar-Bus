/**
 * Réseau de référence TER / BRT de la région de Dakar.
 *
 * STATUT DES DONNÉES (important) :
 * - La liste des 13 gares TER et des 23 stations BRT provient de sources
 *   publiques concordantes : sentersa.sn (plan de transport officiel),
 *   sunubrt.sn / CETUD (brochure officielle du projet BRT) et les
 *   communiqués Dakar Mobilité repris par la presse (2024-2025).
 * - Les coordonnées des 13 gares TER proviennent d'OpenStreetMap
 *   (nœuds `railway=station`, opérateur déclaré SETER), recoupées avec
 *   Nominatim ; ce sont les positions des bâtiments de gare.
 * - Les positions des 23 stations BRT sont des positions de référence
 *   APPROXIMATIVES alignées sur le tracé officiel (Petersen → Guédiawaye) ;
 *   elles restent indicatives tant qu'un géocodage officiel n'est pas fourni.
 * - Les tracés (polylines) sont une géométrie de référence SIMPLIFIÉE reliant
 *   les arrêts dans l'ordre de desserte : ce n'est pas le tracé métrique des
 *   voies, et ce n'est pas un flux GTFS publié.
 *
 * Ce module ne publie donc rien au sens du pipeline de gouvernance du dépôt :
 * il alimente une couche cartographique et un calculateur explicitement
 * étiquetés « réseau de référence ». Les horaires restent des fréquences
 * annoncées publiquement (pas de temps réel, pas de positions de véhicules).
 */

export type CorridorNetworkId = 'ter' | 'brt'

export interface CorridorStop {
  id: string
  name: string
  lat: number
  lon: number
  /** Ordre de desserte sur la ligne principale (0-based). */
  order: number
  /** Alias et repères connus des usagers, pour la recherche et l'assistant. */
  aliases: readonly string[]
  /** TER : zone tarifaire déclarée (1-3). BRT : pôle d'échange éventuel. */
  note?: string
}

export interface CorridorLine {
  id: string
  network: CorridorNetworkId
  shortName: string
  longName: string
  color: string
  /** Identifiants d'arrêts desservis, dans l'ordre de parcours. */
  stopIds: readonly string[]
  /** Fréquence annoncée publiquement (minutes) — pas un horaire temps réel. */
  headwayMin: number
  /** Plage de service annoncée publiquement. */
  serviceWindow: string
  /** Vitesse commerciale moyenne retenue pour les estimations (km/h). */
  speedKph: number
  /** Arrêts « semi-express » (desservis par B2/B3), si applicable. */
  expressStopIds?: readonly string[]
}

export interface CorridorTransfer {
  fromStopId: string
  toStopId: string
  /** Distance de marche de référence entre les deux points (mètres). */
  walkM: number
  label: string
}

export interface CorridorNetwork {
  id: CorridorNetworkId
  label: string
  operator: string
  description: string
  /** Provenance déclarée, affichée telle quelle dans l'interface. */
  provenance: string
}

/** Enveloppe géographique couvrant la région : Almadies → Rufisque/Bargny,
 *  étendue jusqu'à Diamniadio (terminus TER) et Guédiawaye (terminus BRT). */
export const DAKAR_REGION_BOUNDS: { minLat: number; minLon: number; maxLat: number; maxLon: number } = {
  minLat: 14.60,
  minLon: -17.56,
  maxLat: 14.84,
  maxLon: -17.16,
}

export const CORRIDOR_NETWORKS: Record<CorridorNetworkId, CorridorNetwork> = {
  ter: {
    id: 'ter',
    label: 'TER',
    operator: 'SETER (Sen TER)',
    description: 'Train express régional Dakar ↔ Diamniadio — 36 km, 13 gares et haltes.',
    provenance:
      'Gares : plan de transport sentersa.sn et positions OpenStreetMap (opérateur SETER). Tracé de référence simplifié.',
  },
  brt: {
    id: 'brt',
    label: 'BRT (SunuBRT)',
    operator: 'Dakar Mobilité (CETUD)',
    description: 'Bus à haut niveau de service Petersen ↔ Préfecture de Guédiawaye — 18,3 km, 23 stations.',
    provenance:
      'Stations : CETUD / sunubrt.sn et communiqués Dakar Mobilité (2024-2025). Positions de référence approximatives, tracé simplifié.',
  },
}

/** Les 13 gares et haltes du TER, Dakar → Diamniadio.
 *  Coordonnées : OpenStreetMap, nœuds railway=station, operator=SETER. */
export const TER_STOPS: readonly CorridorStop[] = [
  { id: 'ter-dakar', name: 'Dakar', lat: 14.6759856, lon: -17.4335181, order: 0, aliases: ['gare de dakar', 'plateau', 'gare centrale'], note: 'Zone 1' },
  { id: 'ter-colobane', name: 'Colobane', lat: 14.7003482, lon: -17.4416523, order: 1, aliases: ['colobanne'], note: 'Zone 1' },
  { id: 'ter-hann', name: 'Hann', lat: 14.7220913, lon: -17.4320723, order: 2, aliases: ['hann maristes'], note: 'Zone 1' },
  { id: 'ter-dalifort', name: 'Dalifort', lat: 14.7342483, lon: -17.4189983, order: 3, aliases: [], note: 'Zone 1' },
  { id: 'ter-baux-maraichers', name: 'Baux Maraîchers', lat: 14.7397124, lon: -17.4036081, order: 4, aliases: ['beaux maraichers', 'baux maraichers'], note: 'Zone 2' },
  { id: 'ter-pikine', name: 'Pikine', lat: 14.7498644, lon: -17.3916937, order: 5, aliases: [], note: 'Zone 2' },
  { id: 'ter-thiaroye', name: 'Thiaroye', lat: 14.758771, lon: -17.3802989, order: 6, aliases: ['thiaroye gare'], note: 'Zone 2' },
  { id: 'ter-yeumbeul', name: 'Yeumbeul', lat: 14.764913, lon: -17.3565049, order: 7, aliases: [], note: 'Zone 2' },
  { id: 'ter-mbao', name: 'Mbao', lat: 14.744079, lon: -17.3138934, order: 8, aliases: ['keur massar'], note: 'Zone 3' },
  { id: 'ter-pnr', name: 'PNR', lat: 14.7231692, lon: -17.2839425, order: 9, aliases: ['pole nouvelle rufisque'], note: 'Zone 3' },
  { id: 'ter-rufisque', name: 'Rufisque', lat: 14.7159649, lon: -17.2699985, order: 10, aliases: [], note: 'Zone 3' },
  { id: 'ter-bargny', name: 'Bargny', lat: 14.6981798, lon: -17.2292043, order: 11, aliases: [], note: 'Zone 3' },
  { id: 'ter-diamniadio', name: 'Diamniadio', lat: 14.7160641, lon: -17.1984512, order: 12, aliases: ['ville nouvelle'], note: 'Zone 3 · terminus' },
]

/** Les 23 stations du BRT, Petersen → Préfecture de Guédiawaye.
 *  Positions de référence approximatives le long du tracé officiel. */
export const BRT_STOPS: readonly CorridorStop[] = [
  { id: 'brt-petersen', name: 'Petersen – Papa Gueye Fall', lat: 14.6785, lon: -17.4443, order: 0, aliases: ['petersen', 'papa gueye fall', 'gare de petersen', 'terminal cabral'], note: 'Pôle d’échange · terminus' },
  { id: 'brt-grande-mosquee', name: 'Grande Mosquée', lat: 14.689, lon: -17.446, order: 1, aliases: ['mosquee de dakar'], note: undefined },
  { id: 'brt-place-nation', name: 'Place de la Nation', lat: 14.6946, lon: -17.4488, order: 2, aliases: ['obelisque', 'place de l’obelisque'], note: undefined },
  { id: 'brt-dial-diop', name: 'Dial Diop', lat: 14.697, lon: -17.4432, order: 3, aliases: ['boulevard dial diop'], note: undefined },
  { id: 'brt-grand-dakar', name: 'Grand Dakar', lat: 14.6992, lon: -17.4386, order: 4, aliases: [], note: undefined },
  { id: 'brt-sacre-coeur', name: 'Sacré-Cœur', lat: 14.707, lon: -17.4332, order: 5, aliases: ['sacre coeur', 'college sacre-coeur'], note: undefined },
  { id: 'brt-liberte-6', name: 'Liberté 6', lat: 14.7156, lon: -17.4269, order: 6, aliases: ['liberte 6', 'rond-point liberte 6'], note: undefined },
  { id: 'brt-liberte-5', name: 'Liberté 5', lat: 14.7196, lon: -17.4233, order: 7, aliases: ['liberte 5'], note: undefined },
  { id: 'brt-liberte-1', name: 'Liberté 1', lat: 14.7236, lon: -17.4181, order: 8, aliases: ['liberte 1'], note: undefined },
  { id: 'brt-khar-yallah', name: 'Khar Yallah', lat: 14.728, lon: -17.4131, order: 9, aliases: ['khar yalla'], note: undefined },
  { id: 'brt-scat-urbam', name: 'Scat Urbam', lat: 14.733, lon: -17.4076, order: 10, aliases: ['scat'], note: undefined },
  { id: 'brt-grand-medine', name: 'Grand Médine', lat: 14.737, lon: -17.4011, order: 11, aliases: ['grand medine'], note: 'Pôle d’échange' },
  { id: 'brt-croisement-22', name: 'Croisement 22', lat: 14.741, lon: -17.3966, order: 12, aliases: ['croisement 22'], note: undefined },
  { id: 'brt-police-parcelles', name: 'Police des Parcelles', lat: 14.745, lon: -17.3921, order: 13, aliases: ['police parcelles assainies'], note: undefined },
  { id: 'brt-parcelles', name: 'Parcelles', lat: 14.75, lon: -17.3881, order: 14, aliases: ['parcelles assainies'], note: undefined },
  { id: 'brt-ndingala', name: 'Ndingala', lat: 14.756, lon: -17.3831, order: 15, aliases: ['ndinguela'], note: undefined },
  { id: 'brt-golf-sud', name: 'Golf Sud', lat: 14.763, lon: -17.3751, order: 16, aliases: ['golf sud guediawaye'], note: undefined },
  { id: 'brt-thiandoum', name: 'Cardinal Hyacinthe Thiandoum', lat: 14.771, lon: -17.3651, order: 17, aliases: ['thiandoum'], note: undefined },
  { id: 'brt-dalal-jam', name: 'Dalal Jam', lat: 14.78, lon: -17.3521, order: 18, aliases: ['dalal diam', 'hopital dalal jam', 'dalal jam'], note: undefined },
  { id: 'brt-golf-nord', name: 'Golf Nord', lat: 14.785, lon: -17.3441, order: 19, aliases: ['golf nord guediawaye'], note: undefined },
  { id: 'brt-gueule-tapee', name: 'Gueule Tapée', lat: 14.791, lon: -17.3391, order: 20, aliases: ['gueule tapee'], note: undefined },
  { id: 'brt-fith-mith', name: 'Fith Mith', lat: 14.796, lon: -17.3341, order: 21, aliases: ['fith mith'], note: undefined },
  { id: 'brt-prefecture-guediawaye', name: 'Préfecture de Guédiawaye', lat: 14.806, lon: -17.3271, order: 22, aliases: ['prefecture guediawaye', 'guédiawaye', 'guediawaye', 'pole guediawaye'], note: 'Pôle d’échange · terminus' },
]

export const CORRIDOR_LINES: readonly CorridorLine[] = [
  {
    id: 'ter-dakar-diamniadio',
    network: 'ter',
    shortName: 'TER',
    longName: 'Dakar ↔ Diamniadio',
    color: '#2f6fb3',
    stopIds: TER_STOPS.map((stop) => stop.id),
    headwayMin: 15,
    serviceWindow: 'fréquence annoncée de 10 à 20 min',
    speedKph: 55,
  },
  {
    id: 'brt-b1',
    network: 'brt',
    shortName: 'B1',
    longName: 'Petersen – Papa Gueye Fall ↔ Préfecture de Guédiawaye (omnibus)',
    color: '#0f8f66',
    stopIds: BRT_STOPS.map((stop) => stop.id),
    headwayMin: 6,
    serviceWindow: '6 h – 21 h, passage annoncé toutes les 6 min',
    speedKph: 25,
    expressStopIds: [
      'brt-petersen',
      'brt-place-nation',
      'brt-grand-dakar',
      'brt-sacre-coeur',
      'brt-grand-medine',
      'brt-dalal-jam',
      'brt-prefecture-guediawaye',
    ],
  },
]

/** Correspondances marchables de référence entre les deux réseaux.
 *  Distances indicatives entre les bâtiments, pas de cheminement déclaré. */
export const CORRIDOR_TRANSFERS: readonly CorridorTransfer[] = [
  {
    fromStopId: 'ter-dakar',
    toStopId: 'brt-petersen',
    walkM: 1200,
    label: 'Gare TER Dakar ↔ Gare routière de Petersen (marche de référence ~1,2 km)',
  },
  {
    fromStopId: 'ter-colobane',
    toStopId: 'brt-grande-mosquee',
    walkM: 1350,
    label: 'Gare TER Colobane ↔ station BRT Grande Mosquée (marche de référence ~1,35 km)',
  },
]

export const ALL_CORRIDOR_STOPS: readonly CorridorStop[] = [...TER_STOPS, ...BRT_STOPS]

export function getCorridorStop(stopId: string): CorridorStop | null {
  return ALL_CORRIDOR_STOPS.find((stop) => stop.id === stopId) ?? null
}

export function linesServingStop(stopId: string): CorridorLine[] {
  return CORRIDOR_LINES.filter((line) => line.stopIds.includes(stopId))
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Recherche tolérante d'un arrêt de référence par nom ou alias.
 *  Ne devine jamais : renvoie les correspondances explicites uniquement. */
export function searchCorridorStops(query: string): CorridorStop[] {
  const needle = normalize(query)
  if (!needle) return []
  const exact: CorridorStop[] = []
  const partial: CorridorStop[] = []
  for (const stop of ALL_CORRIDOR_STOPS) {
    const haystacks = [stop.name, ...stop.aliases].map(normalize)
    if (haystacks.includes(needle)) {
      exact.push(stop)
    } else if (haystacks.some((value) => value.includes(needle) || needle.includes(value))) {
      partial.push(stop)
    }
  }
  return [...exact, ...partial]
}

/** Distance orthodromique en mètres. */
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180
  const earthRadius = 6_371_000
  const dLat = toRadians(b.lat - a.lat)
  const dLon = toRadians(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(h))
}

export function nearestCorridorStops(point: { lat: number; lon: number }, limit = 3): { stop: CorridorStop; distanceM: number }[] {
  return ALL_CORRIDOR_STOPS.map((stop) => ({ stop, distanceM: haversineMeters(point, stop) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit)
}
