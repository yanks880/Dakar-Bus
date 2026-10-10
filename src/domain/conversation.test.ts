import { describe, expect, it } from 'vitest'
import {
  createConversationMemory,
  detectFollowUp,
  rememberJourney,
  reversedJourney,
} from './conversation'

describe('contexte de conversation', () => {
  it('reconnaît les questions de suivi sans obliger à répéter les lieux', () => {
    expect(detectFollowUp('Et en sens inverse ?')).toBe('reverse')
    expect(detectFollowUp('pour le retour')).toBe('reverse')
    expect(detectFollowUp('et pour rentrer ?')).toBe('reverse')
    expect(detectFollowUp('Pourquoi ce trajet ?')).toBe('why')
    expect(detectFollowUp('Où dois-je descendre ?')).toBe('alight')
    expect(detectFollowUp('Qu’est-ce qui est confirmé ?')).toBe('confirmed')
    expect(detectFollowUp('liste des gares TER')).toBeNull()
    expect(detectFollowUp('trajet de Petersen à Rufisque')).toBeNull()
  })

  it('le sens inverse échange départ et destination réellement connus', () => {
    const memory = createConversationMemory()
    expect(reversedJourney(memory)).toBeNull()
    rememberJourney(memory, {
      origin: { label: 'Petersen – Papa Gueye Fall', lat: 14.6766, lon: -17.4406, stopId: 'brt-petersen' },
      destination: { label: 'Rufisque', lat: 14.7159, lon: -17.2699, stopId: 'ter-rufisque' },
      steps: [],
      totalMinutes: 50,
      boardedLines: ['B1', 'TER'],
      transfers: 1,
      alightStop: 'Rufisque',
    })
    const reversed = reversedJourney(memory)
    expect(reversed?.origin.stopId).toBe('ter-rufisque')
    expect(reversed?.destination.stopId).toBe('brt-petersen')
    expect(memory.lastJourney?.alightStop).toBe('Rufisque')
  })

  it('le wolof « dellu » est reconnu comme un retour', () => {
    expect(detectFollowUp('dellu')).toBe('reverse')
  })
})
