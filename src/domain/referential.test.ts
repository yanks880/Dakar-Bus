import { describe, expect, it } from 'vitest'
import { ALL_CORRIDOR_STOPS, CORRIDOR_LINES } from './corridors'
import {
  REFERENTIAL_LINES,
  REFERENTIAL_NETWORKS,
  REFERENTIAL_STOPS,
  findReferentialLine,
  findReferentialStops,
  linesForStop,
  nearestReferentialStops,
  publishedServiceWindow,
  referentialConsistencyIssues,
  referentialKnowledgeSummary,
  stopsBetween,
} from './referential'

describe('référentiel central des mobilités', () => {
  it('ne contient que les arrêts réels des corridors : aucun arrêt fictif', () => {
    expect(REFERENTIAL_STOPS.map((stop) => stop.id).sort())
      .toEqual(ALL_CORRIDOR_STOPS.map((stop) => stop.id).sort())
    expect(REFERENTIAL_STOPS.length).toBe(36)
    expect(referentialConsistencyIssues()).toEqual([])
  })

  it('distingue les niveaux d’intégration sans mélanger les réseaux', () => {
    const byId = Object.fromEntries(REFERENTIAL_NETWORKS.map((network) => [network.id, network]))
    expect(byId.ter.integrationStatus).toBe('REFERENCE_NETWORK')
    expect(byId.brt.integrationStatus).toBe('REFERENCE_NETWORK')
    expect(byId.ddd.integrationStatus).toBe('METADATA_ONLY')
    expect(byId.aftu.integrationStatus).toBe('METADATA_ONLY')
    expect(byId.tata.integrationStatus).toBe('NOT_INTEGRATED')
    expect(byId.ddd.classification).toBe('BUS_URBAN')
    expect(byId.aftu.classification).toBe('MINIBUS')
    expect(byId.ddd.frequencyStatus).toBe('UNKNOWN')
    expect(byId.aftu.frequencyStatus).toBe('UNKNOWN')
  })

  it('retrouve un arrêt par nom, alias et variante orthographique', () => {
    expect(findReferentialStops('petersen')[0]?.id).toBe('brt-petersen')
    expect(findReferentialStops('Gare de Petersen')[0]?.id).toBe('brt-petersen')
    expect(findReferentialStops('guédiawaye')[0]?.id).toBe('brt-prefecture-guediawaye')
    expect(findReferentialStops('keur mbaye fall')[0]?.id).toBe('ter-mbao')
    expect(findReferentialStops('nimportequoi')).toEqual([])
  })

  it('retrouve une ligne par numéro ou nom, avec ses terminus', () => {
    const b1 = findReferentialLine('B1')
    expect(b1?.shortName).toBe('B1')
    expect(b1?.terminusFrom).toContain('Petersen')
    expect(b1?.terminusTo).toContain('Guédiawaye')
    expect(findReferentialLine('ter')?.shortName).toBe('TER')
    expect(findReferentialLine('ligne 999')).toBeNull()
  })

  it('liste les lignes desservant un arrêt et les arrêts entre deux points dans le bon sens', () => {
    expect(linesForStop('brt-petersen').map((line) => line.shortName)).toContain('B1')
    const b1 = REFERENTIAL_LINES.find((line) => line.id === 'brt-b1')!
    const forward = stopsBetween(b1, 'brt-petersen', 'brt-dial-diop')!
    expect(forward.map((stop) => stop.id)).toEqual(['brt-petersen', 'brt-grande-mosquee', 'brt-place-nation', 'brt-dial-diop'])
    const backward = stopsBetween(b1, 'brt-dial-diop', 'brt-petersen')!
    expect(backward[0].id).toBe('brt-dial-diop')
    expect(backward[backward.length - 1].id).toBe('brt-petersen')
    expect(stopsBetween(b1, 'brt-petersen', 'ter-dakar')).toBeNull()
  })

  it('donne les bornes publiées des fenêtres de service, jamais des passages observés', () => {
    const ter = publishedServiceWindow('ter')
    expect(ter.status).toBe('SCHEDULED')
    expect(ter.firstDeparture).toBe('05:30')
    expect(ter.lastDeparture).toBe('22:00')
    expect(ter.note).toContain('pas des passages observés')
    const brt = publishedServiceWindow('brt')
    expect(brt.lastDeparture).toBe('21:00')
    const ddd = publishedServiceWindow('ddd')
    expect(ddd.status).toBe('UNKNOWN')
    expect(ddd.lastDeparture).toBeNull()
  })

  it('trouve l’arrêt le plus proche avec une distance réelle', () => {
    const nearest = nearestReferentialStops({ lat: 14.6760, lon: -17.4335 }, 1)
    expect(nearest[0].stop.id).toBe('ter-dakar')
    expect(nearest[0].distanceM).toBeLessThan(500)
  })

  it('l’état des connaissances cite le confirmé et le manquant sans inventer', () => {
    const summary = referentialKnowledgeSummary()
    expect(summary).toContain('Confirmé dans le référentiel')
    expect(summary).toContain('Non confirmé')
    expect(summary).toContain('Dakar Dem Dikk')
    expect(summary).toContain('AFTU')
    expect(summary).not.toContain('temps réel connecté')
  })

  it('les lignes du référentiel reprennent exactement les corridors', () => {
    expect(REFERENTIAL_LINES.length).toBe(CORRIDOR_LINES.length)
    for (const line of REFERENTIAL_LINES) {
      const origin = CORRIDOR_LINES.find((candidate) => candidate.id === line.id)
      expect(origin?.stopIds).toEqual(line.stopIds)
    }
  })
})
