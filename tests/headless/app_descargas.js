// 📉 Descargas por diferencia (2 nov 2026): Supabase avisó que el proyecto pasaba la transferencia del plan; cada recarga
// bajaba completas las filas de WinLab (≈8 MB), notas e imagen. Ahora la app pide la lista id + updated_at y solo baja lo
// nuevo o cambiado. Esta suite usa un servidor falso que se porta como PostgREST (respeta select, in., gte/lt, order,
// limit) y comprueba, en cada escenario, que la respuesta armada con la copia local es IDÉNTICA (mismas filas, orden y
// columnas) a la consulta completa de siempre. Pacientes y expedientes ficticios.
//   node tests/headless/app_descargas.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.__alerts=[]; window.prompt=function(){ return null; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;

// ── Datos ficticios ─────────────────────────────────────────────────────────────────────────────────────────────────
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
let verN = 0;
const ver = () => new Date(now - 3600e3 + (++verN) * 1000).toISOString().replace('Z', '+00:00');   // como PostgREST
const PTS = [
  { id: 'a1111111-1111-4111-8111-111111111111', cama: '3-101', exp: '26-90101', nombre: 'ANA PRUEBA UNO', esp: 'CG', estado: 'ESTABLE', edad: '50', ingreso: '2026-10-20', dx: 'COLECISTITIS' },
  { id: 'b2222222-2222-4222-8222-222222222222', cama: '3-102', exp: '26-90102', nombre: 'BETO PRUEBA DOS', esp: 'CG', estado: 'ESTABLE', edad: '40', ingreso: '2026-10-25', dx: 'APENDICITIS' },
  { id: 'c3333333-3333-4333-8333-333333333333', cama: '3-103', exp: '26-90103', nombre: 'CARLA PRUEBA TRES', esp: 'CG', estado: 'ESTABLE', edad: '61', ingreso: '2026-09-01', dx: 'HERNIA' },
];
const rep = (hb) => ({ reportes: [{ estudio: 'BIOMETRIA HEMATICA', fecha: '', resultados: [{ nombre: 'HEMOGLOBINA', valor: String(hb), unidad: 'g/dL' }] }] });
const dia = (n) => new Date(now - n * 86400e3).toISOString().slice(0, 10);
const DB = {
  winlab_labs: [
    { id: 501, exp: '26-90101', paciente: 'PRUEBA UNO ANA', fecha: dia(0), scraped_at: iso(2 * 3600e3), data: rep(12.1), updated_at: ver() },
    { id: 502, exp: '26-90101', paciente: 'PRUEBA UNO ANA', fecha: dia(1), scraped_at: iso(26 * 3600e3), data: rep(11.4), updated_at: ver() },
    { id: 503, exp: '26-90102', paciente: 'PRUEBA DOS BETO', fecha: dia(0), scraped_at: iso(3 * 3600e3), data: rep(14.0), updated_at: ver() },
    { id: 504, exp: '26-90103', paciente: 'PRUEBA TRES CARLA', fecha: dia(9), scraped_at: iso(9 * 86400e3), data: rep(9.8), updated_at: ver() },
  ],
  notes: PTS.map((p, i) => ({ patient_id: p.id, app: 'APP ' + i, pa: '', drenajes: '', qx: '', manejo: 'MANEJO ' + i, sangrado: '', sv: '', balance: '',
    pendientes: 'PEND ' + i, checklist: {}, lab_history: [], imagen_history: [], updated_at: ver(), cronologia: 'NO SE PIDE' })),
  ris_estudios: [
    { id: 71, exp: '26-90101', patient_id: PTS[0].id, paciente: 'PRUEBA UNO ANA', fecha: '01/11/2026', hora: '08:00:00', sede: 'HGL', estudios: 'USG HIGADO', modalidad: 'US', procedencia: 'HOSP', critico: false, reporte: 'SIN ALTERACIONES', reporte_url: null, imagen_url: null, reporte_estado: 'ok', reporte_motivo: null, scraped_at: iso(3600e3), links: [], updated_at: ver() },
    { id: 72, exp: '26-90102', patient_id: PTS[1].id, paciente: 'PRUEBA DOS BETO', fecha: '02/11/2026', hora: '09:30:00', sede: 'HGL', estudios: 'TC ABDOMEN', modalidad: 'TC', procedencia: 'HOSP', critico: false, reporte: '', reporte_url: null, imagen_url: null, reporte_estado: 'pendiente_ris', reporte_motivo: null, scraped_at: iso(3600e3), links: [], updated_at: ver() },
  ],
};
// Tabla grande solo para el camino «copia vacía» (más de 100 filas que faltan → una consulta completa con versión).
DB.fake_big = Array.from({ length: 130 }, (_, i) => ({ id: 900000 + i, exp: '26-90101', paciente: 'X', fecha: dia(0), scraped_at: iso(i * 60e3), data: { n: i }, updated_at: ver() }));

// ── PostgREST mínimo ───────────────────────────────────────────────────────────────────────────────────────────────
let MODO = 'normal';   // 'normal' | 'sin_select' (ignora select, como los mocks viejos) | 'sin_columna' (400 si piden updated_at) | 'pierde' (el lote por id no devuelve una fila)
function pgrest(table, url) {
  const u = new URL('http://x' + url);
  let out = (DB[table] || []).slice();
  const sel = u.searchParams.get('select');
  if (MODO === 'sin_columna' && (table === 'winlab_labs' || table === 'ris_estudios') && sel && /(^|,)updated_at(,|$)/.test(sel)) return { status: 400, body: { message: 'column winlab_labs.updated_at does not exist' } };
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    const m = /^(eq|gte|lt|in)\.(.*)$/s.exec(v); if (!m) continue;
    if (m[1] === 'in') { const set = new Set(m[2].replace(/^\(|\)$/g, '').split(',')); out = out.filter(r => set.has(String(r[k]))); }
    else if (m[1] === 'eq') out = out.filter(r => String(r[k]) === m[2]);
    else if (m[1] === 'gte') out = out.filter(r => String(r[k]) >= m[2]);
    else if (m[1] === 'lt') out = out.filter(r => String(r[k]) < m[2]);
  }
  if (MODO === 'pierde' && /(^|&)id=in\./.test(u.search.slice(1))) out = out.filter(r => r.id !== 501);
  const ord = u.searchParams.get('order');
  if (ord) {
    const keys = ord.split(',').map(s => s.split('.'));
    out.sort((a, b) => { for (const [c, d] of keys) { const x = String(a[c] == null ? '' : a[c]), y = String(b[c] == null ? '' : b[c]); if (x !== y) return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1); } return 0; });
  }
  const lim = u.searchParams.get('limit'); if (lim) out = out.slice(0, +lim);
  if (sel && MODO !== 'sin_select') { const cols = sel.split(','); out = out.map(r => { const o = {}; cols.forEach(c => { if (c in r) o[c] = r[c]; }); return o; }); }
  return { status: 200, body: JSON.parse(JSON.stringify(out)) };
}

(async () => {
  const browser = await launch(); const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  let cortarListas = false;
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (s, o) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
    calls.push({ m, url: decodeURIComponent(url) });
    const table = url.replace(/^\/rest\/v1\//, '').split('?')[0];
    if (cortarListas && m === 'GET' && /select=(id|patient_id)(%2C|,)updated_at(&|$)/.test(url)) return route.abort('internetdisconnected');
    if (table === 'patients') return m === 'GET' ? json(200, PTS) : json(201, [{ id: 'n' }]);
    if (table === 'notes' && m !== 'GET') {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (_) {}
      const rows = Array.isArray(body) ? body : [body];
      const out = rows.map(b => { const n = DB.notes.find(x => x.patient_id === b.patient_id); if (n) { Object.assign(n, b, { updated_at: ver() }); return n; } return b; });
      return json(201, out);
    }
    if (m === 'GET' && DB[table]) { const r = pgrest(table, url); return json(r.status, r.body); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const gets = (re) => calls.filter(c => c.m === 'GET' && re.test(c.url));
  // Las 4 consultas de la app, tal como las arma supaLoadAll / _winlabFetchForPatients / _loadRisEstudios.
  const EQ = async () => page.evaluate(async (PT) => {
    const ids = l => 'id=in.(' + l.map(encodeURIComponent).join(',') + ')';
    const cfgs = {
      notas: { st: 'nt', tabla: 'notes', id: 'patient_id', ver: 'updated_at', cols: NOTES_SELECT_COLS, q: s => 'patient_id=in.(' + PT.map(r => r.id).join(',') + ')&select=' + s + '&order=updated_at.desc&limit=500', ids: l => 'patient_id=in.(' + l.map(encodeURIComponent).join(',') + ')' },
      wl4d: { st: 'wl', tabla: 'winlab_labs', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => _winlabRowsQuery(PT, s), ids },
      wlSinVentana: { st: 'wl', tabla: 'winlab_labs', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => 'select=' + s + '&order=scraped_at.desc&limit=200&exp=in.(26-90101,26-90102,26-90103)', ids },
      ris: { st: 'ris', tabla: 'ris_estudios', id: 'id', ver: 'updated_at', cols: RIS_SELECT, q: s => 'select=' + s + '&order=fecha.desc,hora.desc&limit=800&exp=in.(26-90101,26-90102,26-90103)', ids },
    };
    const R = {};
    for (const k of Object.keys(cfgs)) {
      const a = await _dcConsulta(cfgs[k]); const b = await _sGet(cfgs[k].tabla, cfgs[k].q(cfgs[k].cols));
      R[k] = JSON.stringify(a) === JSON.stringify(b) ? 'igual' : ('DISTINTO ' + JSON.stringify(a).slice(0, 160) + ' VS ' + JSON.stringify(b).slice(0, 160));
    }
    return R;
  }, PTS);
  const todasIguales = (r) => Object.values(r).every(v => v === 'igual');

  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3 && Object.keys(risByExp || {}).length === 2 && _winlabLoadedOnce, null, { timeout: 30000 });
  await page.waitForTimeout(2500);   // que termine el sync de labs (sube notas) y el respaldo de fechas viejas

  // D1 · Arranque: la app ve exactamente lo de siempre (WinLab 4 días + fila vieja del paciente sin labs, imagen).
  const d1 = await page.evaluate(() => ({
    wl: Object.keys(winlabRowsByExp).sort().map(e => e + ':' + winlabRowsByExp[e].map(r => r.fecha).join('|')),
    sinId: Object.values(winlabRowsByExp).every(l => l.every(r => !('id' in r) && !('updated_at' in r))),
    ris: Object.keys(risByExp).sort().map(e => e + ':' + risByExp[e].map(r => r.id).join('|')),
    risSinVer: Object.values(risByExp).every(l => l.every(r => !('updated_at' in r))),
    stats: Object.assign({}, window.__plDc.stats),
  }));
  const wlEsperado = ['26-90101:' + dia(1) + '|' + dia(0), '26-90102:' + dia(0), '26-90103:' + dia(9)];
  check('D1 WinLab en memoria igual que la consulta completa (4 días + fila vieja de quien no tiene labs)',
    JSON.stringify(d1.wl) === JSON.stringify(wlEsperado), JSON.stringify(d1.wl));
  check('D1 filas sin columnas extra (id/updated_at no se cuelan en lo que ve la app)', d1.sinId && d1.risSinVer);
  check('D1 imagen completa', JSON.stringify(d1.ris) === JSON.stringify(['26-90101:71', '26-90102:72']), JSON.stringify(d1.ris));
  check('D1 se pidieron listas de versiones (id,updated_at) de las tres tablas',
    gets(/winlab_labs\?select=id,updated_at/).length >= 1 && gets(/ris_estudios\?select=id,updated_at/).length >= 1 && gets(/notes\?patient_id=in\..*select=patient_id,updated_at/).length >= 1, JSON.stringify(calls.slice(0, 12).map(c => c.url.slice(0, 90))));

  // D2 · Equivalencia exacta de las 4 consultas contra la completa.
  let eq = await EQ();
  check('D2 lo armado con la copia local es idéntico a la consulta completa (notas, WinLab 4 días, WinLab sin ventana, imagen)', todasIguales(eq), JSON.stringify(eq));

  // D3 · Recarga sin cambios: solo listas; ninguna fila con datos viaja.
  let n0 = calls.length;
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); });
  let d3 = calls.slice(n0).filter(c => c.m === 'GET');
  const conDatos = d3.filter(c => /winlab_labs\?.*select=[^&]*data|ris_estudios\?.*select=[^&]*reporte|notes\?.*select=[^&]*checklist/.test(c.url));
  check('D3 recarga sin cambios: cero filas con datos de WinLab, notas o imagen', conDatos.length === 0, JSON.stringify(conDatos.map(c => c.url.slice(0, 120))));
  check('D3 la recarga sí consultó las listas', d3.some(c => /winlab_labs\?select=id,updated_at/.test(c.url)) && d3.some(c => /ris_estudios\?select=id,updated_at/.test(c.url)));

  // D4 · El robot cambia UNA fila de WinLab (versión nueva) → se baja solo esa y la app ve el valor nuevo.
  const r501 = DB.winlab_labs.find(r => r.id === 501); r501.data = rep(7.2); r501.updated_at = ver();
  n0 = calls.length;
  await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); });
  const d4 = calls.slice(n0).filter(c => c.m === 'GET' && /winlab_labs\?/.test(c.url) && /select=[^&]*data/.test(c.url));
  const hb4 = await page.evaluate(() => JSON.stringify((winlabRowsByExp['26-90101'] || []).map(x => x.data.reportes[0].resultados[0].valor)));
  check('D4 fila cambiada: se pide solo id=in.(501)', d4.length === 1 && /id=in\.\(501\)/.test(d4[0].url), JSON.stringify(d4.map(c => c.url.slice(0, 140))));
  check('D4 la app ve el dato nuevo (7.2) y conserva el de ayer (11.4)', /7\.2/.test(hb4) && /11\.4/.test(hb4) && !/12\.1/.test(hb4), hb4);

  // D5 · Fila nueva del robot + fila borrada → la lista manda; resultado igual a la completa.
  DB.winlab_labs.push({ id: 505, exp: '26-90102', paciente: 'PRUEBA DOS BETO', fecha: dia(1), scraped_at: iso(20 * 3600e3), data: rep(13.3), updated_at: ver() });
  DB.ris_estudios = DB.ris_estudios.filter(r => r.id !== 72);
  eq = await EQ();
  check('D5 fila nueva y fila borrada: idéntico a la consulta completa', todasIguales(eq), JSON.stringify(eq));

  // D6 · Nota cambiada en otro equipo (updated_at nuevo) → se baja solo esa nota y llega el texto nuevo.
  const nB = DB.notes.find(n => n.patient_id === PTS[1].id); nB.pendientes = 'PEND CAMBIADO EN OTRO EQUIPO'; nB.updated_at = ver();
  n0 = calls.length;
  const d6 = await page.evaluate(async () => { const l = await supaLoadAll(); _applyLoadedNotes(l.notes); const p = patients.find(x => x.cama === '3-102'); return getNote(pid(p)).pendientes; });
  const notasDatos = calls.slice(n0).filter(c => c.m === 'GET' && /notes\?/.test(c.url) && /select=[^&]*checklist/.test(c.url));
  check('D6 nota cambiada: solo esa nota viaja', notasDatos.length === 1 && notasDatos[0].url.includes(PTS[1].id) && !notasDatos[0].url.includes(PTS[0].id), JSON.stringify(notasDatos.map(c => c.url.slice(0, 160))));
  check('D6 la tarjeta tiene el texto nuevo', d6 === 'PEND CAMBIADO EN OTRO EQUIPO', d6);

  // D7 · Lo que la app haga con las filas no altera la copia local.
  const d7 = await page.evaluate(async () => {
    const cfg = { st: 'wl', tabla: 'winlab_labs', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => _winlabRowsQuery(patients.map(p => ({ exp: p.exp })), s), ids: l => 'id=in.(' + l.join(',') + ')' };
    const a = await _dcConsulta(cfg); a.forEach(r => { r.data = { roto: true }; r.exp = 'X'; });
    const b = await _dcConsulta(cfg); return b.every(r => r.exp !== 'X' && !r.data.roto);
  });
  check('D7 modificar las filas devueltas no ensucia la copia', d7);

  // D8 · Persistencia: abrir la app de nuevo (otra carga de página) usa la copia de IndexedDB: no viaja ninguna fila.
  n0 = calls.length;
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3 && _winlabLoadedOnce && Object.keys(risByExp || {}).length >= 1, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const d8 = calls.slice(n0).filter(c => c.m === 'GET' && /winlab_labs\?.*select=[^&]*data|ris_estudios\?.*select=[^&]*reporte/.test(c.url) && !/scraped_at=lt\./.test(c.url));
  const d8b = await page.evaluate(() => ({ s: Object.assign({}, window.__plDc.stats), n: Object.keys(winlabRowsByExp).length }));
  check('D8 al volver a abrir la app, WinLab e imagen salen de IndexedDB (cero filas con datos)', d8.length === 0 && d8b.s.cache > 0 && d8b.n === 3, JSON.stringify({ d8: d8.map(c => c.url.slice(0, 120)), s: d8b }));
  eq = await EQ();
  check('D8 y sigue idéntico a la consulta completa', todasIguales(eq), JSON.stringify(eq));

  // D9 · Red de seguridad de 20 h: una copia vieja se vuelve a bajar aunque la versión coincida.
  n0 = calls.length;
  await page.evaluate(async () => { const m = await _dcTabla('ris'); m.forEach(c => { c.t = Date.now() - 21 * 3600000; }); await _loadRisEstudios(patients); });
  const d9 = calls.slice(n0).filter(c => c.m === 'GET' && /ris_estudios\?id=in\.\(71\)/.test(c.url));
  check('D9 fila guardada hace más de 20 h: se vuelve a bajar', d9.length === 1, JSON.stringify(calls.slice(n0).map(c => c.url.slice(0, 100))));

  // D10 · Servidor que ignora select (mocks viejos) → consulta completa de siempre, mismo resultado.
  MODO = 'sin_select';
  const d10 = await page.evaluate(async () => { const c0 = window.__plDc.stats.completas; await _loadRisEstudios(patients); return { comp: window.__plDc.stats.completas - c0, ids: Object.keys(risByExp).map(e => risByExp[e].map(r => r.id).join('|')) }; });
  check('D10 lista con columnas de más → consulta completa (y la imagen sigue bien)', d10.comp === 1 && JSON.stringify(d10.ids) === '["71"]', JSON.stringify(d10));
  // D11 · Base sin la columna updated_at (400) → consulta completa, sin error.
  MODO = 'sin_columna';
  const d11 = await page.evaluate(async () => { const c0 = window.__plDc.stats.completas; let err = null; try { await _loadRisEstudios(patients); } catch (e) { err = String(e); } return { comp: window.__plDc.stats.completas - c0, err, ids: Object.keys(risByExp) }; });
  check('D11 base sin columna de versión (HTTP 400) → consulta completa, sin error', d11.comp === 1 && !d11.err && d11.ids.length === 1, JSON.stringify(d11));
  // D12 · Una fila pedida por id no llega (borrada entre las dos consultas) → consulta completa, nunca respuesta a medias.
  MODO = 'pierde';
  r501.updated_at = ver();
  const d12 = await page.evaluate(async () => { const c0 = window.__plDc.stats.completas; const r = await _dcConsulta({ st: 'wl', tabla: 'winlab_labs', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => _winlabRowsQuery(patients.map(p => ({ exp: p.exp })), s), ids: l => 'id=in.(' + l.join(',') + ')' }); return { comp: window.__plDc.stats.completas - c0, n: r.length }; });
  check('D12 fila que no llega en el lote → consulta completa', d12.comp === 1 && d12.n === 4, JSON.stringify(d12));
  MODO = 'normal';

  // D13 · Sin red: el error se propaga igual que antes (supaLoadAll conserva lo que había en memoria).
  cortarListas = true;
  const d13 = await page.evaluate(async () => {
    let err = null; try { await _dcConsulta({ st: 'ris', tabla: 'ris_estudios', id: 'id', ver: 'updated_at', cols: RIS_SELECT, q: s => 'select=' + s + '&limit=800', ids: l => 'id=in.(' + l.join(',') + ')' }); } catch (e) { err = e; }
    const antes = Object.keys(winlabRowsByExp).length; const l = await supaLoadAll(); return { red: !!err && isLikelyNetworkError(err), wlConservado: Object.keys(winlabRowsByExp).length === antes && antes > 0, carga: !!l };
  });
  cortarListas = false;
  check('D13 sin red: error de red (no se inventa respuesta) y WinLab en memoria se conserva', d13.red && d13.wlConservado, JSON.stringify(d13));

  // D14 · Copia vacía con muchas filas → UNA consulta completa con versión (no 3 lotes por id) y queda guardada.
  n0 = calls.length;
  const d14 = await page.evaluate(async () => {
    const cfg = { st: 'wl', tabla: 'fake_big', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => 'select=' + s + '&order=scraped_at.desc&limit=500', ids: l => 'id=in.(' + l.join(',') + ')' };
    const a = await _dcConsulta(cfg); const b = await _sGet('fake_big', cfg.q(cfg.cols)); const c = await _dcConsulta(cfg);
    return { igual: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(c) === JSON.stringify(b), n: a.length };
  });
  const d14c = calls.slice(n0).filter(c => /fake_big/.test(c.url));
  check('D14 copia vacía grande: lista + una consulta completa con versión, luego solo lista; idéntico', d14.igual && d14.n === 130
    && d14c.filter(c => /id=in\./.test(c.url)).length === 0 && d14c.filter(c => /select=exp,paciente,fecha,scraped_at,data,id,updated_at/.test(c.url)).length === 1, JSON.stringify({ d14, urls: d14c.map(c => c.url.slice(0, 90)) }));

  // D15 · Filas que dejan de aparecer se olvidan a los 3 días (memoria e IndexedDB).
  const d15 = await page.evaluate(async () => {
    const m = await _dcTabla('wl'); m.forEach((c, k) => { if (+k >= 900000) c.s = Date.now() - 4 * 86400000; });
    await _dcConsulta({ st: 'wl', tabla: 'winlab_labs', id: 'id', ver: 'updated_at', cols: WL_SELECT, q: s => _winlabRowsQuery(patients.map(p => ({ exp: p.exp })), s), ids: l => 'id=in.(' + l.join(',') + ')' });
    await new Promise(r => setTimeout(r, 300));
    const enMem = Array.from(m.keys()).filter(k => +k >= 900000).length;
    const enIdb = await new Promise(res => { const rq = indexedDB.open('pl_cache', 1); rq.onsuccess = () => { const g = rq.result.transaction('wl').objectStore('wl').getAllKeys(); g.onsuccess = () => { res(g.result.filter(k => +k >= 900000).length); rq.result.close(); }; }; });
    return { enMem, enIdb };
  });
  check('D15 filas sin usar 3 días se borran de memoria y de IndexedDB', d15.enMem === 0 && d15.enIdb === 0, JSON.stringify(d15));

  // D16 · pl_dc_off = 1 → solo consultas completas.
  const d16 = await page.evaluate(async () => { localStorage.setItem('pl_dc_off', '1'); const c0 = window.__plDc.stats.completas, l0 = window.__plDc.stats.listas; await _loadRisEstudios(patients); localStorage.removeItem('pl_dc_off'); return { comp: window.__plDc.stats.completas - c0, listas: window.__plDc.stats.listas - l0 }; });
  check('D16 apagado manual (pl_dc_off) → consulta completa sin listas', d16.comp === 1 && d16.listas === 0, JSON.stringify(d16));

  // D17 · Cerrar sesión borra la copia (memoria e IndexedDB).
  const d17 = await page.evaluate(async () => {
    await _dcBorrar();
    const mem = ['wl', 'nt', 'ris'].map(s => (_dcMem[s] ? _dcMem[s].size : 0)).reduce((a, b) => a + b, 0);
    const idb = await new Promise(res => { const rq = indexedDB.open('pl_cache', 1); rq.onsuccess = () => { const db = rq.result; const tx = db.transaction(['wl', 'nt', 'ris']); let n = 0, k = 0; ['wl', 'nt', 'ris'].forEach(s => { const g = tx.objectStore(s).count(); g.onsuccess = () => { n += g.result; if (++k === 3) { db.close(); res(n); } }; }); }; });
    return { mem, idb, logoutLlama: /_dcBorrar\(\)/.test(String(logout)) };
  });
  check('D17 _dcBorrar vacía memoria e IndexedDB, y logout() lo llama', d17.mem === 0 && d17.idb === 0 && d17.logoutLlama, JSON.stringify(d17));
  eq = await EQ();
  check('D17 tras borrar, todo vuelve a bajarse completo e idéntico', todasIguales(eq), JSON.stringify(eq));

  check('D-errores sin errores de página', errors.length === 0, errors.join(' | '));
  console.log('\nRESULT app_descargas: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SCRIPT FAIL', e); process.exit(2); });
