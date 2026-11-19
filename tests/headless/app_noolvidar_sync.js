// 📌 No olvidar: dos iPads cambian los recordatorios del MISMO paciente a la vez (19 nov 2026, revisión adversarial).
// N1: el iPad B agrega uno, su subida falla una vez (corte de red) y mientras tanto le llega (tarde) el del iPad A: al
//     subir por fin, la nube queda con los DOS (antes la base avanzaba con lo de A y la fusión lo tomaba por borrado aquí).
// N2: B borra uno viejo mientras A agrega otro: el borrado de B y lo nuevo de A se respetan.
//   node tests/headless/app_noolvidar_sync.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh). Pacientes ficticios.
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Doctor Bravo');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const id = (n) => '7d000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const pt = (n, cama, nombre) => ({ id: id(n), cama, exp: '26-72' + String(n).padStart(3, '0'), nombre, esp: 'CG', estado: 'ESTABLE', dx: 'DX FICTICIO', edad: '40', ingreso: '2026-11-10', seccion: 'PISO' });
const PTS = [pt(1, '3-401', 'ANA FICTICIA UNO'), pt(2, '3-402', 'BETO FICTICIO DOS')];
const cloud = {};
cloud[id(2)] = { patient_id: id(2), pendientes: '', sv: '', checklist: { pm_fc: '88',
  _ptReminders: [{ text: 'H1', done: true }, { text: 'H2', done: true }, { text: 'Leer nota IC', done: false }] } };
cloud[id(1)] = { patient_id: id(1), checklist: {} };
(async () => {
  const browser = await launch();
  const errors = [], writes = [];
  const ctx0 = await browser.newContext({ viewport: { width: 834, height: 1194 }, timezoneId: 'America/Mexico_City' });   // como un iPad: su memoria sobrevive a cerrar la app
  const page = await ctx0.newPage();
  page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const rutas = async (pg) => {
  await pg.route('**/vendor/supabase*', r => r.abort());
  await pg.route('**/rest/v1/**', async (route) => {
    if (globalThis.__sinRed) return route.abort('internetdisconnected');
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return json(m === 'GET' ? 200 : 201, m === 'GET' ? PTS : [{ id: PTS[0].id }]);
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') {
        const mm = /patient_id=eq\.([^&]+)/.exec(url);
        const rows = mm ? [cloud[decodeURIComponent(mm[1])]].filter(Boolean) : Object.values(cloud);
        return json(200, JSON.parse(JSON.stringify(rows)));
      }
      if (body && body.checklist && JSON.stringify(body.checklist).includes('DE IPAD B') && !globalThis.__failedOnce) { globalThis.__failedOnce = true; return json(500, { message: 'boom' }); }
      const arr = Array.isArray(body) ? body : [body];
      arr.forEach(r => { writes.push(JSON.parse(JSON.stringify(r))); const c = cloud[r.patient_id] || (cloud[r.patient_id] = { patient_id: r.patient_id }); Object.keys(r).forEach(kk => { c[kk] = r[kk]; }); });
      return json(201, arr);
    }
    return json(200, []);
  });
  await pg.addInitScript(MOCK);
  };
  await rutas(page);
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const K = await page.evaluate(() => { const p = patients.find(x => x.cama === '3-402'); focusGoTo(pid(p)); return pid(p); });
  await page.waitForTimeout(900);
  const names = (a) => (a || []).map(r => r.text + (r.done ? '[x]' : ''));

  // A adds a reminder: it reaches the cloud; B never applies it (no realtime event here, like a dropped event).
  cloud[id(2)].checklist._ptReminders.push({ text: 'DE IPAD A: revisar nota postqx', done: false, by: 'Alfa', t: '2026-11-19T10:00:00.000Z' });

  // B saves vitals at the bedside (opens the suppression window), then adds with Enter.
  await page.evaluate((k) => { try { updateField(k, 'sv', 'FC 90 TA 120/80'); } catch (e) { window.__e = String(e); } }, K);
  await page.waitForTimeout(800);
  const sel = '#ptr-input-' + K.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  await page.focus(sel);
  await page.keyboard.type('DE IPAD B: ver endoscopia');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  const step1 = { cloud: names(cloud[id(2)].checklist._ptReminders), lastWrite: names(((writes.filter(w => w.checklist).slice(-1)[0] || {}).checklist || {})._ptReminders) };

  const rowAfterFail = names(cloud[id(2)].checklist._ptReminders);
  // A's realtime event (its row) arrives on B while B is still in the 5 s suppression window: dropped, kept in _rtNoteMissed.
  const supp = await page.evaluate((args) => { const s = _suppressRealtimeKeys.has(args.pid); handleNoteChange({ eventType: 'UPDATE', new: args.row }); return { suppressed: s, missed: _rtNoteMissed.has(args.pid) }; }, { row: JSON.parse(JSON.stringify(cloud[id(2)])), pid: id(2) });
  await page.waitForTimeout(8000);   // suppression ends -> _rtNoteCatchUp re-reads the row by itself
  const bAfterCatch = await page.evaluate((args) => ({ list: noteData[args.k].checklist._ptReminders.map(r => r.text), dirty: Array.from(_dirtyUnion(args.k)), baseHasA: JSON.stringify((_noteBaseline[args.pid] || {}).checklist || {}).includes('DE IPAD A'), outbox: outboxLoad().length }), { k: K, pid: id(2) });
  const cloudBeforeFlush = names(cloud[id(2)].checklist._ptReminders);
  await page.evaluate(async () => { await flushOutbox(); });
  await page.waitForTimeout(2500);
  const nube1 = names(cloud[id(2)].checklist._ptReminders);
  // Tras subir, este iPad suelta la marca y muestra también lo de A (no se queda con su copia hasta la siguiente edición).
  await page.waitForTimeout(3000);
  const bTras = await page.evaluate((k) => ({ lista: noteData[k].checklist._ptReminders.map(r => r.text), marca: _dirtyUnion(k).has('ck__ptReminders') }), K);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  check('N1 la subida de B falla una vez y le llega tarde el recordatorio de A: al subir, la nube queda con los dos (y con los signos de B) y B ya muestra los dos',
    JSON.stringify(step1.cloud) === JSON.stringify(['H1[x]', 'H2[x]', 'Leer nota IC', 'DE IPAD A: revisar nota postqx']) && supp.suppressed
    && nube1.length === 5 && ['H1[x]', 'H2[x]', 'Leer nota IC', 'DE IPAD A: revisar nota postqx', 'DE IPAD B: ver endoscopia'].every(x => nube1.includes(x))
    && cloud[id(2)].sv === 'FC 90 TA 120/80' && !bTras.marca && bTras.lista.includes('DE IPAD A: revisar nota postqx') && bTras.lista.includes('DE IPAD B: ver endoscopia'),
    JSON.stringify({ step1, supp, bAfterCatch, nube1, bTras }));

  // N2: B borra «Leer nota IC» mientras A agrega otro (que B no ha visto): se respetan los dos cambios.
  await page.waitForTimeout(6000);   // que pase la ventana de supresión de N1
  cloud[id(2)].checklist._ptReminders.push({ text: 'DE IPAD A2: pedir TAC', done: false, by: 'Alfa', t: '2026-11-19T10:05:00.000Z' });
  const n2 = await page.evaluate(async (k) => {
    const rs = noteData[k].checklist._ptReminders; const i = rs.findIndex(r => r.text === 'Leer nota IC');
    window.confirm = () => true; deletePtReminder(k, i);
    await new Promise(r => setTimeout(r, 2500));
    return noteData[k].checklist._ptReminders.filter(r => !r.del).map(r => r.text);
  }, K);
  const nube2 = names(cloud[id(2)].checklist._ptReminders);
  const vis2 = cloud[id(2)].checklist._ptReminders.filter(r => !r.del).map(r => r.text);
  const marca = cloud[id(2)].checklist._ptReminders.find(r => r.text === 'Leer nota IC');
  check('N2 B borra uno viejo mientras A agrega otro: en la nube el borrado queda como marca (ya no se ve) y se queda lo de A',
    !vis2.includes('Leer nota IC') && !!(marca && marca.del && marca.done) && vis2.includes('DE IPAD A2: pedir TAC') && vis2.includes('DE IPAD A: revisar nota postqx') && vis2.includes('DE IPAD B: ver endoscopia')
    && !n2.includes('Leer nota IC'), JSON.stringify({ n2, nube2, vis2 }));

  // N4: sin red, B agrega uno (queda en la cola del iPad) y se cierra la app; mientras tanto A agregó otro. Al volver a abrir
  //     con red, la cola sube y la nube conserva los dos (antes la base de la recarga ya traía lo de A y se tomaba por borrado).
  const ctx = page.context();
  globalThis.__sinRed = true;
  await page.evaluate(async (k) => { const inp = document.getElementById('ptr-input-' + k); inp.value = 'DE IPAD B2: ver TAC'; addPtReminder(k); await new Promise(r => setTimeout(r, 4000)); try { persistBeforeExit(); } catch (_) {} }, K);
  const enCola = await page.evaluate(() => outboxLoad().filter(x => x.type === 'note').length);
  cloud[id(2)].checklist._ptReminders.push({ id: 'a3', text: 'DE IPAD A3: llamar a familiar', done: false, by: 'Alfa', t: '2026-11-19T11:00:00.000Z', u: Date.parse('2026-11-19T11:00:00Z') });
  await page.close();
  globalThis.__sinRed = false;
  const page2 = await ctx.newPage();
  page2.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await rutas(page2);
  await page2.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page2.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page2.waitForTimeout(2500);
  await page2.evaluate(async () => { try { await flushOutbox(); } catch (_) {} });
  await page2.waitForTimeout(3000);
  const vis4 = cloud[id(2)].checklist._ptReminders.filter(r => !r.del).map(r => r.text);
  const cola4 = await page2.evaluate(() => outboxLoad().filter(x => x.type === 'note').length);
  const alAbrir = await page2.evaluate((k) => ((noteData[k] && noteData[k].checklist && noteData[k].checklist._ptReminders) || []).filter(r => !r.del).map(r => r.text), K);
  check('N4 sin red B agrega uno y cierra la app; A agregó otro: al abrir de nuevo con red la cola sube, la nube conserva los dos y este iPad ve los dos',
    enCola >= 1 && cola4 === 0 && vis4.includes('DE IPAD A3: llamar a familiar') && vis4.includes('DE IPAD B2: ver TAC') && vis4.includes('DE IPAD A2: pedir TAC')
    && alAbrir.includes('DE IPAD A3: llamar a familiar') && alAbrir.includes('DE IPAD B2: ver TAC'), JSON.stringify({ enCola, cola4, vis4, alAbrir }));
  check('N3 sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\nRESULT APP-NOOLVIDAR-SYNC: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
