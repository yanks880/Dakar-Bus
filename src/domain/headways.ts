/**
 * Prochains créneaux théoriques calculés depuis les fréquences officielles.
 *
 * CE MODULE N'EST PAS UN FLUX TEMPS RÉEL ET N'EN SIMULE PAS UN.
 *
 * Il projette la grille déclarée par une autorité (premier départ, intervalle,
 * fin de service, jours de service) sur l'horloge de Dakar pour en déduire le
 * prochain créneau de la grille. Ce qu'il produit est un horaire théorique
 * issu d'une fréquence — « le service est annoncé toutes les 10 min à partir
 * de 05:30, donc le prochain créneau de la grille est 07:40 » — jamais une
 * position de véhicule, jamais un retard constaté, jamais une promesse.
 *
 * Dakar (Africa/Dakar) est à UTC+00 toute l'année, sans heure d'été : les
 * composantes UTC de l'instant sont l'heure locale légale. Aucune conversion
 * de fuseau n'est donc appliquée ni nécessaire.
 */

import { formatFrequencyPeriod, type OfficialFrequency, type ServiceDay } from './frequencies'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** Fenêtre glissante de recherche : 8 jours couvrent tous les calendriers déclarés. */
const SEARCH_DAYS = 8

const WEEKDAY_BY_SERVICE_DAY: Record<ServiceDay, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

export type PassageStatus =
  /** Le service est en cours : le créneau appartient à la période en cours. */
  | 'RUNNING'
  /** Le service n'a pas encore commencé aujourd'hui. */
  | 'BEFORE_SERVICE'
  /** Le service est fermé : le créneau appartient à une journée suivante. */
  | 'AFTER_SERVICE'
  /** Le service est encore ouvert mais le dernier créneau du jour est passé. */
  | 'LAST_PAST'

export interface NextPassage {
  status: PassageStatus
  /** Instant du prochain créneau de la grille (ISO 8601, UTC = heure de Dakar). */
  nextDepartureAt: string
  /** Minutes entières restantes, arrondies à l'entier supérieur (jamais 0). */
  minutes: number
  /** Intervalle déclaré de la période retenue (minutes). */
  headwayMinutes: number
  /** Période déclarée retenue, formatée (jours · plage · intervalle). */
  periodLabel: string
  /** Heure du créneau, en heure de Dakar (HH:MM). */
  clockLabel: string
  /** Phrase de vérité affichée avec le décompte : rappelle l'absence de temps réel. */
  note: string
  /** La période retenue exclut les jours fériés, dont la grille n'est pas déclarée. */
  holidayCaveat: boolean
}

function parseClockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function formatClock(date: Date): string {
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`
}

/** Minuit de Dakar pour l'instant donné (UTC+00, sans heure d'été). */
function startOfDakarDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS
}

function isUsable(frequency: OfficialFrequency): boolean {
  if (!Number.isFinite(frequency.headwayMinutes) || frequency.headwayMinutes <= 0) return false
  if (frequency.days.length === 0) return false
  return parseClockMinutes(frequency.serviceStart) !== null && parseClockMinutes(frequency.serviceEnd) !== null
}

function windowStart(dayStart: number, frequency: OfficialFrequency): number {
  return dayStart + (parseClockMinutes(frequency.serviceStart) ?? 0) * MINUTE_MS
}

/** Fin de service exclusive : un créneau tombant sur l'heure de fin n'est pas desservi. */
function windowEnd(dayStart: number, frequency: OfficialFrequency): number {
  const start = parseClockMinutes(frequency.serviceStart) ?? 0
  const end = parseClockMinutes(frequency.serviceEnd) ?? start
  return dayStart + (end <= start ? end + 24 * 60 : end) * MINUTE_MS
}

function servesWeekday(frequency: OfficialFrequency, weekday: number): boolean {
  return frequency.days.some((day) => WEEKDAY_BY_SERVICE_DAY[day] === weekday)
}

function noteFor(status: PassageStatus, clockLabel: string, headwayMinutes: number): string {
  switch (status) {
    case 'RUNNING':
      return `Prochain créneau théorique de la grille déclarée (${headwayMinutes} min). Ce n’est ni une position de véhicule, ni du temps réel.`
    case 'BEFORE_SERVICE':
      return `Service non commencé : premier créneau théorique à ${clockLabel}. Pas de temps réel.`
    case 'AFTER_SERVICE':
      return `Service terminé : prochain créneau théorique à ${clockLabel}. Pas de temps réel.`
    case 'LAST_PAST':
      return `Dernier créneau du service passé : prochain créneau théorique à ${clockLabel}. Pas de temps réel.`
  }
}

/**
 * Prochain créneau théorique d'un réseau, calculé depuis ses fréquences
 * officielles déclarées. Renvoie `null` lorsqu'aucune fréquence exploitable
 * n'est déclarée : dans ce cas rien n'est affiché, aucune attente n'est estimée.
 */
export function nextReferencePassage(
  frequencies: readonly OfficialFrequency[],
  now = Date.now(),
): NextPassage | null {
  const usable = frequencies.filter(isUsable)
  if (usable.length === 0) return null

  const todayStart = startOfDakarDay(now)

  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const dayStart = todayStart + offset * DAY_MS
    const weekday = new Date(dayStart).getUTCDay()
    let best: { at: number; frequency: OfficialFrequency } | null = null

    for (const frequency of usable) {
      if (!servesWeekday(frequency, weekday)) continue
      const start = windowStart(dayStart, frequency)
      const end = windowEnd(dayStart, frequency)
      if (end <= start) continue
      const step = frequency.headwayMinutes * MINUTE_MS
      const elapsed = now - start
      let slot = start + Math.max(0, Math.ceil(elapsed / step)) * step
      if (slot <= now) slot += step
      if (slot >= end) continue
      if (!best || slot < best.at) best = { at: slot, frequency }
    }

    if (!best) continue

    const runningNow = usable.some(
      (frequency) =>
        servesWeekday(frequency, weekday) &&
        windowStart(todayStart, frequency) <= now &&
        now < windowEnd(todayStart, frequency),
    )
    const sameDay = best.at - todayStart < DAY_MS
    const status: PassageStatus = runningNow
      ? sameDay
        ? 'RUNNING'
        : 'LAST_PAST'
      : sameDay
        ? 'BEFORE_SERVICE'
        : 'AFTER_SERVICE'
    const clockLabel = formatClock(new Date(best.at))

    return {
      status,
      nextDepartureAt: new Date(best.at).toISOString(),
      minutes: Math.max(1, Math.ceil((best.at - now) / MINUTE_MS)),
      headwayMinutes: best.frequency.headwayMinutes,
      periodLabel: formatFrequencyPeriod(best.frequency),
      clockLabel,
      note: noteFor(status, clockLabel, best.frequency.headwayMinutes),
      holidayCaveat: best.frequency.excludesPublicHolidays === true,
    }
  }

  return null
}

/** « 6 min », « 1 h 05 » : jamais « 0 min », jamais de temps réel sous-entendu. */
export function formatPassageCountdown(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 1) return '—'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`
}

/**
 * Délai avant le prochain changement de valeur affichée, pour un ensemble
 * d'instants programmés. Une seule temporisation est armée à la fois : elle
 * vise l'instant précis où l'un des décomptes doit diminuer, ce qui évite de
 * réveiller l'interface à la seconde sans raison.
 */
export function nextCountdownTickDelay(timestamps: readonly string[], now = Date.now()): number | null {
  let delay: number | null = null
  for (const timestamp of timestamps) {
    const target = Date.parse(timestamp)
    if (!Number.isFinite(target)) continue
    const remaining = target - now
    if (remaining <= 0) continue
    // Sous une minute, la dernière minute se compte à la seconde.
    const candidate = remaining < MINUTE_MS ? 1_000 : remaining - (Math.ceil(remaining / MINUTE_MS) - 1) * MINUTE_MS
    delay = delay === null ? candidate : Math.min(delay, candidate)
  }
  if (delay === null) return null
  return Math.min(Math.max(delay, 250), 60_000) + 30
}
