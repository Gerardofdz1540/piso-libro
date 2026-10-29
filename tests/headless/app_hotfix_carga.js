// Hotfix 20 oct 2026: 🕓 al abrir, la Guardia de la base gana, y 🔄 aviso de versión nueva con version.json fijo.
// Cama 159: tras limpiar en la base renglones repetidos de la «Cronología de guardias», la Mac los veía limpios y el
// iPad seguía mostrando los repetidos aunque se cerrara y abriera: al cargar ganaba la copia LOCAL de la Guardia
// (migrateNote solo tomaba la del meta remoto si la local estaba vacía). Con recargas reales sobre un Supabase simulado:
//   C1  copia local con 3 renglones repetidos y la base con 1 → modelo, meta, caja y copia local muestran 1
//   C1b la copia local traía un renglón que la base no tiene (sin cola ni edición) → gana la base
//   C2  ítem en la cola con 'entrega' en dirty → gana lo de la cola (en pantalla) y C2b al subir lo lleva el POST
//   C3  'entrega' sucia mientras se escribe → una carga no la pisa (y al soltar la caja sube)
//   C3b la Guardia se guardó y SUBIÓ aquí mientras la carga estaba en camino → la foto vieja no la regresa (_keepRecentLocal)
//   C4  fila remota sin __pl_note_meta → se conserva la Guardia local
//   C5  diagrama: remoto vacío y local con trazo → se conserva el trazo; remoto con trazo distinto → gana el remoto
//   C6  ítem viejo de la cola con dirty ["checklist"] no reinstala la Guardia de ese ítem (sí su casilla)
//   C10 paciente que llega por Realtime (INSERT) con una Guardia propia esperando en la cola → se ve la de la cola
//   C11 renglón de otro equipo por Realtime MIENTRAS una carga viene en camino → la foto vieja no lo quita y sube después
//   C12 Guardia en la cola (subida fallando) y un lab tecleado en esa tarjeta → el push del lab no la saca de la cola
//   C13 📜 Restaurar versión con labHistory aún marcado → la Guardia restaurada sube; C13b sin marcas sube todo lo restaurado
//   C14 como C12 con un trazo del diagrama en la cola (dirty ["body_diagram_post"]) → el push del lab no lo saca y sube
//   C15 ítem viejo de una casilla (dirty ["checklist"]) con la Guardia y el diagrama de ENTONCES, y la base con otros más
//       nuevos → al subir la cola el POST lleva los vigentes: la base y la pantalla se quedan con los nuevos (y la casilla)
//   C15b como C15 con la base SIN diagrama: el trazo viejo del ítem no reaparece en pantalla ni sube
//   C11b tras C11 (Realtime más nuevo que la foto), un guardado sin marcas no regresa nada: la base conserva lo que otro
//       equipo escribió después (Guardia y Pendientes) y lo que trajo Realtime en Pendientes
//   C11c como C11/C11b con el diagrama: Realtime más nuevo que la foto trae el trazo de un colega (D2) → la carga lo deja
//       en pantalla y un guardado sin marcas no regresa el viejo: la base se queda con D2
//   C16 evento de Realtime ATRASADO (más viejo que la foto, por updated_at) durante la carga → gana la foto: Pendientes y
//       Guardia con los dos renglones del colega, y la siguiente edición de este equipo no borra ninguno (C16c: horas)
//   C17 ítem SIN lista (nota completa) con la Guardia escrita sin red y el diagrama vacío, y un lab tecleado → la cola se
//       queda solo con la Guardia y al reintentar la base conserva el diagrama del colega
//   C17b ítem SIN lista con la Guardia IGUAL a la base y un trazo escrito sin red, y un lab → la cola se queda solo con el
//       trazo (["body_diagram_post"]); un colega escribe W en la Guardia: la carga lo muestra y al reintentar la base
//       tiene W y el trazo
//   C18 Guardia en la cola y Realtime trae una casilla del colega antes del lab → la casilla entra y la Guardia de la cola
//       se queda en pantalla y en la copia local; la cola conserva lo escrito sin red y al reintentar sube, con la casilla
//       del colega intacta
//   C19 Guardia en la cola (dirty ["entrega"]) cuya subida falló, un lab y DESPUÉS un colega cambia por Realtime casillas
//       (atb, npo), signos (pm_fc), Pendientes R1 y Cultivos → el reintento sube el checklist VIGENTE: la base conserva
//       lo del colega y recibe la Guardia; C19b con dirty ["checklist","entrega"] (sin lab) sigue subiendo el checklist
//       del ítem: la casilla que este equipo marcó sin red llega a la base
//   C20 la cola sube y la base guarda la Guardia con un renglón de otro equipo que la subida no traía → pantalla, meta y
//       copia local con lo de la base, y la siguiente edición lo conserva; C20b si la respuesta llega mientras se escribe
//       en la Guardia, se queda lo que se escribe
//   C21 un colega guarda mientras la respuesta de la subida viene en camino (su Realtime llega antes) → la caja suma su
//       renglón a lo de la cola; la respuesta, más vieja, no regresa la memoria; la nota se relee (aunque haya supresión
//       y la primera relectura falle); C21b con otro ítem más nuevo
//       encolado mientras tanto, la memoria se queda con el de la cola y la siguiente subida lo lleva
//   C21c/C21d lo más nuevo llega por la respuesta de un push directo propio o por una carga antes que la respuesta de la
//       cola → la memoria no se regresa; se relee la nota
//   C22 límites de Realtime sobre la cola: con la Guardia en edición se queda lo que se escribe; un ítem sin lista no tapa
//       lo del colega
//   C23 la cola sube el ítem VIGENTE: un push directo que ya subió la Guardia (con un renglón más) quita el ítem y la
//       tanda siguiente no sube la copia vieja; C23b si la subida de la cola llega a la base después de un push directo
//       más nuevo y lo regresa, la memoria se queda con lo nuevo y se vuelve a subir
//   C24 con varias notas en la cola, la que ya subió sale de la cola en ese momento: el eco de Realtime con el flush en
//       curso muestra lo de la base
//   C25 ítem atorado en la cola y un colega que agrega un renglón a la Guardia por Realtime → la caja muestra los dos (sin
//       revivir lo que este equipo quitó) y la siguiente edición lo conserva; C21e subida sin cambios ([]) → se relee igual
//   C13c 📜 Restaurar versión con labHistory marcado y otro diagrama → el diagrama restaurado sube y se queda
//   C7  aviso de versión nueva (PL_BUILD en index.html y "v" en version.json; window.__PL_BUILD_TEST__ lo enciende en
//       pruebas): a los 15 s pide ./version.json?ts= con cache no-store; error de red / 404 / archivo raro / sin red /
//       misma versión → nada; sin el gancho (navigator.webdriver, 127.0.0.1) no revisa; con el version.json real del
//       repo → sin barra; visibilitychange y pageshow con mínimo de 60 s; cada 3 min solo con la pestaña visible;
//       barra que se esconde al escribir y ✕ hasta la siguiente revisión; debajo del Pase de visita y de ✏️ Editar (con
//       una ventana abierta «Actualizar» no recarga); mientras se usa nunca recarga sola; «Actualizar» sube la cola y lo escrito sin
//       soltar la caja ANTES de recargar y, si no pudo, avisa; con 1340 px o más no tapa el riel de camas (C7k);
//       C7l lo que publican deploy-pages.yml y netlify.toml lleva version.json igual a PL_BUILD (C7l2: y cada archivo que
//       copia deploy-pages.yml está en sus on.push.paths, version.json incluido); C7m el paso de ci.yml
//       falla si un PR (o la publicación por push) cambia index.html sin subir version.json, y su job trae la historia;
//       C7g registration.update() + SKIP_WAITING + controllerchange antes de irse; C7h2 subida colgada → tope ~8 s;
//       C7o sin red solo avisa; C7p si la recarga no llega, a los ~15 s la barra se rescata; C7q al volver tras 30 min
//       o más oculta se actualiza sola solo si es seguro (no con ausencia corta, algo en la cola, una subida que falla,
//       una ventana abierta ni si se tocó algo al volver), sin avisos
//   C8  service worker REAL con otra VERSION en sw.js: «Actualizar» recarga después de que el SW nuevo toma el control
//   C9  service worker REAL con caché HTTP de GitHub Pages (max-age=600): el SW nuevo guarda la app nueva, no la de la caché
//   node tests/headless/app_hotfix_carga.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto'), { spawnSync } = require('child_process');
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const REPO = path.resolve(__dirname, '..', '..');
const PL_BUILD = (/const PL_BUILD = "([^"]*)";/.exec(fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')) || [])[1] || '';
// Sesión y Supabase simulados. `__pl_seed` (sessionStorage, sobrevive a la recarga) trae la copia local «vieja» que la
// prueba quiere en el equipo: se escribe ANTES de que arranque la app y DESPUÉS de que pagehide guardara la anterior.
//   realSW      no reemplaza navigator.serviceWorker.register (C8/C9: el service worker REAL de sw.js)
//   inPageSupa  Supabase simulado DENTRO de la página (fetch envuelto) con esos pacientes, para contextos sin rutas
//               (con rutas Playwright apaga la caché HTTP del navegador y C9 no probaría nada)
//   swLog       anota en sessionStorage (sobrevive a la recarga) cuándo cambia el SW que controla la página y cuándo se va
//   swStub      getRegistration() de mentira: update() deja un SW «en espera» que toma el control 300 ms después de
//               SKIP_WAITING (controllerchange); anota cada paso (C7g)
const mockScript = (opts) => `(() => {
  ${opts.realSW ? '' : 'try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}'}
  const __swev = function (e) { try { const a = JSON.parse(sessionStorage.getItem('__swev') || '[]'); a.push({ e: e, t: Date.now() }); sessionStorage.setItem('__swev', JSON.stringify(a)); } catch (_) {} };
  ${opts.swLog ? `try { navigator.serviceWorker.addEventListener('controllerchange', function () { __swev('cc'); }); } catch (_) {} addEventListener('pagehide', function () { __swev('hide'); });` : ''}
  ${opts.swStub ? `try { navigator.serviceWorker.getRegistration = function () {
    const reg = { installing: null, waiting: null, update: function () { __swev('update');
      reg.waiting = { postMessage: function (m) { __swev('msg:' + (m && m.type)); reg.waiting = null; setTimeout(function () { navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); }, 300); } };
      return Promise.resolve(reg); } };
    return Promise.resolve(reg); }; } catch (_) {}` : ''}
  ${opts.inPageSupa ? `(function () { const pts = ${JSON.stringify(opts.inPageSupa || [])}; const of = window.fetch; window.__supaLlamadas = [];
    window.fetch = function (u, o) {
      const s = String((u && u.url) || u);
      if (/^https?:\\/\\/[^/]*supabase\\.co\\//.test(s)) {
        const m = String((o && o.method) || (u && u.method) || 'GET').toUpperCase(), p = s.replace(/^https?:\\/\\/[^/]+/, '');
        window.__supaLlamadas.push(m + ' ' + p.slice(0, 60));
        if (!navigator.onLine) return Promise.reject(new TypeError('Failed to fetch'));
        const json = function (st, obj) { return Promise.resolve(new Response(JSON.stringify(obj), { status: st, headers: { 'Content-Type': 'application/json' } })); };
        if (p.indexOf('/rest/v1/patients') === 0) return m === 'GET' ? json(200, pts) : json(200, [{ id: pts[0].id }]);
        if (p.indexOf('/rest/v1/') === 0) return m === 'GET' ? json(200, []) : json(201, []);
        return Promise.reject(new TypeError('Failed to fetch'));   // Storage, funciones, auth: nada sale de aquí
      }
      return of.apply(this, arguments);
    }; })();` : ''}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Guardia');
  window.prompt=function(){ return 'Tester'; }; window.confirm=function(){ return true; };
  ${opts.verTest ? 'window.__PL_BUILD_TEST__=true;' : ''}
  ${opts.quietAlert ? `window.__alerts=[]; window.alert=function(m){ window.__alerts.push(String(m)); };` : ''}
  ${opts.wrapFetch ? `window.__verFetch=[]; (function(){ const of=window.fetch; window.fetch=function(u,o){ try { const s=String((u&&u.url)||u); if (/version\\.json/.test(s)) window.__verFetch.push({ u:s, cache:o&&o.cache }); } catch(_){} return of.apply(this, arguments); }; })();` : ''}
  ${opts.wrapTimers ? `window.__plIntervals=[]; (function(){ const si=window.setInterval; window.setInterval=function(fn,ms){ try { if (typeof fn==='function' && ms>=60000) window.__plIntervals.push({ fn:fn, ms:ms }); } catch(_){} return si.apply(this, arguments); }; })();` : ''}
  try {
    const seed = sessionStorage.getItem('__pl_seed');
    if (seed) { const s = JSON.parse(seed); Object.keys(s).forEach(function (k) { if (s[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, s[k]); }); sessionStorage.removeItem('__pl_seed'); }
  } catch (_) {}
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  const __supa={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
  // Sin rutas la librería empaquetada (vendor/supabase) sí carga y haría window.supabase = …: el simulado no se deja pisar.
  ${opts.realSW ? "Object.defineProperty(window, 'supabase', { value: __supa, writable: false, configurable: false });" : 'window.supabase=__supa;'}
})();`;
const COLS = ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes'];
// updated_at como lo manda la base (timestamptz con microsegundos); el trigger trg_notes_updated lo pone en cada UPDATE.
const pgTs = (ms) => new Date(ms === undefined ? Date.now() : ms).toISOString().replace('Z', '000+00:00');
const T0 = '2026-10-20T07:00:00.000000+00:00';
const noteRow = (id, checklist, extra) => Object.assign({ patient_id: id }, Object.fromEntries(COLS.map(c => [c, ''])), { checklist, lab_history: [], imagen_history: [], updated_at: T0 }, extra || {});
// Nada sale a Supabase real: lo que no atiende el simulado (Storage, funciones, auth directo) se anota y se corta.
// Se registra ANTES que mockSupabase (en Playwright gana la ruta registrada al final).
const realSupa = [];
const guardSupa = (ctx) => ctx.route(/^https?:\/\/[^/]*supabase\.co\//, (route) => { realSupa.push(route.request().method() + ' ' + route.request().url().replace(/^https?:\/\/[^/]+/, '').slice(0, 80)); return route.abort(); });
// Supabase simulado: pacientes y notas en memoria; el upsert de `notes` mezcla columnas como PostgREST.
function mockSupabase(ctx, store, ctl, calls) {
  return ctx.route('**/rest/v1/**', async (route) => {
    if (ctl.offline) return route.abort('internetdisconnected');   // setOffline no corta las peticiones interceptadas
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const call = { m, url, body, t: Date.now() }; calls.push(call);
    const json = (status, obj) => { call.status = status; return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) }); };
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') {
        const eq = /id=eq\.([^&]+)/.exec(url);
        return json(200, eq ? store.patients.filter(p => p.id === decodeURIComponent(eq[1])) : store.patients);
      }
      return json(200, [{ id: (body && body.id) || store.patients[0].id }]);
    }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') {
        const eq = /patient_id=eq\.([^&]+)/.exec(url);
        if (eq && ctl.failGetOnce && ctl.failGetOnce.delete(decodeURIComponent(eq[1]))) return json(500, { message: 'boom' });   // C21: una relectura que falla
        const rows = JSON.parse(JSON.stringify(eq ? [store.notes[decodeURIComponent(eq[1])]].filter(Boolean) : Object.values(store.notes)));   // foto al llegar la petición
        if (!eq && ctl.slowLoadMs) await new Promise(r => setTimeout(r, ctl.slowLoadMs));   // carga lenta (C3b): la foto ya es vieja al llegar
        // Relectura de una nota (select con updated_at) retenida: la foto es la de cuando llegó la petición (C20).
        const holdG = eq && ctl.holdGetFor && /updated_at/.test(decodeURIComponent(url)) && ctl.holdGetFor[decodeURIComponent(eq[1])];
        if (holdG) await holdG;
        // Solo las columnas pedidas (select=…), como PostgREST: sin updated_at en el select la app no lo recibe (C11).
        const sel = /[?&]select=([^&]+)/.exec(url), cols = sel ? decodeURIComponent(sel[1]).split(',').map(c => c.trim()) : null;
        return json(200, cols && !cols.includes('*') ? rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]]))) : rows);
      }
      const rows = Array.isArray(body) ? body : [body];
      if (ctl.hangPost) { (ctl.hung = ctl.hung || []).push(route); return; }   // wifi colgado: la subida nunca responde (C7h2)
      if (rows.some(r => r && ctl.failPost.has(r.patient_id))) return json(500, { message: 'boom' });
      // Solo falla lo que lleva el checklist (la Guardia) de esos pacientes; un push de solo labs sí sube (C12).
      if (ctl.failGuardia && rows.some(r => r && ctl.failGuardia.has(r.patient_id) && r.checklist !== undefined)) return json(500, { message: 'boom' });
      const idAntes = ctl.holdNextBeforeWriteFor && rows.map(r => r && r.patient_id).find(id => ctl.holdNextBeforeWriteFor[id]);   // llega a la base tarde (C23b)
      if (idAntes) { const pr = ctl.holdNextBeforeWriteFor[idAntes]; delete ctl.holdNextBeforeWriteFor[idAntes]; await pr; }
      const sinCambio = new Set();
      rows.forEach(r => {
        if (!r || !r.patient_id) return; const cur = store.notes[r.patient_id] || noteRow(r.patient_id, {});
        const firma = (x) => JSON.stringify(Object.assign({}, x, { updated_at: null }), (kk, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((o, k2) => (o[k2] = v[k2], o), {}) : v), antes = store.notes[r.patient_id] ? firma(cur) : null;
        Object.keys(r).forEach(c => { if (c !== 'updated_by') cur[c] = JSON.parse(JSON.stringify(r[c])); }); store.notes[r.patient_id] = cur;   // copia: `calls` guarda el cuerpo tal como se envió
        // Como pl_entrega_protegida con el renglón de otro equipo de hace menos de 15 min (C20): la base lo conserva aunque
        // la subida no lo traiga.
        const extraL = ctl.serverAddLine && ctl.serverAddLine[r.patient_id], mt = cur.checklist && cur.checklist.__pl_note_meta;
        if (extraL && mt && r.checklist !== undefined && String(mt.entrega || '').split('\n').indexOf(extraL) === -1) mt.entrega = (mt.entrega ? mt.entrega + '\n' : '') + extraL;
        // Como pl_zz_sin_cambios: una subida que no cambia nada no toca updated_at y PostgREST responde sin esa fila ([]).
        if (antes !== null && firma(cur) === antes) sinCambio.add(r.patient_id); else cur.updated_at = pgTs();
      });
      call.sinCambio = rows.some(r => r && sinCambio.has(r.patient_id));
      // La fila completa como queda en la base, como PostgREST con return=representation (21 oct 2026): la app la usa para
      // dejar en memoria lo que la base tiene tras subir la cola. La copia se toma AL ESCRIBIR (C21: la respuesta se retiene
      // y mientras tanto otro equipo guarda).
      const filas = rows.filter(r => r && r.patient_id && !sinCambio.has(r.patient_id)).map(r => JSON.parse(JSON.stringify(store.notes[r.patient_id])));
      if (ctl.holdPost) await ctl.holdPost;
      const holdP = ctl.holdPostFor && rows.map(r => r && ctl.holdPostFor[r.patient_id]).find(Boolean);   // solo la de ese paciente (C24)
      if (holdP) await holdP;
      const idUno = ctl.holdNextPostFor && rows.map(r => r && r.patient_id).find(id => ctl.holdNextPostFor[id]);   // solo la siguiente de ese paciente (C21c, C21d)
      if (idUno) { const pr = ctl.holdNextPostFor[idUno]; delete ctl.holdNextPostFor[idUno]; await pr; }
      return json(201, filas);
    }
    return json(200, []);
  });
}

(async () => {
  const browser = await launch();
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const errors = [];
  const watch = (pg, tag) => pg.on('pageerror', e => errors.push(tag + ': ' + String((e && e.stack) || e).slice(0, 300)));

  // ═══ C1–C6, C10: la Guardia al cargar ═════════════════════════════════════════════════════════════════════
  const L1 = '20/10 07:40 GF: PASE DE VISITA SIN EVENTOS, TOLERA VÍA ORAL';
  const L3 = '20/10 07:50 GF: DRENAJE 40 ML SEROHEMÁTICO';
  const SOLO3 = '20/10 06:00 GF: RENGLÓN QUE SOLO TENÍA ESTE EQUIPO';
  const Q2 = 'BASE G2\n20/10 09:10 GF: ESCRITO SIN RED, ESPERA EN LA COLA';
  const G4 = 'GUARDIA LOCAL G4 (LA NUBE NO TRAE META)';
  const L6 = '20/10 08:15 GF: SE AJUSTA ANALGESIA';
  const VIEJA7 = '18/10 22:00 GF: GUARDIA VIEJA QUE TRAÍA EL ÍTEM DE LA COLA';
  const VIEJO7 = '19/10 21:00 GF: RENGLÓN VIEJO QUE LA BASE YA VACIÓ';
  const D_LOC_ANT = 'data:image/png;base64,TE9DQUxBTlQ=', D_LOC_POST = 'data:image/png;base64,TE9DQUxQT1NU', D_REM_POST = 'data:image/png;base64,UkVNT1RPUE9TVA==';
  const BY7 = { pendientes: { u: 'Otro equipo', i: 'OE', t: '2026-10-20T08:00:00.000Z' } };
  // C11–C15 (hallazgos de las revisiones): tarjetas propias, sin copia local ni cola al abrir.
  const L11 = '20/10 07:30 GF: BASE DE LA TARJETA ONCE', B12 = '20/10 07:31 GF: BASE DE LA TARJETA DOCE';
  const B13 = '20/10 07:32 GF: BASE DE LA TARJETA TRECE', B14 = '20/10 07:33 GF: BASE DE LA TARJETA CATORCE';
  const B15 = '20/10 07:34 GF: BASE DE LA TARJETA QUINCE';
  const D15_BASE = 'data:image/png;base64,QkFTRVFVSU5DRQ==', D15_COLA = 'data:image/png;base64,Q09MQVFVSU5DRQ==';
  const VIEJA16 = '19/10 21:00 GF: GUARDIA DE CUANDO SE ENCOLÓ LA CASILLA';
  const NUEVA16 = VIEJA16 + '\n20/10 07:40 OE: RENGLÓN QUE OTRO EQUIPO ESCRIBIÓ DESPUÉS';
  const D16_VIEJO = 'data:image/png;base64,VklFSk9ESUVDSVNFSVM=', D16_NUEVO = 'data:image/png;base64,TlVFVk9ESUVDSVNFSVM=';
  // C11b, C13c, C15b, C16–C18 (hallazgos de la 5.ª revisión, 21 oct 2026).
  const B17 = '20/10 07:35 GF: BASE DE LA TARJETA DIECISIETE', PB17 = 'PEND BASE 17';
  const GB18 = '20/10 07:36 GF: BASE DE LA TARJETA DIECIOCHO', PB18 = 'PEND BASE 18';
  const GB19 = '20/10 07:37 GF: BASE DE LA TARJETA DIECINUEVE', D19 = 'data:image/png;base64,Q09MRUdBRElFQ0lOVUVWRQ==';
  const GB20 = '20/10 07:38 GF: BASE DE LA TARJETA VEINTE';
  const B21 = '20/10 07:39 GF: BASE DE LA TARJETA VEINTIUNO', D21_BASE = 'data:image/png;base64,QkFTRVZFSU5USVVOTw==', D21_REST = 'data:image/png;base64,UkVTVEFVUkFET1ZFSU5USVVOTw==';
  const B22 = '20/10 07:40 GF: BASE DE LA TARJETA VEINTIDÓS', D22_VIEJO = 'data:image/png;base64,VklFSk9WRUlOVElET1M=';
  // C11c, C17b, C19 (hallazgos de la 6.ª revisión, 21 oct 2026).
  const GB23 = '20/10 07:41 GF: BASE DE LA TARJETA VEINTITRÉS', CK23 = { npo: false, atb: false, pendientes_r1: 'R1 BASE 23', pm_fc: '80', cultivos: '' };
  const GB24 = '20/10 07:42 GF: BASE DE LA TARJETA VEINTICUATRO';
  const B25 = '20/10 07:43 GF: BASE DE LA TARJETA VEINTICINCO', D25 = 'data:image/png;base64,VFJBWk9TSU5SRURWRUlOVElDSU5DTw==';
  const B26 = '20/10 07:44 GF: BASE DE LA TARJETA VEINTISÉIS', D26_1 = 'data:image/png;base64,VFJBWk9WSUVKT1ZFSU5USVNFSVM=', D26_2 = 'data:image/png;base64,VFJBWk9DT0xFR0FWRUlOVElTRUlT';
  // C20, C21 (la cola tras subir: lo que la base tiene vuelve a la memoria, 21 oct 2026).
  const B27 = '20/10 07:45 GF: BASE DE LA TARJETA VEINTISIETE', B28 = '20/10 07:46 GF: BASE DE LA TARJETA VEINTIOCHO';
  const B29 = '20/10 07:47 GF: BASE DE LA TARJETA VEINTINUEVE';
  const B30 = '20/10 07:48 GF: BASE DE LA TARJETA TREINTA', B31 = '20/10 07:49 GF: BASE DE LA TARJETA TREINTA Y UNO';
  const B32 = '20/10 07:50 GF: BASE DE LA TARJETA TREINTA Y DOS', B33 = '20/10 07:51 GF: BASE DE LA TARJETA TREINTA Y TRES';
  const B36 = '20/10 07:55 GF: BASE DE LA TARJETA TREINTA Y SEIS';
  const B34 = '20/10 07:52 GF: BASE DE LA TARJETA TREINTA Y CUATRO', OLD34 = '20/10 07:53 GF: RENGLÓN QUE ESTE EQUIPO BORRÓ SIN RED', B35 = '20/10 07:54 GF: BASE DE LA TARJETA TREINTA Y CINCO';
  const extra = [[11, 'ONCE'], [12, 'DOCE'], [13, 'TRECE'], [14, 'CATORCE'], [15, 'QUINCE'], [16, 'DIECISÉIS'], [17, 'DIECISIETE'], [18, 'DIECIOCHO'], [19, 'DIECINUEVE'], [20, 'VEINTE'], [21, 'VEINTIUNO'], [22, 'VEINTIDÓS'], [23, 'VEINTITRÉS'], [24, 'VEINTICUATRO'], [25, 'VEINTICINCO'], [26, 'VEINTISÉIS'], [27, 'VEINTISIETE'], [28, 'VEINTIOCHO'], [29, 'VEINTINUEVE'], [30, 'TREINTA'], [31, 'TREINTA Y UNO'], [32, 'TREINTA Y DOS'], [33, 'TREINTA Y TRES'], [34, 'TREINTA Y CUATRO'], [35, 'TREINTA Y CINCO'], [36, 'TREINTA Y SEIS']].map(([n, w]) => ({ id: 'g' + n, cama: '3-' + (180 + n), exp: '26-9' + String(180 + n).padStart(4, '0'), nombre: 'PRUEBA FICTICIA ' + w, esp: 'CG', estado: 'ESTABLE' }));
  const store = {
    patients: [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: 'g' + n, cama: '3-' + (158 + n), exp: '26-9' + String(158 + n).padStart(4, '0'), nombre: 'PRUEBA FICTICIA ' + ['UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE'][n - 1], esp: 'CG', estado: 'ESTABLE' })).concat(extra),
    notes: {
      g11: noteRow('g11', { npo: false, __pl_note_meta: { entrega: L11 } }),
      g12: noteRow('g12', { npo: false, __pl_note_meta: { entrega: B12 } }),
      g13: noteRow('g13', { npo: false, __pl_note_meta: { entrega: B13 } }),
      g14: noteRow('g14', { npo: false, __pl_note_meta: { entrega: B14 } }, { pendientes: 'PEND BASE 14' }),
      g15: noteRow('g15', { npo: false, __pl_note_meta: { entrega: B15, body_diagram_post: D15_BASE } }),
      g16: noteRow('g16', { npo: false, __pl_note_meta: { entrega: NUEVA16, body_diagram_post: D16_NUEVO } }),
      g17: noteRow('g17', { npo: false, __pl_note_meta: { entrega: B17 } }, { pendientes: PB17 }),
      g18: noteRow('g18', { npo: false, __pl_note_meta: { entrega: GB18 } }, { pendientes: PB18 }),
      g19: noteRow('g19', { npo: false, __pl_note_meta: { entrega: GB19, body_diagram_ant: D19 } }),
      g20: noteRow('g20', { npo: false, atb: false, __pl_note_meta: { entrega: GB20 } }),
      g21: noteRow('g21', { npo: false, __pl_note_meta: { entrega: B21, body_diagram_post: D21_BASE } }),
      g22: noteRow('g22', { npo: false, __pl_note_meta: { entrega: B22 } }),
      g23: noteRow('g23', Object.assign({}, CK23, { __pl_note_meta: { entrega: GB23 } })),
      g24: noteRow('g24', { npo: false, atb: false, pm_fc: '80', __pl_note_meta: { entrega: GB24 } }),
      g25: noteRow('g25', { npo: false, __pl_note_meta: { entrega: B25 } }),
      g26: noteRow('g26', { npo: false, __pl_note_meta: { entrega: B26, body_diagram_post: D26_1 } }),
      g27: noteRow('g27', { npo: false, __pl_note_meta: { entrega: B27 } }, { pendientes: 'PEND BASE 27' }),
      g28: noteRow('g28', { npo: false, __pl_note_meta: { entrega: B28 } }),
      g29: noteRow('g29', { npo: false, atb: false, __pl_note_meta: { entrega: B29 } }, { pendientes: 'PEND BASE 29' }),
      g30: noteRow('g30', { npo: false, __pl_note_meta: { entrega: B30 } }),
      g31: noteRow('g31', { npo: false, __pl_note_meta: { entrega: B31 } }),
      g32: noteRow('g32', { npo: false, __pl_note_meta: { entrega: B32 } }),
      g33: noteRow('g33', { npo: false, __pl_note_meta: { entrega: B33 } }),
      g34: noteRow('g34', { npo: false, __pl_note_meta: { entrega: B34 + '\n' + OLD34 } }),
      g35: noteRow('g35', { npo: false, __pl_note_meta: { entrega: B35 } }),
      g36: noteRow('g36', { npo: false, __pl_note_meta: { entrega: B36 } }, { pendientes: 'PEND 36' }),
      g1: noteRow('g1', { npo: false, __pl_note_meta: { entrega: L1 } }),
      g2: noteRow('g2', { __pl_note_meta: { entrega: 'BASE G2' } }),
      g3: noteRow('g3', { __pl_note_meta: { entrega: L3 } }),
      g4: noteRow('g4', { npo: false }),
      g5: noteRow('g5', { __pl_note_meta: { body_diagram_post: D_REM_POST } }),
      g6: noteRow('g6', { npo: false, __pl_note_meta: { entrega: L6 } }),
      g7: noteRow('g7', { npo: false, __pl_note_meta: { by: BY7 } }),
    },
  };
  const ctl = { failPost: new Set() };
  const calls = [];
  const N0 = store.patients.length;   // tarjetas al abrir (C10 agrega una más después)
  const ctxG = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  await guardSupa(ctxG);
  await ctxG.route('**/vendor/supabase*', r => r.abort());
  await mockSupabase(ctxG, store, ctl, calls);
  await ctxG.addInitScript(mockScript({ quietAlert: true }));
  // Subir la cola sin chocar con una subida en curso (el intervalo de 30 s o la de la carga): flushOutbox() devolvía la que
  // ya corría (su foto de la cola) y la nueva quedaba para después; con la máquina cargada, C2b fallaba a veces.
  await ctxG.addInitScript(() => {
    window.__sinFlush = async () => { while (typeof _flushing !== 'undefined' && _flushing) { try { await _flushing; } catch (_) {} } };
    window.__flushLimpio = async () => { await window.__sinFlush(); try { await flushOutbox(); } catch (_) {} await window.__sinFlush(); };
  });
  const page = await ctxG.newPage(); watch(page, 'G');
  const ready = (pg, n) => pg.waitForFunction((n) => typeof patients !== 'undefined' && patients.length === n && typeof _noteBaseline !== 'undefined' && !!_noteBaseline.g1 && document.getElementById('card-su-g1'), n, { timeout: 30000 });
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await ready(page, N0);
  await page.waitForTimeout(800);

  // Copia local «vieja» de este equipo (lo que tenía el iPad) + cola pendiente, y recarga real.
  const x3 = (s) => [s, s, s].join('\n');
  const loc = (o) => JSON.stringify(Object.assign({ app: '', pa: '', pendientes: '', manejo: '', labHistory: [], imagenHistory: [] }, o));
  const seed = {
    'note-su-g1': loc({ entrega: x3(L1), checklist: { npo: false, __pl_note_meta: { entrega: x3(L1) } } }),
    'note-su-g2': loc({ entrega: Q2, checklist: { __pl_note_meta: { entrega: Q2 } } }),
    'note-su-g3': loc({ entrega: L3 + '\n' + SOLO3, checklist: { __pl_note_meta: { entrega: L3 + '\n' + SOLO3 } } }),
    'note-su-g4': loc({ entrega: G4, checklist: { npo: false } }),   // escrita aquí y nunca subida: ni la local trae meta
    'note-su-g5': loc({ body_diagram_ant: D_LOC_ANT, body_diagram_post: D_LOC_POST, checklist: { __pl_note_meta: { body_diagram_ant: D_LOC_ANT, body_diagram_post: D_LOC_POST } } }),
    'note-su-g6': loc({ entrega: L6, checklist: { npo: false, __pl_note_meta: { entrega: L6 } } }),
    // La copia local de g7 trae un renglón viejo que la base ya vació: la Guardia de la base gana AUNQUE venga vacía.
    'note-su-g7': loc({ entrega: VIEJO7, checklist: { npo: false, __pl_note_meta: { by: BY7, entrega: VIEJO7 } } }),
    'pl_outbox_v1': JSON.stringify([
      { type: 'note', key: 'su-g2', data: { entrega: Q2, checklist: { __pl_note_meta: { entrega: Q2 } } }, dirty: ['entrega'], ts: Date.now() - 60000 },
      // ítems VIEJOS de una casilla (dirty ["checklist"]): su checklist lleva la Guardia de cuando se encolaron
      { type: 'note', key: 'su-g6', data: { entrega: x3(L6), checklist: { npo: true, __pl_note_meta: { entrega: x3(L6) } } }, dirty: ['checklist'], ts: Date.now() - 3600000 },
      { type: 'note', key: 'su-g7', data: { entrega: VIEJA7, checklist: { npo: true, __pl_note_meta: { entrega: VIEJA7 } } }, dirty: ['checklist'], ts: Date.now() - 3600000 },
    ]),
  };
  ctl.failPost = new Set(['g2', 'g6', 'g7']);   // que sigan en la cola durante las aserciones
  await page.evaluate((s) => sessionStorage.setItem('__pl_seed', JSON.stringify(s)), seed);
  calls.length = 0;
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await ready(page, N0);
  // Carga aplicada: la casilla del ítem de la cola (g7) ya está encima de la nota remota (independiente del arreglo) y la
  // copia local ya se reescribió. Este hotfix NO adelanta el repintado: la tarjeta temprana (copia local) se repinta al
  // final del arranque, después de subir la cola (aquí con 3 ítems que fallan y reintentan: varios segundos).
  await page.waitForFunction(() => noteData['su-g7'] && noteData['su-g7'].checklist && noteData['su-g7'].checklist.npo === true, null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction((L1) => { const ta = document.querySelector('#card-su-g1 textarea[data-field="entrega"]'); return ta && ta.value === L1; }, L1, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  // Sin la subida periódica de la cola (cada 30 s): cada caso sube la cola cuando le toca (__flushLimpio); si no, a veces se
  // colaba entre armar la cola y la carga de un caso (C15: la carga ya no veía el ítem y mostraba la foto).
  await page.evaluate(() => { try { clearInterval(syncInterval); } catch (_) {} });
  const view = (k) => page.evaluate((k) => {
    const nd = noteData[k] || {}; const cl = nd.checklist || {}; const meta = cl.__pl_note_meta || null;
    const entrega = nd.entrega, metaEntrega = meta ? (meta.entrega === undefined ? null : meta.entrega) : 'sin meta';   // antes de getNote (migrateNote rellena)
    const shown = getNote(k);   // lo que pinta la tarjeta (migrateNote sobre la nota viva)
    if (window.__focusPid !== k) { window.__focusPid = k; renderView(); }
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-' + k) || '{}'); } catch (_) {}
    const q = outboxLoad().filter(i => i.type === 'note' && i.key === k);
    return { entrega, metaEntrega, shown: shown.entrega, ta: ta ? ta.value : null,
      lsEntrega: ls.entrega, npo: cl.npo, by: meta && meta.by ? Object.keys(meta.by) : [], ant: nd.body_diagram_ant, post: nd.body_diagram_post, lsAnt: ls.body_diagram_ant, lsPost: ls.body_diagram_post,
      q: q.length, qDirty: q[0] && q[0].dirty };
  }, k);

  const c1 = await view('su-g1');
  check('C1 copia local con 3 renglones repetidos y la base con 1: al recargar, modelo, meta, caja y copia local muestran 1 (la Guardia de la base gana)',
    c1.entrega === L1 && c1.metaEntrega === L1 && c1.shown === L1 && c1.ta === L1 && c1.lsEntrega === L1, JSON.stringify(c1));

  const c1b = await view('su-g3');
  check('C1b la copia local traía un renglón que la base no tiene (sin cola ni edición): modelo, caja y copia local muestran la de la base',
    c1b.entrega === L3 && c1b.shown === L3 && c1b.ta === L3 && c1b.lsEntrega === L3, JSON.stringify(c1b));

  const c2 = await view('su-g2');
  check('C2 ítem de la cola con «entrega» en dirty: gana lo de la cola en el modelo, el meta, la caja y la copia local (sigue en la cola)',
    c2.entrega === Q2 && c2.metaEntrega === Q2 && c2.shown === Q2 && c2.ta === Q2 && c2.lsEntrega === Q2 && c2.q === 1 && Array.isArray(c2.qDirty) && c2.qDirty.join() === 'entrega', JSON.stringify(c2));

  const c4 = await view('su-g4');
  check('C4 fila remota SIN __pl_note_meta: se conserva la Guardia local (como antes)',
    c4.entrega === G4 && c4.shown === G4 && c4.ta === G4 && c4.lsEntrega === G4, JSON.stringify(c4));

  const c5 = await view('su-g5');
  check('C5 diagrama: anterior vacío en la base y con trazo aquí → se conserva el trazo; posterior con trazo distinto en la base → gana el de la base (también en la copia local)',
    c5.ant === D_LOC_ANT && c5.post === D_REM_POST && c5.lsAnt === D_LOC_ANT && c5.lsPost === D_REM_POST, JSON.stringify(c5));

  const c6a = await view('su-g6');
  const c6b = await view('su-g7');
  check('C6 ítem viejo de la cola con dirty ["checklist"]: su casilla sí se aplica (npo) pero NO reinstala su Guardia: queda la de la base (1 renglón) en modelo, meta y caja; con la Guardia vacía en la base, la caja queda vacía aunque la copia local traía un renglón',
    c6a.npo === true && c6a.entrega === L6 && c6a.metaEntrega === L6 && c6a.shown === L6 && c6a.ta === L6 && c6a.q === 1
    && c6b.npo === true && c6b.entrega === '' && !c6b.metaEntrega && c6b.shown === '' && c6b.ta === '' && c6b.q === 1,
    JSON.stringify({ c6a, c6b }));

  // C2b: al volver a poder subir, el POST de g2 lleva la Guardia de la cola.
  ctl.failPost = new Set(['g6', 'g7']);
  calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post2 = calls.filter(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.patient_id === 'g2').pop();
  const meta2 = post2 && post2.body.checklist && post2.body.checklist.__pl_note_meta;
  const c2b = await view('su-g2');
  check('C2b al subir la cola, el POST de esa nota lleva la Guardia de la cola en checklist.__pl_note_meta y la cola de esa nota queda vacía',
    !!meta2 && meta2.entrega === Q2 && store.notes.g2.checklist.__pl_note_meta.entrega === Q2 && c2b.q === 0 && c2b.entrega === Q2, JSON.stringify({ meta2, c2b }));

  // C3: otro equipo cambió la Guardia en la base mientras aquí se escribe en esa caja; llega una carga (volver la red,
  // volver a la app) con la caja sucia → lo que se escribe no se pisa, y al soltar la caja sube.
  store.notes.g1.checklist = Object.assign({}, store.notes.g1.checklist, { __pl_note_meta: { entrega: L1 + '\n20/10 10:00 OE: CAMBIO DESDE OTRO EQUIPO' } });
  const TYPED = L1 + '\n20/10 10:05 GF: ESCRIBIENDO AHORA EN ESTE EQUIPO';
  const c3 = await page.evaluate(async (typed) => {
    const k = 'su-g1';
    window.__focusPid = k; renderView();
    const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]';
    const ta = document.querySelector(sel);
    ta.focus(); ta.dataset.beforeValue = ta.value; ta.value = typed; ta.dispatchEvent(new Event('input', { bubbles: true }));
    const dirty = _dirtyUnion(k).has('entrega');
    const l = await supaLoadAll();
    const remota = l && l.notes[k] ? l.notes[k].entrega : null;
    _applyLoadedNotes(l.notes); renderViewSoft();
    const ta2 = document.querySelector(sel);
    return { dirty, loaded: !!l, remota, entrega: noteData[k].entrega, shown: getNote(k).entrega, ta: ta2 ? ta2.value : null, same: ta2 === ta };
  }, TYPED);
  await page.evaluate(() => { const ta = document.activeElement; if (ta && ta.blur) { ta.dispatchEvent(new Event('change', { bubbles: true })); ta.blur(); } });
  await page.waitForFunction(() => !_pendingPush.has('su-g1') && pendingSyncs === 0, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const c3base = store.notes.g1.checklist.__pl_note_meta.entrega;
  check('C3 «entrega» sucia mientras se escribe: una carga desde la base (con otra Guardia, que ya ganaría) no la pisa ni en el modelo ni en la caja, y al soltar la caja se sube lo escrito',
    c3.dirty && c3.loaded && /OTRO EQUIPO/.test(c3.remota || '') && c3.entrega === TYPED && c3.shown === TYPED && c3.ta === TYPED && c3base === TYPED, JSON.stringify({ c3, c3base }));

  // C3b: carga lenta (la foto de la nube se toma al pedirla); mientras viaja, aquí se guarda y SUBE otra Guardia. Al
  // aplicar la carga ya no hay campos sucios: solo _keepRecentLocal sabe que lo de este equipo es más nuevo.
  ctl.slowLoadMs = 2500;
  const NEW3B = TYPED + '\n20/10 10:20 GF: GUARDADO MIENTRAS LLEGABA LA CARGA';
  const c3b = await page.evaluate(async (nv) => {
    const k = 'su-g1';
    const pl = supaLoadAll();
    await new Promise(r => setTimeout(r, 300));               // la petición de notas ya salió (foto vieja)
    updateField(k, 'entrega', nv, noteData[k].entrega);
    for (let i = 0; i < 40 && (_pendingPush.has(k) || _inflightDirty[k]); i++) await new Promise(r => setTimeout(r, 100));
    const l = await pl;
    const dirtyAtApply = _dirtyUnion(k).size;
    const remoteOld = l && l.notes[k] ? l.notes[k].entrega : null;
    _applyLoadedNotes(l.notes); renderViewSoft();
    await new Promise(r => setTimeout(r, 300));
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    return { dirtyAtApply, remoteOldDiffers: remoteOld !== nv, entrega: noteData[k].entrega, shown: getNote(k).entrega, ta: ta ? ta.value : null };
  }, NEW3B);
  ctl.slowLoadMs = 0;
  check('C3b la Guardia se guardó y subió aquí mientras la carga venía en camino (sin campos sucios al aplicar): la foto vieja de la nube no la regresa (modelo y caja)',
    c3b.dirtyAtApply === 0 && c3b.remoteOldDiffers && c3b.entrega === NEW3B && c3b.shown === NEW3B && c3b.ta === NEW3B, JSON.stringify(c3b));

  // C10: paciente nuevo por Realtime (INSERT de patients) con una Guardia de este equipo esperando en la cola para su
  // tarjeta: la nota de la nube se baja (su Guardia ganaría) y la cola se repone encima (como en la carga normal).
  const Q10 = 'BASE G9\n20/10 11:00 GF: ESCRITO AQUÍ, ESPERA EN LA COLA';
  const p9 = { id: 'g9', cama: '3-169', exp: '26-90169', nombre: 'PRUEBA FICTICIA NUEVE', esp: 'CG', estado: 'ESTABLE' };
  store.patients.push(p9);
  store.notes.g9 = noteRow('g9', { npo: false, __pl_note_meta: { entrega: 'BASE G9' } });
  ctl.failPost.add('g9');
  const c10 = await page.evaluate(async ({ Q10, row }) => {
    const k = 'su-g9';
    outboxEnqueue({ type: 'note', key: k, data: { entrega: Q10, checklist: { __pl_note_meta: { entrega: Q10 } } }, dirty: ['entrega'] });
    handlePatientChange({ eventType: 'INSERT', new: row });
    for (let i = 0; i < 60 && !patients.some(p => p._supa_id === row.id); i++) await new Promise(r => setTimeout(r, 100));
    window.__focusPid = k; renderView();
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    const nd = noteData[k] || {};
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-' + k) || '{}'); } catch (_) {}
    return { added: patients.some(p => p._supa_id === row.id), entrega: nd.entrega, meta: ((nd.checklist || {}).__pl_note_meta || {}).entrega, ta: ta ? ta.value : null, ls: ls.entrega, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, { Q10, row: p9 });
  check('C10 paciente que llega por Realtime (INSERT) con una Guardia de este equipo en la cola: modelo, meta, caja y copia local muestran la de la cola (no la de la nube) y el ítem sigue en la cola',
    c10.added && c10.entrega === Q10 && c10.meta === Q10 && c10.ta === Q10 && c10.ls === Q10 && c10.q === 1, JSON.stringify(c10));

  // Lo de C1–C10 que sigue en la cola (g6, g7, g9 con la subida fallando) ya no hace falta: fuera, para que no estorbe.
  ctl.failPost.clear();
  await page.evaluate(() => { outboxSave([]); updateOutboxBadge(); });
  // Contador de cargas aplicadas (_applyLoadedNotes es una función global: envolverla cambia lo que llaman los manejadores).
  await page.evaluate(() => { const o = _applyLoadedNotes; window.__cargas = 0; _applyLoadedNotes = function () { const r = o.apply(this, arguments); window.__cargas++; return r; }; });
  const vista = (k) => page.evaluate((k) => {
    if (window.__focusPid !== k) { window.__focusPid = k; renderView(); }
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-' + k) || '{}'); } catch (_) {}
    const q = outboxLoad().filter(i => i.type === 'note' && i.key === k);
    return { entrega: (noteData[k] || {}).entrega, shown: getNote(k).entrega, ta: ta ? ta.value : null, ls: ls.entrega, q: q.length, qDirty: q[0] && q[0].dirty, qEntrega: q[0] && q[0].data && q[0].data.entrega };
  }, k);
  const postsDe = (id) => calls.filter(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.patient_id === id);
  const metaDe = (c) => (c && c.body && c.body.checklist && c.body.checklist.__pl_note_meta) || {};

  // C11: Realtime DURANTE la carga, con el manejador real de volver a la app (visibilitychange). La foto de `notes` sale al
  // principio de la carga y se aplica segundos después; en ese hueco llega por Realtime el renglón que OTRO equipo escribió
  // en la Guardia. La foto (de antes) no debe quitarlo de la caja, y la siguiente subida de este equipo lo lleva.
  const X11 = '20/10 10:30 OE: RENGLÓN DE OTRO EQUIPO (REALTIME DURANTE LA CARGA)';
  const Y11 = '20/10 10:35 GF: RENGLÓN DE ESTE EQUIPO';
  await vista('su-g11');
  ctl.slowLoadMs = 2500; calls.length = 0;
  const cargas0 = await page.evaluate(() => { _lastVisibleRefreshTs = 0; const n = window.__cargas; document.dispatchEvent(new Event('visibilitychange')); return n; });
  const fotoNotas = () => calls.some(c => c.m === 'GET' && /^\/rest\/v1\/notes\?patient_id=in\./.test(c.url));
  for (let i = 0; i < 50 && !fotoNotas(); i++) await page.waitForTimeout(100);
  const foto11 = fotoNotas();
  store.notes.g11.checklist = { npo: false, __pl_note_meta: { entrega: L11 + '\n' + X11 } };
  store.notes.g11.updated_at = pgTs();   // la fila del colega es más nueva que la foto (trigger trg_notes_updated)
  const rt11 = await page.evaluate((row) => { handleNoteChange({ eventType: 'UPDATE', new: row }); return { cargas: window.__cargas, entrega: noteData['su-g11'].entrega }; }, JSON.parse(JSON.stringify(store.notes.g11)));
  await page.waitForFunction((n) => window.__cargas > n, cargas0, { timeout: 15000 }).catch(() => {});
  ctl.slowLoadMs = 0;
  await page.waitForTimeout(300);
  const c11a = await vista('su-g11');
  calls.length = 0;
  await page.evaluate((y) => {
    const ta = document.querySelector('#card-su-g11 textarea[data-field="entrega"]');
    ta.focus(); ta.dataset.beforeValue = ta.value; ta.value = ta.value + '\n' + y; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true })); ta.blur();
  }, Y11);
  await page.waitForFunction(() => !_pendingPush.has('su-g11') && pendingSyncs === 0, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  const post11 = postsDe('g11').pop();
  const base11 = store.notes.g11.checklist.__pl_note_meta.entrega;
  check('C11 Realtime trae un renglón de OTRO equipo mientras una carga (volver a la app) viene en camino con una foto de antes: al aplicarse la carga el renglón sigue en el modelo, la caja y la copia local, y la siguiente subida de este equipo lo lleva junto con el propio',
    foto11 && rt11.cargas === cargas0 && rt11.entrega === L11 + '\n' + X11
    && [c11a.entrega, c11a.shown, c11a.ta, c11a.ls].every(v => v === L11 + '\n' + X11)
    && !!post11 && metaDe(post11).entrega === L11 + '\n' + X11 + '\n' + Y11 && base11 === L11 + '\n' + X11 + '\n' + Y11,
    JSON.stringify({ foto11, rt11, cargas0, c11a, post11: metaDe(post11).entrega, base11 }));

  // C12: la Guardia escrita sin red espera en la cola (dirty ["entrega"], de una sesión anterior) y su subida falla (red
  // intermitente); antes del siguiente intento se teclea un lab en esa tarjeta. Ese push lleva solo lab_history y tiene
  // éxito: no debe sacar de la cola la Guardia que no llevó, la siguiente carga la deja en la caja y al final sube.
  const Q12 = B12 + '\n20/10 09:40 GF: ESCRITO SIN RED, ESPERA EN LA COLA';
  ctl.failGuardia = new Set(['g12']);
  await vista('su-g12');
  const c12a = await page.evaluate(async (q) => {
    const k = 'su-g12';
    const nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = q; _entregaMetaAlign(nd);   // como la dejó la carga (cola encima)
    noteData[k] = nd; lsSaveNote(k, nd);
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    await __flushLimpio();                                    // la subida de la cola falla (la Guardia no pasa)
    return { q: outboxLoad().length };
  }, Q12);
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g12';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));            // autoguardado + debounce del push
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const labPosts12 = postsDe('g12').filter(c => c.status !== 500).map(c => Object.keys(c.body).filter(x => x !== 'patient_id' && x !== 'updated_by').join(','));
  const c12b = await vista('su-g12');
  const c12c = await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); return true; });
  await page.waitForTimeout(300);
  const c12d = await vista('su-g12');
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post12 = postsDe('g12').pop();
  const c12e = await vista('su-g12');
  check('C12 Guardia en la cola cuya subida falló y, antes del reintento, un lab tecleado en esa tarjeta (push de solo lab_history, con éxito): la Guardia sigue en la cola (dirty ["entrega"]), la siguiente carga la deja en modelo, caja y copia local, y al reintentar sube a la base',
    c12a.q === 1 && labPosts12.length >= 1 && labPosts12.every(s => s === 'lab_history') && !!store.notes.g12.lab_history.length
    && c12b.q === 1 && Array.isArray(c12b.qDirty) && c12b.qDirty.join() === 'entrega' && c12b.qEntrega === Q12
    && c12c && [c12d.entrega, c12d.shown, c12d.ta, c12d.ls].every(v => v === Q12)
    && !!post12 && metaDe(post12).entrega === Q12 && store.notes.g12.checklist.__pl_note_meta.entrega === Q12 && c12e.q === 0,
    JSON.stringify({ c12a, labPosts12, c12b, c12d, post12: metaDe(post12).entrega, base: store.notes.g12.checklist.__pl_note_meta.entrega, c12e }));

  // C13: 📜 Restaurar versión con un campo que se quedó marcado en esa tarjeta (tras un PDF de labs, labHistory sigue en
  // _dirtyFields): la Guardia restaurada también sube y la siguiente carga no la quita. C13b sin marcas: las diferencias
  // con la base suben la Guardia Y las demás cajas restauradas (marcar solo 'entrega' ahí dejaría fuera Pendientes).
  const REST13 = B13 + '\n20/10 08:00 GF: RENGLÓN RECUPERADO DESDE 📜';
  const REST14 = B14 + '\n20/10 08:05 GF: OTRO RENGLÓN RECUPERADO';
  await vista('su-g13');
  calls.length = 0;
  const c13a = await page.evaluate(async (rest) => {
    const k = 'su-g13';
    const nd = getNote(k); nd.labHistory = [{ fecha: todayStr(), labs: { [getLabKeys()[0]]: '11.1' }, extra: [] }];
    if (!_dirtyFields[k]) _dirtyFields[k] = new Set(); _dirtyFields[k].add('labHistory'); noteData[k] = nd; saveNote(k, nd);   // como la importación de un PDF
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
    const v = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); v.entrega = rest; v.checklist.__pl_note_meta = Object.assign({}, v.checklist.__pl_note_meta, { entrega: rest });
    localStorage.setItem('pl_snap_' + k, JSON.stringify([{ ts: Date.now() - 600000, data: v }]));
    restoreNoteSnapshot(k, 0);
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
    return { marcas: Array.from(_dirtyFields[k] || []), q: outboxLoad().length };
  }, REST13);
  const post13 = postsDe('g13').pop();
  await vista('su-g14');
  const c13b0 = await page.evaluate(async (rest) => {
    const k = 'su-g14';
    const marcas = Array.from(_dirtyFields[k] || []);
    const v = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); v.entrega = rest; v.pendientes = 'PEND RESTAURADO 14'; v.checklist.__pl_note_meta = Object.assign({}, v.checklist.__pl_note_meta, { entrega: rest });
    localStorage.setItem('pl_snap_' + k, JSON.stringify([{ ts: Date.now() - 600000, data: v }]));
    restoreNoteSnapshot(k, 0);
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
    return { marcas };
  }, REST14);
  const post14 = postsDe('g14').pop();
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c13 = await vista('su-g13'), c13b = await vista('su-g14');
  const pend14 = await page.evaluate(() => getNote('su-g14').pendientes);
  check('C13 📜 Restaurar versión con labHistory aún marcado en esa tarjeta: el push lleva la Guardia restaurada (además de lab_history), la marca vuelve a como estaba y la siguiente carga deja la Guardia restaurada en modelo, caja y copia local',
    !!post13 && metaDe(post13).entrega === REST13 && post13.body.lab_history !== undefined && c13a.marcas.join() === 'labHistory'
    && store.notes.g13.checklist.__pl_note_meta.entrega === REST13 && [c13.entrega, c13.shown, c13.ta, c13.ls].every(v => v === REST13),
    JSON.stringify({ c13a, post13: post13 && Object.keys(post13.body), meta13: metaDe(post13).entrega, base: store.notes.g13.checklist.__pl_note_meta.entrega, c13 }));
  check('C13b 📜 Restaurar versión SIN campos marcados: suben la Guardia y Pendientes restaurados (diferencias con la base) y la siguiente carga deja los dos',
    c13b0.marcas.length === 0 && !!post14 && metaDe(post14).entrega === REST14 && post14.body.pendientes === 'PEND RESTAURADO 14'
    && store.notes.g14.pendientes === 'PEND RESTAURADO 14' && store.notes.g14.checklist.__pl_note_meta.entrega === REST14 && c13b.entrega === REST14 && c13b.ta === REST14 && pend14 === 'PEND RESTAURADO 14',
    JSON.stringify({ c13b0, post14: post14 && Object.keys(post14.body), meta14: metaDe(post14).entrega, c13b, pend14 }));

  // Diagrama posterior de una tarjeta: modelo, lo que pinta (getNote), copia local y el ítem de la cola.
  const diag = (k) => page.evaluate((k) => {
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-' + k) || '{}'); } catch (_) {}
    const q = outboxLoad().filter(i => i.type === 'note' && i.key === k);
    return { post: (noteData[k] || {}).body_diagram_post, shown: getNote(k).body_diagram_post, ls: ls.body_diagram_post, q: q.length, qDirty: q[0] && q[0].dirty, qPost: q[0] && q[0].data && q[0].data.body_diagram_post };
  }, k);

  // C14 (como C12, con el diagrama): un trazo hecho sin red espera en la cola (dirty ["body_diagram_post"], de una sesión
  // anterior; la base tiene otro trazo, que gana al abrir) y su subida falla; antes del siguiente intento se teclea un lab en
  // esa tarjeta. Ese push lleva solo lab_history y tiene éxito: no debe sacar de la cola el trazo que no llevó (antes solo
  // se quedaban los ítems con 'entrega'), la siguiente carga lo deja y al reintentar sube.
  ctl.failGuardia = new Set(['g15']);
  await vista('su-g15');
  const c14a = await page.evaluate(async (d) => {
    const k = 'su-g15';
    const nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.body_diagram_post = d;   // como la dejó la carga (cola encima)
    noteData[k] = nd; lsSaveNote(k, nd);
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['body_diagram_post'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    await __flushLimpio();                                    // la subida de la cola falla (el checklist no pasa)
    return { q: outboxLoad().length };
  }, D15_COLA);
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g15';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));            // autoguardado + debounce del push
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const labPosts14 = postsDe('g15').filter(c => c.status !== 500).map(c => Object.keys(c.body).filter(x => x !== 'patient_id' && x !== 'updated_by').join(','));
  const c14b = await diag('su-g15');
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c14c = await diag('su-g15');
  const base14c = store.notes.g15.checklist.__pl_note_meta.body_diagram_post;
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post14d = postsDe('g15').pop();
  const c14d = await diag('su-g15');
  const meta15 = store.notes.g15.checklist.__pl_note_meta;
  check('C14 trazo del diagrama en la cola cuya subida falló y, antes del reintento, un lab tecleado en esa tarjeta (push de solo lab_history, con éxito): el trazo sigue en la cola (dirty ["body_diagram_post"]), la siguiente carga lo deja en modelo, pantalla y copia local aunque la base tenga otro, y al reintentar sube a la base (con la Guardia de la base intacta)',
    c14a.q === 1 && labPosts14.length >= 1 && labPosts14.every(s => s === 'lab_history') && !!store.notes.g15.lab_history.length
    && c14b.q === 1 && Array.isArray(c14b.qDirty) && c14b.qDirty.join() === 'body_diagram_post' && c14b.qPost === D15_COLA
    && base14c === D15_BASE && [c14c.post, c14c.shown, c14c.ls].every(v => v === D15_COLA)
    && !!post14d && metaDe(post14d).body_diagram_post === D15_COLA && meta15.body_diagram_post === D15_COLA && meta15.entrega === B15
    && c14d.q === 0 && c14d.post === D15_COLA,
    JSON.stringify({ c14a, labPosts14, c14b, base14c, c14c, post14d: metaDe(post14d).body_diagram_post, base: meta15, c14d }));

  // C15: ítem VIEJO de la cola de una casilla tocada sin red hace horas (dirty ["checklist"]): su nota y su checklist llevan
  // la Guardia y el trazo de ENTONCES; la base y la copia local ya tienen otros más nuevos (un renglón que otro equipo
  // escribió después, otro trazo). La carga no los reinstala en pantalla (C6) y, al subir la cola, el POST no debe llevar
  // los del ítem (_checklistMergeRemote los tomaba como cambio de este equipo y borraba de la base el renglón ajeno): lleva
  // los vigentes, la base y la pantalla se quedan con los nuevos, y la casilla del ítem sí sube.
  await vista('su-g16');
  calls.length = 0;
  const c15a = await page.evaluate(async ({ vieja, dv }) => {
    const k = 'su-g16';
    const loc = { entrega: noteData[k].entrega, post: noteData[k].body_diagram_post, ls: (JSON.parse(localStorage.getItem('note-' + k) || '{}')).entrega };
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: { app: '', pa: '', pendientes: '', entrega: vieja, body_diagram_post: dv, labHistory: [], imagenHistory: [], checklist: { npo: true, __pl_note_meta: { entrega: vieja, body_diagram_post: dv } } }, dirty: ['checklist'], ts: Date.now() - 3 * 3600000 }]);
    updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();   // carga con el ítem en la cola (como al abrir)
    const antes = { entrega: noteData[k].entrega, post: noteData[k].body_diagram_post, npo: noteData[k].checklist.npo };
    await __flushLimpio();
    return { loc, antes, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, { vieja: VIEJA16, dv: D16_VIEJO });
  const post15 = postsDe('g16').pop();
  const meta16 = Object.assign({}, store.notes.g16.checklist.__pl_note_meta), npo16 = store.notes.g16.checklist.npo;
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c15 = await vista('su-g16'), d15 = await diag('su-g16');
  check('C15 ítem viejo de una casilla (dirty ["checklist"]) con la Guardia y el trazo de cuando se encoló, y la base y la copia local con otros más nuevos: al subir la cola el POST lleva la Guardia y el trazo NUEVOS (y la casilla), la base se queda con ellos y la siguiente carga los deja en modelo, caja y copia local',
    c15a.loc.entrega === NUEVA16 && c15a.loc.ls === NUEVA16 && c15a.loc.post === D16_NUEVO
    && c15a.antes.entrega === NUEVA16 && c15a.antes.post === D16_NUEVO && c15a.antes.npo === true && c15a.q === 0
    && !!post15 && metaDe(post15).entrega === NUEVA16 && metaDe(post15).body_diagram_post === D16_NUEVO && post15.body.checklist.npo === true
    && meta16.entrega === NUEVA16 && meta16.body_diagram_post === D16_NUEVO && npo16 === true
    && [c15.entrega, c15.shown, c15.ta, c15.ls].every(v => v === NUEVA16) && d15.post === D16_NUEVO && d15.ls === D16_NUEVO,
    JSON.stringify({ c15a, post15: post15 && { meta: metaDe(post15), npo: post15.body.checklist && post15.body.checklist.npo }, meta16, npo16, c15, d15 }));

  // C15b (como C15, 21 oct 2026): ítem viejo de una casilla con el trazo de ENTONCES y la base SIN diagrama. Antes la carga
  // igualaba en el meta solo la Guardia: el trazo viejo quedaba en __pl_note_meta, migrateNote lo sacaba a la pantalla
  // (diagrama vacío) y al subir la cola iba a la base. Ahora el meta se iguala también con los diagramas.
  await vista('su-g22');
  calls.length = 0;
  const c15b = await page.evaluate(async ({ b, dv }) => {
    const k = 'su-g22';
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: { app: '', pa: '', pendientes: '', entrega: b, body_diagram_post: dv, labHistory: [], imagenHistory: [], checklist: { npo: true, __pl_note_meta: { entrega: b, body_diagram_post: dv } } }, dirty: ['checklist'], ts: Date.now() - 3 * 3600000 }]);
    updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();
    const nd = noteData[k];
    const antes = { post: nd.body_diagram_post, metaPost: ((nd.checklist || {}).__pl_note_meta || {}).body_diagram_post, shown: getNote(k).body_diagram_post, npo: nd.checklist.npo };
    await __flushLimpio();
    return { antes, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, { b: B22, dv: D22_VIEJO });
  const post15b = postsDe('g22').pop(), meta22 = store.notes.g22.checklist.__pl_note_meta || {};
  check('C15b ítem viejo de una casilla con el trazo de cuando se encoló y la base SIN diagrama: la carga no lo reinstala (ni en el modelo, ni en el meta, ni en lo que se pinta), al subir la cola no va a la base y la casilla sí',
    !c15b.antes.post && !c15b.antes.metaPost && !c15b.antes.shown && c15b.antes.npo === true && c15b.q === 0
    && !!post15b && !metaDe(post15b).body_diagram_post && post15b.body.checklist.npo === true && !meta22.body_diagram_post && meta22.entrega === B22 && store.notes.g22.checklist.npo === true,
    JSON.stringify({ c15b, post15b: post15b && metaDe(post15b), meta22 }));

  // Escribir un renglón al final de una caja de la tarjeta (como al teclear y soltar la caja) y esperar a que suba.
  const teclear = async (k, field, linea) => {
    await page.evaluate(({ k, field, linea }) => {
      const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="' + field + '"]');
      ta.focus(); ta.dataset.beforeValue = ta.value; ta.value = ta.value + '\n' + linea; ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true })); ta.blur();
    }, { k, field, linea });
    await page.waitForFunction((k) => !_pendingPush.has(k) && pendingSyncs === 0, k, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
  };
  const cajas = (k) => page.evaluate((k) => {
    const q = (f) => { const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="' + f + '"]'); return ta ? ta.value : null; };
    const nd = noteData[k] || {};
    return { pend: nd.pendientes, taPend: q('pendientes'), entrega: nd.entrega, taEntrega: q('entrega'), meta: ((nd.checklist || {}).__pl_note_meta || {}).entrega };
  }, k);
  // Volver a la app (visibilitychange) con la carga lenta: devuelve cuántas cargas iban y espera a que salga la foto.
  const volverConCargaLenta = async () => {
    ctl.slowLoadMs = 2500; calls.length = 0;
    const n = await page.evaluate(() => { _lastVisibleRefreshTs = 0; const n = window.__cargas; document.dispatchEvent(new Event('visibilitychange')); return n; });
    for (let i = 0; i < 50 && !fotoNotas(); i++) await page.waitForTimeout(100);
    return { n, foto: fotoNotas() };
  };
  const esperarCarga = async (n) => { await page.waitForFunction((n) => window.__cargas > n, n, { timeout: 15000 }).catch(() => {}); ctl.slowLoadMs = 0; await page.waitForTimeout(300); };
  // Que termine cualquier subida de la cola en curso (el intervalo de 30 s reintenta sola la cola con hasta 4 intentos):
  // antes de quitar la falla, para que el reintento de la prueba arme lo que sube con lo que hay DESPUÉS del colega.
  const esperarFlush = () => page.waitForFunction(() => !_flushing, null, { timeout: 30000 }).catch(() => {});

  // C16 (r2b de la revisión): al volver a la app la foto de `notes` ya trae dos renglones nuevos de OTRO equipo (X e Y, en
  // Pendientes y en la Guardia) y, mientras viaja, se aplica un evento de Realtime ATRASADO (solo X, updated_at más viejo
  // que el de la foto: el iPad que vuelve con eventos en el búfer del socket; el de Y se perdió). Antes la carga se quedaba
  // con la nota en memoria (X): la caja quedaba vieja y la siguiente edición de este equipo borraba Y de la base. Ahora la
  // foto gana (la fila de Realtime no es tan nueva como ella) y Z se agrega a X e Y.
  const X17 = '20/10 10:30 OE: RENGLÓN X DE OTRO EQUIPO', Y17 = '20/10 10:31 OE: RENGLÓN Y DE OTRO EQUIPO', Z17 = '20/10 10:40 GF: RENGLÓN Z DE ESTE EQUIPO';
  await vista('su-g17');
  const E17 = JSON.parse(JSON.stringify(Object.assign({}, store.notes.g17, { pendientes: PB17 + '\n' + X17, checklist: { npo: false, __pl_note_meta: { entrega: B17 + '\n' + X17 } }, updated_at: pgTs(Date.now() - 60000) })));
  store.notes.g17 = Object.assign({}, store.notes.g17, { pendientes: PB17 + '\n' + X17 + '\n' + Y17, checklist: { npo: false, __pl_note_meta: { entrega: B17 + '\n' + X17 + '\n' + Y17 } }, updated_at: pgTs() });
  const v16 = await volverConCargaLenta();
  const rt16 = await page.evaluate((row) => { handleNoteChange({ eventType: 'UPDATE', new: row }); return { cargas: window.__cargas, pend: noteData['su-g17'].pendientes, entrega: noteData['su-g17'].entrega }; }, E17);
  await esperarCarga(v16.n);
  const c16a = await cajas('su-g17');
  await teclear('su-g17', 'pendientes', Z17);
  await teclear('su-g17', 'entrega', Z17);
  const base16 = { pend: store.notes.g17.pendientes, entrega: store.notes.g17.checklist.__pl_note_meta.entrega };
  const XY16p = PB17 + '\n' + X17 + '\n' + Y17, XY16g = B17 + '\n' + X17 + '\n' + Y17;
  const okRt16 = v16.foto && rt16.cargas === v16.n && rt16.pend === PB17 + '\n' + X17 && rt16.entrega === B17 + '\n' + X17;
  check('C16 evento de Realtime ATRASADO (más viejo que la foto) aplicado mientras la carga viene en camino: Pendientes queda con la foto (los renglones X e Y del otro equipo) en el modelo y la caja, y al escribir Z la base tiene X, Y y Z',
    okRt16 && c16a.pend === XY16p && c16a.taPend === XY16p && base16.pend === XY16p + '\n' + Z17,
    JSON.stringify({ v16, rt16, c16a, base16 }));
  check('C16b lo mismo en la Guardia: queda la de la foto (X e Y) en el modelo, el meta y la caja, y al escribir Z la base tiene X, Y y Z',
    okRt16 && c16a.entrega === XY16g && c16a.meta === XY16g && c16a.taEntrega === XY16g && base16.entrega === XY16g + '\n' + Z17,
    JSON.stringify({ rt16, c16a, base16 }));
  const c16c = await page.evaluate(() => {
    const t = _pgTsMicros;
    return {
      iso: t('2026-10-20T10:30:00.123456+00:00') === Date.UTC(2026, 9, 20, 10, 30, 0) * 1000 + 123456,
      espacio: t('2026-10-20 10:30:00.123456+00') === t('2026-10-20T10:30:00.123456+00:00'),
      z: t('2026-10-20T10:30:00Z') === t('2026-10-20T10:30:00.000000+00:00'),
      zona: t('2026-10-20T04:30:00-06:00') === t('2026-10-20T10:30:00+00:00'),
      micro: t('2026-10-20T10:30:00.000002+00:00') > t('2026-10-20T10:30:00.000001+00:00'),
      raro: [t(''), t(undefined), t('ayer'), t('2026-10-20')].every(Number.isNaN),
    };
  }).catch(e => ({ error: String(e && e.message || e).slice(0, 120), ok: false }));
  check('C16c horas de la base (updated_at): ISO con microsegundos y zona, con espacio y +00, Z, otra zona; los microsegundos cuentan; vacío o raro → NaN (y entonces gana la foto)',
    Object.values(c16c).every(Boolean), JSON.stringify(c16c));

  // C11b: como C11 (Realtime MÁS NUEVO que la foto durante la carga: un colega escribió X en la Guardia y P en Pendientes).
  // La carga arma la nota con la foto y de la memoria toma solo la Guardia y el meta; la línea base va igual (foto + meta
  // de Realtime). Después el colega escribe W en la Guardia y otro renglón en Pendientes (P2; el evento aquí no llega) y
  // este equipo guarda sin marcas (imagen, labs, ✨ IA…): no debe subir nada viejo. Con la línea base de la foto, el meta
  // (X) se veía «cambiado aquí» y pisaba W; con la de Realtime, Pendientes (de la foto) se veía cambiado y borraba P; con
  // la nota entera de la memoria, Pendientes (P, de Realtime) se veía cambiado y borraba P2.
  const X18 = '20/10 10:50 OE: RENGLÓN X DE OTRO EQUIPO (REALTIME DURANTE LA CARGA)', W18 = '20/10 10:55 OE: RENGLÓN W DE OTRO EQUIPO (DESPUÉS)';
  const P18 = PB18 + '\n20/10 10:50 OE: PENDIENTE DE OTRO EQUIPO', P18b = P18 + '\n20/10 10:56 OE: OTRO PENDIENTE DEL COLEGA (DESPUÉS)';
  await vista('su-g18');
  const v11b = await volverConCargaLenta();
  store.notes.g18 = Object.assign({}, store.notes.g18, { pendientes: P18, checklist: { npo: false, __pl_note_meta: { entrega: GB18 + '\n' + X18 } }, updated_at: pgTs() });
  const rt11b = await page.evaluate((row) => { handleNoteChange({ eventType: 'UPDATE', new: row }); return { cargas: window.__cargas, entrega: noteData['su-g18'].entrega }; }, JSON.parse(JSON.stringify(store.notes.g18)));
  await esperarCarga(v11b.n);
  const c11b0 = await cajas('su-g18');
  store.notes.g18.checklist = { npo: false, __pl_note_meta: { entrega: GB18 + '\n' + X18 + '\n' + W18 } }; store.notes.g18.pendientes = P18b; store.notes.g18.updated_at = pgTs();
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g18';
    saveNote(k, noteData[k]);                                // guardado sin campos marcados
    await new Promise(r => setTimeout(r, 900));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const base11b = { pend: store.notes.g18.pendientes, entrega: store.notes.g18.checklist.__pl_note_meta.entrega };
  check('C11b tras una carga con Realtime MÁS NUEVO que la foto (Guardia de la memoria), un guardado sin marcas no sube nada viejo: la base conserva la Guardia (W) y los Pendientes (el que trajo Realtime y P2) que otro equipo escribió después',
    v11b.foto && rt11b.cargas === v11b.n && rt11b.entrega === GB18 + '\n' + X18 && c11b0.entrega === GB18 + '\n' + X18 && c11b0.taEntrega === GB18 + '\n' + X18
    && base11b.entrega === GB18 + '\n' + X18 + '\n' + W18 && base11b.pend === P18b,
    JSON.stringify({ v11b, rt11b, c11b0, base11b, posts: postsDe('g18').map(c => Object.keys(c.body)) }));

  // C11c (u8 de la revisión): como C11/C11b con el diagrama. Al volver a la app la foto sale con el trazo D1 y, mientras
  // viaja, un colega dibuja otro (D2) y llega por Realtime (más nuevo que la foto). La carga toma de la memoria la Guardia,
  // los diagramas y el meta: el trazo del colega se queda en el modelo, en lo que se pinta y en la copia local, y un
  // guardado sin marcas no regresa D1 a la base (si de la memoria solo se tomara la Guardia, la pantalla volvía a D1 y ese
  // guardado lo regresaba a la base).
  await vista('su-g26');
  const v11c = await volverConCargaLenta();
  store.notes.g26 = Object.assign({}, store.notes.g26, { checklist: { npo: false, __pl_note_meta: { entrega: B26, body_diagram_post: D26_2 } }, updated_at: pgTs() });
  const rt11c = await page.evaluate((row) => { handleNoteChange({ eventType: 'UPDATE', new: row }); return { cargas: window.__cargas, post: noteData['su-g26'].body_diagram_post }; }, JSON.parse(JSON.stringify(store.notes.g26)));
  await esperarCarga(v11c.n);
  const c11c0 = await diag('su-g26');
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g26';
    saveNote(k, noteData[k]);                                // guardado sin campos marcados
    await new Promise(r => setTimeout(r, 900));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const meta26 = Object.assign({}, store.notes.g26.checklist.__pl_note_meta);
  const c11c1 = await diag('su-g26');
  check('C11c Realtime MÁS NUEVO que la foto trae otro trazo del diagrama (un colega) mientras la carga viene en camino: al aplicarse la carga el trazo del colega queda en modelo, pantalla y copia local, y un guardado sin marcas no regresa el viejo: la base se queda con el trazo del colega (y la Guardia de la base)',
    v11c.foto && rt11c.cargas === v11c.n && rt11c.post === D26_2
    && [c11c0.post, c11c0.shown, c11c0.ls].every(v => v === D26_2)
    && meta26.body_diagram_post === D26_2 && meta26.entrega === B26 && c11c1.post === D26_2 && c11c1.shown === D26_2,
    JSON.stringify({ v11c, rt11c: { cargas: rt11c.cargas, post: String(rt11c.post).slice(-12) }, c11c0: Object.fromEntries(Object.entries(c11c0).map(([a, b]) => [a, typeof b === 'string' ? b.slice(-12) : b])), meta26: { entrega: meta26.entrega, post: String(meta26.body_diagram_post).slice(-12) }, posts: postsDe('g26').map(c => Object.keys(c.body)) }));

  // C17 (t4 de la revisión): ítem SIN lista de campos (nota completa: guardado sin línea base tras abrir sin red) con la
  // Guardia escrita sin red y SIN el diagrama anterior que un colega dibujó (en la base). La carga pone el ítem entero
  // encima (diagrama vacío en memoria, como siempre); su subida falla y, antes del reintento, se teclea un lab (push de solo
  // lab_history, con éxito). Antes el ítem se quedaba con los tres campos del meta y el reintento borraba de la base el
  // diagrama del colega. Ahora se queda solo con la Guardia (escrita y distinta de la base) y lo que el ítem no marcó y
  // aquí está vacío va con lo de la base.
  const GL19 = GB19 + '\n20/10 08:10 GF: ESCRITO SIN RED (NOTA COMPLETA EN LA COLA)';
  ctl.failGuardia = new Set(['g19']);
  await vista('su-g19');
  const c17a = await page.evaluate(async (gl) => {
    const k = 'su-g19';
    const loc = { app: '', pa: '', pendientes: '', entrega: gl, body_diagram_ant: '', body_diagram_post: '', labHistory: [], imagenHistory: [], checklist: { npo: false, __pl_note_meta: { entrega: gl } } };
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: loc, dirty: null, ts: Date.now() - 60000 }]); updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();   // carga con el ítem en la cola (como al abrir)
    const tras = { ant: noteData[k].body_diagram_ant, entrega: noteData[k].entrega };
    await __flushLimpio();                                    // la subida de la cola falla (el checklist no pasa)
    return { tras, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, GL19);
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g19';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const labPosts17 = postsDe('g19').filter(c => c.status !== 500).map(c => Object.keys(c.body).filter(x => x !== 'patient_id' && x !== 'updated_by').join(','));
  const c17b = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g19').map(i => ({ dirty: i.dirty, entrega: i.data && i.data.entrega })));
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post17 = postsDe('g19').pop(), meta19 = Object.assign({}, store.notes.g19.checklist.__pl_note_meta);
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c17c = await page.evaluate(() => ({ ant: noteData['su-g19'].body_diagram_ant, entrega: noteData['su-g19'].entrega, q: outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g19').length }));
  check('C17 ítem SIN lista con la Guardia escrita sin red y el diagrama vacío (la base tiene el del colega), su subida fallando y un lab tecleado (push de solo lab_history): la cola se queda solo con la Guardia y, al reintentar, la base conserva el diagrama del colega y recibe la Guardia; la siguiente carga muestra los dos',
    c17a.tras.ant === '' && c17a.tras.entrega === GL19 && c17a.q === 1 && labPosts17.length >= 1 && labPosts17.every(s => s === 'lab_history')
    && c17b.length === 1 && Array.isArray(c17b[0].dirty) && c17b[0].dirty.join() === 'entrega' && c17b[0].entrega === GL19
    && !!post17 && metaDe(post17).body_diagram_ant === D19 && meta19.body_diagram_ant === D19 && meta19.entrega === GL19
    && c17c.ant === D19 && c17c.entrega === GL19 && c17c.q === 0,
    JSON.stringify({ c17a, labPosts17, c17b, post17: post17 && metaDe(post17), meta19, c17c }));

  // C17b (s3 de la revisión): como C17, ítem SIN lista, pero con la Guardia IGUAL a la base y un trazo del diagrama
  // posterior hecho sin red. Tras el lab (push de solo lab_history), el ítem debe quedarse solo con el trazo: la Guardia
  // no es algo que este equipo escribió. Después un colega escribe W en la Guardia (sin evento: llega en la siguiente
  // carga). Si el ítem se quedara también con la Guardia, la carga la pondría encima (W desaparece de la caja) y el
  // reintento borraría W de la base.
  const W25 = '20/10 11:00 OE: RENGLÓN W DE OTRO EQUIPO';
  ctl.failGuardia = new Set(['g25']);
  await vista('su-g25');
  const c17ba = await page.evaluate(async ({ b, d }) => {
    const k = 'su-g25';
    const loc = { app: '', pa: '', pendientes: '', entrega: b, body_diagram_ant: '', body_diagram_post: d, labHistory: [], imagenHistory: [], checklist: { npo: false, __pl_note_meta: { entrega: b, body_diagram_post: d } } };
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: loc, dirty: null, ts: Date.now() - 60000 }]); updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();   // carga con el ítem en la cola (como al abrir)
    const tras = { post: noteData[k].body_diagram_post, entrega: noteData[k].entrega };
    await __flushLimpio();                                    // la subida de la cola falla (el checklist no pasa)
    return { tras, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, { b: B25, d: D25 });
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g25';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const labPosts17b = postsDe('g25').filter(c => c.status !== 500).map(c => Object.keys(c.body).filter(x => x !== 'patient_id' && x !== 'updated_by').join(','));
  const c17bb = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g25').map(i => ({ dirty: i.dirty, post: i.data && i.data.body_diagram_post })));
  store.notes.g25.checklist = { npo: false, __pl_note_meta: { entrega: B25 + '\n' + W25 } }; store.notes.g25.updated_at = pgTs();
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c17bc = await vista('su-g25'), d17bc = await diag('su-g25');
  await esperarFlush();
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post17b = postsDe('g25').pop(), meta25 = Object.assign({}, store.notes.g25.checklist.__pl_note_meta);
  const q17b = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g25').length);
  const BW25 = B25 + '\n' + W25;
  check('C17b ítem SIN lista con la Guardia igual a la base y un trazo escrito sin red, su subida fallando y un lab tecleado: la cola se queda solo con el trazo (["body_diagram_post"]); un colega escribe W en la Guardia y la siguiente carga lo muestra (modelo y caja, con el trazo en lo que se pinta); al reintentar la base tiene W y el trazo',
    c17ba.tras.post === D25 && c17ba.tras.entrega === B25 && c17ba.q === 1 && labPosts17b.length >= 1 && labPosts17b.every(s => s === 'lab_history')
    && c17bb.length === 1 && Array.isArray(c17bb[0].dirty) && c17bb[0].dirty.join() === 'body_diagram_post' && c17bb[0].post === D25
    && [c17bc.entrega, c17bc.shown, c17bc.ta].every(v => v === BW25) && c17bc.q === 1 && [d17bc.post, d17bc.shown].every(v => v === D25)
    && !!post17b && metaDe(post17b).entrega === BW25 && metaDe(post17b).body_diagram_post === D25
    && meta25.entrega === BW25 && meta25.body_diagram_post === D25 && q17b === 0,
    JSON.stringify({ c17ba: { q: c17ba.q, entrega: c17ba.tras.entrega, post: String(c17ba.tras.post).slice(-12) }, labPosts17b, c17bb: c17bb.map(i => ({ dirty: i.dirty, post: String(i.post).slice(-12) })), c17bc, d17bc: { post: String(d17bc.post).slice(-12), shown: String(d17bc.shown).slice(-12), ls: String(d17bc.ls).slice(-12) }, meta25: { entrega: meta25.entrega, post: String(meta25.body_diagram_post).slice(-12) }, q17b }));

  // C18 (t2 rtlab de la revisión): la Guardia escrita sin red espera en la cola (dirty ["entrega"]) y su subida falla. Un
  // colega marca una casilla (atb) y Realtime trae su fila. 21 oct 2026: la casilla entra, pero la Guardia de la cola se
  // queda en memoria, en la caja y en la copia local (antes la nota en memoria tomaba la de la base: quien escribía
  // después en la caja lo hacía sin el renglón escrito sin red, y en CI la siguiente carga a veces la reponía vieja).
  // Después se teclea un lab: el ítem que se queda en la cola debe llevar lo escrito sin red y, al reintentar, subir con
  // la casilla del colega intacta.
  const GL20 = GB20 + '\n20/10 08:20 GF: ESCRITO SIN RED, ESPERA EN LA COLA';
  ctl.failGuardia = new Set(['g20']);
  await vista('su-g20');
  const c18a = await page.evaluate(async (gl) => {
    const k = 'su-g20';
    const nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = gl; _entregaMetaAlign(nd);   // como la dejó la carga (cola encima)
    noteData[k] = nd; lsSaveNote(k, nd);
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    await __flushLimpio();                                    // la subida de la cola falla
    return { q: outboxLoad().length };
  }, GL20);
  store.notes.g20.checklist = Object.assign({}, store.notes.g20.checklist, { atb: true }); store.notes.g20.updated_at = pgTs();
  const rt18 = await page.evaluate((row) => {
    if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row });
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-su-g20') || '{}'); } catch (_) {}
    const nd = noteData['su-g20'];
    return { entrega: nd.entrega, meta: ((nd.checklist || {}).__pl_note_meta || {}).entrega, ls: ls.entrega, atb: nd.checklist.atb };
  }, JSON.parse(JSON.stringify(store.notes.g20)));
  await page.evaluate(async () => {
    const k = 'su-g20';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const c18b = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g20').map(i => ({ dirty: i.dirty, entrega: i.data && i.data.entrega, meta: ((i.data && i.data.checklist || {}).__pl_note_meta || {}).entrega, atb: (i.data && i.data.checklist || {}).atb })));
  await esperarFlush();
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const base18 = { entrega: store.notes.g20.checklist.__pl_note_meta.entrega, atb: store.notes.g20.checklist.atb };
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c18c = await vista('su-g20');
  check('C18 Guardia en la cola cuya subida falló, Realtime trae una casilla de un colega (entra, y la Guardia de la cola se queda en memoria, meta y copia local) y se teclea un lab: el ítem que se queda lleva lo escrito sin red (en la nota y en el meta) con la casilla vigente, al reintentar la base tiene esa Guardia y la casilla del colega, y la siguiente carga la muestra',
    c18a.q === 1 && rt18.entrega === GL20 && rt18.meta === GL20 && rt18.ls === GL20 && rt18.atb === true
    && c18b.length === 1 && c18b[0].dirty.join() === 'entrega' && c18b[0].entrega === GL20 && c18b[0].meta === GL20 && c18b[0].atb === true
    && base18.entrega === GL20 && base18.atb === true && c18c.entrega === GL20 && c18c.ta === GL20 && c18c.q === 0,
    JSON.stringify({ c18a, rt18, c18b, base18, c18c }));

  // C19 (t2/n4 de la revisión): como C18, pero el colega llega DESPUÉS del lab. La Guardia escrita sin red espera en la
  // cola (dirty ["entrega"]) y su subida falla; se teclea un lab (push de solo lab_history, con éxito) y luego un colega
  // marca casillas (atb, npo) y escribe en los signos (pm_fc), Pendientes R1 y Cultivos de esa tarjeta, que viven en el
  // checklist; llega por Realtime. Antes el reintento subía el checklist del ítem (una foto de cuando se encoló, o de
  // cuando el lab lo rehízo) y _checklistMergeRemote tomaba todo eso como «cambiado aquí»: lo regresaba en la base. Ahora
  // un ítem sin 'checklist' ni ck_* en su lista sube el checklist vigente (con la Guardia del ítem en el meta).
  const GL23 = GB23 + '\n20/10 08:30 GF: ESCRITO SIN RED, ESPERA EN LA COLA';
  const COL23 = { npo: true, atb: true, pendientes_r1: CK23.pendientes_r1 + '\nR1 DEL COLEGA: PEDIR BH', pm_fc: '118', cultivos: 'HEMOCULTIVO POSITIVO (COLEGA)' };
  const ckDe = (c) => { c = c || {}; return { npo: c.npo, atb: c.atb, pendientes_r1: c.pendientes_r1, pm_fc: c.pm_fc, cultivos: c.cultivos }; };
  const igualCk = (c, o) => Object.keys(o).every(f => (c || {})[f] === o[f]);
  ctl.failGuardia = new Set(['g23']);
  await vista('su-g23');
  const c19a = await page.evaluate(async ({ gl, ck }) => {
    const k = 'su-g23';
    const loc = { app: '', pa: '', pendientes: '', entrega: gl, labHistory: [], imagenHistory: [], checklist: Object.assign({}, ck, { __pl_note_meta: { entrega: gl } }) };
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: loc, dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();   // carga con el ítem en la cola (como al abrir)
    const tras = noteData[k].entrega;
    await __flushLimpio();                                    // la subida de la cola falla
    return { tras, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, { gl: GL23, ck: CK23 });
  calls.length = 0;
  await page.evaluate(async () => {
    const k = 'su-g23';
    updateLabHistory(k, todayStr(), getLabKeys()[0], '12.5');
    await new Promise(r => setTimeout(r, 1200));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
  });
  const labPosts19 = postsDe('g23').filter(c => c.status !== 500).map(c => Object.keys(c.body).filter(x => x !== 'patient_id' && x !== 'updated_by').join(','));
  store.notes.g23.checklist = Object.assign({}, store.notes.g23.checklist, COL23); store.notes.g23.updated_at = pgTs();
  const rt19 = await page.evaluate((row) => { if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row }); const c = noteData['su-g23'].checklist || {}; return { npo: c.npo, atb: c.atb, pendientes_r1: c.pendientes_r1, pm_fc: c.pm_fc, cultivos: c.cultivos }; }, JSON.parse(JSON.stringify(store.notes.g23)));
  const c19b = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g23').map(i => ({ dirty: i.dirty, entrega: i.data && i.data.entrega })));
  await esperarFlush();
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post19 = postsDe('g23').pop(), base19 = JSON.parse(JSON.stringify(store.notes.g23.checklist));
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c19c = await vista('su-g23'), ck19c = await page.evaluate(() => { const c = noteData['su-g23'].checklist || {}; return { npo: c.npo, atb: c.atb, pendientes_r1: c.pendientes_r1, pm_fc: c.pm_fc, cultivos: c.cultivos }; });
  check('C19 Guardia en la cola (dirty ["entrega"]) cuya subida falló, un lab tecleado (push de solo lab_history) y DESPUÉS un colega cambia por Realtime casillas (atb, npo), signos (pm_fc), Pendientes R1 y Cultivos de esa tarjeta: el ítem se queda con la Guardia y, al reintentar, la base conserva todo lo del colega y recibe la Guardia escrita sin red; la siguiente carga muestra las dos cosas',
    c19a.tras === GL23 && c19a.q === 1 && labPosts19.length >= 1 && labPosts19.every(s => s === 'lab_history') && igualCk(rt19, COL23)
    && c19b.length === 1 && Array.isArray(c19b[0].dirty) && c19b[0].dirty.join() === 'entrega' && c19b[0].entrega === GL23
    && !!post19 && igualCk(post19.body.checklist, COL23) && metaDe(post19).entrega === GL23
    && igualCk(base19, COL23) && (base19.__pl_note_meta || {}).entrega === GL23
    && c19c.entrega === GL23 && c19c.ta === GL23 && c19c.q === 0 && igualCk(ck19c, COL23),
    JSON.stringify({ c19a, labPosts19, rt19, c19b, post19: post19 && Object.assign(ckDe(post19.body.checklist), { entrega: metaDe(post19).entrega }), base19: Object.assign(ckDe(base19), { entrega: (base19.__pl_note_meta || {}).entrega }), c19c, ck19c }));

  // C19b: la otra variante. Con dirty ["checklist","entrega"] (este equipo marcó sin red una casilla además de escribir la
  // Guardia) el ítem SIGUE subiendo su checklist: la casilla es algo que este equipo cambió. Sin lab: tras un push de solo
  // labs el ítem se queda solo con la Guardia y los diagramas (outboxDropNoteItemsBefore) y sería C19. El colega cambia otra
  // casilla y los signos por Realtime antes del reintento; lo que pase con esos cambios lo decide _checklistMergeRemote,
  // como antes (aquí no se mira).
  const GL24 = GB24 + '\n20/10 08:35 GF: ESCRITO SIN RED CON UNA CASILLA';
  ctl.failGuardia = new Set(['g24']);
  await vista('su-g24');
  const c19ba = await page.evaluate(async (gl) => {
    const k = 'su-g24';
    const loc = { app: '', pa: '', pendientes: '', entrega: gl, labHistory: [], imagenHistory: [], checklist: { npo: true, atb: false, pm_fc: '80', __pl_note_meta: { entrega: gl } } };
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: loc, dirty: ['checklist', 'entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft();
    const tras = { entrega: noteData[k].entrega, npo: noteData[k].checklist.npo };
    await __flushLimpio();                                    // la subida de la cola falla
    return { tras, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, GL24);
  store.notes.g24.checklist = Object.assign({}, store.notes.g24.checklist, { atb: true, pm_fc: '118' }); store.notes.g24.updated_at = pgTs();
  const rt19b = await page.evaluate((row) => { if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row }); const c = noteData['su-g24'].checklist || {}; return { npo: c.npo, atb: c.atb, pm_fc: c.pm_fc }; }, JSON.parse(JSON.stringify(store.notes.g24)));
  const c19bb = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g24').map(i => ({ dirty: i.dirty, npo: (i.data && i.data.checklist || {}).npo })));
  await esperarFlush();
  ctl.failGuardia.clear(); calls.length = 0;
  await page.evaluate(() => __flushLimpio());
  const post19b = postsDe('g24').pop(), base19b = JSON.parse(JSON.stringify(store.notes.g24.checklist));
  const q19b = await page.evaluate(() => outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g24').length);
  check('C19b la otra variante, Guardia y una casilla escritas sin red (dirty ["checklist","entrega"]) con la subida fallando y un colega que cambia otra casilla por Realtime: el reintento sigue subiendo el checklist del ítem: la casilla de este equipo (npo) y la Guardia llegan a la base',
    c19ba.tras.entrega === GL24 && c19ba.tras.npo === true && c19ba.q === 1
    && c19bb.length === 1 && Array.isArray(c19bb[0].dirty) && c19bb[0].dirty.join() === 'checklist,entrega' && c19bb[0].npo === true
    && !!post19b && post19b.body.checklist && post19b.body.checklist.npo === true && metaDe(post19b).entrega === GL24
    && base19b.npo === true && (base19b.__pl_note_meta || {}).entrega === GL24 && q19b === 0,
    JSON.stringify({ c19ba, rt19b, c19bb, post19b: post19b && { npo: (post19b.body.checklist || {}).npo, atb: (post19b.body.checklist || {}).atb, entrega: metaDe(post19b).entrega }, base19b: { npo: base19b.npo, atb: base19b.atb, pm_fc: base19b.pm_fc, entrega: (base19b.__pl_note_meta || {}).entrega }, q19b }));

  // C20 (21 oct 2026): la Guardia escrita sin red sube por la cola y la base la guarda con un renglón de otro equipo que la
  // subida no traía (pl_entrega_protegida conserva lo que otro equipo escribió hace menos de 15 min). Modelo, meta, caja y
  // copia local quedan con lo que la base tiene, y lo que este equipo escribe después en la Guardia lo lleva. Antes la
  // memoria se quedaba con lo subido y, pasados los 15 min, esa siguiente edición borraba de la base el renglón del colega.
  const GL27 = B27 + '\n20/10 08:40 GF: ESCRITO SIN RED (VEINTISIETE)', OTRO27 = '20/10 08:41 OE: RENGLÓN QUE LA BASE CONSERVA';
  const Z27 = '20/10 08:50 GF: DESPUÉS DE SUBIR LA COLA', GO27 = GL27 + '\n' + OTRO27;
  await vista('su-g27');
  ctl.serverAddLine = { g27: OTRO27 };
  let soltarGet27 = null; ctl.holdGetFor = { g27: new Promise(r => { soltarGet27 = r; }) };   // la relectura espera: cuenta lo que se igualó al subir
  const c20a = await page.evaluate(async (gl) => {
    const k = 'su-g27';
    const nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = gl; _entregaMetaAlign(nd);   // como la dejó la carga (cola encima)
    noteData[k] = nd; lsSaveNote(k, nd);
    await __sinFlush(); outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    await __flushLimpio();
    return { q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length };
  }, GL27);
  delete ctl.serverAddLine;
  const subida27 = store.notes.g27.checklist.__pl_note_meta.entrega;
  await page.waitForTimeout(2200);   // el repintado de la tarjeta espera la calma (_rerenderCardSoft)
  const c20b = await vista('su-g27'), meta27 = await page.evaluate(() => ((noteData['su-g27'].checklist || {}).__pl_note_meta || {}).entrega);
  // Mientras la relectura sigue en camino, otro equipo agrega W27 y llega por Realtime; la relectura (foto de antes de
  // W27) no regresa la caja.
  const W27 = '20/10 08:45 OE: W27 DESPUÉS DE LA SUBIDA', GOW27 = GO27 + '\n' + W27;
  const ck27 = JSON.parse(JSON.stringify(store.notes.g27.checklist)); ck27.__pl_note_meta.entrega = GOW27;
  store.notes.g27 = Object.assign({}, store.notes.g27, { checklist: ck27, updated_at: pgTs(Date.now() + 1000) });
  await page.evaluate((row) => { if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row }); }, JSON.parse(JSON.stringify(store.notes.g27)));
  delete ctl.holdGetFor; soltarGet27();
  await page.waitForTimeout(2500);
  const c20d = await vista('su-g27');
  await teclear('su-g27', 'entrega', Z27);
  const base27 = store.notes.g27.checklist.__pl_note_meta.entrega, pend27 = store.notes.g27.pendientes;
  check('C20 la Guardia de la cola sube y la base la guarda con un renglón de otro equipo que la subida no traía: modelo, meta, caja y copia local quedan con lo de la base al subir (sin esperar la relectura); una relectura más vieja que un evento de Realtime posterior no regresa la caja, y lo que se escribe después en la Guardia lo conserva todo (Pendientes intacto)',
    c20a.q === 0 && subida27 === GO27 && [c20b.entrega, c20b.shown, c20b.ta, c20b.ls, meta27].every(v => v === GO27)
    && [c20d.entrega, c20d.ta].every(v => v === GOW27) && base27 === GOW27 + '\n' + Z27 && pend27 === 'PEND BASE 27',
    JSON.stringify({ c20a, subida27, c20b, meta27, c20d, base27, pend27 }));

  // C20b: si al llegar la respuesta de la subida de la cola este equipo está escribiendo en la Guardia (campo sucio, sin
  // soltar la caja), la memoria se queda con lo que se escribe, no con la fila de la respuesta.
  const GQ27 = GOW27 + '\n' + Z27 + '\n20/10 09:00 GF: EN LA COLA (VEINTISIETE)', TQ27 = GQ27 + '\n20/10 09:01 GF: ESCRIBIENDO SIN SOLTAR LA CAJA';
  let soltar27 = null; ctl.holdPost = new Promise(r => { soltar27 = r; });
  await page.evaluate((g) => {
    const k = 'su-g27', nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = g; _entregaMetaAlign(nd);
    noteData[k] = nd; lsSaveNote(k, nd);
    outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    window.__flush27 = __sinFlush().then(() => flushOutbox());
  }, GQ27);
  for (let i = 0; i < 80 && store.notes.g27.checklist.__pl_note_meta.entrega !== GQ27; i++) await page.waitForTimeout(100);
  const escrito27 = store.notes.g27.checklist.__pl_note_meta.entrega === GQ27;
  await page.evaluate((t) => { const k = 'su-g27'; noteData[k].entrega = t; (_dirtyFields[k] = _dirtyFields[k] || new Set()).add('entrega'); }, TQ27);
  delete ctl.holdPost; soltar27();
  const c20c = await page.evaluate(async () => { await window.__flush27; const k = 'su-g27', r = { entrega: noteData[k].entrega, q: outboxLoad().filter(i => i.type === 'note' && i.key === k).length }; if (_dirtyFields[k]) _dirtyFields[k].delete('entrega'); return r; });
  check('C20b la respuesta de la subida de la cola llega mientras este equipo escribe en la Guardia (sin soltar la caja): la memoria se queda con lo que se escribe; cola vacía',
    escrito27 && c20c.entrega === TQ27 && c20c.q === 0, JSON.stringify({ escrito27, c20c }));

  // C21 (21 oct 2026): mientras la respuesta de la subida de la cola viene en camino, otro equipo guarda la nota (un
  // renglón más en la Guardia) y su evento de Realtime llega ANTES que la respuesta. Con el ítem aún en la cola, la caja
  // conserva lo escrito sin red y suma el renglón del colega (_guardiaConNuevos); la fila de la respuesta es más vieja que
  // la de Realtime, así que la memoria no se iguala a ella, y al terminar la nota se relee de la base.
  const GL28 = B28 + '\n20/10 08:45 GF: ESCRITO SIN RED (VEINTIOCHO)', COL28 = '20/10 08:46 OE: RENGLÓN DEL COLEGA DURANTE LA SUBIDA';
  await vista('su-g28');
  let soltar28 = null; ctl.holdPost = new Promise(r => { soltar28 = r; });
  await page.evaluate((gl) => {
    const k = 'su-g28';
    const nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = gl; _entregaMetaAlign(nd);
    noteData[k] = nd; lsSaveNote(k, nd);
    outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    window.__flush28 = __sinFlush().then(() => flushOutbox());
  }, GL28);
  for (let i = 0; i < 80 && store.notes.g28.checklist.__pl_note_meta.entrega !== GL28; i++) await page.waitForTimeout(100);
  const escrito28 = store.notes.g28.checklist.__pl_note_meta.entrega === GL28;
  const ck28 = JSON.parse(JSON.stringify(store.notes.g28.checklist)); ck28.__pl_note_meta.entrega = GL28 + '\n' + COL28;
  store.notes.g28 = Object.assign({}, store.notes.g28, { checklist: ck28, updated_at: pgTs(Date.now() + 1000) });
  const rt21 = await page.evaluate((row) => { if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row }); return noteData['su-g28'].entrega; }, JSON.parse(JSON.stringify(store.notes.g28)));
  calls.length = 0;
  // La relectura llega con una supresión vigente (un lab tecleado en esa tarjeta: suppressKey) y su primera petición falla.
  await page.evaluate(() => suppressKey('g28', 6000));
  ctl.failGetOnce = new Set(['g28']);
  delete ctl.holdPost; soltar28();
  await page.evaluate(() => window.__flush28);
  await page.waitForFunction((v) => noteData['su-g28'].entrega === v, GL28 + '\n' + COL28, { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const c21 = await vista('su-g28');
  const gets21 = calls.filter(c => c.m === 'GET' && c.url.startsWith('/rest/v1/notes') && c.url.indexOf('patient_id=eq.g28') !== -1).length;
  const GC28 = GL28 + '\n' + COL28;
  check('C21 un colega guarda mientras la respuesta de la subida de la cola viene en camino y su Realtime llega antes: con el ítem en la cola la caja conserva lo escrito sin red y suma el renglón del colega; la respuesta (más vieja) no regresa la memoria y la nota se relee (aunque haya una supresión vigente y la primera relectura falle): modelo, caja y copia local con los dos renglones, cola vacía',
    escrito28 && rt21 === GL28 + '\n' + COL28 && gets21 >= 2 && [c21.entrega, c21.shown, c21.ta, c21.ls].every(v => v === GC28) && c21.q === 0,
    JSON.stringify({ escrito28, rt21, gets21, c21 }));

  // C21b: mientras la respuesta de la subida viene en camino se encola OTRO ítem de esa nota con una Guardia más nueva
  // (escrita después; su push directo falló). Al llegar la respuesta la memoria se queda con la más nueva, la que espera en
  // la cola (no con la de la respuesta), y la siguiente subida la lleva a la base.
  const A28 = GC28 + '\n20/10 08:57 GF: RENGLÓN A (EN LA COLA)', N28 = A28 + '\n20/10 08:58 GF: RENGLÓN B (ESCRITO MIENTRAS SUBÍA)';
  let soltar28b = null; ctl.holdPost = new Promise(r => { soltar28b = r; });
  await page.evaluate((a) => {
    const k = 'su-g28', nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = a; _entregaMetaAlign(nd);
    noteData[k] = nd; lsSaveNote(k, nd);
    outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'], ts: Date.now() - 60000 }]); updateOutboxBadge();
    window.__flush28b = __sinFlush().then(() => flushOutbox());
  }, A28);
  for (let i = 0; i < 80 && store.notes.g28.checklist.__pl_note_meta.entrega !== A28; i++) await page.waitForTimeout(100);
  const escrito28b = store.notes.g28.checklist.__pl_note_meta.entrega === A28;
  await page.evaluate((n) => {
    const k = 'su-g28', nd = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); nd.entrega = n; _entregaMetaAlign(nd);
    noteData[k] = nd; lsSaveNote(k, nd);
    outboxEnqueue({ type: 'note', key: k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: ['entrega'] });
  }, N28);
  delete ctl.holdPost; soltar28b();
  await page.evaluate(() => window.__flush28b);
  const c21b1 = await page.evaluate(() => ({ entrega: noteData['su-g28'].entrega, q: outboxLoad().filter(i => i.type === 'note' && i.key === 'su-g28').map(i => i.data && i.data.entrega) }));
  await esperarFlush();
  await page.evaluate(() => __flushLimpio());
  const base28b = store.notes.g28.checklist.__pl_note_meta.entrega;
  const c21b2 = await vista('su-g28');
  check('C21b con la respuesta de la subida en camino se encola otro ítem con una Guardia más nueva: al llegar la respuesta la memoria se queda con la más nueva (la de la cola) y la siguiente subida la deja en la base; cola vacía',
    escrito28b && c21b1.entrega === N28 && c21b1.q.length === 1 && c21b1.q[0] === N28 && base28b === N28 && c21b2.entrega === N28 && c21b2.q === 0,
    JSON.stringify({ escrito28b, c21b1, base28b, c21b2 }));

  // Notas de la cola armadas como las deja la carga (Guardia escrita sin red encima) y el ítem de cada una.
  const enCola = (specs) => page.evaluate((specs) => {
    const t = Date.now() - 60000, q = [];
    specs.forEach((s, i) => {
      if (!s.k) { q.push({ type: 'prueba-sin-tipo', key: 'relleno-' + i, ts: t + i }); return; }   // relleno: se descarta sin red
      const f = s.f || 'entrega', nd = migrateNote(JSON.parse(JSON.stringify(noteData[s.k]))); nd[f] = s.g; _entregaMetaAlign(nd);
      noteData[s.k] = nd; lsSaveNote(s.k, nd);
      q.push({ type: 'note', key: s.k, data: _outboxNoteCopy(JSON.parse(JSON.stringify(nd))), dirty: [f], ts: t + i });
    });
    outboxSave(q); updateOutboxBadge(); renderView();   // la tarjeta pinta lo de la cola, como tras la carga
    window.__flushCola = __sinFlush().then(() => flushOutbox());
  }, specs);
  const metaEntrega = (id) => ((store.notes[id].checklist || {}).__pl_note_meta || {}).entrega;

  // C23 (revisión del arreglo, 21 oct 2026): la cola sube el ítem VIGENTE. Mientras el flush va en la primera tanda (10 por
  // tanda; una nota de esa tanda espera respuesta), este equipo escribe L2 en la Guardia de la tarjeta 32: ese push
  // directo sube y quita su ítem de la cola. Antes la segunda tanda subía igual la copia leída al empezar (sin L2): la
  // base perdía L2 y, con la memoria tomando lo que devuelve la base, también la pantalla.
  const GL32 = B32 + '\n20/10 09:05 GF: L1 ESCRITO SIN RED', L2_32 = '20/10 09:06 GF: L2 ESCRITO CON LA COLA SUBIENDO', GL2_32 = GL32 + '\n' + L2_32;
  const GL33 = B33 + '\n20/10 09:05 GF: OTRA TARJETA EN LA COLA';
  await vista('su-g32');
  let soltar33 = null; ctl.holdPostFor = { g33: new Promise(r => { soltar33 = r; }) };
  await enCola([{ k: 'su-g33', g: GL33 }].concat(Array.from({ length: 9 }, () => ({}))).concat([{ k: 'su-g32', g: GL32 }]));
  for (let i = 0; i < 80 && metaEntrega('g33') !== GL33; i++) await page.waitForTimeout(100);
  const escrito33 = metaEntrega('g33') === GL33;
  await teclear('su-g32', 'entrega', L2_32);
  const directo32 = metaEntrega('g32'), qDirecto32 = await page.evaluate(() => outboxLoad().filter(i => i.key === 'su-g32').length);
  delete ctl.holdPostFor; soltar33();
  await page.evaluate(() => window.__flushCola);
  await page.waitForTimeout(600);
  const base32 = metaEntrega('g32'), c23 = await vista('su-g32');
  check('C23 con la cola subiendo (la tarjeta 32 en la segunda tanda) este equipo escribe L2 en su Guardia y ese push directo sube: la cola ya no sube la copia leída al empezar; base, modelo y caja con L1 y L2; cola vacía',
    escrito33 && directo32 === GL2_32 && qDirecto32 === 0 && base32 === GL2_32 && c23.entrega === GL2_32 && c23.ta === GL2_32 && c23.q === 0,
    JSON.stringify({ escrito33, directo32, qDirecto32, base32, c23 }));

  // C21c (revisión del arreglo): la respuesta de la subida de la cola (Guardia X1) se retiene; mientras, este equipo
  // escribe L4 en esa Guardia y su push directo sube y responde ANTES. Al llegar la respuesta vieja de la cola, la memoria
  // no se regresa a X1 (la respuesta del push propio es más nueva): se relee la nota y queda X1 + L4. Antes la caja perdía
  // L4 y la siguiente edición lo borraba de la base.
  const X1_32 = GL2_32 + '\n20/10 09:20 GF: L3 EN LA COLA', L4_32 = '20/10 09:21 GF: L4 ESCRITO MIENTRAS SUBÍA LA COLA', X14_32 = X1_32 + '\n' + L4_32;
  await vista('su-g32');
  let soltar32 = null; ctl.holdNextPostFor = { g32: new Promise(r => { soltar32 = r; }) };
  await enCola([{ k: 'su-g32', g: X1_32 }]);
  for (let i = 0; i < 80 && metaEntrega('g32') !== X1_32; i++) await page.waitForTimeout(100);
  const escritoX1 = metaEntrega('g32') === X1_32;
  await teclear('su-g32', 'entrega', L4_32);
  const directoX14 = metaEntrega('g32');
  soltar32();
  await page.evaluate(() => window.__flushCola);
  await page.waitForFunction((v) => noteData['su-g32'].entrega === v, X14_32, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const c21c = await vista('su-g32');
  check('C21c la respuesta de la subida de la cola llega DESPUÉS de la de un push directo más nuevo de este equipo (otro renglón en esa Guardia): la memoria no se regresa a lo de la cola; modelo, caja y copia local con los dos renglones, como la base',
    escritoX1 && directoX14 === X14_32 && metaEntrega('g32') === X14_32 && [c21c.entrega, c21c.ta, c21c.ls].every(v => v === X14_32) && c21c.q === 0,
    JSON.stringify({ escritoX1, directoX14, base: metaEntrega('g32'), c21c }));

  // C21d (revisión del arreglo): como C21, pero lo más nuevo llega por una CARGA (volver a la app) y no por Realtime: un
  // colega agrega C a la Guardia mientras la respuesta de la subida de la cola viene en camino. La respuesta (más vieja
  // que la foto) no regresa la memoria: se relee y queda con los dos renglones.
  const Y1_33 = GL33 + '\n20/10 09:25 GF: ESCRITO SIN RED (TREINTA Y TRES)', C33 = '20/10 09:26 OE: RENGLÓN DEL COLEGA QUE TRAE LA CARGA', YC33 = Y1_33 + '\n' + C33;
  await vista('su-g33');
  let soltarY = null; ctl.holdNextPostFor = { g33: new Promise(r => { soltarY = r; }) };
  await enCola([{ k: 'su-g33', g: Y1_33 }]);
  for (let i = 0; i < 80 && metaEntrega('g33') !== Y1_33; i++) await page.waitForTimeout(100);
  const escritoY1 = metaEntrega('g33') === Y1_33;
  const ck33 = JSON.parse(JSON.stringify(store.notes.g33.checklist)); ck33.__pl_note_meta.entrega = YC33;
  store.notes.g33 = Object.assign({}, store.notes.g33, { checklist: ck33, updated_at: pgTs(Date.now() + 1000) });
  const carga21d = await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); return noteData['su-g33'].entrega; });
  soltarY();
  await page.evaluate(() => window.__flushCola);
  await page.waitForFunction((v) => noteData['su-g33'].entrega === v, YC33, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const c21d = await vista('su-g33');
  check('C21d lo más nuevo llega por una carga (un colega agregó un renglón) mientras la respuesta de la subida de la cola viene en camino: con el ítem en la cola la carga muestra lo de la cola; la respuesta, más vieja que la foto, no regresa la memoria y la nota se relee: modelo, caja y copia local con los dos renglones',
    escritoY1 && carga21d === Y1_33 && [c21d.entrega, c21d.ta, c21d.ls].every(v => v === YC33) && c21d.q === 0,
    JSON.stringify({ escritoY1, carga21d, c21d }));

  // C23b (revisión del arreglo): la subida de la cola (Pendientes X36) sale, pero llega a la base DESPUÉS de un push directo
  // de este equipo que agregó L36 a esa caja (dos peticiones del mismo equipo; la de la cola, lenta). La base queda con lo
  // del ítem: la memoria no se regresa (ni al igualar ni al releer) y lo de la caja se vuelve a subir: base y caja con L36.
  const X36 = 'PEND 36\n20/10 10:00 GF: X36 ESCRITO SIN RED', L36 = '20/10 10:01 GF: L36 ESCRITO MIENTRAS SUBÍA', XL36 = X36 + '\n' + L36;
  await vista('su-g36');
  let soltar36 = null; ctl.holdNextBeforeWriteFor = { g36: new Promise(r => { soltar36 = r; }) };
  calls.length = 0;
  await enCola([{ k: 'su-g36', f: 'pendientes', g: X36 }]);
  for (let i = 0; i < 80 && !postsDe('g36').length; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  await teclear('su-g36', 'pendientes', L36);
  // Que pase también el autoguardado de la caja (900 ms tras teclear): si no, su push repara la base por casualidad.
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !_pendingPush.has('su-g36') && pendingSyncs === 0, null, { timeout: 10000 }).catch(() => {});
  const directo36 = store.notes.g36.pendientes;
  soltar36();
  await page.evaluate(() => window.__flushCola);
  const tarde36 = store.notes.g36.pendientes;
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !_pendingPush.has('su-g36') && pendingSyncs === 0, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const c23b = await cajas('su-g36'), q23b = await page.evaluate(() => outboxLoad().filter(i => i.key === 'su-g36').length);
  check('C23b la subida de la cola llega a la base DESPUÉS de un push directo más nuevo de este equipo en esa caja y la regresa: la memoria no se regresa y lo de la caja se vuelve a subir; base, modelo y caja con lo más nuevo, cola vacía',
    directo36 === XL36 && tarde36 === X36 && c23b.pend === XL36 && c23b.taPend === XL36 && store.notes.g36.pendientes === XL36 && q23b === 0,
    JSON.stringify({ directo36, tarde36, c23b, base: store.notes.g36.pendientes, q23b }));

  // C24 (revisión del arreglo): dos notas en la cola; la de la tarjeta 30 sube y la base la guarda con un renglón de otro
  // equipo que la subida no traía, la de la 31 sigue esperando respuesta (el flush no termina). Llega el eco de Realtime de
  // la subida de la 30: la caja muestra lo de la base. Antes el ítem seguía en la cola hasta el final del flush y el eco
  // se tapaba con lo del ítem (sin el renglón del colega).
  const GL30 = B30 + '\n20/10 09:10 GF: ESCRITO SIN RED (TREINTA)', OTRO30 = '20/10 09:09 OE: RENGLÓN QUE LA BASE CONSERVA (TREINTA)', GO30 = GL30 + '\n' + OTRO30;
  const GL31 = B31 + '\n20/10 09:10 GF: ESCRITO SIN RED (TREINTA Y UNO)';
  await vista('su-g30');
  let soltar31 = null; ctl.holdPostFor = { g31: new Promise(r => { soltar31 = r; }) }; ctl.serverAddLine = { g30: OTRO30 };
  await enCola([{ k: 'su-g31', g: GL31 }, { k: 'su-g30', g: GL30 }]);
  for (let i = 0; i < 80 && !(metaEntrega('g31') === GL31 && metaEntrega('g30') === GO30); i++) await page.waitForTimeout(100);
  delete ctl.serverAddLine;
  await page.waitForFunction(() => noteData['su-g30'].entrega.indexOf('LA BASE CONSERVA') !== -1, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  const rt24 = await page.evaluate((row) => {
    if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row });
    return { entrega: noteData['su-g30'].entrega, q30: outboxLoad().filter(i => i.key === 'su-g30').length, enCurso: !!_flushing };
  }, JSON.parse(JSON.stringify(store.notes.g30)));
  delete ctl.holdPostFor; soltar31();
  await page.evaluate(() => window.__flushCola);
  await page.waitForTimeout(2200);
  const c24 = await vista('su-g30');
  check('C24 dos notas en la cola: la 30 sube (la base guarda además el renglón de otro equipo) mientras la 31 espera respuesta; el eco de Realtime de la 30 llega con el flush en curso: la 30 ya salió de la cola y modelo, caja y copia local quedan con lo de la base',
    rt24.enCurso && rt24.q30 === 0 && rt24.entrega === GO30 && [c24.entrega, c24.shown, c24.ta, c24.ls].every(v => v === GO30) && c24.q === 0 && metaEntrega('g31') === GL31,
    JSON.stringify({ rt24, c24 }));

  // C25 (revisión del arreglo): un ítem de la cola que no logra subir (la base rechaza su checklist), con la Guardia escrita
  // sin red: este equipo quitó OLD34 y agregó L34. Un colega agrega C34 y llega por Realtime: la caja muestra lo de la
  // cola más C34, y OLD34 no reaparece. Ya sin falla, este equipo escribe Z34 en la Guardia: el push lleva C34. Antes la
  // caja tapaba C34 con lo de la cola y, pasados 15 min, esa edición lo borraba de la base.
  const L34 = '20/10 09:30 GF: L34 ESCRITO SIN RED', C34 = '20/10 09:31 OE: C34 DEL COLEGA', Z34 = '20/10 09:40 GF: Z34 DESPUÉS';
  const GL34 = B34 + '\n' + L34, GLC34 = GL34 + '\n' + C34;
  ctl.failGuardia = new Set(['g34']);
  await vista('su-g34');
  await enCola([{ k: 'su-g34', g: GL34 }]);
  await page.evaluate(() => window.__flushCola);   // la subida falla (4 intentos)
  const ck34 = JSON.parse(JSON.stringify(store.notes.g34.checklist)); ck34.__pl_note_meta.entrega = B34 + '\n' + OLD34 + '\n' + C34;
  store.notes.g34 = Object.assign({}, store.notes.g34, { checklist: ck34, updated_at: pgTs() });
  const rt25 = await page.evaluate((row) => {
    if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row });
    let ls = {}; try { ls = JSON.parse(localStorage.getItem('note-su-g34') || '{}'); } catch (_) {}
    return { entrega: noteData['su-g34'].entrega, ls: ls.entrega, q: outboxLoad().filter(i => i.key === 'su-g34').length };
  }, JSON.parse(JSON.stringify(store.notes.g34)));
  await page.waitForTimeout(2200);
  await esperarFlush();
  ctl.failGuardia.clear();
  await teclear('su-g34', 'entrega', Z34);
  await esperarFlush(); await page.evaluate(() => __flushLimpio());
  const base25 = metaEntrega('g34'), c25 = await vista('su-g34');
  check('C25 ítem de la cola que no logra subir con la Guardia escrita sin red (un renglón quitado y otro agregado) y un colega que agrega un renglón por Realtime: la caja muestra lo de la cola más el del colega, sin reaparecer el quitado; la siguiente edición de la Guardia lleva el renglón del colega a la base',
    rt25.entrega === GLC34 && rt25.ls === GLC34 && rt25.q === 1 && base25 === GLC34 + '\n' + Z34 && c25.entrega === base25 && c25.q === 0,
    JSON.stringify({ rt25, base25, c25 }));

  // C21e (revisión del arreglo): la subida de la cola no cambia nada (Pendientes ya estaba así en la base: PostgREST
  // responde [] por pl_zz_sin_cambios) y, mientras la respuesta viene en camino, un colega agrega un pendiente que llega por
  // Realtime (tapado por la cola mientras el ítem sigue ahí). Sin fila en la respuesta no hay con qué igualar: la nota se
  // relee igual y la caja queda con el pendiente del colega.
  const P35 = 'PEND 35\n20/10 09:45 GF: YA ESTABA EN LA BASE', X35 = '20/10 09:46 OE: PENDIENTE DEL COLEGA (SUBIDA SIN CAMBIOS)';
  store.notes.g35 = Object.assign({}, store.notes.g35, { pendientes: P35 });
  await vista('su-g35');
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderView(); });
  let soltar35 = null; ctl.holdNextPostFor = { g35: new Promise(r => { soltar35 = r; }) };
  calls.length = 0;
  await enCola([{ k: 'su-g35', f: 'pendientes', g: P35 }]);
  for (let i = 0; i < 80 && !postsDe('g35').length; i++) await page.waitForTimeout(100);
  const noop35 = !!postsDe('g35')[0] && postsDe('g35')[0].sinCambio === true;
  store.notes.g35 = Object.assign({}, store.notes.g35, { pendientes: P35 + '\n' + X35, updated_at: pgTs(Date.now() + 1000) });
  const rt21e = await page.evaluate((row) => { if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row }); return noteData['su-g35'].pendientes; }, JSON.parse(JSON.stringify(store.notes.g35)));
  await page.evaluate(() => suppressKey('g35', 20000));   // supresión larga vigente (un guardado propio): la relectura no la espera
  soltar35();
  await page.evaluate(() => window.__flushCola);
  await page.waitForFunction((v) => noteData['su-g35'].pendientes === v, P35 + '\n' + X35, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(2200);
  const c21e = await cajas('su-g35'), q21e = await page.evaluate(() => outboxLoad().filter(i => i.key === 'su-g35').length);
  check('C21e la subida de la cola no cambia nada (respuesta [] como con pl_zz_sin_cambios) y un colega agrega un pendiente mientras la respuesta viene en camino: con el ítem en la cola se tapa; al terminar la nota se relee (aunque haya una supresión vigente) y modelo y caja quedan con el pendiente del colega',
    noop35 && rt21e === P35 && c21e.pend === P35 + '\n' + X35 && c21e.taPend === P35 + '\n' + X35 && q21e === 0,
    JSON.stringify({ noop35, rt21e, c21e, q21e }));

  // C22 (21 oct 2026): límites de lo que Realtime repone de la cola. (a) Con la Guardia EN EDICIÓN aquí (campo sucio) y
  // un ítem viejo de la cola con otra Guardia, el evento de un colega no pone en memoria la de la cola: se queda lo que se
  // está escribiendo (y la casilla del colega entra). (b) Un ítem SIN lista (nota completa) no se repone sobre Realtime:
  // la casilla y los Pendientes que el colega cambió se ven (sobre la carga sí se repone, como antes).
  const VIEJA29 = B29 + '\n20/10 08:00 GF: GUARDIA VIEJA EN LA COLA', TECLEO29 = B29 + '\n20/10 08:55 GF: LO QUE SE ESTÁ ESCRIBIENDO';
  ctl.failGuardia = new Set(['g29']);
  await vista('su-g29');
  const rt22 = async (cambios) => {
    store.notes.g29 = Object.assign({}, store.notes.g29, cambios, { checklist: Object.assign({}, store.notes.g29.checklist, cambios.checklist || {}), updated_at: pgTs() });
    return page.evaluate((row) => {
      if (_suppressRealtimeKeys.clear) _suppressRealtimeKeys.clear(); handleNoteChange({ eventType: 'UPDATE', new: row });
      const nd = noteData['su-g29']; return { entrega: nd.entrega, atb: nd.checklist.atb, npo: nd.checklist.npo, pend: nd.pendientes };
    }, JSON.parse(JSON.stringify(store.notes.g29)));
  };
  await page.evaluate(({ vieja, tecleo }) => {
    const k = 'su-g29', nd = migrateNote(JSON.parse(JSON.stringify(noteData[k])));
    const it = migrateNote(JSON.parse(JSON.stringify(nd))); it.entrega = vieja; _entregaMetaAlign(it);
    outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(it), dirty: ['entrega'], ts: Date.now() - 600000 }]); updateOutboxBadge();
    nd.entrega = tecleo; noteData[k] = nd; (_dirtyFields[k] = _dirtyFields[k] || new Set()).add('entrega');   // escribiendo, sin soltar la caja
  }, { vieja: VIEJA29, tecleo: TECLEO29 });
  const c22a = await rt22({ checklist: { atb: true } });
  await page.evaluate(() => { const k = 'su-g29'; if (_dirtyFields[k]) _dirtyFields[k].delete('entrega'); outboxSave(outboxLoad().filter(i => i.key !== k)); updateOutboxBadge(); });
  await page.evaluate(() => {
    const k = 'su-g29', it = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); it.checklist.npo = false;
    outboxSave([{ type: 'note', key: k, data: _outboxNoteCopy(it), dirty: null, ts: Date.now() - 60000 }]); updateOutboxBadge();
  });
  const c22b = await rt22({ pendientes: 'PEND BASE 29\nPEND DEL COLEGA', checklist: { npo: true } });
  await page.evaluate(() => { outboxSave(outboxLoad().filter(i => i.key !== 'su-g29')); updateOutboxBadge(); });
  ctl.failGuardia.clear();
  check('C22 Realtime y la cola: (a) con la Guardia en edición aquí y un ítem viejo con otra Guardia, el evento de un colega deja lo que se está escribiendo (y su casilla entra); (b) un ítem sin lista (nota completa) no tapa en Realtime la casilla ni los Pendientes del colega',
    c22a.entrega === TECLEO29 && c22a.atb === true && c22b.npo === true && c22b.pend === 'PEND BASE 29\nPEND DEL COLEGA',
    JSON.stringify({ c22a, c22b }));

  // C13c (d2 de la revisión): 📜 Restaurar versión con labHistory aún marcado y una versión cuyo diagrama es otro: el push
  // debe llevar también el diagrama restaurado (como la Guardia en C13); si no, la siguiente carga (gana la base) lo quita.
  await vista('su-g21');
  calls.length = 0;
  const c13c0 = await page.evaluate(async (d) => {
    const k = 'su-g21';
    const nd = getNote(k); nd.labHistory = [{ fecha: todayStr(), labs: { [getLabKeys()[0]]: '11.1' }, extra: [] }];
    if (!_dirtyFields[k]) _dirtyFields[k] = new Set(); _dirtyFields[k].add('labHistory'); noteData[k] = nd; saveNote(k, nd);   // como la importación de un PDF
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
    const v = migrateNote(JSON.parse(JSON.stringify(noteData[k]))); v.body_diagram_post = d; v.checklist.__pl_note_meta = Object.assign({}, v.checklist.__pl_note_meta, { body_diagram_post: d });
    localStorage.setItem('pl_snap_' + k, JSON.stringify([{ ts: Date.now() - 600000, data: v }]));
    restoreNoteSnapshot(k, 0);
    await new Promise(r => setTimeout(r, 300));
    for (let i = 0; i < 60 && (_pendingPush.has(k) || pendingSyncs > 0); i++) await new Promise(r => setTimeout(r, 100));
    return { marcas: Array.from(_dirtyFields[k] || []) };
  }, D21_REST);
  const post13c = postsDe('g21').pop(), meta21 = Object.assign({}, store.notes.g21.checklist.__pl_note_meta);
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); renderViewSoft(); });
  await page.waitForTimeout(300);
  const c13c = await diag('su-g21');
  check('C13c 📜 Restaurar versión con labHistory aún marcado y otro diagrama: el push lleva el diagrama restaurado (y lab_history), la marca vuelve a como estaba y la siguiente carga lo deja en modelo, pantalla y copia local (la Guardia de la base intacta)',
    !!post13c && metaDe(post13c).body_diagram_post === D21_REST && post13c.body.lab_history !== undefined && c13c0.marcas.join() === 'labHistory'
    && meta21.body_diagram_post === D21_REST && meta21.entrega === B21 && [c13c.post, c13c.shown, c13c.ls].every(v => v === D21_REST),
    JSON.stringify({ c13c0, post13c: post13c && Object.keys(post13c.body), meta: metaDe(post13c), meta21, c13c }));
  check('final C1–C25: sin errores no capturados', errors.length === 0, errors.join(' | '));
  await ctxG.close();

  // ═══ C7: aviso de versión nueva ═══════════════════════════════════════════════════════════════════════════
  const BUILD = PL_BUILD, OTRA = 'otra-version-de-prueba';
  let repoVer = null; try { repoVer = JSON.parse(fs.readFileSync(path.join(REPO, 'version.json'), 'utf8')); } catch (_) {}
  const vstore = { patients: [{ id: 'v1', cama: '3-170', exp: '26-90170', nombre: 'PRUEBA FICTICIA VERSION', esp: 'CG', estado: 'ESTABLE' }], notes: { v1: noteRow('v1', { npo: false }, { pendientes: 'PEND BASE' }) } };
  const vctl = { failPost: new Set() }, vcalls = [];
  let verMode = 'fail', verDelay = 0;
  const verReqs = [], verReqsMarca = [];
  const ctxV = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  await guardSupa(ctxV);
  await ctxV.route('**/vendor/supabase*', r => r.abort());
  await mockSupabase(ctxV, vstore, vctl, vcalls);
  await ctxV.route('**/version.json*', async (route) => {
    verReqs.push({ url: route.request().url(), t: Date.now(), mode: verMode });
    if (verDelay) await new Promise(r => setTimeout(r, verDelay));   // C7q4: tiempo para tocar algo mientras revisa
    if (verMode === 'fail') return route.abort('internetdisconnected');
    if (verMode === '404') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'no' });
    if (verMode === 'raro') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>portal cautivo</title>' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: verMode === 'same' ? BUILD : OTRA }) });
  });
  // C7p: la recarga de «Actualizar» se queda colgada (la navegación nunca responde) mientras hangNav esté encendido.
  let hangNav = false; const hungNav = [];
  await ctxV.route(/\/index\.html(\?.*)?$/, (route) => { if (hangNav && route.request().isNavigationRequest()) { hungNav.push(route); return; } return route.continue(); });
  await ctxV.addInitScript(mockScript({ verTest: true, wrapFetch: true, wrapTimers: true, swStub: true, swLog: true }));
  const swEventos = (pg, desde) => pg.evaluate((d) => { try { return JSON.parse(sessionStorage.getItem('__swev') || '[]').filter(x => x.t >= d); } catch (_) { return []; } }, desde);
  const dialogs = [];
  const pv = await ctxV.newPage(); watch(pv, 'V');
  pv.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const navs = []; pv.on('framenavigated', f => { if (f === pv.mainFrame()) navs.push(Date.now()); });
  // Sin el gancho de pruebas (navigator.webdriver, 127.0.0.1): nunca se pide version.json sola. La ruta deja pasar la
  // petición al servidor (el version.json REAL del repo, como en GitHub Pages) para C7b2.
  const ctxM = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  await guardSupa(ctxM);
  await ctxM.route('**/vendor/supabase*', r => r.abort());
  await mockSupabase(ctxM, { patients: vstore.patients, notes: { v1: noteRow('v1', {}) } }, { failPost: new Set() }, []);
  await ctxM.route('**/version.json*', (route) => { verReqsMarca.push({ url: route.request().url(), t: Date.now() }); return route.continue(); });
  await ctxM.addInitScript(mockScript({ quietAlert: true }));
  const pm = await ctxM.newPage(); watch(pm, 'M');
  const t0 = Date.now();
  await Promise.all([pv.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 }), pm.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 })]);
  const barState = (pg) => pg.evaluate(() => {
    const b = document.getElementById('pl-ver-bar');
    const vis = !!b && getComputedStyle(b).display !== 'none';
    const r = b ? b.getBoundingClientRect() : null; const h = document.getElementById('header'); const hr = h ? h.getBoundingClientRect() : null;
    return { vis, txt: b ? b.textContent.replace(/\s+/g, ' ').trim() : '', pos: b ? getComputedStyle(b).position : '', top: r && r.top, bottom: r && r.bottom, left: r && r.left, headerBottom: hr && hr.bottom, vh: innerHeight };
  });
  // Arranque: a los 15 s revisa. Con la red fallando no sale nada.
  for (let i = 0; i < 70 && !verReqs.length; i++) await pv.waitForTimeout(500);
  await pv.waitForTimeout(500);
  const c7a = await barState(pv);
  const c7aReq = verReqs.filter(r => r.mode === 'fail');
  const c7aFetch = await pv.evaluate(() => window.__verFetch || []);   // cómo lo pidió la app (fetch envuelto en mockScript)
  const c7aConst = await pv.evaluate(() => ({ build: PL_BUILD, primera: PL_VER_PRIMERA_MS, cada: PL_VER_CADA_MS, min: PL_VER_MIN_MS, subir: PL_VER_SUBIR_MS, rel: location.pathname }));
  check('C7a al arrancar (a los 15 s, no antes) pide ./version.json?ts=<hora> con cache «no-store» junto a index.html; con la red fallando NO aparece la barra',
    !!BUILD && c7aConst.build === BUILD && c7aConst.primera === 15000 && c7aConst.min === 60000 && c7aConst.subir === 8000
    && c7aReq.length === 1 && new URL(c7aReq[0].url).pathname === c7aConst.rel.replace(/index\.html$/, '') + 'version.json' && /version\.json\?ts=\d{13}$/.test(c7aReq[0].url)
    && c7aReq[0].t - t0 >= 14500 && c7aReq[0].t - t0 < 30000 && !c7a.vis
    && c7aFetch.length === 1 && c7aFetch[0].cache === 'no-store' && /^\.\/version\.json\?ts=\d{13}$/.test(c7aFetch[0].u),
    JSON.stringify({ c7a, reqs: verReqs.map(r => r.url.replace(/^.*\//, '')), dt: c7aReq[0] && c7aReq[0].t - t0, c7aFetch, c7aConst }));
  await pm.waitForTimeout(1000);
  const c7m = await pm.evaluate(async () => ({ webdriver: navigator.webdriver, test: typeof window.__PL_BUILD_TEST__, activa: _plVerActiva(), r: await _plVersionRevisar(), bar: !!document.getElementById('pl-ver-bar') }));
  check('C7b sin el gancho de pruebas (navegador automatizado en 127.0.0.1) no se revisa nada: ni a los 15 s ni a mano, sin barra',
    (Date.now() - t0) > 16000 && verReqsMarca.length === 0 && c7m.test === 'undefined' && c7m.activa === false && c7m.r === null && !c7m.bar, JSON.stringify({ c7m, reqs: verReqsMarca.length, dt: Date.now() - t0 }));
  // version.json real del repo servido tal cual (así lo sirve GitHub Pages desde la raíz de main): misma versión → sin barra.
  const c7b2 = await pm.evaluate(async () => { window.__PL_BUILD_TEST__ = true; const r = await _plVersionRevisar(); const b = document.getElementById('pl-ver-bar'); return { r, bar: !!b && getComputedStyle(b).display !== 'none' }; });
  check('C7b2 con el version.json REAL del repo (servido desde la raíz, como GitHub Pages) la versión es la misma que PL_BUILD → sin barra',
    !!repoVer && repoVer.v === BUILD && c7b2.r === BUILD && !c7b2.bar && verReqsMarca.length === 1, JSON.stringify({ c7b2, repoVer, reqs: verReqsMarca.length }));
  await ctxM.close();

  verMode = '404';
  const c7c1 = await pv.evaluate(async () => ({ r: await _plVersionRevisar() }));
  const c7c1b = await barState(pv);
  verMode = 'raro';
  const c7c4 = await pv.evaluate(async () => ({ r: await _plVersionRevisar() }));
  const c7c4b = await barState(pv);
  await ctxV.setOffline(true);
  const nOff = verReqs.length;
  const c7c2 = await pv.evaluate(async () => { const n = (window.__verFetch || []).length; const r = await _plVersionRevisar(); return { online: navigator.onLine, r, fetches: (window.__verFetch || []).length - n }; });
  const c7c2b = await barState(pv); const nOff2 = verReqs.length;
  await ctxV.setOffline(false);
  verMode = 'same';
  const c7c3 = await pv.evaluate(async () => ({ r: await _plVersionRevisar() }));
  const c7c3b = await barState(pv);
  check('C7c version.json con 404 → nada; respuesta que no es JSON (portal cautivo) → nada; sin red → ni siquiera lo pide; misma versión → sin barra',
    c7c1.r === null && !c7c1b.vis && c7c4.r === null && !c7c4b.vis && c7c2.online === false && c7c2.r === null && c7c2.fetches === 0 && nOff2 === nOff && !c7c2b.vis && c7c3.r === BUILD && !c7c3b.vis,
    JSON.stringify({ c7c1, c7c4, c7c2, c7c3, vis: [c7c1b.vis, c7c4b.vis, c7c2b.vis, c7c3b.vis] }));

  // Volver a primer plano: mínimo 60 s entre revisiones.
  verMode = 'diff';
  const n0 = verReqs.length;
  await pv.evaluate(() => { _plVerUltima = Date.now() - 30000; document.dispatchEvent(new Event('visibilitychange')); });
  await pv.waitForTimeout(600);
  const nRecent = verReqs.length - n0;
  await pv.evaluate(() => { _plVerUltima = Date.now() - 61000; document.dispatchEvent(new Event('visibilitychange')); });
  await pv.waitForFunction(() => { const b = document.getElementById('pl-ver-bar'); return b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 5000 }).catch(() => {});
  const c7d = await barState(pv);
  check('C7d al volver a primer plano: si la última revisión fue hace < 60 s no pide nada; pasado 1 min revisa y, con otra versión publicada, sale la barra pequeña abajo (fija, sin tapar la cabecera ni la tira de camas)',
    nRecent === 0 && verReqs.length - n0 === 1 && c7d.vis && /Hay una versión nueva de la app/.test(c7d.txt) && /Actualizar/.test(c7d.txt) && c7d.pos === 'fixed'
    && c7d.top >= c7d.headerBottom && c7d.bottom <= c7d.vh && c7d.left < 40 && (c7d.bottom - c7d.top) < 60, JSON.stringify({ nRecent, c7d }));

  // pageshow (regreso desde la caché de páginas) y pestaña oculta; cada 3 min con la pestaña visible (el intervalo que
  // registró la app, llamado a mano: no se esperan 3 min reales).
  const c7n = await pv.evaluate(async () => {
    const reqs = () => (window.__verFetch || []).length;
    const espera = () => new Promise(r => setTimeout(r, 400));
    const out = {};
    let n = reqs();
    _plVerUltima = Date.now() - 61000; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); await espera(); out.pageshowNormal = reqs() - n;
    n = reqs(); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); await espera(); out.pageshowCache = reqs() - n;
    const iv = (window.__plIntervals || []).filter(x => x.ms === 3 * 60000);
    out.intervalos = iv.length;
    n = reqs(); _plVerUltima = Date.now() - 61000;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    iv.forEach(x => x.fn()); document.dispatchEvent(new Event('visibilitychange')); await espera(); out.oculta = reqs() - n;
    delete document.visibilityState;
    n = reqs(); iv.forEach(x => x.fn()); await espera(); out.visible = reqs() - n;
    n = reqs(); iv.forEach(x => x.fn()); await espera(); out.seguido = reqs() - n;   // 60 s mínimo también para el intervalo
    return out;
  });
  check('C7n pageshow desde la caché de páginas revisa (el pageshow normal del arranque no); el intervalo de 3 min revisa solo con la pestaña visible y respetando el mínimo de 60 s; con la pestaña oculta nada',
    c7n.pageshowNormal === 0 && c7n.pageshowCache === 1 && c7n.intervalos === 1 && c7n.oculta === 0 && c7n.visible === 1 && c7n.seguido === 0, JSON.stringify(c7n));

  // Escribir esconde la barra (teclado del iPad); ✕ la oculta hasta la siguiente revisión.
  const c7e = await pv.evaluate(async () => {
    const vis = () => { const b = document.getElementById('pl-ver-bar'); return !!b && getComputedStyle(b).display !== 'none'; };
    const before = vis();
    const ta = document.querySelector('textarea[data-key][data-field="pendientes"]');
    ta.focus(); const typing = vis();
    ta.blur(); await new Promise(r => setTimeout(r, 150)); const after = vis();
    document.querySelector('[data-testid="ver-ocultar"]').click(); const hidden = vis();
    await _plVersionRevisar(); const again = vis();
    return { before, typing, after, hidden, again };
  });
  check('C7e mientras se escribe en una caja la barra se esconde y vuelve al soltarla; ✕ la oculta y la siguiente revisión la vuelve a mostrar',
    c7e.before === true && c7e.typing === false && c7e.after === true && c7e.hidden === false && c7e.again === true, JSON.stringify(c7e));

  // iPad vertical: la barra queda DEBAJO de las ventanas de la app. Con el Pase de visita abierto, lo que hay debajo de la
  // barra (la esquina de «◀ Anterior» de #rondas-nav) se sigue tocando.
  await pv.setViewportSize({ width: 820, height: 1180 });
  await pv.waitForTimeout(300);
  const hit = () => pv.evaluate(() => {
    const bar = document.getElementById('pl-ver-bar');
    const br = bar.getBoundingClientRect(), bvis = getComputedStyle(bar).display !== 'none';
    const top = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    return { bvis, br: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)], barOnTop: !!top && bar.contains(top) };
  });
  const c7i = await pv.evaluate(async () => {
    _plVerPintar();
    startRondas();
    await new Promise(r => setTimeout(r, 500));
    const bar = document.getElementById('pl-ver-bar'), prev = document.getElementById('rondas-prev');
    const br = bar.getBoundingClientRect(), pr = prev.getBoundingClientRect();
    const x1 = Math.max(br.left, pr.left), x2 = Math.min(br.right, pr.right), y1 = Math.max(br.top, pr.top), y2 = Math.min(br.bottom, pr.bottom);
    const overlap = x2 > x1 && y2 > y1;
    const el = overlap ? document.elementFromPoint((x1 + x2) / 2, (y1 + y2) / 2) : null;
    return { open: document.getElementById('rondas-overlay').classList.contains('open'), bvis: getComputedStyle(bar).display !== 'none', overlap, hitPrev: !!el && (el === prev || prev.contains(el)), onBar: !!el && bar.contains(el) };
  });
  const c7iBar = await hit();
  await pv.evaluate(() => exitRondas());
  check('C7i iPad vertical (820×1180) con el Pase de visita abierto: la barra (visible) queda debajo; donde se encima con «◀ Anterior» el toque llega al botón',
    c7i.open && c7i.bvis && c7i.overlap && c7i.hitPrev && !c7i.onBar && !c7iBar.barOnTop, JSON.stringify({ c7i, c7iBar }));

  // ✏️ Editar abierto con algo escrito: la barra no se puede tocar y, si «Actualizar» llega de todos modos (teclado:
  // Tab + Enter), no recarga, avisa y lo escrito en la ventana sigue ahí.
  const dlgJ = dialogs.length, navsJ = navs.length;
  const DXJ = 'DX NUEVO ESCRITO EN EL MODAL';
  const c7j = await pv.evaluate(async (dxNew) => {
    const k = pid(patients[0]);
    const dxAntes = patients[0].dx || '';
    openEditModal(k);
    const dx = document.getElementById('mf-dx'); dx.focus(); dx.value = dxNew; dx.dispatchEvent(new Event('input', { bubbles: true })); dx.blur();
    await new Promise(r => setTimeout(r, 150));
    _plVerPintar();
    const bar = document.getElementById('pl-ver-bar'), btn = bar.querySelector('[data-testid="ver-actualizar"]');
    const r = btn.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const bvis = getComputedStyle(bar).display !== 'none';
    await plVersionActualizar();
    return { bvis, tappable: !!el && (el === btn || btn.contains(el)), actualizando: _plVerActualizando, dx: document.getElementById('mf-dx').value, modal: document.getElementById('patient-modal').style.display, dxAntes, dxPaciente: patients[0].dx || '' };
  }, DXJ);
  await pv.waitForTimeout(1500);
  const c7jDlg = dialogs.slice(dlgJ);
  await pv.evaluate(() => { try { closeModal(); } catch (_) {} });
  await pv.setViewportSize({ width: 1194, height: 834 });
  await pv.waitForTimeout(300);
  check('C7j con ✏️ Editar abierto y algo escrito: la barra queda debajo (no se puede tocar) y «Actualizar» no recarga: avisa que se guarde o cierre la ventana y lo escrito sigue en el modal',
    c7j.bvis && !c7j.tappable && c7j.actualizando === false && c7jDlg.length === 1 && /Guarda o cierra la ventana/.test(c7jDlg[0]) && navs.length === navsJ
    && c7j.dx === DXJ && c7j.modal !== 'none' && c7j.dxPaciente === c7j.dxAntes, JSON.stringify({ c7j, c7jDlg, navs: navs.length - navsJ }));

  // «Actualizar» con un ítem en la cola: lo sube ANTES de recargar; nunca recarga sola.
  const navsBefore = navs.length;
  await pv.waitForTimeout(1500);
  check('C7f la barra nunca recarga sola (sin tocar «Actualizar» no hubo navegación)', navs.length === navsBefore, JSON.stringify({ navs: navs.length, navsBefore }));
  await pv.evaluate(() => { const k = pid(patients[0]); outboxEnqueue({ type: 'note', key: k, data: Object.assign(migrateNote(JSON.parse(JSON.stringify(noteData[k]))), { pendientes: 'PENDIENTE ANTES DE ACTUALIZAR' }), dirty: ['pendientes'] }); });
  vcalls.length = 0;
  const dlgG = dialogs.length;
  const tClick = Date.now();
  await Promise.all([pv.waitForEvent('load', { timeout: 30000 }), pv.click('[data-testid="ver-actualizar"]')]);
  const navAt = navs.filter(t => t >= tClick)[0];
  const postV = vcalls.filter(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.pendientes === 'PENDIENTE ANTES DE ACTUALIZAR');
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const c7g = await pv.evaluate(() => ({ q: outboxLoad().length }));
  // Service worker (getRegistration de mentira, swStub): registration.update() y, con un SW nuevo en espera, SKIP_WAITING y
  // la espera a que tome el control (controllerchange), todo ANTES de que la página se vaya (pagehide de la recarga).
  const evG = await swEventos(pv, tClick), iEv = (e) => evG.findIndex(x => x.e === e);
  const ordenSW = iEv('update') >= 0 && iEv('msg:SKIP_WAITING') > iEv('update') && iEv('cc') > iEv('msg:SKIP_WAITING') && iEv('hide') > iEv('cc');
  check('C7g «Actualizar» con un ítem en la cola: lo sube ANTES de recargar (POST antes de la navegación), sin aviso; luego registration.update() del service worker, SKIP_WAITING al SW en espera y espera a que tome el control antes de irse; la app recarga con la cola vacía',
    postV.length >= 1 && !!navAt && postV[0].t < navAt && dialogs.length === dlgG && c7g.q === 0 && vstore.notes.v1.pendientes === 'PENDIENTE ANTES DE ACTUALIZAR'
    && ordenSW && evG[iEv('update')].t > postV[0].t,
    JSON.stringify({ posts: postV.length, postT: postV[0] && postV[0].t - tClick, navT: navAt && navAt - tClick, dialogs, c7g, sw: evG.map(x => x.e + '@' + (x.t - tClick)) }));

  // «Actualizar» con lo escrito en una caja que aún no se guarda (autoguardado en espera, sin soltar la caja):
  // persistBeforeExit lo pasa a la cola y sube ANTES de recargar (no después, al abrir).
  await pv.waitForTimeout(800);
  const PEND_G2 = 'ESCRITO SIN SOLTAR LA CAJA';
  const dlgG2 = dialogs.length;
  const c7g2a = await pv.evaluate(async (txt) => {
    await _plVersionRevisar();
    const k = pid(patients[0]);
    const ta = document.querySelector('textarea[data-key][data-field="pendientes"]');
    ta.value = txt; liveUpdate(ta);                          // como al teclear: campo sucio y autoguardado programado
    return { dirty: _dirtyUnion(k).has('pendientes'), push: _pendingPush.has(k), q: outboxLoad().length, bar: getComputedStyle(document.getElementById('pl-ver-bar')).display };
  }, PEND_G2);
  vcalls.length = 0;
  const tClickG2 = Date.now();
  await Promise.all([pv.waitForEvent('load', { timeout: 30000 }), pv.click('[data-testid="ver-actualizar"]')]);
  const navAtG2 = navs.filter(t => t >= tClickG2)[0];
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  await pv.waitForTimeout(1500);
  const postG2 = vcalls.filter(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.pendientes === PEND_G2);
  check('C7g2 «Actualizar» con lo escrito en una caja sin guardar todavía (sin soltarla): sube ANTES de recargar, sin aviso',
    c7g2a.dirty && !c7g2a.push && c7g2a.q === 0 && c7g2a.bar === 'flex' && postG2.length >= 1 && !!navAtG2 && postG2[0].t < navAtG2 && dialogs.length === dlgG2 && vstore.notes.v1.pendientes === PEND_G2,
    JSON.stringify({ c7g2a, posts: postG2.map(p => p.t - tClickG2), navT: navAtG2 && navAtG2 - tClickG2, dialogs: dialogs.slice(dlgG2) }));

  // «Actualizar» sin poder subir (la base responde 500): avisa que se quedó en el equipo, recarga y el ítem sigue en la cola.
  vctl.failPost.add('v1');
  const dlgH = dialogs.length;
  await pv.evaluate(async () => { const k = pid(patients[0]); outboxEnqueue({ type: 'note', key: k, data: Object.assign(migrateNote(JSON.parse(JSON.stringify(noteData[k]))), { pendientes: 'NO ALCANZÓ A SUBIR' }), dirty: ['pendientes'] }); await _plVersionRevisar(); });
  const tClick2 = Date.now();
  await Promise.all([pv.waitForEvent('load', { timeout: 40000 }), pv.click('[data-testid="ver-actualizar"]')]);
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const c7h = await pv.evaluate(() => { const q = outboxLoad().filter(i => i.type === 'note'); return { q: q.length, pend: q[0] && q[0].data && q[0].data.pendientes }; });
  check('C7h «Actualizar» sin poder subir (la base responde 500): avisa que se quedó guardado en el equipo y se subirá al abrir, recarga y el ítem sigue en la cola',
    dialogs.length === dlgH + 1 && /se quedó guardado en este equipo/.test(dialogs[dlgH]) && c7h.q === 1 && c7h.pend === 'NO ALCANZÓ A SUBIR' && (Date.now() - tClick2) < 20000,
    JSON.stringify({ dialogs: dialogs.slice(dlgH), c7h, dt: Date.now() - tClick2 }));
  vctl.failPost.clear();
  await pv.waitForTimeout(1500);

  // C7h2 wifi colgado: la subida de notas NUNCA responde (ni 500 ni error). «Actualizar» no espera más del tope (~8 s):
  // avisa que se quedó en el equipo, recarga y el ítem sigue en la cola. Sin el tope se quedaba minutos en «⏳ Subiendo…».
  await pv.evaluate(() => { outboxSave([]); updateOutboxBadge(); });
  vctl.hangPost = true; vctl.hung = [];
  const dlgH2 = dialogs.length;
  await pv.evaluate(async () => { const k = pid(patients[0]); outboxEnqueue({ type: 'note', key: k, data: Object.assign(migrateNote(JSON.parse(JSON.stringify(noteData[k]))), { pendientes: 'COLGADO SIN RESPUESTA' }), dirty: ['pendientes'] }); await _plVersionRevisar(); });
  const tH2 = Date.now();
  const cargoH2 = await Promise.all([pv.waitForEvent('load', { timeout: 20000 }).then(() => true).catch(() => false), pv.click('[data-testid="ver-actualizar"]', { timeout: 20000 }).catch(() => {})]).then(r => r[0]);
  const dtH2 = Date.now() - tH2;
  const colgados = vctl.hung.length;
  const soltar = () => { vctl.hangPost = false; vctl.hung.splice(0).forEach(r => r.abort('timedout').catch(() => {})); };
  if (!cargoH2) { soltar(); await pv.waitForEvent('load', { timeout: 90000 }).catch(() => {}); }   // no recargó: se suelta la red para seguir
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const c7h2 = await pv.evaluate(() => { const q = outboxLoad().filter(i => i.type === 'note'); return { q: q.length, pend: q[0] && q[0].data && q[0].data.pendientes }; });
  soltar();
  check('C7h2 «Actualizar» con la subida colgada (la base nunca responde): a los ~8 s (tope) deja de esperar, avisa que se quedó guardado en el equipo, recarga y el ítem sigue en la cola',
    cargoH2 && colgados >= 1 && dtH2 >= 7500 && dtH2 < 13000 && dialogs.length === dlgH2 + 1 && /se quedó guardado en este equipo/.test(dialogs[dlgH2]) && c7h2.q === 1 && c7h2.pend === 'COLGADO SIN RESPUESTA',
    JSON.stringify({ cargoH2, colgados, dtH2, dialogs: dialogs.slice(dlgH2), c7h2 }));
  await pv.waitForFunction(() => outboxLoad().length === 0 && pendingSyncs === 0, null, { timeout: 30000 }).catch(() => {});

  // C7o sin red: «Actualizar» no hace nada más que avisar (sin red no se puede subir lo pendiente ni bajar la versión).
  await pv.evaluate(() => _plVersionRevisar());
  await ctxV.setOffline(true);
  const dlgO = dialogs.length, navsO = navs.length, tO = Date.now();
  await pv.click('[data-testid="ver-actualizar"]');
  await pv.waitForTimeout(1500);
  const c7o = await pv.evaluate(() => typeof _plVerActualizando === 'undefined' ? { app: false, online: navigator.onLine } : ({ app: true, act: _plVerActualizando, online: navigator.onLine, bar: getComputedStyle(document.getElementById('pl-ver-bar')).display })).catch(e => ({ app: false, err: String(e).slice(0, 80) }));
  const evO = c7o.app ? await swEventos(pv, tO) : ['sin app'];
  await ctxV.setOffline(false);
  if (!c7o.app) { await pv.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 }); await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 }); }
  check('C7o sin red «Actualizar» no recarga ni toca el service worker: avisa «Sin conexión…» y la barra sigue ahí',
    c7o.app && c7o.online === false && dialogs.length === dlgO + 1 && /Sin conexión/.test(dialogs[dlgO]) && navs.length === navsO && c7o.act === false && c7o.bar === 'flex' && evO.length === 0,
    JSON.stringify({ c7o, dialogs: dialogs.slice(dlgO), navs: navs.length - navsO, evO }));

  // C7p la recarga no llega (la navegación se cae o nunca responde, como en el iPad cuando WebKit cerraba el SW viejo):
  // a los ~15 s la barra vuelve a su texto y «Actualizar» se puede tocar otra vez (antes, «⏳ Subiendo lo pendiente…» para
  // siempre y los toques no hacían nada).
  // Con la navegación pendiente Playwright no evalúa en la página vieja (espera a la nueva): la página reporta su barra
  // por consola cada 300 ms y eso se lee aquí.
  await pv.waitForTimeout(1200);
  const verLog = [];
  pv.on('console', (m) => { const s = m.text(); if (s.indexOf('__PLVER ') === 0) { try { verLog.push(Object.assign({ t: Date.now() }, JSON.parse(s.slice(8)))); } catch (_) {} } });
  await pv.evaluate(async () => {
    await _plVersionRevisar();
    setInterval(() => { const b = document.getElementById('pl-ver-bar'), t = b && b.querySelector('.pl-ver-txt'); console.log('__PLVER ' + JSON.stringify({ act: _plVerActualizando, txt: t ? t.textContent : '', vis: !!b && getComputedStyle(b).display !== 'none' })); }, 300);
  });
  hangNav = true;
  const tP = Date.now();
  // Toque desde la página: pv.click esperaría a que la navegación que dispara se complete (y aquí nunca llega).
  await pv.evaluate(() => { setTimeout(() => document.querySelector('[data-testid="ver-actualizar"]').click(), 0); });
  for (let i = 0; i < 60 && !hungNav.length; i++) await pv.waitForTimeout(100);
  const tHung = Date.now();
  for (let i = 0; i < 250 && !verLog.some(x => x.t > tHung && x.act === false); i++) await new Promise(r => setTimeout(r, 100));
  const c7pA = verLog.filter(x => x.t > tHung)[0] || null;
  const c7pB = verLog.find(x => x.t > tHung && x.act === false) || null;
  const dtP = c7pB ? c7pB.t - tP : -1;
  const colgadasP = hungNav.length;
  hangNav = false; hungNav.splice(0).forEach(r => r.continue().catch(() => {}));
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1 && typeof _plVerActualizando !== 'undefined' && _plVerActualizando === false, null, { timeout: 30000 }).catch(() => {});
  check('C7p la recarga de «Actualizar» no llega: mientras tanto «⏳ Subiendo lo pendiente…»; a los ~15 s la barra vuelve a «🔄 Hay una versión nueva de la app ·» y «Actualizar» se puede volver a tocar',
    colgadasP >= 1 && !!c7pA && c7pA.act === true && /Subiendo lo pendiente/.test(c7pA.txt) && !!c7pB && c7pB.txt === '🔄 Hay una versión nueva de la app ·' && c7pB.vis && dtP >= 14000 && dtP < 22000,
    JSON.stringify({ colgadasP, c7pA, c7pB, dtP }));

  // C7q (29 oct 2026): al volver a la app después de 30 min o más oculta, con versión nueva y si es seguro, se actualiza
  // sola. Nunca: ausencia corta, algo en la cola, una ventana abierta o si se tocó algo al volver.
  await pv.waitForTimeout(1500);
  const volver = (min, escribir) => pv.evaluate(([m, txt]) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    // escribir: algo queda escrito (campo sucio, sin cola ni subida en curso) DESPUÉS de que la app guardó al ocultarse.
    if (txt) { const ta = document.querySelector('textarea[data-key][data-field="pendientes"]'); ta.value = txt; liveUpdate(ta); }
    _plVerOcultaDesde = Date.now() - m * 60000; _plVerUltima = Date.now() - 61000;
    document.dispatchEvent(new Event('visibilitychange'));
  }, [min, escribir || '']);
  const estadoQ = () => pv.evaluate(() => { const r = { q: outboxLoad().length, act: _plVerActualizando, auto: window.__vioAuto, bar: (document.getElementById('pl-ver-bar') || {}).style ? getComputedStyle(document.getElementById('pl-ver-bar')).display : 'sin barra' }; window.__vioAuto = false; return r; });
  // ¿Llegó a intentar la actualización sola? (su texto en la barra); estadoQ lo lee y lo reinicia en cada paso.
  await pv.evaluate(() => {
    window.__vioAuto = false;
    setInterval(() => { const t = document.querySelector('#pl-ver-bar .pl-ver-txt'); if (t && /Actualizando a la versión nueva/.test(t.textContent)) window.__vioAuto = true; }, 40);
  });
  const dlgQ = dialogs.length;
  // 1) 10 min oculta: solo revisa (sale la barra) y no recarga.
  let navsQ = navs.length;
  await volver(10); await pv.waitForTimeout(2000);
  const q1 = Object.assign(await estadoQ(), { navs: navs.length - navsQ });
  // 2) 40 min oculta con algo que no se ha podido subir: no recarga ni avisa; la barra sigue y lo pendiente también.
  vctl.failPost.add('v1');
  await pv.evaluate(() => { const k = pid(patients[0]); outboxEnqueue({ type: 'note', key: k, data: Object.assign(migrateNote(JSON.parse(JSON.stringify(noteData[k]))), { pendientes: 'PENDIENTE AL VOLVER' }), dirty: ['pendientes'] }); });
  await pv.waitForTimeout(800);
  navsQ = navs.length;
  await volver(40); await pv.waitForTimeout(2500);
  const q2 = Object.assign(await estadoQ(), { navs: navs.length - navsQ });
  // 2b) La revisión previa pasa (nada en la cola) pero al subir lo escrito la base falla: tampoco recarga ni avisa.
  await pv.evaluate(() => { outboxSave([]); updateOutboxBadge(); window.__vioAuto = false; });
  navsQ = navs.length;
  await volver(40, 'ESCRITO ANTES DE VOLVER');
  await pv.waitForTimeout(800);
  await pv.waitForFunction(() => !_plVerActualizando, null, { timeout: 15000 }).catch(() => {});
  await pv.waitForTimeout(500);
  const q2b = Object.assign(await estadoQ().catch(() => ({ auto: 'recargó' })), { navs: navs.length - navsQ });
  vctl.failPost.clear();
  await pv.evaluate(() => flushOutbox().catch(() => {}));
  await pv.waitForFunction(() => outboxLoad().length === 0 && pendingSyncs === 0 && _pendingPush.size === 0, null, { timeout: 30000 }).catch(() => {});
  // 3) 40 min oculta con ✏️ Editar abierto: no recarga.
  await pv.evaluate(() => openEditModal(pid(patients[0])));
  navsQ = navs.length;
  await volver(40); await pv.waitForTimeout(2000);
  const q3 = Object.assign(await estadoQ(), { navs: navs.length - navsQ, modal: await pv.evaluate(() => document.getElementById('patient-modal').style.display) });
  await pv.evaluate(() => { try { closeModal(); } catch (_) {} });
  await pv.waitForTimeout(300);
  // 4) 40 min oculta pero tocó la pantalla mientras se revisaba la versión: no recarga.
  verDelay = 900;
  navsQ = navs.length;
  await volver(40);
  await pv.waitForTimeout(150);
  await pv.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await pv.waitForTimeout(2500);
  const q4 = Object.assign(await estadoQ(), { navs: navs.length - navsQ });
  verDelay = 0;
  // 5) 40 min oculta, sin nada pendiente, sin ventanas y sin tocar: se actualiza sola (SW y recarga), sin avisos.
  navsQ = navs.length;
  const tQ5 = Date.now();
  const cargoQ5 = await Promise.all([pv.waitForEvent('load', { timeout: 30000 }).then(() => true).catch(() => false), volver(40)]).then(r => r[0]);
  await pv.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const evQ5 = await swEventos(pv, tQ5);
  check('C7q al volver: 10 min oculta → solo la barra; 40 min con algo sin subir, con una ventana abierta o tocando al volver → no recarga; 40 min y todo en orden → se actualiza sola (SW nuevo y recarga) sin ningún aviso',
    q1.navs === 0 && q1.bar === 'flex' && q1.auto === false && q2.navs === 0 && q2.auto === false && q2.q >= 1 && q2.bar === 'flex' && q2.act === false
    && q2b.navs === 0 && q2b.auto === true && q2b.q >= 1 && q2b.act === false && q2b.bar === 'flex'
    && q3.navs === 0 && q3.auto === false && q3.modal !== 'none' && q4.navs === 0 && q4.auto === false
    && cargoQ5 && navs.length > navsQ && evQ5.some(x => x.e === 'update') && dialogs.length === dlgQ,
    JSON.stringify({ q1, q2, q2b, q3, q4, cargoQ5, navs: navs.length - navsQ, sw: evQ5.map(x => x.e), dialogs: dialogs.slice(dlgQ) }));
  check('final C7: sin errores no capturados', errors.length === 0, errors.join(' | '));
  await ctxV.close();

  // C7k: con 1340 px o más (Mac, laptop, iPad Pro 12.9" acostado) las camas van en el riel de la izquierda (#board-side,
  // pegajoso hasta abajo). Con muchos pacientes y el riel hasta el fondo, la barra no tapa ninguna de las últimas camas.
  // Nombres ficticios distintos entre sí (con el mismo nombre la app abre el aviso de duplicados arriba y el riel baja).
  const ficticio = (i) => ['ZAPATA', 'QUIROGA', 'LUNA', 'BRAVO', 'SOTO', 'VEGA', 'ROJAS', 'PAZ', 'CRUZ', 'MORA', 'DIAZ', 'RIOS'][i % 12] + ' ' + ['ALBA', 'NIEVES', 'OLMO', 'PINO'][Math.floor(i / 12) % 4] + ' FICTICIO ' + ['ANDRES', 'BEATRIZ', 'CARMEN', 'DANIEL', 'ELENA', 'FABIAN', 'GLORIA'][i % 7];
  const rstore = { patients: Array.from({ length: 40 }, (_, i) => ({ id: 'r' + i, cama: '3-' + (150 + i), exp: '26-9' + String(150 + i).padStart(4, '0'), nombre: ficticio(i), esp: 'CG', estado: 'ESTABLE' })), notes: {} };
  const ctxR = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await guardSupa(ctxR);
  await ctxR.route('**/vendor/supabase*', r => r.abort());
  await mockSupabase(ctxR, rstore, { failPost: new Set() }, []);
  await ctxR.route('**/version.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: OTRA }) }));
  await ctxR.addInitScript(mockScript({ verTest: true, quietAlert: true }));
  const prl = await ctxR.newPage(); watch(prl, 'R');
  await prl.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await prl.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 40 && document.querySelectorAll('#board-side .bs-btn').length === 40, null, { timeout: 30000 });
  const riel = async (w, h) => {
    await prl.setViewportSize({ width: w, height: h });
    await prl.waitForTimeout(300);
    return prl.evaluate(async () => {
      await _plVersionRevisar();
      const side = document.getElementById('board-side');
      window.scrollTo(0, side.getBoundingClientRect().top + scrollY); await new Promise(r => setTimeout(r, 150));   // riel ya pegado arriba
      side.scrollTop = side.scrollHeight; await new Promise(r => setTimeout(r, 200));
      const bar = document.getElementById('pl-ver-bar'), br = bar.getBoundingClientRect(), sr = side.getBoundingClientRect();
      const btns = Array.from(side.querySelectorAll('.bs-btn'));
      const tocar = (b) => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!el && (el === b || b.contains(el)); };
      return { w: innerWidth, side: getComputedStyle(side).display, enVista: sr.top >= 0 && sr.bottom <= innerHeight, scrolled: side.scrollTop > 0 && Math.abs(side.scrollTop - (side.scrollHeight - side.clientHeight)) <= 1,
        bvis: getComputedStyle(bar).display !== 'none', encima: !(br.right <= sr.left || br.left >= sr.right || br.bottom <= sr.top || br.top >= sr.bottom),
        ultima: tocar(btns[btns.length - 1]), penultima: tocar(btns[btns.length - 2]), bar: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)], sideR: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)] };
    });
  };
  const c7k1 = await riel(1440, 900), c7k2 = await riel(1366, 1024);
  check('C7k con 1340 px o más y el riel de camas hasta el fondo (1440×900 y 1366×1024, 40 pacientes): la barra visible no se encima con el riel y las dos últimas camas se pueden tocar',
    [c7k1, c7k2].every(r => r.side !== 'none' && r.enVista && r.scrolled && r.bvis && !r.encima && r.ultima && r.penultima), JSON.stringify({ c7k1, c7k2 }));
  await ctxR.close();

  // C7l: lo que publican Cloudflare (deploy-pages.yml) y el espejo de Netlify (netlify.toml): se corren SUS líneas sobre una
  // copia de los archivos (fuera del repo) y la copia publicada lleva version.json igual a PL_BUILD, sin tocar index.html.
  // GitHub Pages sirve la raíz tal cual: es lo que probó C7b2.
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pl-pub-'));
  const copiaRepo = () => {
    const d = tmp();
    ['index.html', '_headers', 'manifest.json', 'sw.js', 'version.json'].forEach(f => { if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), path.join(d, f)); });
    ['icons', 'vendor'].forEach(dir => fs.cpSync(path.join(REPO, dir), path.join(d, dir), { recursive: true }));
    return d;
  };
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-pages.yml'), 'utf8').split('\n');
  const w0 = wf.findIndex(l => l.includes('mkdir -p dist/icons dist/vendor')), w1 = wf.findIndex((l, i) => i > w0 && l.includes('ls -la dist'));
  const pasoCF = w0 >= 0 && w1 > w0 ? wf.slice(w0, w1 + 1).map(l => l.replace(/^ {10}/, '')).join('\n') : '';
  const nt = /command\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(REPO, 'netlify.toml'), 'utf8'));
  const pasoNL = nt ? nt[1] : '';
  const publicar = (paso) => {
    const d = copiaRepo();
    try {
      const r = spawnSync('bash', ['-e', '-c', paso], { cwd: d, encoding: 'utf8' });
      let ver = null; try { ver = JSON.parse(fs.readFileSync(path.join(d, 'dist', 'version.json'), 'utf8')); } catch (_) {}
      let html = ''; try { html = fs.readFileSync(path.join(d, 'dist', 'index.html'), 'utf8'); } catch (_) {}
      let sw = ''; try { sw = fs.readFileSync(path.join(d, 'dist', 'sw.js'), 'utf8'); } catch (_) {}
      return { rc: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().slice(-300), ver, html, sw };
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  const fuente = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const cf = publicar(pasoCF), nl = publicar(pasoNL);
  const pubOk = (p) => p.rc === 0 && !!p.ver && p.ver.v === BUILD && p.html === fuente && /const PL_BUILD = "/.test(p.html) && /pisolibro-v12/.test(p.sw);
  // La copia de Cloudflare abierta en el navegador (index.html y version.json de dist/): misma versión → sin barra.
  const ctxP = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  await guardSupa(ctxP);
  await ctxP.route('**/vendor/supabase*', r => r.abort());
  await ctxP.route(/\/index\.html(\?.*)?$/, r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: cf.html || '<!doctype html>' }));
  await mockSupabase(ctxP, { patients: vstore.patients, notes: { v1: noteRow('v1', {}) } }, { failPost: new Set() }, []);
  await ctxP.route('**/version.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cf.ver || {}) }));
  await ctxP.addInitScript(mockScript({ verTest: true, quietAlert: true }));
  const pp = await ctxP.newPage(); watch(pp, 'P');
  await pp.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await pp.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const c7l = await pp.evaluate(async () => ({ build: PL_BUILD, r: await _plVersionRevisar(), bar: !!document.getElementById('pl-ver-bar') && getComputedStyle(document.getElementById('pl-ver-bar')).display !== 'none' }));
  await ctxP.close();
  check('C7l lo que publican deploy-pages.yml (Cloudflare) y netlify.toml (Netlify): el paso termina bien, dist/ lleva version.json con "v" igual a PL_BUILD, index.html sin cambios y sw.js v12; abierta la copia de Cloudflare, misma versión → sin barra',
    !!pasoCF && !!pasoNL && pubOk(cf) && pubOk(nl) && c7l.build === BUILD && c7l.r === BUILD && !c7l.bar,
    JSON.stringify({ pasoCF: !!pasoCF, pasoNL: !!pasoNL, cf: { rc: cf.rc, out: cf.out.slice(-120), ver: cf.ver, igual: cf.html === fuente }, nl: { rc: nl.rc, out: nl.out.slice(-120), ver: nl.ver, igual: nl.html === fuente }, c7l }));
  // C7l2 (21 oct 2026): cada archivo que copia ese paso a dist/ está en on.push.paths de deploy-pages.yml; si no, un push
  // a main que solo cambie ese archivo (p. ej. version.json) no publica nada en Cloudflare.
  const pushPaths = (() => {
    const iPush = wf.findIndex(l => /^  push:\s*$/.test(l)), iPaths = wf.findIndex((l, i) => iPush >= 0 && i > iPush && /^    paths:\s*$/.test(l));
    const out = [];
    if (iPush < 0 || iPaths < 0) return out;
    for (let i = iPaths + 1; i < wf.length; i++) {
      const l = wf[i];
      if (!l.trim() || /^\s*#/.test(l)) continue;
      const m = /^      - (\S+)\s*$/.exec(l); if (!m) break; out.push(m[1]);
    }
    return out;
  })();
  const copiados = pasoCF.split('\n').map(l => (/^cp\s+(\S+)\s+dist\//.exec(l.trim()) || [])[1]).filter(Boolean);
  const cubre = (src) => pushPaths.some(p => p === src || (p.endsWith('/**') && src.startsWith(p.slice(0, -2))));
  const sinCubrir = copiados.filter(s => !cubre(s));
  check('C7l2 cada archivo que deploy-pages.yml copia a dist/ (index.html, sw.js, iconos, vendor, version.json…) está en sus on.push.paths: un push a main que solo cambie version.json también publica',
    copiados.length >= 7 && copiados.includes('version.json') && pushPaths.includes('version.json') && !sinCubrir.length,
    JSON.stringify({ pushPaths, copiados, sinCubrir }));

  // C7m: el paso de ci.yml que exige subir version.json cuando cambia index.html, corrido tal cual sobre repos de git de
  // prueba: en el PR (la rama base como origin/main, el PR como HEAD) y en la publicación (push a main: contra el commit
  // anterior, github.event.before), donde se ve la carrera entre dos PR que suben la versión al MISMO valor siguiente.
  const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8').split('\n');
  const s0 = ci.findIndex(l => /- name: version\.json acompaña a index\.html/.test(l));
  const r0 = ci.findIndex((l, i) => i > s0 && /^\s+run: \|\s*$/.test(l));
  let pasoCI = '';
  if (s0 >= 0 && r0 > s0) {
    const ind = ci[r0].match(/^\s*/)[0].length;
    const body = [];
    for (let i = r0 + 1; i < ci.length; i++) { const l = ci[i]; if (l.trim() && l.match(/^\s*/)[0].length <= ind) break; body.push(l); }
    const min = Math.min(...body.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
    pasoCI = body.map(l => l.slice(min)).join('\n');
  }
  const pasoIf = s0 >= 0 ? (ci.slice(s0, r0).find(l => /^\s+if:/.test(l)) || '') : '';
  const ifPRyPush = /github\.event_name == 'pull_request'/.test(pasoIf) && /github\.event_name == 'push'/.test(pasoIf);
  const pasoEnv = s0 >= 0 ? ci.slice(s0, r0).join('\n') : '';
  const envOk = /EVENTO:\s*\$\{\{\s*github\.event_name\s*\}\}/.test(pasoEnv) && /BASE_REF:\s*\$\{\{\s*github\.base_ref\s*\}\}/.test(pasoEnv) && /ANTES:\s*\$\{\{\s*github\.event\.before\s*\}\}/.test(pasoEnv);
  // El job de ese paso baja la historia completa (fetch-depth: 0): con la copia de un solo commit de actions/checkout no
  // existen origin/<base> ni el ancestro común, y `git diff origin/main...HEAD` falla en TODOS los PR.
  const j0 = (() => { for (let i = s0; i >= 0; i--) if (/^  [\w-]+:\s*$/.test(ci[i])) return i; return -1; })();
  const jobAntes = j0 >= 0 ? ci.slice(j0, s0).join('\n') : '';
  const historiaCompleta = /uses:\s*actions\/checkout@[\s\S]*?\n\s+with:\s*\n\s+fetch-depth:\s*0\s*(\n|$)/.test(jobAntes);
  const git = (d, args) => spawnSync('git', args, { cwd: d, encoding: 'utf8' });
  const escribe = (d, files) => Object.keys(files).forEach(f => { if (files[f] === null) fs.rmSync(path.join(d, f), { force: true }); else fs.writeFileSync(path.join(d, f), files[f]); });
  const repoPrueba = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-ci-')); git(d, ['init', '-q', '-b', 'main']); git(d, ['config', 'user.email', 'ci@prueba.local']); git(d, ['config', 'user.name', 'Prueba']); return d; };
  const commit = (d, files, msg) => { escribe(d, files); git(d, ['add', '-A']); git(d, ['commit', '-qm', msg, '--allow-empty']); return git(d, ['rev-parse', 'HEAD']).stdout.trim(); };
  const paso = (d, env) => { const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', pasoCI], { cwd: d, encoding: 'utf8', env: Object.assign({}, process.env, env) }); return { rc: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-2).join(' | ') }; };
  const correrCI = (base, pr) => {
    const d = repoPrueba();
    try {
      commit(d, base, 'base'); git(d, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(d, ['checkout', '-qb', 'pr']); commit(d, pr, 'pr');
      return paso(d, { EVENTO: 'pull_request', BASE_REF: 'main', ANTES: '' });
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  // Publicación: commits seguidos en main; el paso corre en el último con ANTES = el commit `antes` (índice) o un valor dado.
  const correrPush = (commits, antes) => {
    const d = repoPrueba();
    try {
      const shas = commits.map((c, i) => commit(d, c, 'c' + i));
      return paso(d, { EVENTO: 'push', BASE_REF: '', ANTES: typeof antes === 'number' ? shas[antes] : antes });
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  };
  const idx = (v) => '<script>const PL_BUILD = "' + v + '";</script>\n';
  const vj = (v) => JSON.stringify({ v }) + '\n';
  const m1 = correrCI({ 'index.html': idx('A'), 'version.json': vj('A') }, { 'index.html': idx('B') });                                   // index sin version.json
  const m2 = correrCI({ 'index.html': idx('A'), 'version.json': vj('A') }, { 'index.html': idx('B'), 'version.json': vj('B') });         // los dos
  const m3 = correrCI({ 'index.html': idx('A'), 'version.json': vj('A') }, { 'README.md': 'otra cosa\n' });                               // no toca index.html
  const m4 = correrCI({ 'index.html': idx('A'), 'version.json': vj('A') }, { 'index.html': idx('B'), 'version.json': '{ "v": "A" }\n' }); // version.json con la misma v
  const m5 = correrCI({ 'index.html': idx('A') }, { 'index.html': idx('B'), 'version.json': vj('B') });                                   // primera vez (este PR)
  // Carrera: main en A; el PR 1 (índice 1: index B1 y v B) se fusiona; el PR 2, abierto a la vez, también subió a v B (pasó
  // en su PR) y se fusiona después (índice 2: index B2, misma v B).
  const carrera = [{ 'index.html': idx('A'), 'version.json': vj('A') }, { 'index.html': idx('B1'), 'version.json': vj('B') }, { 'index.html': idx('B2'), 'version.json': vj('B') }];
  const p1 = correrPush(carrera.slice(0, 2), 0);                                          // publicación del PR 1: A → B
  const p2 = correrPush(carrera, 1);                                                      // publicación del PR 2: misma v → falla
  const p3 = correrPush(carrera, '0000000000000000000000000000000000000000');             // primer push de la rama: se omite
  const p4 = correrPush(carrera, 'f'.repeat(40));                                         // historia reescrita: se omite
  const p5 = correrPush([carrera[0], { 'README.md': 'x\n' }], 0);                         // publicación sin index.html: pasa
  check('C7m el paso de ci.yml (en pull_request y en la publicación por push) falla si cambia index.html sin subir version.json o con la misma "v" —también en la carrera de dos PR que suben al mismo valor, al publicar el segundo—, pasa si sube los dos, si no toca index.html o si version.json es nuevo, se omite sin commit anterior, y su job baja la historia completa (fetch-depth: 0)',
    !!pasoCI && ifPRyPush && envOk && historiaCompleta && m1.rc !== 0 && /::error/.test(m1.out) && m2.rc === 0 && m3.rc === 0 && m4.rc !== 0 && m5.rc === 0
    && p1.rc === 0 && p2.rc !== 0 && /::error/.test(p2.out) && p3.rc === 0 && /::warning/.test(p3.out) && p4.rc === 0 && /::warning/.test(p4.out) && p5.rc === 0,
    JSON.stringify({ pasoCI: !!pasoCI, ifPRyPush, envOk, historiaCompleta, m1, m2, m3, m4, m5, p1, p2, p3, p4, p5 }));

  // ═══ C8/C9: con el service worker REAL (sw.js) y la caché HTTP del navegador encendida ═══════════════════════════════
  // Servidor propio que imita a GitHub Pages (Cache-Control: max-age=600, ETag, 304) y sirve los archivos del repo; las
  // «publicaciones siguientes» cambian en memoria index.html (PL_BUILD), version.json y la VERSION de sw.js (el repo no se
  // toca). Contexto SIN rutas (con rutas Playwright apaga la caché HTTP): Supabase simulado dentro de la página.
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
  const pub = { over: {}, log: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    pub.log.push({ t: Date.now(), p, cc: req.headers['cache-control'] || '' });
    let body;
    if (pub.over[p] !== undefined) body = Buffer.from(pub.over[p]);
    else {
      const f = path.join(REPO, p);
      if (!f.startsWith(REPO + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
      body = fs.readFileSync(f);
    }
    const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
    const h = { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', ETag: etag, 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'max-age=600' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
    res.writeHead(200, h); res.end(body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const SRV = 'http://127.0.0.1:' + srv.address().port;
  const swSrc = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8'), idxSrc = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const VER_SW = (/const VERSION = '([^']+)';/.exec(swSrc) || [])[1] || '';
  const publicarSig = (suf, build) => {
    pub.over['/sw.js'] = swSrc.replace("const VERSION = '" + VER_SW + "';", "const VERSION = '" + VER_SW + '-' + suf + "';");
    pub.over['/index.html'] = idxSrc.replace('const PL_BUILD = "' + BUILD + '";', 'const PL_BUILD = "' + build + '";');
    pub.over['/version.json'] = JSON.stringify({ v: build });
  };
  const sPac = [{ id: 's1', cama: '3-175', exp: '26-90175', nombre: 'PRUEBA FICTICIA SERVICE WORKER', esp: 'CG', estado: 'ESTABLE' }];
  const ctxS = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  await ctxS.addInitScript(mockScript({ verTest: true, quietAlert: true, realSW: true, inPageSupa: sPac, swLog: true }));
  const ps = await ctxS.newPage(); watch(ps, 'S');
  await ps.goto(SRV + '/', { waitUntil: 'load', timeout: 90000 });
  await ps.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1, null, { timeout: 30000 });
  const s0sw = await ps.evaluate(async () => {
    const t = Date.now();
    while (Date.now() - t < 20000) { const r = await navigator.serviceWorker.getRegistration(); if (navigator.serviceWorker.controller && r && r.active && !r.installing && !r.waiting) break; await new Promise(x => setTimeout(x, 200)); }
    return { ctrl: !!navigator.serviceWorker.controller, keys: await caches.keys(), build: PL_BUILD };
  });
  // C9: la siguiente publicación (otro sw.js e index.html) llega menos de 10 min después de abrir: la copia de la app que
  // guarda el SW nuevo al instalarse debe ser la NUEVA, no la que el navegador tiene en su caché HTTP (max-age=600).
  const B9 = 'version-c9-de-prueba';
  publicarSig('c9', B9);
  const c9 = await ps.evaluate(async (v) => {
    const cc = new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    const reg = await navigator.serviceWorker.getRegistration(); await reg.update();
    await Promise.race([cc, new Promise(r => setTimeout(r, 15000))]);
    let keys = await caches.keys();
    for (let i = 0; i < 50 && keys.length > 1; i++) { await new Promise(r => setTimeout(r, 100)); keys = await caches.keys(); }   // el SW nuevo borra la caché vieja al activarse
    const c = await caches.open(keys.find(k => /-c9$/.test(k)) || 'no-hay');
    const m = await c.match('./'); const txt = m ? await m.text() : '';
    return { keys, guardada: (/const PL_BUILD = "([^"]*)";/.exec(txt) || [])[1] || null, esperada: v };
  }, B9);
  check('C9 service worker real: si la publicación siguiente se instala a menos de 10 min de abrir (caché HTTP de GitHub Pages, max-age=600), la copia de la app que guarda el SW nuevo es la NUEVA (la instalación no usa la caché HTTP)',
    s0sw.ctrl && s0sw.keys.length === 1 && s0sw.keys[0] === VER_SW && s0sw.build === BUILD && c9.keys.length === 1 && c9.keys[0] === VER_SW + '-c9' && c9.guardada === B9,
    JSON.stringify({ s0sw, c9 }));
  // C8: la publicación siguiente trae OTRO sw.js (VERSION nueva). «Actualizar» espera a que el SW nuevo tome el control
  // (controllerchange) ANTES de recargar: en WebKit (iPad), recargar mientras se activaba cerraba el SW viejo a media
  // navegación y la página se quedaba en «⏳ Subiendo lo pendiente…». La recarga abre la versión nueva, atendida por el SW nuevo.
  publicarSig('c8', OTRA);
  await ps.evaluate(() => sessionStorage.removeItem('__swev'));
  const c8a = await ps.evaluate(async () => { const r = await _plVersionRevisar(); const b = document.getElementById('pl-ver-bar'); return { r, vis: !!b && getComputedStyle(b).display !== 'none' }; });
  const tS = Date.now();
  await ps.click('[data-testid="ver-actualizar"]');
  await ps.waitForFunction((v) => typeof PL_BUILD !== 'undefined' && PL_BUILD === v && typeof patients !== 'undefined' && patients.length === 1, OTRA, { timeout: 40000 }).catch(() => {});
  const c8 = await ps.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return { build: PL_BUILD, ev: JSON.parse(sessionStorage.getItem('__swev') || '[]').map(x => x.e), keys: await caches.keys(), ctrl: !!navigator.serviceWorker.controller, act: !!(r && r.active), wait: !!(r && r.waiting), alerts: window.__alerts || [], bar: !!document.getElementById('pl-ver-bar') && getComputedStyle(document.getElementById('pl-ver-bar')).display !== 'none' };
  });
  const iCc = c8.ev.indexOf('cc'), iHide = c8.ev.indexOf('hide');
  check('C8 service worker real con VERSION nueva en sw.js: «Actualizar» espera a que el SW nuevo tome el control (controllerchange) ANTES de irse la página, recarga en la versión nueva (PL_BUILD y version.json iguales → sin barra), con el SW nuevo controlando y su caché sola',
    c8a.r === OTRA && c8a.vis && c8.build === OTRA && iCc >= 0 && iHide > iCc && c8.ctrl && c8.act && !c8.wait && c8.keys.length === 1 && c8.keys[0] === VER_SW + '-c8' && !c8.bar && c8.alerts.length === 0 && (Date.now() - tS) < 40000,
    JSON.stringify({ c8a, c8, dt: Date.now() - tS }));
  const supaS = await ps.evaluate(() => (window.__supaLlamadas || []).length);
  console.log('INFO C8/C9: peticiones a Supabase atendidas dentro de la página (sin red): ' + supaS + ' · al servidor de la publicación: ' + pub.log.length);
  // C0 sin internet: en este contexto no hay rutas; lo que no sea 127.0.0.1 no sale de la máquina (_browser.js: proxy muerto).
  // Si saliera, un preflight o una petición que ninguna ruta atiende (app_offline) llegaría al Supabase real.
  const pNet = await ctxS.newPage();
  const c0 = await pNet.goto('https://example.com/', { timeout: 15000 }).then(r => ({ ok: true, status: r && r.status() })).catch(e => ({ ok: false, err: String(e && e.message || e).split('\n')[0].slice(0, 120) }));
  await pNet.close();
  check('C0 sin internet: un contexto sin rutas no puede abrir un sitio de internet (el navegador de las pruebas no tiene salida)', c0.ok === false, JSON.stringify(c0));
  await ctxS.close();
  srv.close();

  // Ninguna petición salió a Supabase real (lo que el simulado no atiende se cortó arriba): se informa.
  console.log('INFO peticiones a *.supabase.co cortadas (no atendidas por el simulado): ' + realSupa.length + (realSupa.length ? ' · ' + Array.from(new Set(realSupa)).slice(0, 8).join(' ; ') : ''));
  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-HOTFIX-CARGA: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
