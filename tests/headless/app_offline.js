// Abrir sin red y sin perder nada (oct 2026): service worker con copia de la app, sesión guardada sin
// red, texto escrito sin conexión que sobrevive a recargar y se sube al volver la red sin que la
// copia remota lo pise, y el botón ↩ Regresar.
//   node tests/headless/app_offline.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
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
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  let offline = false;
  const posts = [];
  const remoteNote = { patient_id: 'a1', app: '', pa: '', drenajes: '', qx: '', manejo: '', sangrado: '', sv: '', balance: '', pendientes: 'PEND REMOTO', checklist: {}, lab_history: [], imagen_history: [] };
  // context.route también cubre peticiones que pasan por el service worker (Chromium)
  await context.route('**/rest/v1/**', async (route) => {
    if (offline) return route.abort('internetdisconnected');
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' }]); return json(201, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') return json(200, [remoteNote]);
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      posts.push(body); return json(201, [{ patient_id: 'a1' }]);
    }
    return json(m === 'GET' ? 200 : 201, m === 'GET' ? [] : [{ id: 1 }]);
  });
  await context.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };

  // 1) Con red: arranca, instala el service worker y guarda la app + supabase-js en caché
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(4000);
  const o1 = await page.evaluate(async () => {
    const t0 = Date.now(); let doc = null, lib = null, sw = null;
    while (Date.now() - t0 < 15000) {
      try { sw = await navigator.serviceWorker.getRegistration(); const c = await caches.open('pisolibro-v9'); doc = await c.match('./'); lib = await c.match('./vendor/supabase-2.46.1.js'); } catch (e) {}
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

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-OFFLINE: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
