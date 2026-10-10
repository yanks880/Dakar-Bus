import { BusFront, Footprints, TrainFront } from 'lucide-react'
import { MobilityBadge, MobilityText } from './MobilityBadge'
import { formatMeters, type PlannerLeg } from '../domain/planner'

function LegIcon({ leg }: { leg: PlannerLeg }) {
  if (leg.kind === 'ride' && leg.line?.network === 'ter') return <TrainFront size={15} />
  if (leg.kind === 'ride') return <BusFront size={15} />
  return <Footprints size={15} />
}

function legTitle(leg: PlannerLeg): string {
  if (leg.kind === 'walk_transfer') return `Correspondance à pied · ${leg.from} → ${leg.to}`
  if (leg.kind === 'walk_direct') return `À pied · ${leg.from} → ${leg.to}`
  if (leg.kind === 'ride') return `${leg.from} → ${leg.to}`
  return `Marche${leg.to ? ` vers ${leg.to}` : ''}`
}

function legDetail(leg: PlannerLeg): string {
  if (leg.kind === 'ride') {
    const via = leg.intermediateStops?.length ? ` · via ${leg.intermediateStops.join(', ')}` : ''
    const distance = leg.distanceM ? ` · ${formatMeters(leg.distanceM)}` : ''
    return `~${leg.minutes} min${via}${distance}`
  }
  return `${formatMeters(leg.distanceM)} · ~${leg.minutes} min${leg.note ? ` · ${leg.note}` : ''}`
}

/** Étapes d’un itinéraire de référence, colorées par le mode de chaque trajet. */
export function PlannerLegList({ legs }: { legs: readonly PlannerLeg[] }) {
  return (
    <ol className="planner-legs">
      {legs.map((leg, index) => {
        const network = leg.line?.network
        return (
          <li
            key={`${leg.kind}-${leg.line?.id ?? ''}-${index}`}
            className={`planner-leg planner-leg-${leg.kind}${network ? ` planner-leg-${network} mobility-${network}` : ''}`}
          >
            <span className="planner-leg-icon"><LegIcon leg={leg} /></span>
            <span className="planner-leg-copy">
              <strong>
                {network && leg.line ? <MobilityBadge id={network}>{leg.line.shortName}</MobilityBadge> : null}
                <MobilityText text={legTitle(leg)} />
              </strong>
              <small><MobilityText text={legDetail(leg)} /></small>
            </span>
            <span className="planner-leg-time">~{leg.minutes} min</span>
          </li>
        )
      })}
    </ol>
  )
}
