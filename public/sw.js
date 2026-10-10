// Service worker de Dakar Bus.
// Version du cache : incrémenter à chaque changement de stratégie. L'activation
// purge tous les caches "dakar-bus-*" qui ne portent pas ce nom.
//
// v5 borne le cache. Sans plafond, chaque publication ajoute des fichiers
// hachés dans le même cache et rien ne les retire tant que le nom ne change pas.

/* policy:start */
const CACHE_NAME = 'dakar-bus-shell-v5'
// Shell (page, manifeste, icône) + quelques générations d'assets hachés.
// Assez large pour un usage hors ligne, assez étroit pour ne pas croître sans fin.
const MAX_CACHE_ENTRIES = 48
const SHELL_SUFFIXES = ['manifest.webmanifest', 'icons/icon.svg']

function isApiPath(pathname) {
  // "/api" avec ou sans slash final, y compris sous le préfixe GitHub Pages.
  return /\/api(\/|$)/.test(pathname)
}

function isShellPath(pathname, basePath) {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`
  if (pathname === base || pathname === base.slice(0, -1)) return true
  return SHELL_SUFFIXES.some((suffix) => pathname === `${base}${suffix}`)
}

/**
 * Clés à retirer pour rester sous `maxEntries`.
 *
 * Réserve ouverte : `keys` est supposé être l'ordre d'insertion de
 * `cache.keys()` (la plus ancienne en tête), comme le décrit la spécification
 * Cache. Cet ordre n'est pas vérifié dans un navigateur.
 *
 * Les entrées du shell ne sont jamais évincées : sinon le repli hors ligne
 * de la page d'accueil disparaîtrait. Si le shell dépasse déjà le plafond,
 * on n'évince que le reste — le cache peut alors rester au-dessus du plafond.
 * Un plafond illisible n'évince rien.
 */
function keysToEvict(keys, maxEntries, isProtected) {
  if (!Number.isFinite(maxEntries) || maxEntries < 1) return []
  const list = Array.from(keys)
  let protectedCount = 0
  for (const key of list) {
    if (isProtected(key)) protectedCount += 1
  }
  const overflow = list.length - Math.max(maxEntries, protectedCount)
  if (overflow <= 0) return []
  const evictable = list.filter((key) => !isProtected(key))
  return evictable.slice(0, overflow)
}
/* policy:end */

const BASE_PATH = new URL('.', self.location.href).pathname
const APP_SHELL = [BASE_PATH, ...SHELL_SUFFIXES.map((suffix) => BASE_PATH + suffix)]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith('dakar-bus-') && key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

/**
 * Met en cache puis évince le surplus.
 * Réserve ouverte, préexistante depuis dakar-bus-shell-v4 : ce put n'est pas
 * dans `event.waitUntil`. Le navigateur peut interrompre l'écriture si
 * l'événement `fetch` se termine avant. La borne ne corrige pas ce point et
 * ne l'aggrave pas — ce n'est pas une régression introduite par le plafond.
 */
function remember(request, response) {
  caches.open(CACHE_NAME).then(async (cache) => {
    await cache.put(request, response)
    const keys = await cache.keys()
    const doomed = keysToEvict(keys, MAX_CACHE_ENTRIES, (cached) => {
      try {
        return isShellPath(new URL(cached.url).pathname, BASE_PATH)
      } catch {
        return false
      }
    })
    await Promise.all(doomed.map((cached) => cache.delete(cached)))
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isApiPath(url.pathname)) return

  if (request.mode === 'navigate') {
    // Réseau d'abord pour la page d'accueil, repli sur la copie en cache hors ligne.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) remember(BASE_PATH, response.clone())
          return response
        })
        .catch(async () => (await caches.match(BASE_PATH)) || Response.error()),
    )
    return
  }

  // Ressources statiques : cache d'abord, puis réseau (et mise en cache des réponses de base).
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') remember(request, response.clone())
        return response
      }),
    ),
  )
})
