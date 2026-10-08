import { describe, expect, it } from 'vitest'
import { getCorridorStop } from './corridors'
import { describeLeg, planReferenceJourney, type PlannerResult } from './planner'

const PLATEAU = { label: 'Plateau (point carte)', lat: 14.6735, lon: -17.4375 }
const GUEDIAWAYE = { label: 'Guédiawaye (point carte)', lat: 14.8035, lon: -17.3245 }
const RUFISQUE = { label: 'Rufisque (point carte)', lat: 14.7145, lon: -17.2725 }

describe('calculateur multimodal de référence', () => {
  it('relie le Plateau à Guédiawaye en BRT sans inventer de correspondance', () => {
    const outcome = planReferenceJourney(PLATEAU, GUEDIAWAYE)
    expect(outcome.ok).toBe(true)
    const result = outcome as PlannerResult
    const rides = result.legs.filter((leg) => leg.kind === 'ride')
    expect(rides.length).toBe(1)
    expect(rides[0].line?.shortName).toBe('B1')
    expect(rides[0].from).toContain('Petersen')
    expect(result.transfers).toBe(0)
    expect(result.totalMinutes).toBeGreaterThan(20)
    expect(result.totalMinutes).toBeLessThan(180)
    expect(result.limitation).toContain('réseau de référence')
  })

  it('combine BRT et TER avec une correspondance marchable déclarée pour Rufisque', () => {
    // Départ près du terminus BRT (Guédiawaye) vers Rufisque, desservi par le seul TER.
    const outcome = planReferenceJourney(GUEDIAWAYE, RUFISQUE)
    expect(outcome.ok).toBe(true)
    const result = outcome as PlannerResult
    const lines = result.legs.filter((leg) => leg.kind === 'ride').map((leg) => leg.line?.shortName)
    expect(lines).toContain('B1')
    expect(lines).toContain('TER')
    expect(result.transfers).toBeGreaterThanOrEqual(1)
    expect(result.boardedLines).toEqual(expect.arrayContaining(['B1', 'TER']))
  })

  it('refuse un départ trop éloigné du réseau de référence au lieu de deviner', () => {
    const far = { label: 'Mbour', lat: 14.4167, lon: -16.9667 }
    const outcome = planReferenceJourney(far, GUEDIAWAYE)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toBe('NO_ACCESSIBLE_STOP')
      expect(outcome.message).toContain('DDD')
    }
  })

  it('refuse un trajet entre deux points identiques', () => {
    const outcome = planReferenceJourney(PLATEAU, PLATEAU)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('SAME_POINT')
  })

  it('accepte un arrêt de référence choisi explicitement comme départ', () => {
    const stop = getCorridorStop('brt-grand-medine')!
    const origin = { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id }
    const outcome = planReferenceJourney(origin, RUFISQUE)
    expect(outcome.ok).toBe(true)
    const result = outcome as PlannerResult
    // Le trajet part bien de l’arrêt choisi : soit on y monte directement,
    // soit une marche d’accès démarre de là (vers une gare proche, par exemple).
    expect(result.legs[0].from).toBe(stop.name)
  })

  it('décrit chaque jambe dans un français lisible', () => {
    const outcome = planReferenceJourney(PLATEAU, GUEDIAWAYE) as PlannerResult
    const texts = outcome.legs.map(describeLeg)
    expect(texts[0]).toMatch(/Marcher/)
    expect(texts.some((text) => text.startsWith('B1'))).toBe(true)
  })

  it('compte la marche totale et reste cohérent avec la somme des jambes', () => {
    const outcome = planReferenceJourney(PLATEAU, GUEDIAWAYE) as PlannerResult
    const legSum = outcome.legs.reduce((total, leg) => total + leg.minutes, 0)
    expect(Math.abs(legSum - outcome.totalMinutes)).toBeLessThanOrEqual(outcome.legs.length + 2)
    expect(outcome.totalWalkM).toBeGreaterThanOrEqual(0)
  })
})
