// Abrir sin red y sin perder nada (oct 2026): service worker con copia de la app, sesión guardada sin
// red, texto escrito sin conexión que sobrevive a recargar y se sube al volver la red sin que la
// copia remota lo pise, el botón ↩ Regresar, y la cama cambiada sin red (✏️ Editar) que sobrevive a la
// recarga, no la pisa la fila remota ni Realtime, y sube con la cama nueva al volver la red (O6-O9). O13: version.json
// (aviso de versión nueva) nunca sale de la caché del service worker.
//   node tests/headless/app_offline.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const http = require('http');
const { launch, name: BROWSER } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  const KEY='__mock_session';
  if (!sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  // Sesión guardada tal como la deja supabase-js (clave sb-<ref>-auth-token): es la que usa el arranque sin red.
  localStorage.setItem('sb-vkxplmrzyqlamxpbtmes-auth-token', JSON.stringify({ access_token:'stored-tok', refresh_token:'r', expires_at: 1, user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const listeners=[];
  const auth={
    // Sin red, supabase-js no puede renovar el token y getSession falla con un error de red.
    getSession: async()=>{ if(!navigator.onLine) throw new TypeError('Failed to fetch'); return { data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }; },
    onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
    refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }),
    signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null })
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  const mock={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
  // No sobrescribible: la librería empaquetada (UMD) hace window.supabase = … y debe quedar ignorada en la prueba.
  Object.defineProperty(window, 'supabase', { value: mock, writable: false, configurable: false });
})();`;
(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  let offline = false;
  // Red intermitente (O10/O11): navigator.onLine sigue en true pero los PATCH a patients no llegan (wifi del hospital).
  let failPatch = false;
  const posts = [];
  // Fila remota MUTABLE: un PATCH a /rest/v1/patients con `cama` la actualiza (como Supabase), así la
  // aserción "la nube termina con la cama nueva" es real y no un eco del mock.
  const remotePatient = { id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' };
  const patches = [];
  const remoteNote = { patient_id: 'a1', app: '', pa: '', drenajes: '', qx: '', manejo: '', sangrado: '', sv: '', balance: '', pendientes: 'PEND REMOTO', checklist: {}, lab_history: [], imagen_history: [] };
  // Supabase simulado: { json: [status, cuerpo] } o { cortar: true } (red caída o que no responde).
  const rest = (m, url, raw) => {
    if (offline) return { cortar: true };
    let body = null; try { body = JSON.parse(raw || 'null'); } catch (_) {}
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return { json: [200, [Object.assign({}, remotePatient)]] };
      if (m === 'PATCH') {
        if (failPatch) { patches.push({ url, body, failed: true }); return { cortar: true }; }
        patches.push({ url, body });
        if (body && body.cama !== undefined) remotePatient.cama = body.cama;
        return { json: [200, [Object.assign({}, remotePatient)]] };
      }
      return { json: [201, [{ id: 'a1' }]] };
    }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') return { json: [200, [Object.assign({}, remoteNote)]] };
      posts.push(body);
      // Fila de notas también MUTABLE (21 oct 2026): el upsert mezcla las columnas que llegan y responde la fila, como
      // PostgREST; la app relee la nota tras subir la cola y una fila fija regresaba lo escrito sin red.
      (Array.isArray(body) ? body : [body]).forEach((r) => { if (r) Object.keys(r).forEach((c) => { if (c !== 'updated_by' && c !== 'patient_id') remoteNote[c] = JSON.parse(JSON.stringify(r[c])); }); });
      return { json: [201, [Object.assign({}, remoteNote)]] };
    }
    return { json: [m === 'GET' ? 200 : 201, m === 'GET' ? [] : [{ id: 1 }]] };
  };
  // Lo atiende un servidor DE VERDAD en 127.0.0.1 (21 oct 2026), no context.route: con la página controlada por el service
  // worker, Supabase (otro origen) pasa por su fetch sin respondWith y sale directo a la red, y en WebKit Playwright no
  // intercepta esa salida (iba al proxy muerto de _browser.js: «Could not connect to proxy server», cola sin subir en
  // O4 y O8-O12). Así la petición recorre el mismo camino que en el iPad (página → service worker → red) en los dos
  // motores, con CORS como Supabase (preflight OPTIONS; Authorization no entra en el comodín `*`, se devuelve la lista
  // pedida). Cortar = destruir el socket: el fetch de la app falla como sin red, igual que route.abort.
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    let raw = ''; req.setEncoding('utf8'); req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const r = rest(req.method, req.url, raw);
      if (r.cortar) return req.socket.destroy();
      res.writeHead(r.json[0], Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(r.json[1]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // La app arma cada URL como SUPA_URL + "/rest/v1/…" (_sFetch); solo se cambia el origen, se lee de la index.html servida.
  const SUPA_URL = ((await (await fetch(BASE_URL + '/index.html')).text()).match(/const SUPA_URL = "([^"]+)"/) || [])[1];
  if (!SUPA_URL) throw new Error('index.html sin «const SUPA_URL = "…"»: no se puede apuntar la app al Supabase simulado');
  await context.addInitScript(([from, to]) => {
    const f = window.fetch;
    window.fetch = function (input, init) {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
      return f.call(window, u !== null && u.indexOf(from) === 0 ? to + u.slice(from.length) : input, init);
    };
  }, [SUPA_URL + '/rest/v1/', 'http://127.0.0.1:' + server.address().port + '/rest/v1/']);
  await context.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };

  // 1) Con red: arranca, instala el service worker y guarda la app + supabase-js en caché
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(4000);
  const o1 = await page.evaluate(async () => {
    const t0 = Date.now(); let doc = null, lib = null, sw = null;
    while (Date.now() - t0 < 15000) {
      try { sw = await navigator.serviceWorker.getRegistration(); const ck = (await caches.keys()).find(n => /^pisolibro-v\d+$/.test(n)) || 'pisolibro-v10'; const c = await caches.open(ck); doc = await c.match('./'); lib = await c.match('./vendor/supabase-2.46.1.js'); } catch (e) {}
      if (doc && lib) break;
      await new Promise(r => setTimeout(r, 300));
    }
    const k = pid(patients[0]);
    return { sw: !!sw, doc: !!doc, lib: !!lib, ext: Array.from(document.scripts).filter(s => /^https?:/.test(s.src) && !/127\.0\.0\.1/.test(s.src)).map(s => s.src), overlay: getComputedStyle(document.getElementById('login-overlay')).display, pend: getNote(k).pendientes, supaMock: typeof window.supabase.createClient === 'function' && !window.supabase.SupabaseClient };
  });
  check('O1 con red: service worker instalado; la app (./) y supabase-js quedan en caché; ningún script externo; sesión normal',
    o1.sw && o1.doc && o1.lib && o1.ext.length === 0 && o1.overlay === 'none' && o1.pend === 'PEND REMOTO' && o1.supaMock, JSON.stringify(o1));

  // 2) Sin red: escribir en Pendientes → queda en el dispositivo y en la cola (outbox), no se pierde
  offline = true; await context.setOffline(true);
  await page.waitForTimeout(400);
  const o2 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const ta = document.querySelector('textarea[data-key][data-field="pendientes"]');
    ta.focus(); ta.dataset.beforeValue = ta.value; ta.value = 'ESCRITO SIN RED'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); ta.blur();
    await new Promise(r => setTimeout(r, 2500));
    const q = outboxLoad();
    const ls = JSON.parse(localStorage.getItem('note-' + k) || '{}');
    return { online: navigator.onLine, status: (document.getElementById('sync-status') || {}).textContent || '', q: q.length, dirty: q[0] && q[0].dirty, qPend: q[0] && q[0].data && q[0].data.pendientes, lsPend: ls.pendientes, undo: _undoCount(k) };
  });
  check('O2 sin red: lo escrito queda en localStorage y en la cola de envío con su campo; estado "Sin conexión"; Regresar disponible',
    !o2.online && /Sin conexión|Guardado|Error|pendientes/i.test(o2.status || 'x') && o2.q === 1 && Array.isArray(o2.dirty) && o2.dirty.includes('pendientes') && o2.qPend === 'ESCRITO SIN RED' && o2.lsPend === 'ESCRITO SIN RED' && o2.undo >= 1, JSON.stringify(o2));

  // 3) Recargar SIN red: la app abre desde la caché del service worker, con la sesión guardada y el texto escrito
  let reloadOk = true;
  try { await page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (e) { reloadOk = false; errors.push('reload offline: ' + String(e).slice(0, 120)); }
  await page.waitForTimeout(4500);
  const o3 = reloadOk ? await page.evaluate(() => {
    const k = pid(patients[0]);
    const ta = document.querySelector('textarea[data-key][data-field="pendientes"]');
    return { online: navigator.onLine, pts: patients.length, overlay: getComputedStyle(document.getElementById('login-overlay')).display, offlineSession: !!_offlineSession, tok: _userAccessToken, pend: getNote(k).pendientes, taVal: ta ? ta.value : null, status: (document.getElementById('sync-status') || {}).textContent || '', q: outboxLoad().length, scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean) };
  }) : { reloadOk };
  check('O3 recarga sin red: abre desde la caché (sin login), sesión guardada, paciente y texto escrito siguen ahí, cola intacta',
    reloadOk && !o3.online && o3.pts === 1 && o3.overlay === 'none' && o3.offlineSession && o3.tok === 'stored-tok' && o3.pend === 'ESCRITO SIN RED' && o3.taVal === 'ESCRITO SIN RED' && /Sin conexión/.test(o3.status) && o3.q === 1, JSON.stringify(o3));

  // 4) Vuelve la red: se baja lo remoto (viejo) SIN pisar lo escrito, y la cola lo sube con ese valor
  offline = false; await context.setOffline(false);
  await page.waitForTimeout(5000);
  const o4 = await page.evaluate(() => {
    const k = pid(patients[0]);
    return { online: navigator.onLine, pend: getNote(k).pendientes, q: outboxLoad().length, status: (document.getElementById('sync-status') || {}).textContent || '' };
  });
  const posted = posts.find(b => b && b.pendientes !== undefined);
  check('O4 al volver la red: la nota remota ("PEND REMOTO") no pisa lo escrito; el POST sube "ESCRITO SIN RED" con merge por campo; cola vacía',
    o4.online && o4.pend === 'ESCRITO SIN RED' && !!posted && posted.pendientes === 'ESCRITO SIN RED' && o4.q === 0, JSON.stringify({ o4, posts: posts.map(b => b && Object.keys(b)) }));

  // 5) ↩ Regresar: deshace el último cambio (texto, quitar cirugía) y deja "como estaba" para volver
  const o5 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const before = getNote(k).pendientes;
    updateField(k, 'pendientes', 'TEXTO EQUIVOCADO', before);
    const btn = document.querySelector('#card-' + CSS.escape(k) + ' .undo-btn');
    const visible = !!btn && btn.style.display !== 'none';
    const title = btn ? btn.title : '';
    const l1 = undoLast(k);
    const afterUndo = getNote(k).pendientes;
    const taVal = (document.querySelector('textarea[data-key][data-field="pendientes"]') || {}).value;
    const rbtn = document.querySelector('#card-' + CSS.escape(k) + ' .redo-btn');
    const redoVisible = !!rbtn && rbtn.style.display !== 'none';
    const l2 = redoLast(k);                                // Rehacer: vuelve al texto equivocado
    const redo = getNote(k).pendientes;
    const l2b = undoLast(k);                               // Regresar otra vez: de nuevo al bueno
    const again = getNote(k).pendientes;
    // Editar algo nuevo con un Rehacer pendiente: lo que se dejó atrás pasa a la pila de Regresar (no se pierde)
    updateField(k, 'pendientes', 'TEXTO NUEVO', getNote(k).pendientes);
    const redoAfterEdit = _redoCount(k);
    const l2c = undoLast(k);                               // deshace el texto nuevo → ESCRITO SIN RED
    const back1 = getNote(k).pendientes;
    const l2d = undoLast(k);                               // "como estaba antes de regresar" → TEXTO EQUIVOCADO (recuperable)
    const back2 = getNote(k).pendientes;
    redoLast(k); redoLast(k);                              // y de vuelta al texto nuevo
    const back3 = getNote(k).pendientes;
    undoLast(k);                                           // dejar ESCRITO SIN RED
    // quitar una cirugía y regresarla
    const id = addCirugia(k, '2026-10-10'); updateCirugia(k, id, 'procedimiento', 'LAPE');
    removeCirugia(k, id);
    const n0 = getNote(k).checklist.cirugias.length;
    const l3 = undoLast(k);
    const n1 = getNote(k).checklist.cirugias.length;
    const dirty = Array.from(_dirtyUnion(k));
    const stored = JSON.parse(localStorage.getItem('pl_undo_v1') || '{}');
    const storedRedo = JSON.parse(localStorage.getItem('pl_redo_v1') || '{}');
    return { visible, title, l1, afterUndo, taVal, redoVisible, l2, redo, l2b, again, redoAfterEdit, l2c, back1, l2d, back2, back3, final: getNote(k).pendientes, n0, l3, n1, hasStack: !!stored[k], hasRedo: !!storedRedo[k], dirty };
  });
  check('O5 Regresar/Rehacer: botón visible con la etiqueta; vuelve el texto anterior (y la caja); Rehacer vuelve a como estaba; editar tras regresar no pierde lo dejado atrás; una cirugía quitada regresa; pilas persistidas',
    o5.visible && /Regresar: texto de Pendientes/.test(o5.title) && /texto de Pendientes/.test(o5.l1) && o5.afterUndo === 'ESCRITO SIN RED' && o5.taVal === 'ESCRITO SIN RED' && o5.redoVisible
    && /texto de Pendientes/.test(o5.l2) && o5.redo === 'TEXTO EQUIVOCADO' && /texto de Pendientes/.test(o5.l2b) && o5.again === 'ESCRITO SIN RED'
    && o5.redoAfterEdit === 0 && /texto de Pendientes/.test(o5.l2c) && o5.back1 === 'ESCRITO SIN RED' && /como estaba antes de regresar/.test(o5.l2d) && o5.back2 === 'TEXTO EQUIVOCADO' && o5.back3 === 'TEXTO NUEVO'
    && o5.final === 'ESCRITO SIN RED' && o5.n0 === 0 && /quitar cirugía LAPE/.test(o5.l3) && o5.n1 === 1 && o5.hasStack && o5.hasRedo, JSON.stringify(o5));

  // ── Cama editada SIN RED que se revertía al volver la red ──────────────────────────────────────
  // Antes: 'online'/init cargaban la fila remota (cama vieja) ANTES del flush, el flush leía esa fila
  // y PATCHeaba la cama VIEJA → la nube no cambiaba y la tarjeta volvía a la cama anterior.
  // Helper: editar la cama en ✏️ Editar sin red y esperar a que el PATCH falle y el cambio pase a la cola.
  const editBedOffline = (newBed) => page.evaluate(async (bed) => {
    const k = pid(patients[0]);
    openEditModal(k);
    document.getElementById('mf-cama').value = bed;
    saveModal();
    await new Promise(r => setTimeout(r, 1500)); // PATCH falla + reintento 300 ms → outbox
    const it = outboxLoad().find(x => x.type === 'patient');
    const ls = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const posEl = document.querySelector('#board-nav .bn-pos');
    return { online: navigator.onLine, cama: patients[0].cama, lsCama: ls[0] && ls[0].cama, itCama: it && it.patient && it.patient.cama, itTs: it && it.patient && it.patient.cama_app_ts, dirty: it && it.dirty, modal: document.getElementById('patient-modal').style.display, uiBed: (document.querySelector('.card-bed') || {}).textContent, pos: posEl ? posEl.textContent : null };
  }, newBed);

  // 6) Sin red: cambiar la cama en ✏️ Editar → tarjeta, localStorage y cola (solo el campo cama); un UPDATE
  //    de Realtime con la cama vieja (otro iPad / sheet-sync) NO la pisa mientras el cambio espera subir.
  offline = true; await context.setOffline(true); await page.waitForTimeout(400);
  const o6 = await editBedOffline('3-105');
  const o6rt = await page.evaluate(() => {
    // saveNote suprime Realtime 5 s para este paciente (BUG-C1): quitarla para que el UPDATE sí se procese
    // (en producción llega pasada la ventana, p. ej. al reconectar Realtime) y la aserción no sea vacía.
    _suppressRealtimeKeys.clear();
    const suppressed = _suppressRealtimeKeys.size;
    handlePatientChange({ eventType: 'UPDATE', new: { id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' }, old: { id: 'a1' } });
    const ls2 = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return { suppressed, afterRt: patients[0].cama, afterRtTs: patients[0].cama_app_ts, afterRtLs: ls2[0] && ls2[0].cama, uiBed: (document.querySelector('.card-bed') || {}).textContent, q: outboxLoad().filter(x => x.type === 'patient').length };
  });
  check('O6 sin red: cambiar la cama en ✏️ Editar queda en la tarjeta, en localStorage y en la cola (solo el campo cama, con la marca cama_app_ts para que el sheet-sync no la regrese); un UPDATE de Realtime con la cama vieja no la pisa ni le quita la marca',
    !o6.online && /^\d{4}-\d{2}-\d{2}T/.test(o6.itTs || '') && o6rt.afterRtTs === o6.itTs && o6.cama === '3-105' && o6.lsCama === '3-105' && o6.itCama === '3-105' && Array.isArray(o6.dirty) && o6.dirty.length === 1 && o6.dirty[0] === 'cama' && o6.modal === 'none' && o6.uiBed === '3-105' && (o6.pos === null || /3-105/.test(o6.pos))
    && o6rt.suppressed === 0 && o6rt.afterRt === '3-105' && o6rt.afterRtLs === '3-105' && o6rt.uiBed === '3-105' && o6rt.q === 1, JSON.stringify({ o6, o6rt }));

  // 7) Recarga SIN red: la cama nueva sigue en la tarjeta y el cambio sigue en la cola. Arranca un vigía
  //    que anota cada 30 ms la cama en memoria y en la tarjeta (para O8: la vieja no debe verse ni un instante).
  let reload7 = true;
  try { await page.reload({ waitUntil: 'load', timeout: 30000 }); } catch (e) { reload7 = false; errors.push('reload offline 2: ' + String(e).slice(0, 120)); }
  await page.waitForTimeout(4500);
  const o7 = reload7 ? await page.evaluate(() => {
    window.__camaSeen = []; window.__camaT = setInterval(() => { try { window.__camaSeen.push(String(patients[0] && patients[0].cama) + '|' + ((document.querySelector('.card-bed') || {}).textContent || '')); } catch (_) {} }, 30);
    return { online: navigator.onLine, cama: patients[0] && patients[0].cama, uiBed: (document.querySelector('.card-bed') || {}).textContent, q: outboxLoad().filter(x => x.type === 'patient').length };
  }) : { reload7 };
  check('O7 recarga sin red: la cama nueva sigue en la tarjeta y el cambio sigue en la cola', reload7 && !o7.online && o7.cama === '3-105' && o7.uiBed === '3-105' && o7.q === 1, JSON.stringify(o7));

  // 8) Vuelve la red ('online' → carga remota → flush): el PATCH lleva la cama NUEVA (ninguno con la vieja),
  //    la fila remota vieja no se ve ni un instante, la cola queda vacía y la nube termina con la cama nueva.
  patches.length = 0;
  offline = false; await context.setOffline(false);
  await page.waitForTimeout(6500);
  const o8 = await page.evaluate(() => {
    clearInterval(window.__camaT);
    const ls = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const posEl = document.querySelector('#board-nav .bn-pos');
    return { online: navigator.onLine, cama: patients[0].cama, lsCama: ls[0] && ls[0].cama, uiBed: (document.querySelector('.card-bed') || {}).textContent, pos: posEl ? posEl.textContent : null, qPt: outboxLoad().filter(x => x.type === 'patient').length, seen: Array.from(new Set(window.__camaSeen)) };
  });
  const ptPatches8 = patches.filter(p => /\/rest\/v1\/patients/.test(p.url));
  check('O8 al volver la red: el PATCH a patients lleva la cama NUEVA con su marca cama_app_ts (ninguno con la vieja), la fila remota vieja no se ve ni un instante, la tarjeta muestra la cama nueva, la cola queda vacía y la nube termina con la nueva',
    o8.online && ptPatches8.length >= 1 && ptPatches8.every(p => p.body && p.body.cama === '3-105' && /^\d{4}-\d{2}-\d{2}T/.test(p.body.cama_app_ts || '')) && o8.cama === '3-105' && o8.lsCama === '3-105' && o8.uiBed === '3-105' && (o8.pos === null || /3-105/.test(o8.pos)) && o8.qPt === 0 && o8.seen.length > 0 && o8.seen.every(s => !/3-101/.test(s)) && remotePatient.cama === '3-105',
    JSON.stringify({ o8, patches: ptPatches8.map(p => p.body && p.body.cama), remote: remotePatient.cama }));

  // 9) Camino init CON red: otra edición sin red ('3-107'), se cierra la pestaña sin red y se abre la app
  //    de nuevo ya con red (así el 'online' no corre antes que init). init carga lo remoto ('3-105') → el
  //    ítem pendiente se superpone → el flush sube '3-107' y la nube queda con '3-107'.
  offline = true; await context.setOffline(true); await page.waitForTimeout(400);
  const o9a = await editBedOffline('3-107');
  await page.close();
  patches.length = 0;
  offline = false; await context.setOffline(false);
  const page2 = await context.newPage();
  page2.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page2.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page2.waitForTimeout(6500);
  const o9 = await page2.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return { online: navigator.onLine, pts: patients.length, cama: patients[0] && patients[0].cama, lsCama: ls[0] && ls[0].cama, uiBed: (document.querySelector('.card-bed') || {}).textContent, qPt: outboxLoad().filter(x => x.type === 'patient').length, status: (document.getElementById('sync-status') || {}).textContent || '' };
  });
  const ptPatches9 = patches.filter(p => /\/rest\/v1\/patients/.test(p.url));
  check('O9 abrir la app con red tras editar la cama sin red (init): lo remoto no pisa el cambio pendiente, el PATCH lleva la cama nueva, la cola queda vacía y la nube termina con ella',
    o9a.cama === '3-107' && o9a.itCama === '3-107' && Array.isArray(o9a.dirty) && o9a.dirty.join() === 'cama'
    && o9.online && o9.pts === 1 && ptPatches9.length >= 1 && ptPatches9.every(p => p.body && p.body.cama === '3-107' && p.body.cama_app_ts === o9a.itTs) && o9.cama === '3-107' && o9.lsCama === '3-107' && o9.uiBed === '3-107' && o9.qPt === 0 && remotePatient.cama === '3-107',
    JSON.stringify({ o9a, o9, patches: ptPatches9.map(p => p.body && p.body.cama), remote: remotePatient.cama }));

  // 10-11) Red INTERMITENTE (sin evento 'offline'/'online'): la 1.ª cama no sube y queda en la cola; la 2.ª sí sube.
  //    Antes del arreglo del revisor la cola guardaba la 1.ª y la volvía a imponer: el eco de Realtime de la 2.ª y el
  //    flush de cada 30 s regresaban la tarjeta y la nube a la 1.ª (la misma "cama que se revierte").
  const editBed = (pg, bed, waitMs) => pg.evaluate(async ([bed, waitMs]) => {
    openEditModal(pid(patients[0])); document.getElementById('mf-cama').value = bed; saveModal();
    await new Promise(r => setTimeout(r, waitMs));
    return { online: navigator.onLine, cama: patients[0].cama, q: outboxLoad().filter(x => x.type === 'patient').map(x => x.patient.cama) };
  }, [bed, waitMs]);
  const stateOf = (pg) => pg.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return { cama: patients[0].cama, lsCama: ls[0] && ls[0].cama, uiBed: (document.querySelector('.card-bed') || {}).textContent, qPt: outboxLoad().filter(x => x.type === 'patient').length };
  });
  patches.length = 0;
  failPatch = true;
  const o10a = await editBed(page2, '3-109', 1500);   // PATCH + reintento de 300 ms fallan → cola
  await page2.waitForTimeout(4500);                    // el reintento de 4 s también falla
  const o10q = await page2.evaluate(() => outboxLoad().filter(x => x.type === 'patient').map(x => x.patient.cama));
  failPatch = false;                                   // vuelve la red SIN evento 'online'
  const o10b = await editBed(page2, '3-111', 1200);    // 2.ª edición: sube
  const o10rt = await page2.evaluate(() => {           // eco de Realtime de la 2.ª edición
    _suppressRealtimeKeys.clear();
    handlePatientChange({ eventType: 'UPDATE', new: { id: 'a1', cama: '3-111', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' }, old: { id: 'a1' } });
    return { cama: patients[0].cama };
  });
  await page2.evaluate(() => flushOutbox());           // el flush periódico (30 s) adelantado
  const o10 = await stateOf(page2);
  const okPatches10 = patches.filter(p => !p.failed && /\/rest\/v1\/patients/.test(p.url)).map(p => p.body && p.body.cama);
  check('O10 red intermitente: la 1.ª cama (3-109) no sube y queda en la cola; la 2.ª (3-111) sube y saca a la 1.ª de la cola; ni el eco de Realtime ni el flush la regresan a 3-109 (tarjeta, localStorage y nube en 3-111)',
    o10a.online && o10q.length === 1 && o10q[0] === '3-109' && o10b.cama === '3-111' && o10b.q.length === 0 && o10rt.cama === '3-111'
    && o10.cama === '3-111' && o10.lsCama === '3-111' && o10.uiBed === '3-111' && o10.qPt === 0 && okPatches10.length >= 1 && okPatches10.every(c => c === '3-111') && remotePatient.cama === '3-111',
    JSON.stringify({ o10a, o10q, o10b, o10rt, o10, okPatches10, remote: remotePatient.cama }));

  // 11) El reintento de 4 s de un guardado que falló no sube el objeto VIEJO encima de una edición posterior.
  patches.length = 0;
  failPatch = true;
  const o11a = await editBed(page2, '3-113', 800);     // falla → cola; el reintento de 4 s queda programado
  failPatch = false;
  const o11b = await editBed(page2, '3-115', 800);     // antes de los 4 s: 2.ª edición, sube
  await page2.waitForTimeout(4500);                    // corre el reintento de 4 s de la 1.ª
  const o11 = await stateOf(page2);
  const okPatches11 = patches.filter(p => !p.failed && /\/rest\/v1\/patients/.test(p.url)).map(p => p.body && p.body.cama);
  check('O11 el reintento de 4 s de la 1.ª edición (3-113) sube la fila VIGENTE (3-115), no la de hace 4 s: tarjeta, localStorage y nube en 3-115 y cola vacía',
    o11a.q.length === 1 && o11a.q[0] === '3-113' && o11b.cama === '3-115' && o11.cama === '3-115' && o11.lsCama === '3-115' && o11.uiBed === '3-115' && o11.qPt === 0
    && okPatches11.length >= 1 && okPatches11.every(c => c === '3-115') && remotePatient.cama === '3-115',
    JSON.stringify({ o11a, o11b, o11, okPatches11, remote: remotePatient.cama }));

  // 12) Sin red se cambia SOLO el estado (select en línea) mientras la hoja mueve al paciente de cama en la nube: al
  //     volver la red el ítem lleva solo `estado` y NO regresa la cama vieja (con el ítem de fila completa sí la regresaba).
  offline = true; await page2.context().setOffline(true); await page2.waitForTimeout(400);
  const o12a = await page2.evaluate(async () => {
    inlineEstado({ dataset: { pk: pid(patients[0]) }, value: 'GRAVE', style: {} });
    await new Promise(r => setTimeout(r, 1500));
    const it = outboxLoad().find(x => x.type === 'patient');
    return { online: navigator.onLine, estado: patients[0].estado, cama: patients[0].cama, dirty: it ? it.dirty : 'sin ítem' };
  });
  remotePatient.cama = '3-121';                        // la hoja lo movió mientras este iPad no tenía red
  patches.length = 0;
  offline = false; await page2.context().setOffline(false);
  await page2.waitForTimeout(6500);
  const o12 = await page2.evaluate(() => ({ cama: patients[0].cama, estado: patients[0].estado, qPt: outboxLoad().filter(x => x.type === 'patient').length }));
  const okPatches12 = patches.filter(p => !p.failed && /\/rest\/v1\/patients/.test(p.url)).map(p => p.body && (p.body.cama + '|' + p.body.estado));
  check('O12 estado cambiado sin red: el ítem lleva solo ["estado"]; al volver la red sube GRAVE sin regresar la cama que la hoja cambió en la nube (3-121)',
    !o12a.online && o12a.estado === 'GRAVE' && Array.isArray(o12a.dirty) && o12a.dirty.join() === 'estado'
    && o12.cama === '3-121' && o12.estado === 'GRAVE' && o12.qPt === 0 && okPatches12.length >= 1 && okPatches12.every(s => s === '3-121|GRAVE' || s === 'undefined|GRAVE') && remotePatient.cama === '3-121',
    JSON.stringify({ o12a, o12, okPatches12, remote: remotePatient.cama }));

  // 13) version.json (aviso de versión nueva, 20 oct 2026) va SIEMPRE a la red: el service worker no lo guarda ni lo
  //     sirve de su caché (con el cache-first de los assets el aviso nunca vería una versión nueva) y sin red falla (la
  //     app entonces no avisa nada). La caché es la de esta versión del SW (pisolibro-v12), sin restos de la anterior.
  let verBody = { v: 'aaa1111' };
  await context.route('**/version.json*', (r) => offline ? r.abort('internetdisconnected') : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(verBody) }));
  const o13a = await page2.evaluate(async () => { const r = await fetch('./version.json', { cache: 'no-store' }); return { ctrl: !!navigator.serviceWorker.controller, v: (await r.json()).v }; });
  verBody = { v: 'bbb2222' };
  const o13b = await page2.evaluate(async () => {
    const v = (await (await fetch('./version.json', { cache: 'no-store' })).json()).v;
    const v2 = (await (await fetch('./version.json?ts=' + Date.now(), { cache: 'no-store' })).json()).v;
    const names = await caches.keys(); let cached = 0;
    for (const n of names) { const c = await caches.open(n); cached += (await c.keys()).filter(q => /version\.json/.test(q.url)).length; }
    return { v, v2, cached, names };
  });
  offline = true; await page2.context().setOffline(true); await page2.waitForTimeout(300);
  const o13c = await page2.evaluate(async () => { try { const r = await fetch('./version.json', { cache: 'no-store' }); return { failed: false, status: r.status }; } catch (e) { return { failed: true }; } });
  offline = false; await page2.context().setOffline(false);
  // WebKit (20 oct 2026): context.route no intercepta lo que el service worker deja pasar sin respondWith; ahí llega el
  // version.json real del servidor en las tres lecturas (no 'aaa1111'/'bbb2222'). Es del arnés, no de la app: en WebKit
  // se comprueba lo demás (nada en la caché, caché v12 sola, sin red falla) y se informa.
  const o13Ruta = o13a.v === 'aaa1111' && o13b.v === 'bbb2222' && o13b.v2 === 'bbb2222';
  const o13WebkitSinRuta = BROWSER === 'webkit' && !!o13a.v && o13a.v !== 'aaa1111' && o13b.v === o13a.v && o13b.v2 === o13a.v;
  if (o13WebkitSinRuta) console.log('INFO O13 (WebKit): la ruta no intercepta version.json pedido desde la página controlada por el service worker (llegó el del servidor, «' + o13a.v + '»); se comprobó lo demás');
  check('O13 version.json siempre a la red: con el service worker controlando la página cada petición trae lo publicado (aunque sea la misma URL), nada de version.json en la caché, sin red falla (no se sirve copia guardada) y la caché es pisolibro-v12 sola',
    o13a.ctrl && (o13Ruta || o13WebkitSinRuta) && o13b.cached === 0 && o13b.names.includes('pisolibro-v12') && o13b.names.filter(n => /^pisolibro-v/.test(n)).length === 1 && o13c.failed,
    JSON.stringify({ o13a, o13b, o13c }));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-OFFLINE: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  server.closeAllConnections(); server.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
