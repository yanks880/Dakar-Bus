import { describe, expect, it } from 'vitest'
import type { AssistantContext } from './assistant'
import { copilotAnswer } from './copilot'
import { createConversationMemory } from './conversation'
import { WOLOF_VALIDATION_NOTE } from './wolof'

const CONTEXT: AssistantContext = { publishedAvailable: false, adminOnline: false }
const NOW = Date.parse('2026-10-10T07:30:00Z')

function ask(question: string, options?: { context?: AssistantContext; preference?: 'auto' | 'fr' | 'wo' }) {
  const memory = createConversationMemory()
  return { reply: copilotAnswer(question, options?.context ?? CONTEXT, memory, options?.preference ?? 'auto', NOW), memory }
}

describe('copilote : questions libres fondées sur les données', () => {
  it('répond à une demande de trajet formulée naturellement et mémorise le trajet', () => {
    const { reply, memory } = ask('Comment aller de Petersen à Rufisque ?')
    expect(reply.text).toContain('Petersen')
    expect(reply.text).toContain('Rufisque')
    expect(reply.journey?.origin.stopId).toBe('brt-petersen')
    expect(reply.journey?.destination.stopId).toBe('ter-rufisque')
    expect(memory.lastJourney).not.toBeNull()
  })

  it('répond au suivi « en sens inverse » sans faire répéter les lieux', () => {
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Petersen à Rufisque', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Et en sens inverse ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.journey?.origin.stopId).toBe('ter-rufisque')
    expect(reply.journey?.destination.stopId).toBe('brt-petersen')
    expect(reply.text).toContain('Trajet retour')
  })

  it('sans trajet en mémoire, le suivi le dit au lieu d’inventer', () => {
    const { reply } = ask('Et en sens inverse ?')
    expect(reply.text).toContain('pas encore de trajet en mémoire')
    expect(reply.journey).toBeUndefined()
  })

  it('explique pourquoi un trajet est proposé (méthode, hypothèses, statut ESTIMATED)', () => {
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Guédiawaye à Diamniadio', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Pourquoi ce trajet ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('Pourquoi ce trajet')
    expect(reply.text).toContain('ESTIMATED')
    expect(reply.text).toContain('fréquence officielle de référence')
  })

  it('dit où descendre d’après le dernier calcul', () => {
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Petersen à Rufisque', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Où dois-je descendre ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('Descendez à')
  })

  it('trouve la station la plus proche quand la position est connue, sinon demande la localisation', () => {
    const located = ask('Où se trouve la station la plus proche ?', {
      context: { ...CONTEXT, userLocation: { lat: 14.7719, lon: -17.3868, accuracyM: 20 } },
    })
    expect(located.reply.text).toContain('Préfecture de Guédiawaye')
    expect(located.reply.text).toContain('environ')
    const unlocated = ask('Où se trouve la station la plus proche ?')
    expect(unlocated.reply.text).toContain('géolocalisation')
    expect(unlocated.reply.text).not.toContain('est à')
  })

  it('donne le numéro de la ligne qui dessert une destination connue', () => {
    const { reply } = ask('Donne-moi le numéro de la ligne qui dessert Guédiawaye')
    expect(reply.text).toContain('B1')
    const unknown = ask('Quel est le numéro de la ligne qui dessert Ngor ?')
    expect(unknown.reply.text).toContain('pas reconnu')
    expect(unknown.reply.text).not.toMatch(/ligne \d{2,}/)
  })

  it('liste les arrêts entre deux points sur une même ligne, dans le bon sens', () => {
    const { reply } = ask('Quels arrêts entre Petersen et Sacré-Cœur ?')
    expect(reply.text).toContain('1. Petersen')
    expect(reply.text).toContain('Sacré-Cœur')
    expect(reply.text).toContain('Ordre de desserte')
    const impossible = ask('Quels arrêts entre Petersen et Rufisque ?')
    expect(impossible.reply.text).toContain('pas sur la même ligne')
  })

  it('donne le dernier départ publié avec son statut, jamais un passage observé', () => {
    const { reply } = ask('Quel est le dernier horaire publié pour le TER ?')
    expect(reply.text).toContain('22:00')
    expect(reply.text).toContain('SCHEDULED')
    expect(reply.text).toContain('pas un passage observé')
    const brt = ask('Dernier bus BRT ?')
    expect(brt.reply.text).toContain('21:00')
  })

  it('pour une alternative en cas d’interruption, compare sans confirmer de perturbation', () => {
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Guédiawaye à Diamniadio', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Existe-t-il une alternative si le TER est interrompu ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('Aucune perturbation')
    expect(reply.text).toContain('Option')
  })

  it('détaille ce qui est confirmé et ce qui ne l’est pas, sans inventer', () => {
    const { reply } = ask('Quelles informations sont confirmées et lesquelles restent inconnues ?')
    expect(reply.text).toContain('TER')
    expect(reply.text).toContain('AFTU')
    expect(reply.text).not.toContain('temps réel connecté')
  })

  it('explique comment faire une correspondance entre le TER et le BRT', () => {
    const { reply } = ask('Comment faire une correspondance entre le TER et le BRT ?')
    expect(reply.text).toContain('Gare TER Dakar ↔ station BRT Petersen')
    expect(reply.text).toContain('Gare TER Colobane ↔ station BRT Place de la Nation')
    expect(reply.text).toContain('estimations')
  })

  it('répond aux questions déictiques avec le contexte : lignes à « cet arrêt »', () => {
    const memory = createConversationMemory()
    copilotAnswer('Quelles lignes passent à Petersen ?', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Quelles lignes passent à cet arrêt ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('B1')
    const empty = ask('Quelles lignes passent à cet arrêt ?')
    expect(empty.reply.text).toContain('De quel arrêt')
  })

  it('classe selon un critère uniquement à partir d’un trajet réellement en mémoire', () => {
    const without = ask('Quel trajet nécessite le moins de marche ?')
    expect(without.reply.text).toContain('indiquez d’abord un départ')
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Guédiawaye à Diamniadio', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Quel itinéraire est le plus rapide ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('Le plus rapide')
    expect(reply.text).toContain('réellement calculée')
  })

  it('liste les arrêts entre le départ et la destination gardés en mémoire', () => {
    const memory = createConversationMemory()
    copilotAnswer('Trajet de Petersen à Sacré-Cœur', CONTEXT, memory, 'auto', NOW)
    const reply = copilotAnswer('Quels arrêts entre mon point de départ et ma destination ?', CONTEXT, memory, 'auto', NOW)
    expect(reply.text).toContain('1. Petersen')
    expect(reply.text).toContain('Sacré-Cœur')
  })

  it('les réseaux non couverts sont annoncés comme tels, jamais inventés', () => {
    const { reply } = ask('Quel bus DDD pour aller à Yoff ?')
    expect(reply.text.toLowerCase()).toContain('ddd')
    expect(reply.text).not.toContain('ligne 1')
  })
})

describe('copilote : wolof et formulations mixtes', () => {
  it('répond en wolof à une salutation wolof, avec note de validation', () => {
    const { reply } = ask('Nanga def !')
    expect(reply.language).toBe('wo')
    expect(reply.text).toContain('Nanga def')
    expect(reply.text).toContain(WOLOF_VALIDATION_NOTE)
  })

  it('calcule un trajet demandé en wolof sur les mêmes données', () => {
    const { reply } = ask('Dama bëgg a dem jóge Petersen dem Rufisque')
    expect(reply.language).toBe('wo')
    expect(reply.text).toContain('Yoon wi')
    expect(reply.journey?.origin.stopId).toBe('brt-petersen')
    expect(reply.journey?.destination.stopId).toBe('ter-rufisque')
  })

  it('une question mixte reçoit une réponse wolof compréhensible', () => {
    const { reply } = ask('Je veux dem ci Diamniadio, ndax TER am na ?')
    expect(reply.language).toBe('wo')
  })

  it('en préférence wolof, une réponse sans modèle wolof bascule honnêtement en français', () => {
    const { reply } = ask('Quels sont les prochains départs ?', { preference: 'wo' })
    expect(reply.language).toBe('wo')
    expect(reply.text).toContain('Tontu bii ci français la')
  })

  it('en préférence française, une question wolof reçoit une réponse française', () => {
    const { reply } = ask('Nanga def, dama bëgg a dem Rufisque', { preference: 'fr' })
    expect(reply.language).toBe('fr')
  })

  it('la station la plus proche en wolof utilise la position connue', () => {
    const { reply } = ask('Bërëb bi gën a jege ?', {
      context: { ...CONTEXT, userLocation: { lat: 14.6760, lon: -17.4335, accuracyM: 15 } },
    })
    expect(reply.language).toBe('wo')
    expect(reply.text).toContain('Dakar')
  })
})

describe('copilote : honnêteté et non-invention', () => {
  it('un lieu inconnu produit une réponse explicite, pas un trajet fictif', () => {
    const { reply } = ask('Trajet de Ngor à Yoff')
    expect(reply.text).not.toContain('Montez à')
    expect(reply.text.toLowerCase()).toMatch(/pas reconnu|non reconnue|ne sont reconnus/)
    expect(reply.journey).toBeUndefined()
  })

  it('aucun prix n’est inventé quand on demande le moins cher', () => {
    const { reply } = ask('Quel trajet de Petersen à Rufisque est le moins cher ?')
    expect(reply.text).toContain('prix')
    expect(reply.text).not.toMatch(/\d+\s*(?:FCFA|F CFA|francs)/i)
  })

  it('les questions hors périmètre restent transparentes (météo : aucune source, rien d’inventé)', () => {
    const { reply } = ask('Quel temps fera-t-il demain à Dakar ?')
    expect(reply.text).toContain('météo')
    expect(reply.text).toMatch(/n’en invente pas|n'invente pas/)
  })
})
