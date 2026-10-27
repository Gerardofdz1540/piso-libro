// 🩻 Estudios de imagen del RIS (26 oct 2026, revisión completa): el robot guarda la fecha como DD/MM/AAAA y la app la
// comparaba como texto (orden revuelto entre meses, la entrega omitía los estudios del día 1 al 20 y fechaba hoy las
// líneas automáticas); Realtime dejaba la copia vieja al cambiar de expediente y no borraba nada; enlaces javascript:
// se pintaban como vínculo. Pacientes ficticios.
//   node tests/headless/app_ris.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.prompt=function(){ return null; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const A = { id: 'pa', cama: '3-101', exp: '26-100', nombre: 'PATRICIA SOL VEGA', esp: 'CG', estado: 'ESTABLE', edad: '50', ingreso: '2026-09-20', dx: 'PANCREATITIS' };
const B = { id: 'pb', cama: '3-102', exp: '26-200', nombre: 'MARCOS LUNA RIOS', esp: 'CG', estado: 'ESTABLE', edad: '40', ingreso: '2026-10-20', dx: 'APENDICITIS' };
const z = n => String(n).padStart(2, '0');
const dmy = d => `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}`;
const now = new Date();
// Un día de las últimas 2 semanas con día del mes ≤ 19 (como texto «19/10/…» < «2026-…» y se perdía).
let recent = null; for (let i = 1; i <= 13 && !recent; i++) { const d = new Date(now.getTime() - i * 86400e3); if (d.getDate() <= 19) recent = d; }
const mid = new Date(now.getTime() - 24 * 86400e3);
const old = new Date(now.getTime() - 58 * 86400e3); old.setDate(28);
const OLDSC = new Date(now.getTime() - 10 * 86400e3).toISOString(), NEWSC = new Date(now.getTime() - 3600e3).toISOString();
const RIS = [
  { id: 1, exp: '26-100', patient_id: 'pa', paciente: 'SOL VEGA PATRICIA', fecha: dmy(mid), hora: '10:00:00', modalidad: 'RX', estudios: 'TORAX', reporte: 'CONCLUSION: SIN ALTERACIONES', reporte_estado: 'ok', scraped_at: OLDSC },
  { id: 3, exp: '26-100', patient_id: 'pa', paciente: 'SOL VEGA PATRICIA', fecha: dmy(recent), hora: '08:00:00', modalidad: 'US', estudios: 'HIGADO', reporte: 'CONCLUSION: VIA BILIAR DILATADA', reporte_estado: 'ok', reporte_url: 'https://ris.example/rep/3', scraped_at: NEWSC },
  { id: 4, exp: '26-100', patient_id: 'pa', paciente: 'SOL VEGA PATRICIA', fecha: dmy(old), hora: '08:00:00', modalidad: 'RX', estudios: 'ABDOMEN', reporte: 'CONCLUSION: ESTUDIO VIEJO', reporte_estado: 'ok', scraped_at: OLDSC },
  { id: 10, exp: '26-200', patient_id: null, paciente: 'LUNA RIOS MARCOS', fecha: dmy(recent), hora: '11:00:00', modalidad: 'US', estudios: 'APENDICE', reporte: 'CONCLUSION: APENDICITIS', reporte_estado: 'ok', reporte_url: 'javascript:alert(document.cookie)', imagen_url: ' JavaScript:void(0)', scraped_at: OLDSC },
];
const DMY_RECENT = dmy(recent);
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const notesW = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (s, o) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, [A, B]) : json(201, [{ id: 'n' }]);
    if (url.startsWith('/rest/v1/notes')) { if (m !== 'GET') notesW.push(req.postData() || ''); return m === 'GET' ? json(200, []) : json(201, [{}]); }
    if (url.startsWith('/rest/v1/ris_estudios')) return json(200, RIS);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2 && Object.keys(risByExp || {}).length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const r = await page.evaluate(({ RIS_ROWS }) => {
    const a = patients.find(p => p.cama === '3-101'), b = patients.find(p => p.cama === '3-102');
    const R = {};
    R.ids = risForPatient(a).map(x => x.id);
    R.when = Array.from(renderRisEstudios(a, pid(a)).matchAll(/class="ris-when">([^<]*)</g)).map(m => m[1]);
    R.eg = _egImagen(a, migrateNote(noteData[pid(a)] || defaultData()));
    R.entAntes = [a, b].map(x => toSafeString(getNote(pid(x)).entrega));
    const hb = renderRisEstudios(b, pid(b)); R.hrefsB = Array.from(hb.matchAll(/href="([^"]*)"/g)).map(m => m[1]);
    R.hrefsA = Array.from(renderRisEstudios(a, pid(a)).matchAll(/href="([^"]*)"/g)).map(m => m[1]);
    const nd = migrateNote(defaultData()); nd.imagenHistory = [{ fecha: '2026-10-20', estudios: [{ tipo: 'TC', descripcion: 'x', link: 'javascript:alert(1)' }, { tipo: 'RX', descripcion: 'y', link: 'https://pacs.example/1' }] }];
    activeImagenDate[pid(a)] = '2026-10-20';
    R.manual = Array.from(renderImagenField(nd, pid(a)).matchAll(/imagen-link-chip">([\s\S]*?)<button/g)).map(m => m[1]);
    // Realtime
    let toasts = 0; const t0 = window._showRTToast; window._showRTToast = function () { toasts++; };
    try { _showRTToast = window._showRTToast; } catch (_) {}
    const row3 = Object.assign({}, RIS_ROWS.find(x => x.id === 3));
    handleRisChange({ eventType: 'UPDATE', new: row3, old: { id: 3 } });
    R.toastSinCambio = toasts;
    handleRisChange({ eventType: 'UPDATE', new: Object.assign({}, RIS_ROWS.find(x => x.id === 10), { exp: '26-100', patient_id: 'pa', paciente: 'SOL VEGA PATRICIA' }), old: { id: 10 } });
    R.bTrasMover = risForPatient(b).map(x => x.id); R.aTrasMover = risForPatient(a).map(x => x.id);
    handleRisChange({ eventType: 'DELETE', new: {}, old: { id: 1 } });
    R.aTrasBorrar = risForPatient(a).map(x => x.id);
    handleRisChange({ eventType: 'INSERT', new: { id: 20, exp: '26-200', patient_id: 'pb', paciente: 'LUNA RIOS MARCOS', fecha: '25/10/2026', hora: '09:00', modalidad: 'TC', estudios: 'ABDOMEN', reporte: '' }, old: {} });
    R.bTrasInsert = risForPatient(b).map(x => x.id + '@' + x.fecha); R.toastInsert = toasts;
    R.entDespues = [a, b].map(x => toSafeString(getNote(pid(x)).entrega)); R.sinFn = typeof _entregaItemsFromRis === 'undefined';
    return R;
  }, { RIS_ROWS: RIS }).catch(e => ({ err: String(e) }));
  check('R1 tarjeta: el estudio más reciente arriba aunque cambie el mes, con la fecha como DD/MM/AAAA', JSON.stringify(r.ids) === '[3,1,4]' && r.when && /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(r.when[0]) && r.when[0].startsWith(DMY_RECENT), JSON.stringify(r));
  check('R2 entrega/proyector: incluye el estudio reciente (día ≤ 19) y deja fuera los de hace más de 2 semanas', r.eg && r.eg.length === 1 && /VIA BILIAR/.test(r.eg[0]) && r.eg[0].startsWith(DMY_RECENT.slice(0, 5)), JSON.stringify(r.eg));
  check('R3 Cronología: los estudios del RIS (al cargar y por Realtime: moverlo, borrarlo, uno nuevo) ya no se anotan solos en la caja (27 oct 2026)', r.sinFn && JSON.stringify(r.entAntes) === JSON.stringify(r.entDespues) && !/\(RIS\)/.test(r.entDespues.join('')), JSON.stringify({ antes: r.entAntes, despues: r.entDespues }));
  check('R4 enlaces: javascript: nunca se pinta como vínculo; https sí', r.hrefsB && r.hrefsB.length === 0 && JSON.stringify(r.hrefsA) === '["https://ris.example/rep/3"]', JSON.stringify([r.hrefsA, r.hrefsB]));
  check('R5 caja Imagen manual: enlace javascript: queda como texto, https como vínculo', r.manual && r.manual.length === 2 && !/<a /.test(r.manual[0]) && /href="https:\/\/pacs\.example\/1"/.test(r.manual[1]), JSON.stringify(r.manual));
  check('R6 Realtime: la pasada del robot sin cambios no avisa ni repinta', r.toastSinCambio === 0, JSON.stringify(r));
  check('R7 Realtime: el estudio que cambia de expediente sale del paciente anterior', r.bTrasMover && r.bTrasMover.length === 0 && r.aTrasMover.indexOf(10) >= 0, JSON.stringify(r));
  check('R8 Realtime: DELETE (new vacío, old solo con id) quita el estudio', r.aTrasBorrar && r.aTrasBorrar.indexOf(1) < 0 && r.aTrasBorrar.length === 3, JSON.stringify(r.aTrasBorrar));
  check('R9 Realtime: INSERT nuevo se normaliza la fecha y avisa una vez', JSON.stringify(r.bTrasInsert) === '["20@2026-10-25"]' && r.toastInsert === 1, JSON.stringify(r));
  // Revisión completa de errores (26 oct 2026): Esc lanzaba ReferenceError (closeNoteModal no existe) y en 📌 No olvidar
  // el círculo del recordatorio del paciente no hacía nada (comillas rotas) o marcaba otro (índice de pendientes).
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const no = await page.evaluate(() => {
    const a = patients.find(p => p.cama === '3-101'), k = pid(a);
    const nd = migrateNote(noteData[k] || defaultData()); nd.checklist = nd.checklist || {};
    nd.checklist._ptReminders = [{ text: 'YA HECHO', done: true }, { text: 'PENDIENTE UNO', done: false }];
    noteData[k] = nd;
    setView('noOlvidar', document.querySelector('.tab[onclick*="noOlvidar"]'));
    const b = Array.from(document.querySelectorAll('#view-noOlvidar button')).find(x => /togglePtReminder/.test(x.getAttribute('onclick') || ''));
    if (!b) return { err: 'sin botón' };
    b.click();
    const r = noteData[k].checklist._ptReminders;
    return { r0: r[0].done, r1: r[1].done };
  }).catch(e => ({ err: String(e) }));
  check('R10 Esc no lanza error y 📌 No olvidar marca el recordatorio correcto', no.r0 === true && no.r1 === true && !errors.some(e => /closeNoteModal|Unexpected end/.test(e)), JSON.stringify([no, errors.slice(0, 2)]));
  // ── R11: «🚫 No es de este paciente» (hallazgo 75): oculta el estudio en esta tarjeta (y en la Entrega), no lo borra, se
  //        guarda en la nota (viaja a todos los iPads) y «Mostrar ocultos» / «Sí es de este paciente» lo regresan ──
  const n0 = notesW.length;
  const o = await page.evaluate(async () => {
    const a = patients.find(p => p.cama === '3-101'); const k = pid(a);
    _rerenderCard(k);
    const card = () => document.getElementById('card-' + k);
    const ids0 = risForPatient(a).map(x => x.id);
    const btn = card().querySelector('[data-testid="ris-ocultar"][data-rid="3"]');
    if (!btn) return { err: 'sin botón ocultar' };
    btn.click(); await new Promise(r => setTimeout(r, 1800));   // deja subir el cambio antes de regresarlo
    const ids1 = risForPatient(a).map(x => x.id), conOcultos = risForPatient(a, true).map(x => x.id);
    const eg = _egImagen(a, migrateNote(noteData[k] || defaultData())).join(' ');
    const ver = card().querySelector('[data-testid="ris-ver-ocultos"]'); const verTxt = ver ? ver.textContent : '';
    ver.click(); await new Promise(r => setTimeout(r, 100));
    const dim = card().querySelectorAll('.ris-item[data-oculto="1"]').length;
    card().querySelector('[data-testid="ris-mostrar"][data-rid="3"]').click(); await new Promise(r => setTimeout(r, 200));
    return { ids0, ids1, conOcultos, eg, verTxt, dim, ids2: risForPatient(a).map(x => x.id), lista: noteData[k].checklist.ris_ocultos, undo: _undoCount(k) };
  }).catch(e => ({ err: String(e) }));
  await page.waitForTimeout(1500);
  const subidas = notesW.slice(n0).map(b => { try { const x = JSON.parse(b); return JSON.stringify((Array.isArray(x) ? x[0] : x).checklist && (Array.isArray(x) ? x[0] : x).checklist.ris_ocultos); } catch (_) { return ''; } });
  check('R11 «🚫 No es de este paciente»: el estudio sale de la tarjeta y de la Entrega pero no se borra (risForPatient con ocultos lo trae); «👁 Mostrar ocultos (1)» lo enseña atenuado; «↩ Sí es de este paciente» lo regresa; la lista viaja en la nota; queda un paso en Regresar',
    !o.err && o.ids0.includes(3) && !o.ids1.includes(3) && o.conOcultos.includes(3) && !/VIA BILIAR/.test(o.eg) && /Mostrar ocultos \(1\)/.test(o.verTxt) && o.dim === 1
    && o.ids2.includes(3) && Array.isArray(o.lista) && o.lista.length === 0 && o.undo >= 2 && subidas.some(x => x === '["3"]') && subidas.some(x => x === '[]'), JSON.stringify({ o, subidas }));

  check('final: sin errores de JavaScript en la página', errors.length === 0 && !r.err, JSON.stringify([r.err, errors.slice(0, 3)]));
  console.log('RESULT APP-RIS: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
