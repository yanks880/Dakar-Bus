/**
 * Console session and decision client.
 *
 * The console never decides anything on its own: every action is a POST to the
 * local API, authenticated with the session cookie and the CSRF token issued at
 * login. Refusals keep their server code, message and blockers — the interface
 * repeats what the server said rather than inventing a friendlier story.
 */

import { API_TIMEOUT_MS } from './http'
import { REQUIRED_ATTESTATIONS } from './review'

export type Role = 'reviewer' | 'publisher'

export const ROLE_LABELS: Record<Role, string> = {
  reviewer: 'relecteur',
  publisher: 'publieur',
}

export interface Actor {
  actorId: string
  displayName: string | null
  role: Role
}

export interface SessionState {
  authenticated: boolean
  actor: Actor | null
  csrfToken: string | null
  expiresAt: string | null
}

export interface ApiRefusal {
  ok: false
  status: number
  code: string
  message: string
  blockers: string[]
}

export type ApiOutcome<T> = { ok: true; value: T } | ApiRefusal

export interface DecisionOutcome {
  action: 'APPROVE' | 'REJECT' | 'REVERT_DECISION' | 'PUBLISH' | 'REVERT_PUBLICATION'
  datasetId: string | null
  reviewStatus: string | null
  publicationStatus: string | null
  entryId: string | null
  entryHash: string | null
  actorId: string | null
  method: string | null
  recordedAt: string | null
}

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/

/** Refusals the server can send back, worded for the person reading them. */
export function sessionErrorMessage(code: string): string {
  switch (code) {
    case 'AUTHENTICATION_REQUIRED':
      return 'Aucune session active : connectez-vous avec un compte local, ou passez par le jeton du CLI.'
    case 'AUTHENTICATION_FAILED':
      return 'Identifiant ou secret incorrect. Le registre ne révèle pas lequel des deux.'
    case 'ACTOR_REVOKED':
      return 'Ce compte a été révoqué : ses décisions ne valent plus. Créez un compte de remplacement.'
    case 'ROLE_FORBIDDEN':
      return 'Votre rôle ne permet pas cette action : la séparation des devoirs est appliquée par le serveur.'
    case 'CSRF_REQUIRED':
    case 'CSRF_INVALID':
      return 'Écriture refusée : le jeton CSRF de la session est absent ou invalide. Reconnectez-vous.'
    case 'CROSS_ORIGIN_REFUSED':
      return 'Écriture refusée : la requête ne vient pas de cette console.'
    case 'TOO_MANY_ATTEMPTS':
      return 'Trop de tentatives pour ce compte : patientez quelques minutes avant de réessayer.'
    case 'APPROVAL_BLOCKED':
      return 'Approbation refusée : des vérifications obligatoires manquent. Le détail suit.'
    case 'SEPARATION_OF_DUTIES':
      return 'La personne qui a approuvé une version ne peut pas la publier elle-même.'
    case 'ALREADY_REJECTED':
    case 'APPROVAL_ALREADY_RECORDED':
      return 'Une décision est déjà active sur cette version : annulez-la d’abord, la trace reste.'
    case 'REVERT_TARGET_MISMATCH':
    case 'NO_ACTIVE_DECISION':
      return 'Seule la dernière décision active peut être annulée ; le journal reste inchangé.'
    case 'DATASET_NOT_PUBLISHABLE':
      return 'Cette version n’est pas publiable en l’état : le détail des bloqueurs suit.'
    case 'DATASET_INTEGRITY_INVALID':
      return 'Cette version n’est pas intacte : aucune décision n’est enregistrée dessus.'
    case 'NOT_PUBLISHED':
      return 'Aucune publication active : il n’y a rien à annuler.'
    case 'INVALID_REQUEST':
      return 'Demande incomplète ou mal formée : vérifiez les champs saisis.'
    case 'REQUEST_TOO_LARGE':
      return 'Requête trop volumineuse pour cette API.'
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'Cette API attend un corps JSON.'
    case 'LEDGER_LOCKED':
      return 'Un autre poste écrit dans le journal : réessayez dans un instant.'
    case 'NOT_FOUND':
      return 'Cette version est inconnue du catalogue local.'
    case 'NETWORK':
      return 'L’API locale ne répond pas sur /api. Démarrez-la avec « npm run admin:api ».'
    default:
      return 'Le serveur a refusé l’écriture ; le détail ci-dessus vient de lui, sans interprétation.'
  }
}

async function readRefusal(response: Response): Promise<ApiRefusal> {
  let code = 'UNKNOWN'
  let message = ''
  let blockers: string[] = []
  try {
    const body: unknown = await response.json()
    if (isRecord(body)) {
      if (typeof body.error === 'string' && body.error) code = body.error
      if (typeof body.message === 'string' && body.message) message = body.message
      if (Array.isArray(body.blockers)) {
        blockers = body.blockers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      }
    }
  } catch {
    code = 'UNREADABLE_REFUSAL'
    message = `Le serveur a répondu ${response.status} sans corps lisible : aucun état n’est supposé.`
  }
  return { ok: false, status: response.status, code, message: message || sessionErrorMessage(code), blockers }
}

function networkRefusal(): ApiRefusal {
  return { ok: false, status: 0, code: 'NETWORK', message: sessionErrorMessage('NETWORK'), blockers: [] }
}

async function requestJson(
  fetcher: Fetcher,
  path: string,
  init: RequestInit,
): Promise<ApiOutcome<unknown>> {
  // Une lecture bloquée ne fige pas la console. Une écriture (décision, publication)
  // n’est jamais annulée côté client : le serveur peut l’avoir déjà enregistrée.
  const isRead = !init.method || init.method === 'GET'
  const controller = isRead ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), API_TIMEOUT_MS) : null
  try {
    const response = await fetcher(path, {
      credentials: 'same-origin',
      ...init,
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!response.ok) return readRefusal(response)
    try {
      return { ok: true, value: await response.json() }
    } catch {
      return {
        ok: false,
        status: response.status,
        code: 'UNREADABLE_PAYLOAD',
        message: 'Le serveur a répondu autre chose que du JSON : aucune décision n’est affichée.',
        blockers: [],
      }
    }
  } catch {
    return networkRefusal()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseActor(raw: unknown): Actor | null {
  if (!isRecord(raw)) return null
  const actorId = optionalString(raw.actor_id)
  const role = raw.role === 'reviewer' || raw.role === 'publisher' ? raw.role : null
  if (!actorId || !role) return null
  return { actorId, displayName: optionalString(raw.display_name), role }
}

/** Accept only a payload shaped like `GET|POST /api/session`. */
export function parseSessionPayload(payload: unknown): ApiOutcome<SessionState> {
  if (!isRecord(payload) || typeof payload.authenticated !== 'boolean') {
    return { ok: false, status: 200, code: 'UNREADABLE_PAYLOAD', message: 'Réponse de session illisible.', blockers: [] }
  }
  const actor = payload.authenticated ? parseActor(payload.actor) : null
  if (payload.authenticated && !actor) {
    return {
      ok: false,
      status: 200,
      code: 'UNREADABLE_PAYLOAD',
      message: 'La session ne nomme aucun acteur : aucune identité n’est affichée.',
      blockers: [],
    }
  }
  return {
    ok: true,
    value: {
      authenticated: Boolean(actor),
      actor,
      csrfToken: payload.authenticated ? optionalString(payload.csrf_token) : null,
      expiresAt: payload.authenticated ? optionalString(payload.expires_at) : null,
    },
  }
}

export async function readSession(fetcher: Fetcher = fetch): Promise<ApiOutcome<SessionState>> {
  const outcome = await requestJson(fetcher, '/api/session', { headers: { Accept: 'application/json' } })
  return outcome.ok ? parseSessionPayload(outcome.value) : outcome
}

export async function login(
  actorId: string,
  secret: string,
  fetcher: Fetcher = fetch,
): Promise<ApiOutcome<SessionState>> {
  const outcome = await requestJson(fetcher, '/api/session', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor_id: actorId, secret }),
  })
  return outcome.ok ? parseSessionPayload(outcome.value) : outcome
}

export async function logout(
  state: SessionState,
  fetcher: Fetcher = fetch,
): Promise<ApiOutcome<SessionState>> {
  const outcome = await requestJson(fetcher, '/api/session', {
    method: 'DELETE',
    headers: { Accept: 'application/json', ...csrfHeader(state) },
  })
  if (!outcome.ok) return outcome
  return { ok: true, value: { authenticated: false, actor: null, csrfToken: null, expiresAt: null } }
}

function csrfHeader(state: SessionState): Record<string, string> {
  return state.csrfToken ? { 'X-Dakar-CSRF': state.csrfToken } : {}
}

export interface AttestationInput {
  evidence: string
  reference: string | null
}

export function emptyAttestations(): Record<string, AttestationInput> {
  return Object.fromEntries(REQUIRED_ATTESTATIONS.map((item) => [item.id, { evidence: '', reference: null }]))
}

export function missingAttestations(attestations: Record<string, AttestationInput>): string[] {
  return REQUIRED_ATTESTATIONS.filter((item) => !(attestations[item.id]?.evidence ?? '').trim()).map((item) => item.id)
}

export function parseDecisionPayload(action: DecisionOutcome['action'], payload: unknown): ApiOutcome<DecisionOutcome> {
  if (!isRecord(payload)) {
    return { ok: false, status: 200, code: 'UNREADABLE_PAYLOAD', message: 'Réponse de décision illisible.', blockers: [] }
  }
  const entry = isRecord(payload.entry) ? payload.entry : isRecord(payload.journal_entry) ? payload.journal_entry : null
  const authentication = isRecord(payload.authentication)
    ? payload.authentication
    : entry && isRecord(entry.authentication)
      ? entry.authentication
      : null
  const entryId = optionalString(payload.entry_id) ?? (entry ? optionalString(entry.entry_id) : null)
  const entryHash = optionalString(payload.entry_hash) ?? (entry ? optionalString(entry.entry_hash) : null)
  return {
    ok: true,
    value: {
      action,
      datasetId: optionalString(payload.dataset_id),
      reviewStatus: optionalString(payload.review_status),
      publicationStatus: optionalString(payload.publication_status),
      entryId,
      entryHash,
      actorId: authentication ? optionalString(authentication.actor_id) : null,
      method: authentication ? optionalString(authentication.method) : null,
      recordedAt: optionalString(payload.reviewed_at) ?? (entry ? optionalString(entry.recorded_at) : null),
    },
  }
}

async function postAction(
  path: string,
  body: Record<string, unknown>,
  state: SessionState,
  action: DecisionOutcome['action'],
  fetcher: Fetcher,
): Promise<ApiOutcome<DecisionOutcome>> {
  if (!state.authenticated || !state.csrfToken) {
    // Without a session there is no decision to send: the request is not even made.
    return {
      ok: false,
      status: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: sessionErrorMessage('AUTHENTICATION_REQUIRED'),
      blockers: ['Connectez-vous avec un compte local avant toute décision.'],
    }
  }
  const outcome = await requestJson(fetcher, path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...csrfHeader(state) },
    body: JSON.stringify(body),
  })
  return outcome.ok ? parseDecisionPayload(action, outcome.value) : outcome
}

export function decisionPath(datasetId: string, suffix: 'decision' | 'revert' | 'publication'): string {
  return `/api/datasets/${encodeURIComponent(datasetId)}/${suffix}`
}

export interface DecisionRequest {
  datasetId: string
  state: SessionState
  note?: string | null
  reason?: string | null
  attestations?: Record<string, AttestationInput>
}

export async function approveVersion(request: DecisionRequest, fetcher: Fetcher = fetch) {
  const payload: Record<string, unknown> = { decision: 'approve' }
  if (request.attestations) {
    payload.attestations = Object.fromEntries(
      Object.entries(request.attestations).map(([item, value]) => [
        item,
        { evidence: value.evidence, reference: value.reference },
      ]),
    )
  }
  if (request.note) payload.note = request.note
  return postAction(decisionPath(request.datasetId, 'decision'), payload, request.state, 'APPROVE', fetcher)
}

export async function rejectVersion(request: DecisionRequest, fetcher: Fetcher = fetch) {
  return postAction(
    decisionPath(request.datasetId, 'decision'),
    { decision: 'reject', reason: request.reason },
    request.state,
    'REJECT',
    fetcher,
  )
}

export async function revertVersionDecision(
  request: DecisionRequest & { entryId: string },
  fetcher: Fetcher = fetch,
) {
  return postAction(
    decisionPath(request.datasetId, 'revert'),
    { entry_id: request.entryId, reason: request.reason },
    request.state,
    'REVERT_DECISION',
    fetcher,
  )
}

export async function publishVersion(request: DecisionRequest, fetcher: Fetcher = fetch) {
  return postAction(
    decisionPath(request.datasetId, 'publication'),
    { note: request.note },
    request.state,
    'PUBLISH',
    fetcher,
  )
}

export async function revertPublication(
  request: { state: SessionState; reason: string; snapshotId?: string | null },
  fetcher: Fetcher = fetch,
) {
  const payload: Record<string, unknown> = { reason: request.reason }
  if (request.snapshotId) payload.snapshot_id = request.snapshotId
  return postAction('/api/publication/revert', payload, request.state, 'REVERT_PUBLICATION', fetcher)
}

export function canReview(actor: Actor | null): boolean {
  return actor?.role === 'reviewer'
}

export function canPublish(actor: Actor | null): boolean {
  return actor?.role === 'publisher'
}
