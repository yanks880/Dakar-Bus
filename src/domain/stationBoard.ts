/**
 * Tableau des créneaux théoriques, station par station et sens par sens.
 *
 * CE MODULE N'EST PAS UN FLUX TEMPS RÉEL ET N'EN SIMULE PAS UN.
 *
 * Pour chaque ligne qui publie une fréquence officielle (aujourd'hui TER et
 * BRT, réseau de référence), il projette la grille déclarée au départ de
 * chaque terminus sur l'ensemble des stations : le créneau d'une station est
 * le départ théorique du terminus augmenté du temps de parcours de référence
 * (distance à vol d'oiseau entre stations consécutives / vitesse commerciale
 * déclarée + arrêts intermédiaires). Les deux sens sont distincts :
 * - sens aller : grille projetée depuis le terminus d'origine de la ligne ;
 * - sens retour : grille projetée depuis le terminus opposé.
 *
 * La phase exacte de la grille au départ de chaque terminus n'est pas
 * déclarée publiquement : les créneaux du sens retour projettent la même
 * grille depuis le terminus opposé, sans inventer de décalage. Ce que ce
 * module produit reste un horaire théorique issu d'une fréquence — jamais
 * une position de véhicule, jamais un retard constaté, jamais une promesse.
 *
 * Les réseaux sans ligne publiée (DDD, AFTU, TATA) ne renvoient aucune
 * station : la structure est prête à les afficher dès que des lignes
 * publiées existeront, sans autre changement d'interface.
 */

import { CORRIDOR_LINES, getCorridorStop, haversineMeters, type CorridorStop } from './corridors'
import type { OfficialFrequency } from './frequencies'
import { DWELL_MIN } from './planner'
import { nextReferencePassage, type NextPassage } from './headways'
import type { NetworkId } from './network'

/** Ligne exploitable par le tableau : tout réseau peut en publier une. */
export interface BoardLine {
  id: string
  network: NetworkId
  shortName: string
  longName: string
  stopIds: readonly string[]
  /** Vitesse commerciale moyenne déclarée (km/h). */
  speedKph: number
  officialFrequencies: readonly OfficialFrequency[]
}

/** Une station et ses deux créneaux théoriques, aller et retour. */
export interface StationRow {
  stop: CorridorStop
  /** Temps de parcours de référence depuis le terminus d'origine (minutes). */
  offsetFromOriginMin: number
  /** Temps de parcours de référence depuis le terminus opposé (minutes). */
  offsetFromDestinationMin: number
  /** Sens aller (départ du terminus d'origine) : nul au terminus opposé. */
  outbound: NextPassage | null
  /** Sens retour (départ du terminus opposé) : nul au terminus d'origine. */
  inbound: NextPassage | null
}

export interface StationBoard {
  line: BoardLine
  /** Station d'origine de la ligne (sens aller au départ de celle-ci). */
  originStop: CorridorStop
  /** Terminus opposé (sens retour au départ de celui-ci). */
  destinationStop: CorridorStop
  rows: readonly StationRow[]
}

/** Temps de parcours de référence entre deux stations consécutives (min). */
function segmentMinutes(line: BoardLine, index: number): number {
  const a = getCorridorStop(line.stopIds[index])
  const b = getCorridorStop(line.stopIds[index + 1])
  if (!a || !b) return 0
  return (haversineMeters(a, b) / 1000 / line.speedKph) * 60
}

/**
 * Construit le tableau d'une ligne : pour chaque station desservie, le
 * prochain créneau théorique dans chaque sens. Les identifiants d'arrêt non
 * résolus sont ignorés — aucune station n'est inventée.
 */
export function buildStationBoard(line: BoardLine, now = Date.now()): StationBoard | null {
  const stops = line.stopIds
    .map((stopId) => getCorridorStop(stopId))
    .filter((stop): stop is CorridorStop => stop !== null)
  if (stops.length < 2) return null

  const dwell = DWELL_MIN[line.network] ?? 0.5
  const originStop = stops[0]
  const destinationStop = stops[stops.length - 1]

  const rows: StationRow[] = stops.map((stop, index) => {
    // Parcours cumulé depuis l'origine : segments + arrêts intermédiaires.
    let fromOrigin = 0
    for (let i = 0; i < index; i += 1) fromOrigin += segmentMinutes(line, i)
    fromOrigin += Math.max(0, index - 1) * dwell
    // Parcours cumulé depuis le terminus opposé, symétrique.
    let fromDestination = 0
    for (let i = index; i < stops.length - 1; i += 1) fromDestination += segmentMinutes(line, i)
    fromDestination += Math.max(0, stops.length - 2 - index) * dwell

    return {
      stop,
      offsetFromOriginMin: fromOrigin,
      offsetFromDestinationMin: fromDestination,
      outbound: index === stops.length - 1 ? null : nextReferencePassage(line.officialFrequencies, now, fromOrigin),
      inbound: index === 0 ? null : nextReferencePassage(line.officialFrequencies, now, fromDestination),
    }
  })

  return { line, originStop, destinationStop, rows }
}

/**
 * Lignes publiées d'un réseau, prêtes pour le tableau par station. Aujourd'hui
 * seuls TER et BRT publient des lignes de référence ; DDD, AFTU et TATA
 * reviendront ici dès que des lignes leur seront publiées — l'interface les
 * affichera alors sans autre changement.
 */
export function boardLinesForNetwork(networkId: NetworkId): readonly BoardLine[] {
  return CORRIDOR_LINES.filter((line) => line.network === networkId)
}

/** Libellé court d'une station pour les en-têtes compacts. */
export function stationShortName(stop: CorridorStop): string {
  return stop.shortName ?? stop.name
}
