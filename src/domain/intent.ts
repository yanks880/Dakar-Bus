/** Local, explicit interpretation of mobility requests. Unknown places remain unknown. */
import { searchCorridorStops } from './corridors'
import { getPlace, isRouteQuestion, placeEndpoint, resolveJourneyEndpoints, type PlaceEntry } from './places'
import type { PlannerEndpoint, PlannerPriority } from './planner'

export interface MobilityIntent {
  origin: PlannerEndpoint | null
  destination: PlannerEndpoint | null
  /** Lieux reconnus, y compris ceux des fiches bus (non calculables). */
  originPlace: PlaceEntry | null
  destinationPlace: PlaceEntry | null
  priority: PlannerPriority | 'cheapest'
  compare: boolean
  arrivalRequested: boolean
  /** Minutes after midnight, Dakar (UTC+0). Null if missing or invalid. */
  arrivalMinutes: number | null
  tomorrow: boolean
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, ' ')

function endpointFromStop(name: string): PlaceEntry | null {
  const stop = searchCorridorStops(name.trim())[0]
  return stop ? getPlace(stop.id) : null
}

/**
 * Filet de sécurité : si aucun lieu de la mémoire n'est reconnu tel quel, une
 * formulation « de X à Y » est encore résolue par la recherche tolérante du
 * réseau de référence. La mémoire des lieux reste prioritaire.
 */
function legacyEndpoints(question: string): { origin: PlaceEntry | null; destination: PlaceEntry | null } | null {
  const text = normalize(question)
  const pairs = [...text.matchAll(/\b(?:de|depuis|entre)\s+([a-z0-9 .-]{2,55}?)\s+(?:a|vers|jusqu\s+a)\s+([a-z0-9 .-]{2,65})/g)]
  const pair = pairs.find((match) => endpointFromStop(match[1]) && endpointFromStop(match[2])) ?? pairs.at(-1)
  if (pair) {
    return { origin: endpointFromStop(pair[1]), destination: endpointFromStop(pair[2]) }
  }
  const single = /\b(?:aller|arriver|rejoindre)\s+(?:a|vers)\s+([a-z0-9 .-]{2,65})/.exec(text)
  if (single) return { origin: null, destination: endpointFromStop(single[1]) }
  return null
}

export interface RoutePreferences {
  priority: PlannerPriority | 'cheapest'
  compare: boolean
  arrivalRequested: boolean
  /** Minutes après minuit, heure de Dakar (UTC+0). Null si absente ou invalide. */
  arrivalMinutes: number | null
  tomorrow: boolean
}

/**
 * Critères de trajet portés par une phrase, indépendamment de la présence d'un
 * verbe de déplacement : « Keur Mbaye Fall Dakar avant 9 h, moins de marche »
 * est compris comme « Keur Mbaye Fall → Diamniadio avant 9 h, moins de marche ».
 */
export function routePreferencesFrom(question: string): RoutePreferences {
  const text = normalize(question)
  const priority: RoutePreferences['priority'] = /moins cher|le moins couteux|meilleur prix|prix le plus bas/.test(text) ? 'cheapest'
    : /moins de marche|marcher le moins|eviter? (?:de )?marcher/.test(text) ? 'lessWalking'
      : /moins de correspondances|eviter? les correspondances|sans correspondance/.test(text) ? 'fewerTransfers' : 'fastest'
  const time = /\b(?:avant|arriver\s+(?:avant|a))\s*(\d{1,2})\s*(?:h|:)(\d{0,2})\b/.exec(text)
  const hour = time ? Number(time[1]) : -1
  const minute = time && time[2] ? Number(time[2]) : 0
  return {
    priority,
    compare: /compar|alternatives|plusieurs options/.test(text),
    arrivalRequested: /\b(?:avant\s+\d|arriver\s+(?:avant|a)\s*\d)/.test(text),
    arrivalMinutes: hour >= 0 && hour < 24 && minute < 60 ? hour * 60 + minute : null,
    tomorrow: /\bdemain\b/.test(text),
  }
}

export function extractMobilityIntent(question: string): MobilityIntent | null {
  // Le langage naturel est analysé : « comment faire pour aller à Dakar ? Je
  // suis à Keur Mbaye Fall » est une demande d'itinéraire, pas un mot-clé.
  if (!isRouteQuestion(question)) return null
  const { priority, compare, arrivalRequested, arrivalMinutes, tomorrow } = routePreferencesFrom(question)

  const resolved = resolveJourneyEndpoints(question)
  let originPlace = resolved?.origin ?? null
  let destinationPlace = resolved?.destination ?? null
  if (!originPlace && !destinationPlace) {
    const legacy = legacyEndpoints(question)
    originPlace = legacy?.origin ?? null
    destinationPlace = legacy?.destination ?? null
  }
  if (!originPlace && !destinationPlace) return null
  return {
    origin: originPlace ? placeEndpoint(originPlace) : null,
    destination: destinationPlace ? placeEndpoint(destinationPlace) : null,
    originPlace,
    destinationPlace,
    priority,
    compare,
    arrivalRequested,
    arrivalMinutes,
    tomorrow,
  }
}

/** Date-aware estimate in Dakar time (UTC+0), never a service guarantee. */
export function departureAdvice(arrivalMinutes: number, durationMinutes: number, now: number, tomorrow = false): string {
  const today = new Date(now)
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  let arrival = midnight + arrivalMinutes * 60_000 + (tomorrow ? 86_400_000 : 0)
  if (!tomorrow && arrival - durationMinutes * 60_000 <= now) arrival += 86_400_000
  const departure = new Date(arrival - durationMinutes * 60_000)
  const formatted = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Dakar', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(departure)
  return `Pour arriver à l’heure souhaitée, départ estimé le ${formatted} (heure de Dakar), soit environ ${durationMinutes} min avant. Ce calcul n’assure ni un service à cette heure, ni une arrivée garantie : vérifiez les horaires auprès des opérateurs.`
}
