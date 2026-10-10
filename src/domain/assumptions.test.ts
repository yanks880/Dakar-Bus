import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORRIDOR_LINES } from './corridors'
import {
  BOARDING_WAIT_FRACTION,
  DEFAULT_DWELL_MIN,
  DWELL_MIN,
  MAX_ACCESS_M,
  REFERENCE_COMMERCIAL_SPEED_KPH,
  TRANSFER_BUFFER_MIN,
  WALK_SPEED_MPM,
  dwellMinutes,
  walkDisplayMinutes,
} from './assumptions'

describe('hypothèses du moteur', () => {
  it('conserve les valeurs déjà utilisées par le calculateur TER/BRT et ajoute DDD/AFTU/TATA en pointillés', () => {
    expect(WALK_SPEED_MPM).toBe(80)
    expect(TRANSFER_BUFFER_MIN).toBe(3)
    expect(MAX_ACCESS_M).toBe(1200)
    expect(DWELL_MIN).toEqual({ ter: 1, brt: 0.5 })
    expect(DEFAULT_DWELL_MIN).toBe(0.5)
    expect(BOARDING_WAIT_FRACTION).toBe(0.5)
    // Après ajustement visuel : TER/BRT continus, DDD/AFTU/TATA en pointillés légers avec vitesses de référence
    expect(REFERENCE_COMMERCIAL_SPEED_KPH.ter).toBe(55)
    expect(REFERENCE_COMMERCIAL_SPEED_KPH.brt).toBe(25)
    expect(REFERENCE_COMMERCIAL_SPEED_KPH.ddd).toBe(18)
    expect(REFERENCE_COMMERCIAL_SPEED_KPH.aftu).toBe(16)
    expect(REFERENCE_COMMERCIAL_SPEED_KPH.tata).toBe(15)
  })

  it('ne déclare aucune fréquence DDD, AFTU ou TATA (seulement vitesses pour pointillés)', () => {
    // Les vitesses DDD/AFTU/TATA sont désormais autorisées pour l'affichage pointillé léger
    expect(DWELL_MIN).not.toHaveProperty('ddd')
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './assumptions.ts'), 'utf8')
    expect(source).not.toMatch(/headwayMinutes/)
    expect(source).toContain('frequencies.ts')
  })

  it('replie un réseau sans hypothèse nommée sur l’ancien 0,5 min, sans le présenter comme un fait', () => {
    expect(dwellMinutes('ter')).toBe(1)
    expect(dwellMinutes('brt')).toBe(0.5)
    expect(dwellMinutes('ddd')).toBe(0.5)
    expect(dwellMinutes('aftu')).toBe(0.5)
    expect(dwellMinutes('inconnu')).toBe(DEFAULT_DWELL_MIN)
  })

  it('branche les vitesses de référence sur la source unique', () => {
    const ter = CORRIDOR_LINES.find((line) => line.network === 'ter')
    const brt = CORRIDOR_LINES.find((line) => line.network === 'brt')
    expect(ter?.speedKph).toBe(REFERENCE_COMMERCIAL_SPEED_KPH.ter)
    expect(brt?.speedKph).toBe(REFERENCE_COMMERCIAL_SPEED_KPH.brt)
  })

  it('calcule la marche affichée comme avant : au moins une minute, arrondi supérieur', () => {
    expect(walkDisplayMinutes(0)).toBe(1)
    expect(walkDisplayMinutes(80)).toBe(1)
    expect(walkDisplayMinutes(81)).toBe(2)
    expect(walkDisplayMinutes(1200)).toBe(15)
  })

  it('garde l’attente d’embarquement égale à la moitié du headway officiel', () => {
    expect(6 * BOARDING_WAIT_FRACTION).toBe(3)
    expect(10 * BOARDING_WAIT_FRACTION).toBe(5)
    expect(20 * BOARDING_WAIT_FRACTION).toBe(10)
  })
})
