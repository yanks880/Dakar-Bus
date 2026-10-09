import { describe, expect, it } from 'vitest'
import { BRT_STOPS, TER_STOPS } from './corridors'
import type { PublishedStop } from './published'
import {
  GROUP_BRT,
  GROUP_MOBILITY,
  GROUP_PUBLISHED,
  GROUP_TER,
  buildStopIndex,
  findStopOption,
  normalizeSearchTerm,
  searchStopIndex,
} from './stops'

const published: PublishedStop[] = [
  { stopId: 'D6', stopName: 'Démo — Yoff Aéroport', lat: 14.748, lon: -17.49, distanceM: 120, locationType: '0', parentStation: null },
  { stopId: 'D9', stopName: 'Démo — Sans position', lat: null, lon: null, distanceM: null, locationType: '0', parentStation: null },
]

const index = buildStopIndex(published)
const labels = (query: string, limit?: number) => searchStopIndex(index, query, limit).map((option) => option.label)

describe('index de recherche du Trajet', () => {
  it('couvre les cinq mobilités et tous les arrêts déclarés', () => {
    const mobility = index.filter((option) => option.group === GROUP_MOBILITY)
    expect(mobility.map((option) => option.label)).toEqual(['TER', 'BRT', 'DDD', 'AFTU', 'TATA'])
    expect(index.filter((option) => option.group === GROUP_TER)).toHaveLength(TER_STOPS.length)
    expect(index.filter((option) => option.group === GROUP_BRT)).toHaveLength(BRT_STOPS.length)
    expect(index.filter((option) => option.group === GROUP_PUBLISHED).map((option) => option.stopId)).toEqual(['D6'])
  })

  it('trouve chaque mobilité par son sigle ou son autorité', () => {
    expect(labels('aftu')[0]).toBe('AFTU')
    expect(labels('cetud').map((value) => value)).toEqual(expect.arrayContaining(['DDD', 'AFTU']))
    expect(labels('senter')[0]).toBe('TER')
    expect(labels('sunubrt')[0]).toBe('BRT')
    expect(labels('dakar dem dikk')[0]).toBe('DDD')
    expect(labels('tata')[0]).toBe('TATA')
  })

  it('trouve un arrêt de référence par son nom, accentué ou non', () => {
    expect(labels('petersen')[0]).toMatch(/Petersen/)
    expect(labels('guediawaye')[0]).toMatch(/Guédiawaye/)
    expect(labels('prefecture')[0]).toMatch(/Préfecture/)
    expect(labels('keur mbaye')[0]).toBe('Keur Mbaye Fall')
  })

  it('trouve un arrêt publié et un alias', () => {
    expect(labels('yoff').map((value) => value)).toEqual(expect.arrayContaining(['Démo — Yoff Aéroport']))
    expect(labels('D6')[0]).toBe('Démo — Yoff Aéroport')
    expect(labels('hann')[0]).toBe('Hann')
  })

  it('classe les correspondances exactes avant les partielles', () => {
    expect(labels('dakar')[0]).toBe('Dakar')
  })

  it('ne renvoie rien sur une recherche vide et borne les résultats', () => {
    expect(labels('   ')).toEqual([])
    expect(searchStopIndex(index, 'a', 3)).toHaveLength(3)
  })

  it('marque comme non sélectionnable une mobilité sans arrêt déclaré', () => {
    const aftu = index.find((option) => option.value === 'network:aftu')!
    expect(aftu.selectable).toBe(false)
    expect(aftu.hint).toMatch(/arrêts non publiés/)
    const ter = index.find((option) => option.value === 'network:ter')!
    expect(ter.hint).toMatch(/13 gares/)
  })

  it('retrouve une option par sa valeur, ou rien', () => {
    expect(findStopOption(index, 'ref:brt-petersen')?.label).toMatch(/Petersen/)
    expect(findStopOption(index, 'published:D6')?.lat).toBe(14.748)
    expect(findStopOption(index, 'inconnu')).toBeNull()
  })
})

describe('normalisation des termes cherchés', () => {
  it('ignore accents, apostrophes, tirets et casse', () => {
    expect(normalizeSearchTerm('Préfecture de Guédiawaye')).toBe('prefecture de guediawaye')
    expect(normalizeSearchTerm('Patte d’Oie')).toBe('patte d oie')
    expect(normalizeSearchTerm('  AFTU  ')).toBe('aftu')
  })
})
