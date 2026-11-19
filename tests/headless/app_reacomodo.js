// 📌 Reacomodo para iPad y encabezado nuevo (19 nov 2026, pedido de Gera):
//   · iPad vertical (una columna): 📌 No olvidar arriba, luego DX y enseguida el Pase (signos vitales y drenajes primero);
//     antes el Pase y el No olvidar quedaban hasta abajo de la ficha. iPad horizontal: el Pase sigue arriba a la derecha.
//   · Modo Hoja: el Pase va justo después del DX; el No olvidar arriba de la cuadrícula (⚙ Cajas lo sigue ocultando).
//   · 📌 No olvidar de cada cama: siempre a la vista, alta rápida (Enter), quién lo anotó y cuándo, borrar pide
//     confirmación; los abiertos aparecen solos en la pestaña 📌 No olvidar (en orden de cama, con «Ir a la cama») y la
//     pestaña se pone al día cuando otro iPad agrega uno.
//   · Encabezado: logo del servicio, misma altura o menor, sin scroll horizontal, mismos ids y pestañas.
//   node tests/headless/app_reacomodo.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh). Pacientes ficticios.
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const TZ = 'America/Mexico_City';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Prueba');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const id = (n) => '7d000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const pt = (n, cama, nombre) => ({ id: id(n), cama, exp: '26-72' + String(n).padStart(3, '0'), nombre, esp: 'CG', estado: 'ESTABLE', dx: 'DX FICTICIO', edad: '40', ingreso: '2026-11-10', seccion: 'PISO' });
const PTS = [pt(1, '3-401', 'ANA FICTICIA UNO'), pt(2, '3-402', 'BETO FICTICIO DOS'), pt(3, '3-403', 'CARLA FICTICIA TRES')];
const NOTES = [
  { patient_id: id(2), pendientes: 'Revisar BH', drenajes: '', checklist: { pm_fc: '88', pm_ta: '120/70',
    dispositivos: [{ id: 'd1', tipo: 'Penrose', lado: '', sitio: 'FID', gasto: '120', carac: 'seroso', fi: '' }],
    _ptReminders: [{ text: 'YA HECHO', done: true }, { text: 'Leer nota de IC de Medicina Interna', done: false }] } },
  { patient_id: id(3), checklist: { _ptReminders: [{ text: 'Ver reporte de endoscopía', done: false, by: 'Dra', t: '2026-11-18T15:30:00.000Z' }] } },
];
(async () => {
  const browser = await launch();
  const errors = [], escrituras = [];
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const page = await browser.newPage({ viewport: { width: 834, height: 1194 }, timezoneId: TZ });
  page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return json(m === 'GET' ? 200 : 201, m === 'GET' ? PTS : [{ id: PTS[0].id }]);
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, NOTES); escrituras.push({ m, url, body }); return json(201, Array.isArray(body) ? body : [body]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  const K = await page.evaluate(() => { const p = patients.find(x => x.cama === '3-402'); focusGoTo(pid(p)); return pid(p); });
  await page.waitForTimeout(900);
  const EK = K.replace(/[^a-zA-Z0-9]/g, '_');

  // Posiciones en pantalla (top/left) de los bloques de la ficha.
  const medir = () => page.evaluate((ek) => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { t: Math.round(b.top + scrollY), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      rec: r('#sec-rec-' + ek), dx: r('#sec-dx-' + ek), pase: r('#sec-pase-' + ek), labs: r('#sec-labs-' + ek), cx: r('#sec-cx-' + ek), crono: r('#sec-entrega-' + ek),
      vit: r('#ck-row-' + ek + ' .ck-r-vitales'), dren: r('#ck-row-' + ek + ' .ck-r-drenajes'), dieta: r('#ck-row-' + ek + ' .ck-r-dieta'), clin: r('#ck-row-' + ek + ' .ck-r-clinico'),
      recEnDetails: !!(document.getElementById('sec-rec-' + ek) && document.getElementById('sec-rec-' + ek).closest('details')),
      recAntesDeBento: (() => { const a = document.getElementById('sec-rec-' + ek); return !!(a && a.parentElement.classList.contains('fc-main') && a.parentElement.firstElementChild === a); })(),
      scrollX: document.documentElement.scrollWidth > innerWidth + 1,
      // Espacio entre bloques seguidos de la ficha (en una columna: 8 px como antes, sin márgenes que se sumen)
      gaps: (() => {
        const bl = Array.from(document.querySelectorAll('#card-' + CSS.escape(window.__focusPid) + ' .fc-bento > .fc-main > *, #card-' + CSS.escape(window.__focusPid) + ' .fc-bento > .fc-side > *'))
          .filter(e => e.getClientRects().length).map(e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom }; }).sort((x, y) => x.t - y.t);
        const g = []; for (let i = 1; i < bl.length; i++) g.push(Math.round(bl[i].t - bl[i - 1].b)); return g;
      })(),
      nRec: document.querySelectorAll('[id^="sec-rec-"]').length, nInput: document.querySelectorAll('#ptr-input-' + CSS.escape(window.__focusPid)).length,
    };
  }, EK);

  // ── R1 iPad vertical: No olvidar → DX → Pase (vitales, drenajes, luego dieta…) → Labs → Cirugías → Cronología ──
  const v = await medir();
  check('R1 iPad vertical: 📌 No olvidar arriba (fuera de las columnas y de los plegables), luego DX, enseguida el Pase con signos vitales y drenajes, y después Labs, Cirugías y Cronología; sin scroll horizontal',
    v.rec && v.dx && v.pase && v.labs && v.rec.t < v.dx.t && v.dx.t < v.pase.t && v.pase.t < v.labs.t && v.labs.t < v.cx.t && v.cx.t < v.crono.t
    && v.vit.t < v.dren.t && v.dren.t < v.dieta.t && v.dieta.t < v.clin.t && !v.recEnDetails && v.recAntesDeBento && !v.scrollX && v.nRec === 1 && v.nInput === 1
    && v.gaps.length >= 8 && v.gaps.every(g => g >= 6 && g <= 10), JSON.stringify(v));

  // ── R2 cuadro: abiertos a la vista, hechos plegados, contador; nada se agrega solo ──
  const r2 = await page.evaluate((ek) => {
    const box = document.querySelector('#sec-rec-' + ek + ' .pt-reminders');
    const abiertos = Array.from(box.querySelectorAll(':scope > .ptr-item .ptr-text')).map(x => x.textContent);
    const hechos = box.querySelector('details.ptr-hechos');
    return { abiertos, cnt: (box.querySelector('.ptr-cnt') || {}).textContent, hechosTxt: hechos ? hechos.querySelector('summary').textContent : null, hechosOpen: hechos ? hechos.open : null,
      hechosItems: hechos ? Array.from(hechos.querySelectorAll('.ptr-text')).map(x => x.textContent) : [], ambar: box.classList.contains('has-open'),
      ph: (box.querySelector('.ptr-add-input') || {}).placeholder, valor: (box.querySelector('.ptr-add-input') || {}).value };
  }, EK);
  check('R2 cuadro 📌: el pendiente a la vista, el hecho plegado en «✓ 1 hecho», contador 1, en ámbar; la caja para anotar empieza vacía (solo un ejemplo como placeholder)',
    JSON.stringify(r2.abiertos) === JSON.stringify(['Leer nota de IC de Medicina Interna']) && r2.cnt === '1' && /1 hecho/.test(r2.hechosTxt || '') && r2.hechosOpen === false
    && JSON.stringify(r2.hechosItems) === JSON.stringify(['YA HECHO']) && r2.ambar && /IC|postquir|endosc/.test(r2.ph || '') && r2.valor === '', JSON.stringify(r2));

  // ── R3 alta rápida con Enter: queda con autor y hora, la caja se vacía y conserva el foco; el contador de la barra sube ──
  await page.click(`[id="ptr-input-${K}"]`);
  await page.keyboard.type('Revisar nota postquirúrgica');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const r3 = await page.evaluate((k) => {
    const rs = noteData[k].checklist._ptReminders; const n = rs[rs.length - 1];
    const inp = document.getElementById('ptr-input-' + k);
    const chip = Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' .pt-reminders > .ptr-item')).map(x => (x.querySelector('.ptr-by') || {}).textContent || '');
    const jump = Array.from(document.querySelectorAll('#board-nav .bn-jump button')).find(b => /No olvidar/.test(b.textContent));
    return { n, focused: document.activeElement === inp, vacio: inp && inp.value === '', chip, jumpTxt: jump ? jump.textContent.replace(/\s+/g, ' ').trim() : null, ls: (localStorage.getItem('note-' + k) || '').includes('Revisar nota postquirúrgica') };
  }, K);
  check('R3 alta con Enter: se guarda con quién lo anotó (primer nombre) y la hora, se ve la etiqueta «Gerardo · dd/mm hh:mm», la caja queda vacía y con el foco para anotar otro, y el botón «No olvidar» de la barra cuenta 2',
    r3.n && r3.n.text === 'Revisar nota postquirúrgica' && r3.n.done === false && r3.n.by === 'Gerardo' && Date.now() - Date.parse(r3.n.t) < 60000 && r3.focused && r3.vacio
    && r3.chip[0] === '' && /^Gerardo · \d\d\/\d\d \d\d:\d\d$/.test(r3.chip[1]) && /No olvidar\s*2/.test(r3.jumpTxt || '') && r3.ls, JSON.stringify(r3));

  // ── R4 borrar pide confirmación (es para todo el equipo) ──
  const r4 = await page.evaluate((k) => {
    const n0 = noteData[k].checklist._ptReminders.length;
    window.confirm = () => false; deletePtReminder(k, n0 - 1); const n1 = noteData[k].checklist._ptReminders.length;
    window.confirm = () => true; deletePtReminder(k, 99); const n2 = noteData[k].checklist._ptReminders.length;
    return { n0, n1, n2 };
  }, K);
  check('R4 ✕ pide confirmación: cancelar no borra nada (y un índice que ya no existe tampoco)', r4.n0 === 3 && r4.n1 === 3 && r4.n2 === 3, JSON.stringify(r4));

  // ── R4b borrar de verdad: queda una marca (para que otro iPad no lo regrese) y desaparece del cuadro, la pestaña,
  //        el contador de la barra y el resumen de la entrega ──
  const r4b = await page.evaluate(async (k) => {
    const nd = noteData[k];
    nd.checklist._ptReminders.push({ id: 'borrame', text: 'PARA BORRAR', done: false, t: new Date().toISOString(), u: Date.now() });
    noteData[k] = nd; _rerenderCard(k);
    const i = nd.checklist._ptReminders.findIndex(r => r.id === 'borrame');
    window.confirm = () => true; deletePtReminder(k, i, 'i:borrame');
    await new Promise(r => setTimeout(r, 150));
    const it = noteData[k].checklist._ptReminders.find(r => r.id === 'borrame');
    const card = document.getElementById('card-' + k).textContent.includes('PARA BORRAR');
    const jump = Array.from(document.querySelectorAll('#board-nav .bn-jump button')).find(b => /No olvidar/.test(b.textContent));
    const R = buildEntregaResumen(patients.find(p => pid(p) === k), noteData[k]);
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    const tab = document.getElementById('view-noOlvidar').textContent.includes('PARA BORRAR');
    setView('piso', document.querySelector('.tab'));
    return { marca: !!(it && it.del && it.done && it.u > 0), card, jumpTxt: jump ? jump.textContent.replace(/\s+/g, ' ').trim() : null, resumen: JSON.stringify(R.pend || []).includes('PARA BORRAR'), tab };
  }, K);
  check('R4b borrar deja una marca (otro iPad no lo regresa) y el recordatorio desaparece del cuadro, de la pestaña, del contador y del resumen de la entrega',
    r4b.marca && !r4b.card && !r4b.tab && !r4b.resumen && /No olvidar\s*2/.test(r4b.jumpTxt || ''), JSON.stringify(r4b));

  // ── R5 pestaña 📌 No olvidar: «Por paciente» arriba, en orden de cama, con autor; palomear usa el índice completo ──
  await page.waitForTimeout(1500);
  const r5 = await page.evaluate((k) => {
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    const v = document.getElementById('view-noOlvidar');
    const wrap = v.querySelector('.no-pt-wrap');
    const camas = Array.from(v.querySelectorAll('.no-pt-cama > span')).map(x => x.textContent);
    const textos = Array.from(v.querySelectorAll('.no-pt-text')).map(x => x.textContent);
    const autores = Array.from(v.querySelectorAll('.no-pt-item')).map(x => (x.querySelector('.ptr-by') || {}).textContent || '');
    const btn = Array.from(v.querySelectorAll('.no-pt-item button')).map(b => b.getAttribute('onclick'));
    const antesDeEquipo = !!(wrap && v.querySelector('#no-olvidar-input') && (v.querySelector('#no-olvidar-input').compareDocumentPosition(wrap) & Node.DOCUMENT_POSITION_FOLLOWING));
    return { camas, textos, autores, btn, n: (v.querySelector('.no-pt-n') || {}).textContent, antesDeEquipo };
  }, K);
  check('R5 pestaña 📌 No olvidar: los de cada cama aparecen solos arriba (3-402 antes que 3-403), sin los hechos, con quién lo anotó; el botón palomea por la posición completa',
    r5.camas.length === 2 && /^🛏 3-402/.test(r5.camas[0]) && /^🛏 3-403/.test(r5.camas[1]) && JSON.stringify(r5.textos) === JSON.stringify(['Leer nota de IC de Medicina Interna', 'Revisar nota postquirúrgica', 'Ver reporte de endoscopía'])
    && r5.autores[0] === '' && /^Gerardo · /.test(r5.autores[1]) && /^Dra · \d\d\/\d\d \d\d:\d\d$/.test(r5.autores[2]) && /togglePtReminder\(.*,1,"L:Leer nota de IC de Medicina Interna#1"\)/.test(r5.btn[0]) && /togglePtReminder\(.*,2,"i:[a-z0-9]+"\)/.test(r5.btn[1])
    && r5.n === '3' && r5.antesDeEquipo, JSON.stringify(r5));

  // ── R6 la pestaña se pone al día sola cuando otro iPad agrega un recordatorio ──
  const r6 = await page.evaluate(async (k) => {
    _suppressRealtimeKeys.clear();
    const nd = getNote(k); const ck = JSON.parse(JSON.stringify(nd.checklist || {}));
    ck._ptReminders.push({ text: 'DEL OTRO IPAD: pedir valoración de Nutrición', done: false, by: 'Luis', t: new Date().toISOString() });
    const row = { patient_id: patients.find(p => pid(p) === k)._supa_id || patients.find(p => pid(p) === k).id, checklist: ck };
    ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'entrega'].forEach(f => { row[f] = nd[f] || ''; });
    handleNoteChange({ eventType: 'UPDATE', new: row });
    await new Promise(r => setTimeout(r, 300));
    return { vista: currentView, txt: document.getElementById('view-noOlvidar').textContent.includes('DEL OTRO IPAD: pedir valoración de Nutrición') };
  }, K);
  check('R6 con la pestaña abierta, un recordatorio que agrega otro iPad aparece solo', r6.vista === 'noOlvidar' && r6.txt, JSON.stringify(r6));

  // ── R7 «Ir a la cama» abre la tarjeta del paciente ──
  const r7 = await page.evaluate(async (k) => {
    const b = Array.from(document.querySelectorAll('#view-noOlvidar .no-pt-ir')).find(x => x.dataset.k === k); b.click();
    await new Promise(r => setTimeout(r, 900));
    return { vista: currentView, foco: window.__focusPid === k, card: !!document.getElementById('card-' + k), act: (document.querySelector('.tab.active') || {}).textContent };
  }, K);
  check('R7 «Ir a la cama ›» abre la tarjeta de ese paciente en Piso Libro', r7.vista === 'piso' && r7.foco && r7.card && /Piso/.test(r7.act || ''), JSON.stringify(r7));

  // ── R8 iPad horizontal: dos columnas; el Pase arriba a la derecha, al lado del DX; el No olvidar a todo lo ancho ──
  await page.setViewportSize({ width: 1194, height: 834 });
  await page.evaluate(() => renderView()); await page.waitForTimeout(700);
  const h = await medir();
  check('R8 iPad horizontal: el 📌 No olvidar arriba de la columna izquierda y, a su lado, arriba a la derecha, el Pase con signos vitales y drenajes primero (no los empuja hacia abajo)',
    h.pase.l > h.rec.l + 300 && Math.abs(h.pase.t - h.rec.t) < 30 && h.rec.t < h.dx.t && Math.abs(h.rec.l - h.dx.l) < 20 && h.vit.t < h.dren.t && h.dren.t < h.dieta.t && !h.scrollX, JSON.stringify(h));

  // ── R9 Hoja: Pase justo después del DX; No olvidar arriba de la cuadrícula y ⚙ Cajas lo oculta ──
  const r9 = await page.evaluate(async (ek) => {
    if (!isHojaMode()) toggleHojaMode();
    await new Promise(r => setTimeout(r, 500));
    const bento = document.querySelector('.fc-bento');
    const areas = getComputedStyle(bento).gridTemplateAreas;
    const top = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top);
    const out = { areas, recTop: top('#sec-rec-' + ek), dxTop: top('#sec-dx-' + ek), paseTop: top('#sec-pase-' + ek), labsTop: top('#sec-labs-' + ek) };
    toggleHojaBlock('rec'); await new Promise(r => setTimeout(r, 200));
    out.oculto = getComputedStyle(document.getElementById('sec-rec-' + ek)).display;
    toggleHojaBlock('rec'); await new Promise(r => setTimeout(r, 200));
    out.visible = getComputedStyle(document.getElementById('sec-rec-' + ek)).display;
    toggleHojaMode(); await new Promise(r => setTimeout(r, 400));
    out.salio = !document.body.classList.contains('pl-hoja');
    return out;
  }, EK);
  check('R9 Hoja: cuadrícula «rec» (📌 No olvidar) → «dx» → «pase» → «labs»; ⚙ Cajas lo oculta y lo vuelve a mostrar',
    /^"rec rec rec rec" "dx dx dx dx" "pase pase pase pase" "labs labs labs labs"/.test(r9.areas) && r9.recTop < r9.dxTop && r9.dxTop < r9.paseTop && r9.paseTop < r9.labsTop
    && r9.oculto === 'none' && r9.visible !== 'none' && r9.salio, JSON.stringify(r9));

  // ── R14 lo escrito en la caja (sin Enter) sobrevive a un repintado; «✓ hechos» abierto se queda abierto ──
  const r14 = await page.evaluate(async (k) => {
    const inp = document.getElementById('ptr-input-' + k);
    inp.value = 'BORRADOR A MEDIAS'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.blur();
    const det = document.querySelector('#card-' + CSS.escape(k) + ' details.ptr-hechos'); det.open = true; det.dispatchEvent(new Event('toggle'));
    await new Promise(r => setTimeout(r, 50));
    _rerenderCard(k);
    const out = { borrador: document.getElementById('ptr-input-' + k).value, hechos: document.querySelector('#card-' + CSS.escape(k) + ' details.ptr-hechos').open };
    document.getElementById('ptr-input-' + k).value = ''; _ptrGuardarBorrador(k, '');
    return out;
  }, K);
  check('R14 lo que se escribe en el cuadro sin dar Enter no se borra si la tarjeta se repinta, y «✓ hechos» abierto sigue abierto', r14.borrador === 'BORRADOR A MEDIAS' && r14.hechos === true, JSON.stringify(r14));

  // ── R15 dos iPads cambian la lista a la vez: se unen por identidad (sin «copia base»); el borrado es una marca ──
  const r15 = await page.evaluate(() => {
    const t0 = Date.parse('2026-11-19T10:00:00Z');
    const A = { text: 'Viejo A', done: false }, B = { text: 'Viejo B', done: false };            // de antes (sin id)
    const n1 = { id: 'n1', text: 'NUEVO 1', done: false, t: '2026-11-19T09:00:00.000Z', u: t0 };
    const local = [A, { text: 'Viejo B', done: true, u: t0 + 50 }, Object.assign({}, n1, { del: true, done: true, u: t0 + 60 }), { id: 'aqui', text: 'NUEVO AQUI', done: false, t: '2026-11-19T10:01:00.000Z', u: t0 + 70 }];
    const remote = [A, B, n1, { id: 'alla', text: 'NUEVO ALLA', done: false, t: '2026-11-19T10:00:30.000Z', u: t0 + 30 }];
    const m = _ptrMerge(local, remote, t0 + 100);
    const vis = (l) => l.filter(_ptrVisible).map(r => r.text + (r.done ? '✓' : ''));
    // Un iPad viejo quitó «Viejo A» (sin marca): la nube manda en los de antes. Una marca de borrado de hace más de 30 días se limpia.
    const m2 = _ptrMerge([A, B], [B], t0);
    const m3 = _ptrMerge([{ id: 'x', text: 'X', del: true, done: true, u: t0 - 31 * 864e5 }], [], t0);
    // Empate de hora: gana la nube (un iPad viejo que palomea no cambia u).
    const m4 = _ptrMerge([{ id: 'y', text: 'Y', done: true, u: 5 }], [{ id: 'y', text: 'Y', done: false, u: 5 }], t0);
    return { vis: vis(m), tieneMarca: m.some(r => r.id === 'n1' && r.del), m2: m2.map(r => r.text), m3: m3.length, m4: m4[0].done };
  });
  check('R15 dos iPads a la vez: lo agregado de cada lado se junta, la casilla y el borrado los decide el cambio más reciente (el borrado queda como marca, que se limpia a los 30 días); en los de antes manda la nube',
    JSON.stringify(r15.vis) === JSON.stringify(['Viejo A', 'Viejo B✓', 'NUEVO ALLA', 'NUEVO AQUI']) && r15.tieneMarca && JSON.stringify(r15.m2) === JSON.stringify(['Viejo B']) && r15.m3 === 0 && r15.m4 === false, JSON.stringify(r15));

  // ── R16 «Ir a la cama» con un filtro que esconde esa cama: quita los filtros y abre la correcta ──
  const r16 = await page.evaluate(async () => {
    const otro = patients.find(p => p.cama === '3-403'), k3 = pid(otro);
    const s = document.getElementById('search'); if (s) s.value = '3-401';
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    irANoOlvidarPaciente(k3);
    await new Promise(r => setTimeout(r, 700));
    return { foco: window.__focusPid === k3, card: !!document.getElementById('card-' + k3), busqueda: (document.getElementById('search') || {}).value };
  });
  check('R16 «Ir a la cama ›» con un filtro que escondía esa cama: se quitan los filtros y abre la tarjeta correcta (no otra)', r16.foco && r16.card && !r16.busqueda, JSON.stringify(r16));
  const r16b = await page.evaluate(async () => {
    const k2 = pid(patients.find(p => p.cama === '3-402')), out = {};
    for (const caso of ['libres', 'vacio']) {
      if (caso === 'libres') { showLibres = true; } else { const s = document.getElementById('search'); if (s) s.value = 'zzzz-nadie'; }
      setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
      irANoOlvidarPaciente(k2);
      await new Promise(r => setTimeout(r, 700));
      out[caso] = { foco: window.__focusPid === k2, card: !!document.getElementById('card-' + k2), libres: showLibres };
    }
    return out;
  });
  check('R16b «Ir a la cama ›» también desde la vista de 🛏 camas libres y con un filtro que dejaba el tablero vacío: abre la tarjeta',
    r16b.libres.foco && r16b.libres.card && !r16b.libres.libres && r16b.vacio.foco && r16b.vacio.card, JSON.stringify(r16b));

  // ── R17 la caja del equipo de la pestaña no se borra si otro iPad cambia un recordatorio mientras se escribe ──
  const r17 = await page.evaluate(async (k) => {
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    const eq = document.getElementById('no-olvidar-input'); eq.value = 'TEXTO A MEDIAS DEL EQUIPO'; eq.blur();
    _suppressRealtimeKeys.clear();
    const nd = getNote(k); const ck = JSON.parse(JSON.stringify(nd.checklist || {}));
    ck._ptReminders.push({ text: 'OTRO MAS DEL OTRO IPAD', done: false, by: 'Luis', t: new Date().toISOString() });
    const p = patients.find(x => pid(x) === k); const row = { patient_id: p._supa_id || p.id, checklist: ck };
    ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'entrega'].forEach(f => { row[f] = nd[f] || ''; });
    handleNoteChange({ eventType: 'UPDATE', new: row });
    await new Promise(r => setTimeout(r, 300));
    const out = { eq: (document.getElementById('no-olvidar-input') || {}).value, vista: currentView };
    document.getElementById('no-olvidar-input').value = '';
    return out;
  }, K);
  check('R17 pestaña abierta con texto a medias en la caja del equipo: un cambio de otro iPad no lo borra', r17.eq === 'TEXTO A MEDIAS DEL EQUIPO' && r17.vista === 'noOlvidar', JSON.stringify(r17));

  // ── R18 las tarjetas simples (otros servicios) también tienen su cuadro 📌 ──
  const r18 = await page.evaluate(async () => {
    const p = patients.find(x => x.cama === '3-401'); p.esp = 'URO'; const k = pid(p);
    setView('piso', document.querySelector('.tab')); focusGoTo(k); await new Promise(r => setTimeout(r, 500));
    const card = document.getElementById('card-' + k);
    const out = { simple: !!(card && card.classList.contains('simple-card')), caja: !!(card && card.querySelector('.pt-reminders .ptr-add-input#ptr-input-' + CSS.escape(k))) };
    p.esp = 'CG'; renderView();
    return out;
  });
  check('R18 las tarjetas simples (otros servicios) también tienen su cuadro 📌 No olvidar', r18.simple && r18.caja, JSON.stringify(r18));

  // ── R21 llega un cambio de otro iPad cuando aquí hay un recordatorio que aún no se sube: se juntan (no se esconde el de aquí) ──
  const r21 = await page.evaluate(async () => {
    const p = patients.find(x => x.cama === '3-401'), k1 = pid(p);
    setView('piso', document.querySelector('.tab')); focusGoTo(k1); await new Promise(r => setTimeout(r, 300));
    const inp = document.getElementById('ptr-input-' + k1); inp.value = 'MIO SIN SUBIR'; addPtReminder(k1);
    _suppressRealtimeKeys.clear();
    const row = { patient_id: p._supa_id || p.id, checklist: { _ptReminders: [{ id: 'colega1', text: 'DEL COLEGA', done: false, t: new Date().toISOString(), u: Date.now() }] } };
    ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'entrega'].forEach(f => { row[f] = (getNote(k1)[f]) || ''; });
    handleNoteChange({ eventType: 'UPDATE', new: row });
    await new Promise(r => setTimeout(r, 200));
    return noteData[k1].checklist._ptReminders.filter(_ptrVisible).map(r => r.text);
  });
  check('R21 llega un cambio de otro iPad mientras aquí hay uno sin subir: se ven los dos (ninguno desaparece)', r21.includes('MIO SIN SUBIR') && r21.includes('DEL COLEGA'), JSON.stringify(r21));

  // ── R22 al abrir la app con un recordatorio en la cola, la nota de la nube y lo de la cola se UNEN (no se esconde lo del colega) ──
  const r22 = await page.evaluate(() => {
    const p = patients.find(x => x.cama === '3-401'), k1 = pid(p);
    const colega = { id: 'col22', text: 'DEL COLEGA EN LA NUBE', done: false, t: '2026-11-19T08:00:00.000Z', u: 100 };
    const mio = { id: 'mio22', text: 'MIO EN LA COLA', done: false, t: '2026-11-19T08:01:00.000Z', u: 200 };
    const antes = outboxLoad();
    const out = {};
    for (const dirty of [['checklist'], null]) {
      outboxSave([{ type: 'note', key: k1, data: { checklist: { _ptReminders: [mio] } }, dirty: dirty || undefined, ts: Date.now() }]);
      const target = {}; target[k1] = migrateNote(Object.assign(defaultData(), { checklist: { _ptReminders: [colega] } }));
      _applyOutboxOverlay(target);
      out[dirty ? 'conLista' : 'sinLista'] = (target[k1].checklist._ptReminders || []).map(r => r.text);
    }
    outboxSave(antes);
    return out;
  });
  check('R22 al abrir la app con un recordatorio en la cola: se ven el de la cola y el que otro iPad ya subió (con o sin lista de campos)',
    ['conLista', 'sinLista'].every(c => (r22[c] || []).includes('MIO EN LA COLA') && (r22[c] || []).includes('DEL COLEGA EN LA NUBE')), JSON.stringify(r22));

  // ── R23 palomear aquí gana a una copia vieja que llega de otro iPad (la hora del cambio se actualiza al palomear) ──
  const r23 = await page.evaluate(async () => {
    const p = patients.find(x => x.cama === '3-401'), k1 = pid(p), nd = getNote(k1);
    nd.checklist._ptReminders = [{ id: 'pal23', text: 'PALOMEAME', done: false, t: '2026-11-19T08:00:00.000Z', u: 1000 }]; noteData[k1] = nd;
    togglePtReminder(k1, 0, 'i:pal23');
    _suppressRealtimeKeys.clear();
    const row = { patient_id: p._supa_id || p.id, checklist: { _ptReminders: [{ id: 'pal23', text: 'PALOMEAME', done: false, t: '2026-11-19T08:00:00.000Z', u: 1000 }] } };
    ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'entrega'].forEach(f => { row[f] = (getNote(k1)[f]) || ''; });
    handleNoteChange({ eventType: 'UPDATE', new: row });
    await new Promise(r => setTimeout(r, 150));
    const it = noteData[k1].checklist._ptReminders.find(r => r.id === 'pal23');
    return { done: it && it.done, u: it && it.u };
  });
  check('R23 lo que se palomea aquí no lo revierte una copia vieja que llega de otro iPad', r23.done === true && r23.u > 1000, JSON.stringify(r23));

  // ── R19 pestaña pintada antes de que un colega borrara uno: palomear el siguiente marca ESE, no otro ──
  const r19 = await page.evaluate(async () => {
    const p = patients.find(x => x.cama === '3-403'), k3 = pid(p), nd = getNote(k3);
    nd.checklist._ptReminders = [{ id: 'q1', text: 'PRIMERO', done: false, u: 1 }, { id: 'q2', text: 'SEGUNDO', done: false, u: 1 }]; noteData[k3] = nd;
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    const eq = document.getElementById('no-olvidar-input'); eq.value = 'algo a medias';   // la pestaña no se repinta
    const btn = Array.from(document.querySelectorAll('#view-noOlvidar .no-pt-item')).find(x => /SEGUNDO/.test(x.textContent)).querySelector('button');
    noteData[k3].checklist._ptReminders.splice(0, 1);   // el colega lo quitó (iPad viejo) y llegó por Realtime
    btn.click();
    const out = { lista: noteData[k3].checklist._ptReminders.map(r => r.text + (r.done ? '✓' : '')), eq: (document.getElementById('no-olvidar-input') || {}).value };
    document.getElementById('no-olvidar-input').value = '';
    return out;
  });
  check('R19 una pestaña pintada antes de que otro iPad quitara un recordatorio: palomear marca el correcto (por su clave, no por su posición) y no borra lo escrito en la caja del equipo',
    JSON.stringify(r19.lista) === JSON.stringify(['SEGUNDO✓']) && r19.eq === 'algo a medias', JSON.stringify(r19));

  // ── R10 Encabezado: logo del servicio, misma altura o menor que antes, sin scroll horizontal, mismos ids ──
  // Se compara en el MISMO navegador contra el estilo anterior (sin la hoja hdr-v2 y con el logo en una caja de 52 px como
  // el ícono de antes): no depende de las fuentes de cada máquina. Estados: en reposo, «✅ Guardado», con el botón de
  // administrador y encogido al bajar (hdr-min). Anchos de teléfono a monitor grande.
  await page.evaluate(() => setView('piso', document.querySelector('.tab')));
  const alturas = {}, malos = [];
  for (const vp of ['1920x1080', '1700x900', '1600x900', '1440x900', '1366x1024', '1280x800', '1194x834', '1024x1366', '834x1194', '390x844']) {
    const [w, hh] = vp.split('x').map(Number);
    await page.setViewportSize({ width: w, height: hh });
    await page.evaluate(() => { window.scrollTo(0, 0); renderView(); }); await page.waitForTimeout(400);
    alturas[vp] = await page.evaluate(() => {
      const H = () => Math.round(document.getElementById('header').getBoundingClientRect().height);
      const st = document.getElementById('sync-status'), lb = document.getElementById('sync-label'), adm = document.getElementById('admin-btn');
      const prev = { cls: st.className, lb: lb.textContent, adm: adm.style.display, min: document.body.classList.contains('hdr-min'), foc: document.body.classList.contains('focus-on') };
      const medir = () => {
        const r = [];
        st.className = 'synced'; lb.textContent = ''; adm.style.display = 'none'; r.push(H());
        lb.textContent = '✅ Guardado'; r.push(H());
        adm.style.display = ''; r.push(H());
        document.body.classList.add('focus-on', 'hdr-min'); r.push(H()); document.body.classList.remove('hdr-min');
        return r;
      };
      const nuevo = medir();
      const css = document.getElementById('hdr-v2'), badge = document.querySelector('.pl-svc-badge');
      css.disabled = true; badge.setAttribute('style', 'display:inline-block;width:52px;height:52px;flex-shrink:0');
      const viejo = medir();
      css.disabled = false; badge.removeAttribute('style');
      st.className = prev.cls; lb.textContent = prev.lb; adm.style.display = prev.adm;
      document.body.classList.toggle('focus-on', prev.foc); document.body.classList.toggle('hdr-min', prev.min);
      return { nuevo, viejo, sx: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    const a = alturas[vp];
    if (a.sx || a.nuevo.some((h2, i) => h2 > a.viejo[i])) malos.push(vp);
  }
  check('R10 encabezado: en reposo, con «✅ Guardado», con el botón de administrador y encogido, igual o más bajo que el de antes en todos los anchos (teléfono a 1920 px) y sin scroll horizontal',
    malos.length === 0, JSON.stringify({ malos, alturas }));
  // La pestaña 📌 No olvidar en teléfono no se sale de la pantalla (antes «➕ Agregar» empujaba 35 px).
  await page.setViewportSize({ width: 390, height: 844 });
  const r20 = await page.evaluate(async () => { setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]')); await new Promise(r => setTimeout(r, 200)); const sx = document.documentElement.scrollWidth > innerWidth + 1; setView('piso', document.querySelector('.tab')); return sx; });
  check('R20 pestaña 📌 No olvidar en teléfono: sin scroll horizontal', r20 === false, String(r20));
  await page.setViewportSize({ width: 1194, height: 834 }); await page.waitForTimeout(300);
  const r11 = await page.evaluate(async () => {
    const img = document.querySelector('#header-top .header-title .pl-svc-badge img.pl-svc-logo');
    const badge = document.querySelector('.pl-svc-badge'); const bb = badge.getBoundingClientRect();
    const ids = ['header', 'quote-bar', 'quote-text', 'course-countdown', 'header-top', 'tabs', 'gi-fecha', 'gi-entrega', 'gi-recibe', 'sync-status', 'sync-label', 'winlab-refresh-pill', 'winlab-pill-icon', 'winlab-pill-lbl', 'winlab-autosync-btn', 'scraper-status-dot', 'scraper-status-text', 'hc-more-btn', 'hc-more-menu', 'pl-fs-btn', 'pizarra-toggle-btn', 'cuaderno-toggle-btn', 'proyectar-btn', 'proxy-pill', 'account-btn', 'admin-btn', 'logout-btn', 'espacio-banner'];
    const tabs = Array.from(document.querySelectorAll('#tabs .tab')).map(t => t.getAttribute('onclick'));
    return { img: !!img && img.complete && img.naturalWidth === 96, alt: img && img.getAttribute('alt') === '', bw: Math.round(bb.width), bh: Math.round(bb.height), faltan: ids.filter(i => !document.getElementById(i)),
      tabs, primera: /setView\('piso'/.test(tabs[0] || ''), viejoSvg: !!document.querySelector('svg.pl-brand-logo'), noPrint: badge.classList.contains('no-print') };
  });
  check('R11 encabezado: logo del servicio (96 px, decorativo) en un círculo de 52 px, sin el ícono anterior; siguen todos los ids y las 7 pestañas en el mismo orden',
    r11.img && r11.alt && r11.bw === 52 && r11.bh === 52 && r11.faltan.length === 0 && r11.tabs.length === 7 && r11.primera && !r11.viejoSvg && r11.noPrint
    && ['piso', 'census', 'print', 'noOlvidar', 'pendientes', 'tablero'].every((v2, i) => (r11.tabs[i] || '').includes("'" + v2 + "'")) && /startRondas/.test(r11.tabs[6] || ''), JSON.stringify(r11));
  // Movimiento: con «reducir movimiento» no hay animaciones; al imprimir no salen el logo ni los fondos.
  // 19 nov 2026: el ECG («se ve más de internista») se cambió por incisión con bisturí + surgete (.header-title::before /
  // ::after) y el halo por el anillo de anastomosis (badge ::before / ::after).
  const anims = () => page.evaluate(() => { const t = document.querySelector('.header-title'), b = document.querySelector('.pl-svc-badge'), cs = (el, ps) => getComputedStyle(el, ps).animationName;
    return { corte: cs(t, '::before'), surgete: cs(t, '::after'), anillo: cs(b, '::before'), destello: cs(b, '::after'), ecg: getComputedStyle(document.getElementById('header'), '::after').content }; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const mov = await anims();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const mov2 = await anims();
  await page.emulateMedia({ media: 'print' });
  const imp = await page.evaluate(() => { const t = document.querySelector('.header-title'); return { badge: getComputedStyle(document.querySelector('.pl-svc-badge')).display, corte: getComputedStyle(t, '::before').display, surgete: getComputedStyle(t, '::after').display, puntos: getComputedStyle(document.getElementById('header'), '::before').display }; });
  await page.emulateMedia({ media: 'screen' });
  check('R12 encabezado quirúrgico: bisturí/surgete y anillo del logo se mueven solo si el iPad no pide «reducir movimiento»; ya no hay ECG; al imprimir no salen ni el logo ni los fondos',
    [mov.corte, mov.surgete, mov.anillo, mov.destello].every(a => a === 'none') && mov2.corte === 'plCut' && mov2.surgete === 'plSew' && mov2.anillo === 'plRing' && mov2.destello === 'plRing'
    && (mov2.ecg === 'none' || mov2.ecg === 'normal') && imp.badge === 'none' && imp.corte === 'none' && imp.surgete === 'none' && imp.puntos === 'none', JSON.stringify({ mov, mov2, imp }));

  check('R13 sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\nRESULT APP-REACOMODO: ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
