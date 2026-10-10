/** Local, explicit interpretation of mobility requests. Unknown places remain unknown. */
import { searchCorridorStops, type CorridorStop } from './corridors'
import type { PlannerEndpoint, PlannerPriority } from './planner'

export interface MobilityIntent {
  origin: PlannerEndpoint | null
  destination: PlannerEndpoint | null
  /** Texte du départ tel qu'écrit, lorsqu'un départ est donné mais n'est pas reconnu. */
  originText?: string | null
  priority: PlannerPriority | 'cheapest'
  compare: boolean
  arrivalRequested: boolean
  /** Minutes after midnight, Dakar (UTC+0). Null if missing or invalid. */
  arrivalMinutes: number | null
  tomorrow: boolean
}

/** Départ déclaré par l'usager dans une phrase du type « je suis à … ». */
export interface OriginStatement {
  origin: PlannerEndpoint | null
  /** Texte du lieu, lorsqu'il n'est pas reconnu sur le réseau de référence. */
  originText: string | null
  /** Question complémentaire détectée : la phrase n'est alors pas une simple déclaration. */
  hasOtherRequest: boolean
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, ' ')

/** Forme comparable d'un nom de lieu : minuscules, sans accents ni ponctuation. */
function foldPlace(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Articles et liaisons qui précèdent un lieu dans une phrase libre. */
const LEADING_LINKS = /^(?:a|au|aux|de|du|des|d|en|dans|sur|pres|proche|la|le|les|l|actuellement|maintenant|ici|pour|environ|vers)\s+/

function stripLeadingLinks(value: string): string {
  let result = value
  let previous = ''
  while (result !== previous) {
    previous = result
    result = result.replace(LEADING_LINKS, '')
  }
  return result
}

function toEndpoint(stop: CorridorStop): PlannerEndpoint {
  return { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id }
}

/** Arrêt dont le nom ou un alias est exactement la chaîne demandée. */
function exactStopFor(name: string): CorridorStop | null {
  if (!name) return null
  return searchCorridorStops(name).find((stop) =>
    [stop.name, ...stop.aliases].some((value) => foldPlace(value) === name)) ?? null
}

/**
 * Reconnaît un lieu au début d'une clause libre : « Keur Mbaye Fall je suis à »
 * donne Keur Mbaye Fall. Le plus long préfixe exact gagne ; sinon, correspondance
 * partielle sur la clause. Aucun lieu n'est deviné.
 */
function placeFromClause(clause: string): PlannerEndpoint | null {
  const words = stripLeadingLinks(foldPlace(clause)).split(' ').filter(Boolean).slice(0, 6)
  for (let count = words.length; count >= 1; count -= 1) {
    const stop = exactStopFor(words.slice(0, count).join(' '))
    if (stop) return toEndpoint(stop)
  }
  const partial = words.length ? searchCorridorStops(words.join(' '))[0] : undefined
  return partial ? toEndpoint(partial) : null
}

/** Texte d'un lieu exploitable : au moins un mot de trois lettres (pas une heure seule). */
function meaningfulText(clause: string | null | undefined): string | null {
  const folded = clause ? stripLeadingLinks(foldPlace(clause)) : ''
  // « dans le BRT » désigne un mode, pas un lieu : rien à reprendre comme départ.
  if (/^(?:brt|sunubrt|ter|train|bus|car|taxi|ddd|aftu|tata)(?: |$)/.test(folded)) return null
  return /[a-z]{3,}/.test(folded) ? folded : null
}

function endpoint(name: string): PlannerEndpoint | null {
  const stop = searchCorridorStops(name.trim())[0]
  return stop ? toEndpoint(stop) : null
}

// « je suis à X », « je me trouve à X », « j’habite X », « je pars de X », « partir de X ».
const STATED_ORIGIN = /\b(?:je suis|je me trouve|j habite|je pars|partir)\s+(?:de\s+|d\s+|a\s+|au\s+|aux\s+|en\s+|dans\s+|sur\s+|pres de\s+)?([^?!,;:]{2,80})/
// « depuis X » lorsqu'il n'est pas suivi d'une destination : « … à Rufisque depuis Keur Mbaye Fall ».
const FROM_PHRASE = /\bdepuis\s+([^?!,;:]{2,80})/
// « aller à X », « arriver à X », « me rendre à X » (préposition obligatoire) ; « rejoindre X » sans préposition.
const DESTINATION_PHRASE = /\b(?:(?:aller|arriver|me rendre|rendre)\s+(?:a|au|aux|vers|dans|en|jusqu a|jusqu au)\s+|rejoindre\s+(?:a|au|aux|vers)?\s*)([^?!,;:]{2,80})/

/** Mots qui indiquent une autre demande que la simple déclaration du départ. */
const OTHER_REQUEST_WORDS = /\b(?:horaire|horaires|prochain|prochaine|tarif|tarifs|prix|ligne|lignes|arret|arrets|station|stations|gare|gares|liste|quel|quelle|quels|quelles|combien|ou|perturbation|perturbations|frequence|frequences|passe|passent|dessert|trafic|meteo|aller|trajet|itineraire|compare|comparer|va|avant|arriver|rejoindre|sens|retour)\b/

/**
 * Déclaration du départ (« je suis à Keur Mbaye Fall »), sans destination
 * explicite. Retourne null si la phrase ne déclare pas de départ.
 */
export function extractOriginStatement(question: string): OriginStatement | null {
  const text = normalize(question).replace(/\s+/g, ' ')
  const match = STATED_ORIGIN.exec(text)
  if (!match) return null
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
  const clause = match[1]
  const origin = placeFromClause(clause)
  return {
    origin,
    originText: origin ? null : meaningfulText(clause),
    hasOtherRequest: OTHER_REQUEST_WORDS.test(rest.replace(/[^a-z0-9 ]/g, ' ')),
  }
}

export function extractMobilityIntent(question: string): MobilityIntent | null {
  const text = normalize(question)
  const wantsRoute = /\b(trajet|itineraire|aller|arriver|rejoindre|voyage|compare|comparer|comparaison|chemin)\b/.test(text)
    || /\b(?:me rendre|je pars|partir de)\b/.test(text)
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

  // Trajet explicite « de X à Y » : seul un trajet de forme « de … à … » est
  // considéré ; une recherche libre n'est jamais convertie en couple.
  const pairs = [...text.matchAll(/\b(?:de|depuis|entre)\s+([a-z0-9 .-]{2,55}?)\s+(?:a|vers|jusqu\s+a)\s+([a-z0-9 .-]{2,65})/g)]
  const pair = pairs.find((match) => endpoint(match[1]) && endpoint(match[2])) ?? pairs.at(-1)
  const pairOrigin = pair ? endpoint(pair[1]) : null

  // Départ : « de X à Y », puis « je suis à X » / « je pars de X », puis « depuis X ».
  const statedOrigin = STATED_ORIGIN.exec(text)
  const fromPhrase = FROM_PHRASE.exec(text)
  let origin: PlannerEndpoint | null = pairOrigin
  let originText: string | null = pair ? meaningfulText(pair[1]) : null
  if (!origin && !pair && statedOrigin) {
    origin = placeFromClause(statedOrigin[1])
    originText = origin ? null : meaningfulText(statedOrigin[1])
  }
  if (!origin && !pair && !statedOrigin && fromPhrase) {
    origin = placeFromClause(fromPhrase[1])
    originText = origin ? null : meaningfulText(fromPhrase[1])
  }

  // Destination : « de X à Y », puis « aller à Y ».
  const destinationPhrase = DESTINATION_PHRASE.exec(text)
  const destination = pair
    ? endpoint(pair[2]) ?? (destinationPhrase ? placeFromClause(destinationPhrase[1]) : null)
    : destinationPhrase ? placeFromClause(destinationPhrase[1]) : null
  if (!pair && !destination) return null
  return {
    origin,
    destination,
    originText,
    priority,
    compare,
    arrivalRequested,
    arrivalMinutes,
    tomorrow: /\bdemain\b/.test(text),
  }
}

/**
 * Applique un départ déjà connu de la conversation (« je suis à … » donné plus
 * tôt) à une demande qui n'indique qu'une destination. Un départ écrit mais non
 * reconnu n'est jamais remplacé en silence.
 */
export function withFallbackOrigin(intent: MobilityIntent | null, fallbackOrigin: PlannerEndpoint | null | undefined): MobilityIntent | null {
  if (!intent || intent.origin || intent.originText || !fallbackOrigin || !intent.destination) return intent
  return { ...intent, origin: fallbackOrigin }
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
