/**
 * Verrouillage de la hauteur d'affichage à l'ouverture du clavier mobile.
 *
 * Constat du 10 octobre 2026 : dès que l'usager touchait le champ « On va où ? »,
 * l'ouverture du clavier réduisait la fenêtre utile. La coquille (`100dvh`) et
 * la carte Leaflet se redimensionnaient alors en cascade : la page se décalait
 * vers le haut, l'en-tête et le logo étaient rognés, et la carte se recalculait
 * sous les yeux de l'usager.
 *
 * Ce module ne touche pas au DOM. À partir de mesures brutes il décide
 * seulement :
 *   1. si un clavier virtuel recouvre l'écran (`keyboardIsOpen`) ;
 *   2. quelle hauteur appliquer au conteneur de l'application
 *      (`resolveShellHeight`) — la dernière hauteur connue clavier fermé est
 *      conservée tant que le clavier est ouvert ;
 *   3. si la carte peut se recalculer (`shouldResizeMap`) — jamais pendant
 *      l'ouverture du clavier ;
 *   4. de combien décaler le conteneur défilant pour que le champ reste lisible
 *      au-dessus du clavier (`fieldScrollShift`), sans jamais déplacer
 *      l'en-tête.
 *
 * Tout est éprouvé dans `viewportLock.test.ts`.
 */

/**
 * Perte de hauteur à partir de laquelle un clavier virtuel est réputé ouvert.
 * Les claviers mesurés (iOS Safari, Chrome Android) occupent 240 à 380 px ;
 * 120 px laisse la barre d'adresse mobile se replier, ou une rotation
 * s'achever, sans déclencher le verrou par erreur.
 */
export const KEYBOARD_MIN_LOSS_PX = 120

/** Marge conservée autour du champ ramené dans la partie visible de l'écran. */
export const FIELD_VISIBLE_MARGIN_PX = 12

/**
 * En dessous de ce seuil, un changement de taille de la carte est un arrondi de
 * mise en page : il ne justifie pas un recalcul complet des tuiles.
 */
export const MAP_RESIZE_MIN_DELTA_PX = 4

/** Types d'`<input>` qui appellent réellement le clavier virtuel. */
const KEYBOARD_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'url',
  'tel',
  'email',
  'number',
  'password',
])

/** Mesures brutes de la fenêtre, lues au moment de l'événement. */
export interface ViewportMeasure {
  /** `window.innerHeight` : hauteur de la fenêtre de mise en page. */
  layoutHeight: number
  /** `window.visualViewport?.height` : `null` quand l'API est absente. */
  visualHeight: number | null
}

/** Mesures complétées de l'état de saisie et de la hauteur déjà verrouillée. */
export interface KeyboardContext extends ViewportMeasure {
  /** Un champ appelant le clavier a le focus (`focusin`). */
  editing: boolean
  /** Dernière hauteur appliquée alors qu'aucun clavier n'était ouvert. */
  lockedHeight: number
}

/** Forme minimale d'un élément recevant le focus : rien du DOM n'est exigé. */
export interface FocusTarget {
  tagName: string
  /** Attribut `type` d'un `<input>` ; absent des autres éléments. */
  type?: string | null
  isContentEditable?: boolean
}

/**
 * Le clavier virtuel est-il ouvert ?
 *
 * Deux signatures sont reconnues, parce que les navigateurs ne réagissent pas
 * de la même façon :
 *   - `resizes-visual` (défaut Chrome Android, iOS Safari) : la fenêtre de mise
 *     en page garde sa hauteur, seule la fenêtre visuelle se réduit ;
 *   - `resizes-content` : la fenêtre de mise en page se réduit aussi, et seule
 *     la hauteur verrouillée permet de voir la perte.
 * Hors saisie, aucune des deux ne suffit : un redimensionnement réel de la
 * fenêtre (bureau, rotation) n'est jamais pris pour un clavier.
 */
export function keyboardIsOpen(context: KeyboardContext): boolean {
  if (!context.editing) return false
  const { layoutHeight, visualHeight, lockedHeight } = context
  if (visualHeight !== null && layoutHeight - visualHeight >= KEYBOARD_MIN_LOSS_PX) return true
  return lockedHeight - layoutHeight >= KEYBOARD_MIN_LOSS_PX
}

/**
 * Hauteur à appliquer au conteneur de l'application, en pixels.
 * Clavier ouvert, la hauteur verrouillée est rendue telle quelle : la mise en
 * page ne bouge pas, l'en-tête n'est pas rogné.
 */
export function resolveShellHeight(context: KeyboardContext): number {
  return keyboardIsOpen(context) ? context.lockedHeight : context.layoutHeight
}

/** L'élément qui reçoit le focus appelle-t-il le clavier virtuel ? */
export function summonsKeyboard(target: FocusTarget | null | undefined): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  const tag = target.tagName.toUpperCase()
  if (tag === 'TEXTAREA') return true
  if (tag !== 'INPUT') return false
  const type = (target.type ?? 'text').toLowerCase()
  return KEYBOARD_INPUT_TYPES.has(type)
}

/** Taille d'une boîte, en pixels entiers. */
export interface BoxSize {
  width: number
  height: number
}

/**
 * La carte Leaflet peut-elle être recalculée (`invalidateSize`) ?
 *
 * Faux pendant l'ouverture du clavier : la carte garde sa taille et ses tuiles,
 * elle est simplement recouverte. Faux aussi en dessous du seuil d'arrondi, pour
 * qu'un sous-pixel de mise en page ne déclenche pas un redessin complet.
 */
export function shouldResizeMap(input: {
  previous: BoxSize
  next: BoxSize
  keyboardOpen: boolean
}): boolean {
  if (input.keyboardOpen) return false
  const delta = Math.max(
    Math.abs(input.next.width - input.previous.width),
    Math.abs(input.next.height - input.previous.height),
  )
  return delta >= MAP_RESIZE_MIN_DELTA_PX
}

/** Position d'un champ et de la partie réellement visible, dans un même repère. */
export interface VisibleField {
  fieldTop: number
  fieldBottom: number
  visibleTop: number
  visibleBottom: number
  margin?: number
}

/**
 * Décalage à ajouter au `scrollTop` du conteneur pour ramener le champ dans la
 * partie visible de l'écran, clavier déduit. Zéro quand le champ y est déjà :
 * rien ne bouge. Le défilement est appliqué au conteneur du champ, jamais au
 * document : l'en-tête reste en place.
 */
export function fieldScrollShift(field: VisibleField): number {
  const margin = field.margin ?? FIELD_VISIBLE_MARGIN_PX
  const bottomLimit = field.visibleBottom - margin
  if (field.fieldBottom > bottomLimit) return field.fieldBottom - bottomLimit
  const topLimit = field.visibleTop + margin
  if (field.fieldTop < topLimit) return field.fieldTop - topLimit
  return 0
}
