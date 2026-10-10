import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Contraste WCAG 2.x des minutes d'attente. Le texte fait 10 à 14,5 px :
 * c'est du texte courant, le seuil AA est 4,5:1 (pas 3:1, réservé au grand texte).
 */

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../App.css'), 'utf8')

const LIGHT_BACKGROUNDS = [
  'surface-panel',
  'surface-card',
  'surface-sunken',
  'surface-raised',
  'green-50',
  'passage-green-tint',
] as const

function block(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`marqueur introuvable : ${marker}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  throw new Error(`bloc non fermé : ${marker}`)
}

function properties(blockText: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of blockText.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    found[match[1]] = match[2].trim()
  }
  return found
}

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const normalized = hex.trim().toLowerCase()
  if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new Error(`couleur illisible : ${hex}`)
  return 0.2126 * channel(normalized, 1) + 0.7152 * channel(normalized, 3) + 0.0722 * channel(normalized, 5)
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

const light = properties(block(css, ':root {'))
const darkExplicit = properties(block(css, ':root[data-theme="dark"]'))
const darkMedia = properties(block(css, ':root:not([data-theme="light"])'))

describe('contraste des minutes d’attente', () => {
  it('reproduit le constat d’audit : #00B140 sur #fafdfc est sous AA', () => {
    expect(contrastRatio('#00B140', '#fafdfc')).toBeCloseTo(2.79, 2)
    expect(contrastRatio('#00B140', '#e5f7ec')).toBeLessThan(4.5)
  })

  it('assombrit le vert clair sans quitter la teinte Dakar, et garde #00B140 au sombre', () => {
    expect(light['passage-green']?.toLowerCase()).toBe('#007a2d')
    expect(light['passage-green-tint']?.toLowerCase()).toBe('#e5f7ec')
    expect(darkExplicit['passage-green']?.toLowerCase()).toBe('#00b140')
    expect(darkExplicit['passage-green-tint']?.toLowerCase()).toBe('#0f291e')
    expect(darkMedia['passage-green']).toBe(darkExplicit['passage-green'])
    expect(darkMedia['passage-green-tint']).toBe(darkExplicit['passage-green-tint'])
  })

  it('atteint 4,5:1 sur chaque fond où les minutes sont écrites, clair et sombre', () => {
    for (const name of LIGHT_BACKGROUNDS) {
      expect(contrastRatio(light['passage-green'], light[name]), `clair ${name}`).toBeGreaterThanOrEqual(4.5)
      const darkBackground = darkExplicit[name] ?? light[name]
      expect(contrastRatio(darkExplicit['passage-green'], darkBackground), `sombre ${name}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('laisse les trois vues sur le même jeton, sans recopier un hexadécimal', () => {
    expect(css.match(/color:\s*var\(--passage-green\)/g)).toHaveLength(3)
    expect(css).not.toMatch(/color:\s*#00B140/i)
    expect(css).not.toMatch(/color:\s*#007A2D/i)
  })
})
