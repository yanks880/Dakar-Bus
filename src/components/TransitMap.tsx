import { memo, useEffect, useMemo } from 'react'
import { Circle, CircleMarker, MapContainer, Marker, Polyline, Rectangle, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import L, { type DivIcon } from 'leaflet'
import type { PublishedStop, SnapshotBounds } from '../domain/published'
import type { CorridorLine, CorridorStop } from '../domain/corridors'
import { formatFrequencyPeriod, formatSourceVerification } from '../domain/frequencies'
import { safeHttpUrl } from '../domain/http'
import { mobilityFromStopId, mobilityPaint, type MobilityPaint } from '../domain/mobilityColors'

export interface Coordinates {
  lat: number
  lng: number
}

export interface UserLocation extends Coordinates {
  accuracy: number
}

export type RoutePointKey = 'origin' | 'destination'

/** A stop marker needs a declared position; stops without coordinates have none. */
export interface MappableStop extends Coordinates {
  stopId: string
  stopName: string
}

export interface RegionBounds {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

interface TransitMapProps {
  location: UserLocation | null
  routePoints: Partial<Record<RoutePointKey, Coordinates>>
  pickingPoint: RoutePointKey | null
  recenterTo: Coordinates | null
  zoomAction: { delta: number; nonce: number } | null
  onChoosePoint: (coordinates: Coordinates) => void
  publishedStops?: readonly PublishedStop[]
  selectedStopId?: string | null
  coverage?: SnapshotBounds | null
  showCoverage?: boolean
  onSelectStop?: (stop: PublishedStop) => void
  /** Enveloppe à cadrer au chargement (Almadies → Rufisque/Bargny + terminus). */
  initialBounds?: RegionBounds | null
  /** Lignes de référence à tracer (TER/BRT), déjà filtrées par couche. */
  corridorLines?: readonly CorridorLine[]
  /** Arrêts de référence à afficher, déjà filtrés par couche. */
  corridorStops?: readonly CorridorStop[]
  onSelectCorridorStop?: (stop: CorridorStop) => void
}

const DAKAR_CENTER: [number, number] = [14.7167, -17.4677]

export type MappablePublishedStop = PublishedStop & { lat: number; lon: number }

/** Stops are only mapped where the feed declares coordinates. */
export function mappableStops(stops: readonly PublishedStop[]): MappablePublishedStop[] {
  return stops.filter((stop): stop is MappablePublishedStop => stop.lat !== null && stop.lon !== null)
}

function MapClickHandler({
  pickingPoint,
  onChoosePoint,
}: Pick<TransitMapProps, 'pickingPoint' | 'onChoosePoint'>) {
  useMapEvents({
    click(event) {
      if (pickingPoint) {
        onChoosePoint({ lat: event.latlng.lat, lng: event.latlng.lng })
      }
    },
  })
  return null
}

function MapController({ recenterTo, zoomAction }: Pick<TransitMapProps, 'recenterTo' | 'zoomAction'>) {
  const map = useMap()

  useEffect(() => {
    if (!recenterTo) return
    map.flyTo([recenterTo.lat, recenterTo.lng], Math.max(map.getZoom(), 15), { duration: 0.8 })
  }, [map, recenterTo])

  useEffect(() => {
    if (!zoomAction) return
    map.setZoom(map.getZoom() + zoomAction.delta, { animate: true })
  }, [map, zoomAction])

  return null
}

/** Cadrage initial : englobe toute la région utile au chargement de la carte. */
function MapInitialFit({ bounds }: { bounds: RegionBounds | null }) {
  const map = useMap()
  useEffect(() => {
    if (!bounds) return
    map.fitBounds(
      [
        [bounds.minLat, bounds.minLon],
        [bounds.maxLat, bounds.maxLon],
      ],
      { padding: [16, 16], animate: false },
    )
    // Appliqué une seule fois au montage : le centrage manuel prime ensuite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])
  return null
}

/** Échappe une valeur avant de l’insérer dans le HTML d’une icône Leaflet. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function makeMarker(className: string, label: string, color: string): DivIcon {
  return L.divIcon({
    className: 'dakar-marker-shell',
    html: `<span class="${escapeHtml(className)}" style="--marker-color:${escapeHtml(color)}" role="img" aria-label="${escapeHtml(label)}"><span></span></span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

function paintFor(network: string | undefined, stopId?: string): MobilityPaint | null {
  return mobilityPaint(network) ?? mobilityPaint(mobilityFromStopId(stopId ?? ''))
}

function TransitMapView({
  location,
  routePoints,
  pickingPoint,
  recenterTo,
  zoomAction,
  onChoosePoint,
  publishedStops = [],
  selectedStopId = null,
  coverage = null,
  showCoverage = true,
  onSelectStop,
  initialBounds = null,
  corridorLines = [],
  corridorStops = [],
  onSelectCorridorStop,
}: TransitMapProps) {
  const userIcon = useMemo(() => makeMarker('map-user-marker', 'Votre position', '#198754'), [])
  const originIcon = useMemo(() => makeMarker('map-route-marker map-route-marker-origin', 'Départ sélectionné', '#146b43'), [])
  const destinationIcon = useMemo(() => makeMarker('map-route-marker map-route-marker-destination', 'Destination sélectionnée', '#d78a32'), [])
  const stops = useMemo(() => mappableStops(publishedStops), [publishedStops])
  const corridorLineStops = useMemo(
    () =>
      corridorLines.map((line) => ({
        line,
        positions: line.stopIds
          .map((stopId) => corridorStops.find((stop) => stop.id === stopId))
          .filter((stop): stop is CorridorStop => stop !== undefined)
          .map((stop) => [stop.lat, stop.lon] as [number, number]),
      })),
    [corridorLines, corridorStops],
  )

  return (
    <MapContainer
      center={DAKAR_CENTER}
      zoom={13}
      minZoom={10}
      maxZoom={19}
      zoomControl={false}
      scrollWheelZoom
      preferCanvas
      className={`leaflet-map${pickingPoint ? ' leaflet-map-picking' : ''}`}
      aria-label="Carte interactive de Dakar"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <MapClickHandler pickingPoint={pickingPoint} onChoosePoint={onChoosePoint} />
      <MapController recenterTo={recenterTo} zoomAction={zoomAction} />
      <MapInitialFit bounds={initialBounds} />

      {/* Réseau de référence TER/BRT : superposé au fond OpenStreetMap, sans le modifier.
          Halo blanc, liseré de la seconde teinte officielle, cœur de la teinte de tracé. */}
      {corridorLineStops.map(({ line, positions }) => {
        const paint = paintFor(line.network)
        if (!paint) return null
        return (
          <Polyline
            key={`corridor-halo-${line.id}`}
            positions={positions}
            interactive={false}
            pathOptions={{ color: '#ffffff', weight: 11, opacity: 0.92, lineCap: 'round', lineJoin: 'round' }}
          />
        )
      })}
      {corridorLineStops.map(({ line, positions }) => {
        const paint = paintFor(line.network)
        if (!paint) return null
        return (
          <Polyline
            key={`corridor-casing-${line.id}`}
            positions={positions}
            interactive={false}
            pathOptions={{ color: paint.casing, weight: 8, opacity: 0.98, lineCap: 'round', lineJoin: 'round' }}
          />
        )
      })}
      {corridorLineStops.map(({ line, positions }) => {
        const paint = paintFor(line.network)
        return (
          <Polyline
            key={`corridor-${line.id}`}
            positions={positions}
            pathOptions={{ color: paint?.core ?? line.color, weight: 4.5, opacity: 1, lineCap: 'round', lineJoin: 'round' }}
          >
            <Tooltip direction="center" sticky opacity={0.95} className={`stop-tooltip mobility-tooltip${paint ? ` mobility-${paint.id}` : ''}`}>
              <div className="map-frequency-tooltip">
                <strong>
                  {paint && <span className={`mobility-badge mobility-${paint.id}`}>{line.shortName}</span>}
                  {' '}{line.longName}
                </strong>
              {line.officialFrequencies.map((frequency, index) => (
                <span key={`${frequency.serviceStart}-${frequency.serviceEnd}-${index}`}>{formatFrequencyPeriod(frequency)}</span>
              ))}
              <small>
                {line.frequencyStatus === 'OFFICIAL_REFERENCE' ? 'Fréquence officielle de référence' : 'Fréquence inconnue'}
                {' · '}{formatSourceVerification(line.frequencySource)}
              </small>
              {safeHttpUrl(line.frequencySource.sourceUrl) && (
                <a className="map-frequency-source" href={safeHttpUrl(line.frequencySource.sourceUrl) ?? undefined} target="_blank" rel="noreferrer">
                  Source : {line.frequencySource.authority}
                </a>
              )}
              <span className="map-frequency-disclaimer">Fréquence de service uniquement · pas un prochain passage.</span>
            </div>
          </Tooltip>
          </Polyline>
        )
      })}
      {corridorStops.map((stop) => {
        const line = corridorLines.find((candidate) => candidate.stopIds.includes(stop.id))
        const paint = paintFor(line?.network, stop.id)
        return (
          <CircleMarker
            key={`corridor-stop-${stop.id}`}
            center={[stop.lat, stop.lon]}
            radius={7}
            pathOptions={{
              color: '#ffffff',
              weight: 2,
              fillColor: paint?.badge ?? '#475569',
              fillOpacity: 1,
            }}
            eventHandlers={onSelectCorridorStop ? { click: () => onSelectCorridorStop(stop) } : undefined}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={1} className={`stop-tooltip mobility-tooltip${paint ? ` mobility-${paint.id}` : ''}`}>
              <div className="map-frequency-tooltip">
                <strong>
                  {paint && <span className={`mobility-badge mobility-${paint.id}`}>{paint.label}</span>}
                  {' '}{stop.name}{stop.note ? ` · ${stop.note}` : ''}
                </strong>
                {line?.officialFrequencies.map((frequency, index) => (
                  <span key={`${frequency.serviceStart}-${frequency.serviceEnd}-${index}`}>{formatFrequencyPeriod(frequency)}</span>
                ))}
                {line && (
                  <small>
                    {line.frequencyStatus === 'OFFICIAL_REFERENCE' ? 'Fréquence officielle de référence' : 'Fréquence inconnue'}
                    {' · '}{formatSourceVerification(line.frequencySource)}
                  </small>
                )}
                {line && safeHttpUrl(line.frequencySource.sourceUrl) && (
                  <a className="map-frequency-source" href={safeHttpUrl(line.frequencySource.sourceUrl) ?? undefined} target="_blank" rel="noreferrer">
                    Source : {line.frequencySource.authority}
                  </a>
                )}
                {line && <span className="map-frequency-disclaimer">Fréquence de service uniquement · pas un prochain passage.</span>}
              </div>
            </Tooltip>
          </CircleMarker>
        )
      })}

      {coverage && showCoverage && (
        <Rectangle
          bounds={[
            [coverage.minLat, coverage.minLon],
            [coverage.maxLat, coverage.maxLon],
          ]}
          pathOptions={{ color: '#198754', weight: 1, dashArray: '5 6', fillColor: '#198754', fillOpacity: 0.05 }}
        />
      )}

      {stops.map((stop) => (
        <CircleMarker
          key={stop.stopId}
          center={[stop.lat, stop.lon]}
          radius={stop.stopId === selectedStopId ? 9 : 6}
          pathOptions={
            stop.stopId === selectedStopId
              ? { color: '#ffffff', weight: 3, fillColor: '#146a42', fillOpacity: 1 }
              : { color: '#ffffff', weight: 2, fillColor: '#198754', fillOpacity: 0.92 }
          }
          eventHandlers={onSelectStop ? { click: () => onSelectStop(stop) } : undefined}
        >
          <Tooltip direction="top" offset={[0, -6]} opacity={1} className="stop-tooltip">
            {stop.stopName}
          </Tooltip>
        </CircleMarker>
      ))}

      {location && (
        <>
          <Circle
            center={[location.lat, location.lng]}
            radius={location.accuracy}
            pathOptions={{ color: '#198754', weight: 1, fillColor: '#198754', fillOpacity: 0.11 }}
          />
          <Marker position={[location.lat, location.lng]} icon={userIcon} keyboard title="Votre position" />
        </>
      )}

      {routePoints.origin && (
        <Marker
          position={[routePoints.origin.lat, routePoints.origin.lng]}
          icon={originIcon}
          keyboard
          title="Point de départ sélectionné"
        />
      )}
      {routePoints.destination && (
        <Marker
          position={[routePoints.destination.lat, routePoints.destination.lng]}
          icon={destinationIcon}
          keyboard
          title="Point d'arrivée sélectionné"
        />
      )}
    </MapContainer>
  )
}

/** Carte mémorisée : elle ne se redessine que si ses données ou ses rappels changent. */
export const TransitMap = memo(TransitMapView)
