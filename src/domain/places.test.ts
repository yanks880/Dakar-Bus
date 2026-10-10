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
  it('couvre les 13 gares TER, les 23 stations BRT, les arrêts DDD/AFTU/TATA en pointillés et les lieux des fiches bus', () => {
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'ter')).toHaveLength(13)
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'brt')).toHaveLength(23)
    // DDD (jaune #F59E0B) et AFTU/TATA (orange #D97706) en pointillés légers + pastilles
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'ddd').length).toBeGreaterThanOrEqual(10)
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'aftu').length).toBeGreaterThanOrEqual(10)
    expect(REFERENCE_PLACES.filter((place) => place.kind === 'tata').length).toBeGreaterThanOrEqual(1)
    expect(BUS_PLACES.length).toBeGreaterThan(10)
    expect(ALL_KNOWN_PLACES.length).toBe(REFERENCE_PLACES.length + BUS_PLACES.length)
    // Petersen existe en BRT (tracé continu) et aussi en DDD/AFTU en pointillés : le BRT reste présent
    const petersens = ALL_KNOWN_PLACES.filter((place) =>
      [place.name, ...place.aliases].some((label) => label.toLowerCase() === 'petersen'))
    expect(petersens.length).toBeGreaterThanOrEqual(1)
    expect(petersens.some((p) => p.kind === 'brt')).toBe(true)
    // Aucun lieu bus ne doit écraser la gare BRT de référence
    expect(BUS_PLACES.filter((place) => place.name.toLowerCase() === 'petersen')).toHaveLength(0)
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

  it('reconnaît un lieu cité par les fiches bus sans le géocoder (ou en pointillés DDD/AFTU)', () => {
    // Ouakam est désormais un arrêt DDD/AFTU géolocalisé en pointillés légers (jaune/orange)
    // On teste un lieu qui reste purement bus, sans coordonnées : ex. UCAD ou un terminus non géolocalisé
    const candidates = ['UCAD', 'Cambérène', 'Malika']
    let busPlace: ReturnType<typeof findPlaceMentions>[0]['place'] | null = null
    for (const name of candidates) {
      const found = findPlaceMentions(name)[0]?.place
      if (found && found.kind === 'bus') {
        busPlace = found
        break
      }
    }
    // Si tous les candidats sont devenus référence, on prend le premier bus place restant
    if (!busPlace) busPlace = BUS_PLACES[0]
    expect(busPlace).toBeTruthy()
    if (busPlace!.kind === 'bus') {
      expect(placeEndpoint(busPlace!)).toBeNull()
      expect(crossNetworkNearest(busPlace!)).toBeNull()
    }
    expect(busPlace!.busLines.length).toBeGreaterThan(0)
    // Ouakam lui-même est maintenant en pointillés DDD/AFTU, donc géolocalisé
    const ouakam = findPlaceMentions('Ouakam')[0]?.place
    expect(ouakam).toBeTruthy()
    expect(['ddd', 'aftu', 'brt', 'bus']).toContain(ouakam!.kind)
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
  it('mesure l’arrêt de l’autre réseau le plus proche sans l’inventer (TER continu, DDD/AFTU pointillés)', () => {
    const petersen = REFERENCE_PLACES.find((place) => place.id === 'brt-petersen')!
    const nearest = crossNetworkNearest(petersen)
    // Avec DDD/AFTU en pointillés au même pôle, le plus proche peut être DDD/AFTU à 0m ou TER Dakar à ~1km
    expect(nearest).toBeTruthy()
    expect(nearest!.reachable).toBe(true)
    expect(['ter-dakar', 'ddd-petersen', 'aftu-petersen', 'tata-colobane', 'ddd-parcelles']).toContain(nearest!.stop.id)
    // Si c'est TER Dakar, distance ~1km ; si c'est DDD/AFTU même pôle, distance ~0
    if (nearest!.stop.id === 'ter-dakar') {
      expect(nearest!.distanceM).toBeGreaterThan(500)
    } else {
      expect(nearest!.distanceM).toBeLessThan(100)
    }
    const parcels = REFERENCE_PLACES.find((place) => place.id === 'brt-parcelles')!
    const parcelsNearest = crossNetworkNearest(parcels)
    expect(parcelsNearest).toBeTruthy()
    // Désormais DDD/AFTU/TATA Parcelles au même endroit : reachable true (0m) au lieu de false
    if (parcelsNearest!.stop.id.includes('parcelles')) {
      expect(parcelsNearest!.reachable).toBe(true)
      expect(parcelsNearest!.distanceM).toBeLessThan(100)
    } else {
      expect(parcelsNearest!.stop.id.startsWith('ter')).toBe(true)
    }
  })
})
