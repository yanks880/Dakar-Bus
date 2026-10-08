import { describe, expect, it } from 'vitest'
import {
  describeRouteType,
  formatDistance,
  isCurrentSnapshot,
  parseNetworkPayload,
  parseRoutesPayload,
  parseStopDetailPayload,
  parseStopsPayload,
  publicationStatusLabel,
  routeDisplayName,
  snapshotCountLine,
  type PublishedNetwork,
} from './published'

const networkPayload = (overrides: Record<string, unknown> = {}) => ({
  available: true,
  publication_status: 'PUBLISHED',
  published_at: '2026-10-08T13:19:34+00:00',
  publisher_id: 'ousmane.fall',
  snapshot: {
    snapshot_id: 'snap-20261008t131934z-demo',
    built_at: '2026-10-08T13:19:34+00:00',
    validity_status: 'CURRENT',
    valid_from: '2026-01-01T00:00:00+00:00',
    valid_until: '2027-12-31T23:59:59+00:00',
    timezone: 'Africa/Dakar',
    record_count: { stops: 8, routes: 3, stop_times: 19 },
    bounds: { min_lat: 14.66, min_lon: -17.49, max_lat: 14.77, max_lon: -17.4, stops_with_coordinates: 8 },
  },
  dataset: { dataset_id: 'demo-2026-10', operator: 'Démonstration locale', source_type: 'GTFS', service_status: 'ACTIVE' },
  message: 'Snapshot publié servi en lecture seule ; horaires théoriques, aucun temps réel.',
  data_policy: 'Données GTFS Static publiées depuis un snapshot daté et immuable.',
  blocked_reason: null,
  realtime: false,
  ...overrides,
})

describe('network payload parsing', () => {
  it('accepts a published snapshot and keeps its identity', () => {
    const parsed = parseNetworkPayload(networkPayload())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.available).toBe(true)
    expect(parsed.value.publicationStatus).toBe('PUBLISHED')
    expect(parsed.value.snapshot?.snapshotId).toBe('snap-20261008t131934z-demo')
    expect(parsed.value.snapshot?.validityStatus).toBe('CURRENT')
    expect(parsed.value.snapshot?.recordCount.stops).toBe(8)
    expect(parsed.value.snapshot?.bounds?.maxLat).toBe(14.77)
    expect(parsed.value.dataset?.operator).toBe('Démonstration locale')
    expect(isCurrentSnapshot(parsed.value)).toBe(true)
    expect(snapshotCountLine(parsed.value.snapshot!)).toBe('8 stops · 3 routes · 19 stop_times')
  })

  it('accepts the honest « nothing published » answer', () => {
    const parsed = parseNetworkPayload({
      available: false,
      publication_status: 'NOT_PUBLISHED',
      snapshot: null,
      message: 'Aucun jeu de données n’est publié.',
      realtime: false,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.available).toBe(false)
    expect(parsed.value.snapshot).toBeNull()
    expect(isCurrentSnapshot(parsed.value)).toBe(false)
  })

  it('refuses an available network without an identifiable snapshot', () => {
    const parsed = parseNetworkPayload({ available: true, publication_status: 'PUBLISHED', snapshot: null })
    expect(parsed.ok).toBe(false)
  })

  it('refuses a payload that is not an object', () => {
    expect(parseNetworkPayload(null).ok).toBe(false)
    expect(parseNetworkPayload('snap').ok).toBe(false)
    expect(parseNetworkPayload({ snapshot: {} }).ok).toBe(false)
  })

  it('marks an unrecognised publication or validity status as unknown', () => {
    const parsed = parseNetworkPayload(
      networkPayload({ publication_status: 'MAYBE', snapshot: { ...networkPayload().snapshot, validity_status: 'SOON' } }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.publicationStatus).toBe('UNKNOWN')
    expect(parsed.value.snapshot?.validityStatus).toBe('UNKNOWN')
  })
})

describe('stops and routes parsing', () => {
  it('parses search results with declared coordinates only', () => {
    const parsed = parseStopsPayload({
      count: 1,
      results: [{ stop_id: 'D6', stop_name: 'Démo — Yoff Aéroport', stop_lat: 14.748, stop_lon: -17.49, distance_m: 786 }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value[0].stopName).toBe('Démo — Yoff Aéroport')
    expect(parsed.value[0].distanceM).toBe(786)
    expect(formatDistance(parsed.value[0].distanceM)).toBe('à 786 m')
  })

  it('keeps a stop without coordinates rather than inventing a position', () => {
    const parsed = parseStopsPayload({ results: [{ stop_id: 'S1', stop_name: 'Sans coordonnées' }] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value[0].lat).toBeNull()
    expect(parsed.value[0].lon).toBeNull()
    expect(formatDistance(parsed.value[0].distanceM)).toBeNull()
  })

  it('refuses a malformed stop list instead of skipping broken entries', () => {
    expect(parseStopsPayload({ results: [{ stop_name: 'sans identifiant' }] }).ok).toBe(false)
    expect(parseStopsPayload({ results: 'nope' }).ok).toBe(false)
    expect(parseStopsPayload({}).ok).toBe(false)
  })

  it('parses a stop detail with its theoretical window labelled as such', () => {
    const parsed = parseStopDetailPayload({
      stop: {
        stop_id: 'D1',
        stop_name: 'Démo — Plateau Nord',
        stop_lat: 14.674,
        stop_lon: -17.438,
        routes: [{ route_id: 'L1', route_short_name: 'L1', route_long_name: 'Démo — Plateau ↔ Yoff (bus)', route_type: '3', trip_count: 2 }],
        scheduled_time_window: {
          first_declared_departure: '06:00:00',
          last_declared_departure: '08:30:00',
          note: 'Heures théoriques déclarées dans stop_times (GTFS Static) ; ce n’est ni une position, ni un temps réel.',
        },
      },
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.routes).toHaveLength(1)
    expect(routeDisplayName({ ...parsed.value.routes[0], shortName: parsed.value.routes[0].shortName, longName: parsed.value.routes[0].longName })).toBe(
      'L1 · Démo — Plateau ↔ Yoff (bus)',
    )
    expect(parsed.value.scheduledWindow?.firstDeclaredDeparture).toBe('06:00:00')
    expect(parsed.value.scheduledWindow?.note).toContain('temps réel')
    expect(describeRouteType(parsed.value.routes[0].routeType)).toBe('Bus')
  })

  it('refuses a stop detail without a stop object', () => {
    expect(parseStopDetailPayload({}).ok).toBe(false)
    expect(parseStopDetailPayload({ stop: { stop_name: 'sans identifiant' } }).ok).toBe(false)
  })

  it('parses routes and never invents a short name', () => {
    const parsed = parseRoutesPayload({
      results: [
        { route_id: 'L1', route_short_name: 'L1', route_long_name: 'Plateau ↔ Yoff', route_type: '3', trip_count: 2 },
        { route_id: 'L2', route_short_name: null, route_long_name: null, route_type: '99', trip_count: null },
      ],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(routeDisplayName(parsed.value[0])).toBe('L1 · Plateau ↔ Yoff')
    expect(routeDisplayName(parsed.value[1])).toBe('L2')
    expect(describeRouteType(parsed.value[1].routeType)).toBe('Mode non précisé')
    expect(parseRoutesPayload({ results: [{ nope: true }] }).ok).toBe(false)
  })
})

describe('labels', () => {
  it('describes publication and validity states without pretending', () => {
    expect(publicationStatusLabel('PUBLISHED')).toBe('Publié')
    expect(publicationStatusLabel('NOT_PUBLISHED')).toBe('Aucun jeu publié')
    expect(publicationStatusLabel('UNKNOWN')).toBe('État de publication inconnu')
    expect(formatDistance(0)).toBe('à 0 m')
    expect(formatDistance(1500)).toBe('à 1,5 km')
    expect(formatDistance(null)).toBeNull()
  })

  it('only treats a current, available snapshot as current data', () => {
    const base = parseNetworkPayload(networkPayload())
    expect(base.ok).toBe(true)
    if (!base.ok) return
    const stale: PublishedNetwork = {
      ...base.value,
      snapshot: { ...base.value.snapshot!, validityStatus: 'STALE' },
    }
    expect(isCurrentSnapshot(stale)).toBe(false)
  })
})
