// ✍️ Lápiz directo sobre las cajas (tinta por caja que viaja con la nota, tachadura que borra, toque = cursor,
// dedo no pinta, menú de la esquina) + vista iPad: tira de camas en la barra, sin botones flotantes.
//   node tests/headless/app_pen.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  localStorage.setItem('pl_pen_mode', '1');      // modo Tinta (en Chromium headless no hay lápiz: se simula con PointerEvent)
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  // Ayudante de IA simulado para ✍️ → Texto: devuelve "TEXTO n" (o falla con 500)
  let aiN = 0, aiMode = 'ok'; const aiBodies = [];
  await page.route('**/api/ai', async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) {}
    aiBodies.push(body);
    if (aiMode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
    aiN++; await new Promise(r => setTimeout(r, 150));
    const content = (((body || {}).messages || [])[0] || {}).content; const ptxt = Array.isArray(content) ? ((content.find(c => c.type === 'text') || {}).text || '') : '';
    const texto = /campo numérico/.test(ptxt) ? String(90 + aiN) : 'TEXTO ' + aiN;     // campos numéricos (vitales, vasopresor) → número
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '```json\n{"texto":"' + texto + '"}\n```' }] }) });
  });
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
    l1.fab === false && /Pase|Completo/.test(l1.modes[0]) && l1.modes.includes('📊 Planes') && l1.modes.includes('✍️ Tinta') && l1.stripShown === 'flex' && l1.sideShown === 'none' && l1.chips === 2 && JSON.stringify(l1.cur) === JSON.stringify(['3-170']) && l1.sideBtns === 2
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
    togglePenMode(document.querySelector('.bn-pen'));   // apagado → ✍️ → Texto
    const textMode = penMode() === 'text' && localStorage.getItem('pl_pen_mode') === '2' && document.querySelector('.bn-pen').textContent === '✍️ → Texto' && document.body.classList.contains('pen-on');
    togglePenMode(document.querySelector('.bn-pen'));   // → Texto → Tinta
    const on = penMode() === 'ink' && localStorage.getItem('pl_pen_mode') === '1' && document.querySelector('.bn-pen').textContent === '✍️ Tinta';
    // tinta guardada con otro ancho de caja (otro dispositivo) → se reescala y la caja crece para que no se corte
    const nd = getNote(k); nd.checklist.__ink = { manejo: { w: Math.round(ta.offsetWidth / 2), s: [{ c: '#1d4ed8', p: [[10, 10, 0.5], [20, 60, 0.5], [30, 62, 0.5]] }] } }; noteData[k] = nd;
    ta.style.height = ''; _penMountAll();
    return { acts, nUndo, modal, nBig, firstPt, cleared, menuHidden, off, noInk, textMode, on, scaledH: parseFloat(getComputedStyle(ta).height), cvThere: !!(ta.nextElementSibling && ta.nextElementSibling.classList.contains('pl-ink-cv')) };
  });
  check('L3 menú ✍️: deshacer quita el último trazo; «pasar a texto» abre el lienzo grande con la tinta precargada (más grande) para 🤖 Transcribir; borrar quita la tinta y oculta el botón; el botón de la barra cicla Tinta → apagado (el lápiz no pinta: el iPad decide) → «→ Texto» → Tinta y se recuerda por dispositivo; tinta guardada con otro ancho se reescala y la caja crece',
    JSON.stringify(l3.acts) === JSON.stringify(['undo', 'text', 'clear']) && l3.nUndo === 2 && l3.modal === 'flex' && l3.nBig === 2 && l3.firstPt && l3.firstPt.x === 40 + 100 * 1.8 && l3.cleared && l3.menuHidden && l3.off && l3.noInk && l3.textMode && l3.on
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

  // ── L5: ✍️ → Texto: la tinta se convierte en texto con IA al soltar el lápiz y se inserta por la vía del teclado ──
  const l5 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2');
    const k = pid(patients[0]); const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]';
    const ta = document.querySelector(sel); ta.value = ''; noteData[k].pendientes = '';
    const stroke = (pts) => { const r = ta.getBoundingClientRect(); const ev = (type, x, y) => ta.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.5 })); ev('pointerdown', pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ev('pointermove', pts[i][0], pts[i][1]); ev('pointerup', pts[pts.length - 1][0], pts[pts.length - 1][1]); };
    const key = k + '|pendientes';
    stroke([[10, 10], [30, 14], [50, 12], [70, 16]]);
    const pend1 = PEN.pending[key].strokes.length; const menu = ta.nextElementSibling.nextElementSibling; const menuShown1 = menu.style.display !== 'none';
    // tachar la tinta pendiente la borra (no se manda a la IA)
    stroke([[8, 8], [22, 24], [14, 6], [30, 26], [20, 4], [40, 26], [32, 6], [50, 26], [44, 8], [62, 26], [56, 6], [74, 26]]);
    const pendAfterScratch = PEN.pending[key].strokes.length;
    stroke([[10, 10], [30, 14], [50, 12], [70, 16]]);                 // se vuelve a escribir
    await new Promise(r => setTimeout(r, 2300));                       // pausa de 1.6 s + respuesta simulada
    const val1 = ta.value, nd1 = getNote(k).pendientes, pendAfter = PEN.pending[key].strokes.length, inkSaved = !!(getNote(k).checklist.__ink && getNote(k).checklist.__ink.pendientes);
    const menuHidden = menu.style.display === 'none';
    stroke([[10, 60], [30, 64], [50, 62]]);                            // otro renglón (más abajo) → salto de línea
    await new Promise(r => setTimeout(r, 2300));
    const val2 = ta.value;
    stroke([[90, 60], [110, 64], [130, 62]]);                          // mismo renglón (< 10 s) → se une con espacio
    await new Promise(r => setTimeout(r, 2300));
    const val3 = ta.value;
    return { pend1, menuShown1, pendAfterScratch, val1, nd1, pendAfter, inkSaved, menuHidden, val2, val3, by: ((getNote(k).checklist.__pl_note_meta || {}).by || {}).pendientes, taStill: document.querySelector(sel) === ta };
  });
  const ai0 = aiBodies[0] || {}; const c0 = ((ai0.messages || [])[0] || {}).content || [];
  const textPosted = calls.some(c => (c.m === 'POST' || c.m === 'PATCH') && /\/rest\/v1\/notes/.test(c.url) && c.body && typeof c.body.pendientes === 'string' && /^TEXTO 1/.test(c.body.pendientes));
  check('L5 ✍️ → Texto: el trazo queda pendiente (morado, botón ✍️ visible); tachar la tinta pendiente la borra sin mandarla; tras la pausa la tinta va al ayudante de IA (imagen + instrucción de la caja) y el texto reconocido se inserta en la caja sin guardar tinta; otro renglón → salto de línea; mismo renglón → espacio; se guarda con autor como si fuera tecleado',
    l5.pend1 === 1 && l5.menuShown1 && l5.pendAfterScratch === 0 && l5.val1 === 'TEXTO 1' && l5.nd1 === 'TEXTO 1' && l5.pendAfter === 0 && !l5.inkSaved && l5.menuHidden
    && l5.val2 === 'TEXTO 1\nTEXTO 2' && l5.val3 === 'TEXTO 1\nTEXTO 2 TEXTO 3' && l5.by && l5.by.i === 'GF' && l5.taStill
    && aiBodies.length === 3 && c0[0] && c0[0].type === 'image' && c0[0].source && c0[0].source.media_type === 'image/png' && c0[0].source.data.length > 100 && c0[1] && /pendientes \/ plan/.test(c0[1].text) && /SOLO un JSON/.test(c0[1].text) && ai0.max_tokens === 800
    && textPosted, JSON.stringify({ l5, nAi: aiBodies.length, textPosted }));

  // ── L6: si la IA falla, la tinta se queda; «🤖 Convertir ahora» desde el menú ✍️ la reintenta ──
  aiMode = 'fail';
  const l6 = await page.evaluate(async () => {
    const k = pid(patients[0]); const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]'; const ta = document.querySelector(sel); const key = k + '|pendientes';
    const r = ta.getBoundingClientRect(); const ev = (type, x, y) => ta.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.5 }));
    ev('pointerdown', 10, 100); ev('pointermove', 30, 104); ev('pointermove', 50, 102); ev('pointerup', 50, 102);
    await new Promise(r2 => setTimeout(r2, 2300));
    return { kept: PEN.pending[key].strokes.length, val: ta.value, menuShown: ta.nextElementSibling.nextElementSibling.style.display !== 'none', alerts: window.__alerts.length };
  });
  aiMode = 'ok';
  const l6b = await page.evaluate(async () => {
    const k = pid(patients[0]); const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]'; const ta = document.querySelector(sel); const key = k + '|pendientes';
    ta.nextElementSibling.nextElementSibling.click();
    const acts = Array.from(document.querySelectorAll('.pl-ink-pop button')).map(b => b.dataset.act);
    document.querySelector('.pl-ink-pop button[data-act="now"]').click();
    await new Promise(r => setTimeout(r, 800));
    localStorage.setItem('pl_pen_mode', '1');
    return { acts, val: ta.value, pend: PEN.pending[key].strokes.length };
  });
  check('L6 la IA falla (HTTP 500): el texto no cambia, la tinta pendiente se queda y el botón ✍️ sigue visible (aviso, sin alert); el menú ofrece «🤖 Convertir ahora», que reintenta y agrega el texto en renglón nuevo',
    l6.kept === 1 && l6.val === 'TEXTO 1\nTEXTO 2 TEXTO 3' && l6.menuShown && l6.alerts === 0
    && JSON.stringify(l6b.acts) === JSON.stringify(['now', 'undo', 'clear']) && l6b.val === 'TEXTO 1\nTEXTO 2 TEXTO 3\nTEXTO 4' && l6b.pend === 0, JSON.stringify({ l6, l6b }));

  // ── L7: campos de UNA LÍNEA: el lápiz abre una banda; en los NUMÉRICOS el número se reconoce al instante (sin IA) y se pone solo ──
  const l7 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2'); PEN_DIGITS.forget();
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const pen = (el, type, x, y, id) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id || 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.5 }));
    const tap = (el) => { const r = el.getBoundingClientRect(); pen(el, 'pointerdown', r.left + 4, r.top + 4); pen(el, 'pointerup', r.left + 4, r.top + 4); return document.querySelector('.pl-pen-strip'); };
    // dígitos "a mano": las plantillas del reconocedor (100×100) escaladas a 70 px, cada trazo con su pointerdown/move/up
    const digit = (s, ch, x0) => { const cv = s.querySelector('canvas'); const c = cv.getBoundingClientRect(); const tpl = PEN_DIGITS.templatesFor(ch)[0];
      tpl.forEach(st => { const P = st.map(p => [c.left + x0 + p[0] * 0.7, c.top + 12 + p[1] * 0.7]); pen(cv, 'pointerdown', P[0][0], P[0][1]); P.slice(1).forEach(p => pen(cv, 'pointermove', p[0], p[1])); pen(cv, 'pointerup', P[P.length - 1][0], P[P.length - 1][1]); }); return cv; };
    const scribble = (s) => { const cv = s.querySelector('canvas'); const c = cv.getBoundingClientRect(); pen(cv, 'pointerdown', c.left + 20, c.top + 40); pen(cv, 'pointermove', c.left + 40, c.top + 60); pen(cv, 'pointermove', c.left + 60, c.top + 40); pen(cv, 'pointermove', c.left + 80, c.top + 60); pen(cv, 'pointerup', c.left + 80, c.top + 60); return cv; };
    // FC (numérico): toque → banda «FC» (sin robar el foco) con teclado; "9" y "5" → vista previa "95" al momento; se pone solo tras la pausa; la banda se cierra sola
    const fc = q('pm_fc'); const s1 = tap(fc); const lbl = s1 && s1.querySelector('.pps-lbl').textContent; const focused = document.activeElement === fc; const keys = s1.querySelectorAll('.pps-keys button').length;
    const cv1 = digit(s1, '9', 20); digit(s1, '5', 90);
    const preview = s1.querySelector('.pps-prev').textContent; const notYet = q('pm_fc').value;
    const c1 = cv1.getBoundingClientRect();     // el dedo sobre la banda no pinta
    cv1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: c1.left + 200, clientY: c1.top + 40 })); cv1.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: c1.left + 200, clientY: c1.top + 40 }));
    const nStrokes = PEN_STRIP.strokes.length;
    await new Promise(r => setTimeout(r, 1300));
    const val = q('pm_fc').value, saved = getNote(k).checklist.pm_fc, okCls = s1.querySelector('.pps-prev').className, stillOpen = !!document.querySelector('.pl-pen-strip');
    await new Promise(r => setTimeout(r, 2800));
    const closed = !document.querySelector('.pl-pen-strip');
    // vasopresor: mL/h "9","6" con ✓ (ya) → recalcula la dosis y APRENDE la letra (2 plantillas)
    toggleChecklist(k, 'vp_nore_on'); { const p = q('pm_peso'); p.value = '70'; p.dispatchEvent(new Event('input', { bubbles: true })); }
    const s2 = tap(q('vp_nore_mlh')); digit(s2, '9', 20); digit(s2, '6', 90); s2.querySelector('button[data-act="ok"]').click();
    const mlhVal = q('vp_nore_mlh').value, res = document.getElementById('vp-nore-res-' + ek).textContent, learned = PEN_DIGITS.learnedCount(), lsLearned = !!localStorage.getItem('pl_pen_digits_v1');
    // TA: con el TECLADO de la banda "1 2 0 / 8 0" → ✓
    const s4 = tap(q('pm_ta')); ['1', '2', '0', '/', '8', '0'].forEach(kk => s4.querySelector('.pps-keys button[data-k="' + kk + '"]').click()); const prevTa = s4.querySelector('.pps-prev').textContent; s4.querySelector('button[data-act="ok"]').click();
    const taVal = getNote(k).checklist.pm_ta;
    // dieta (texto): sigue por IA; tocar FUERA de la banda (dedo) convierte lo pendiente y la cierra
    const dieta = document.querySelector('#ck-row-' + ek + ' input[placeholder^="blanda"]'); const s3 = tap(dieta); const lbl3 = s3.querySelector('.pps-lbl').textContent; const noKeys = !s3.querySelector('.pps-keys'); scribble(s3);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 }));
    const closedByTap = !document.querySelector('.pl-pen-strip');
    await new Promise(r => setTimeout(r, 700));
    const dietaVal = getNote(k).checklist.dieta;
    // ✕ cierra sin poner nada
    const s5 = tap(q('pm_fr')); digit(s5, '1', 20); s5.querySelector('button[data-act="close"]').click();
    await new Promise(r => setTimeout(r, 1100));
    // el lápiz sobre el MISMO campo con la banda abierta: la cierra y pone el cursor
    const s6 = tap(q('pm_fr')); const open6 = !!s6; tap(q('pm_fr'));
    const closed6 = !document.querySelector('.pl-pen-strip'), focused6 = document.activeElement === q('pm_fr');
    return { lbl, focused, keys, preview, notYet, nStrokes, val, saved, okCls, stillOpen, closed, mlhVal, res, learned, lsLearned, prevTa, taVal, lbl3, noKeys, closedByTap, dietaVal, frVal: q('pm_fr').value, open6, closed6, focused6 };
  });
  check('L7 campos de una línea: FC abre la banda «FC» con teclado (sin robar el foco); "9" y "5" a mano → vista previa "95" al instante (sin IA), se pone solo tras 0.9 s y la banda se cierra sola; el dedo no pinta; vasopresor "96" con ✓ recalcula la dosis y aprende 2 plantillas; TA con el teclado "120/80"; dieta (texto, sin teclado) sigue por IA y se convierte al tocar fuera; ✕ cierra sin poner nada; tocar el mismo campo cierra la banda y pone el cursor',
    l7.lbl === 'FC' && l7.focused === false && l7.keys === 13 && l7.preview === '→ 95' && l7.notYet === '' && l7.nStrokes === 2 && l7.val === '95' && l7.saved === '95' && /ok/.test(l7.okCls) && l7.stillOpen && l7.closed
    && l7.mlhVal === '96' && /^54\.9 mcg\/kg\/h/.test(l7.res) && l7.learned === 2 && l7.lsLearned && l7.prevTa === '→ 120/80' && l7.taVal === '120/80'
    && /Dieta/.test(l7.lbl3) && l7.noKeys && l7.closedByTap && l7.dietaVal === 'TEXTO 5' && l7.frVal === '' && l7.open6 && l7.closed6 && l7.focused6, JSON.stringify(l7));

  // ── L9: reconocedor local: cadenas completas con plantillas perturbadas y aprendizaje de la letra propia ──
  const l9 = await page.evaluate(() => {
    let seed = 3; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    function word(str, s, gap) {
      const strokes = []; let x = 40;
      for (const ch of str) {
        if (ch === '.') { strokes.push([[x + 3, 100 + 42 * s, 0.5], [x + 4, 100 + 43 * s, 0.5], [x + 5, 100 + 42 * s, 0.5]]); x += 12 * s + gap; continue; }
        if (ch === ':') { strokes.push([[x + 3, 100 - 15 * s, 0.5], [x + 4, 100 - 14 * s, 0.5]]); strokes.push([[x + 3, 100 + 20 * s, 0.5], [x + 4, 100 + 21 * s, 0.5]]); x += 12 * s + gap; continue; }
        const tpl = PEN_DIGITS.templatesFor(ch)[0];
        tpl.forEach(st => strokes.push(st.map(p => [x + (p[0] - 20) * s + (rnd() - 0.5) * 3, 100 + (p[1] - 50) * s + (rnd() - 0.5) * 3, 0.5])));
        x += 60 * s + gap;
      }
      return strokes;
    }
    const words = ['130/80', '36.3', '1:2', '95', '0.03', '120', '7', '18', '4', '14.5', '100', '2', '6', '8', '9'];
    const out = words.map(w => ({ w, r: PEN_DIGITS.recognize(word(w, 0.8, 10)).text, r2: PEN_DIGITS.recognize(word(w, 0.5, 6)).text }));
    // aprender: una forma rara de "7" (sin barra, muy inclinada) se reconoce como 7 después de enseñársela
    const raro = [[[10, 10, .5], [60, 12, .5], [58, 14, .5], [30, 60, .5], [22, 90, .5]]];
    const antes = PEN_DIGITS.recognize(raro).text; PEN_DIGITS.learn('7', raro); const despues = PEN_DIGITS.recognize(raro).text;
    return { out, bad: out.filter(o => o.r !== o.w || o.r2 !== o.w), antes, despues, learned: PEN_DIGITS.learnedCount() };
  });
  check('L9 reconocedor local: 130/80, 36.3, 1:2, 95, 0.03, 120, 7, 18, 4, 14.5, 100 y dígitos sueltos se leen bien en dos tamaños; una forma propia enseñada se reconoce después',
    l9.bad.length === 0 && l9.despues === '7' && l9.learned >= 1, JSON.stringify(l9));

  // ── L8: cajas de texto fuera de la ficha (modal de paciente): el lápiz también escribe ahí ──
  const l8 = await page.evaluate(async () => {
    openAddModal();
    const ta = document.getElementById('mf-app-modal'); ta.value = '';
    const r = ta.getBoundingClientRect();
    const ev = (type, x, y) => ta.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.5 }));
    ev('pointerdown', 10, 10); ev('pointermove', 30, 14); ev('pointermove', 50, 12); ev('pointerup', 50, 12);
    const layer = !!(ta.nextElementSibling && ta.nextElementSibling.classList.contains('pl-ink-cv')); const key = _penField(ta);
    const pend = (PEN.pending[_penPendKey('', key)] || { strokes: [] }).strokes.length;
    await new Promise(r2 => setTimeout(r2, 2300));
    const val = ta.value;
    document.getElementById('patient-modal').style.display = 'none';
    localStorage.setItem('pl_pen_mode', '1');
    return { layer, key, pend, val };
  });
  check('L8 cajas fuera de la ficha (modal de paciente): el lápiz también escribe ahí; la tinta se convierte en texto y se pone en la caja (sin guardar tinta)',
    l8.layer && /^el:p\d+$/.test(l8.key) && l8.pend === 1 && l8.val === 'TEXTO 6', JSON.stringify(l8));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-PEN: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
