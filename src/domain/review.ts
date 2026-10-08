/**
 * Governance view model for the read-only admin API.
 *
 * The API is the only source of truth here: when it is unreachable or returns
 * an unexpected shape, the console says so instead of inventing datasets,
 * reviewers, or approval dates.
 */

export type ReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'UNKNOWN'
export type LedgerIntegrity = 'OK' | 'EMPTY' | 'INVALID' | 'UNKNOWN'
export type DatasetIntegrity = 'OK' | 'INVALID' | 'UNKNOWN'

export interface CatalogDataset {
  datasetId: string
  integrity: DatasetIntegrity
  validityStatus: string
  reviewStatus: ReviewStatus
  ledgerIntegrity: LedgerIntegrity
  operator: string | null
  datasetVersion: string | null
  source: string | null
  sourceType: string | null
  serviceStatus: string | null
  reviewerId: string | null
  reviewedAt: string | null
  publicationStatus: string
}

export interface PipelineStage {
  id: string
  label: string
  count: number
  note: string
}

export interface PipelineSummary {
  generatedAt: string
  stages: PipelineStage[]
  dataPolicy: string
  publicationStatus: string
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

const REVIEW_STATUSES: readonly ReviewStatus[] = ['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'UNKNOWN']
const LEDGER_INTEGRITIES: readonly LedgerIntegrity[] = ['OK', 'EMPTY', 'INVALID', 'UNKNOWN']

/** Stages every dataset must cross. Publication is not implemented yet. */
export const GOVERNANCE_STAGES: readonly { id: string; label: string; requirement: string; implemented: boolean }[] = [
  {
    id: 'staging',
    label: 'Staging',
    requirement: 'Archive validée, empreinte SHA-256, provenance déclarée par l’importateur.',
    implemented: true,
  },
  {
    id: 'review',
    label: 'Revue humaine',
    requirement: 'Cinq attestations obligatoires signées par un relecteur nominatif.',
    implemented: true,
  },
  {
    id: 'approval',
    label: 'Approbation traçable',
    requirement: 'Décision enregistrée dans un journal append-only chaîné par empreintes.',
    implemented: true,
  },
  {
    id: 'publication',
    label: 'Publication',
    requirement: 'Étape séparée, réversible et non implémentée : rien n’atteint la carte publique.',
    implemented: false,
  },
]

export const REQUIRED_ATTESTATIONS: readonly { id: string; label: string }[] = [
  { id: 'source_identity', label: 'Identité de la source et URL vérifiées auprès de l’éditeur' },
  { id: 'reuse_rights', label: 'Droit de réutilisation confirmé (licence et conditions d’usage)' },
  { id: 'operator_confirmed', label: 'Opérateur confirmé, réseaux distincts non confondus' },
  { id: 'service_operational', label: 'Service réellement exploité aux dates déclarées' },
  { id: 'freshness_confirmed', label: 'Fraîcheur et période de validité confirmées avec la source' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseDataset(raw: unknown): CatalogDataset | null {
  if (!isRecord(raw)) return null
  const datasetId = requiredString(raw.dataset_id)
  if (!datasetId) return null

  const reviewStatus = typeof raw.review_status === 'string' && (REVIEW_STATUSES as readonly string[]).includes(raw.review_status)
    ? (raw.review_status as ReviewStatus)
    : 'UNKNOWN'
  const ledgerIntegrity = typeof raw.ledger_integrity === 'string' && (LEDGER_INTEGRITIES as readonly string[]).includes(raw.ledger_integrity)
    ? (raw.ledger_integrity as LedgerIntegrity)
    : 'UNKNOWN'
  const integrity: DatasetIntegrity = raw.integrity === 'OK' ? 'OK' : raw.integrity === 'INVALID' ? 'INVALID' : 'UNKNOWN'

  return {
    datasetId,
    integrity,
    validityStatus: optionalString(raw.effective_validity_status) ?? 'UNKNOWN',
    reviewStatus,
    ledgerIntegrity,
    operator: optionalString(raw.operator),
    datasetVersion: optionalString(raw.dataset_version),
    source: optionalString(raw.source),
    sourceType: optionalString(raw.source_type),
    serviceStatus: optionalString(raw.service_status),
    reviewerId: optionalString(raw.reviewer_id),
    reviewedAt: optionalString(raw.reviewed_at),
    publicationStatus: optionalString(raw.publication_status) ?? 'NOT_PUBLISHED',
  }
}

/** Accept only a payload shaped like the catalog API output. */
export function parseCatalogPayload(payload: unknown): ParseResult<CatalogDataset[]> {
  if (!isRecord(payload) || !Array.isArray(payload.datasets)) {
    return { ok: false, reason: 'Réponse du catalogue illisible.' }
  }
  const datasets: CatalogDataset[] = []
  for (const raw of payload.datasets) {
    const dataset = parseDataset(raw)
    if (!dataset) return { ok: false, reason: 'Une entrée du catalogue est incomplète.' }
    datasets.push(dataset)
  }
  return { ok: true, value: datasets }
}

export function parsePipelinePayload(payload: unknown): ParseResult<PipelineSummary> {
  if (!isRecord(payload) || !Array.isArray(payload.stages)) {
    return { ok: false, reason: 'Réponse du pipeline illisible.' }
  }
  const stages: PipelineStage[] = []
  for (const raw of payload.stages) {
    if (!isRecord(raw)) return { ok: false, reason: 'Une étape du pipeline est illisible.' }
    const id = requiredString(raw.id)
    const label = requiredString(raw.label)
    if (!id || !label || typeof raw.count !== 'number' || !Number.isFinite(raw.count)) {
      return { ok: false, reason: 'Une étape du pipeline est incomplète.' }
    }
    stages.push({ id, label, count: raw.count, note: optionalString(raw.note) ?? '' })
  }
  const generatedAt = optionalString(payload.generated_at)
  if (!generatedAt) return { ok: false, reason: 'Horodatage du pipeline absent.' }
  return {
    ok: true,
    value: {
      generatedAt,
      stages,
      dataPolicy: optionalString(payload.data_policy) ?? 'Lecture seule.',
      publicationStatus: optionalString(payload.publication_status) ?? 'NOT_PUBLISHED',
    },
  }
}

export interface CatalogSummary {
  total: number
  pendingReview: number
  approved: number
  rejected: number
  integrityInvalid: number
  published: number
}

export function summarizeCatalog(datasets: readonly CatalogDataset[]): CatalogSummary {
  return datasets.reduce<CatalogSummary>(
    (summary, dataset) => ({
      total: summary.total + 1,
      pendingReview: summary.pendingReview + (dataset.reviewStatus === 'PENDING_REVIEW' ? 1 : 0),
      approved: summary.approved + (dataset.reviewStatus === 'APPROVED' ? 1 : 0),
      rejected: summary.rejected + (dataset.reviewStatus === 'REJECTED' ? 1 : 0),
      integrityInvalid: summary.integrityInvalid + (dataset.integrity === 'INVALID' || dataset.ledgerIntegrity === 'INVALID' ? 1 : 0),
      published: summary.published + (dataset.publicationStatus === 'PUBLISHED' ? 1 : 0),
    }),
    { total: 0, pendingReview: 0, approved: 0, rejected: 0, integrityInvalid: 0, published: 0 },
  )
}

export function reviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'Approuvé'
    case 'REJECTED':
      return 'Refusé'
    case 'PENDING_REVIEW':
      return 'En revue'
    case 'UNKNOWN':
      return 'État inconnu'
  }
}

export function validityStatusLabel(status: string): string {
  switch (status) {
    case 'CURRENT':
      return 'Validité en cours'
    case 'STALE':
      return 'Validité dépassée'
    case 'NOT_YET_VALID':
      return 'Pas encore valide'
    default:
      return 'Validité inconnue'
  }
}

export function integrityLabel(dataset: Pick<CatalogDataset, 'integrity' | 'ledgerIntegrity'>): string {
  if (dataset.integrity === 'INVALID') return 'Archive altérée'
  if (dataset.ledgerIntegrity === 'INVALID') return 'Journal de revue corrompu'
  if (dataset.integrity === 'UNKNOWN') return 'Intégrité inconnue'
  return 'Intégrité vérifiée'
}

export function formatTimestamp(value: string | null): string {
  if (!value) return 'non daté'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return 'horodatage illisible'
  return new Date(parsed).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}
