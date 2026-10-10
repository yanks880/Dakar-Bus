/**
 * Cerveau de l'assistant « mobilité » de Dakar Bus.
 *
 * Ce n'est pas un modèle de langage distant : c'est un moteur local à règles
 * branché sur (1) le réseau de référence TER/BRT (corridors.ts), (2) le
 * calculateur de correspondances (planner.ts) et (3) l'état réel des API
 * locales (publication, alertes). Il répond en langage naturel mais ne
 * fabrique jamais une donnée : ce qu'il ne sait pas, il le dit.
 */

import {
  BRT_STOPS,
  CORRIDOR_NETWORKS,
  TER_STOPS,
  linesServingStop,
  searchCorridorStops,
} from './corridors'
import { NETWORK_REFERENCE_DATA, OFFICIAL_REFERENCE_FREQUENCIES, formatFrequencyPeriod, formatSourceVerification } from './frequencies'
import { answerMobilityKnowledge, busKnowledgeSummary, generalFareReply } from './mobilityKnowledge'
import { referentialKnowledgeSummary } from './referential'
import { getRemainingMinutes } from './truth'
import { formatPassageCountdown } from './headways'
import { describeLeg, formatMeters, planReferenceJourney, type PlannerEndpoint } from './planner'
import { compareReferenceJourneys, PRIORITY_LABELS } from './comparison'
import { departureAdvice, extractMobilityIntent, routePreferencesFrom } from './intent'
import { placeBriefWithQuestion, placeQuestionReply, unroutablePairReply } from './placeMemory'
import { findPlaceMentions, isRouteQuestion, placeEndpoint, resolveJourneyEndpoints, unrecognizedPlaceNote } from './places'
import type { PlannerPriority } from './planner'

export interface AssistantContext {
  /** Un snapshot GTFS est publié et servi par l'API de lecture. */
  publishedAvailable: boolean
  /** L'API d'administration locale répond. */
  adminOnline: boolean
  /** Position explicite de l'usager (géolocalisation autorisée), jamais déduite. */
  userLocation?: { lat: number; lon: number; accuracyM?: number } | null
  /** Départ exact issu d'un horaire GTFS publié ; absent pour les seules fréquences de référence. */
  nextDepartureAt?: {
    network: 'brt' | 'ter'
    status: 'SCHEDULED'
    nextDepartureAt: string
    /** Provenance text for an exact trip selected from the published schedule. */
    routeDescription?: string
  } | null
}

export interface AssistantMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** Only set for a valid, positive countdown calculated from a scheduled departure. */
  countdownMinutes?: number
  journey?: { origin: PlannerEndpoint; destination: PlannerEndpoint }
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

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function requestedFrequencyNetwork(text: string): 'brt' | 'ter' | null {
  const wantsBrt = includesAny(text, ['brt', 'b1', 'b2', 'b3', 'sunubrt', 'bus rapide'])
  const wantsTer = includesAny(text, ['ter', 'train', 'gare', 'express regional'])
  if (wantsBrt === wantsTer) return null
  return wantsBrt ? 'brt' : 'ter'
}

/** Countdown only when an exact scheduled departure was supplied by the caller. */
function scheduledRouteDescription(context: AssistantContext): string | null {
  const description = context.nextDepartureAt?.routeDescription?.trim()
  return description || null
}

export function getAssistantCountdownMinutes(question: string, context: AssistantContext, now = Date.now()): number | null {
  const text = normalize(question)
  if (!includesAny(text, ['dans combien', 'combien de temps', 'arrive', 'arriver', 'prochain', 'prochaine'])) return null
  const requestedNetwork = requestedFrequencyNetwork(text)
  const scheduled = context.nextDepartureAt
  if (!requestedNetwork || !scheduled || scheduled.network !== requestedNetwork || scheduled.status !== 'SCHEDULED') return null
  return getRemainingMinutes(scheduled.nextDepartureAt, now)
}

function officialFrequencyAnswer(network: 'brt' | 'ter'): string {
  const reference = NETWORK_REFERENCE_DATA[network]
  const source = network === 'brt' ? 'CETUD / SunuBRT' : 'TER / SETER'
  const verification = formatSourceVerification(reference.source)
  const information = reference.officialFrequencies.map(formatFrequencyPeriod).join('; ')
  if (network === 'brt') {
    const frequency = reference.officialFrequencies[0]
    return `Le BRT circule selon une fréquence officielle de référence de ${frequency.headwayMinutes} minutes entre ${frequency.serviceStart} et ${frequency.serviceEnd}. Source : ${source} (${reference.source.sourceUrl}). ${verification}. Cette information décrit une fréquence de service de référence, pas la position en temps réel d’un bus.`
  }
  return `Le TER fonctionne selon des fréquences officielles de référence selon la période : ${information}. Source : ${source} (${reference.source.sourceUrl}). ${verification}. Il ne s’agit pas d’une information temps réel.`
}

function noReliableDepartureAnswer(network: 'brt' | 'ter'): string {
  const reference = NETWORK_REFERENCE_DATA[network]
  const source = network === 'brt' ? 'CETUD / SunuBRT' : 'TER / SETER'
  const verification = formatSourceVerification(reference.source)
  const frequency = network === 'brt'
    ? 'la fréquence officielle de référence du BRT (6 minutes)'
    : 'les fréquences officielles de référence du TER, qui varient selon la période'
  return `Je connais ${frequency}, mais je ne dispose actuellement d’aucune heure de prochain passage fiable. Source : ${source} (${reference.source.sourceUrl}). ${verification}. Une fréquence seule ne permet pas de déduire un départ imminent.`
}

const OFFICIAL_CHANNELS =
  'Canaux officiels d’information voyageurs : Sen TER (sentersa.sn, centre d’appels SETER), SunuBRT (sunubrt.sn, Dakar Mobilité) et le CETUD (cetud.sn). Aucune de ces sources n’est connectée en temps réel à cette application pour l’instant.'

/** Réponses communes au calcul d'itinéraire, quelle que soit la formulation. */
const CHEAPEST_REPLY =
  'Je ne peux pas classer les trajets par prix : les tarifs complets et vérifiés TER/BRT ne sont pas disponibles ici. Je peux comparer la durée, la marche ou les correspondances, pas inventer un coût.'
const INVALID_ARRIVAL_REPLY =
  'Heure d’arrivée invalide : indiquez une heure de Dakar au format « avant 9 h » ou « avant 09:30 ». Aucun départ ne peut être conseillé sans heure valide.'

const HONEST_LIMIT =
  'Je raisonne sur les références officielles TER/BRT et les horaires GTFS publiés lorsqu’ils existent : aucune position de véhicule ni donnée temps réel. Pour DDD et AFTU, je consulte aussi des fiches de lignes et des points de passage textuels sourcés ; les fréquences par ligne et les correspondances bus ne sont pas validées.'

/** Extrait un couple (origine, destination) sans inférer une position actuelle. */
export function extractJourneyRequest(question: string): { origin: PlannerEndpoint; destination: PlannerEndpoint } | null {
  const intent = extractMobilityIntent(question)
  if (intent?.origin && intent.destination) return { origin: intent.origin, destination: intent.destination }
  // Deux lieux calculables suffisent, même sans verbe de déplacement.
  const resolved = resolveJourneyEndpoints(question)
  const origin = resolved?.origin ? placeEndpoint(resolved.origin) : null
  const destination = resolved?.destination ? placeEndpoint(resolved.destination) : null
  return origin && destination ? { origin, destination } : null
}

export interface JourneyReplyOptions {
  priority: PlannerPriority
  compare: boolean
  /** Minutes après minuit (heure de Dakar) ; null si aucune heure demandée. */
  arrivalMinutes: number | null
  tomorrow: boolean
  now: number
}

/**
 * Itinéraire calculé, partagé par le moteur de réponses et le copilote : une
 * seule composition pour un même calcul, qu'il vienne d'une phrase libre, d'un
 * suivi de conversation ou de la mémoire des lieux.
 */
export function journeyReply(
  origin: PlannerEndpoint,
  destination: PlannerEndpoint,
  options: JourneyReplyOptions,
): string {
  const { priority, compare, arrivalMinutes, tomorrow, now } = options
  if (compare || priority !== 'fastest') {
    const comparison = compareReferenceJourneys(origin, destination)
    if (!comparison.ok) return comparison.message
    const chosen = comparison.options.find((option) => option.priority === comparison.bestBy[priority])!
    const alternatives = comparison.options.map((option, index) =>
      `• Option ${index + 1} (${option.result.boardedLines.join(' + ') || 'à pied'}) : environ ${option.result.totalMinutes} min, ${formatMeters(option.result.totalWalkM)} de marche, ${option.result.transfers} correspondance(s).`).join('\n')
    const advice = arrivalMinutes === null ? '' : `\n${departureAdvice(arrivalMinutes, chosen.result.totalMinutes, now, tomorrow)}`
    return `Copilote · ${origin.label} → ${destination.label}. ${PRIORITY_LABELS[priority]} : option ${comparison.options.indexOf(chosen) + 1}.\n${alternatives}\n${comparison.options.length === 1 ? 'Une seule option distincte est calculable. ' : ''}Classement parmi ces options calculées. Données : réseau de référence TER/BRT, marche et attente estimées, sans horaires de passage ni temps réel. Tarif non comparable (données insuffisantes).${advice} Ouvrez Trajet pour voir le détail et comparer les options.`
  }
  const outcome = planReferenceJourney(origin, destination)
  if (!outcome.ok) return outcome.message
  const steps = outcome.legs.map((leg) => `• ${describeLeg(leg)}`).join('\n')
  const advice = arrivalMinutes === null ? '' : `\n${departureAdvice(arrivalMinutes, outcome.totalMinutes, now, tomorrow)}`
  return `Itinéraire de référence ${origin.label} → ${destination.label} — environ ${outcome.totalMinutes} min, ${outcome.transfers} correspondance${outcome.transfers > 1 ? 's' : ''}, ${formatMeters(outcome.totalWalkM)} de marche :\n${steps}\n${outcome.limitation}${advice}`
}

export function answerAssistant(question: string, context: AssistantContext, now = Date.now()): string {
  const text = normalize(question)
  if (!text) return 'Posez-moi une question sur les transports de Dakar : arrêts BRT, gares TER, itinéraires, fréquences ou perturbations.'

  const knowledge = answerMobilityKnowledge(question)
  if (knowledge) return knowledge.text

  // La mémoire embarquée reste consultable sans API ni fichier GTFS.
  if (includesAny(text, ['memoire', 'base de connaissances', 'quels reseaux', 'toutes les mobilites'])) {
    return `Ma base de connaissances est embarquée : aucun import GTFS n’est nécessaire pour la consulter.\n${referentialKnowledgeSummary()}\n${busKnowledgeSummary()}`
  }


  // 1) Salutations et aide. Une salutation qui porte une demande réelle
  //    (« bonjour, je suis à Rufisque… ») est traitée comme une demande.
  const greeted = /^(bonjour|bonsoir|salut|coucou|bonjour dakarbus)/.test(text)
  if ((greeted && !isRouteQuestion(question) && findPlaceMentions(question).length === 0) || text.length <= 3) {
    return `Bonjour ! Décrivez votre déplacement comme vous le parlez — « je suis à Keur Mbaye Fall, comment aller à Dakar ? » — : je repère vos lieux, je choisis le mode le plus adapté (TER, BRT, lignes DDD/AFTU documentées) et je calcule l’itinéraire avec les correspondances. Je connais les 23 stations du BRT, les 13 gares du TER et les fiches de lignes DDD/AFTU. ${HONEST_LIMIT}`
  }
  if (includesAny(text, ['aide', 'qui es tu', 'que sais tu', 'capable', 'comment ca marche'])) {
    return `Je peux :
• Comprendre une phrase libre (« je suis à Parcelles Assainies, je voudrais aller à Diamniadio ») et en déduire départ, destination et itinéraire ;
• Lister les 23 stations BRT ou les 13 gares TER (« liste des stations BRT ») ;
• Dire si un lieu est desservi, par quel mode et avec quelles correspondances (« Parcelles Assainies », « Rufisque ») ;
• Calculer un itinéraire multimodal (« trajet de Petersen à Rufisque ») ;
• Comparer durée, marche ou correspondances (« compare les trajets de Guédiawaye à Rufisque, moins de marche »), estimer un départ pour une heure d’arrivée sans garantir le service ;
• Donner les fréquences et tarifs de référence publiés ;
• Faire le point honnêtement sur les perturbations et l’état des données.
${HONEST_LIMIT}`
  }

  // 2) Langage naturel : intention de déplacement puis calculateur de référence.
  const intent = extractMobilityIntent(question)
  if (intent) {
    if (!intent.originPlace && !intent.destinationPlace) {
      const unknown = unrecognizedPlaceNote(question)
      const recall = 'Donnez-moi un lieu déclaré — « je suis à Keur Mbaye Fall, je vais à Dakar » — : je préfère le dire plutôt qu’inventer un trajet.'
      return unknown
        ? `${unknown} ${recall}`
        : `Ni votre départ ni votre destination ne sont reconnus dans la mémoire des lieux (13 gares TER, 23 stations BRT et les lieux des fiches DDD/AFTU). ${recall}`
    }
    if (intent.priority === 'cheapest') return CHEAPEST_REPLY
    if (intent.arrivalRequested && intent.arrivalMinutes === null) return INVALID_ARRIVAL_REPLY
    if (intent.origin && intent.destination) {
      return journeyReply(intent.origin, intent.destination, {
        priority: intent.priority,
        compare: intent.compare,
        arrivalMinutes: intent.arrivalMinutes,
        tomorrow: intent.tomorrow,
        now,
      })
    }
    // Un lieu cité et inconnu est nommé : l'usager l'a écrit, la réponse le
    // reprend au lieu de l'ignorer.
    const unknown = unrecognizedPlaceNote(question)
    // Deux lieux reconnus mais au moins un non calculable (fiche bus) : tout
    // ce qui est documenté est donné, rien n'est complété à la place de
    // l'opérateur.
    if (intent.originPlace && intent.destinationPlace) {
      const pair = unroutablePairReply(intent.originPlace, intent.destinationPlace)
      return unknown ? `${unknown}\n${pair}` : pair
    }
    // Un seul lieu : la fiche du lieu d'abord — avec un itinéraire réellement
    // calculé depuis le pôle central — puis une question courte. Jamais une
    // phrase toute faite qui ignorerait ce que l'usager vient d'écrire.
    const known = intent.destinationPlace ?? intent.originPlace!
    const missing = intent.destinationPlace ? 'origin' : 'destination'
    const brief = placeBriefWithQuestion(known, missing, { arrivalRequested: intent.arrivalRequested })
    return unknown ? `${unknown}\n${brief}` : brief
  }

  // 3) Prochain départ / fréquence officielle de référence.
  const wantsBrt = includesAny(text, ['brt', 'b1', 'b2', 'b3', 'sunubrt', 'bus rapide'])
  const wantsTer = includesAny(text, ['ter', 'train', 'gare', 'express regional'])
  const asksFrequency = includesAny(text, ['prochain', 'prochaine', 'bientot', 'attente', 'frequence', 'passage', 'passe', 'cadence', 'dans combien', 'combien de temps', 'arrive'])
  if (asksFrequency) {
    const destinationStops = searchCorridorStops(question.replace(/.*?(vers|pour|a|à|jusqu'a|jusqu à)\s+/i, ''))
    const target = destinationStops[0]
    const serving = target ? linesServingStop(target.id) : []
    const targetLine = target && serving.length > 0 ? `${target.name} est desservi par ${serving.map((line) => line.shortName).join(' et ')}. ` : ''
    const requestedNetwork = requestedFrequencyNetwork(text)
    const unknownFrequencyNetwork = includesAny(text, ['ddd', 'dakar dem dikk'])
      ? NETWORK_REFERENCE_DATA.ddd
      : includesAny(text, ['aftu']) ? NETWORK_REFERENCE_DATA.aftu : null
    if (unknownFrequencyNetwork) {
      const counts = unknownFrequencyNetwork.id === 'ddd'
        ? `${unknownFrequencyNetwork.lineCount} lignes et ${unknownFrequencyNetwork.vehicleCount} bus`
        : `${unknownFrequencyNetwork.lineCount} lignes, ${unknownFrequencyNetwork.vehicleCount?.toLocaleString('fr-FR')} bus et ${unknownFrequencyNetwork.gieCount} GIE`
      return `${unknownFrequencyNetwork.operator} : ${counts}, service ${unknownFrequencyNetwork.serviceStart}–${unknownFrequencyNetwork.serviceEnd}. ${unknownFrequencyNetwork.frequencyLabel}. Aucun prochain départ fiable ou horaire par ligne n’est disponible : je ne peux pas donner de compte à rebours. Source : CETUD (${unknownFrequencyNetwork.source.sourceUrl}). ${formatSourceVerification(unknownFrequencyNetwork.source)}.`
    }
    if (requestedNetwork) {
      const wantsNext = includesAny(text, ['prochain', 'prochaine', 'dans combien', 'combien de temps', 'arrive', 'arriver', 'attente'])
      if (wantsNext) {
        const minutes = getAssistantCountdownMinutes(question, context, now)
        if (minutes !== null) {
          const label = requestedNetwork === 'brt' ? 'BRT' : 'TER'
          const departure = scheduledRouteDescription(context)
          const trip = departure ? `La course ${departure} est programmée` : `Le prochain ${label} est prévu`
          return `${targetLine}${trip} dans ${formatPassageCountdown(minutes)} selon un horaire théorique déclaré. Ce n’est pas une information temps réel.`
        }
        return `${targetLine}${noReliableDepartureAnswer(requestedNetwork)}`
      }
      return `${targetLine}${officialFrequencyAnswer(requestedNetwork)}`
    }

    const frequencies = [
      officialFrequencyAnswer('brt'),
      officialFrequencyAnswer('ter'),
    ].join('\n')
    const ddd = NETWORK_REFERENCE_DATA.ddd
    const aftu = NETWORK_REFERENCE_DATA.aftu
    const unknownFrequencyNetworks = [
      `• DDD : ${ddd.lineCount} lignes, ${ddd.vehicleCount} bus, ${ddd.serviceStart}–${ddd.serviceEnd} ; fréquences non publiées ligne par ligne. Source CETUD (${ddd.source.sourceUrl}) · ${formatSourceVerification(ddd.source)}.`,
      `• AFTU : ${aftu.lineCount} lignes, ${aftu.vehicleCount?.toLocaleString('fr-FR')} bus, ${aftu.gieCount} GIE, ${aftu.serviceStart}–${aftu.serviceEnd} ; fréquences non publiées ligne par ligne. Source CETUD (${aftu.source.sourceUrl}) · ${formatSourceVerification(aftu.source)}.`,
    ].join('\n')
    return `${frequencies}\n${unknownFrequencyNetworks}\nAucune heure de prochain passage n’est disponible sans horaire fiable.`
  }

  // 4) Desserte d'un lieu.
  const desserte = /(?:est[- ]ce que|va[- ]t[- ]il|dessert|passe[- ]t[- ]il|s?arr[eê]te).*/.test(text) || includesAny(text, ['va a ', 'aller a ', 'jusqu a '])
  if (desserte) {
    const stops = searchCorridorStops(question)
    if (stops.length > 0) {
      const stop = stops[0]
      const lines = linesServingStop(stop.id)
      return `${stop.name} est desservi par ${lines.map((line) => `${line.shortName} (${CORRIDOR_NETWORKS[line.network].label})`).join(', ')}${stop.note ? ` — ${stop.note}` : ''}. Position et correspondances sont visibles sur l’onglet Explorer (couche « Réseau de référence »).`
    }
    return 'Ce lieu n’est ni une gare TER ni une station BRT du réseau de référence. Les fiches documentaires DDD/AFTU ne permettent pas de garantir ici un arrêt ni une fréquence par ligne ; je préfère le dire plutôt que deviner.'
  }

  // 5) Listes et comptes.
  if (includesAny(text, ['liste', 'quelles sont', 'quels sont', 'combien', 'enumerer', 'toutes les stations', 'toutes les gares'])) {
    if (wantsBrt && !wantsTer) {
      return `Les 23 stations du BRT, de Petersen à la Préfecture de Guédiawaye :
${BRT_STOPS.map((stop, index) => `${index + 1}. ${stop.name}`).join('\n')}
(Séquence de référence B1 ; le projet consigne des coordonnées liées aux nœuds OpenStreetMap, sans date de vérification externe documentée ; corridor de 18,3 km.)`
    }
    if (includesAny(text, ['ddd', 'dakar dem dikk'])) {
      const reference = NETWORK_REFERENCE_DATA.ddd
      return `${reference.operator} (${reference.shortName}) : ${reference.lineCount} lignes, ${reference.vehicleCount} bus, service ${reference.serviceStart}–${reference.serviceEnd}. ${reference.frequencyLabel} : aucune fréquence uniforme n’est attribuée aux lignes. Source : CETUD (${reference.source.sourceUrl}). ${formatSourceVerification(reference.source)}.`
    }
    if (includesAny(text, ['aftu'])) {
      const reference = NETWORK_REFERENCE_DATA.aftu
      return `${reference.operator} : ${reference.lineCount} lignes, ${reference.vehicleCount?.toLocaleString('fr-FR')} bus, ${reference.gieCount} GIE, service ${reference.serviceStart}–${reference.serviceEnd}. ${reference.frequencyLabel} : aucune fréquence uniforme n’est attribuée aux lignes. Source : CETUD (${reference.source.sourceUrl}). ${formatSourceVerification(reference.source)}.`
    }
    if (wantsTer && !wantsBrt) {
      return `Les 13 gares et haltes du TER, de Dakar à Diamniadio :
${TER_STOPS.map((stop, index) => `${index + 1}. ${stop.name}${stop.note ? ` — ${stop.note}` : ''}`).join('\n')}
Fréquences officielles de référence : ${OFFICIAL_REFERENCE_FREQUENCIES.ter.map(formatFrequencyPeriod).join('; ')}. Source : TER / SETER (${NETWORK_REFERENCE_DATA.ter.source.sourceUrl}). ${formatSourceVerification(NETWORK_REFERENCE_DATA.ter.source)}.`
    }
    return `Le réseau de référence couvre :
• TER — ${TER_STOPS.length} gares, Dakar ↔ Diamniadio (${CORRIDOR_NETWORKS.ter.operator}) ;
• BRT — ${BRT_STOPS.length} stations, Petersen ↔ Préfecture de Guédiawaye (${CORRIDOR_NETWORKS.brt.operator}).
Demandez-moi « liste des stations BRT » ou « liste des gares TER » pour le détail.`
  }

  // 6) Tarifs de référence.
  if (includesAny(text, ['tarif', 'prix', 'ticket', 'combien coute', 'payer', 'carte sama'])) {
    return generalFareReply()
  }

  // 7) Horaires / amplitude.
  if (includesAny(text, ['horaire', 'heure', 'ouvre', 'ferme', 'amplitude', 'matin', 'soir', 'nuit'])) {
    return `Amplitudes et fréquences officielles de référence :
• BRT : 06:00–21:00, fréquence de référence de 6 min ; source CETUD / SunuBRT (${NETWORK_REFERENCE_DATA.brt.source.sourceUrl}). ${formatSourceVerification(NETWORK_REFERENCE_DATA.brt.source)}.
• TER : ${OFFICIAL_REFERENCE_FREQUENCIES.ter.map(formatFrequencyPeriod).join('; ')} ; source TER / SETER (${NETWORK_REFERENCE_DATA.ter.source.sourceUrl}). ${formatSourceVerification(NETWORK_REFERENCE_DATA.ter.source)}.
Une fréquence ne donne pas l’heure du prochain passage : aucun départ individuel ni temps réel n’est déduit de ces références.`
  }

  // 8) Perturbations / alertes.
  if (includesAny(text, ['perturbation', 'panne', 'greve', 'greve', 'retard', 'probleme', 'incident', 'alerte', 'information trafic', 'trafic'])) {
    return `Je n’ai aucune alerte vérifiable à afficher : aucune source de perturbation n’est connectée, et l’absence d’alerte ne signifie pas que le service est normal. ${OFFICIAL_CHANNELS}${context.adminOnline ? ' L’API de gouvernance locale est joignable, mais elle ne transporte pas encore de flux d’alertes.' : ''}`
  }

  // 9) État des données / gouvernance.
  if (includesAny(text, ['donnees', 'source', 'publie', 'publication', 'gouvernance', 'snapshot', 'api'])) {
    return `État réel du système : ${context.publishedAvailable ? 'un snapshot GTFS est publié et servi par l’API de lecture.' : 'aucun snapshot GTFS n’est publié : les API répondent NOT_PUBLISHED pour les données de transport.'} ${context.adminOnline ? 'L’API de gouvernance locale est en ligne (onglet Paramètres, console technique).' : 'L’API de gouvernance locale ne répond pas : démarrez-la avec npm run admin:api.'} Le réseau de référence TER/BRT affiché dans l’onglet Explorer est une couche distincte, clairement étiquetée, issue de sources publiques (Sen TER, CETUD/SunuBRT, OpenStreetMap) — pas un flux opérateur validé.`
  }

  // 10) Mémoire des lieux : un lieu cité reçoit une fiche complète (mode le
  //     plus adapté, correspondances, itinéraire calculé depuis le pôle
  //     central), sans redemander ce que le message a déjà dit.
  const mentions = findPlaceMentions(question)
  if (mentions.length > 0) {
    const resolved = resolveJourneyEndpoints(question)
    const origin = resolved?.origin ? placeEndpoint(resolved.origin) : null
    const destination = resolved?.destination ? placeEndpoint(resolved.destination) : null
    if (origin && destination) {
      // Deux lieux calculables : l'itinéraire est proposé directement, même
      // sans verbe de déplacement (« Keur Mbaye Fall Dakar »), avec les mêmes
      // critères que pour une phrase complète.
      const preferences = routePreferencesFrom(question)
      if (preferences.priority === 'cheapest') return CHEAPEST_REPLY
      if (preferences.arrivalRequested && preferences.arrivalMinutes === null) return INVALID_ARRIVAL_REPLY
      return journeyReply(origin, destination, {
        priority: preferences.priority,
        compare: preferences.compare,
        arrivalMinutes: preferences.arrivalMinutes,
        tomorrow: preferences.tomorrow,
        now,
      })
    }
    if (resolved?.origin && resolved?.destination) {
      return unroutablePairReply(resolved.origin, resolved.destination)
    }
    const missing = resolved?.destination ? 'origin' : resolved?.origin ? 'destination' : null
    return placeQuestionReply(mentions[0].place, missing)
  }

  // 11) Recherche d'arrêt simple.
  const stops = searchCorridorStops(question)
  if (stops.length > 0) {
    const stop = stops[0]
    const lines = linesServingStop(stop.id)
    const network = CORRIDOR_NETWORKS[lines[0]?.network ?? (stop.id.startsWith('ter') ? 'ter' : 'brt')]
    return `${stop.name} — ${network.label}, ${network.operator}. Desservi par ${lines.map((line) => line.shortName).join(', ') || 'aucune ligne de référence'}. ${stop.note ? `${stop.note}. ` : ''}Demandez « je suis à … , je vais vers ${stop.name} » pour un itinéraire multimodal.`
  }

  return `Je n’ai pas reconnu cette demande dans mes données de référence — et je préfère le dire plutôt que d’inventer. ${HONEST_LIMIT} Parlez-moi comme à un guichetier : « je suis à Keur Mbaye Fall, comment aller à Dakar ? », « liste des stations BRT », « le TER va-t-il à Rufisque ? ».`
}
