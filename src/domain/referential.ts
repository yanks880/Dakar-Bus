/**
 * Référentiel central des mobilités de Dakar.
 *
 * Ce module est le point d'entrée unique qui alimente simultanément la carte,
 * la recherche d'arrêts et de lignes, le calculateur d'itinéraires et le
 * copilote. Il ne duplique aucune donnée : il dérive des modules existants
 * (`corridors.ts`, `frequencies.ts`, `network.ts`), qui restent la source de
 * vérité, et il leur ajoute ce qui manquait : un modèle commun par réseau
 * (identifiants, classification, statut d'intégration, provenance, statut
 * temporel) et des requêtes transverses (arrêt par nom ou alias, ligne par
 * numéro ou nom, arrêts entre deux points, dernier départ publié, état des
 * connaissances).
 *
 * Règle absolue inchangée : aucune donnée inventée. Ce qui n'est pas sourcé
 * est marqué UNKNOWN ou « métadonnées réseau seulement », jamais complété.
 */

import {
  ALL_CORRIDOR_STOPS,
  CORRIDOR_LINES,
  CORRIDOR_TRANSFERS,
  getCorridorStop,
  linesServingStop,
  nearestCorridorStops,
  searchCorridorStops,
  type CorridorLine,
  type CorridorStop,
} from './corridors'
import {
  NETWORK_REFERENCE_DATA,
  OFFICIAL_REFERENCE_FREQUENCIES,
  type FrequencySource,
  type ReferenceNetworkId,
} from './frequencies'

/** Statut de toute information temporelle affichée par l'application. */
export type TimeInfoStatus = 'SCHEDULED' | 'ESTIMATED' | 'REAL_TIME' | 'UNKNOWN'

/** Niveau de validation d'une donnée du référentiel. */
export type VerificationLevel =
  | 'OFFICIAL_REFERENCE'
  | 'METADATA_ONLY'
  | 'COMMUNITY'
  | 'UNVERIFIED'

export interface ReferentialSource {
  authority: string
  sourceUrl: string
  verificationStatus: 'VERIFIED_OFFICIAL' | 'UNVERIFIED_IN_REPOSITORY'
  /** Date de vérification en ligne ; nulle si aucune n'est documentée. */
  verifiedAt: string | null
  /**
   * Date de collecte dans le dépôt. Le dépôt ne documente pas de date de
   * collecte pour les références TER/BRT : la valeur reste nulle plutôt que
   * fabriquée.
   */
  collectedAt: string | null
}

export type NetworkClassification = 'RAIL' | 'BRT' | 'BUS_URBAN' | 'MINIBUS' | 'UNCLASSIFIED'

/** État d'intégration d'un réseau dans le référentiel. */
export type IntegrationStatus =
  /** Arrêts, ordre de desserte et fréquences de référence présents. */
  | 'REFERENCE_NETWORK'
  /** Seules des métadonnées réseau vérifiées (opérateur, ampleur) sont connues. */
  | 'METADATA_ONLY'
  /** Aucune donnée exploitable ; le réseau est nommé mais non décrit. */
  | 'NOT_INTEGRATED'

export interface ReferentialNetwork {
  id: ReferenceNetworkId | 'tata'
  label: string
  operator: string
  classification: NetworkClassification
  integrationStatus: IntegrationStatus
  coverage: string
  lineCount: number | null
  stationCount: number | null
  serviceWindow: string
  frequencyStatus: TimeInfoStatus
  /** Ce qui est réellement disponible pour ce réseau, formulé pour l'usager. */
  known: string
  /** Ce qui manque et ne doit pas être inventé. */
  missing: string
  source: ReferentialSource
}

export interface ReferentialStop {
  id: string
  networkId: ReferenceNetworkId
  name: string
  shortName?: string
  lat: number
  lon: number
  order: number
  aliases: readonly string[]
  note?: string
  verification: VerificationLevel
  source: ReferentialSource
}

export interface ReferentialLine {
  id: string
  networkId: ReferenceNetworkId
  shortName: string
  longName: string
  /** Terminus dans l'ordre d'encodage : [origine, destination]. */
  terminusFrom: string
  terminusTo: string
  stopIds: readonly string[]
  serviceWindow: string
  frequencyStatus: TimeInfoStatus
  source: ReferentialSource
}

export interface TimeWindow {
  /** Heure de dernier départ publié depuis les grilles de référence. */
  lastDeparture: string | null
  firstDeparture: string | null
  status: TimeInfoStatus
  source: ReferentialSource | null
  note: string
}

function fromFrequencySource(source: FrequencySource): ReferentialSource {
  return {
    authority: source.authority,
    sourceUrl: source.sourceUrl,
    verificationStatus: source.verificationStatus,
    verifiedAt: source.verificationStatus === 'VERIFIED_OFFICIAL' ? source.verifiedAt : null,
    collectedAt: null,
  }
}

export const REFERENTIAL_SOURCES: Readonly<Record<'ter' | 'brt' | 'cetud', ReferentialSource>> = {
  ter: fromFrequencySource(NETWORK_REFERENCE_DATA.ter.source),
  brt: fromFrequencySource(NETWORK_REFERENCE_DATA.brt.source),
  cetud: fromFrequencySource(NETWORK_REFERENCE_DATA.ddd.source),
}

export const REFERENTIAL_NETWORKS: readonly ReferentialNetwork[] = [
  {
    id: 'ter',
    label: 'TER',
    operator: NETWORK_REFERENCE_DATA.ter.operator,
    classification: 'RAIL',
    integrationStatus: 'REFERENCE_NETWORK',
    coverage: NETWORK_REFERENCE_DATA.ter.coverage,
    lineCount: 1,
    stationCount: NETWORK_REFERENCE_DATA.ter.stationCount,
    serviceWindow: NETWORK_REFERENCE_DATA.ter.serviceWindow,
    frequencyStatus: 'SCHEDULED',
    known:
      '13 gares de Dakar à Diamniadio, ordre de desserte, zones tarifaires, fréquences officielles de référence par période.',
    missing:
      'Horaires de passage arrêt par arrêt, calendrier daté des exceptions, temps réel et perturbations.',
    source: REFERENTIAL_SOURCES.ter,
  },
  {
    id: 'brt',
    label: 'BRT (SunuBRT)',
    operator: NETWORK_REFERENCE_DATA.brt.operator,
    classification: 'BRT',
    integrationStatus: 'REFERENCE_NETWORK',
    coverage: NETWORK_REFERENCE_DATA.brt.coverage,
    lineCount: 1,
    stationCount: NETWORK_REFERENCE_DATA.brt.stationCount,
    serviceWindow: NETWORK_REFERENCE_DATA.brt.serviceWindow,
    frequencyStatus: 'SCHEDULED',
    known:
      '23 stations de Petersen – Papa Gueye Fall à la Préfecture de Guédiawaye, ordre de desserte B1, desserte B3 annoncée, fréquence officielle de référence (6 min).',
    missing:
      'Horaires de passage station par station, tarif vérifié, variantes B2/B3 complètes, temps réel et perturbations.',
    source: REFERENTIAL_SOURCES.brt,
  },
  {
    id: 'ddd',
    label: 'Dakar Dem Dikk',
    operator: NETWORK_REFERENCE_DATA.ddd.operator,
    classification: 'BUS_URBAN',
    integrationStatus: 'REFERENCE_NETWORK',
    coverage: NETWORK_REFERENCE_DATA.ddd.coverage,
    lineCount: NETWORK_REFERENCE_DATA.ddd.lineCount,
    stationCount: 14,
    serviceWindow: NETWORK_REFERENCE_DATA.ddd.serviceWindow,
    frequencyStatus: 'UNKNOWN',
    known:
      'Ampleur déclarée (38 lignes, ~400 bus) + 14 arrêts principaux de référence géolocalisés (jaune #F59E0B) en pointillés légers + pastilles pour éviter la surcharge carte.',
    missing:
      'Fréquences par ligne non publiées : pas de prochain passage temps réel, uniquement des repères géographiques légers.',
    source: REFERENTIAL_SOURCES.cetud,
  },
  {
    id: 'aftu',
    label: 'AFTU',
    operator: NETWORK_REFERENCE_DATA.aftu.operator,
    classification: 'MINIBUS',
    integrationStatus: 'REFERENCE_NETWORK',
    coverage: NETWORK_REFERENCE_DATA.aftu.coverage,
    lineCount: NETWORK_REFERENCE_DATA.aftu.lineCount,
    stationCount: 13,
    serviceWindow: NETWORK_REFERENCE_DATA.aftu.serviceWindow,
    frequencyStatus: 'UNKNOWN',
    known:
      'Ampleur déclarée (72 lignes, ~2 300 minibus, 14 GIE) + 13 arrêts principaux de référence géolocalisés (orange ambré #D97706) en pointillés légers + pastilles.',
    missing:
      'Fréquences par ligne non publiées : affichage léger uniquement, pas de temps réel.',
    source: REFERENTIAL_SOURCES.cetud,
  },
  {
    id: 'tata',
    label: 'TATA',
    operator: 'AFTU / TATA',
    classification: 'MINIBUS',
    integrationStatus: 'REFERENCE_NETWORK',
    coverage: 'Réseau TATA — 6 arrêts principaux de référence',
    lineCount: 1,
    stationCount: 6,
    serviceWindow: '06:00–21:00 · TATA',
    frequencyStatus: 'UNKNOWN',
    known: '6 arrêts principaux de référence (marron #C05621, palette AFTU) en pointillés légers + pastilles, distincts d’AFTU sans sortir de la palette.',
    missing: 'Fréquences par ligne non publiées, pas de temps réel.',
    source: REFERENTIAL_SOURCES.cetud,
  },
]

export const REFERENTIAL_STOPS: readonly ReferentialStop[] = ALL_CORRIDOR_STOPS.map((stop) => {
  const networkId = stop.id.startsWith('ter')
    ? 'ter'
    : stop.id.startsWith('brt')
      ? 'brt'
      : stop.id.startsWith('ddd')
        ? 'ddd'
        : stop.id.startsWith('aftu')
          ? 'aftu'
          : 'tata'
  const source = networkId === 'ter'
    ? REFERENTIAL_SOURCES.ter
    : networkId === 'brt'
      ? REFERENTIAL_SOURCES.brt
      : REFERENTIAL_SOURCES.cetud
  return {
    id: stop.id,
    networkId,
    name: stop.name,
    ...(stop.shortName ? { shortName: stop.shortName } : {}),
    lat: stop.lat,
    lon: stop.lon,
    order: stop.order,
    aliases: stop.aliases,
    ...(stop.note ? { note: stop.note } : {}),
    verification: 'OFFICIAL_REFERENCE' as const,
    source,
  }
})

export const REFERENTIAL_LINES: readonly ReferentialLine[] = CORRIDOR_LINES.map((line) => {
  const first = getCorridorStop(line.stopIds[0])
  const last = getCorridorStop(line.stopIds[line.stopIds.length - 1])
  return {
    id: line.id,
    networkId: line.network,
    shortName: line.shortName,
    longName: line.longName,
    terminusFrom: first?.name ?? line.stopIds[0],
    terminusTo: last?.name ?? line.stopIds[line.stopIds.length - 1],
    stopIds: line.stopIds,
    serviceWindow: line.serviceWindow,
    frequencyStatus: line.frequencyStatus === 'OFFICIAL_REFERENCE' ? 'SCHEDULED' : 'UNKNOWN',
    source: line.network === 'ter' ? REFERENTIAL_SOURCES.ter : REFERENTIAL_SOURCES.brt,
  }
})

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Recherche un arrêt par nom, alias ou variante orthographique raisonnable. */
export function findReferentialStops(query: string): ReferentialStop[] {
  const matches = searchCorridorStops(query)
  return matches
    .map((stop) => REFERENTIAL_STOPS.find((entry) => entry.id === stop.id))
    .filter((entry): entry is ReferentialStop => entry !== undefined)
}

export function getReferentialStop(stopId: string): ReferentialStop | null {
  return REFERENTIAL_STOPS.find((stop) => stop.id === stopId) ?? null
}

/** Recherche une ligne par numéro, code ou nom (« B1 », « TER », « BRT »…). */
export function findReferentialLine(query: string): ReferentialLine | null {
  const needle = normalize(query)
  if (!needle) return null
  for (const line of REFERENTIAL_LINES) {
    const haystacks = [line.shortName, line.longName, line.id, line.networkId].map(normalize)
    if (haystacks.some((value) => value === needle || value.includes(needle))) return line
  }
  return null
}

/** Lignes desservant un arrêt du référentiel. */
export function linesForStop(stopId: string): ReferentialLine[] {
  return REFERENTIAL_LINES.filter((line) => line.stopIds.includes(stopId))
}

/**
 * Arrêts desservis entre deux arrêts d'une même ligne, dans le sens demandé.
 * Renvoie null si les deux arrêts ne sont pas sur la ligne (rien n'est deviné).
 */
export function stopsBetween(line: ReferentialLine, fromStopId: string, toStopId: string): ReferentialStop[] | null {
  const fromIndex = line.stopIds.indexOf(fromStopId)
  const toIndex = line.stopIds.indexOf(toStopId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null
  const ordered = fromIndex < toIndex
    ? line.stopIds.slice(fromIndex, toIndex + 1)
    : [...line.stopIds.slice(toIndex, fromIndex + 1)].reverse()
  return ordered
    .map((id) => getReferentialStop(id))
    .filter((stop): stop is ReferentialStop => stop !== null)
}

/** Arrêts du référentiel les plus proches d'un point, avec distances réelles. */
export function nearestReferentialStops(point: { lat: number; lon: number }, limit = 3): { stop: ReferentialStop; distanceM: number }[] {
  return nearestCorridorStops(point, limit)
    .map((entry) => {
      const stop = getReferentialStop(entry.stop.id)
      return stop ? { stop, distanceM: entry.distanceM } : null
    })
    .filter((entry): entry is { stop: ReferentialStop; distanceM: number } => entry !== null)
}

/**
 * Premier et dernier départs publiés d'un réseau d'après les grilles de
 * fréquence de référence. Ce sont des bornes de fenêtre de service publiées,
 * pas l'observation d'un véhicule ; les réseaux sans grille renvoient UNKNOWN.
 */
export function publishedServiceWindow(networkId: ReferenceNetworkId): TimeWindow {
  const frequencies = networkId === 'ter' || networkId === 'brt'
    ? OFFICIAL_REFERENCE_FREQUENCIES[networkId]
    : []
  if (frequencies.length === 0) {
    return {
      firstDeparture: null,
      lastDeparture: null,
      status: 'UNKNOWN',
      source: null,
      note: 'Aucune grille horaire publiée n’est disponible dans le référentiel pour ce réseau.',
    }
  }
  const toMinutes = (value: string): number => {
    const [hours, minutes] = value.split(':').map(Number)
    return hours * 60 + minutes
  }
  const earliest = [...frequencies].sort((a, b) => toMinutes(a.serviceStart) - toMinutes(b.serviceStart))[0]
  const latest = [...frequencies].sort((a, b) => toMinutes(b.serviceEnd) - toMinutes(a.serviceEnd))[0]
  return {
    firstDeparture: earliest.serviceStart,
    lastDeparture: latest.serviceEnd,
    status: 'SCHEDULED',
    source: fromFrequencySource(earliest.source),
    note: 'Bornes des fenêtres de service publiées (grilles de fréquence de référence) — ce ne sont pas des passages observés.',
  }
}

export function formatReferentialSource(source: ReferentialSource): string {
  const verification = source.verificationStatus === 'VERIFIED_OFFICIAL' && source.verifiedAt
    ? `Vérifiée le ${source.verifiedAt}`
    : 'Référence présente dans le dépôt · vérification en ligne non documentée'
  return `Source : ${source.authority} (${source.sourceUrl}) · ${verification}`
}

/**
 * État honnête des connaissances : ce qui est confirmé et ce qui ne l'est
 * pas. Utilisé par le copilote pour répondre aux questions sur les données.
 */
export function referentialKnowledgeSummary(): string {
  const covered = REFERENTIAL_NETWORKS.filter((network) => network.integrationStatus === 'REFERENCE_NETWORK')
    .map((network) => `• ${network.label} : ${network.known}`)
    .join('\n')
  const gaps = REFERENTIAL_NETWORKS.filter((network) => network.integrationStatus !== 'REFERENCE_NETWORK')
    .map((network) => `• ${network.label} : ${network.missing}`)
    .join('\n')
  return `Confirmé dans le référentiel :\n${covered}\n\nNon confirmé (jamais inventé) :\n${gaps}\nAucun flux temps réel n’est connecté : aucun « direct », aucune position de véhicule.`
}

/** Correspondances marchables déclarées entre réseaux (TER ↔ BRT). */
export const REFERENTIAL_TRANSFERS = CORRIDOR_TRANSFERS

/** Garde-fou interne : les alias pointent uniquement vers des arrêts réels. */
export function referentialConsistencyIssues(): string[] {
  const issues: string[] = []
  const ids = new Set(ALL_CORRIDOR_STOPS.map((stop) => stop.id))
  for (const line of CORRIDOR_LINES) {
    for (const stopId of line.stopIds) {
      if (!ids.has(stopId)) issues.push(`Ligne ${line.shortName} : arrêt inconnu ${stopId}`)
    }
  }
  for (const transfer of CORRIDOR_TRANSFERS) {
    if (!ids.has(transfer.fromStopId)) issues.push(`Correspondance : arrêt inconnu ${transfer.fromStopId}`)
    if (!ids.has(transfer.toStopId)) issues.push(`Correspondance : arrêt inconnu ${transfer.toStopId}`)
  }
  if (REFERENTIAL_STOPS.length !== ALL_CORRIDOR_STOPS.length) {
    issues.push('Le référentiel contient un nombre d’arrêts différent des corridors.')
  }
  const seen = new Set<string>()
  for (const stop of REFERENTIAL_STOPS) {
    if (seen.has(stop.id)) issues.push(`Arrêt en double : ${stop.id}`)
    seen.add(stop.id)
  }
  return issues
}

export type { CorridorLine, CorridorStop }
export { linesServingStop }
