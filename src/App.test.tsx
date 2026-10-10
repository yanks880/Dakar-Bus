// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/TransitMap', () => ({
  TransitMap: ({
    pickingPoint,
    onChoosePoint,
    publishedStops,
    recenterTo,
  }: {
    recenterTo: { lat: number; lng: number } | null
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
      <span data-testid="map-recenter">{recenterTo ? `${recenterTo.lat},${recenterTo.lng}` : ''}</span>
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

/**
 * Choisit un arrêt dans la barre de recherche du Trajet : l'index couvre les
 * mobilités et tous les arrêts déclarés de Dakar.
 */
function chooseStopInField(title: string, query: string, optionName: RegExp) {
  const input = screen.getByLabelText(new RegExp(`^${title} du trajet$`, 'i'))
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: query } })
  // Le sélecteur du planificateur avancé contient aussi des options : on se
  // limite à la liste déroulante du champ concerné.
  const listbox = screen.getByRole('listbox', { name: new RegExp(`${title} : arrêts et mobilités`, 'i') })
  fireEvent.click(within(listbox).getByRole('option', { name: optionName }))
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
      next_departure_at: null,
      departure_status: 'UNKNOWN',
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
  window.localStorage.clear()
  stubGeolocation()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** L’état de l’API de lecture n’est jamais affiché sur la carte : il vit dans
 *  l’onglet Paramètres, le seul centre d’état des API et d’aide. */
async function openReadApiState() {
  fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
  fireEvent.click(screen.getByText(/^état des données$/i))
  return screen.findByText(/snapshot publié servi|affichage vérifié/i)
}

/** La console d’administration locale est une section technique repliée par
 *  défaut dans Paramètres : on l’ouvre explicitement pour la vérifier. */
async function openLocalConsole() {
  fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
  fireEvent.click(await screen.findByRole('button', { name: /console d’administration locale/i }))
}

describe('Dakar Bus experience safety', () => {
  it('states that transit sources are not connected while nothing is published', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    await openReadApiState()
    expect(screen.getByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.getByText(/aucun arrêt, horaire ou tracé n’est simulé/i)).toBeTruthy()
    expect(screen.getByText(/^en attente$/i)).toBeTruthy()
    expect(screen.queryByText(/\bLIVE\b/i)).toBeNull()
    expect(screen.queryByText(/^0 min$/i)).toBeNull()
  })

  it('does not invent a reference route when the selected points are identical', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
      { match: '/api/journeys', respond: () => errorResponse(404, 'NOT_PUBLISHED') },
    ])
    render(<App />)
    await openReadApiState()
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))

    const pointButtons = screen.getAllByRole('button', { name: /choisir un point sur la carte/i })
    fireEvent.click(pointButtons[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[1])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))
    expect(await screen.findByText(/aucun trajet ter\/brt de référence trouvé/i)).toBeTruthy()
    expect(screen.getAllByText(/aucun jeu de transport publié/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/départ et la destination sont identiques/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^≈ \d+ min$/)).toBeNull()
  })

  it('uses the local TER/BRT planner on GitHub Pages when no journey API server exists', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
      { match: '/api/journeys', respond: () => ({ ok: false, status: 404, json: async () => { throw new Error('Pages 404 HTML') } }) },
    ])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    chooseStopInField('Départ', 'petersen', /petersen/i)
    chooseStopInField('Destination', 'mbaye', /keur mbaye fall/i)
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

    expect(await screen.findByRole('region', { name: 'Estimation de trajet TER/BRT' })).toBeTruthy()
    expect(screen.getByText(/serveur d’horaires est indisponible/i)).toBeTruthy()
    expect(screen.getByText(/≈ \d+ min/)).toBeTruthy()
    const estimate = screen.getByRole('region', { name: 'Estimation de trajet TER/BRT' })
    expect(estimate.textContent).toContain('Petersen')
    expect(estimate.textContent).toContain('Keur Mbaye Fall')
    expect(estimate.textContent).toMatch(/ce n’est ni un horaire, ni du temps réel/i)
  })

  it('says the read API is unreachable instead of falling back to fabricated data', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('réseau indisponible'))))
    render(<App />)

    await openReadApiState()
    expect(await screen.findByText(/l’api de lecture locale ne répond pas sur \/api/i)).toBeTruthy()
    expect(screen.queryByText(/arrêts publiés/i)).toBeNull()
    expect(screen.queryByText(/démo — yoff aéroport/i)).toBeNull()
  })

  it('keeps alert details tucked away and does not claim normal service', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /alertes/i }))

    expect(screen.getByText(/aucune alerte vérifiée pour le moment/i)).toBeTruthy()
    expect(screen.queryByText(/l’absence d’alerte ne garantit pas un service normal/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /voir les canaux officiels/i }))
    expect(screen.getByText(/l’absence d’alerte ne garantit pas un service normal/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'sentersa.sn' })).toBeTruthy()
  })
})

describe('isolation de la vue carte', () => {
  it('ne monte la carte Leaflet que sur l’onglet Explorer', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    expect(screen.getByLabelText('Carte de test')).toBeTruthy()
    expect(container.querySelector('.app-shell')?.className).not.toContain('is-map-hidden')

    for (const tab of [/trajet/i, /alertes/i, /paramètres/i]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      // La carte est démontée du DOM : plus de tuiles, plus de place occupée.
      expect(screen.queryByLabelText('Carte de test')).toBeNull()
      expect(container.querySelector('.app-shell')?.className).toContain('is-map-hidden')
    }

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    expect(screen.getByLabelText('Carte de test')).toBeTruthy()
    expect(container.querySelector('.app-shell')?.className).not.toContain('is-map-hidden')
  })

  it('n’affiche plus le slogan « La ville en mouvement »', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    expect(screen.queryByText(/la ville en mouvement/i)).toBeNull()
    expect(screen.queryByText(/votre ville, votre rythme/i)).toBeNull()
  })

  it('emmène choisir un point sur la carte puis ramène à l’itinéraire', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[0])

    // Choisir un point passe par l’onglet Explorer : la carte n’existe que là.
    expect(screen.getByLabelText('Carte de test')).toBeTruthy()
    expect(screen.getByText(/choisissez un point de départ sur la carte/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    // Retour automatique à l’itinéraire, point enregistré.
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.getByText('Point choisi sur la carte')).toBeTruthy()
  })

  it('réserve le statut de l’API de lecture à l’onglet Paramètres', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    // Onglet Explorer (carte) et Trajet : aucun panneau d’état d’API de lecture.
    expect(screen.queryByText(/affichage vérifié/i)).toBeNull()
    expect(screen.queryByText(/api de lecture/i)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    expect(screen.queryByText(/api de lecture/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
    expect(await screen.findByText(/affichage vérifié/i)).toBeTruthy()
    expect(screen.getByText(/api de lecture · snapshot publié/i)).toBeTruthy()
  })

  it('permet de choisir un arrêt connu directement depuis l’onglet Itinéraire', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    chooseStopInField('Départ', 'petersen', /petersen/i)
    chooseStopInField('Destination', 'guediawaye', /préfecture de guédiawaye/i)

    // Deux arrêts du réseau de référence suffisent : aucun passage par la carte.
    const submit = screen.getByRole('button', { name: /rechercher mon itinéraire/i }) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    expect(screen.queryByLabelText('Carte de test')).toBeNull()
  })
})

describe('structure en quatre piliers', () => {
  it('garde Explorer compact et déplace les détails techniques dans Paramètres', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    expect(screen.getByRole('region', { name: 'Réseaux de référence' })).toBeTruthy()
    // TER et BRT publient une fréquence : leur décompte est affiché et vivant.
    expect(document.querySelectorAll('.network-summary-dot.is-referenced')).toHaveLength(5)
    expect(document.querySelectorAll('.network-summary-dot.is-counting')).toHaveLength(2)
    expect(screen.getAllByText(/créneau \d{2}:\d{2} · \d+ min/)).toHaveLength(2)
    // DDD, AFTU et TATA ne publient pas de fréquence : rien n’est inventé.
    expect(screen.getAllByText('Non déclaré')).toHaveLength(3)
    expect(screen.queryByText(/décompte théorique · pas de temps réel/i)).toBeNull()
    expect(screen.queryByText(/vérification en ligne non documentée/i)).toBeNull()
    expect(screen.queryByText(/validité calendaire/i)).toBeNull()
    expect(screen.queryByText(/38 lignes · 400 bus/)).toBeNull()
    // Aucune affirmnation de temps réel : l’écran ne revendique jamais le direct.
    expect(document.querySelector('.is-live')).toBeNull()
    expect(screen.queryByText(/^LIVE$/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
    expect(screen.getByRole('region', { name: 'Fréquences et services de référence' })).toBeTruthy()
    expect(screen.getByText(/lun\.–sam\. \(hors jours fériés\) · 05:30–21:00 · 10 min/)).toBeTruthy()
    expect(screen.getByText(/38 lignes · 400 bus/)).toBeTruthy()
    expect(screen.getByText(/72 lignes · 2\s?300 bus · 14 GIE/)).toBeTruthy()
    expect(screen.getAllByText(/vérification en ligne non documentée/).length).toBeGreaterThanOrEqual(4)
    expect(screen.getByRole('link', { name: 'TER / SETER' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'CETUD / SunuBRT' })).toBeTruthy()
  })

  it('expose exactement quatre onglets, avec leurs rôles exclusifs', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual(['Explorer', 'Trajet', 'Alertes', 'Paramètres'])
    // Les anciens libellés ne doivent plus exister comme onglets.
    expect(screen.queryByRole('tab', { name: /^carte$/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /^itinéraire$/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /gouvernance/i })).toBeNull()
  })

  it('shows the map and destination guide only in Explorer', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    expect(screen.getByLabelText('Carte de test')).toBeTruthy()
    expect(screen.getByPlaceholderText('On va où ?')).toBeTruthy()
    expect(screen.getByRole('button', { name: /définir la maison sur la carte/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /définir le boulot sur la carte/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /définir une adresse sur la carte/i })).toBeTruthy()

    for (const tab of [/trajet/i, /alertes/i, /paramètres/i]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      expect(screen.queryByLabelText('Carte de test')).toBeNull()
      expect(screen.queryByPlaceholderText('On va où ?')).toBeNull()
      expect(screen.queryByRole('search')).toBeNull()
    }
  })

  it('keeps Trajet focused on the route form and hides the Explorer search field', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    expect(screen.queryByText(/résultats de recherche/i)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))

    expect(screen.getByRole('heading', { name: /planifier un trajet/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.queryByRole('search')).toBeNull()
    expect(screen.queryByText(/réseaux pris en charge/i)).toBeNull()
    expect(container.querySelector('.advanced-planner')?.hasAttribute('open')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    expect(screen.getByPlaceholderText('On va où ?')).toBeTruthy()
  })

  it('answers a question from the Explorer search and opens results in Trajet', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    const search = screen.getByLabelText(/rechercher un arrêt, une station ou une destination/i)
    fireEvent.change(search, { target: { value: 'liste des stations BRT' } })
    fireEvent.submit(search.closest('form')!)

    expect(await screen.findByText(/assistant mobilité/i)).toBeTruthy()
    // L’assistant énumère les 23 stations officielles, dans l’ordre.
    expect(screen.getByText(/1\. Petersen – Papa Gueye Fall/)).toBeTruthy()
    expect(screen.getByText(/23\. Préfecture de Guédiawaye/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.queryByRole('search')).toBeNull()
  })

  it('range l’aide, les CGU, l’historique et la console technique dans Paramètres', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    expect(screen.queryByText(/mode d’emploi/i)).toBeNull()
    expect(screen.queryByRole('heading', { name: /conditions d’utilisation/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /mises à jour/i })).toBeNull()
    expect(screen.queryByText(/console d’administration locale/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    expect((await screen.findAllByText(/mode d’emploi/i)).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText(/^conditions d’utilisation$/i))
    expect(screen.getByRole('heading', { name: /conditions d’utilisation/i })).toBeTruthy()
    expect(screen.getByText(/aucune donnée temps réel \(position de véhicule, retard constaté\)/i)).toBeTruthy()
    expect(screen.getByText(/jamais transmise à un tiers/i)).toBeTruthy()
    fireEvent.click(screen.getByText(/^mises à jour$/i))
    expect(screen.getByRole('heading', { name: /mises à jour/i })).toBeTruthy()
    // La console technique est repliée : le catalogue n’est pas interrogé tant
    // que l’utilisateur ne l’ouvre pas.
    expect(screen.queryByText(/catalogue local vérifié/i)).toBeNull()
    expect(screen.queryByText(/console hors ligne/i)).toBeNull()
  })
})

describe('published snapshot in the app', () => {
  it('shows the published snapshot, its provenance and its theoretical stops', async () => {
    publishedApi()
    render(<App />)

    await openReadApiState()
    expect(screen.getByText(/^snapshot publié servi$/i)).toBeTruthy()
    expect(screen.getByText(/^publié$/i)).toBeTruthy()
    expect(screen.getByText(/démonstration locale · version demo-2026-10/i)).toBeTruthy()
    expect(screen.getByText(/horaires théoriques, aucune position de véhicule/i)).toBeTruthy()
    expect(screen.queryByText(/aucune source de transport n’est encore reliée/i)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    expect(screen.getByPlaceholderText('On va où ?')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
    expect(await screen.findByText(/^L1 · Démo — Plateau ↔ Yoff$/)).toBeTruthy()
    expect(screen.getByText(/démo — médina ↔ guédiawaye/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))

    fireEvent.click(screen.getAllByRole('button', { name: /me localiser/i })[0])
    expect(await screen.findByText('Démo — Plateau Sud')).toBeTruthy()
    expect(screen.getByText(/à 24 m/)).toBeTruthy()
    expect(screen.getByTestId('mapped-stops').textContent).toBe('Démo — Plateau Sud | Démo — Yoff Aéroport')
  })

  it('opens a stop card with the lines and the theoretical window, then uses it as a destination', async () => {
    publishedApi()
    render(<App />)
    await openReadApiState()
    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))

    const search = screen.getByLabelText(/rechercher un arrêt, une station ou une destination/i)
    fireEvent.change(search, { target: { value: 'yoff' } })
    fireEvent.submit(search.closest('form')!)

    expect(await screen.findByText('Démo — Yoff Aéroport')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /démo — yoff aéroport/i }))

    expect(await screen.findByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeTruthy()
    expect(screen.getByText(/07:05:00 → 07:20:00/)).toBeTruthy()
    expect(screen.getByText(/ni une position, ni un temps réel/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /partir d’ici/i }))
    // Le point de départ reprend l’arrêt publié et ses coordonnées déclarées.
    expect(await screen.findByText(/14\.7480, -17\.4900 · arrêt publié/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /aller ici/i }))
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))
    expect(await screen.findByText(/horaires théoriques déclarés/i)).toBeTruthy()
    expect(screen.queryByText(/moteur d’itinéraires pas encore en place/i)).toBeNull()
  })

  it('proposes only declared direct rides, with their theoretical times', async () => {
    const fetchMock = publishedApi()
    render(<App />)
    await openReadApiState()

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    expect(await screen.findByText('14.7051, -17.4602')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    const search = screen.getByLabelText(/rechercher un arrêt, une station ou une destination/i)
    fireEvent.change(search, { target: { value: 'yoff' } })
    fireEvent.submit(search.closest('form')!)
    fireEvent.click(await screen.findByRole('button', { name: /démo — yoff aéroport/i }))
    fireEvent.click(await screen.findByRole('button', { name: /aller ici/i }))

    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

    expect(await screen.findByText(/horaires théoriques déclarés/i)).toBeTruthy()
    expect(screen.getAllByText(/1 course directe/i).length).toBeGreaterThan(0)
    expect(screen.getByText('06:00')).toBeTruthy()
    expect(screen.getByText('06:42')).toBeTruthy()
    expect(screen.getByText(/≈ 42 min/)).toBeTruthy()
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

  it('actualise le compte à rebours programmé sans recharger et nettoie son timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
    const scheduledPayload = {
      ...JOURNEYS_PAYLOAD,
      requested_at: '2026-10-08T12:00:00.000Z',
      results: [{
        ...JOURNEYS_PAYLOAD.results[0],
        board: { ...JOURNEYS_PAYLOAD.results[0].board, departure: '12:05:01' },
        alight: { ...JOURNEYS_PAYLOAD.results[0].alight, arrival: '12:47:01' },
        next_departure_at: '2026-10-08T12:05:01Z',
        departure_status: 'SCHEDULED',
      }],
    }
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
      { match: '/api/journeys', respond: () => jsonResponse(scheduledPayload) },
    ])
    const view = render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[1])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText(/Départ programmé dans 6 min/)).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(screen.getByText(/Départ programmé dans 5 min/)).toBeTruthy()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('explains the absence of a direct ride without proposing a detour', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      { match: '/api/journeys', respond: () => jsonResponse(JOURNEYS_NO_RIDE) },
    ])
    render(<App />)
    await openReadApiState()

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    // Le départ est déjà la position GPS : c’est donc le champ Destination
    // (deuxième bouton) que l’on désigne sur la carte.
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[1])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

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
    await openReadApiState()

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    // Le départ est déjà la position GPS : c’est donc le champ Destination
    // (deuxième bouton) que l’on désigne sur la carte.
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[1])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

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
    await openReadApiState()

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    fireEvent.click(screen.getByRole('button', { name: /utiliser ma position comme départ/i }))
    // Le départ est déjà la position GPS : c’est donc le champ Destination
    // (deuxième bouton) que l’on désigne sur la carte.
    fireEvent.click(screen.getAllByRole('button', { name: /choisir un point sur la carte/i })[1])
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))

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

    await openReadApiState()
    expect(screen.getByText(/ne couvre pas aujourd’hui/i)).toBeTruthy()
    expect(screen.getByText(/rien n’est affiché comme actuel/i)).toBeTruthy()
    expect(screen.getByText(/^période dépassée$/i)).toBeTruthy()
    expect(screen.queryByText(/démo — plateau sud/i)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
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
    await openReadApiState()

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /me localiser/i })[0])
    fireEvent.click(await screen.findByRole('button', { name: /démo — yoff aéroport/i }))
    expect(await screen.findByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeTruthy()
    expect(screen.getByTestId('mapped-stops').textContent).toContain('Démo — Yoff Aéroport')

    // The publication is withdrawn server-side: refreshing must drop the view
    // instead of keeping a snapshot that is no longer served.
    published = false
    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
    fireEvent.click(screen.getByRole('button', { name: /actualiser l’état de publication/i }))

    expect(await screen.findByText(/aucune source de transport n’est encore reliée/i)).toBeTruthy()
    expect(screen.queryByRole('region', { name: /arrêt démo — yoff aéroport/i })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    expect(screen.getByTestId('mapped-stops').textContent).toBe('')
    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    fireEvent.click(screen.getByText(/^état des données$/i))
    expect(screen.getByText(/aucune donnée publiée à explorer/i)).toBeTruthy()
  })

  it('keeps the map at the top and makes saved destinations useful for routing', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    expect(container.querySelector('.app-shell')?.className).toContain('tab-explore')
    expect(container.querySelector('.map-stage')).toBeTruthy()
    expect(container.querySelector('.destination-shortcuts-row')?.children).toHaveLength(3)
    expect(screen.getByPlaceholderText('On va où ?')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /définir la maison sur la carte/i }))
    expect(container.querySelector('.map-pick-banner')?.textContent).toMatch(/touchez la carte pour définir maison/i)
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.getByText('Maison')).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem('dakar-bus:destinations') ?? '{}').home).toMatchObject({
      lat: 14.7001,
      lng: -17.4502,
    })

    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    fireEvent.click(screen.getByRole('button', { name: /rentrer à la maison/i }))
    expect(screen.getByRole('tab', { name: /^trajet$/i }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Maison')).toBeTruthy()
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
    await openLocalConsole()

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
    await openLocalConsole()

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
    await openLocalConsole()

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
    await openLocalConsole()

    expect(await screen.findByText(/console hors ligne/i)).toBeTruthy()
    expect(screen.getByText(/une entrée du catalogue est incomplète/i)).toBeTruthy()
  })
})

describe('décomptes dynamiques de l’Explorer', () => {
  it('fait descendre en temps réel le décompte des réseaux de référence', async () => {
    vi.useFakeTimers()
    // Jeudi 8 octobre 2026, 12:00 UTC : BRT toutes les 6 min, TER toutes les 10 min.
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    // Deux réseaux publient une fréquence officielle : deux décomptes vivants.
    expect(document.querySelectorAll('.network-summary-dot.is-counting')).toHaveLength(2)
    expect(screen.getByText('6 min')).toBeTruthy()
    expect(screen.getByText('10 min')).toBeTruthy()
    expect(screen.getByText(/créneau 12:06 · 6 min/)).toBeTruthy()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })

    // Le temps a passé : les minutes ont diminué, sans rechargement.
    expect(screen.getByText('5 min')).toBeTruthy()
    expect(screen.getByText('9 min')).toBeTruthy()
  })

  it('place « Mes destinations » au-dessus des réseaux de référence', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    const destinations = container.querySelector('.destination-shortcuts')
    const networks = container.querySelector('.network-summary-section')
    expect(destinations).toBeTruthy()
    expect(networks).toBeTruthy()
    // DOCUMENT_POSITION_FOLLOWING : les réseaux suivent les destinations dans le DOM.
    expect(destinations!.compareDocumentPosition(networks!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('déclenche une micro-interaction et un retour haptique lors de la sélection d’un réseau', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const vibrateMock = vi.fn(() => true)
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrateMock })
    const { container } = render(<App />)

    const terItem = container.querySelector('.network-item-ter') as HTMLElement
    expect(terItem).toBeTruthy()
    expect(terItem.classList.contains('is-selected')).toBe(false)

    const terHeader = terItem.querySelector('.network-summary-header') as HTMLElement
    fireEvent.click(terHeader)
    expect(vibrateMock).toHaveBeenCalledWith(12)
    expect(terItem.classList.contains('is-selected')).toBe(true)
    expect(terItem.querySelector('.network-summary-detail')?.textContent).toMatch(/Dakar ↔ Diamniadio/i)

    // Toucher le contenu déplié ne replie pas l'accordéon.
    fireEvent.click(terItem.querySelector('.station-board-head')!)
    expect(terItem.classList.contains('is-selected')).toBe(true)

    fireEvent.click(terHeader)
    expect(terItem.classList.contains('is-selected')).toBe(false)
  })

  it('n’émet aucun recentrage de carte à l’ouverture du volet TER, seulement au choix d’une gare', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)
    const recenter = () => screen.getByTestId('map-recenter').textContent

    expect(recenter()).toBe('')
    fireEvent.click(container.querySelector('.network-item-ter .network-summary-header')!)
    expect(recenter()).toBe('')
    fireEvent.click(container.querySelector('.network-item-brt .network-summary-header')!)
    expect(recenter()).toBe('')

    fireEvent.click(container.querySelector('.network-item-ter .network-summary-header')!)
    fireEvent.click(within(container.querySelector('.station-board') as HTMLElement).getAllByText('Colobane')[0])
    expect(recenter()).not.toBe('')
  })

  it('décline les créneaux TER station par station et sens par sens', async () => {
    vi.useFakeTimers()
    // Jeudi 8 octobre 2026, 12:00 UTC : grille TER de 10 min en service.
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    fireEvent.click(container.querySelector('.network-item-ter .network-summary-header')!)

    const board = container.querySelector('.station-board') as HTMLElement
    expect(board).toBeTruthy()
    // Deux sections distinctes, chacune avec les 13 gares empilées.
    const outbound = board.querySelector('.station-direction-outbound') as HTMLElement
    const inbound = board.querySelector('.station-direction-inbound') as HTMLElement
    expect(outbound.querySelectorAll('.station-board-row')).toHaveLength(13)
    expect(inbound.querySelectorAll('.station-board-row')).toHaveLength(13)
    expect(within(outbound).getByText('Colobane')).toBeTruthy()
    expect(within(outbound).getByText('Dalifort')).toBeTruthy()

    // La direction est explicite, avec les terminus.
    expect(outbound.querySelector('.station-direction-kicker')!.textContent).toMatch(/Direction Aller/)
    expect(outbound.querySelector('.station-direction-route')!.textContent).toBe('Dakar ➔ Diamniadio')
    expect(inbound.querySelector('.station-direction-kicker')!.textContent).toMatch(/Direction Retour/)
    expect(inbound.querySelector('.station-direction-route')!.textContent).toBe('Diamniadio ➔ Dakar')

    // Aller : Dakar en tête, Diamniadio en dernier ; retour : ordre inversé.
    const outRows = [...outbound.querySelectorAll('.station-board-row')]
    const inRows = [...inbound.querySelectorAll('.station-board-row')]
    expect(outRows[0].textContent).toMatch(/^Dakar/)
    expect(inRows[0].textContent).toMatch(/^Diamniadio/)

    // Une gare intermédiaire : un créneau isolé par sens, au format du résumé.
    const colobaneOut = outRows.find((row) => row.textContent!.includes('Colobane'))!
    const colobaneIn = inRows.find((row) => row.textContent!.includes('Colobane'))!
    expect(colobaneOut.querySelectorAll('.station-board-passage:not(.is-undeclared)')).toHaveLength(1)
    expect(colobaneOut.textContent).toMatch(/créneau 12:03 · 10 min/)
    expect(colobaneIn.textContent).toMatch(/créneau 12:04 · 10 min/)

    // Au terminus d'arrivée de chaque sens, aucun départ : c'est dit, pas inventé.
    expect(outRows[outRows.length - 1].textContent).toMatch(/Terminus/)
    expect(inRows[inRows.length - 1].textContent).toMatch(/Terminus/)

    // Toucher une gare ne replie pas le tableau.
    fireEvent.click(within(outbound).getByText('Colobane'))
    expect(container.querySelector('.network-item-ter')!.classList.contains('is-selected')).toBe(true)
    expect(container.querySelectorAll('.station-board-row')).toHaveLength(26)

    const colobaneTimes = () => [colobaneOut, colobaneIn].map((row) => row.querySelector('.station-board-passage > strong')!.textContent)
    // Les créneaux par station descendent au même rythme que les réseaux.
    // (Avancement par pas : chaque tic réarme le suivant après le rendu.)
    expect(colobaneTimes()).toEqual(['4 min', '5 min'])
    for (let step = 0; step < 20; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })
    }
    expect(colobaneTimes()).toEqual(['3 min', '4 min'])
    vi.useRealTimers()
  })

  it('affiche les 23 stations du BRT dans les deux sens, de Petersen à Guédiawaye', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    fireEvent.click(container.querySelector('.network-item-brt .network-summary-header')!)

    const board = container.querySelector('.station-board') as HTMLElement
    expect(board).toBeTruthy()
    expect(board.querySelectorAll('.station-direction-outbound .station-board-row')).toHaveLength(23)
    expect(board.querySelectorAll('.station-direction-inbound .station-board-row')).toHaveLength(23)
    expect(board.querySelector('.station-direction-outbound .station-direction-route')!.textContent).toBe('Petersen ➔ Guédiawaye')
    expect(board.querySelector('.station-direction-inbound .station-direction-route')!.textContent).toBe('Guédiawaye ➔ Petersen')

    // Une station intermédiaire (près de Colobane) : deux créneaux au format du résumé.
    const placeNation = [...board.querySelectorAll('.station-direction-outbound .station-board-row')].find((row) => row.textContent!.includes('Place de la Nation'))!
    expect(placeNation.querySelectorAll('.station-board-passage:not(.is-undeclared)')).toHaveLength(1)
    expect(placeNation.textContent).toMatch(/créneau \d{2}:\d{2} · 6 min/)
    vi.useRealTimers()
  })

  it('prépare la structure AFTU et TATA sans inventer d’horaire', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    for (const network of ['aftu', 'tata']) {
      fireEvent.click(container.querySelector(`.network-item-${network} .network-summary-header`)!)
      const detail = container.querySelector(`.network-item-${network} .network-summary-detail`) as HTMLElement
      expect(detail).toBeTruthy()
      // Aucune station, aucun créneau : la structure attend les lignes publiées.
      expect(detail.querySelector('.station-board')).toBeNull()
      expect(detail.textContent).toMatch(/aucune ligne (AFTU|TATA) n’est encore publiée/i)
      expect(detail.textContent).toMatch(/dès qu’une ligne sera disponible/i)
      expect(detail.textContent).toMatch(/aucun horaire n’est inventé/i)
    }
  })

  it('bascule élégamment entre le mode clair et le mode sombre adaptatif', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    const { container } = render(<App />)

    const toggle = screen.getByRole('button', { name: /passer au mode sombre/i })
    expect(container.querySelector('.app-shell')?.classList.contains('theme-light')).toBe(true)

    fireEvent.click(toggle)
    expect(container.querySelector('.app-shell')?.classList.contains('theme-dark')).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('dakar-bus:theme')).toBe('dark')

    const backToLight = screen.getByRole('button', { name: /passer au mode clair/i })
    fireEvent.click(backToLight)
    expect(container.querySelector('.app-shell')?.classList.contains('theme-light')).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
})

describe('barre de recherche du Trajet', () => {
  it('couvre toutes les mobilités et tous les arrêts déclarés de Dakar', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))

    const input = screen.getByLabelText(/^départ du trajet$/i)
    fireEvent.focus(input)
    const list = screen.getByRole('listbox', { name: /départ : arrêts et mobilités/i })

    // Chaque mobilité est trouvable par son sigle comme par son autorité.
    for (const [query, expected] of [
      ['aftu', /AFTU/],
      ['cetud', /DDD/],
      ['senter', /TER/],
      ['sunubrt', /BRT/],
      ['dakar dem dikk', /DDD/],
      ['tata', /TATA/],
    ] as const) {
      fireEvent.change(input, { target: { value: query } })
      expect(within(list).getAllByRole('option').length).toBeGreaterThan(0)
      expect(within(list).getByRole('option', { name: expected })).toBeTruthy()
    }

    // Les arrêts déclarés aussi : gares TER et stations BRT.
    fireEvent.change(input, { target: { value: 'guediawaye' } })
    expect(within(list).getByRole('option', { name: /Préfecture de Guédiawaye/ })).toBeTruthy()
    fireEvent.change(input, { target: { value: 'thiaroye' } })
    expect(within(list).getByRole('option', { name: /Thiaroye/ })).toBeTruthy()
  })

  it('explique au lieu d’inventer quand un réseau n’a aucun arrêt déclaré', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))

    const input = screen.getByLabelText(/^départ du trajet$/i)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'aftu' } })
    const list = screen.getByRole('listbox', { name: /départ : arrêts et mobilités/i })
    fireEvent.click(within(list).getByRole('option', { name: /AFTU/ }))

    // Aucun point n’est créé : le réseau dit pourquoi il n’est pas utilisable.
    expect(screen.getByText(/aucun arrêt n’est inventé/i)).toBeTruthy()
    expect(screen.getByLabelText(/^départ du trajet$/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toHaveProperty('disabled', true)
  })

  it('affiche durée, correspondances et prochain départ avec son point vert', async () => {
    stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_PUBLISHED) },
      { match: '/api/routes', respond: () => jsonResponse(ROUTES_PAYLOAD) },
      { match: '/api/stops/near', respond: () => jsonResponse(NEARBY_PAYLOAD) },
      {
        match: '/api/journeys',
        respond: () =>
          jsonResponse({
            ...JOURNEYS_PAYLOAD,
            requested_at: '2026-10-08T12:00:00.000Z',
            results: [{ ...JOURNEYS_PAYLOAD.results[0], next_departure_at: '2026-10-08T12:06:00Z', departure_status: 'SCHEDULED' }],
          }),
      },
    ])
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
    render(<App />)

    fireEvent.click(screen.getByRole('tab', { name: /^trajet$/i }))
    chooseStopInField('Départ', 'petersen', /petersen/i)
    chooseStopInField('Destination', 'guediawaye', /préfecture de guédiawaye/i)
    fireEvent.click(screen.getByRole('button', { name: /rechercher mon itinéraire/i }))
    await act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
    })

    expect(screen.getByText(/≈ 42 min/)).toBeTruthy()
    expect(screen.getByText(/sans correspondance/i)).toBeTruthy()
    expect(screen.getByText(/départ programmé dans 6 min/i)).toBeTruthy()
    expect(document.querySelectorAll('.journey-countdown .live-dot')).toHaveLength(1)
  })
})

describe('Direct rue', () => {
  function openStreetView() {
    fireEvent.click(screen.getByRole('tab', { name: /alertes/i }))
    fireEvent.click(screen.getByRole('button', { name: /direct rue/i }))
  }

  it('reste séparé des alertes officielles et dit ce qu’il est', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    openStreetView()
    expect(screen.getByText(/signalements d’usagers, non vérifiés/i)).toBeTruthy()
    expect(screen.getByText(/aucun signalement actif/i)).toBeTruthy()
    // Les canaux officiels restent dans la vue « Alertes officielles ».
    expect(screen.queryByText(/aucune alerte vérifiée pour le moment/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /alertes officielles/i }))
    expect(screen.getByText(/aucune alerte vérifiée pour le moment/i)).toBeTruthy()
  })

  it('publie un signalement local, le conserve et permet de le retirer', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    openStreetView()

    // La portion de route est obligatoire : rien n’est publié sans elle.
    fireEvent.click(screen.getByRole('button', { name: /publier le signalement/i }))
    expect(screen.getByRole('alert').textContent).toMatch(/portion de route/i)

    fireEvent.change(screen.getByLabelText(/portion de route/i), { target: { value: 'Patte d’Oie → Aéroport' } })
    fireEvent.click(screen.getByRole('button', { name: /^Embouteillage$/ }))
    fireEvent.change(screen.getByLabelText(/réseau concerné/i), { target: { value: 'ddd' } })
    fireEvent.change(screen.getByLabelText(/précision/i), { target: { value: 'File ininterrompue' } })
    fireEvent.click(screen.getByRole('button', { name: /publier le signalement/i }))

    expect(await screen.findByText('Patte d’Oie → Aéroport')).toBeTruthy()
    expect(screen.getByText('File ininterrompue')).toBeTruthy()
    expect(screen.getAllByText(/embouteillage/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText('DDD').length).toBeGreaterThan(0)
    expect(screen.getByText(/à l’instant/)).toBeTruthy()
    expect(screen.getAllByText(/non vérifié/).length).toBeGreaterThan(0)

    // Local à l’appareil : seul le stockage du navigateur est écrit.
    const stored = JSON.parse(window.localStorage.getItem('dakar-bus:street-reports') ?? '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ place: 'Patte d’Oie → Aéroport', networkId: 'ddd', source: 'COMMUNITY' })
    expect(screen.getByRole('button', { name: /direct rue/i }).textContent).toContain('1')

    fireEvent.click(screen.getByRole('button', { name: /retirer le signalement/i }))
    expect(screen.getByText(/aucun signalement actif/i)).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem('dakar-bus:street-reports') ?? '[]')).toHaveLength(0)
  })
})

describe('boutons : une action va jusqu’au bout', () => {
  it('ouvre le mode d’emploi depuis le badge Dakar Bus', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /à propos de dakar bus/i }))
    expect(screen.getByRole('tab', { name: /paramètres/i }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText(/mode d’emploi/i).length).toBeGreaterThan(0)
  })

  it('lance le calcul jusqu’au bout depuis un raccourci enregistré', async () => {
    const fetchMock = stubApi([
      { match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) },
      { match: '/api/journeys', respond: () => jsonResponse(JOURNEYS_NO_RIDE) },
    ])
    render(<App />)

    // Enregistrer « Maison » sur la carte.
    fireEvent.click(screen.getByRole('button', { name: /définir la maison sur la carte/i }))
    fireEvent.click(screen.getByRole('button', { name: /choisir le point actif sur la carte/i }))

    // Le raccourci part de la position connue et calcule sans clic supplémentaire.
    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^ma position$/i }))
    fireEvent.click(screen.getByRole('button', { name: /rentrer à la maison/i }))
    expect(screen.getByRole('tab', { name: /^trajet$/i }).getAttribute('aria-selected')).toBe('true')
    expect((await screen.findAllByText(/aucune course directe déclarée/i)).length).toBeGreaterThan(0)
    expect(fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.startsWith('/api/journeys'))).toBe(true)
  })
})


describe('copilote et comparateur sur les parcours existants', () => {
  it('préremplit Trajet depuis une question explicite et montre les alternatives sans tarif inventé', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    const search = screen.getByLabelText(/rechercher un arrêt, une station ou une destination/i)
    fireEvent.change(search, { target: { value: 'Compare les trajets de Préfecture de Guédiawaye à Rufisque, moins de marche' } })
    fireEvent.submit(search.closest('form')!)
    expect(await screen.findByText(/Copilote · Préfecture de Guédiawaye/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /comparer les options TER\/BRT/i }))
    const comparison = screen.getByRole('region', { name: /comparaison des itinéraires TER\/BRT/i })
    expect(within(comparison).getByText(/Option 2/)).toBeTruthy()
    expect(within(comparison).getByText(/Prix non comparés/)).toBeTruthy()
    expect(within(comparison).getByText(/horaires ne sont pas mélangés/)).toBeTruthy()
  })

  it('ouvre Trajet depuis le chat sans changer les autres réponses', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'trajet de Petersen à Rufisque' } })
    fireEvent.submit(input.closest('form')!)
    // La réponse asynchrone doit être visible avant l'action « Ouvrir dans Trajet ».
    await screen.findByText(/Itinéraire de référence Petersen/i)
    fireEvent.click(screen.getByRole('button', { name: /ouvrir dans Trajet/i }))
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /comparer les options TER\/BRT/i })).toBeTruthy()
  })
})

describe('fenêtre du copilote : questions et réponses visibles', () => {
  it('affiche une fiche bus sourcée sans créer un faux trajet TER/BRT', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Assistant IA' }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'Itinéraire AFTU 53' } })
    fireEvent.submit(input.closest('form')!)
    const panel = screen.getByRole('region', { name: /assistant mobilité/i })
    expect(await within(panel).findByText(/AFTU 53 : Keur Massar/)).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: /ouvrir dans trajet/i })).toBeNull()
    const summary = within(panel).getByText('Sources et date de consultation')
    expect(summary.closest('details')?.open).toBe(false)
    fireEvent.click(summary)
    expect(within(panel).getByRole('link', { name: 'aftu-senegal.org' }).getAttribute('href')).toBe('https://aftu-senegal.org/map/dakar-urbain-ligne-53/')
    fireEvent.change(input, { target: { value: 'Et ses horaires ?' } })
    fireEvent.submit(input.closest('form')!)
    expect(await within(panel).findByText(/Aucun prochain départ fiable/)).toBeTruthy()
  })

  it('reste dans l’en-tête, ouvre un échange vide et rend le focus avec Échap', () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    const toggle = screen.getByRole('button', { name: /assistant IA/i })
    expect(toggle.closest('.brand-row')).not.toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('log').textContent).toBe('')
    expect(screen.queryByRole('button', { name: 'Trajet de Petersen à Rufisque' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /votre question à l’assistant/i }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /assistant mobilité/i })).toBeNull()
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(screen.getByRole('tab', { name: /paramètres/i }))
    expect(screen.getByRole('button', { name: /assistant IA/i })).toBe(toggle)
    fireEvent.click(toggle)
    expect(screen.getByRole('region', { name: /assistant mobilité/i })).toBeTruthy()
  })

  it('une question affiche la réponse dans le panneau, sans double envoi', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'Trajet de Petersen à Rufisque' } })
    fireEvent.submit(input.closest('form')!)
    // Un second envoi avant la réponse ne duplique pas la question.
    fireEvent.submit(input.closest('form')!)
    const panel = screen.getByRole('region', { name: /assistant mobilité/i })
    const log = within(panel).getByRole('log')
    expect(within(log).getAllByText('Trajet de Petersen à Rufisque')).toHaveLength(1)
    expect(within(log).getByText(/L’assistant consulte les données/i)).toBeTruthy()
    expect(await within(log).findByText(/Itinéraire de référence Petersen/i)).toBeTruthy()
    expect(within(log).queryByText(/L’assistant consulte les données/i)).toBeNull()
  })

  it('la question « prochain BRT » reçoit une réponse honnête dans le panneau', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'Quel est le prochain BRT vers Guédiawaye ?' } })
    fireEvent.submit(input.closest('form')!)
    const panel = screen.getByRole('region', { name: /assistant mobilité/i })
    const log = within(panel).getByRole('log')
    expect(await within(log).findByText(/fréquence officielle de référence du BRT/i)).toBeTruthy()
    expect(within(log).queryByText(/aucune heure de prochain passage fiable/i)).toBeTruthy()
  })

  it('« Ouvrir dans Trajet » injecte le trajet sans fermer la fenêtre', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'trajet de Petersen à Rufisque' } })
    fireEvent.submit(input.closest('form')!)
    await screen.findByText(/Itinéraire de référence Petersen/i)
    fireEvent.click(screen.getByRole('button', { name: /ouvrir dans Trajet/i }))
    // L'onglet Trajet est actif ET la fenêtre reste ouverte (état conservé).
    expect(screen.getByRole('button', { name: /rechercher mon itinéraire/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /assistant IA/i }).getAttribute('aria-expanded')).toBe('true')
    // De retour dans Explorer, la conversation est toujours là.
    fireEvent.click(screen.getByRole('tab', { name: /^explorer$/i }))
    expect(screen.getByRole('region', { name: /assistant mobilité/i })).toBeTruthy()
    expect(screen.getAllByText(/Itinéraire de référence Petersen/i).length).toBeGreaterThan(0)
  })

  it('la saisie manuelle envoie une seule fois et fait défiler vers la réponse', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'liste des gares TER' } })
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    const panel = screen.getByRole('region', { name: /assistant mobilité/i })
    expect(within(panel).getAllByText('liste des gares TER')).toHaveLength(1)
    expect(await within(panel).findByText(/Les 13 gares et haltes du TER/i)).toBeTruthy()
    expect(within(panel).getByRole('log')).toBeTruthy()
  })

  it('sans reconnaissance vocale, le micro explique le repli écrit au lieu de simuler', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    fireEvent.click(screen.getByRole('button', { name: /poser la question par la voix/i }))
    expect(await screen.findByText(/reconnaissance vocale n’est pas disponible/i)).toBeTruthy()
  })

  it('sans synthèse vocale, le bouton d’écoute explique la limite sans bloquer le chat', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'bonjour' } })
    fireEvent.submit(input.closest('form')!)
    const voices = await screen.findAllByRole('button', { name: /écouter la réponse/i })
    fireEvent.click(voices[0])
    expect(await screen.findByText(/synthèse vocale n’est pas disponible/i)).toBeTruthy()
    expect(screen.getByRole('region', { name: /assistant mobilité/i })).toBeTruthy()
  })

  it('le choix de langue de réponse persiste et la conversation est conservée', async () => {
    stubApi([{ match: '/api/network', respond: () => jsonResponse(NETWORK_EMPTY) }])
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /assistant IA/i }))
    fireEvent.click(screen.getByText('Langue'))
    fireEvent.click(screen.getByRole('button', { name: 'WO', hidden: false }))
    expect(window.localStorage.getItem('dakar-bus:assistant-language')).toBe('wo')
    const input = screen.getByRole('textbox', { name: /votre question à l’assistant/i })
    fireEvent.change(input, { target: { value: 'trajet de Petersen à Rufisque' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText(/Yoon wi/i)).toBeTruthy()
  })
})
