import { describe, expect, it } from 'vitest'
import { placeBrief, placeBriefWithQuestion, placeQuestionReply, unroutablePairReply } from './placeMemory'
import { getPlace } from './places'

const parcelles = getPlace('brt-parcelles')!
const keurMbayeFall = getPlace('ter-mbao')!
const petersen = getPlace('brt-petersen')!
const ouakam = getPlace('bus:ouakam')!

describe('mémoire du maître : fiche d’un lieu', () => {
  it('identifie une station BRT, son mode et sa desserte', () => {
    const brief = placeBrief(parcelles)
    expect(brief).toContain('station BRT')
    expect(brief).toContain('B1')
    expect(brief).toMatch(/Mode le plus adapté/)
    expect(brief).toContain('06:00–21:00')
  })

  it('donne un itinéraire réellement calculé depuis le pôle central', () => {
    const brief = placeBrief(keurMbayeFall)
    expect(brief).toContain('gare/halte TER')
    expect(brief).toContain('Itinéraire repère depuis Dakar')
    expect(brief).toMatch(/TER : Dakar → Keur Mbaye Fall/)
    expect(brief).toMatch(/Environ \d+ min/)
  })

  it('donne les correspondances déclarées quand elles existent', () => {
    expect(placeBrief(petersen)).toContain('Correspondance déclarée')
    // Sinon, la distance annoncée reste une mesure à vol d’oiseau.
    expect(placeBrief(keurMbayeFall)).toMatch(/à vol d’oiseau/)
  })

  it('dit d’où vient une fiche bus sans la transformer en arrêt', () => {
    const brief = placeBrief(ouakam)
    expect(brief).toContain('Ouakam')
    expect(brief).toMatch(/ni une gare TER ni une station BRT/)
    expect(brief).toContain('Fiches bus mentionnant ce lieu')
    expect(brief).not.toMatch(/Environ \d+ min/)
  })

  it('rappelle ses limites : ni horaire, ni temps réel, ni fréquence bus', () => {
    expect(placeBrief(keurMbayeFall)).toMatch(/ni horaire de passage, ni temps réel/)
  })
})

describe('mémoire du maître : il manque un lieu', () => {
  it('donne la fiche du lieu connu puis pose une question courte', () => {
    const reply = placeBriefWithQuestion(keurMbayeFall, 'origin')
    expect(reply).toContain('Itinéraire repère')
    expect(reply).toContain('Il me manque votre point de départ')
    expect(reply).not.toContain('Quel est votre point de départ ?')
    const destination = placeBriefWithQuestion(keurMbayeFall, 'destination')
    expect(destination).toContain('Il me manque votre destination')
  })

  it('refuse d’estimer une heure de départ sans point de départ', () => {
    expect(placeBriefWithQuestion(keurMbayeFall, 'origin', { arrivalRequested: true }))
      .toContain('aucune heure de départ')
  })

  it('demande le complément qui manque, jamais ce qui vient d’être dit', () => {
    expect(placeQuestionReply(keurMbayeFall, 'destination')).toContain('Dites-moi où vous allez')
    expect(placeQuestionReply(keurMbayeFall, 'origin')).toContain('Dites-moi d’où vous partez')
    expect(placeQuestionReply(keurMbayeFall)).toContain('en une phrase')
  })
})

describe('mémoire du maître : deux lieux non calculables', () => {
  it('documente sans inventer ni durée ni correspondance', () => {
    const reply = unroutablePairReply(ouakam, getPlace('bus:yoff')!)
    expect(reply).toContain('Ouakam')
    expect(reply).toContain('Yoff')
    expect(reply).toMatch(/je ne peux pas calculer cet itinéraire/)
    expect(reply).toMatch(/aucun arrêt géolocalisé/)
    expect(reply).not.toMatch(/Environ \d+ min de marche/)
  })

  it('sert l’itinéraire du lieu calculable quand un seul l’est', () => {
    const reply = unroutablePairReply(ouakam, getPlace('ter-diamniadio')!)
    expect(reply).toContain('Diamniadio')
    expect(reply).toContain('Itinéraire repère depuis Dakar')
    expect(reply).toContain('Ouakam')
  })
})
