import { describe, expect, it } from 'vitest'
import {
  ALL_KNOWN_PLACES,
  BUS_PLACES,
  REFERENCE_PLACES,
  crossNetworkNearest,
  findPlaceMentions,
  isRouteQuestion,
  placeEndpoint,
  resolveJourneyEndpoints,
} from './places'

describe('mémoire des lieux de Dakar', () => {
  it('couvre les 13 gares TER, les 23 stations BRT et les lieux des fiches bus', () => {
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'ter')).toHaveLength(13)
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'brt')).toHaveLength(23)
    expect(BUS_PLACES.length).toBeGreaterThan(20)
    expect(ALL_KNOWN_PLACES.length).toBe(REFERENCE_PLACES.length + BUS_PLACES.length)
    // Une fiche bus ne crée jamais une fausse gare : Petersen reste la station BRT.
    const petersens = ALL_KNOWN_PLACES.filter((place) =>
      [place.name, ...place.aliases].some((label) => label.toLowerCase() === 'petersen'))
    expect(petersens).toHaveLength(1)
    expect(petersens[0].kind).toBe('brt')
  })

  it('ne retient que les lieux nommés, pas les noms de rues', () => {
    expect(BUS_PLACES.some((place) => /^rue\b/i.test(place.name))).toBe(false)
    expect(BUS_PLACES.some((place) => /^avenue\b/i.test(place.name))).toBe(false)
  })

  it('reconnaît le libellé le plus long avant le plus court', () => {
    const mentions = findPlaceMentions('je pars de la gare de Dakar vers Rufisque')
    expect(mentions.map((mention) => mention.place.id)).toEqual(['ter-dakar', 'ter-rufisque'])
    expect(mentions[0].start).toBeLessThan(mentions[1].start)
  })

  it('reconnaît les alias usuels des usagers', () => {
    expect(findPlaceMentions('Parcelles Assainies').map((m) => m.place.id)).toEqual(['brt-parcelles'])
    expect(findPlaceMentions('Guédiawaye').map((m) => m.place.id)).toEqual(['brt-prefecture-guediawaye'])
    expect(findPlaceMentions('Keur Massar').map((m) => m.place.id)).toEqual(['ter-mbao'])
  })
})

describe('compréhension du langage naturel', () => {
  it('extrait départ et destination d’une phrase libre, dans n’importe quel ordre', () => {
    const a = resolveJourneyEndpoints('Comment faire pour aller à Dakar ? Je suis à Keur Mbaye Fall')
    expect(a?.origin?.id).toBe('ter-mbao')
    expect(a?.destination?.id).toBe('ter-dakar')
    expect(a?.explicit).toBe(true)

    const b = resolveJourneyEndpoints('je suis à Parcelles Assainies et je voudrais rejoindre Diamniadio')
    expect(b?.origin?.id).toBe('brt-parcelles')
    expect(b?.destination?.id).toBe('ter-diamniadio')

    const c = resolveJourneyEndpoints('je vais à Dakar depuis Rufisque')
    expect(c?.origin?.id).toBe('ter-rufisque')
    expect(c?.destination?.id).toBe('ter-dakar')

    const d = resolveJourneyEndpoints('trajet de Petersen à Rufisque')
    expect(d?.origin?.id).toBe('brt-petersen')
    expect(d?.destination?.id).toBe('ter-rufisque')
  })

  it('ne redemande jamais ce que le message a déjà dit', () => {
    // « je suis à … » suffit à désigner le départ : pas de question en retour.
    const only = resolveJourneyEndpoints('je suis à Keur Mbaye Fall')
    expect(only?.origin?.id).toBe('ter-mbao')
    expect(only?.destination).toBeNull()
    // Et la destination seule reste une destination, jamais un départ deviné.
    const destination = resolveJourneyEndpoints('je veux aller à Rufisque')
    expect(destination?.origin).toBeNull()
    expect(destination?.destination?.id).toBe('ter-rufisque')
  })

  it('résout deux lieux sans mot de liaison par l’ordre des mots', () => {
    const pair = resolveJourneyEndpoints('Keur Mbaye Fall Dakar')
    expect(pair?.origin?.id).toBe('ter-mbao')
    expect(pair?.destination?.id).toBe('ter-dakar')
    expect(pair?.explicit).toBe(false)
  })

  it('ignore les articles et les formulations longues', () => {
    const pair = resolveJourneyEndpoints('prendre le TER depuis la gare de Keur Mbaye Fall jusqu’à la gare de Dakar')
    expect(pair?.origin?.id).toBe('ter-mbao')
    expect(pair?.destination?.id).toBe('ter-dakar')
    const fromHome = resolveJourneyEndpoints('je pars de chez moi à Dakar')
    expect(fromHome?.origin).toBeNull()
    expect(fromHome?.destination?.id).toBe('ter-dakar')
  })

  it('reconnaît un lieu cité par les fiches bus sans le géocoder', () => {
    const place = findPlaceMentions('Ouakam')[0]?.place
    expect(place?.kind).toBe('bus')
    expect(placeEndpoint(place!)).toBeNull()
    expect(place?.busLines.length).toBeGreaterThan(0)
    expect(crossNetworkNearest(place!)).toBeNull()
  })

  it('ne fabrique aucun lieu inconnu', () => {
    expect(resolveJourneyEndpoints('bonjour')).toBeNull()
    expect(resolveJourneyEndpoints('quel temps fera-t-il demain ?')).toBeNull()
    expect(findPlaceMentions('Mbour')).toHaveLength(0)
  })

  it('reconnaît une demande d’itinéraire au-delà du mot « trajet »', () => {
    expect(isRouteQuestion('Comment faire pour aller à Dakar ?')).toBe(true)
    expect(isRouteQuestion('je veux aller à Rufisque')).toBe(true)
    expect(isRouteQuestion('quel bus pour Guédiawaye ?')).toBe(true)
    expect(isRouteQuestion('trajet de Petersen à Rufisque')).toBe(true)
    expect(isRouteQuestion('quelle est la fréquence du TER ?')).toBe(false)
    expect(isRouteQuestion('liste des gares TER')).toBe(false)
  })
})

describe('correspondances entre modes', () => {
  it('mesure l’arrêt de l’autre réseau le plus proche sans l’inventer', () => {
    const petersen = REFERENCE_PLACES.find((place) => place.id === 'brt-petersen')!
    const nearest = crossNetworkNearest(petersen)
    expect(nearest?.stop.id).toBe('ter-dakar')
    expect(nearest?.reachable).toBe(true)
    const parcels = crossNetworkNearest(REFERENCE_PLACES.find((place) => place.id === 'brt-parcelles')!)
    expect(parcels?.stop.id.startsWith('ter')).toBe(true)
    expect(parcels?.reachable).toBe(false)
  })
})
