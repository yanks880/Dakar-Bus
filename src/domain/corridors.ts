/**
 * Réseau de référence TER / BRT de la région de Dakar.
 *
 * PROVENANCE :
 * - Les références de réseau du dépôt citent Sen TER/sentersa.sn, CETUD/SunuBRT
 *   et OpenStreetMap. Aucune vérification externe ni date de vérification des
 *   positions n'est enregistrée dans ce module.
 * - Les coordonnées des gares et stations sont des valeurs statiques associées
 *   à des identifiants de référence, notamment `osmNodeId` pour le BRT. Le dépôt
 *   n'atteste pas leur exactitude actuelle ; aucune position n'est interpolée
 *   au chargement de la carte.
 * - Les tracés relient ces arrêts dans l'ordre encodé pour cette couche de
 *   référence ; ils ne sont ni un tracé métrique des voies, ni un flux GTFS.
 *
 * Ce module ne publie donc rien au sens du pipeline de gouvernance du dépôt :
 * il alimente une couche cartographique et un calculateur explicitement
 * étiquetés « réseau de référence ». Les fréquences de référence restent
 * distinctes des horaires GTFS et du temps réel (aucune position de véhicule).
 */

import { FREQUENCY_SOURCES, OFFICIAL_REFERENCE_FREQUENCIES, type FrequencySource, type FrequencyStatus, type OfficialFrequency } from './frequencies'

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
  /** Identification de la source de la position : nœud OpenStreetMap. */
  osmNodeId?: number
}

export interface CorridorLine {
  id: string
  network: CorridorNetworkId
  shortName: string
  longName: string
  color: string
  /** Identifiants d'arrêts desservis, dans l'ordre de parcours. */
  stopIds: readonly string[]
  /**
   * Entrée technique du calculateur (attente théorique uniquement). Pour TER,
   * utilise le headway officiel maximal, faute de date/heure dans ce plan.
   */
  headwayMin: number
  frequencyStatus: FrequencyStatus
  frequencySource: FrequencySource
  officialFrequencies: readonly OfficialFrequency[]
  /** Synthèse lisible des périodes de service officielles. */
  serviceWindow: string
  /** Vitesse commerciale moyenne retenue pour les estimations (km/h). */
  speedKph: number
  /** Arrêts « semi-express » (desservis par les services B2/B3 documentés),
   *  si applicable. Ici : la desserte annoncée du B3 (7 stations). */
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
      'Stations : référence CETUD / sunubrt.sn (23 stations entre Petersen – Papa Gueye Fall et la Préfecture de Guédiawaye). Le projet consigne des coordonnées et identifiants de nœuds OpenStreetMap de la relation B1 (19961937/19961993, network=SunuBRT) ; leur date de vérification externe n’est pas documentée. Tracé : liaison des arrêts dans l’ordre de desserte, pas le tracé métrique des voies.',
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
  { id: 'ter-mbao', name: 'Keur Mbaye Fall', lat: 14.744079, lon: -17.3138934, order: 8, aliases: ['mbao', 'keur massar'], note: 'Zone 3' },
  { id: 'ter-pnr', name: 'PNR', lat: 14.7231692, lon: -17.2839425, order: 9, aliases: ['pole nouvelle rufisque'], note: 'Zone 3' },
  { id: 'ter-rufisque', name: 'Rufisque', lat: 14.7159649, lon: -17.2699985, order: 10, aliases: [], note: 'Zone 3' },
  { id: 'ter-bargny', name: 'Bargny', lat: 14.6981798, lon: -17.2292043, order: 11, aliases: [], note: 'Zone 3' },
  { id: 'ter-diamniadio', name: 'Diamniadio', lat: 14.7160641, lon: -17.1984512, order: 12, aliases: ['ville nouvelle'], note: 'Zone 3 · terminus' },
]

/** Référence de 23 stations BRT, Petersen – Papa Gueye Fall → Préfecture de Guédiawaye.
 *
 *  La séquence et les coordonnées sont des valeurs statiques conservées dans le
 *  dépôt ; les identifiants OSM sont consignés comme provenance de ces données,
 *  mais leur exactitude et leur date de vérification externe ne sont pas
 *  attestées ici. Les positions ne sont pas interpolées par l'application.
 *
 *  Deux identifiants sont commentés comme variantes de sens ou de pôle dans les
 *  données de référence : les éventuelles distances entre ces points ne sont
 *  pas utilisées pour calculer des horaires ou une position véhicule. */
export const BRT_STOPS: readonly CorridorStop[] = [
  { id: 'brt-petersen', name: 'Petersen – Papa Gueye Fall', lat: 14.6766438, lon: -17.4406354, order: 0, aliases: ['petersen', 'papa gueye fall', 'gare de petersen', 'gare routiere de petersen', 'terminal cabral', 'pem petersen'], note: 'Pôle d’échange · terminus', osmNodeId: 13376764678 },
  { id: 'brt-grande-mosquee', name: 'Grande Mosquée', lat: 14.6824846, lon: -17.4443248, order: 1, aliases: ['mosquee de dakar', 'grande mosquee'], note: undefined, osmNodeId: 13376766853 },
  { id: 'brt-place-nation', name: 'Place de la Nation', lat: 14.6960909, lon: -17.4506369, order: 2, aliases: ['obelisque', 'place de l’obelisque'], note: undefined, osmNodeId: 11739960199 },
  { id: 'brt-dial-diop', name: 'Dial Diop', lat: 14.6993790, lon: -17.4535498, order: 3, aliases: ['boulevard dial diop'], note: undefined, osmNodeId: 11739960196 },
  { id: 'brt-grand-dakar', name: 'Grand Dakar', lat: 14.7049934, lon: -17.4583342, order: 4, aliases: [], note: undefined, osmNodeId: 11739960194 },
  { id: 'brt-liberte-1', name: 'Liberté 1', lat: 14.7099321, lon: -17.4624955, order: 5, aliases: ['liberte 1'], note: undefined, osmNodeId: 11739960190 },
  { id: 'brt-sacre-coeur', name: 'Sacré-Cœur', lat: 14.7169687, lon: -17.4665407, order: 6, aliases: ['sacre coeur', 'college sacre-coeur'], note: undefined, osmNodeId: 11739960188 },
  { id: 'brt-liberte-5', name: 'Liberté 5', lat: 14.7210415, lon: -17.4640450, order: 7, aliases: ['liberte 5'], note: undefined, osmNodeId: 11739960184 },
  { id: 'brt-liberte-6', name: 'Liberté 6', lat: 14.7263088, lon: -17.4591976, order: 8, aliases: ['liberte 6', 'rond-point liberte 6'], note: undefined, osmNodeId: 11739960181 },
  { id: 'brt-khar-yallah', name: 'Khar Yalla', lat: 14.7320392, lon: -17.4564326, order: 9, aliases: ['khar yalla', 'khar yallah'], note: undefined, osmNodeId: 11738664241 },
  { id: 'brt-scat-urbam', name: 'Scat Urbam', lat: 14.7369859, lon: -17.4552396, order: 10, aliases: ['scat'], note: undefined, osmNodeId: 11738664176 },
  { id: 'brt-thiandoum', name: 'Cardinal Hyacinthe Thiandoum', lat: 14.7415853, lon: -17.4513360, order: 11, aliases: ['thiandoum'], note: undefined, osmNodeId: 11739848237 },
  { id: 'brt-grand-medine', name: 'Grand Médine', lat: 14.7481903, lon: -17.4444326, order: 12, aliases: ['grand medine', 'pem grand medine'], note: 'Pôle d’échange', osmNodeId: 11739848234 },
  { id: 'brt-police-parcelles', name: 'Police des Parcelles', lat: 14.7510760, lon: -17.4387907, order: 13, aliases: ['police parcelles assainies'], note: undefined, osmNodeId: 11739848233 },
  { id: 'brt-croisement-22', name: 'Croisement 22', lat: 14.7539779, lon: -17.4332535, order: 14, aliases: ['croisement 22'], note: undefined, osmNodeId: 11739848217 },
  { id: 'brt-parcelles', name: 'Parcelles', lat: 14.7626996, lon: -17.4242946, order: 15, aliases: ['parcelles assainies'], note: undefined, osmNodeId: 11739850196 },
  { id: 'brt-ndingala', name: 'Ndingala', lat: 14.7646271, lon: -17.4196781, order: 16, aliases: ['ndinguela'], note: undefined, osmNodeId: 11739850112 },
  { id: 'brt-golf-sud', name: 'Golf Sud', lat: 14.7675735, lon: -17.4134425, order: 17, aliases: ['golf sud guediawaye'], note: undefined, osmNodeId: 11739850115 },
  { id: 'brt-dalal-jam', name: 'Dalal Jamm', lat: 14.7719783, lon: -17.4082010, order: 18, aliases: ['dalal diam', 'dalal jam', 'hopital dalal jamm'], note: undefined, osmNodeId: 11739850118 },
  { id: 'brt-fith-mith', name: 'Fith Mith', lat: 14.7753280, lon: -17.4055188, order: 19, aliases: ['fith mith'], note: undefined, osmNodeId: 11739850121 },
  { id: 'brt-golf-nord', name: 'Golf Nord', lat: 14.7763179, lon: -17.3984054, order: 20, aliases: ['golf nord guediawaye'], note: undefined, osmNodeId: 11739850125 },
  { id: 'brt-gueule-tapee', name: 'Gueule Tapée', lat: 14.7756271, lon: -17.3921489, order: 21, aliases: ['gueule tapee'], note: undefined, osmNodeId: 11739850126 },
  { id: 'brt-prefecture-guediawaye', name: 'Préfecture de Guédiawaye', lat: 14.7719791, lon: -17.3868591, order: 22, aliases: ['prefecture guediawaye', 'guédiawaye', 'guediawaye', 'pole guediawaye', 'pem guediawaye'], note: 'Pôle d’échange · terminus', osmNodeId: 11739850129 },
]

export const CORRIDOR_LINES: readonly CorridorLine[] = [
  {
    id: 'ter-dakar-diamniadio',
    network: 'ter',
    shortName: 'TER',
    longName: 'Dakar ↔ Diamniadio',
    color: '#2f6fb3',
    stopIds: TER_STOPS.map((stop) => stop.id),
    // L'estimateur de correspondance n'a pas d'heure/jour de départ : il
    // retient prudemment le maximum officiel (20 min), sans l'afficher comme
    // une cadence permanente. Les fenêtres ci-dessous restent la référence.
    headwayMin: 20,
    frequencyStatus: 'OFFICIAL_REFERENCE',
    frequencySource: FREQUENCY_SOURCES.ter,
    officialFrequencies: OFFICIAL_REFERENCE_FREQUENCIES.ter,
    serviceWindow: '05:30–22:00 selon la période : 10 min en journée, 20 min le soir et les dimanches/jours fériés',
    speedKph: 55,
  },
  {
    id: 'brt-b1',
    network: 'brt',
    shortName: 'B1',
    // La presse récente annonce « 21 stations desservies » par la B1 sans
    // nommer les arrêts écartés ; la relation OpenStreetMap B1 (network=SunuBRT)
    // et la modélisation « omnibus » retiennent, elles, les 23 stations du
    // corridor. Aucun arrêt n'est retiré sur une base non nommée : l'écart
    // reste signalé ici plutôt que deviné.
    longName: 'Petersen – Papa Gueye Fall ↔ Préfecture de Guédiawaye (omnibus)',
    color: '#0f8f66',
    stopIds: BRT_STOPS.map((stop) => stop.id),
    headwayMin: 6,
    frequencyStatus: 'OFFICIAL_REFERENCE',
    frequencySource: FREQUENCY_SOURCES.brt,
    officialFrequencies: OFFICIAL_REFERENCE_FREQUENCIES.brt,
    serviceWindow: '06:00–21:00 · fréquence officielle de référence : 6 min',
    speedKph: 25,
    // Desserte annoncée du service semi-express B3 (SunuBRT, octobre 2025),
    // remise dans l’ordre de parcours Petersen → Guédiawaye.
    expressStopIds: [
      'brt-petersen',
      'brt-place-nation',
      'brt-khar-yallah',
      'brt-croisement-22',
      'brt-parcelles',
      'brt-gueule-tapee',
      'brt-prefecture-guediawaye',
    ],
  },
]

/** Correspondances marchables de référence entre les deux réseaux.
 *  Distances de marche estimées à partir des positions déclarées des deux
 *  arrêts (≈ 1,3 × la distance à vol d’oiseau) : ce sont des estimations,
 *  pas un cheminement piéton calculé. Les deux paires retenues sont les plus
 *  proches du réseau : Petersen ↔ Gare de Dakar (770 m à vol d’oiseau) et
 *  Place de la Nation ↔ Colobane (1 080 m à vol d’oiseau). */
export const CORRIDOR_TRANSFERS: readonly CorridorTransfer[] = [
  {
    fromStopId: 'ter-dakar',
    toStopId: 'brt-petersen',
    walkM: 1000,
    label: 'Gare TER Dakar ↔ station BRT Petersen – Papa Gueye Fall (marche de référence ~1 km)',
  },
  {
    fromStopId: 'ter-colobane',
    toStopId: 'brt-place-nation',
    walkM: 1400,
    label: 'Gare TER Colobane ↔ station BRT Place de la Nation (marche de référence ~1,4 km)',
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
