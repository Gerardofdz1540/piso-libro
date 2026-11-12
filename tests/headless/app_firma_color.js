// ✍️ Firma y color por renglón en las cajas (11 nov 2026): «Gerardo 10.11.26 23:50 - …» en cada renglón NUEVO al soltar la
// caja; nada en lo que ya estaba, lo editado, lo restaurado o lo regresado; color por autor en una capa encima de la caja.
//   node tests/headless/app_firma_color.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh). Pacientes ficticios.
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const SHOT = process.env.PL_SHOT || '';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Prueba');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PT = { id: '7b000000-0000-4000-8000-000000000001', cama: '3-301', exp: '26-70001', nombre: 'LUIS PRUEBA UNO', esp: 'CG', estado: 'ESTABLE', dx: 'APENDICITIS', edad: '30' };
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [PT]); return json(201, [{ id: PT.id }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); posts.push(body); return json(201, [{ patient_id: PT.id }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  const mismoRect = (a, b) => { try { const x = JSON.parse(a), y = JSON.parse(b); return ['x', 'y', 'width', 'height'].every(k => Math.abs(x[k] - y[k]) < 0.6); } catch (_) { return false; } };
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── F1: lógica pura de la firma ──
  const f1 = await page.evaluate(() => {
    const st = 'Gerardo 10.11.26 23:50 - ';
    const r = {};
    r.vacia = plStampNewLines('', 'Cambiar apósitos', st);
    r.agrega = plStampNewLines('Gerardo 09.11.26 08:00 - Ayuno', 'Gerardo 09.11.26 08:00 - Ayuno\nRetirar SNG', st);
    r.edita = plStampNewLines('texto viejo sin firma', 'texto viejo sin firma corregido', st);
    r.igual = plStampNewLines('a\nb', 'a\nb', st);
    r.yaFirmado = plStampNewLines('', 'Ana 10.11.26 22:00 - lo puso Ana', st);
    r.sangria = plStampNewLines('', 'Plan:\n  continuar ATB\n- retirar sonda', st);
    r.pegado = plStampNewLines('', ['1', '2', '3', '4', '5', '6', '7', '8'].map(x => 'renglón ' + x).join('\n'), st, { pegado: true });
    r.escritos = plStampNewLines('', ['1', '2', '3', '4', '5', '6', '7', '8'].map(x => 'renglón ' + x).join('\n'), st);
    r.arriba = plStampNewLines('Gerardo 09.11.26 08:00 - viejo', 'nuevo arriba\nGerardo 09.11.26 08:00 - viejo', st);
    r.sinNombre = plStampNewLines('', 'x', '');
    r.ahora = plStampNow(new Date(2026, 10, 10, 23, 50));
    r.autor = plStampAuthor('✓ Gerardo 10.11.26 23:50 - hecho');
    r.autorViejo = plStampAuthor('14/10 08:15 GF: viejo');
    r.color = plAuthorColor('Gerardo') === plAuthorColor('gerardo') && /^#/.test(plAuthorColor('Gerardo'));
    return r;
  });
  check('F1 firma: caja vacía → «Nombre dd.mm.aa hh:mm - texto»; renglón agregado se firma y lo que ya estaba no; editar un renglón NO lo firma; sin cambios no toca; lo ya firmado no se refirma; sangría = continuación; viñeta se cambia por la firma; pegado grande = una firma; lo nuevo arriba también; sin nombre no firma; ✓ y firmas viejas se reconocen',
    f1.vacia === 'Gerardo 10.11.26 23:50 - Cambiar apósitos' && f1.agrega === 'Gerardo 09.11.26 08:00 - Ayuno\nGerardo 10.11.26 23:50 - Retirar SNG'
    && f1.edita === 'texto viejo sin firma corregido' && f1.igual === 'a\nb' && f1.yaFirmado === 'Ana 10.11.26 22:00 - lo puso Ana'
    && f1.sangria === 'Gerardo 10.11.26 23:50 - Plan:\n  continuar ATB\nGerardo 10.11.26 23:50 - retirar sonda'
    && f1.pegado.split('\n').filter(l => l.startsWith('Gerardo')).length === 1 && f1.pegado.startsWith('Gerardo 10.11.26 23:50 - renglón 1') && f1.pegado.split('\n').slice(1).every(l => /^  renglón \d$/.test(l))
    && f1.escritos.split('\n').every(l => l.startsWith('Gerardo 10.11.26 23:50 - renglón '))
    && f1.arriba === 'Gerardo 10.11.26 23:50 - nuevo arriba\nGerardo 09.11.26 08:00 - viejo' && f1.sinNombre === 'x'
    && f1.ahora === 'Gerardo 10.11.26 23:50 - ' && f1.autor && f1.autor.name === 'Gerardo' && f1.autorViejo && f1.autorViejo.name === 'GF' && f1.color, JSON.stringify(f1));

  // ── F2: escribir en Pendientes y soltar la caja → se guarda firmado y aparece la capa de color ──
  // Se escribe con el teclado (eventos reales): un evento que dispara el propio código no firma.
  const k2 = await page.evaluate(async () => {
    const k = pid(patients[0]); focusGoTo(k);
    await new Promise(r => setTimeout(r, 400));
    const ta = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]');
    ta.focus(); ta.value = 'SINTETICO'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
    window.__sint = ta.value; ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true })); ta.blur();
    ta.scrollIntoView({ block: 'center' });
    return k;
  });
  await page.click('textarea[data-key="' + k2 + '"][data-field="pendientes"]');
  await page.keyboard.type('Cambiar apósitos', { delay: 10 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  const f2 = await page.evaluate(async (k) => {
    await new Promise(r => setTimeout(r, 600));
    const ta2 = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]');
    const bd = ta2 && ta2.previousElementSibling;
    return { k, sint: window.__sint, val: ta2 && ta2.value, nota: getNote(k).pendientes, bd: !!(bd && bd.classList.contains('pl-st-bd')), bdHtml: bd ? bd.innerHTML.slice(0, 300) : '', taRect: ta2 ? JSON.stringify(ta2.getBoundingClientRect()) : '', bdRect: bd ? JSON.stringify(bd.getBoundingClientRect()) : '' };
  }, k2);
  const hoy = new Date(); const z = n => String(n).padStart(2, '0');
  const fecha = z(hoy.getDate()) + '.' + z(hoy.getMonth() + 1) + '.' + String(hoy.getFullYear()).slice(2);
  check('F2 escribir con el teclado «Cambiar apósitos» en Pendientes y soltar (un evento sintético del código no firma): la caja y la nota quedan «Gerardo ' + fecha + ' hh:mm - Cambiar apósitos» y aparece la capa de color alineada con la caja',
    f2.sint === 'SINTETICO' && new RegExp('^Gerardo ' + fecha.replace(/\./g, '\\.') + ' \\d{2}:\\d{2} - Cambiar apósitos$').test(f2.val || '') && f2.nota === f2.val && f2.bd && /background:rgba/.test(f2.bdHtml) && mismoRect(f2.taRect, f2.bdRect), JSON.stringify(f2));
  // ── F3: marcas de «editado aquí» (11 nov 2026): ➕ Cultivo, Eliminar labs y el diagrama ya no dejan la tarjeta marcada para
  // siempre (con la marca, el equipo no veía lo de los colegas y al ocultarse re-subía su copia vieja: pérdidas del 8 nov).
  const f3 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const marcas = () => Array.from(_dirtyFields[k] || []).sort();
    const r = {};
    _dirtyFields[k] = new Set();
    cultivoQuickAdd(k, 'Hemocultivo'); r.cultivo = marcas(); r.cultivoTxt = /Hemocultivo/.test((getNote(k).checklist || {}).cultivos || '');
    // si la persona ya estaba escribiendo en Cultivos, su marca se respeta
    _dirtyFields[k] = new Set(['ck_cultivos']); cultivoQuickAdd(k, 'Urocultivo'); r.cultivoPrevia = marcas();
    _dirtyFields[k] = new Set();
    const nd = getNote(k); nd.labHistory = [{ fecha: '2026-11-01', labs: { hb: '10' } }, { fecha: '2026-11-02', labs: { hb: '11' } }]; noteData[k] = nd;
    deleteLabDate(k, '2026-11-01'); r.labs = marcas(); r.labsQuedan = (getNote(k).labHistory || []).map(s => s.fecha);
    _dirtyFields[k] = new Set(['labHistory']); deleteLabDate(k, '2026-11-02'); r.labsPrevia = marcas();
    _dirtyFields[k] = new Set();
    try { toggleDrains(k); await new Promise(res => setTimeout(res, 300)); r.canvas = !!bdGetCanvas(k, 'ant'); bdClear(k, 'ant'); } catch (e) { r.bdErr = String(e); } r.diagrama = marcas();
    _dirtyFields[k] = new Set();
    return r;
  });
  check('F3 ➕ Cultivo, Eliminar labs y 🗑 diagrama guardan y NO dejan la tarjeta marcada como «editada aquí»; si ya había una edición a mano en curso de esa caja, su marca se respeta',
    f3.cultivo.length === 0 && f3.cultivoTxt && JSON.stringify(f3.cultivoPrevia) === '["ck_cultivos"]' && f3.labs.length === 0 && JSON.stringify(f3.labsQuedan) === '["2026-11-02"]'
    && JSON.stringify(f3.labsPrevia) === '["labHistory"]' && !f3.bdErr && f3.canvas && f3.diagrama.length === 0, JSON.stringify(f3));
  // ── F4: PDF de labs (11 nov 2026): durante la subida (segundos) la nota puede re-armarse (Realtime, autoguardado). Se guarda
  // sobre la nota VIGENTE: lo escrito en esos segundos no se pierde y los labs no caen en una copia suelta.
  const f4 = await page.evaluate(async () => {
    const k = pid(patients[0]); const p = patients[0]; const hoyS = todayStr();
    const orig = { gp: window.getProxyUrl, cw: window.callLabsExtractionWorker, at: window.attachLabSourceToSnap, al: window.alert };
    const r = { alerts: [] };
    window.getProxyUrl = () => 'https://proxy.test';
    window.callLabsExtractionWorker = async () => ({ patients: [{ paciente: p.nombre, fecha_labs: hoyS, hb: '9.8', k: '4.1' }] });
    window.attachLabSourceToSnap = async (kk, fecha, snap) => {
      const copia = JSON.parse(JSON.stringify(getNote(kk))); copia.pendientes = 'ESCRITO DURANTE LA SUBIDA'; noteData[kk] = copia;
      snap.source = 'manual'; snap.source_file_name = 'lab.pdf';
    };
    window.alert = (m) => { r.alerts.push(String(m).slice(0, 80)); };
    try {
      _dirtyFields[k] = new Set();
      const nd = getNote(k); nd.labHistory = [{ fecha: hoyS, labs: { na: '138' } }]; noteData[k] = nd;
      const file = new File(['%PDF-1.4 x'], 'lab.pdf', { type: 'application/pdf' });
      await handleLabPDF(k, { files: [file], value: 'x' });
      const v = getNote(k); const s = (v.labHistory || []).find(x => x.fecha === hoyS) || {};
      Object.assign(r, { pend: v.pendientes, hb: (s.labs || {}).hb, na: (s.labs || {}).na, file: s.source_file_name, snaps: (v.labHistory || []).filter(x => x.fecha === hoyS).length, marcas: Array.from(_dirtyFields[k] || []) });
      _dirtyFields[k] = new Set(['labHistory']);
      await handleLabPDF(k, { files: [file], value: 'x' });
      r.marcasPrevia = Array.from(_dirtyFields[k] || []);
    } catch (e) { r.err = String(e); }
    _dirtyFields[k] = new Set();
    Object.assign(window, { getProxyUrl: orig.gp, callLabsExtractionWorker: orig.cw, attachLabSourceToSnap: orig.at, alert: orig.al });
    return r;
  });
  check('F4 PDF de labs: si la nota se re-arma durante la subida, lo escrito en esos segundos se conserva, los labs caen en la fecha de la nota vigente (sin duplicarla) con el archivo enlazado, y no queda la marca «editada aquí» (salvo una edición de labs en curso)',
    !f4.err && f4.alerts.length === 0 && f4.pend === 'ESCRITO DURANTE LA SUBIDA' && f4.hb === '9.8' && f4.na === '138' && f4.file === 'lab.pdf' && f4.snaps === 1
    && f4.marcas.indexOf('labHistory') < 0 && JSON.stringify(f4.marcasPrevia) === '["labHistory"]', JSON.stringify(f4));
  // ── F5: la entrega/resumen lee la firma nueva: «Gerardo 10.11.26 23:50 - texto» → fecha 2026-11-10 y «Gerardo: texto» ──
  const f5 = await page.evaluate(() => _egLineasFechadas('Gerardo 10.11.26 23:50 - Cambiar apósitos\n✓ Ana 09.11.26 08:00 - TAC\n  sigue sin firma\nGerardo 11.11.26 07:00 - '));
  check('F5 _egLineasFechadas: la firma nueva da la fecha del renglón y «Nombre: texto» (✓ se conserva; la continuación hereda la fecha; la firma sola no crea renglón)',
    JSON.stringify(f5) === JSON.stringify([{ fecha: '2026-11-10', text: 'Gerardo: Cambiar apósitos' }, { fecha: '2026-11-09', text: '✓ Ana: TAC' }, { fecha: '2026-11-09', text: 'sigue sin firma' }]), JSON.stringify(f5));
  // ── F6: revisión adversarial del 11 nov 2026 ──
  const f6 = await page.evaluate(() => {
    const st = 'Gerardo 11.11.26 10:00 - ';
    const r = {};
    r.arribaEdita = plStampNewLines('Pendiente TAC', 'Llamar a cirugía\nPendiente TAC abdominal', st);
    r.medioEdita = plStampNewLines('L1\nL2\nL3', 'L1\nNUEVO\nL2 editado\nL3', st);
    r.mover = plStampNewLines('A uno\nB dos\nC tres', 'B dos\nC tres\nA uno', st);
    r.partir = plStampNewLines('Ana 10.11.26 23:50 - Penrose 30cc, Blake 20cc', 'Ana 10.11.26 23:50 - Penrose 30cc,\nBlake 20cc', st);
    r.corto = plStampNewLines('TAC', 'TC', st);
    r.vineta = plStampNewLines('Pedir BH', 'Pedir BH\n- ', st);
    r.signo = plStampNewLines('Pedir BH', 'Pedir BH\n?', st);
    r.libre = _egLineasFechadas('Gerardo 11.11.26 10:00 - Se pasó 1 PG\nTEXTO LIBRE VIEJO');
    r.sinFirmas = plTextoSinFirmas('Gerardo 11.11.26 10:00 - \nGerardo 11.11.26 10:01 - Pedir TAC\n✓ Ana 10.11.26 08:00 - BH\nTexto suelto');
    r.ctx = _plneCtxLinea('PENDIENTES', 'Gerardo 11.11.26 10:00 - \nGerardo 11.11.26 10:01 - Pedir TAC', true);
    r.ctxPa = _plneCtxLinea('PA', 'Ingresa 10.11.26 23:50 - por urgencias con dolor abdominal');
    r.ctxCrono = _plneCtxLinea('CRONOLOGÍA', 'Gerardo 11.11.26 03:10 - Fiebre 38.9\nAna 10.11.26 22:00 - ', 'fecha');
    r.snap = [_labSnapCambia({ fecha: 'x', labs: { a: 1 }, client_updated_at: 1 }, [{ fecha: 'x', labs: { a: 1 }, client_updated_at: 2 }]),
      _labSnapCambia({ fecha: 'x', labs: { a: 1 } }, [{ fecha: 'x', labs: { a: 2 } }]), _labSnapCambia({ fecha: 'y', labs: {} }, [])];
    r.ctxTodo = _plneContexto({ ingreso: '', estado: '' }, { app: 'Ingresa 10.11.26 23:50 - por urgencias', pa: '', manejo: 'Gerardo 11.11.26 10:00 - Vigilar', pendientes: '', entrega: 'Gerardo 11.11.26 03:10 - Fiebre 38.9', checklist: {} });
    r.cambia = plStampNewLines('Pedir BH', 'Llamar a nefrología', st);
    r.solo = [plSoloFirma('Gerardo 11.11.26 10:00 - '), plSoloFirma('Gerardo 11.11.26 10:00 - TAC'), plSoloFirma('11/11 —')];
    r.sin = plSinFirma('✓ Gerardo 11.11.26 10:00 - TAC');
    r.nota = _plneLineas('Gerardo 11.11.26 10:00 - \nGerardo 11.11.26 10:01 - Pedir TAC\n11/11 — \n• IC nefro');
    r.crono = _egLineasFechadas('Gerardo 11.11.26 10:00 - Se pasó 1 PG\n09/11 22:15 GF: Fiebre 38.5, hemocultivos\n08/11 07:30 AB: Ingresa de urgencias\nVIGILAR DRENAJE 3');
    return r;
  });
  check('F6 revisión adversarial (lógica): el renglón nuevo arriba de uno editado se firma y el editado no; mover o partir un renglón no lo firma; corregir «TAC»→«TC» es editar; una viñeta sola no se firma; reemplazar el texto por otro distinto sí; la firma sola no cuenta como pendiente ni pasa a la nota; la Cronología vieja no hereda la fecha de una firma nueva',
    f6.arribaEdita === 'Gerardo 11.11.26 10:00 - Llamar a cirugía\nPendiente TAC abdominal' && f6.medioEdita === 'L1\nGerardo 11.11.26 10:00 - NUEVO\nL2 editado\nL3'
    && f6.mover === 'B dos\nC tres\nA uno' && f6.partir === 'Ana 10.11.26 23:50 - Penrose 30cc,\nBlake 20cc' && f6.corto === 'TC' && f6.vineta === 'Pedir BH\n- ' && f6.signo === 'Pedir BH\n?' && f6.libre.length === 2 && f6.libre[1].fecha === null && f6.sinFirmas === 'Pedir TAC\n✓ BH\nTexto suelto' && f6.ctx === 'PENDIENTES: Pedir TAC' && f6.ctxPa === 'PA: Ingresa 10.11.26 23:50 - por urgencias con dolor abdominal' && f6.ctxCrono === 'CRONOLOGÍA: 11.11 03:10: Fiebre 38.9 | 10.11 22:00:' && /CRONOLOGÍA DE GUARDIAS: 11\.11 03:10: Fiebre 38\.9/.test(f6.ctxTodo) && /OTROS[^\n]*: Vigilar/.test(f6.ctxTodo) && /: Ingresa 10\.11\.26 23:50 - por urgencias/.test(f6.ctxTodo) && JSON.stringify(f6.snap) === '[false,true,true]'
    && f6.cambia === 'Gerardo 11.11.26 10:00 - Llamar a nefrología' && JSON.stringify(f6.solo) === '[true,false,false]' && f6.sin === '✓ TAC'
    && JSON.stringify(f6.nota) === '["Pedir TAC","IC nefro"]'
    && f6.crono.length === 4 && f6.crono[0].fecha === '2026-11-11' && /Fiebre/.test(f6.crono[1].text) && /-11-09$/.test(f6.crono[1].fecha) && /-11-08$/.test(f6.crono[2].fecha) && f6.crono[3].fecha === f6.crono[2].fecha, JSON.stringify(f6));

  // ── F7: en la tarjeta se firma AL SOLTAR la caja (mientras se escribe no se toca el texto: el retroceso y Cmd+Z funcionan);
  // lo que cambia por código con la caja abierta no se firma con el nombre de quien escribe; un pegado largo lleva una firma y
  // sangría; ➕ Hoy no apila firmas vacías: cambia la de otro día solo si no hace de encabezado; la capa de color sigue a la
  // sangría ──
  const k7 = await page.evaluate(async () => { const k = pid(patients[0]); const nd = getNote(k); nd.pendientes = 'Pedir BH'; noteData[k] = nd; _rerenderCard(k); await new Promise(r => setTimeout(r, 300)); return k; });
  const sel7 = 'textarea[data-key="' + k7 + '"][data-field="pendientes"]';
  const valor7 = () => page.evaluate((sel) => document.querySelector(sel).value, sel7);
  const soltar7 = async () => { await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.waitForTimeout(150); };
  // (a) Retroceso: escribir «\nx» y borrarlo deja la caja como estaba, sin restos de firma
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('x');
  const f7durante = await valor7();
  for (let i = 0; i < 2; i++) await page.keyboard.press('Backspace');
  const f7borrado = await valor7(); await soltar7(); const f7borradoFin = await valor7();
  // (b) Cmd/Ctrl+Z: lo escrito se deshace sin dejar firmas
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Retirar SNG', { delay: 10 });
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  const f7undo = await valor7(); await soltar7();
  // (b2) un «change» que dispara el código no firma (aunque haya algo escrito por la persona)
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Sin firma aun', { delay: 10 });
  const f7sint = await page.evaluate((sel) => { const ta = document.querySelector(sel); ta.dispatchEvent(new Event('change', { bubbles: true })); return ta.value; }, sel7);
  for (let i = 0; i < 14; i++) await page.keyboard.press('Backspace');
  await soltar7();
  // (c) renglones nuevos (también arriba) se firman al soltar, cada uno con su firma
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Retirar SNG', { delay: 10 });
  await page.keyboard.press('Control+Home'); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp'); await page.keyboard.type('Arriba', { delay: 10 });
  await soltar7(); const f7c1 = await valor7();
  // (d) cambio por código con la caja abierta: «DE OTRO» no se firma con mi nombre; lo que tecleé antes y después sí
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Antes', { delay: 10 });
  await page.evaluate((sel) => { const ta = document.querySelector(sel); ta.value = ta.value + '\nDE OTRO'; }, sel7);
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Mío', { delay: 10 });
  await soltar7(); const f7d = await valor7();
  // (d2) cambio por código y se suelta sin teclear más: tampoco se firma con mi nombre
  await page.click(sel7);
  await page.evaluate((sel) => { const ta = document.querySelector(sel); ta.value = ta.value + '\nOTRO SOLO'; ta.dispatchEvent(new Event('input', { bubbles: true })); }, sel7);
  await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.press('Backspace');
  await soltar7(); const f7d2 = await valor7();
  // (d3) lápiz con lo tecleado sin soltar: lo tecleado también se firma
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Tecleado', { delay: 10 });
  await page.evaluate((k) => _penInsertText(k, 'pendientes', 'DEL LAPIZ', '\n', true), k7);
  await soltar7(); const f7d3 = await valor7();
  // (d3b) como Safari: al soltar NO llega «change» (el último cambio fue del código); al perder el foco se firma igual y se guarda
  await page.evaluate(() => { window.__sinChange = function (e) { e.stopImmediatePropagation(); }; window.addEventListener('change', window.__sinChange, true); });
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Safari', { delay: 10 });
  await page.evaluate((k) => _penInsertText(k, 'pendientes', 'LAPIZ 2', '\n', true), k7);
  await soltar7();
  await page.evaluate(() => window.removeEventListener('change', window.__sinChange, true));
  const f7d3b = await page.evaluate((k) => ({ val: document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]').value, nota: getNote(k).pendientes }), k7);
  // (d5) ocultar la app escribiendo ARRIBA: se firma sin mover el cursor (lo que se sigue tecleando cae en ese renglón) y la
  // base no se reinicia (la continuación con sangría que se escribe al volver no lleva otra firma)
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = 'Ana 10.11.26 08:00 - Pedir BH\nAna 10.11.26 08:01 - Pedir QS'; noteData[k] = nd; _rerenderCard(k); }, k7); await page.waitForTimeout(200);
  await page.click(sel7); await page.keyboard.press('Control+Home'); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Llamar a ciru', { delay: 10 });
  await page.evaluate(() => persistBeforeExit());
  await page.keyboard.type('gía', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.type('  y avisar a MI', { delay: 10 });
  await soltar7(); const f7d5 = await valor7();
  // (d4) salir de la app sin soltar la caja: se firma antes de guardar
  await page.click(sel7); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Sin soltar', { delay: 10 });
  const f7d4 = await page.evaluate((k) => { persistBeforeExit(); return { val: document.activeElement.value, nota: getNote(k).pendientes }; }, k7);
  await soltar7();
  // (e) pegado de 8 renglones: una firma y los demás con sangría
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = 'Pedir BH'; noteData[k] = nd; _rerenderCard(k); }, k7); await page.waitForTimeout(200);
  await page.click(sel7); await page.keyboard.press('Control+End');
  await page.evaluate((sel) => { const ta = document.querySelector(sel); ta.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', bubbles: true, cancelable: true })); }, sel7);
  await page.keyboard.insertText('\nHb 9.1\nLeucos 14\nPlaq 210\nNa 136\nK 4.1\nCr 0.9\nPCR 12\nLactato 1.1');
  await soltar7(); const f7e = await valor7();
  const f7f = await page.evaluate(async (k) => {
    const r = {};
    const nd = getNote(k);
    // ➕ Hoy: firma vacía de ayer con un renglón firmado debajo → se cambia por la de hoy (no se apila)
    nd.pendientes = 'Gerardo 10.11.26 08:00 - \nGerardo 10.11.26 08:05 - Pedir BH'; noteData[k] = nd; _rerenderCard(k); await new Promise(x => setTimeout(x, 200));
    pendInsertToday(k); r.hoyA = getNote(k).pendientes; pendInsertToday(k); r.hoyA2 = getNote(k).pendientes;
    // ➕ Hoy: firma vacía de ayer que hace de encabezado de un renglón sin firma → se pone la de hoy arriba y la vieja se queda
    const nd2 = getNote(k); nd2.pendientes = 'Gerardo 10.11.26 08:00 - \nPedir BH'; noteData[k] = nd2; _rerenderCard(k); await new Promise(x => setTimeout(x, 200));
    pendInsertToday(k); r.hoyB = getNote(k).pendientes;
    const nd3 = getNote(k); nd3.checklist = nd3.checklist || {}; nd3.checklist.interconsultas = 'MI: valorado\nGerardo 10.11.26 08:00 - '; noteData[k] = nd3; _rerenderCard(k); await new Promise(x => setTimeout(x, 200));
    insertTodayStamp(k, 'interconsultas', true, 'Interconsultas'); r.ic1 = getNote(k).checklist.interconsultas;
    insertTodayStamp(k, 'interconsultas', true, 'Interconsultas'); r.ic2 = getNote(k).checklist.interconsultas;
    document.activeElement && document.activeElement.blur();
    const nd4 = getNote(k); nd4.pendientes = 'Gerardo 11.11.26 10:00 - Nuevo\n  sigue el nuevo\nPedir BH viejo'; noteData[k] = nd4; _rerenderCard(k); await new Promise(x => setTimeout(x, 300));
    plStMountAll();
    const ta = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]'); const bd = ta && ta.previousElementSibling;
    r.capa = bd && bd.classList.contains('pl-st-bd') ? bd.innerHTML.split('\n').map(l => /background/.test(l)) : null;
    nd4.pendientes = ''; noteData[k] = nd4; _rerenderCard(k);
    return r;
  }, k7);
  const z7 = n => String(n).padStart(2, '0'); const h7 = new Date(); const fe7 = z7(h7.getDate()) + '\\.' + z7(h7.getMonth() + 1) + '\\.' + String(h7.getFullYear()).slice(2);
  const fh = '^Gerardo ' + fe7 + ' \\d{2}:\\d{2} - ';
  const F = (re) => new RegExp(re);
  check('F7 en la tarjeta: al escribir no se toca el texto (Retroceso y Cmd+Z funcionan, sin restos de firma); al soltar se firma cada renglón nuevo (también el de arriba); lo cambiado por código no lleva mi firma; un pegado largo lleva una firma y sangría; ➕ Hoy cambia la firma vacía de ayer si no es encabezado y si lo es pone la de hoy arriba (IC igual); la capa sigue a la sangría',
    f7sint === 'Pedir BH\nSin firma aun' && f7durante === 'Pedir BH\nx' && f7borrado === 'Pedir BH' && f7borradoFin === 'Pedir BH' && f7undo === 'Pedir BH'
    && F(fh + 'Arriba\nPedir BH\nGerardo \\d{2}\\.\\d{2}\\.\\d{2} \\d{2}:\\d{2} - Retirar SNG$').test(f7c1)
    && /\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Antes\nDE OTRO\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Mío$/.test(f7d) && /\nOTRO SOLO$/.test(f7d2)
    && /\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Tecleado\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - DEL LAPIZ$/.test(f7d3)
    && /\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Safari\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - LAPIZ 2$/.test(f7d3b.val) && f7d3b.nota === f7d3b.val
    && /\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Sin soltar$/.test(f7d4.val) && f7d4.nota === f7d4.val
    && /^Gerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Llamar a cirugía\n  y avisar a MI\nAna 10\.11\.26 08:00 - Pedir BH\nAna 10\.11\.26 08:01 - Pedir QS$/.test(f7d5)
    && F('^Pedir BH\\nGerardo \\d{2}\\.\\d{2}\\.\\d{2} \\d{2}:\\d{2} - Hb 9\\.1\\n  Leucos 14\\n  Plaq 210\\n  Na 136\\n  K 4\\.1\\n  Cr 0\\.9\\n  PCR 12\\n  Lactato 1\\.1$').test(f7e)
    && F(fh).test(f7f.hoyA) && f7f.hoyA.split('\n').length === 2 && f7f.hoyA2 === f7f.hoyA
    && F(fh).test(f7f.hoyB) && f7f.hoyB.split('\n').length === 3 && /\nGerardo 10\.11\.26 08:00 - \nPedir BH$/.test(f7f.hoyB)
    && /^MI: valorado\n/.test(f7f.ic1) && F(fh).test(f7f.ic1.split('\n')[1]) && f7f.ic1.split('\n').length === 2 && f7f.ic2 === f7f.ic1
    && JSON.stringify(f7f.capa && f7f.capa.slice(0, 3)) === '[true,true,false]', JSON.stringify({ f7sint, f7durante, f7borrado, f7borradoFin, f7undo, f7c1, f7d, f7d2, f7d3, f7d3b, f7d4, f7d5, f7e, f7f }));

  // ── F8: sin la marca «editado aquí», lo que este equipo guardó DESPUÉS de que empezó una carga (diagrama, labs del PDF,
  // fecha de labs borrada) no lo regresa la foto vieja de la nube ──
  const f8 = await page.evaluate(() => {
    const k = pid(patients[0]); const t0 = Date.now() - 5000;
    const nd = getNote(k); nd.checklist = nd.checklist || {};
    nd.body_diagram_ant = 'data:image/png;base64,LOCAL'; nd.labHistory = [{ fecha: '2026-11-10', labs: { hb: '9' }, client_updated_at: Date.now() }]; nd.checklist.__lab_deleted = ['2026-11-01']; noteData[k] = nd;
    _dirtyFields[k] = new Set(); delete _pendingDirty[k]; delete _inflightDirty[k];
    const colaAntes = outboxLoad(); outboxSave([]);   // la superposición de la cola taparía la foto de la nube
    _touchLocalFields(k, ['body_diagram_ant', 'labHistory', 'checklist']);
    const vieja = JSON.parse(JSON.stringify(nd)); vieja.body_diagram_ant = 'data:image/png;base64,VIEJA';
    vieja.labHistory = [{ fecha: '2026-11-01', labs: { hb: '7' }, client_updated_at: 1 }, { fecha: '2026-11-05', labs: { hb: '8' }, client_updated_at: 1 }]; vieja.checklist.__lab_deleted = ['2026-11-07'];
    nd.labHistory.push({ fecha: '2026-11-07', labs: { hb: '6' }, client_updated_at: Date.now() - 60000 });   // otro equipo borró el 07: no revive
    nd.labHistory.push({ fecha: '2026-11-01', labs: { hb: '11' }, client_updated_at: Date.now() - 60000 });  // borrada aquí y vuelta a llenar aquí: se queda
    nd.labHistory.push({ fecha: '2026-11-09', labs: { hb: '12' }, client_updated_at: Date.now() });          // ↩ regresada aquí durante la carga: se queda
    vieja.checklist.__lab_deleted = ['2026-11-07', '2026-11-09'];
    const cargada = {}; cargada[k] = vieja; cargada.__loadStartTs = t0;
    _applyLoadedNotes(cargada);
    outboxSave(colaAntes);
    const v = noteData[k];
    const r = { diag: v.body_diagram_ant, fechas: (v.labHistory || []).map(x => x.fecha), del: (v.checklist || {}).__lab_deleted };
    // (b) solo se tocaron los labs (no el checklist): una fecha que otro equipo borró y que aquí se volvió a llenar después
    // de que empezó la carga se queda
    const nd2 = noteData[k]; nd2.checklist = nd2.checklist || {}; nd2.checklist.__lab_deleted = [];
    nd2.labHistory = [{ fecha: '2026-11-08', labs: { hb: '13' }, client_updated_at: Date.now() }]; noteData[k] = nd2;
    if (_localFieldTouch[k]) { delete _localFieldTouch[k].checklist; delete _localFieldTouch[k].body_diagram_ant; }
    _touchLocalFields(k, ['labHistory']);
    const vieja2 = JSON.parse(JSON.stringify(nd2)); vieja2.labHistory = []; vieja2.checklist.__lab_deleted = ['2026-11-08'];
    const cargada2 = {}; cargada2[k] = vieja2; cargada2.__loadStartTs = Date.now() - 5000;
    const cola2 = outboxLoad(); outboxSave([]); _applyLoadedNotes(cargada2); outboxSave(cola2);
    r.soloLabs = (noteData[k].labHistory || []).map(x => x.fecha);
    // (c) valores de lo borrado: si este equipo NO borró esa fecha durante la carga, ganan los de la nube
    const nd3 = noteData[k]; nd3.checklist = nd3.checklist || {};
    nd3.checklist.__lab_deleted = ['2026-11-03', '2026-11-04']; nd3.checklist.__lab_deleted_labs = { '2026-11-03': { hb: 'VIEJO' }, '2026-11-04': { hb: 'MIO' } }; noteData[k] = nd3;
    window._labBorradoLocalTs[k + '|2026-11-04'] = Date.now();   // este equipo borró el 04 durante la carga
    if (_localFieldTouch[k]) { delete _localFieldTouch[k].labHistory; }
    _touchLocalFields(k, ['checklist']);
    const vieja3 = JSON.parse(JSON.stringify(nd3)); vieja3.checklist.__lab_deleted_labs = { '2026-11-03': { hb: 'NUBE' }, '2026-11-04': { hb: 'NUBE' } };
    const cargada3 = {}; cargada3[k] = vieja3; cargada3.__loadStartTs = Date.now() - 5000;
    const cola3 = outboxLoad(); outboxSave([]); _applyLoadedNotes(cargada3); outboxSave(cola3);
    r.dl = noteData[k].checklist.__lab_deleted_labs;
    delete window._labBorradoLocalTs[k + '|2026-11-04']; noteData[k].checklist.__lab_deleted = []; noteData[k].checklist.__lab_deleted_labs = {};
    const v2 = noteData[k]; v2.body_diagram_ant = ''; v2.labHistory = []; v2.checklist.__lab_deleted = []; delete cargada.__loadStartTs; delete cargada2.__loadStartTs;
    return r;
  });
  check('F8 una carga que empezó antes de guardar no regresa el diagrama, no revive la fecha de labs borrada (ni la que borró otro equipo), conserva los labs del PDF y los de otro equipo, y SUMA las lápidas',
    f8.diag === 'data:image/png;base64,LOCAL' && JSON.stringify(f8.fechas.slice().sort()) === '["2026-11-01","2026-11-05","2026-11-09","2026-11-10"]' && JSON.stringify(f8.del.slice().sort()) === '["2026-11-01","2026-11-07"]' && JSON.stringify(f8.soloLabs) === '["2026-11-08"]' && f8.dl && f8.dl['2026-11-03'].hb === 'NUBE' && f8.dl['2026-11-04'].hb === 'MIO', JSON.stringify(f8));

  // ── F9: PDF de labs cuando la tarjeta cambia de clave a media subida, y cuando la subida a Storage cae al respaldo ──
  const f9 = await page.evaluate(async () => {
    const p = patients[0]; const k0 = pid(p); const id0 = p._supa_id || p.id; const hoyS = todayStr();
    const orig = { gp: window.getProxyUrl, cw: window.callLabsExtractionWorker, at: window.attachLabSourceToSnap, al: window.alert };
    const r = { alerts: [] };
    window.getProxyUrl = () => 'https://proxy.test'; window.alert = (m) => { r.alerts.push(String(m).slice(0, 80)); };
    window.callLabsExtractionWorker = async () => ({ patients: [{ paciente: p.nombre, fecha_labs: hoyS, hb: '10.2' }] });
    try {
      // (a) la tarjeta recibe otro id durante la subida
      const nd = getNote(k0); nd.pendientes = 'NO SE PIERDE'; nd.labHistory = []; noteData[k0] = nd; _dirtyFields[k0] = new Set();
      const idNuevo = '7b000000-0000-4000-8000-0000000000aa';
      window.attachLabSourceToSnap = async () => { _relinkPatientId(p, idNuevo); };
      await handleLabPDF(k0, { files: [new File(['%PDF-1.4 x'], 'a.pdf', { type: 'application/pdf' })], value: 'x' });
      const k1 = pid(p);
      r.claveCambio = k1 !== k0; r.vieja = !!noteData[k0];
      const v1 = getNote(k1); r.pend = v1.pendientes; r.hb = ((v1.labHistory || []).find(x => x.fecha === hoyS) || { labs: {} }).labs.hb;
      r.marcas = Array.from(_dirtyFields[k1] || []);
      _relinkPatientId(p, id0);
      // (b) la nota se re-arma durante la subida y Storage falla (respaldo dentro de la nota): no queda la ruta del PDF anterior
      const k2 = pid(p); const nd2 = getNote(k2);
      nd2.labHistory = [{ fecha: hoyS, labs: { na: '139' }, source: 'manual', source_storage_bucket: 'labs', source_storage_path: 'X/viejo.pdf', source_file_name: 'viejo.pdf' }]; noteData[k2] = nd2;
      window.attachLabSourceToSnap = async (kk, fecha, snap) => {
        noteData[kk] = JSON.parse(JSON.stringify(getNote(kk)));
        snap.source_storage_bucket = ''; snap.source_storage_path = ''; snap.source_file = 'data:application/pdf;base64,NUEVO'; snap.source_file_name = 'nuevo.pdf'; snap.source_file_type = 'application/pdf';
      };
      await handleLabPDF(k2, { files: [new File(['%PDF-1.4 y'], 'nuevo.pdf', { type: 'application/pdf' })], value: 'x' });
      const s2 = (getNote(k2).labHistory || []).find(x => x.fecha === hoyS) || {};
      r.ruta = s2.source_storage_path; r.archivo = s2.source_file_name; r.inline = /NUEVO/.test(s2.source_file || ''); r.na = (s2.labs || {}).na; r.hb2 = (s2.labs || {}).hb;
    } catch (e) { r.err = String(e && e.stack || e).slice(0, 300); }
    Object.assign(window, { getProxyUrl: orig.gp, callLabsExtractionWorker: orig.cw, attachLabSourceToSnap: orig.at, alert: orig.al });
    const kf = pid(p); _dirtyFields[kf] = new Set(); const ndf = getNote(kf); ndf.pendientes = ''; ndf.labHistory = []; noteData[kf] = ndf;
    return r;
  });
  check('F9 PDF de labs: si la tarjeta cambia de clave a media subida, los labs entran a la nota del paciente sin vaciarla ni dejar una nota en blanco ni la marca; si Storage falla, el enlace queda en el archivo nuevo (no en la ruta del PDF anterior)',
    !f9.err && f9.alerts.length === 0 && f9.claveCambio && !f9.vieja && f9.pend === 'NO SE PIERDE' && f9.hb === '10.2' && f9.marcas.indexOf('labHistory') < 0
    && f9.ruta === '' && f9.archivo === 'nuevo.pdf' && f9.inline && f9.na === '139' && f9.hb2 === '10.2', JSON.stringify(f9));

  // ── F10: ✏️ Editar (ventana del paciente): lo escrito ahí en Pendientes / Otros / Drenajes también se firma al guardar;
  //    lo que ya estaba no; APP no es caja con firma; cerrar sin «Guardar» también sube lo escrito firmado. ──
  const f10 = await page.evaluate(async () => {
    const r = {};
    try {
      const k = pid(patients[0]); const nd = getNote(k);
      nd.pendientes = 'Ana 09.11.26 08:00 - ya estaba'; nd.manejo = ''; nd.app = ''; noteData[k] = nd; _dirtyFields[k] = new Set();
      openEditModal(k);
      const pe = document.getElementById('mf-pendientes-modal'), ap = document.getElementById('mf-app-modal'), dr = document.getElementById('mf-drenajes-modal');
      pe.value = pe.value + '\nRetirar sonda Foley'; liveModalNote('pendientes', pe.value);
      ap.value = 'DM2'; liveModalNote('app', ap.value);
      dr.value = 'Penrose 30 ml seroso'; liveModalNote('drenajes', dr.value);
      saveModal();
      await new Promise(res => setTimeout(res, 300));
      const n1 = getNote(k);
      r.pend = n1.pendientes; r.app = n1.app; r.dren = n1.drenajes; r.abierto = document.getElementById('patient-modal').style.display;
      // cerrar con ✕ sin guardar: lo escrito en Otros se sube firmado
      openEditModal(k);
      const ma = document.getElementById('mf-manejo-modal');
      ma.value = 'Valorar retiro de SNG'; liveModalNote('manejo', ma.value);
      closeModal();
      r.otros = getNote(k).manejo;
      // abrir y guardar sin tocar nada: no cambia ni se refirma
      openEditModal(k); saveModal(); await new Promise(res => setTimeout(res, 200));
      const n3 = getNote(k); r.igual = n3.pendientes === r.pend && n3.manejo === r.otros;
      nd.pendientes = ''; nd.manejo = ''; nd.app = ''; nd.drenajes = ''; noteData[k] = nd; _dirtyFields[k] = new Set();
    } catch (e) { r.err = String(e && e.stack || e).slice(0, 300); }
    return r;
  });
  const stRe = /^Gerardo \d\d\.\d\d\.\d\d \d\d:\d\d - /;
  check('F10 ✏️ Editar: un renglón nuevo en Pendientes y lo escrito en Drenajes se guardan firmados y lo que ya estaba no se toca; APP no lleva firma; cerrar sin «Guardar» sube Otros firmado; guardar sin cambios no refirma',
    !f10.err && f10.abierto === 'none' && f10.pend.split('\n')[0] === 'Ana 09.11.26 08:00 - ya estaba' && stRe.test(f10.pend.split('\n')[1]) && /Retirar sonda Foley$/.test(f10.pend)
    && f10.app === 'DM2' && stRe.test(f10.dren) && /Penrose 30 ml seroso$/.test(f10.dren) && stRe.test(f10.otros || '') && /Valorar retiro de SNG$/.test(f10.otros) && f10.igual, JSON.stringify(f10));

  // ── F11: ✏️ Editar con teclado real (revisión adversarial del 11 nov) ──
  const kF = await page.evaluate(async () => {
    const k = pid(patients[0]); const nd = getNote(k);
    nd.pendientes = 'Ana 09.11.26 08:00 - ya estaba'; nd.manejo = ''; nd.drenajes = 'Ana 09.11.26 08:00 - Penrose FID 30 cc seroso\nBeto 10.11.26 09:00 - Blake 50 cc hemático';
    noteData[k] = nd; _dirtyFields[k] = new Set(); focusGoTo(k); await new Promise(r => setTimeout(r, 400));
    return k;
  });
  const pendCard = 'textarea[data-key="' + kF + '"][data-field="pendientes"]';
  const r11 = {};
  // a) ✕ sin guardar: la tarjeta se repinta con lo escrito (firmado) y escribir luego en la tarjeta no lo borra
  await page.evaluate((k) => openEditModal(k), kF);
  await page.focus('#mf-pendientes-modal'); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('Retirar sonda Foley', { delay: 5 });
  await page.$eval('#patient-modal .modal-close', b => b.click());
  await page.waitForTimeout(2600);
  r11.cardTrasCerrar = await page.$eval(pendCard, t => t.value);
  await page.click(pendCard); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('TAC control', { delay: 5 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(300);
  r11.notaTrasTarjeta = await page.evaluate((k) => getNote(k).pendientes, kF);
  // b) solo cambiar el estado y guardar: la nota de drenajes de varios renglones no se une
  r11.drenOk = await page.evaluate(async (k) => {
    const antes = getNote(k).drenajes; openEditModal(k); _setEstadoPill('DELICADO'); saveModal();
    await new Promise(r => setTimeout(r, 200)); const d = getNote(k).drenajes;
    openEditModal(k); _setEstadoPill('ESTABLE'); saveModal(); await new Promise(r => setTimeout(r, 200));
    return d === antes;
  }, kF);
  // c) ➕ drenaje con Enter en «Tipo»: renglón nuevo y firmado; lo de Ana y Beto intacto
  await page.evaluate((k) => openEditModal(k), kF);
  await page.focus('#mf-dr-tipo'); await page.keyboard.type('Jackson', { delay: 5 }); await page.keyboard.press('Enter');
  await page.$eval('#modal-save-btn', b => b.click()); await page.waitForTimeout(300);
  r11.dren = await page.evaluate((k) => getNote(k).drenajes, kF);
  // d) Esc cierra como ✕: lo escrito en Otros queda firmado en la nota y la ventana cerrada por dentro
  await page.evaluate((k) => openEditModal(k), kF);
  await page.focus('#mf-manejo-modal'); await page.keyboard.type('Curación diaria', { delay: 5 });
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  r11.esc = await page.evaluate((k) => ({ otros: getNote(k).manejo, vis: document.getElementById('patient-modal').style.display, clave: _modalCurrentEditKey }), kF);
  // e) ocultar la app con la ventana abierta (persistBeforeExit): lo escrito se firma en la nota; al cerrar no se refirma
  await page.evaluate((k) => openEditModal(k), kF);
  await page.focus('#mf-pendientes-modal'); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('Interconsulta a nutrición', { delay: 5 });
  r11.salir = await page.evaluate((k) => { persistBeforeExit(); const a = getNote(k).pendientes; closeModal(); return { a, b: getNote(k).pendientes }; }, kF);
  // f) la marca de pegado no pasa de una ventana a otra; un alta compara contra nada
  r11.pegado = await page.evaluate((k) => { openEditModal(k); const el = document.getElementById('mf-pendientes-modal'); el.__stPegado = true; closeModal(); const t1 = el.__stPegado; el.__stPegado = true; openAddModal(); const t2 = el.__stPegado; const snap = _modalNoteSnapshot; closeModal(); return t1 === false && t2 === false && snap === null; }, kF);
  // g) ➕ Agregar con el expediente de alguien ya registrado → «Mover»: lo escrito en la ventana se suma a su nota
  r11.mover = await page.evaluate(async (k) => {
    const p = patients.find(x => pid(x) === k); const camaAntes = p.cama;
    openAddModal();
    document.getElementById('mf-cama').value = '3-399'; document.getElementById('mf-exp').value = p.exp; document.getElementById('mf-nombre').value = p.nombre;
    document.getElementById('mf-pendientes-modal').value = 'Ver TAC de abdomen'; document.getElementById('mf-app-modal').value = 'HAS';
    saveModal(); await new Promise(r => setTimeout(r, 300));
    const q = patients.find(x => x.exp === p.exp); const n = getNote(pid(q));
    const out = { cama: q.cama, pend: n.pendientes, app: n.app, n: patients.filter(x => x.exp === p.exp).length };
    _moveExistingPatient(q, { cama: camaAntes }); return out;
  }, kF);
  // h) Esc y tocar la tarjeta en seguida (sin esperar el repintado): lo escrito en la ventana no se pierde
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = 'Ana 09.11.26 08:00 - ya estaba'; noteData[k] = nd; _dirtyFields[k] = new Set(); _rerenderCard(k); }, kF);
  await page.waitForTimeout(300);
  await page.evaluate((k) => openEditModal(k), kF);
  await page.focus('#mf-pendientes-modal'); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('Pedir BH', { delay: 5 });
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  await page.click(pendCard); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('TAC control', { delay: 5 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(300);
  r11.rapido = await page.evaluate((k) => getNote(k).pendientes, kF);
  // i) ocultar la app con el cursor a media caja: el cursor se queda en su renglón (no salta al final)
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = 'Ana 10.11.26 08:00 - Pedir BH\nAna 10.11.26 08:01 - Pedir QS'; noteData[k] = nd; _dirtyFields[k] = new Set(); openEditModal(k); }, kF);
  await page.focus('#mf-pendientes-modal'); await page.keyboard.press('Control+Home');
  await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp'); await page.keyboard.type('Llamar a ciru', { delay: 5 });
  await page.evaluate(() => persistBeforeExit());
  await page.keyboard.type('gía', { delay: 5 });
  await page.$eval('#modal-save-btn', b => b.click()); await page.waitForTimeout(300);
  r11.cursor = await page.evaluate((k) => getNote(k).pendientes, kF);
  // j-k) «Mover» con Sangrado y PA: Sangrado de varios renglones sobrevive a guardar la ventana; «LAPE» no se omite por estar dentro de «LAPE + lavado»
  r11.mover2 = await page.evaluate(async (k) => {
    const p = patients.find(x => pid(x) === k); const camaAntes = p.cama; const nd = getNote(k);
    nd.sangrado = '200'; nd.pa = 'LAPE + lavado'; noteData[k] = nd; _dirtyFields[k] = new Set();
    openAddModal();
    document.getElementById('mf-cama').value = '3-398'; document.getElementById('mf-exp').value = p.exp; document.getElementById('mf-nombre').value = p.nombre;
    document.getElementById('mf-sangrado-modal').value = '350'; document.getElementById('mf-pa-modal').value = 'LAPE';
    saveModal(); await new Promise(r => setTimeout(r, 300));
    const q = patients.find(x => x.exp === p.exp); const k2 = pid(q); const n = getNote(k2);
    const out = { sangrado: n.sangrado, pa: n.pa };
    openEditModal(k2); _setEstadoPill('DELICADO'); saveModal(); await new Promise(r => setTimeout(r, 200));
    out.sangradoTras = getNote(k2).sangrado;
    openEditModal(k2); _setEstadoPill('ESTABLE'); saveModal(); await new Promise(r => setTimeout(r, 200));
    _moveExistingPatient(q, { cama: camaAntes }); return out;
  }, kF);
  // l) «Mover» con pendiente igual a uno ya hecho ✓, lectura de drenaje igual a la de ayer y una continuación con sangría:
  //    todo lo escrito se agrega completo y firmado; APP idéntica se omite; la tarjeta lo muestra al instante
  r11.mover3 = await page.evaluate(async (k) => {
    const p = patients.find(x => pid(x) === k); const camaAntes = p.cama; const nd = getNote(k);
    nd.pendientes = '✓ Ana 09.11.26 08:00 - Pedir BH'; nd.drenajes = 'Ana 10.11.26 08:00 - Penrose FID 30 cc seroso'; nd.app = 'HAS\nDM2';
    noteData[k] = nd; _dirtyFields[k] = new Set(); _rerenderCard(k);
    openAddModal();
    document.getElementById('mf-cama').value = '3-397'; document.getElementById('mf-exp').value = p.exp; document.getElementById('mf-nombre').value = p.nombre;
    document.getElementById('mf-pendientes-modal').value = 'Pedir BH\nTAC de abdomen\n  en ayuno';
    document.getElementById('mf-drenajes-modal').value = 'Penrose FID 30 cc seroso'; document.getElementById('mf-app-modal').value = 'DM2';
    document.getElementById('mf-pendientes-modal').focus();   // iPad: el toque en el botón no se lleva el foco
    saveModal();
    const q = patients.find(x => x.exp === p.exp); const k2 = pid(q); const n = getNote(k2);
    const ta = document.querySelector('textarea[data-key="' + k2 + '"][data-field="pendientes"]');
    const out = { pend: n.pendientes, dren: n.drenajes, app: n.app, tarjeta: ta ? ta.value : null };
    _moveExistingPatient(q, { cama: camaAntes }); return out;
  }, kF);
  // m) ocultar la app con el cursor al inicio de un renglón con viñeta: el cursor queda después de la firma, no dentro
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = 'Ana 10.11.26 08:00 - Pedir BH'; noteData[k] = nd; _dirtyFields[k] = new Set(); openEditModal(k); }, kF);
  await page.focus('#mf-pendientes-modal'); await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter'); await page.keyboard.type('- QS', { delay: 5 }); await page.keyboard.press('Home');
  await page.evaluate(() => persistBeforeExit());
  await page.keyboard.type('Urgente ', { delay: 5 });
  await page.$eval('#modal-save-btn', b => b.click()); await page.waitForTimeout(300);
  r11.vineta = await page.evaluate((k) => getNote(k).pendientes, kF);
  await page.evaluate((k) => { const nd = getNote(k); nd.pendientes = ''; nd.manejo = ''; nd.drenajes = ''; nd.app = ''; nd.pa = ''; nd.sangrado = ''; noteData[k] = nd; _dirtyFields[k] = new Set(); }, kF);
  const lin = (s) => String(s || '').split('\n');
  check('F11a ✏️ Editar cerrada con ✕: la tarjeta muestra lo escrito ya firmado y lo que se escribe después en la tarjeta se suma sin borrarlo',
    lin(r11.cardTrasCerrar)[0] === 'Ana 09.11.26 08:00 - ya estaba' && stRe.test(lin(r11.cardTrasCerrar)[1]) && /Retirar sonda Foley$/.test(r11.cardTrasCerrar)
    && /Retirar sonda Foley/.test(r11.notaTrasTarjeta) && /TAC control$/.test(r11.notaTrasTarjeta), JSON.stringify(r11));
  check('F11b-c Drenajes en ✏️ Editar: guardar solo el estado no une los renglones; ➕ (Enter en Tipo) agrega un renglón nuevo firmado',
    r11.drenOk === true && lin(r11.dren).length === 3 && lin(r11.dren)[0] === 'Ana 09.11.26 08:00 - Penrose FID 30 cc seroso' && lin(r11.dren)[1] === 'Beto 10.11.26 09:00 - Blake 50 cc hemático' && stRe.test(lin(r11.dren)[2]) && /Jackson$/.test(r11.dren), JSON.stringify(r11));
  check('F11d-e Esc cierra ✏️ Editar como ✕ (Otros firmado, ventana cerrada por dentro); ocultar la app con la ventana abierta firma lo escrito y cerrar después no lo refirma',
    r11.esc && stRe.test(r11.esc.otros || '') && /Curación diaria$/.test(r11.esc.otros) && r11.esc.vis === 'none' && r11.esc.clave === null
    && r11.salir && stRe.test(lin(r11.salir.a)[1] || '') && /Interconsulta a nutrición$/.test(r11.salir.a) && r11.salir.b === r11.salir.a, JSON.stringify(r11));
  check('F11f-g la marca de pegado no pasa a la siguiente ventana y un alta compara contra nada; ➕ Agregar que termina en «Mover» suma lo escrito a la nota (Pendientes firmado, APP tal cual) sin duplicar al paciente',
    r11.pegado === true && r11.mover && r11.mover.cama === '3-399' && r11.mover.n === 1 && stRe.test(lin(r11.mover.pend).slice(-1)[0]) && /Ver TAC de abdomen$/.test(r11.mover.pend) && r11.mover.app === 'HAS', JSON.stringify(r11));

  check('F11h-i Esc y tocar la tarjeta en seguida no borra lo escrito en la ventana; ocultar la app a media caja deja el cursor en su renglón (lo que se sigue escribiendo no cae en el renglón de otra persona)',
    lin(r11.rapido).length === 3 && lin(r11.rapido)[0] === 'Ana 09.11.26 08:00 - ya estaba' && stRe.test(lin(r11.rapido)[1]) && /Pedir BH$/.test(lin(r11.rapido)[1]) && /TAC control$/.test(lin(r11.rapido)[2])
    && lin(r11.cursor).length === 3 && stRe.test(lin(r11.cursor)[0]) && /- Llamar a cirugía$/.test(lin(r11.cursor)[0]) && lin(r11.cursor)[1] === 'Ana 10.11.26 08:00 - Pedir BH' && lin(r11.cursor)[2] === 'Ana 10.11.26 08:01 - Pedir QS', JSON.stringify(r11));
  check('F11j-k «Mover»: Sangrado de dos renglones sobrevive a guardar la ventana (ya no es un campo de un renglón); «LAPE» se suma aunque «LAPE + lavado» lo contenga',
    r11.mover2 && r11.mover2.sangrado === '200\n350' && r11.mover2.sangradoTras === '200\n350' && r11.mover2.pa === 'LAPE + lavado\nLAPE', JSON.stringify(r11.mover2));

  const m3 = r11.mover3 || {};
  check('F11l «Mover»: un pendiente igual a uno ya hecho ✓, la lectura de drenaje igual a la de ayer y una continuación con sangría se agregan completos y firmados; APP idéntica no se duplica; la tarjeta muestra lo sumado al instante',
    lin(m3.pend).length === 4 && lin(m3.pend)[0] === '✓ Ana 09.11.26 08:00 - Pedir BH' && stRe.test(lin(m3.pend)[1]) && /- Pedir BH$/.test(lin(m3.pend)[1]) && stRe.test(lin(m3.pend)[2]) && /TAC de abdomen$/.test(lin(m3.pend)[2]) && lin(m3.pend)[3] === '  en ayuno'
    && lin(m3.dren).length === 2 && stRe.test(lin(m3.dren)[1]) && /Penrose FID 30 cc seroso$/.test(lin(m3.dren)[1]) && m3.app === 'HAS\nDM2' && m3.tarjeta === m3.pend, JSON.stringify(m3));
  check('F11m ocultar la app con el cursor al inicio de un renglón con viñeta: lo que se sigue escribiendo queda después de la firma (no la rompe ni se firma dos veces)',
    lin(r11.vineta).length === 2 && lin(r11.vineta)[0] === 'Ana 10.11.26 08:00 - Pedir BH' && stRe.test(lin(r11.vineta)[1]) && /\d - Urgente QS$/.test(lin(r11.vineta)[1]) && (lin(r11.vineta)[1].match(/Gerardo/g) || []).length === 1, JSON.stringify(r11.vineta));

  if (SHOT) {
    await page.evaluate(() => { const k = pid(patients[0]); const ta = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]'); ta.value = 'Ana 10.11.26 22:10 - Revisar herida\n  y retirar puntos alternos\n' + ta.value + '\nTexto viejo sin firma'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: SHOT, fullPage: false });
  }
  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-FIRMA-COLOR: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
