import { describe, expect, it } from 'vitest'
import { canDisplayLive, canPublishAsActive, formatScheduledCountdown, getRemainingMinutes, statusLabel } from './truth'

const now = Date.parse('2026-10-08T12:00:00.000Z')

describe('formatScheduledCountdown', () => {
  it('keeps a two-minute scheduled departure at two minutes', () => {
    expect(formatScheduledCountdown('2026-10-08T12:02:00.000Z', now)).toBe('2 min')
  })

  it('never rounds a forthcoming passage down to zero', () => {
    expect(formatScheduledCountdown('2026-10-08T12:00:01.000Z', now)).toBe('1 min')
  })

  it('treats an exact scheduled time as expired rather than showing zero or less than a minute', () => {
    expect(formatScheduledCountdown('2026-10-08T12:00:00.000Z', now)).toBe('Horaire dépassé')
    expect(formatScheduledCountdown('2026-10-08T12:00:00.000Z', now)).not.toMatch(/0 min|moins d’une minute/i)
  })

  it('does not keep an old scheduled time looking upcoming', () => {
    expect(formatScheduledCountdown('2026-10-08T11:59:00.000Z', now)).toBe('Horaire dépassé')
  })

  it('does not fabricate a value for invalid or timezone-free timestamps', () => {
    expect(formatScheduledCountdown('not-a-date', now)).toBe('Horaire indisponible')
    expect(formatScheduledCountdown('2026-10-08T12:02:00', now)).toBe('Horaire indisponible')
  })
})

describe('getRemainingMinutes', () => {
  const departure = '2026-10-08T18:06:00.000Z'
  const at = (time: string) => Date.parse(`2026-10-08T${time}.000Z`)

  it('counts down a scheduled departure from six minutes through one, never zero', () => {
    expect(getRemainingMinutes(departure, at('18:00:00'))).toBe(6)
    expect(getRemainingMinutes(departure, at('18:01:01'))).toBe(5)
    expect(getRemainingMinutes(departure, at('18:02:01'))).toBe(4)
    expect(getRemainingMinutes(departure, at('18:03:10'))).toBe(3)
    expect(getRemainingMinutes(departure, at('18:04:01'))).toBe(2)
    expect(getRemainingMinutes(departure, at('18:05:30'))).toBe(1)
  })

  it('normalizes timestamps with an explicit numeric UTC offset', () => {
    const localTimestamp = '2026-10-08T19:06:00.000+01:00'
    expect(getRemainingMinutes(localTimestamp, at('18:00:00'))).toBe(6)
    expect(formatScheduledCountdown(localTimestamp, at('18:05:30'))).toBe('1 min')
  })

  it('returns no countdown at or after departure and for invalid timestamps', () => {
    expect(getRemainingMinutes(departure, at('18:06:00'))).toBeNull()
    expect(getRemainingMinutes(departure, at('18:06:01'))).toBeNull()
    expect(getRemainingMinutes('not-a-date', now)).toBeNull()
    expect(getRemainingMinutes('2026-10-08T18:06:00', now)).toBeNull()
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

  it('uses distinct, clear status labels for references, schedules, estimates and live data', () => {
    expect(statusLabel('OFFICIAL_REFERENCE')).toBe('Fréquence officielle de référence')
    expect(statusLabel('SCHEDULED')).toBe('Horaire théorique')
    expect(statusLabel('ESTIMATED')).toBe('Estimé')
    expect(statusLabel('REAL_TIME')).toBe('Temps réel')
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
