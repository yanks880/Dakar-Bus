import { answerMobilityKnowledge } from './mobilityKnowledge'
/**
 * Copilote de mobilité : interprétation des questions libres, récupération
 * dans le référentiel, calcul d'itinéraires et réponses honnêtes.
 *
 * Pipeline d'une question :
 * 1. détecter la langue (français, wolof, mixte) et la langue de réponse ;
 * 2. résoudre les questions de suivi avec le contexte de conversation ;
 * 3. reconnaître les intentions nouvelles (arrêt proche, ligne qui dessert,
 *    arrêts entre deux points, dernier départ, alternatives, explication) ;
 * 4. déléguer le reste au moteur de réponses existant (`assistant.ts`), qui
 *    couvre déjà fréquences, listes, trajets, tarifs et état des données ;
 * 5. ne jamais inventer : une donnée absente produit une réponse qui le dit.
 */

import {
  answerAssistant,
  extractJourneyRequest,
  getAssistantCountdownMinutes,
  type AssistantContext,
} from './assistant'
import { compareReferenceJourneys } from './comparison'
import {
  detectFollowUp,
  rememberJourney,
  reversedJourney,
  type ConversationMemory,
} from './conversation'
import { extractMobilityIntent } from './intent'
import {
  detectLanguage,
  resolveResponseLanguage,
  type AssistantLanguagePreference,
  type ResponseLanguage,
} from './language'
import { describeLeg, formatMeters, planReferenceJourney, type PlannerEndpoint, type PlannerLeg } from './planner'
import {
  REFERENTIAL_LINES,
  REFERENTIAL_STOPS,
  REFERENTIAL_TRANSFERS,
  findReferentialLine,
  findReferentialStops,
  formatReferentialSource,
  linesForStop,
  nearestReferentialStops,
  publishedServiceWindow,
  referentialKnowledgeSummary,
  stopsBetween,
} from './referential'
import {
  woAskOrigin,
  woFrenchFallbackPrefix,
  woGreeting,
  woHonestLimit,
  woJourneyHeader,
  woLeg,
  woNearestStop,
  woNoLocation,
  woTotal,
  woUnknownPlace,
} from './wolof'

export interface CopilotReply {
  text: string
  language: ResponseLanguage
  /** Trajet injectable dans l'onglet Trajet, si la réponse en produit un. */
  journey?: { origin: PlannerEndpoint; destination: PlannerEndpoint }
  /** Compte à rebours seulement si un départ programmé exact est fourni. */
  countdownMinutes?: number
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function describeRideLegs(legs: readonly PlannerLeg[]): string[] {
  return legs.map((leg) => describeLeg(leg))
}

function alightStopOf(legs: readonly PlannerLeg[]): string | null {
  for (let index = legs.length - 1; index >= 0; index -= 1) {
    const leg = legs[index]
    if (leg.kind === 'ride') return leg.to ?? null
  }
  return null
}

/** Enregistrement local du trajet pour les questions de suivi. */
function rememberLastJourney(
  memory: ConversationMemory,
  legs: readonly PlannerLeg[],
  origin: PlannerEndpoint,
  destination: PlannerEndpoint,
  outcome: { totalMinutes: number; transfers: number; boardedLines: string[] },
): void {
  rememberJourney(memory, {
    origin,
    destination,
    steps: describeRideLegs(legs),
    totalMinutes: outcome.totalMinutes,
    boardedLines: outcome.boardedLines,
    transfers: outcome.transfers,
    alightStop: alightStopOf(legs),
  })
}

/** Réponse wolof construite sur le même calcul que la réponse française. */
function wolofJourneyReply(memory: ConversationMemory, origin: PlannerEndpoint, destination: PlannerEndpoint): CopilotReply {
  const outcome = planReferenceJourney(origin, destination)
  if (!outcome.ok) {
    return { text: `${woUnknownPlace()}\n${woHonestLimit()}`, language: 'wo' }
  }
  const steps = outcome.legs.map((leg) => `• ${woLeg(leg)}`).join('\n')
  const text = `${woJourneyHeader(origin.label, destination.label)}\n${steps}\n${woTotal(outcome.totalMinutes, outcome.transfers)}\n${woHonestLimit()}`
  rememberLastJourney(memory, outcome.legs, origin, destination, outcome)
  return { text, language: 'wo', journey: { origin, destination } }
}

/**
 * Extrait (origine, destination) d'une demande de trajet formulée en wolof :
 * « jóge X dem Y » ou « dem ci X ». Aucun lieu n'est déduit : seuls les lieux
 * présents dans le référentiel sont retenus.
 */
function wolofJourneyEndpoints(question: string): { origin: PlannerEndpoint | null; destination: PlannerEndpoint | null } | null {
  const text = question.toLowerCase().replace(/['’]/g, ' ')
  const joge = '(?:j\u00f3ge|joge)'
  const placeChars = 'a-z\u00eb\u00e0\u00f1\u00f3\u014bx0-9 .-'
  const pair = new RegExp(`${joge}\\s+([${placeChars}]{2,55}?)\\s+dem\\b(?:\\s+(?:ci|ba|si|ca))?\\s+([${placeChars}]{2,65})`).exec(text)
  const toEndpoint = (name: string): PlannerEndpoint | null => {
    const stop = findReferentialStops(name)[0]
    return stop ? { label: stop.name, lat: stop.lat, lon: stop.lon, stopId: stop.id } : null
  }
  if (pair) {
    return { origin: toEndpoint(pair[1]), destination: toEndpoint(pair[2]) }
  }
  const single = new RegExp(`dem\\s+(?:ci|ba|si|ca)\\s+([${placeChars}]{2,65})`).exec(text)
  if (single) {
    return { origin: null, destination: toEndpoint(single[1]) }
  }
  return null
}

function nearestStopReply(context: AssistantContext, language: ResponseLanguage): string {
  const location = context.userLocation
  if (!location) {
    return language === 'wo'
      ? woNoLocation()
      : 'Je ne connais pas votre position : la géolocalisation n’a pas été activée dans cette session. Touchez « Me localiser » dans Explorer, ou donnez-moi un lieu (gare, station, quartier).'
  }
  const nearest = nearestReferentialStops({ lat: location.lat, lon: location.lon }, 1)[0]
  if (!nearest) {
    return 'Aucun arrêt TER ou BRT du référentiel n’a pu être rapproché de votre position.'
  }
  const lines = linesForStop(nearest.stop.id).map((line) => line.shortName).join(' et ') || 'réseau de référence'
  if (language === 'wo') {
    return woNearestStop(nearest.stop.name, nearest.distanceM, lines)
  }
  const precision = location.accuracyM && location.accuracyM > 100 ? ' Votre position est approximative : la distance est indicative.' : ''
  return `L’arrêt de référence le plus proche est ${nearest.stop.name} (${lines}), à environ ${nearest.distanceM < 1000 ? `${Math.round(nearest.distanceM)} m` : `${(nearest.distanceM / 1000).toFixed(1).replace('.', ',')} km`} de votre position.${precision} Ce calcul porte sur les arrêts TER/BRT du référentiel ; DDD/AFTU ne sont pas intégrés.`
}

function stopsBetweenReply(question: string, memory: ConversationMemory): string | null {
  const text = normalize(question)
  if (!/\barrets\b.*\bentre\b|\bentre\b.*\bet\b.*\bquels\b|\bquels arrets\b/.test(text) && !/arrets (?:se trouvant|situes) entre/.test(text)) {
    return null
  }
  // Variante déictique : « entre mon point de départ et ma destination ».
  if (/entre mon (?:point de )?depart et ma destination|entre mon depart et ma destination/.test(text)) {
    const originId = memory.lastOrigin?.stopId
    const destinationId = memory.lastDestination?.stopId
    if (!originId || !destinationId) {
      return 'Je n’ai pas encore de départ et de destination en mémoire : demandez d’abord un trajet, puis reposez la question.'
    }
    for (const line of REFERENTIAL_LINES) {
      const sequence = stopsBetween(line, originId, destinationId)
      if (sequence) {
        const list = sequence.map((stop, index) => `${index + 1}. ${stop.name}`).join('\n')
        return `Arrêts de la ligne ${line.shortName} sur votre trajet (${sequence[0].name} → ${sequence[sequence.length - 1].name}) :\n${list}\nOrdre de desserte du référentiel — pas un horaire.`
      }
    }
    const journey = memory.lastJourney
    if (journey && journey.steps.length > 0) {
      return `Votre trajet ${journey.origin.label} → ${journey.destination.label} n’emprunte pas une seule ligne de bout en bout :\n${journey.steps.map((step) => `• ${step}`).join('\n')}\nIl n’existe donc pas de liste unique d’arrêts intermédiaires sur une seule ligne.`
    }
    return 'Ces deux points ne sont pas sur la même ligne du référentiel TER/BRT.'
  }
  const pair = /\bentre\s+([a-z0-9 .-]{2,55}?)\s+(?:et|a|jusqu\s+a)\s+([a-z0-9 .-]{2,65})/.exec(text)
  if (!pair) return 'Pour lister les arrêts entre deux points, indiquez « arrêts entre [arrêt] et [arrêt] ».'
  const fromMatches = findReferentialStops(pair[1])
  const toMatches = findReferentialStops(pair[2])
  if (fromMatches.length === 0 || toMatches.length === 0) {
    return 'Un des deux arrêts n’est pas dans le référentiel TER/BRT : je ne peux pas lister les arrêts intermédiaires sans arrêts reconnus.'
  }
  const from = fromMatches[0]
  const to = toMatches[0]
  for (const line of REFERENTIAL_LINES) {
    const sequence = stopsBetween(line, from.id, to.id)
    if (sequence) {
      const list = sequence.map((stop, index) => `${index + 1}. ${stop.name}`).join('\n')
      return `Arrêts de la ligne ${line.shortName} entre ${from.name} et ${to.name} (sens ${from.name} → ${to.name}) :\n${list}\nOrdre de desserte du référentiel — pas un horaire.`
    }
  }
  return `${from.name} et ${to.name} ne sont pas sur la même ligne du référentiel TER/BRT : je ne peux pas lister d’arrêts intermédiaires sans ligne commune vérifiée.`
}

function lineNumberReply(question: string, memory: ConversationMemory): string | null {
  const text = normalize(question)
  const deicticStop = /\b(?:cet|cette|ce)\s+(?:arret|station|gare)\b/.test(text)
  const deicticDestination = /cette destination|ma destination/.test(text)
  if (!deicticStop && !deicticDestination && !/numero de la ligne|quelles? lignes? (?:passent?|passe|desservent?|va|men[èe]nt?)|quelle ligne (?:va|dessert|passe|men?e)|quelle est la ligne|ligne qui dessert|code de la ligne|quelles lignes/.test(text)) {
    return null
  }
  let deicticStopId: string | null = null
  if (deicticStop) {
    deicticStopId = memory.lastStopId
    if (!deicticStopId) return 'De quel arrêt parlez-vous ? Nommez-le (« lignes à Petersen ») ou mentionnez d’abord un arrêt : je ne devine pas l’arrêt courant.'
  } else if (deicticDestination) {
    deicticStopId = memory.lastDestination?.stopId ?? null
    if (!deicticStopId) return 'Quelle destination ? Donnez-moi un lieu reconnu (gare ou station) : je ne devine pas la destination courante.'
  }
  if (deicticStopId) {
    const deicticStop = REFERENTIAL_STOPS.find((entry) => entry.id === deicticStopId) ?? null
    if (!deicticStop) return 'L’arrêt gardé en mémoire n’est plus dans le référentiel.'
    const deicticLines = linesForStop(deicticStop.id)
    if (deicticLines.length === 0) return `${deicticStop.name} figure dans le référentiel, mais aucune ligne de référence n’y est associée.`
    return `${deicticStop.name} est desservi par : ${deicticLines.map((line) => `${line.shortName} (${line.terminusFrom} ↔ ${line.terminusTo})`).join(', ')}. Réseau de référence — source dans Paramètres, état des données.`
  }
  const target = /\b(?:vers|a|pour|jusqu a)\s+([a-z0-9 .-]{2,65})$/.exec(text)
  const stops = target ? findReferentialStops(target[1]) : findReferentialStops(question)
  if (stops.length === 0) {
    return 'Je n’ai pas reconnu de destination sur le réseau de référence TER/BRT. Les lignes DDD/AFTU ne sont pas vérifiées dans le dépôt : je ne peux pas donner un numéro que je ne connais pas.'
  }
  const stop = stops[0]
  const lines = linesForStop(stop.id)
  if (lines.length === 0) {
    return `${stop.name} figure dans le référentiel, mais aucune ligne de référence n’y est associée.`
  }
  memory.lastStopId = stop.id
  return `${stop.name} est desservi par : ${lines.map((line) => `${line.shortName} (${line.terminusFrom} ↔ ${line.terminusTo})`).join(', ')}. Réseau de référence — source dans Paramètres, état des données.`
}

/** Correspondances déclarées entre le TER et le BRT : les seules connues. */
function transfersReply(question: string): string | null {
  const text = normalize(question)
  if (!/correspondance entre|comment faire une correspondance|changer entre|passer du ter au brt|passer du brt au ter|liaison entre/.test(text)) {
    return null
  }
  const list = REFERENTIAL_TRANSFERS
    .map((transfer) => `• ${transfer.label}`)
    .join('\n')
  return `Correspondances déclarées entre le TER et le BRT :\n${list}\nDistances de marche de référence (estimations, pas un cheminement mesuré). Aucune autre correspondance officielle n’est intégrée : DDD/AFTU ne sont pas vérifiés dans le dépôt.`
}

/** Classement par critère d'un trajet déjà en mémoire — options réellement
 *  calculées uniquement, jamais de classement sur des données absentes. */
function criterionReply(question: string, memory: ConversationMemory): string | null {
  const text = normalize(question)
  const criterion: 'fastest' | 'lessWalking' | 'fewerTransfers' | null =
    /moins de marche|marcher le moins/.test(text) ? 'lessWalking'
      : /moins de correspondances|sans correspondance|le plus simple/.test(text) ? 'fewerTransfers'
        : /plus rapide|le plus court|meilleur temps/.test(text) ? 'fastest' : null
  if (!criterion) return null
  const origin = memory.lastOrigin
  const destination = memory.lastDestination
  if (!origin || !destination) {
    return 'Pour comparer selon ce critère, indiquez d’abord un départ et une destination (« trajet de … à … ») : je ne classe que des itinéraires réellement calculés.'
  }
  const comparison = compareReferenceJourneys(origin, destination)
  if (!comparison.ok) return comparison.message
  const chosen = comparison.options.find((option) => option.priority === comparison.bestBy[criterion])!
  const ranking = criterion === 'fastest' ? 'Le plus rapide' : criterion === 'lessWalking' ? 'Le moins de marche' : 'Le moins de correspondances'
  return `${ranking} parmi ${comparison.options.length} option(s) réellement calculée(s) entre ${origin.label} et ${destination.label} : ${chosen.result.boardedLines.join(' + ') || 'à pied'} — environ ${chosen.result.totalMinutes} min, ${formatMeters(chosen.result.totalWalkM)} de marche, ${chosen.result.transfers} correspondance(s). Estimations du réseau de référence : ni horaires de passage, ni temps réel. Tarif non comparé (données insuffisantes).`
}

function lastDepartureReply(question: string): string | null {
  const text = normalize(question)
  if (!/dernier (?:depart|train|bus|passage|horair)|derniere? (?:course|heure de service)|heure de fin|fin de service|a quelle heure (?:se termine|finit|s arrete)/.test(text)) {
    return null
  }
  const wantsTer = /\bter\b|\btrain\b|\bgare\b/.test(text)
  const wantsBrt = /\bbrt\b|\bb1\b|\bstation\b|\bbus\b/.test(text)
  const networks: ('ter' | 'brt')[] = wantsTer && !wantsBrt ? ['ter'] : wantsBrt && !wantsTer ? ['brt'] : ['ter', 'brt']
  const parts: string[] = []
  for (const networkId of networks) {
    const window = publishedServiceWindow(networkId)
    const label = networkId === 'ter' ? 'TER' : 'BRT'
    if (window.status === 'SCHEDULED' && window.lastDeparture) {
      parts.push(`• ${label} : fin de service publiée à ${window.lastDeparture} (premier départ ${window.firstDeparture}). Statut SCHEDULED — grille de fréquence de référence, pas un passage observé. ${window.source ? formatReferentialSource(window.source) : ''}`)
    } else {
      parts.push(`• ${label} : dernière heure de départ inconnue (aucune grille publiée).`)
    }
  }
  return `Derniers départs connus d’après les fenêtres de service publiées :\n${parts.join('\n')}\nUne fréquence ne donne pas l’heure exacte d’un passage : aucun départ individuel n’est déduit.`
}

function alternativeReply(question: string, memory: ConversationMemory): string | null {
  const text = normalize(question)
  if (!/alternative|itineraire de secours|si (?:la ligne|le ter|le brt) (?:est interrompue|interrompu|en panne|supprime|ne marche pas)|remplacer la ligne/.test(text)) {
    return null
  }
  const origin = memory.lastOrigin
  const destination = memory.lastDestination
  const disclaimer = 'Aucune perturbation n’est connectée à l’application : je ne peux pas confirmer une interruption. Voici uniquement les variantes réellement calculables sur le réseau de référence TER/BRT.'
  if (!origin || !destination) {
    return `${disclaimer} Donnez-moi un départ et une destination (« trajet de … à … ») pour que je compare les options.`
  }
  const comparison = compareReferenceJourneys(origin, destination)
  if (!comparison.ok) return `${disclaimer}\n${comparison.message}`
  const options = comparison.options
    .map((option, index) => `• Option ${index + 1} (${option.result.boardedLines.join(' + ') || 'à pied'}) : ~${option.result.totalMinutes} min, ${formatMeters(option.result.totalWalkM)} de marche, ${option.result.transfers} correspondance(s).`)
    .join('\n')
  return `${disclaimer}\n${options}`
}

function whyJourneyReply(memory: ConversationMemory, language: ResponseLanguage): string {
  const journey = memory.lastJourney
  if (!journey) {
    return language === 'wo'
      ? 'Amul trajet bu ma la joxoon balaa. Laaj ma « trajet de … à … » ba ma ko mën a leeral.'
      : 'Je n’ai pas encore proposé de trajet dans cette conversation : demandez-moi « trajet de … à … » et je pourrai l’expliquer.'
  }
  const steps = journey.steps.map((step) => `• ${step}`).join('\n')
  return `Pourquoi ce trajet (${journey.origin.label} → ${journey.destination.label}) :\n${steps}\nMéthode : marche d’accès, attente estimée à partir de la fréquence officielle de référence (demi-intervalle), temps de parcours estimé par distance et vitesse commerciale de référence, correspondances marchables déclarées. Ce sont des estimations (ESTIMATED), pas des horaires publiés ni du temps réel. Tarif non comparé : données insuffisantes.`
}

function alightReply(memory: ConversationMemory, language: ResponseLanguage): string {
  const journey = memory.lastJourney
  if (!journey) {
    return language === 'wo'
      ? 'Waxal ma sa destination balaa : du mën a xam fan nga wara wàcc.'
      : 'Indiquez d’abord votre destination (« trajet de … à … ») : je pourrai alors vous dire où descendre.'
  }
  if (!journey.alightStop) {
    return `Pour ${journey.origin.label} → ${journey.destination.label}, le calcul ne comporte pas de segment en transport (marche seule) : il n’y a pas d’arrêt où descendre.`
  }
  const lines = journey.boardedLines.length > 0 ? journey.boardedLines.join(' puis ') : 'la ligne calculée'
  return `Descendez à ${journey.alightStop}, après avoir pris ${lines}. Dernière jambe du dernier calcul — refaites le calcul si vous avez changé de destination.`
}

/**
 * Répond à une question libre en s'appuyant sur le référentiel, le moteur
 * d'itinéraires et le contexte de conversation. `memory` est mis à jour.
 */
export function copilotAnswer(
  question: string,
  context: AssistantContext,
  memory: ConversationMemory,
  preference: AssistantLanguagePreference,
  now = Date.now(),
): CopilotReply {
  const detected = detectLanguage(question)
  const language = resolveResponseLanguage(preference, detected)
  const text = normalize(question)

  // Consultation documentaire avant le parseur de trajets TER/BRT : les noms
  // de quartiers et numéros bus ne doivent pas être interprétés comme du rail.
  const knowledge = answerMobilityKnowledge(question, memory.lastKnowledgeLineId)
  if (knowledge) {
    memory.lastKnowledgeLineId = knowledge.lineId ?? null
    memory.lastAnswer = knowledge.text
    // Ne pas réutiliser un ancien trajet TER/BRT après une fiche bus.
    if (knowledge.lineId || /\b(ddd|aftu|tata)\b/.test(text) || knowledge.text.startsWith('Pistes documentaires')) {
      memory.lastJourney = null
      memory.lastOrigin = null
      memory.lastDestination = null
    }
    return { text: language === 'wo' ? woFrenchFallbackPrefix() + knowledge.text : knowledge.text, language: 'fr' }
  }

  // 1) Questions de suivi, résolues avec le contexte précédent.
  const followUp = detectFollowUp(question)
  if (followUp === 'reverse') {
    const reversed = reversedJourney(memory)
    if (reversed) {
      if (language === 'wo') return wolofJourneyReply(memory, reversed.origin, reversed.destination)
      const outcome = planReferenceJourney(reversed.origin, reversed.destination)
      if (outcome.ok) {
        rememberLastJourney(memory, outcome.legs, reversed.origin, reversed.destination, outcome)
        const steps = outcome.legs.map((leg) => `• ${describeLeg(leg)}`).join('\n')
        return {
          text: `Trajet retour : ${reversed.origin.label} → ${reversed.destination.label}.\n${steps}\nEnviron ${outcome.totalMinutes} min au total, ${formatMeters(outcome.totalWalkM)} de marche, ${outcome.transfers} correspondance(s). ${outcome.limitation}`,
          language: 'fr',
          journey: reversed,
        }
      }
      return { text: outcome.message, language: 'fr' }
    }
    return {
      text: language === 'wo'
        ? 'Amul trajet bu njëkk bu ma xam : waxal ma « jóge … dem … » balaa.'
        : 'Je n’ai pas encore de trajet en mémoire pour cette conversation : donnez-moi d’abord un départ et une destination.',
      language,
    }
  }
  if (followUp === 'why') {
    return { text: whyJourneyReply(memory, language), language: 'fr' }
  }
  if (followUp === 'alight') {
    return { text: alightReply(memory, language), language: 'fr' }
  }
  if (followUp === 'confirmed') {
    return { text: referentialKnowledgeSummary(), language: 'fr' }
  }
  if (followUp === 'again') {
    return {
      text: memory.lastAnswer ?? 'Je n’ai pas de réponse précédente à répéter dans cette conversation.',
      language: 'fr',
    }
  }

  // 2) Salutations wolof.
  if (language === 'wo' && /^(nanga def|nangadef|salam|salaam|bonjour|bonsoir|salut|coucou)\b/.test(text)) {
    const reply: CopilotReply = { text: woGreeting(), language: 'wo' }
    memory.lastAnswer = reply.text
    return reply
  }

  // 3) Intention de trajet en wolof : mêmes données, modèle wolof.
  if (language === 'wo') {
    const wolofRoute = wolofJourneyEndpoints(question)
    if (wolofRoute) {
      if (!wolofRoute.origin && !wolofRoute.destination) return { text: `${woUnknownPlace()}\n${woHonestLimit()}`, language: 'wo' }
      if (!wolofRoute.origin) return { text: woAskOrigin(), language: 'wo' }
      if (!wolofRoute.destination) return { text: `${woUnknownPlace()}\n${woHonestLimit()}`, language: 'wo' }
      const reply = wolofJourneyReply(memory, wolofRoute.origin, wolofRoute.destination)
      memory.lastAnswer = reply.text
      return reply
    }
    const intent = extractMobilityIntent(question)
    if (intent) {
      if (!intent.origin) return { text: woAskOrigin(), language: 'wo' }
      if (!intent.destination) return { text: `${woUnknownPlace()}\n${woHonestLimit()}`, language: 'wo' }
      const reply = wolofJourneyReply(memory, intent.origin, intent.destination)
      memory.lastAnswer = reply.text
      return reply
    }
    if (/bërëb bi gën a jege|berëb bi gën a jege|estasiyoŋ bi gën a jege|station bi gën a jege|wetam|gën a jege/.test(question)) {
      const replyText = nearestStopReply(context, 'wo')
      memory.lastAnswer = replyText
      return { text: replyText, language: 'wo' }
    }
  }

  // 4) Familles nouvelles, servies par le référentiel.
  if (/station la plus proche|arret le plus proche|gare la plus proche|arret pres de|station pres de|ou se trouve la station|ou est la station|ou se trouve l arret|ou est l arret|proche de moi/.test(text)) {
    const replyText = nearestStopReply(context, language)
    memory.lastAnswer = replyText
    return { text: replyText, language }
  }
    const between = stopsBetweenReply(question, memory)
    if (between) {
      memory.lastAnswer = between
      return { text: between, language: 'fr' }
    }
    const lineNumber = lineNumberReply(question, memory)
    if (lineNumber) {
      memory.lastAnswer = lineNumber
      return { text: lineNumber, language: 'fr' }
    }
    const transfers = transfersReply(question)
    if (transfers) {
      memory.lastAnswer = transfers
      return { text: transfers, language: 'fr' }
    }
    // Le classement par critère ne s'applique qu'aux questions sans lieux
    // explicites : une demande « trajet de X à Y, moins de marche » suit le
    // chemin principal du calculateur.
    const explicitRoute = extractMobilityIntent(question)
    if (!explicitRoute || (!explicitRoute.origin && !explicitRoute.destination)) {
      const criterion = criterionReply(question, memory)
      if (criterion) {
        memory.lastAnswer = criterion
        return { text: criterion, language: 'fr' }
      }
    }
  const lastDeparture = lastDepartureReply(question)
  if (lastDeparture) {
    memory.lastAnswer = lastDeparture
    return { text: lastDeparture, language: 'fr' }
  }
  const alternative = alternativeReply(question, memory)
  if (alternative) {
    memory.lastAnswer = alternative
    return { text: alternative, language: 'fr' }
  }

  // 4b) Hors périmètre assumé : aucune source météo connectée, rien d'inventé.
  if (/meteo|quel temps fera|pleut|pleuvra|pluie|weather|temperature/.test(text)) {
    const weatherText = language === 'wo'
      ? 'Xamuma meteo bi : amul source météo bu lëkkaloo ak application bi. Du ma jum dara.'
      : 'Je n’ai aucune source météo connectée : je ne peux pas donner de prévisions, et je n’en invente pas. Le trafic routier en direct n’est pas disponible non plus : aucune source temps réel n’est intégrée.'
    memory.lastAnswer = weatherText
    return { text: weatherText, language }
  }

  // 5) Le moteur existant couvre le reste (fréquences, listes, trajets,
  //    tarifs, perturbations, état des données) — inchangé.
  const base = answerAssistant(question, context, now)
  const journey = extractJourneyRequest(question)
  memory.lastKnowledgeLineId = null
  const countdownMinutes = getAssistantCountdownMinutes(question, context, now) ?? undefined
  if (journey) {
    const outcome = planReferenceJourney(journey.origin, journey.destination)
    if (outcome.ok) {
      rememberLastJourney(memory, outcome.legs, journey.origin, journey.destination, outcome)
    } else {
      memory.lastOrigin = journey.origin
      memory.lastDestination = journey.destination
    }
  } else {
    const stops = findReferentialStops(question)
    if (stops.length > 0) memory.lastStopId = stops[0].id
  }
  const finalText = language === 'wo' ? woFrenchFallbackPrefix() + base : base
  memory.lastAnswer = finalText
  return {
    text: finalText,
    language,
    ...(journey ? { journey } : {}),
    ...(countdownMinutes === undefined ? {} : { countdownMinutes }),
  }
}

/** Ligne de référence reconnue dans une question (« la B1 », « le TER »…). */
export function lineMentionedIn(question: string): string | null {
  return findReferentialLine(question)?.shortName ?? null
}
