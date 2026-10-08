import { describe, expect, it } from 'vitest'
import {
  GOVERNANCE_STAGES,
  REQUIRED_ATTESTATIONS,
  formatTimestamp,
  integrityLabel,
  parseCatalogPayload,
  parsePipelinePayload,
  reviewStatusLabel,
  summarizeCatalog,
  validityStatusLabel,
  type CatalogDataset,
} from './review'

const dataset = (overrides: Partial<CatalogDataset> = {}): CatalogDataset => ({
  datasetId: 'test-operator-v1-abc123def456',
  integrity: 'OK',
  validityStatus: 'CURRENT',
  reviewStatus: 'PENDING_REVIEW',
  ledgerIntegrity: 'OK',
  operator: 'Test operator',
  datasetVersion: 'v1',
  source: 'Test source',
  sourceType: 'OFFICIAL',
  serviceStatus: 'ACTIVE',
  reviewerId: null,
  reviewedAt: null,
  reviewEntryId: null,
  publicationStatus: 'NOT_PUBLISHED',
  publicationSnapshotId: null,
  ...overrides,
})

describe('catalog payload parsing', () => {
  it('accepts the shape produced by the read-only admin API', () => {
    const parsed = parseCatalogPayload({
      datasets: [
        {
          dataset_id: 'ddd-2026-10-abcdef123456',
          integrity: 'OK',
          effective_validity_status: 'CURRENT',
          review_status: 'APPROVED',
          ledger_integrity: 'OK',
          operator: 'Dakar Dem Dikk',
          dataset_version: '2026-10',
          source: 'Open data publisher',
          source_type: 'OFFICIAL',
          service_status: 'ACTIVE',
          reviewer_id: 'fatou.ndiaye',
          reviewed_at: '2026-10-08T11:30:00+00:00',
          review_entry_id: 'rv-000004',
          publication_status: 'PUBLISHED',
          publication_snapshot_id: 'snap-20261008t113000z-dakar-dem-dikk',
        },
      ],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toHaveLength(1)
    expect(parsed.value[0].reviewStatus).toBe('APPROVED')
    expect(parsed.value[0].reviewerId).toBe('fatou.ndiaye')
    expect(parsed.value[0].publicationStatus).toBe('PUBLISHED')
    // The console can only revert what it can identify: the active decision and the snapshot.
    expect(parsed.value[0].reviewEntryId).toBe('rv-000004')
    expect(parsed.value[0].publicationSnapshotId).toBe('snap-20261008t113000z-dakar-dem-dikk')
  })

  it('refuses payloads that are missing entries instead of guessing', () => {
    expect(parseCatalogPayload(null).ok).toBe(false)
    expect(parseCatalogPayload({ datasets: 'not-a-list' }).ok).toBe(false)
    expect(parseCatalogPayload({ datasets: [{}] }).ok).toBe(false)
    expect(parseCatalogPayload({ datasets: [{ dataset_id: '' }] }).ok).toBe(false)
  })

  it('downgrades unknown review states to UNKNOWN rather than inventing one', () => {
    const parsed = parseCatalogPayload({
      datasets: [{ dataset_id: 'abc-123', review_status: 'PUBLISHED', ledger_integrity: 'MAYBE' }],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value[0].reviewStatus).toBe('UNKNOWN')
    expect(parsed.value[0].ledgerIntegrity).toBe('UNKNOWN')
  })
})

describe('pipeline payload parsing', () => {
  it('reads stage counts and keeps the publication stage at zero', () => {
    const parsed = parsePipelinePayload({
      generated_at: '2026-10-08T12:00:00+00:00',
      counts: { staged: 2, published: 0 },
      stages: [
        { id: 'staged', label: 'Staging', count: 2, note: 'n' },
        { id: 'published', label: 'Publié', count: 0, note: 'n' },
      ],
      data_policy: 'Lecture seule.',
      publication_status: 'NOT_PUBLISHED',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.stages).toHaveLength(2)
    expect(parsed.value.publicationStatus).toBe('NOT_PUBLISHED')
  })

  it('rejects a stage without a numeric count', () => {
    const parsed = parsePipelinePayload({
      generated_at: '2026-10-08T12:00:00+00:00',
      stages: [{ id: 'staged', label: 'Staging', count: 'deux' }],
    })
    expect(parsed.ok).toBe(false)
  })
})

describe('catalog summary and labels', () => {
  it('counts review states and never reports a published dataset', () => {
    const summary = summarizeCatalog([
      dataset({ reviewStatus: 'PENDING_REVIEW' }),
      dataset({ datasetId: 'b', reviewStatus: 'APPROVED' }),
      dataset({ datasetId: 'c', reviewStatus: 'REJECTED' }),
      dataset({ datasetId: 'd', integrity: 'INVALID' }),
    ])
    // The fourth dataset is integrity-invalid but still awaiting a decision.
    expect(summary).toMatchObject({ total: 4, pendingReview: 2, approved: 1, rejected: 1, integrityInvalid: 1, published: 0 })
  })

  it('describes review, validity and integrity states in French', () => {
    expect(reviewStatusLabel('APPROVED')).toBe('Approuvé')
    expect(reviewStatusLabel('UNKNOWN')).toBe('État inconnu')
    expect(validityStatusLabel('STALE')).toBe('Validité dépassée')
    expect(validityStatusLabel('NOPE')).toBe('Validité inconnue')
    expect(integrityLabel({ integrity: 'OK', ledgerIntegrity: 'INVALID' })).toBe('Journal de revue corrompu')
    expect(integrityLabel({ integrity: 'INVALID', ledgerIntegrity: 'OK' })).toBe('Archive altérée')
  })

  it('formats timestamps without pretending a missing date exists', () => {
    expect(formatTimestamp(null)).toBe('non daté')
    expect(formatTimestamp('not-a-date')).toBe('horodatage illisible')
    expect(formatTimestamp('2026-10-08T11:30:00Z')).toBe('2026-10-08 11:30 UTC')
  })

  it('lists publication as an implemented stage and five mandatory attestations', () => {
    const publication = GOVERNANCE_STAGES.find((stage) => stage.id === 'publication')
    expect(publication?.implemented).toBe(true)
    expect(publication?.requirement).toContain('Snapshot daté et haché')
    expect(REQUIRED_ATTESTATIONS).toHaveLength(5)
  })
})
