import { useState } from 'react'
import { compareReferenceJourneys, PRIORITY_LABELS, type Comparison } from '../domain/comparison'
import { describeLeg, formatMeters, type PlannerEndpoint } from '../domain/planner'

type Point = { label: string; lat: number; lng: number; stopId?: string }

/** Optional comparison: leaves published direct journeys and default results untouched. */
export function RouteComparison({ origin, destination }: { origin: Point; destination: Point }) {
  const key = `${origin.lat},${origin.lng},${origin.stopId ?? ''}|${destination.lat},${destination.lng},${destination.stopId ?? ''}`
  const [requested, setRequested] = useState<{ key: string; comparison: Comparison } | null>(null)
  const comparison = requested?.key === key ? requested.comparison : null

  function compare() {
    const endpoint = (point: Point): PlannerEndpoint => ({
      label: point.label, lat: point.lat, lon: point.lng, stopId: point.stopId,
    })
    setRequested({ key, comparison: compareReferenceJourneys(endpoint(origin), endpoint(destination)) })
  }

  return (
    <div className="route-comparison">
      <button type="button" className="route-comparison-action" onClick={compare}>Comparer les options TER/BRT</button>
      {comparison && !comparison.ok && <p role="status">{comparison.message}</p>}
      {comparison && comparison.ok && (
        <section aria-label="Comparaison des itinéraires TER/BRT" className="route-comparison-results">
          <h3>Comparer les itinéraires de référence</h3>
          <p>Critères classés parmi les options calculées seulement. Durées estimées (attente théorique), pas des horaires ni du temps réel. Les courses directes publiées, si disponibles, restent affichées séparément : leurs horaires ne sont pas mélangés à ces estimations.</p>
          <ol>
            {comparison.options.map((option, index) => {
              const best = (Object.keys(comparison.bestBy) as (keyof typeof comparison.bestBy)[])
                .filter((criterion) => comparison.bestBy[criterion] === option.priority).map((criterion) => PRIORITY_LABELS[criterion])
              return (
                <li key={option.priority}>
                  <strong>Option {index + 1} · {option.result.boardedLines.join(' + ') || 'À pied'}</strong>
                  <span>≈ {option.result.totalMinutes} min · {formatMeters(option.result.totalWalkM)} de marche · {option.result.transfers} correspondance{option.result.transfers > 1 ? 's' : ''}</span>
                  <small>{best.join(' · ')}</small>
                  <details><summary>Voir les étapes</summary><ol>{option.result.legs.map((leg, legIndex) => <li key={legIndex}>{describeLeg(leg)}</li>)}</ol></details>
                </li>
              )
            })}
          </ol>
          {comparison.options.length === 1 && <p>Une seule option distincte est calculable sur ce réseau.</p>}
          <p>Prix non comparés : tarifs complets et vérifiés indisponibles. DDD/AFTU non intégrés. Vérifiez le service auprès des opérateurs avant de partir.</p>
        </section>
      )}
    </div>
  )
}
