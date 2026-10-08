/**
 * View model for `/api/journeys`, the direct-ride search served from the
 * published snapshot and its routing graph.
 *
 * Same discipline as `published.ts`: an answer that does not carry every
 * declared field is refused instead of being completed with invented values.
 * A payload that claims realtime is refused outright: this server only knows
 * theoretical declared timetables.
 */

import type { FrequencyStatus } from './frequencies'
import type { ParseResult } from './published'

export interface JourneyLeg {
  stopId: string
  stopName: string | null
  /** Declared time in the feed (`HH:MM:SS`), never an estimate. */
  declaredTime: string
  walkM: number | null
  /** False when the walk follows a declared link whose distance is unknown. */
  walkKnown: boolean
  walkPath: string[]
}

export type JourneyDepartureStatus = Extract<FrequencyStatus, 'SCHEDULED' | 'UNKNOWN'>

export interface Journey {
  tripId: string | null
  serviceId: string | null
  routeId: string
  routeShortName: string | null
  routeLongName: string | null
  routeType: string | null
  departure: JourneyLeg
  arrival: JourneyLeg
  durationMin: number
  /** Service day of the trip (`YYYY-MM-DD`), usually the requested local day. */
  date: string
  /** Exact UTC departure instant, only for a timezone-qualified GTFS schedule. */
  nextDepartureAt: string | null
  departureStatus: JourneyDepartureStatus
  note: string
}

export interface JourneySearch {
  snapshotId: string | null
  requestedAt: string
  localDay: string
  maxWalkM: number | null
  startWalkM: number | null
  results: Journey[]
  resultDate: string | null
  nextServiceDate: string | null
  exhaustedToday: boolean
  reason: JourneyReason
  message: string | null
  limitations: string | null
  graphBuiltAt: string | null
  graphStats: Record<string, number>
}

export type JourneyReason =
  | 'DIRECT_RIDE_FOUND'
  | 'NO_DIRECT_SERVICE'
  | 'NO_NEARBY_STOPS'
  | 'UNKNOWN'

const REASONS: readonly JourneyReason[] = ['DIRECT_RIDE_FOUND', 'NO_DIRECT_SERVICE', 'NO_NEARBY_STOPS']
const JOURNEY_DEPARTURE_STATUSES: readonly JourneyDepartureStatus[] = ['SCHEDULED', 'UNKNOWN']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function absoluteTimestamp(value: string | null): number | null {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    out.push(item)
  }
  return out
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw
  }
  return out
}

function parseLeg(value: unknown, timeKey: 'departure' | 'arrival'): JourneyLeg | null {
  if (!isRecord(value)) return null
  const stopId = optionalString(value.stop_id)
  const declaredTime = optionalString(value[timeKey])
  const walkPath = stringList(value.walk_path)
  if (!stopId || !declaredTime || walkPath === null) return null
  if (typeof value.walk_m_known !== 'boolean') return null
  return {
    stopId,
    stopName: optionalString(value.stop_name),
    declaredTime,
    walkM: optionalNumber(value.walk_m),
    walkKnown: value.walk_m_known,
    walkPath,
  }
}

/**
 * One direct ride: exactly one boarding and one alighting. Any result that
 * carries a transfer is refused, because this engine never produces one.
 */
function parseJourney(value: unknown): Journey | null {
  if (!isRecord(value) || value.kind !== 'direct') return null
  if (optionalNumber(value.transfers) !== 0) return null
  const departure = parseLeg(value.board, 'departure')
  const arrival = parseLeg(value.alight, 'arrival')
  const durationMin = optionalNumber(value.duration_min)
  const date = optionalString(value.date)
  const note = optionalString(value.note)
  const route = isRecord(value.route) ? value.route : null
  const routeId = route ? optionalString(route.route_id) : null
  const rawStatus = value.departure_status === undefined ? 'UNKNOWN' : optionalString(value.departure_status)
  if (!rawStatus || !(JOURNEY_DEPARTURE_STATUSES as readonly string[]).includes(rawStatus)) return null
  const departureStatus = rawStatus as JourneyDepartureStatus
  const nextDepartureAt = optionalString(value.next_departure_at)
  if (departureStatus === 'SCHEDULED') {
    if (absoluteTimestamp(nextDepartureAt) === null) return null
  } else if (nextDepartureAt !== null) {
    return null
  }
  if (!departure || !arrival || durationMin === null || !date || !note || !routeId || !route) return null
  return {
    tripId: optionalString(value.trip_id),
    serviceId: optionalString(value.service_id),
    routeId,
    routeShortName: optionalString(route.short_name),
    routeLongName: optionalString(route.long_name),
    routeType: optionalString(route.route_type),
    departure,
    arrival,
    durationMin,
    date,
    nextDepartureAt,
    departureStatus,
    note,
  }
}

export function parseJourneysPayload(payload: unknown): ParseResult<JourneySearch> {
  if (!isRecord(payload)) return { ok: false, reason: 'Réponse d’itinéraires illisible.' }
  if (payload.realtime !== false) {
    return { ok: false, reason: 'La réponse prétend au temps réel : elle est refusée.' }
  }
  const requestedAt = optionalString(payload.requested_at)
  const requestedAtMs = absoluteTimestamp(requestedAt)
  const localDay = optionalString(payload.local_day)
  if (!requestedAt || requestedAtMs === null || !localDay) {
    return { ok: false, reason: 'Réponse d’itinéraires sans heure absolue ni jour de référence.' }
  }
  if (!Array.isArray(payload.results)) {
    return { ok: false, reason: 'Réponse d’itinéraires sans liste de résultats.' }
  }

  const results: Journey[] = []
  for (const raw of payload.results) {
    const journey = parseJourney(raw)
    if (!journey) {
      return { ok: false, reason: 'Une course proposée est incomplète : elle n’est pas affichée.' }
    }
    const nextDepartureAtMs = absoluteTimestamp(journey.nextDepartureAt)
    if (journey.departureStatus === 'SCHEDULED' && (nextDepartureAtMs === null || nextDepartureAtMs <= requestedAtMs)) {
      return { ok: false, reason: 'Une course déclarée est déjà passée à l’heure de recherche : la réponse est refusée.' }
    }
    results.push(journey)
  }

  const rawReason = optionalString(payload.reason)
  const reason: JourneyReason = rawReason && (REASONS as readonly string[]).includes(rawReason)
    ? (rawReason as JourneyReason)
    : results.length > 0 ? 'DIRECT_RIDE_FOUND' : 'UNKNOWN'

  return {
    ok: true,
    value: {
      snapshotId: optionalString(payload.snapshot_id),
      requestedAt,
      localDay,
      maxWalkM: optionalNumber(payload.max_walk_m),
      startWalkM: optionalNumber(payload.start_walk_m),
      results,
      resultDate: optionalString(payload.result_date),
      nextServiceDate: optionalString(payload.next_service_date),
      exhaustedToday: payload.exhausted_today === true,
      reason,
      message: optionalString(payload.message),
      limitations: optionalString(payload.limitations),
      graphBuiltAt: isRecord(payload.graph) ? optionalString(payload.graph.built_at) : null,
      graphStats: isRecord(payload.graph) ? numberRecord(payload.graph.stats) : {},
    },
  }
}

/** `HH:MM` from a declared `HH:MM:SS`; hours over 24 are kept as declared. */
export function declaredClockLabel(declaredTime: string): string {
  const match = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(declaredTime.trim())
  if (!match) return declaredTime
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export function journeyRouteLabel(journey: Journey): string {
  return journey.routeShortName ?? journey.routeLongName ?? journey.routeId
}

/** The walk that leads to a leg, or null when the leg is boarded where you stand. */
export function walkSummary(leg: JourneyLeg): string | null {
  if (leg.walkPath.length <= 1) return null
  if (leg.walkM === null || !leg.walkKnown) return 'cheminement déclaré, distance inconnue'
  if (leg.walkM < 1000) return `${Math.round(leg.walkM)} m à pied`
  return `${(leg.walkM / 1000).toFixed(1).replace('.', ',')} km à pied`
}

export function formatJourneyDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) return date
  return `${match[3]}/${match[2]}/${match[1]}`
}
