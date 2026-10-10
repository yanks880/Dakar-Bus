/**
 * Modèles de réponse en wolof pour le copilote.
 *
 * HONNÊTETÉ LINGUISTIQUE : ces modèles sont des phrases wolof de base,
 * construites à partir de formules courantes (salutations, direction,
 * proximité, négation). Ils ne couvrent ni toutes les variantes dialectales,
 * ni la grammaire complète. Ils doivent être validés par des locuteurs
 * compétents avant toute mise en avant ; tant que ce n'est pas fait,
 * l'application l'indique et le français reste toujours disponible.
 * Les noms propres (gares, stations, réseaux) ne sont pas traduits.
 */

import type { PlannerLeg } from './planner'
import { formatMeters } from './planner'

export const WOLOF_VALIDATION_NOTE =
  'Modèles wolof de base — en attente de validation par des locuteurs. Le français reste disponible à tout moment.'

export function woGreeting(): string {
  return `Nanga def ! Maa ngi lay dimbali ci sa yoonu Dakar : xam naa 13 gares TER yi ak 23 stations BRT yi. Laaj ma, dinaa la tontu ci li ma xam dëgg.\n(${WOLOF_VALIDATION_NOTE})`
}

export function woAskOrigin(): string {
  return 'Waxal ma fan nga jóge : « jóge [bërëb] dem [bërëb] ». Xamuma fan nga nekk, te du ko xalaat ci boppam.'
}

export function woUnknownPlace(): string {
  return 'Bërëb boobu amul ci xibaar yi ma am (TER/BRT refférans). Li ma xamul, dama koy wax ni mu nekk — du ma jum dara.'
}

export function woJourneyHeader(origin: string, destination: string): string {
  return `Yoon wi : ${origin} → ${destination}. Xayma la ci référaas TER/BRT : du horaire bu dëgg, du temps réel.`
}

export function woLeg(leg: PlannerLeg): string {
  switch (leg.kind) {
    case 'walk_access':
    case 'walk_egress':
      return `Dox ba ${leg.to} (${formatMeters(leg.distanceM)}, ~${leg.minutes} min).`
    case 'walk_direct':
      return `Dox : ${leg.from} → ${leg.to} (${formatMeters(leg.distanceM)}, ~${leg.minutes} min).`
    case 'walk_transfer':
      return `Wàccal, dem ci ${leg.to} ngir soppi (${formatMeters(leg.distanceM)}, ~${leg.minutes} min).`
    case 'ride':
      return `Jël ${leg.line?.shortName ?? 'ligne'} : ${leg.from} → ${leg.to} (~${leg.minutes} min).`
    case 'wait':
      return `Xaar (~${leg.minutes} min).`
    default:
      return leg.from ?? ''
  }
}

export function woTotal(totalMinutes: number, transfers: number): string {
  const transferNote = transfers > 0 ? ` · ${transfers} correspondance(s)` : ''
  return `Lépp : ~${totalMinutes} minit${transferNote}. Tarifs yi : xamuma lépp — du ko wax.`
}

export function woNearestStop(name: string, distanceM: number, networkLabel: string): string {
  return `Bërëbu dem bi gën a jege mooy ${name} (${networkLabel}), ~${distanceM < 1000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1000).toFixed(1).replace('.', ',')} km`} ci sa wet.`
}

export function woNoLocation(): string {
  return 'Xamuma fan nga nekk. Jëfandikool « Me localiser » ci carte bi, walla waxal ma bërëb bu am solo (gare, station, quartier).'
}

export function woHonestLimit(): string {
  return 'Li ma xam : référaas TER ak BRT. DDD ak AFTU : amul xibaar bu wóor fii — du ma leen jum. Temps réel amul.'
}

/** Préfixe honnête quand une réponse n'existe qu'en français. */
export function woFrenchFallbackPrefix(): string {
  return '(Tontu bii ci français la — modèles wolof yi soxla nañu vérification)\n'
}
