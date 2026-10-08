import { describe, expect, it } from 'vitest'
import { canDisplayLive, canPublishAsActive, formatScheduledCountdown, statusLabel } from './truth'

const now = Date.parse('2026-10-08T12:00:00.000Z')

describe('formatScheduledCountdown', () => {
  it('keeps a two-minute scheduled departure at two minutes', () => {
    expect(formatScheduledCountdown('2026-10-08T12:02:00.000Z', now)).toBe('2 min')
  })

  it('never rounds a forthcoming passage down to zero', () => {
    expect(formatScheduledCountdown('2026-10-08T12:00:01.000Z', now)).toBe('1 min')
  })

  it('labels an exact scheduled time without claiming real-time arrival', () => {
    expect(formatScheduledCountdown('2026-10-08T12:00:00.000Z', now)).toBe('Prévu maintenant')
  })

  it('does not keep an old scheduled time looking upcoming', () => {
    expect(formatScheduledCountdown('2026-10-08T11:59:00.000Z', now)).toBe('Horaire dépassé')
  })

  it('does not fabricate a value for invalid timestamps', () => {
    expect(formatScheduledCountdown('not-a-date', now)).toBe('Horaire indisponible')
  })
})

describe('real-time labelling', () => {
  it('requires an explicitly real-time source', () => {
    expect(canDisplayLive({ sourceType: 'GTFS', verifiedAt: '2026-10-08T11:59:00.000Z', maxAgeMs: 60_000 }, now)).toBe(false)
  })

  it('accepts a fresh, verified GTFS-RT source', () => {
    expect(canDisplayLive({ sourceType: 'GTFS_REALTIME', verifiedAt: '2026-10-08T11:59:30.000Z', maxAgeMs: 60_000 }, now)).toBe(true)
  })

  it('rejects stale or future-dated real-time evidence', () => {
    expect(canDisplayLive({ sourceType: 'OFFICIAL_REALTIME', verifiedAt: '2026-10-08T11:57:00.000Z', maxAgeMs: 60_000 }, now)).toBe(false)
    expect(canDisplayLive({ sourceType: 'GTFS_REALTIME', verifiedAt: '2026-10-08T12:01:00.000Z', maxAgeMs: 60_000 }, now)).toBe(false)
  })

  it('uses clear status labels', () => {
    expect(statusLabel('SCHEDULED')).toBe('Horaire théorique')
    expect(statusLabel('UNKNOWN')).toBe('Horaire indisponible')
  })
})

describe('active network publication guard', () => {
  const validRecord = {
    source: 'Opérateur officiel',
    sourceType: 'GTFS' as const,
    verifiedAt: '2026-10-08T11:00:00.000Z',
    validUntil: '2026-10-09T00:00:00.000Z',
    datasetVersion: '2026-10-08.1',
    status: 'ACTIVE' as const,
  }

  it('allows records with traceable, non-unknown provenance and current validity', () => {
    expect(canPublishAsActive(validRecord, now)).toBe(true)
  })

  it('rejects records without a source, a version, valid dates, or active status', () => {
    expect(canPublishAsActive({ ...validRecord, source: null }, now)).toBe(false)
    expect(canPublishAsActive({ ...validRecord, datasetVersion: null }, now)).toBe(false)
    expect(canPublishAsActive({ ...validRecord, validUntil: null }, now)).toBe(false)
    expect(canPublishAsActive({ ...validRecord, status: 'PLANNED' }, now)).toBe(false)
  })

  it('does not treat stale data, OSM geometry or estimates as an active service', () => {
    expect(canPublishAsActive({ ...validRecord, validUntil: '2026-10-08T11:59:59.000Z' }, now)).toBe(false)
    expect(canPublishAsActive({ ...validRecord, sourceType: 'OSM' }, now)).toBe(false)
    expect(canPublishAsActive({ ...validRecord, sourceType: 'ESTIMATED' }, now)).toBe(false)
  })
})
