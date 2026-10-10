// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useViewportLock } from './useViewportLock'

/**
 * Comportement du verrou de hauteur : la hauteur rendue ne doit pas bouger
 * pendant l'ouverture du clavier mobile, et doit suivre la fenêtre dès que le
 * clavier est refermé.
 */

function Probe() {
  const lock = useViewportLock()
  return (
    <div className="probe">
      <output data-testid="height">{lock.height ?? 'null'}</output>
      <output data-testid="keyboard">{String(lock.keyboardOpen)}</output>
      <input data-testid="field" type="text" />
      <input data-testid="checkbox" type="checkbox" />
    </div>
  )
}

/** Fenêtre visuelle pilotable : jsdom ne fournit pas window.visualViewport. */
class FakeVisualViewport extends EventTarget {
  height: number
  offsetTop = 0
  offsetLeft = 0
  width = 390
  scale = 1
  constructor(height: number) {
    super()
    this.height = height
  }
  fire() {
    this.dispatchEvent(new Event('resize'))
  }
}

let visual: FakeVisualViewport | null = null

function setLayoutHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

function setVisualHeight(height: number) {
  if (!visual) throw new Error('fenêtre visuelle absente')
  visual.height = height
  visual.fire()
}

describe('useViewportLock', () => {
  beforeEach(() => {
    setLayoutHeight(800)
    visual = new FakeVisualViewport(800)
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual })
  })

  afterEach(() => {
    // Le nettoyage automatique de Testing Library suppose les globales vitest,
    // désactivées ici : il est fait à la main, comme dans App.test.tsx.
    cleanup()
    visual = null
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  })

  it('mesure la fenêtre avant peinture', () => {
    render(<Probe />)
    expect(screen.getByTestId('height').textContent).toBe('800')
    expect(screen.getByTestId('keyboard').textContent).toBe('false')
  })

  it('garde la hauteur verrouillée quand le clavier réduit la fenêtre visuelle', () => {
    render(<Probe />)
    const field = screen.getByTestId('field')

    act(() => {
      field.focus()
    })
    act(() => {
      setVisualHeight(470)
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('true')
    expect(screen.getByTestId('height').textContent).toBe('800')
  })

  it('garde la hauteur verrouillée quand le clavier réduit la fenêtre de mise en page', () => {
    render(<Probe />)
    const field = screen.getByTestId('field')

    act(() => {
      field.focus()
    })
    act(() => {
      // interactive-widget=resizes-content : les deux fenêtres se réduisent.
      setLayoutHeight(470)
      setVisualHeight(470)
      window.dispatchEvent(new Event('resize'))
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('true')
    expect(screen.getByTestId('height').textContent).toBe('800')
  })

  it('reprend la hauteur réelle à la fermeture du clavier', () => {
    render(<Probe />)
    const field = screen.getByTestId('field')

    act(() => {
      field.focus()
    })
    act(() => {
      setVisualHeight(470)
    })
    act(() => {
      field.blur()
      setVisualHeight(800)
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('false')
    expect(screen.getByTestId('height').textContent).toBe('800')
  })

  it('suit un vrai redimensionnement de fenêtre, hors saisie', () => {
    render(<Probe />)

    act(() => {
      setLayoutHeight(640)
      setVisualHeight(640)
      window.dispatchEvent(new Event('resize'))
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('false')
    expect(screen.getByTestId('height').textContent).toBe('640')
  })

  it('ne verrouille pas sur un champ qui n’ouvre pas de clavier', () => {
    render(<Probe />)
    const checkbox = screen.getByTestId('checkbox')

    act(() => {
      checkbox.focus()
    })
    act(() => {
      setVisualHeight(470)
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('false')
    expect(screen.getByTestId('height').textContent).toBe('800')
  })

  it('ne verrouille pas quand la barre d’adresse se replie pendant la saisie', () => {
    render(<Probe />)
    const field = screen.getByTestId('field')

    act(() => {
      field.focus()
    })
    act(() => {
      setVisualHeight(740)
    })

    expect(screen.getByTestId('keyboard').textContent).toBe('false')
  })
})
