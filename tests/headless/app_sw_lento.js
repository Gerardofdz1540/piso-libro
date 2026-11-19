// Service worker con wifi LENTO (19 nov 2026): «seguimos con la versión antigua de la app». La página (~700 KB) tardaba
// más de 15 s en bajar: el SW mostraba la copia guardada (bien) pero ABANDONABA la descarga, la copia nunca se
// actualizaba y el equipo se quedaba para siempre en la versión vieja aunque tocara «Actualizar».
// Aquí un servidor de verdad publica la versión A; luego publica la B entregándola despacio (cabeceras al instante,
// cuerpo en ~20 s, más que el tope de 15 s). Se espera: la recarga muestra A al vencer el tope (no se cuelga), la descarga
// de B se termina en segundo plano y deja la copia guardada en B, y la siguiente apertura (aún lenta) ya muestra B.
//   node tests/headless/app_sw_lento.js   (levanta su propio servidor; ver run_all.sh)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { launch } = require('./_browser');
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
  let build = 'TEST-A', lento = false;
  const pagina = () => INDEX.replace(/const PL_BUILD = "[^"]+";/, 'const PL_BUILD = "' + build + '";');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '/index.html') {
      const body = Buffer.from(pagina(), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      if (!lento) return res.end(body);
      // Wifi saturado: cabeceras y un primer pedazo al instante; el resto en ~20 s (más que el tope de 15 s del SW).
      const partes = 20, tam = Math.ceil(body.length / partes); let i = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(body.subarray(i * tam, (i + 1) * tam)); i++;
        if (i >= partes) { clearInterval(t); res.end(); }
      }, 1000);
      return;
    }
    if (p === '/version.json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify({ v: build })); }
    const file = p === '/sw.js' ? SW : path.join(ROOT, p);
    if (!file.startsWith(ROOT) && file !== SW) { res.writeHead(403); return res.end(); }
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
  const copiaGuardada = () => page.evaluate(async () => {
    try {
      const k = (await caches.keys()).find((n) => /^pisolibro-v\d+$/.test(n)); if (!k) return '';
      const r = await (await caches.open(k)).match('./'); if (!r) return '';
      const m = (await r.text()).match(/const PL_BUILD = "([^"]+)"/); return m ? m[1] : '?';
    } catch (e) { return 'err'; }
  });
  const esperarCopia = async (v, ms) => { const t0 = Date.now(); let c = ''; while (Date.now() - t0 < ms) { c = await copiaGuardada().catch(() => ''); if (c === v) return c; await page.waitForTimeout(500); } return c; };

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

  console.log(`\nRESULT APP-SW-LENTO: ${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
