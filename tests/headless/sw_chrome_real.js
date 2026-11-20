// Service worker en un Chrome «de verdad» (19 nov 2026, segunda revisión independiente del SW v13). Con Playwright,
// Chromium nunca cierra el service worker (DevTools queda enganchado a él), así que app_sw_lento.js no puede ver lo que
// pasa en un Chrome normal: el navegador cierra el SW ~30 s después de su último evento abierto, y con él se corta la
// descarga de la página que sigue en segundo plano. Un tope fijo de 2 min para soltar esa descarga hacía que Chrome
// perdiera las descargas de 2.5 a 5 min y el equipo volviera a quedarse en la versión vieja.
// Aquí Chromium se lanza a mano y CDP se engancha SOLO a la pestaña (sin auto-attach al SW), como un Chrome normal.
// Página sintética (~700 KB) con marca de versión: lo que se prueba es el SW. La app queda abierta y quieta.
//   R1 se publica B con la página tardando D s (cabeceras al instante): la copia guardada debe terminar en B.
//   R2 (tercera revisión) se publica B junto con un sw.js nuevo cuya instalación FALLA (manifest.json 503) y la página
//      tarda D2 s: soltar la espera al empezar esa instalación (updatefound) hacía que Chrome cortara la descarga y la
//      copia se quedara en A. Debe terminar en B.
//   R3 (cuarta revisión) apertura en frío: la app queda quieta 45 s (Chrome detiene el SW), luego se publica B y la página
//      tarda D3 s (más que el tope de 15 s). Chrome lanza él mismo la petición (precarga automática) y la descarta al
//      recibir la copia guardada; el SW debe repetir la descarga en segundo plano y la copia debe terminar en B.
//   SW_FILE=<sw.js> D=<s> D2=<s> D3=<s> CASOS=r1,r2,r3 node tests/headless/sw_chrome_real.js   (240, 90 y 25 s; ~9 min)
// No está en run_all.sh (tarda varios minutos); se corre a mano al tocar el manejador de navegación de sw.js.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const SW = process.env.SW_FILE || path.join(ROOT, 'sw.js');
const D1 = +(process.env.D || 240), D2 = +(process.env.D2 || 90), D3 = +(process.env.D3 || 25);
const CASOS = String(process.env.CASOS || 'r1,r2,r3').split(',').map((x) => x.trim()).filter(Boolean);
const CHROME = process.env.CHROME || require('playwright').chromium.executablePath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's', ...a);
const SW_TXT = fs.readFileSync(SW, 'utf8');
const pagina = (b) => Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><h1>BUILD-${b}</h1>
<script>window.PL_BUILD = "BUILD-${b}"; if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');</script>
<!--` + 'x'.repeat(700 * 1024) + '--></body></html>', 'utf8');

async function correr(caso, D, { swNuevoFalla = false, frio = 0, cortes = 0 } = {}) {
  const st = { build: 'A', lento: false, cortadas: 0, completas: 0, swVer: '', fallas: 0 };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/' || p === '/index.html') {
      const body = pagina(st.build);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': body.length });
      if (!st.lento) return res.end(body);
      res.flushHeaders();
      const N = 40, tam = Math.ceil(body.length / N); let off = 0, fin = false;
      res.on('close', () => { if (!fin) { fin = true; st.cortadas++; log(caso, 'CORTADA tras', Math.round(100 * off / body.length) + '%'); } });
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        const ch = body.subarray(off, off + tam); off += ch.length; res.write(ch);
        if (off >= body.length) { clearInterval(t); fin = true; st.completas++; log(caso, 'COMPLETA'); res.end(); }
      }, D * 1000 / N);
      return;
    }
    if (p === '/sw.js') {
      let t = SW_TXT; if (st.swVer) t = t.replace(/const VERSION = '[^']+';/, "const VERSION = '" + st.swVer + "';");
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }); return res.end(t);
    }
    // R2: la instalación del sw.js nuevo falla (503 en manifest.json, como un archivo que no baja con el wifi inestable).
    if (p === '/manifest.json' && st.swVer) { st.fallas++; log(caso, 'manifest 503 (instalación del SW nuevo)'); res.writeHead(503); return res.end(); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Cache-Control': 'no-cache' }); res.end(d); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-sw-chrome-'));
  const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', '--user-data-dir=' + dir,
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let port = '', wsPath = '';
  for (let i = 0; i < 100 && !port; i++) { await sleep(200); try { [port, wsPath] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n'); } catch (_) {} }
  const ws = new WebSocket('ws://127.0.0.1:' + port + wsPath);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map(); const ev = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else ev.push(d); };
  const send = (method, params, sessionId) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true });   // solo la pestaña
  await send('Page.enable', {}, S);
  const evalp = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S); return r.result && r.result.result ? r.result.result.value : ''; };
  const cargar = async (fn) => { const n = ev.length; await fn(); const t = Date.now(); while (Date.now() - t < 120000) { if (ev.slice(n).some((e) => e.method === 'Page.loadEventFired')) return; await sleep(200); } };
  const copia = () => evalp(`(async()=>{const o=[];for(const k of await caches.keys()){if(!/^pisolibro-v\\d+$/.test(k))continue;const r=await (await caches.open(k)).match('./');if(!r)continue;const m=(await r.text()).match(/BUILD-(\\w)/);o.push(m?m[1]:'?');}return o.join(',');})()`);

  await cargar(() => send('Page.navigate', { url: BASE }, S));
  for (let i = 0; i < 60 && !(await evalp('!!navigator.serviceWorker.controller')); i++) await sleep(500);
  await sleep(1500);
  const c0 = await copia();
  log(caso, 'inicio: copia', c0);
  if (frio) { log(caso, 'app quieta', frio, 's (Chrome detiene el SW)'); await sleep(frio * 1000); }
  st.build = 'B'; st.lento = true; if (swNuevoFalla) st.swVer = 'pisolibro-v99';
  await cargar(() => send('Page.reload', {}, S));
  log(caso, 'recarga con la página lenta: muestra', await evalp('window.PL_BUILD'));
  let c = '';
  const t1 = Date.now();
  while (Date.now() - t1 < (D + 40) * 1000) { await sleep(5000); c = await copia(); if (c === 'B' || st.cortadas > cortes) break; }
  await sleep(3000); c = await copia();
  try { ws.close(); } catch (_) {}
  ch.kill('SIGTERM'); server.close();
  await sleep(1500); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return { c0, copia: c, cortadas: st.cortadas, completas: st.completas, fallas: st.fallas };
}

(async () => {
  let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + ' :: ' + JSON.stringify(x)); } };
  if (CASOS.includes('r1')) {
    const r = await correr('R1', D1);
    check('R1 Chrome normal (SW sin DevTools), página de ' + D1 + ' s con la app abierta y quieta: la descarga en segundo plano se termina y la copia queda en B',
      r.c0 === 'A' && r.copia === 'B' && r.cortadas === 0, r);
  }
  if (CASOS.includes('r2')) {
    const r = await correr('R2', D2, { swNuevoFalla: true, cortes: 1 });
    // La instalación del SW nuevo falla (su propia descarga de la página puede cortarse: 1 cortada se admite); la
    // descarga en segundo plano del SW actual se termina y deja la copia en B.
    check('R2 se publica un sw.js nuevo cuya instalación falla (manifest 503) y la página tarda ' + D2 + ' s: la descarga en segundo plano no se suelta y la copia queda en B',
      r.c0 === 'A' && r.copia === 'B' && r.fallas > 0 && r.completas >= 1, r);
  }
  if (CASOS.includes('r3')) {
    const r = await correr('R3', D3, { frio: 45, cortes: 1 });
    // La precarga de Chrome se corta al entregar la copia (1 cortada se admite); el reintento la termina.
    check('R3 apertura en frío (SW detenido) con la página de ' + D3 + ' s: la descarga se repite en segundo plano y la copia queda en B',
      r.c0 === 'A' && r.copia === 'B' && r.completas >= 1, r);
  }
  console.log(`\nRESULT SW-CHROME-REAL: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
