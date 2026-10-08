/**
 * Références de fréquence et amplitudes documentées pour les réseaux de Dakar.
 * Ces références ne sont ni un horaire de passage ni un flux temps réel.
 */

export type FrequencyStatus = 'OFFICIAL_REFERENCE' | 'SCHEDULED' | 'ESTIMATED' | 'REAL_TIME' | 'UNKNOWN'
export type FrequencyAuthority = 'CETUD' | 'TER_DAKAR' | 'SETER' | 'AFTU' | 'DDD'
export type ServiceDay = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN'
export type ReferenceNetworkId = 'ter' | 'brt' | 'ddd' | 'aftu'

export type FrequencySource = {
  authority: FrequencyAuthority
  sourceUrl: string
  publishedAt?: string
} & (
  | {
      /** Verification date is required before a source can be marked verified. */
      verifiedAt: string
      verificationStatus: 'VERIFIED_OFFICIAL'
    }
  | {
      /** Null records that the repository contains the URL but no online check date. */
      verifiedAt: null
      verificationStatus: 'UNVERIFIED_IN_REPOSITORY'
    }
)

export interface FrequencyValidityPeriod {
  /** Null signifie que la source locale ne publie pas de date calendaire. */
  validFrom: string | null
  validUntil: string | null
}

export interface OfficialFrequency {
  status: 'OFFICIAL_REFERENCE'
  headwayMinutes: number
  serviceStart: string
  serviceEnd: string
  days: readonly ServiceDay[]
  appliesToPublicHolidays?: boolean
  excludesPublicHolidays?: boolean
  source: FrequencySource
  operator: string
  scope: string
  label: string
  validityPeriod: FrequencyValidityPeriod
  /** Une exception ou un renfort est un enregistrement séparé, jamais la base permanente. */
  serviceVariant?: {
    type: 'EXCEPTIONAL' | 'REINFORCED'
    validFrom: string
    validUntil: string
  }
}

export interface NetworkReferenceData {
  id: ReferenceNetworkId
  label: string
  shortName: string
  operator: string
  coverage: string
  lineCount: number | null
  stationCount: number | null
  vehicleCount: number | null
  gieCount: number | null
  serviceStart: string
  serviceEnd: string
  serviceWindow: string
  frequencyStatus: FrequencyStatus
  frequencyLabel: string
  officialFrequencies: readonly OfficialFrequency[]
  sourceAuthority: FrequencyAuthority
  source: FrequencySource
  validityPeriod: FrequencyValidityPeriod
}

// The repository contains these source URLs, but no external verification date.
const NO_VERIFIED_DATE = null
const NO_CALENDAR_VALIDITY: FrequencyValidityPeriod = { validFrom: null, validUntil: null }

/** URLs racines déjà référencées par le générateur GTFS et l'interface du dépôt. */
export const FREQUENCY_SOURCES: Readonly<Record<'brt' | 'ter' | 'cetud', FrequencySource>> = {
  brt: {
    authority: 'CETUD',
    sourceUrl: 'https://www.sunubrt.sn',
    verifiedAt: NO_VERIFIED_DATE,
    verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
  },
  ter: {
    authority: 'TER_DAKAR',
    sourceUrl: 'https://www.senersa.sn',
    verifiedAt: NO_VERIFIED_DATE,
    verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
  },
  cetud: {
    authority: 'CETUD',
    sourceUrl: 'https://cetud.sn',
    verifiedAt: NO_VERIFIED_DATE,
    verificationStatus: 'UNVERIFIED_IN_REPOSITORY',
  },
}

const ALL_DAYS: readonly ServiceDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const WEEKDAYS_AND_SATURDAY: readonly ServiceDay[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const SUNDAY: readonly ServiceDay[] = ['SUN']

export const OFFICIAL_REFERENCE_FREQUENCIES: Readonly<Record<'brt' | 'ter', readonly OfficialFrequency[]>> = {
  brt: [
    {
      status: 'OFFICIAL_REFERENCE',
      headwayMinutes: 6,
      serviceStart: '06:00',
      serviceEnd: '21:00',
      days: ALL_DAYS,
      source: FREQUENCY_SOURCES.brt,
      operator: 'CETUD / Dakar Mobilité (SunuBRT)',
      scope: 'B1 · Guédiawaye ↔ Petersen · 23 stations',
      label: 'Toutes les 6 minutes',
      validityPeriod: NO_CALENDAR_VALIDITY,
    },
  ],
  ter: [
    {
      status: 'OFFICIAL_REFERENCE',
      headwayMinutes: 10,
      serviceStart: '05:30',
      serviceEnd: '21:00',
      days: WEEKDAYS_AND_SATURDAY,
      excludesPublicHolidays: true,
      source: FREQUENCY_SOURCES.ter,
      operator: 'TER / SETER',
      scope: 'Dakar ↔ Diamniadio',
      label: 'Toutes les 10 minutes',
      validityPeriod: NO_CALENDAR_VALIDITY,
    },
    {
      status: 'OFFICIAL_REFERENCE',
      headwayMinutes: 20,
      serviceStart: '21:00',
      serviceEnd: '22:00',
      days: WEEKDAYS_AND_SATURDAY,
      excludesPublicHolidays: true,
      source: FREQUENCY_SOURCES.ter,
      operator: 'TER / SETER',
      scope: 'Dakar ↔ Diamniadio',
      label: 'Toutes les 20 minutes',
      validityPeriod: NO_CALENDAR_VALIDITY,
    },
    {
      status: 'OFFICIAL_REFERENCE',
      headwayMinutes: 20,
      serviceStart: '06:30',
      serviceEnd: '22:00',
      days: SUNDAY,
      appliesToPublicHolidays: true,
      source: FREQUENCY_SOURCES.ter,
      operator: 'TER / SETER',
      scope: 'Dakar ↔ Diamniadio',
      label: 'Toutes les 20 minutes',
      validityPeriod: NO_CALENDAR_VALIDITY,
    },
  ],
}

/**
 * Aucun service exceptionnel ou renforcé n'est intégré faute d'une référence
 * correspondante déjà vérifiée dans les sources du projet (notamment le tronc
 * commun BRT à 3 min). Le type accepte de futurs ajouts séparés de la base.
 */
export const OFFICIAL_FREQUENCY_VARIANTS: readonly OfficialFrequency[] = []

export const NETWORK_REFERENCE_DATA: Readonly<Record<ReferenceNetworkId, NetworkReferenceData>> = {
  brt: {
    id: 'brt',
    label: 'BRT',
    shortName: 'BRT',
    operator: 'Dakar Mobilité / SunuBRT',
    coverage: 'B1 · Guédiawaye ↔ Petersen',
    lineCount: 1,
    stationCount: 23,
    vehicleCount: null,
    gieCount: null,
    serviceStart: '06:00',
    serviceEnd: '21:00',
    serviceWindow: '06:00–21:00 · tous les jours',
    frequencyStatus: 'OFFICIAL_REFERENCE',
    frequencyLabel: '6 min',
    officialFrequencies: OFFICIAL_REFERENCE_FREQUENCIES.brt,
    sourceAuthority: 'CETUD',
    source: FREQUENCY_SOURCES.brt,
    validityPeriod: NO_CALENDAR_VALIDITY,
  },
  ter: {
    id: 'ter',
    label: 'TER',
    shortName: 'TER',
    operator: 'TER / SETER',
    coverage: 'Dakar ↔ Diamniadio',
    lineCount: null,
    stationCount: 13,
    vehicleCount: null,
    gieCount: null,
    serviceStart: '05:30',
    serviceEnd: '22:00',
    serviceWindow: '05:30–22:00 selon le jour et la période',
    frequencyStatus: 'OFFICIAL_REFERENCE',
    frequencyLabel: '10 min en journée · 20 min selon la période',
    officialFrequencies: OFFICIAL_REFERENCE_FREQUENCIES.ter,
    sourceAuthority: 'TER_DAKAR',
    source: FREQUENCY_SOURCES.ter,
    validityPeriod: NO_CALENDAR_VALIDITY,
  },
  ddd: {
    id: 'ddd',
    label: 'Dakar Dem Dikk',
    shortName: 'DDD',
    operator: 'Dakar Dem Dikk',
    coverage: 'Réseau urbain',
    lineCount: 38,
    stationCount: null,
    vehicleCount: 400,
    gieCount: null,
    serviceStart: '06:00',
    serviceEnd: '21:00',
    serviceWindow: '06:00–21:00',
    frequencyStatus: 'UNKNOWN',
    frequencyLabel: 'Fréquences non publiées ligne par ligne',
    officialFrequencies: [],
    sourceAuthority: 'CETUD',
    source: FREQUENCY_SOURCES.cetud,
    validityPeriod: NO_CALENDAR_VALIDITY,
  },
  aftu: {
    id: 'aftu',
    label: 'AFTU',
    shortName: 'AFTU',
    operator: 'AFTU',
    coverage: 'Réseau de minibus',
    lineCount: 72,
    stationCount: null,
    vehicleCount: 2300,
    gieCount: 14,
    serviceStart: '06:00',
    serviceEnd: '21:00',
    serviceWindow: '06:00–21:00',
    frequencyStatus: 'UNKNOWN',
    frequencyLabel: 'Fréquences non publiées ligne par ligne',
    officialFrequencies: [],
    sourceAuthority: 'CETUD',
    source: FREQUENCY_SOURCES.cetud,
    validityPeriod: NO_CALENDAR_VALIDITY,
  },
}

const SERVICE_DAY_LABELS: Record<ServiceDay, string> = {
  MON: 'lun.',
  TUE: 'mar.',
  WED: 'mer.',
  THU: 'jeu.',
  FRI: 'ven.',
  SAT: 'sam.',
  SUN: 'dim.',
}

export function formatVerificationDate(value: string | null): string {
  if (!value) return 'non vérifiée en ligne'
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(date)
}

export function formatSourceVerification(source: FrequencySource): string {
  if (source.verificationStatus === 'VERIFIED_OFFICIAL' && source.verifiedAt) {
    return `Vérifiée le ${formatVerificationDate(source.verifiedAt)}`
  }
  return 'Référence présente dans le dépôt · vérification en ligne non documentée'
}

export function formatFrequencyDays(frequency: OfficialFrequency): string {
  const days = frequency.days.map((day) => SERVICE_DAY_LABELS[day])
  const label = days.length === 7 ? 'tous les jours' : days.length === 1 ? days[0] : `${days[0]}–${days[days.length - 1]}`
  if (frequency.appliesToPublicHolidays) return `${label} et jours fériés`
  if (frequency.excludesPublicHolidays) return `${label} (hors jours fériés)`
  return label
}

export function formatFrequencyPeriod(frequency: OfficialFrequency): string {
  return `${formatFrequencyDays(frequency)} · ${frequency.serviceStart}–${frequency.serviceEnd} · ${frequency.headwayMinutes} min`
}
