// 🪪 Expediente repetido en el censo (17 oct 2026): dos PERSONAS distintas con el mismo número (error de
// captura en la hoja) ahora aparecen las dos en la app. Lo que llega solo por expediente (imagen RIS,
// cultivos, labs de WinLab, estado del robot) se atribuye por nombre y nunca a las dos; Editar no se
// bloquea; el aviso de duplicados no ofrece borrarlas; el Excel las empareja por nombre.
//   node tests/headless/app_expdup.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture_ego_bh.json'), 'utf8'));
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
  // el robot lo asignó a 3-189 (patient_id) aunque el RIS lo trae con un nombre que la app no reconoce (FCO/abreviatura)
  { id: 905, exp: X, patient_id: 'b1', paciente: 'DIAZ M PEDRO', fecha: '2026-10-16', hora: '11:00:00', modalidad: 'TC', estudios: 'ABDOMEN', reporte: 'LIQUIDO LIBRE', scraped_at: NOW },
  // patient_id de una fila que ya no existe → se decide por nombre
  { id: 906, exp: X, patient_id: 'zz-gone', paciente: 'PEREZ LOPEZ JUAN', fecha: '2026-10-15', hora: '11:00:00', modalidad: 'RX', estudios: 'TORAX PA', reporte: 'SIN CAMBIOS', scraped_at: NOW },
  // bajo el exp de 3-150 (único) pero el robot lo asignó a 3-154 (exp recién corregido): no es de 3-150
  { id: 907, exp: '26-11111', patient_id: 'a1', paciente: 'PEREZ LOPEZ JUAN', fecha: '2026-10-14', hora: '11:00:00', modalidad: 'TC', estudios: 'CRANEO', reporte: 'SIN LESIONES', scraped_at: NOW },
];
const d0 = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const ayer = new Date(d0.getTime() - 86400000);
const mkReport = (hb, d) => ({ __cells: ['', '', '', `${dmy(d)} 06:10`, `${dmy(d)} 08:00`, '', ''], __hasLink: true, valores: FIX.valores.map(v => v.estudio === 'HEMOGLOBINA' ? { ...v, valor: hb } : v) });
const WL_A = { exp: X, paciente: 'JUAN PEREZ LOPEZ', fecha: ymd(ayer), scraped_at: new Date(d0.getTime() - 20 * 3600e3).toISOString(), data: { headers: [], reportes: [mkReport('7.70', ayer)] } };
const WL_B = { exp: X, paciente: 'PEDRO DIAZ MORA', fecha: ymd(d0), scraped_at: new Date(d0.getTime() - 3600e3).toISOString(), data: { headers: [], reportes: [mkReport('9.90', d0)] } };
// La vista winlab_cultivos une por expediente: el mismo cultivo llega una vez por cada cama con ese exp.
const CULT = [
  { exp: X, cama: '3-154', nombre: A.nombre, fecha: '2026-10-16', tipo: 'Hemocultivo', germen: 'Escherichia coli', resultado: 'POSITIVO', texto_origen: 'x' },
  { exp: X, cama: '3-189', nombre: B.nombre, fecha: '2026-10-16', tipo: 'Hemocultivo', germen: 'Escherichia coli', resultado: 'POSITIVO', texto_origen: 'x' },
  { exp: '26-11111', cama: '3-150', nombre: C.nombre, fecha: '2026-10-16', tipo: 'Urocultivo', germen: 'Klebsiella pneumoniae', resultado: 'POSITIVO', texto_origen: 'x', busqueda: 'ANA RUIZ SOTO' },
  // cultivo viejo de OTRA persona que tuvo este exp (expediente ya corregido): no es de 3-150
  { exp: '26-11111', cama: '3-150', nombre: C.nombre, fecha: '2026-10-10', tipo: 'Hemocultivo', germen: 'Candida albicans', resultado: 'POSITIVO', texto_origen: 'x', busqueda: 'PEDRO DIAZ MORA' },
];
const MATCH = [{ exp: X, cama: '3-154', alias: null, status: 'homonimos', buscado: ['PEREZ LOPEZ'], candidatos: ['PEREZ LOPEZ, JUANA'], encontrado_como: null, reportes: 0, detalle: null, checked_at: '2026-10-17T11:00:00Z' }];
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  // X17-X18: la fila `goneId` ya no existe en la nube y en su exp+cama hay otra fila (`twin`)
  let relink = null;
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (relink) {
      if (url.startsWith('/rest/v1/notes') && m === 'POST' && body && body.patient_id === relink.goneId) return json(409, { code: '23503', message: 'insert or update on table "notes" violates foreign key constraint "notes_patient_id_fkey"' });
      if (url.startsWith('/rest/v1/patients?id=eq.' + relink.goneId)) return json(200, []);
      if (url.startsWith('/rest/v1/patients?exp=eq.') && m === 'GET') return relink.failTwin ? json(503, { message: 'unavailable' }) : json(200, relink.twin ? [relink.twin] : []);
      if (url.startsWith('/rest/v1/patients?id=eq.' + (relink.twin && relink.twin.id)) && m === 'PATCH') return json(200, [{ ...relink.twin, ...body }]);
    }
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
  check('X2 imagen: 3-154 ve su TC de tórax (y el RX cuyo patient_id ya no existe, por su nombre); 3-189 su RX de abdomen y el TC que el robot le asignó por patient_id aunque el nombre del RIS no coincida; el estudio sin nombre no va a ninguno; 3-150 (exp único) igual que siempre',
    JSON.stringify(x2.a) === '[901,906]' && JSON.stringify(x2.b) === '[902,905]' && JSON.stringify(x2.c) === '[904]', JSON.stringify(x2));

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
    const a = patients.find(p => p.cama === '3-154'), b = patients.find(p => p.cama === '3-189'), c = patients.find(p => p.cama === '3-150');
    // espera a que cargue la vista (3-150 tiene exp único y debe ver su caja)
    let hc = '';
    for (let i = 0; i < 60 && !hc; i++) { hc = renderCultivosLabSection(c, getNote(pid(c)), pid(c)); if (!hc) await new Promise(r => setTimeout(r, 250)); }
    winlabByExp = { '26-99999': { exp: '26-99999', paciente: 'JUAN PEREZ LOPEZ', data: {} } };
    const ha = renderCultivosLabSection(a, getNote(pid(a)), pid(a)), hb = renderCultivosLabSection(b, getNote(pid(b)), pid(b));
    winlabByExp = {};
    const none = renderCultivosLabSection(a, getNote(pid(a)), pid(a));
    return { c: /Klebsiella/.test(hc), cOther: /Candida/.test(hc), nA: (ha.match(/Escherichia coli/g) || []).length, hb, none };
  });
  check('X4 cultivos: la vista no dice de cuál de los dos es cada cultivo → con gemelos la caja «Cultivos (lab)» no se muestra en ninguna (cada quien ve los suyos en 🦠 Cultivos, ya separados por nombre); 3-150 sí la ve, pero sin el cultivo viejo de otra persona que tuvo su exp',
    x4.hb === '' && x4.none === '' && x4.nA === 0 && x4.c === true && x4.cOther === false, JSON.stringify({ ...x4, hb: x4.hb.slice(0, 80), none: x4.none.slice(0, 80) }));

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

  // ── X11: labs de WinLab: si la fila más nueva del exp es de la otra persona, cada quien recibe SOLO la suya ──
  const x11 = await page.evaluate(async ({ wa, wb }) => {
    winlabByExp = { '26-99999': wb };
    winlabRowsByExp['26-99999'] = [wa, wb];
    await applyWinlabSyncToPatients({ verbose: false });
    const hb = c => (getNote(pid(patients.find(p => p.cama === c))).labHistory || []).map(s => s.labs && s.labs.hb).filter(Boolean);
    return { a: hb('3-154'), b: hb('3-189') };
  }, { wa: WL_A, wb: WL_B });
  check('X11 labs: la fila más nueva (de 3-189) no le quita a 3-154 la suya de ayer: 3-154 tiene solo Hb 7.70 y 3-189 solo Hb 9.90',
    x11.a.includes('7.70') && !x11.a.includes('9.90') && x11.b.includes('9.90') && !x11.b.includes('7.70'), JSON.stringify(x11));

  // ── X12: misma persona = todas las palabras, o parecido sin contradicción de edad/sexo ──
  const x12 = await page.evaluate(() => ({
    hf: _plSamePerson({ nombre: 'JUAN HERNANDEZ LOPEZ', edad: '44' }, { nombre: 'JUAN FERNANDEZ LOPEZ', edad: '67' }),
    hfSame: _plSamePerson({ nombre: 'JUAN HERNANDEZ LOPEZ', edad: '44' }, { nombre: 'JUAN HERNANDES LOPEZ', edad: '44' }),
    sub: _plSamePerson({ nombre: 'JUAN PEREZ' }, { nombre: 'JUAN CARLOS PEREZ LOPEZ' }),
    two: _plSamePerson({ nombre: 'MARIA GUADALUPE GARCIA LOPEZ' }, { nombre: 'MARIA ELENA GARCIA RUIZ' }),
    close: _plCloseName('JOSE LUIS HDEZ PEREZ', 'JOSE LUIS HERNANDEZ PEREZ'), notClose: _plCloseName('ROSA MENA DIAZ', 'PABLO TORO GIL'),
    julian: _plCloseName('JUAN PEREZ LOPEZ', 'JULIAN PEREZ LOPEZ'), adriana: _plCloseName('ANA HERNANDEZ', 'ADRIANA HERNANDEZ'), luisa: _plCloseName('LUIS SOTO', 'LUISA SOTO'),
  }));
  check('X12 misma persona: HERNANDEZ/FERNANDEZ con otra edad = dos personas; una letra con la misma edad = la misma; subconjunto = la misma; nombre + apellido en común no basta; HDEZ≈HERNANDEZ es nombre casi igual; JUAN/JULIAN, ANA/ADRIANA, LUIS/LUISA no',
    x12.hf === false && x12.hfSame === true && x12.sub === true && x12.two === false && x12.close === true && x12.notClose === false
    && x12.julian === false && x12.adriana === false && x12.luisa === false, JSON.stringify(x12));

  // ── X13: ✏️ Editar con gemelos que comparten nombre y apellido: nunca ofrece «mover» la fila del otro ──
  const x13 = await page.evaluate(async () => {
    patients.push({ _supa_id: 't1', cama: '3-171', exp: '26-77777', nombre: 'MARIA GUADALUPE GARCIA LOPEZ', esp: 'CG', edad: '50', estado: 'ESTABLE' });
    patients.push({ _supa_id: 't2', cama: '3-172', exp: '26-77777', nombre: 'MARIA ELENA GARCIA RUIZ', esp: 'CG', edad: '33', estado: 'ESTABLE' });
    window.__alerts.length = 0; window.__confirms.length = 0;
    openEditModal('su-t1');
    document.getElementById('mf-dx').value = 'DX NUEVO';
    saveModal();
    await new Promise(r => setTimeout(r, 300));
    const t1 = patients.find(p => p._supa_id === 't1'), t2 = patients.find(p => p._supa_id === 't2');
    const r = { confirms: window.__confirms.slice(), alerts: window.__alerts.slice(), t1: t1 && [t1.cama, t1.nombre, t1.dx], t2: t2 && [t2.cama, t2.nombre] };
    patients = patients.filter(p => p._supa_id !== 't1' && p._supa_id !== 't2');
    return r;
  });
  check('X13 Editar a una de dos personas con el mismo exp y «MARIA … GARCIA» en común: se guarda el dx sin «PACIENTE YA REGISTRADO» ni «Operación cancelada»; la otra queda intacta',
    !x13.confirms.some(c => /PACIENTE YA REGISTRADO|EXPEDIENTE/.test(c)) && !x13.alerts.some(a => /cancelada|CONFLICTO/.test(a))
    && JSON.stringify(x13.t1) === '["3-171","MARIA GUADALUPE GARCIA LOPEZ","DX NUEVO"]' && JSON.stringify(x13.t2) === '["3-172","MARIA ELENA GARCIA RUIZ"]', JSON.stringify(x13));

  // ── X14: Excel: el gemelo cuya cama toma el otro sale en «no encontrados»; reingreso con nombre abreviado sí, otra persona no ──
  const runImport = async (rows) => page.evaluate(async (rows) => {
    await _libLoad('xlsx');
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Hoja1');
    pendingImport = null;
    handleXlsxImport({ files: [new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'censo.xlsx')], value: '' });
    for (let i = 0; i < 40 && !pendingImport; i++) await new Promise(r => setTimeout(r, 150));
    const pi = pendingImport || {};
    const r = { moved: (pi.movedPts || []).map(m => m.oldPt.cama + '→' + m.newPt.cama + ':' + m.oldPt.nombre), missing: (pi.missingPts || []).map(p => p.cama + ':' + p.nombre),
      rein: (pi.reingresoPts || []).map(x => x.newPt.nombre + '<=' + x.archived.nombre), nuevos: (pi.newPts || []).map(p => p.cama + ':' + p.nombre) };
    try { if (typeof closeImportModal === 'function') closeImportModal(); } catch (_) {}
    pendingImport = null;
    return r;
  }, rows);
  const H = ['CAMA', 'EXPEDIENTE', 'NOMBRE', 'EDAD', 'DIAGNÓSTICO', 'ESPECIALIDAD', 'ESTADO'];
  const x14a = await runImport([H, ['3-150', '26-11111', 'ANA RUIZ SOTO', 60, 'COLANGITIS', 'CG', 'ESTABLE'], ['3-189', '26-99999', 'JUAN PEREZ LOPEZ', 44, 'TRAUMA DE TORAX', 'CT', 'ESTABLE']]);
  check('X14a Excel: JUAN pasa a 3-189 y PEDRO (3-189) ya no viene → JUAN se mueve y PEDRO sale en «no encontrados» (no se borra como fantasma)',
    x14a.moved.includes('3-154→3-189:JUAN PEREZ LOPEZ') && x14a.missing.includes('3-189:PEDRO DIAZ MORA'), JSON.stringify(x14a));
  await page.evaluate(() => {
    archivados.unshift({ cama: '3-180', exp: '26-55555', nombre: 'JOSE LUIS HDEZ PEREZ', _archivedAt: new Date().toISOString(), _archiveKey: 'k55', _note: {} });
    archivados.unshift({ cama: '3-181', exp: '26-66666', nombre: 'ROSA MENA DIAZ', _archivedAt: new Date().toISOString(), _archiveKey: 'k66', _note: { pendientes: 'nota de ROSA' } });
  });
  const x14b = await runImport([H, ['3-150', '26-11111', 'ANA RUIZ SOTO', 60, 'COLANGITIS', 'CG', 'ESTABLE'], ['3-154', '26-99999', 'JUAN PEREZ LOPEZ', 44, 'TRAUMA DE TORAX', 'CT', 'ESTABLE'], ['3-189', '26-99999', 'PEDRO DIAZ MORA', 31, 'TRAUMA ABDOMINAL', 'CG', 'ESTABLE'],
    ['3-180', '26-55555', 'JOSE LUIS HERNANDEZ PEREZ', 50, 'DX', 'CG', 'ESTABLE'], ['3-181', '26-66666', 'PABLO TORO GIL', 40, 'DX', 'CG', 'ESTABLE']]);
  await page.evaluate(() => { archivados = archivados.filter(a => a._archiveKey !== 'k55' && a._archiveKey !== 'k66'); });
  check('X14b Excel: «JOSE LUIS HERNANDEZ PEREZ» se ofrece como reingreso del archivado «HDEZ»; «PABLO TORO GIL» con el exp de otra persona archivada entra como nuevo (sin su nota)',
    x14b.rein.includes('JOSE LUIS HERNANDEZ PEREZ<=JOSE LUIS HDEZ PEREZ') && !x14b.rein.some(r => /PABLO/.test(r)) && x14b.nuevos.includes('3-181:PABLO TORO GIL'), JSON.stringify(x14b));
  await page.evaluate(() => {
    archivados.unshift({ cama: '3-182', exp: '26-44444', nombre: 'JUAN PEREZ LOPEZ', edad: '70', _archivedAt: new Date().toISOString(), _archiveKey: 'k44', _note: { pendientes: 'nota de JUAN' } });
    archivados.unshift({ cama: '3-183', exp: '26-33333', nombre: 'MARIA HERNANDEZ LOPEZ', edad: '75', _archivedAt: new Date().toISOString(), _archiveKey: 'k33', _note: { pendientes: 'nota de MARIA H' } });
  });
  const x14c = await runImport([H, ['3-150', '26-11111', 'ANA RUIZ SOTO', 60, 'COLANGITIS', 'CG', 'ESTABLE'], ['3-154', '26-99999', 'JUAN PEREZ LOPEZ', 44, 'TRAUMA DE TORAX', 'CT', 'ESTABLE'], ['3-189', '26-99999', 'PEDRO DIAZ MORA', 31, 'TRAUMA ABDOMINAL', 'CG', 'ESTABLE'],
    ['3-182', '26-44444', 'JULIAN PEREZ LOPEZ', 25, 'DX', 'CG', 'ESTABLE'], ['3-183', '26-33333', 'MARIA FERNANDEZ LOPEZ', 40, 'DX', 'CG', 'ESTABLE']]);
  await page.evaluate(() => { archivados = archivados.filter(a => a._archiveKey !== 'k44' && a._archiveKey !== 'k33'); });
  check('X14c Excel: JULIAN (25) con el exp del archivado JUAN (70) y MARIA FERNANDEZ (40) con el de MARIA HERNANDEZ (75) NO son reingresos: entran como nuevos, sin la nota de otra persona',
    x14c.rein.length === 0 && x14c.nuevos.includes('3-182:JULIAN PEREZ LOPEZ') && x14c.nuevos.includes('3-183:MARIA FERNANDEZ LOPEZ'), JSON.stringify(x14c));

  // ── X15: una fila con solo apellidos que encaja con dos personas del mismo exp no recibe datos de ninguna ──
  const x15 = await page.evaluate(() => {
    const extra = [{ _supa_id: 's1', cama: '3-101', exp: '26-88888', nombre: 'PEREZ RUIZ', esp: 'CG' }, { _supa_id: 'j1', cama: '3-102', exp: '26-88888', nombre: 'PEREZ RUIZ JUAN CARLOS', esp: 'CG' }, { _supa_id: 'm1', cama: '3-103', exp: '26-88888', nombre: 'PEREZ RUIZ MARIA ELENA', esp: 'CG' }];
    patients.push(...extra);
    const s1 = extra[0], j1 = extra[1];
    const r = { twS: _plExpTwins(s1).length, twJ: _plExpTwins(j1).map(q => q.cama), sGetsJ: _winlabCensoNameOk(s1, { paciente: 'PEREZ RUIZ JUAN CARLOS' }), jGetsJ: _winlabCensoNameOk(j1, { paciente: 'PEREZ RUIZ JUAN CARLOS' }),
      dup: detectDuplicatePatients(patients).filter(g => g.patients.some(p => p.exp === '26-88888')).length };
    patients = patients.filter(p => !['s1', 'j1', 'm1'].includes(p._supa_id));
    return r;
  });
  check('X15 solo apellidos + dos personas con el mismo exp: la fila ambigua tiene a las dos como gemelas y no recibe los labs de JUAN; JUAN sí; no se arma grupo de «duplicados» que encadene a las tres',
    x15.twS === 2 && JSON.stringify(x15.twJ) === '["3-103"]' && x15.sGetsJ === false && x15.jGetsJ === true && x15.dup === 0, JSON.stringify(x15));

  // ── X16: un estudio que el robot asignó a OTRO paciente activo no aparece aunque el exp sea único ──
  const x16 = await page.evaluate(() => risForPatient(patients.find(p => p.cama === '3-150')).map(r => r.id));
  check('X16 imagen: con exp único, el estudio con patient_id de otro paciente activo (exp recién corregido) no sale en 3-150',
    JSON.stringify(x16) === '[904]', JSON.stringify(x16));

  // ── X17: tarjeta vieja (su fila se archivó como cama reasignada) con una nota sin subir: NO se sube a la fila de
  //         la OTRA persona que el sync puso en esa cama con el mismo exp; va a la Papelera y la tarjeta se retira ──
  const relinkCase = async (goneId, twin) => {
    relink = { goneId, twin }; const from = calls.length;
    const r = await page.evaluate(async ([goneId]) => {
      const z = { _supa_id: goneId, cama: '3-170', exp: '26-77777', nombre: 'LUIS GARCIA VEGA', edad: '50', esp: 'CG', estado: 'ESTABLE' };
      patients.push(z);
      const k = pid(z); noteData[k] = { ...defaultData(), pendientes: 'PEND DE LUIS' };
      const out = await supaUpsertNote(goneId, noteData[k]);
      const still = patients.find(p => p === z);
      patients = patients.filter(p => p !== z);
      return { out: out == null ? null : 'ok', still: !!still, supa: z._supa_id };
    }, [goneId]);
    relink = null;
    return { ...r, c: calls.slice(from) };
  };
  const x17 = await relinkCase('z1', { id: 'z2', nombre: 'MARIA SOTO RUIZ', edad: '30' });
  const x17note = x17.c.find(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.patient_id === 'z2');
  const x17arc = x17.c.find(c => c.m === 'POST' && c.url.startsWith('/rest/v1/archive'));
  check('X17 nota sin subir de una fila archivada: con OTRA persona en su exp+cama no se sube a su fila; se archiva con su nombre y la tarjeta se retira',
    !x17note && !!x17arc && x17arc.body.patient_data.nombre === 'LUIS GARCIA VEGA' && x17arc.body.note_data.pendientes === 'PEND DE LUIS' && !x17.still, JSON.stringify({ ...x17, c: x17.c.map(c => c.m + ' ' + c.url) }));
  // ── X18: ...pero si la fila nueva es la MISMA persona (nombre corregido), se re-enlaza y la nota sube ahí ──
  const x18 = await relinkCase('z3', { id: 'z4', nombre: 'LUIS GARCIA BEGA', edad: '50' });
  const x18note = x18.c.find(c => c.m === 'POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.patient_id === 'z4');
  check('X18 misma persona con el nombre corregido en la fila nueva: se re-enlaza y la nota sube a esa fila',
    !!x18note && x18note.body.pendientes === 'PEND DE LUIS' && x18.supa === 'z4' && x18.still && !x18.c.some(c => c.url.startsWith('/rest/v1/archive')), JSON.stringify({ ...x18, c: x18.c.map(c => c.m + ' ' + c.url) }));
  // ── X19: PATCH de datos censales a una fila que ya no existe: no se copia sobre la de otra persona ──
  const patchCase = async (goneId, twin) => {
    relink = { goneId, twin }; const from = calls.length;
    const r = await page.evaluate(async ([goneId]) => {
      const z = { _supa_id: goneId, cama: '3-171', exp: '26-77778', nombre: 'LUIS GARCIA VEGA', edad: '50', esp: 'CG', estado: 'ESTABLE', dx: 'DX DE LUIS' };
      patients.push(z);
      const out = await supaUpsertPatient(z, ['dx']);
      patients = patients.filter(p => p !== z);
      return { out: out && out.__deleted_remotely ? 'gone' : (out ? 'ok' : null), supa: z._supa_id };
    }, [goneId]);
    relink = null;
    return { ...r, c: calls.slice(from) };
  };
  const x19 = await patchCase('z5', { id: 'z6', nombre: 'MARIA SOTO RUIZ', edad: '30' });
  const x19b = await patchCase('z7', { id: 'z8', nombre: 'GARCIA VEGA LUIS', edad: '50' });
  check('X19 PATCH a una fila borrada: con OTRA persona en su exp+cama no la toca (fila borrada en remoto); con la misma persona se re-enlaza y la actualiza',
    x19.out === 'gone' && !x19.c.some(c => c.m === 'PATCH' && c.url.includes('id=eq.z6')) && x19b.supa === 'z8' && x19b.c.some(c => c.m === 'PATCH' && c.url.includes('id=eq.z8')),
    JSON.stringify({ x19: { ...x19, c: x19.c.map(c => c.m + ' ' + c.url) }, x19b: { ...x19b, c: x19b.c.map(c => c.m + ' ' + c.url) } }));
  // ── X20: la regla de nombre compatible de la app es EXACTAMENTE la del sync de la hoja (mismo resultado en cada par) ──
  const SYNC = (() => { const vm = require('vm'); const sb = { Logger: { log() {} }, PropertiesService: {}, CacheService: {}, UrlFetchApp: {}, console }; vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'apps-script', 'censo-sync.gs'), 'utf8'), sb); return sb; })();
  const BASE = ['PEREZ DIAS JUAN', 'PEREZ DIAZ JUAN', 'GOMEZ GRACIA LUIS', 'GOMEZ GARCIA LUIS', 'HDZ LOPEZ JUAN', 'HERNANDEZ LOPEZ JUAN CARLOS', 'DESCONOCIDO MASCULINO',
    'PEREZ LOPEZ JUAN', 'PEREZ DELACRUZ JUAN', 'PEREZ DE LA CRUZ JUAN', 'Pérez Ruíz Juan', 'PEREZ RUIZ JUAN CARLOS', 'PEREZ SOTO MIGUEL', 'PEREZ LOPEZ MARIA',
    'GARCIA ANA', 'LOPEZ ANA', 'PEREZ J', 'J. PEREZ L.', 'MONTESDEOCA ANA', 'MONTES DE OCA ANA LUISA', 'MARIAJOSE PERES', 'MARIA JOSE PEREZ', 'ALEJ PEREZ', 'ALEJANDRO PEREZ',
    'BAEZ ANA', 'VAES ANA', 'FEMENINA', 'N.N.', 'HIJO DE MARIA LOPEZ', 'MARIA LOPEZ', 'PEREZ LOPEZ JUANA', 'SOTO LUIS', 'SOTO LUISA', 'MA. DE JESUS LOPEZ', 'MARIA JESUS LOPEZ',
    'GPE LOPEZ', 'GUADALUPE LOPEZ SOTO', 'LOPEZ PEREZ MARIA GUADALUPE', 'SANCHEZ RUIZ MARIA GUADALUPE', 'HERNADES RUIZ JUAN', 'HERNANDEZ RUIZ JUAN', 'GONZALES MARTINES',
    'GONZALEZ MARTINEZ', 'NUÑEZ PEÑA ANA', 'NUNEZ PENA ANA', 'LLAMAS CRUZ', 'YAMAS CRUS', 'CECILIA VEGA', 'SESILIA BEGA', 'DIAZ ROSA', 'DIAZ ROSARIO', '', 'X', 'RN DE PEREZ'];
  const PAIRS = []; for (const a of BASE) for (const b of BASE) PAIRS.push([a, b]);
  const x20app = await page.evaluate((pairs) => pairs.map(([a, b]) => _plNamesCompatible({ nombre: a, edad: '40' }, { nombre: b, edad: '40' })), PAIRS);
  const x20diff = PAIRS.filter(([a, b], i) => SYNC.namesCompatible_({ nombre: a, edad: '40' }, { nombre: b, edad: '40' }) !== x20app[i]);
  const P20 = (a, b) => x20app[PAIRS.findIndex(([x, y]) => x === a && y === b)];
  check('X20 _plNamesCompatible da lo mismo que namesCompatible_ del sync en los ' + PAIRS.length + ' pares; correcciones (DIAS/DIAZ, HDZ, J, DELACRUZ, acentos) sí; hermanos, JUANA/LUISA o un solo apellido en común no',
    x20diff.length === 0 && P20('PEREZ DIAS JUAN', 'PEREZ DIAZ JUAN') && P20('HDZ LOPEZ JUAN', 'HERNANDEZ LOPEZ JUAN CARLOS') && P20('PEREZ J', 'PEREZ LOPEZ JUAN') && P20('Pérez Ruíz Juan', 'PEREZ RUIZ JUAN CARLOS')
    && !P20('PEREZ LOPEZ JUAN', 'PEREZ LOPEZ MARIA') && !P20('PEREZ LOPEZ JUAN', 'PEREZ LOPEZ JUANA') && !P20('PEREZ RUIZ JUAN CARLOS', 'PEREZ SOTO MIGUEL') && !P20('MARIA LOPEZ', 'HIJO DE MARIA LOPEZ'),
    JSON.stringify(x20diff.slice(0, 8)));

  // ── X21: alta sin id (p. ej. restaurar de la Papelera) en una cama+exp que la nube ya tiene con OTRA persona: no se fusiona ──
  const upsertCase = async (held) => {
    relink = { goneId: '__none__', twin: held }; const from = calls.length;
    const r = await page.evaluate(async () => {
      const z = { cama: '3-172', exp: '26-77779', nombre: 'LUIS GARCIA VEGA', edad: '50', esp: 'CG', estado: 'ESTABLE', dx: 'DX DE LUIS' };
      const out = await supaUpsertPatient(z);
      return { out: out ? 'ok' : null, supa: z._supa_id || null };
    });
    relink = null;
    return { ...r, c: calls.slice(from) };
  };
  const x21 = await upsertCase({ id: 'y2', nombre: 'MARIA SOTO RUIZ', edad: '30', exp: '26-77779', cama: '3-172' });
  const x21b = await upsertCase({ id: 'y3', nombre: 'GARCIA VEGA LUIS', edad: '50', exp: '26-77779', cama: '3-172' });
  check('X21 alta sin id con OTRA persona en esa cama+exp: no hay upsert por exp+cama (no se fusiona con su fila); con la misma persona sí',
    x21.out === null && !x21.c.some(c => c.m === 'POST' && c.url.startsWith('/rest/v1/patients')) && x21b.c.some(c => c.m === 'POST' && c.url.startsWith('/rest/v1/patients?on_conflict=exp,cama')),
    JSON.stringify({ x21: x21.c.map(c => c.m + ' ' + c.url), x21b: x21b.c.map(c => c.m + ' ' + c.url) }));

  // ── X22: FK de la nota y la verificación de identidad falla por red: no se recrea por exp+cama (reintenta después) ──
  {
    relink = { goneId: 'w1', twin: null, failTwin: true }; const from = calls.length;
    const r = await page.evaluate(async () => {
      const z = { _supa_id: 'w1', cama: '3-173', exp: '26-77780', nombre: 'LUIS GARCIA VEGA', edad: '50', esp: 'CG', estado: 'ESTABLE' };
      patients.push(z); const k = pid(z); noteData[k] = { ...defaultData(), pendientes: 'PEND DE LUIS' };
      const out = await supaUpsertNote('w1', noteData[k]);
      const still = patients.includes(z); patients = patients.filter(p => p !== z);
      return { out: out == null ? null : 'ok', still, supa: z._supa_id };
    });
    relink = null;
    const c = calls.slice(from);
    check('X22 FK + la búsqueda por exp+cama falla por red: la tarjeta no pierde su id ni se upsertea por exp+cama; la nota queda para reintentar',
      r.out === null && r.supa === 'w1' && r.still && !c.some(x => x.m === 'POST' && x.url.startsWith('/rest/v1/patients')), JSON.stringify({ r, c: c.map(x => x.m + ' ' + x.url) }));
  }

  // ── X23: restaurar de la Papelera a alguien cuya cama ya tiene OTRA persona: pide otra cama ──
  {
    const r = await page.evaluate(async () => {
      const b = patients.find(p => p.cama === '3-189');
      archivados.unshift({ cama: '3-189', exp: b.exp, nombre: 'RAUL TORRES NAVA', edad: '52', esp: 'CG', _archivedAt: new Date().toISOString(), _archiveKey: 'kx23', _note: { ...defaultData(), pendientes: 'nota de RAUL' } });
      const before = patients.length;
      window.prompt = function () { return null; };   // cancela
      restorePatient(0);
      const cancelled = patients.length === before && archivados[0] && archivados[0]._archiveKey === 'kx23';
      window.prompt = function () { return '3-199'; };
      restorePatient(0);
      const rp = patients.find(p => p.nombre === 'RAUL TORRES NAVA');
      const out = { cancelled, cama: rp && rp.cama, bStill: patients.find(p => p.cama === '3-189') === b };
      patients = patients.filter(p => p !== rp);
      window.prompt = function () { return null; };
      return out;
    });
    check('X23 restaurar de la Papelera con su cama ocupada por otra persona: pregunta otra cama (cancelar no restaura); se restaura en la cama elegida y el ocupante no se toca',
      r.cancelled && r.cama === '3-199' && r.bStill, JSON.stringify(r));
  }

  check('X10 sin errores de JavaScript en la página', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('RESULT APP-EXPDUP: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
