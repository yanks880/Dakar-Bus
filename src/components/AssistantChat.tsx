import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Mic, MicOff, Send, Sparkles, Square, Volume2, X } from 'lucide-react'
import { extractJourneyRequest, getAssistantCountdownMinutes, type AssistantContext, type AssistantMessage } from '../domain/assistant'
import { MobilityText } from './MobilityBadge'
import { assistantBounds } from './assistantBounds'
import { safeHttpUrl } from '../domain/http'
import { copilotAnswer } from '../domain/copilot'
import { createConversationMemory, type ConversationMemory } from '../domain/conversation'
import {
  loadAssistantLanguagePreference,
  saveAssistantLanguagePreference,
  type AssistantLanguagePreference,
} from '../domain/language'
import type { PlannerEndpoint } from '../domain/planner'
import {
  WOLOF_STT_UNAVAILABLE,
  speechRecognitionSupported,
  speak,
  startSpeechRecognition,
  stopSpeaking,
  type SpeechRecognitionHandle,
} from '../domain/speech'

const LANGUAGE_OPTIONS: readonly { value: AssistantLanguagePreference; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Détecter la langue de la question (français, wolof, mixte)' },
  { value: 'fr', label: 'FR', title: 'Répondre en français' },
  { value: 'wo', label: 'WO', title: 'Répondre en wolof (modèles de base, en attente de validation)' },
]

let nextMessageId = 1

interface ChatMessage extends AssistantMessage {
  /** Langue effective de la réponse, pour la lecture audio. */
  lang?: 'fr' | 'wo'
  /** Une réponse qui n’a pas pu être préparée est affichée comme telle. */
  failed?: boolean
}

function AssistantBubble({ message }: { message: ChatMessage }) {
  const className = message.failed
    ? 'assistant-bubble assistant-bubble-assistant assistant-bubble-error'
    : `assistant-bubble assistant-bubble-${message.role}`
  if (message.role !== 'assistant') return <p className={className}>{message.text}</p>
  const sourceParts = message.text.split('\nSource : ')
  const countdown = message.countdownMinutes
  const mark = countdown !== undefined && countdown >= 1 ? `${countdown} min` : undefined
  const reply = <MobilityText text={sourceParts[0]} mark={mark} />
  if (sourceParts.length > 1) {
    return (
      <div className={className}>
        <div className="assistant-reply-text">{reply}</div>
        <details className="assistant-sources">
          <summary>Sources et date de consultation</summary>
          {sourceParts.slice(1).map((part, index) => {
            const [url, ...notes] = part.split('\n')
            const safeUrl = safeHttpUrl(url)
            return <p key={index}>{safeUrl ? <a href={safeUrl} target="_blank" rel="noopener noreferrer">{new URL(safeUrl).hostname}</a> : 'Source non disponible'}<br />{notes.join('\n')}</p>
          })}
        </details>
      </div>
    )
  }
  return <div className={className}>{reply}</div>
}

/**
 * Widget d'assistant : accès dans l’en-tête et panneau de discussion. Le cerveau est
 * local (`domain/copilot.ts` + `domain/assistant.ts`) : il s'appuie sur le
 * référentiel des mobilités, le calculateur de correspondances et l'état réel
 * des API — aucune conversation n'est envoyée à un service externe.
 *
 * Vie du panneau : il reste ouvert jusqu'à ce que l'usager le ferme ;
 * l’envoi manuel et la voix passent par le même chemin,
 * avec un état de chargement visible et le défilement vers la dernière réponse.
 */
export function AssistantChat({ context, onOpenJourney }: { context: AssistantContext; onOpenJourney?: (origin: PlannerEndpoint, destination: PlannerEndpoint) => void }) {
  const [open, setOpen] = useState(false)
  const [exchanges, setExchanges] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const [speakingId, setSpeakingId] = useState<number | null>(null)
  const [preference, setPreference] = useState<AssistantLanguagePreference>(() => loadAssistantLanguagePreference())
  const listRef = useRef<HTMLDivElement | null>(null)
  const memoryRef = useRef<ConversationMemory>(createConversationMemory())
  const contextRef = useRef(context)
  const preferenceRef = useRef(preference)
  const pendingRef = useRef(false)
  const recognitionRef = useRef<SpeechRecognitionHandle | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    contextRef.current = context
  }, [context])
  useEffect(() => {
    preferenceRef.current = preference
  }, [preference])

  const messages = exchanges
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = useState({ top: 12, left: 12, width: 360, maxHeight: 360 })

  const close = useCallback(() => {
    setOpen(false)
    toggleRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const reposition = () => {
      const rect = toggleRef.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const height = viewport?.height ?? window.innerHeight
      const tabs = toggleRef.current?.closest('.sidebar-top')?.querySelector('.desktop-tabs')
      const tabBounds = tabs?.getBoundingClientRect()
      // Laisser les onglets cliquables pendant la discussion sur ordinateur.
      const anchor = { right: rect.right, bottom: Math.max(rect.bottom, tabBounds?.height ? tabBounds.bottom : 0) }
      setPosition(assistantBounds(anchor, {
        width: viewport?.width ?? window.innerWidth,
        height,
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        keyboardOpen: height < window.innerHeight - 100,
      }))
    }
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
    }
    reposition()

    window.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('resize', reposition)
    window.visualViewport?.addEventListener('scroll', reposition)
    document.addEventListener('keydown', dismiss)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition)
    const shell = toggleRef.current?.closest('.app-shell')
    if (shell) observer?.observe(shell)
    return () => {
      window.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('resize', reposition)
      window.visualViewport?.removeEventListener('scroll', reposition)
      document.removeEventListener('keydown', dismiss)
      observer?.disconnect()
    }
  }, [open, close, context])

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true })
  }, [open])

  // Défilement vers la réponse la plus récente : après le rendu, une fois la
  // hauteur réelle connue (réponses longues incluses).
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current
      if (list) list.scrollTop = list.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, messages, pending])

  // Ni micro actif ni lecture audio ne doivent survivre à la fermeture.
  useEffect(() => {
    if (open) return
    recognitionRef.current?.stop()
    recognitionRef.current = null
    setListening(false)
    stopSpeaking()
    setSpeakingId(null)
  }, [open])

  useEffect(() => () => {
    recognitionRef.current?.stop()
    stopSpeaking()
  }, [])

  const ask = useCallback((question: string): boolean => {
    const trimmed = question.trim()
    if (!trimmed || pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    setNotice(null)
    setExchanges((current) => [...current, { id: nextMessageId++, role: 'user', text: trimmed }])
    // La question et l'état de chargement sont rendus avant le calcul de la
    // réponse : la fenêtre ne dépend plus du temps de traitement.
    window.setTimeout(() => {
      let text: string
      let failed = false
      let reply: ReturnType<typeof copilotAnswer> | null = null
      try {
        reply = copilotAnswer(trimmed, contextRef.current, memoryRef.current, preferenceRef.current, Date.now())
        text = reply.text
      } catch {
        failed = true
        text = 'Une erreur est survenue en préparant cette réponse. Réessayez : la carte, la recherche et le calcul de trajet restent disponibles pendant ce temps.'
      }
      const journey = reply ? reply.journey : extractJourneyRequest(trimmed) ?? undefined
      const countdownMinutes = reply?.countdownMinutes
        ?? getAssistantCountdownMinutes(trimmed, contextRef.current, Date.now())
        ?? undefined
      setExchanges((current) => [
        ...current,
        {
          id: nextMessageId++,
          role: 'assistant',
          text,
          lang: reply?.language ?? 'fr',
          ...(failed ? { failed } : {}),
          ...(journey ? { journey } : {}),
          ...(countdownMinutes === undefined ? {} : { countdownMinutes }),
        },
      ])
      pendingRef.current = false
      setPending(false)
    }, 0)
    return true
  }, [])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft.trim() || pending) return
    if (ask(draft)) setDraft('')
  }

  function chooseLanguage(value: AssistantLanguagePreference) {
    setPreference(value)
    saveAssistantLanguagePreference(value)
  }

  function toggleMicrophone() {
    if (listening) {
      recognitionRef.current?.stop()
      recognitionRef.current = null
      setListening(false)
      return
    }
    if (preferenceRef.current === 'wo') {
      setNotice(WOLOF_STT_UNAVAILABLE)
      return
    }
    if (!speechRecognitionSupported()) {
      setNotice('La reconnaissance vocale n’est pas disponible dans ce navigateur. Écrivez votre question : le chat fonctionne sans micro.')
      return
    }
    setNotice(null)
    setListening(true)
    recognitionRef.current = startSpeechRecognition({
      lang: 'fr',
      onFinal: (transcript) => {
        // Le texte reconnu est proposé dans le champ : l'usager le corrige
        // ou le confirme, il n'est jamais envoyé à son insu.
        setDraft(transcript)
        inputRef.current?.focus()
      },
      onError: (message) => setNotice(message),
      onEnd: () => {
        setListening(false)
        recognitionRef.current = null
      },
    })
    if (!recognitionRef.current) setListening(false)
  }

  function listenTo(message: ChatMessage) {
    if (speakingId === message.id) {
      stopSpeaking()
      setSpeakingId(null)
      return
    }
    const lang = message.lang ?? 'fr'
    const started = speak({ text: message.text.split('\nSource : ')[0], lang, onEnd: () => setSpeakingId(null) })
    if (!started) {
      setNotice(lang === 'wo'
        ? 'La lecture audio en wolof n’est pas disponible : aucune voix wolof dans ce navigateur. Le texte reste affiché.'
        : 'La synthèse vocale n’est pas disponible dans ce navigateur : la réponse reste affichée à l’écran.')
      return
    }
    setSpeakingId(message.id)
  }

  const micSupported = speechRecognitionSupported()

  return (
    <div className="assistant-widget">
      {open && createPortal(
        <section
          id="mobility-assistant-panel"
          style={position}
          className="assistant-panel"
          aria-label="Assistant mobilité"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="assistant-head">
            <span className="assistant-head-icon"><Bot size={17} /></span>
            <div>
              <strong>Assistant mobilité</strong>

            </div>
            <details className="assistant-options"><summary>Langue</summary>
            <div className="assistant-lang" role="group" aria-label="Langue de réponse de l’assistant">
              {LANGUAGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`assistant-lang-option${preference === option.value ? ' is-active' : ''}`}
                  aria-pressed={preference === option.value}
                  title={option.title}
                  onClick={() => chooseLanguage(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            </details>
            <button type="button" className="icon-button" aria-label="Fermer l’assistant" onClick={close}><X size={16} /></button>
          </header>
          <div className="assistant-messages" ref={listRef} role="log" aria-live="polite" aria-busy={pending}>
            {messages.map((message) => {
              const bubble = message.journey && onOpenJourney ? (
                <div key={message.id} className="assistant-route-reply">
                  <AssistantBubble message={message} />
                  <button
                    type="button"
                    className="assistant-chip"
                    onClick={(event) => {
                      // Le trajet s'ouvre dans l'onglet Trajet ; le panneau reste
                      // ouvert : c'est l'usager qui décide de le fermer.
                      event.stopPropagation()
                      onOpenJourney(message.journey!.origin, message.journey!.destination)
                    }}
                  >
                    Ouvrir dans Trajet
                  </button>
                </div>
              ) : <AssistantBubble key={message.id} message={message} />
              if (message.role !== 'assistant') return bubble
              return (
                <div key={message.id} className="assistant-spoken-row">
                  {bubble}
                  <button
                    type="button"
                    className={`assistant-voice${speakingId === message.id ? ' is-speaking' : ''}`}
                    aria-label={speakingId === message.id ? 'Arrêter la lecture audio' : 'Écouter la réponse'}
                    title={speakingId === message.id ? 'Arrêter la lecture audio' : 'Écouter la réponse'}
                    onClick={() => listenTo(message)}
                  >
                    {speakingId === message.id ? <Square size={12} /> : <Volume2 size={13} />}
                  </button>
                </div>
              )
            })}
            {pending && (
              <p className="assistant-bubble assistant-bubble-assistant assistant-pending" role="status">
                L’assistant consulte les données de mobilité…
              </p>
            )}
          </div>
          {listening && (
            <p className="assistant-privacy" role="status">
              <Mic size={12} /> Micro actif — la reconnaissance utilise le moteur du navigateur (qui peut traiter l’audio auprès de son fournisseur). Dakar Bus n’enregistre ni ne conserve votre voix.
            </p>
          )}
          {notice && (
            <p className="assistant-notice" role="status">
              {notice}
              <button type="button" aria-label="Fermer le message de l’assistant" onClick={() => setNotice(null)}><X size={12} /></button>
            </p>
          )}
          <form className="assistant-form" onSubmit={submit}>
            <input
              ref={inputRef}
              aria-label="Votre question à l’assistant"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={listening ? 'Je vous écoute…' : 'Ex. : je suis à Keur Mbaye Fall, je vais à Dakar'}
              enterKeyHint="send"
            />
            <button
              type="button"
              className={`assistant-mic${listening ? ' is-listening' : ''}`}
              aria-label={listening ? 'Arrêter l’écoute' : 'Poser la question par la voix'}
              aria-pressed={listening}
              title={listening ? 'Arrêter l’écoute' : micSupported ? 'Poser la question par la voix' : 'Reconnaissance vocale indisponible dans ce navigateur'}
              onClick={toggleMicrophone}
            >
              {listening ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            <button type="submit" className="assistant-send" aria-label="Envoyer la question" disabled={!draft.trim() || pending}><Send size={15} /></button>
          </form>
        </section>,
        toggleRef.current?.closest('.app-shell') ?? document.body,
      )}
      <button
        type="button"
        className={`assistant-toggle${open ? ' is-open' : ''}`}
        ref={toggleRef}
        aria-label="Assistant IA"
        aria-controls="mobility-assistant-panel"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles size={16} />
        <span>IA</span>
      </button>
    </div>
  )
}
