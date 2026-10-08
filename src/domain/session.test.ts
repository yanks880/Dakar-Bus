import { describe, expect, it } from 'vitest'

import {
  ROLE_LABELS,
  approveVersion,
  emptyAttestations,
  login,
  logout,
  missingAttestations,
  parseDecisionPayload,
  parseSessionPayload,
  publishVersion,
  readSession,
  rejectVersion,
  revertPublication,
  revertVersionDecision,
  sessionErrorMessage,
  type Fetcher,
  type SessionState,
} from './session'

const SESSION_STATE: SessionState = {
  authenticated: true,
  actor: { actorId: 'fatou.ndiaye', displayName: 'Fatou Ndiaye', role: 'reviewer' },
  csrfToken: 'csrf-de-test',
  expiresAt: '2026-10-08T21:00:00+00:00',
}

function jsonResponse(payload: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => payload } as unknown as Response
}

function stub(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher: Fetcher = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    return Promise.resolve(jsonResponse(payload, status))
  }
  return { fetcher, calls }
}

describe('session payloads', () => {
  it('reports an anonymous session without inventing an actor', () => {
    const parsed = parseSessionPayload({ authenticated: false, actor: null, csrf_token: null })
    expect(parsed).toEqual({ ok: true, value: { authenticated: false, actor: null, csrfToken: null, expiresAt: null } })
  })

  it('keeps the actor, the role and the CSRF token of an open session', () => {
    const parsed = parseSessionPayload({
      authenticated: true,
      actor: { actor_id: 'ousmane.fall', display_name: 'Ousmane Fall', role: 'publisher' },
      csrf_token: 'jeton',
      expires_at: '2026-10-08T23:00:00+00:00',
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.actor).toEqual({ actorId: 'ousmane.fall', displayName: 'Ousmane Fall', role: 'publisher' })
      expect(parsed.value.csrfToken).toBe('jeton')
    }
  })

  it('refuses an authenticated session that names nobody', () => {
    const parsed = parseSessionPayload({ authenticated: true, actor: null })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.code).toBe('UNREADABLE_PAYLOAD')
      expect(parsed.message).toContain('aucun acteur')
    }
  })

  it('reads a decision result from either the entry or the publication journal', () => {
    const fromEntry = parseDecisionPayload('APPROVE', {
      review_status: 'APPROVED',
      entry: { entry_id: 'rv-000001', entry_hash: 'abc', recorded_at: '2026-10-08T09:00:00+00:00', authentication: { actor_id: 'fatou.ndiaye', method: 'console-session' } },
    })
    expect(fromEntry.ok && fromEntry.value.entryId).toBe('rv-000001')
    expect(fromEntry.ok && fromEntry.value.actorId).toBe('fatou.ndiaye')
    expect(fromEntry.ok && fromEntry.value.method).toBe('console-session')

    const fromJournal = parseDecisionPayload('PUBLISH', {
      snapshot_id: 'snap-1',
      publication_status: 'PUBLISHED',
      journal_entry: { entry_id: 'pb-000001', entry_hash: 'def', authentication: { actor_id: 'ousmane.fall', method: 'console-session' } },
    })
    expect(fromJournal.ok && fromJournal.value.entryId).toBe('pb-000001')
    expect(fromJournal.ok && fromJournal.value.actorId).toBe('ousmane.fall')
    expect(fromJournal.ok && fromJournal.value.publicationStatus).toBe('PUBLISHED')
  })

  it('labels the two roles without inventing a third', () => {
    expect(ROLE_LABELS.reviewer).toBe('relecteur')
    expect(ROLE_LABELS.publisher).toBe('publieur')
  })

  it('says out loud what each refusal means', () => {
    expect(sessionErrorMessage('ACTOR_REVOKED')).toContain('révoqué')
    expect(sessionErrorMessage('ROLE_FORBIDDEN')).toContain('séparation des devoirs')
    expect(sessionErrorMessage('CSRF_INVALID')).toContain('CSRF')
    expect(sessionErrorMessage('NOT_PUBLISHED')).toContain('rien à annuler')
    expect(sessionErrorMessage('INCONNU_DE_MOI')).toContain('sans interprétation')
  })
})

describe('session requests', () => {
  it('reads the session as a same-origin request', async () => {
    const { fetcher, calls } = stub({ authenticated: false })
    const outcome = await readSession(fetcher)
    expect(outcome.ok).toBe(true)
    expect(calls[0].url).toBe('/api/session')
    expect(calls[0].init.credentials).toBe('same-origin')
    expect(calls[0].init.method).toBeUndefined()
  })

  it('logs in with the account credentials only', async () => {
    const { fetcher, calls } = stub({
      authenticated: true,
      actor: { actor_id: 'fatou.ndiaye', display_name: 'Fatou Ndiaye', role: 'reviewer' },
      csrf_token: 'jeton-csrf',
    })
    const outcome = await login('fatou.ndiaye', 'un-secret-de-test', fetcher)
    expect(outcome.ok).toBe(true)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ actor_id: 'fatou.ndiaye', secret: 'un-secret-de-test' })
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('repeats the server refusal with its blockers instead of softening it', async () => {
    const { fetcher } = stub({ error: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives pour « fatou.ndiaye ».', blockers: ['Réessayez dans cinq minutes.'] }, 429)
    const outcome = await login('fatou.ndiaye', 'secret-au-hasard', fetcher)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(429)
      expect(outcome.code).toBe('TOO_MANY_ATTEMPTS')
      expect(outcome.message).toContain('Trop de tentatives')
      expect(outcome.blockers).toEqual(['Réessayez dans cinq minutes.'])
    }
  })

  it('falls back to an honest message when the refusal body is not JSON', async () => {
    const fetcher: Fetcher = () =>
      Promise.resolve({ ok: false, status: 502, json: async () => { throw new Error('pas du json') } } as unknown as Response)
    const outcome = await readSession(fetcher)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('UNREADABLE_REFUSAL')
  })

  it('reports the API as unreachable when the fetch itself fails', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('réseau coupé'))
    const outcome = await readSession(fetcher)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('NETWORK')
      expect(outcome.message).toContain('admin:api')
    }
  })

  it('closes the session with the CSRF token of that session', async () => {
    const { fetcher, calls } = stub({ authenticated: false })
    const outcome = await logout(SESSION_STATE, fetcher)
    expect(outcome.ok && outcome.value.authenticated).toBe(false)
    expect(calls[0].init.method).toBe('DELETE')
    expect((calls[0].init.headers as Record<string, string>)['X-Dakar-CSRF']).toBe('csrf-de-test')
  })
})

describe('decisions from the console', () => {
  it('approves with the five attestations and the CSRF token', async () => {
    const { fetcher, calls } = stub({
      review_status: 'APPROVED',
      entry: { entry_id: 'rv-000002', entry_hash: 'a'.repeat(64), authentication: { actor_id: 'fatou.ndiaye', method: 'console-session' } },
    })
    const attestations = emptyAttestations()
    attestations.source_identity = { evidence: 'Source confirmée par l’éditeur.', reference: 'https://example.invalid/feed' }
    const outcome = await approveVersion(
      { datasetId: 'demo-2026-10', state: SESSION_STATE, attestations, note: 'Dossier vérifié.' },
      fetcher,
    )
    expect(outcome.ok).toBe(true)
    expect(calls[0].url).toBe('/api/datasets/demo-2026-10/decision')
    expect((calls[0].init.headers as Record<string, string>)['X-Dakar-CSRF']).toBe('csrf-de-test')
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.decision).toBe('approve')
    expect(body.attestations.source_identity.reference).toBe('https://example.invalid/feed')
    expect(body.note).toBe('Dossier vérifié.')
    if (outcome.ok) {
      expect(outcome.value.action).toBe('APPROVE')
      expect(outcome.value.actorId).toBe('fatou.ndiaye')
    }
  })

  it('shows the missing attestations the server reports', async () => {
    const { fetcher } = stub({ error: 'APPROVAL_BLOCKED', message: 'L’approbation est refusée.', blockers: ['Attestation manquante : freshness_confirmed'] }, 409)
    const outcome = await approveVersion({ datasetId: 'demo-2026-10', state: SESSION_STATE, attestations: emptyAttestations() }, fetcher)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.status).toBe(409)
      expect(outcome.blockers).toEqual(['Attestation manquante : freshness_confirmed'])
    }
  })

  it('targets the right routes for a refusal, a reversal, a publication and its reversal', async () => {
    const { fetcher, calls } = stub({ entry_id: 'rv-000003', review_status: 'REJECTED', publication_status: 'NOT_PUBLISHED' })
    await rejectVersion({ datasetId: 'demo-2026-10', state: SESSION_STATE, reason: 'Source non identifiée auprès de l’éditeur.' }, fetcher)
    await revertVersionDecision({ datasetId: 'demo-2026-10', state: SESSION_STATE, entryId: 'rv-000003', reason: 'Motif corrigé après vérification.' }, fetcher)
    await publishVersion({ datasetId: 'demo-2026-10', state: SESSION_STATE, note: 'Publication après approbation séparée.' }, fetcher)
    await revertPublication({ state: SESSION_STATE, reason: 'Période de validité contestée par la source.' }, fetcher)

    expect(calls.map((call) => call.url)).toEqual([
      '/api/datasets/demo-2026-10/decision',
      '/api/datasets/demo-2026-10/revert',
      '/api/datasets/demo-2026-10/publication',
      '/api/publication/revert',
    ])
    expect(JSON.parse(String(calls[0].init.body)).decision).toBe('reject')
    expect(JSON.parse(String(calls[1].init.body)).entry_id).toBe('rv-000003')
    expect(JSON.parse(String(calls[2].init.body)).note).toContain('séparée')
    expect(JSON.parse(String(calls[3].init.body)).reason).toContain('validité')
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['X-Dakar-CSRF']).toBe('csrf-de-test')
    }
  })

  it('lists exactly the attestations still missing', () => {
    const attestations = emptyAttestations()
    attestations.source_identity = { evidence: 'Source confirmée.', reference: null }
    attestations.reuse_rights = { evidence: '   ', reference: null }
    expect(missingAttestations(attestations)).toEqual([
      'reuse_rights',
      'operator_confirmed',
      'service_operational',
      'freshness_confirmed',
    ])
  })
})

describe('a session without a token', () => {
  it('refuses to pretend a decision can be sent', async () => {
    const sent: string[] = []
    const fetcher: Fetcher = (input) => {
      sent.push(String(input))
      return Promise.resolve(jsonResponse({}))
    }
    const anonymous: SessionState = { authenticated: false, actor: null, csrfToken: null, expiresAt: null }
    const outcome = await publishVersion({ datasetId: 'demo-2026-10', state: anonymous, note: 'Publication sans session.' }, fetcher)
    expect(sent).toEqual([])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('AUTHENTICATION_REQUIRED')
      expect(outcome.status).toBe(401)
    }
  })
})
