import type { FrequencyStatus } from './frequencies'

export type TransportStatus = FrequencyStatus
export type ProvenanceType = 'OFFICIAL' | 'GTFS' | 'GTFS_REALTIME' | 'OFFICIAL_REALTIME' | 'OSM' | 'COMMUNITY' | 'ESTIMATED' | 'UNKNOWN'

export interface RealtimeEvidence {
  sourceType: ProvenanceType
  verifiedAt: string | null
  maxAgeMs: number
}

const MINUTE_MS = 60_000

/** Return only positive, rounded-up minutes for a real scheduled timestamp. */
export function getRemainingMinutes(nextDepartureAt: string, now = Date.now()): number | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(nextDepartureAt.trim())) return null
  const departureAt = Date.parse(nextDepartureAt)
  if (!Number.isFinite(departureAt) || departureAt <= now) return null
  return Math.ceil((departureAt - now) / MINUTE_MS)
}

/** A LIVE label requires an explicitly real-time, verified, fresh source. */
export function canDisplayLive(evidence: RealtimeEvidence, now = Date.now()): boolean {
  if (evidence.sourceType !== 'GTFS_REALTIME' && evidence.sourceType !== 'OFFICIAL_REALTIME') return false
  if (!evidence.verifiedAt) return false

  const verifiedAt = Date.parse(evidence.verifiedAt)
  if (!Number.isFinite(verifiedAt) || verifiedAt > now) return false
  return now - verifiedAt <= evidence.maxAgeMs
}

/**
 * Present a theoretical timestamp without implying vehicle presence.
 * Positive countdowns are rounded up so a forthcoming passage never appears
 * as 0 min. An elapsed or exact-time departure is expired, not "now".
 */
export function formatScheduledCountdown(timestamp: string, now = Date.now()): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp.trim()) || !Number.isFinite(Date.parse(timestamp))) {
    return 'Horaire indisponible'
  }
  const minutes = getRemainingMinutes(timestamp, now)
  return minutes === null ? 'Horaire dépassé' : `${minutes} min`
}

export function statusLabel(status: TransportStatus): string {
  switch (status) {
    case 'OFFICIAL_REFERENCE':
      return 'Fréquence officielle de référence'
    case 'REAL_TIME':
      return 'Temps réel'
    case 'ESTIMATED':
      return 'Estimé'
    case 'SCHEDULED':
      return 'Horaire théorique'
    case 'UNKNOWN':
      return 'Horaire indisponible'
  }
}

export interface PublishableRecord {
  source: string | null
  sourceType: ProvenanceType
  verifiedAt: string | null
  validUntil: string | null
  datasetVersion: string | null
  status: 'ACTIVE' | 'PLANNED' | 'SUSPENDED' | 'UNKNOWN'
}

/** Gate for transport objects shown as active in the public map. */
export function canPublishAsActive(record: PublishableRecord, now = Date.now()): boolean {
  if (!record.source?.trim() || !record.verifiedAt || !record.validUntil || !record.datasetVersion?.trim()) return false
  if (record.status !== 'ACTIVE') return false
  if (record.sourceType === 'UNKNOWN' || record.sourceType === 'ESTIMATED' || record.sourceType === 'COMMUNITY' || record.sourceType === 'OSM') return false

  const verifiedAt = Date.parse(record.verifiedAt)
  const validUntil = Date.parse(record.validUntil)
  return Number.isFinite(verifiedAt) && Number.isFinite(validUntil) && verifiedAt <= now && now < validUntil
}
