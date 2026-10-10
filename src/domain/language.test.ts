// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  detectLanguage,
  loadAssistantLanguagePreference,
  resolveResponseLanguage,
  saveAssistantLanguagePreference,
} from './language'

describe('détection de langue français / wolof / mixte', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('reconnaît le français standard', () => {
    expect(detectLanguage('Quel est le prochain BRT vers Guédiawaye ?')).toBe('fr')
    expect(detectLanguage('Trajet de Petersen à Rufisque')).toBe('fr')
    expect(detectLanguage('bonjour')).toBe('fr')
  })

  it('reconnaît le wolof par ses marqueurs non ambigus', () => {
    expect(detectLanguage('Nanga def, dama bëgg a dem Guédiawaye')).toBe('wo')
    expect(detectLanguage('Fan la station bi gën a jege?')).toBe('wo')
    expect(detectLanguage('Lu tax nga tann yoon wii ?')).toBe('wo')
    expect(detectLanguage('Jërëjëf')).toBe('wo')
  })

  it('signale les phrases mixtes français-wolof', () => {
    expect(detectLanguage('Je veux dem ci Guédiawaye, ndax am na BRT ?')).toBe('mixed')
  })

  it('ne devine pas une langue sans marqueur exploitable', () => {
    expect(detectLanguage('xyz')).toBe('undetermined')
    expect(detectLanguage('')).toBe('undetermined')
  })

  it('résout la langue de réponse selon la préférence et la détection', () => {
    expect(resolveResponseLanguage('fr', 'wo')).toBe('fr')
    expect(resolveResponseLanguage('wo', 'fr')).toBe('wo')
    expect(resolveResponseLanguage('auto', 'wo')).toBe('wo')
    expect(resolveResponseLanguage('auto', 'mixed')).toBe('wo')
    expect(resolveResponseLanguage('auto', 'fr')).toBe('fr')
    expect(resolveResponseLanguage('auto', 'undetermined')).toBe('fr')
  })

  it('persiste la préférence de langue sans la conversation', () => {
    window.localStorage.clear()
    saveAssistantLanguagePreference('wo')
    expect(loadAssistantLanguagePreference()).toBe('wo')
    saveAssistantLanguagePreference('auto')
    expect(loadAssistantLanguagePreference()).toBe('auto')
    window.localStorage.setItem('dakar-bus:assistant-language', 'nimportequoi')
    expect(loadAssistantLanguagePreference('fr')).toBe('fr')
  })
})
