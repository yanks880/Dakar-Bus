import { describe, expect, it } from 'vitest'
import {
  MAX_STORED_REPORTS,
  STREET_REPORT_STORAGE_KEY,
  STREET_REPORT_TTL_MINUTES,
  createStreetReport,
  formatReportAge,
  isReportExpired,
  parseStreetReport,
  parseStreetReports,
  readStreetReports,
  removeStreetReport,
  reportKindLabel,
  sortStreetReports,
  writeStreetReports,
  type StreetReport,
} from './streetReports'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

function report(overrides: Partial<StreetReport> = {}): StreetReport {
  return {
    id: 'r1',
    kind: 'CONGESTION',
    place: 'Patte d’Oie → Aéroport',
    networkId: 'ddd',
    comment: 'File ininterrompue depuis 20 minutes.',
    lat: 14.72,
    lng: -17.47,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + STREET_REPORT_TTL_MINUTES * 60_000).toISOString(),
    source: 'COMMUNITY',
    ...overrides,
  }
}

describe('création d’un signalement', () => {
  it('horodate et fait expirer le signalement', () => {
    const created = createStreetReport(
      { kind: 'INCIDENT', place: '  Voie de dégagement   du   BRT  ', networkId: 'brt', comment: '  Bus arrêté  ' },
      NOW,
    )!
    expect(created.place).toBe('Voie de dégagement du BRT')
    expect(created.comment).toBe('Bus arrêté')
    expect(created.createdAt).toBe('2026-10-08T12:00:00.000Z')
    expect(created.expiresAt).toBe('2026-10-08T13:30:00.000Z')
    expect(created.source).toBe('COMMUNITY')
    expect(created.lat).toBeNull()
  })

  it('refuse un signalement sans portion de route ni type connu', () => {
    expect(createStreetReport({ kind: 'OTHER', place: '   ' }, NOW)).toBeNull()
    expect(createStreetReport({ kind: 'AUTRE' as never, place: 'Sacré-Cœur' }, NOW)).toBeNull()
  })

  it('ne conserve une position que si les deux composantes sont exploitables', () => {
    const created = createStreetReport({ kind: 'ROADWORK', place: 'Hann', networkId: null, lat: 14.7, lng: Number.NaN }, NOW)!
    expect(created.lat).toBeNull()
    expect(created.lng).toBeNull()
  })

  it('tronque les textes longs au lieu de les perdre', () => {
    const created = createStreetReport({ kind: 'OTHER', place: 'a'.repeat(300), comment: 'b'.repeat(300) }, NOW)!
    expect(created.place).toHaveLength(80)
    expect(created.comment).toHaveLength(140)
  })
})

describe('validation des signalements lus', () => {
  it('écarte les entrées invalides, périmées et dupliquées', () => {
    const fresh = report({ id: 'ok' })
    const expired = report({ id: 'vieux', createdAt: new Date(NOW - 200 * 60_000).toISOString(), expiresAt: new Date(NOW - 110 * 60_000).toISOString() })
    const list = parseStreetReports([fresh, expired, fresh, null, 42, { id: 'x' }, { ...fresh, id: 'sans-type', kind: 'INCONNU' }], NOW)
    expect(list.map((item) => item.id)).toEqual(['ok'])
  })

  it('refuse une position incomplète', () => {
    const parsed = parseStreetReport({ ...report(), id: 'a', lng: null })
    expect(parsed?.lat).toBeNull()
    expect(parsed?.lng).toBeNull()
  })

  it('ne garde qu’un réseau connu de l’application', () => {
    expect(parseStreetReport({ ...report(), id: 'a', networkId: 'ddd' })?.networkId).toBe('ddd')
    expect(parseStreetReport({ ...report(), id: 'b', networkId: '<img src=x>' })?.networkId).toBeNull()
    expect(parseStreetReport({ ...report(), id: 'c', networkId: 42 })?.networkId).toBeNull()
  })

  it('trie du plus récent au plus ancien', () => {
    const older = report({ id: 'a', createdAt: new Date(NOW - 60_000).toISOString() })
    const newer = report({ id: 'b', createdAt: new Date(NOW).toISOString() })
    expect(sortStreetReports([older, newer]).map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('signale l’expiration à l’instant de fin de validité', () => {
    const value = report()
    expect(isReportExpired(value, NOW)).toBe(false)
    expect(isReportExpired(value, Date.parse(value.expiresAt))).toBe(true)
  })
})

describe('persistance locale', () => {
  it('relit ce qu’il a écrit et oublie les signalements périmés', () => {
    const storage = memoryStorage()
    const fresh = report({ id: 'ok' })
    const expired = report({ id: 'vieux', expiresAt: new Date(NOW - 1_000).toISOString() })
    writeStreetReports(storage, [fresh, expired], NOW)
    expect(readStreetReports(storage, NOW).map((item) => item.id)).toEqual(['ok'])
  })

  it('renvoie une liste vide quand le stockage est indisponible', () => {
    expect(readStreetReports(null, NOW)).toEqual([])
    expect(() => writeStreetReports(null, [report()])).not.toThrow()
  })

  it('renvoie une liste vide sur un contenu illisible', () => {
    const storage = memoryStorage()
    storage.setItem(STREET_REPORT_STORAGE_KEY, 'ceci n’est pas du JSON')
    expect(readStreetReports(storage, NOW)).toEqual([])
  })

  it('borne le nombre de signalements conservés', () => {
    const storage = memoryStorage()
    const many = Array.from({ length: MAX_STORED_REPORTS + 15 }, (_unused, index) =>
      report({ id: `r-${index}`, createdAt: new Date(NOW + index * 1_000).toISOString() }),
    )
    writeStreetReports(storage, many, NOW + 60_000)
    expect(readStreetReports(storage, NOW + 60_000)).toHaveLength(MAX_STORED_REPORTS)
  })

  it('retire un signalement par son identifiant', () => {
    const list = [report({ id: 'a' }), report({ id: 'b' })]
    expect(removeStreetReport(list, 'a').map((item) => item.id)).toEqual(['b'])
  })
})

describe('présentation', () => {
  it('nomme chaque type de signalement', () => {
    expect(reportKindLabel('CONGESTION')).toBe('Embouteillage')
    expect(reportKindLabel('BLOCKED')).toBe('Route coupée')
  })

  it('exprime l’âge du signalement, jamais une prédiction', () => {
    expect(formatReportAge(new Date(NOW - 5_000).toISOString(), NOW)).toBe('à l’instant')
    expect(formatReportAge(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('il y a 12 min')
    expect(formatReportAge(new Date(NOW - 65 * 60_000).toISOString(), NOW)).toBe('il y a 1 h 05')
    expect(formatReportAge('pas une date', NOW)).toBe('horodatage illisible')
  })
})
