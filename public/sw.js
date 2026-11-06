// Primero la red, para abrir siempre la última versión; sin conexión, lo último que se guardó.
// Solo archivos de la propia app: YouTube, mapas y otros servicios no pasan por aquí.
const CACHE = 'keiser-app-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' })
        if (cached) return cached
        if (request.mode === 'navigate') {
          const home = await caches.match(new URL('./', self.location).href)
          if (home) return home
        }
        return Response.error()
      }),
  )
})
