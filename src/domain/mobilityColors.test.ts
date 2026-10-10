import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORRIDOR_LINES } from './corridors'
import {
  MOBILITY_IDS,
  MOBILITY_PALETTE,
  mobilityFromLabel,
  mobilityFromStopId,
  mobilityIdFromToken,
  mobilitySpans,
} from './mobilityColors'

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../App.css'), 'utf8')

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

const OFFICIAL_PAIRS: Record<string, readonly [string, string]> = {
  ter: ['#003366', '#1D4ED8'],
  brt: ['#00A859', '#10B981'],
  ddd: ['#F59E0B', '#EAB308'],
  aftu: ['#D97706', '#C05621'],
  tata: ['#C05621', '#D97706'],
}

describe('code couleur officiel des mobilités', () => {
  it('fixe les paires officielles, sans teinte inventée hors AFTU/TATA', () => {
    for (const id of MOBILITY_IDS) {
      const paint = MOBILITY_PALETTE[id]
      const [badge, bright] = OFFICIAL_PAIRS[id]
      expect(paint.badge.toLowerCase()).toBe(badge.toLowerCase())
      expect(paint.bright.toLowerCase()).toBe(bright.toLowerCase())
      expect([paint.core, paint.casing].map((hex) => hex.toLowerCase()).sort()).toEqual([badge, bright].map((hex) => hex.toLowerCase()).sort())
    }
    const aftuTata = new Set([
      MOBILITY_PALETTE.aftu.badge,
      MOBILITY_PALETTE.aftu.bright,
      MOBILITY_PALETTE.tata.badge,
      MOBILITY_PALETTE.tata.bright,
    ].map((hex) => hex.toLowerCase()))
    expect(aftuTata).toEqual(new Set(['#d97706', '#c05621']))
    expect(MOBILITY_PALETTE.aftu.badge.toLowerCase()).not.toBe(MOBILITY_PALETTE.tata.badge.toLowerCase())
  })

  it('garde un texte de pastille lisible (AA 4,5:1) sur chaque fond officiel', () => {
    for (const id of MOBILITY_IDS) {
      const paint = MOBILITY_PALETTE[id]
      expect(contrastRatio(paint.ink, paint.badge), id).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('publie les mêmes hexadécimaux dans la feuille de style', () => {
    for (const id of MOBILITY_IDS) {
      const paint = MOBILITY_PALETTE[id]
      expect(css).toMatch(new RegExp(`--mobility-${id}:\\s*${paint.badge}`, 'i'))
      expect(css).toMatch(new RegExp(`--mobility-${id}-bright:\\s*${paint.bright}`, 'i'))
      expect(css).toMatch(new RegExp(`--mobility-${id}-ink:\\s*${paint.ink}`, 'i'))
    }
  })

  it('aligne la couleur de tracé TER/BRT sur le cœur officiel', () => {
    const ter = CORRIDOR_LINES.find((line) => line.network === 'ter')
    const brt = CORRIDOR_LINES.find((line) => line.network === 'brt')
    expect(ter?.color.toLowerCase()).toBe(MOBILITY_PALETTE.ter.core.toLowerCase())
    expect(brt?.color.toLowerCase()).toBe(MOBILITY_PALETTE.brt.core.toLowerCase())
  })

  it('reconnaît les sigles sans colorer un mot qui les contient', () => {
    expect(mobilityIdFromToken('B1')).toBe('brt')
    expect(mobilityIdFromToken('SunuBRT')).toBe('brt')
    expect(mobilityFromLabel('Démo — Médina')).toBeNull()
    expect(mobilityFromLabel('TER + B1')).toBeNull()
    expect(mobilityFromLabel('AFTU 53')).toBe('aftu')
    expect(mobilityFromStopId('ter-dakar')).toBe('ter')
    expect(mobilityFromStopId('brt-petersen')).toBe('brt')
    expect(mobilityFromStopId('published-12')).toBeNull()
    const spans = mobilitySpans('Source SETER, prendre le TER puis le B1.')
    expect(spans.filter((span) => span.kind === 'sigil').map((span) => span.text)).toEqual(['TER', 'B1'])
  })
})
