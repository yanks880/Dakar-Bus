import { describe, expect, it } from 'vitest'
import { CORRIDOR_LINES } from './corridors'
import {
  CANDIDATE_LINES,
  OBSERVATION_POLICY,
  confidenceOf,
  considerObservation,
  emptyObservationStats,
  estimateRide,
  isDocumentedTrace,
  nextCountdown,
  parseCandidate,
  projectArrival,
  withCandidateOptions,
  type CandidateLine,
  type PassageObservation,
} from './candidateLines'

/** Fixture de test. Ce n'est pas une ligne versée dans l'inventaire. */
function line(overrides: Partial<CandidateLine> = {}): CandidateLine {
  return {
    networkId: 'ddd',
    lineId: 'fixture-ddd-1',
    directionId: 'outbound',
    name: 'Fixture — ne pas publier',
    stops: [
      { name: 'Départ fixture', lat: 14.7, lon: -17.44, coordinateStatus: 'published' },
      { name: 'Milieu fixture', lat: 14.71, lon: -17.42, coordinateStatus: 'published' },
      { name: 'Arrivée fixture', lat: 14.73, lon: -17.4, coordinateStatus: 'observed' },
    ],
    temporalModel: 'UNKNOWN',
    source: {
      authority: 'CETUD',
      url: 'https://cetud.sn/reseaux-de-transport/ddd/',
      consultedAt: null,
      validFrom: null,
      validUntil: null,
    },
    assumptions: { speedKph: null, dwellMin: null, publishedHeadwayMin: null },
    serviceWindow: null,
    publishedDepartureIso: null,
    ...overrides,
  }
}

const THURSDAY_NOON = Date.parse('2026-10-08T12:00:00Z')
const WINDOW = { days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const, start: '06:00', end: '21:00' }

describe('lignes candidates DDD/AFTU', () => {
  it('ne verse aucune ligne inventée et ne retire pas TER/BRT (DDD/AFTU/TATA en pointillés légers)', () => {
    expect(CANDIDATE_LINES).toEqual([])
    // Après ajustement visuel : TER/BRT continus + DDD/AFTU/TATA en pointillés légers
    const allReferenceIds = CORRIDOR_LINES.map((item) => item.id)
    expect(allReferenceIds).toContain('ter-dakar-diamniadio')
    expect(allReferenceIds).toContain('brt-b1')
    expect(allReferenceIds).toContain('ddd-1')
    expect(allReferenceIds).toContain('aftu-1')
    expect(allReferenceIds).toContain('tata-1')
    expect(withCandidateOptions(CORRIDOR_LINES.map((item) => item.id))).toEqual(allReferenceIds)
    const partial = line({ stops: [line().stops[0]] })
    expect(isDocumentedTrace(partial)).toBe(false)
    expect(withCandidateOptions(['ter-dakar-diamniadio', 'brt-b1'], [partial, line({ assumptions: { speedKph: 18, dwellMin: null, publishedHeadwayMin: null } })])).toEqual([
      'ter-dakar-diamniadio',
      'brt-b1',
      'fixture-ddd-1',
    ])
  })

  it('rejette TATA, une URL active et une fiche illisible sans lever d’exception', () => {
    expect(parseCandidate(null)).toBeNull()
    expect(parseCandidate({ networkId: 'tata', lineId: '1' })).toBeNull()
    expect(parseCandidate({ ...line(), source: { ...line().source, url: 'javascript:alert(1)' } })).toBeNull()
    expect(parseCandidate('ddd')).toBeNull()
    expect(() => nextCountdown(line(), Number.NaN)).not.toThrow()
    expect(nextCountdown(line(), Number.NaN)).toEqual({ kind: 'NONE', reason: 'UNREADABLE' })
  })

  it('estime un parcours documenté sans horaire, et refuse une vitesse inventée', () => {
    const documented = line({ assumptions: { speedKph: 18, dwellMin: 0.4, publishedHeadwayMin: null } })
    const ride = estimateRide(documented, 0, 2)
    expect(ride.ok).toBe(true)
    if (ride.ok) {
      expect(ride.kind).toBe('ESTIMATED_RIDE')
      expect(ride.countdown).toBeNull()
      expect(ride.distanceM).toBeGreaterThan(1000)
      expect(ride.minutes).toBeGreaterThan(1)
    }
    expect(estimateRide(line(), 0, 2)).toEqual({ ok: false, reason: 'NO_SPEED_ASSUMPTION' })
    expect(estimateRide(documented, 2, 0)).toEqual({ ok: false, reason: 'WRONG_DIRECTION' })
    expect(nextCountdown(documented, THURSDAY_NOON)).toEqual({ kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' })
  })

  it('projette un départ publié sans le confondre avec l’heure estimée à l’arrêt', () => {
    const anchor = '2026-10-08T12:00:00.000Z'
    const atTerminus = projectArrival(anchor, 0)
    const downstream = projectArrival(anchor, 17)
    expect(atTerminus?.publishedDeparture).toBe(atTerminus?.estimatedArrival)
    expect(downstream?.publishedDeparture).toBe(anchor)
    expect(downstream?.estimatedArrival).not.toBe(downstream?.publishedDeparture)
    expect(downstream?.estimatedArrival).toBe('2026-10-08T12:17:00.000Z')
  })

  it('ne fabrique pas un compte à rebours exact sans ancre, et sépare les sens', () => {
    const outbound = line({
      temporalModel: 'PUBLISHED_DEPARTURES',
      directionId: 'outbound',
      publishedDepartureIso: '2026-10-08T12:10:00.000Z',
      serviceWindow: WINDOW,
    })
    const inbound = line({
      ...outbound,
      directionId: 'inbound',
      lineId: 'fixture-ddd-1-retour',
      publishedDepartureIso: '2026-10-08T12:40:00.000Z',
    })
    const going = nextCountdown(outbound, THURSDAY_NOON, { offsetMin: 17 })
    const returning = nextCountdown(inbound, THURSDAY_NOON, { offsetMin: 17 })
    expect(going.kind).toBe('EXACT')
    expect(returning.kind).toBe('EXACT')
    if (going.kind === 'EXACT' && returning.kind === 'EXACT') {
      expect(going.estimatedArrival).not.toBe(returning.estimatedArrival)
      expect(going.publishedDeparture).not.toBe(going.estimatedArrival)
      expect(going.minutes).toBeGreaterThanOrEqual(1)
    }
    expect(nextCountdown({ ...outbound, publishedDepartureIso: null }, THURSDAY_NOON)).toEqual({ kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' })
    expect(nextCountdown({ ...outbound, temporalModel: 'UNKNOWN' }, THURSDAY_NOON)).toEqual({ kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' })
    expect(nextCountdown(line({ temporalModel: 'MODEL_ONLY', assumptions: { speedKph: 18, dwellMin: null, publishedHeadwayMin: null } }), THURSDAY_NOON).kind).toBe('NONE')
  })

  it('ne propose pas d’horaire hors fenêtre connue, et n’en invente pas si la fenêtre manque', () => {
    const published = line({
      temporalModel: 'PUBLISHED_HEADWAY',
      assumptions: { speedKph: null, dwellMin: null, publishedHeadwayMin: 12 },
      serviceWindow: WINDOW,
    })
    expect(nextCountdown(published, THURSDAY_NOON)).toEqual({ kind: 'AVERAGE', minutes: 6 })
    expect(nextCountdown(published, Date.parse('2026-10-08T21:00:00Z'))).toEqual({ kind: 'NONE', reason: 'OUTSIDE_SERVICE' })
    expect(nextCountdown(published, Date.parse('2026-10-10T12:00:00Z'))).toEqual({ kind: 'NONE', reason: 'OUTSIDE_SERVICE' })
    expect(nextCountdown({ ...published, serviceWindow: null }, THURSDAY_NOON)).toEqual({ kind: 'NONE', reason: 'UNKNOWN_WINDOW' })
    expect(nextCountdown(published, THURSDAY_NOON).kind).not.toBe('EXACT')
  })

  it('ignore les observations futures, hors ligne, dupliquées ou trop rapprochées', () => {
    const documented = line()
    const base: PassageObservation = {
      lineId: documented.lineId,
      directionId: documented.directionId,
      stopName: 'Départ fixture',
      observedAt: '2026-10-08T11:00:00.000Z',
      collectedBy: 'explicit-user-action',
    }
    const initial = emptyObservationStats()
    const accepted = considerObservation(documented, base, THURSDAY_NOON, initial)
    expect(accepted.accepted).toBe(true)
    expect(accepted.stats.validCount).toBe(1)

    const future = considerObservation(documented, { ...base, observedAt: '2026-10-08T13:00:00.000Z' }, THURSDAY_NOON, accepted.stats)
    expect(future).toMatchObject({ accepted: false, reason: 'FUTURE' })
    expect(future.stats).toBe(accepted.stats)

    const offLine = considerObservation(documented, { ...base, stopName: 'Arrêt imaginaire', observedAt: '2026-10-08T11:02:00.000Z' }, THURSDAY_NOON, accepted.stats)
    expect(offLine.reason).toBe('OFF_LINE')
    expect(offLine.stats).toBe(accepted.stats)

    const duplicate = considerObservation(documented, base, THURSDAY_NOON, accepted.stats)
    expect(duplicate.reason).toBe('DUPLICATE')

    const aberrant = considerObservation(documented, { ...base, observedAt: '2026-10-08T11:00:20.000Z' }, THURSDAY_NOON, accepted.stats)
    expect(aberrant.reason).toBe('ABERRANT')
    expect(aberrant.stats.validCount).toBe(1)

    const passive = considerObservation(documented, { ...base, collectedBy: 'background-gps', observedAt: '2026-10-08T11:05:00.000Z' }, THURSDAY_NOON, accepted.stats)
    expect(passive.reason).toBe('NOT_EXPLICIT')
    expect(confidenceOf(accepted.stats, THURSDAY_NOON)).toBe('exploratory')
    expect(OBSERVATION_POLICY.minSamplesForUsable).toBeGreaterThan(accepted.stats.validCount)
  })

  it('ne promeut pas une statistique périmée ou trop mince en compte à rebours', () => {
    const observed = line({ temporalModel: 'OBSERVED_HEADWAY' })
    const thin = { validCount: 2, lastObservedAt: '2026-10-08T11:00:00.000Z', acceptedAt: ['2026-10-08T10:00:00.000Z', '2026-10-08T11:00:00.000Z'] }
    expect(nextCountdown(observed, THURSDAY_NOON, { stats: thin })).toEqual({ kind: 'NONE', reason: 'NO_TEMPORAL_ANCHOR' })
    const stale = {
      validCount: OBSERVATION_POLICY.minSamplesForUsable,
      lastObservedAt: '2026-01-01T00:00:00.000Z',
      acceptedAt: ['2026-01-01T00:00:00.000Z'],
    }
    expect(confidenceOf(stale, THURSDAY_NOON)).toBe('none')
    expect(nextCountdown(observed, THURSDAY_NOON, { stats: stale }).kind).toBe('NONE')
  })
})
