/**
 * Services vocaux du copilote : reconnaissance (micro) et synthèse (lecture).
 *
 * Capacités réelles, jamais simulées :
 * - La reconnaissance vocale utilise l'API Web Speech du navigateur quand elle
 *   existe ; sinon la fonction est déclarée indisponible et le chat écrit
 *   reste le chemin principal.
 * - Le wolof n'est PAS une langue de reconnaissance garantie : la plupart des
 *   moteurs de navigateur ne la proposent pas. L'application le dit au lieu de
 *   laisser croire qu'elle comprend le wolof parlé.
 * - La synthèse lit le texte réellement produit par l'assistant. Sans voix
 *   correspondant à la langue, elle se désactive et l'explique.
 *
 * Confidentialité : aucun audio n'est enregistré ni conservé par Dakar Bus.
 * La reconnaissance utilise le moteur du navigateur, qui peut transmettre
 * l'audio à son fournisseur — l'interface le signale quand le micro est actif.
 */

export const STT_LANGUAGES = { fr: 'fr-FR' } as const

/** Le wolof parlé n'est pas supporté de manière fiable par les moteurs courants. */
export const WOLOF_STT_UNAVAILABLE =
  'La reconnaissance vocale du wolof n’est pas disponible dans ce navigateur. Vous pouvez écrire votre question, ou la poser en français si le moteur le prend en charge.'

export interface SpeechRecognitionHandle {
  stop: () => void
}

interface RecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort?: () => void
}

function getRecognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as Record<string, unknown>).SpeechRecognition
    ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition
  return typeof candidate === 'function' ? (candidate as new () => RecognitionLike) : null
}

export function speechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null
}

export interface RecognitionRequest {
  lang: 'fr'
  onFinal: (transcript: string) => void
  onError: (message: string) => void
  onEnd: () => void
}

/**
 * Démarre une session de reconnaissance. Retourne null si le navigateur ne la
 * fournit pas — l'interface affiche alors le repli écrit, rien n'est simulé.
 */
export function startSpeechRecognition(request: RecognitionRequest): SpeechRecognitionHandle | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null
  let recognition: RecognitionLike
  try {
    recognition = new Ctor()
  } catch {
    return null
  }
  recognition.lang = STT_LANGUAGES.fr
  recognition.interimResults = false
  recognition.maxAlternatives = 1
  recognition.continuous = false
  recognition.onresult = (event) => {
    const last = event.results[event.results.length - 1]
    const transcript = last?.[0]?.transcript?.trim()
    if (transcript) request.onFinal(transcript)
  }
  recognition.onerror = (event) => {
    const code = event.error ?? 'unknown'
    const message = code === 'not-allowed' || code === 'service-not-allowed'
      ? 'L’accès au microphone a été refusé. Autorisez-le dans votre navigateur, ou écrivez votre question.'
      : code === 'no-speech'
        ? 'Aucune parole détectée. Réessayez en parlant distinctement.'
        : 'La reconnaissance vocale a rencontré une erreur. Vous pouvez écrire votre question.'
    request.onError(message)
  }
  recognition.onend = () => request.onEnd()
  try {
    recognition.start()
  } catch {
    request.onError('Impossible de démarrer la reconnaissance vocale. Vous pouvez écrire votre question.')
    return null
  }
  return {
    stop: () => {
      try {
        recognition.stop()
      } catch {
        // Une session déjà terminée ne doit pas produire d'erreur visible.
      }
    },
  }
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

function voicesFor(lang: 'fr' | 'wo'): SpeechSynthesisVoice[] {
  if (!speechSynthesisSupported()) return []
  try {
    const wanted = lang === 'fr' ? 'fr' : 'wo'
    return window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith(wanted))
  } catch {
    return []
  }
}

/** Une voix exploitable pour la langue demandée (wolof : presque jamais). */
export function hasVoiceFor(lang: 'fr' | 'wo'): boolean {
  return voicesFor(lang).length > 0
}

export interface SpeakRequest {
  text: string
  lang: 'fr' | 'wo'
  onEnd?: () => void
}

/**
 * Lit le texte produit par l'assistant. Retourne false (et ne lit rien) si la
 * synthèse ou une voix adaptée est absente — l'interface l'affiche alors.
 */
export function speak(request: SpeakRequest): boolean {
  if (!speechSynthesisSupported()) return false
  if (!hasVoiceFor(request.lang)) return false
  const UtteranceCtor = (window as unknown as Record<string, unknown>).SpeechSynthesisUtterance
  if (typeof UtteranceCtor !== 'function') return false
  try {
    window.speechSynthesis.cancel()
    const utterance = new (UtteranceCtor as new (text: string) => SpeechSynthesisUtterance)(request.text)
    utterance.lang = request.lang === 'fr' ? 'fr-FR' : 'wo-SN'
    const voice = voicesFor(request.lang)[0]
    if (voice) utterance.voice = voice
    if (request.onEnd) utterance.onend = () => request.onEnd?.()
    window.speechSynthesis.speak(utterance)
    return true
  } catch {
    return false
  }
}

export function stopSpeaking(): void {
  if (!speechSynthesisSupported()) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    // Arrêt best-effort : la synthèse peut déjà être terminée.
  }
}
