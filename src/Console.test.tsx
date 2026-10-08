// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConsolePanel } from './Console'
import { REQUIRED_ATTESTATIONS, type CatalogDataset } from './domain/review'

const DATASET_ID = 'demo-2026-10-abcdef123456'

const dataset = (overrides: Partial<CatalogDataset> = {}): CatalogDataset => ({
  datasetId: DATASET_ID,
  integrity: 'OK',
  validityStatus: 'CURRENT',
  reviewStatus: 'PENDING_REVIEW',
  ledgerIntegrity: 'OK',
  operator: 'Démonstration locale',
  datasetVersion: 'demo-2026-10',
  source: 'Jeu de démonstration',
  sourceType: 'GTFS',
  serviceStatus: 'ACTIVE',
  reviewerId: null,
  reviewedAt: null,
  reviewEntryId: null,
  publicationStatus: 'NOT_PUBLISHED',
  publicationSnapshotId: null,
  ...overrides,
})

const SESSION_REVIEWER = {
  authenticated: true,
  actor: { actor_id: 'fatou.ndiaye', display_name: 'Fatou Ndiaye', role: 'reviewer' },
  csrf_token: 'csrf-relecteur',
  expires_at: '2026-10-08T21:00:00+00:00',
}

const SESSION_PUBLISHER = {
  authenticated: true,
  actor: { actor_id: 'ousmane.fall', display_name: 'Ousmane Fall', role: 'publisher' },
  csrf_token: 'csrf-publieur',
  expires_at: '2026-10-08T22:00:00+00:00',
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

type Handler = {
  match: string
  method?: string
  respond: (call: RecordedCall) => { status: number; payload: unknown; unreadable?: boolean }
}

function stubApi(handlers: Handler[]) {
  const calls: RecordedCall[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(call)
    const handler = handlers.find(
      (entry) => call.url.startsWith(entry.match) && (entry.method ?? 'GET').toUpperCase() === call.method,
    )
    const result = handler ? handler.respond(call) : { status: 404, payload: { error: 'NOT_FOUND', message: 'Ressource inconnue.' } }
    const body = result.payload
    return Promise.resolve({
      ok: result.status < 400,
      status: result.status,
      json: result.unreadable
        ? async () => {
            throw new Error('pas du JSON')
          }
        : async () => body,
    } as unknown as Response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

const anonymous = { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: { authenticated: false } }) }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('console without a session', () => {
  it('asks for a local account and shows no decision button', async () => {
    stubApi([anonymous])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)

    expect(await screen.findByText('Aucune session ouverte')).toBeTruthy()
    expect(screen.getByLabelText('Identifiant d’acteur')).toBeTruthy()
    expect(screen.getByLabelText('Secret du compte')).toBeTruthy()
    expect(screen.getByText(/npm run actors -- create/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Approuver/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Publier/ })).toBeNull()
  })

  it('refuses an invalid identifier without calling the API', async () => {
    const { calls } = stubApi([anonymous])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)
    await screen.findByText('Aucune session ouverte')

    fireEvent.change(screen.getByLabelText('Identifiant d’acteur'), { target: { value: 'Fatou Ndiaye' } })
    fireEvent.change(screen.getByLabelText('Secret du compte'), { target: { value: 'un-secret-de-test' } })
    fireEvent.click(screen.getByRole('button', { name: /Ouvrir une session/ }))

    expect(await screen.findByText('Identifiant invalide')).toBeTruthy()
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('says the API is unreachable instead of pretending a session', async () => {
    stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 503, payload: {}, unreadable: true }) },
    ])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)
    expect(await screen.findByText('Session indisponible (HTTP 503)')).toBeTruthy()
    expect(screen.getByText(/sans corps lisible/)).toBeTruthy()
    expect(screen.getByText('Aucune session ouverte')).toBeTruthy()
  })
})

describe('console with a reviewer session', () => {
  it('shows the actor, the role and only the actions that role allows', async () => {
    stubApi([{ match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) }])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)

    expect(await screen.findByText('Fatou Ndiaye')).toBeTruthy()
    expect(screen.getByText(/rôle « relecteur »/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Approuver/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refuser/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Annuler la décision/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Publier/ })).toBeNull()
  })

  it('approves with the five attestations, the CSRF token and reports the journal entry', async () => {
    const onChanged = vi.fn()
    const { calls } = stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) },
      {
        match: `/api/datasets/${DATASET_ID}/decision`,
        method: 'POST',
        respond: () => ({
          status: 200,
          payload: {
            recorded: true,
            action: 'APPROVE',
            dataset_id: DATASET_ID,
            review_status: 'APPROVED',
            publication_status: 'NOT_PUBLISHED',
            entry: {
              entry_id: 'rv-000004',
              entry_hash: 'f'.repeat(64),
              recorded_at: '2026-10-08T15:00:00+00:00',
              authentication: { actor_id: 'fatou.ndiaye', method: 'console-session' },
            },
          },
        }),
      },
    ])
    render(<ConsolePanel datasets={[dataset()]} onChanged={onChanged} />)
    await screen.findByText('Fatou Ndiaye')

    fireEvent.click(screen.getByRole('button', { name: /Approuver/ }))
    const evidenceFields = screen.getAllByLabelText('Preuve constatée')
    expect(evidenceFields).toHaveLength(REQUIRED_ATTESTATIONS.length)
    evidenceFields.forEach((field, index) => fireEvent.change(field, { target: { value: `Preuve constatée ${index}` } }))
    fireEvent.change(screen.getAllByLabelText('URL de preuve (facultative hors source_identity)')[0], {
      target: { value: 'https://example.invalid/feed' },
    })
    fireEvent.change(screen.getByLabelText('Note de revue (facultative)'), { target: { value: 'Dossier vérifié.' } })
    fireEvent.click(screen.getByRole('button', { name: /Approuver cette version/ }))

    expect(await screen.findByText('Approbation enregistré par le serveur')).toBeTruthy()
    const decisionCall = calls.find((call) => call.url.endsWith('/decision'))
    expect(decisionCall?.headers['X-Dakar-CSRF']).toBe('csrf-relecteur')
    const body = decisionCall?.body as { decision: string; attestations: Record<string, { evidence: string; reference: string | null }>; note: string }
    expect(body.decision).toBe('approve')
    expect(Object.keys(body.attestations)).toHaveLength(REQUIRED_ATTESTATIONS.length)
    expect(body.attestations.source_identity.reference).toBe('https://example.invalid/feed')
    expect(body.note).toBe('Dossier vérifié.')
    expect(screen.getByText(/rv-000004/)).toBeTruthy()
    expect(screen.getByText(/ffffffffffff…/)).toBeTruthy()
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(calls.some((call) => call.method === 'GET' && call.url === '/api/session')).toBe(true)
  })

  it('repeats the server blockers when an approval is refused', async () => {
    stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) },
      {
        match: `/api/datasets/${DATASET_ID}/decision`,
        method: 'POST',
        respond: () => ({
          status: 409,
          payload: {
            error: 'APPROVAL_BLOCKED',
            message: 'L’approbation est refusée : des vérifications obligatoires ne sont pas attestées.',
            blockers: ['Attestation manquante : freshness_confirmed — Fraîcheur et période de validité confirmées avec la source'],
          },
        }),
      },
    ])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)
    await screen.findByText('Fatou Ndiaye')
    fireEvent.click(screen.getByRole('button', { name: /Approuver/ }))
    fireEvent.click(screen.getByRole('button', { name: /Approuver cette version/ }))

    expect(await screen.findByText('Le serveur a refusé l’écriture')).toBeTruthy()
    expect(screen.getByText(/Attestation manquante : freshness_confirmed/)).toBeTruthy()
    expect(screen.queryByText('Approbation enregistré par le serveur')).toBeNull()
  })

  it('reverts the active decision by its journal identifier', async () => {
    const { calls } = stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) },
      {
        match: `/api/datasets/${DATASET_ID}/revert`,
        method: 'POST',
        respond: () => ({
          status: 200,
          payload: { review_status: 'PENDING_REVIEW', entry_id: 'rv-000005', entry_hash: 'a'.repeat(64) },
        }),
      },
    ])
    render(
      <ConsolePanel
        datasets={[dataset({ reviewStatus: 'REJECTED', reviewerId: 'fatou.ndiaye', reviewEntryId: 'rv-000003' })]}
        onChanged={() => {}}
      />,
    )
    await screen.findByText('Fatou Ndiaye')
    fireEvent.click(screen.getByRole('button', { name: /Annuler la décision/ }))

    const entryField = screen.getByLabelText('Identifiant de la décision') as HTMLInputElement
    expect(entryField.value).toBe('rv-000003')
    fireEvent.change(screen.getByLabelText('Motif de l’annulation (au moins 12 caractères)'), {
      target: { value: 'Motif de refus erroné, source confirmée ensuite.' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: /^Annuler la décision$/ })[1])

    expect(await screen.findByText('Annulation de la décision enregistré par le serveur')).toBeTruthy()
    const revertCall = calls.find((call) => call.url.endsWith('/revert'))
    expect((revertCall?.body as { entry_id: string }).entry_id).toBe('rv-000003')
  })
})

describe('console with a publisher session', () => {
  it('publishes an approved version and cannot approve anything', async () => {
    const { calls } = stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_PUBLISHER }) },
      {
        match: `/api/datasets/${DATASET_ID}/publication`,
        method: 'POST',
        respond: () => ({
          status: 200,
          payload: {
            snapshot_id: 'snap-20261008t150000z-demo',
            publication_status: 'PUBLISHED',
            separation_of_duties: true,
            journal_entry: {
              entry_id: 'pb-000002',
              entry_hash: 'b'.repeat(64),
              authentication: { actor_id: 'ousmane.fall', method: 'console-session' },
            },
          },
        }),
      },
    ])
    render(
      <ConsolePanel
        datasets={[dataset({ reviewStatus: 'APPROVED', reviewerId: 'fatou.ndiaye', reviewEntryId: 'rv-000004' })]}
        onChanged={() => {}}
      />,
    )
    await screen.findByText('Ousmane Fall')
    expect(screen.getByText(/rôle « publieur »/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Approuver$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Publier/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Publier/ }))
    fireEvent.change(screen.getByLabelText('Note de publication (au moins 12 caractères)'), {
      target: { value: 'Publication après approbation séparée.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Publier cette version/ }))

    expect(await screen.findByText('Publication enregistré par le serveur')).toBeTruthy()
    const publishCall = calls.find((call) => call.url.endsWith('/publication'))
    expect(publishCall?.headers['X-Dakar-CSRF']).toBe('csrf-publieur')
    expect((publishCall?.body as { note: string }).note).toContain('séparée')
    expect(screen.getByText(/pb-000002/)).toBeTruthy()
  })
})

describe('console notice and logout', () => {
  it('closes the session and comes back to the account form', async () => {
    const { calls } = stubApi([
      { match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) },
      { match: '/api/session', method: 'DELETE', respond: () => ({ status: 200, payload: { authenticated: false, closed: true } }) },
    ])
    render(<ConsolePanel datasets={[dataset()]} onChanged={() => {}} />)
    await screen.findByText('Fatou Ndiaye')

    fireEvent.click(screen.getByRole('button', { name: 'Fermer la session' }))
    expect(await screen.findByText('Session fermée')).toBeTruthy()
    expect(screen.getByText('Aucune session ouverte')).toBeTruthy()
    const logoutCall = calls.find((call) => call.method === 'DELETE')
    expect(logoutCall?.headers['X-Dakar-CSRF']).toBe('csrf-relecteur')
  })

  it('says which version the reviewer cannot act on', async () => {
    stubApi([{ match: '/api/session', method: 'GET', respond: () => ({ status: 200, payload: SESSION_REVIEWER }) }])
    render(
      <ConsolePanel
        datasets={[dataset({ integrity: 'INVALID', reviewStatus: 'UNKNOWN' })]}
        onChanged={() => {}}
      />,
    )
    await screen.findByText('Fatou Ndiaye')
    expect(screen.getByText('Aucune version décidable')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approuver/ })).toBeNull())
  })
})
