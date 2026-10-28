// 🚪 Egresos sin motivo: aviso discreto (28 oct 2026, pedido de Gera). Pacientes ficticios.
// · Una tarjeta pequeña abajo a la izquierda pregunta el motivo de los egresos de los últimos 7 días que nadie clasificó
//   («3-160 · NOMBRE ya no aparece en el censo. ¿Cuál fue el motivo del egreso?») con un menú; chip 🚪 N en la barra.
// · No cuenta copias técnicas, egresos con motivo ni a quien volvió al censo; la misma persona con dos copias se pregunta
//   una vez y se guarda en las dos.
// · No estorba: se esconde mientras se escribe; «Después» la pospone; «✕» la cierra hasta recargar; el chip la reabre.
// · Defunción pide confirmar; si la red falla no se pierde; 🚪 Alta y la Papelera tienen los mismos motivos nuevos.
// node tests/headless/app_egresos.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.__confirms = [];
  window.prompt=function(){ return null; }; window.alert=function(){}; window.confirm=function(m){ window.__confirms.push(String(m)); return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const DAY = 86400e3; const NOW = Date.now();
const PTS = [
  { id: 'g1', cama: '3-150', exp: '26-90001', nombre: 'ANA DIAZ RIOS', esp: 'CG', edad: '40', seccion: 'PISO' },
  { id: 'g2', cama: '3-151', exp: '26-90002', nombre: 'TERESA VEGA MAR', esp: 'CG', edad: '61', seccion: 'PISO' },
];
const ARCH = [
  { id: 'a1', archived_at: new Date(NOW - 1 * DAY).toISOString(), nombre: 'LUIS MORA PENA', cama: '3-160', exp: '26-90010', estado: 'ESTABLE', tipo: null, etiqueta: 'RETIRADO DEL CENSO (hoja)' },
  { id: 'a2', archived_at: new Date(NOW - 1 * DAY - 3600e3).toISOString(), nombre: 'LUIS MORA PENA', cama: '3-160', exp: '26-90010', estado: 'ESTABLE', tipo: null, etiqueta: 'CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)' },
  { id: 'a3', archived_at: new Date(NOW - 2 * DAY).toISOString(), nombre: 'EVA SOLIS CANO', cama: '3-161', exp: '26-90011', estado: 'ESTABLE', tipo: 'alta', etiqueta: 'EGRESO' },
  { id: 'a4', archived_at: new Date(NOW - 2 * DAY).toISOString(), nombre: 'ROSA PEREZ LUNA', cama: '3-162', exp: '26-90012', estado: '', tipo: null, etiqueta: 'DUPLICADO (misma persona en dos camas)' },
  { id: 'a5', archived_at: new Date(NOW - 3 * DAY).toISOString(), nombre: 'ANA DIAZ RIOS', cama: '3-150', exp: '26-90001', estado: '', tipo: null, etiqueta: 'RETIRADO DEL CENSO (hoja)' },
  { id: 'a6', archived_at: new Date(NOW - 3 * DAY).toISOString(), nombre: 'IVAN ROJO LARA', cama: '2-061', exp: '26-90013', estado: 'DELICADO', tipo: null, etiqueta: 'RETIRADO DEL CENSO (hoja)' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const archQ = [], rpc = []; let rpcFalla = false;
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/, '')); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, PTS) : json(200, [{}]);
    if (url.startsWith('/rest/v1/rpc/archive_set_egreso')) {
      if (rpcFalla) return json(503, { message: 'down' });
      const b = JSON.parse(req.postData() || '{}'); rpc.push(b);
      ARCH.forEach(a => { if (a.id === b.p_id) a.tipo = b.p_tipo || null; });
      return json(200, 'ok');
    }
    if (url.startsWith('/rest/v1/archive') && m === 'GET') {
      archQ.push(url);
      if (/nombre:patient_data->>nombre/.test(url)) return json(200, ARCH.map(a => Object.assign({}, a)));
      return json(200, []);
    }
    if (url.startsWith('/rest/v1/notes') && m === 'POST') return json(201, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 700) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  const vis = () => page.evaluate(() => { const c = document.getElementById('egreso-card'); return !!(c && c.classList.contains('show')); });
  const estado = () => page.evaluate(() => {
    const c = document.getElementById('egreso-card'); const chip = document.querySelector('#board-nav [data-testid="egreso-chip"]');
    const r = c ? c.getBoundingClientRect() : null;
    return { show: !!(c && c.classList.contains('show')), txt: c ? c.textContent.replace(/\s+/g, ' ') : '', chip: chip ? chip.textContent.trim() : '', izq: r ? Math.round(r.left) : -1, abajo: r ? Math.round(innerHeight - r.bottom) : -1 };
  });
  const elegir = async (texto) => {
    // El menú sustituye al <select> en el siguiente cuadro (requestAnimationFrame): se espera a su botón.
    await page.waitForFunction((id) => { const s = document.querySelector('[data-testid="' + id + '"]'); if (s && !s.__trig && window.residSyncSelects) window.residSyncSelects(); return !!(s && s.__trig && s.__trig.isConnected); }, 'egreso-card-select', { timeout: 15000 });
    await page.evaluate(() => { const sel = document.querySelector('[data-testid="egreso-card-select"]'); sel.__trig.click(); });
    await page.waitForSelector('.resid-sheet-backdrop.rs-open .resid-sheet-row');
    await page.evaluate((t) => { const r = Array.from(document.querySelectorAll('.resid-sheet-backdrop.rs-open .resid-sheet-row')).find(x => x.querySelector('.rs-tx').textContent.trim().indexOf(t) === 0); r.click(); }, texto);
    await page.waitForTimeout(700);
  };

  // La primera revisión va sola a los 6 s del arranque (no compite con la carga).
  await page.waitForFunction(() => { const c = document.getElementById('egreso-card'); return c && c.classList.contains('show'); }, null, { timeout: 20000 });
  let e = await estado();
  check('E1 a los segundos de abrir aparece la tarjeta abajo a la izquierda con la cama, el nombre y la pregunta; 2 pendientes (chip 🚪 2)',
    /3-160 · LUIS MORA PENA ya no aparece en el censo/.test(e.txt) && /¿Cuál fue el motivo del egreso\?/.test(e.txt) && /1 de 2/.test(e.txt) && e.chip === '🚪 2' && e.izq >= 0 && e.izq <= 20 && e.abajo >= 0 && e.abajo <= 40, JSON.stringify(e));
  const q = archQ.find(u => /nombre:patient_data/.test(u)) || '';
  check('E2 la consulta trae solo nombre, cama, expediente y motivo de los últimos 7 días (no la nota completa); no cuenta el que tiene motivo, la copia técnica ni a quien volvió al censo',
    /archived_at=gte\./.test(q) && /tipo:note_data->>_egreso_tipo/.test(q) && !/select=\*/.test(q) && !/[,=]note_data(,|&|$)/.test(q) && !/EVA SOLIS|ROSA PEREZ|ANA DIAZ/.test(e.txt), q);
  const opts = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="egreso-card-select"] option')).map(o => o.textContent));
  check('E3 el menú trae alta, defunción, cambio de servicio, contrarreferencia, traslado, alta voluntaria, fuga, otro y «no fue egreso»',
    opts.join('|') === '— elegir —|Alta a domicilio|Defunción|Cambio de servicio|Contrarreferencia|Traslado a otro hospital|Alta voluntaria|Fuga / abandono|Otro motivo|No fue egreso (error del censo)', opts.join('|'));
  // No estorba: al escribir se esconde y regresa al terminar.
  await page.evaluate(() => { const ta = document.querySelector('textarea[data-field="pendientes"]'); ta.focus(); });
  await page.waitForTimeout(200);
  const escribiendo = await vis();
  await page.evaluate(() => { document.activeElement.blur(); });
  await page.waitForTimeout(1200);
  check('E4 mientras se escribe en una caja la tarjeta se esconde; al terminar regresa', escribiendo === false && await vis() === true, String(escribiendo));
  // Elegir el motivo
  await elegir('Cambio de servicio');
  e = await estado();
  await page.waitForTimeout(900);   // el buscador del menú se enfoca 320 ms después de abrirlo
  e = await estado();
  check('E5 al elegir «Cambio de servicio» se guarda en las DOS copias de la misma persona (con quién) y pasa al siguiente, a la vista; chip 🚪 1',
    e.show && rpc.length === 2 && rpc.every(b => b.p_tipo === 'cambio_servicio' && b.p_por === 'Tester') && rpc.map(b => b.p_id).sort().join() === 'a1,a2' && /2-061 · IVAN ROJO LARA/.test(e.txt) && !/1 de/.test(e.txt) && e.chip === '🚪 1', JSON.stringify({ rpc, e }));
  // Después: se pospone en este dispositivo; el chip la vuelve a abrir.
  await page.click('[data-testid="egreso-despues"]');
  await page.waitForTimeout(300);
  const tras = await estado();
  const snooze = await page.evaluate(() => JSON.parse(localStorage.getItem('pl_egreso_snooze') || '{}'));
  await page.evaluate(() => _egresosRevisar()); await page.waitForTimeout(500);
  const sigueOculta = !(await vis());
  await page.click('[data-testid="egreso-chip"]'); await page.waitForTimeout(300);
  check('E6 «Después» la esconde (se pospone 3 h aunque se vuelva a revisar) y el chip 🚪 1 la vuelve a abrir', !tras.show && tras.chip === '🚪 1' && Object.keys(snooze).length === 1 && sigueOculta && await vis(), JSON.stringify({ tras, snooze, sigueOculta }));
  // Un campo enfocado que desaparece sin soltar el foco (tarjeta repintada; Safari no avisa): la tarjeta regresa sola.
  await page.evaluate(() => { const ta = document.createElement('textarea'); ta.id = '__tmp_ta'; document.body.appendChild(ta); ta.focus(); });
  await page.waitForTimeout(300);
  const tapada = !(await vis());
  await page.evaluate(() => { const ta = document.getElementById('__tmp_ta'); ta.remove(); });
  await page.waitForTimeout(2500);
  check('E6b si el campo donde se escribía se quita sin soltar el foco, la tarjeta vuelve sola', tapada && await vis(), String(tapada));
  // ✕: cerrada hasta recargar
  await page.click('#egreso-card .eg-x'); await page.waitForTimeout(200);
  await page.evaluate(() => _egresosRevisar()); await page.waitForTimeout(500);
  const cerrada = !(await vis());
  await page.click('[data-testid="egreso-chip"]'); await page.waitForTimeout(300);
  check('E7 «✕» la cierra por esta sesión (aunque se revise otra vez) y el chip la reabre', cerrada && await vis(), String(cerrada));
  // Sin red: no se pierde
  rpcFalla = true;
  await elegir('Contrarreferencia');
  e = await estado(); rpcFalla = false;
  const selVal = await page.evaluate(() => document.querySelector('[data-testid="egreso-card-select"]').value);
  check('E8 si la red falla no se pierde: la tarjeta sigue en el mismo paciente y el menú regresa a «— elegir —»', /IVAN ROJO LARA/.test(e.txt) && e.chip === '🚪 1' && selVal === '', JSON.stringify({ e, selVal }));
  // Defunción pide confirmar
  const n0 = rpc.length;
  await elegir('Defunción');
  e = await estado();
  check('E9 «Defunción» pide confirmar y se guarda; sin pendientes ya no hay tarjeta ni chip',
    window_confirm_ok(await page.evaluate(() => window.__confirms.slice(-1)[0] || '')) && rpc.length === n0 + 1 && rpc[rpc.length - 1].p_id === 'a6' && rpc[rpc.length - 1].p_tipo === 'defuncion' && !e.show && e.chip === '', JSON.stringify({ e, last: rpc[rpc.length - 1] }));
  function window_confirm_ok(m) { return /DEFUNCIÓN de IVAN ROJO LARA/.test(m); }
  // 🚪 Alta y Papelera: los mismos motivos
  const alta = await page.evaluate(() => { openConfirm(pid(patients[0])); const o = Array.from(document.querySelectorAll('#confirm-egreso-tipo option')).map(x => x.value); document.getElementById('confirm-modal').style.display = 'none'; return o; });
  const pap = await page.evaluate(() => { archivados = [{ nombre: 'PRUEBA FICTICIA', cama: '3-170', _supaArchiveId: 'zz', _archivedAt: new Date().toISOString(), _note: { _egreso: 'RETIRADO DEL CENSO (hoja)' } }]; renderPapelera(); return Array.from(document.querySelectorAll('[data-testid="egreso-tipo-0"] option')).map(x => x.value); });
  check('E10 🚪 Alta y la Papelera ofrecen los mismos motivos nuevos', alta.join() === ',alta,defuncion,cambio_servicio,contrarreferencia,traslado,alta_voluntaria,fuga,otro,no_egreso' && pap.join() === alta.join(), JSON.stringify({ alta, pap }));

  check('sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
