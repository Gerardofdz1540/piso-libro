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
    r.pegado = plStampNewLines('', ['1', '2', '3', '4', '5', '6', '7', '8'].map(x => 'renglón ' + x).join('\n'), st);
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
    && f1.pegado.split('\n').filter(l => l.startsWith('Gerardo')).length === 1 && f1.pegado.startsWith('Gerardo 10.11.26 23:50 - renglón 1')
    && f1.arriba === 'Gerardo 10.11.26 23:50 - nuevo arriba\nGerardo 09.11.26 08:00 - viejo' && f1.sinNombre === 'x'
    && f1.ahora === 'Gerardo 10.11.26 23:50 - ' && f1.autor && f1.autor.name === 'Gerardo' && f1.autorViejo && f1.autorViejo.name === 'GF' && f1.color, JSON.stringify(f1));

  // ── F2: escribir en Pendientes y soltar la caja → se guarda firmado y aparece la capa de color ──
  const f2 = await page.evaluate(async () => {
    const k = pid(patients[0]); focusGoTo(k);
    await new Promise(r => setTimeout(r, 400));
    const ta = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]');
    ta.focus(); ta.value = 'Cambiar apósitos'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur(); ta.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const ta2 = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]');
    const bd = ta2 && ta2.previousElementSibling;
    return { k, val: ta2 && ta2.value, nota: getNote(k).pendientes, bd: !!(bd && bd.classList.contains('pl-st-bd')), bdHtml: bd ? bd.innerHTML.slice(0, 300) : '', taRect: ta2 ? JSON.stringify(ta2.getBoundingClientRect()) : '', bdRect: bd ? JSON.stringify(bd.getBoundingClientRect()) : '' };
  });
  const hoy = new Date(); const z = n => String(n).padStart(2, '0');
  const fecha = z(hoy.getDate()) + '.' + z(hoy.getMonth() + 1) + '.' + String(hoy.getFullYear()).slice(2);
  check('F2 escribir «Cambiar apósitos» en Pendientes y soltar: la caja y la nota quedan «Gerardo ' + fecha + ' hh:mm - Cambiar apósitos» y aparece la capa de color alineada con la caja',
    new RegExp('^Gerardo ' + fecha.replace(/\./g, '\\.') + ' \\d{2}:\\d{2} - Cambiar apósitos$').test(f2.val || '') && f2.nota === f2.val && f2.bd && /background:rgba/.test(f2.bdHtml) && mismoRect(f2.taRect, f2.bdRect), JSON.stringify(f2));
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
  if (SHOT) {
    await page.evaluate(() => { const k = pid(patients[0]); const ta = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]'); ta.value = 'Ana 10.11.26 22:10 - Revisar herida\n  y retirar puntos alternos\n' + ta.value + '\nTexto viejo sin firma'; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.scrollIntoView({ block: 'center' }); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: SHOT, fullPage: false });
  }
  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-FIRMA-COLOR: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
