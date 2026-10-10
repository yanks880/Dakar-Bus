/** Mémoire documentaire embarquée, indépendante du GTFS et du calculateur.
 * Les points de passage textuels ne sont PAS des arrêts géolocalisés ni des
 * courses. Aucun horaire, sens retour ou transfert pédestre n'en est déduit.
 * Voir docs/mobility-research-2026-10-10.md pour les vérifications et lacunes.
 */
import catalog from '../data/mobility-lines.json'
import { searchCorridorStops } from './corridors'

export const KNOWLEDGE_CHECKED_AT = '2026-10-10'
export const BUS_LINES = catalog
export type BusLine = typeof BUS_LINES[number]
export interface KnowledgeReply { text: string; lineId?: string }

const SOURCES = {
  ddd: 'https://cetud.sn/reseaux-de-transport/ddd/',
  aftu: 'https://cetud.sn/reseaux-de-transport/aftu/',
  aftuLines: 'https://aftu-senegal.org/infos-pratiques/',
  dddLines: 'https://demdikk.sn/reseau-urbain-dakar/',
  brtGuide: 'https://cetud.sn/wp-content/uploads/2024/11/sunubrt-guide-du-voyageur-vf.pdf',
  brtContact: 'https://sunubrt.sn/',
  terStations: 'https://sentersa.sn/gares-et-haltes/',
  terServices: 'https://sentersa.sn/service-en-gare/',
  terHours: 'https://www.terdakar.sn/les_horaires_des_trains/',
  terFares: 'https://www.terdakar.sn/ticket-voyage-aller-simple-de-quoi-s-agit-il/',
  terSubscriptions: 'https://www.terdakar.sn/quel-titre-choisir/',
  terOffers: 'https://www.terdakar.sn/les-offres-ter-de-dakar/',
  traffic: 'https://cetud.sn/observatoire/indicateurs-de-trafic/',
} as const

function source(url: string, publishedAt?: string | null): string {
  return `\nSource : ${url}\nConsultée le ${KNOWLEDGE_CHECKED_AT}${publishedAt ? ` · publication du ${publishedAt}` : ' · date de publication non précisée'}. Référence documentaire, pas un suivi en direct.`
}
export function normalizeMobility(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
}
function key(line: BusLine): string { return `${line.network}:${line.code}` }
function label(line: BusLine): string { return `${line.network.toUpperCase()} ${line.code} : ${line.origin} ↔ ${line.destination}` }
function explicitNetworks(text: string): string[] {
  return [(/\b(ddd|dem dikk)\b/.test(text) ? 'ddd' : ''), (/\b(aftu|tata)\b/.test(text) ? 'aftu' : '')].filter(Boolean)
}
function lineReply(line: BusLine, question: string): KnowledgeReply {
  const text = normalizeMobility(question)
  let detail: string
  if (/\b(correspondance|correspondances|changer|transfert)\b/.test(text)) {
    detail = line.waypoints.some((point) => /gare (ter|de dakar)/i.test(point))
      ? 'La fiche mentionne la gare TER / gare de Dakar comme point de passage. Cela fournit un repère pour rejoindre le TER, mais l’arrêt bus précis, le chemin piéton, les horaires coordonnés et le billet combiné ne sont pas validés ici.'
      : 'Aucune correspondance garantie n’est documentée pour cette ligne dans la mémoire. Un nom de quartier commun ne suffit pas à confirmer le même arrêt, un chemin piéton sûr ou des horaires coordonnés.'
  } else if (/\b(prochain|prochaine|attente|passage|frequence|horaire|horaires|heure|depart)\b/.test(text) && !/\b(ou|arrets|itineraire|parcours)\b/.test(text)) {
    detail = 'Aucun prochain départ fiable ni fréquence par ligne dans cette fiche. Je ne peux pas calculer un compte à rebours.'
  } else if (/\b(prix|tarif|ticket|cout|coute|payer)\b/.test(text)) {
    detail = 'Tarif de cette ligne non documenté dans la base consultée : à confirmer auprès du receveur ou de l’opérateur.'
  } else if (line.waypoints.length) {
    detail = `Points de passage dans le sens publié :\n${line.waypoints.join(' → ')}\nCe sont des repères d’itinéraire, pas une liste d’arrêts géolocalisés. Le détail du sens retour n’est pas confirmé.`
  } else {
    detail = 'Les terminus sont documentés ; le détail des arrêts intermédiaires n’est pas encore transcrit dans la mémoire. Consultez la fiche de l’opérateur pour le parcours complet.'
  }
  return { text: `${label(line)}\n${detail}${line.note ? `\nAttention : ${line.note}` : ''}${source(line.detailSourceUrl ?? line.sourceUrl, line.publishedAt)}`, lineId: key(line) }
}

export function busKnowledgeSummary(): string {
  const ddd = BUS_LINES.filter((line) => line.network === 'ddd').length
  const aftu = BUS_LINES.filter((line) => line.network === 'aftu').length
  return `Mémoire documentaire DDD/AFTU : ${ddd} fiches DDD et ${aftu} fiches AFTU, dont ${BUS_LINES.filter((line) => line.waypoints.length).length} parcours avec points de passage transcrits. Consultation du ${KNOWLEDGE_CHECKED_AT}. Ce catalogue n’est pas exhaustif ; les tarifs par bus, arrêts géolocalisés et correspondances garanties restent à compléter. « TATA » peut être précisé par un numéro de ligne AFTU, sans supposer un réseau indépendant vérifié.`
}

export function generalFareReply(): string {
  return `Tarifs de référence :\n• TER : 500 / 1 000 / 1 500 F CFA pour 1 / 2 / 3 zones en 2e classe ; 2 500 F CFA en 1re classe.\n• BRT : 400 F CFA dans une même zone ; 500 F CFA en franchissant une ou deux limites de zones.\n• DDD/AFTU : tarifs par ligne non documentés ici.\nCes tarifs ne permettent pas de calculer le coût complet d’une correspondance ni de garantir une promotion.${source(SOURCES.terFares)}${source(SOURCES.brtGuide)}`
}

/** Réponses courtes par thème, avec provenance au lieu de remplir le chat d'un guide entier. */
function practicalReply(text: string): string | null {
  const brt = /\b(brt|sunubrt|b1|b2|b3)\b/.test(text)
  const ter = /\b(ter|train|senter|seter)\b/.test(text)
  const fares = /\b(tarif|tarifs|prix|coute|cout|payer|ticket|tickets|billet|billets)\b/.test(text)
  if (brt && ter) return fares ? generalFareReply() : null // pas de comparaison avec un seul réseau
  if (brt) {
    if (/\b(contact|telephone|joindre|appeler|whatsapp|reclamation)\b/.test(text)) return `SunuBRT : 818 55 55 55 (50 F l’appel), WhatsApp 76 215 15 15, serviceclient@sunubrt.sn. Service client annoncé 7j/7, 06h–23h : ce sont les heures du service client, pas celles des bus.${source(SOURCES.brtContact)}`
    if (/\b(zone|zones)\b/.test(text) && !fares) return `Le guide SunuBRT distingue trois zones :\n• Zone 1 : Papa Gueye Fall – Liberté 6.\n• Zone 2 : Khar Yalla – Croisement 22.\n• Zone 3 : Parcelles – Préfecture de Guédiawaye.${source(SOURCES.brtGuide)}`
    if (/\b(valider|validation|sortir|portique|refuse)\b/.test(text)) return `Validez votre titre à l’entrée ET à la sortie de la station BRT (check-in/check-out). Gardez-le jusqu’à la sortie. Si le titre est refusé, adressez-vous à un agent en station.${source(SOURCES.brtGuide)}`
    if (/\b(handicap|pmr|accessible|accessibilite|fauteuil)\b/.test(text)) return `Le guide SunuBRT indique que les stations et véhicules sont accessibles aux personnes à mobilité réduite. Je ne dispose pas de l’état actuel des équipements ; demandez assistance à un agent.${source(SOURCES.brtGuide)}`
    if (/\b(acheter|recharger|recharge|abonnement|carte)\b/.test(text)) return `Titres SunuBRT : guichets en station, agences de Guédiawaye, Grand Médine et Petersen, dépositaires agréés. Le guide prévoit aussi l’application et la e-boutique ; leur disponibilité actuelle n’est pas garantie, le site était en maintenance à la consultation. L’abonnement 30 jours utilise une carte nominative ; le billet sans contact ne porte pas d’abonnement.${source(SOURCES.brtGuide)}`
    if (fares || /\b(enfant|enfants|gratuit)\b/.test(text)) return `Tarifs de référence SunuBRT : 400 F CFA dans une même zone ; 500 F CFA en franchissant une ou deux limites de zones. Voyage gratuit pour les enfants accompagnés de moins de 4 ans, selon le guide. Tarifs à reconfirmer au guichet ; aucune promotion ancienne n’est appliquée.${source(SOURCES.brtGuide)}`
    if (/\bb1\b/.test(text)) return `Le guide SunuBRT décrit B1 entre Guédiawaye et Petersen, 7j/7, avec une fréquence de référence de 6 minutes et un renfort entre Grand Médine et Petersen. Ce guide ne garantit ni un départ imminent ni les modalités actuelles du renfort ; le site opérateur était en maintenance.${source(SOURCES.brtGuide)}`
    if (/\bb[23]\b/.test(text)) return 'Les pages B2/B3 de SunuBRT étaient en maintenance à la consultation. Des extraits indexés décrivent des services semi-express, mais je ne confirme pas leur service actuel à partir de ces seuls extraits. Contactez SunuBRT au 818 55 55 55.' + source(SOURCES.brtContact)
  }
  if (ter) {
    if (/\b(horaire|horaires|frequence|frequences|premier|dernier|ouvre|ferme)\b/.test(text) && !/\b(prochain|prochaine|dans combien)\b/.test(text)) return `Horaires de référence publiés par TER Dakar :\n• Lundi–samedi : premier départ 05h35 de Diamniadio, 05h45 de Dakar ; toutes les 10 min jusqu’à 20h55.\n• Puis toutes les 20 min de 21h05 à 22h05 (dernier départ).\n• Dimanches et jours fériés : toutes les 20 min de 06h25 à 22h05.\nCes heures ne sont pas celles de chaque gare intermédiaire et ne garantissent pas le prochain passage.${source(SOURCES.terHours)}`
    if (/\b(abonnement|abonnements|mensuel|hebdo|hebdomadaire)\b/.test(text)) return `Abonnements adultes TER de référence, 2e classe :\n• Mensuel : 15 000 / 30 000 / 45 000 F CFA pour 1 / 2 / 3 zones, du 1er à la fin du mois.\n• Hebdomadaire : 6 000 / 12 000 / 18 000 F CFA, du lundi au dimanche.\nCarte Sama TER nominative. Des offres jeunes et enfants existent : consultez les conditions d’âge et de zones sur la page de l’opérateur ; ce résumé ne leur applique pas automatiquement un tarif adulte.${source(SOURCES.terSubscriptions)}`
    if (/\b(enfant|enfants|gratuit)\b/.test(text)) return `Le site TER Dakar annonce la gratuité pour les enfants de moins de 5 ans. Les autres offres enfants et jeunes dépendent de l’âge et du titre choisi.${source(SOURCES.terOffers)}`
    if (fares || /\b(sama|paiement)\b/.test(text)) return `Ticket TER, aller simple de référence :\n• 2e classe : 500 F CFA (1 zone), 1 000 F CFA (2 zones), 1 500 F CFA (3 zones).\n• 1re classe : 2 500 F CFA, quelle que soit la zone.\nTicket papier QR code valable 5 jours, acheté aux guichets ou distributeurs ; espèces et monnaie mobile. Cela ne signifie pas des voyages illimités pendant 5 jours.${source(SOURCES.terFares)}`
    if (/\b(commerce|commerces|service|services|kiosque|senter)\b/.test(text)) return `SENTER indique 83 espaces commerciaux répartis sur 13 gares et haltes entre Dakar et Diamniadio, dont 58 kiosques sur les parvis. Contact : contact@senter.sn. Le site institutionnel présente aussi des chiffres de projet plus larges : je ne les transforme pas en desserte aujourd’hui confirmée vers l’AIBD.${source(SOURCES.terServices)}`
    if (/\b(aibd|aeroport|14 gares)\b/.test(text)) return `Le référentiel de trajet embarqué reste limité à Dakar–Diamniadio. Les présentations SENTER mentionnent 14 gares et l’AIBD, tandis que sa page Services en gare décrit 13 gares et haltes Dakar–Diamniadio. Ces pages seules ne suffisent pas à confirmer l’ouverture et les horaires d’une extension vers l’aéroport.${source(SOURCES.terStations)}`
  }
  if (/\b(circulation|embouteillage|embouteillages|trafic routier)\b/.test(text)) return `Aucun flux de circulation en temps réel n’est connecté. Les indicateurs CETUD consultés sont des statistiques historiques (2020–2024), pas l’état actuel d’une rue. Je ne peux pas annoncer qu’une route est fluide ni chiffrer un retard actuel. Les signalements de l’onglet Alertes restent des témoignages non vérifiés.${source(SOURCES.traffic)}`
  return null
}

function mentions(place: string, question: string): boolean {
  const name = normalizeMobility(place).replace(/^terminus /, '').replace(/\s*\(.*/, '')
  return name.length >= 4 && ` ${question} `.includes(` ${name} `)
}
function busRouteReply(question: string, networks: string[]): KnowledgeReply | null {
  const route = /\b(?:de|depuis) (.+?) (?:a|vers|jusqu a) (.+?)(?: en bus| en ddd| en aftu| en tata| avec .*)?$/.exec(question)
  if (!route) return null
  const [, from, to] = route
  // Préserver les parcours TER/BRT déjà calculables, sauf choix bus explicite.
  if (!networks.length && searchCorridorStops(from).length && searchCorridorStops(to).length) return null
  const candidates = BUS_LINES.filter((line) => (!networks.length || networks.includes(line.network)) && !line.note?.startsWith('Divergence'))
  const matched = candidates.filter((line) => {
    const points = line.waypoints.length ? line.waypoints : [line.origin, line.destination]
    const start = points.findIndex((point) => mentions(from, normalizeMobility(point)))
    const end = points.findIndex((point) => mentions(to, normalizeMobility(point)))
    return start >= 0 && end > start
  })
  if (!matched.length) return networks.length ? { text: 'Je ne trouve pas de parcours direct dans le sens demandé parmi les fiches bus transcrites. Cela ne signifie pas qu’aucune ligne existe. Précisez le numéro, le quartier et le sens ; les correspondances bus et le sens retour ne sont pas encore validés.' } : null
  return { text: `Pistes documentaires pour ${from} → ${to} :\n${matched.slice(0, 4).map((line) => `• ${label(line)}${line.waypoints.length ? '' : ' (terminus seulement)'}`).join('\n')}\nÀ confirmer auprès de l’opérateur avant le départ : ni arrêt d’embarquement précis, ni durée, ni prochain départ garanti. Demandez le numéro d’une ligne pour ses points de passage.${[...new Set(matched.slice(0, 4).map((line) => line.detailSourceUrl ?? line.sourceUrl))].map((url) => source(url)).join('')}`, ...(matched.length === 1 ? { lineId: key(matched[0]) } : {}) }
}

export function answerMobilityKnowledge(question: string, lastLineId?: string | null): KnowledgeReply | null {
  const text = normalizeMobility(question)
  const networks = explicitNetworks(text)
  const code = /\b(?:ligne|bus|ddd|aftu|tata)\s*(?:numero\s*|n\s*)?0*(\d+[ab]?|to1)\b/.exec(text)?.[1]?.toUpperCase()
  if (code) {
    const matches = BUS_LINES.filter((line) => line.code === code && (!networks.length || networks.includes(line.network)))
    if (matches.length > 1) return { text: `Ce numéro existe sur plusieurs réseaux :\n${matches.map((line) => `• ${label(line)}`).join('\n')}\nPrécisez DDD ou AFTU pour éviter de vous orienter vers le mauvais bus.` }
    if (matches.length === 1) {
      const reply = lineReply(matches[0], question)
      if (/\btata\b/.test(text)) reply.text = 'Si vous désignez la ligne AFTU par « TATA », voici sa fiche :\n' + reply.text
      return reply
    }
    return { text: `La ligne ${code}${networks.length ? ` ${networks.join('/')}` : ''} n’est pas documentée dans ma mémoire actuelle. Cela ne prouve pas son absence du réseau. Précisez l’opérateur ou consultez son plan officiel ; je n’invente ni numéro ni parcours.` }
  }
  if (lastLineId && /^(et |ses |les horaires|les arrets|son |elle passe|le prix)/.test(text) && !networks.length && !/\b(ter|brt|train|meteo|temperature)\b/.test(text)) {
    const line = BUS_LINES.find((entry) => key(entry) === lastLineId)
    if (line) return lineReply(line, question)
  }
  const practical = practicalReply(text)
  if (practical) return { text: practical }
  if (!/\b(ter|brt|train)\b/.test(text)) {
    const route = busRouteReply(text, networks)
    if (route) return route
  }
  if (networks.length) {
    const lines = BUS_LINES.filter((line) => networks.includes(line.network))
    if (/\b(liste|lignes|numeros)\b/.test(text)) return { text: `${networks.map((network) => network.toUpperCase()).join(' / ')} : numéros documentés dans la mémoire (pas une garantie d’exhaustivité) :\n${networks.map((network) => `${network.toUpperCase()} : ${lines.filter((line) => line.network === network).map((line) => line.code).join(', ')}`).join('\n')}\nDemandez « itinéraire AFTU 53 » ou « ligne DDD 1 » pour le détail.${source(networks[0] === 'ddd' ? SOURCES.dddLines : SOURCES.aftuLines)}` }
    if (/\b(telephone|contact|joindre|appeler)\b/.test(text)) return { text: networks.includes('ddd') ? `DDD : 33 824 10 10 ; info@demdikk.sn.${source(SOURCES.ddd)}` : `AFTU : +221 33 859 02 88 ; siège Zone de captage, 440–441 Dakar.${source(SOURCES.aftuLines)}` }
    if (/\b(arret|arrets|passe|dessert|ligne|aller)\b/.test(text)) {
      const serving = lines.filter((line) => [line.origin, line.destination, ...line.waypoints].some((point) => mentions(point, text)))
      if (serving.length) return { text: `Fiches mentionnant ce lieu :\n${serving.slice(0, 6).map((line) => `• ${label(line)}`).join('\n')}\nRepères textuels seulement, pas des arrêts géolocalisés. Précisez le numéro pour le parcours et ses réserves.${source(networks[0] === 'ddd' ? SOURCES.dddLines : SOURCES.aftuLines)}` }
    }
    if (/\b(tata)\b/.test(text)) return { text: `Pour les minibus que vous appelez « TATA », je peux consulter les fiches AFTU si vous précisez le numéro. Je n’assimile pas automatiquement tout véhicule TATA à une ligne AFTU. ${busKnowledgeSummary()}${source(SOURCES.aftuLines)}` }
    if (/\b(presente|presentation|reseau|connaitre|connais|c est quoi)\b/.test(text)) return { text: networks.includes('ddd') ? `CETUD décrit DDD avec 38 lignes, 400 autobus et une amplitude générale 06h–21h. Ce n’est pas l’horaire de chaque ligne. ${busKnowledgeSummary()}${source(SOURCES.ddd)}` : `CETUD décrit AFTU avec 72 lignes, 2 300 bus, 14 GIE et une amplitude générale 06h–21h. Ce n’est pas l’horaire de chaque ligne. ${busKnowledgeSummary()}${source(SOURCES.aftu)}` }
  }
  return null
}
