import { describe, expect, it } from 'vitest'

import {
  declaredClockLabel,
  formatJourneyDate,
  journeyRouteLabel,
  parseJourneysPayload,
  walkSummary,
  type Journey,
} from './journeys'

const LEG = {
  stop_id: 'D1',
  stop_name: 'Démo — Plateau Nord',
  departure: '06:00:00',
  walk_m: 0,
  walk_m_known: true,
  walk_path: ['D1'],
}

const RESULT = {
  kind: 'direct',
  transfers: 0,
  trip_id: 'L1-A',
  service_id: 'DEMO-WK',
  route: { route_id: 'L1', short_name: 'L1', long_name: 'Démo — Plateau ↔ Yoff (bus)', route_type: '3' },
  board: LEG,
  alight: { ...LEG, stop_id: 'D6', stop_name: 'Démo — Yoff Aéroport', departure: undefined, arrival: '07:05:00' },
  departure_seconds: 21600,
  arrival_seconds: 25500,
  duration_min: 65,
  date: '2026-10-08',
  note: 'Horaire théorique déclaré dans le flux GTFS Static ; ni position ni estimation temps réel.',
}

const PAYLOAD = {
  generated_at: '2026-10-08T13:47:47+00:00',
  snapshot_id: 'snap-20261008t131934z-d-monstration-locale-donn-es-synth-tique',
  publication_status: 'PUBLISHED',
  graph: {
    built_at: '2026-10-08T13:45:53+00:00',
    snapshot_id: 'snap-20261008t131934z-d-monstration-locale-donn-es-synth-tique',
    stats: { stops: 8, places: 8, trips: 5, edges: 0 },
    capabilities: { network_walk: true, direct_rides: true, transfers_itinerary: false, realtime: false },
    parameters: { cluster_radius_m: 250.0, nearby_walk_radius_m: 400.0 },
  },
  origin: { input: 'Démo — Plateau Nord', origin: 'published-stop', coordinates: { lat: 14.674, lon: -17.438 } },
  destination: { input: 'Démo — Yoff Aéroport', origin: 'published-stop', coordinates: { lat: 14.748, lon: -17.49 } },
  requested_at: '2026-10-08T13:47:47+00:00',
  local_day: '2026-10-08',
  max_walk_m: 900.0,
  start_walk_m: 400.0,
  results: [RESULT],
  result_count: 1,
  result_date: '2026-10-08',
  exhausted_today: false,
  next_service_date: null,
  message: null,
  limitations: 'Le moteur ne propose que des courses directes déclarées dans le flux : une seule montée, une seule descente.',
  data_policy: 'Graphe dérivé du snapshot publié.',
  realtime: false,
}

describe('parseJourneysPayload', () => {
  it('lit une course directe déclarée', () => {
    const parsed = parseJourneysPayload(PAYLOAD)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.results).toHaveLength(1)
    const journey = parsed.value.results[0]
    expect(journey.departure.declaredTime).toBe('06:00:00')
    expect(journey.arrival.declaredTime).toBe('07:05:00')
    expect(journey.durationMin).toBe(65)
    expect(journey.date).toBe('2026-10-08')
    expect(journey.routeShortName).toBe('L1')
    expect(journeyRouteLabel(journey)).toBe('L1')
    expect(parsed.value.reason).toBe('DIRECT_RIDE_FOUND')
    expect(parsed.value.localDay).toBe('2026-10-08')
    expect(parsed.value.graphStats.stops).toBe(8)
    expect(parsed.value.graphBuiltAt).toBe('2026-10-08T13:45:53+00:00')
  })

  it('lit un refus sans inventer de résultat', () => {
    const parsed = parseJourneysPayload({
      ...PAYLOAD,
      results: [],
      result_count: 0,
      result_date: null,
      message: 'Aucune course directe déclarée ne relie ces deux lieux dans le rayon de marche demandé.',
      next_service_date: '2026-10-12',
      exhausted_today: true,
      reason: 'NO_DIRECT_SERVICE',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.results).toEqual([])
    expect(parsed.value.reason).toBe('NO_DIRECT_SERVICE')
    expect(parsed.value.nextServiceDate).toBe('2026-10-12')
    expect(parsed.value.exhaustedToday).toBe(true)
  })

  it('refuse une réponse qui prétend au temps réel', () => {
    const parsed = parseJourneysPayload({ ...PAYLOAD, realtime: true })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/temps réel/i)
  })

  it('refuse une course incomplète plutôt que de la compléter', () => {
    const withoutArrival = { ...RESULT, alight: { ...RESULT.alight, arrival: null } }
    const parsed = parseJourneysPayload({ ...PAYLOAD, results: [withoutArrival] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/incomplète/i)
  })

  it('refuse une course qui porterait une correspondance', () => {
    const parsed = parseJourneysPayload({ ...PAYLOAD, results: [{ ...RESULT, transfers: 1 }] })
    expect(parsed.ok).toBe(false)
  })

  it('refuse une marche sans mention de sa mesure', () => {
    const walk = { ...RESULT.board, walk_m: 120, walk_m_known: undefined }
    const parsed = parseJourneysPayload({ ...PAYLOAD, results: [{ ...RESULT, board: walk }] })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.reason).toMatch(/incomplète/i)
  })

  it('refuse une réponse sans heure de référence ou sans liste de résultats', () => {
    expect(parseJourneysPayload({ ...PAYLOAD, requested_at: null }).ok).toBe(false)
    expect(parseJourneysPayload({ ...PAYLOAD, results: undefined }).ok).toBe(false)
    expect(parseJourneysPayload('pas un objet').ok).toBe(false)
  })

  it('retombe sur un motif inconnu plutôt que d’annoncer une course', () => {
    const parsed = parseJourneysPayload({ ...PAYLOAD, results: [], reason: 'PEUT_ÊTRE' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.reason).toBe('UNKNOWN')
  })
})

describe('libellés d’itinéraire', () => {
  it('affiche les heures déclarées telles quelles, secondes masquées', () => {
    expect(declaredClockLabel('06:00:00')).toBe('06:00')
    expect(declaredClockLabel('25:10:00')).toBe('25:10')
    expect(declaredClockLabel('texte libre')).toBe('texte libre')
  })

  it('décrit la marche seulement quand elle existe', () => {
    const journey = parseJourneysPayload(PAYLOAD)
    expect(journey.ok).toBe(true)
    if (!journey.ok) return
    expect(walkSummary(journey.value.results[0].departure)).toBeNull()

    const walkLeg: Journey = journey.value.results[0]
    expect(walkSummary({ ...walkLeg.departure, walkM: 420, walkKnown: true, walkPath: ['D1', 'D2'] })).toBe('420 m à pied')
    expect(walkSummary({ ...walkLeg.departure, walkM: 1500, walkKnown: true, walkPath: ['D1', 'D2'] })).toBe('1,5 km à pied')
    expect(walkSummary({ ...walkLeg.departure, walkM: 0, walkKnown: false, walkPath: ['D1', 'D2'] })).toBe(
      'cheminement déclaré, distance inconnue',
    )
  })

  it('formate la date de service', () => {
    expect(formatJourneyDate('2026-10-09')).toBe('09/10/2026')
    expect(formatJourneyDate('bientôt')).toBe('bientôt')
  })
})
