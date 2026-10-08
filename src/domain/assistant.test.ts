import { describe, expect, it } from 'vitest'
import { answerAssistant, extractJourneyRequest, type AssistantContext } from './assistant'

const CONTEXT: AssistantContext = { publishedAvailable: false, adminOnline: true }

describe('assistant mobilité', () => {
  it('maîtrise les 23 stations BRT et les 13 gares TER', () => {
    const brt = answerAssistant('Quelles sont les stations du BRT ?', CONTEXT)
    expect(brt).toContain('23')
    expect(brt).toContain('Préfecture de Guédiawaye')
    expect(brt).toContain('Petersen')
    const ter = answerAssistant('liste des gares TER', CONTEXT)
    expect(ter).toContain('13')
    expect(ter).toContain('Diamniadio')
    expect(ter).toContain('Rufisque')
  })

  it('répond à « prochain BRT vers Guédiawaye » sans inventer d’heure de passage', () => {
    const answer = answerAssistant('Quel est le prochain BRT vers Guédiawaye ?', CONTEXT)
    expect(answer).toContain('Guédiawaye')
    expect(answer).toMatch(/6 min|toutes les 6/)
    expect(answer).toContain('jamais une heure de passage inventée')
    expect(answer).not.toMatch(/\bdans \d+ min\b/)
  })

  it('calcule un itinéraire multimodal en langage naturel', () => {
    const answer = answerAssistant('trajet de Petersen à Rufisque', CONTEXT)
    expect(answer).toContain('Itinéraire de référence')
    expect(answer).toContain('TER')
    expect(answer).toMatch(/min/)
  })

  it('combine BRT et TER avec correspondance quand c’est nécessaire', () => {
    const answer = answerAssistant('comment aller de Préfecture de Guédiawaye à Diamniadio', CONTEXT)
    expect(answer).toContain('correspondance')
    expect(answer).toContain('TER')
    expect(answer).toContain('B1')
  })

  it('dit honnêtement qu’un lieu non desservi n’est pas deviné', () => {
    const answer = answerAssistant('est-ce que le BRT va à Mbour ?', CONTEXT)
    expect(answer).toContain('plutôt que deviner')
  })

  it('ne fabrique aucune alerte de perturbation', () => {
    const answer = answerAssistant('y a-t-il des perturbations sur le BRT ?', CONTEXT)
    expect(answer).toContain('aucune alerte vérifiable')
    expect(answer).toContain('cetud.sn')
  })

  it('donne l’état réel des données quand on le demande', () => {
    const answer = answerAssistant('où en sont les données publiées ?', CONTEXT)
    expect(answer).toContain('aucun snapshot GTFS n’est publié')
    expect(answer).toContain('en ligne')
    const offline = answerAssistant('où en sont les données publiées ?', { publishedAvailable: false, adminOnline: false })
    expect(offline).toContain('npm run admin:api')
  })

  it('extrait un couple origine/destination d’une phrase naturelle', () => {
    const request = extractJourneyRequest('Comment aller de Colobane à Bargny ?')
    expect(request?.origin.label).toBe('Colobane')
    expect(request?.destination.label).toBe('Bargny')
    expect(extractJourneyRequest('bonjour')).toBeNull()
  })
})
