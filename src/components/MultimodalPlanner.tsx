import { useMemo, useState, type FormEvent } from 'react'
import { ArrowRight, BusFront, Footprints, Info, Route as RouteIcon, TrainFront } from 'lucide-react'
import { ALL_CORRIDOR_STOPS, BRT_STOPS, TER_STOPS, type CorridorStop } from '../domain/corridors'
import { formatMeters, planReferenceJourney, type PlannerEndpoint, type PlannerOutcome } from '../domain/planner'

export interface PlannerPoint {
  label: string
  lat: number
  lng: number
}

interface MultimodalPlannerProps {
  /** Point de départ choisi dans l'onglet Explorer (ou position GPS), réutilisé par Trajet. */
  mapOrigin?: PlannerPoint | null
  /** Destination choisie dans l'onglet Explorer, réutilisée par Trajet. */
  mapDestination?: PlannerPoint | null
}

const MAP_ORIGIN_VALUE = '__map_origin__'
const MAP_DESTINATION_VALUE = '__map_destination__'

function pointKey(point: PlannerPoint | null | undefined): string {
  return point ? `${point.lat},${point.lng}` : ''
}

function endpointFromSelection(value: string, mapPoint: PlannerPoint | null, kind: 'origin' | 'destination'): PlannerEndpoint | null {
  if (value === (kind === 'origin' ? MAP_ORIGIN_VALUE : MAP_DESTINATION_VALUE)) {
    if (!mapPoint) return null
    return { label: mapPoint.label, lat: mapPoint.lat, lon: mapPoint.lng }
  }
  const stop = ALL_CORRIDOR_STOPS.find((candidate) => candidate.id === value)
  if (!stop) return null
  return { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id }
}

function LegIcon({ kind, network }: { kind: string; network?: 'ter' | 'brt' }) {
  if (kind === 'ride' && network === 'ter') return <TrainFront size={15} />
  if (kind === 'ride') return <BusFront size={15} />
  return <Footprints size={15} />
}

/**
 * Calculatrice de correspondances multimodale (TER + BRT) sur le réseau de
 * référence. Module ajouté à l'onglet Itinéraire : il ne remplace ni ne
 * modifie la recherche de courses directes publiée existante.
 */
export function MultimodalPlanner({ mapOrigin = null, mapDestination = null }: MultimodalPlannerProps) {
  const [pickedOrigin, setOriginValue] = useState<string>(TER_STOPS[0].id)
  const [pickedDestination, setDestinationValue] = useState<string>(BRT_STOPS[BRT_STOPS.length - 1].id)
  // Si le point choisi sur la carte disparaît, le champ revient à un arrêt réel
  // (sinon le <select> afficherait une option absente de la liste).
  const originValue = pickedOrigin === MAP_ORIGIN_VALUE && !mapOrigin ? TER_STOPS[0].id : pickedOrigin
  const destinationValue = pickedDestination === MAP_DESTINATION_VALUE && !mapDestination ? BRT_STOPS[BRT_STOPS.length - 1].id : pickedDestination
  const [result, setResult] = useState<{ key: string; outcome: PlannerOutcome } | null>(null)

  // Le résultat n’est affiché que tant que les points demandés sont inchangés :
  // un point modifié sur la carte ou dans la liste n’affiche jamais l’ancien trajet.
  const selectionKey = [originValue, destinationValue, pointKey(mapOrigin), pointKey(mapDestination)].join('|')
  const outcome = result && result.key === selectionKey ? result.outcome : null

  const originOptions = useMemo(
    () => [
      ...(mapOrigin ? [{ value: MAP_ORIGIN_VALUE, label: `📍 ${mapOrigin.label} (carte)` }] : []),
      ...TER_STOPS.map((stop: CorridorStop) => ({ value: stop.id, label: `TER · ${stop.name}` })),
      ...BRT_STOPS.map((stop: CorridorStop) => ({ value: stop.id, label: `BRT · ${stop.name}` })),
    ],
    [mapOrigin],
  )
  const destinationOptions = useMemo(
    () => [
      ...(mapDestination ? [{ value: MAP_DESTINATION_VALUE, label: `📍 ${mapDestination.label} (carte)` }] : []),
      ...TER_STOPS.map((stop: CorridorStop) => ({ value: stop.id, label: `TER · ${stop.name}` })),
      ...BRT_STOPS.map((stop: CorridorStop) => ({ value: stop.id, label: `BRT · ${stop.name}` })),
    ],
    [mapDestination],
  )

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const origin = endpointFromSelection(originValue, mapOrigin, 'origin')
    const destination = endpointFromSelection(destinationValue, mapDestination, 'destination')
    if (!origin || !destination) {
      setResult({ key: selectionKey, outcome: { ok: false, reason: 'SAME_POINT', message: 'Choisissez un départ et une destination valides.' } })
      return
    }
    setResult({ key: selectionKey, outcome: planReferenceJourney(origin, destination) })
  }

  return (
    <section className="planner-card" aria-label="Calculateur de correspondances multimodal">
      <div className="planner-head">
        <span className="planner-head-icon"><RouteIcon size={16} /></span>
        <div>
          <strong>Calculateur de correspondances (TER + BRT)</strong>
          <span>Réseau de référence : combinaisons TER/BRT avec temps de marche et d’attente estimés.</span>
        </div>
      </div>

      <form className="planner-form" onSubmit={submit}>
        <label className="planner-field">
          <span>Départ</span>
          <select value={originValue} onChange={(event) => setOriginValue(event.target.value)}>
            {originOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="planner-field">
          <span>Destination</span>
          <select value={destinationValue} onChange={(event) => setDestinationValue(event.target.value)}>
            {destinationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary-action planner-submit"><RouteIcon size={16} /><span>Calculer le trajet</span><ArrowRight size={15} /></button>
      </form>

      {outcome && !outcome.ok && (
        <p className="planner-error" role="status">{outcome.message}</p>
      )}

      {outcome && outcome.ok && (
        <div className="planner-result" role="status">
          <div className="planner-summary">
            <strong>≈ {outcome.totalMinutes} min</strong>
            <span>{outcome.transfers} correspondance{outcome.transfers > 1 ? 's' : ''}</span>
            <span className="strip-divider" />
            <span><Footprints size={13} /> {formatMeters(outcome.totalWalkM)}</span>
            {outcome.boardedLines.length > 0 && <span className="strip-divider" />}
            {outcome.boardedLines.length > 0 && <span>{outcome.boardedLines.join(' + ')}</span>}
          </div>
          <ol className="planner-legs">
            {outcome.legs.map((leg, index) => (
              <li key={`${leg.kind}-${index}`} className={`planner-leg planner-leg-${leg.kind}`}>
                <span className="planner-leg-icon"><LegIcon kind={leg.kind} network={leg.line?.network} /></span>
                <span className="planner-leg-copy">
                  <strong>
                    {leg.kind === 'ride'
                      ? `${leg.line?.shortName} · ${leg.from} → ${leg.to}`
                      : leg.kind === 'walk_transfer'
                        ? `Correspondance : ${leg.from} → ${leg.to}`
                        : leg.kind === 'walk_direct'
                          ? `À pied : ${leg.from} → ${leg.to}`
                          : `Marche${leg.to ? ` vers ${leg.to}` : ''}`}
                  </strong>
                  <small>
                    {leg.kind === 'ride'
                      ? `${leg.minutes} min${leg.intermediateStops && leg.intermediateStops.length > 0 ? ` · via ${leg.intermediateStops.join(', ')}` : ''}${leg.distanceM ? ` · ${formatMeters(leg.distanceM)}` : ''}`
                      : `${formatMeters(leg.distanceM)} · ~${leg.minutes} min`}
                  </small>
                </span>
                <span className="planner-leg-time">~{leg.minutes} min</span>
              </li>
            ))}
          </ol>
          <p className="planner-footnote"><Info size={13} /> {outcome.limitation}</p>
        </div>
      )}
    </section>
  )
}
