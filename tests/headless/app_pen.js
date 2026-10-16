// ✍️ Lápiz: tinta por caja (viaja con la nota, tachadura que borra, toque = cursor, dedo no pinta, menú de la esquina),
// escritura DIRECTA sobre los campos (sin recuadro): NÚMEROS con el reconocedor local PEN_OCR al momento; TEXTO en iPad por
// Scribble (la app no intercepta el lápiz) y fuera del iPad por IA (la lectura local solo se muestra provisional, nunca se guarda)
// + vista iPad: tira de camas en la barra, sin botones flotantes.
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
  let aiN = 0, aiMode = 'ok', aiDelay = 150; const aiBodies = [];
  await page.route('**/api/ai', async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) {}
    aiBodies.push(body);
    if (aiMode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) });
    const n = ++aiN; await new Promise(r => setTimeout(r, aiDelay));                    // el número se fija al LLEGAR la petición (varias pueden solaparse)
    const content = (((body || {}).messages || [])[0] || {}).content; const ptxt = Array.isArray(content) ? ((content.find(c => c.type === 'text') || {}).text || '') : '';
    const texto = /Dieta/.test(ptxt) ? (aiN--, 'BLANDA') : 'TEXTO ' + n;                // dieta: la IA lee lo mismo que el reconocedor local
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

  // ── Escritura DIRECTA (sin recuadro): trazos "a mano" con las plantillas del reconocedor, sobre el campo y lo que se salga ──
  // Helpers inyectados en la página: pen(el, tipo, x, y), strokeAt(P), writeChars(str, x0, y0, s, gap) (altura ≈ 90·s px),
  // tap(el). Los trazos van a document.elementFromPoint, como en el iPad (los que se salen del cuadro caen donde caigan).
  await page.evaluate(() => {
    window.__pen = (el, type, x, y, id, ptype) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id || 7, pointerType: ptype || 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.5 }));
    // forceEl: dispatch el pointerdown del PRIMER trazo en ese elemento (para cajas 0×0 en headless, como los modales).
    window.__strokeAt = (P, forceEl) => { const el0 = forceEl || document.elementFromPoint(P[0][0], P[0][1]) || document.body; __pen(el0, 'pointerdown', P[0][0], P[0][1]); P.slice(1).forEach(p => __pen(document.body, 'pointermove', p[0], p[1])); __pen(document.body, 'pointerup', P[P.length - 1][0], P[P.length - 1][1]); };
    window.__writeChars = (str, x0, y0, s, gap, opts) => {
      opts = opts || {}; const minCell = opts.minCell || 0; let x = x0, first = true;
      for (const ch of str) {
        if (ch === ' ') { x += 0.9 * 90 * s; continue; }
        if (ch === '.') { __strokeAt([[x + 2, y0 + 86 * s], [x + 3, y0 + 87 * s], [x + 4, y0 + 86 * s]], first ? opts.el : null); first = false; x += Math.max(8, minCell) * s + gap; continue; }
        const tpl = PEN_OCR.templatesFor(ch)[0];
        let minX = Infinity, maxX = -Infinity; tpl.forEach(st => st.forEach(p => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }));
        tpl.forEach((st, i) => { __strokeAt(st.map(p => [x + (p[0] - minX) * s, y0 + (p[1] - 5) * s]), (first && i === 0) ? opts.el : null); });
        first = false;
        x += Math.max(maxX - minX, minCell) * s + gap;
      }
    };
    window.__tap = (el) => { const r = el.getBoundingClientRect(); __pen(el, 'pointerdown', r.left + 4, r.top + 4); __pen(el, 'pointerup', r.left + 4, r.top + 4); };
  });

  // ── L5: caja grande en ✍️ → Texto: lo escrito se vuelve texto AL MOMENTO (local), queda con autor y la IA revisa en segundo plano ──
  aiDelay = 400;                                                        // margen holgado: la IA simulada contesta a ~1.7 s; el lote cierra a 1.3 s y se mide a 1.35 s
  const l5 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2');
    const k = pid(patients[0]); const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]';
    const ta = document.querySelector(sel); ta.value = ''; noteData[k].pendientes = '';
    ta.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 120));
    const r = ta.getBoundingClientRect();
    __writeChars('HAS', r.left + 8, r.top + 6, 0.4, 6);
    const live = ta.value, liveCls = ta.classList.contains('pl-pen-live'), glass = document.querySelector('canvas.pl-pen-glass'), sess = PEN_LIVE.el === ta && PEN_LIVE.strokes.length === 6;   // H (3 trazos) + A (2) + S (1)
    const notFocused = document.activeElement !== ta;
    await new Promise(r2 => setTimeout(r2, 1350));                       // pausa de 1.3 s → queda como texto (sin IA; la IA simulada tarda 150 ms más)
    const v1 = ta.value, nd1 = getNote(k).pendientes, prov = ta.classList.contains('pl-pen-prov'), closed = PEN_LIVE.el === null, inkSaved = !!(getNote(k).checklist.__ink && getNote(k).checklist.__ink.pendientes);
    await new Promise(r2 => setTimeout(r2, 700));                        // la IA (simulada, 400 ms) ya transcribió → ese texto es el que se guarda
    const v1b = ta.value, nd1b = getNote(k).pendientes, provOff = !ta.classList.contains('pl-pen-prov') && !ta.classList.contains('pl-pen-live');
    await new Promise(r2 => setTimeout(r2, 1500));                       // 1.4 s después de quedar, la tinta verde se desvanece
    const faded = glass && glass.style.opacity === '0';
    __writeChars('DM2', r.left + 8, r.top + 60, 0.4, 6);                 // otro renglón (más abajo) → salto de línea
    const live2 = ta.value;
    await new Promise(r2 => setTimeout(r2, 2000));
    const v2 = ta.value;
    __writeChars('POP', r.left + 150, r.top + 60, 0.4, 6);               // mismo renglón (< 10 s, misma altura) → espacio
    await new Promise(r2 => setTimeout(r2, 2000));
    const v3 = ta.value;
    return { live, liveCls, glass: !!glass, sess, notFocused, v1, nd1, prov, closed, inkSaved, v1b, nd1b, provOff, faded, live2, v2, v3, by: ((getNote(k).checklist.__pl_note_meta || {}).by || {}).pendientes, taStill: document.querySelector(sel) === ta };
  });
  aiDelay = 150;
  const ai0 = aiBodies[0] || {}; const c0 = ((ai0.messages || [])[0] || {}).content || [];
  const textPosted = calls.some(c => (c.m === 'POST' || c.m === 'PATCH') && /\/rest\/v1\/notes/.test(c.url) && c.body && typeof c.body.pendientes === 'string' && /^(HAS|TEXTO 1)/.test(c.body.pendientes));
  check('L5 ✍️ → Texto en una caja grande (fuera del iPad): «HAS» a mano aparece al momento como lectura PROVISIONAL (sin recuadro, sin robar el foco; tinta en el cristal, caja marcada); tras 1.3 s sigue provisional (morada, SIN guardar) mientras la IA transcribe; el texto de la IA (TEXTO 1) es el que se guarda, con autor y sin tinta; la tinta se desvanece; otro renglón → salto de línea; mismo renglón → espacio; viaja a la nube',
    l5.live === 'HAS' && l5.liveCls && l5.glass && l5.sess && l5.notFocused && l5.v1 === 'HAS' && l5.nd1 === '' && l5.prov && l5.closed && !l5.inkSaved && l5.v1b === 'TEXTO 1' && l5.nd1b === 'TEXTO 1' && l5.provOff && l5.faded
    && l5.live2 === 'TEXTO 1\nDM2' && l5.v2 === 'TEXTO 1\nTEXTO 2' && l5.v3 === 'TEXTO 1\nTEXTO 2 TEXTO 3' && l5.by && l5.by.i === 'GF' && l5.taStill
    && aiBodies.length === 3 && c0[0] && c0[0].type === 'image' && c0[0].source && c0[0].source.media_type === 'image/png' && c0[0].source.data.length > 100 && c0[1] && /pendientes \/ plan/.test(c0[1].text) && /SOLO un JSON/.test(c0[1].text) && ai0.max_tokens === 800
    && textPosted, JSON.stringify({ l5, nAi: aiBodies.length, textPosted }));

  // ── L6: si la IA falla (HTTP 500), lo leído localmente se queda tal cual (sin alert, sin tinta pendiente) ──
  aiMode = 'fail';
  const l6 = await page.evaluate(async () => {
    const k = pid(patients[0]); const sel = '#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]'; const ta = document.querySelector(sel);
    const r = ta.getBoundingClientRect();
    __writeChars('TAC', r.left + 8, r.top + 8, 0.4, 6);              // encima del texto que ya hay (otro renglón que el último lote)
    await new Promise(r2 => setTimeout(r2, 2000));
    return { val: ta.value, nd: getNote(k).pendientes, alerts: window.__alerts.length, closed: PEN_LIVE.el === null, prov: ta.classList.contains('pl-pen-prov'), menuHidden: !ta.nextElementSibling || !ta.nextElementSibling.nextElementSibling || ta.nextElementSibling.nextElementSibling.style.display === 'none' };
  });
  aiMode = 'ok';
  check('L6 la IA falla (HTTP 500): la lectura local NO se guarda (letras no fiables): la caja vuelve a lo que tenía, sin provisional, sin alert ni tinta pendiente ni botón ✍️ (aviso)',
    l6.val === 'TEXTO 1\nTEXTO 2 TEXTO 3' && l6.nd === l6.val && !l6.prov && l6.alerts === 0 && l6.closed && l6.menuHidden, JSON.stringify(l6));

  // ── L7: campos de UNA LÍNEA: se escribe ENCIMA (y lo que se salga del cuadro también cuenta), el número aparece al momento y se pone solo ──
  const l7 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2'); PEN_OCR.forget(); PEN_LIVE.learnMs = 60;
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const prep = async (el) => { el.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 120)); return el.getBoundingClientRect(); };
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // FC: "95" de 36 px de alto, más ancho que el cuadro (el "5" cae fuera) → lectura al momento, sin foco; tras 0.9 s se guarda; tinta verde que se desvanece; aprende 2 plantillas
    const fc = q('pm_fc'); let r = await prep(fc);
    __writeChars('95', r.left + 4, r.top + 2, 0.5, 8);
    const live = fc.value, cls = fc.classList.contains('pl-pen-live'), notFocused = document.activeElement !== fc, nStrokes = PEN_LIVE.strokes.length, notYet = getNote(k).checklist.pm_fc || '';
    const spilled = Math.max.apply(null, PEN_LIVE.strokes.flat().map(p => p[0])) > r.right;      // la tinta se sale del cuadro por la derecha
    await wait(1100);
    const val = fc.value, saved = getNote(k).checklist.pm_fc, closed = PEN_LIVE.el === null, learned = PEN_OCR.learnedCount(), lsLearned = !!localStorage.getItem('pl_pen_digits_v1');
    await wait(2000);
    const faded = document.querySelector('canvas.pl-pen-glass').style.opacity === '0';
    // el dedo no escribe
    __pen(fc, 'pointerdown', r.left + 6, r.top + 6, 9, 'touch'); __pen(document.body, 'pointermove', r.left + 30, r.top + 10, 9, 'touch'); __pen(document.body, 'pointerup', r.left + 30, r.top + 10, 9, 'touch');
    const fingerNo = PEN_LIVE.el === null && fc.value === '95';
    // vasopresor: mL/h "96" → recalcula la dosis
    toggleChecklist(k, 'vp_nore_on'); { const p = q('pm_peso'); p.value = '70'; p.dispatchEvent(new Event('input', { bubbles: true })); }
    const mlh = q('vp_nore_mlh'); r = await prep(mlh); __writeChars('96', r.left + 4, r.top + 2, 0.4, 8); await wait(1100);
    const mlhVal = q('vp_nore_mlh').value, res = document.getElementById('vp-nore-res-' + ek).textContent;
    // TA: "130/80" (la barra es un trazo recto inclinado)
    const ta = q('pm_ta'); r = await prep(ta); __writeChars('130/80', r.left + 4, r.top + 2, 0.34, 5, { minCell: 45 }); const taLive = ta.value; await wait(1100);
    const taVal = getNote(k).checklist.pm_ta;
    // dieta (texto): «BLANDA» en mayúsculas de molde → al momento; la IA (simulada) lee lo mismo → no cambia nada
    const dieta = document.querySelector('#ck-row-' + ek + ' input.ck-dieta'); r = await prep(dieta); __writeChars('BLANDA', r.left + 4, r.top + 2, 0.36, 6);
    const dietaLive = dieta.value; await wait(1700); const dietaVal = getNote(k).checklist.dieta; await wait(500); const dietaStill = dieta.value;
    // cambio RÁPIDO de campo: "7" en FR y, sin esperar, "8" lejos en uresis → cada uno a su campo
    const fr = q('pm_fr'), ur = q('pm_uresis'); r = await prep(fr); __writeChars('7', r.left + 4, r.top + 2, 0.4, 8);
    const ru = ur.getBoundingClientRect(); __writeChars('8', ru.left + 4, ru.top + 2, 0.4, 8); await wait(1100);
    const frVal = getNote(k).checklist.pm_fr, urVal = getNote(k).checklist.pm_uresis;
    // el trazo que se sale al cuadro de al lado sigue siendo del primer campo: "10" empezando a media caja de SaO₂ (el "0" cae fuera, hacia O₂ L)
    const sa = q('pm_sao2'), o2n = q('pm_o2l'); r = await prep(sa); __writeChars('10', r.left + 30, r.top + 2, 0.5, 8);
    const saLive = sa.value, dxLive = o2n.value, over = ((document.elementFromPoint(r.right + 12, r.top + 10) || {}).dataset || {}).field || (document.elementFromPoint(r.right + 12, r.top + 10) || {}).tagName; await wait(1100);
    const saVal = getNote(k).checklist.pm_sao2, dxVal = getNote(k).checklist.pm_o2l || '';
    // toque en OTRO campo con la sesión abierta: cierra lo pendiente ("5" en T°) y pone el cursor
    const temp = q('pm_temp'); r = await prep(temp); __writeChars('5', r.left + 4, r.top + 2, 0.4, 8); __tap(fr);
    const tempVal = getNote(k).checklist.pm_temp, frFocused = document.activeElement === fr, tempClosed = PEN_LIVE.el === null;
    // corrección tecleada → se aprende la corrección (O₂ L: se lee "7", se corrige a "1")
    PEN_LIVE.learnMs = 400; const o2 = q('pm_o2l'); r = await prep(o2); __writeChars('7', r.left + 4, r.top + 2, 0.4, 8); await wait(1000);
    const before = PEN_OCR.learnedCount(); o2.value = '1'; o2.dispatchEvent(new Event('input', { bubbles: true })); await wait(600); const afterFix = PEN_OCR.learnedCount();
    // tachar la tinta pendiente la borra y el campo vuelve a lo que tenía
    const iu = q('pm_talla'); r = await prep(iu); __writeChars('9', r.left + 4, r.top + 2, 0.4, 8); const iuLive = iu.value;
    __strokeAt([[r.left + 2, r.top + 2], [r.left + 12, r.top + 30], [r.left + 6, r.top + 1], [r.left + 18, r.top + 32], [r.left + 10, r.top], [r.left + 24, r.top + 32], [r.left + 16, r.top + 2], [r.left + 30, r.top + 32], [r.left + 22, r.top + 2], [r.left + 36, r.top + 30]]);
    const iuAfter = iu.value, iuClosed = PEN_LIVE.el === null; await wait(1100); const iuVal = getNote(k).checklist.pm_talla || '';
    // lápiz apagado: no pasa nada
    localStorage.setItem('pl_pen_mode', '0'); r = await prep(fc); __writeChars('4', r.left + 4, r.top + 2, 0.4, 8); const offVal = fc.value; localStorage.setItem('pl_pen_mode', '2');
    return { live, cls, notFocused, nStrokes, notYet, spilled, val, saved, closed, learned, lsLearned, faded, fingerNo, mlhVal, res, taLive, taVal, dietaLive, dietaVal, dietaStill, frVal, urVal, saLive, dxLive, over, saVal, dxVal, tempVal, frFocused, tempClosed, before, afterFix, iuLive, iuAfter, iuClosed, iuVal, offVal };
  });
  check('L7 campos de una línea: «95» escrito ENCIMA de FC (más ancho que el cuadro) se lee al momento sin foco ni recuadro, se guarda solo tras 0.9 s y aprende la letra; la tinta se desvanece; el dedo no escribe; vasopresor «96» recalcula la dosis; TA «130/80»; dieta «BLANDA» (texto) provisional al momento y la IA lo confirma como valor; cambio rápido FR→uresis; el dígito que se sale al cuadro de al lado sigue siendo de SaO₂; toque en otro campo cierra y pone el cursor; la corrección tecleada se aprende; tachar borra lo pendiente (talla); apagado no escribe',
    l7.live === '95' && l7.cls && l7.notFocused && l7.nStrokes === 2 && l7.notYet === '' && l7.spilled && l7.val === '95' && l7.saved === '95' && l7.closed && l7.learned === 2 && l7.lsLearned && l7.faded && l7.fingerNo
    && l7.mlhVal === '96' && /^54\.9 mcg\/kg\/h/.test(l7.res) && l7.taLive === '130/80' && l7.taVal === '130/80' && l7.dietaLive === 'BLANDA' && l7.dietaVal === 'BLANDA' && l7.dietaStill === 'BLANDA'
    && l7.frVal === '7' && l7.urVal === '8' && l7.saLive === '10' && l7.dxLive === '' && l7.saVal === '10' && l7.dxVal === '' && l7.tempVal === '5' && l7.frFocused && l7.tempClosed && l7.afterFix === l7.before + 1
    && l7.iuLive === '9' && l7.iuAfter === '' && l7.iuClosed && l7.iuVal === '' && l7.offVal === '95', JSON.stringify(l7));

  // ── L8: cajas de texto fuera de la ficha (modal de paciente): el lápiz también escribe ahí (texto local + revisión IA) ──
  const l8 = await page.evaluate(async () => {
    openAddModal();
    const ta = document.getElementById('mf-app-modal'); ta.value = '';
    ta.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 120));
    const r = ta.getBoundingClientRect();
    __writeChars('HAS', (r.left || 20) + 8, (r.top || 20) + 6, 0.4, 6, { el: ta });   // el modal es 0×0 en headless: forzamos el destino del lápiz
    const live = ta.value, key = _penField(ta), kind = PEN_LIVE.kind, noLayer = !(ta.nextElementSibling && ta.nextElementSibling.classList.contains('pl-ink-cv'));
    await new Promise(r2 => setTimeout(r2, 1350)); const val = ta.value;      // tras la pausa (local, antes de que responda la IA)
    await new Promise(r2 => setTimeout(r2, 700)); const valAi = ta.value;     // la IA (simulada) revisa y corrige
    document.getElementById('patient-modal').style.display = 'none';
    localStorage.setItem('pl_pen_mode', '1');
    return { live, key, kind, noLayer, val, valAi };
  });
  check('L8 cajas fuera de la ficha (modal de paciente): «HAS» aparece al momento como provisional (sin capa de tinta) y el texto que queda es el de la IA',
    l8.live === 'HAS' && /^el:p\d+$/.test(l8.key) && l8.kind === 'ta' && l8.noLayer && l8.val === 'HAS' && l8.valAi === 'TEXTO 4', JSON.stringify(l8));

  // ── L10: en iPad el TEXTO lo escribe Scribble (la app no intercepta el lápiz) y los NÚMEROS los atiende la app ──
  const l10 = await page.evaluate(async () => {
    window.__pl_force_ipad = true; localStorage.setItem('pl_pen_mode', '2'); PEN_LIVE.scribbleHint = false;
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pd = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.5 }));   // true = NO se canceló
    // dieta (texto): sin sesión, el evento sigue su curso (Scribble), el valor no se toca, un aviso
    const dieta = document.querySelector('#ck-row-' + ek + ' input.ck-dieta'); const before = dieta.value; dieta.scrollIntoView({ block: 'center' }); await wait(120);
    const r = dieta.getBoundingClientRect(); const notPrevented = pd(dieta, r.left + 6, r.top + 6);
    __pen(document.body, 'pointermove', r.left + 30, r.top + 10); __pen(document.body, 'pointerup', r.left + 30, r.top + 10);
    const noSession = PEN_LIVE.el === null, untouched = dieta.value === before, hint = PEN_LIVE.scribbleHint === true;
    // caja grande (pendientes): tampoco se intercepta
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]'); const rt = ta.getBoundingClientRect();
    const notPrevented2 = pd(ta, rt.left + 10, rt.top + 10); __pen(document.body, 'pointerup', rt.left + 10, rt.top + 10); const noSession2 = PEN_LIVE.el === null;
    // FC (número): la app sí lo atiende y entra al instante
    const fc = q('pm_fc'); fc.scrollIntoView({ block: 'center' }); await wait(120); const rf = fc.getBoundingClientRect();
    __writeChars('95', rf.left + 4, rf.top + 2, 0.5, 8); const fcLive = fc.value, fcSess = PEN_LIVE.el === fc; await wait(1100); const fcVal = getNote(k).checklist.pm_fc;
    window.__pl_force_ipad = false; localStorage.setItem('pl_pen_mode', '1');
    return { notPrevented, noSession, untouched, hint, notPrevented2, noSession2, fcLive, fcSess, fcVal };
  });
  check('L10 iPad: el TEXTO va a Scribble (la app no intercepta el lápiz en dieta ni en la caja grande: sin sesión, evento no cancelado, valor intacto, un aviso) y los NÚMEROS siguen entrando al instante por la app',
    l10.notPrevented && l10.noSession && l10.untouched && l10.hint && l10.notPrevented2 && l10.noSession2 && l10.fcLive === '95' && l10.fcSess && l10.fcVal === '95', JSON.stringify(l10));

  // ── L12: iPad con sesión NUMÉRICA abierta: el trazo que empieza PEGADO a la tinta (se salió del cuadro) sigue siendo del número aunque caiga
  //        sobre un campo de texto; el que empieza LEJOS sobre un campo de TEXTO cierra el número y NO se intercepta (Scribble lo recibe).
  //        Sin sesión, en Tinta y en Scribble/off, pointerdown y touchstart (stylus) cancelables sobre campos de texto devuelven true. ──
  const l12 = await page.evaluate(async () => {
    window.__pl_force_ipad = true; localStorage.setItem('pl_pen_mode', '2');
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const pd = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure: 0.5 }));   // true = NO se canceló
    try { Object.defineProperty(Touch.prototype, 'touchType', { get() { return 'stylus'; }, configurable: true }); } catch (_) {}          // WebKit: Apple Pencil
    const ts = (el, x, y) => { const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y }); return el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] })); };
    const edge = () => { const xs = PEN_LIVE.strokes.flat().map(p => p[0]), ys = PEN_LIVE.strokes.flat().map(p => p[1]); return [Math.max.apply(null, xs) + 4, (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2]; };   // pegado a la tinta, a la derecha
    const dieta = document.querySelector('#ck-row-' + ek + ' input.ck-dieta'); const dietaBefore = dieta.value;
    // "95" en FC → sesión; pointerdown con destino dieta pero PEGADO a la tinta → se intercepta y sigue en FC; al soltar sin arrastrar: toque → cierra y guarda, sin cursor en dieta
    const fc = q('pm_fc'); fc.scrollIntoView({ block: 'center' }); await wait(120); let r = fc.getBoundingClientRect();
    __writeChars('95', r.left + 4, r.top + 2, 0.5, 8); const open1 = PEN_LIVE.el === fc; let p = edge();
    const nearPrevented = !pd(dieta, p[0], p[1]); const stillOpen1 = PEN_LIVE.el === fc; __pen(document.body, 'pointerup', p[0], p[1]);
    const closed1 = PEN_LIVE.el === null, fcVal = getNote(k).checklist.pm_fc, notFocused = document.activeElement !== dieta;
    // "7" en FR → sesión; pointerdown LEJOS sobre dieta (texto, iPad): NO se cancela, la sesión se cierra, el 7 queda; dieta intacta
    const fr = q('pm_fr'); fr.scrollIntoView({ block: 'center' }); await wait(120); r = fr.getBoundingClientRect();
    __writeChars('7', r.left + 4, r.top + 2, 0.4, 8); const open2 = PEN_LIVE.el === fr;
    let rd = dieta.getBoundingClientRect(); const far = [rd.left + 6, rd.top + 6]; const isFar = _penLiveFar([far]);
    const farNotPrevented = pd(dieta, far[0], far[1]); const closed2 = PEN_LIVE.el === null; __pen(document.body, 'pointermove', far[0] + 20, far[1] + 4); __pen(document.body, 'pointerup', far[0] + 20, far[1] + 4);
    const frVal = getNote(k).checklist.pm_fr, noSession2 = PEN_LIVE.el === null && PEN_LIVE.active === null, dietaSame = dieta.value === dietaBefore;
    // touchstart: con sesión en uresis, el que empieza lejos sobre dieta NO se cancela (sigue abierta: la cierra el pointerdown); el pegado a la tinta sí
    const ur = q('pm_uresis'); ur.scrollIntoView({ block: 'center' }); await wait(120); r = ur.getBoundingClientRect();
    __writeChars('8', r.left + 4, r.top + 2, 0.4, 8); const open3 = PEN_LIVE.el === ur; rd = dieta.getBoundingClientRect();
    const tsFarOk = ts(dieta, rd.left + 6, rd.top + 6), stillOpen3 = PEN_LIVE.el === ur; p = edge(); const tsNearPrevented = !ts(dieta, p[0], p[1]);
    await wait(1100); const urVal = getNote(k).checklist.pm_uresis, closed3 = PEN_LIVE.el === null;
    // sin sesión: → Texto, Tinta y Scribble/off sobre dieta (input de texto), pendientes (caja de la ficha) y la caja del modal (sin data-key)
    const taPend = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]'); const rp = taPend.getBoundingClientRect(); const taModal = document.getElementById('mf-app-modal');
    const probe = () => { const o = { pdDieta: pd(dieta, rd.left + 6, rd.top + 6), tsDieta: ts(dieta, rd.left + 6, rd.top + 6), pdPend: pd(taPend, rp.left + 8, rp.top + 8) }; __pen(document.body, 'pointerup', rp.left + 8, rp.top + 8);
      o.tsPend = ts(taPend, rp.left + 8, rp.top + 8); o.pdModal = pd(taModal, 30, 30); __pen(document.body, 'pointerup', 30, 30); o.tsModal = ts(taModal, 30, 30); o.clean = PEN_LIVE.el === null && PEN_LIVE.active === null && PEN.active === null; return o; };
    const text = probe(); localStorage.setItem('pl_pen_mode', '1'); const ink = probe(); localStorage.setItem('pl_pen_mode', '0'); const off = probe();
    try { delete Touch.prototype.touchType; } catch (_) {}
    window.__pl_force_ipad = false; localStorage.setItem('pl_pen_mode', '1');
    return { open1, nearPrevented, stillOpen1, closed1, fcVal, notFocused, open2, isFar, farNotPrevented, closed2, frVal, noSession2, dietaSame, open3, tsFarOk, stillOpen3, tsNearPrevented, urVal, closed3, text, ink, off };
  });
  const allTrue = (o, except) => Object.keys(o).every(key => (except || []).includes(key) ? o[key] === false : o[key] === true);
  check('L12 iPad con número abierto: el trazo pegado a la tinta sigue en FC aunque caiga en dieta (se intercepta; toque cierra y guarda sin robar el cursor); el que empieza LEJOS sobre dieta cierra FR, guarda el 7 y NO se cancela (Scribble); touchstart stylus igual (lejos pasa, pegado se cancela); sin sesión en → Texto, Tinta (salvo la caja de la ficha, que es tinta) y Scribble/off ningún pointerdown/touchstart sobre texto se cancela',
    l12.open1 && l12.nearPrevented && l12.stillOpen1 && l12.closed1 && l12.fcVal === '95' && l12.notFocused && l12.open2 && l12.isFar && l12.farNotPrevented && l12.closed2 && l12.frVal === '7' && l12.noSession2 && l12.dietaSame
    && l12.open3 && l12.tsFarOk && l12.stillOpen3 && l12.tsNearPrevented && l12.urVal === '8' && l12.closed3
    && allTrue(l12.text) && allTrue(l12.ink, ['pdPend', 'tsPend']) && allTrue(l12.off), JSON.stringify(l12));

  // ── L11: sin ayudante de IA (fuera del iPad): el texto NO se guarda con letras locales; la caja vuelve a lo que tenía ──
  const l11 = await page.evaluate(async () => {
    const savedCfg = localStorage.getItem('hgl-worker-config'); localStorage.removeItem('hgl-worker-config'); localStorage.setItem('pl_pen_mode', '2');
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const dieta = document.querySelector('#ck-row-' + ek + ' input.ck-dieta'); const before = dieta.value, savedBefore = getNote(k).checklist.dieta; dieta.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 120));
    const r = dieta.getBoundingClientRect(); __writeChars('HAS', r.left + 4, r.top + 2, 0.36, 6); const live = dieta.value;
    await new Promise(r2 => setTimeout(r2, 1600));
    const after = dieta.value, savedAfter = getNote(k).checklist.dieta, prov = dieta.classList.contains('pl-pen-prov');
    // número: sigue funcionando sin IA
    const fr = document.querySelector('#ck-row-' + ek + ' input[data-field="pm_fr"]'); fr.scrollIntoView({ block: 'center' }); await new Promise(r2 => setTimeout(r2, 120));
    const rf = fr.getBoundingClientRect(); __writeChars('8', rf.left + 4, rf.top + 2, 0.4, 8); await new Promise(r2 => setTimeout(r2, 1100)); const frVal = getNote(k).checklist.pm_fr;
    localStorage.setItem('hgl-worker-config', savedCfg); localStorage.setItem('pl_pen_mode', '1');
    return { before, live, after, savedBefore, savedAfter, prov, frVal };
  });
  check('L11 sin IA configurada (fuera del iPad): la lectura local del texto se muestra solo mientras se escribe y NO se guarda; la caja vuelve a lo que tenía (aviso de qué activar); los números siguen entrando',
    l11.live === 'HAS' && l11.after === l11.before && l11.savedAfter === l11.savedBefore && !l11.prov && l11.frVal === '8', JSON.stringify(l11));

  // ── L13: fuera del iPad, una palabra tras otra en la misma caja mientras la IA (lenta, 2 s) aún no respondió: cada lote entra DETRÁS del anterior, en orden; nada se pierde ──
  aiDelay = 2000; const n0 = aiN;
  const l13 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2'); window.__pl_force_ipad = false;
    const k = pid(patients[0]); const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    ta.scrollIntoView({ block: 'center' }); await wait(120); const r = ta.getBoundingClientRect(); const v0 = ta.value, s0 = getNote(k).pendientes;
    __writeChars('HAS', r.left + 8, r.top + 6, 0.4, 6, { el: ta });
    await wait(1400);                                                    // pausa → lote 1 a la IA (tarda 2 s): provisional, sin guardar
    const a = { v: ta.value, s: getNote(k).pendientes, prov: ta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length, closed: PEN_LIVE.el === null };
    __writeChars('DM2', r.left + 8, r.top + 50, 0.4, 6, { el: ta });      // segunda palabra (otro renglón) ANTES de que vuelva la IA del lote 1: el provisional se queda
    const b = { v: ta.value, open: PEN_LIVE.el === ta, base: PEN_LIVE.base, pend: PEN_LIVE.pendingAi.length };
    await wait(1400);                                                    // pausa → lote 2, en espera detrás del 1
    const c = { v: ta.value, s: getNote(k).pendientes, prov: ta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length, closed: PEN_LIVE.el === null };
    __writeChars('POP', r.left + 8, r.top + 94, 0.4, 6, { el: ta });      // tercera, con la sesión abierta cuando vuelve la IA del lote 1
    await wait(800);                                                     // ~3.6 s: la IA del lote 1 ya volvió y se guardó; el 2 sigue provisional detrás; el 3 se está escribiendo
    const d = { v: ta.value, s: getNote(k).pendientes, base: PEN_LIVE.base, open: PEN_LIVE.el === ta, pend: PEN_LIVE.pendingAi.length };
    await wait(4200);                                                    // el 3 cierra, espera al 2 y luego entra el suyo
    const e = { v: ta.value, s: getNote(k).pendientes, prov: ta.classList.contains('pl-pen-prov'), live: ta.classList.contains('pl-pen-live'), pend: PEN_LIVE.pendingAi.length, closed: PEN_LIVE.el === null };
    localStorage.setItem('pl_pen_mode', '1');
    return { v0, s0, a, b, c, d, e };
  });
  aiDelay = 150;
  const T = (n) => 'TEXTO ' + (n0 + n);
  check('L13 fuera del iPad, IA lenta (2 s): «HAS» queda provisional (sin guardar); «DM2» escrito antes de que vuelva la IA NO lo cancela (sigue provisional, la caja muestra ambos); vuelve la IA del 1 → se guarda y la base de lo que se escribe («POP») se corrige; al final los tres lotes quedan en orden (TEXTO n+1, n+2, n+3), guardados, sin provisional',
    l13.a.v === l13.v0 + '\nHAS' && l13.a.s === l13.s0 && l13.a.prov && l13.a.pend === 1 && l13.a.closed
    && l13.b.v === l13.v0 + '\nHAS\nDM2' && l13.b.open && l13.b.base === l13.v0 + '\nHAS' && l13.b.pend === 1
    && l13.c.v === l13.v0 + '\nHAS\nDM2' && l13.c.s === l13.s0 && l13.c.prov && l13.c.pend === 2 && l13.c.closed
    && l13.d.s === l13.v0 + '\n' + T(1) && l13.d.v === l13.v0 + '\n' + T(1) + '\nDM2\nPOP' && l13.d.base === l13.v0 + '\n' + T(1) + '\nDM2' && l13.d.open && l13.d.pend === 1
    && l13.e.v === l13.v0 + '\n' + T(1) + '\n' + T(2) + '\n' + T(3) && l13.e.s === l13.e.v && !l13.e.prov && !l13.e.live && l13.e.pend === 0 && l13.e.closed
    && aiN === n0 + 3, JSON.stringify({ l13, n0, aiN }));

  // ── L14: el TECLADO toma una caja con provisional (foco / tecla): el provisional se quita ANTES de teclear (nunca se guarda con lo tecleado) y la IA
  //        se agrega detrás al llegar; una sesión abierta se cierra con la tecla. Repintado mientras la IA tarda: el texto cae en la MISMA caja
  //        (la dieta solo lleva data-ck, igual que la fecha de una cirugía, que va antes en la ficha) ──
  aiDelay = 1500; const n14 = aiN;
  const l14 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2'); window.__pl_force_ipad = false;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="pendientes"]');
    ta.scrollIntoView({ block: 'center' }); await wait(120); let r = ta.getBoundingClientRect(); const v0 = ta.value, s0 = getNote(k).pendientes;
    __writeChars('TAC', r.left + 8, r.top + 6, 0.4, 6, { el: ta }); await wait(1400);           // provisional; la IA (1.5 s) en camino
    const a = { v: ta.value, prov: ta.classList.contains('pl-pen-prov'), s: getNote(k).pendientes, activeBefore: (document.activeElement || {}).tagName + ':' + ((document.activeElement || {}).dataset || {}).field };
    let fired = 0; const probe = (ev) => { if (ev.target === ta) fired++; }; document.addEventListener('focus', probe, true);
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (_) {}
    ta.focus();                                                                                    // el teclado toma la caja (foco) → el provisional se quita
    document.removeEventListener('focus', probe, true);
    const b = { v: ta.value, prov: ta.classList.contains('pl-pen-prov'), live: ta.classList.contains('pl-pen-live'), focused: document.activeElement === ta, hasFocus: document.hasFocus(), fired, pend: PEN_LIVE.pendingAi.length };
    ta.value = ta.value + '\nX'; ta.dispatchEvent(new Event('input', { bubbles: true }));          // se teclea: se guarda SIN el provisional
    const c = { s: getNote(k).pendientes };
    await wait(1700);                                                                              // vuelve la IA: su texto se agrega detrás de lo tecleado
    const d = { v: ta.value, s: getNote(k).pendientes, prov: ta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length };
    ta.blur();
    // sesión ABIERTA (se está escribiendo) y llega una tecla: la sesión se cierra (va a la IA) y el provisional no se mezcla con lo tecleado
    __writeChars('IC', r.left + 8, r.top + 50, 0.4, 6, { el: ta }); const e0 = { v: ta.value, open: PEN_LIVE.el === ta };
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    const e = { v: ta.value, closed: PEN_LIVE.el === null, prov: ta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length };
    ta.value = ta.value + 'Y'; ta.dispatchEvent(new Event('input', { bubbles: true })); const e1 = { s: getNote(k).pendientes };
    await wait(1700); const f = { v: ta.value, s: getNote(k).pendientes, pend: PEN_LIVE.pendingAi.length };
    // repintado mientras la IA tarda: con una cirugía (su fecha es el primer input[data-ck] de la ficha) la dieta repintada sigue siendo la dieta
    const cxId = addCirugia(k); try { document.activeElement.blur(); } catch (_) {}
    updateDieta(k, 'LIQUIDOS'); _rerenderCard(k); await wait(150);
    const dieta = document.querySelector('#ck-row-' + ek + ' input.ck-dieta'); dieta.scrollIntoView({ block: 'center' }); await wait(120);
    r = dieta.getBoundingClientRect(); __writeChars('BLANDA', r.left + 4, r.top + 2, 0.36, 6); await wait(1400);
    const fechaDe = () => (getNote(k).checklist.cirugias.find(c => String(c.id) === String(cxId)) || {}).fecha;
    const g = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), fecha: fechaDe() };
    _rerenderCard(k); await wait(150);                                                             // la caja original ya no está en el DOM
    const dieta2 = document.querySelector('#ck-row-' + ek + ' input.ck-dieta');
    const h = { nuevo: dieta2 !== dieta && !dieta.isConnected, v: dieta2.value, firstCk: (document.querySelector('#card-' + CSS.escape(k) + ' input[data-ck]') || {}).className };
    await wait(1700);
    const i = { v: dieta2.value, s: getNote(k).checklist.dieta, fecha: fechaDe(), cxVal: (document.querySelector('#card-' + CSS.escape(k) + ' input.cx-date') || {}).value, pend: PEN_LIVE.pendingAi.length };
    removeCirugia(k, cxId); localStorage.setItem('pl_pen_mode', '1');
    return { v0, s0, a, b, c, d, e0, e, e1, f, g, h, i };
  });
  aiDelay = 150;
  const T14 = (n) => 'TEXTO ' + (n14 + n);
  check('L14 teclado sobre un provisional: con «TAC» provisional (sin guardar), el FOCO lo quita (la caja vuelve a lo confirmado) y lo tecleado se guarda sin él; la IA llega y se agrega detrás; con la sesión abierta («IC»), una TECLA la cierra sin mezclar el provisional con lo tecleado; repintado con una cirugía delante: la dieta repintada recibe «BLANDA» y la fecha de la cirugía no se toca',
    l14.a.v === l14.v0 + '\nTAC' && l14.a.prov && l14.a.s === l14.s0
    && l14.b.v === l14.v0 && !l14.b.prov && !l14.b.live && l14.b.focused && l14.b.pend === 1
    && l14.c.s === l14.v0 + '\nX'
    && l14.d.s === l14.v0 + '\nX\n' + T14(1) && l14.d.v === l14.d.s && !l14.d.prov && l14.d.pend === 0
    && l14.e0.v === l14.d.v + '\nIC' && l14.e0.open
    && l14.e.v === l14.d.v && l14.e.closed && !l14.e.prov && l14.e.pend === 1
    && l14.e1.s === l14.d.v + 'Y'
    && l14.f.s === l14.d.v + 'Y\n' + T14(2) && l14.f.v === l14.f.s && l14.f.pend === 0
    && l14.g.v === 'BLANDA' && l14.g.prov && /^\d{4}-\d{2}-\d{2}$/.test(l14.g.fecha)
    && l14.h.nuevo && l14.h.v === 'LIQUIDOS' && l14.h.firstCk === 'cx-date'
    && l14.i.v === 'BLANDA' && l14.i.s === 'BLANDA' && l14.i.fecha === l14.g.fecha && l14.i.cxVal === l14.g.fecha && l14.i.pend === 0
    && aiN === n14 + 2, JSON.stringify({ l14, n14, aiN }));

  // ── L15: caja SUELTA (el teclado la tomó) y se vuelve a escribir con el lápiz antes de que vuelva la IA: ninguna lectura local
  //        (ni la de la sesión abierta ni una provisional posterior) se toma por texto tecleado; solo entra la IA, detrás de lo tecleado.
  //        Fase 1: la IA del lote suelto vuelve con la sesión ABIERTA en la misma caja. Fase 2: un lote nuevo nace con uno suelto
  //        pendiente → también va suelto (sin provisional). La dieta: la IA simulada siempre lee «BLANDA». ──
  aiDelay = 2000; const nb15 = aiBodies.length;
  const l15 = await page.evaluate(async () => {
    localStorage.setItem('pl_pen_mode', '2'); window.__pl_force_ipad = false;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_'); const sel = '#ck-row-' + ek + ' input.ck-dieta';
    try { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); } catch (_) {}
    updateDieta(k, 'LIQUIDOS'); _rerenderCard(k); await wait(150);
    const dieta = document.querySelector(sel); dieta.scrollIntoView({ block: 'center' }); await wait(250);
    const r = dieta.getBoundingClientRect(); const nd = () => getNote(k).checklist.dieta;
    __writeChars('HAS', r.left + 4, r.top + 2, 0.36, 6); await wait(1400);                       // lote 1 provisional; su IA tarda 2 s
    const a = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length, s: nd() };
    dieta.focus();                                                                                 // el teclado toma la caja → suelto
    const b = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), released: PEN_LIVE.pendingAi.every(P => P.released), focused: document.activeElement === dieta };
    dieta.value = dieta.value + ' X'; dieta.dispatchEvent(new Event('input', { bubbles: true })); // se teclea
    const c = { s: nd() };
    await wait(1300);                                                                              // ~2.7 s: la IA del 1 aún no volvió
    __writeChars('DM2', r.left + 4, r.top + 2, 0.36, 6);                                          // se vuelve a escribir con el lápiz (sesión abierta)
    const d = { v: dieta.value, open: PEN_LIVE.el === dieta, base: PEN_LIVE.base, orig: PEN_LIVE.orig, s: nd() };
    await wait(800);                                                                               // ~3.55 s: volvió la IA del 1 (3.3 s) con la sesión abierta
    const e = { v: dieta.value, s: nd(), open: PEN_LIVE.el === dieta, base: PEN_LIVE.base, pend: PEN_LIVE.pendingAi.length };
    await wait(900);                                                                               // la sesión cerró (pausa 1.3 s) → lote 2: ya no hay sueltos → provisional normal
    const f = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), pend: PEN_LIVE.pendingAi.length, s: nd(), closed: PEN_LIVE.el === null };
    await wait(2000);                                                                              // vuelve la IA del 2
    const g = { v: dieta.value, s: nd(), pend: PEN_LIVE.pendingAi.length, prov: dieta.classList.contains('pl-pen-prov'), same: document.querySelector(sel) === dieta };
    // Fase 2: lote 3 provisional → una TECLA lo suelta (la caja sigue con el foco) → lote 4 con el lápiz mientras el 3 sigue pendiente
    __writeChars('TAC', r.left + 4, r.top + 2, 0.36, 6); await wait(1400);
    const h0 = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov') };
    dieta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
    const h1 = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), released: PEN_LIVE.pendingAi.every(P => P.released) };
    __writeChars('POP', r.left + 4, r.top + 2, 0.36, 6); const h2 = { v: dieta.value, open: PEN_LIVE.el === dieta }; await wait(1400);
    const h = { v: dieta.value, prov: dieta.classList.contains('pl-pen-prov'), live: dieta.classList.contains('pl-pen-live'), pend: PEN_LIVE.pendingAi.length, released: PEN_LIVE.pendingAi.every(P => P.released), s: nd(), closed: PEN_LIVE.el === null };
    await wait(700);                                                                               // vuelve la IA del 3 (sin sesión abierta)
    const i = { v: dieta.value, s: nd(), pend: PEN_LIVE.pendingAi.length, prov: dieta.classList.contains('pl-pen-prov') };
    await wait(1500);                                                                              // vuelve la IA del 4
    const j = { v: dieta.value, s: nd(), pend: PEN_LIVE.pendingAi.length, prov: dieta.classList.contains('pl-pen-prov'), live: dieta.classList.contains('pl-pen-live') };
    try { dieta.blur(); } catch (_) {}
    localStorage.setItem('pl_pen_mode', '1');
    return { a, b, c, d, e, f, g, h0, h1, h2, h, i, j };
  });
  aiDelay = 150;
  const V1 = 'LIQUIDOS X BLANDA', V2 = V1 + ' BLANDA', V3 = V2 + ' BLANDA', V4 = V3 + ' BLANDA';
  check('L15 caja suelta y se vuelve a escribir con el lápiz antes de que vuelva la IA: «HAS» provisional → el foco lo quita y se teclea « X» (guardado sin él); «DM2» abierto cuando vuelve la IA del 1 → entra «BLANDA» detrás de lo tecleado y la lectura en vivo se re-pone encima SIN guardarse; su IA entra después; «TAC» suelto por una tecla y «POP» escrito con el 3 pendiente → el 4 nace suelto (sin provisional) y las dos IA entran en orden; nunca se guarda HAS/DM2/TAC/POP',
    l15.a.v === 'HAS' && l15.a.prov && l15.a.pend === 1 && l15.a.s === 'LIQUIDOS'
    && l15.b.v === 'LIQUIDOS' && !l15.b.prov && l15.b.released && l15.b.focused && l15.c.s === 'LIQUIDOS X'
    && l15.d.v === 'LIQUIDOS X DM2' && l15.d.open && l15.d.base === 'LIQUIDOS X' && l15.d.orig === 'LIQUIDOS X' && l15.d.s === 'LIQUIDOS X'
    && l15.e.v === V1 + ' DM2' && l15.e.s === V1 && l15.e.open && l15.e.base === V1 && l15.e.pend === 0
    && l15.f.v === V1 + ' DM2' && l15.f.prov && l15.f.pend === 1 && l15.f.s === V1 && l15.f.closed
    && l15.g.v === V2 && l15.g.s === V2 && l15.g.pend === 0 && !l15.g.prov && l15.g.same
    && l15.h0.v === V2 + ' TAC' && l15.h0.prov && l15.h1.v === V2 && !l15.h1.prov && l15.h1.released
    && l15.h2.v === V2 + ' POP' && l15.h2.open && l15.h.v === V2 && !l15.h.prov && !l15.h.live && l15.h.pend === 2 && l15.h.released && l15.h.s === V2 && l15.h.closed
    && l15.i.v === V3 && l15.i.s === V3 && l15.i.pend === 1 && !l15.i.prov
    && l15.j.v === V4 && l15.j.s === V4 && l15.j.pend === 0 && !l15.j.prov && !l15.j.live
    && aiBodies.length === nb15 + 4 && !/HAS|DM2|TAC|POP/.test(l15.j.s), JSON.stringify({ l15, nAi: aiBodies.length - nb15 }));

  // ── L9: reconocedor local a fondo: palabras y cifras de la hoja, renglones, caracteres perturbados, aprendizaje ──
  const l9 = await page.evaluate(() => {
    PEN_OCR.forget();
    let seed = 3; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const ACC = { 'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U', 'Ñ': 'N' };
    const tpls = (ch) => { if (!ACC[ch]) return PEN_OCR.templatesFor(ch); const mark = ch === 'Ñ' ? [[28, 12], [40, 4], [50, 8], [60, 12], [72, 4]] : [[46, 12], [52, 6], [58, 1]]; return PEN_OCR.templatesFor(ACC[ch]).map(v => v.map(st => st.map(p => [50 + (p[0] - 50) * 0.75, 25 + (p[1] - 5) * 0.75])).concat([mark])); };
    function word(str, s, gap, noise, lineY) {
      const strokes = []; let x = 40; const H = 90 * s;
      for (const ch of str) {
        if (ch === ' ') { x += 0.9 * H; continue; }
        if (ch === '.') { strokes.push([[x + 3, lineY + 42 * s, 0.5], [x + 4, lineY + 43 * s, 0.5], [x + 5, lineY + 42 * s, 0.5]]); x += 12 * s + gap; continue; }
        if (ch === ':') { strokes.push([[x + 3, lineY - 15 * s, 0.5], [x + 4, lineY - 14 * s, 0.5]]); strokes.push([[x + 3, lineY + 20 * s, 0.5], [x + 4, lineY + 21 * s, 0.5]]); x += 12 * s + gap; continue; }
        const vars = tpls(ch); const tpl = vars[Math.floor(rnd() * vars.length)];
        let minX = Infinity, maxX = -Infinity; tpl.forEach(st => st.forEach(p => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }));
        tpl.forEach(st => strokes.push(st.map(p => [x + (p[0] - minX) * s + (rnd() - 0.5) * noise, lineY + (p[1] - 50) * s + (rnd() - 0.5) * noise, 0.5])));
        x += (maxX - minX) * s + gap;
      }
      return strokes;
    }
    const words = ['HAS', 'DM2', 'POP', 'LAPE', 'ATB', 'BH', 'QS', 'TAC', 'DIETA BLANDA', 'FC 95', '130/80', 'AÑOS', 'IC', 'NPT', 'TVP', 'O2', 'SAO2', 'RX', 'USG', 'KCL', 'I:E', '1:2', 'PCR', 'PO 1', 'COLECISTITIS', 'SEPSIS', 'SIN DOLOR', '36.5', '100', 'SO2 95', 'CÓLICO', 'QUIRÓFANO', 'HOY', 'DX', 'JP', 'IV', 'VO', 'MG', 'KG', 'TA 120/80', 'DM2 HAS', 'POP 3', 'ESTABLE', 'GRAVE', 'INR 1.2', 'HB 10', 'BIS', 'DIA 2', 'EGO', 'NA 135', 'K 4.1', 'ZINC', 'GAZA', 'OJO', 'BOLSA', 'ÁCIDO', 'ÚLCERA'];
    const badW = []; words.forEach(w => [[0.8, 10, 3], [0.5, 6, 2], [1.2, 14, 3]].forEach(([s, gap, noise]) => { const r = PEN_OCR.recognize(word(w, s, gap, noise, 100), { alpha: true }).text; if (r !== w) badW.push(w + '→' + r); }));
    const ml = word('HAS DM2', 0.8, 10, 3, 100).concat(word('POP 3 LAPE', 0.8, 10, 3, 220)).concat(word('TA 120/80', 0.8, 10, 3, 340));
    const lines = PEN_OCR.recognize(ml, { alpha: true, multiline: true }).text;
    const nums = ['130/80', '36.3', '1:2', '95', '0.03', '120', '7', '18', '4', '14.5', '100', '2', '6', '8', '9', '37.8', '88', '110/70', '0.5', '12.5'];
    const badN = []; nums.forEach(w => [[0.8, 10, 3], [0.5, 6, 2]].forEach(([s, gap, noise]) => { const r = PEN_OCR.recognize(word(w, s, gap, noise, 100)).text; if (r !== w) badN.push(w + '→' + r); }));
    // caracteres aislados perturbados (escala, rotación ±8°, cizalla, ruido): letra y dígito que se escriben igual cuentan como acierto
    const AMB = { '1': 'I', '0': 'O', '5': 'S', '2': 'Z', '8': 'B', '6': 'G', 'I': '1', 'O': '0', 'S': '5', 'Z': '2', 'B': '8', 'G': '6' };
    const xf = (tpl, s, rot, shear, noise) => { const c = Math.cos(rot), sn = Math.sin(rot); return tpl.map(st => st.map(p => { let x = (p[0] - 50) * s, y = (p[1] - 50) * s; x += shear * y; return [100 + x * c - y * sn + (rnd() - 0.5) * 2 * noise, 100 + x * sn + y * c + (rnd() - 0.5) * 2 * noise, 0.5]; })); };
    let tA = 0, okA = 0, tN = 0, okN = 0;
    PEN_OCR.alphabet().forEach(ch => tpls(ch).forEach(tpl => [0.5, 1.1].forEach(s => [-8, 8].forEach(deg => [-0.1, 0.1].forEach(sh => {
      const strokes = xf(tpl, s, deg * Math.PI / 180, sh, 1.5); const got = (PEN_OCR.recognize(strokes, { alpha: true }).chars[0] || {}).ch || '';
      tA++; if (got === ch || AMB[ch] === got) okA++;
      if (/^[0-9]$/.test(ch)) { tN++; if (PEN_OCR.recognize(strokes).text === ch) okN++; }
    })))));
    // aprender: una forma rara de "7" (sin barra, muy inclinada) se reconoce como 7 después de enseñársela
    const raro = [[[10, 10, .5], [60, 12, .5], [58, 14, .5], [30, 60, .5], [22, 90, .5]]];
    const antes = PEN_OCR.recognize(raro).text; PEN_OCR.learn('7', raro); const despues = PEN_OCR.recognize(raro).text;
    const t0 = performance.now(); for (let i = 0; i < 10; i++) PEN_OCR.recognize(word('DIETA BLANDA', 0.8, 10, 3, 100), { alpha: true }); const ms = (performance.now() - t0) / 10;
    return { badW, lines, badN, accA: okA / tA, accN: okN / tN, tA, antes, despues, learned: PEN_OCR.learnedCount(), ms };
  });
  check('L9 reconocedor local: ' + 57 + ' palabras y cifras de la hoja (HAS, DM2, SAO2, O2, DIETA BLANDA, AÑOS, 130/80, 36.5…) en tres tamaños sin fallar; tres renglones; cifras en modo numérico; caracteres aislados perturbados ≥ 90 % (dígitos ≥ 93 %); una forma propia enseñada se reconoce después; una frase de 11 letras en < 400 ms',
    l9.badW.length === 0 && l9.lines === 'HAS DM2\nPOP 3 LAPE\nTA 120/80' && l9.badN.length === 0 && l9.accA >= 0.9 && l9.accN >= 0.93 && l9.despues === '7' && l9.learned >= 1 && l9.ms < 400, JSON.stringify(l9));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-PEN: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
