import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  Bell,
  BusFront,
  ChevronDown,
  CircleAlert,
  Compass,
  Database,
  FileCheck2,
  Footprints,
  History,
  Info,
  Lock,
  LayoutPanelLeft,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Minus,
  Navigation,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Search,
  ShieldCheck,
  TrainFront,
  X,
} from 'lucide-react'
import { TransitMap, type Coordinates, type RoutePointKey, type UserLocation } from './components/TransitMap'
import {
  declaredClockLabel,
  formatJourneyDate,
  journeyRouteLabel,
  parseJourneysPayload,
  walkSummary,
  type Journey,
  type JourneySearch,
} from './domain/journeys'
import { NETWORK_SOURCES, getConnectedNetworkCount, type NetworkId, type NetworkSource } from './domain/network'
import { ConsolePanel } from './Console'
import {
  describeRouteType,
  formatDistance,
  isCurrentSnapshot,
  parseNetworkPayload,
  parseRoutesPayload,
  parseStopDetailPayload,
  parseStopsPayload,
  publicationStatusLabel,
  publishedValidityLabel,
  routeDisplayName,
  type PublishedNetwork,
  type PublishedRoute,
  type PublishedStop,
  type PublishedStopDetail,
} from './domain/published'
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
  type PipelineSummary,
} from './domain/review'
import './App.css'

type TabId = 'map' | 'route' | 'explore' | 'alerts' | 'governance'
type GovernanceStatus = 'idle' | 'loading' | 'ready' | 'offline'
type PublishedStatus = 'idle' | 'loading' | 'ready' | 'error'
type LayoutMode = 'map' | 'split'

interface GovernanceState {
  status: GovernanceStatus
  datasets: CatalogDataset[]
  pipeline: PipelineSummary | null
  error: string | null
}

interface PublishedState {
  status: PublishedStatus
  network: PublishedNetwork | null
  error: string | null
}

interface NearbyState {
  status: PublishedStatus
  stops: PublishedStop[]
  radius: number
  error: string | null
}

interface LinesState {
  status: PublishedStatus
  routes: PublishedRoute[]
  error: string | null
}

interface StopSearchState {
  status: PublishedStatus
  query: string
  stops: PublishedStop[]
  error: string | null
}

interface JourneyState {
  status: PublishedStatus
  search: JourneySearch | null
  error: string | null
  errorCode: string | null
}

const IDLE_JOURNEY: JourneyState = { status: 'idle', search: null, error: null, errorCode: null }
type GpsState = 'idle' | 'loading' | 'ready' | 'denied' | 'error'
type MapPoint = Coordinates & { label: string; kind?: 'map' | 'stop'; stopId?: string }

const NEARBY_RADIUS_M = 1500
/** Walking radius asked from the routing API: declared links only, never a shortcut. */
const ROUTE_MAX_WALK_M = 900
const LAYOUT_STORAGE_KEY = 'dakar-bus:layout'

type ApiResult = { ok: true; payload: unknown } | { ok: false; status: number; code: string | null }

/** The browser only ever calls relative URLs; Vite relays /api to the local API. */
async function fetchApi(path: string): Promise<ApiResult> {
  try {
    const response = await fetch(path, { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      let code: string | null = null
      try {
        const body: unknown = await response.json()
        if (body && typeof body === 'object' && 'error' in body) {
          const candidate = (body as { error: unknown }).error
          if (typeof candidate === 'string') code = candidate
        }
      } catch {
        code = null
      }
      return { ok: false, status: response.status, code }
    }
    return { ok: true, payload: await response.json() }
  } catch {
    return { ok: false, status: 0, code: null }
  }
}

/** Honest wording for every refusal the routing API can return. */
function journeyErrorMessage(code: string | null): string {
  switch (code) {
    case 'NOT_PUBLISHED':
      return 'Aucun jeu de transport publié : aucun itinéraire ne peut être calculé.'
    case 'GRAPH_UNAVAILABLE':
      return 'Le graphe d’itinéraires n’est pas construit pour le snapshot publié. Reconstruisez-le avec « npm run graph:build » : aucun trajet n’est deviné en attendant.'
    case 'PLACE_NOT_FOUND':
      return 'Aucun arrêt publié ne correspond à ce point. Choisissez un arrêt publié ou un point sur la carte : aucun lieu n’est deviné.'
    case 'PLACE_UNUSABLE':
      return 'Ce lieu publié n’a pas de coordonnées déclarées : il ne peut pas servir de point de départ ou d’arrivée.'
    case 'INVALID_QUERY':
      return 'Demande incomplète : choisissez un départ et une destination, puis relancez la recherche.'
    default:
      return 'Le calcul d’itinéraire n’a pas répondu. Réessayez : aucune course n’est affichée sans réponse du serveur.'
  }
}

function readStoredLayout(): LayoutMode {
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
    return stored === 'split' || stored === 'map' ? stored : 'map'
  } catch {
    return 'map'
  }
}

const NAV_ITEMS: { id: TabId; label: string; icon: typeof MapIcon }[] = [
  { id: 'map', label: 'Carte', icon: MapIcon },
  { id: 'route', label: 'Itinéraire', icon: RouteIcon },
  { id: 'explore', label: 'Explorer', icon: Compass },
  { id: 'alerts', label: 'Alertes', icon: Bell },
  { id: 'governance', label: 'Gouvernance', icon: Database },
]

const NETWORK_ICONS: Record<NetworkId, typeof TrainFront> = {
  ter: TrainFront,
  brt: BusFront,
  ddd: BusFront,
  aftu: BusFront,
  tata: BusFront,
  other: BusFront,
}

function formatCoordinates(point: Coordinates): string {
  return `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`
}

function NetworkIcon({ id, size = 18 }: { id: NetworkId; size?: number }) {
  const Icon = NETWORK_ICONS[id]
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />
}

function App() {
  const [activeTab, setActiveTab] = useState<TabId>('map')
  const [search, setSearch] = useState('')
  const [networkLayers, setNetworkLayers] = useState<Record<NetworkId, boolean>>({
    ter: true,
    brt: true,
    ddd: true,
    aftu: true,
    tata: true,
    other: true,
  })
  const [layersOpen, setLayersOpen] = useState(false)
  const [location, setLocation] = useState<UserLocation | null>(null)
  const [gpsState, setGpsState] = useState<GpsState>('idle')
  const [recenterTo, setRecenterTo] = useState<Coordinates | null>(null)
  const [zoomAction, setZoomAction] = useState<{ delta: number; nonce: number } | null>(null)
  const [nextZoomNonce, setNextZoomNonce] = useState(0)
  const [routePoints, setRoutePoints] = useState<Partial<Record<RoutePointKey, MapPoint>>>({})
  const [pickingPoint, setPickingPoint] = useState<RoutePointKey | null>(null)
  const [routeAttempted, setRouteAttempted] = useState(false)
  const [journey, setJourney] = useState<JourneyState>(IDLE_JOURNEY)
  const [toast, setToast] = useState<string | null>(null)
  const [gpsMessage, setGpsMessage] = useState<string | null>(null)
  const [exploreFilter, setExploreFilter] = useState<NetworkId | 'all'>('all')
  const [alertInfoOpen, setAlertInfoOpen] = useState(false)
  const [governance, setGovernance] = useState<GovernanceState>({ status: 'idle', datasets: [], pipeline: null, error: null })
  const [published, setPublished] = useState<PublishedState>({ status: 'idle', network: null, error: null })
  const [nearby, setNearby] = useState<NearbyState>({ status: 'idle', stops: [], radius: NEARBY_RADIUS_M, error: null })
  const [lines, setLines] = useState<LinesState>({ status: 'idle', routes: [], error: null })
  const [stopSearch, setStopSearch] = useState<StopSearchState>({ status: 'idle', query: '', stops: [], error: null })
  const [selectedStop, setSelectedStop] = useState<PublishedStopDetail | null>(null)
  const [selectedStopError, setSelectedStopError] = useState<string | null>(null)
  const [showCoverage, setShowCoverage] = useState(true)
  const [layout, setLayout] = useState<LayoutMode>(() => readStoredLayout())
  const toastTimer = useRef<number | undefined>(undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const connectedCount = getConnectedNetworkCount()
  const network = published.network
  const dataAvailable = network !== null && isCurrentSnapshot(network)
  const mappablePublishedStops = dataAvailable ? nearby.stops : []

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    function handleKeyboardShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchInputRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setLayersOpen(false)
        setPickingPoint(null)
      }
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        toggleLayout()
      }
    }
    window.addEventListener('keydown', handleKeyboardShortcut)
    return () => window.removeEventListener('keydown', handleKeyboardShortcut)
  }, [])

  function announce(message: string) {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }

  const loadGovernance = useCallback(async () => {
    setGovernance((current) => ({ ...current, status: 'loading', error: null }))
    try {
      const [catalogResponse, pipelineResponse] = await Promise.all([
        fetch('/api/catalog', { headers: { Accept: 'application/json' } }),
        fetch('/api/pipeline', { headers: { Accept: 'application/json' } }),
      ])
      if (!catalogResponse.ok || !pipelineResponse.ok) {
        setGovernance({
          status: 'offline',
          datasets: [],
          pipeline: null,
          error: `L’API d’administration a répondu ${catalogResponse.status} / ${pipelineResponse.status}.`,
        })
        return
      }
      const catalog = parseCatalogPayload(await catalogResponse.json())
      const pipeline = parsePipelinePayload(await pipelineResponse.json())
      if (!catalog.ok) {
        setGovernance({ status: 'offline', datasets: [], pipeline: null, error: catalog.reason })
        return
      }
      if (!pipeline.ok) {
        setGovernance({ status: 'offline', datasets: [], pipeline: null, error: pipeline.reason })
        return
      }
      setGovernance({ status: 'ready', datasets: catalog.value, pipeline: pipeline.value, error: null })
    } catch {
      setGovernance({
        status: 'offline',
        datasets: [],
        pipeline: null,
        error: 'L’API d’administration locale ne répond pas sur /api.',
      })
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'governance') return
    if (governance.status === 'idle') void loadGovernance()
  }, [activeTab, governance.status, loadGovernance])

  const loadPublishedNetwork = useCallback(async () => {
    setPublished((current) => ({ ...current, status: 'loading', error: null }))
    const result = await fetchApi('/api/network')
    if (!result.ok) {
      setPublished({
        status: 'error',
        network: null,
        error: result.status === 0 ? 'L’API de lecture locale ne répond pas sur /api.' : `L’API de lecture a répondu ${result.status}${result.code ? ` (${result.code})` : ''}.`,
      })
      return
    }
    const parsed = parseNetworkPayload(result.payload)
    if (!parsed.ok) {
      setPublished({ status: 'error', network: null, error: parsed.reason })
      return
    }
    setPublished({ status: 'ready', network: parsed.value, error: null })
  }, [])

  useEffect(() => {
    void loadPublishedNetwork()
  }, [loadPublishedNetwork])

  const loadPublishedLines = useCallback(async () => {
    setLines({ status: 'loading', routes: [], error: null })
    const result = await fetchApi('/api/routes?limit=100')
    if (!result.ok) {
      setLines({ status: 'error', routes: [], error: result.code === 'NOT_PUBLISHED' ? 'Aucune ligne publiée pour le moment.' : 'Les lignes publiées n’ont pas pu être lues.' })
      return
    }
    const parsed = parseRoutesPayload(result.payload)
    if (!parsed.ok) {
      setLines({ status: 'error', routes: [], error: parsed.reason })
      return
    }
    setLines({ status: 'ready', routes: parsed.value, error: null })
  }, [])

  useEffect(() => {
    if (!dataAvailable || lines.status !== 'idle') return
    void loadPublishedLines()
  }, [dataAvailable, lines.status, loadPublishedLines])

  useEffect(() => {
    if (dataAvailable) return
    // Nothing is served any more: the app drops the published view instead of
    // keeping a snapshot on screen that is no longer the published one.
    setSelectedStop(null)
    setSelectedStopError(null)
    setNearby({ status: 'idle', stops: [], radius: NEARBY_RADIUS_M, error: null })
  }, [dataAvailable])

  const loadNearbyStops = useCallback(async (origin: Coordinates) => {
    setNearby({ status: 'loading', stops: [], radius: NEARBY_RADIUS_M, error: null })
    const result = await fetchApi(`/api/stops/near?lat=${origin.lat}&lon=${origin.lng}&radius=${NEARBY_RADIUS_M}&limit=8`)
    if (!result.ok) {
      setNearby({
        status: 'error',
        stops: [],
        radius: NEARBY_RADIUS_M,
        error: result.code === 'NOT_PUBLISHED' ? 'Aucun jeu publié : rien à afficher autour de vous.' : 'Les arrêts publiés à proximité n’ont pas pu être lus.',
      })
      return
    }
    const parsed = parseStopsPayload(result.payload)
    if (!parsed.ok) {
      setNearby({ status: 'error', stops: [], radius: NEARBY_RADIUS_M, error: parsed.reason })
      return
    }
    setNearby({ status: 'ready', stops: parsed.value, radius: NEARBY_RADIUS_M, error: null })
  }, [])

  useEffect(() => {
    if (!dataAvailable || !location || nearby.status !== 'idle') return
    void loadNearbyStops(location)
  }, [dataAvailable, location, nearby.status, loadNearbyStops])

  async function openStop(stop: PublishedStop) {
    setSelectedStopError(null)
    const result = await fetchApi(`/api/stops/${encodeURIComponent(stop.stopId)}`)
    if (!result.ok) {
      setSelectedStop(null)
      setSelectedStopError(result.code === 'NOT_PUBLISHED' ? 'Cet arrêt n’est plus servi : la publication a été annulée.' : 'La fiche de cet arrêt n’a pas pu être lue.')
      announce('Fiche d’arrêt indisponible.')
      return
    }
    const parsed = parseStopDetailPayload(result.payload)
    if (!parsed.ok) {
      setSelectedStop(null)
      setSelectedStopError(parsed.reason)
      return
    }
    setSelectedStop(parsed.value)
    if (parsed.value.lat !== null && parsed.value.lon !== null) {
      setRecenterTo({ lat: parsed.value.lat, lng: parsed.value.lon })
    }
    announce(`Arrêt ${parsed.value.stopName} · ${parsed.value.routes.length} ligne${parsed.value.routes.length > 1 ? 's' : ''} déclarée${parsed.value.routes.length > 1 ? 's' : ''}.`)
  }

  function useStopAsRoutePoint(stop: PublishedStopDetail, key: RoutePointKey) {
    if (stop.lat === null || stop.lon === null) {
      announce('Cet arrêt n’a pas de coordonnées déclarées : il ne peut pas servir de point.')
      return
    }
    setRoutePoints((current) => ({
      ...current,
      [key]: { lat: stop.lat!, lng: stop.lon!, label: stop.stopName, kind: 'stop', stopId: stop.stopId },
    }))
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setActiveTab('route')
    announce(key === 'origin' ? `${stop.stopName} défini comme départ.` : `${stop.stopName} défini comme destination.`)
  }

  const runStopSearch = useCallback(async (query: string) => {
    const trimmed = query.trim()
    if (!trimmed) {
      setStopSearch({ status: 'idle', query: '', stops: [], error: null })
      return
    }
    setStopSearch({ status: 'loading', query: trimmed, stops: [], error: null })
    const result = await fetchApi(`/api/stops/search?q=${encodeURIComponent(trimmed)}&limit=20`)
    if (!result.ok) {
      setStopSearch({
        status: 'error',
        query: trimmed,
        stops: [],
        error: result.code === 'NOT_PUBLISHED' ? 'Aucune donnée publiée : la recherche ne peut rien renvoyer.' : 'La recherche n’a pas pu être effectuée.',
      })
      return
    }
    const parsed = parseStopsPayload(result.payload)
    if (!parsed.ok) {
      setStopSearch({ status: 'error', query: trimmed, stops: [], error: parsed.reason })
      return
    }
    setStopSearch({ status: 'ready', query: trimmed, stops: parsed.value, error: null })
  }, [])

  function toggleLayout() {
    setLayout((current) => {
      const next: LayoutMode = current === 'map' ? 'split' : 'map'
      try {
        window.localStorage.setItem(LAYOUT_STORAGE_KEY, next)
      } catch {
        // Le choix reste en mémoire si le stockage local est indisponible.
      }
      return next
    })
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setActiveTab('explore')
    setPickingPoint(null)
    if (!search.trim()) {
      setStopSearch({ status: 'idle', query: '', stops: [], error: null })
      return
    }
    void runStopSearch(search)
  }

  function clearSearch() {
    setSearch('')
    setStopSearch({ status: 'idle', query: '', stops: [], error: null })
  }

  function startPointSelection(key: RoutePointKey) {
    setActiveTab('route')
    setPickingPoint(key)
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setLayersOpen(false)
    announce(key === 'origin' ? 'Touchez la carte pour choisir un point de départ.' : 'Touchez la carte pour choisir une destination.')
  }

  function handleMapPick(point: Coordinates) {
    if (!pickingPoint) return
    const nextPoint: MapPoint = { ...point, label: 'Point choisi sur la carte' }
    setRoutePoints((current) => ({ ...current, [pickingPoint]: nextPoint }))
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setPickingPoint(null)
    announce(pickingPoint === 'origin' ? 'Point de départ enregistré.' : 'Destination enregistrée.')
  }

  function requestLocation(purpose: 'center' | 'origin' = 'center') {
    if (!('geolocation' in navigator)) {
      setGpsState('error')
      setGpsMessage('La géolocalisation n’est pas disponible sur cet appareil.')
      announce('La géolocalisation n’est pas disponible sur cet appareil.')
      return
    }

    setGpsState('loading')
    setGpsMessage(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coords = { lat: position.coords.latitude, lng: position.coords.longitude }
        const result: UserLocation = { ...coords, accuracy: position.coords.accuracy }
        setLocation(result)
        setRecenterTo(coords)
        setGpsState('ready')
        setGpsMessage(position.coords.accuracy > 100 ? 'Position approximative' : 'Position localisée')
        if (dataAvailable) void loadNearbyStops(coords)
        if (purpose === 'origin') {
          setRoutePoints((current) => ({ ...current, origin: { ...coords, label: 'Ma position' } }))
          setActiveTab('route')
          setRouteAttempted(false)
          setJourney(IDLE_JOURNEY)
          announce('Votre position a été choisie comme point de départ.')
        } else {
          announce(position.coords.accuracy > 100 ? 'Position approximative affichée sur la carte.' : 'Votre position est affichée sur la carte.')
        }
      },
      (error) => {
        const denied = error.code === error.PERMISSION_DENIED
        setGpsState(denied ? 'denied' : 'error')
        const message = denied
          ? 'Autorisez la localisation dans votre navigateur pour afficher votre position.'
          : error.code === error.TIMEOUT
            ? 'La localisation a pris trop de temps. Réessayez lorsque le signal sera meilleur.'
            : 'Localisation indisponible. Vérifiez les réglages de votre appareil et réessayez.'
        setGpsMessage(message)
        announce(message)
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    )
  }

  function zoomMap(delta: number) {
    const nonce = nextZoomNonce + 1
    setNextZoomNonce(nonce)
    setZoomAction({ delta, nonce })
  }

  function toggleNetwork(id: NetworkId) {
    setNetworkLayers((current) => ({ ...current, [id]: !current[id] }))
  }

  function swapRoutePoints() {
    setRoutePoints((current) => ({ origin: current.destination, destination: current.origin }))
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
  }

  async function submitRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const origin = routePoints.origin
    const destination = routePoints.destination
    if (!origin || !destination) {
      announce('Choisissez un départ et une destination sur la carte avant de continuer.')
      return
    }
    setRouteAttempted(true)
    setJourney({ status: 'loading', search: null, error: null, errorCode: null })

    const parameters = new URLSearchParams()
    const addPoint = (prefix: 'origin' | 'destination', point: MapPoint) => {
      // A published stop is sent by identity so the server answers with the name
      // it holds; anything else is a raw coordinate pair, never a guessed address.
      if (point.kind === 'stop' && point.stopId) {
        parameters.set(prefix, point.stopId)
        return
      }
      parameters.set(`${prefix}_lat`, point.lat.toFixed(6))
      parameters.set(`${prefix}_lon`, point.lng.toFixed(6))
    }
    addPoint('origin', origin)
    addPoint('destination', destination)
    parameters.set('at', new Date().toISOString())
    parameters.set('max_walk_m', String(ROUTE_MAX_WALK_M))

    const result = await fetchApi(`/api/journeys?${parameters.toString()}`)
    if (!result.ok) {
      const message = journeyErrorMessage(result.code)
      setJourney({ status: 'error', search: null, error: message, errorCode: result.code })
      announce(message)
      return
    }
    const parsed = parseJourneysPayload(result.payload)
    if (!parsed.ok) {
      setJourney({ status: 'error', search: null, error: parsed.reason, errorCode: null })
      announce(parsed.reason)
      return
    }
    setJourney({ status: 'ready', search: parsed.value, error: null, errorCode: null })
    const found = parsed.value.results.length
    announce(
      found > 0
        ? `${found} course${found > 1 ? 's' : ''} directe${found > 1 ? 's' : ''} déclarée${found > 1 ? 's' : ''} trouvée${found > 1 ? 's' : ''}.`
        : 'Aucune course directe déclarée ne relie ces deux points. Aucun trajet indirect n’est proposé.',
    )
  }

  const visibleSources = exploreFilter === 'all'
    ? NETWORK_SOURCES
    : NETWORK_SOURCES.filter((network) => network.id === exploreFilter)

  return (
    <main className={`app-shell layout-${layout}`}>
      <section className="map-stage" aria-label="Carte de Dakar">
        <TransitMap
          location={location}
          routePoints={routePoints}
          pickingPoint={pickingPoint}
          recenterTo={recenterTo}
          zoomAction={zoomAction}
          onChoosePoint={handleMapPick}
          publishedStops={mappablePublishedStops}
          selectedStopId={selectedStop?.stopId ?? null}
          coverage={dataAvailable ? network?.snapshot?.bounds ?? null : null}
          showCoverage={showCoverage}
          onSelectStop={(stop) => void openStop(stop)}
        />

        <div className="map-heading-overlay">
          <div className="map-place-chip">
            <span className="place-icon"><MapPin size={15} /></span>
            <span>Dakar</span>
            <span className="place-separator" />
            <span className="place-country">Sénégal</span>
          </div>
          <div className={`map-source-chip${dataAvailable ? ' is-published' : ''}`}>
            <span className="source-dot" />
            {dataAvailable
              ? `${nearby.stops.length > 0 ? `${nearby.stops.length} arrêts publiés · ` : ''}${lines.routes.length} ligne${lines.routes.length > 1 ? 's' : ''} publiée${lines.routes.length > 1 ? 's' : ''}`
              : connectedCount > 0 ? `${connectedCount} source${connectedCount > 1 ? 's' : ''} connectée${connectedCount > 1 ? 's' : ''}` : 'Réseaux à connecter'}
          </div>
        </div>

        <div className="map-actions-top">
          <button
            className="map-tool-button layout-toggle"
            type="button"
            aria-label={layout === 'map' ? 'Passer au panneau latéral' : 'Passer la carte en plein écran'}
            onClick={toggleLayout}
            title="Basculer entre la carte plein écran et le panneau latéral (touche P)"
          >
            <LayoutPanelLeft size={17} />
            <span>{layout === 'map' ? 'Panneau' : 'Plein écran'}</span>
          </button>
          <button
            className={`map-tool-button${layersOpen ? ' is-open' : ''}`}
            type="button"
            aria-expanded={layersOpen}
            aria-controls="map-layers"
            onClick={() => setLayersOpen((open) => !open)}
          >
            <Layers3 size={17} />
            <span>Couches</span>
            <ChevronDown size={14} className="layers-chevron" />
          </button>
          {layersOpen && (
            <div className="layers-popover" id="map-layers">
              <div className="popover-heading">
                <div><span className="eyebrow">AFFICHAGE</span><strong>Couches du réseau</strong></div>
                <button type="button" className="icon-button popover-close" aria-label="Fermer les couches" onClick={() => setLayersOpen(false)}><X size={17} /></button>
              </div>
              <p className="popover-note">Les catégories restent vides tant qu’une source fiable n’est pas intégrée.</p>
              <div className="layer-options">
                {NETWORK_SOURCES.map((network) => (
                  <label className="layer-option" key={network.id}>
                    <input type="checkbox" checked={networkLayers[network.id]} onChange={() => toggleNetwork(network.id)} />
                    <span className={`layer-icon layer-icon-${network.id}`}><NetworkIcon id={network.id} size={16} /></span>
                    <span className="layer-label">{network.label}</span>
                    <span className="layer-empty">sans données</span>
                  </label>
                ))}
              </div>
              {dataAvailable && (
                <label className="layer-option">
                  <input type="checkbox" checked={showCoverage} onChange={() => setShowCoverage((shown) => !shown)} />
                  <span className="layer-icon layer-icon-published"><Database size={16} /></span>
                  <span className="layer-label">Périmètre publié</span>
                  <span className="layer-empty">{network?.snapshot?.bounds?.stopsWithCoordinates ?? 0} arrêts</span>
                </label>
              )}
              <div className="popover-footnote"><Info size={13} /> Activer une couche n’ajoute aucune donnée non vérifiée.</div>
            </div>
          )}
        </div>

        {pickingPoint && (
          <div className="map-pick-banner" role="status">
            <MapPin size={16} />
            <span>Choisissez {pickingPoint === 'origin' ? 'un point de départ' : 'une destination'} sur la carte</span>
            <button type="button" aria-label="Annuler la sélection" onClick={() => setPickingPoint(null)}><X size={16} /></button>
          </div>
        )}

        <div className={`map-transport-note${dataAvailable ? ' is-published' : ''}`}>
          <div className="transport-note-icon"><ShieldCheck size={17} /></div>
          <div>
            <strong>{dataAvailable ? 'Arrêts du snapshot publié affichés' : 'La carte ne montre que le territoire'}</strong>
            <span>
              {dataAvailable
                ? network?.message ?? 'Horaires théoriques déclarés dans le flux ; aucune position de véhicule.'
                : 'Les lignes et arrêts apparaîtront après validation des sources.'}
            </span>
          </div>
        </div>

        <div className="map-controls" aria-label="Contrôles de la carte">
          <button type="button" className="map-control" aria-label="Zoom avant" onClick={() => zoomMap(1)}><Plus size={17} /></button>
          <button type="button" className="map-control" aria-label="Zoom arrière" onClick={() => zoomMap(-1)}><Minus size={17} /></button>
          <span className="control-divider" />
          <button
            type="button"
            className={`map-control locate-control${gpsState === 'ready' ? ' is-located' : ''}`}
            aria-label={gpsState === 'loading' ? 'Localisation en cours' : 'Me localiser'}
            onClick={() => requestLocation()}
            disabled={gpsState === 'loading'}
          >
            <LocateFixed size={18} className={gpsState === 'loading' ? 'is-spinning' : ''} />
          </button>
        </div>

        <div className="map-attribution-note">
          <span className="map-attribution-dot" /> Fond cartographique OpenStreetMap
        </div>
      </section>

      <aside className="sidebar" aria-label="Dakar Bus">
        <div className="sidebar-top">
          <header className="brand-row">
            <div className="brand-lockup">
              <div className="brand-symbol" aria-hidden="true"><BusFront size={22} strokeWidth={2} /></div>
              <div className="brand-name-wrap">
                <span className="brand-name">dakar<span>bus</span></span>
                <span className="brand-subtitle">LA MOBILITÉ, EN CLAIR</span>
              </div>
            </div>
            <button type="button" className="profile-button" aria-label="À propos de Dakar Bus" onClick={() => setActiveTab('explore')}>
              <span>DB</span>
            </button>
          </header>

          <div className="search-heading">
            <div>
              <span className="eyebrow">RÉGION DE DAKAR</span>
              <h1>Où allez-vous ?</h1>
            </div>
            <span className="search-heading-mark"><Navigation size={16} /></span>
          </div>
          <form className="search-form" role="search" onSubmit={handleSearchSubmit}>
            <Search size={18} className="search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              aria-label="Rechercher un arrêt, une station ou une ligne"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Arrêt, station, ligne…"
            />
            {search ? (
              <button type="button" className="search-clear" aria-label="Effacer la recherche" onClick={() => setSearch('')}><X size={15} /></button>
            ) : (
              <kbd aria-hidden="true">⌘ K</kbd>
            )}
          </form>

          <nav className="desktop-tabs" aria-label="Navigation principale" role="tablist">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === item.id}
                  className={`nav-tab${activeTab === item.id ? ' active' : ''}`}
                  onClick={() => { setActiveTab(item.id); setPickingPoint(null) }}
                >
                  <Icon size={16} strokeWidth={1.9} />
                  <span>{item.label}</span>
                  {item.id === 'alerts' && <span className="nav-dot" aria-label="Source non connectée" />}
                </button>
              )
            })}
          </nav>
        </div>

        {selectedStop && (
          <StopCard
            stop={selectedStop}
            onClose={() => { setSelectedStop(null); setSelectedStopError(null) }}
            onUseAsOrigin={() => useStopAsRoutePoint(selectedStop, 'origin')}
            onUseAsDestination={() => useStopAsRoutePoint(selectedStop, 'destination')}
          />
        )}
        {selectedStopError && (
          <div className="stop-card stop-card-error" role="status">
            <AlertTriangle size={15} />
            <span>{selectedStopError}</span>
            <button type="button" aria-label="Fermer" onClick={() => setSelectedStopError(null)}><X size={15} /></button>
          </div>
        )}

        <div className="panel-content" key={activeTab}>
          {activeTab === 'map' && (
            <MapPanel
              gpsState={gpsState}
              gpsMessage={gpsMessage}
              onLocate={() => requestLocation()}
              onPlan={() => setActiveTab('route')}
              onExplore={() => setActiveTab('explore')}
              published={published}
              dataAvailable={dataAvailable}
              nearby={nearby}
              lines={lines}
              onSelectStop={(stop) => void openStop(stop)}
              onRefresh={() => void loadPublishedNetwork()}
            />
          )}

          {activeTab === 'route' && (
            <RoutePanel
              routePoints={routePoints}
              pickingPoint={pickingPoint}
              routeAttempted={routeAttempted}
              onSelectPoint={startPointSelection}
              onUseLocation={() => requestLocation('origin')}
              onSwap={swapRoutePoints}
              onClear={() => { setRoutePoints({}); setRouteAttempted(false); setPickingPoint(null); setJourney(IDLE_JOURNEY) }}
              onSubmit={submitRoute}
              dataAvailable={dataAvailable}
              journey={journey}
            />
          )}

          {activeTab === 'explore' && (
            <ExplorePanel
              filter={exploreFilter}
              query={search}
              sources={visibleSources}
              onFilterChange={setExploreFilter}
              onToggleLayer={toggleNetwork}
              layerState={networkLayers}
              onClearSearch={clearSearch}
              dataAvailable={dataAvailable}
              lines={lines}
              search={stopSearch}
              onSelectStop={(stop) => void openStop(stop)}
              onRetrySearch={() => void runStopSearch(stopSearch.query)}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsPanel infoOpen={alertInfoOpen} onToggleInfo={() => setAlertInfoOpen((open) => !open)} />
          )}

          {activeTab === 'governance' && <GovernancePanel state={governance} onReload={() => void loadGovernance()} />}
        </div>

        <footer className="sidebar-footer">
          <div className="footer-truth-mark"><ShieldCheck size={15} /><span>Pas de donnée, pas d’affirmation.</span></div>
          <button type="button" className="footer-link" onClick={() => setActiveTab('explore')}>Sources & données <ArrowRight size={13} /></button>
        </footer>
      </aside>

      <nav className="mobile-nav" aria-label="Navigation principale">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={`mobile-nav-item${activeTab === item.id ? ' active' : ''}`}
              aria-current={activeTab === item.id ? 'page' : undefined}
              onClick={() => { setActiveTab(item.id); setPickingPoint(null) }}
            >
              <span className="mobile-nav-icon"><Icon size={19} strokeWidth={1.9} />{item.id === 'alerts' && <i />}</span>
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      {toast && <div className="toast-message" role="status"><Info size={16} /><span>{toast}</span><button type="button" aria-label="Fermer le message" onClick={() => setToast(null)}><X size={15} /></button></div>}
    </main>
  )
}

function publishedBadge(state: PublishedState): { label: string; tone: 'neutral' | 'published' | 'warning' } {
  if (state.status === 'loading') return { label: 'LECTURE', tone: 'neutral' }
  if (state.status === 'error') return { label: 'INDISPONIBLE', tone: 'warning' }
  if (state.network && isCurrentSnapshot(state.network)) return { label: 'PUBLIÉ', tone: 'published' }
  if (state.network?.available) return { label: 'PÉRIODE DÉPASSÉE', tone: 'warning' }
  return { label: 'EN ATTENTE', tone: 'neutral' }
}

function MapPanel({
  gpsState,
  gpsMessage,
  onLocate,
  onPlan,
  onExplore,
  published,
  dataAvailable,
  nearby,
  lines,
  onSelectStop,
  onRefresh,
}: {
  gpsState: GpsState
  gpsMessage: string | null
  onLocate: () => void
  onPlan: () => void
  onExplore: () => void
  published: PublishedState
  dataAvailable: boolean
  nearby: NearbyState
  lines: LinesState
  onSelectStop: (stop: PublishedStop) => void
  onRefresh: () => void
}) {
  const network = published.network
  const badge = publishedBadge(published)
  return (
    <section className="panel map-panel" aria-label="Résumé de la carte">
      <div className="panel-intro">
        <div>
          <span className="eyebrow">VOTRE VILLE, VOTRE RYTHME</span>
          <h2>La ville en mouvement.</h2>
          <p>Explorez Dakar et repérez les options de mobilité autour de vous.</p>
        </div>
        <span className="intro-compass"><Compass size={19} /></span>
      </div>

      <div className={`data-honesty-card tone-${badge.tone}`}>
        <div className="honesty-icon"><ShieldCheck size={18} /></div>
        <div className="honesty-copy">
          <div className="honesty-title-row">
            <strong>{dataAvailable ? 'Snapshot publié servi' : 'Affichage vérifié'}</strong>
            <span className={`neutral-status status-${badge.tone}`}><i /> {badge.label}</span>
          </div>
          {published.status === 'idle' || published.status === 'loading' ? (
            <p>Vérification de l’état de publication auprès de l’API locale…</p>
          ) : dataAvailable && network ? (
            <>
              <p>
                {network.dataset?.operator ?? 'Opérateur non précisé'} · version {network.dataset?.datasetVersion ?? 'non précisée'} ·{' '}
                {publishedValidityLabel(network.snapshot?.validityStatus ?? 'UNKNOWN')}
              </p>
              <p className="honesty-meta">
                Snapshot {network.snapshot?.snapshotId} · publié le {formatTimestamp(network.publishedAt)} · horaires théoriques, aucune position de véhicule.
              </p>
              <button type="button" className="honesty-link" onClick={onRefresh}>Actualiser l’état de publication</button>
            </>
          ) : published.status === 'error' ? (
            <p>{published.error} Démarrer l’API locale avec <code>npm run admin:api</code>. Aucun arrêt n’est affiché.</p>
          ) : network?.available ? (
            <p>
              Un snapshot est {publicationStatusLabel(network.publicationStatus).toLowerCase()} mais la période déclarée
              ne couvre pas aujourd’hui ({publishedValidityLabel(network.snapshot?.validityStatus ?? 'UNKNOWN').toLowerCase()}) :
              rien n’est affiché comme actuel.
            </p>
          ) : (
            <p>Aucune source de transport n’est encore reliée. Aucun arrêt, horaire ou tracé n’est simulé.</p>
          )}
        </div>
      </div>

      <div className="nearby-header">
        <div>
          <span className="eyebrow">EXPLORATION</span>
          <h3>Autour de vous</h3>
        </div>
        <button type="button" className="text-action" onClick={onLocate} disabled={gpsState === 'loading'}>
          <LocateFixed size={15} className={gpsState === 'loading' ? 'is-spinning' : ''} />
          {gpsState === 'loading' ? 'Recherche…' : 'Me localiser'}
        </button>
      </div>

      {!dataAvailable && (
        <div className="nearby-empty">
          <span className="nearby-empty-icon"><MapPin size={18} /></span>
          <div>
            <strong>{gpsState === 'ready' ? 'Position affichée sur la carte' : 'Les transports validés apparaîtront ici'}</strong>
            <span>{gpsMessage || 'Aucune donnée de transport vérifiée à proximité pour le moment.'}</span>
          </div>
          <span className="empty-chevron"><ArrowRight size={15} /></span>
        </div>
      )}

      {dataAvailable && gpsState !== 'ready' && (
        <div className="nearby-empty">
          <span className="nearby-empty-icon"><LocateFixed size={18} /></span>
          <div>
            <strong>Activez la localisation</strong>
            <span>Les arrêts publiés dans un rayon de {Math.round(nearby.radius)} m s’afficheront ici, avec leur distance.</span>
          </div>
          <span className="empty-chevron"><ArrowRight size={15} /></span>
        </div>
      )}

      {dataAvailable && gpsState === 'ready' && nearby.status === 'loading' && (
        <div className="nearby-empty"><span className="nearby-empty-icon"><RefreshCw size={18} className="is-spinning" /></span><div><strong>Recherche des arrêts publiés…</strong><span>Lecture du snapshot en cours.</span></div></div>
      )}

      {dataAvailable && gpsState === 'ready' && nearby.status === 'error' && (
        <div className="nearby-empty"><span className="nearby-empty-icon"><AlertTriangle size={18} /></span><div><strong>Lecture impossible</strong><span>{nearby.error}</span></div></div>
      )}

      {dataAvailable && gpsState === 'ready' && nearby.status === 'ready' && (
        <ul className="published-stop-list">
          {nearby.stops.length === 0 && (
            <li className="published-stop-empty">Aucun arrêt publié dans un rayon de {Math.round(nearby.radius)} m autour de votre position.</li>
          )}
          {nearby.stops.map((stop) => (
            <li key={stop.stopId}>
              <button type="button" className="published-stop-row" onClick={() => onSelectStop(stop)}>
                <span className="stop-row-icon"><MapPin size={15} /></span>
                <span className="stop-row-copy">
                  <strong>{stop.stopName}</strong>
                  <small>{[formatDistance(stop.distanceM), stop.parentStation ? `parent ${stop.parentStation}` : null].filter(Boolean).join(' · ') || 'distance inconnue'}</small>
                </span>
                <ArrowRight size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {dataAvailable && (
        <div className="published-counts">
          <span><strong>{lines.routes.length}</strong> ligne{lines.routes.length > 1 ? 's' : ''} publiée{lines.routes.length > 1 ? 's' : ''}</span>
          <span className="strip-divider" />
          <span><strong>{network?.snapshot?.bounds?.stopsWithCoordinates ?? 0}</strong> arrêts géolocalisés</span>
          <span className="strip-divider" />
          <span><strong>{lines.status === 'ready' ? lines.routes.reduce((total, route) => total + (route.tripCount ?? 0), 0) : '—'}</strong> courses déclarées</span>
        </div>
      )}

      <button type="button" className="primary-action" onClick={onPlan}>
        <RouteIcon size={17} />
        <span>Préparer un itinéraire</span>
        <ArrowRight size={16} />
      </button>
      <button type="button" className="secondary-action" onClick={onExplore}>
        {dataAvailable ? 'Voir les arrêts et lignes publiés' : 'Explorer les sources réseau'} <ArrowRight size={14} />
      </button>

      <div className="data-state-strip">
        <span className="data-state-marker" />
        <span>Fond externe · OpenStreetMap</span>
        <span className="strip-divider" />
        <span>{dataAvailable ? `Transport : snapshot publié${lines.routes.length > 0 ? ` · ${lines.routes.length} ligne${lines.routes.length > 1 ? 's' : ''}` : ''}` : 'Transport : données en attente'}</span>
      </div>
    </section>
  )
}

function PointField({
  title,
  point,
  pointKey,
  isPicking,
  onSelect,
}: {
  title: string
  point?: MapPoint
  pointKey: RoutePointKey
  isPicking: boolean
  onSelect: (key: RoutePointKey) => void
}) {
  return (
    <div className={`point-field${isPicking ? ' picking' : ''}`}>
      <span className={`point-symbol ${pointKey === 'origin' ? 'origin-symbol' : 'destination-symbol'}`}><i /></span>
      <div className="point-field-content">
        <span className="point-title">{title}</span>
        <button type="button" className="point-picker" onClick={() => onSelect(pointKey)}>
          <span>{point ? point.label : 'Choisir un point sur la carte'}</span>
          {point && (
            <small>
              {formatCoordinates(point)}
              {point.kind === 'stop' ? ' · arrêt publié' : ''}
            </small>
          )}
          {!point && <MapPin size={14} />}
        </button>
      </div>
      {isPicking && <span className="picking-label">Touchez la carte</span>}
    </div>
  )
}

function RoutePanel({
  routePoints,
  pickingPoint,
  routeAttempted,
  onSelectPoint,
  onUseLocation,
  onSwap,
  onClear,
  onSubmit,
  dataAvailable,
  journey,
}: {
  routePoints: Partial<Record<RoutePointKey, MapPoint>>
  pickingPoint: RoutePointKey | null
  routeAttempted: boolean
  onSelectPoint: (key: RoutePointKey) => void
  onUseLocation: () => void
  onSwap: () => void
  onClear: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  dataAvailable: boolean
  journey: JourneyState
}) {
  return (
    <section className="panel route-panel" aria-label="Planifier un itinéraire">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">TRAJET MULTIMODAL</span>
          <h2>Votre prochain trajet.</h2>
          <p>{dataAvailable ? 'Choisissez deux arrêts publiés ou deux points sur la carte : les courses directes déclarées sont proposées.' : 'Choisissez deux points sur la carte pour commencer.'}</p>
        </div>
        {(routePoints.origin || routePoints.destination) && <button type="button" className="icon-button clear-route" aria-label="Effacer le trajet" onClick={onClear}><X size={16} /></button>}
      </div>

      <form onSubmit={onSubmit}>
        <div className="route-fields-wrap">
          <div className="route-connector" aria-hidden="true"><i /><span /><i /></div>
          <PointField title="Départ" point={routePoints.origin} pointKey="origin" isPicking={pickingPoint === 'origin'} onSelect={onSelectPoint} />
          <button type="button" className="swap-route" aria-label="Inverser départ et destination" onClick={onSwap}><ArrowDownUp size={15} /></button>
          <PointField title="Destination" point={routePoints.destination} pointKey="destination" isPicking={pickingPoint === 'destination'} onSelect={onSelectPoint} />
        </div>

        <button type="button" className="use-location-action" onClick={onUseLocation}>
          <LocateFixed size={15} /> Utiliser ma position comme départ
        </button>

        <div className="route-preferences">
          <span className="preference-chip"><ClockIcon /> Au départ maintenant</span>
          <button type="button" className="preference-edit" title="Les options d'accessibilité seront configurées avec les données réseau">Options <ChevronDown size={13} /></button>
        </div>

        <button className="primary-action route-submit" type="submit" disabled={!routePoints.origin || !routePoints.destination}>
          <Search size={17} /><span>Rechercher un itinéraire</span><ArrowRight size={16} />
        </button>
      </form>

      {routeAttempted ? (
        <RouteOutcome journey={journey} dataAvailable={dataAvailable} />
      ) : (
        <div className="route-truth-card">
          <div className="route-truth-icon"><ShieldCheck size={17} /></div>
          {dataAvailable ? (
            <div>
              <strong>Courses directes uniquement.</strong>
              <span>
                Le calcul s’appuie sur le snapshot publié : une montée, une descente, aux horaires théoriques déclarés.
                Les itinéraires à correspondance, les positions de véhicules et les estimations temps réel ne sont pas proposés.
              </span>
            </div>
          ) : (
            <div><strong>Un itinéraire fiable, pas approximatif.</strong><span>Le calcul sera activé quand un jeu de transport vérifié sera publié.</span></div>
          )}
        </div>
      )}

      <div className="route-mode-legend">
        <span><Footprints size={14} /> Marche</span>
        <span><BusFront size={14} /> Bus & BRT</span>
        <span><TrainFront size={14} /> TER</span>
      </div>
    </section>
  )
}

function RouteOutcome({ journey, dataAvailable }: { journey: JourneyState; dataAvailable: boolean }) {
  if (journey.status === 'loading') {
    return (
      <div className="route-unavailable" role="status" aria-live="polite">
        <div className="unavailable-icon"><Search size={18} /></div>
        <div>
          <strong>Recherche des courses directes déclarées…</strong>
          <p>Arrêts publiés et horaires théoriques du snapshot actif uniquement.</p>
        </div>
      </div>
    )
  }

  if (journey.status === 'error') {
    return (
      <div className="route-unavailable" role="status" aria-live="polite">
        <div className="unavailable-icon"><AlertTriangle size={18} /></div>
        <div>
          <strong>Itinéraire impossible pour le moment</strong>
          <p>{journey.error}</p>
          <p className="route-unavailable-note">Aucun trajet n’est inventé : la recherche s’arrête là.</p>
        </div>
      </div>
    )
  }

  const search = journey.search
  if (journey.status !== 'ready' || !search) {
    return (
      <div className="route-unavailable" role="status" aria-live="polite">
        <div className="unavailable-icon"><Search size={18} /></div>
        <div>
          <strong>Recherche des courses directes déclarées…</strong>
          <p>Arrêts publiés et horaires théoriques du snapshot actif uniquement.</p>
        </div>
      </div>
    )
  }

  const laterDay = search.results.length > 0 && search.results[0].date !== search.localDay

  if (search.results.length === 0) {
    return (
      <div className="route-unavailable" role="status" aria-live="polite">
        <div className="unavailable-icon"><AlertTriangle size={18} /></div>
        <div>
          <strong>Aucune course directe déclarée</strong>
          <p>{search.message ?? 'Le moteur ne propose que des courses directes déclarées ; aucun trajet indirect n’est proposé.'}</p>
          {search.nextServiceDate && (
            <p className="route-next-service">
              Prochaine date déclarée avec une course directe : <strong>{formatJourneyDate(search.nextServiceDate)}</strong>.
            </p>
          )}
          {search.limitations && <p className="route-unavailable-note">{search.limitations}</p>}
        </div>
      </div>
    )
  }

  return (
    <section className="journey-results" aria-label="Courses directes proposées">
      <div className="journey-results-head">
        <span className="eyebrow">HORAIRES THÉORIQUES DÉCLARÉS</span>
        <div className="journey-count-chip">
          {search.results.length} course{search.results.length > 1 ? 's' : ''} directe{search.results.length > 1 ? 's' : ''}
          {laterDay ? ` du ${formatJourneyDate(search.results[0].date)}` : ''}
        </div>
      </div>

      {laterDay && (
        <p className="journey-later-day" role="status">
          Plus aucune course directe ne part aujourd’hui : voici la première course déclarée, le{' '}
          {formatJourneyDate(search.results[0].date)}.
        </p>
      )}

      <ul className="journey-list">
        {search.results.map((item) => (
          <JourneyCard key={`${item.tripId ?? item.routeId}-${item.departure.declaredTime}-${item.date}`} journey={item} localDay={search.localDay} />
        ))}
      </ul>

      <p className="journey-footnote">
        {search.limitations ?? 'Courses directes déclarées uniquement : aucune correspondance n’est proposée.'}
      </p>
      <p className="journey-footnote journey-footnote-strong">
        {dataAvailable
          ? 'Aucune position de véhicule et aucun temps réel : ces heures sont celles déclarées dans le flux publié.'
          : 'Aucune donnée publiée n’est servie : ces heures proviennent exclusivement du flux publié.'}
      </p>
    </section>
  )
}

function JourneyCard({ journey, localDay }: { journey: Journey; localDay: string }) {
  const departureWalk = walkSummary(journey.departure)
  const arrivalWalk = walkSummary(journey.arrival)
  return (
    <li className="journey-card">
      <div className="journey-card-head">
        <span className="journey-route-badge">{journeyRouteLabel(journey)}</span>
        <span className="journey-mode">{describeRouteType(journey.routeType)}</span>
        {journey.routeLongName && <span className="journey-route-name">{journey.routeLongName}</span>}
      </div>

      <div className="journey-timeline">
        <div className="journey-point">
          <span className="journey-clock">{declaredClockLabel(journey.departure.declaredTime)}</span>
          <strong>{journey.departure.stopName ?? journey.departure.stopId}</strong>
          <small>{departureWalk ? <><Footprints size={12} /> {departureWalk}</> : 'Départ à l’arrêt'}</small>
        </div>
        <div className="journey-duration">
          <span>{journey.durationMin} min</span>
          <ArrowRight size={14} />
        </div>
        <div className="journey-point journey-point-arrival">
          <span className="journey-clock">{declaredClockLabel(journey.arrival.declaredTime)}</span>
          <strong>{journey.arrival.stopName ?? journey.arrival.stopId}</strong>
          <small>{arrivalWalk ? <><Footprints size={12} /> {arrivalWalk}</> : 'Arrivée à l’arrêt'}</small>
        </div>
      </div>

      {journey.date !== localDay && (
        <p className="journey-date-note">Course du {formatJourneyDate(journey.date)} — pas aujourd’hui.</p>
      )}
      <p className="journey-note">{journey.note}</p>
    </li>
  )
}

function StopCard({
  stop,
  onClose,
  onUseAsOrigin,
  onUseAsDestination,
}: {
  stop: PublishedStopDetail
  onClose: () => void
  onUseAsOrigin: () => void
  onUseAsDestination: () => void
}) {
  const window = stop.scheduledWindow
  return (
    <section className="stop-card" aria-label={`Arrêt ${stop.stopName}`}>
      <div className="stop-card-head">
        <span className="stop-card-icon"><MapPin size={16} /></span>
        <div>
          <strong>{stop.stopName}</strong>
          <span>
            {stop.stopId}
            {stop.parentStationName ? ` · rattaché à ${stop.parentStationName}` : ''}
            {stop.lat !== null && stop.lon !== null ? ` · ${stop.lat.toFixed(4)}, ${stop.lon.toFixed(4)}` : ' · sans coordonnées déclarées'}
          </span>
        </div>
        <button type="button" aria-label="Fermer la fiche d’arrêt" onClick={onClose}><X size={15} /></button>
      </div>

      {stop.routes.length > 0 ? (
        <ul className="stop-card-routes">
          {stop.routes.map((route) => (
            <li key={route.routeId}>
              <span className="stop-route-badge"><BusFront size={13} /></span>
              <span>{routeDisplayName(route)}</span>
              <small>{describeRouteType(route.routeType)}{route.tripCount !== null ? ` · ${route.tripCount} courses` : ''}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="stop-card-note">Aucune ligne ne dessert cet arrêt dans le snapshot publié.</p>
      )}

      {window && (window.firstDeclaredDeparture || window.lastDeclaredDeparture) && (
        <p className="stop-card-note">
          Heures théoriques déclarées : {window.firstDeclaredDeparture ?? '—'} → {window.lastDeclaredDeparture ?? '—'}. {window.note}
        </p>
      )}

      <div className="stop-card-actions">
        <button type="button" onClick={onUseAsOrigin} disabled={stop.lat === null}><RouteIcon size={14} /> Partir d’ici</button>
        <button type="button" onClick={onUseAsDestination} disabled={stop.lat === null}><ArrowRight size={14} /> Aller ici</button>
      </div>
    </section>
  )
}

function ClockIcon() {
  return <span className="clock-status-icon"><span /></span>
}

function ExplorePanel({
  filter,
  query,
  sources,
  onFilterChange,
  onToggleLayer,
  layerState,
  onClearSearch,
  dataAvailable,
  lines,
  search,
  onSelectStop,
  onRetrySearch,
}: {
  filter: NetworkId | 'all'
  query: string
  sources: readonly NetworkSource[]
  onFilterChange: (filter: NetworkId | 'all') => void
  onToggleLayer: (id: NetworkId) => void
  layerState: Record<NetworkId, boolean>
  onClearSearch: () => void
  dataAvailable: boolean
  lines: LinesState
  search: StopSearchState
  onSelectStop: (stop: PublishedStop) => void
  onRetrySearch: () => void
}) {
  const filters: { id: NetworkId | 'all'; label: string }[] = [
    { id: 'all', label: 'Tout' },
    { id: 'ter', label: 'TER' },
    { id: 'brt', label: 'BRT' },
    { id: 'ddd', label: 'DDD' },
    { id: 'aftu', label: 'AFTU' },
    { id: 'tata', label: 'TATA' },
  ]

  return (
    <section className="panel explore-panel" aria-label="Explorer les arrêts et les lignes">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">RÉSEAU DE DAKAR</span>
          <h2>Explorer.</h2>
          <p>Les données affichées proviennent du snapshot publié, jamais d’un catalogue inventé.</p>
        </div>
        <span className="explore-icon"><Compass size={19} /></span>
      </div>

      {search.status !== 'idle' && (
        <div className="search-results-block">
          <div className="source-list-heading">
            <span>ARRÊTS PUBLIÉS · « {search.query} »</span>
            <span className="source-count">
              {search.status === 'ready' ? `${search.stops.length} résultat${search.stops.length > 1 ? 's' : ''}` : search.status === 'loading' ? 'recherche…' : 'indisponible'}
            </span>
          </div>
          {search.status === 'error' && (
            <div className="published-inline-error">
              <AlertTriangle size={14} />
              <span>{search.error}</span>
              <button type="button" onClick={onRetrySearch}>Réessayer</button>
            </div>
          )}
          {search.status === 'ready' && search.stops.length === 0 && (
            <p className="stop-card-note">Aucun arrêt publié ne porte ce nom. La recherche ne devine ni synonyme ni lieu.</p>
          )}
          {search.status === 'ready' && search.stops.length > 0 && (
            <ul className="published-stop-list">
              {search.stops.map((stop) => (
                <li key={stop.stopId}>
                  <button type="button" className="published-stop-row" onClick={() => onSelectStop(stop)}>
                    <span className="stop-row-icon"><MapPin size={15} /></span>
                    <span className="stop-row-copy">
                      <strong>{stop.stopName}</strong>
                      <small>{stop.stopId}{stop.parentStation ? ` · parent ${stop.parentStation}` : ''}</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dataAvailable && (
        <div className="published-lines-block">
          <div className="source-list-heading">
            <span>LIGNES PUBLIÉES</span>
            <span className="source-count">
              {lines.status === 'ready' ? `${lines.routes.length} ligne${lines.routes.length > 1 ? 's' : ''}` : lines.status === 'loading' ? 'lecture…' : 'indisponible'}
            </span>
          </div>
          {lines.status === 'error' && <div className="published-inline-error"><AlertTriangle size={14} /><span>{lines.error}</span></div>}
          {lines.status === 'ready' && lines.routes.length === 0 && (
            <p className="stop-card-note">Le snapshot publié ne déclare aucune ligne.</p>
          )}
          {lines.status === 'ready' && lines.routes.length > 0 && (
            <ul className="published-route-list">
              {lines.routes.map((route) => (
                <li key={route.routeId}>
                  <span className="route-list-badge"><BusFront size={14} /></span>
                  <span className="route-list-copy">
                    <strong>{routeDisplayName(route)}</strong>
                    <small>
                      {describeRouteType(route.routeType)}
                      {route.tripCount !== null ? ` · ${route.tripCount} courses déclarées` : ' · nombre de courses inconnu'}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!dataAvailable && (
        <div className="nearby-empty">
          <span className="nearby-empty-icon"><Database size={18} /></span>
          <div>
            <strong>Aucune donnée publiée à explorer</strong>
            <span>Les arrêts et lignes apparaîtront ici dès qu’un snapshot vérifié sera publié via <code>npm run publish:gtfs</code>.</span>
          </div>
        </div>
      )}

      {query.trim() && (
        <div className="search-query-notice">
          <Search size={15} /><span>Recherche : <strong>{query}</strong></span>
          <button type="button" aria-label="Effacer la recherche" onClick={onClearSearch}><X size={14} /></button>
        </div>
      )}

      <div className="filter-scroll" role="group" aria-label="Filtrer les réseaux">
        {filters.map((item) => (
          <button key={item.id} type="button" className={`filter-chip${filter === item.id ? ' selected' : ''}`} onClick={() => onFilterChange(item.id)}>{item.label}</button>
        ))}
      </div>

      <div className="source-list-heading"><span>CATÉGORIES À RELIER</span><span className="source-count">{sources.length} proposées</span></div>
      <div className="network-source-list">
        {sources.map((network) => {
          const Icon = NETWORK_ICONS[network.id]
          return (
            <article className="network-source-card" key={network.id}>
              <span className={`network-source-icon network-${network.id}`}><Icon size={18} strokeWidth={1.85} /></span>
              <div className="network-source-copy">
                <strong>{network.label}</strong>
                <span>{network.description}</span>
              </div>
              <div className="network-source-actions">
                <span className="source-pending"><i /> À RELIER</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={layerState[network.id]}
                  aria-label={`${layerState[network.id] ? 'Masquer' : 'Afficher'} la couche ${network.label}`}
                  className={`switch${layerState[network.id] ? ' on' : ''}`}
                  onClick={() => onToggleLayer(network.id)}
                ><span /></button>
              </div>
            </article>
          )
        })}
      </div>

      <div className="source-governance-note">
        <ShieldCheck size={16} />
        <p><strong>Une catégorie n’est pas une ligne.</strong> Aucun service ne sera publié sans opérateur confirmé, source, version et date de validité.</p>
      </div>
      {filter === 'tata' && <p className="tata-note"><Info size={14} /> TATA reste séparé d’AFTU tant que sa classification n’est pas confirmée.</p>}
    </section>
  )
}

function AlertsPanel({ infoOpen, onToggleInfo }: { infoOpen: boolean; onToggleInfo: () => void }) {
  return (
    <section className="panel alerts-panel" aria-label="Alertes de service">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">INFORMATION VOYAGEUR</span>
          <h2>Alertes.</h2>
          <p>Les informations de service doivent être vérifiées et datées.</p>
        </div>
        <span className="alert-heading-icon"><Bell size={18} /></span>
      </div>

      <div className="alerts-unavailable-card">
        <div className="alerts-status-icon"><CircleAlert size={20} /></div>
        <span className="eyebrow">SOURCE D’ALERTES NON CONNECTÉE</span>
        <h3>Pas d’information vérifiable pour l’instant.</h3>
        <p>L’absence d’alerte reçue ne signifie pas que le service est normal. Les perturbations seront affichées ici lorsqu’une source fiable sera disponible.</p>
        <button type="button" className="quiet-action" onClick={onToggleInfo}>{infoOpen ? 'Masquer les détails' : 'Pourquoi cette précision ?'} <ChevronDown size={14} className={infoOpen ? 'rotate-icon' : ''} /></button>
        {infoOpen && (
          <div className="alert-explainer"><ShieldCheck size={15} /><span>Chaque alerte devra inclure une source, un opérateur, une période de validité et l’heure de vérification.</span></div>
        )}
      </div>

      <div className="alert-severity-legend">
        <span><i className="severity-dot critical" /> Critique</span>
        <span><i className="severity-dot major" /> Important</span>
        <span><i className="severity-dot info" /> Information</span>
      </div>
      <div className="alert-empty-hint"><Info size={15} /><span>Aucune alerte active ne peut être confirmée à ce stade.</span></div>
    </section>
  )
}

function GovernancePanel({ state, onReload }: { state: GovernanceState; onReload: () => void }) {
  const summary = summarizeCatalog(state.datasets)
  const stageCounts: Record<string, number> = {
    staging: summary.total,
    review: summary.pendingReview,
    approval: summary.approved,
    publication: summary.published,
  }
  const showCounts = state.status === 'ready'

  return (
    <section className="panel governance-panel" aria-label="Gouvernance des données">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">PROVENANCE ET REVUE</span>
          <h2>Gouvernance.</h2>
          <p>Du staging à la publication, chaque étape laisse une trace vérifiable.</p>
        </div>
        <span className="governance-heading-icon"><Database size={19} /></span>
      </div>

      <div className={`governance-status governance-status-${state.status}`} role="status">
        {state.status === 'ready' && (
          <>
            <span className="governance-status-icon is-online"><Lock size={15} /></span>
            <div>
              <strong>Catalogue local vérifié</strong>
              <span>Catalogue local lu à {formatTimestamp(state.pipeline?.generatedAt ?? null)} · les écritures exigent un compte local authentifié, ci-dessous ou en CLI.</span>
            </div>
            <button type="button" className="governance-refresh" onClick={onReload} aria-label="Recharger le catalogue"><RefreshCw size={14} /></button>
          </>
        )}
        {state.status === 'loading' && (
          <>
            <span className="governance-status-icon is-loading"><RefreshCw size={15} className="is-spinning" /></span>
            <div><strong>Lecture du catalogue local…</strong><span>Les versions stagées et leur état de revue sont vérifiés à chaque lecture.</span></div>
          </>
        )}
        {state.status === 'offline' && (
          <>
            <span className="governance-status-icon is-offline"><AlertTriangle size={15} /></span>
            <div>
              <strong>Console hors ligne</strong>
              <span>{state.error} Démarrer l’API locale avec <code>npm run admin:api</code> puis recharger.</span>
            </div>
            <button type="button" className="governance-refresh" onClick={onReload} aria-label="Réessayer la connexion"><RefreshCw size={14} /></button>
          </>
        )}
        {state.status === 'idle' && (
          <>
            <span className="governance-status-icon"><Database size={15} /></span>
            <div><strong>Catalogue non chargé</strong><span>Ouvrir cet onglet interroge l’API locale : lecture publique, décisions authentifiées.</span></div>
          </>
        )}
      </div>

      <div className="governance-stage-strip">
        {GOVERNANCE_STAGES.map((stage) => (
          <div className={`governance-stage${stage.implemented ? '' : ' is-planned'}`} key={stage.id}>
            <span className="governance-stage-count">{showCounts ? stageCounts[stage.id] ?? 0 : '—'}</span>
            <strong>{stage.label}</strong>
            <span className="governance-stage-note">{stage.implemented ? stage.requirement : 'Non implémentée · rien n’est exposé publiquement'}</span>
          </div>
        ))}
      </div>

      <div className="governance-list-heading">
        <span>VERSIONS STAGÉES</span>
        <span className="source-count">{showCounts ? `${summary.total} lue${summary.total > 1 ? 's' : ''}` : 'catalogue non chargé'}</span>
      </div>

      {state.status === 'ready' && state.datasets.length === 0 && (
        <div className="governance-empty">
          <span className="governance-empty-icon"><FileCheck2 size={18} /></span>
          <div>
            <strong>Aucune version stagée</strong>
            <span>Le staging s’effectue avec <code>npm run stage:gtfs</code> sur une archive obtenue auprès d’une source vérifiable.</span>
          </div>
        </div>
      )}

      {state.status === 'ready' && state.datasets.length > 0 && (
        <ul className="governance-dataset-list">
          {state.datasets.map((dataset) => (
            <li className="governance-dataset" key={dataset.datasetId}>
              <div className="governance-dataset-head">
                <strong>{dataset.operator ?? 'Opérateur non déclaré'}</strong>
                <span className={`governance-badge governance-badge-${dataset.reviewStatus.toLowerCase()}`}>
                  {reviewStatusLabel(dataset.reviewStatus)}
                </span>
              </div>
              <span className="governance-dataset-id">{dataset.datasetId}</span>
              <dl className="governance-dataset-meta">
                <div><dt>Version</dt><dd>{dataset.datasetVersion ?? 'inconnue'}</dd></div>
                <div><dt>Source</dt><dd>{dataset.sourceType ?? 'inconnue'}{dataset.serviceStatus ? ` · ${dataset.serviceStatus}` : ''}</dd></div>
                <div><dt>Validité</dt><dd>{validityStatusLabel(dataset.validityStatus)}</dd></div>
                <div><dt>Intégrité</dt><dd>{integrityLabel(dataset)}</dd></div>
                <div><dt>Décision</dt><dd>{dataset.reviewerId ? `${dataset.reviewerId} · ${formatTimestamp(dataset.reviewedAt)}` : 'aucune décision'}</dd></div>
                <div><dt>Publication</dt><dd>{dataset.publicationStatus}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      <div className="governance-checklist">
        <span className="eyebrow">ATTESTATIONS OBLIGATOIRES</span>
        <ul>
          {REQUIRED_ATTESTATIONS.map((item) => (
            <li key={item.id}><History size={13} /><span>{item.label}</span></li>
          ))}
        </ul>
      </div>

      {state.status === 'ready' && <ConsolePanel datasets={state.datasets} onChanged={onReload} />}

      <div className="source-governance-note">
        <ShieldCheck size={16} />
        <p><strong>Une approbation ne publie rien.</strong> Les décisions sont enregistrées par un acteur authentifié — console connectée ou CLI — dans un journal chaîné ; la publication est une étape séparée qui gèle un snapshot daté et haché, et un retour en arrière ajoute une entrée sans rien effacer.</p>
      </div>
    </section>
  )
}

export default App
