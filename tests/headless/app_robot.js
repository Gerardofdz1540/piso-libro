// 🤖 Robot WinLab por paciente (oct 2026): aviso cuando el robot no encontró al paciente (qué buscó,
// nombres parecidos tocables), "nombre en WinLab" (alias en la nota, sin red), 🔎 Buscar ahora (corrida
// dirigida vía worker) y vigilancia hasta que llegan los labs.
//   node tests/headless/app_robot.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.__prompts=[]; window.__promptAnswer='Tester';
  window.prompt=function(m){ window.__prompts.push(String(m)); return window.__promptAnswer; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const EXP = '26-00001';
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = []; const scrapes = [];
  let matchRow = { exp: EXP, cama: '3-181', alias: null, status: 'homonimos', buscado: ['HERNADNEZ CASTRO', 'HERNADNEZ + ADRIAN', 'CASTRO + ADRIAN'], candidatos: ['HERNANDEZ CASTRO, ADRIAN', 'HERNANDEZ CASTRO, ADRIEL'], encontrado_como: null, reportes: 0, detalle: null, checked_at: '2026-10-14T20:33:20Z' };
  let scrapeMode = 'ok';
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/api/scrape', async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) {}
    scrapes.push({ body, headers: route.request().headers() });
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    if (scrapeMode === 'pending') return json({ dispatched: false, reason: 'already_pending', message: 'Ya hay una corrida en cola; tomará el censo más reciente.' });
    return json({ dispatched: true, exp: body && body.exp, message: 'Robot disparado.' });
  });
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-181', exp: EXP, nombre: 'ADRIAN HERNADNEZ CASTRO', esp: 'CT', estado: 'DELICADO', edad: '36', ingreso: '2026-10-13' }]); return json(201, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    if (url.startsWith('/rest/v1/winlab_match')) return json(200, matchRow ? [matchRow] : []);
    if (url.startsWith('/rest/v1/winlab_labs')) return json(200, []);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── R1: aviso del robot en la sección de labs + botón en el menú de la tarjeta ──
  const r1 = await page.evaluate(() => {
    const k = pid(patients[0]); focusGoTo(k);
    const line = document.querySelector('[data-testid="robot-line"]');
    return { k, loaded: !!winlabMatchByExp['26-00001'], line: line ? line.textContent.replace(/\s+/g, ' ').trim() : null, warn: !!(line && line.classList.contains('rb-warn')), chips: Array.from(document.querySelectorAll('.rb-chip')).map(c => c.textContent.trim()), go: !!document.querySelector('[data-testid="robot-go"]'), aliasBtn: (document.querySelector('[data-testid="robot-alias"]') || {}).textContent || '', menu: !!document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="card-robot"]') };
  });
  const matchGet = calls.find(c => c.m === 'GET' && /\/rest\/v1\/winlab_match/.test(c.url));
  check('R1 el robot no lo encontró: la sección de labs avisa (otras personas, ninguna coincide), dice qué buscó y cuándo, ofrece los nombres parecidos como sugerencias tocables, ✏️ Nombre en WinLab y 🔎 Buscar ahora; el menú ⋯ de la tarjeta tiene 🤖 Pedir labs al robot; winlab_match se consulta acotada al censo',
    r1.loaded && r1.warn && /ninguna coincide/.test(r1.line) && /Buscó: HERNADNEZ CASTRO · HERNADNEZ \+ ADRIAN · CASTRO \+ ADRIAN · 14\/10/.test(r1.line) && /Es alguno de estos/.test(r1.line)
    && r1.chips.length === 2 && r1.chips[0] === 'HERNANDEZ CASTRO, ADRIAN' && r1.go && /^✏️ Nombre en WinLab$/.test(r1.aliasBtn.trim()) && r1.menu && /PDF \/ 📷 Foto/.test(r1.line)
    && matchGet && /exp=in\.\(26-00001\)/.test(decodeURIComponent(matchGet.url)), JSON.stringify({ r1, matchGet: matchGet && matchGet.url }));

  // ── R2: tocar una sugerencia fija el alias en la nota (se guarda, con Regresar) ──
  const r2 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    document.querySelector('.rb-chip').click();
    await new Promise(r => setTimeout(r, 900));
    const line = document.querySelector('[data-testid="robot-line"]');
    const toast = document.getElementById('__pl_toast');
    return { alias: getNote(k).checklist.winlab_alias, by: !!(getNote(k).checklist.__pl_note_meta && getNote(k).checklist.__pl_note_meta.by && getNote(k).checklist.__pl_note_meta.by.winlab_alias), aliasBtn: (document.querySelector('[data-testid="robot-alias"]') || {}).textContent || '', chips: Array.from(document.querySelectorAll('.rb-chip')).map(c => c.textContent.trim()), undo: _undoCount(k), toast: toast ? toast.textContent : '', line: line ? line.textContent.replace(/\s+/g, ' ') : '' };
  });
  const aliasPost = calls.find(c => c.m === 'POST' && /\/rest\/v1\/notes/.test(c.url) && c.body && c.body.checklist && c.body.checklist.winlab_alias === 'HERNANDEZ CASTRO, ADRIAN');
  check('R2 tocar la sugerencia: el alias queda en la nota (checklist.winlab_alias, con autor y paso de Regresar), viaja a la nube, el botón muestra el nombre fijado, la sugerencia usada desaparece y avisa que el robot lo usará',
    r2.alias === 'HERNANDEZ CASTRO, ADRIAN' && r2.by && /Nombre en WinLab: HERNANDEZ CASTRO, ADRIAN/.test(r2.aliasBtn) && r2.chips.length === 1 && r2.chips[0] === 'HERNANDEZ CASTRO, ADRIEL' && r2.undo >= 1 && /El robot buscará «HERNANDEZ CASTRO, ADRIAN»/.test(r2.toast) && !!aliasPost, JSON.stringify({ r2, aliasPost: !!aliasPost }));

  // ── R3: 🔎 Buscar ahora → corrida dirigida; al llegar el resultado la tarjeta se actualiza sola ──
  const r3 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    await robotBuscarAhora(k);
    await new Promise(r => setTimeout(r, 300));
    const pend = document.querySelector('[data-testid="robot-pending"]');
    const t1 = (document.getElementById('__pl_toast') || {}).textContent || '';
    return { pending: _robotPending['26-00001'] || null, pendShown: pend ? pend.textContent : null, toast: t1 };
  });
  const sc = scrapes[0];
  matchRow = { ...matchRow, status: 'ok', encontrado_como: 'HERNANDEZ CASTRO ADRIAN', reportes: 3, checked_at: '2026-10-14T21:40:00Z', alias: 'HERNANDEZ CASTRO, ADRIAN' };
  const r3b = await page.evaluate(async () => {
    const k = pid(patients[0]);
    _robotWatch('26-00001', k, 80);
    await new Promise(r => setTimeout(r, 700));
    const line = document.querySelector('[data-testid="robot-line"]');
    return { pending: _robotPending['26-00001'] || null, line: line ? line.textContent.replace(/\s+/g, ' ').trim() : null, ok: !!(line && line.classList.contains('rb-ok')), toast: (document.getElementById('__pl_toast') || {}).textContent || '', go: !!document.querySelector('[data-testid="robot-go"]') };
  });
  check('R3 🔎 Buscar ahora: manda {exp} al worker con el token, marca "robot en camino" y avisa; cuando winlab_match trae un resultado nuevo con status ok, quita la marca, muestra «encontrado como …» (alias fijado), avisa y deja solo ✏️',
    sc && sc.body && sc.body.exp === '26-00001' && sc.headers['x-piso-token'] === 'tok' && /^pedido /.test(r3.pending || '') && /robot en camino/.test(r3.pendShown || '') && /Robot en camino para la cama 3-181/.test(r3.toast)
    && r3b.pending === null && r3b.ok && /encontrado como «HERNANDEZ CASTRO ADRIAN» \(nombre en WinLab fijado en la app\)/.test(r3b.line) && /El robot encontró a la cama 3-181/.test(r3b.toast) && !r3b.go, JSON.stringify({ sc: sc && sc.body, r3, r3b }));

  // ── R4: corrida en cola y sin internet ──
  scrapeMode = 'pending';
  const r4 = await page.evaluate(async () => {
    const k = pid(patients[0]); const n0 = window.__alerts.length;
    await robotBuscarAhora(k); await new Promise(r => setTimeout(r, 200));
    const pend = _robotPending['26-00001'] || null; const toast = (document.getElementById('__pl_toast') || {}).textContent || '';
    delete _robotPending['26-00001'];
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    await robotBuscarAhora(k); await new Promise(r => setTimeout(r, 200));
    Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true });
    return { pend, toast, alerts: window.__alerts.slice(n0) };
  });
  check('R4 ya hay corrida en cola → "en cola" y aviso de que la incluirá; sin internet → aviso claro y no se manda nada',
    r4.pend === 'en cola' && /en cola/.test(r4.toast) && scrapes.length === 2 && r4.alerts.length === 1 && /Sin internet/.test(r4.alerts[0]), JSON.stringify({ r4, scrapes: scrapes.length }));

  // ── R5: ✏️ Nombre en WinLab a mano (se normaliza), quitarlo, y si el robot ya lo encontró sin alias no estorba ──
  const r5 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    window.__promptAnswer = '  garcia   lopez,  juan  '; setWinlabAlias(k);
    const a1 = getNote(k).checklist.winlab_alias;
    window.__promptAnswer = ''; setWinlabAlias(k);
    const a2 = getNote(k).checklist.winlab_alias;
    await new Promise(r => setTimeout(r, 100));
    const line = document.querySelector('[data-testid="robot-line"]');
    window.__promptAnswer = null; const before = getNote(k).checklist.winlab_alias; setWinlabAlias(k);
    return { a1, a2, lineGone: !line, cancel: getNote(k).checklist.winlab_alias === before, prompts: window.__prompts.length };
  });
  check('R5 ✏️ a mano: mayúsculas y espacios normalizados; vacío lo quita; con el robot en «ok» y sin alias la sección no muestra nada; cancelar no cambia nada',
    r5.a1 === 'GARCIA LOPEZ, JUAN' && r5.a2 === '' && r5.lineGone && r5.cancel && r5.prompts === 3, JSON.stringify(r5));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-ROBOT: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
