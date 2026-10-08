import { describe, expect, it } from 'vitest'
import {
  ALL_CORRIDOR_STOPS,
  BRT_STOPS,
  CORRIDOR_LINES,
  DAKAR_REGION_BOUNDS,
  TER_STOPS,
  haversineMeters,
  linesServingStop,
  nearestCorridorStops,
  searchCorridorStops,
} from './corridors'

describe('réseau de référence TER/BRT', () => {
  it('porte les 13 gares TER et les 23 stations BRT annoncées publiquement', () => {
    expect(TER_STOPS).toHaveLength(13)
    expect(BRT_STOPS).toHaveLength(23)
  })

  it('garantit des identifiants uniques et un ordre de desserte cohérent', () => {
    const ids = ALL_CORRIDOR_STOPS.map((stop) => stop.id)
    expect(new Set(ids).size).toBe(ids.length)
    TER_STOPS.forEach((stop, index) => expect(stop.order).toBe(index))
    BRT_STOPS.forEach((stop, index) => expect(stop.order).toBe(index))
  })

  it('place tous les arrêts dans l’enveloppe régionale affichée', () => {
    for (const stop of ALL_CORRIDOR_STOPS) {
      expect(stop.lat).toBeGreaterThanOrEqual(DAKAR_REGION_BOUNDS.minLat)
      expect(stop.lat).toBeLessThanOrEqual(DAKAR_REGION_BOUNDS.maxLat)
      expect(stop.lon).toBeGreaterThanOrEqual(DAKAR_REGION_BOUNDS.minLon)
      expect(stop.lon).toBeLessThanOrEqual(DAKAR_REGION_BOUNDS.maxLon)
    }
  })

  it('englobe Almadies et Bargny dans le cadrage de la carte', () => {
    // Pointe des Almadies ~ (14.7479, -17.5277) ; Bargny ~ (14.73, -17.0) hors BRT mais Rufisque/Bargny TER inclus.
    expect(DAKAR_REGION_BOUNDS.minLon).toBeLessThanOrEqual(-17.53)
    const bargny = TER_STOPS.find((stop) => stop.name === 'Bargny')
    expect(bargny).toBeDefined()
    expect(bargny!.lon).toBeGreaterThan(DAKAR_REGION_BOUNDS.minLon)
    expect(bargny!.lon).toBeLessThan(DAKAR_REGION_BOUNDS.maxLon)
  })

  it('retrouve un arrêt malgré les accents et les alias', () => {
    expect(searchCorridorStops('guediawaye')[0]?.id).toBe('brt-prefecture-guediawaye')
    expect(searchCorridorStops('Guédiawaye')[0]?.id).toBe('brt-prefecture-guediawaye')
    expect(searchCorridorStops('petersen')[0]?.id).toBe('brt-petersen')
    expect(searchCorridorStops('diamniadio')[0]?.id).toBe('ter-diamniadio')
    expect(searchCorridorStops('aéroport blaise diagne')).toHaveLength(0)
  })

  it('ne renvoie rien plutôt que deviner un lieu inconnu', () => {
    expect(searchCorridorStops('tour eiffel')).toHaveLength(0)
    expect(searchCorridorStops('')).toHaveLength(0)
  })

  it('associe chaque arrêt aux lignes qui le desservent réellement', () => {
    expect(linesServingStop('ter-rufisque').map((line) => line.shortName)).toEqual(['TER'])
    expect(linesServingStop('brt-parcelles').map((line) => line.shortName)).toEqual(['B1'])
    expect(linesServingStop('inconnu')).toHaveLength(0)
  })

  it('calcule des distances plausibles (Dakar → Diamniadio ≈ 25 km à vol d’oiseau)', () => {
    const dakar = TER_STOPS[0]
    const diamniadio = TER_STOPS[TER_STOPS.length - 1]
    const distance = haversineMeters(dakar, diamniadio)
    expect(distance).toBeGreaterThan(20_000)
    expect(distance).toBeLessThan(30_000)
  })

  it('liste les arrêts les plus proches d’un point', () => {
    const near = nearestCorridorStops({ lat: 14.6761, lon: -17.4336 }, 1)
    expect(near[0]?.stop.id).toBe('ter-dakar')
    expect(near[0]?.distanceM).toBeLessThan(100)
  })

  it('déclare des lignes dont les arrêts existent tous', () => {
    for (const line of CORRIDOR_LINES) {
      for (const stopId of line.stopIds) {
        expect(ALL_CORRIDOR_STOPS.some((stop) => stop.id === stopId)).toBe(true)
      }
    }
  })
})
