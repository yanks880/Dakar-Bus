// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/TransitMap', () => ({
  TransitMap: ({
    pickingPoint,
    onChoosePoint,
  }: {
    pickingPoint: 'origin' | 'destination' | null
    onChoosePoint: (point: { lat: number; lng: number }) => void
  }) => (
    <div aria-label="Carte de test">
      <button
        type="button"
        aria-label="Choisir le point actif sur la carte"
        disabled={!pickingPoint}
        onClick={() => onChoosePoint({ lat: 14.7001, lng: -17.4502 })}
      >
        Choisir le point actif
      </button>
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Dakar Bus experience safety', () => {
  it('states that transit sources are not connected and does not show fabricated departures', () => {
    render(<App />)

    expect(screen.getByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.getByText(/aucun arrêt, horaire ou tracé n’est simulé/i)).toBeTruthy()
    expect(screen.queryByText(/\bLIVE\b/i)).toBeNull()
    expect(screen.queryByText(/0 min/i)).toBeNull()
  })

  it('lets the user select map points but refuses to invent an itinerary without GTFS', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))

    const pointButtons = screen.getAllByRole('button', { name: /choisir un point sur la carte/i })
    fireEvent.click(pointButtons[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    fireEvent.click(screen.getByRole('button', { name: /choisir un point sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    const searchRoute = screen.getByRole('button', { name: /rechercher un itinéraire/i })
    expect((searchRoute as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(searchRoute)

    expect(screen.getByText(/calcul impossible pour le moment/i)).toBeTruthy()
    expect(screen.getByText(/aucun jeu de transport GTFS vérifié n’est connecté/i)).toBeTruthy()
    expect(screen.queryByText(/\d+ min · \d+ min/i)).toBeNull()
  })

  it('does not claim normal service when the alert source is missing', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /alertes/i }))

    expect(screen.getByText(/source d’alertes non connectée/i)).toBeTruthy()
    expect(screen.getByText(/l’absence d’alerte reçue ne signifie pas que le service est normal/i)).toBeTruthy()
  })
})

const CATALOG_PAYLOAD = {
  datasets: [
    {
      dataset_id: 'ddd-2026-10-abcdef123456',
      integrity: 'OK',
      effective_validity_status: 'CURRENT',
      review_status: 'APPROVED',
      ledger_integrity: 'OK',
      operator: 'Dakar Dem Dikk',
      dataset_version: '2026-10',
      source: 'Éditeur de données publiques',
      source_type: 'OFFICIAL',
      service_status: 'ACTIVE',
      reviewer_id: 'fatou.ndiaye',
      reviewed_at: '2026-10-08T11:30:00+00:00',
      publication_status: 'NOT_PUBLISHED',
    },
  ],
}

const PIPELINE_PAYLOAD = {
  generated_at: '2026-10-08T12:00:00+00:00',
  counts: { staged: 1, approved: 1, published: 0 },
  stages: [
    { id: 'staged', label: 'Staging', count: 1, note: 'Archive copiée' },
    { id: 'pending_review', label: 'En revue', count: 0, note: 'Attente de décision' },
    { id: 'approved', label: 'Approuvé', count: 1, note: 'Attestations complètes' },
    { id: 'rejected', label: 'Refusé', count: 0, note: 'Motif enregistré' },
    { id: 'published', label: 'Publié', count: 0, note: 'Non implémentée' },
  ],
  data_policy: 'Lecture seule',
  publication_status: 'NOT_PUBLISHED',
}

describe('governance console', () => {
  it('says the local console is offline instead of inventing staged datasets', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('réseau indisponible'))))
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText(/console hors ligne/i)).toBeTruthy()
    expect(screen.queryByText(/ddd-2026-10-abcdef123456/i)).toBeNull()
    expect(screen.queryByText(/fatou\.ndiaye/i)).toBeNull()
    expect(screen.getByText(/une approbation ne publie rien/i)).toBeTruthy()
  })

  it('shows the catalog read from the API and the publication stage as implemented', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        const payload = url.includes('/api/catalog') ? CATALOG_PAYLOAD : PIPELINE_PAYLOAD
        return Promise.resolve({ ok: true, status: 200, json: async () => payload })
      }),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText('ddd-2026-10-abcdef123456')).toBeTruthy()
    expect(screen.getByText(/console en lecture seule/i)).toBeTruthy()
    expect(screen.getByText('Approuvé')).toBeTruthy()
    expect(screen.getByText('fatou.ndiaye · 2026-10-08 11:30 UTC')).toBeTruthy()
    expect(screen.getByText('NOT_PUBLISHED')).toBeTruthy()
    expect(screen.getAllByText(/snapshot daté et haché/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/non implémentée · rien n’est exposé publiquement/i)).toBeNull()
  })

  it('reports a published snapshot as published instead of hiding it', async () => {
    const publishedCatalog = {
      datasets: [{ ...CATALOG_PAYLOAD.datasets[0], publication_status: 'PUBLISHED', publication_snapshot_id: 'snap-20261008t131934z-demo' }],
    }
    const publishedPipeline = {
      ...PIPELINE_PAYLOAD,
      counts: { ...PIPELINE_PAYLOAD.counts, published: 1 },
      publication_status: 'PUBLISHED',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const payload = String(input).includes('/api/catalog') ? publishedCatalog : publishedPipeline
        return Promise.resolve({ ok: true, status: 200, json: async () => payload })
      }),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText('PUBLISHED')).toBeTruthy()
    const publicationStage = Array.from(document.querySelectorAll('.governance-stage')).find((stage) =>
      stage.textContent?.includes('Publication'),
    )
    expect(publicationStage?.querySelector('.governance-stage-count')?.textContent).toBe('1')
  })

  it('refuses a malformed API response instead of rendering a fake catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({ datasets: [{ nope: true }] }) })),
    )
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText(/console hors ligne/i)).toBeTruthy()
    expect(screen.getByText(/une entrée du catalogue est incomplète/i)).toBeTruthy()
  })
})
