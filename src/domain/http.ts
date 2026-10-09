/**
 * Utilitaires réseau de l'interface : délai d'attente, lecture JSON tolérante
 * et validation des liens externes.
 *
 * Règle : une requête lente ou bloquée ne doit jamais figer l'écran. Au bout
 * de `API_TIMEOUT_MS`, la requête est annulée et traitée comme une absence de
 * réponse du serveur — jamais comme une donnée.
 */

export const API_TIMEOUT_MS = 12_000

export interface TimedRequestOptions {
  /** Annulation externe (par exemple au démontage d’un composant). */
  signal?: AbortSignal
  timeoutMs?: number
  /** Injection pour les tests ; par défaut, l’API `fetch` du navigateur. */
  fetcher?: typeof fetch
}

/**
 * Exécute une requête annulable dans un délai borné. La lecture du corps
 * (`read`) reste sous le même chronomètre : un corps qui n’arrive jamais est
 * aussi une erreur réseau. Les erreurs (réseau, délai, lecture) remontent
 * telles quelles à l’appelant, qui décide du message à afficher.
 */
export async function timedRequest<T>(
  input: string,
  options: TimedRequestOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { signal, timeoutMs = API_TIMEOUT_MS, fetcher = fetch } = options
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetcher(input, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    return await read(response)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Lit un corps JSON ; renvoie `undefined` si le corps n’est pas du JSON. */
export async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Renvoie l’URL normalisée seulement si elle est `http(s)`. Sert à éviter tout
 * lien `javascript:` ou `data:` si une source venait à être mal renseignée.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** Coordonnées géographiques valides (dans les bornes du globe). */
export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  )
}
