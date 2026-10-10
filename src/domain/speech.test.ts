// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WOLOF_STT_UNAVAILABLE,
  hasVoiceFor,
  speak,
  speechRecognitionSupported,
  speechSynthesisSupported,
  startSpeechRecognition,
  stopSpeaking,
} from './speech'

type ResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }

function installRecognition(): { instances: Array<{ lang: string; onresult: ((event: ResultEvent) => void) | null; onerror: ((event: { error?: string }) => void) | null; onend: (() => void) | null }> } {
  const instances: Array<{ lang: string; onresult: ((event: ResultEvent) => void) | null; onerror: ((event: { error?: string }) => void) | null; onend: (() => void) | null }> = []
  class FakeRecognition {
    lang = ''
    interimResults = false
    maxAlternatives = 1
    continuous = false
    onresult: ((event: ResultEvent) => void) | null = null
    onerror: ((event: { error?: string }) => void) | null = null
    onend: (() => void) | null = null
    constructor() {
      instances.push(this as never)
    }
    start() {}
    stop() {}
  }
  ;(window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition
  return { instances }
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).SpeechRecognition
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  delete (window as unknown as Record<string, unknown>).speechSynthesis
  vi.restoreAllMocks()
})

describe('reconnaissance vocale : capacités réelles, jamais simulées', () => {
  it('sans API navigateur, la reconnaissance est déclarée indisponible', () => {
    expect(speechRecognitionSupported()).toBe(false)
    expect(startSpeechRecognition({ lang: 'fr', onFinal: vi.fn(), onError: vi.fn(), onEnd: vi.fn() })).toBeNull()
  })

  it('avec l’API navigateur, la transcription finale arrive en français fr-FR', () => {
    const { instances } = installRecognition()
    expect(speechRecognitionSupported()).toBe(true)
    const onFinal = vi.fn()
    const onEnd = vi.fn()
    const handle = startSpeechRecognition({ lang: 'fr', onFinal, onError: vi.fn(), onEnd })
    expect(handle).not.toBeNull()
    expect(instances[0].lang).toBe('fr-FR')
    instances[0].onresult!({ results: [[{ transcript: ' Trajet de Petersen à Rufisque ' }]] })
    expect(onFinal).toHaveBeenCalledWith('Trajet de Petersen à Rufisque')
    instances[0].onend!()
    expect(onEnd).toHaveBeenCalled()
  })

  it('un refus de microphone produit un message explicite, pas un faux résultat', () => {
    const { instances } = installRecognition()
    const onError = vi.fn()
    const onFinal = vi.fn()
    startSpeechRecognition({ lang: 'fr', onFinal, onError, onEnd: vi.fn() })
    instances[0].onerror!({ error: 'not-allowed' })
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('microphone'))
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('le wolof parlé est annoncé comme non pris en charge, sans simulation', () => {
    expect(WOLOF_STT_UNAVAILABLE).toContain('wolof')
    expect(WOLOF_STT_UNAVAILABLE).toContain('écrire')
  })
})

describe('synthèse vocale : lecture honnête selon les voix disponibles', () => {
  it('sans synthèse navigateur, la lecture est refusée proprement', () => {
    expect(speechSynthesisSupported()).toBe(false)
    expect(speak({ text: 'Bonjour', lang: 'fr' })).toBe(false)
    stopSpeaking()
  })

  it('avec synthèse mais sans voix adaptée, aucune lecture n’est lancée', () => {
    const speakSpy = vi.fn()
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { getVoices: () => [], cancel: vi.fn(), speak: speakSpy },
    })
    expect(speechSynthesisSupported()).toBe(true)
    expect(hasVoiceFor('wo')).toBe(false)
    expect(speak({ text: 'Nanga def', lang: 'wo' })).toBe(false)
    expect(speakSpy).not.toHaveBeenCalled()
  })

  it('une voix française disponible lit le texte réellement produit', () => {
    class FakeUtterance {
      lang = ''
      voice: unknown = null
      onend: (() => void) | null = null
      constructor(public text: string) {}
    }
    ;(window as unknown as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance
    const speakSpy = vi.fn()
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [{ lang: 'fr-FR', name: 'Test' }],
        cancel: vi.fn(),
        speak: speakSpy,
      },
    })
    expect(hasVoiceFor('fr')).toBe(true)
    expect(speak({ text: 'Le BRT circule toutes les 6 minutes.', lang: 'fr' })).toBe(true)
    expect(speakSpy).toHaveBeenCalledTimes(1)
    const utterance = speakSpy.mock.calls[0][0] as FakeUtterance
    expect(utterance.lang).toBe('fr-FR')
    expect(utterance.text).toContain('BRT')
    delete (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
  })
})
