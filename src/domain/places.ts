/**
 * Mémoire des lieux de Dakar — la « mémoire du maître » de l'assistant.
 *
 * Trois sources, aucune invention :
 * 1. les 13 gares TER et les 23 stations BRT du réseau de référence
 *    (`corridors.ts`) — seules à porter des coordonnées, donc seules
 *    utilisables comme extrémités d'itinéraire calculé ;
 * 2. les terminus et points de passage textuels des fiches DDD/AFTU
 *    (`data/mobility-lines.json`) — repères documentaires, jamais des arrêts
 *    géolocalisés : un lieu purement « bus » ne peut pas être géocodé ici ;
 * 3. les correspondances TER ↔ BRT déclarées (`CORRIDOR_TRANSFERS`).
 *
 * Compréhension du langage naturel : une phrase comme « Comment faire pour
 * aller à Dakar ? Je suis à Keur Mbaye Fall » est résolue par les mots de
 * liaison (depuis / je suis à → départ ; à / vers / aller à → destination),
 * jamais par une position supposée. Ce module ne devine rien : un lieu
 * absent de la mémoire reste absent, et un lieu sans coordonnées n'entre
 * pas dans le calculateur.
 */

import { MAX_ACCESS_M } from './assumptions'
import {
  ALL_CORRIDOR_STOPS,
  CORRIDOR_TRANSFERS,
  haversineMeters,
  linesServingStop,
  type CorridorStop,
} from './corridors'
import { BUS_LINES, normalizeMobility, type BusLine } from './mobilityKnowledge'
import type { PlannerEndpoint } from './planner'

export type PlaceKind = 'ter' | 'brt' | 'ddd' | 'aftu' | 'tata' | 'bus'

export interface PlaceEntry {
  kind: PlaceKind
  /** Identifiant stable : identifiant d'arrêt de référence, ou `bus:<clé>`. */
  id: string
  /** Nom affiché, tel qu'il est déclaré par la source. */
  name: string
  aliases: readonly string[]
  /** Coordonnées uniquement pour une gare TER ou une station BRT. */
  lat?: number
  lon?: number
  /** Zone tarifaire (TER) ou pôle d'échange (BRT), tel que déclaré. */
  note?: string
  /** Fiches DDD/AFTU dont le parcours mentionne ce lieu (repères textuels). */
  busLines: readonly BusLine[]
}

export type PlaceRole = 'origin' | 'destination'

export interface PlaceMention {
  place: PlaceEntry
  /** Position dans le texte normalisé, pour l'ordre des mots de liaison. */
  start: number
  end: number
  /** Rôle déduit des mots de liaison. Null si la phrase n'en porte aucun. */
  role: PlaceRole | null
  /** Mots de liaison retenus (texte normalisé), utiles aux tests et au débogage. */
  connector: string
}

export interface JourneyEndpoints {
  origin: PlaceEntry | null
  destination: PlaceEntry | null
  mentions: readonly PlaceMention[]
  /** Vrai si au moins un rôle a été déduit d'un mot de liaison explicite. */
  explicit: boolean
}

const RANK: Record<PlaceKind, number> = { ter: 0, brt: 1, ddd: 2, aftu: 3, tata: 4, bus: 5 }

/** Préfixes de voirie : un nom de rue n'est pas un lieu nommé. */
const STREET_LIKE = /^(?:rue|avenue|avenue|bd|boulevard|route|rond point|giratoire|chemin|autoroute|voie|voies|impasse|allee|deux voies|carrefour)\b/

function isPlaceName(key: string): boolean {
  if (key.length < 4) return false
  if (/^\d+$/.test(key)) return false
  if (STREET_LIKE.test(key)) return false
  return true
}

/** « Terminus Leclerc » et « Leclerc (Dakar) » ramènent au lieu « Leclerc ». */
function busPlaceKey(raw: string): string {
  return normalizeMobility(raw.replace(/^terminus\s+/i, '').replace(/\([^)]*\)/g, ' '))
}

interface BusPlaceIndex {
  label: string
  lines: BusLine[]
}

function buildBusIndex(): Map<string, BusPlaceIndex> {
  const index = new Map<string, BusPlaceIndex>()
  for (const line of BUS_LINES) {
    for (const raw of [line.origin, line.destination, ...line.waypoints]) {
      const key = busPlaceKey(raw)
      if (!isPlaceName(key)) continue
      const known = index.get(key)
      if (known) {
        if (!known.lines.includes(line)) known.lines.push(line)
        continue
      }
      index.set(key, { label: raw.trim(), lines: [line] })
    }
  }
  return index
}

const BUS_INDEX = buildBusIndex()

function referenceLabels(): Set<string> {
  const labels = new Set<string>()
  for (const stop of ALL_CORRIDOR_STOPS) {
    for (const label of [stop.name, ...stop.aliases]) {
      const normalized = normalizeMobility(label)
      if (normalized) labels.add(normalized)
    }
  }
  return labels
}

const REFERENCE_LABELS = referenceLabels()

function busLinesForLabels(labels: readonly string[]): BusLine[] {
  const lines: BusLine[] = []
  const seen = new Set<string>()
  for (const label of labels) {
    const key = busPlaceKey(label)
    for (const line of BUS_INDEX.get(key)?.lines ?? []) {
      const id = `${line.network}:${line.code}`
      if (seen.has(id)) continue
      seen.add(id)
      lines.push(line)
    }
  }
  return lines
}

/** Gares TER, stations BRT, arrêts DDD/AFTU/TATA : extrémités calculables en référence.
 *  DDD (jaune #F59E0B) et AFTU/TATA (orange #D97706) sont désormais géolocalisés
 *  en pointillés légers + pastilles pour éviter la surcharge carte. */
export const REFERENCE_PLACES: readonly PlaceEntry[] = ALL_CORRIDOR_STOPS.map((stop) => {
  const kind: PlaceKind = stop.id.startsWith('ter')
    ? 'ter'
    : stop.id.startsWith('brt')
      ? 'brt'
      : stop.id.startsWith('ddd')
        ? 'ddd'
        : stop.id.startsWith('aftu')
          ? 'aftu'
          : stop.id.startsWith('tata')
            ? 'tata'
            : 'bus'
  return {
    kind,
    id: stop.id,
    name: stop.name,
    aliases: stop.aliases,
    lat: stop.lat,
    lon: stop.lon,
    ...(stop.note ? { note: stop.note } : {}),
    busLines: busLinesForLabels([stop.name, ...stop.aliases]),
  }
})

/** Lieux cités par les fiches DDD/AFTU, hors réseau de référence. */
export const BUS_PLACES: readonly PlaceEntry[] = [...BUS_INDEX.entries()]
  .filter(([key]) => !REFERENCE_LABELS.has(key))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([key, entry]) => ({
    kind: 'bus' as const,
    id: `bus:${key}`,
    name: entry.label,
    aliases: [],
    busLines: entry.lines,
  }))

export const ALL_KNOWN_PLACES: readonly PlaceEntry[] = [...REFERENCE_PLACES, ...BUS_PLACES]

export function getPlace(placeId: string): PlaceEntry | null {
  return ALL_KNOWN_PLACES.find((place) => place.id === placeId) ?? null
}

interface Candidate {
  label: string
  place: PlaceEntry
  rank: number
}

/** Index des libellés par premier mot : la recherche reste linéaire et courte. */
const CANDIDATES_BY_FIRST_WORD = (() => {
  const index = new Map<string, Candidate[]>()
  for (const place of ALL_KNOWN_PLACES) {
    const labels = place.kind === 'bus' ? [place.name] : [place.name, ...place.aliases]
    const seen = new Set<string>()
    for (const label of labels) {
      const normalized = normalizeMobility(label)
      if (!normalized || seen.has(normalized) || !isPlaceName(normalized)) continue
      seen.add(normalized)
      const [firstWord] = normalized.split(' ')
      const bucket = index.get(firstWord) ?? []
      bucket.push({ label: normalized, place, rank: RANK[place.kind] })
      index.set(firstWord, bucket)
    }
  }
  // Le libellé le plus long d'abord : « gare de Dakar » avant « Dakar ».
  for (const bucket of index.values()) {
    bucket.sort((a, b) => b.label.length - a.label.length || a.rank - b.rank)
  }
  return index
})()

/**
 * Mots de liaison qui désignent un départ. Un lieu n'est jamais déduit d'une
 * position : seule la formulation de l'usager est interprétée.
 */
const ORIGIN_END = /(?:^|\s)(?:depuis|de|du|des|entre|pars\s+de|pars\s+du|viens\s+de|arrive\s+de|suis\s+(?:a|au|aux|sur|dans)|sommes\s+(?:a|au|aux|sur|dans)|est\s+(?:a|au|aux)|me\s+trouve\s+(?:a|au|aux|sur|dans)|me\s+situe\s+(?:a|au|aux)|habite\s+(?:a|au|aux)|reside\s+(?:a|au|aux)|part\s+(?:de|du)|partant\s+de|depart\s+de|au\s+depart\s+de|a\s+partir\s+de|en\s+partant\s+de|je\s+suis\s+a|on\s+est\s+a|nous\s+sommes\s+a|j\s+habite\s+a)(?:\s+(?:la|le|les|l))?$/

/** Mots de liaison qui désignent une destination. */
const DESTINATION_END = /(?:^|\s)(?:a|au|aux|vers|jusqu\s+a|jusqu\s+au|jusqu\s+aux|jusque|pour|rejoindre|direction|aller\s+(?:a|au|aux|vers)|arriver\s+(?:a|au|aux)|rendre\s+(?:a|au|aux)|destination|du\s+cote\s+de|cote\s+de)(?:\s+(?:la|le|les|l))?$/

function roleOf(connector: string): PlaceRole | null {
  if (!connector) return null
  if (ORIGIN_END.test(connector)) return 'origin'
  if (DESTINATION_END.test(connector)) return 'destination'
  return null
}

interface RawMatch {
  place: PlaceEntry
  start: number
  end: number
  length: number
  rank: number
}

/**
 * Repère les lieux connus dans une phrase libre. Les correspondances les plus
 * longues sont retenues en priorité et ne se recouvrent jamais : « gare de
 * Dakar » n'est pas comptée deux fois.
 */
export function findPlaceMentions(text: string): PlaceMention[] {
  const normalized = normalizeMobility(text)
  if (!normalized) return []
  const matches: RawMatch[] = []
  let position = 0
  while (position < normalized.length) {
    if (normalized[position] === ' ') {
      position += 1
      continue
    }
    const nextSpace = normalized.indexOf(' ', position)
    const word = normalized.slice(position, nextSpace === -1 ? normalized.length : nextSpace)
    const candidates = CANDIDATES_BY_FIRST_WORD.get(word)
    let matched: RawMatch | null = null
    for (const candidate of candidates ?? []) {
      const end = position + candidate.label.length
      if (normalized.slice(position, end) !== candidate.label) continue
      const after = normalized[end]
      if (after !== undefined && after !== ' ') continue
      matched = { place: candidate.place, start: position, end, length: candidate.label.length, rank: candidate.rank }
      break
    }
    if (matched) {
      matches.push(matched)
      position = matched.end
      continue
    }
    position += word.length + 1
  }
  // Recouvrements résiduels : le plus long l'emporte, puis le réseau de référence.
  matches.sort((a, b) => a.start - b.start || b.length - a.length || a.rank - b.rank)
  const accepted: RawMatch[] = []
  for (const match of matches) {
    if (accepted.some((kept) => match.start < kept.end && kept.start < match.end)) continue
    accepted.push(match)
  }
  accepted.sort((a, b) => a.start - b.start)
  return accepted.map((match, index) => {
    const previousEnd = index === 0 ? 0 : accepted[index - 1].end
    const connector = normalized.slice(previousEnd, match.start).trim()
    return {
      place: match.place,
      start: match.start,
      end: match.end,
      role: roleOf(connector),
      connector,
    }
  })
}

/**
 * Résout le couple (départ, destination) d'une phrase libre.
 * Règles, dans cet ordre :
 * 1. les rôles portés par les mots de liaison ;
 * 2. un seul lieu porteur de rôle : l'autre lieu cité prend le rôle complémentaire ;
 * 3. deux lieux sans indice : le premier cité est le départ, le second l'arrivée.
 * Un lieu cité deux fois n'est pas un trajet.
 */
export function resolveJourneyEndpoints(text: string): JourneyEndpoints | null {
  const mentions = findPlaceMentions(text)
  if (mentions.length === 0) return null
  const explicit = mentions.some((mention) => mention.role !== null)
  const byRole = (role: PlaceRole) => mentions.filter((mention) => mention.role === role)

  const origins = byRole('origin')
  const destinations = byRole('destination')
  const otherThan = (placeId: string, last: boolean) => {
    const candidates = mentions.filter((mention) => mention.place.id !== placeId)
    return last ? candidates[candidates.length - 1]?.place ?? null : candidates[0]?.place ?? null
  }

  let origin: PlaceEntry | null = null
  let destination: PlaceEntry | null = null
  if (origins.length > 0 && destinations.length > 0) {
    origin = origins[0].place
    destination = destinations[destinations.length - 1].place
  } else if (origins.length > 0) {
    // « je suis à X, Y » : Y complète la phrase, il n'est pas redemandé.
    origin = origins[0].place
    destination = otherThan(origin.id, true)
  } else if (destinations.length > 0) {
    destination = destinations[destinations.length - 1].place
    origin = otherThan(destination.id, false)
  } else {
    // Aucun indice : l'ordre des mots fait foi (« Keur Mbaye Fall Dakar »),
    // et un lieu seul est la destination la plus probable.
    origin = mentions.length > 1 ? mentions[0].place : null
    destination = mentions.length > 1 ? mentions[1].place : mentions[0].place
  }

  if (origin && destination && origin.id === destination.id) {
    return { origin, destination: null, mentions, explicit }
  }
  return { origin, destination, mentions, explicit }
}

/**
 * Une phrase est traitée comme une demande d'itinéraire dès qu'elle exprime un
 * déplacement — pas seulement avec le mot « trajet ».
 */
export function isRouteQuestion(text: string): boolean {
  const normalized = normalizeMobility(text)
  if (!normalized) return false
  if (/\b(?:trajet|itineraire|aller|arriver|rejoindre|voyage|compar\w*|chemin|partir|partons|pars|rendre|rends|deplacer|cheminement|emmener|amener|conduire|vais|vont|allons)\b/.test(normalized)) return true
  if (/\bcomment\s+(?:faire|aller|je\s+fais|on\s+va|on\s+fait|me\s+rendre|se\s+rendre|tu\s+fais|vas\s+tu)\b/.test(normalized)) return true
  if (/\b(?:bus|train|ter|brt|ligne)\s+pour\b/.test(normalized)) return true
  if (/\b(?:moyen|moyens)\s+(?:de|pour)\b/.test(normalized)) return true
  return /\b(?:comment|quelle|quel)\b[^?]{0,40}\b(?:aller|rendre|rejoindre|arriver)\b/.test(normalized)
}

/** Groupe de mots commençant par une majuscule : un nom propre, donc un lieu. */
const NAME = "([A-ZÀ-Ý][\\wÀ-ÿ'’°-]*(?:[ -][\\wÀ-ÿ'’°-]+){0,4})"
const ARTICLE = "(?:la |le |les |l |du |des |de la |d )?"
const TO = "(?:[àa]|[àa]u|[àa]ux|vers|jusqu(?:'|’)?\\s*[àa]u|jusqu(?:'|’)?\\s*[àa])"
const UNKNOWN_CUES = [
  new RegExp(`\\b(?:de|depuis|entre)\\s+${ARTICLE}${NAME}\\s+${TO}`, 'i'),
  new RegExp(`\\b(?:aller|arriver|rejoindre|vais|va|partir)\\s+${TO}\\s+${ARTICLE}${NAME}`, 'i'),
  new RegExp(`\\b(?:je\\s+suis|je\\s+me\\s+trouve|j\\s?habite|on\\s+est|nous\\s+sommes)\\s+(?:[àa]|[àa]u|[àa]ux|sur|dans)\\s+${ARTICLE}${NAME}`, 'i'),
]

/**
 * Signale honnêtement un lieu cité qui n'existe pas dans la mémoire, au lieu
 * de l'ignorer : l'usager a dit « Mbour », la réponse parle de « Mbour ».
 * Seuls les noms propres (majuscule) sont considérés, pour ne pas prendre
 * « à pied » ou « à l'école » pour un lieu.
 */
export function unrecognizedPlaceNote(question: string): string | null {
  for (const cue of UNKNOWN_CUES) {
    const match = cue.exec(question)
    const name = match?.[1]?.trim()
    if (!name || name.length < 3) continue
    if (/^(?:TER|BRT|DDD|AFTU|TATA|Dem|Dikk)$/i.test(name)) continue
    if (findPlaceMentions(name).length > 0) continue
    return `« ${name} » ne figure pas dans ma mémoire des lieux (13 gares TER, 23 stations BRT et les lieux cités par les fiches DDD/AFTU) : je ne le situe pas et je ne le devine pas.`
  }
  return null
}

/** Extrémité de calculateur : seules les gares TER et stations BRT en ont une. */
export function placeEndpoint(place: PlaceEntry): PlannerEndpoint | null {
  if (place.lat === undefined || place.lon === undefined) return null
  return {
    label: place.name,
    lat: place.lat,
    lon: place.lon,
    ...(place.kind === 'bus' ? {} : { stopId: place.id }),
  }
}

/** Arrêt de référence correspondant à un lieu calculable, s'il existe. */
export function referenceStopOf(place: PlaceEntry): CorridorStop | null {
  if (place.kind === 'bus') return null
  return ALL_CORRIDOR_STOPS.find((stop) => stop.id === place.id) ?? null
}

/** Lignes du réseau de référence desservant ce lieu. */
export function referenceLinesOf(place: PlaceEntry) {
  const stop = referenceStopOf(place)
  return stop ? linesServingStop(stop.id) : []
}

/** Correspondance TER ↔ BRT déclarée à cet arrêt, s'il en porte une. */
export function declaredTransferOf(place: PlaceEntry) {
  if (place.kind === 'bus') return null
  return CORRIDOR_TRANSFERS.find((transfer) => transfer.fromStopId === place.id || transfer.toStopId === place.id) ?? null
}

/**
 * Arrêt de l'autre réseau le plus proche, à vol d'oiseau. C'est une distance
 * calculée entre deux coordonnées déclarées, pas un cheminement mesuré :
 * `reachable` indique seulement si elle entre dans le rayon de marche du
 * calculateur.
 */
export function crossNetworkNearest(place: PlaceEntry): { stop: CorridorStop; distanceM: number; reachable: boolean } | null {
  if (place.lat === undefined || place.lon === undefined || place.kind === 'bus') return null
  const others = ALL_CORRIDOR_STOPS.filter((stop) => !stop.id.startsWith(place.kind))
  if (others.length === 0) return null
  let nearest: { stop: CorridorStop; distanceM: number } | null = null
  for (const stop of others) {
    const distanceM = haversineMeters({ lat: place.lat, lon: place.lon }, stop)
    if (!nearest || distanceM < nearest.distanceM) nearest = { stop, distanceM }
  }
  if (!nearest) return null
  return { ...nearest, reachable: nearest.distanceM <= MAX_ACCESS_M }
}
