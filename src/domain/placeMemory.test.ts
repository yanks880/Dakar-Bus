import { describe, expect, it } from 'vitest'
import { placeBrief, placeBriefWithQuestion, placeQuestionReply, unroutablePairReply } from './placeMemory'
import { BUS_PLACES, getPlace } from './places'

const parcelles = getPlace('brt-parcelles')!
const keurMbayeFall = getPlace('ter-mbao')!
const petersen = getPlace('brt-petersen')!
// Ouakam est désormais géolocalisé DDD/AFTU en pointillés ; on prend un lieu bus pur s'il reste, sinon un DDD
const ouakamBus = getPlace('bus:ouakam') ?? getPlace('ddd-ouakam') ?? getPlace('aftu-ouakam') ?? BUS_PLACES[0]
const ouakam = ouakamBus!
const yoffBus = getPlace('bus:yoff') ?? getPlace('aftu-yoff') ?? getPlace('ddd-parcelles') ?? BUS_PLACES[0]

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

  it('dit d’où vient une fiche bus sans la transformer en arrêt (ou précise DDD/AFTU pointillés)', () => {
    const brief = placeBrief(ouakam)
    expect(brief).toContain(ouakam.name)
    if (ouakam.kind === 'bus') {
      expect(brief).toMatch(/ni une gare TER ni une station BRT/)
      expect(brief).toContain('Fiches bus mentionnant ce lieu')
      expect(brief).not.toMatch(/Environ \d+ min/)
    } else {
      // DDD/AFTU/TATA : désormais géolocalisé en pointillés légers + pastille
      expect(brief).toMatch(/DDD|AFTU|TATA/)
      expect(brief).toMatch(/pointillés légers/)
    }
  })

  it('rappelle ses limites : ni horaire, ni temps réel, ni fréquence bus (avec code couleur)', () => {
    const brief = placeBrief(keurMbayeFall)
    expect(brief).toMatch(/TER bleu #003366|ni horaire de passage|pointillés légers/)
    expect(brief).toMatch(/#00A859|#F59E0B|#D97706/)
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
  it('documente sans inventer ni durée ni correspondance (ou avec pointillés DDD/AFTU)', () => {
    const reply = unroutablePairReply(ouakam, yoffBus)
    expect(reply).toContain(ouakam.name)
    expect(reply).toContain(yoffBus.name)
    expect(reply).toMatch(/je ne peux pas calculer cet itinéraire/)
    // Si les deux sont bus purs : aucun arrêt géolocalisé ; si l'un est DDD/AFTU : il a un itinéraire repère
    if (ouakam.kind === 'bus' && yoffBus.kind === 'bus') {
      expect(reply).toMatch(/aucun arrêt géolocalisé/)
      expect(reply).not.toMatch(/Environ \d+ min de marche/)
    } else {
      expect(reply).toMatch(/Itinéraire repère|Fiches bus/)
    }
  })

  it('sert l’itinéraire du lieu calculable quand un seul l’est (ou les deux en pointillés)', () => {
    const diamniadio = getPlace('ter-diamniadio')!
    const reply2 = unroutablePairReply(ouakam, diamniadio)
    expect(reply2).toContain('Diamniadio')
    // Avec DDD/AFTU en pointillés, Ouakam a désormais un itinéraire repère depuis Petersen (DDD) ou Lat Dior (AFTU)
    expect(reply2).toMatch(/Itinéraire repère/)
    expect(reply2).toContain(ouakam.name)
  })
})
