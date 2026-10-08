/**
 * View model for the public read API (`/api/network`, `/api/stops/...`,
 * `/api/routes`).
 *
 * The API only ever answers from the active published snapshot. This module
 * keeps the same discipline as `review.ts`: a malformed answer is refused
 * instead of being rendered with default values, and nothing here turns a
 * theoretical timetable into a vehicle position.
 */

export type PublicationStatus = 'PUBLISHED' | 'NOT_PUBLISHED' | 'UNKNOWN'
export type PublishedValidityStatus = 'CURRENT' | 'NOT_YET_VALID' | 'STALE' | 'UNKNOWN'

export interface SnapshotBounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
  stopsWithCoordinates: number
}

export interface PublishedSnapshot {
  snapshotId: string
  builtAt: string | null
  validityStatus: PublishedValidityStatus
  validFrom: string | null
  validUntil: string | null
  timezone: string | null
  databaseSha256: string | null
  recordCount: Record<string, number>
  bounds: SnapshotBounds | null
}

export interface PublishedDataset {
  datasetId: string | null
  datasetVersion: string | null
  operator: string | null
  source: string | null
  sourceType: string | null
  serviceStatus: string | null
}

export interface PublishedNetwork {
  available: boolean
  publicationStatus: PublicationStatus
  snapshot: PublishedSnapshot | null
  dataset: PublishedDataset | null
  publishedAt: string | null
  publisherId: string | null
  message: string
  dataPolicy: string
  blockedReason: string | null
}

export interface PublishedStop {
  stopId: string
  stopName: string
  lat: number | null
  lon: number | null
  distanceM: number | null
  locationType: string | null
  parentStation: string | null
}

export interface PublishedRoute {
  routeId: string
  shortName: string | null
  longName: string | null
  routeType: string | null
  tripCount: number | null
}

export interface ServingRoute {
  routeId: string
  shortName: string | null
  longName: string | null
  routeType: string | null
  tripCount: number | null
}

export interface ScheduledWindow {
  firstDeclaredDeparture: string | null
  lastDeclaredDeparture: string | null
  note: string
}

export interface PublishedStopDetail extends PublishedStop {
  parentStationName: string | null
  routes: ServingRoute[]
  scheduledWindow: ScheduledWindow | null
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const PUBLICATION_STATUSES: readonly PublicationStatus[] = ['PUBLISHED', 'NOT_PUBLISHED', 'UNKNOWN']
const VALIDITY_STATUSES: readonly PublishedValidityStatus[] = ['CURRENT', 'NOT_YET_VALID', 'STALE', 'UNKNOWN']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function requiredString(value: unknown): string | null {
  return optionalString(value)
}

function recordCount(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {}
  const counts: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) counts[key] = raw
  }
  return counts
}

function parseBounds(value: unknown): SnapshotBounds | null {
  if (!isRecord(value)) return null
  const minLat = optionalNumber(value.min_lat)
  const minLon = optionalNumber(value.min_lon)
  const maxLat = optionalNumber(value.max_lat)
  const maxLon = optionalNumber(value.max_lon)
  if (minLat === null || minLon === null || maxLat === null || maxLon === null) return null
  return {
    minLat,
    minLon,
    maxLat,
    maxLon,
    stopsWithCoordinates: optionalNumber(value.stops_with_coordinates) ?? 0,
  }
}

function parseSnapshot(value: unknown): PublishedSnapshot | null {
  if (!isRecord(value)) return null
  const snapshotId = requiredString(value.snapshot_id)
  if (!snapshotId) return null
  const validity = typeof value.validity_status === 'string' && (VALIDITY_STATUSES as readonly string[]).includes(value.validity_status)
    ? (value.validity_status as PublishedValidityStatus)
    : 'UNKNOWN'
  return {
    snapshotId,
    builtAt: optionalString(value.built_at),
    validityStatus: validity,
    validFrom: optionalString(value.valid_from),
    validUntil: optionalString(value.valid_until),
    timezone: optionalString(value.timezone),
    databaseSha256: optionalString(value.database_sha256),
    recordCount: recordCount(value.record_count),
    bounds: parseBounds(value.bounds),
  }
}

function parseDataset(value: unknown): PublishedDataset | null {
  if (!isRecord(value)) return null
  return {
    datasetId: optionalString(value.dataset_id),
    datasetVersion: optionalString(value.dataset_version),
    operator: optionalString(value.operator),
    source: optionalString(value.source),
    sourceType: optionalString(value.source_type),
    serviceStatus: optionalString(value.service_status),
  }
}

export function parseNetworkPayload(payload: unknown): ParseResult<PublishedNetwork> {
  if (!isRecord(payload) || typeof payload.available !== 'boolean') {
    return { ok: false, reason: 'Réponse de publication illisible.' }
  }
  const publicationStatus = typeof payload.publication_status === 'string'
    && (PUBLICATION_STATUSES as readonly string[]).includes(payload.publication_status)
    ? (payload.publication_status as PublicationStatus)
    : 'UNKNOWN'
  const snapshot = parseSnapshot(payload.snapshot)
  if (payload.available && !snapshot) {
    // An available network without an identifiable snapshot is refused: the
    // app would otherwise render data it cannot attribute to anything.
    return { ok: false, reason: 'Snapshot publié annoncé sans identifiant exploitable.' }
  }
  return {
    ok: true,
    value: {
      available: payload.available,
      publicationStatus,
      snapshot,
      dataset: parseDataset(payload.dataset),
      publishedAt: optionalString(payload.published_at),
      publisherId: optionalString(payload.publisher_id),
      message: optionalString(payload.message) ?? '',
      dataPolicy: optionalString(payload.data_policy) ?? '',
      blockedReason: optionalString(payload.blocked_reason),
    },
  }
}

function parseStop(raw: unknown): PublishedStop | null {
  if (!isRecord(raw)) return null
  const stopId = requiredString(raw.stop_id)
  if (!stopId) return null
  return {
    stopId,
    stopName: optionalString(raw.stop_name) ?? stopId,
    lat: optionalNumber(raw.stop_lat),
    lon: optionalNumber(raw.stop_lon),
    distanceM: optionalNumber(raw.distance_m),
    locationType: optionalString(raw.location_type),
    parentStation: optionalString(raw.parent_station),
  }
}

export function parseStopsPayload(payload: unknown): ParseResult<PublishedStop[]> {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return { ok: false, reason: 'Liste d’arrêts illisible.' }
  }
  const stops: PublishedStop[] = []
  for (const raw of payload.results) {
    const stop = parseStop(raw)
    if (!stop) return { ok: false, reason: 'Un arrêt publié est illisible.' }
    stops.push(stop)
  }
  return { ok: true, value: stops }
}

export function parseStopDetailPayload(payload: unknown): ParseResult<PublishedStopDetail> {
  if (!isRecord(payload) || !isRecord(payload.stop)) {
    return { ok: false, reason: 'Fiche d’arrêt illisible.' }
  }
  const stop = parseStop(payload.stop)
  if (!stop) return { ok: false, reason: 'Fiche d’arrêt illisible.' }

  const routes: ServingRoute[] = []
  if (Array.isArray(payload.stop.routes)) {
    for (const raw of payload.stop.routes) {
      if (!isRecord(raw)) return { ok: false, reason: 'Une ligne desservant cet arrêt est illisible.' }
      const routeId = requiredString(raw.route_id)
      if (!routeId) return { ok: false, reason: 'Une ligne desservant cet arrêt est illisible.' }
      routes.push({
        routeId,
        shortName: optionalString(raw.route_short_name),
        longName: optionalString(raw.route_long_name),
        routeType: optionalString(raw.route_type),
        tripCount: optionalNumber(raw.trip_count),
      })
    }
  }

  let scheduledWindow: ScheduledWindow | null = null
  const window = payload.stop.scheduled_time_window
  if (isRecord(window)) {
    scheduledWindow = {
      firstDeclaredDeparture: optionalString(window.first_declared_departure),
      lastDeclaredDeparture: optionalString(window.last_declared_departure),
      note: optionalString(window.note) ?? 'Heures théoriques déclarées dans le flux.',
    }
  }

  return {
    ok: true,
    value: {
      ...stop,
      parentStationName: optionalString(payload.stop.parent_station_name),
      routes,
      scheduledWindow,
    },
  }
}

export function parseRoutesPayload(payload: unknown): ParseResult<PublishedRoute[]> {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return { ok: false, reason: 'Liste de lignes illisible.' }
  }
  const routes: PublishedRoute[] = []
  for (const raw of payload.results) {
    if (!isRecord(raw)) return { ok: false, reason: 'Une ligne publiée est illisible.' }
    const routeId = requiredString(raw.route_id)
    if (!routeId) return { ok: false, reason: 'Une ligne publiée est illisible.' }
    routes.push({
      routeId,
      shortName: optionalString(raw.route_short_name),
      longName: optionalString(raw.route_long_name),
      routeType: optionalString(raw.route_type),
      tripCount: optionalNumber(raw.trip_count),
    })
  }
  return { ok: true, value: routes }
}

export function publicationStatusLabel(status: PublicationStatus): string {
  switch (status) {
    case 'PUBLISHED':
      return 'Publié'
    case 'NOT_PUBLISHED':
      return 'Aucun jeu publié'
    case 'UNKNOWN':
      return 'État de publication inconnu'
  }
}

export function publishedValidityLabel(status: PublishedValidityStatus): string {
  switch (status) {
    case 'CURRENT':
      return 'Période en cours'
    case 'NOT_YET_VALID':
      return 'Période non commencée'
    case 'STALE':
      return 'Période dépassée'
    case 'UNKNOWN':
      return 'Période inconnue'
  }
}

/** GTFS `route_type` values, described plainly; unknown codes stay unknown. */
export function describeRouteType(routeType: string | null): string {
  switch (routeType) {
    case '0':
      return 'Tramway'
    case '1':
      return 'Métro'
    case '2':
      return 'Train'
    case '3':
      return 'Bus'
    case '4':
      return 'Ferry'
    case '5':
      return 'Câble'
    case '6':
      return 'Téléphérique'
    case '7':
      return 'Funiculaire'
    case '11':
      return 'Trolleybus'
    case '12':
      return 'Monorail'
    default:
      return 'Mode non précisé'
  }
}

export function routeDisplayName(route: { shortName: string | null; longName: string | null; routeId: string }): string {
  if (route.shortName && route.longName) return `${route.shortName} · ${route.longName}`
  return route.shortName ?? route.longName ?? route.routeId
}

export function formatDistance(distanceM: number | null): string | null {
  if (distanceM === null || !Number.isFinite(distanceM) || distanceM < 0) return null
  if (distanceM < 1000) return `à ${Math.round(distanceM)} m`
  return `à ${(distanceM / 1000).toFixed(1).replace('.', ',')} km`
}

/** A snapshot is only served as current data while its declared window covers today. */
export function isCurrentSnapshot(network: PublishedNetwork): boolean {
  return network.available && network.snapshot?.validityStatus === 'CURRENT'
}

export function snapshotCountLine(snapshot: PublishedSnapshot): string {
  const parts = Object.entries(snapshot.recordCount)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${count} ${table}`)
  return parts.join(' · ')
}
