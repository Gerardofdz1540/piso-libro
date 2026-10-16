/* Piso Libro — Service Worker (v9, oct 2026: abrir en cualquier red y sin conexión)
 *
 * Qué cambió respecto a v8 y por qué:
 *   - Antes la app dependía de 6 librerías en CDNs externos (unpkg, cdnjs, jsdelivr) que el SW no
 *     guardaba. En redes móviles que bloquean o cortan esos dominios (y a veces el propio host), la
 *     página se quedaba en blanco o caía al login "CDN bloqueado" aunque los datos estuvieran en el
 *     dispositivo. Ahora las librerías viven en ./vendor/ (mismo origen) y se precachean.
 *   - La navegación era "network-first" sin límite de tiempo: en una red que acepta la conexión pero
 *     nunca responde (datos móviles filtrados, portal cautivo) el arranque se colgaba 30-60 s. Ahora
 *     la red tiene 4 s; si no responde, se sirve la copia en caché y la app abre al instante.
 *   - Supabase sigue pasando directo a la red (la app ya tiene outbox y copia local para trabajar
 *     sin conexión y sincronizar después).
 */
const VERSION = 'pisolibro-v10';
const CACHE = VERSION;
const NAV_TIMEOUT_MS = 4000;
// Solo './' como documento: en Cloudflare Pages '/index.html' redirige (308) a '/', y una respuesta
// redirigida guardada en caché no sirve como fallback de navegación (primer arranque offline en blanco).
const SHELL = [
  './',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/supabase-2.46.1.js'
];
// Pesadas y de uso ocasional (importar/exportar Excel y Word): se precachean "a la mejor", sin
// bloquear la instalación si alguna falla; si no están en caché, la app las pide a la red al usarlas.
const OPTIONAL = [
  './vendor/xlsx-0.18.5.full.min.js',
  './vendor/exceljs-4.4.0.min.js',
  './vendor/docx-8.5.0.umd.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(req).then((res) => { clearTimeout(t); resolve(res); }, (err) => { clearTimeout(t); reject(err); });
  });
}

async function putClean(cache, key, res) {
  // Copia "limpia" (sin bandera redirected) para que sirva como fallback de navegación.
  try {
    const body = await res.clone().blob();
    await cache.put(key, new Response(body, { status: 200, headers: res.headers }));
  } catch (_) {}
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Solo mismo origen. Supabase / WinLab pasan directo a la red.
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetchWithTimeout(req, NAV_TIMEOUT_MS);
        if (res && res.ok) {
          // Documento COMPLETO antes de responder y, si hay copia guardada, con tope propio: con cabeceras a tiempo
          // pero cuerpo lento o cortado (wifi saturado) antes se colgaba en blanco o entregaba la página truncada.
          const prev = await cache.match('./');
          const body = await (prev
            ? Promise.race([res.blob(), new Promise((_, rej) => setTimeout(() => rej(new Error('body timeout')), 15000))])
            : res.blob());
          const h = new Headers(res.headers); h.delete('content-encoding'); h.delete('content-length');
          const fresh = new Response(body, { status: 200, headers: h });
          try { await cache.put('./', fresh.clone()); } catch (_) {}
          return fresh;
        }
        const cached = await cache.match('./');
        return cached || res;
      } catch (_) {
        const cached = await cache.match('./');
        if (cached) return cached;
        return new Response('<!doctype html><meta charset="utf-8"><title>Piso Libro</title><body style="font-family:sans-serif;padding:24px"><h2>Sin conexión</h2><p>La app aún no se ha guardado en este dispositivo. Ábrela una vez con internet (Wi-Fi del hospital) y después funcionará sin red.</p></body>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // Librerías con versión en el nombre y assets: cache-first (inmutables); si no están, red + guardar.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    const res = await fetch(req);
    if (res && res.ok) { const cache = await caches.open(CACHE); cache.put(req, res.clone()).catch(() => {}); }
    return res;
  })());
});

// La app puede pedir una actualización inmediata del SW (botón "actualizar") sin cerrar pestañas.
self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
