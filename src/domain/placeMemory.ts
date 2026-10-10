/**
 * Réponses « mémoire du maître » : pour chaque lieu connu de Dakar, une fiche
 * complète — identification, mode le plus adapté, desserte, correspondances,
 * itinéraire concret calculé et fiches bus documentaires.
 *
 * Règle inchangée : rien n'est inventé. Un lieu sans coordonnées n'entre pas
 * dans le calculateur ; une distance entre deux réseaux est annoncée comme une
 * mesure à vol d'oiseau ; une fiche DDD/AFTU reste un repère textuel, jamais
 * un arrêt géolocalisé ni un horaire. Quand il manque le départ ou la
 * destination, l'assistant donne d'abord l'essentiel (l'itinéraire repère
 * depuis le pôle central) puis pose une question courte, en langage naturel —
 * jamais une phrase toute faite qui ignorerait ce que l'usager vient d'écrire.
 */

import { MAX_ACCESS_M } from './assumptions'
import { CORRIDOR_NETWORKS, TER_STOPS, getCorridorStop } from './corridors'
import type { BusLine } from './mobilityKnowledge'
import { describeLeg, formatMeters, planReferenceJourney, type PlannerEndpoint } from './planner'
import {
  crossNetworkNearest,
  declaredTransferOf,
  placeEndpoint,
  referenceLinesOf,
  type PlaceEntry,
  type PlaceRole,
} from './places'

/** Pôles centraux servant d'origine aux itinéraires repère. */
const HUB_BY_KIND: Record<string, string> = {
  ter: 'ter-dakar',
  brt: 'brt-petersen',
  ddd: 'ddd-petersen',
  aftu: 'aftu-lat-dior',
  tata: 'tata-colobane',
}

const PLACE_LIMIT =
  'Estimations du réseau de référence : TER bleu #003366 et BRT vert #00A859 en tracés continus, DDD jaune #F59E0B et AFTU/TATA orange #D97706 en pointillés légers + pastilles. Fréquences DDD/AFTU/TATA non publiées ligne par ligne : ni temps réel, ni prochain passage garanti.'

function networkLabel(place: PlaceEntry): string {
  if (place.kind === 'ter') return CORRIDOR_NETWORKS.ter.label
  if (place.kind === 'brt') return CORRIDOR_NETWORKS.brt.label
  if (place.kind === 'ddd') return CORRIDOR_NETWORKS.ddd.label
  if (place.kind === 'aftu') return CORRIDOR_NETWORKS.aftu.label
  if (place.kind === 'tata') return CORRIDOR_NETWORKS.tata.label
  return 'Bus'
}

/** Première phrase : ce qu'est le lieu, et d'où vient l'information. */
function identityLine(place: PlaceEntry): string {
  const note = place.note ? ` (${place.note})` : ''
  if (place.kind === 'ter') {
    return `${place.name} — gare/halte TER${note}, ligne Dakar ↔ Diamniadio (${TER_STOPS.length} arrêts, ${CORRIDOR_NETWORKS.ter.operator}).`
  }
  if (place.kind === 'brt') {
    return `${place.name} — station BRT${note}, ligne B1 Petersen ↔ Préfecture de Guédiawaye (${CORRIDOR_NETWORKS.brt.operator}).`
  }
  if (place.kind === 'ddd') {
    return `${place.name} — arrêt DDD${note}, réseau urbain Dakar Dem Dikk (jaune #F59E0B) en pointillés légers + pastille.`
  }
  if (place.kind === 'aftu') {
    return `${place.name} — arrêt AFTU${note}, réseau minibus AFTU (orange ambré #D97706) en pointillés légers + pastille.`
  }
  if (place.kind === 'tata') {
    return `${place.name} — arrêt TATA${note}, réseau TATA (marron #C05621, palette AFTU) en pointillés légers + pastille.`
  }
  return `${place.name} — lieu cité par les fiches documentaires DDD/AFTU. Ce n'est ni une gare TER ni une station BRT : aucun arrêt géolocalisé ne lui est associé dans le référentiel.`
}

/** Desserte déclarée, avec la fenêtre de service publiée. */
function serviceLine(place: PlaceEntry): string | null {
  const lines = referenceLinesOf(place)
  if (lines.length === 0) return null
  return `Desserte : ${lines.map((line) => `${line.shortName} (${line.longName})`).join(', ')} — service de référence ${lines[0].serviceWindow}.`
}

/** Mode le plus adapté pour atteindre ce lieu, d'après le réseau de référence. */
function bestModeLine(place: PlaceEntry): string {
  if (place.kind === 'ter') {
    return 'Mode le plus adapté : le TER bleu #003366 — le plus rapide sur ce corridor, aux heures de service publiées.'
  }
  if (place.kind === 'brt') {
    return 'Mode le plus adapté : le BRT vert #00A859 (B1) — cadence de référence la plus régulière du réseau, en site propre.'
  }
  if (place.kind === 'ddd') {
    return 'Mode le plus adapté : DDD jaune #F59E0B — bus urbains, affichage en pointillés légers + pastilles pour éviter la surcharge.'
  }
  if (place.kind === 'aftu') {
    return 'Mode le plus adapté : AFTU orange #D97706 — minibus, pointillés légers + pastilles.'
  }
  if (place.kind === 'tata') {
    return 'Mode le plus adapté : TATA marron #C05621 — réseau indépendant, même palette AFTU, pointillés légers.'
  }
  return 'Mode le plus adapté : une ligne DDD ou AFTU, à confirmer auprès de l’opérateur : aucun arrêt de référence n’est rattaché à ce lieu.'
}

/**
 * Itinéraire réellement calculé depuis le pôle central du réseau concerné.
 * C'est un repère, jamais le trajet « depuis chez vous » : la position de
 * l'usager n'est pas déduite.
 */
function itineraryLine(place: PlaceEntry): string | null {
  if (place.kind === 'bus') return null
  const hubId = HUB_BY_KIND[place.kind]
  if (hubId === place.id) return null
  const hub = getCorridorStop(hubId)
  const target = placeEndpoint(place)
  if (!hub || !target) return null
  const hubEndpoint: PlannerEndpoint = { label: hub.name, lat: hub.lat, lon: hub.lon, stopId: hub.id }
  const outcome = planReferenceJourney(hubEndpoint, target)
  if (!outcome.ok) return null
  const steps = outcome.legs.map((leg) => `• ${describeLeg(leg)}`).join('\n')
  const transfers = `${outcome.transfers} correspondance${outcome.transfers > 1 ? 's' : ''}`
  return [
    `Itinéraire repère depuis ${hub.name} (pôle central ${networkLabel(place)}) :`,
    steps,
    `Environ ${outcome.totalMinutes} min, ${formatMeters(outcome.totalWalkM)} de marche, ${transfers}.`,
  ].join('\n')
}

/** Correspondances connues, déclarées ou mesurées — jamais supposées. */
function correspondenceLine(place: PlaceEntry): string | null {
  const declared = declaredTransferOf(place)
  if (declared) {
    const other = getCorridorStop(declared.fromStopId === place.id ? declared.toStopId : declared.fromStopId)
    return `Correspondance déclarée : ${declared.label}${other ? ` — ${networkLabel(place)} ↔ ${other.id.startsWith('ter') ? 'TER' : 'BRT'}` : ''}.`
  }
  const nearest = crossNetworkNearest(place)
  if (!nearest) return null
  const otherNetwork = nearest.stop.id.startsWith('ter') ? 'gare TER' : 'station BRT'
  const distance = formatMeters(nearest.distanceM)
  const radius = formatMeters(MAX_ACCESS_M)
  if (nearest.reachable) {
    return `Correspondance possible : ${otherNetwork} ${nearest.stop.name} à ${distance} à vol d’oiseau (dans le rayon de marche du calculateur, ${radius}) — cheminement réel à confirmer sur place.`
  }
  return `Pas de correspondance à pied dans ce modèle : l’arrêt ${otherNetwork} le plus proche est ${nearest.stop.name}, à ${distance} à vol d’oiseau — au-delà du rayon de marche de ${radius}. Il faut un autre mode pour le rejoindre.`
}

/** Fiches DDD/AFTU citant ce lieu, avec leurs réserves. */
function busFichesLine(place: PlaceEntry): string | null {
  if (place.busLines.length === 0) return null
  const shown = place.busLines.slice(0, 4)
  const rest = place.busLines.length - shown.length
  const lines = shown.map((line: BusLine) => `• ${line.network.toUpperCase()} ${line.code} : ${line.origin} ↔ ${line.destination}`).join('\n')
  return `Fiches bus mentionnant ce lieu (ou l’un de ses noms usuels) :\n${lines}${rest > 0 ? `\n… et ${rest} autre(s) fiche(s).` : ''}\nRepères textuels : ni arrêt précis, ni durée, ni fréquence — à confirmer auprès de l’opérateur.`
}

/** Fiche complète d'un lieu : identification, mode, desserte, correspondances, itinéraire. */
export function placeBrief(place: PlaceEntry): string {
  const parts = [identityLine(place), bestModeLine(place)]
  for (const part of [serviceLine(place), itineraryLine(place), correspondenceLine(place), busFichesLine(place)]) {
    if (part) parts.push(part)
  }
  parts.push(PLACE_LIMIT)
  return parts.join('\n')
}

/**
 * Réponse quand il manque le départ ou la destination : l'essentiel d'abord
 * (la fiche du lieu connu, avec un itinéraire réellement calculé), puis une
 * question courte en langage naturel.
 */
export function placeBriefWithQuestion(
  place: PlaceEntry,
  missing: PlaceRole,
  options: { arrivalRequested?: boolean } = {},
): string {
  const brief = placeBrief(place)
  const ask = missing === 'origin'
    ? 'Il me manque votre point de départ : dites-le simplement (« je suis à … », « depuis Parcelles Assainies ») et je calcule le trajet complet avec les correspondances.'
    : 'Il me manque votre destination : dites-la (« je vais à … », « vers Rufisque ») et je calcule le trajet complet avec les correspondances.'
  const arrival = options.arrivalRequested
    ? '\nSans point de départ, je n’estime aucune heure de départ : une heure de départ inventée serait fausse.'
    : ''
  return `${brief}\n${ask}${arrival}`
}

/**
 * Réponse à une question portant sur un seul lieu (« Parcelles Assainies ? »).
 * `missing` précise ce qui reste à dire : quand l'usager vient d'énoncer son
 * départ, c'est la destination qui est demandée — jamais l'inverse.
 */
export function placeQuestionReply(place: PlaceEntry, missing: PlaceRole | null = null): string {
  const invite = missing === 'destination'
    ? 'Dites-moi où vous allez — « je vais à Diamniadio » — et je calcule l’itinéraire complet avec les correspondances.'
    : missing === 'origin'
      ? 'Dites-moi d’où vous partez — « je suis à Keur Mbaye Fall » — et je calcule l’itinéraire complet avec les correspondances.'
      : 'Dites-moi d’où vous partez (ou où vous allez) en une phrase — « je suis à Ouakam, je vais à Diamniadio » — et je calcule l’itinéraire complet.'
  return `${placeBrief(place)}\n${invite}`
}

function busLineKey(line: BusLine): string {
  return `${line.network}:${line.code}`
}

/** Fiches DDD/AFTU dont le parcours cite les deux lieux. */
function sharedBusLines(origin: PlaceEntry, destination: PlaceEntry): BusLine[] {
  const other = new Set(destination.busLines.map(busLineKey))
  return origin.busLines.filter((line) => other.has(busLineKey(line)))
}

function shortIdentity(place: PlaceEntry): string {
  if (place.kind === 'bus') {
    return `${place.name} : lieu cité par les fiches DDD/AFTU — aucun arrêt géolocalisé, donc aucun calcul d’itinéraire possible.`
  }
  return `${place.name} : ${place.kind === 'ter' ? 'gare/halte TER' : 'station BRT'} du réseau de référence.`
}

/**
 * Deux lieux cités, mais au moins un n'est pas calculable : on donne tout ce
 * qui est documenté — l'itinéraire du lieu calculable, les fiches bus qui
 * citent les deux, et ce qu'on ne peut pas faire — sans jamais fabriquer un
 * trajet ni une durée.
 */
export function unroutablePairReply(origin: PlaceEntry | null, destination: PlaceEntry | null): string {
  const places = [origin, destination].filter((place): place is PlaceEntry => place !== null)
  const parts = [`${places.map((place) => place.name).join(' → ')} : je ne peux pas calculer cet itinéraire.`]
  for (const place of places) parts.push(`• ${shortIdentity(place)}`)
  const calculable = places.find((place) => place.kind !== 'bus')
  const itinerary = calculable ? itineraryLine(calculable) : null
  if (itinerary) parts.push(itinerary)
  if (origin && destination) {
    const shared = sharedBusLines(origin, destination)
    if (shared.length > 0) {
      parts.push([
        'Fiches bus citant les deux lieux :',
        ...shared.slice(0, 4).map((line) => `• ${line.network.toUpperCase()} ${line.code} : ${line.origin} ↔ ${line.destination}`),
        'Repère textuel : le sens publié et les arrêts précis ne sont pas confirmés, et aucune durée n’est déduite.',
      ].join('\n'))
    } else {
      parts.push('Aucune fiche transcrite ne cite les deux lieux : je ne complète pas avec une ligne supposée.')
    }
  }
  parts.push('Sans arrêts géolocalisés ni horaires par ligne pour DDD/AFTU, je ne calcule ni durée ni correspondance : ce serait inventer. Donnez-moi une gare TER ou une station BRT (« liste des gares TER »), ou un numéro de ligne (« itinéraire AFTU 53 ») pour une réponse complète.')
  return parts.join('\n')
}
