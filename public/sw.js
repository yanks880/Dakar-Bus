// Service worker de Dakar Bus.
// Version du cache : incrémenter à chaque changement de stratégie. L'activation
// purge tous les caches "dakar-bus-*" qui ne portent pas ce nom.
const CACHE_NAME = 'dakar-bus-shell-v4'
const BASE_PATH = new URL('.', self.location.href).pathname
const APP_SHELL = [BASE_PATH, BASE_PATH + 'manifest.webmanifest', BASE_PATH + 'icons/icon.svg']
// Les appels API ne sont jamais mis en cache : "/api" avec ou sans slash final.
const API_PATH = /\/api(\/|$)/

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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || API_PATH.test(url.pathname)) return

  if (request.mode === 'navigate') {
    // Réseau d'abord pour la page d'accueil, repli sur la copie en cache hors ligne.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(BASE_PATH, copy))
          }
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
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        }
        return response
      }),
    ),
  )
})
