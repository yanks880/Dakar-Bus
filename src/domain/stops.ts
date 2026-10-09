/**
 * Index de recherche unique de l'onglet Trajet : toutes les mobilités
 * suivies et tous les arrêts réellement déclarés dans l'application.
 *
 * Périmètre honnête :
 *  - les cinq mobilités de Dakar (TER, BRT, DDD, AFTU, TATA) sont cherchables
 *    par leur nom, leur sigle et leur autorité (SETER, SunuBRT, CETUD…) ;
 *  - seuls les arrêts réellement connus sont proposés comme point de départ
 *    ou d'arrivée : les gares TER (référence SETER), les stations BRT
 *    (référence SunuBRT) et les arrêts du snapshot publié ;
 *  - une mobilité dont les arrêts ne sont pas déclarés (AFTU, DDD, TATA)
 *    apparaît dans les résultats pour être trouvée, mais elle explique
 *    aussitôt pourquoi elle ne peut pas servir de point : aucune liste
 *    d'arrêts n'est inventée pour « faire joli ».
 */

import { BRT_STOPS, TER_STOPS, type CorridorStop } from './corridors'
import { NETWORK_SOURCES, type NetworkId } from './network'
import type { PublishedStop } from './published'

export type StopOptionKind = 'network' | 'reference' | 'published'

export interface StopOption {
  /** Valeur opaque échangée avec l'UI : « published:<id> », « ref:<id> », « network:<id> ». */
  value: string
  kind: StopOptionKind
  label: string
  group: string
  /** Précision affichée sous le libellé (réseau, source, coordonnées…). */
  hint: string
  /** Une mobilité sans arrêt déclaré informe, elle ne définit pas de point. */
  selectable: boolean
  networkId: NetworkId | null
  stopId: string | null
  lat: number | null
  lon: number | null
  /** Termes supplémentaires cherchables (sigles, autorités, alias). */
  keywords: readonly string[]
}

export const GROUP_MOBILITY = 'Mobilités'
export const GROUP_PUBLISHED = 'Arrêts publiés'
export const GROUP_TER = 'TER · SETER'
export const GROUP_BRT = 'BRT · SunuBRT'

/** Mots-clés cherchables par réseau : sigles, exploitants et autorités cités. */
const NETWORK_KEYWORDS: Record<NetworkId, readonly string[]> = {
  ter: ['ter', 'senter', 'sen ter', 'seter', 'train', 'train express regional', 'gare'],
  brt: ['brt', 'sunubrt', 'sunu brt', 'bus rapid transit', 'b1', 'dakar mobilite', 'station'],
  ddd: ['ddd', 'dakar dem dikk', 'dem dikk', 'cetud', 'bus urbain'],
  aftu: ['aftu', 'cetud', 'minibus', 'ndiaga ndiaye', 'car rapide'],
  tata: ['tata', 'reseau independant', 'taxi', 'clando'],
  other: ['autre'],
}

const NETWORK_SOURCE_LABEL: Record<NetworkId, string> = {
  ter: 'Référence SETER',
  brt: 'Référence SunuBRT / CETUD',
  ddd: 'Référence CETUD',
  aftu: 'Référence CETUD',
  tata: 'Référence catalogue',
  other: 'Source non déclarée',
}

export function normalizeSearchTerm(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`-]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function networkHint(id: NetworkId, stopCount: number | null): string {
  if (id === 'ter') return `${stopCount ?? 0} gares · ${NETWORK_SOURCE_LABEL.ter}`
  if (id === 'brt') return `${stopCount ?? 0} stations · ${NETWORK_SOURCE_LABEL.brt}`
  const network = NETWORK_SOURCES.find((item) => item.id === id)
  const counts = [
    network?.referenceData?.lineCount ? `${network.referenceData.lineCount} lignes` : null,
    network?.referenceData?.vehicleCount ? `${network.referenceData.vehicleCount.toLocaleString('fr-FR')} bus` : null,
  ].filter((value): value is string => value !== null)
  const detail = counts.length > 0 ? counts.join(' · ') : NETWORK_SOURCE_LABEL[id]
  return `${detail} · arrêts non publiés`
}

function corridorOption(stop: CorridorStop, network: NetworkId, group: string): StopOption {
  return {
    value: `ref:${stop.id}`,
    kind: 'reference',
    label: stop.name,
    group,
    hint: `${network === 'ter' ? 'TER' : 'BRT'} · ${stop.note ?? NETWORK_SOURCE_LABEL[network]}`,
    selectable: true,
    networkId: network,
    stopId: stop.id,
    lat: stop.lat,
    lon: stop.lon,
    keywords: [...stop.aliases, network === 'ter' ? 'ter' : 'brt'],
  }
}

function publishedOption(stop: PublishedStop): StopOption {
  return {
    value: `published:${stop.stopId}`,
    kind: 'published',
    label: stop.stopName,
    group: GROUP_PUBLISHED,
    hint: `Arrêt publié · ${stop.stopId}`,
    selectable: stop.lat !== null && stop.lon !== null,
    networkId: null,
    stopId: stop.stopId,
    lat: stop.lat,
    lon: stop.lon,
    keywords: [stop.stopId, stop.parentStation ?? ''],
  }
}

/** Index complet : mobilités, arrêts publiés, puis réseaux de référence. */
export function buildStopIndex(publishedStops: readonly PublishedStop[]): StopOption[] {
  const networks: StopOption[] = NETWORK_SOURCES.map((network) => {
    const stopCount =
      network.id === 'ter' ? TER_STOPS.length : network.id === 'brt' ? BRT_STOPS.length : null
    return {
      value: `network:${network.id}`,
      kind: 'network' as const,
      label: network.referenceData?.shortName ?? network.label,
      group: GROUP_MOBILITY,
      hint: networkHint(network.id, stopCount),
      selectable: false,
      networkId: network.id,
      stopId: null,
      lat: null,
      lon: null,
      keywords: [...NETWORK_KEYWORDS[network.id], network.label, network.description],
    }
  })

  return [
    ...networks,
    ...publishedStops.filter((stop) => stop.lat !== null && stop.lon !== null).map(publishedOption),
    ...TER_STOPS.map((stop) => corridorOption(stop, 'ter', GROUP_TER)),
    ...BRT_STOPS.map((stop) => corridorOption(stop, 'brt', GROUP_BRT)),
  ]
}

function scoreOption(option: StopOption, needle: string): number | null {
  if (!needle) return 0
  const label = normalizeSearchTerm(option.label)
  if (label === needle) return 0
  if (label.startsWith(needle)) return 1
  if (label.split(' ').some((word) => word.startsWith(needle))) return 2
  for (const keyword of option.keywords) {
    const normalized = normalizeSearchTerm(keyword)
    if (normalized === needle) return 2
    if (normalized.startsWith(needle)) return 3
    if (normalized.includes(needle)) return 4
  }
  if (label.includes(needle)) return 4
  return null
}

const GROUP_ORDER: readonly string[] = [GROUP_MOBILITY, GROUP_PUBLISHED, GROUP_TER, GROUP_BRT]

/**
 * Recherche tolérante (accents, apostrophes, tirets) sur l'index complet.
 * Aucun résultat n'est extrapolé : seules les correspondances explicites
 * et les mots-clés déclarés remontent.
 */
export function searchStopIndex(
  options: readonly StopOption[],
  query: string,
  limit = 12,
): StopOption[] {
  const needle = normalizeSearchTerm(query)
  if (!needle) return []
  const scored: { option: StopOption; score: number }[] = []
  for (const option of options) {
    const score = scoreOption(option, needle)
    if (score === null) continue
    scored.push({ option, score })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    const groupDelta = GROUP_ORDER.indexOf(a.option.group) - GROUP_ORDER.indexOf(b.option.group)
    if (groupDelta !== 0) return groupDelta
    return a.option.label.localeCompare(b.option.label, 'fr')
  })
  const seen = new Set<string>()
  return scored
    .filter((entry) => {
      if (seen.has(entry.option.value)) return false
      seen.add(entry.option.value)
      return true
    })
    .slice(0, limit)
    .map((entry) => entry.option)
}

export function findStopOption(options: readonly StopOption[], value: string): StopOption | null {
  return options.find((option) => option.value === value) ?? null
}
