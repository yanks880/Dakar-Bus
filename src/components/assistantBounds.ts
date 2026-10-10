/** Bornes en pixels CSS : aucune largeur ne doit dépasser le viewport visuel,
 * y compris lorsque le clavier ou le zoom réduit sa surface. */
export function assistantBounds(
  anchor: { right: number; bottom: number },
  viewport: { width: number; height: number; left: number; top: number; keyboardOpen: boolean },
) {
  const margin = 12
  const width = Math.max(0, Math.min(360, viewport.width - margin * 2))
  const left = Math.max(viewport.left + margin, Math.min(anchor.right - width, viewport.left + viewport.width - width - margin))
  const bottomSpace = viewport.keyboardOpen ? margin : Math.min(88, viewport.height * .2)
  const top = Math.max(viewport.top + margin, Math.min(anchor.bottom + 8, viewport.top + viewport.height - bottomSpace - 200))
  const maxHeight = Math.max(0, Math.min(360, viewport.top + viewport.height - top - bottomSpace))
  return { left, top, width, maxHeight }
}
