import { describe, expect, it } from 'vitest'
import { getCorridorStop } from './corridors'
import { compareReferenceJourneys } from './comparison'
import { planReferenceJourney, type PlannerEndpoint } from './planner'

const point = (id: string): PlannerEndpoint => {
  const stop = getCorridorStop(id)!
  return { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: id }
}

const GUEDIAWAYE = point('brt-prefecture-guediawaye')
const RUFISQUE = point('ter-rufisque')

describe('comparateur de trajets de référence', () => {
  it('conserve exactement le trajet par défaut comme première option', () => {
    const original = planReferenceJourney(GUEDIAWAYE, RUFISQUE)
    expect(planReferenceJourney(GUEDIAWAYE, RUFISQUE, 'fastest')).toEqual(original)
    const comparison = compareReferenceJourneys(GUEDIAWAYE, RUFISQUE)
    expect(comparison.ok).toBe(true)
    if (comparison.ok) expect(comparison.options[0].result).toEqual(original)
  })

  it('ne présente que des trajets distincts calculés et classe selon les valeurs affichées', () => {
    const comparison = compareReferenceJourneys(GUEDIAWAYE, RUFISQUE)
    expect(comparison.ok).toBe(true)
    if (!comparison.ok) return
    // For this pair the 1.4 km Colobane transfer is faster, while the
    // 1 km Dakar transfer trades a few minutes for less walking.
    expect(comparison.options).toHaveLength(2)
    expect(comparison.options[0].result.totalWalkM).toBe(1400)
    expect(comparison.options[1].result.totalWalkM).toBe(1000)
    expect(comparison.options[1].result.totalMinutes).toBeGreaterThan(comparison.options[0].result.totalMinutes)
    for (const { result } of comparison.options) {
      expect(result.totalMinutes).toBeGreaterThan(0)
      expect(result.totalWalkM).toBeGreaterThanOrEqual(0)
      expect(result.limitation).toContain('réseau de référence')
    }
    const best = (criterion: keyof typeof comparison.bestBy) => comparison.options.find((option) => option.priority === comparison.bestBy[criterion])!.result
    expect(best('fastest').totalMinutes).toBe(Math.min(...comparison.options.map((option) => option.result.totalMinutes)))
    expect(best('lessWalking').totalWalkM).toBe(Math.min(...comparison.options.map((option) => option.result.totalWalkM)))
    expect(best('fewerTransfers').transfers).toBe(Math.min(...comparison.options.map((option) => option.result.transfers)))
    const fingerprints = comparison.options.map(({ result }) => result.legs.map((leg) => [leg.kind, leg.line?.id, leg.from, leg.to].join(':')).join('|'))
    expect(new Set(fingerprints).size).toBe(comparison.options.length)
  })

  it('refuse au lieu de comparer quand aucun arrêt n’est accessible', () => {
    const result = compareReferenceJourneys({ label: 'Mbour', lat: 14.4167, lon: -16.9667 }, RUFISQUE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('NO_ACCESSIBLE_STOP')
  })
})
