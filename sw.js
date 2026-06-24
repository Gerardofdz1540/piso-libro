/* Piso Libro — Service Worker
 * Estrategia conservadora pensada para una app data-driven (Supabase + WinLab):
 *   - El documento HTML va "network-first": siempre intenta traer la última
 *     versión y solo cae al cache si estás offline. Así nunca se queda pegada
 *     una versión vieja del index.html.
 *   - Los assets estáticos (íconos, manifest) van "cache-first".
 *   - Las peticiones cross-origin (Supabase, CDNs, API de WinLab) NO se tocan:
 *     pasan directo a la red, igual que sin service worker.
 */
const CACHE = 'pisolibro-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Solo manejamos mismo origen. Supabase / WinLab / CDNs pasan directo a la red.
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first: la app siempre se actualiza cuando hay red.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Cache-first para assets estáticos.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
