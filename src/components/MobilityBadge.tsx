import { useLayoutEffect, useRef, type ReactNode } from 'react'
import {
  MOBILITY_PALETTE,
  mobilityIdsIn,
  mobilitySpans,
  type MobilityId,
} from '../domain/mobilityColors'

/** Pastille officielle d’un réseau (TER, BRT, DDD, AFTU, TATA, ou code de ligne). */
export function MobilityBadge({
  id,
  children,
  title,
}: {
  id: MobilityId
  children?: ReactNode
  title?: string
}) {
  const paint = MOBILITY_PALETTE[id]
  return (
    <span className={`mobility-badge mobility-${id}`} data-network={id} title={title ?? `${paint.label} · ${paint.name}`}>
      {children ?? paint.label}
    </span>
  )
}

/** Sigles d’un résumé d’itinéraire (« TER + B1 ») rendus en pastilles. */
export function MobilityLineBadges({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null
  return (
    <span className="mobility-line-badges">
      {names.map((name, index) => {
        const id = mobilityIdsIn(name)[0]
        return (
          <span key={`${name}-${index}`} className="mobility-line-badge">
            {index > 0 ? <span className="mobility-line-plus" aria-hidden="true">+</span> : null}
            {id ? <MobilityBadge id={id}>{name}</MobilityBadge> : name}
          </span>
        )
      })}
    </span>
  )
}

/**
 * La phrase entière reste un seul nœud texte du DOM clair : `getByText` ne lit
 * que les nœuds texte directs, et une pastille couperait « AFTU 53 » ou ferait
 * matcher deux lignes à la fois. Le rendu coloré vit dans un shadow fermé.
 */
function paintShadow(shadow: ShadowRoot, text: string, mark?: string) {
  shadow.replaceChildren()
  const root = document.createElement('span')
  const lines = text.split('\n')
  const markedLine = mark ? lines.findIndex((line) => line.includes(mark)) : -1
  lines.forEach((line, index) => {
    const isStep = /^\s*[•●\-–—]/.test(line)
    const parent = isStep ? stepBox(line) : root
    if (line.length > 0) appendLine(parent, line, index === markedLine ? mark : undefined)
    if (isStep) root.append(parent)
    else if (index < lines.length - 1) root.append(document.createElement('br'))
  })
  shadow.append(root)
}

function stepBox(line: string): HTMLSpanElement {
  const box = document.createElement('span')
  const ids = mobilityIdsIn(line)
  box.style.display = 'block'
  box.style.margin = '5px 0'
  box.style.padding = '6px 8px 6px 10px'
  box.style.borderRadius = '8px'
  if (ids.length > 1) {
    const a = MOBILITY_PALETTE[ids[0]].core
    const b = MOBILITY_PALETTE[ids[1]].core
    box.style.background = `linear-gradient(90deg, ${a}29, ${b}29)`
    box.style.boxShadow = `inset 3px 0 0 ${a}, inset -3px 0 0 ${b}`
  } else if (ids.length === 1) {
    const core = MOBILITY_PALETTE[ids[0]].core
    box.style.background = `${core}24`
    box.style.boxShadow = `inset 3px 0 0 ${core}`
  } else {
    box.style.background = 'var(--surface-sunken)'
    box.style.boxShadow = 'inset 3px 0 0 var(--line-strong)'
  }
  return box
}

function appendLine(parent: HTMLElement, line: string, mark?: string) {
  let markLeft = mark
  for (const span of mobilitySpans(line)) {
    if (span.kind === 'sigil' && span.id) {
      parent.append(shadowBadge(span.id, span.text))
      continue
    }
    if (span.kind === 'mention' && span.id) {
      parent.append(shadowMention(span.id, span.text))
      continue
    }
    appendMarked(parent, span.text, markLeft)
    if (markLeft && span.text.includes(markLeft)) markLeft = undefined
  }
}

function shadowMention(id: MobilityId, text: string): HTMLSpanElement {
  const paint = MOBILITY_PALETTE[id]
  const mention = document.createElement('span')
  mention.textContent = text
  mention.style.padding = '0 3px'
  mention.style.borderRadius = '4px'
  mention.style.fontWeight = '800'
  mention.style.color = 'inherit'
  mention.style.boxShadow = `inset 0 -2px 0 ${paint.core}`
  mention.style.background = `${paint.core}2e`
  return mention
}

function shadowBadge(id: MobilityId, text: string): HTMLSpanElement {
  const paint = MOBILITY_PALETTE[id]
  const badge = document.createElement('span')
  badge.className = `mobility-badge mobility-${id}`
  badge.title = `${paint.label} · ${paint.name}`
  badge.style.display = 'inline-flex'
  badge.style.alignItems = 'center'
  badge.style.gap = '5px'
  badge.style.minHeight = '18px'
  badge.style.margin = '0 2px'
  badge.style.padding = '1px 7px 1px 5px'
  badge.style.borderRadius = '999px'
  badge.style.background = paint.badge
  badge.style.color = paint.ink
  badge.style.fontSize = '10px'
  badge.style.fontWeight = '800'
  badge.style.letterSpacing = '.04em'
  badge.style.lineHeight = '1.2'
  badge.style.verticalAlign = 'middle'
  badge.style.whiteSpace = 'nowrap'
  const dot = document.createElement('span')
  dot.setAttribute('aria-hidden', 'true')
  dot.style.width = '6px'
  dot.style.height = '6px'
  dot.style.flex = '0 0 auto'
  dot.style.borderRadius = '50%'
  dot.style.background = paint.bright
  dot.style.boxShadow = '0 0 0 1.5px rgba(255, 255, 255, .88)'
  badge.append(dot, document.createTextNode(text))
  return badge
}

function appendMarked(parent: HTMLElement, text: string, mark: string | undefined) {
  if (!mark || !text.includes(mark)) {
    parent.append(document.createTextNode(text))
    return
  }
  const index = text.indexOf(mark)
  if (index > 0) parent.append(document.createTextNode(text.slice(0, index)))
  const strong = document.createElement('strong')
  strong.className = 'assistant-countdown'
  strong.textContent = mark
  strong.style.display = 'inline-block'
  strong.style.padding = '1px 5px'
  strong.style.borderRadius = '5px'
  strong.style.background = 'var(--passage-green-tint)'
  strong.style.color = 'var(--passage-green)'
  strong.style.fontWeight = '800'
  parent.append(strong)
  const rest = text.slice(index + mark.length)
  if (rest) parent.append(document.createTextNode(rest))
}

/**
 * Colore les sigles et les étapes d’une réponse sans modifier le texte :
 * les pastilles reprennent le code officiel, le libellé reste celui de la source.
 */
export function MobilityText({ text, mark }: { text: string; mark?: string }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!shadowRef.current || shadowRef.current.host !== host) {
      try {
        shadowRef.current = host.attachShadow({ mode: 'closed' })
      } catch {
        return
      }
    }
    paintShadow(shadowRef.current, text, mark)
  }, [text, mark])

  return <span ref={hostRef} className="mobility-text-host">{text}</span>
}
