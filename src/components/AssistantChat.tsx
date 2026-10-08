import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Bot, Send, Sparkles, X } from 'lucide-react'
import { answerAssistant, type AssistantContext, type AssistantMessage } from '../domain/assistant'

const SUGGESTIONS: readonly string[] = [
  'Quel est le prochain BRT vers Guédiawaye ?',
  'Liste des gares TER',
  'Trajet de Petersen à Rufisque',
  'Y a-t-il des perturbations ?',
]

let nextMessageId = 1

function firstGreeting(context: AssistantContext): AssistantMessage {
  return {
    id: nextMessageId++,
    role: 'assistant',
    text: answerAssistant('bonjour', context),
  }
}

/**
 * Widget d'assistant : bouton flottant en bas à gauche de la carte et panneau
 * de discussion. Le cerveau est local (`domain/assistant.ts`) : il s'appuie sur
 * le réseau de référence TER/BRT, le calculateur de correspondances et l'état
 * réel des API — aucune conversation n'est envoyée à un service externe.
 */
export function AssistantChat({ context }: { context: AssistantContext }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<AssistantMessage[]>(() => [firstGreeting(context)])
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [open, messages])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const question = draft.trim()
    if (!question) return
    const answer = answerAssistant(question, context)
    setMessages((current) => [
      ...current,
      { id: nextMessageId++, role: 'user', text: question },
      { id: nextMessageId++, role: 'assistant', text: answer },
    ])
    setDraft('')
  }

  function ask(question: string) {
    const answer = answerAssistant(question, context)
    setMessages((current) => [
      ...current,
      { id: nextMessageId++, role: 'user', text: question },
      { id: nextMessageId++, role: 'assistant', text: answer },
    ])
  }

  return (
    <div className="assistant-widget">
      {open && (
        <section className="assistant-panel" aria-label="Assistant mobilité">
          <header className="assistant-head">
            <span className="assistant-head-icon"><Bot size={17} /></span>
            <div>
              <strong>Assistant mobilité</strong>
              <span>TER · BRT · itinéraires — réponses locales, rien n’est envoyé à un serveur distant</span>
            </div>
            <button type="button" className="icon-button" aria-label="Fermer l’assistant" onClick={() => setOpen(false)}><X size={16} /></button>
          </header>
          <div className="assistant-messages" ref={listRef} role="log" aria-live="polite">
            {messages.map((message) => (
              <p key={message.id} className={`assistant-bubble assistant-bubble-${message.role}`}>{message.text}</p>
            ))}
          </div>
          <div className="assistant-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" className="assistant-chip" onClick={() => ask(suggestion)}>{suggestion}</button>
            ))}
          </div>
          <form className="assistant-form" onSubmit={submit}>
            <input
              aria-label="Votre question à l’assistant"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ex. : le BRT va-t-il à Parcelles ?"
            />
            <button type="submit" className="assistant-send" aria-label="Envoyer la question" disabled={!draft.trim()}><Send size={15} /></button>
          </form>
        </section>
      )}
      <button
        type="button"
        className={`assistant-toggle${open ? ' is-open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles size={18} />
        <span>Assistant IA</span>
      </button>
    </div>
  )
}
