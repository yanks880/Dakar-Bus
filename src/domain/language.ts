/**
 * Couche linguistique français / wolof du copilote.
 *
 * Honnêteté : la compréhension et la production du wolof reposent ici sur des
 * marqueurs lexicaux et des modèles de phrases de base. Ce n'est ni un modèle
 * de langue entraîné, ni une couverture de toutes les variantes dialectales.
 * La détection distingue le français, le wolof et les phrases mixtes ; quand
 * la confiance est insuffisante, l'application répond en français et le dit.
 */

export type AssistantLanguagePreference = 'auto' | 'fr' | 'wo'
export type DetectedLanguage = 'fr' | 'wo' | 'mixed' | 'undetermined'
export type ResponseLanguage = 'fr' | 'wo'

const STORAGE_KEY = 'dakar-bus:assistant-language'

/**
 * Marqueurs wolof non ambigus : leur présence suffit à orienter la détection.
 * Ils sont testés avec des frontières de mot sur le texte normalisé (les
 * diacritiques wolof — ë, ñ, ó, à — sont conservées).
 */
const WOLOF_STRONG_MARKERS: readonly string[] = [
  'nanga def', 'nangadef', 'maa ngi', 'ma ngi', 'mangi', 'maangi',
  'bëgg', 'begg a', 'ndax', 'lu tax', 'loutax', 'ñaata', 'niata', 'ñaata la',
  'fan la', 'fanna', 'kanam', 'ginaaw', 'ginaaw bi', 'wàcc', 'wacc', 'wàccal',
  'yéeg', 'yeeg', 'dëgg', 'deug', 'dëgg-dëgg', 'jërëjëf', 'jërejëf', 'ërëjëf',
  'tey', 'suba', 'ngir', 'wax', 'wax ma', 'xam', 'xam na', 'xamuma', 'am na',
  'amul', 'dama', 'dinga', 'nga def', 'ñu ngi', 'nu ngi', 'dafay', 'dana',
  'doon', 'dem na', 'dem ci', 'dem ak', 'jóge', 'joge', 'egg', 'eggsi',
  'agsi na', 'yoon wi', 'yonn wi', 'takkussan', 'léegi', 'légi', 'noonu',
  'waaw', 'déedéet', 'deedet', 'gëna', 'gën a', 'soxla', 'fàww', 'faww',
  'ci kanam', 'ba tey', 'sax', 'ndëgg', 'ndeysaan', 'sama', 'yën', 'yeen',
  'war na', 'mën na', 'men na', 'amul solo', 'lu mel ni', 'noppal', 'fayda',
  'ak sama', 'baax na', 'baaxul', 'jar na', 'jeex na', 'ànd ak', 'and ak',
]

/** Mots-outils wolof fréquents mais ambigus (ils ne comptent qu'en appoint). */
const WOLOF_WEAK_MARKERS: readonly string[] = [
  'ci', 'ak ', ' ak', 'la ', ' la', 'na ', ' na', 'nga', 'ñu', 'nu dem',
  'bu ', ' bu', 'su ', 'bi ', ' bi', 'yi ', ' yi', 'yu ', 'sa ', 'sama',
]

// Le signal français porte sur la structure (mots interrogatifs, pronoms,
// tournures) plutôt que sur le vocabulaire transport, largement partagé avec
// le wolof parlé à Dakar (« station », « bus », « gare » sont des emprunts).
const FRENCH_MARKERS: readonly string[] = [
  'je ', 'j\'ai', 'je veux', 'je voudrais', 'est-ce', 'est ce', 'quel ', 'quelle ',
  'quels ', 'quelles ', 'comment ', 'pourquoi ', 'quand ', 'où est', 'ou est',
  'où se trouve', 'où se', 'le train', 'la ligne', 'lesquels', 'lesquelles',
  'un bus', 'une ', 's\'il', 'qu\'est-ce', 'y a-t-il', 'la liste',
  'aller de', 'aller à', 'aller a', 'à quelle heure', 'l\'horaire',
  'donne-moi', 'donnez-moi', 'peux-tu', 'puis-je', 'est-il ', 'sont-ils',
  'trajet', 'itinéraire', 'itineraire', 'bonjour', 'bonsoir', 'salut', 'merci',
]

/** Normalisation qui conserve les diacritiques wolof mais retire la casse. */
export function normalizeForDetection(value: string): string {
  return value.toLowerCase().replace(/['’]/g, ' ').replace(/\s+/g, ' ').trim()
}

function containsMarker(text: string, marker: string): boolean {
  const trimmed = marker.trim()
  if (trimmed.includes(' ')) return text.includes(trimmed)
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-zëàñóŋ])${escaped}(?:$|[^a-zëàñóŋ])`, 'i').test(text)
}

/**
 * Détecte la langue dominante d'une question. Une phrase qui mélange les deux
 * langues est signalée « mixed » ; sans marqueur exploitable, « undetermined ».
 */
export function detectLanguage(question: string): DetectedLanguage {
  const text = normalizeForDetection(question)
  if (!text) return 'undetermined'
  const wolofScore =
    WOLOF_STRONG_MARKERS.filter((marker) => containsMarker(text, marker)).length +
    WOLOF_WEAK_MARKERS.filter((marker) => containsMarker(text, marker)).length / 3
  const frenchScore = FRENCH_MARKERS.filter((marker) => containsMarker(text, marker)).length
  if (wolofScore >= 1 && frenchScore >= 1) return 'mixed'
  if (wolofScore >= 1) return 'wo'
  if (frenchScore >= 1) return 'fr'
  return 'undetermined'
}

/**
 * Langue de réponse effective : la préférence explicite gagne ; en mode
 * automatique, une question wolof ou mixte reçoit une réponse wolof (dans la
 * limite des modèles disponibles), sinon français.
 */
export function resolveResponseLanguage(
  preference: AssistantLanguagePreference,
  detected: DetectedLanguage,
): ResponseLanguage {
  if (preference === 'fr') return 'fr'
  if (preference === 'wo') return 'wo'
  return detected === 'wo' || detected === 'mixed' ? 'wo' : 'fr'
}

export function loadAssistantLanguagePreference(fallback: AssistantLanguagePreference = 'auto'): AssistantLanguagePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'fr' || raw === 'wo' || raw === 'auto') return raw
    return fallback
  } catch {
    return fallback
  }
}

export function saveAssistantLanguagePreference(preference: AssistantLanguagePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Le stockage peut être indisponible (navigation privée) : la préférence
    // reste alors en mémoire pour la session, sans erreur pour l'usager.
  }
}
