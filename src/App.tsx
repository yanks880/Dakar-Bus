import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  Bell,
  BookOpen,
  Bot,
  BusFront,
  ChevronDown,
  CircleAlert,
  Compass,
  Database,
  FileCheck2,
  Footprints,
  History,
  Home,
  Briefcase,
  Info,
  Lock,
  Layers3,
  LocateFixed,
  MapPin,
  Minus,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  TrainFront,
  X,
} from 'lucide-react'
import { TransitMap, type Coordinates, type RoutePointKey, type UserLocation } from './components/TransitMap'
import { AssistantChat } from './components/AssistantChat'
import { MultimodalPlanner } from './components/MultimodalPlanner'
import { answerAssistant, type AssistantContext } from './domain/assistant'
import {
  BRT_STOPS,
  CORRIDOR_LINES,
  CORRIDOR_NETWORKS,
  DAKAR_REGION_BOUNDS,
  TER_STOPS,
  getCorridorStop,
  linesServingStop,
  searchCorridorStops,
  type CorridorStop,
} from './domain/corridors'
import {
  declaredClockLabel,
  formatJourneyDate,
  journeyRouteLabel,
  parseJourneysPayload,
  walkSummary,
  type Journey,
  type JourneySearch,
} from './domain/journeys'
import { NETWORK_SOURCES, type NetworkId, type NetworkSource } from './domain/network'
import { NETWORK_REFERENCE_DATA, formatFrequencyPeriod, formatSourceVerification } from './domain/frequencies'
import { getRemainingMinutes } from './domain/truth'
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

/** Quatre piliers fonctionnels, un rôle exclusif par onglet. */
type TabId = 'explore' | 'route' | 'alerts' | 'settings'
type GovernanceStatus = 'idle' | 'loading' | 'ready' | 'offline'
type PublishedStatus = 'idle' | 'loading' | 'ready' | 'error'
type DestinationShortcutId = 'home' | 'work' | 'address'

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

const SAVED_DESTINATIONS_KEY = 'dakar-bus:destinations'
const DESTINATION_SHORTCUTS: {
  id: DestinationShortcutId
  label: string
  goLabel: string
  setupLabel: string
  icon: typeof Home
}[] = [
  { id: 'home', label: 'Maison', goLabel: 'Rentrer à la maison', setupLabel: 'Définir la maison sur la carte', icon: Home },
  { id: 'work', label: 'Boulot', goLabel: 'Aller au boulot', setupLabel: 'Définir le boulot sur la carte', icon: Briefcase },
  { id: 'address', label: 'Adresse', goLabel: 'Aller à l’adresse enregistrée', setupLabel: 'Définir une adresse sur la carte', icon: MapPin },
]

function readSavedDestinations(): Partial<Record<DestinationShortcutId, MapPoint>> {
  try {
    const stored = window.localStorage.getItem(SAVED_DESTINATIONS_KEY)
    if (!stored) return {}
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

    const destinations: Partial<Record<DestinationShortcutId, MapPoint>> = {}
    for (const shortcut of DESTINATION_SHORTCUTS) {
      const value = (parsed as Record<string, unknown>)[shortcut.id]
      if (!value || typeof value !== 'object') continue
      const point = value as Record<string, unknown>
      if (typeof point.lat !== 'number' || !Number.isFinite(point.lat)) continue
      if (typeof point.lng !== 'number' || !Number.isFinite(point.lng)) continue
      destinations[shortcut.id] = { lat: point.lat, lng: point.lng, label: shortcut.label, kind: 'map' }
    }
    return destinations
  } catch {
    return {}
  }
}

/** Rayon demandé à l’API pour « autour de vous » : 5 km, la limite servie
 *  par /api/stops/near. Les arrêts sont classés du plus proche au plus loin. */
const NEARBY_RADIUS_M = 5000
const NEARBY_LIMIT = 12
/** Walking radius asked from the routing API: declared links only, never a shortcut. */
const ROUTE_MAX_WALK_M = 900

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

function explicitJourneyNetwork(journey: Journey): 'brt' | 'ter' | null {
  const label = `${journey.routeShortName ?? ''} ${journey.routeLongName ?? ''}`
  const isBrt = /(?:^|[^a-z0-9])(?:brt|b1)(?=$|[^a-z0-9])/i.test(label)
  const isTer = /(?:^|[^a-z0-9])ter(?=$|[^a-z0-9])/i.test(label)
  if (isBrt === isTer) return null
  return isBrt ? 'brt' : 'ter'
}

function assistantScheduleFromJourney(search: JourneySearch | null, now: number): AssistantContext['nextDepartureAt'] {
  if (!search) return null
  for (const journey of search.results) {
    if (journey.departureStatus !== 'SCHEDULED' || !journey.nextDepartureAt) continue
    if (getRemainingMinutes(journey.nextDepartureAt, now) === null) continue
    const network = explicitJourneyNetwork(journey)
    if (!network) continue
    const departureStop = journey.departure.stopName ?? journey.departure.stopId
    const arrivalStop = journey.arrival.stopName ?? journey.arrival.stopId
    return {
      network,
      status: 'SCHEDULED',
      nextDepartureAt: journey.nextDepartureAt,
      routeDescription: `${journeyRouteLabel(journey)} · ${departureStop} → ${arrivalStop}`,
    }
  }
  return null
}

/** La barre de navigation répartit l’application en 4 piliers exclusifs :
 *  Explorer (carte + GPS + guide de destination), Trajet (préparation d’itinéraire),
 *  Alertes (information voyageur), Paramètres (aide, données, CGU, historique
 *  et console technique locale). */
const NAV_ITEMS: { id: TabId; label: string; icon: typeof Compass }[] = [
  { id: 'explore', label: 'Explorer', icon: Compass },
  { id: 'route', label: 'Trajet', icon: RouteIcon },
  { id: 'alerts', label: 'Alertes', icon: Bell },
  { id: 'settings', label: 'Paramètres', icon: Settings },
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
  const [activeTab, setActiveTab] = useState<TabId>('explore')
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
  const [savedDestinations, setSavedDestinations] = useState(() => readSavedDestinations())
  const [pendingShortcut, setPendingShortcut] = useState<DestinationShortcutId | null>(null)
  /** Onglet vers lequel revenir après un choix de point sur la carte. */
  const [pickReturnTab, setPickReturnTab] = useState<TabId | null>(null)
  const [routeAttempted, setRouteAttempted] = useState(false)
  const [journey, setJourney] = useState<JourneyState>(IDLE_JOURNEY)
  const [countdownNow, setCountdownNow] = useState(() => Date.now())
  const [toast, setToast] = useState<string | null>(null)
  const [gpsMessage, setGpsMessage] = useState<string | null>(null)
  const [exploreFilter, setExploreFilter] = useState<NetworkId | 'all'>('all')
  const [alertInfoOpen, setAlertInfoOpen] = useState(false)
  /** Section technique de l’onglet Paramètres : console d’administration locale. */
  const [consoleOpen, setConsoleOpen] = useState(false)
  /** Réponse de l’assistant à la dernière recherche universelle. */
  const [assistantAnswer, setAssistantAnswer] = useState<{ question: string; answer: string } | null>(null)
  const [governance, setGovernance] = useState<GovernanceState>({ status: 'idle', datasets: [], pipeline: null, error: null })
  const [published, setPublished] = useState<PublishedState>({ status: 'idle', network: null, error: null })
  const [nearby, setNearby] = useState<NearbyState>({ status: 'idle', stops: [], radius: NEARBY_RADIUS_M, error: null })
  const [lines, setLines] = useState<LinesState>({ status: 'idle', routes: [], error: null })
  const [stopSearch, setStopSearch] = useState<StopSearchState>({ status: 'idle', query: '', stops: [], error: null })
  const [selectedStop, setSelectedStop] = useState<PublishedStopDetail | null>(null)
  const [selectedStopError, setSelectedStopError] = useState<string | null>(null)
  const [showCoverage, setShowCoverage] = useState(true)
  const toastTimer = useRef<number | undefined>(undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const network = published.network
  const dataAvailable = network !== null && isCurrentSnapshot(network)
  const mappablePublishedStops = dataAvailable ? nearby.stops : []

  // Réseau de référence TER/BRT : tracés et arrêts superposés au fond OSM,
  // pilotés par les interrupteurs de couche existants.
  const visibleCorridorLines = CORRIDOR_LINES.filter((line) => networkLayers[line.network])
  const visibleCorridorStops: CorridorStop[] = [
    ...(networkLayers.ter ? TER_STOPS : []),
    ...(networkLayers.brt ? BRT_STOPS : []),
  ]

  function handleSelectCorridorStop(stop: CorridorStop) {
    setRecenterTo({ lat: stop.lat, lng: stop.lon })
    const lines = linesServingStop(stop.id)
    announce(
      `${stop.name} — ${CORRIDOR_NETWORKS[stop.id.startsWith('ter') ? 'ter' : 'brt'].label} (réseau de référence)` +
        (lines.length > 0 ? ` · ligne${lines.length > 1 ? 's' : ''} ${lines.map((line) => line.shortName).join(', ')}` : ''),
    )
  }

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // Le compte à rebours est rafraîchi chaque seconde, uniquement tant qu’au
  // moins un départ GTFS exact est futur ; le timeout est nettoyé au démontage.
  useEffect(() => {
    const hasUpcomingScheduledDeparture = journey.search?.results.some((item) =>
      item.departureStatus === 'SCHEDULED' && item.nextDepartureAt !== null &&
      getRemainingMinutes(item.nextDepartureAt, countdownNow) !== null,
    ) ?? false
    if (!hasUpcomingScheduledDeparture) return
    const timer = window.setTimeout(() => setCountdownNow(Date.now()), 1_000)
    return () => window.clearTimeout(timer)
  }, [journey.search, countdownNow])

  // Les raccourcis clavier passent par une référence : le gestionnaire voit
  // toujours l’état courant (onglet de retour, point en cours de choix…).
  const shortcutRef = useRef<(event: KeyboardEvent) => void>(() => {})

  shortcutRef.current = function handleKeyboardShortcut(event: KeyboardEvent) {
    if (activeTab === 'explore' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    if (event.key === 'Escape') {
      setLayersOpen(false)
      if (pickingPoint) cancelPointSelection()
      else setPickingPoint(null)
    }
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => shortcutRef.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
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

  // Le catalogue local (staging, revue, publications) n’est interrogé que
  // lorsque la section technique de Paramètres est ouverte.
  useEffect(() => {
    if (activeTab !== 'settings' || !consoleOpen) return
    if (governance.status === 'idle') void loadGovernance()
  }, [activeTab, consoleOpen, governance.status, loadGovernance])

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
    const result = await fetchApi(`/api/stops/near?lat=${origin.lat}&lon=${origin.lng}&radius=${NEARBY_RADIUS_M}&limit=${NEARBY_LIMIT}`)
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

  /** Recherche universelle (en-tête) : elle couvre l’index complet des arrêts
   *  et lignes — snapshot publié + réseau de référence TER/BRT — et interroge
   *  l’assistant, qui répond à partir des mêmes références avec leur provenance. */
  function askUniversalSearch(query: string) {
    const question = query.trim()
    setActiveTab('route')
    setPickingPoint(null)
    if (!question) {
      setStopSearch({ status: 'idle', query: '', stops: [], error: null })
      setAssistantAnswer(null)
      return
    }
    const context: AssistantContext = { publishedAvailable: dataAvailable, adminOnline: governance.status === 'ready' }
    setAssistantAnswer({ question, answer: answerAssistant(question, context) })
    void runStopSearch(question)
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

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    askUniversalSearch(search)
  }

  function clearSearch() {
    setSearch('')
    setStopSearch({ status: 'idle', query: '', stops: [], error: null })
    setAssistantAnswer(null)
  }

  /** Annule un choix de point en cours et ramène l’utilisateur d’où il vient. */
  function cancelPointSelection() {
    const target = pickReturnTab
    setPickingPoint(null)
    setPendingShortcut(null)
    setPickReturnTab(null)
    setLayersOpen(false)
    if (target && target !== 'explore') setActiveTab(target)
  }

  function startPointSelection(key: RoutePointKey) {
    // La carte n’est montée que dans l’onglet « Explorer » : on y emmène
    // l’utilisateur pour désigner le point, puis on le ramène au trajet.
    setPendingShortcut(null)
    setPickReturnTab('route')
    setActiveTab('explore')
    setPickingPoint(key)
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setLayersOpen(false)
    announce(key === 'origin' ? 'Touchez la carte pour choisir un point de départ.' : 'Touchez la carte pour choisir une destination.')
  }

  function chooseDestinationShortcut(id: DestinationShortcutId) {
    const shortcut = DESTINATION_SHORTCUTS.find((candidate) => candidate.id === id)!
    const saved = savedDestinations[id]
    if (saved) {
      setRoutePoints((current) => ({ ...current, destination: saved }))
      setRouteAttempted(false)
      setJourney(IDLE_JOURNEY)
      setActiveTab('route')
      announce(`Destination ${shortcut.label} choisie.`)
      return
    }

    setPendingShortcut(id)
    setPickReturnTab('route')
    setActiveTab('explore')
    setPickingPoint('destination')
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setLayersOpen(false)
    announce(`Touchez la carte pour définir ${shortcut.label}.`)
  }

  function handleMapPick(point: Coordinates) {
    if (!pickingPoint) return
    const picked = pickingPoint
    const shortcut = pendingShortcut
      ? DESTINATION_SHORTCUTS.find((candidate) => candidate.id === pendingShortcut)
      : undefined
    const nextPoint: MapPoint = { ...point, label: shortcut?.label ?? 'Point choisi sur la carte' }
    setRoutePoints((current) => ({ ...current, [picked]: nextPoint }))
    if (pendingShortcut) {
      const savedId = pendingShortcut
      setSavedDestinations((current) => {
        const next = { ...current, [savedId]: nextPoint }
        try {
          window.localStorage.setItem(SAVED_DESTINATIONS_KEY, JSON.stringify(next))
        } catch {
          // La destination reste utilisable en mémoire même si le stockage est indisponible.
        }
        return next
      })
    }
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    setPickingPoint(null)
    setPendingShortcut(null)
    const target = pickReturnTab
    setPickReturnTab(null)
    if (target && target !== 'explore') setActiveTab(target)
    announce(shortcut ? `${shortcut.label} enregistrée comme destination.` : picked === 'origin' ? 'Point de départ enregistré.' : 'Destination enregistrée.')
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

  /** Arrêts choisis dans l’onglet Trajet sans passer par la carte :
   *  les arrêts publiés déjà lus par l’application, puis le réseau de
   *  référence TER/BRT. Aucun lieu n’est deviné : la liste est exhaustive. */
  const selectablePublishedStops = [...nearby.stops, ...stopSearch.stops].filter(
    (stop, index, all) =>
      stop.lat !== null && stop.lon !== null && all.findIndex((candidate) => candidate.stopId === stop.stopId) === index,
  )
  const routeStopOptions: StopOption[] = [
    ...selectablePublishedStops.map((stop) => ({ value: `published:${stop.stopId}`, label: `${stop.stopName} (publié)`, group: 'Arrêts publiés' })),
    ...BRT_STOPS.map((stop) => ({ value: `ref:${stop.id}`, label: `BRT · ${stop.name}`, group: 'Réseau de référence BRT' })),
    ...TER_STOPS.map((stop) => ({ value: `ref:${stop.id}`, label: `TER · ${stop.name}`, group: 'Réseau de référence TER' })),
  ]

  function selectRoutePoint(key: RoutePointKey, value: string) {
    if (!value) return
    const separator = value.indexOf(':')
    const kind = value.slice(0, separator)
    const id = value.slice(separator + 1)
    let next: MapPoint | null = null
    if (kind === 'published') {
      const stop = selectablePublishedStops.find((candidate) => candidate.stopId === id)
      if (stop && stop.lat !== null && stop.lon !== null) {
        next = { lat: stop.lat, lng: stop.lon, label: stop.stopName, kind: 'stop', stopId: stop.stopId }
      }
    } else {
      const stop = getCorridorStop(id)
      if (stop) next = { lat: stop.lat, lng: stop.lon, label: stop.name }
    }
    if (!next) {
      announce('Cet arrêt n’est plus disponible : choisissez-en un autre.')
      return
    }
    setRoutePoints((current) => ({ ...current, [key]: next! }))
    setRouteAttempted(false)
    setJourney(IDLE_JOURNEY)
    announce(key === 'origin' ? `${next.label} défini comme départ.` : `${next.label} défini comme destination.`)
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

  // La carte n'existe que sur l'onglet « Explorer » : ailleurs, elle est
  // démontée du DOM. Dans Explorer, elle occupe le tiers supérieur de l’écran.
  const mapVisible = activeTab === 'explore'
  const showStopCard = activeTab === 'explore' || activeTab === 'route'

  return (
    <main className={`app-shell tab-${activeTab}${mapVisible ? '' : ' is-map-hidden'}`}>
      {mapVisible && (
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
          initialBounds={DAKAR_REGION_BOUNDS}
          corridorLines={visibleCorridorLines}
          corridorStops={visibleCorridorStops}
          onSelectCorridorStop={handleSelectCorridorStop}
        />

        <div className="map-heading-overlay">
          <div className="map-place-chip">
            <span className="place-icon"><MapPin size={15} /></span>
            <span>Dakar</span>
            <span className="place-separator" />
            <span className="place-country">Sénégal</span>
          </div>
        </div>

        <div className="map-actions-top">
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
              <p className="popover-note">TER et BRT affichent le réseau de référence (tracés et arrêts de source publique) ; les autres catégories restent vides tant qu’une source fiable n’est pas intégrée.</p>
              <div className="layer-options">
                {NETWORK_SOURCES.map((network) => (
                  <label className="layer-option" key={network.id}>
                    <input type="checkbox" checked={networkLayers[network.id]} onChange={() => toggleNetwork(network.id)} />
                    <span className={`layer-icon layer-icon-${network.id}`}><NetworkIcon id={network.id} size={16} /></span>
                    <span className="layer-label">{network.label}</span>
                    <span className="layer-empty">
                      {network.id === 'ter' ? `${TER_STOPS.length} gares (référence)`
                        : network.id === 'brt' ? `${BRT_STOPS.length} stations (référence)`
                        : 'sans données'}
                    </span>
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
              <div className="popover-footnote"><Info size={13} /> Les couches de référence n’ajoutent ni horaire GTFS ni temps réel.</div>
            </div>
          )}
        </div>

        {pickingPoint && (
          <div className="map-pick-banner" role="status">
            <MapPin size={16} />
            <span>
              {pendingShortcut
                ? `Touchez la carte pour définir ${DESTINATION_SHORTCUTS.find((shortcut) => shortcut.id === pendingShortcut)?.label ?? 'votre adresse'}`
                : `Choisissez ${pickingPoint === 'origin' ? 'un point de départ' : 'une destination'} sur la carte`}
            </span>
            <button type="button" aria-label="Annuler la sélection" onClick={cancelPointSelection}><X size={16} /></button>
          </div>
        )}

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

        {/* Assistant IA : bouton flottant en bas à gauche de la carte. */}
        <AssistantChat context={{
          publishedAvailable: dataAvailable,
          adminOnline: governance.status === 'ready',
          nextDepartureAt: assistantScheduleFromJourney(journey.search, countdownNow),
        }} />
      </section>
      )}

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
                  onClick={() => { setActiveTab(item.id); setPickingPoint(null); setPendingShortcut(null); setPickReturnTab(null); setLayersOpen(false) }}
                >
                  <Icon size={16} strokeWidth={1.9} />
                  <span>{item.label}</span>
                  {item.id === 'alerts' && <span className="nav-dot" aria-label="Source non connectée" />}
                </button>
              )
            })}
          </nav>
        </div>

        {/* La fiche d’arrêt n’accompagne que les onglets qui manipulent des
            arrêts (carte/exploration et calcul d’itinéraire). */}
        {showStopCard && selectedStop && (
          <StopCard
            stop={selectedStop}
            onClose={() => { setSelectedStop(null); setSelectedStopError(null) }}
            onUseAsOrigin={() => useStopAsRoutePoint(selectedStop, 'origin')}
            onUseAsDestination={() => useStopAsRoutePoint(selectedStop, 'destination')}
          />
        )}
        {showStopCard && selectedStopError && (
          <div className="stop-card stop-card-error" role="status">
            <AlertTriangle size={15} />
            <span>{selectedStopError}</span>
            <button type="button" aria-label="Fermer" onClick={() => setSelectedStopError(null)}><X size={15} /></button>
          </div>
        )}

        <div className="panel-content" key={activeTab}>
          {activeTab === 'explore' && (
            <ExplorerPanel
              gpsState={gpsState}
              gpsMessage={gpsMessage}
              onLocate={() => requestLocation()}
              dataAvailable={dataAvailable}
              nearby={nearby}
              onSelectStop={(stop) => void openStop(stop)}
              search={search}
              onSearchChange={setSearch}
              onSearchSubmit={handleSearchSubmit}
              onClearSearch={clearSearch}
              searchInputRef={searchInputRef}
              savedDestinations={savedDestinations}
              onChooseShortcut={chooseDestinationShortcut}
            />
          )}

          {activeTab === 'route' && (
            <>
              {search.trim() && (
                <UniversalSearchCard
                  query={search}
                  answer={assistantAnswer}
                  search={stopSearch}
                  onRetry={() => askUniversalSearch(search)}
                  onClear={clearSearch}
                  onSelectPublishedStop={(stop) => void openStop(stop)}
                  onSelectReferenceStop={handleSelectCorridorStop}
                  dataAvailable={dataAvailable}
                />
              )}
              <RoutePanel
                routePoints={routePoints}
                pickingPoint={pickingPoint}
                routeAttempted={routeAttempted}
                stopOptions={routeStopOptions}
                onSelectPoint={startPointSelection}
                onSelectStop={selectRoutePoint}
                onUseLocation={() => requestLocation('origin')}
                onSwap={swapRoutePoints}
                onClear={() => { setRoutePoints({}); setRouteAttempted(false); setPickingPoint(null); setJourney(IDLE_JOURNEY) }}
                onSubmit={submitRoute}
                dataAvailable={dataAvailable}
                journey={journey}
                countdownNow={countdownNow}
              />
              <details className="advanced-planner">
                <summary>Autres options de trajet</summary>
                <MultimodalPlanner mapOrigin={routePoints.origin} mapDestination={routePoints.destination} />
              </details>
            </>
          )}

          {activeTab === 'alerts' && (
            <AlertsPanel infoOpen={alertInfoOpen} onToggleInfo={() => setAlertInfoOpen((open) => !open)} />
          )}

          {activeTab === 'settings' && (
            <>
              <SettingsHelpSection />
              <SettingsDisclosure title="Réseaux et données">
                <DataCatalogSection
                  filter={exploreFilter}
                  sources={visibleSources}
                  onFilterChange={setExploreFilter}
                  onToggleLayer={toggleNetwork}
                  layerState={networkLayers}
                  dataAvailable={dataAvailable}
                  lines={lines}
                  onFocusReferenceStop={(stop: CorridorStop) => { setActiveTab('explore'); handleSelectCorridorStop(stop) }}
                />
              </SettingsDisclosure>
              <SettingsDisclosure title="Conditions d’utilisation"><LegalSection /></SettingsDisclosure>
              <SettingsDisclosure title="Mises à jour"><ChangelogSection /></SettingsDisclosure>
              <SettingsDisclosure title="État des données">
                <ReadApiCard published={published} dataAvailable={dataAvailable} onRefresh={() => void loadPublishedNetwork()} />
              </SettingsDisclosure>
              <LocalConsoleSection
                open={consoleOpen}
                onToggle={() => setConsoleOpen((current) => !current)}
                state={governance}
                onReload={() => void loadGovernance()}
              />
            </>
          )}
        </div>

        <footer className="sidebar-footer">
          <div className="footer-truth-mark"><ShieldCheck size={15} /><span>Pas de donnée, pas d’affirmation.</span></div>
          <button type="button" className="footer-link" onClick={() => { setActiveTab('settings'); setConsoleOpen(false) }}>Aide, CGU & sources <ArrowRight size={13} /></button>
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
              onClick={() => { setActiveTab(item.id); setPickingPoint(null); setPendingShortcut(null); setPickReturnTab(null) }}
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

/** État de l’API de lecture : il n’apparaît jamais sur la carte. Il vit dans
 *  l’onglet Paramètres, seul centre d’état des API et d’aide. */
function ReadApiCard({
  published,
  dataAvailable,
  onRefresh,
}: {
  published: PublishedState
  dataAvailable: boolean
  onRefresh: () => void
}) {
  const network = published.network
  const badge = publishedBadge(published)
  return (
    <>
      <div className="governance-list-heading">
        <span>API DE LECTURE · SNAPSHOT PUBLIÉ</span>
        <span className="source-count">/api/network</span>
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
    </>
  )
}

function publishedBadge(state: PublishedState): { label: string; tone: 'neutral' | 'published' | 'warning' } {
  if (state.status === 'loading') return { label: 'LECTURE', tone: 'neutral' }
  if (state.status === 'error') return { label: 'INDISPONIBLE', tone: 'warning' }
  if (state.network && isCurrentSnapshot(state.network)) return { label: 'PUBLIÉ', tone: 'published' }
  if (state.network?.available) return { label: 'PÉRIODE DÉPASSÉE', tone: 'warning' }
  return { label: 'EN ATTENTE', tone: 'neutral' }
}

/** Guide de déplacement : carte en tête, recherche claire et raccourcis utiles. */
function ExplorerPanel({
  gpsState,
  gpsMessage,
  onLocate,
  dataAvailable,
  nearby,
  onSelectStop,
  search,
  onSearchChange,
  onSearchSubmit,
  onClearSearch,
  searchInputRef,
  savedDestinations,
  onChooseShortcut,
}: {
  gpsState: GpsState
  gpsMessage: string | null
  onLocate: () => void
  dataAvailable: boolean
  nearby: NearbyState
  onSelectStop: (stop: PublishedStop) => void
  search: string
  onSearchChange: (value: string) => void
  onSearchSubmit: (event: FormEvent<HTMLFormElement>) => void
  onClearSearch: () => void
  searchInputRef: { current: HTMLInputElement | null }
  savedDestinations: Partial<Record<DestinationShortcutId, MapPoint>>
  onChooseShortcut: (id: DestinationShortcutId) => void
}) {
  const locationHint = gpsState === 'loading'
    ? 'Recherche de votre position…'
    : gpsState === 'denied' || gpsState === 'error'
      ? gpsMessage ?? 'Votre position n’est pas disponible.'
      : gpsState === 'ready'
        ? gpsMessage ?? 'Votre position est affichée sur la carte.'
        : 'Touchez la carte ou cherchez une destination.'

  return (
    <section className="panel explore-guide-panel" aria-label="Guide de déplacement">
      <div className="explore-guide-heading">
        <div>
          <span className="eyebrow">GUIDE DE DÉPLACEMENT</span>
          <h2>On va où&nbsp;?</h2>
        </div>
        <button type="button" className="text-action explore-locate" onClick={onLocate} disabled={gpsState === 'loading'}>
          <LocateFixed size={18} className={gpsState === 'loading' ? 'is-spinning' : ''} />
          {gpsState === 'loading' ? 'Recherche…' : 'Ma position'}
        </button>
      </div>

      <form className="search-form explore-search-form" role="search" onSubmit={onSearchSubmit}>
        <Search size={20} className="search-icon" aria-hidden="true" />
        <input
          ref={searchInputRef}
          aria-label="Rechercher un arrêt, une station ou une destination"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="On va où ?"
        />
        {search && (
          <button type="button" className="search-clear" aria-label="Effacer la recherche" onClick={onClearSearch}>
            <X size={17} />
          </button>
        )}
        <button type="submit" className="search-submit" aria-label="Rechercher" disabled={!search.trim()}>
          <ArrowRight size={19} />
        </button>
      </form>

      <p className="explore-guide-hint" role="status">{locationHint}</p>

      {dataAvailable && gpsState === 'ready' && nearby.status === 'loading' && (
        <p className="explore-nearby-message" role="status">Recherche des arrêts proches…</p>
      )}
      {dataAvailable && gpsState === 'ready' && nearby.status === 'error' && (
        <p className="explore-nearby-message" role="status">Les arrêts proches n’ont pas pu être chargés.</p>
      )}
      {dataAvailable && gpsState === 'ready' && nearby.status === 'ready' && (
        <section className="explore-nearby" aria-label="Arrêts proches">
          <h3>Près de vous</h3>
          {nearby.stops.length > 0 ? (
            <ul className="published-stop-list">
              {nearby.stops.slice(0, 3).map((stop) => (
                <li key={stop.stopId}>
                  <button type="button" className="published-stop-row" onClick={() => onSelectStop(stop)}>
                    <span className="stop-row-icon"><MapPin size={17} /></span>
                    <span className="stop-row-copy"><strong>{stop.stopName}</strong></span>
                    <small className="explore-stop-distance">{formatDistance(stop.distanceM) ?? ''}</small>
                    <ArrowRight size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Aucun arrêt à proximité pour le moment.</p>
          )}
        </section>
      )}

      {!dataAvailable && (
        <p className="explore-data-note">Aucun horaire GTFS n’est connecté. Les fiches ci-dessous sont des références officielles, pas des prochains passages.</p>
      )}

      <ReferenceFrequencyCards />

      <div className="destination-shortcuts" aria-label="Destinations enregistrées">
        <strong className="destination-shortcuts-title">Mes destinations</strong>
        <div className="destination-shortcuts-row">
          {DESTINATION_SHORTCUTS.map((shortcut) => {
            const Icon = shortcut.icon
            const isSaved = Boolean(savedDestinations[shortcut.id])
            return (
              <button
                key={shortcut.id}
                type="button"
                className={`destination-shortcut${isSaved ? ' is-saved' : ''}`}
                aria-label={isSaved ? shortcut.goLabel : shortcut.setupLabel}
                title={isSaved ? shortcut.goLabel : shortcut.setupLabel}
                onClick={() => onChooseShortcut(shortcut.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{shortcut.label}</span>
                {isSaved ? <ArrowRight size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

const REFERENCE_NETWORK_CARD_IDS = ['ter', 'brt', 'ddd', 'aftu'] as const

function ReferenceFrequencyCards() {
  return (
    <section className="network-reference-cards-section" aria-label="Fréquences et services de référence">
      <div className="network-reference-cards-heading">
        <strong>Réseaux de référence</strong>
        <span>Service · pas temps réel</span>
      </div>
      <div className="network-reference-cards">
        {REFERENCE_NETWORK_CARD_IDS.map((id) => {
          const network = NETWORK_REFERENCE_DATA[id]
          const Icon = NETWORK_ICONS[id]
          const counts = [
            network.stationCount === null ? null : `${network.stationCount} ${id === 'ter' ? 'gares' : 'stations'}`,
            network.lineCount === null || id === 'brt' ? null : `${network.lineCount} lignes`,
            network.vehicleCount === null ? null : `${network.vehicleCount.toLocaleString('fr-FR')} bus`,
            network.gieCount === null ? null : `${network.gieCount} GIE`,
          ].filter((value): value is string => value !== null)
          const sourceLabel = id === 'brt' ? 'CETUD / SunuBRT' : id === 'ter' ? 'TER / SETER' : 'CETUD'
          return (
            <article className={`network-reference-card reference-${id}`} key={id}>
              <header className="network-reference-card-head">
                <span className={`network-reference-icon network-${id}`}><Icon size={17} aria-hidden="true" /></span>
                <span className="network-reference-title">
                  <strong>{network.label}</strong>
                  <small>{network.coverage}</small>
                </span>
              </header>
              <p className="network-reference-counts">{counts.join(' · ')}</p>
              <div className={`network-reference-frequency${network.frequencyStatus === 'UNKNOWN' ? ' is-unknown' : ''}`}>
                <strong>{network.frequencyStatus === 'OFFICIAL_REFERENCE' ? network.frequencyLabel : 'Horaires non disponibles'}</strong>
                <span>{network.frequencyStatus === 'OFFICIAL_REFERENCE' ? 'Fréquence officielle de référence' : network.frequencyLabel}</span>
              </div>
              <p className="network-reference-service">Service {network.serviceWindow}</p>
              {network.officialFrequencies.length > 1 && (
                <ul className="network-reference-periods">
                  {network.officialFrequencies.map((frequency, index) => (
                    <li key={`${frequency.serviceStart}-${frequency.serviceEnd}-${index}`}>{formatFrequencyPeriod(frequency)}</li>
                  ))}
                </ul>
              )}
              <p className="network-reference-source">
                Source : <a href={network.source.sourceUrl} target="_blank" rel="noreferrer">{sourceLabel}</a>
                {' · '}{formatSourceVerification(network.source)}
              </p>
              <p className="network-reference-validity">Validité calendaire : dates non précisées dans la référence locale.</p>
            </article>
          )
        })}
      </div>
    </section>
  )
}

interface StopOption {
  value: string
  label: string
  group: string
}

function PointField({
  title,
  point,
  pointKey,
  isPicking,
  stopOptions,
  onSelect,
  onSelectStop,
}: {
  title: string
  point?: MapPoint
  pointKey: RoutePointKey
  isPicking: boolean
  stopOptions: readonly StopOption[]
  onSelect: (key: RoutePointKey) => void
  onSelectStop: (key: RoutePointKey, value: string) => void
}) {
  const groups = Array.from(new Set(stopOptions.map((option) => option.group)))
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
        {stopOptions.length > 0 && (
          <select
            className="point-stop-select"
            aria-label={`${title} parmi les arrêts connus`}
            value=""
            onChange={(event) => onSelectStop(pointKey, event.target.value)}
          >
            <option value="">Choisir un arrêt par son nom…</option>
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {stopOptions
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
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
  onSelectStop,
  stopOptions,
  onUseLocation,
  onSwap,
  onClear,
  onSubmit,
  dataAvailable,
  journey,
  countdownNow,
}: {
  routePoints: Partial<Record<RoutePointKey, MapPoint>>
  pickingPoint: RoutePointKey | null
  routeAttempted: boolean
  onSelectPoint: (key: RoutePointKey) => void
  onSelectStop: (key: RoutePointKey, value: string) => void
  stopOptions: readonly StopOption[]
  onUseLocation: () => void
  onSwap: () => void
  onClear: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  dataAvailable: boolean
  journey: JourneyState
  countdownNow: number
}) {
  return (
    <section className="panel route-panel" aria-label="Planifier un itinéraire">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">GUIDE DE TRAJET</span>
          <h2>Préparer un trajet</h2>
          <p>Choisissez votre départ et votre destination.</p>
        </div>
        {(routePoints.origin || routePoints.destination) && <button type="button" className="icon-button clear-route" aria-label="Effacer le trajet" onClick={onClear}><X size={16} /></button>}
      </div>

      <form onSubmit={onSubmit}>
        <div className="route-fields-wrap">
          <div className="route-connector" aria-hidden="true"><i /><span /><i /></div>
          <PointField
            title="Départ"
            point={routePoints.origin}
            pointKey="origin"
            isPicking={pickingPoint === 'origin'}
            stopOptions={stopOptions}
            onSelect={onSelectPoint}
            onSelectStop={onSelectStop}
          />
          <button type="button" className="swap-route" aria-label="Inverser départ et destination" onClick={onSwap}><ArrowDownUp size={15} /></button>
          <PointField
            title="Destination"
            point={routePoints.destination}
            pointKey="destination"
            isPicking={pickingPoint === 'destination'}
            stopOptions={stopOptions}
            onSelect={onSelectPoint}
            onSelectStop={onSelectStop}
          />
        </div>

        <button type="button" className="use-location-action" onClick={onUseLocation}>
          <LocateFixed size={15} /> Utiliser ma position comme départ
        </button>

        <button className="primary-action route-submit" type="submit" disabled={!routePoints.origin || !routePoints.destination}>
          <Search size={17} /><span>Rechercher un itinéraire</span><ArrowRight size={16} />
        </button>
      </form>

      {routeAttempted ? (
        <RouteOutcome journey={journey} dataAvailable={dataAvailable} countdownNow={countdownNow} />
      ) : (
        <div className="route-truth-card">
          <div className="route-truth-icon"><ShieldCheck size={17} /></div>
          {dataAvailable ? (
            <div><strong>Horaires disponibles</strong><span>Trajets directs uniquement.</span></div>
          ) : (
            <div><strong>En attente des horaires</strong><span>Le calcul s’activera dès qu’une source vérifiée sera disponible.</span></div>
          )}
        </div>
      )}

    </section>
  )
}

function RouteOutcome({ journey, dataAvailable, countdownNow }: { journey: JourneyState; dataAvailable: boolean; countdownNow: number }) {
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
          <JourneyCard key={`${item.tripId ?? item.routeId}-${item.departure.declaredTime}-${item.date}`} journey={item} localDay={search.localDay} now={countdownNow} />
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

function JourneyCard({ journey, localDay, now }: { journey: Journey; localDay: string; now: number }) {
  const departureWalk = walkSummary(journey.departure)
  const arrivalWalk = walkSummary(journey.arrival)
  const countdownMinutes = journey.departureStatus === 'SCHEDULED' && journey.nextDepartureAt
    ? getRemainingMinutes(journey.nextDepartureAt, now)
    : null
  const scheduledDepartureExpired = journey.departureStatus === 'SCHEDULED' && journey.nextDepartureAt !== null && countdownMinutes === null
  return (
    <li className="journey-card">
      <div className="journey-card-head">
        <span className="journey-route-badge">{journeyRouteLabel(journey)}</span>
        <span className="journey-mode">{describeRouteType(journey.routeType)}</span>
        {journey.routeLongName && <span className="journey-route-name">{journey.routeLongName}</span>}
        {countdownMinutes !== null && (
          <span className="journey-countdown" role="status" aria-label={`Départ programmé dans ${countdownMinutes} minutes`}>
            Départ programmé dans {countdownMinutes} min
          </span>
        )}
        {scheduledDepartureExpired && (
          <span className="journey-expired-note" role="status">Départ passé · relancez la recherche pour consulter une autre course déclarée.</span>
        )}
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

/** Résultats de la recherche lancée depuis le guide Explorer : l’index couvre
 *  les arrêts disponibles (snapshot publié + réseau de référence TER/BRT),
 *  puis présente les réponses vérifiées dans l’onglet Trajet. */
function UniversalSearchCard({
  query,
  answer,
  search,
  onRetry,
  onClear,
  onSelectPublishedStop,
  onSelectReferenceStop,
  dataAvailable,
}: {
  query: string
  answer: { question: string; answer: string } | null
  search: StopSearchState
  onRetry: () => void
  onClear: () => void
  onSelectPublishedStop: (stop: PublishedStop) => void
  onSelectReferenceStop: (stop: CorridorStop) => void
  dataAvailable: boolean
}) {
  const referenceMatches = searchCorridorStops(query).slice(0, 8)
  const publishedCount = search.status === 'ready' ? search.stops.length : 0
  return (
    <section className="panel universal-search-card" aria-label="Résultats de recherche">
      <div className="universal-query-row">
        <span>Résultats pour « {query.trim()} »</span>
        <button type="button" className="icon-button" aria-label="Effacer la recherche" onClick={onClear}><X size={16} /></button>
      </div>

      {query.trim() && (
        <>
          {answer && (
            <div className="assistant-answer">
              <div className="assistant-answer-head"><Bot size={15} /><strong>Assistant mobilité</strong></div>
              <p>{answer.answer}</p>
            </div>
          )}

          <div className="source-list-heading">
            <span>ARRÊTS PUBLIÉS CORRESPONDANTS</span>
            <span className="source-count">
              {search.status === 'ready' ? `${publishedCount} résultat${publishedCount > 1 ? 's' : ''}` : search.status === 'loading' ? 'recherche…' : dataAvailable ? 'indisponible' : 'aucune publication'}
            </span>
          </div>
          {search.status === 'error' && (
            <div className="published-inline-error">
              <AlertTriangle size={14} />
              <span>{search.error}</span>
              <button type="button" onClick={onRetry}>Réessayer</button>
            </div>
          )}
          {search.status === 'ready' && publishedCount === 0 && (
            <p className="stop-card-note">Aucun arrêt publié ne porte ce nom.</p>
          )}
          {search.status === 'ready' && publishedCount > 0 && (
            <ul className="published-stop-list">
              {search.stops.map((stop) => (
                <li key={stop.stopId}>
                  <button type="button" className="published-stop-row" onClick={() => onSelectPublishedStop(stop)}>
                    <span className="stop-row-icon"><MapPin size={15} /></span>
                    <span className="stop-row-copy">
                      <strong>{stop.stopName}</strong>
                      <small>{stop.stopId}{stop.parentStation ? ` · parent ${stop.parentStation}` : ''} · arrêt publié</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {referenceMatches.length > 0 && (
            <>
              <div className="source-list-heading">
                <span>RÉSEAU DE RÉFÉRENCE TER/BRT</span>
                <span className="source-count">{referenceMatches.length} correspondance{referenceMatches.length > 1 ? 's' : ''}</span>
              </div>
              <ul className="reference-stop-list">
                {referenceMatches.map((stop) => {
                  const isTer = stop.id.startsWith('ter')
                  const Icon = isTer ? TrainFront : BusFront
                  return (
                    <li key={stop.id}>
                      <button type="button" className="published-stop-row" onClick={() => onSelectReferenceStop(stop)}>
                        <span className={`stop-row-icon reference-icon-${isTer ? 'ter' : 'brt'}`}><Icon size={15} /></span>
                        <span className="stop-row-copy">
                          <strong>{stop.name}</strong>
                          <small>
                            {CORRIDOR_NETWORKS[isTer ? 'ter' : 'brt'].label} · {linesServingStop(stop.id).map((line) => line.shortName).join(', ')} · référence
                          </small>
                        </span>
                        <ArrowRight size={14} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** Section « Réseaux et données » de Paramètres : catalogue lisible des lignes
 *  publiées, du réseau de référence TER/BRT et des sources à relier. */
function DataCatalogSection({
  filter,
  sources,
  onFilterChange,
  onToggleLayer,
  layerState,
  dataAvailable,
  lines,
  onFocusReferenceStop,
}: {
  filter: NetworkId | 'all'
  sources: readonly NetworkSource[]
  onFilterChange: (filter: NetworkId | 'all') => void
  onToggleLayer: (id: NetworkId) => void
  layerState: Record<NetworkId, boolean>
  dataAvailable: boolean
  lines: LinesState
  onFocusReferenceStop: (stop: CorridorStop) => void
}) {
  const filters: { id: NetworkId | 'all'; label: string }[] = [
    { id: 'all', label: 'Tout' },
    { id: 'ter', label: 'TER' },
    { id: 'brt', label: 'BRT' },
    { id: 'ddd', label: 'DDD' },
    { id: 'aftu', label: 'AFTU' },
    { id: 'tata', label: 'TATA' },
  ]
  const referenceStops = filter === 'ter' ? TER_STOPS : filter === 'brt' ? BRT_STOPS : [...TER_STOPS, ...BRT_STOPS]

  return (
    <section className="panel explore-panel" aria-label="Réseaux et données publiées">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">RÉSEAU DE DAKAR</span>
          <h2>Réseaux et données.</h2>
          <p>Les données affichées proviennent du snapshot publié ou du réseau de référence, jamais d’un catalogue inventé.</p>
        </div>
        <span className="explore-icon"><Compass size={19} /></span>
      </div>

      <div className="source-list-heading">
        <span>MOBILITÉS SUIVIES</span>
        <span className="source-count">{layerState && Object.values(layerState).filter(Boolean).length} couches actives</span>
      </div>
      <div className="layer-options settings-layer-options">
        {NETWORK_SOURCES.map((network) => (
          <label className="layer-option" key={network.id}>
            <input type="checkbox" checked={layerState[network.id]} onChange={() => onToggleLayer(network.id)} />
            <span className={`layer-icon layer-icon-${network.id}`}><NetworkIcon id={network.id} size={16} /></span>
            <span className="layer-label">{network.label}</span>
            <span className="layer-empty">
              {network.id === 'ter' ? `${TER_STOPS.length} gares · référence`
                : network.id === 'brt' ? `${BRT_STOPS.length} stations · référence`
                : network.referenceData?.lineCount ? `${network.referenceData.lineCount} lignes · horaires inconnus`
                : 'sans données de référence'}
            </span>
          </label>
        ))}
      </div>

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
            <span>Les arrêts et lignes publiés apparaîtront ici dès qu’un snapshot vérifié sera publié via <code>npm run publish:gtfs</code>. En attendant, le réseau de référence ci-dessous reste consultable.</span>
          </div>
        </div>
      )}

      {(filter === 'all' || filter === 'ter' || filter === 'brt') && (
        <div className="reference-network-block">
          <div className="source-list-heading">
            <span>RÉSEAU DE RÉFÉRENCE {filter === 'all' ? '· TER + BRT' : `· ${filter.toUpperCase()}`}</span>
            <span className="source-count">{referenceStops.length} arrêts</span>
          </div>
          <p className="reference-provenance">
            {(filter === 'ter' || filter === 'all') && CORRIDOR_NETWORKS.ter.provenance}{' '}
            {(filter === 'brt' || filter === 'all') && CORRIDOR_NETWORKS.brt.provenance}
          </p>
          <ul className="reference-stop-list">
            {referenceStops.map((stop) => {
              const serving = linesServingStop(stop.id)
              const isTer = stop.id.startsWith('ter')
              const Icon = isTer ? TrainFront : BusFront
              return (
                <li key={stop.id}>
                  <button type="button" className="published-stop-row" onClick={() => onFocusReferenceStop(stop)}>
                    <span className={`stop-row-icon reference-icon-${isTer ? 'ter' : 'brt'}`}><Icon size={15} /></span>
                    <span className="stop-row-copy">
                      <strong>{stop.name}</strong>
                      <small>{serving.map((line) => line.shortName).join(', ')}{stop.note ? ` · ${stop.note}` : ''} · référence</small>
                    </span>
                    <ArrowRight size={14} />
                  </button>
                </li>
              )
            })}
          </ul>
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
            </article>
          )
        })}
      </div>
    </section>
  )
}
function AlertsPanel({ infoOpen, onToggleInfo }: { infoOpen: boolean; onToggleInfo: () => void }) {
  return (
    <section className="panel alerts-panel" aria-label="Alertes de service">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">INFORMATION VOYAGEUR</span>
          <h2>Alertes</h2>
          <p>Les informations vérifiées apparaîtront ici.</p>
        </div>
        <span className="alert-heading-icon"><Bell size={20} /></span>
      </div>

      <div className="alerts-unavailable-card">
        <div className="alerts-status-icon"><CircleAlert size={22} /></div>
        <span className="eyebrow">PAS DE FLUX CONNECTÉ</span>
        <h3>Aucune alerte vérifiée pour le moment.</h3>
        <p>Vérifiez auprès de votre opérateur avant de partir.</p>
        <button
          type="button"
          className="quiet-action"
          aria-expanded={infoOpen}
          onClick={onToggleInfo}
        >
          {infoOpen ? 'Masquer les canaux officiels' : 'Voir les canaux officiels'}
          <ChevronDown size={16} className={infoOpen ? 'rotate-icon' : ''} />
        </button>
        {infoOpen && (
          <div className="alert-channels-card">
            <p className="alert-channels-intro">L’absence d’alerte ne garantit pas un service normal.</p>
            <ul className="alert-channels-list">
              <li><strong>TER</strong><a href="https://sentersa.sn" target="_blank" rel="noreferrer">sentersa.sn</a></li>
              <li><strong>BRT</strong><a href="https://sunubrt.sn" target="_blank" rel="noreferrer">sunubrt.sn</a></li>
              <li><strong>CETUD</strong><a href="https://cetud.sn" target="_blank" rel="noreferrer">cetud.sn</a></li>
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

/** Section technique de Paramètres : la console locale n’est chargée qu’à
 *  l’ouverture explicite, et le rôle de chaque onglet reste inchangé. */
function LocalConsoleSection({
  open,
  onToggle,
  state,
  onReload,
}: {
  open: boolean
  onToggle: () => void
  state: GovernanceState
  onReload: () => void
}) {
  return (
    <section className="panel settings-technical" aria-label="Console d’administration locale">
      <button type="button" className="technical-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="technical-icon"><Lock size={16} /></span>
        <span className="technical-copy">
          <strong>Console d’administration locale</strong>
          <small>Staging, revue et publication GTFS · technique, hors ligne par défaut</small>
        </span>
        <ChevronDown size={16} className={open ? 'rotate-icon' : ''} />
      </button>
      {open && <GovernancePanel state={state} onReload={onReload} />}
    </section>
  )
}

/** Aide : mode d’emploi de l’application, pilier par pilier. */
function SettingsHelpSection() {
  const steps: { id: TabId; label: string; text: string }[] = [
    {
      id: 'explore',
      label: 'Explorer',
      text: 'Recherchez « On va où ? », utilisez votre position ou touchez la carte. Enregistrez vos destinations en bas.'
    },
    {
      id: 'route',
      label: 'Trajet',
      text: 'Choisissez un départ, puis une destination.'
    },
    {
      id: 'alerts',
      label: 'Alertes',
      text: 'Consultez les informations et les canaux des réseaux.'
    },
    {
      id: 'settings',
      label: 'Paramètres',
      text: 'Retrouvez les réseaux, les sources et les informations de l’application.'
    },
  ]
  return (
    <section className="panel settings-panel" aria-label="Mode d’emploi">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">MODE D’EMPLOI</span>
          <h2>Votre guide</h2>
          <p>Les étapes essentielles pour vous déplacer à Dakar.</p>
        </div>
        <span className="explore-icon"><BookOpen size={19} /></span>
      </div>
      <ol className="settings-help-list">
        {steps.map((step) => (
          <li key={step.id}>
            <span className="settings-help-number">{NAV_ITEMS.findIndex((item) => item.id === step.id) + 1}</span>
            <div>
              <strong>{step.label}</strong>
              <span>{step.text}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="settings-disclosure">
      <summary>
        <span>{title}</span>
        <ChevronDown size={18} aria-hidden="true" />
      </summary>
      <div className="settings-disclosure-content">{children}</div>
    </details>
  )
}

/** Conditions générales d’utilisation, en français clair. */
function LegalSection() {
  const clauses: { title: string; text: string }[] = [
    {
      title: 'Objet',
      text: 'Dakar Bus est une application d’information sur les mobilités de la région de Dakar. Elle affiche des données publiées de manière traçable (snapshot GTFS daté) et un réseau de référence TER/BRT explicitement étiqueté comme tel.',
    },
    {
      title: 'Nature des données',
      text: 'Aucune donnée temps réel (position de véhicule, retard constaté) n’est fournie. Les horaires affichés sont des horaires théoriques déclarés ou des fréquences officielles de référence : une fréquence n’est pas un prochain passage et ne constitue pas un engagement de l’exploitant.',
    },
    {
      title: 'Géolocalisation et données personnelles',
      text: 'La position est demandée avec votre accord, utilisée uniquement dans l’appareil pour afficher les environs et n’est jamais transmise à un tiers. L’application ne conserve aucun compte, aucune trace de déplacement et aucun identifiant publicitaire.',
    },
    {
      title: 'Sources et licences',
      text: 'Fond cartographique © OpenStreetMap contributors (ODbL). Listes et positions TER/BRT issues de sources publiques (Sen TER, CETUD/SunuBRT, OpenStreetMap). Toute réutilisation doit conserver ces attributions.',
    },
    {
      title: 'Limites et responsabilité',
      text: 'Les informations sont fournies en l’état, sans garantie d’exactitude ni de disponibilité. Il appartient à l’usager de vérifier l’information auprès du canal officiel de l’exploitant (SunuBRT, Sen TER, CETUD) avant un déplacement.',
    },
    {
      title: 'Gouvernance des données',
      text: 'Aucune donnée n’entre dans l’application sans staging, revue traçable et publication authentifiée ; une publication reste un acte humain. L’application ne publie rien d’elle-même.',
    },
  ]
  return (
    <section className="panel settings-panel" aria-label="Conditions générales d’utilisation">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">CGU</span>
          <h2>Conditions d’utilisation.</h2>
          <p>Ce que l’application fait, ce qu’elle ne fait pas, et les droits associés.</p>
        </div>
        <span className="explore-icon"><ScrollText size={19} /></span>
      </div>
      <dl className="legal-list">
        {clauses.map((clause) => (
          <div key={clause.title}>
            <dt>{clause.title}</dt>
            <dd>{clause.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Historique des mises à jour, daté et vérifiable dans l’historique Git. */
function ChangelogSection() {
  const releases: { date: string; title: string; items: string[] }[] = [
    {
      date: '2026-10-08',
      title: 'Un guide plus simple',
      items: [
        'Explorer affiche la carte en haut, la recherche « On va où ? » et les raccourcis Maison, Boulot et Adresse sur une même ligne.',
        'Textes agrandis ; recherche retirée de Trajet, Alertes et Paramètres ; détails de Paramètres repliables.',
        'La gare TER-09 s’affiche désormais sous le nom Keur Mbaye Fall.',
      ],
    },
    {
      date: '2026-10-08',
      title: 'Quatre piliers, données BRT exactes',
      items: [
        'Navigation en 4 onglets : Explorer (carte et guide de destination), Trajet (itinéraires), Alertes et Paramètres.',
        'Carte montée uniquement dans Explorer ; les panneaux occupent seuls les autres onglets.',
        'Slogan publicitaire retiré.',
        '23 stations BRT alignées sur les positions exactes des nœuds OpenStreetMap de la ligne B1 (relation 19961937).',
        'Panneau des environs porté à 5 km, avec flux des mobilités et horaires annoncés.',
      ],
    },
    {
      date: '2026-10 (précédent)',
      title: 'Réseau de référence et assistant',
      items: [
        'Réseau de référence TER (13 gares) + BRT, tracé superposé au fond OpenStreetMap avec arrêts cliquables.',
        'Calculateur multimodal TER + BRT et assistant local répondant sur les mêmes données.',
        'Itinéraires directs déclarés dans le snapshot publié (une montée, une descente).',
      ],
    },
    {
      date: '2026-10 (fondation)',
      title: 'Gouvernance des données',
      items: [
        'Pipeline staging → revue → publication avec journal chaîné par empreintes et comptes nominatifs.',
        'API locale de lecture (/api/network, /api/stops/*, /api/routes, /api/journeys) et console authentifiée.',
        'Auditeur GTFS Static en lecture seule et page de vérité : « pas de donnée, pas d’affirmation ».',
      ],
    },
  ]
  return (
    <section className="panel settings-panel" aria-label="Historique des mises à jour">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">HISTORIQUE</span>
          <h2>Mises à jour.</h2>
          <p>Chaque version est un commit de ce dépôt : rien n’est publié silencieusement.</p>
        </div>
        <span className="explore-icon"><History size={19} /></span>
      </div>
      <ol className="changelog-list">
        {releases.map((release) => (
          <li key={release.date + release.title}>
            <span className="changelog-date">{release.date}</span>
            <strong>{release.title}</strong>
            <ul>
              {release.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  )
}

function GovernancePanel({
  state,
  onReload,
}: {
  state: GovernanceState
  onReload: () => void
}) {
  const summary = summarizeCatalog(state.datasets)
  const stageCounts: Record<string, number> = {
    staging: summary.total,
    review: summary.pendingReview,
    approval: summary.approved,
    publication: summary.published,
  }
  const showCounts = state.status === 'ready'

  return (
    <div className="governance-body" aria-label="Gouvernance des données">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">PROVENANCE ET REVUE</span>
          <h3>Catalogue local.</h3>
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
            <div><strong>Catalogue non chargé</strong><span>Ouvrir cette console interroge l’API locale : lecture publique, décisions authentifiées.</span></div>
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
    </div>
  )
}

export default App
