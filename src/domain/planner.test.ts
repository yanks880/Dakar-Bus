import { describe, expect, it } from 'vitest'
import { getCorridorStop } from './corridors'
import { describeLeg, planReferenceJourney, type PlannerResult } from './planner'

const PLATEAU = { label: 'Plateau (point carte)', lat: 14.6735, lon: -17.4375 }
// Point à ~110 m de la station BRT « Préfecture de Guédiawaye » (position OSM).
const GUEDIAWAYE = { label: 'Guédiawaye (point carte)', lat: 14.7725, lon: -17.3860 }
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

describe('cohérence des coûts du calculateur', () => {
  it('ne propose pas un détour à pied quand aucun véhicule n’est emprunté', () => {
    // Deux points à ~110 m l’un de l’autre, mais chacun à ~1,2 km de la gare de
    // Dakar : la chaîne « marche vers la gare puis marche vers la destination »
    // faisait 2,4 km et 30 min pour un déplacement de 2 min à pied.
    const dakar = getCorridorStop('ter-dakar')!
    const a = { label: 'A', lat: dakar.lat + 0.0107, lon: dakar.lon }
    const b = { label: 'B', lat: dakar.lat + 0.0107, lon: dakar.lon + 0.001 }
    const outcome = planReferenceJourney(a, b)
    expect(outcome.ok).toBe(true)
    const result = outcome as PlannerResult
    expect(result.legs).toHaveLength(1)
    expect(result.legs[0].kind).toBe('walk_direct')
    expect(result.boardedLines).toHaveLength(0)
    expect(result.totalMinutes).toBeLessThanOrEqual(3)
    expect(result.totalWalkM).toBeLessThan(200)
  })

  it('préfère la marche directe à une chaîne marche + marche sans transport', () => {
    // Deux points au nord de deux stations BRT voisines : le trajet utile est la
    // marche directe, pas un passage par une station.
    const petersen = getCorridorStop('brt-petersen')!
    const mosquee = getCorridorStop('brt-grande-mosquee')!
    const outcome = planReferenceJourney(
      { label: 'P', lat: petersen.lat + 0.005, lon: petersen.lon },
      { label: 'Q', lat: mosquee.lat + 0.005, lon: mosquee.lon },
    ) as PlannerResult
    expect(outcome.legs.filter((leg) => leg.kind === 'ride')).toHaveLength(0)
    expect(outcome.legs).toHaveLength(1)
    expect(outcome.legs[0].kind).toBe('walk_direct')
    expect(outcome.totalWalkM).toBeLessThan(900)
  })

  it('conserve les trajets qui empruntent réellement un véhicule', () => {
    const outcome = planReferenceJourney(PLATEAU, GUEDIAWAYE) as PlannerResult
    expect(outcome.legs.some((leg) => leg.kind === 'ride')).toBe(true)
    expect(outcome.legs.some((leg) => leg.kind === 'walk_direct')).toBe(false)
  })

  it('décrit la marche directe dans un français lisible', () => {
    const dakar = getCorridorStop('ter-dakar')!
    const outcome = planReferenceJourney(
      { label: 'A', lat: dakar.lat + 0.0107, lon: dakar.lon },
      { label: 'B', lat: dakar.lat + 0.0107, lon: dakar.lon + 0.001 },
    ) as PlannerResult
    expect(describeLeg(outcome.legs[0])).toMatch(/Trajet à pied .* : A → B/)
  })

  it('répond court quand aucun trajet n’est possible', () => {
    const far = { label: 'Mbour', lat: 14.4167, lon: -16.9667 }
    const outcome = planReferenceJourney(far, GUEDIAWAYE)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message.length).toBeLessThan(120)
  })
})
