import { describe, expect, it } from 'vitest'
import { assistantBounds } from './assistantBounds'

describe('bornes du panneau non modal', () => {
  for (const width of [280, 320, 390, 844, 1024, 1440]) {
    for (const height of [320, 390, 568, 844]) {
      it(`ne déborde pas en ${width} × ${height}, même avec une ancre décalée`, () => {
        const result = assistantBounds({ right: width - 25, bottom: height / 3 + 54 }, { width, height, left: 0, top: 0, keyboardOpen: false })
        expect(result.left).toBeGreaterThanOrEqual(12)
        expect(result.left + result.width).toBeLessThanOrEqual(width - 12)
        expect(result.top).toBeGreaterThanOrEqual(12)
        expect(result.top + result.maxHeight).toBeLessThanOrEqual(height)
        expect(result.maxHeight).toBeLessThanOrEqual(360)
      })
    }
  }
  it('prend en compte le viewport déplacé et réduit par le clavier ou le zoom', () => {
    const result = assistantBounds({ right: 390, bottom: 450 }, { width: 260, height: 280, left: 30, top: 100, keyboardOpen: true })
    expect(result.left).toBeGreaterThanOrEqual(42)
    expect(result.left + result.width).toBeLessThanOrEqual(278)
    expect(result.top).toBeGreaterThanOrEqual(112)
    expect(result.top + result.maxHeight).toBeLessThanOrEqual(368)
  })
})
