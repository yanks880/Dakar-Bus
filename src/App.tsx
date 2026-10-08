import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  Bell,
  BusFront,
  ChevronDown,
  CircleAlert,
  Compass,
  Footprints,
  Info,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  MapPin,
  Minus,
  Navigation,
  Plus,
  Route as RouteIcon,
  Search,
  ShieldCheck,
  TrainFront,
  X,
} from 'lucide-react'
import { TransitMap, type Coordinates, type RoutePointKey, type UserLocation } from './components/TransitMap'
import { NETWORK_SOURCES, getConnectedNetworkCount, type NetworkId, type NetworkSource } from './domain/network'
import './App.css'

type TabId = 'map' | 'route' | 'explore' | 'alerts'
type GpsState = 'idle' | 'loading' | 'ready' | 'denied' | 'error'
type MapPoint = Coordinates & { label: string }

const NAV_ITEMS: { id: TabId; label: string; icon: typeof MapIcon }[] = [
  { id: 'map', label: 'Carte', icon: MapIcon },
  { id: 'route', label: 'Itinéraire', icon: RouteIcon },
  { id: 'explore', label: 'Explorer', icon: Compass },
  { id: 'alerts', label: 'Alertes', icon: Bell },
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
  const [toast, setToast] = useState<string | null>(null)
  const [gpsMessage, setGpsMessage] = useState<string | null>(null)
  const [exploreFilter, setExploreFilter] = useState<NetworkId | 'all'>('all')
  const [alertInfoOpen, setAlertInfoOpen] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const connectedCount = getConnectedNetworkCount()

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
    }
    window.addEventListener('keydown', handleKeyboardShortcut)
    return () => window.removeEventListener('keydown', handleKeyboardShortcut)
  }, [])

  function announce(message: string) {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3600)
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setActiveTab('explore')
    if (search.trim()) {
      announce('Aucune donnée de transport vérifiée ne correspond à cette recherche pour le moment.')
    }
  }

  function startPointSelection(key: RoutePointKey) {
    setActiveTab('route')
    setPickingPoint(key)
    setRouteAttempted(false)
    setLayersOpen(false)
    announce(key === 'origin' ? 'Touchez la carte pour choisir un point de départ.' : 'Touchez la carte pour choisir une destination.')
  }

  function handleMapPick(point: Coordinates) {
    if (!pickingPoint) return
    const nextPoint: MapPoint = { ...point, label: 'Point choisi sur la carte' }
    setRoutePoints((current) => ({ ...current, [pickingPoint]: nextPoint }))
    setRouteAttempted(false)
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
        if (purpose === 'origin') {
          setRoutePoints((current) => ({ ...current, origin: { ...coords, label: 'Ma position' } }))
          setActiveTab('route')
          setRouteAttempted(false)
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
  }

  function submitRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!routePoints.origin || !routePoints.destination) {
      announce('Choisissez un départ et une destination sur la carte avant de continuer.')
      return
    }
    setRouteAttempted(true)
  }

  const visibleSources = exploreFilter === 'all'
    ? NETWORK_SOURCES
    : NETWORK_SOURCES.filter((network) => network.id === exploreFilter)

  return (
    <main className="app-shell">
      <section className="map-stage" aria-label="Carte de Dakar">
        <TransitMap
          location={location}
              routePoints={routePoints}
              pickingPoint={pickingPoint}
              recenterTo={recenterTo}
              zoomAction={zoomAction}
          onChoosePoint={handleMapPick}
        />

        <div className="map-heading-overlay">
          <div className="map-place-chip">
            <span className="place-icon"><MapPin size={15} /></span>
            <span>Dakar</span>
            <span className="place-separator" />
            <span className="place-country">Sénégal</span>
          </div>
          <div className="map-source-chip">
            <span className="source-dot" />
            {connectedCount > 0 ? `${connectedCount} source${connectedCount > 1 ? 's' : ''} connectée${connectedCount > 1 ? 's' : ''}` : 'Réseaux à connecter'}
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

        <div className="map-transport-note">
          <div className="transport-note-icon"><ShieldCheck size={17} /></div>
          <div>
            <strong>La carte ne montre que le territoire</strong>
            <span>Les lignes et arrêts apparaîtront après validation des sources.</span>
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

        <div className="panel-content" key={activeTab}>
          {activeTab === 'map' && (
            <MapPanel
              gpsState={gpsState}
              gpsMessage={gpsMessage}
              onLocate={() => requestLocation()}
              onPlan={() => setActiveTab('route')}
              onExplore={() => setActiveTab('explore')}
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
              onClear={() => { setRoutePoints({}); setRouteAttempted(false); setPickingPoint(null) }}
              onSubmit={submitRoute}
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
              onClearSearch={() => setSearch('')}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsPanel infoOpen={alertInfoOpen} onToggleInfo={() => setAlertInfoOpen((open) => !open)} />
          )}
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

function MapPanel({
  gpsState,
  gpsMessage,
  onLocate,
  onPlan,
  onExplore,
}: {
  gpsState: GpsState
  gpsMessage: string | null
  onLocate: () => void
  onPlan: () => void
  onExplore: () => void
}) {
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

      <div className="data-honesty-card">
        <div className="honesty-icon"><ShieldCheck size={18} /></div>
        <div className="honesty-copy">
          <div className="honesty-title-row"><strong>Affichage vérifié</strong><span className="neutral-status"><i /> EN CONFIGURATION</span></div>
          <p>Aucune source de transport n’est encore reliée. Aucun arrêt, horaire ou tracé n’est simulé.</p>
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

      <div className="nearby-empty">
        <span className="nearby-empty-icon"><MapPin size={18} /></span>
        <div>
          <strong>{gpsState === 'ready' ? 'Position affichée sur la carte' : 'Les transports validés apparaîtront ici'}</strong>
          <span>{gpsMessage || 'Aucune donnée de transport vérifiée à proximité pour le moment.'}</span>
        </div>
        <span className="empty-chevron"><ArrowRight size={15} /></span>
      </div>

      <button type="button" className="primary-action" onClick={onPlan}>
        <RouteIcon size={17} />
        <span>Préparer un itinéraire</span>
        <ArrowRight size={16} />
      </button>
      <button type="button" className="secondary-action" onClick={onExplore}>
        Explorer les sources réseau <ArrowRight size={14} />
      </button>

      <div className="data-state-strip"><span className="data-state-marker" /><span>Fond externe · OpenStreetMap</span><span className="strip-divider" /><span>Transport : données en attente</span></div>
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
          {point && <small>{formatCoordinates(point)}</small>}
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
}: {
  routePoints: Partial<Record<RoutePointKey, MapPoint>>
  pickingPoint: RoutePointKey | null
  routeAttempted: boolean
  onSelectPoint: (key: RoutePointKey) => void
  onUseLocation: () => void
  onSwap: () => void
  onClear: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <section className="panel route-panel" aria-label="Planifier un itinéraire">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">TRAJET MULTIMODAL</span>
          <h2>Votre prochain trajet.</h2>
          <p>Choisissez deux points sur la carte pour commencer.</p>
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
        <div className="route-unavailable" role="status">
          <div className="unavailable-icon"><AlertTriangle size={18} /></div>
          <div><strong>Calcul impossible pour le moment</strong><p>Aucun jeu de transport GTFS vérifié n’est connecté. Nous préférons ne pas proposer un trajet fictif.</p></div>
        </div>
      ) : (
        <div className="route-truth-card">
          <div className="route-truth-icon"><ShieldCheck size={17} /></div>
          <div><strong>Un itinéraire fiable, pas approximatif.</strong><span>Le calcul multimodal sera activé quand les horaires et tracés auront une source vérifiée.</span></div>
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
}: {
  filter: NetworkId | 'all'
  query: string
  sources: readonly NetworkSource[]
  onFilterChange: (filter: NetworkId | 'all') => void
  onToggleLayer: (id: NetworkId) => void
  layerState: Record<NetworkId, boolean>
  onClearSearch: () => void
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
    <section className="panel explore-panel" aria-label="Explorer les réseaux">
      <div className="panel-heading-row">
        <div>
          <span className="eyebrow">RÉSEAU DE DAKAR</span>
          <h2>Explorer.</h2>
          <p>Modes et opérateurs, chacun avec sa source propre.</p>
        </div>
        <span className="explore-icon"><Compass size={19} /></span>
      </div>

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

      <div className="source-list-heading"><span>CATÉGORIES DE MOBILITÉ</span><span className="source-count">{sources.length} proposées</span></div>
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

export default App
