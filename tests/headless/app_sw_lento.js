// Service worker con wifi LENTO (19 nov 2026): «seguimos con la versión antigua de la app». La página (~700 KB) tardaba
// más de 15 s en bajar: el SW mostraba la copia guardada (bien) pero ABANDONABA la descarga, la copia nunca se
// actualizaba y el equipo se quedaba para siempre en la versión vieja aunque tocara «Actualizar».
// Aquí un servidor de verdad publica la versión A; luego publica la B entregándola despacio (cabeceras al instante,
// cuerpo en ~20 s, más que el tope de 15 s). Se espera: la recarga muestra A al vencer el tope (no se cuelga), la descarga
// de B se termina en segundo plano y deja la copia guardada en B, y la siguiente apertura (aún lenta) ya muestra B.
// Además (revisión independiente del SW v13):
//   L5 una descarga lenta que termina tarde no pisa la copia más nueva que ya dejó una navegación posterior;
//   L6 /index.html redirigido (Cloudflare: 308 → /) abre la versión publicada, no la copia vieja;
//   L7 una navegación colgada no frena la activación del SW de la siguiente versión más allá del tope (aquí el tope se
//      sirve corto, 5 s, en un contexto aparte; en producción son 2 min);
//   L8 la instalación del SW nuevo copia las librerías de ./vendor/ de la caché anterior en vez de bajarlas otra vez.
//   node tests/headless/app_sw_lento.js   (levanta su propio servidor; ver run_all.sh)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch, name: MOTOR } = require('./_browser');
const ROOT = path.resolve(__dirname, '..', '..');
const SW = process.env.SW_FILE || path.join(ROOT, 'sw.js');   // SW_FILE: otra versión del SW (prueba del mutante)
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const MOCK = `(() => {
  const KEY='__mock_session';
  if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: ()=>({ data:{ subscription:{ unsubscribe(){} } } }), refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  const mock={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
  Object.defineProperty(window, 'supabase', { value: mock, writable: false, configurable: false });
})();`;

(async () => {
  let build = 'TEST-A', lento = false, lentoMs = 1000, colgar = 0, redirigir = false;
  let swTope = 0, swVersion = '';           // L7: tope corto y VERSION nueva en el sw.js servido
  let lentasActivas = 0, pedidosVendor = 0; const colgadas = [];
  const SW_TXT = fs.readFileSync(SW, 'utf8');
  const swServido = () => {
    let t = SW_TXT;
    if (swTope) t = t.replace(/const TOPE_FONDO_MS = \d+;/, 'const TOPE_FONDO_MS = ' + swTope + ';');
    if (swVersion) t = t.replace(/const VERSION = '[^']+';/, "const VERSION = '" + swVersion + "';");
    return t;
  };
  const pagina = () => INDEX.replace(/const PL_BUILD = "[^"]+";/, 'const PL_BUILD = "' + build + '";');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/index.html' && redirigir) { res.writeHead(308, { Location: '/', 'Cache-Control': 'no-cache' }); return res.end(); }
    if (p === '/' || p === '/index.html') {
      // L7: red colgada para UNA petición de la página (acepta la conexión y nunca responde).
      if (colgar > 0) { colgar--; colgadas.push(res); return; }
      const body = Buffer.from(pagina(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      if (!lento) return res.end(body);
      // Wifi saturado: cabeceras y un primer pedazo al instante; el resto en 20 pedazos (lentoMs entre cada uno).
      const partes = 20, tam = Math.ceil(body.length / partes); let i = 0;
      lentasActivas++;
      let cerrada = false; const cerrar = () => { if (!cerrada) { cerrada = true; lentasActivas--; } };
      res.on('close', cerrar);
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); return cerrar(); }
        res.write(body.subarray(i * tam, (i + 1) * tam)); i++;
        if (i >= partes) { clearInterval(t); res.end(); cerrar(); }
      }, lentoMs);
      return;
    }
    if (p === '/version.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify({ v: build })); }
    if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); return res.end(swServido()); }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (p.startsWith('/vendor/')) pedidosVendor++;
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 834, height: 1194 } });
  await context.addInitScript(MOCK);
  const page = await context.newPage();
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const copiaGuardada = (pg) => (pg || page).evaluate(async () => {
    try {
      const k = (await caches.keys()).find((n) => /^pisolibro-v\d+$/.test(n)); if (!k) return '';
      const r = await (await caches.open(k)).match('./'); if (!r) return '';
      const m = (await r.text()).match(/const PL_BUILD = "([^"]+)"/); return m ? m[1] : '?';
    } catch (e) { return 'err'; }
  });
  const esperarCopia = async (v, ms, pg) => { const t0 = Date.now(); let c = ''; while (Date.now() - t0 < ms) { c = await copiaGuardada(pg).catch(() => ''); if (c === v) return c; await (pg || page).waitForTimeout(500); } return c; };

  // 1) Con red buena: se instala el SW y la copia guardada es la versión A.
  await page.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  const c1 = await esperarCopia('TEST-A', 20000);
  const b1 = await page.evaluate(() => PL_BUILD);
  check('L1 red buena: abre la A, el service worker controla la página y la copia guardada es la A', b1 === 'TEST-A' && c1 === 'TEST-A', JSON.stringify({ b1, c1 }));

  // 2) Se publica la B, pero la red es lenta (~20 s para bajar la página).
  build = 'TEST-B'; lento = true;
  const t0 = Date.now();
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  const seg = Math.round((Date.now() - t0) / 1000);
  const b2 = await page.evaluate(() => PL_BUILD);
  check('L2 red lenta: la recarga no se cuelga (abre la copia guardada A al vencer el tope de 15 s)', b2 === 'TEST-A' && seg <= 25, JSON.stringify({ b2, seg }));

  // 3) La descarga de B se termina en segundo plano y deja la copia guardada en B (antes se abandonaba: A para siempre).
  const c3 = await esperarCopia('TEST-B', 30000);
  check('L3 la descarga lenta se termina en segundo plano y la copia guardada queda en la versión publicada (B)', c3 === 'TEST-B', JSON.stringify({ c3 }));

  // 4) Siguiente apertura, aún con la red lenta: ya abre la B.
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  const b4 = await page.evaluate(() => PL_BUILD);
  check('L4 siguiente apertura con la misma red lenta: ya abre la versión publicada (B)', b4 === 'TEST-B', JSON.stringify({ b4 }));

  // 5) Una descarga lenta que termina tarde no pisa una copia más nueva. N1 baja C despacio (~30 s; la página abre la
  //    copia B al vencer el tope); mientras, se publica D y la siguiente apertura (N2, red buena) deja la copia en D.
  //    Cuando N1 termina, la copia debe seguir en D (antes volvía a C: la app retrocedía de versión).
  build = 'TEST-C'; lento = true; lentoMs = 1500;
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  const b5a = await page.evaluate(() => PL_BUILD);
  build = 'TEST-D'; lento = false;
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  const b5b = await page.evaluate(() => PL_BUILD);
  const c5b = await esperarCopia('TEST-D', 15000);
  { const t = Date.now(); while (lentasActivas > 0 && Date.now() - t < 45000) await page.waitForTimeout(500); }
  const n1Termino = lentasActivas === 0;
  await page.waitForTimeout(3000);
  const c5 = await copiaGuardada();
  // Firefox no deja salir N2 mientras N1 sigue bajando la misma URL (candado de su caché HTTP): N2 abre la copia B y baja
  // D después de N1. Ahí no hay carrera que ganar, pero la copia final también debe quedar en D.
  const n2Primero = MOTOR === 'firefox' ? (b5b === 'TEST-B' || b5b === 'TEST-D') : (b5b === 'TEST-D' && c5b === 'TEST-D');
  check('L5 una descarga lenta que termina tarde no pisa la copia más nueva (la copia sigue en D, no vuelve a C)',
    b5a === 'TEST-B' && n2Primero && n1Termino && c5 === 'TEST-D', JSON.stringify({ MOTOR, b5a, b5b, c5b, n1Termino, c5 }));

  // 6) Entrar por /index.html cuando el servidor lo redirige a / (Cloudflare Pages): abre la versión publicada (E).
  build = 'TEST-E'; redirigir = true;
  await page.goto(BASE + 'index.html', { waitUntil: 'load', timeout: 60000 });
  const b6 = await page.evaluate(() => PL_BUILD);
  const u6 = page.url();
  const c6 = await esperarCopia('TEST-E', 10000);
  redirigir = false;
  check('L6 /index.html redirigido a / abre la versión publicada (no la copia vieja) y la copia queda al día',
    b6 === 'TEST-E' && u6 === BASE && c6 === 'TEST-E', JSON.stringify({ b6, u6, c6 }));

  // 7) Navegación colgada (acepta la conexión y nunca responde) con copia guardada y, mientras, una versión nueva del SW:
  //    el SW nuevo toma el control al vencer el tope (aquí 5 s) y no hasta que el navegador abandone la petición
  //    (5 min en Chromium, más en WebKit). Contexto aparte para estrenar el SW con el tope corto.
  swTope = 5000; build = 'TEST-F';
  const ctx2 = await browser.newContext({ viewport: { width: 834, height: 1194 } });
  await ctx2.addInitScript(MOCK);
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: 'load', timeout: 60000 });
  await p2.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
  const c7a = await esperarCopia('TEST-F', 20000, p2);
  colgar = 1;
  const t7 = Date.now();
  await p2.reload({ waitUntil: 'load', timeout: 60000 });
  const b7 = await p2.evaluate(() => PL_BUILD);
  swVersion = 'pisolibro-v99';
  const vendor0 = pedidosVendor;
  const r7 = await p2.evaluate(async () => {
    const t0 = Date.now();
    const cambio = new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(true), { once: true }));
    try { const reg = await navigator.serviceWorker.getRegistration(); await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 4000))]); } catch (e) {}
    const ok = await Promise.race([cambio, new Promise((r) => setTimeout(() => r(false), 25000))]);
    return { ok, ms: Date.now() - t0, keys: await caches.keys() };
  });
  const seg7 = Math.round((Date.now() - t7) / 1000);
  check('L7 con una navegación colgada, el SW de la versión siguiente toma el control al vencer el tope (no se queda esperando)',
    c7a === 'TEST-F' && b7 === 'TEST-F' && r7.ok === true && seg7 <= 30 && r7.keys.includes('pisolibro-v99'), JSON.stringify({ c7a, b7, r7, seg7 }));
  // 8) La instalación de esa versión nueva copió las librerías de ./vendor/ de la caché anterior (no las volvió a bajar)
  //    y la caché nueva las tiene todas, igual que la página.
  const vendorBajadas = pedidosVendor - vendor0;
  const c8 = await p2.evaluate(async () => {
    const c = await caches.open('pisolibro-v99');
    const urls = ['./', './vendor/supabase-2.46.1.js', './vendor/xlsx-0.20.3.full.min.js', './vendor/exceljs-4.4.0.min.js', './vendor/docx-8.5.0.umd.js'];
    const r = {};
    for (const u of urls) { const m = await c.match(u); r[u] = m ? (await m.arrayBuffer()).byteLength : 0; }
    return r;
  }).catch((e) => ({ err: String(e) }));
  const tam = (f) => fs.statSync(path.join(ROOT, f)).size;
  check('L8 la instalación del SW nuevo copia las librerías de la caché anterior (0 descargas de ./vendor/) y la caché nueva las tiene completas',
    r7.ok === true && vendorBajadas === 0 && c8['./'] > 100000 && c8['./vendor/supabase-2.46.1.js'] === tam('vendor/supabase-2.46.1.js')
      && c8['./vendor/xlsx-0.20.3.full.min.js'] === tam('vendor/xlsx-0.20.3.full.min.js') && c8['./vendor/exceljs-4.4.0.min.js'] === tam('vendor/exceljs-4.4.0.min.js')
      && c8['./vendor/docx-8.5.0.umd.js'] === tam('vendor/docx-8.5.0.umd.js'), JSON.stringify({ vendorBajadas, c8 }));
  for (const r of colgadas) { try { r.destroy(); } catch (_) {} }
  await ctx2.close().catch(() => {});

  console.log(`\nRESULT APP-SW-LENTO: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
