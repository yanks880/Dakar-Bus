/**
 * Code couleur officiel des mobilités de Dakar Bus.
 *
 * Une seule source pour les tracés Leaflet, les pastilles, les listes,
 * l’assistant et les résultats de recherche. Les teintes ne sont pas dérivées
 * du vert signature de l’application : chaque réseau se reconnaît d’un coup d’œil.
 *
 * Paires officielles :
 * - TER — bleu nuit / ferroviaire (#003366 / #1D4ED8)
 * - BRT — vert électrique / émeraude (#00A859 / #10B981)
 * - DDD — jaune / or national (#F59E0B / #EAB308)
 * - AFTU / TATA — orange ambré / marron (#D97706 / #C05621)
 *
 * AFTU et TATA partagent cette dernière paire. Pour les distinguer sans sortir
 * de la palette, AFTU prend l’ambre comme couleur dominante et TATA le marron.
 * La seconde teinte reste visible en accent (pastille, liseré de tracé).
 *
 * `ink` n’est pas une teinte de réseau : c’est le texte posé sur la pastille,
 * choisi pour un contraste AA d’au moins 4,5:1.
 */

export const MOBILITY_IDS = ['ter', 'brt', 'ddd', 'aftu', 'tata'] as const

export type MobilityId = (typeof MOBILITY_IDS)[number]

export interface MobilityPaint {
  id: MobilityId
  label: string
  /** Nom officiel de la paire de teintes. */
  name: string
  /** Couleur dominante des pastilles et des puces d’arrêt. */
  badge: string
  /** Texte sur `badge` (contraste AA). */
  ink: string
  /** Seconde teinte officielle. */
  bright: string
  /** Cœur du tracé cartographique. */
  core: string
  /** Liseré du tracé, l’autre teinte de la paire. */
  casing: string
}

export const MOBILITY_PALETTE: Record<MobilityId, MobilityPaint> = {
  ter: {
    id: 'ter',
    label: 'TER',
    name: 'Bleu nuit / ferroviaire',
    badge: '#003366',
    ink: '#FFFFFF',
    bright: '#1D4ED8',
    core: '#1D4ED8',
    casing: '#003366',
  },
  brt: {
    id: 'brt',
    label: 'BRT',
    name: 'Vert électrique / émeraude',
    badge: '#00A859',
    ink: '#1C1408',
    bright: '#10B981',
    core: '#00A859',
    casing: '#10B981',
  },
  ddd: {
    id: 'ddd',
    label: 'DDD',
    name: 'Jaune / or national',
    badge: '#F59E0B',
    ink: '#1C1408',
    bright: '#EAB308',
    core: '#F59E0B',
    casing: '#EAB308',
  },
  aftu: {
    id: 'aftu',
    label: 'AFTU',
    name: 'Orange ambré / marron',
    badge: '#D97706',
    ink: '#1C1408',
    bright: '#C05621',
    core: '#D97706',
    casing: '#C05621',
  },
  tata: {
    id: 'tata',
    label: 'TATA',
    name: 'Orange ambré / marron',
    badge: '#C05621',
    ink: '#FFFFFF',
    bright: '#D97706',
    core: '#C05621',
    casing: '#D97706',
  },
}

const TOKEN = /(?<![0-9A-Za-zÀ-ÿ])(Dakar Dem Dikk|Sunu\s?BRT|TER|BRT|DDD|AFTU|TATA|B[1-3])(?![0-9A-Za-zÀ-ÿ])/gi

export function isMobilityId(value: string | null | undefined): value is MobilityId {
  return Boolean(value && (MOBILITY_IDS as readonly string[]).includes(value))
}

export function mobilityPaint(id: string | null | undefined): MobilityPaint | null {
  return isMobilityId(id) ? MOBILITY_PALETTE[id] : null
}

/** Sigle, ligne B1–B3 ou nom de marque → réseau. `null` si ce n’est pas une mobilité. */
export function mobilityIdFromToken(token: string): MobilityId | null {
  const key = token.toLowerCase().replace(/\s+/g, '')
  if (key === 'ter') return 'ter'
  if (key === 'brt' || key === 'sunubrt' || /^b[1-3]$/.test(key)) return 'brt'
  if (key === 'ddd' || key === 'dakardemdikk') return 'ddd'
  if (key === 'aftu') return 'aftu'
  if (key === 'tata') return 'tata'
  return null
}

export interface MobilitySpan {
  text: string
  id: MobilityId | null
  /** `sigil` : pastille (TER, B1…). `mention` : nom long coloré sans pastille pleine. */
  kind: 'text' | 'sigil' | 'mention'
}

export function mobilitySpans(text: string): MobilitySpan[] {
  const spans: MobilitySpan[] = []
  let cursor = 0
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0
    const raw = match[1]
    if (start > cursor) spans.push({ text: text.slice(cursor, start), id: null, kind: 'text' })
    const id = mobilityIdFromToken(raw)
    const sigil = /^(ter|brt|ddd|aftu|tata|b[1-3])$/i.test(raw)
    spans.push({ text: raw, id, kind: id && sigil ? 'sigil' : id ? 'mention' : 'text' })
    cursor = start + raw.length
  }
  if (cursor < text.length || spans.length === 0) spans.push({ text: text.slice(cursor), id: null, kind: 'text' })
  return spans
}

/** Réseaux cités dans un libellé, sans doublon, dans l’ordre d’apparition. */
export function mobilityIdsIn(text: string): MobilityId[] {
  const ids: MobilityId[] = []
  for (const span of mobilitySpans(text)) {
    if (span.id && !ids.includes(span.id)) ids.push(span.id)
  }
  return ids
}

/**
 * Réseau unique d’un libellé de course ou de ligne.
 * `null` si aucun sigle n’est cité, ou si deux réseaux le sont (pas d’invention).
 */
export function mobilityFromLabel(text: string): MobilityId | null {
  const ids = mobilityIdsIn(text)
  return ids.length === 1 ? ids[0] : null
}

/** Puce d’arrêt de référence : le préfixe d’identifiant est déclaré, pas deviné. */
export function mobilityFromStopId(stopId: string): MobilityId | null {
  if (stopId.startsWith('ter')) return 'ter'
  if (stopId.startsWith('brt')) return 'brt'
  return null
}
