import { describe, expect, it } from 'vitest'
import type { AssistantContext } from './assistant'
import { answerAssistant, extractJourneyRequest } from './assistant'
import { copilotAnswer } from './copilot'
import { createConversationMemory } from './conversation'
import { extractMobilityIntent, extractOriginStatement, withFallbackOrigin } from './intent'

const CONTEXT: AssistantContext = { publishedAvailable: false, adminOnline: false }
const NOW = Date.parse('2026-10-10T07:00:00Z')

function ask(question: string, memory = createConversationMemory()) {
  return copilotAnswer(question, CONTEXT, memory, 'auto', NOW)
}

describe('langage naturel : départ et destination dans une même question', () => {
  it('extrait Keur Mbaye Fall comme départ et Dakar comme destination (exemple de la consigne)', () => {
    const intent = extractMobilityIntent('Comment faire pour aller à Dakar ? Je suis à Keur Mbaye Fall')
    expect(intent).toMatchObject({
      origin: { stopId: 'ter-mbao', label: 'Keur Mbaye Fall' },
      destination: { stopId: 'ter-dakar', label: 'Dakar' },
    })
  })

  it('donne directement le trajet TER, sans demander le départ déjà écrit', () => {
    const reply = ask('Comment faire pour aller à Dakar ? Je suis à Keur Mbaye Fall')
    expect(reply.text).not.toContain('point de départ')
    expect(reply.text).toContain('Keur Mbaye Fall → Dakar')
    expect(reply.text).toContain('TER')
    expect(reply.journey?.origin.stopId).toBe('ter-mbao')
    expect(reply.journey?.destination.stopId).toBe('ter-dakar')
  })

  it('reconnaît le départ placé après la destination et sans ponctuation finale', () => {
    expect(extractMobilityIntent('je suis à Keur Mbaye Fall comment aller à Dakar')).toMatchObject({
      origin: { stopId: 'ter-mbao' },
      destination: { stopId: 'ter-dakar' },
    })
    expect(extractMobilityIntent('comment aller à Rufisque depuis Keur Mbaye Fall')).toMatchObject({
      origin: { stopId: 'ter-mbao' },
      destination: { stopId: 'ter-rufisque' },
    })
  })

  it('accepte « centre-ville » comme repère de la gare TER de Dakar', () => {
    expect(extractMobilityIntent('comment aller au centre-ville depuis Petersen')).toMatchObject({
      origin: { stopId: 'brt-petersen' },
      destination: { stopId: 'ter-dakar' },
    })
  })

  it('reconnaît les lieux de la consigne : Parcelles Assainies, Petersen, Rufisque', () => {
    expect(extractMobilityIntent('Je suis à Parcelles Assainies, comment rejoindre Petersen ?')).toMatchObject({
      origin: { stopId: 'brt-parcelles' },
      destination: { stopId: 'brt-petersen' },
    })
    expect(extractMobilityIntent('Je veux aller à Rufisque avant 9h')?.destination).toMatchObject({ stopId: 'ter-rufisque' })
  })

  it('ne transforme pas un lieu inconnu en départ et le signale', () => {
    const intent = extractMobilityIntent('trajet de Mbour à Rufisque')
    expect(intent?.origin).toBeNull()
    expect(intent?.originText).toBe('mbour')
    expect(extractJourneyRequest('trajet de Mbour à Rufisque')).toBeNull()
  })

  it('ne prend pas un mode de transport (« dans le BRT ») pour un lieu inconnu', () => {
    const reply = ask('Je suis dans le BRT')
    expect(reply.text).not.toContain('n’est pas une gare')
    expect(extractMobilityIntent('je suis dans le bus, comment aller à Rufisque')?.originText).toBeNull()
  })

  it('n’extrait pas de départ d’une simple question de desserte ou de fréquence', () => {
    expect(extractMobilityIntent('Le BRT va-t-il à Parcelles ?')).toBeNull()
    expect(extractMobilityIntent('Quel est le prochain départ du TER à Rufisque ?')).toBeNull()
  })
})

describe('mémoire du départ déclaré dans la conversation', () => {
  it('garde le départ « je suis à … » puis l’utilise pour la question suivante', () => {
    const memory = createConversationMemory()
    const statement = ask('Je suis à Keur Mbaye Fall', memory)
    expect(statement.text).toContain('Noté : vous êtes à Keur Mbaye Fall')
    expect(memory.statedOrigin?.stopId).toBe('ter-mbao')

    const reply = ask('Comment faire pour aller à Dakar ?', memory)
    expect(reply.text).toContain('Keur Mbaye Fall → Dakar')
    expect(reply.journey?.origin.stopId).toBe('ter-mbao')
  })

  it('ne remplace jamais un départ écrit mais non reconnu', () => {
    const memory = createConversationMemory()
    ask('Je suis à Keur Mbaye Fall', memory)
    const reply = ask('trajet de Mbour à Rufisque', memory)
    expect(reply.text).toContain('« mbour » n’est pas une gare')
    expect(reply.journey).toBeUndefined()
  })

  it('refuse un départ inconnu déclaré seul, sans le retenir', () => {
    const memory = createConversationMemory()
    const reply = ask('Je suis à Mbour', memory)
    expect(reply.text).toContain('« mbour » n’est pas une gare')
    expect(memory.statedOrigin).toBeNull()
  })

  it('ne traite pas une déclaration suivie d’une autre demande comme simple départ', () => {
    const memory = createConversationMemory()
    const reply = ask('Je suis à Petersen, quelles lignes passent ici ?', memory)
    expect(reply.text).toContain('Petersen – Papa Gueye Fall est desservi par')
    expect(memory.statedOrigin).toBeNull()
  })

  it('applique le départ mémorisé seulement aux demandes qui n’en donnent pas', () => {
    const origin = { label: 'Keur Mbaye Fall', lat: 14.744079, lon: -17.3138934, stopId: 'ter-mbao' }
    expect(withFallbackOrigin(extractMobilityIntent('comment aller à Rufisque'), origin)?.origin).toEqual(origin)
    expect(withFallbackOrigin(extractMobilityIntent('trajet de Mbour à Rufisque'), origin)?.origin).toBeNull()
    expect(withFallbackOrigin(extractMobilityIntent('trajet de Petersen à Rufisque'), origin)?.origin?.stopId).toBe('brt-petersen')
    expect(answerAssistant('Comment aller à Rufisque ?', CONTEXT, NOW, { fallbackOrigin: origin })).toContain('Keur Mbaye Fall → Rufisque')
  })

  it('répond au suivi « sens inverse » après une demande en langage naturel', () => {
    const memory = createConversationMemory()
    ask('Je suis à Keur Mbaye Fall, comment aller à Dakar ?', memory)
    const reply = ask('Et en sens inverse ?', memory)
    expect(reply.journey?.origin.stopId).toBe('ter-dakar')
    expect(reply.journey?.destination.stopId).toBe('ter-mbao')
  })
})

describe('origine de la déclaration', () => {
  it('ne reconnaît une déclaration que pour les formes « je suis / je pars de »', () => {
    expect(extractOriginStatement('Je suis à Keur Mbaye Fall')).toMatchObject({ origin: { stopId: 'ter-mbao' }, hasOtherRequest: false })
    expect(extractOriginStatement('Je pars de Petersen')).toMatchObject({ origin: { stopId: 'brt-petersen' } })
    expect(extractOriginStatement('Quel est le prochain TER ?')).toBeNull()
  })
})
