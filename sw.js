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
 *   - v11 (19-oct-2026): SheetJS 0.18.5 → 0.20.3 (la 0.18.5 tenía fallas de seguridad conocidas al leer
 *     un Excel manipulado). Subir VERSION hace que los iPads descarten la caché vieja y bajen el archivo
 *     nuevo; el procedimiento para actualizar cualquier librería está en vendor/README.md.
 *   - v12 (20-oct-2026): aviso de versión nueva. version.json (raíz del repo, la versión publicada) lo compara la app
 *     con la suya (PL_BUILD en index.html). version.json va SIEMPRE a la red y nunca se guarda: con el cache-first de
 *     abajo, pedido sin ?ts= se serviría para siempre la primera respuesta (el aviso no vería jamás una versión nueva) y
 *     con ?ts= se guardaría una copia por revisión (la caché crecería sin fin). Subir VERSION hace que cada equipo
 *     instale este SW (y descarte la caché vieja) en la siguiente visita con red. Además, la instalación baja la app del
 *     servidor sin pasar por la caché HTTP del navegador (ver `fresco`).
 *   - v13 (19-nov-2026): equipos atorados en una versión vieja con el wifi lento del hospital. La descarga de la página
 *     ya no se abandona al vencer el tope de 15 s: se termina en segundo plano y actualiza la copia guardada (ver el
 *     manejador de navegación). Subir VERSION hace que cada equipo instale este SW, y la instalación baja la versión
 *     publicada completa sin tope de tiempo (`fresco`), así que hasta los equipos ya atorados quedan al día. Tras una
 *     revisión independiente: esa espera se suelta en cuanto un SW nuevo queda instalado (si no, frenaba su activación), una
 *     descarga vieja ya no pisa una copia más nueva, /index.html redirigido ya no se queda en la copia vieja y la
 *     instalación copia las librerías de ./vendor/ de la caché anterior en vez de bajarlas otra vez (más rápida).
 */
const VERSION = 'pisolibro-v13';
const CACHE = VERSION;
const NAV_TIMEOUT_MS = 4000;
// Descarga de la página que sigue en segundo plano cuando ya se mostró la copia guardada (ver el manejador de
// navegación). Se suelta cuando un SW nuevo ya quedó INSTALADO (si no, el navegador no lo activa mientras la descarga
// siga abierta) y, como red de seguridad, a los TOPE_FONDO_MS: 280 s, por debajo de los 5 min que Chromium da a un
// evento, para nunca cortar antes que el propio navegador (un tope de 2 min hacía que Chrome cerrara el SW y perdiera
// descargas de 2.5 a 5 min: el equipo se quedaba otra vez en la versión vieja). No se suelta al EMPEZAR la instalación
// (`updatefound`): si ésta falla (wifi inestable, un ícono que no baja), el SW nuevo queda descartado, Chrome cierra
// este SW ~30 s después y la descarga se perdía. Por eso se vigila el estado del nuevo y se suelta solo con
// 'installed'/'activating'/'activated', nunca con 'redundant'.
const TOPE_FONDO_MS = 280000;
const sueltas = new Set();
const soltarTodas = () => { for (const s of Array.from(sueltas)) { try { s(); } catch (_) {} } };
const vigilados = new WeakSet();
function vigilarNuevo(w) {
  if (!w || vigilados.has(w)) return;
  vigilados.add(w);
  const ver = () => { if (w.state === 'installed' || w.state === 'activating' || w.state === 'activated') soltarTodas(); };
  try { w.addEventListener('statechange', ver); } catch (_) {}
  ver();
}
try { self.registration.addEventListener('updatefound', () => { try { vigilarNuevo(self.registration.installing); } catch (_) {} }); } catch (_) {}
// Turnos de las descargas de la página (solo en memoria; si el navegador cierra el SW, sus descargas mueren con él).
let navTurno = 0, copiaTurno = 0, copiaCola = Promise.resolve();
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
// Los nombres llevan versión (cache-first, inmutables): al actualizar una librería hay que cambiar el
// nombre aquí y en index.html (_libLoad) y subir VERSION; si no, el iPad sigue sirviendo la vieja.
const OPTIONAL = [
  './vendor/xlsx-0.20.3.full.min.js',
  './vendor/exceljs-4.4.0.min.js',
  './vendor/docx-8.5.0.umd.js'
];

// Precache siempre desde el servidor, sin la caché HTTP del navegador (20 oct 2026): GitHub Pages sirve todo con
// Cache-Control: max-age=600 y, si este SW se instalaba menos de 10 min después de abrir la app (p. ej. «Actualizar»
// justo al ver el aviso), guardaba como './' el index.html ANTERIOR: sin red la app abría la versión vieja hasta la
// siguiente apertura con red. Con Cloudflare/Netlify (_headers: no-cache) no pasaba.
const fresco = (u) => new Request(u, { cache: 'reload' });

// Librerías de ./vendor/ (llevan versión en el nombre, nunca cambian): v13 (19 nov 2026) las copia de la caché que dejó
// el SW anterior en vez de bajarlas otra vez. Con el wifi lento del hospital la instalación bajaba ~2.8 MB de librerías
// además de la página y tardaba unas 3 veces más; mientras tanto el equipo seguía en la versión vieja y, en el iPad, si se
// salía de la app a media instalación, ésta se quedaba trabada. Si no hay copia anterior se bajan como siempre.
const esInmutable = (u) => /\/vendor\//.test(u);
async function guardarInmutable(cache, u, obligatoria) {
  try {
    const previa = await caches.match(u);
    if (previa && previa.ok && !previa.redirected) { await cache.put(u, previa); return; }
  } catch (_) {}
  if (obligatoria) await cache.add(fresco(u));
  else await cache.add(fresco(u)).catch(() => {});
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.filter((u) => !esInmutable(u)).map(fresco));
    await Promise.all(SHELL.filter(esInmutable).map((u) => guardarInmutable(cache, u, true)));
    await Promise.all(OPTIONAL.map((u) => guardarInmutable(cache, u, false)));
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
  // version.json (aviso de versión nueva, 20 oct 2026): sin respondWith el navegador lo pide directo a la red y no pasa
  // por la caché. Sin red la petición falla y la app no avisa nada (es lo correcto: no hay con qué comparar).
  if (/\/version\.json$/.test(url.pathname)) return;

  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    // v13 (19 nov 2026): UNA sola descarga de la página, que se termina y se guarda aunque llegue tarde. Con el wifi
    // lento del hospital la página (~700 KB) tardaba más de 15 s: se mostraba la copia guardada (bien) pero la descarga
    // se ABANDONABA, la copia nunca se actualizaba y el iPad se quedaba para siempre en la versión vieja aunque tocara
    // «Actualizar». Ahora la descarga sigue en segundo plano (waitUntil) y deja la copia en la versión publicada: la
    // siguiente apertura (o «Actualizar») ya abre la nueva. Los topes para mostrar algo rápido no cambian.
    //   - Mientras el evento siga abierto el navegador no activa el SW de la siguiente versión aunque llame a skipWaiting
    //     (una red colgada lo detenía 5 min en Chromium y más en WebKit): se suelta en cuanto hay un SW nuevo ya instalado
    //     (en espera o activándose), o al vencer TOPE_FONDO_MS. Si la página aún espera esa descarga (sin copia guardada), la respuesta
    //     misma sigue esperando como siempre: respondWith mantiene el evento abierto hasta entregarla.
    //   - Cada descarga lleva su turno (`turno`): una descarga lenta que termina tarde no pisa la copia que ya dejó otra
    //     más reciente (si no, la app podía volver a una versión anterior).
    //     La petición de la página no se modifica (sigue siendo la navegación original): al soltarse solo se libera el
    //     evento y el navegador puede cerrar el SW (y con él la descarga) cuando quiera.
    //   - Reintento (cuarta revisión): Chrome, al abrir con el SW detenido (sin uso por ~30 s), lanza él mismo la petición
    //     de la página (precarga automática) y la DESCARTA en cuanto se le entrega la copia guardada; la descarga se perdía
    //     y la copia se quedaba en la versión vieja. Si la descarga falla después de haber mostrado la copia, se repite UNA
    //     vez en segundo plano con una petición propia (en Safari y Firefox no hay precarga: solo ocurre si la red se cae).
    const turno = ++navTurno;
    const red = fetch(req);
    const bajar = (pedido, t) => pedido.then(async (res) => {
      if (!res || !res.ok) return null;
      const body = await res.blob();
      const h = new Headers(res.headers); h.delete('content-encoding'); h.delete('content-length');
      const fresh = new Response(body, { status: 200, headers: h });
      const copia = fresh.clone();
      copiaCola = copiaCola.then(async () => {
        if (t < copiaTurno) return;   // ya hay una copia de una descarga posterior
        // Si un SW más nuevo ya se activó y borró esta caché, no se vuelve a crear (quedaría huérfana).
        if (!(await caches.has(CACHE))) return;
        copiaTurno = t;
        const c = await caches.open(CACHE); await c.put('./', copia);
      }).catch(() => {});
      await copiaCola;
      return fresh;
    });
    const guardada = bajar(red, turno);
    let bajando = true, copiaServida = false;
    guardada.then(() => { bajando = false; }, () => { bajando = false; });
    const completa = guardada.catch((e) => {
      if (!copiaServida) throw e;
      // Turno NUEVO: el reintento sale después que cualquier navegación ya empezada, así que solo él puede pisarlas.
      return bajar(fetch(req.url, { credentials: 'same-origin', cache: 'no-cache', redirect: 'manual' }), ++navTurno);
    });
    const ignorar = () => {};
    let soltar = ignorar;
    const sostener = new Promise((r) => { soltar = r; });
    const suelta = () => { sueltas.delete(suelta); soltar(); };
    sueltas.add(suelta);
    red.catch(ignorar); completa.then(suelta, suelta);
    try { event.waitUntil(sostener); } catch (_) {}
    setTimeout(suelta, TOPE_FONDO_MS);
    try {
      const r = self.registration;
      if (r && r.waiting) suelta();                   // ya hay uno instalado esperando
      else if (r && r.installing) vigilarNuevo(r.installing);
    } catch (_) {}
    const espera = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      let prev = null;
      try { prev = await cache.match('./'); } catch (_) {}
      try {
        const res = await Promise.race([red, espera(NAV_TIMEOUT_MS, 'timeout')]);
        // Redirección (Cloudflare: /index.html → 308 → /): se entrega tal cual para que el navegador la siga y pida '/'
        // (ésa sí se baja y actualiza la copia). Antes se servía la copia guardada y quien entraba por /index.html se
        // quedaba en la versión vieja aunque la red fuera buena.
        if (res && res.type === 'opaqueredirect') return res;
        if (res && res.ok) {
          // Documento COMPLETO antes de responder y, si hay copia guardada, con tope propio: con cabeceras a tiempo
          // pero cuerpo lento o cortado (wifi saturado) antes se colgaba en blanco o entregaba la página truncada.
          const fresh = await (prev ? Promise.race([guardada, espera(15000, 'body timeout')]) : guardada);
          if (fresh) return fresh;
        }
        const cached = await cache.match('./');
        return cached || res;
      } catch (_) {
        const cached = await cache.match('./');
        if (cached) { if (bajando) copiaServida = true; return cached; }
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
