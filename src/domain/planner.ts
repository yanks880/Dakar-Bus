/**
 * Calculateur de correspondances multimodal sur le réseau de référence.
 *
 * Ce moteur combine les corridors TER et BRT (voir `corridors.ts`) :
 * marche d'accès, montée, correspondance marchable, descente, marche finale.
 * Il inclut les temps de marche, d'attente (demi-fréquence officielle de
 * référence, utilisée comme estimation) et de parcours (distance / vitesse
 * commerciale de référence). Les périodes TER restent distinctes ; sans jour
 * ni heure demandés, le calculateur retient le headway officiel maximal.
 *
 * Honnêteté :
 * - il ne calcule que sur le réseau de référence (TER + BRT) : les réseaux
 *   DDD, AFTU et TATA n'ont aucune donnée vérifiée et ne sont pas inventés ;
 * - les durées sont des ESTIMATIONS à partir de fréquences et vitesses
 *   annoncées publiquement — ni horaire déclaré, ni temps réel ;
 * - quand aucune chaîne de trajets n'existe dans le graphe de référence, la
 *   réponse le dit au lieu de fabriquer un itinéraire.
 */

import {
  BOARDING_WAIT_FRACTION,
  MAX_ACCESS_M,
  TRANSFER_BUFFER_MIN,
  WALK_SPEED_MPM,
  dwellMinutes,
  walkDisplayMinutes,
} from './assumptions'
import {
  ALL_CORRIDOR_STOPS,
  CORRIDOR_LINES,
  CORRIDOR_TRANSFERS,
  getCorridorStop,
  haversineMeters,
  type CorridorLine,
  type CorridorStop,
} from './corridors'

export { DWELL_MIN, MAX_ACCESS_M } from './assumptions'

export interface PlannerEndpoint {
  label: string
  lat: number
  lon: number
  /** Quand le point est exactement un arrêt de référence. */
  stopId?: string
}

export type PlannerLegKind = 'walk_access' | 'walk_direct' | 'walk_transfer' | 'walk_egress' | 'ride' | 'wait'

export interface PlannerLeg {
  kind: PlannerLegKind
  /** Pour un trajet : ligne empruntée. */
  line?: CorridorLine
  from?: string
  to?: string
  /** Distance en mètres (marche) — arrondie. */
  distanceM?: number
  /** Durée estimée en minutes (arrondie à la minute supérieure). */
  minutes: number
  /** Arrêts intermédiaires pour un trajet (hors montée/descente). */
  intermediateStops?: string[]
  note?: string
}

export interface PlannerResult {
  ok: true
  legs: PlannerLeg[]
  totalMinutes: number
  totalWalkM: number
  transfers: number
  boardedLines: string[]
  limitation: string
}

export interface PlannerFailure {
  ok: false
  reason: 'NO_ACCESSIBLE_STOP' | 'NO_PATH' | 'SAME_POINT'
  message: string
}

export type PlannerOutcome = PlannerResult | PlannerFailure

// Vitesses, arrêts et attente : hypothèses nommées dans assumptions.ts.
// Les constantes historiques restent exportées pour ne pas casser les appelants.

interface GraphEdge {
  to: string
  cost: number
  leg: PlannerLeg
}

interface NodeState {
  cost: number
  previous: string | null
  edge: GraphEdge | null
  /** Ligne sur laquelle on est monté en arrivant ici (pour la continuité de trajet). */
  ridingLine: string | null
}

function rideMinutes(line: CorridorLine, fromOrder: number, toOrder: number): { minutes: number; distanceM: number; intermediate: string[] } {
  const start = Math.min(fromOrder, toOrder)
  const end = Math.max(fromOrder, toOrder)
  let distanceM = 0
  for (let index = start; index < end; index += 1) {
    const a = getCorridorStop(line.stopIds[index])
    const b = getCorridorStop(line.stopIds[index + 1])
    if (a && b) distanceM += haversineMeters(a, b)
  }
  const travel = (distanceM / 1000 / line.speedKph) * 60
  const dwell = (end - start - 1) * dwellMinutes(line.network)
  const intermediate = line.stopIds.slice(start + 1, end).map((id) => getCorridorStop(id)?.name ?? id)
  return { minutes: travel + dwell, distanceM, intermediate }
}

function walkLeg(kind: PlannerLegKind, from: string, to: string, meters: number): PlannerLeg {
  return {
    kind,
    from,
    to,
    distanceM: Math.round(meters),
    minutes: walkDisplayMinutes(meters),
  }
}

/**
 * Calcule le meilleur enchaînement TER/BRT entre deux points.
 * Les points peuvent être des coordonnées libres (clic carte, GPS) ou des
 * arrêts de référence choisis dans la liste.
 */
export function planReferenceJourney(origin: PlannerEndpoint, destination: PlannerEndpoint): PlannerOutcome {
  if (Math.abs(origin.lat - destination.lat) < 1e-9 && Math.abs(origin.lon - destination.lon) < 1e-9) {
    return { ok: false, reason: 'SAME_POINT', message: 'Le départ et la destination sont identiques : aucun trajet à calculer.' }
  }

  // Arrêts accessibles à pied depuis le départ / vers la destination.
  const access = ALL_CORRIDOR_STOPS.map((stop) => ({
    stop,
    meters: origin.stopId === stop.id ? 0 : haversineMeters(origin, stop),
  })).filter((entry) => entry.meters <= MAX_ACCESS_M)
  const egress = ALL_CORRIDOR_STOPS.map((stop) => ({
    stop,
    meters: destination.stopId === stop.id ? 0 : haversineMeters(destination, stop),
  })).filter((entry) => entry.meters <= MAX_ACCESS_M)

  if (access.length === 0 || egress.length === 0) {
    return {
      ok: false,
      reason: 'NO_ACCESSIBLE_STOP',
      message: `Aucun arrêt TER ou BRT à moins de ${MAX_ACCESS_M / 1000} km de ${access.length === 0 ? 'votre départ' : 'votre destination'} (DDD et AFTU non intégrés).`,
    }
  }

  // Dijkstra sur les arrêts de référence.
  const states = new Map<string, NodeState>()
  const queue: string[] = []

  for (const entry of access) {
    states.set(entry.stop.id, {
      cost: entry.meters / WALK_SPEED_MPM,
      previous: null,
      edge: entry.meters > 0
        ? { to: entry.stop.id, cost: 0, leg: walkLeg('walk_access', origin.label, entry.stop.name, entry.meters) }
        : null,
      ridingLine: null,
    })
    queue.push(entry.stop.id)
  }

  const relax = (fromId: string, edge: GraphEdge, ridingLine: string | null) => {
    const current = states.get(fromId)
    if (!current) return
    const nextCost = current.cost + edge.cost
    const existing = states.get(edge.to)
    if (!existing || nextCost < existing.cost) {
      states.set(edge.to, { cost: nextCost, previous: fromId, edge, ridingLine })
      queue.push(edge.to)
    }
  }

  while (queue.length > 0) {
    // File de priorité simple : extrait le coût minimal.
    let bestIndex = 0
    for (let index = 1; index < queue.length; index += 1) {
      const candidate = states.get(queue[index])?.cost ?? Number.POSITIVE_INFINITY
      const best = states.get(queue[bestIndex])?.cost ?? Number.POSITIVE_INFINITY
      if (candidate < best) bestIndex = index
    }
    const currentId = queue.splice(bestIndex, 1)[0]
    const current = states.get(currentId)
    if (!current) continue

    const currentStop = getCorridorStop(currentId)
    if (!currentStop) continue

    // 1) Trajets : monter, continuer ou descendre de chaque ligne desservant l'arrêt.
    for (const line of CORRIDOR_LINES.filter((candidate) => candidate.stopIds.includes(currentId))) {
      const boarding = current.ridingLine === line.id ? 0 : line.headwayMin * BOARDING_WAIT_FRACTION
      for (const targetId of line.stopIds) {
        if (targetId === currentId) continue
        const fromOrder = line.stopIds.indexOf(currentId)
        const toOrder = line.stopIds.indexOf(targetId)
        // Uniquement de proche en proche : la continuité du trajet est reconstruite ensuite.
        if (Math.abs(toOrder - fromOrder) !== 1) continue
        const target = getCorridorStop(targetId)
        if (!target) continue
        const segment = rideMinutes(line, fromOrder, toOrder)
        const dwell = dwellMinutes(line.network)
        relax(currentId, {
          to: targetId,
          cost: boarding + segment.minutes + dwell,
          leg: {
            kind: 'ride',
            line,
            from: currentStop.name,
            to: target.name,
            distanceM: Math.round(segment.distanceM),
            minutes: Math.max(1, Math.round(boarding + segment.minutes + dwell)),
          },
        }, line.id)
      }
    }

    // 2) Correspondances marchables déclarées entre réseaux.
    for (const transfer of CORRIDOR_TRANSFERS) {
      const other = transfer.fromStopId === currentId ? transfer.toStopId : transfer.toStopId === currentId ? transfer.fromStopId : null
      if (!other) continue
      const otherStop = getCorridorStop(other)
      if (!otherStop) continue
      relax(currentId, {
        to: other,
        cost: transfer.walkM / WALK_SPEED_MPM + TRANSFER_BUFFER_MIN,
        leg: { ...walkLeg('walk_transfer', currentStop.name, otherStop.name, transfer.walkM), note: transfer.label },
      }, null)
    }
  }

  // Meilleure arrivée : arrêt accessible à la destination, marche finale incluse.
  let bestStop: { stop: CorridorStop; meters: number; total: number } | null = null
  for (const entry of egress) {
    const state = states.get(entry.stop.id)
    if (!state) continue
    const total = state.cost + entry.meters / WALK_SPEED_MPM
    if (!bestStop || total < bestStop.total) {
      bestStop = { stop: entry.stop, meters: entry.meters, total }
    }
  }
  if (!bestStop) {
    return {
      ok: false,
      reason: 'NO_PATH',
      message: 'Aucun trajet TER ou BRT entre ces deux points.',
    }
  }

  // Reconstruction du chemin.
  const rawLegs: PlannerLeg[] = []
  let cursor: string | null = bestStop.stop.id
  const visited = new Set<string>()
  while (cursor) {
    if (visited.has(cursor)) break
    visited.add(cursor)
    const state = states.get(cursor)
    if (!state || !state.edge) break
    rawLegs.unshift(state.edge.leg)
    cursor = state.previous
  }

  // Fusionne les trajets consécutifs de la même ligne en une seule jambe.
  const legs: PlannerLeg[] = []
  for (const leg of rawLegs) {
    const last = legs[legs.length - 1]
    if (leg.kind === 'ride' && last?.kind === 'ride' && last.line?.id === leg.line?.id) {
      last.to = leg.to
      last.minutes += leg.minutes
      last.distanceM = (last.distanceM ?? 0) + (leg.distanceM ?? 0)
      last.intermediateStops = [...(last.intermediateStops ?? []), ...(leg.intermediateStops ?? []), ...(leg.from ? [leg.from] : [])]
      continue
    }
    if (leg.kind === 'ride') {
      legs.push({ ...leg, intermediateStops: [] })
      continue
    }
    legs.push(leg)
  }
  if (bestStop.meters > 0) {
    legs.push(walkLeg('walk_egress', bestStop.stop.name, destination.label, bestStop.meters))
  }

  const totalWalkM = legs.reduce((total, leg) => total + (leg.kind === 'ride' ? 0 : leg.distanceM ?? 0), 0)
  const transfers = legs.filter((leg) => leg.kind === 'walk_transfer').length
  const boardedLines = [...new Set(legs.filter((leg) => leg.kind === 'ride' && leg.line).map((leg) => leg.line!.shortName))]

  // Aucun véhicule emprunté : la chaîne « marche vers un arrêt puis marche vers
  // la destination » n'est qu'un détour. La marche directe entre les deux points
  // est toujours au moins aussi courte (inégalité triangulaire) : c'est elle qui
  // est rendue, plutôt qu'un itinéraire plus long sans aucun transport dedans.
  if (boardedLines.length === 0) {
    const directLeg = walkLeg('walk_direct', origin.label, destination.label, haversineMeters(origin, destination))
    return {
      ok: true,
      legs: [directLeg],
      totalMinutes: directLeg.minutes,
      totalWalkM: directLeg.distanceM ?? 0,
      transfers: 0,
      boardedLines: [],
      limitation: 'Trajet à pied : aucun trajet TER ou BRT ne raccourcit ce déplacement.',
    }
  }

  return {
    ok: true,
    legs,
    totalMinutes: Math.max(1, Math.round(bestStop.total)),
    totalWalkM,
    transfers,
    boardedLines,
    limitation:
      'Estimation du réseau de référence sur les fréquences officielles TER/BRT (le TER retient son headway maximal, faute d’heure choisie). Ce n’est ni un horaire, ni du temps réel.',
  }
}

/** Résumé lisible d'une jambe pour l'interface et l'assistant. */
export function describeLeg(leg: PlannerLeg): string {
  switch (leg.kind) {
    case 'walk_access':
      return `Marcher ${formatMeters(leg.distanceM)} jusqu’à ${leg.to} (~${leg.minutes} min)`
    case 'walk_direct':
      return `Trajet à pied ${formatMeters(leg.distanceM)} : ${leg.from} → ${leg.to} (~${leg.minutes} min)`
    case 'walk_egress':
      return `Marcher ${formatMeters(leg.distanceM)} jusqu’à ${leg.to} (~${leg.minutes} min)`
    case 'walk_transfer':
      return `Correspondance à pied ${formatMeters(leg.distanceM)} : ${leg.from} → ${leg.to} (~${leg.minutes} min)`
    case 'ride': {
      const via = leg.intermediateStops && leg.intermediateStops.length > 0 ? ` via ${leg.intermediateStops.join(', ')}` : ''
      return `${leg.line?.shortName ?? 'Ligne'} : ${leg.from} → ${leg.to}${via} (~${leg.minutes} min)`
    }
    case 'wait':
      return `Attente (~${leg.minutes} min)`
    default:
      return leg.from ?? ''
  }
}

export function formatMeters(meters: number | undefined): string {
  if (meters === undefined) return ''
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}
