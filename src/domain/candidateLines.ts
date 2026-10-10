/**
 * Inventaire additif des lignes candidates DDD/AFTU.
 *
 * Spec : docs/spec-estimation-progressive-ddd-aftu.md (§6 étape 1, §7, §8).
 * Aucune ligne n'est inventée : `CANDIDATE_LINES` reste vide tant qu'un tracé
 * sourcé n'est pas versé. Ce module n'est importé ni par l'interface ni par
 * le moteur TER/BRT. TATA reste hors de ce type jusqu'à confirmation de sa
 * classification.
 *
 * Une estimation n'est jamais présentée comme un horaire officiel. Sans ancre
 * temporelle, aucun compte à rebours exact n'est fabriqué.
 */

import { DAKAR_REGION_BOUNDS, haversineMeters } from './corridors'
import type { ServiceDay } from './frequencies'
import { safeHttpUrl } from './http'

export type TemporalModel =
  | 'PUBLISHED_DEPARTURES'
  | 'PUBLISHED_HEADWAY'
  | 'OBSERVED_HEADWAY'
  | 'MODEL_ONLY'
  | 'UNKNOWN'

export type EvidenceStatus = 'published' | 'observed' | 'estimated' | 'unknown'

export interface CandidateSource {
  authority: string
  url: string
  consultedAt: string | null
  validFrom: string | null
  validUntil: string | null
}

export interface CandidateStop {
  name: string
  lat: number | null
  lon: number | null
  coordinateStatus: EvidenceStatus
}

export interface CandidateServiceWindow {
  days: readonly ServiceDay[]
  /** Inclusif, `HH:MM`, heure de Dakar (UTC+00). */
  start: string
  /** Exclusif, comme la fin de fenêtre de `headways.ts`. */
  end: string
}

export interface CandidateAssumptions {
  /** Null : la vitesse n'est pas chiffrée. On n'emprunte pas celle du TER ou du BRT. */
  speedKph: number | null
  /** Null : aucun temps d'arrêt n'est ajouté. On n'emprunte pas le 0,5 min BRT. */
  dwellMin: number | null
  /** Headway publié, seulement exploitable si le modèle est `PUBLISHED_HEADWAY`. */
  publishedHeadwayMin: number | null
}

export interface CandidateLine {
  networkId: 'ddd' | 'aftu'
  lineId: string
  directionId: string
  name: string
  stops: readonly CandidateStop[]
  temporalModel: TemporalModel
  source: CandidateSource
  assumptions: CandidateAssumptions
  serviceWindow: CandidateServiceWindow | null
  /** Départ de terminus publié pour CE sens. Absent : pas de compte à rebours exact. */
  publishedDepartureIso: string | null
}

export interface ObservationStats {
  validCount: number
  lastObservedAt: string | null
  acceptedAt: readonly string[]
}

export interface PassageObservation {
  lineId: string
  directionId: string
  stopName: string
  observedAt: string
  collectedBy: 'explicit-user-action' | string
}

/** Seuils nommés. En dessous, une observation reste exploratoire et ne devient pas un horaire. */
export const OBSERVATION_POLICY = {
  minIntervalSec: 45,
  minSamplesForUsable: 12,
  maxAgeDays: 60,
  maxStoredTimestamps: 200,
} as const

/** Inventaire de production. Vide : aucune ligne DDD/AFTU sourcée n'est versée. */
export const CANDIDATE_LINES: readonly CandidateLine[] = []

const TEMPORAL_MODELS: readonly TemporalModel[] = [
  'PUBLISHED_DEPARTURES',
  'PUBLISHED_HEADWAY',
  'OBSERVED_HEADWAY',
  'MODEL_ONLY',
  'UNKNOWN',
]
const EVIDENCE: readonly EvidenceStatus[] = ['published', 'observed', 'estimated', 'unknown']
const SERVICE_DAYS: readonly ServiceDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const WEEKDAY: Record<ServiceDay, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }

export function emptyObservationStats(): ObservationStats {
  return { validCount: 0, lastObservedAt: null, acceptedAt: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalIso(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return value
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/** Accepte une ligne candidate ou rejette la valeur. Ne lève pas. */
export function parseCandidate(value: unknown): CandidateLine | null {
  if (!isRecord(value)) return null
  if (value.networkId !== 'ddd' && value.networkId !== 'aftu') return null
  if (typeof value.lineId !== 'string' || value.lineId.trim() === '') return null
  if (typeof value.directionId !== 'string' || value.directionId.trim() === '') return null
  if (typeof value.name !== 'string' || value.name.trim() === '') return null
  if (typeof value.temporalModel !== 'string' || !TEMPORAL_MODELS.includes(value.temporalModel as TemporalModel)) return null
  if (!Array.isArray(value.stops)) return null
  if (!isRecord(value.source) || typeof value.source.authority !== 'string' || value.source.authority.trim() === '') return null
  const url = typeof value.source.url === 'string' ? safeHttpUrl(value.source.url) : null
  if (!url) return null
  const consultedAt = optionalIso(value.source.consultedAt)
  const validFrom = optionalIso(value.source.validFrom)
  const validUntil = optionalIso(value.source.validUntil)
  if (consultedAt === undefined || validFrom === undefined || validUntil === undefined) return null
  if (!isRecord(value.assumptions)) return null
  const speedKph = finiteOrNull(value.assumptions.speedKph)
  const dwellMin = finiteOrNull(value.assumptions.dwellMin)
  const publishedHeadwayMin = finiteOrNull(value.assumptions.publishedHeadwayMin)
  if (speedKph === undefined || dwellMin === undefined || publishedHeadwayMin === undefined) return null
  if (speedKph !== null && speedKph <= 0) return null
  if (dwellMin !== null && dwellMin < 0) return null
  if (publishedHeadwayMin !== null && publishedHeadwayMin <= 0) return null

  const stops: CandidateStop[] = []
  for (const stop of value.stops) {
    if (!isRecord(stop) || typeof stop.name !== 'string' || stop.name.trim() === '') return null
    if (typeof stop.coordinateStatus !== 'string' || !EVIDENCE.includes(stop.coordinateStatus as EvidenceStatus)) return null
    const lat = finiteOrNull(stop.lat)
    const lon = finiteOrNull(stop.lon)
    if (lat === undefined || lon === undefined) return null
    stops.push({ name: stop.name.trim(), lat, lon, coordinateStatus: stop.coordinateStatus as EvidenceStatus })
  }

  let serviceWindow: CandidateServiceWindow | null = null
  if (value.serviceWindow !== null && value.serviceWindow !== undefined) {
    if (!isRecord(value.serviceWindow) || !Array.isArray(value.serviceWindow.days)) return null
    if (value.serviceWindow.days.length === 0) return null
    if (!value.serviceWindow.days.every((day) => typeof day === 'string' && SERVICE_DAYS.includes(day as ServiceDay))) return null
    if (typeof value.serviceWindow.start !== 'string' || typeof value.serviceWindow.end !== 'string') return null
    if (parseClock(value.serviceWindow.start) === null || parseClock(value.serviceWindow.end) === null) return null
    serviceWindow = {
      days: value.serviceWindow.days as ServiceDay[],
      start: value.serviceWindow.start,
      end: value.serviceWindow.end,
    }
  }

  const publishedDepartureIso = optionalIso(value.publishedDepartureIso)
  if (publishedDepartureIso === undefined) return null

  return {
    networkId: value.networkId,
    lineId: value.lineId.trim(),
    directionId: value.directionId.trim(),
    name: value.name.trim(),
    stops,
    temporalModel: value.temporalModel as TemporalModel,
    source: { authority: value.source.authority.trim(), url, consultedAt, validFrom, validUntil },
    assumptions: { speedKph, dwellMin, publishedHeadwayMin },
    serviceWindow,
    publishedDepartureIso,
  }
}

function inRegion(lat: number, lon: number): boolean {
  return lat >= DAKAR_REGION_BOUNDS.minLat && lat <= DAKAR_REGION_BOUNDS.maxLat
    && lon >= DAKAR_REGION_BOUNDS.minLon && lon <= DAKAR_REGION_BOUNDS.maxLon
}

/** Tracé exploitable : au moins deux arrêts ordonnés, coordonnées sourcées, dans la région. */
export function isDocumentedTrace(line: CandidateLine): boolean {
  if (line.stops.length < 2) return false
  return line.stops.every((stop) =>
    stop.lat !== null
    && stop.lon !== null
    && (stop.coordinateStatus === 'published' || stop.coordinateStatus === 'observed')
    && inRegion(stop.lat, stop.lon),
  )
}

export type RideEstimate =
  | { ok: true; minutes: number; distanceM: number; kind: 'ESTIMATED_RIDE'; countdown: null }
  | { ok: false; reason: 'NO_GEOMETRY' | 'NO_SPEED_ASSUMPTION' | 'WRONG_DIRECTION' | 'BAD_INDEX' }

/**
 * Durée de parcours estimée sur un tracé documenté. N'invente ni vitesse ni
 * compte à rebours. Le sens inverse est une autre ligne candidate.
 */
export function estimateRide(line: CandidateLine, fromIndex: number, toIndex: number): RideEstimate {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return { ok: false, reason: 'BAD_INDEX' }
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= line.stops.length || toIndex >= line.stops.length) {
    return { ok: false, reason: 'BAD_INDEX' }
  }
  if (toIndex <= fromIndex) return { ok: false, reason: 'WRONG_DIRECTION' }
  if (!isDocumentedTrace(line)) return { ok: false, reason: 'NO_GEOMETRY' }
  const speed = line.assumptions.speedKph
  if (speed === null) return { ok: false, reason: 'NO_SPEED_ASSUMPTION' }
  let distanceM = 0
  for (let index = fromIndex; index < toIndex; index += 1) {
    const from = line.stops[index]
    const to = line.stops[index + 1]
    distanceM += haversineMeters({ lat: from.lat as number, lon: from.lon as number }, { lat: to.lat as number, lon: to.lon as number })
  }
  const dwell = line.assumptions.dwellMin ?? 0
  const minutes = (distanceM / 1000 / speed) * 60 + Math.max(0, toIndex - fromIndex - 1) * dwell
  return { ok: true, minutes, distanceM, kind: 'ESTIMATED_RIDE', countdown: null }
}

export function projectArrival(departureIso: string, offsetMin: number): { publishedDeparture: string; estimatedArrival: string; offsetMin: number } | null {
  const departure = Date.parse(departureIso)
  if (!Number.isFinite(departure) || !Number.isFinite(offsetMin) || offsetMin < 0) return null
  return {
    publishedDeparture: new Date(departure).toISOString(),
    estimatedArrival: new Date(departure + offsetMin * 60_000).toISOString(),
    offsetMin,
  }
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** `null` si la fenêtre n'est pas connue : on ne propose alors aucun horaire. */
export function isInsideServiceWindow(line: CandidateLine, nowMs: number): boolean | null {
  const window = line.serviceWindow
  if (!window) return null
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  if (start === null || end === null || !Number.isFinite(nowMs)) return null
  const date = new Date(nowMs)
  const served = window.days.some((day) => WEEKDAY[day] === date.getUTCDay())
  if (!served) return false
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  if (end > start) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

export type Countdown =
  | { kind: 'NONE'; reason: 'NO_TEMPORAL_ANCHOR' | 'OUTSIDE_SERVICE' | 'UNKNOWN_WINDOW' | 'ANCHOR_PASSED' | 'UNREADABLE' }
  | { kind: 'AVERAGE'; minutes: number }
  | { kind: 'EXACT'; minutes: number; publishedDeparture: string; estimatedArrival: string }

function meanIntervalMin(timestamps: readonly string[]): number | null {
  const sorted = timestamps.map((value) => Date.parse(value)).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length < 2) return null
  let total = 0
  for (let index = 1; index < sorted.length; index += 1) total += sorted[index] - sorted[index - 1]
  return total / (sorted.length - 1) / 60_000
}

export function confidenceOf(stats: ObservationStats, nowMs: number): 'none' | 'exploratory' | 'usable' {
  if (stats.validCount <= 0 || !stats.lastObservedAt) return 'none'
  const last = Date.parse(stats.lastObservedAt)
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return 'none'
  const age = nowMs - last
  if (age < 0 || age > OBSERVATION_POLICY.maxAgeDays * 86_400_000) return 'none'
  if (stats.validCount >= OBSERVATION_POLICY.minSamplesForUsable) return 'usable'
  return 'exploratory'
}

/**
 * Prochain passage affichable. Un modèle sans ancre, une donnée contradictoire
 * ou une fenêtre inconnue ne produisent pas une heure exacte inventée.
 * Le départ publié n'est utilisé que si le modèle est `PUBLISHED_DEPARTURES`.
 */
export function nextCountdown(line: CandidateLine, nowMs: number, options?: { offsetMin?: number; stats?: ObservationStats }): Countdown {
  const offsetMin = options?.offsetMin ?? 0
  if (!Number.isFinite(nowMs) || !Number.isFinite(offsetMin) || offsetMin < 0) return { kind: 'NONE', reason: 'UNREADABLE' }

  if (line.temporalModel === 'PUBLISHED_DEPARTURES') {
    if (!line.publishedDepartureIso) return { kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' }
    const window = isInsideServiceWindow(line, nowMs)
    if (window === null) return { kind: 'NONE', reason: 'UNKNOWN_WINDOW' }
    if (!window) return { kind: 'NONE', reason: 'OUTSIDE_SERVICE' }
    const projected = projectArrival(line.publishedDepartureIso, offsetMin)
    if (!projected) return { kind: 'NONE', reason: 'UNREADABLE' }
    const remaining = Date.parse(projected.estimatedArrival) - nowMs
    if (remaining <= 0) return { kind: 'NONE', reason: 'ANCHOR_PASSED' }
    return {
      kind: 'EXACT',
      minutes: Math.max(1, Math.ceil(remaining / 60_000)),
      publishedDeparture: projected.publishedDeparture,
      estimatedArrival: projected.estimatedArrival,
    }
  }

  if (line.temporalModel === 'PUBLISHED_HEADWAY') {
    const headway = line.assumptions.publishedHeadwayMin
    if (headway === null) return { kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' }
    const window = isInsideServiceWindow(line, nowMs)
    if (window === null) return { kind: 'NONE', reason: 'UNKNOWN_WINDOW' }
    if (!window) return { kind: 'NONE', reason: 'OUTSIDE_SERVICE' }
    return { kind: 'AVERAGE', minutes: headway * 0.5 }
  }

  if (line.temporalModel === 'OBSERVED_HEADWAY') {
    const stats = options?.stats
    if (!stats || confidenceOf(stats, nowMs) !== 'usable') return { kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' }
    const interval = meanIntervalMin(stats.acceptedAt)
    if (interval === null || interval <= 0) return { kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' }
    return { kind: 'AVERAGE', minutes: interval / 2 }
  }

  return { kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' }
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function considerObservation(
  line: CandidateLine,
  observation: PassageObservation,
  nowMs: number,
  stats: ObservationStats,
): { stats: ObservationStats; accepted: boolean; reason: string | null } {
  const refuse = (reason: string) => ({ stats, accepted: false, reason })
  if (!Number.isFinite(nowMs)) return refuse('UNREADABLE')
  if (observation.collectedBy !== 'explicit-user-action') return refuse('NOT_EXPLICIT')
  if (observation.lineId !== line.lineId || observation.directionId !== line.directionId) return refuse('OFF_LINE')
  const observedMs = Date.parse(observation.observedAt)
  if (!Number.isFinite(observedMs)) return refuse('UNREADABLE')
  if (observedMs > nowMs) return refuse('FUTURE')
  const stop = normalizeName(observation.stopName)
  if (!line.stops.some((candidate) => normalizeName(candidate.name) === stop)) return refuse('OFF_LINE')
  if (stats.acceptedAt.includes(observation.observedAt)) return refuse('DUPLICATE')
  const previous = stats.acceptedAt
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value <= observedMs)
    .sort((a, b) => b - a)[0]
  if (previous !== undefined && observedMs - previous < OBSERVATION_POLICY.minIntervalSec * 1000) return refuse('ABERRANT')

  const acceptedAt = [...stats.acceptedAt, observation.observedAt].slice(-OBSERVATION_POLICY.maxStoredTimestamps)
  return {
    accepted: true,
    reason: null,
    stats: {
      validCount: stats.validCount + 1,
      lastObservedAt: stats.lastObservedAt && Date.parse(stats.lastObservedAt) > observedMs ? stats.lastObservedAt : observation.observedAt,
      acceptedAt,
    },
  }
}

/**
 * Ajoute les lignes candidates au calcul d'options sans retirer le réseau de
 * référence. Une ligne partielle ou illisible ne fait pas disparaître TER/BRT.
 */
export function withCandidateOptions(referenceLineIds: readonly string[], candidates: readonly CandidateLine[] = CANDIDATE_LINES): string[] {
  const extras: string[] = []
  for (const candidate of candidates) {
    try {
      if (isDocumentedTrace(candidate) && !referenceLineIds.includes(candidate.lineId) && !extras.includes(candidate.lineId)) {
        extras.push(candidate.lineId)
      }
    } catch {
      // Une fiche contradictoire ne doit pas bloquer les options déjà connues.
    }
  }
  return [...referenceLineIds, ...extras]
}
