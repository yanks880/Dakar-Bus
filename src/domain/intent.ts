/** Local, explicit interpretation of mobility requests. Unknown places remain unknown. */
import { searchCorridorStops } from './corridors'
import type { PlannerEndpoint, PlannerPriority } from './planner'

export interface MobilityIntent {
  origin: PlannerEndpoint | null
  destination: PlannerEndpoint | null
  priority: PlannerPriority | 'cheapest'
  compare: boolean
  arrivalRequested: boolean
  /** Minutes after midnight, Dakar (UTC+0). Null if missing or invalid. */
  arrivalMinutes: number | null
  tomorrow: boolean
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, ' ')

function endpoint(name: string): PlannerEndpoint | null {
  const stop = searchCorridorStops(name.trim())[0]
  return stop ? { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id } : null
}

export function extractMobilityIntent(question: string): MobilityIntent | null {
  const text = normalize(question)
  const wantsRoute = /\b(trajet|itineraire|aller|arriver|rejoindre|voyage|compare|comparer|comparaison|chemin)\b/.test(text)
  if (!wantsRoute) return null
  const priority: MobilityIntent['priority'] = /moins cher|le moins couteux|meilleur prix|prix le plus bas/.test(text) ? 'cheapest'
    : /moins de marche|marcher le moins|eviter? (?:de )?marcher/.test(text) ? 'lessWalking'
      : /moins de correspondances|eviter? les correspondances|sans correspondance/.test(text) ? 'fewerTransfers' : 'fastest'
  const compare = /compar|alternatives|plusieurs options/.test(text)
  const time = /\b(?:avant|arriver\s+(?:avant|a))\s*(\d{1,2})\s*(?:h|:)(\d{0,2})\b/.exec(text)
  const arrivalRequested = /\b(?:avant\s+\d|arriver\s+(?:avant|a)\s*\d)/.test(text)
  const hour = time ? Number(time[1]) : -1
  const minute = time && time[2] ? Number(time[2]) : 0
  const arrivalMinutes = hour >= 0 && hour < 24 && minute < 60 ? hour * 60 + minute : null

  // Only a route-shaped phrase is considered; a free-text stop search is not
  // silently converted into an origin/destination pair.
  const pairs = [...text.matchAll(/\b(?:de|depuis|entre)\s+([a-z0-9 .-]{2,55}?)\s+(?:a|vers|jusqu\s+a)\s+([a-z0-9 .-]{2,65})/g)]
  const pair = pairs.find((match) => endpoint(match[1]) && endpoint(match[2])) ?? pairs.at(-1)
  const origin = pair ? endpoint(pair[1]) : null
  const destination = pair ? endpoint(pair[2]) : endpoint(/\b(?:aller|arriver|rejoindre)\s+(?:a|vers)\s+([a-z0-9 .-]{2,65})/.exec(text)?.[1] ?? '')
  if (!pair && !destination) return null
  return { origin, destination, priority, compare, arrivalRequested, arrivalMinutes, tomorrow: /\bdemain\b/.test(text) }
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
