import { describe, expect, it } from 'vitest'
import { answerAssistant } from './assistant'
import { departureAdvice, extractMobilityIntent } from './intent'

const CONTEXT = { publishedAvailable: false, adminOnline: false }
const NOW = Date.parse('2026-10-10T07:00:00Z')

describe('copilote local à intentions explicites', () => {
  it('reconnaît lieux, comparaison, critères, heure Dakar et lendemain sans inventer de GPS', () => {
    const request = extractMobilityIntent('Compare les trajets de Petersen à Rufisque avant 9 h, moins de marche')
    expect(request).toMatchObject({ origin: { stopId: 'brt-petersen' }, destination: { stopId: 'ter-rufisque' }, compare: true, priority: 'lessWalking', arrivalMinutes: 540 })
    expect(extractMobilityIntent('trajet de Colobane à Bargny demain avant 09:30')).toMatchObject({ tomorrow: true, arrivalMinutes: 570 })
    expect(extractMobilityIntent('bonjour')).toBeNull()
    expect(extractMobilityIntent('je veux aller à Rufisque')?.origin).toBeNull()
  })

  it('classe sur marche et correspondances avec les mesures réelles, et refuse le prix', () => {
    expect(answerAssistant('Compare les trajets de Petersen à Rufisque, moins de marche', CONTEXT, NOW)).toMatch(/Copilote.*moins de marche/i)
    expect(answerAssistant('Trajet de Guédiawaye à Diamniadio sans correspondance', CONTEXT, NOW)).toContain('Le moins de correspondances')
    const cheapest = answerAssistant('Quel trajet de Petersen à Rufisque est le moins cher ?', CONTEXT, NOW)
    expect(cheapest).toContain('ne peux pas classer les trajets par prix')
    expect(cheapest).not.toMatch(/\b\d+\s*(?:FCFA|francs)/i)
  })

  it('ne promet pas de départ ni de service en calculant une heure cible', () => {
    const text = answerAssistant('Trajet de Petersen à Rufisque avant 9 h', CONTEXT, NOW)
    expect(text).toContain('départ estimé')
    expect(text).toContain('heure de Dakar')
    expect(text).toContain('ni un service à cette heure')
    expect(departureAdvice(540, 60, NOW)).toContain('08:00')
    expect(departureAdvice(540, 60, Date.parse('2026-10-10T12:00:00Z'))).toContain('11/10')
    expect(answerAssistant('Trajet de Petersen à Rufisque avant 25 h', CONTEXT, NOW)).toContain('Heure d’arrivée invalide')
  })

  it('demande seulement le départ manquant, sans formule figée, et refuse les lieux absents des références', () => {
    const missing = answerAssistant('Je veux aller à Rufisque avant 9h', CONTEXT, NOW)
    expect(missing).toContain('il me manque seulement votre point de départ')
    expect(missing).not.toContain('Indiquez « trajet de')
    expect(answerAssistant('trajet de Mbour à Rufisque', CONTEXT, NOW)).toContain('« mbour » n’est pas une gare')
  })
})
