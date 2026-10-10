import { describe, expect, it } from 'vitest'
import { answerAssistant, extractJourneyRequest, getAssistantCountdownMinutes, type AssistantContext } from './assistant'

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
    expect(answer).toContain('aucune heure de prochain passage fiable')
    expect(answer).toContain('fréquence seule ne permet pas de déduire')
    expect(answer).toContain('vérification en ligne non documentée')
    expect(answer).not.toMatch(/\bdans \d+ min\b/)
  })

  it('distingue les périodes TER et ne présente pas une référence comme un départ', () => {
    const answer = answerAssistant('Quelle est la fréquence du TER ?', CONTEXT)
    expect(answer).toContain('05h35 de Diamniadio, 05h45 de Dakar')
    expect(answer).toContain('21h05 à 22h05')
    expect(answer).toContain('06h25 à 22h05')
    expect(answer).toContain('Consultée le 2026-10-10')
    expect(answer).not.toMatch(/prochain.*dans \d+ min/i)
  })

  it('ne donne pas de fréquence uniforme ni de compte à rebours DDD/AFTU', () => {
    const ddd = answerAssistant('Quelle est la fréquence de DDD ?', CONTEXT)
    expect(ddd).toContain('38 lignes')
    expect(ddd).toContain('400 bus')
    expect(ddd.toLowerCase()).toContain('fréquences non publiées ligne par ligne')
    expect(ddd).not.toMatch(/dans \d+ min/)

    const aftu = answerAssistant('Quand passe le prochain bus AFTU ?', CONTEXT)
    expect(aftu).toContain('72 lignes')
    expect(aftu.replace(/\s/g, ' ')).toContain('2 300 bus')
    expect(aftu).toContain('14 GIE')
    expect(aftu.toLowerCase()).toContain('aucun prochain départ fiable')
  })

  it('ne calcule le délai que depuis un départ exact programmé du bon réseau', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    const scheduled: AssistantContext = {
      ...CONTEXT,
      nextDepartureAt: { network: 'brt', status: 'SCHEDULED', nextDepartureAt: '2026-10-08T12:05:01Z' },
    }
    expect(getAssistantCountdownMinutes('Dans combien de temps le BRT ?', scheduled, now)).toBe(6)
    expect(getAssistantCountdownMinutes('Dans combien de temps le TER ?', scheduled, now)).toBeNull()
    expect(answerAssistant('Dans combien de temps le BRT ?', scheduled, now)).toContain('dans 6 min')
    const expired: AssistantContext = {
      ...CONTEXT,
      nextDepartureAt: { network: 'brt', status: 'SCHEDULED', nextDepartureAt: '2026-10-08T12:00:00Z' },
    }
    expect(getAssistantCountdownMinutes('Dans combien de temps le BRT ?', expired, now)).toBeNull()
    expect(answerAssistant('Dans combien de temps le BRT ?', expired, now)).not.toMatch(/dans \d+ min/)
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

  it('comprend une phrase libre et sert l’itinéraire sans rien redemander', () => {
    const answer = answerAssistant('Comment faire pour aller à Dakar ? Je suis à Keur Mbaye Fall', CONTEXT)
    expect(answer).toContain('Itinéraire de référence Keur Mbaye Fall → Dakar')
    expect(answer).toContain('TER')
    expect(answer).not.toContain('Quel est votre point de départ')
    expect(answer).not.toContain('Indiquez « trajet de')
    // L’ordre des propositions ne change pas le résultat.
    expect(answerAssistant('je suis à Parcelles Assainies, je vais à Diamniadio', CONTEXT))
      .toContain('Itinéraire de référence Parcelles → Diamniadio')
  })

  it('propose un itinéraire concret pour un lieu seul, sans phrase toute faite', () => {
    for (const place of ['Parcelles Assainies', 'Petersen', 'Rufisque', 'Keur Mbaye Fall']) {
      const answer = answerAssistant(place, CONTEXT)
      expect(answer).not.toMatch(/Quel est votre point de départ|Destination non reconnue/)
      expect(answer).toMatch(/(gare\/halte TER|station BRT|fiches documentaires)/)
    }
    const parcelles = answerAssistant('Parcelles Assainies', CONTEXT)
    expect(parcelles).toContain('B1')
    expect(parcelles).toContain('Itinéraire repère')
  })

  it('extrait un couple origine/destination d’une phrase naturelle', () => {
    const request = extractJourneyRequest('Comment aller de Colobane à Bargny ?')
    expect(request?.origin.label).toBe('Colobane')
    expect(request?.destination.label).toBe('Bargny')
    expect(extractJourneyRequest('bonjour')).toBeNull()
  })
})
