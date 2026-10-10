/** Comparison of *calculable* TER/BRT reference routes. No fares or live data. */
import { planReferenceJourney, type PlannerEndpoint, type PlannerFailure, type PlannerPriority, type PlannerResult } from './planner'

export interface ComparedRoute {
  priority: PlannerPriority
  result: PlannerResult
}

export type Comparison = { ok: true; options: ComparedRoute[]; bestBy: Record<PlannerPriority, PlannerPriority> } | PlannerFailure

const PRIORITIES: readonly PlannerPriority[] = ['fastest', 'lessWalking', 'fewerTransfers']

function routeKey(result: PlannerResult): string {
  // Stops, ride lines and walking connections identify a route; differences in
  // optimization weights alone must never create a fake alternative.
  return result.legs.map((leg) => [leg.kind, leg.line?.id ?? '', leg.from ?? '', leg.to ?? ''].join(':')).join('|')
}

export function compareReferenceJourneys(origin: PlannerEndpoint, destination: PlannerEndpoint): Comparison {
  const options: ComparedRoute[] = []
  const seen = new Set<string>()
  for (const priority of PRIORITIES) {
    const result = planReferenceJourney(origin, destination, priority)
    if (!result.ok) {
      if (priority === 'fastest') return result
      continue
    }
    const key = routeKey(result)
    if (seen.has(key)) continue
    seen.add(key)
    options.push({ priority, result })
  }
  // Actual displayed metrics, not weighted search costs, determine the labels.
  const byMetric = (metric: (route: PlannerResult) => number): PlannerPriority =>
    [...options].sort((a, b) => metric(a.result) - metric(b.result))[0].priority
  return {
    ok: true,
    options,
    bestBy: {
      fastest: byMetric((route) => route.totalMinutes),
      lessWalking: byMetric((route) => route.totalWalkM),
      fewerTransfers: byMetric((route) => route.transfers),
    },
  }
}

export const PRIORITY_LABELS: Record<PlannerPriority, string> = {
  fastest: 'Le plus rapide',
  lessWalking: 'Le moins de marche',
  fewerTransfers: 'Le moins de correspondances',
}
