import { describe, expect, it } from 'vitest'
import {
  ALL_CORRIDOR_STOPS,
  BRT_STOPS,
  CORRIDOR_LINES,
  DAKAR_REGION_BOUNDS,
  CORRIDOR_TRANSFERS,
  TER_STOPS,
  getCorridorStop,
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

  it('verrouille la séquence officielle des 23 stations BRT', () => {
    // Séquence publiée (CETUD / SunuBRT), sens Plateau → Guédiawaye. Toute
    // modification de cette liste doit être justifiée par une source publique.
    expect(BRT_STOPS.map((stop) => stop.name)).toEqual([
      'Petersen – Papa Gueye Fall',
      'Grande Mosquée',
      'Place de la Nation',
      'Dial Diop',
      'Grand Dakar',
      'Liberté 1',
      'Sacré-Cœur',
      'Liberté 5',
      'Liberté 6',
      'Khar Yalla',
      'Scat Urbam',
      'Cardinal Hyacinthe Thiandoum',
      'Grand Médine',
      'Police des Parcelles',
      'Croisement 22',
      'Parcelles',
      'Ndingala',
      'Golf Sud',
      'Dalal Jamm',
      'Fith Mith',
      'Golf Nord',
      'Gueule Tapée',
      'Préfecture de Guédiawaye',
    ])
    // Chaque station porte le nœud OpenStreetMap qui justifie sa position.
    const nodes = BRT_STOPS.map((stop) => stop.osmNodeId)
    expect(nodes.every((node): node is number => typeof node === 'number' && node > 0)).toBe(true)
    expect(new Set(nodes).size).toBe(BRT_STOPS.length)
    expect(BRT_STOPS[0]).toMatchObject({ id: 'brt-petersen', lat: 14.6766438, lon: -17.4406354 })
    expect(BRT_STOPS[BRT_STOPS.length - 1]).toMatchObject({
      id: 'brt-prefecture-guediawaye',
      lat: 14.7719791,
      lon: -17.3868591,
    })
  })

  it('enchaîne les stations BRT sans saut invraisemblable (positions exactes, pas d’interpolation)', () => {
    for (let index = 0; index < BRT_STOPS.length - 1; index += 1) {
      const distance = haversineMeters(BRT_STOPS[index], BRT_STOPS[index + 1])
      expect(distance).toBeGreaterThan(300)
      expect(distance).toBeLessThan(1700)
    }
    const total = BRT_STOPS.slice(1).reduce(
      (sum, stop, index) => sum + haversineMeters(BRT_STOPS[index], stop),
      0,
    )
    // Corridor officiel : 18,3 km ; la somme des segments entre stations
    // (vol d’oiseau, sans détour de voirie) doit rester du même ordre.
    expect(total / 1000).toBeGreaterThan(16)
    expect(total / 1000).toBeLessThan(19)
  })

  it('déclare la desserte semi-express B3 sur les seules stations annoncées', () => {
    const b1 = CORRIDOR_LINES.find((line) => line.id === 'brt-b1')
    expect(b1?.expressStopIds).toEqual([
      'brt-petersen',
      'brt-place-nation',
      'brt-khar-yallah',
      'brt-croisement-22',
      'brt-parcelles',
      'brt-gueule-tapee',
      'brt-prefecture-guediawaye',
    ])
  })

  it('relie TER et BRT par des correspondances marchables cohérentes avec les positions', () => {
    for (const transfer of CORRIDOR_TRANSFERS) {
      const from = getCorridorStop(transfer.fromStopId)
      const to = getCorridorStop(transfer.toStopId)
      expect(from).not.toBeNull()
      expect(to).not.toBeNull()
      // Une marche déclarée ne peut pas être plus courte que la ligne droite
      // entre les deux positions, ni dépasser une correspondance urbaine.
      expect(transfer.walkM).toBeGreaterThanOrEqual(Math.floor(haversineMeters(from!, to!)))
      expect(transfer.walkM).toBeLessThan(2500)
    }
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
    expect(searchCorridorStops('Keur Mbaye Fall')[0]?.id).toBe('ter-mbao')
    expect(searchCorridorStops('Mbao')[0]?.name).toBe('Keur Mbaye Fall')
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
