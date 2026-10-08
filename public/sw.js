const CACHE_NAME = 'dakar-bus-shell-v3'
const BASE_PATH = new URL('.', self.location.href).pathname
const APP_SHELL = [BASE_PATH, BASE_PATH + 'manifest.webmanifest', BASE_PATH + 'icons/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('dakar-bus-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(BASE_PATH, response.clone()))
      return response
    }).catch(async () => (await caches.match(BASE_PATH)) || Response.error()))
    return
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()))
    return response
  })))
})
