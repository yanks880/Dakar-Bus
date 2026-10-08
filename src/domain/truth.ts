export type TransportStatus = 'SCHEDULED' | 'ESTIMATED' | 'REAL_TIME' | 'UNKNOWN'
export type ProvenanceType = 'OFFICIAL' | 'GTFS' | 'GTFS_REALTIME' | 'OFFICIAL_REALTIME' | 'OSM' | 'COMMUNITY' | 'ESTIMATED' | 'UNKNOWN'

export interface RealtimeEvidence {
  sourceType: ProvenanceType
  verifiedAt: string | null
  maxAgeMs: number
}

const MINUTE_MS = 60_000

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
 * as 0 min. Past schedule events are explicitly called out instead.
 */
export function formatScheduledCountdown(timestamp: string, now = Date.now()): string {
  const departure = Date.parse(timestamp)
  if (!Number.isFinite(departure)) return 'Horaire indisponible'

  const remaining = departure - now
  if (remaining < 0) return 'Horaire dépassé'
  if (remaining === 0) return 'Prévu maintenant'

  const minutes = Math.ceil(remaining / MINUTE_MS)
  return `${minutes} min`
}

export function statusLabel(status: TransportStatus): string {
  switch (status) {
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
