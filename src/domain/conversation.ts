/**
 * Contexte de conversation du copilote.
 *
 * L'usager ne doit pas avoir à répéter son départ ou sa destination à chaque
 * question : les questions de suivi (« et en sens inverse ? », « pourquoi ce
 * trajet ? », « où dois-je descendre ? ») s'appuient sur le dernier échange.
 * Ce module ne devine jamais un lieu : il ne transporte que des lieux déjà
 * explicitement reconnus.
 */

import type { PlannerEndpoint } from './planner'

export interface JourneyMemory {
  origin: PlannerEndpoint
  destination: PlannerEndpoint
  /** Résumé lisible du dernier calcul (étapes), pour expliquer le choix. */
  steps: readonly string[]
  totalMinutes: number | null
  boardedLines: readonly string[]
  transfers: number
  /** Arrêt où descendre sur la dernière jambe en transport, si connu. */
  alightStop: string | null
}

export interface ConversationMemory {
  /** Dernière fiche documentaire bus ; séparée des trajets géographiques. */
  lastKnowledgeLineId?: string | null
  lastOrigin: PlannerEndpoint | null
  lastDestination: PlannerEndpoint | null
  /** Départ déclaré par l'usager (« je suis à … ») : repris pour les demandes qui n'en donnent pas. */
  statedOrigin: PlannerEndpoint | null
  lastJourney: JourneyMemory | null
  lastStopId: string | null
  lastNetwork: 'ter' | 'brt' | 'ddd' | 'aftu' | null
  /** Dernier texte de réponse, pour les questions « qu'est-ce qui est confirmé ? ». */
  lastAnswer: string | null
}

export function createConversationMemory(): ConversationMemory {
  return {
    lastKnowledgeLineId: null,
    lastOrigin: null,
    lastDestination: null,
    statedOrigin: null,
    lastJourney: null,
    lastStopId: null,
    lastNetwork: null,
    lastAnswer: null,
  }
}

export type FollowUpKind = 'reverse' | 'why' | 'alight' | 'confirmed' | 'again' | null

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, ' ')
}

/**
 * Reconnaît une question de suivi qui réutilise le contexte précédent.
 * Retourne null si la question porte sur un sujet autonome.
 */
export function detectFollowUp(question: string): FollowUpKind {
  const text = normalize(question)
  if (!text) return null
  if (/\b(en sens inverse|sens inverse|retour|retourner|revenir|rentrer|le retour|dellu|dellosi|delloo)\b/.test(text)) {
    return 'reverse'
  }
  if (/\b(pourquoi (?:ce |cet |cette )?(?:trajet|itineraire|option|chemin|choix)|pourquoi tu|pourquoi me|raison de|explication|lu tax|loutax)\b/.test(text)) {
    return 'why'
  }
  if (/\b(ou (?:dois(?:[- ]je)?|est[- ]ce que je dois|je descends|faut[- ]il) descendre|descendre ou|mon arret|ou est[- ]ce que je m arrete)\b/.test(text)) {
    return 'alight'
  }
  if (/\b(confirme|confirmees|qu est ce qui est (?:confirme|connu|sur)|informations fiables|donnees fiables|ce qui est vrai|ce que tu sais vraiment)\b/.test(text)) {
    return 'confirmed'
  }
  if (/^(encore|recommence|refais|reponds encore|waxaat|waxaatil)$/.test(text.trim())) {
    return 'again'
  }
  return null
}

/** Applique un suivi « sens inverse » au dernier trajet connu. */
export function reversedJourney(memory: ConversationMemory): { origin: PlannerEndpoint; destination: PlannerEndpoint } | null {
  if (!memory.lastOrigin || !memory.lastDestination) return null
  return { origin: memory.lastDestination, destination: memory.lastOrigin }
}

/** Enregistre un trajet calculé dans la mémoire de conversation. */
export function rememberJourney(
  memory: ConversationMemory,
  journey: JourneyMemory,
): void {
  memory.lastOrigin = journey.origin
  memory.lastDestination = journey.destination
  memory.lastJourney = journey
}
