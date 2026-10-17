// 🪪 Expediente repetido en el censo (17 oct 2026): dos PERSONAS distintas con el mismo número (error de
// captura en la hoja) ahora aparecen las dos en la app. Lo que llega solo por expediente (imagen RIS,
// cultivos, labs de WinLab, estado del robot) se atribuye por nombre y nunca a las dos; Editar no se
// bloquea; el aviso de duplicados no ofrece borrarlas; el Excel las empareja por nombre.
//   node tests/headless/app_expdup.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.__confirms=[];
  window.prompt=function(){ return null; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(m){ window.__confirms.push(String(m)); return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const X = '26-99999';
const A = { id: 'a1', cama: '3-154', exp: X, nombre: 'JUAN PEREZ LOPEZ', esp: 'CT', estado: 'ESTABLE', edad: '44', ingreso: '2026-10-16', dx: 'TRAUMA DE TORAX' };
const B = { id: 'b1', cama: '3-189', exp: X, nombre: 'PEDRO DIAZ MORA', esp: 'CG', estado: 'ESTABLE', edad: '31', ingreso: '2026-10-16', dx: 'TRAUMA ABDOMINAL' };
const C = { id: 'c1', cama: '3-150', exp: '26-11111', nombre: 'ANA RUIZ SOTO', esp: 'CG', estado: 'ESTABLE', edad: '60', ingreso: '2026-10-15', dx: 'COLANGITIS' };
const NOW = new Date().toISOString();
const RIS = [
  { id: 901, exp: X, paciente: 'PEREZ LOPEZ JUAN', fecha: '2026-10-17', hora: '08:00:00', modalidad: 'CT', estudios: 'TORAX', reporte: 'NEUMOTORAX DERECHO LAMINAR', scraped_at: NOW },
  { id: 902, exp: X, paciente: 'DIAZ MORA PEDRO', fecha: '2026-10-17', hora: '09:00:00', modalidad: 'RX', estudios: 'ABDOMEN', reporte: 'NIVELES HIDROAEREOS', scraped_at: NOW },
  { id: 903, exp: X, paciente: '', fecha: '2026-10-17', hora: '10:00:00', modalidad: 'US', estudios: 'HIGADO', reporte: 'SIN NOMBRE EN EL RIS', scraped_at: NOW },
  { id: 904, exp: '26-11111', paciente: 'RUIZ SOTO ANA', fecha: '2026-10-17', hora: '07:00:00', modalidad: 'US', estudios: 'VESICULA', reporte: 'COLEDOCOLITIASIS', scraped_at: NOW },
];
// La vista winlab_cultivos une por expediente: el mismo cultivo llega una vez por cada cama con ese exp.
const CULT = [
  { exp: X, cama: '3-154', nombre: A.nombre, fecha: '2026-10-16', tipo: 'Hemocultivo', germen: 'Escherichia coli', resultado: 'POSITIVO', texto_origen: 'x' },
  { exp: X, cama: '3-189', nombre: B.nombre, fecha: '2026-10-16', tipo: 'Hemocultivo', germen: 'Escherichia coli', resultado: 'POSITIVO', texto_origen: 'x' },
];
const MATCH = [{ exp: X, cama: '3-154', alias: null, status: 'homonimos', buscado: ['PEREZ LOPEZ'], candidatos: ['PEREZ LOPEZ, JUANA'], encontrado_como: null, reportes: 0, detalle: null, checked_at: '2026-10-17T11:00:00Z' }];
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
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [C, A, B]); return json(201, [{ id: 'n' + calls.length }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{}]); }
    if (url.startsWith('/rest/v1/ris_estudios')) return json(200, RIS);
    if (url.startsWith('/rest/v1/winlab_cultivos')) return json(200, CULT);
    if (url.startsWith('/rest/v1/winlab_match')) return json(200, MATCH);
    if (url.startsWith('/rest/v1/archive')) { if (m === 'POST') return json(201, [{ id: 777 }]); return json(200, []); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3 && Object.keys(risByExp || {}).length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── X1: aparecen los dos (nada los oculta ni los fusiona) y cada uno con su propia clave ──
  const x1 = await page.evaluate(() => {
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189');
    return { n: patients.length, a: !!a, b: !!b, ka: a && pid(a), kb: b && pid(b), twinsA: a ? _plExpTwins(a).map(q => q.cama) : null, twinsC: _plExpTwins(patients.find(p => p.cama === '3-150')).length };
  });
  check('X1 los dos pacientes con el mismo expediente aparecen, con claves distintas; cada uno ve al otro como «gemelo» y un paciente normal no tiene gemelos',
    x1.n === 3 && x1.a && x1.b && x1.ka !== x1.kb && JSON.stringify(x1.twinsA) === '["3-189"]' && x1.twinsC === 0, JSON.stringify(x1));

  // ── X2: imagen (RIS) por nombre; sin nombre no se atribuye; el paciente normal sigue igual ──
  const x2 = await page.evaluate(() => {
    const f = c => risForPatient(patients.find(p => p.cama === c)).map(r => r.id);
    return { a: f('3-154'), b: f('3-189'), c: f('3-150') };
  });
  check('X2 imagen: 3-154 solo ve su TC de tórax, 3-189 solo su RX de abdomen, el estudio sin nombre no va a ninguno; 3-150 (exp único) igual que siempre',
    JSON.stringify(x2.a) === '[901]' && JSON.stringify(x2.b) === '[902]' && JSON.stringify(x2.c) === '[904]', JSON.stringify(x2));

  // ── X3: la entrega automática no guarda en la nota de uno el estudio del otro ──
  const x3 = await page.evaluate(async () => {
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189');
    _entregaAutoFromRis([a, b]);
    await new Promise(r => setTimeout(r, 300));
    return { ea: toSafeString(getNote(pid(a)).entrega), eb: toSafeString(getNote(pid(b)).entrega) };
  });
  check('X3 entrega automática: la de 3-154 lleva su CT de tórax y no el RX de abdomen; la de 3-189 al revés; ninguna lleva el estudio sin nombre',
    /CT TORAX/.test(x3.ea) && !/ABDOMEN/.test(x3.ea) && /RX ABDOMEN/.test(x3.eb) && !/TORAX/.test(x3.eb) && !/HIGADO/.test(x3.ea + x3.eb), JSON.stringify(x3));

  // ── X4: caja «Cultivos (lab)»: solo en la tarjeta de quien el robot encontró en WinLab, una vez ──
  const x4 = await page.evaluate(async () => {
    winlabByExp = { '26-99999': { exp: '26-99999', paciente: 'JUAN PEREZ LOPEZ', data: {} } };
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189');
    let ha = '';
    for (let i = 0; i < 60 && !ha; i++) { ha = renderCultivosLabSection(a, getNote(pid(a)), pid(a)); if (!ha) await new Promise(r => setTimeout(r, 250)); }
    const hb = renderCultivosLabSection(b, getNote(pid(b)), pid(b));
    winlabByExp = {};
    const none = renderCultivosLabSection(a, getNote(pid(a)), pid(a));
    return { loaded: !!ha, nA: (ha.match(/Escherichia coli/g) || []).length, hb, none };
  });
  check('X4 cultivos: la vista los repite por cama, pero salen UNA vez y solo en 3-154 (la persona de la fila de WinLab); 3-189 no los ve; sin fila de WinLab no se atribuyen a nadie',
    x4.loaded && x4.nA === 1 && x4.hb === '' && x4.none === '', JSON.stringify({ ...x4, hb: x4.hb.slice(0, 80), none: x4.none.slice(0, 80) }));

  // ── X5: labs de WinLab: la guarda de nombre es EXCLUSIVA con expediente repetido ──
  const x5 = await page.evaluate(() => {
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189'), c = patients.find(p => p.cama === '3-150');
    const r = { aOwn: _winlabCensoNameOk(a, { paciente: 'JUAN PEREZ LOPEZ' }), bOther: _winlabCensoNameOk(b, { paciente: 'JUAN PEREZ LOPEZ' }), aEmpty: _winlabCensoNameOk(a, { paciente: '' }), cEmpty: _winlabCensoNameOk(c, { paciente: '' }) };
    // una fila cuyo nombre encaja con LOS DOS (subconjunto) no es de ninguno
    const save = patients;
    patients = [{ cama: '1', exp: '9', nombre: 'JUAN PEREZ LOPEZ' }, { cama: '2', exp: '9', nombre: 'MARIO PEREZ VEGA' }];
    r.bothA = _winlabCensoNameOk(patients[0], { paciente: 'PEREZ' }); r.bothB = _winlabCensoNameOk(patients[1], { paciente: 'PEREZ' });
    patients = save;
    return r;
  });
  check('X5 labs: la fila de WinLab a nombre de 3-154 es de 3-154 y NO de 3-189; sin nombre no se atribuye con exp repetido (con exp único sigue pasando); un nombre que encaja con los dos no es de ninguno',
    x5.aOwn === true && x5.bOther === false && x5.aEmpty === false && x5.cEmpty === true && x5.bothA === false && x5.bothB === false, JSON.stringify(x5));

  // ── X6: línea del robot: el resultado (y sus nombres sugeridos) solo en la cama a la que pertenece ──
  const x6 = await page.evaluate(() => {
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189');
    const t = (p) => { const d = document.createElement('div'); d.innerHTML = renderRobotLine(p, getNote(pid(p)), pid(p)); return { txt: d.textContent.replace(/\s+/g, ' '), chips: d.querySelectorAll('.rb-chip').length, dup: !!d.querySelector('[data-testid="robot-expdup"]') }; };
    return { loaded: !!winlabMatchByExp['26-99999'], a: t(a), b: t(b) };
  });
  check('X6 robot: las dos tarjetas avisan «Expediente repetido en la hoja» con la otra cama; el resultado del robot y su sugerencia solo salen en 3-154 (de quien es); 3-189 no muestra nombres de otra persona',
    x6.loaded && x6.a.dup && /3-189/.test(x6.a.txt) && x6.a.chips === 1 && /ninguna coincide/.test(x6.a.txt)
    && x6.b.dup && /3-154/.test(x6.b.txt) && x6.b.chips === 0 && !/ninguna coincide|JUANA/.test(x6.b.txt), JSON.stringify(x6));

  // ── X7: el aviso de duplicados no los trata como duplicado (no ofrece borrar a ninguno) ──
  const x7 = await page.evaluate(() => detectDuplicatePatients(patients).map(g => g.type + ':' + g.patients.map(p => p.cama).join(',')));
  check('X7 duplicados: dos personas con el mismo expediente NO forman un grupo de duplicados', x7.length === 0, JSON.stringify(x7));

  // ── X8: ✏️ Editar a cualquiera de los dos ya no se bloquea; agregar ese exp a otra persona pide confirmar ──
  const x8 = await page.evaluate(async () => {
    const b = patients.find(p => p.cama === '3-189');
    window.__alerts.length = 0; window.__confirms.length = 0;
    openEditModal(pid(b));
    document.getElementById('mf-dx').value = 'TRAUMA ABDOMINAL + PO LAPE';
    saveModal();
    await new Promise(r => setTimeout(r, 400));
    const edited = patients.find(p => p.cama === '3-189');
    const r = { alertsEdit: window.__alerts.slice(), confirmsEdit: window.__confirms.slice(), dx: edited && edited.dx, nombre: edited && edited.nombre, n0: patients.length };
    window.__alerts.length = 0; window.__confirms.length = 0;
    openAddModal();
    document.getElementById('mf-cama').value = '3-170'; document.getElementById('mf-exp').value = '26-99999';
    document.getElementById('mf-nombre').value = 'MARIO SOTO VEGA'; document.getElementById('mf-esp').value = 'CG';
    saveModal();
    await new Promise(r => setTimeout(r, 400));
    r.confirmsAdd = window.__confirms.slice(); r.alertsAdd = window.__alerts.slice();
    r.added = !!patients.find(p => p.cama === '3-170' && p.nombre === 'MARIO SOTO VEGA');
    return r;
  });
  check('X8 Editar 3-189 (exp sin cambio): se guarda el dx sin «EXPEDIENTE EN CONFLICTO» ni preguntas; Agregar a otra persona con ese exp: pregunta «EXPEDIENTE REPETIDO» y al aceptar la agrega',
    !x8.alertsEdit.some(a => /CONFLICTO/.test(a)) && !x8.confirmsEdit.some(c => /EXPEDIENTE/.test(c)) && x8.dx === 'TRAUMA ABDOMINAL + PO LAPE' && x8.nombre === 'PEDRO DIAZ MORA'
    && x8.confirmsAdd.some(c => /EXPEDIENTE REPETIDO/.test(c)) && !x8.alertsAdd.some(a => /CONFLICTO/.test(a)) && x8.added, JSON.stringify(x8));
  await page.evaluate(() => { patients = patients.filter(p => p.cama !== '3-170'); });

  // ── X9: Excel: con el exp repetido se empareja por nombre (el que cambió de cama es el correcto) ──
  const x9 = await page.evaluate(async () => {
    await _libLoad('xlsx');
    const rows = [['CAMA', 'EXPEDIENTE', 'NOMBRE', 'EDAD', 'DIAGNÓSTICO', 'ESPECIALIDAD', 'ESTADO'],
      ['3-150', '26-11111', 'ANA RUIZ SOTO', 60, 'COLANGITIS', 'CG', 'ESTABLE'],
      ['3-154', '26-99999', 'JUAN PEREZ LOPEZ', 44, 'TRAUMA DE TORAX', 'CT', 'ESTABLE'],
      ['3-160', '26-99999', 'PEDRO DIAZ MORA', 31, 'TRAUMA ABDOMINAL', 'CG', 'ESTABLE']];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Hoja1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    pendingImport = null;
    handleXlsxImport({ files: [new File([buf], 'censo.xlsx')], value: '' });
    for (let i = 0; i < 40 && !pendingImport; i++) await new Promise(r => setTimeout(r, 150));
    const pi = pendingImport || {};
    const r = {
      same: (pi.samePts || []).map(p => p.cama + ':' + p.nombre),
      moved: (pi.movedPts || []).map(m => m.oldPt.cama + '→' + m.newPt.cama + ':' + m.oldPt.nombre + '=' + m.newPt.nombre),
      changed: (pi.changedPts || []).map(m => m.oldPt.cama + ':' + m.newPt.nombre),
      missing: (pi.missingPts || []).map(p => p.cama), nuevos: (pi.newPts || []).map(p => p.cama),
    };
    try { if (typeof closeImportModal === 'function') closeImportModal(); } catch (_) {}
    pendingImport = null;
    return r;
  });
  check('X9 Excel con el exp repetido: 3-189 (PEDRO) se movió a 3-160 → el cambio de cama es de PEDRO (no de JUAN); JUAN sigue en 3-154; nadie queda como desaparecido ni duplicado',
    x9.moved.length === 1 && x9.moved[0] === '3-189→3-160:PEDRO DIAZ MORA=PEDRO DIAZ MORA' && x9.same.includes('3-154:JUAN PEREZ LOPEZ') && x9.same.includes('3-150:ANA RUIZ SOTO')
    && x9.missing.length === 0 && x9.changed.length === 0 && x9.nuevos.length === 0, JSON.stringify(x9));

  check('X10 sin errores de JavaScript en la página', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('RESULT APP-EXPDUP: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
