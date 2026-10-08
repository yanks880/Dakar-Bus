import { describe, expect, it } from 'vitest'
import {
  FREQUENCY_SOURCES,
  NETWORK_REFERENCE_DATA,
  OFFICIAL_FREQUENCY_VARIANTS,
  OFFICIAL_REFERENCE_FREQUENCIES,
  formatFrequencyPeriod,
  formatVerificationDate,
  type OfficialFrequency,
} from './frequencies'

describe('références officielles de fréquence', () => {
  it('enregistre le BRT B1 à six minutes sans le confondre avec un prochain passage', () => {
    const [brt] = OFFICIAL_REFERENCE_FREQUENCIES.brt
    expect(brt).toMatchObject({
      status: 'OFFICIAL_REFERENCE',
      headwayMinutes: 6,
      serviceStart: '06:00',
      serviceEnd: '21:00',
      scope: 'B1 · Guédiawaye ↔ Petersen · 23 stations',
    })
    expect(brt.days).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])
    expect(brt.source).toMatchObject({
      authority: 'CETUD',
      sourceUrl: 'https://www.sunubrt.sn',
      verifiedAt: null,
      verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
    })
    expect(formatFrequencyPeriod(brt)).toContain('06:00–21:00 · 6 min')
    expect(brt.label).toBe('Toutes les 6 minutes')
  })

  it('représente les trois périodes TER distinctement', () => {
    const [daytime, evening, sundayAndHoliday] = OFFICIAL_REFERENCE_FREQUENCIES.ter
    expect([daytime.headwayMinutes, evening.headwayMinutes, sundayAndHoliday.headwayMinutes]).toEqual([10, 20, 20])
    expect([daytime.serviceStart, daytime.serviceEnd]).toEqual(['05:30', '21:00'])
    expect([evening.serviceStart, evening.serviceEnd]).toEqual(['21:00', '22:00'])
    expect([sundayAndHoliday.serviceStart, sundayAndHoliday.serviceEnd]).toEqual(['06:30', '22:00'])
    expect(daytime.days).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])
    expect(evening.days).toEqual(daytime.days)
    expect(daytime.excludesPublicHolidays).toBe(true)
    expect(evening.excludesPublicHolidays).toBe(true)
    expect(sundayAndHoliday.days).toEqual(['SUN'])
    expect(sundayAndHoliday.appliesToPublicHolidays).toBe(true)
    expect(daytime.status).toBe('OFFICIAL_REFERENCE')
    expect(daytime.source).toMatchObject({
      authority: 'TER_DAKAR',
      sourceUrl: 'https://www.senersa.sn',
      verifiedAt: null,
      verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
    })
  })

  it('keeps official DDD/AFTU fleet counts separate from unavailable line frequencies', () => {
    expect(NETWORK_REFERENCE_DATA.ddd).toMatchObject({
      lineCount: 38,
      vehicleCount: 400,
      serviceStart: '06:00',
      serviceEnd: '21:00',
      sourceAuthority: 'CETUD',
      frequencyStatus: 'UNKNOWN',
      frequencyLabel: 'Fréquences non publiées ligne par ligne',
      officialFrequencies: [],
    })
    expect(NETWORK_REFERENCE_DATA.aftu).toMatchObject({
      lineCount: 72,
      vehicleCount: 2300,
      gieCount: 14,
      serviceStart: '06:00',
      serviceEnd: '21:00',
      sourceAuthority: 'CETUD',
      frequencyStatus: 'UNKNOWN',
      frequencyLabel: 'Fréquences non publiées ligne par ligne',
      officialFrequencies: [],
    })
    expect(NETWORK_REFERENCE_DATA.aftu.lineCount).not.toBe(71)
    expect(NETWORK_REFERENCE_DATA.ddd.source).toMatchObject({
      authority: 'CETUD',
      sourceUrl: 'https://cetud.sn',
      verifiedAt: null,
      verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
    })
  })

  it('uses only source URLs already recorded in the repository', () => {
    expect(FREQUENCY_SOURCES.brt.sourceUrl).toBe('https://www.sunubrt.sn')
    expect(FREQUENCY_SOURCES.ter.sourceUrl).toBe('https://www.senersa.sn')
    expect(FREQUENCY_SOURCES.cetud.sourceUrl).toBe('https://cetud.sn')
    for (const source of Object.values(FREQUENCY_SOURCES)) {
      expect(source.sourceUrl).toMatch(/^https:\/\//)
      expect(source.verifiedAt).toBeNull()
      expect(source.verificationStatus).toBe('UNVERIFIED_IN_REPOSITORY')
    }
  })

  it('can store an exceptional TER variant without replacing the permanent reference', () => {
    const permanent = OFFICIAL_REFERENCE_FREQUENCIES.ter[0]
    const exceptional: OfficialFrequency = {
      ...permanent,
      headwayMinutes: 5,
      serviceVariant: {
        type: 'EXCEPTIONAL',
        validFrom: '2026-12-01T00:00:00Z',
        validUntil: '2026-12-02T00:00:00Z',
      },
    }
    expect(permanent.headwayMinutes).toBe(10)
    expect(exceptional.headwayMinutes).toBe(5)
    expect(exceptional.serviceVariant?.type).toBe('EXCEPTIONAL')
    // Aucun renfort (dont 3 min sur le BRT) n'est affirmé sans source vérifiée.
    expect(OFFICIAL_FREQUENCY_VARIANTS).toEqual([])
  })

  it('does not invent an online verification date', () => {
    expect(formatVerificationDate(null)).toBe('non vérifiée en ligne')
    expect(formatVerificationDate('2026-10-08')).toBe('08/10/2026')
    expect(formatVerificationDate('date inconnue')).toBe('date inconnue')
  })
})
