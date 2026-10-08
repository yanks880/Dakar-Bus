// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/TransitMap', () => ({
  TransitMap: ({
    pickingPoint,
    onChoosePoint,
    publishedStops,
  }: {
    pickingPoint: 'origin' | 'destination' | null
    onChoosePoint: (point: { lat: number; lng: number }) => void
    publishedStops: readonly { stopId: string; stopName: string }[]
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
      <span data-testid="mapped-stops">{publishedStops.map((stop) => stop.stopName).join(' | ')}</span>
    </div>
  ),
}))

type ApiResponse = { ok: boolean; status: number; json: () => Promise<unknown> }

const jsonResponse = (payload: unknown, status = 200): ApiResponse => ({ ok: true, status, json: async () => payload })
const errorResponse = (status: number, code: string): ApiResponse => ({ ok: false, status, json: async () => ({ error: code }) })

/** Routes by URL prefix; anything unmatched is a hard 404 NOT_FOUND. */
function stubApi(routes: { match: string; respond: () => ApiResponse }[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes.find((entry) => url.startsWith(entry.match))
    return Promise.resolve(route ? route.respond() : errorResponse(404, 'NOT_FOUND'))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function stubGeolocation(latitude = 14.7051, longitude = -17.4602) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (success: (position: unknown) => void) =>
        success({ coords: { latitude, longitude, accuracy: 25 } }),
    },
  })
}

const NETWORK_PUBLISHED = {
  available: true,
  publication_status: 'PUBLISHED',
  published_at: '2026-10-08T13:19:34+00:00',
  publisher_id: 'demo.mainteneur',
  snapshot: {
    snapshot_id: 'snap-20261008t131934z-demonstration',
    built_at: '2026-10-08T13:19:34+00:00',
    validity_status: 'CURRENT',
    valid_from: '2026-01-01T00:00:00+00:00',
    valid_until: '2027-12-31T23:59:59+00:00',
    timezone: 'Africa/Dakar',
    record_count: { stops: 8, routes: 3 },
    bounds: { min_lat: 14.66, min_lon: -17.49, max_lat: 14.77, max_lon: -17.4, stops_with_coordinates: 8 },
  },
  dataset: { dataset_id: 'demo-2026-10', dataset_version: 'demo-2026-10', operator: 'Démonstration locale', source_type: 'GTFS', service_status: 'ACTIVE' },
  message: 'Snapshot publié servi en lecture seule ; horaires théoriques, aucun temps réel.',
  data_policy: 'Données GTFS Static publiées depuis un snapshot daté et immuable.',
  blocked_reason: null,
  realtime: false,
}

const NETWORK_EMPTY = {
  available: false,
  publication_status: 'NOT_PUBLISHED',
  snapshot: null,
  dataset: null,
  message: 'Aucun jeu de données n’est publié : la carte reste une carte de fond OpenStreetMap et le calcul d’itinéraire reste indisponible.',
  data_policy: 'Données GTFS Static publiées depuis un snapshot daté et immuable.',
  blocked_reason: 'Aucun snapshot publié : rien n’est servi à l’application.',
  realtime: false,
}

const ROUTES_PAYLOAD = {
  count: 2,
  results: [
    { route_id: 'L1', route_short_name: 'L1', route_long_name: 'Démo — Plateau ↔ Yoff', route_type: '3', trip_count: 2 },
    { route_id: 'L2', route_short_name: 'L2', route_long_name: 'Démo — Médina ↔ Guédiawaye', route_type: '3', trip_count: 2 },
  ],
}

const NEARBY_PAYLOAD = {
  count: 2,
  results: [
    { stop_id: 'D2', stop_name: 'Démo — Plateau Sud', stop_lat: 14.7053, stop_lon: -17.4601, distance_m: 24 },
    { stop_id: 'D6', stop_name: 'Démo — Yoff Aéroport', stop_lat: 14.748, stop_lon: -17.49, distance_m: 4860 },
  ],
}

const STOP_D6_DETAIL = {
  stop: {
    stop_id: 'D6',
    stop_name: 'Démo — Yoff Aéroport',
    stop_lat: 14.748,
    stop_lon: -17.49,
    location_type: '0',
    parent_station: null,
    routes: [
      { route_id: 'L1', route_short_name: 'L1', route_long_name: 'Démo — Plateau ↔ Yoff', route_type: '3', trip_count: 2 },
    ],
    scheduled_time_window: {
      first_declared_departure: '07:05:00',
      last_declared_departure: '07:20:00',
      note: 'Heures théoriques déclarées dans stop_times (GTFS Static) ; ce n’est ni une position, ni un temps réel.',
    },
  },
}

const JOURNEYS_PAYLOAD = {
  generated_at: '2026-10-08T13:47:47+00:00',
  snapshot_id: 'snap-20261008t131934z-demonstration',
  publication_status: 'PUBLISHED',
  graph: {
    built_at: '2026-10-08T13:45:53+00:00',
    snapshot_id: 'snap-20261008t131934z-demonstration',
    stats: { stops: 8, places: 8, trips: 5, edges: 0 },
    capabilities: { network_walk: true, direct_rides: true, transfers_itinerary: false, realtime: false },
    parameters: { cluster_radius_m: 250, nearby_walk_radius_m: 400 },
  },
  origin: { input: '14.705100, -17.460200', origin: 'coordinates', coordinates: { lat: 14.7051, lon: -17.4602 }, place: null, alternatives: [] },
  destination: { input: 'D6', origin: 'published-stop', coordinates: { lat: 14.748, lon: -17.49 }, place: { place_id: 'stop-D6', label: 'Démo — Yoff Aéroport', kind: 'stop', stop_ids: ['D6'] }, alternatives: [] },
  requested_at: '2026-10-08T13:47:47+00:00',
  local_day: '2026-10-08',
  max_walk_m: 900,
  start_walk_m: 400,
  results: [
    {
      kind: 'direct',
      transfers: 0,
      trip_id: 'L1-B',
      service_id: 'DEMO-WK',
      route: { route_id: 'L1', short_name: 'L1', long_name: 'Démo — Plateau ↔ Yoff (bus)', route_type: '3' },
      board: { stop_id: 'D1', stop_name: 'Démo — Plateau Nord', departure: '06:00:00', walk_m: 0, walk_m_known: true, walk_path: ['D1'] },
      alight: { stop_id: 'D2', stop_name: 'Démo — Plateau Sud', arrival: '06:42:00', walk_m: 31, walk_m_known: true, walk_path: ['D2', 'D1'] },
      departure_seconds: 21600,
      arrival_seconds: 24120,
      duration_min: 42,
      date: '2026-10-08',
      note: 'Horaire théorique déclaré dans le flux GTFS Static ; ni position ni estimation temps réel.',
    },
  ],
  result_count: 1,
  result_date: '2026-10-08',
  exhausted_today: false,
  next_service_date: null,
  message: null,
  limitations: 'Le moteur ne propose que des courses directes déclarées dans le flux : une seule montée, une seule descente.',
  data_policy: 'Graphe dérivé du snapshot publié.',
  realtime: false,
}

const JOURNEYS_NO_RIDE = {
  ...JOURNEYS_PAYLOAD,
  results: [],
  result_count: 0,
  result_date: null,
  exhausted_today: true,
  next_service_date: '2026-10-12',
  reason: 'NO_DIRECT_SERVICE',
  message:
    'Aucune course directe déclarée ne relie ces deux lieux dans le rayon de marche demandé. La première course directe déclarée est le 2026-10-12. Le moteur à correspondances n’est pas implémenté : aucun trajet indirect n’est proposé.',
}

const SEARCH_PAYLOAD = {
  count: 1,
  results: [{ stop_id: 'D6', stop_name: 'Démo — Yoff Aéroport', stop_lat: 14.748, stop_lon: -17.49 }],
}

function publishedApi() {
  return stubApi([
    { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
    { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
    { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
    { match: '/api/stops/search', respond: () => jsonResponse(SEARCH_PAYLOAD) },
    { match: '/api/stops/D6', respond: () => jsonResponse(STOP_D6_DETAIL) },
    { match: '/api/journeys', respond: () => jsonResponse(JOURNEYS_PAYLOAD) },
  ])
}

beforeEach(() => {
  stubGeolocation()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Dakar Bus experience safety', () => {
  it('states that transit sources are not connected while nothing is published', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    expect(await screen.findByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.getByText(/aucun arrêt, horaire ou tracé n’est simulé/i)).toBeTruthy()
    expect(screen.getByText(/^en attente$/i)).toBeTruthy()
    expect(screen.queryByText(/\bLIVE\b/i)).toBeNull()
    expect(screen.queryByText(/0 min/i)).toBeNull()
  })

  it('lets the user select map points but refuses to invent an itinerary without GTFS', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
      { match: '/api/journeys', respond: () => errorResponse(409, 'NOT_PUBLISHED') },
    ])
    render(<App />)
    await screen.findByText(/aucune source de transport n’est encore reliée/i)
    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))

    const pointButtons = screen.getAllByRole('button', { name: /choisir un point sur la carte/i })
    fireEvent.click(pointButtons[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    fireEvent.click(screen.getByRole('button', { name: /choisir un point sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    const searchRoute = screen.getByRole('button', { name: /rechercher un itinéraire/i })
    expect((searchRoute as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(searchRoute)

    expect(await screen.findByText(/itinéraire impossible pour le moment/i)).toBeTruthy()
    // Le message apparaît aussi dans la région d’annonce : on compte au lieu d’exiger un seul nœud.
    expect(screen.getAllByText(/aucun jeu de transport publié/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/aucun trajet n’est inventé/i)).toBeTruthy()
    expect(screen.queryByText(/^\d+ min$/)).toBeNull()
  })

  it('says the read API is unreachable instead of falling back to fabricated data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('réseau indisponible'))))
    render(<App />)

    expect(await screen.findByText(/l’api de lecture locale ne répond pas sur \/api/i)).toBeTruthy()
    expect(screen.queryByText(/arrêts publiés/i)).toBeNull()
    expect(screen.queryByText(/démo — yoff aéroport/i)).toBeNull()
  })

  it('does not claim normal service when the alert source is missing', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /alertes/i }))

    expect(screen.getByText(/source d’alertes non connectée/i)).toBeTruthy()
    expect(screen.getByText(/l’absence d’alerte reçue ne signifie pas que le service est normal/i)).toBeTruthy()
  })
})

describe('published snapshot in the app', () => {
  it('shows the published snapshot, its provenance and its theoretical stops', async () => {
    publishedApi()
    render(<App />)

    expect(await screen.findByText(/^snapshot publié servi$/i)).toBeTruthy()
    expect(screen.getByText(/^publié$/i)).toBeTruthy()
    expect(screen.getByText(/démonstration locale · version demo-2026-10/i)).toBeTruthy()
    expect(screen.getByText(/horaires théoriques, aucune position de véhicule/i)).toBeTruthy()
    expect(screen.queryByText(/aucune source de transport n’est encore reliée/i)).toBeNull()

    expect(await screen.findByText(/2 lignes publiées/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /explorer/i }))
    expect(await screen.findByText(/^L1 · Démo — Plateau ↔ Yoff$/)).toBeTruthy()
    expect(screen.getByText(/démo — médina ↔ guédiawaye/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /carte/i }))

    fireEvent.click(screen.getAllByRole('button', { name: /me localiser/i })[0])
    expect(await screen.findByText('Démo — Plateau Sud')).toBeTruthy()
    expect(screen.getByText(/à 24 m/)).toBeTruthy()
    expect(screen.getByTestId('mapped-stops').textContent).toBe('Démo — Plateau Sud | Démo — Yoff Aéroport')
  })

  it('opens a stop card with the lines and the theoretical window, then uses it as a destination', async () => {
    publishedApi()
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i))
    fireEvent.change(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i), { target: { value: 'yoff' } })
    fireEvent.submit(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i).closest('form')!)

    expect(await screen.findByText('Démo — Yoff Aéroport')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /démo — yoff aéroport/i }))

    expect(await screen.findByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeTruthy()
    expect(screen.getByText(/07:05:00 → 07:20:00/)).toBeTruthy()
    expect(screen.getByText(/ni une position, ni un temps réel/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /partir d’ici/i }))
    expect(await screen.findByText(/arrêt publié/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /aller ici/i }))
    expect(screen.getByRole('button', { name: /rechercher un itinéraire/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /rechercher un itinéraire/i }))
    expect(await screen.findByText(/horaires théoriques déclarés/i)).toBeTruthy()
    expect(screen.queryByText(/moteur d’itinéraires pas encore en place/i)).toBeNull()
  })

  it('proposes only declared direct rides, with their theoretical times', async () => {
    const fetchMock = publishedApi()
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    expect(await screen.findByText('14.7051, -17.4602')).toBeTruthy()

    fireEvent.click(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i))
    fireEvent.change(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i), { target: { value: 'yoff' } })
    fireEvent.submit(screen.getByLabelText(/rechercher un arrêt, une station ou une ligne/i).closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /démo — yoff aéroport/i }))
    fireEvent.click(await screen.findByRole('button', { name: /aller ici/i }))

    fireEvent.click(screen.getByRole('button', { name: /rechercher un itinéraire/i }))

    expect(await screen.findByText(/horaires théoriques déclarés/i)).toBeTruthy()
    expect(screen.getAllByText(/1 course directe/i).length).toBeGreaterThan(0)
    expect(screen.getByText('06:00')).toBeTruthy()
    expect(screen.getByText('06:42')).toBeTruthy()
    expect(screen.getByText('42 min')).toBeTruthy()
    expect(screen.getByText('Démo — Plateau Nord')).toBeTruthy()
    expect(screen.getByText('Démo — Plateau Sud')).toBeTruthy()
    expect(screen.getByText(/31 m à pied/i)).toBeTruthy()
    expect(screen.getByText(/ni position ni estimation temps réel/i)).toBeTruthy()
    expect(screen.getByText(/aucune position de véhicule et aucun temps réel/i)).toBeTruthy()

    // Le départ géolocalisé part en coordonnées, la destination garde l’identité de l’arrêt publié.
    const journeyCall = fetchMock.mock.calls.map((call) => String(call[0])).find((url) => url.startsWith('/api/journeys'))
    expect(journeyCall).toBeDefined()
    const query = new URLSearchParams(journeyCall!.split('?')[1])
    expect(query.get('origin_lat')).toBe('14.705100')
    expect(query.get('origin_lon')).toBe('-17.460200')
    expect(query.get('origin')).toBeNull()
    expect(query.get('destination')).toBe('D6')
    expect(query.get('at')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(query.get('max_walk_m')).toBe('900')
  })

  it('explains the absence of a direct ride without proposing a detour', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      { match: '/api/journeys', respond: () => jsonResponse(JOURNEYS_NO_RIDE) },
    ])
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher un itinéraire/i }))

    expect((await screen.findAllByText(/aucune course directe déclarée/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/aucun trajet indirect n’est proposé/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/12\/10\/2026/)).toBeTruthy()
    expect(screen.queryByText(/^\d+ min$/)).toBeNull()
  })

  it('says the routing graph is missing instead of guessing an itinerary', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      { match: '/api/journeys', respond: () => errorResponse(409, 'GRAPH_UNAVAILABLE') },
    ])
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher un itinéraire/i }))

    expect(await screen.findByText(/itinéraire impossible pour le moment/i)).toBeTruthy()
    expect(screen.getAllByText(/graphe d’itinéraires n’est pas construit/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/npm run graph:build/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/aucun trajet n’est deviné en attendant/i).length).toBeGreaterThan(0)
  })

  it('refuses a point that matches no published stop rather than inventing a place', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      { match: '/api/journeys', respond: () => errorResponse(404, 'PLACE_NOT_FOUND') },
    ])
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getByRole('tab', { name: /itinéraire/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher un itinéraire/i }))

    expect(await screen.findByText(/itinéraire impossible pour le moment/i)).toBeTruthy()
    expect(screen.getAllByText(/aucun lieu n’est deviné/i).length).toBeGreaterThan(0)
  })

  it('shows nothing as current when the published period is over', async () => {
    stubApi([
      {
        match: '/api/network',
        respond: () =>
          jsonResponse({
            ...NETWORK_PUBLISHED,
            snapshot: { ...NETWORK_PUBLISHED.snapshot, validity_status: 'STALE' },
          }),
      },
    ])
    render(<App />)

    expect(await screen.findByText(/ne couvre pas aujourd’hui/i)).toBeTruthy()
    expect(screen.getByText(/rien n’est affiché comme actuel/i)).toBeTruthy()
    expect(screen.getByText(/^période dépassée$/i)).toBeTruthy()
    expect(screen.queryByText(/démo — plateau sud/i)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /explorer/i }))
    expect(screen.getByText(/aucune donnée publiée à explorer/i)).toBeTruthy()
  })

  it('reports a withdrawn publication instead of keeping the snapshot on screen', async () => {
    let published = true
    stubApi([
      {
        match: '/api/network',
        respond: () => (published ? jsonResponse(NETWORK_PUBLISHED) : jsonResponse(NETWORK_EMPTY)),
      },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      { match: '/api/stops/D6', respond: () => (published ? jsonResponse(STOP_D6_DETAIL) : errorResponse(404, 'NOT_PUBLISHED')) },
    ])
    render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    fireEvent.click(screen.getAllByRole('button', { name: /me localiser/i })[0])
    fireEvent.click(await screen.findByRole('button', { name: /démo — yoff aéroport/i }))
    expect(await screen.findByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeTruthy()
    expect(screen.getByTestId('mapped-stops').textContent).toContain('Démo — Yoff Aéroport')

    // The publication is withdrawn server-side: refreshing must drop the view
    // instead of keeping a snapshot that is no longer served.
    published = false
    fireEvent.click(screen.getByRole('button', { name: /actualiser l’état de publication/i }))

    expect(await screen.findByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.queryByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeNull()
    expect(screen.getByTestId('mapped-stops').textContent).toBe('')
    expect(screen.queryByText(/^L1 · Démo — Plateau ↔ Yoff$/)).toBeNull()
  })

  it('keeps the layout switch explicit and remembers the choice', async () => {
    publishedApi()
    const { container } = render(<App />)
    await screen.findByText(/^snapshot publié servi$/i)

    expect(container.querySelector('.app-shell')?.className).toContain('layout-map')
    fireEvent.click(screen.getByRole('button', { name: /passer au panneau latéral/i }))
    expect(container.querySelector('.app-shell')?.className).toContain('layout-split')
    expect(window.localStorage.getItem('dakar-bus:layout')).toBe('split')
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
    { id: 'published', label: 'Publié', count: 0, note: 'Snapshot daté' },
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
    stubApi([
      { match: '/api/catalog', respond: () => jsonResponse(CATALOG_PAYLOAD) },
      { match: '/api/pipeline', respond: () => jsonResponse(PIPELINE_PAYLOAD) },
      { match: '/api/session', respond: () => jsonResponse({ authenticated: false }) },
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
    ])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText('ddd-2026-10-abcdef123456')).toBeTruthy()
    expect(screen.getByText(/catalogue local vérifié/i)).toBeTruthy()
    // The connected console is mounted with the catalogue and asks for an account.
    expect(await screen.findByText(/aucune session ouverte/i)).toBeTruthy()
    expect(screen.getByText(/npm run actors -- create/)).toBeTruthy()
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
    stubApi([
      { match: '/api/catalog', respond: () => jsonResponse(publishedCatalog) },
      { match: '/api/pipeline', respond: () => jsonResponse(publishedPipeline) },
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
    ])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText('PUBLISHED')).toBeTruthy()
    const publicationStage = Array.from(document.querySelectorAll('.governance-stage')).find((stage) =>
      stage.textContent?.includes('Publication'),
    )
    expect(publicationStage?.querySelector('.governance-stage-count')?.textContent).toBe('1')
  })

  it('refuses a malformed API response instead of rendering a fake catalog', async () => {
    stubApi([
      { match: '/api/catalog', respond: () => jsonResponse({ datasets: [{ nope: true }] }) },
      { match: '/api/pipeline', respond: () => jsonResponse(PIPELINE_PAYLOAD) },
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
    ])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /gouvernance/i }))

    expect(await screen.findByText(/console hors ligne/i)).toBeTruthy()
    expect(screen.getByText(/une entrée du catalogue est incomplète/i)).toBeTruthy()
  })
})
