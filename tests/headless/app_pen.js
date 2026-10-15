// ✍️ Lápiz directo sobre las cajas (tinta por caja que viaja con la nota, tachadura que borra, toque = cursor,
// dedo no pinta, menú de la esquina) + vista iPad: tira de camas en la barra, sin botones flotantes.
//   node tests/headless/app_pen.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  localStorage.setItem('pl_pen_mode', '1');      // en Chromium headless no hay touch: encender el lápiz a mano
  window.__alerts=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return json(200, [
        { id: 'a1', cama: '3-170', exp: '24-20852', nombre: 'HERNANDEZ GONZALEZ FAUSTINO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'CHOQUE SÉPTICO' },
        { id: 'a2', cama: '3-172', exp: '24-20900', nombre: 'LOPEZ RUIZ ANA', esp: 'CG', estado: 'ESTABLE', edad: '45', dx: 'COLECISTITIS' }]);
      return json(201, [{ id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── L1: vista iPad (1194 px): tira de camas en la barra, riel lateral oculto, sin botones flotantes, menú ⋯ Más ──
  const l1 = await page.evaluate(() => {
    const k = pid(patients[0]); focusGoTo(k);
    const nav = document.getElementById('board-nav');
    const cs = (el) => el ? getComputedStyle(el).display : null;
    const modes = Array.from(nav.querySelectorAll('.bn-mode')).map(b => b.textContent.trim());
    const strip = nav.querySelector('.bn-beds'); const side = document.getElementById('board-side'); const menu = document.getElementById('hc-more-menu');
    return { fab: !!document.getElementById('pl-fab-v28'), modes, stripShown: cs(strip), sideShown: cs(side), chips: strip ? strip.querySelectorAll('.bb').length : 0, cur: strip ? Array.from(strip.querySelectorAll('.bb.bb-cur')).map(b => b.textContent.trim()) : [],
      padR: getComputedStyle(document.getElementById('board-main')).paddingRight, menuBtns: ['hcm-planes', 'hcm-indic', 'hcm-backup'].map(t => !!menu.querySelector('[data-testid="' + t + '"]')), penBtn: !!nav.querySelector('.bn-pen.on'), bodyPen: document.body.classList.contains('pen-on'),
      sideBtns: side ? side.querySelectorAll('.bs-btn').length : 0 };
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  const l1b = await page.evaluate(() => { renderView(); const cs = (el) => el ? getComputedStyle(el).display : null; return { side: cs(document.getElementById('board-side')), strip: cs(document.querySelector('#board-nav .bn-beds')) }; });
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.evaluate(() => renderView());
  check('L1 iPad horizontal (1194 px): las camas van en una tira dentro de la barra pegajosa (cama en foco marcada, punto de estado) y el riel lateral se oculta; sin botones flotantes a la derecha ni margen reservado; «📊 Planes» y «✍️ Lápiz» en la barra (Pase sigue siendo el primero); los tres botones viven en ⋯ Más; en laptop (1400 px) vuelve el riel lateral y se oculta la tira',
    l1.fab === false && /Pase|Completo/.test(l1.modes[0]) && l1.modes.includes('📊 Planes') && l1.modes.includes('✍️ Lápiz') && l1.stripShown === 'flex' && l1.sideShown === 'none' && l1.chips === 2 && JSON.stringify(l1.cur) === JSON.stringify(['3-170']) && l1.sideBtns === 2
    && l1.padR === '0px' && l1.menuBtns.every(Boolean) && l1.penBtn && l1.bodyPen && l1b.side === 'grid' && l1b.strip === 'none', JSON.stringify({ l1, l1b }));

  // ── L2: tinta con el lápiz: trazo, segundo trazo, el dedo no pinta, rayón borra solo lo que toca, toque = cursor, sobrevive al repintado, se guarda ──
  const l2 = await page.evaluate(async () => {
    const k = pid(patients[0]); focusGoTo(k);
    const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]';
    let ta = document.querySelector(sel);
    const r = ta.getBoundingClientRect();
    const ev = (type, x, y, extra) => ta.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.5 }, extra || {})));
    const stroke = (pts) => { ev('pointerdown', pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ev('pointermove', pts[i][0], pts[i][1]); ev('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]); };
    const h0 = ta.offsetHeight;
    stroke([[10, 10], [20, 12], [30, 14], [40, 18], [50, 20], [60, 22]]);         // "palabra" 1
    const cv = ta.nextElementSibling;
    const ink1 = JSON.parse(JSON.stringify(getNote(k).checklist.__ink['manejo']));
    stroke([[100, 30], [110, 28], [120, 30], [130, 32]]);                           // "palabra" 2, separada
    const n2 = getNote(k).checklist.__ink['manejo'].s.length;
    // dedo: ni pinta ni crea trazos
    ['pointerdown', 'pointermove', 'pointerup'].forEach((t, i) => ta.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: r.left + 5 + i * 20, clientY: r.top + 5 + i * 10 })));
    ['pointerdown', 'pointermove', 'pointerup'].forEach((t, i) => ta.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: r.left + 5 + i * 20, clientY: r.top + 5 + i * 10 })));
    const n3 = getNote(k).checklist.__ink['manejo'].s.length;
    // rayón (zigzag) ENCIMA de la palabra 1 → la borra; la 2 se queda; el rayón no se guarda
    stroke([[8, 8], [22, 24], [14, 6], [30, 26], [20, 4], [40, 26], [32, 6], [50, 26], [44, 8], [62, 26]]);
    const after = JSON.parse(JSON.stringify(getNote(k).checklist.__ink['manejo'].s));
    // zigzag en espacio VACÍO → es tinta normal (escribir "mm" no borra nada)
    stroke([[200, 8], [214, 24], [206, 6], [222, 26], [212, 4], [232, 26], [224, 6], [242, 26], [236, 8], [254, 26]]);
    const nZig = getNote(k).checklist.__ink['manejo'].s.length;
    // toque con el lápiz sin arrastrar → cursor en la caja, sin trazo nuevo
    ta.blur(); ev('pointerdown', 150, 20); ev('pointerup', 150, 20);
    const focused = document.activeElement === ta; const nTap = getNote(k).checklist.__ink['manejo'].s.length;
    // escribir cerca del borde de abajo → la caja crece
    stroke([[10, h0 - 10], [30, h0 - 8], [50, h0 - 12], [70, h0 - 9]]);
    const grew = ta.offsetHeight > h0;
    await new Promise(r2 => setTimeout(r2, 1700));   // 600 ms (tinta) + 500 ms (saveNote) + red
    _rerenderCard(k);
    ta = document.querySelector(sel);
    const cv2 = ta.nextElementSibling; const menu = cv2 ? cv2.nextElementSibling : null;
    return { cvMade: !!(cv && cv.classList.contains('pl-ink-cv')), cvW: cv ? cv.style.width : null, taW: Math.round(r.width) + 'px', inkW: ink1.w, n1: ink1.s.length, pts: ink1.s[0].p.length, first: ink1.s[0].p[0], color: ink1.s[0].c, by: ink1.s[0].by,
      n2, n3, afterN: after.length, afterFirst: after.length ? after[0].p[0] : null, nZig, focused, nTap, grew,
      remount: !!(cv2 && cv2.classList.contains('pl-ink-cv')), remountW: cv2 ? cv2.style.width === ta.offsetWidth + 'px' : null, menuShown: !!(menu && menu.classList.contains('pl-ink-menu') && menu.style.display !== 'none'), keptHeight: ta.offsetHeight > h0, nFinal: getNote(k).checklist.__ink['manejo'].s.length };
  });
  const inkPosted = calls.some(c => (c.m === 'POST' || c.m === 'PATCH') && /\/rest\/v1\/notes/.test(c.url) && c.body && c.body.checklist && c.body.checklist.__ink && c.body.checklist.__ink.manejo && Array.isArray(c.body.checklist.__ink.manejo.s) && c.body.checklist.__ink.manejo.s.length >= 1);
  check('L2 lápiz sobre la caja: el trazo crea la capa del tamaño de la caja y se guarda en checklist.__ink (ancho de referencia, puntos [x,y,presión], color, iniciales); segundo trazo; dedo y ratón no pintan; el rayón encima de la palabra 1 la borra y respeta la 2 (el rayón no se guarda); un zigzag en espacio vacío sí es tinta; toque = cursor sin trazo; escribir abajo hace crecer la caja; sobrevive al repintado (capa, menú ✍️, altura) y viaja a la nube',
    l2.cvMade && l2.cvW === l2.taW && l2.inkW + 'px' === l2.taW && l2.n1 === 1 && l2.pts === 6 && JSON.stringify(l2.first) === JSON.stringify([10, 10, 0.5]) && l2.color === '#1d4ed8' && l2.by === 'GF'
    && l2.n2 === 2 && l2.n3 === 2 && l2.afterN === 1 && JSON.stringify(l2.afterFirst) === JSON.stringify([100, 30, 0.5]) && l2.nZig === 2 && l2.focused && l2.nTap === 2 && l2.grew
    && l2.remount && l2.remountW && l2.menuShown && l2.keptHeight && l2.nFinal === 3 && inkPosted, JSON.stringify({ l2, inkPosted }));

  // ── L3: menú ✍️ de la esquina: deshacer, pasar a texto (lienzo grande precargado), borrar; apagar el lápiz desactiva la tinta ──
  const l3 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]';
    const ta = document.querySelector(sel); const menu = ta.nextElementSibling.nextElementSibling;
    menu.click();
    const pop = document.querySelector('.pl-ink-pop'); const acts = pop ? Array.from(pop.querySelectorAll('button')).map(b => b.dataset.act) : [];
    pop.querySelector('button[data-act="undo"]').click();
    const nUndo = getNote(k).checklist.__ink['manejo'].s.length;
    penToText(k, 'manejo');
    const modal = document.getElementById('inkpad-modal').style.display; const nBig = _inkStrokes.length; const firstPt = _inkStrokes[0] && _inkStrokes[0].points[0];
    closeInkpad();
    penClear(k, 'manejo');
    const cleared = !(getNote(k).checklist.__ink && getNote(k).checklist.__ink['manejo']);
    const menuHidden = menu.style.display === 'none';
    // lápiz apagado: el trazo del lápiz ya no pinta (queda el comportamiento del sistema)
    togglePenMode(document.querySelector('.bn-pen'));
    const off = !penModeOn() && !document.body.classList.contains('pen-on') && !document.querySelector('.bn-pen').classList.contains('on');
    const r = ta.getBoundingClientRect();
    ['pointerdown', 'pointermove', 'pointermove', 'pointerup'].forEach((t, i) => ta.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + 10 + i * 15, clientY: r.top + 10 + i * 3, pressure: 0.5 })));
    const noInk = !(getNote(k).checklist.__ink && getNote(k).checklist.__ink['manejo']);
    togglePenMode(document.querySelector('.bn-pen'));
    const on = penModeOn() && localStorage.getItem('pl_pen_mode') === '1';
    // tinta guardada con otro ancho de caja (otro dispositivo) → se reescala y la caja crece para que no se corte
    const nd = getNote(k); nd.checklist.__ink = { manejo: { w: Math.round(ta.offsetWidth / 2), s: [{ c: '#1d4ed8', p: [[10, 10, 0.5], [20, 60, 0.5], [30, 62, 0.5]] }] } }; noteData[k] = nd;
    ta.style.height = ''; _penMountAll();
    return { acts, nUndo, modal, nBig, firstPt, cleared, menuHidden, off, noInk, on, scaledH: parseFloat(getComputedStyle(ta).height), cvThere: !!(ta.nextElementSibling && ta.nextElementSibling.classList.contains('pl-ink-cv')) };
  });
  check('L3 menú ✍️: deshacer quita el último trazo; «pasar a texto» abre el lienzo grande con la tinta precargada (más grande) para 🤖 Transcribir; borrar quita la tinta y oculta el botón; con ✍️ Lápiz apagado el lápiz no pinta; se recuerda por dispositivo; tinta guardada con otro ancho se reescala y la caja crece',
    JSON.stringify(l3.acts) === JSON.stringify(['undo', 'text', 'clear']) && l3.nUndo === 2 && l3.modal === 'flex' && l3.nBig === 2 && l3.firstPt && l3.firstPt.x === 40 + 100 * 1.8 && l3.cleared && l3.menuHidden && l3.off && l3.noInk && l3.on
    && l3.scaledH >= 62 * 2 + 14 && l3.cvThere, JSON.stringify(l3));

  // ── L4: la tarjeta se repinta DIRECTO (como Realtime / RIS / fotos) → la capa de tinta se vuelve a montar sola ──
  const l4 = await page.evaluate(async () => {
    const k = pid(patients[0]); const p = patients[0];
    const nd = getNote(k); nd.checklist.__ink = { manejo: { w: 600, s: [{ c: '#1d4ed8', p: [[10, 10, 0.5], [40, 20, 0.5]] }] } }; noteData[k] = nd;
    document.getElementById('card-' + k).outerHTML = renderFullCard(p, nd, k);     // sin pasar por _rerenderCard
    await new Promise(r => setTimeout(r, 150));
    const cv = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"] + canvas.pl-ink-cv');
    return { after: !!cv, w: cv ? cv.style.width : null };
  });
  check('L4 si la tarjeta se repinta directo (Realtime, RIS, fotos…) la capa de tinta se vuelve a montar sola (MutationObserver)', l4.after === true && /px$/.test(l4.w || ''), JSON.stringify(l4));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-PEN: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
