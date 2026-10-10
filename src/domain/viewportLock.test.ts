import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FIELD_VISIBLE_MARGIN_PX,
  KEYBOARD_MIN_LOSS_PX,
  MAP_RESIZE_MIN_DELTA_PX,
  fieldScrollShift,
  keyboardIsOpen,
  resolveShellHeight,
  shouldResizeMap,
  summonsKeyboard,
} from './viewportLock'

/**
 * Non-régression du bug du 10 octobre 2026 : au toucher du champ « On va où ? »,
 * l'ouverture du clavier mobile étirait la page vers le haut, rognait l'en-tête
 * et recalculait la carte. Les décisions sont testées ici, la mise en page qui
 * en découle est contrôlée en fin de fichier.
 */

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, '../App.css'), 'utf8')
const mapSource = readFileSync(resolve(here, '../components/TransitMap.tsx'), 'utf8')
const indexHtml = readFileSync(resolve(here, '../../index.html'), 'utf8')

describe('détection du clavier virtuel', () => {
  it('ne voit aucun clavier hors saisie, même fenêtre réduite', () => {
    expect(
      keyboardIsOpen({ layoutHeight: 480, visualHeight: 460, editing: false, lockedHeight: 800 }),
    ).toBe(false)
  })

  it('reconnaît le clavier qui ne réduit que la fenêtre visuelle (iOS, Chrome par défaut)', () => {
    expect(
      keyboardIsOpen({ layoutHeight: 800, visualHeight: 470, editing: true, lockedHeight: 800 }),
    ).toBe(true)
  })

  it('reconnaît le clavier qui réduit la fenêtre de mise en page (interactive-widget=resizes-content)', () => {
    expect(
      keyboardIsOpen({ layoutHeight: 480, visualHeight: 480, editing: true, lockedHeight: 800 }),
    ).toBe(true)
  })

  it('ignore la barre d’adresse mobile qui se replie : la perte reste sous le seuil', () => {
    const loss = KEYBOARD_MIN_LOSS_PX - 1
    expect(
      keyboardIsOpen({ layoutHeight: 800, visualHeight: 800 - loss, editing: true, lockedHeight: 800 }),
    ).toBe(false)
  })

  it('fonctionne sans window.visualViewport, d’après la seule hauteur verrouillée', () => {
    expect(
      keyboardIsOpen({ layoutHeight: 480, visualHeight: null, editing: true, lockedHeight: 800 }),
    ).toBe(true)
    expect(
      keyboardIsOpen({ layoutHeight: 800, visualHeight: null, editing: true, lockedHeight: 800 }),
    ).toBe(false)
  })
})

describe('hauteur du conteneur de l’application', () => {
  it('conserve la hauteur verrouillée pendant toute l’ouverture du clavier', () => {
    expect(
      resolveShellHeight({ layoutHeight: 480, visualHeight: 470, editing: true, lockedHeight: 800 }),
    ).toBe(800)
  })

  it('suit la fenêtre réelle dès que le clavier est refermé', () => {
    expect(
      resolveShellHeight({ layoutHeight: 800, visualHeight: 800, editing: false, lockedHeight: 800 }),
    ).toBe(800)
    // Rotation tenue, clavier fermé : la nouvelle hauteur s’applique.
    expect(
      resolveShellHeight({ layoutHeight: 380, visualHeight: 380, editing: false, lockedHeight: 800 }),
    ).toBe(380)
  })
})

describe('champs qui appellent le clavier', () => {
  it('reconnaît la saisie texte, le textarea et le contenu éditable', () => {
    expect(summonsKeyboard({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(summonsKeyboard({ tagName: 'INPUT' })).toBe(true)
    expect(summonsKeyboard({ tagName: 'INPUT', type: 'search' })).toBe(true)
    expect(summonsKeyboard({ tagName: 'TEXTAREA' })).toBe(true)
    expect(summonsKeyboard({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('écarte ce qui n’ouvre pas de clavier', () => {
    expect(summonsKeyboard({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(summonsKeyboard({ tagName: 'INPUT', type: 'radio' })).toBe(false)
    expect(summonsKeyboard({ tagName: 'INPUT', type: 'range' })).toBe(false)
    expect(summonsKeyboard({ tagName: 'SELECT' })).toBe(false)
    expect(summonsKeyboard({ tagName: 'BUTTON' })).toBe(false)
    expect(summonsKeyboard(null)).toBe(false)
  })
})

describe('recalcul de la carte', () => {
  const previous = { width: 390, height: 260 }

  it('est refusé pendant l’ouverture du clavier, quelle que soit la taille', () => {
    expect(shouldResizeMap({ previous, next: { width: 390, height: 90 }, keyboardOpen: true })).toBe(false)
  })

  it('ignore les arrondis de mise en page', () => {
    const jitter = MAP_RESIZE_MIN_DELTA_PX - 1
    expect(
      shouldResizeMap({ previous, next: { width: 390 + jitter, height: 260 }, keyboardOpen: false }),
    ).toBe(false)
  })

  it('accepte un vrai changement de taille, clavier fermé', () => {
    expect(
      shouldResizeMap({ previous, next: { width: 390, height: 340 }, keyboardOpen: false }),
    ).toBe(true)
  })

  it('n’exige rien quand la taille revient à l’identique après le clavier', () => {
    expect(shouldResizeMap({ previous, next: previous, keyboardOpen: false })).toBe(false)
  })
})

describe('champ ramené dans la partie visible', () => {
  it('ne déplace rien quand le champ est déjà lisible', () => {
    expect(
      fieldScrollShift({ fieldTop: 300, fieldBottom: 346, visibleTop: 260, visibleBottom: 470 }),
    ).toBe(0)
  })

  it('défile vers le bas du minimum nécessaire quand le clavier couvre le champ', () => {
    expect(
      fieldScrollShift({ fieldTop: 430, fieldBottom: 476, visibleTop: 260, visibleBottom: 470 }),
    ).toBe(476 - (470 - FIELD_VISIBLE_MARGIN_PX))
  })

  it('défile vers le haut quand le champ est passé au-dessus de la partie visible', () => {
    expect(
      fieldScrollShift({ fieldTop: 240, fieldBottom: 286, visibleTop: 260, visibleBottom: 470 }),
    ).toBe(240 - (260 + FIELD_VISIBLE_MARGIN_PX))
  })
})

/** Découpe la feuille de style en règles plates (les @media sont traversées).
 * Les commentaires sont retirés d'abord : ils précèdent souvent un sélecteur et
 * fausseraient sa reconnaissance. */
function cssRules(source: string): Array<{ selectors: string[]; body: string }> {
  const rules: Array<{ selectors: string[]; body: string }> = []
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selectors: match[1].split(',').map((selector) => selector.trim()).filter(Boolean),
      body: match[2],
    })
  }
  return rules
}

function fontSizeOf(body: string): number | null {
  const match = /font-size:\s*([\d.]+)px/.exec(body)
  return match ? Number.parseFloat(match[1]) : null
}

describe('mise en page verrouillée (feuille de style)', () => {
  const rules = cssRules(css)
  /** Tous les corps de règles portant exactement ce sélecteur. */
  const bodiesFor = (selector: string) =>
    rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body)

  it('donne à la coquille une hauteur verrouillée, sans unité de fenêtre dynamique', () => {
    const shells = bodiesFor('.app-shell')
    expect(shells.length).toBeGreaterThan(0)
    expect(shells.some((body) => body.includes('height: var(--app-height, 100svh)'))).toBe(true)
    expect(shells.some((body) => body.includes('overflow: hidden'))).toBe(true)
    // Aucune hauteur dynamique, aucune hauteur minimale qui ferait déborder la
    // coquille sur une fenêtre basse et rognerait son en-tête.
    expect(shells.every((body) => !body.includes('dvh'))).toBe(true)
    expect(shells.every((body) => !body.includes('min-height: 600px'))).toBe(true)
  })

  it('empêche le corps de page de grandir ou de défiler', () => {
    const bodies = bodiesFor('body')
    expect(bodies.some((body) => body.includes('position: fixed'))).toBe(true)
    expect(bodies.some((body) => body.includes('overflow: hidden'))).toBe(true)
    expect(bodies.some((body) => body.includes('overscroll-behavior: none'))).toBe(true)
  })

  it('fige la mise en page pendant l’ouverture du clavier', () => {
    expect(bodiesFor('.app-shell.is-keyboard-open *').some((body) => body.includes('transition: none !important'))).toBe(true)
  })

  it('exprime la ligne de la carte en pourcentage de la coquille', () => {
    const explores = bodiesFor('.app-shell.tab-explore')
    const rows = explores.filter((body) => body.includes('grid-template-rows'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((body) => body.includes('grid-template-rows: minmax(0, 33.333%) minmax(0, 1fr)'))).toBe(true)
    expect(explores.every((body) => !body.includes('dvh'))).toBe(true)
  })

  it('coupe le double tap zoom sur le champ de recherche', () => {
    expect(bodiesFor('.search-form').some((body) => body.includes('touch-action: manipulation'))).toBe(true)
  })
})

describe('champs de saisie à 16 px au minimum', () => {
  /** Sélecteurs de champs qui appellent le clavier mobile. */
  const keyboardFields = [
    '.search-form input',
    '.explore-search-form input',
    '.point-search-input',
    '.assistant-form input',
    '.street-field input',
    '.street-field textarea',
    '.console-form input',
    '.console-form textarea',
    '.console-login input',
  ]

  it('n’écrit jamais une taille de police sous 16 px sur ces champs', () => {
    const offenders: string[] = []
    for (const rule of cssRules(css)) {
      const matches = rule.selectors.some((selector) =>
        keyboardFields.some((field) => selector === field || selector.endsWith(` ${field}`)),
      )
      if (!matches) continue
      const size = fontSizeOf(rule.body)
      if (size !== null && size < 16) offenders.push(`${rule.selectors.join(', ')} → ${size}px`)
    }
    expect(offenders).toEqual([])
  })

  it('déclare bien 16 px sur le champ « On va où ? »', () => {
    for (const selector of ['.search-form input', '.explore-search-form input']) {
      const sizes = cssRules(css)
        .filter((rule) => rule.selectors.includes(selector))
        .map((rule) => fontSizeOf(rule.body))
        .filter((size): size is number => size !== null)
      expect(sizes.length).toBeGreaterThan(0)
      expect(sizes.every((size) => size >= 16)).toBe(true)
    }
  })
})

describe('carte et fenêtre : garde-fous hors CSS', () => {
  it('retire à Leaflet l’écoute automatique du resize', () => {
    expect(mapSource).toContain('trackResize={false}')
    expect(mapSource).toContain('MapResizeController')
    expect(mapSource).toContain('shouldResizeMap')
  })

  it('demande au navigateur de ne redimensionner que la fenêtre visuelle', () => {
    expect(indexHtml).toContain('interactive-widget=resizes-visual')
    // Le zoom volontaire de l’usager reste possible : pas de user-scalable=no.
    expect(indexHtml).not.toContain('user-scalable=no')
  })
})
