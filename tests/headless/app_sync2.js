// 🔄 Sincronización y datos (lote C, 27 oct 2026). Pacientes ficticios.
// · alta desde otro iPad con cambios sin subir → Papelera («cambios de este iPad sin subir»); nota huérfana en la cola idem;
// · «No olvidar»: el aviso entre iPads ya no impone la lista del emisor; se baja de la nube conservando lo creado sin red;
// · reconexión de los canales → recarga completa; aviso recortado (>1 MB) → fila completa; día del procedimiento fijo;
// · críticos reconocidos con quién y hora; indicador del robot; antigüedad de los datos sin red; notas de egresados;
// · nombres parecidos; cama ocupada; dos personas en la misma caja; nota postquirúrgica de otro paciente; labs imposibles;
// · Tablero compartido; tamaño de letra; altas programadas viejas fuera de la Entrega; motivo del egreso.
// node tests/headless/app_sync2.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Uno');
  window.__alerts=[]; window.prompt=function(){ return window.__promptAnswer === undefined ? null : window.__promptAnswer; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  window.__sent=[]; window.__subs=[];
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(cb){ if (typeof cb === 'function') window.__subs.push(cb); return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(p){ window.__sent.push(p); return Promise.resolve('ok'); } };
  window.__chans=[]; window.__rtAuth=[];
  window.supabase={ createClient:()=>({ auth, channel:(name, opts)=>{ window.__chans.push({ name, opts: opts || null, auth: window.__rtAuth.length }); return chan; }, realtime:{ setAuth(t){ window.__rtAuth.push(t); } }, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const hace = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const store = {
  patients: [
    { id: 's1', cama: '3-301', exp: '26-70001', nombre: 'JUAN PEREZ SOTO', esp: 'CG', edad: '50', estado: 'ESTABLE' },
    { id: 's2', cama: '3-302', exp: '26-70002', nombre: 'PEDRO PEREZ LUNA', esp: 'CG', edad: '61', estado: 'ESTABLE' },
    { id: 's3', cama: '3-303', exp: '26-70003', nombre: 'MARIA LOPEZ RUIZ', esp: 'CG', edad: '40', estado: 'ESTABLE' },
  ],
  noteFull: { patient_id: 's1', app: 'APP COMPLETO', pa: '', drenajes: '', qx: '', manejo: '', sangrado: '', sv: '', balance: '', pendientes: 'PENDIENTE COMPLETO DE LA NUBE', checklist: {}, lab_history: [], imagen_history: [], updated_at: new Date().toISOString() },
  noOlvidar: [{ id: 11, texto: 'NUBE 1', author: 'A', fecha: '2026-10-27', done: false, created_at: new Date().toISOString() }],
  config: {},
  match: [{ checked_at: hace(1) }],
  rpc: [],
};
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body, t: Date.now() });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, store.patients) : json(200, [{}]);
    if (url.startsWith('/rest/v1/notes')) {
      // Desde S20 la nota de s1 se guarda como en la base real (lo que sube un iPad es lo que relee el otro).
      if (m !== 'GET' && store.persistirNotas) [].concat(body || []).forEach((r) => { if (r && r.patient_id === 's1') Object.keys(r).forEach((f) => { if (f !== 'patient_id') store.noteFull[f] = r[f]; }); });
      if (m === 'GET' && /patient_id=eq\.s1/.test(url)) return json(200, [store.noteFull]);
      return m === 'GET' ? json(200, []) : json(201, [{}]);
    }
    if (url.startsWith('/rest/v1/no_olvidar')) return m === 'GET' ? json(200, store.noOlvidar) : json(201, [{ id: 99 }]);
    if (url.startsWith('/rest/v1/config')) {
      if (m === 'GET') { const k = (/key=eq\.([^&]+)/.exec(url) || [])[1]; return json(200, store.config[k] ? [{ value: store.config[k] }] : []); }
      if (body && body.key) store.config[body.key] = body.value; return json(201, [{}]);
    }
    if (url.startsWith('/rest/v1/winlab_match')) return json(200, store.match);
    if (url.startsWith('/rest/v1/archive')) return m === 'POST' ? json(201, [{ id: 501 }]) : json(200, []);
    if (url.startsWith('/rest/v1/winlab_cultivos')) return store.cultivos500 ? json(500, { code: '57014', message: 'canceling statement due to statement timeout' }) : json(200, store.cultivos || []);
    if (url.startsWith('/rest/v1/rpc/archive_set_egreso')) { store.rpc.push(body); return json(200, store.rpcFalla ? 'no-encontrado' : 'ok'); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3, null, { timeout: 30000 });
  await page.waitForTimeout(3000);
  const t0 = Date.now();

  // ── S1: alta desde otro iPad con cambios sin subir ──
  const s1 = await page.evaluate(async () => {
    const p = patients.find(x => x._supa_id === 's3'); const k = pid(p);
    updateField(k, 'pendientes', 'ESCRITO AQUI SIN SUBIR');   // el guardado está programado (aún no sube)
    const antes = archivados.length;
    handlePatientChange({ eventType: 'DELETE', old: { id: 's3' } });
    await new Promise(r => setTimeout(r, 400));
    const a = archivados[0] || {};
    return { quitado: !patients.some(x => x._supa_id === 's3'), nuevo: archivados.length === antes + 1, etiqueta: (a._note || {})._egreso || '', pend: (a._note || {}).pendientes, aviso: (document.querySelector('[data-testid="aviso-alta-remota"]') || {}).textContent || '' };
  });
  const s1post = calls.some(c => c.m === 'POST' && c.url.startsWith('/rest/v1/archive') && JSON.stringify(c.body || {}).includes('ESCRITO AQUI SIN SUBIR'));
  check('S1 alta desde otro iPad: lo que este iPad no había subido va a la Papelera (local y nube) como «CAMBIOS DE ESTE iPad SIN SUBIR» y sale un aviso',
    s1.quitado && s1.nuevo && /CAMBIOS DE ESTE iPad SIN SUBIR/.test(s1.etiqueta) && s1.pend === 'ESCRITO AQUI SIN SUBIR' && /Papelera/.test(s1.aviso) && s1post, JSON.stringify({ s1, s1post }));

  // ── S2: nota huérfana en la cola al volver la red ──
  const s2 = await page.evaluate(async () => {
    const antes = archivados.length;
    outboxSave([{ type: 'note', key: 'pt-26-79999-3-399', data: Object.assign(defaultData(), { pendientes: 'NOTA HUERFANA' }), who: { nombre: 'JOSE NADIE DIAZ', exp: '26-79999', cama: '3-399' }, ts: Date.now() }]);
    await flushOutbox();
    const a = archivados[0] || {};
    return { nuevo: archivados.length === antes + 1, pend: (a._note || {}).pendientes, cama: a.cama, cola: outboxLoad().length };
  });
  check('S2 nota en la cola de un paciente que ya no está en el censo: ya no se tira, va a la Papelera y sale de la cola',
    s2.nuevo && s2.pend === 'NOTA HUERFANA' && s2.cama === '3-399' && s2.cola === 0, JSON.stringify(s2));

  // ── S2b: el rescate no se repite (30 oct 2026: un iPad viejo dejó 30 copias iguales de la misma persona) ──
  const s2b = await page.evaluate(async () => {
    const k = 'pt-26-79998-3-398', who = { nombre: 'ANA NADIE ROJO', exp: '26-79998', cama: '3-398' };
    const d = Object.assign(defaultData(), { pendientes: 'NOTA HUERFANA 2' });
    noteData[k] = d; _pendingDirty[k] = new Set(['pendientes']); _pendingPush.add(k); _dirtyFields[k] = new Set(['pendientes']);
    const antes = archivados.length;
    outboxSave([{ type: 'note', key: k, data: JSON.parse(JSON.stringify(d)), dirty: ['pendientes'], who, ts: Date.now() }]);
    await flushOutbox();
    const tras1 = archivados.length - antes;
    persistBeforeExit();                                   // al ocultar la app: antes la volvía a encolar
    const cola1 = outboxLoad().filter(i => i.key === k).length;
    const sucio = !!(_pendingDirty[k] || _dirtyFields[k] || _inflightDirty[k] || _pendingPush.has(k));
    // Otra pestaña que aún la tenía pendiente la encola otra vez (con otro meta de autor/hora): no hay copia nueva.
    outboxEnqueue({ type: 'note', key: k, data: Object.assign(JSON.parse(JSON.stringify(d)), { __pl_note_meta: { by: { pendientes: { i: 'XX', t: Date.now() } } } }), dirty: ['pendientes'], who });
    await flushOutbox();
    const tras2 = archivados.length - antes;
    // Con contenido distinto sí es otra copia.
    outboxEnqueue({ type: 'note', key: k, data: Object.assign(JSON.parse(JSON.stringify(d)), { pendientes: 'OTRA COSA DISTINTA' }), dirty: ['pendientes'], who });
    await flushOutbox();
    return { tras1, cola1, sucio, tras2, tras3: archivados.length - antes, cola: outboxLoad().length, huellas: Object.keys(JSON.parse(localStorage.getItem('pl_rescates') || '{}')).length };
  });
  await page.waitForTimeout(600);
  const s2bPosts = (t) => calls.filter(c => c.m === 'POST' && c.url.startsWith('/rest/v1/archive') && JSON.stringify(c.body || {}).includes(t)).length;
  check('S2b el rescate de la cola se archiva una sola vez: se olvidan sus pendientes (ocultar la app ya no la re-encola) y otra copia igual no se archiva; con otro contenido, sí',
    s2b.tras1 === 1 && s2b.cola1 === 0 && !s2b.sucio && s2b.tras2 === 1 && s2b.tras3 === 2 && s2b.cola === 0 && s2bPosts('NOTA HUERFANA 2') === 1 && s2bPosts('OTRA COSA DISTINTA') === 1 && s2b.huellas >= 3,
    JSON.stringify({ s2b, p1: s2bPosts('NOTA HUERFANA 2'), p2: s2bPosts('OTRA COSA DISTINTA') }));

  // ── S2c: una sola pestaña sube la cola a la vez (Web Locks) ──
  const s2c = await page.evaluate(async () => {
    if (!(navigator.locks && navigator.locks.request)) return { sinLocks: true };
    let soltar; await new Promise(r => navigator.locks.request('pl-outbox-flush', () => new Promise(s => { soltar = s; r(); })));
    outboxSave([{ type: 'rest', key: 'proc|delete|999', method: 'DELETE', table: 'procedimientos_dia', match: 'id=eq.999', ts: Date.now() }]);
    await flushOutbox();
    const conCandado = outboxLoad().length;
    soltar();
    await new Promise(r => setTimeout(r, 4000));
    return { conCandado, despues: outboxLoad().length };
  });
  check('S2c con el candado en manos de otra pestaña esta no sube la cola; al soltarlo, la sube sola a los 3 s',
    s2c.conCandado === 1 && s2c.despues === 0, JSON.stringify(s2c));

  // ── S3: «No olvidar» ──
  const s3 = await page.evaluate(async () => {
    lsSaveNoOlvidar([{ id: 'tmp-1', _tempId: true, texto: 'CREADO SIN RED', author: 'T', fecha: '2026-10-27', done: false }, { id: 50, texto: 'VIEJA DE ESTE IPAD', author: 'T', fecha: '2026-10-20', done: false }]);
    await _recargarListasCompartidas();
    const lista = lsGetNoOlvidar().map(i => i.texto);
    const n0 = window.__sent.length; syncNoOlvidarBroadcast([{ id: 1 }]);
    const env = window.__sent.slice(n0).map(x => x.payload);
    return { lista, env };
  });
  check('S3 «No olvidar»: se baja de la nube (gana la nube) conservando lo creado sin red; el aviso entre iPads ya no lleva la lista',
    JSON.stringify(s3.lista) === JSON.stringify(['CREADO SIN RED', 'NUBE 1']) && s3.env.length === 1 && !('items' in s3.env[0]), JSON.stringify(s3));

  // ── S4: reconexión → recarga completa ──
  const n4 = calls.length;
  await page.evaluate(() => { _rtHuboCaida = true; window.__subs.forEach(cb => { try { cb('SUBSCRIBED'); } catch (_) {} }); });
  await page.waitForTimeout(3200);
  const s4 = calls.slice(n4).filter(c => c.m === 'GET').map(c => c.url.split('?')[0]);
  check('S4 los canales en vivo vuelven después de una caída: una recarga completa (censo, notas, «No olvidar», procedimientos), no una por canal',
    s4.filter(u => u === '/rest/v1/patients').length === 1 && s4.includes('/rest/v1/no_olvidar') && s4.includes('/rest/v1/procedimientos_dia'), JSON.stringify(s4));

  // ── S4b (22 nov 2026, cuota de Supabase): el canal en vivo cayéndose y volviendo cada pocos segundos ya no recarga todo
  //    cada vez. Entre dos recargas automáticas pasan al menos 3 min; la que llega antes queda UNA sola, diferida. ──
  const n4b = calls.length;
  await page.evaluate(() => { for (let i = 0; i < 3; i++) { _rtHuboCaida = true; window.__subs.forEach(cb => { try { cb('SUBSCRIBED'); } catch (_) {} }); } });
  await page.waitForTimeout(3200);
  await page.evaluate(() => _recargaCompleta('periódica'));
  const s4b = { pts: calls.slice(n4b).filter(c => c.m === 'GET' && c.url.split('?')[0] === '/rest/v1/patients').length,
    diferida: await page.evaluate(() => !!_recargaDiferida), min: await page.evaluate(() => PL_RECARGA_MIN_MS) };
  check('S4b reconexiones seguidas: ninguna recarga completa antes de 3 min de la anterior (queda una diferida)',
    s4b.pts === 0 && s4b.diferida && s4b.min >= 180000, JSON.stringify(s4b));
  // Pasado el plazo, la diferida corre una sola vez.
  const n4c = calls.length;
  await page.evaluate(() => { _lastVisibleRefreshTs -= PL_RECARGA_MIN_MS; clearTimeout(_recargaDiferida); _recargaDiferida = null; return _recargaCompleta('reconexión (diferida)'); });
  await page.waitForTimeout(1500);
  const s4c = calls.slice(n4c).filter(c => c.m === 'GET' && c.url.split('?')[0] === '/rest/v1/patients').length;
  check('S4c cumplido el plazo, la recarga corre (una vez)', s4c === 1, JSON.stringify({ s4c }));

  // ── S5: aviso en vivo recortado (>1 MB) ──
  const s5 = await page.evaluate(async () => {
    const k = pid(patients.find(x => x._supa_id === 's1'));
    handleNoteChange({ eventType: 'UPDATE', commit_timestamp: new Date().toISOString(), errors: null, new: { patient_id: 's1', app: 'APP COMPLETO', updated_at: new Date().toISOString() } });
    await new Promise(r => setTimeout(r, 600));
    return { pend: getNote(k).pendientes, app: getNote(k).app };
  });
  check('S5 aviso en vivo recortado (nota de más de 1 MB: faltan columnas): se baja la fila completa en vez de vaciar las cajas',
    s5.pend === 'PENDIENTE COMPLETO DE LA NUBE' && s5.app === 'APP COMPLETO', JSON.stringify(s5));

  // ── S6: día del procedimiento ──
  const s6 = await page.evaluate(() => {
    const ayer = new Date(Date.now() - 86400e3); const z = n => String(n).padStart(2, '0');
    const dAyer = ayer.getFullYear() + '-' + z(ayer.getMonth() + 1) + '-' + z(ayer.getDate());
    return { dAyer, fijo: _procDia({ fecha_dia: '2026-10-20' }), porHora: _procToRow({ nombre: 'X', _addedAt: ayer.toISOString() }).fecha_dia, sinNada: _procDia({}) === todayStr() };
  });
  check('S6 procedimientos: el día se fija al crearlo y no cambia al editar o subir después de medianoche', s6.fijo === '2026-10-20' && s6.porHora === s6.dAyer && s6.sinNada, JSON.stringify(s6));

  // ── S7: crítico reconocido con quién y hora ──
  const s7 = await page.evaluate(() => {
    const k = pid(patients.find(x => x._supa_id === 's1')); const nd = getNote(k);
    nd.labHistory = [{ fecha: todayStr(), labs: { k: '6.4', hb: '11' } }]; noteData[k] = nd;
    ackCriticalLabs(k);
    const a = (getNote(k).checklist._labAcks || {}).k || {};
    return { by: a.by, by_name: a.by_name, linea: renderLabGuardianBanner(getNote(k), k) };
  });
  check('S7 reconocer un crítico guarda quién (iniciales y nombre) y la tarjeta muestra «K 6.4 ✓ TU hh:mm»',
    s7.by === 'TU' && s7.by_name === 'Tester Uno' && /Reconocidos: K 6\.4 ✓ TU \d\d:\d\d/.test(s7.linea), JSON.stringify(s7));

  // ── S8: indicador del robot ── (la corrida «de hace 1 h» cae AYER si la suite corre entre las 00:00 y la 01:00: también vale)
  const s8a = await page.evaluate(async () => {
    const prog = window._wlUltimaProgramada(Date.UTC(2026, 9, 27, 15, 0)).toISOString();
    await window.checkScraperStatus();
    const b = document.getElementById('winlab-autosync-btn');
    return { prog, txt: b.textContent, st: b.getAttribute('data-scraper-status'), dot: !!document.getElementById('scraper-status-dot') };
  });
  store.match = [{ checked_at: hace(30) }];
  const s8b = await page.evaluate(async () => { await window.checkScraperStatus(); const b = document.getElementById('winlab-autosync-btn'); return { txt: b.textContent, st: b.getAttribute('data-scraper-status'), title: b.title }; });
  store.match = [{ checked_at: hace(1) }];
  check('S8 indicador del robot: dice la última corrida («Robot: hoy hh:mm», verde) y se pone en rojo con ⚠ si no corrió a la hora programada (05:00, 12:30, 20:07 + 2 h); ya no lo borra «Auto ON»',
    s8a.prog === '2026-10-27T11:00:00.000Z' && /Robot: (hoy|ayer) \d\d:\d\d/.test(s8a.txt) && s8a.st === 'fresh' && s8a.dot && /⚠/.test(s8b.txt) && s8b.st === 'error' && /No corrió/.test(s8b.title), JSON.stringify({ s8a, s8b }));

  // ── S9: sin red, de cuándo son los datos ──
  const s9 = await page.evaluate(() => {
    localStorage.setItem('pl_last_supabase_sync_ts', String(Date.now() - 3 * 3600e3));
    setSyncStatus('offline', 'Sin conexión');
    const lbl = document.getElementById('sync-label').textContent, cls = document.getElementById('sync-status').className;
    const banner = (document.getElementById('pl-datos-viejos') || {}).textContent || '';
    setSyncStatus('synced', '✅ Guardado');
    return { lbl, cls, banner, quitado: !document.getElementById('pl-datos-viejos') };
  });
  check('S9 sin red: la barra dice de cuándo son los datos («datos de hoy hh:mm»), en rojo y con aviso si tienen más de 2 h; al sincronizar se quita',
    /Sin conexión · datos de (hoy|ayer) \d\d:\d\d/.test(s9.lbl) && /viejo/.test(s9.cls) && /hace 3 h/.test(s9.banner) && s9.quitado, JSON.stringify(s9));

  // ── S10: notas de pacientes que ya no están ──
  const s10 = await page.evaluate(() => {
    localStorage.setItem('note-pt-26-11111-3-311', JSON.stringify({ pendientes: 'X' }));
    const b1 = _limpiarNotasHuerfanas(); const sigue1 = !!localStorage.getItem('note-pt-26-11111-3-311');
    const v = JSON.parse(localStorage.getItem('pl_notas_huerfanas_v1')); v['pt-26-11111-3-311'] = Date.now() - 25 * 3600e3; localStorage.setItem('pl_notas_huerfanas_v1', JSON.stringify(v));
    const b2 = _limpiarNotasHuerfanas(); const sigue2 = !!localStorage.getItem('note-pt-26-11111-3-311');
    const vivas = patients.every(p => !!localStorage.getItem('note-' + pid(p)) || true);
    return { b1, sigue1, b2, sigue2, vivas };
  });
  check('S10 memoria del iPad: la nota de un paciente que ya no está se borra después de 24 h fuera del censo (no antes)',
    s10.b1 === 0 && s10.sigue1 && s10.b2 === 1 && !s10.sigue2, JSON.stringify(s10));

  // ── S11 + S12: nombres parecidos, cama ocupada ──
  const s11 = await page.evaluate(() => {
    const p1 = patients.find(x => x._supa_id === 's1'), p2 = patients.find(x => x._supa_id === 's2');
    const card = renderFullCard(p1, getNote(pid(p1)), pid(p1));
    const a0 = window.__alerts.length; window.__promptAnswer = '3-302';
    promptChangeBed(pid(p1)); window.__promptAnswer = undefined;
    return { badge: /Apellido igual: 3-302/.test(card), cama: p1.cama, alerta: window.__alerts.slice(a0).join(' | ') };
  });
  check('S11 nombres parecidos: la tarjeta avisa «👥 Apellido igual: 3-302»', s11.badge, JSON.stringify(s11));
  check('S12 mover a una cama ocupada: avisa quién la ocupa y no cambia nada (antes se atoraba en la cola sin explicación)',
    s11.cama === '3-301' && /la ocupa PEDRO PEREZ LUNA/.test(s11.alerta), JSON.stringify(s11));

  // ── S13: dos personas en la misma caja ──
  const s13 = await page.evaluate(async () => {
    const p = patients.find(x => x._supa_id === 's2'); const k = pid(p);
    const base = { patient_id: 's2', app: '', pa: '', drenajes: '', qx: '', manejo: '', sangrado: '', sv: '', balance: '', pendientes: 'BASE', checklist: {}, lab_history: [], imagen_history: [], updated_at: new Date().toISOString() };
    _noteBaselineSet('s2', base); const nd = getNote(k); nd.pendientes = 'BASE'; noteData[k] = nd;
    updateField(k, 'pendientes', 'BASE\nLO MIO');   // en edición aquí
    handleNoteChange({ eventType: 'UPDATE', new: Object.assign({}, base, { pendientes: 'BASE\nDEL COLEGA', updated_by: 'Dra Colega' }) });
    const html = renderConflictosCaja(k);
    const local = getNote(k).pendientes;
    unirConflictoCaja(k, 'pendientes');
    return { html, local, unido: getNote(k).pendientes, despues: renderConflictosCaja(k) };
  });
  check('S13 dos personas en la misma caja: aviso «Dra Colega cambió…» con Ver/Unir/Quedarme; lo de aquí no se pisa y «Unir» agrega sus renglones nuevos con su nombre',
    /Dra Colega/.test(s13.html) && /Unir las dos/.test(s13.html) && s13.local === 'BASE\nLO MIO' && s13.unido === 'BASE\nLO MIO\n— de Dra Colega:\nDEL COLEGA' && s13.despues === '', JSON.stringify(s13));

  // ── S14 + S15: nota de otro paciente, labs imposibles ──
  const s14 = await page.evaluate(() => {
    const p = patients.find(x => x._supa_id === 's1');
    return {
      otro: _cxNotaDeOtro({ paciente_nombre: 'ROBERTO GOMEZ DIAZ' }, p), mismo: _cxNotaDeOtro({ paciente_nombre: 'JUAN PEREZ' }, p),
      expOtro: _cxNotaDeOtro({ paciente_exp: '26-70009' }, p), expMismo: _cxNotaDeOtro({ paciente_exp: '2670001', paciente_nombre: 'X Y' }, p), nada: _cxNotaDeOtro({}, p),
      imposibles: _labsImposibles({ k: '50', hb: '9.1', na: '140', plaq: '0' }).map(x => x.key)
    };
  });
  check('S14 nota postquirúrgica: si el nombre o el expediente de la foto son de otro paciente no se llena nada; sin datos de identidad o coincidiendo, sí',
    s14.otro === 'ROBERTO GOMEZ DIAZ' && s14.mismo === '' && /expediente 26-70009/.test(s14.expOtro) && s14.expMismo === '' && s14.nada === '', JSON.stringify(s14));
  check('S15 labs leídos de foto/PDF: los imposibles (K 50, plaquetas 0) se descartan antes de pedir confirmación', JSON.stringify(s14.imposibles) === JSON.stringify(['plaq', 'k']), JSON.stringify(s14));

  // ── S16: Tablero compartido ──
  store.config.tablero_v1 = { altas: [{ id: 'r1', text: 'ALTA DE OTRO IPAD', done: false, createdAt: '2026-10-27T08:00:00Z', ts: 1 }], _borrados: {} };
  const s16 = await page.evaluate(async () => {
    localStorage.removeItem('pl_tablero_v1');
    setView('tablero');
    await new Promise(r => setTimeout(r, 700));
    const tras1 = JSON.parse(localStorage.getItem('pl_tablero_v1') || '{}');
    tableroAddItem('r1'); const local = JSON.parse(localStorage.getItem('pl_tablero_v1'));
    const nuevoId = (local.r1 || [])[0].id; tableroUpdateText('r1', nuevoId, 'PENDIENTE DE ESTE IPAD');
    tableroDeleteItem('altas', 'r1');
    await new Promise(r => setTimeout(r, 2000));
    setView('piso');
    return { bajo: ((tras1.altas || [])[0] || {}).text, nuevoId };
  });
  const nube = store.config.tablero_v1 || {};
  check('S16 📌 Tablero compartido: baja lo de otros iPads, sube lo de este (con hora por renglón) y un borrado deja marca para no resucitar',
    s16.bajo === 'ALTA DE OTRO IPAD' && (nube.r1 || []).some(i => i.text === 'PENDIENTE DE ESTE IPAD' && i.ts > 0) && !(nube.altas || []).some(i => i.id === 'r1') && !!(nube._borrados || {}).r1, JSON.stringify({ s16, nube }));

  // ── S16b (19 nov 2026): quién escribió cada renglón del Tablero ──
  // Renglones que ya bajaron de otro iPad (la bajada se limita a una cada 20 s y S16 acaba de hacerla): copia local y nube iguales.
  const T16b = { altas: [{ id: 'v1', text: 'RENGLON VIEJO SIN AUTOR', done: false, createdAt: '2026-10-27T08:00:00Z', ts: 1 },
    { id: 'x1', text: 'DE OTRO IPAD', done: false, createdAt: '2026-10-27T08:00:00Z', ts: 2, by: '<img src=x onerror=window.__xss=1>', bt: 1763550000000 }], _borrados: {} };
  store.config.tablero_v1 = JSON.parse(JSON.stringify(T16b));
  const s16b = await page.evaluate(async (T) => {
    localStorage.setItem('pl_tablero_v1', JSON.stringify(T));
    window.__xss = 0;
    setView('tablero');
    await new Promise(r => setTimeout(r, 700));
    renderTablero();
    const chipDe = (id) => { const li = document.querySelector('#view-tablero [data-item-id="' + id + '"]'); const c = li && li.querySelector('.t-by'); return c ? c.textContent : null; };
    const viejo = chipDe('v1'), otro = chipDe('x1'), imgs = document.querySelectorAll('#view-tablero .t-by img').length;
    tableroAddItem('postqx');
    let d = JSON.parse(localStorage.getItem('pl_tablero_v1')); const id = d.postqx[d.postqx.length - 1].id;
    const alCrear = { by: d.postqx[d.postqx.length - 1].by, bt: d.postqx[d.postqx.length - 1].bt };
    tableroUpdateText('postqx', id, 'REVISAR NOTA POSTQX 3-301');
    d = JSON.parse(localStorage.getItem('pl_tablero_v1')); const tras = d.postqx.find(i => i.id === id);
    // Otra persona: solo lo toca (blur sin cambiar), lo palomea y lo mueve → el autor no cambia; si cambia el texto, sí.
    localStorage.setItem('pl_user_name', 'Otra Persona');
    tableroUpdateText('postqx', id, 'REVISAR NOTA POSTQX 3-301 ');
    tableroToggleDone('postqx', id);
    d = JSON.parse(localStorage.getItem('pl_tablero_v1')); const tocado = d.postqx.find(i => i.id === id);
    tableroUpdateText('postqx', id, 'REVISAR NOTA POSTQX 3-301 Y DE ENDOSCOPIA');
    d = JSON.parse(localStorage.getItem('pl_tablero_v1')); const editado = d.postqx.find(i => i.id === id);
    localStorage.setItem('pl_user_name', 'Tester Uno');
    renderTablero();
    const chipNuevo = chipDe(id);
    // Un renglón vacío (recién agregado, sin texto) no muestra autor.
    tableroAddItem('r1'); renderTablero();
    d = JSON.parse(localStorage.getItem('pl_tablero_v1')); const vacioId = d.r1[d.r1.length - 1].id;
    const chipVacio = chipDe(vacioId);
    await new Promise(r => setTimeout(r, 1800));
    setView('piso');
    return { viejo, otro, imgs, xss: window.__xss, alCrear, tras: { by: tras.by, bt: tras.bt > 0 }, tocado: { by: tocado.by, done: tocado.done }, editado: editado.by, chipNuevo, chipVacio, id };
  }, T16b);
  const nube16b = store.config.tablero_v1 || {};
  check('S16b ✍️ Tablero: cada renglón dice quién lo escribió (primer nombre y hora); tocarlo, palomearlo o moverlo no cambia el autor; cambiar el texto sí; los viejos sin autor y los vacíos no muestran nada; el nombre llega escapado y sube a la nube con el renglón',
    s16b.viejo === null && /^✍️ <img src=x onerror=window.__xss=1> · \d\d\/\d\d \d\d:\d\d$/.test(s16b.otro || '') && s16b.imgs === 0 && s16b.xss === 0
    && s16b.alCrear.by === 'Tester' && s16b.alCrear.bt > 0 && s16b.tras.by === 'Tester' && s16b.tras.bt
    && s16b.tocado.by === 'Tester' && s16b.tocado.done === true && s16b.editado === 'Otra'
    && /^✍️ Otra · \d\d\/\d\d \d\d:\d\d$/.test(s16b.chipNuevo || '') && s16b.chipVacio === null
    && (nube16b.postqx || []).some(i => i.id === s16b.id && i.by === 'Otra' && i.bt > 0),
    JSON.stringify({ s16b, postqx: nube16b.postqx }));

  // ── S16c: tocar un renglón y salir (blur real) no cambia el autor ni el texto, aunque traiga saltos de línea o «&lt;» ──
  const s16c = await page.evaluate(async () => {
    const T = { altas: [{ id: 'z1', text: 'LINEA UNO\nLINEA DOS', done: false, createdAt: '2026-11-19T08:00:00Z', ts: 5, by: 'Luis', bt: 1763550000000 },
      { id: 'z2', text: 'usar &lt; y <b> tal cual', done: false, createdAt: '2026-11-19T08:01:00Z', ts: 6, by: 'Luis', bt: 1763550000000 }], _borrados: {} };
    localStorage.setItem('pl_tablero_v1', JSON.stringify(T));
    setView('tablero'); renderTablero(); await new Promise(r => setTimeout(r, 300));
    for (const id of ['z1', 'z2']) {
      const el = document.querySelector('#view-tablero [data-item-id="' + id + '"] .tablero-text');
      el.focus(); await new Promise(r => setTimeout(r, 30)); el.blur(); await new Promise(r => setTimeout(r, 120));
    }
    const d = JSON.parse(localStorage.getItem('pl_tablero_v1'));
    const z1 = d.altas.find(i => i.id === 'z1'), z2 = d.altas.find(i => i.id === 'z2');
    // Una cuenta sin nombre que SÍ cambia el texto: no se le atribuye a Luis.
    localStorage.setItem('pl_user_name', '');
    tableroUpdateText('altas', 'z2', 'texto cambiado sin nombre');
    const z2b = JSON.parse(localStorage.getItem('pl_tablero_v1')).altas.find(i => i.id === 'z2');
    localStorage.setItem('pl_user_name', 'Tester Uno');
    setView('piso');
    return { z1: { by: z1.by, bt: z1.bt }, z2: { by: z2.by, text: z2.text }, z2b: { by: z2b.by || null, bt: z2b.bt || null } };
  });
  check('S16c ✍️ Tablero: tocar un renglón y salir sin escribir no cambia su autor (ni con saltos de línea) ni su texto («&lt;» se queda tal cual); si alguien sin nombre cambia el texto, ya no se le atribuye al anterior',
    s16c.z1.by === 'Luis' && s16c.z1.bt === 1763550000000 && s16c.z2.by === 'Luis' && s16c.z2.text === 'usar &lt; y <b> tal cual' && s16c.z2b.by === null && s16c.z2b.bt === null, JSON.stringify(s16c));

  // ── S16d: pantalla vieja: otro iPad cambió el renglón (ya está en la copia local) y aquí solo lo tocan y salen →
  //    no se pisa lo del otro iPad ni cambia el autor; al repintar se ve lo nuevo ──
  const s16d = await page.evaluate(async () => {
    const T = { altas: [{ id: 'x9', text: 'TAC abdomen', done: false, createdAt: '2026-11-19T08:00:00Z', ts: 10, by: 'Carlos', bt: 1763550000000 }], _borrados: {} };
    localStorage.setItem('pl_tablero_v1', JSON.stringify(T));
    setView('tablero'); renderTablero(); await new Promise(r => setTimeout(r, 200));
    const d = JSON.parse(localStorage.getItem('pl_tablero_v1'));   // llega lo de Ana (como la fusión en segundo plano, sin repintar)
    Object.assign(d.altas[0], { text: 'TAC cancelada', by: 'Ana', bt: 1763560000000, ts: Date.now() });
    localStorage.setItem('pl_tablero_v1', JSON.stringify(d));
    const el = document.querySelector('#view-tablero [data-item-id="x9"] .tablero-text');
    const enPantalla = el.innerText;
    el.focus(); await new Promise(r => setTimeout(r, 30)); el.blur(); await new Promise(r => setTimeout(r, 200));
    const x = JSON.parse(localStorage.getItem('pl_tablero_v1')).altas[0];
    renderTablero();
    const ahora = document.querySelector('#view-tablero [data-item-id="x9"] .tablero-text').innerText;
    setView('piso');
    return { enPantalla, guardado: x.text, by: x.by, ahora };
  });
  check('S16d ✍️ Tablero con la pantalla vieja: tocar el renglón y salir no pisa lo que escribió otro iPad ni cambia el autor; al repintar se ve lo nuevo',
    s16d.enPantalla === 'TAC abdomen' && s16d.guardado === 'TAC cancelada' && s16d.by === 'Ana' && s16d.ahora === 'TAC cancelada', JSON.stringify(s16d));

  // ── S17 + S18: letra, altas viejas ──
  const s17 = await page.evaluate(() => {
    const v = () => getComputedStyle(document.documentElement).getPropertyValue('--pl-fs-scale').trim();
    const out = [];
    cambiarLetra(); out.push(v() + '|' + document.getElementById('pl-fs-btn').textContent);
    cambiarLetra(); out.push(v());
    cambiarLetra(); out.push(v());
    localStorage.setItem(ALTAS_KEY, JSON.stringify([{ id: 'a1', cama: '3-301', nombre: 'JUAN PEREZ SOTO', completado: false }, { id: 'a2', cama: '3-399', nombre: 'YA SE FUE', completado: false }]));
    setView('entrega');
    const txt = (document.getElementById('view-entrega') || document.body).textContent;
    setView('piso');
    return { out, alta: /JUAN PEREZ SOTO/.test(txt), vieja: /YA SE FUE/.test(txt) };
  });
  check('S17 🔠 Letra: normal → grande → más grande → normal (variable --pl-fs-scale)', s17.out[0] === '1.12|🔠 Letra: grande' && s17.out[1] === '1.25' && s17.out[2] === '1', JSON.stringify(s17));
  check('S18 Entrega: las altas programadas de pacientes que ya no están en el censo no se proyectan', !s17.vieja, JSON.stringify(s17));

  // ── S19: motivo del egreso (registro de pacientes para investigación) ──
  const n19 = calls.length;
  const s19a = await page.evaluate(async () => {
    const p = patients.find(x => x._supa_id === 's2'); const k = pid(p);
    openConfirm(k);
    const sel = document.querySelector('[data-testid="confirm-egreso-tipo"]'); const limpio = sel.value === '';
    sel.value = 'defuncion';
    document.getElementById('confirm-btn').click();
    await new Promise(r => setTimeout(r, 600));
    const a = archivados.find(x => x._archiveKey === k) || {};
    return { limpio, tipo: (a._note || {})._egreso_tipo, por: (a._note || {})._egreso_tipo_por, ts: (a._note || {})._egreso_tipo_ts, fuera: !patients.some(x => x._supa_id === 's2') };
  });
  const post19 = calls.slice(n19).find(c => c.m === 'POST' && c.url.startsWith('/rest/v1/archive') && (c.body || {}).note_data);
  check('S19a al dar de alta se elige el motivo (empieza vacío) y viaja en la copia de la Papelera con quién y hora UTC',
    s19a.limpio && s19a.fuera && s19a.tipo === 'defuncion' && s19a.por === 'Tester Uno' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s19a.ts || '') && post19 && post19.body.note_data._egreso_tipo === 'defuncion', JSON.stringify({ s19a, post: post19 && post19.body.note_data._egreso_tipo }));
  const s19b = await page.evaluate(async () => {
    archivados.unshift(
      { nombre: 'RETIRO SIN MOTIVO', cama: '3-310', exp: '26-70010', estado: 'ESTABLE', _archivedAt: new Date().toISOString(), _archiveKey: 'k10', _supaArchiveId: 'aaaa-10', _note: { _egreso: 'RETIRADO DEL CENSO (hoja)' } },
      { nombre: 'SIN SUBIR AUN', cama: '3-311', exp: '26-70011', estado: 'ESTABLE', _archivedAt: new Date().toISOString(), _archiveKey: 'k11', _note: { _egreso: 'EGRESO' } },
      { nombre: 'COPIA DE RESCATE', cama: '3-312', exp: '26-70012', _archivedAt: new Date().toISOString(), _archiveKey: 'k12', _supaArchiveId: 'aaaa-12', _note: { _egreso: 'CAMBIOS DE ESTE iPad SIN SUBIR (x)' } });
    renderPapelera();
    const banner = () => ((document.querySelector('[data-testid="egresos-sin-motivo"]') || {}).textContent || '');
    const antes = banner();
    const sel0 = document.querySelector('[data-testid="egreso-tipo-0"]'); sel0.value = 'alta'; await setEgresoTipo(0, sel0);
    const despues = banner();
    const sel1 = document.querySelector('[data-testid="egreso-tipo-1"]'); sel1.value = 'traslado'; await setEgresoTipo(1, sel1);
    const sel1b = document.querySelector('[data-testid="egreso-tipo-1"]');
    return { antes, despues, tipo0: archivados[0]._note._egreso_tipo, tipo1: archivados[1]._note._egreso_tipo || '', sel1: sel1b && sel1b.value,
      rescate: !document.querySelector('[data-testid="egreso-tipo-2"]'), alerta: window.__alerts.slice(-1)[0] || '' };
  });
  check('S19b Papelera: aviso de egresos sin motivo; elegir uno lo guarda en la nube (archive_set_egreso con id, tipo y quién) y el aviso baja',
    /egresos? sin motivo/.test(s19b.antes) && s19b.tipo0 === 'alta' && store.rpc.length === 1 && store.rpc[0].p_id === 'aaaa-10' && store.rpc[0].p_tipo === 'alta' && store.rpc[0].p_por === 'Tester Uno'
    && (parseInt(s19b.antes.replace(/\D+/g, ' ').trim(), 10) - 1 === (parseInt(s19b.despues.replace(/\D+/g, ' ').trim(), 10) || 0)), JSON.stringify({ s19b, rpc: store.rpc }));
  check('S19c sin copia en la nube todavía: no se guarda a medias (aviso y el selector vuelve); las copias de rescate no se clasifican',
    s19b.tipo1 === '' && s19b.sel1 === '' && /todavía no sube/.test(s19b.alerta) && s19b.rescate && store.rpc.length === 1, JSON.stringify(s19b));
  store.rpcFalla = true;
  const s19d = await page.evaluate(async () => {
    const sel = document.querySelector('[data-testid="egreso-tipo-0"]'); sel.value = 'defuncion'; await setEgresoTipo(0, sel);
    return { tipo: archivados[0]._note._egreso_tipo, sel: document.querySelector('[data-testid="egreso-tipo-0"]').value, alerta: window.__alerts.slice(-1)[0] || '' };
  });
  check('S19d si la nube no lo guarda, la app no lo da por guardado (sigue el motivo anterior y avisa)', s19d.tipo === 'alta' && s19d.sel === 'alta' && /No se pudo guardar el motivo/.test(s19d.alerta), JSON.stringify(s19d));

  // ── S20: ida y vuelta entre dos iPads en la misma caja: nada se duplica ni se borra ──
  // La base simulada guarda lo que sube este iPad; «el otro iPad» escribe directo en la base y manda su aviso en vivo.
  store.persistirNotas = true;
  const esperarCalma = () => page.evaluate(async () => { for (let i = 0; i < 120 && (_suppressRealtimeKeys.has('s1') || _suppressRealtimeKeys.has('__all__')); i++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 400)); });
  const aviso = (cambios) => page.evaluate((c) => { const row = Object.assign({}, c, { patient_id: 's1', updated_at: new Date().toISOString() }); handleNoteChange({ eventType: 'UPDATE', new: row }); handleNoteChange({ eventType: 'UPDATE', new: row }); }, cambios);
  const otroIpad = (f, v) => { store.noteFull[f] = v; store.noteFull.updated_at = new Date().toISOString(); };
  const leer = () => page.evaluate(() => { const k = pid(patients.find(x => x._supa_id === 's1')); const n = getNote(k); return { pend: n.pendientes, manejo: n.manejo }; });
  const dup = (t) => { const l = String(t || '').split('\n').filter(Boolean); return new Set(l).size !== l.length; };
  // 1) Este iPad escribe y guarda; llega su propio eco (la misma fila) dos veces.
  await page.evaluate(() => { const k = pid(patients.find(x => x._supa_id === 's1')); updateField(k, 'pendientes', 'RX DE TORAX'); });
  await page.waitForTimeout(2500);
  await aviso(Object.assign({}, store.noteFull, { pendientes: 'RX DE TORAX' }));
  await esperarCalma();
  const r1 = await leer();
  // 2) El otro iPad agrega un renglón: llega en vivo (el mismo aviso dos veces) sin repetirse.
  otroIpad('pendientes', 'RX DE TORAX\nTAC DE ABDOMEN');
  await aviso(store.noteFull); await esperarCalma();
  const r2 = await leer();
  // 3) Mientras este iPad escribe en Manejo, el otro cambia Pendientes: Manejo no se toca, Pendientes sí; al subir, la base
  //    queda con las dos cosas.
  await page.evaluate(() => { const k = pid(patients.find(x => x._supa_id === 's1')); updateField(k, 'manejo', 'AYUNO\nSOLUCIONES'); });
  otroIpad('pendientes', 'RX DE TORAX\nTAC DE ABDOMEN\nIC A CARDIOLOGIA');
  await aviso(store.noteFull); await page.waitForTimeout(2500); await esperarCalma();
  const r3 = await leer();
  check('S20 dos iPads en la misma tarjeta: el eco propio (repetido) no duplica, lo del otro iPad llega en vivo sin repetirse, no pisa la caja que se está escribiendo y la base termina con las dos cosas',
    r1.pend === 'RX DE TORAX' && r2.pend === 'RX DE TORAX\nTAC DE ABDOMEN' && r3.manejo === 'AYUNO\nSOLUCIONES' && r3.pend === 'RX DE TORAX\nTAC DE ABDOMEN\nIC A CARDIOLOGIA'
    && store.noteFull.manejo === 'AYUNO\nSOLUCIONES' && store.noteFull.pendientes === 'RX DE TORAX\nTAC DE ABDOMEN\nIC A CARDIOLOGIA' && ![r1, r2, r3].some((r) => dup(r.pend) || dup(r.manejo)),
    JSON.stringify({ r1, r2, r3, base: { pend: store.noteFull.pendientes, manejo: store.noteFull.manejo } }));

  // ── S21: la consulta de cultivos de WinLab falla en el servidor: la caja lo dice y se reintenta (antes, vacía y en silencio) ──
  store.cultivos500 = true;
  const s21a = await page.evaluate(async () => {
    window.__cultivosReintentos = 0; await window.loadCultivos(true);
    const p = patients.find(x => x._supa_id === 's1');
    return { reint: window.__cultivosReintentos, html: window.renderCultivosLabSection(p, getNote(pid(p)), pid(p)) };
  });
  store.cultivos500 = false; store.cultivos = [{ exp: '26-70001', cama: '3-301', nombre: 'JUAN PEREZ SOTO', fecha: new Date().toISOString().slice(0, 10), tipo: 'Hemocultivo', germen: null, resultado: 'Negativo', texto_origen: 'HEMOCULTIVO DESARROLLO NEGATIVO', busqueda: 'JUAN PEREZ SOTO' }];
  const s21b = await page.evaluate(async () => {
    await window.loadCultivos(true);
    const p = patients.find(x => x._supa_id === 's1');
    const h = window.renderCultivosLabSection(p, getNote(pid(p)), pid(p));
    return { reint: window.__cultivosReintentos, aviso: /cultivos-lab-error/.test(h), caja: /Cultivos \(lab\)/.test(h) };
  });
  check('S21 cultivos de WinLab: si el servidor falla, la caja lo dice y se programa el reintento; al volver, el aviso se va y aparecen los cultivos',
    s21a.reint === 1 && /cultivos-lab-error/.test(s21a.html) && /se reintenta/.test(s21a.html) && s21b.reint === 0 && !s21b.aviso && s21b.caja, JSON.stringify({ s21a, s21b }));

  // ── S22: canales en vivo privados (hallazgo 78) con vuelta a los públicos si la base los rechaza ──
  const s22 = await page.evaluate(async () => {
    const vivos = ['pl-guard-info', 'pl-presence', 'pl-no-olvidar'];
    const ult = (n) => window.__chans.filter(c => c.name === n).slice(-1)[0];
    const antes = vivos.map(n => { const c = ult(n); return { n, priv: !!(c && c.opts && c.opts.config && c.opts.config.private), conToken: !!(c && c.auth > 0) }; });
    const tablaPriv = window.__chans.filter(c => /-changes$/.test(c.name)).some(c => c.opts && c.opts.config && c.opts.config.private);
    const presKey = !!(ult('pl-presence').opts.config.presence && ult('pl-presence').opts.config.presence.key);
    const n0 = window.__chans.length;
    _plCanalEstado('CHANNEL_ERROR'); await new Promise(r => setTimeout(r, 50));
    const despues = vivos.map(n => { const c = window.__chans.slice(n0).filter(x => x.name === n).slice(-1)[0]; return { n, reabierto: !!c, priv: !!(c && c.opts && c.opts.config && c.opts.config.private) }; });
    const n1 = window.__chans.length; _plCanalEstado('CHANNEL_ERROR'); await new Promise(r => setTimeout(r, 50));
    return { antes, tablaPriv, presKey, despues, otraVez: window.__chans.length - n1 };
  });
  check('S22 canales en vivo: quién edita, guardia y No olvidar se abren PRIVADOS y con el token de la sesión ya puesto (las tablas siguen igual); si la base rechaza el privado se reabren públicos una sola vez',
    s22.antes.every(x => x.priv && x.conToken) && !s22.tablaPriv && s22.presKey && s22.despues.every(x => x.reabierto && !x.priv) && s22.otraVez === 0, JSON.stringify(s22));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-SYNC2: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
