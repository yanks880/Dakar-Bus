import { describe, expect, it } from 'vitest'
import { answerMobilityKnowledge, BUS_LINES, busKnowledgeSummary } from './mobilityKnowledge'
import { copilotAnswer } from './copilot'
import { createConversationMemory } from './conversation'
import { answerAssistant } from './assistant'

const context = { publishedAvailable: false, adminOnline: false }
function ask(question: string) { return answerMobilityKnowledge(question)?.text ?? '' }

describe('mémoire documentaire consultée le 10 octobre 2026', () => {
  it('embarque 72 fiches AFTU et 37 DDD, pas un graphe ni des positions inventées', () => {
    expect(BUS_LINES.filter((line) => line.network === 'aftu')).toHaveLength(72)
    expect(BUS_LINES.filter((line) => line.network === 'ddd')).toHaveLength(37)
    expect(BUS_LINES.filter((line) => line.waypoints.length)).toHaveLength(20)
    expect(new Set(BUS_LINES.map((line) => `${line.network}:${line.code}`)).size).toBe(109)
    expect(busKnowledgeSummary()).toContain('n’est pas exhaustif')
    for (const line of BUS_LINES) {
      expect(line.consultedAt).toBe('2026-10-10')
      expect(new URL(line.sourceUrl).protocol).toBe('https:')
      expect(line.origin.length).toBeGreaterThan(1)
      expect(line.destination.length).toBeGreaterThan(1)
      if (line.waypoints.length) expect(line.detailSourceUrl).toBeTruthy()
      expect(line).not.toHaveProperty('lat')
      expect(line).not.toHaveProperty('nextDepartureAt')
    }
  })

  it('ne confond pas le même numéro sur DDD et AFTU', () => {
    expect(ask('ligne 1')).toContain('Précisez DDD ou AFTU')
    expect(ask('DDD 01')).toContain('Place Leclerc')
    expect(ask('AFTU ligne 1')).toContain('Lat Dior')
    expect(ask('AFTU ligne 1')).toContain('Grand Médine')
    expect(ask('AFTU ligne 1')).toContain('terminus à confirmer')
  })

  it('donne le parcours AFTU récent plutôt que le parcours historique CETUD', () => {
    const result = ask('itinéraire AFTU 53')
    expect(result).toContain('Terminus Keur Massar (Marché)')
    expect(result).toContain('Sococim → Bargny → Diamniadio')
    expect(result).toContain('publication du 2026-07-06')
    expect(result).toContain('remplace ici le parcours Lac Rose')
    expect(result).toContain('pas une liste d’arrêts géolocalisés')
  })

  it('accepte TATA comme formulation usager avec clarification AFTU', () => {
    expect(ask('TATA 42')).toContain('Si vous désignez la ligne AFTU')
    expect(ask('TATA 42')).toContain('Boutikou Diallo')
  })

  it('signale les divergences, y compris celles présentes chez un opérateur', () => {
    for (const code of ['23', '217', '233']) expect(ask(`DDD ${code}`)).toContain('Divergence dans la source')
  })

  it('ne fabrique pas les points de passage non transcrits', () => {
    expect(ask('ligne AFTU 91')).toContain('APIX ↔ Dougar')
    expect(ask('ligne AFTU 91')).toContain('pas encore transcrit')
    expect(ask('bus DDD 999')).toContain('n’est pas documentée')
  })

  it('ne donne ni fréquence ni tarif pour une ligne bus non documentée sur ce point', () => {
    expect(ask('prochain bus AFTU 53')).toContain('Aucun prochain départ fiable')
    expect(ask('horaires DDD 1')).not.toMatch(/dans \d+ min/)
    expect(ask('prix DDD 1')).toContain('Tarif de cette ligne non documenté')
  })

  it('trouve une piste de trajet dans le sens textuel publié sans la géocoder', () => {
    const result = ask('trajet DDD de Ouakam à UCAD')
    expect(result).toContain('DDD 7')
    expect(result).toContain('ni durée, ni prochain départ garanti')
    expect(ask('trajet AFTU de Keur Massar à Sébikotane')).toContain('AFTU 53')
  })

  it('n’inverse pas un parcours ou ne garantit pas une correspondance bus', () => {
    expect(ask('trajet AFTU de Sébikotane à Keur Massar')).toContain('pas de parcours direct dans le sens demandé')
  })

  it('préserve le calculateur TER/BRT existant pour ses parcours', () => {
    expect(answerMobilityKnowledge('trajet de Petersen à Rufisque')).toBeNull()
    expect(copilotAnswer('trajet de Petersen à Rufisque', context, createConversationMemory(), 'fr').journey).toBeTruthy()
  })

  it('garde la fiche bus pour un suivi sans réutiliser un ancien trajet TER', () => {
    const memory = createConversationMemory()
    copilotAnswer('trajet de Petersen à Rufisque', context, memory, 'fr')
    const line = copilotAnswer('DDD 1', context, memory, 'fr')
    expect(line.journey).toBeUndefined()
    expect(memory.lastJourney).toBeNull()
    expect(memory.lastKnowledgeLineId).toBe('ddd:1')
    const next = copilotAnswer('Et ses horaires ?', context, memory, 'fr')
    expect(next.text).toContain('DDD 1')
    expect(next.text).toContain('Aucun prochain départ fiable')
  })

  it('répond hors ligne aux tarifs BRT et TER sans réclamer un GTFS', () => {
    expect(ask('tarif BRT')).toContain('400 F CFA')
    expect(ask('prix TER')).toContain('1 500 F CFA')
    const combined = answerAssistant('Quels sont les tarifs TER et BRT ?', context)
    expect(combined).toContain('400 F CFA')
    expect(combined).toContain('2 500 F CFA')
    expect(combined).not.toContain('aucun tarif fiable')
  })

  it('différencie gratuité TER et BRT, et validation des titres', () => {
    expect(ask('enfant gratuit TER')).toContain('moins de 5 ans')
    expect(ask('enfant gratuit BRT')).toContain('accompagnés de moins de 4 ans')
    expect(ask('Comment valider BRT ?')).toContain('entrée ET à la sortie')
    expect(ask('acheter carte BRT')).toContain('site était en maintenance')
  })

  it('distingue service client et amplitude de transport', () => {
    const result = ask('contact SunuBRT')
    expect(result).toContain('76 215 15 15')
    expect(result).toContain('pas celles des bus')
  })

  it('ne déduit pas une correspondance validée d’un simple point de passage', () => {
    expect(ask('correspondance DDD 1 TER')).toContain('le chemin piéton')
    expect(ask('correspondance AFTU 53 TER')).toContain('Aucune correspondance garantie')
  })

  it('ne confirme pas le service semi-express depuis une page en maintenance', () => {
    expect(ask('BRT B3')).toContain('ne confirme pas leur service actuel')
  })

  it('précise les directions et les jours pour les horaires TER', () => {
    expect(ask('horaires TER')).toContain('05h35 de Diamniadio, 05h45 de Dakar')
    expect(ask('horaires TER')).toContain('Dimanches et jours fériés')
    expect(ask('horaires TER')).toContain('ne sont pas celles de chaque gare intermédiaire')
  })

  it('ne transforme pas une statistique CETUD ou une page institutionnelle en temps réel', () => {
    expect(ask('circulation à Dakar')).toContain('statistiques historiques')
    expect(ask('TER vers AIBD')).toContain('ne suffisent pas à confirmer')
    const weather = copilotAnswer('température maintenant à Dakar', context, createConversationMemory(), 'fr')
    expect(weather.text).toContain('aucune source météo connectée')
    expect(weather.text).not.toMatch(/\d+\s*°/)
  })
})
