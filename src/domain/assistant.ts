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
  CORRIDOR_LINES,
  CORRIDOR_NETWORKS,
  TER_STOPS,
  linesServingStop,
  searchCorridorStops,
} from './corridors'
import { describeLeg, formatMeters, planReferenceJourney, type PlannerEndpoint } from './planner'

export interface AssistantContext {
  /** Un snapshot GTFS est publié et servi par l'API de lecture. */
  publishedAvailable: boolean
  /** L'API d'administration locale répond. */
  adminOnline: boolean
}

export interface AssistantMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
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

const OFFICIAL_CHANNELS =
  'Canaux officiels d’information voyageurs : Sen TER (sentersa.sn, centre d’appels SETER), SunuBRT (sunubrt.sn, Dakar Mobilité) et le CETUD (cetud.sn). Aucune de ces sources n’est connectée en temps réel à cette application pour l’instant.'

const HONEST_LIMIT =
  'Je raisonne sur le réseau de référence (13 gares TER, 23 stations BRT) et sur les fréquences annoncées publiquement : pas de temps réel, pas de positions de véhicules, pas de réseaux DDD/AFTU/TATA (aucune donnée vérifiée).'

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

export function answerAssistant(question: string, context: AssistantContext): string {
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

  // 3) Prochain départ / fréquences.
  const wantsBrt = includesAny(text, ['brt', 'b1', 'b2', 'b3', 'sunubrt', 'bus rapide'])
  const wantsTer = includesAny(text, ['ter', 'train', 'gare', 'express regional'])
  if (includesAny(text, ['prochain', 'prochaine', 'bientot', 'attente', 'frequence', 'passage', 'cadence'])) {
    const destinationStops = searchCorridorStops(question.replace(/.*?(vers|pour|a|à|jusqu'a|jusqu à)\s+/i, ''))
    const target = destinationStops[0]
    const serving = target ? linesServingStop(target.id) : []
    const lines = serving.length > 0 ? serving : CORRIDOR_LINES
    const detail = lines
      .map((line) => `• ${line.shortName} (${line.longName}) : ${line.serviceWindow}.`)
      .join('\n')
    const targetLine = target && serving.length > 0 ? `${target.name} est desservi par ${serving.map((line) => line.shortName).join(' et ')}. ` : ''
    const published = context.publishedAvailable
      ? ' Un snapshot GTFS est publié : l’onglet Trajet calcule aussi les courses directes déclarées.'
      : ' Aucun horaire publié n’est servi par l’API pour l’instant : je donne les fréquences de référence, jamais une heure de passage inventée.'
    return `${targetLine}Fréquences annoncées publiquement :
${detail}
${published}${published ? '' : ' '}`.trim()
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
    return 'Ce lieu n’est ni une gare TER ni une station BRT du réseau de référence. Les réseaux DDD, AFTU et TATA n’ont pas encore de données vérifiées : je préfère le dire plutôt que deviner.'
  }

  // 5) Listes et comptes.
  if (includesAny(text, ['liste', 'quelles sont', 'quels sont', 'combien', 'enumerer', 'toutes les stations', 'toutes les gares'])) {
    if (wantsBrt && !wantsTer) {
      return `Les 23 stations du BRT, de Petersen à la Préfecture de Guédiawaye :
${BRT_STOPS.map((stop, index) => `${index + 1}. ${stop.name}`).join('\n')}
(Séquence officielle ; positions exactes des nœuds OpenStreetMap de la ligne B1, relevées le 8 octobre 2026 ; corridor de 18,3 km.)`
    }
    if (wantsTer && !wantsBrt) {
      return `Les 13 gares et haltes du TER, de Dakar à Diamniadio :
${TER_STOPS.map((stop, index) => `${index + 1}. ${stop.name}${stop.note ? ` — ${stop.note}` : ''}`).join('\n')}
(Source : plan de transport Sen TER ; 36 km, fréquence annoncée de 10 à 20 min.)`
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
    return `Amplitudes et fréquences annoncées publiquement :
• BRT : 6 h – 21 h, passage toutes les 6 min environ ;
• TER : fréquence de 10 à 20 min selon l’heure ; première gare Dakar, terminus Diamniadio (l’aéroport AIBD n’est pas encore desservi, phase 2 annoncée).
Aucun horaire minuté n’est publié ici : pas de temps réel, pas d’estimation de passage inventée.`
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
