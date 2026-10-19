// Apple Pencil en las tarjetas (oct 2026, «sigue sin poder utilizarse») y caja Misceláneo (antes «Manejo médico actual»).
// Sin puertos: page.route sirve los archivos del repo (no choca con run_all). Datos inventados.
//   node tests/headless/app_pencil.js
// P1  iPad + ✍️ Scribble: NINGÚN oyente táctil/de puntero NO pasivo en document (en WebKit cada uno hace que el toque espere
//     al hilo principal antes de que arranque el reconocedor de Scribble → el lápiz «solo selecciona»); el lápiz sobre una
//     caja grande no se cancela.
// P2  ✍️ en iPad (19 oct 2026, ya sin Tinta): el botón NO cambia de modo ni pone oyentes (sigue Scribble, el lápiz no se
//     cancela); solo avisa cómo activar Garabatear. Dos toques seguidos: igual.
// P3  Tablero (📌): pasar de una nota a otra (lo que hace Scribble al escribir) no destruye la nota en la que se escribe.
// P4  Ficha (tablero de una tarjeta): tocar la cama/nombre de la cabecera ya no pliega la tarjeta (las cajas no desaparecen).
// P5  Misceláneo: la caja se llama así en la ficha, la barra de saltos y ⚙ Cajas; lo escrito no se pierde al cambiar de
//     tarjeta antes del guardado, ni al ocultar la app sin red (queda en localStorage y en la cola).
const fs = require('fs'), path = require('path');
const { launch } = require('./_browser');
const REPO = path.join(__dirname, '..', '..');
const HTML = process.argv[2] || path.join(REPO, 'index.html');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session';
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Uno');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: ()=>({ data:{ subscription:{ unsubscribe(){} } } }), refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const TYPES = /^(touchstart|touchmove|touchend|pointerdown|pointermove|pointerup|pointercancel|mousedown)$/;
(async () => {
  const browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = []; let offline = false;
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('http://pen.local/')) {
      const p = decodeURIComponent(new URL(url).pathname);
      if (p === '/' || p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(HTML, 'utf8') });
      if (/vendor\/supabase/.test(p)) return route.abort();
      const f = path.join(REPO, p); if (!f.startsWith(REPO) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, body: fs.readFileSync(f), contentType: p.endsWith('.js') ? 'application/javascript' : undefined });
    }
    if (url.includes('/rest/v1/')) {
      if (offline) return route.abort('internetdisconnected');
      const u = url.replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
      const json = (s, o) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
      if (u.startsWith('/rest/v1/patients') && m === 'GET') return json(200, [
        { id: 'a1', cama: '3-170', exp: '24-1', nombre: 'PACIENTE PRUEBA UNO', esp: 'CG', estado: 'ESTABLE', edad: '50', dx: 'DX UNO', ingreso: '2026-10-10' },
        { id: 'a2', cama: '3-171', exp: '24-2', nombre: 'PACIENTE PRUEBA DOS', esp: 'CG', estado: 'ESTABLE', edad: '60', dx: 'DX DOS', ingreso: '2026-10-11' }]);
      if (u.startsWith('/rest/v1/notes') && m === 'POST') { let b = null; try { b = JSON.parse(req.postData() || 'null'); } catch (_) {} posts.push(Array.isArray(b) ? b[0] : b); return json(201, [{ patient_id: 'a1' }]); }
      return json(200, []);
    }
    return route.abort();
  });
  await page.addInitScript(MOCK);
  await page.addInitScript(() => { localStorage.setItem('pl_pen_mode', '0'); localStorage.setItem('pl_pen_ipad_v3', '1'); window.__pl_force_ipad = true; });
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://pen.local/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(4000);
  check('init: sin errores no capturados', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => { const k = pid(patients[0]); focusGoTo(k); });
  await page.waitForTimeout(500);

  const cdp = await ctx.newCDPSession(page);
  const nonPassive = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter(l => TYPES.test(l.type) && !l.passive).map(l => l.type);
  };
  const penDown = () => page.evaluate(() => {
    const ta = document.querySelector('textarea.field-ta[data-key][data-field="pendientes"]'); if (!ta) return 'sin caja';
    const r = ta.getBoundingClientRect();
    const ok = ta.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + 8, clientY: r.top + 8, pressure: .5 }));
    ta.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + 8, clientY: r.top + 8 }));
    return ok ? 'no cancelado' : 'cancelado';
  });
  const p1 = { mode: await page.evaluate(() => penMode()), np: await nonPassive(), pd: await penDown() };
  check('P1 iPad Scribble: cero oyentes táctiles/de puntero no pasivos en document y el lápiz sobre la caja no se cancela', p1.mode === 'off' && p1.np.length === 0 && p1.pd === 'no cancelado', JSON.stringify(p1));
  await page.evaluate(() => { window.__toasts = []; window.__origToast = window._plToast; window._plToast = function (m) { window.__toasts.push(String(m)); }; togglePenMode(document.querySelector('.bn-pen')); });
  const p2a = { mode: await page.evaluate(() => penMode()), ls: await page.evaluate(() => localStorage.getItem('pl_pen_mode')), np: await nonPassive(), pd: await penDown(), on: await page.evaluate(() => document.body.classList.contains('pen-on')), label: await page.evaluate(() => document.querySelector('.bn-pen').textContent) };
  await page.evaluate(() => togglePenMode(document.querySelector('.bn-pen')));
  const p2b = { mode: await page.evaluate(() => penMode()), ls: await page.evaluate(() => localStorage.getItem('pl_pen_mode')), np: await nonPassive(), pd: await penDown(), toasts: await page.evaluate(() => { const t = window.__toasts.slice(); window._plToast = window.__origToast; return t; }) };
  check('P2 ✍️ en iPad: el botón no cambia de modo (sigue Scribble, "0", sin pen-on, etiqueta «✍️ Scribble»), no pone oyentes no pasivos y el lápiz no se cancela; dos toques seguidos solo avisan cómo activar Garabatear',
    p2a.mode === 'off' && p2a.ls === '0' && p2a.np.length === 0 && p2a.pd === 'no cancelado' && !p2a.on && p2a.label === '✍️ Scribble'
    && p2b.mode === 'off' && p2b.ls === '0' && p2b.np.length === 0 && p2b.pd === 'no cancelado' && p2b.toasts.length === 2 && p2b.toasts.every(t => /Garabatear/.test(t)), JSON.stringify({ p2a, p2b }));

  const p3 = await page.evaluate(async () => {
    localStorage.removeItem('pl_tablero_v1');
    setView('tablero', document.querySelector('.tab[onclick*="tablero"]'));
    tableroAddItem('altas'); await new Promise(r => setTimeout(r, 80));
    tableroAddItem('altas'); await new Promise(r => setTimeout(r, 80));
    const els = () => Array.from(document.querySelectorAll('#view-tablero .tablero-text'));
    const [a, b] = els(); a.focus(); a.textContent = 'cama 170 alta';
    b.focus(); b.textContent = 'escribiendo';
    await new Promise(r => setTimeout(r, 60));
    const bAlive = b.isConnected;
    b.blur(); await new Promise(r => setTimeout(r, 400));
    const saved = (JSON.parse(localStorage.getItem('pl_tablero_v1') || '{}').altas || []).map(i => i.text);
    setView('piso', document.querySelector('.tab'));
    return { bAlive, saved };
  });
  check('P3 Tablero: pasar de una nota a otra no destruye la nota en la que se escribe; se guardan las dos', p3.bAlive && p3.saved.indexOf('cama 170 alta') !== -1 && p3.saved.indexOf('escribiendo') !== -1, JSON.stringify(p3));

  const p4 = await page.evaluate(async () => {
    const k = pid(patients[0]); focusGoTo(k); await new Promise(r => setTimeout(r, 150));
    const n0 = document.querySelectorAll('#card-' + CSS.escape(k) + ' textarea').length;
    toggleExpand(k);
    return { n0, n1: document.querySelectorAll('#card-' + CSS.escape(k) + ' textarea').length };
  });
  check('P4 ficha: tocar la cabecera (cama/nombre) no pliega la tarjeta ni quita las cajas', p4.n0 > 5 && p4.n1 === p4.n0, JSON.stringify(p4));

  const p5 = await page.evaluate(async () => {
    const k = pid(patients[0]), k2 = pid(patients[1]);
    focusGoTo(k); await new Promise(r => setTimeout(r, 200));
    const card = document.getElementById('card-' + k);
    const label = (card && card.textContent || '');
    const jump = (document.querySelector('#board-nav') || {}).textContent || '';
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]');
    if (!ta) return { noTa: true };
    ta.focus(); ta.value = 'MISC ESCRITO ANTES DE CAMBIAR'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    focusGoTo(k2);                                   // cambia de tarjeta ANTES del guardado con retraso
    await new Promise(r => setTimeout(r, 1800));
    const kept = getNote(k).manejo;
    const ls = JSON.parse(localStorage.getItem('note-' + k) || '{}').manejo;
    return { labelOk: /Misceláneo/.test(label) && !/Manejo médico actual/.test(label), jumpOk: /Misceláneo/.test(jump) || /Misc/.test(jump), kept, ls };
  });
  const postMisc = posts.find(b => b && b.manejo === 'MISC ESCRITO ANTES DE CAMBIAR');
  check('P5 Misceláneo: la caja se llama así (ya no «Manejo médico actual»); lo escrito sobrevive al cambiar de tarjeta, queda en localStorage y se sube',
    !p5.noTa && p5.labelOk && p5.kept === 'MISC ESCRITO ANTES DE CAMBIAR' && p5.ls === 'MISC ESCRITO ANTES DE CAMBIAR' && !!postMisc, JSON.stringify({ p5, posted: !!postMisc }));

  // P6: sin red, escribir en Misceláneo y ocultar la app: queda en localStorage y en la cola con el campo
  offline = true; await ctx.setOffline(true);
  const p6 = await page.evaluate(async () => {
    const k = pid(patients[1]); focusGoTo(k); await new Promise(r => setTimeout(r, 200));
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]');
    ta.focus(); ta.value = 'MISC SIN RED'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 600));
    const ls = JSON.parse(localStorage.getItem('note-' + k) || '{}').manejo;
    const q = (typeof outboxLoad === 'function' ? outboxLoad() : JSON.parse(localStorage.getItem('pl_outbox_v1') || '[]')) || [];
    const item = q.find(i => i && i.type === 'note' && i.key === k);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    return { ls, queued: !!item, dirty: item && item.dirty };
  });
  offline = false; await ctx.setOffline(false);
  check('P6 Misceláneo sin red: al ocultar la app queda en localStorage y en la cola con el campo manejo', p6.ls === 'MISC SIN RED' && p6.queued && (!p6.dirty || p6.dirty.indexOf('manejo') !== -1), JSON.stringify(p6));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-PENCIL: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
