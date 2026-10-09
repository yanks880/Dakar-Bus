/**
 * « Direct rue » : remontée d'informations terrain par les usagers.
 *
 * RÈGLE DE VÉRITÉ — ces signalements sont des déclarations d'usagers :
 *  - ils ne sont jamais vérifiés par l'application, ni par un exploitant ;
 *  - ils ne remplacent ni ne corrigent un horaire déclaré ;
 *  - ils ne sont pas transmis à un serveur : ils vivent dans le stockage local
 *    du navigateur, sur l'appareil de celle ou celui qui les saisit ;
 *  - ils expirent d'eux-mêmes (durée de vie courte) pour qu'une information
 *    périmée ne reste pas affichée comme actuelle.
 *
 * Aucun signalement n'est donc présenté comme une alerte officielle : la
 * provenance « COMMUNITY » est affichée partout où ils apparaissent.
 */

import { NETWORK_SOURCES, type NetworkId } from './network'

export type StreetReportKind = 'CONGESTION' | 'INCIDENT' | 'ROADWORK' | 'BLOCKED' | 'OTHER'

export interface StreetReportKindDefinition {
  id: StreetReportKind
  label: string
  /** Ce que l'usager décrit, en une phrase. */
  hint: string
}

export const STREET_REPORT_KINDS: readonly StreetReportKindDefinition[] = [
  { id: 'CONGESTION', label: 'Embouteillage', hint: 'Circulation très ralentie ou à l’arrêt sur la portion.' },
  { id: 'INCIDENT', label: 'Incident', hint: 'Accident, panne ou véhicule immobilisé sur la voie.' },
  { id: 'ROADWORK', label: 'Travaux', hint: 'Chantier, déviation ou voie rétrécie.' },
  { id: 'BLOCKED', label: 'Route coupée', hint: 'Voie fermée ou impraticable dans un sens ou les deux.' },
  { id: 'OTHER', label: 'Autre', hint: 'Toute autre situation visible sur place.' },
]

export interface StreetReport {
  id: string
  kind: StreetReportKind
  /** Portion de route ou repère saisi par l'usager, jamais géocodé à sa place. */
  place: string
  /** Réseau concerné, si l'usager le précise. */
  networkId: NetworkId | null
  comment: string | null
  /** Position jointe au signalement, uniquement si l'usager l'a demandé. */
  lat: number | null
  lng: number | null
  /** Instant de la saisie (ISO 8601). */
  createdAt: string
  /** Fin de validité : au-delà, le signalement disparaît de l'écran. */
  expiresAt: string
  source: 'COMMUNITY'
}

export const STREET_REPORT_STORAGE_KEY = 'dakar-bus:street-reports'
export const STREET_REPORT_TTL_MINUTES = 90
export const MAX_PLACE_LENGTH = 80
export const MAX_COMMENT_LENGTH = 140
export const MAX_STORED_REPORTS = 40

export const STREET_REPORT_PROVENANCE =
  'Signalements d’usagers, non vérifiés : ce ne sont ni des alertes officielles, ni du temps réel, ni un horaire.'

export function reportKindLabel(kind: StreetReportKind): string {
  return STREET_REPORT_KINDS.find((item) => item.id === kind)?.label ?? 'Signalement'
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
  return trimmed.length > 0 ? trimmed : null
}

function isKind(value: unknown): value is StreetReportKind {
  return typeof value === 'string' && STREET_REPORT_KINDS.some((item) => item.id === value)
}

function finiteCoordinate(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Seul un réseau connu de l’application peut être rattaché à un signalement. */
function isNetworkId(value: unknown): value is NetworkId {
  return typeof value === 'string' && NETWORK_SOURCES.some((network) => network.id === value)
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

let fallbackSequence = 0

function createReportId(now: number): string {
  const random = globalThis.crypto?.randomUUID?.()
  if (typeof random === 'string' && random.length > 0) return random
  fallbackSequence += 1
  return `report-${now}-${fallbackSequence}`
}

export interface StreetReportDraft {
  kind: StreetReportKind
  place: string
  networkId?: NetworkId | null
  comment?: string | null
  lat?: number | null
  lng?: number | null
}

/**
 * Crée un signalement horodaté et périssable. Renvoie `null` si la portion
 * de route est vide : mieux vaut ne rien enregistrer qu'un signalement sans
 * objet.
 */
export function createStreetReport(draft: StreetReportDraft, now = Date.now()): StreetReport | null {
  const place = cleanText(draft.place, MAX_PLACE_LENGTH)
  if (!place || !isKind(draft.kind)) return null
  const createdAt = new Date(now).toISOString()
  const lat = finiteCoordinate(draft.lat)
  const lng = finiteCoordinate(draft.lng)
  return {
    id: createReportId(now),
    kind: draft.kind,
    place,
    networkId: draft.networkId ?? null,
    comment: cleanText(draft.comment, MAX_COMMENT_LENGTH),
    // Une position n'est conservée que si les deux composantes sont exploitables.
    lat: lat !== null && lng !== null ? lat : null,
    lng: lat !== null && lng !== null ? lng : null,
    createdAt,
    expiresAt: new Date(now + STREET_REPORT_TTL_MINUTES * 60_000).toISOString(),
    source: 'COMMUNITY',
  }
}

export function isReportExpired(report: StreetReport, now = Date.now()): boolean {
  const expiresAt = Date.parse(report.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

/** Valide un objet inconnu (stockage local) sans rien inventer en cas de doute. */
export function parseStreetReport(value: unknown): StreetReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null
  if (!isKind(raw.kind)) return null
  const place = cleanText(raw.place, MAX_PLACE_LENGTH)
  if (!place) return null
  if (!isIsoInstant(raw.createdAt) || !isIsoInstant(raw.expiresAt)) return null
  const lat = finiteCoordinate(raw.lat)
  const lng = finiteCoordinate(raw.lng)
  return {
    id: raw.id,
    kind: raw.kind,
    place,
    networkId: isNetworkId(raw.networkId) ? raw.networkId : null,
    comment: cleanText(raw.comment, MAX_COMMENT_LENGTH),
    // Une position n'est conservée que si les deux composantes sont exploitables.
    lat: lat !== null && lng !== null ? lat : null,
    lng: lat !== null && lng !== null ? lng : null,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
    source: 'COMMUNITY',
  }
}

/**
 * Filtre, valide et trie une liste lue depuis le stockage : aucun signalement
 * invalide ou périmé ne remonte à l'écran.
 */
export function parseStreetReports(raw: unknown, now = Date.now()): StreetReport[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const reports: StreetReport[] = []
  for (const item of raw) {
    const report = parseStreetReport(item)
    if (!report || seen.has(report.id) || isReportExpired(report, now)) continue
    seen.add(report.id)
    reports.push(report)
  }
  return sortStreetReports(reports)
}

/** Les plus récents d'abord : un signalement de terrain se périme vite. */
export function sortStreetReports(reports: readonly StreetReport[]): StreetReport[] {
  return [...reports].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function readStreetReports(storage: Storage | null, now = Date.now()): StreetReport[] {
  if (!storage) return []
  try {
    const stored = storage.getItem(STREET_REPORT_STORAGE_KEY)
    if (!stored) return []
    return parseStreetReports(JSON.parse(stored) as unknown, now)
  } catch {
    return []
  }
}

export function writeStreetReports(storage: Storage | null, reports: readonly StreetReport[], now = Date.now()): void {
  if (!storage) return
  try {
    const kept = sortStreetReports(reports.filter((report) => !isReportExpired(report, now))).slice(0, MAX_STORED_REPORTS)
    storage.setItem(STREET_REPORT_STORAGE_KEY, JSON.stringify(kept))
  } catch {
    // Le stockage peut être plein ou refusé : les signalements restent
    // utilisables pour la session en cours, sans être persistés.
  }
}

export function removeStreetReport(reports: readonly StreetReport[], id: string): StreetReport[] {
  return reports.filter((report) => report.id !== id)
}

/** « à l'instant », « il y a 12 min », « il y a 1 h 05 » : l'âge, pas une prédiction. */
export function formatReportAge(createdAt: string, now = Date.now()): string {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return 'horodatage illisible'
  const elapsed = now - created
  if (elapsed < 60_000) return 'à l’instant'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `il y a ${hours} h` : `il y a ${hours} h ${String(rest).padStart(2, '0')}`
}
