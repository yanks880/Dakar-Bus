import { useLayoutEffect, useRef, useState } from 'react'
import {
  FIELD_VISIBLE_MARGIN_PX,
  fieldScrollShift,
  keyboardIsOpen,
  resolveShellHeight,
  summonsKeyboard,
  type FocusTarget,
} from '../domain/viewportLock'

/**
 * Hauteur verrouillée du conteneur de l'application.
 *
 * La valeur rendue est posée sur `.app-shell` en `--app-height` : la mise en
 * page a une hauteur en pixels qui ne change pas pendant l'ouverture du clavier
 * mobile. C'est ce verrou qui supprime le reflow violent constaté au toucher du
 * champ « On va où ? » (page décalée vers le haut, en-tête rogné, carte
 * recalculée).
 */
export interface ViewportLock {
  /** Hauteur verrouillée en px ; `null` avant la première mesure. */
  height: number | null
  /** Vrai pendant que le clavier mobile recouvre l'écran. */
  keyboardOpen: boolean
}

/** Lit la fenêtre de mise en page et la fenêtre visuelle, si elle existe. */
function measureViewport(): { layoutHeight: number; visualHeight: number | null } {
  if (typeof window === 'undefined') return { layoutHeight: 0, visualHeight: null }
  const visual = window.visualViewport
  return { layoutHeight: window.innerHeight, visualHeight: visual ? visual.height : null }
}

/** Réduit un élément du DOM à ce dont la règle de saisie a besoin. */
export function focusTargetOf(target: EventTarget | null): FocusTarget | null {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return null
  return {
    tagName: target.tagName,
    type: target.getAttribute('type'),
    isContentEditable: target.isContentEditable,
  }
}

/** Premier ancêtre qui défile vraiment : c'est lui qu'on déplace, pas la page. */
function scrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    const overflowY = window.getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
    node = node.parentElement
  }
  return null
}

/**
 * Ramène le champ actif au-dessus du clavier en défilant son conteneur.
 * Le document n'est jamais déplacé : l'en-tête et la carte restent en place.
 */
function keepFocusedFieldVisible(): void {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (!summonsKeyboard(focusTargetOf(active))) return
  const container = scrollableAncestor(active)
  if (!container) return
  const containerRect = container.getBoundingClientRect()
  const fieldRect = active.getBoundingClientRect()
  const visual = window.visualViewport
  const visualTop = visual?.offsetTop ?? 0
  const visualBottom = visual ? visualTop + visual.height : window.innerHeight
  const shift = fieldScrollShift({
    fieldTop: fieldRect.top,
    fieldBottom: fieldRect.bottom,
    visibleTop: Math.max(containerRect.top, visualTop),
    visibleBottom: Math.min(containerRect.bottom, visualBottom),
    margin: FIELD_VISIBLE_MARGIN_PX,
  })
  if (shift !== 0) container.scrollTop += shift
}

/**
 * Suit la fenêtre et le focus, et rend une hauteur qui ne varie pas pendant
 * l'ouverture du clavier mobile.
 */
export function useViewportLock(): ViewportLock {
  const editingRef = useRef(false)
  /** Dernière hauteur connue clavier fermé : c'est elle qui est conservée. */
  const lockedRef = useRef<number | null>(null)
  const keyboardWasOpenRef = useRef(false)
  const [lock, setLock] = useState<ViewportLock>({ height: null, keyboardOpen: false })

  // Mesure avant peinture : la première image a déjà la bonne hauteur.
  useLayoutEffect(() => {
    const sync = () => {
      const viewport = measureViewport()
      const lockedHeight = lockedRef.current ?? viewport.layoutHeight
      const context = { ...viewport, editing: editingRef.current, lockedHeight }
      const keyboardOpen = keyboardIsOpen(context)
      const height = resolveShellHeight(context)
      if (!keyboardOpen) lockedRef.current = viewport.layoutHeight
      // Le champ n'est ramené qu'à l'ouverture du clavier : ensuite, le
      // défilement de l'usager n'est plus contredit.
      if (keyboardOpen && !keyboardWasOpenRef.current) keepFocusedFieldVisible()
      keyboardWasOpenRef.current = keyboardOpen
      setLock((current) =>
        current.height === height && current.keyboardOpen === keyboardOpen
          ? current
          : { height, keyboardOpen },
      )
    }

    const handleFocusIn = (event: FocusEvent) => {
      editingRef.current = summonsKeyboard(focusTargetOf(event.target))
      sync()
    }
    const handleFocusOut = () => {
      editingRef.current = false
      sync()
    }

    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)
    const visual = window.visualViewport
    visual?.addEventListener('resize', sync)
    visual?.addEventListener('scroll', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      visual?.removeEventListener('resize', sync)
      visual?.removeEventListener('scroll', sync)
    }
  }, [])

  return lock
}
