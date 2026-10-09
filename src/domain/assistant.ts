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
import { getRemainingMinutes } from './truth'
import { formatPassageCountdown } from './headways'
import { describeLeg, formatMeters, planReferenceJourney, type PlannerEndpoint } from './planner'

export interface AssistantContext {
  /** Un snapshot GTFS est publié et servi par l'API de lecture. */
  publishedAvailable: boolean
  /** L'API d'administration locale répond. */
  adminOnline: boolean
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

const HONEST_LIMIT =
  'Je raisonne sur les références officielles TER/BRT et les horaires GTFS publiés lorsqu’ils existent : aucune position de véhicule ni donnée temps réel. Pour DDD et AFTU, le catalogue ne contient que des repères de réseau ; aucune fréquence par ligne n’est disponible.'

/** Extrait un couple (origine, destination) d'une question d'itinéraire. */
export function extractJourneyRequest(question: string): { origin: PlannerEndpoint; destination: PlannerEndpoint } | null {
  const match =
    /(?:comment\s+(?:aller|se rendre|je vais)|itin[eé]raire|trajet|aller|voyage)\D*(?:de|depuis|entre)\s+([a-zà-ÿ0-9’' .-]{2,40}?)\s+(?:[àa]|vers|jusqu ?[àa]|pour aller [àa])\s+([a-zà-ÿ0-9’' .-]{2,40})/i.exec(
      question,
    )
  if (!match) return null
  const [, originText, destinationText] = match
  const originStops = searchCorridorStops(originText.trim())
  const destinationStops = searchCorridorStops(destinationText.trim())
  if (originStops.length === 0 || destinationStops.length === 0) return null
  const originStop = originStops[0]
  const destinationStop = destinationStops[0]
  return {
    origin: { label: originStop.name, lat: originStop.lat, lon: originStop.lon, stopId: originStop.id },
    destination: { label: destinationStop.name, lat: destinationStop.lat, lon: destinationStop.lon, stopId: destinationStop.id },
  }
}

export function answerAssistant(question: string, context: AssistantContext, now = Date.now()): string {
  const text = normalize(question)
  if (!text) return 'Posez-moi une question sur les transports de Dakar : arrêts BRT, gares TER, itinéraires, fréquences ou perturbations.'

  // 1) Salutations et aide.
  if (/^(bonjour|bonsoir|salut|coucou|bonjour dakarbus)/.test(text) || text.length <= 3) {
    return `Bonjour ! Je suis l’assistant mobilité de Dakar Bus. Je connais les 23 stations du BRT et les 13 gares du TER, je peux proposer un itinéraire multimodal (TER + BRT avec correspondances) et vous renseigner sur les fréquences. ${HONEST_LIMIT}`
  }
  if (includesAny(text, ['aide', 'qui es tu', 'que sais tu', 'capable', 'comment ca marche'])) {
    return `Je peux :
• Lister les 23 stations BRT ou les 13 gares TER (« liste des stations BRT ») ;
• Dire si un lieu est desservi (« le BRT va-t-il à Guédiawaye ? ») ;
• Calculer un itinéraire multimodal (« trajet de Petersen à Rufisque ») ;
• Donner les fréquences et tarifs de référence publiés ;
• Faire le point honnêtement sur les perturbations et l’état des données.
${HONEST_LIMIT}`
  }

  // 2) Itinéraire A → B via le calculateur de correspondances.
  const journey = extractJourneyRequest(question)
  if (journey) {
    const outcome = planReferenceJourney(journey.origin, journey.destination)
    if (!outcome.ok) return outcome.message
    const steps = outcome.legs.map((leg) => `• ${describeLeg(leg)}`).join('\n')
    return `Itinéraire de référence ${journey.origin.label} → ${journey.destination.label} — environ ${outcome.totalMinutes} min, ${outcome.transfers} correspondance${outcome.transfers > 1 ? 's' : ''}, ${formatMeters(outcome.totalWalkM)} de marche :
${steps}
${outcome.limitation}`
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
    return 'Ce lieu n’est ni une gare TER ni une station BRT du réseau de référence. Le catalogue DDD/AFTU ne contient pas d’arrêts ni de fréquences par ligne vérifiés ; je préfère le dire plutôt que deviner.'
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
    return `Tarifs de référence publiés (Sen TER / presse, à confirmer auprès de l’opérateur) :
• TER : Dakar–Thiaroye 500 F, Dakar–Rufisque 1 000 F, Dakar–Diamniadio 1 500 F, 1re classe 2 500 F (carte Sama TER) ; ticket dès 300 F selon la zone.
• BRT : aucun tarif fiable n’est documenté dans mes sources de référence : je ne l’invente pas — consultez sunubrt.sn.
Ce ne sont pas des données publiées par le pipeline de gouvernance de l’application.`
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

  // 10) Recherche d'arrêt simple.
  const stops = searchCorridorStops(question)
  if (stops.length > 0) {
    const stop = stops[0]
    const lines = linesServingStop(stop.id)
    const network = CORRIDOR_NETWORKS[lines[0]?.network ?? (stop.id.startsWith('ter') ? 'ter' : 'brt')]
    return `${stop.name} — ${network.label}, ${network.operator}. Desservi par ${lines.map((line) => line.shortName).join(', ') || 'aucune ligne de référence'}. ${stop.note ? `${stop.note}. ` : ''}Demandez « trajet de … vers ${stop.name} » pour un itinéraire multimodal.`
  }

  return `Je n’ai pas reconnu cette demande dans mes données de référence — et je préfère le dire plutôt que d’inventer. ${HONEST_LIMIT} Essayez : « liste des stations BRT », « le TER va-t-il à Rufisque ? », « trajet de Guédiawaye à Diamniadio ».`
}
