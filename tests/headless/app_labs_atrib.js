// 🧪 Atribución de labs de WinLab a la tarjeta (26 oct 2026, revisión completa). Casos que fallaban:
// · expediente repetido: el robot junta a los dos pacientes en UNA fila (exp, fecha) y el segundo nunca recibía labs
//   (cama 3-160); con WinLab en italiano el primero recibía también los del otro;
// · FCO./FCA. en el censo, «nombre en WinLab» (alias) y __target del robot ignorados;
// · encabezados en italiano sin reconocer (la guardia de servicio tiraba labs de NCX/URO);
// · homónimo ANTONIA en la tarjeta de ANTONIO; EGO antes que la BH en el mismo reporte;
// · Realtime con el mismo scraped_at; chip de fecha que dejaba tendencia/INR de la fecha anterior.
// Pacientes ficticios.   node tests/headless/app_labs_atrib.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.prompt=function(){ return null; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const d0 = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const ayer = new Date(d0.getTime() - 86400000);
const PTS = [
  { id: 'p1', cama: '3-201', exp: '26-90001', nombre: 'FCO. JAVIER RUIZ SOTO', esp: 'CG', edad: '50', sexo: 'M' },
  { id: 'p2', cama: '3-202', exp: '26-90002', nombre: 'MARIA ELENA LOPEZ PEREZ', esp: 'CG', edad: '61', sexo: 'F' },
  { id: 'p3', cama: '3-159', exp: '26-90003', nombre: 'JUAN CARLOS MENDEZ ORTIZ', esp: 'CG', edad: '40', sexo: 'M' },
  { id: 'p4', cama: '3-160', exp: '26-90003', nombre: 'ROSA MARIA VEGA LUNA', esp: 'CG', edad: '70', sexo: 'F' },
  { id: 'p5', cama: '3-205', exp: '26-90005', nombre: 'PEDRO SALAS MORA', esp: 'NCX', edad: '33', sexo: 'M' },
  { id: 'p6', cama: '3-206', exp: '26-90006', nombre: 'ANTONIO GARCIA LOPEZ', esp: 'CG', edad: '45', sexo: 'M' },
  { id: 'p7', cama: '3-207', exp: '26-90007', nombre: 'LUIS ALBERTO CRUZ DIAZ', esp: 'CG', edad: '58', sexo: 'M' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (url.startsWith('/rest/v1/notes') && m === 'POST') return json(201, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 7, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(({ D, A, Dd, Ad }) => {
    const out = {};
    const BH = (hb, leu) => [{ estudio: 'HEMOGLOBINA', valor: hb, unidad: 'g/dL', referencia: '13.0 - 17.0' }, { estudio: 'LEUCOCITOS', valor: leu, unidad: 'x10^3/uL', referencia: '4.5 - 11.0' }, { estudio: 'HEMATOCRITO', valor: '38', unidad: '%', referencia: '' }];
    // Encabezado ES / IT (claves de la tabla de búsqueda) y fila de reporte (6 celdas)
    const hdrES = (ap, nom, sx, fnac) => ({ '': '', 'CODIGO PACIENTE': '1', 'APELLIDOS COMPLETOS': ap, NOMBRE: nom, SEXO: sx, 'FECHA DE NAC.': fnac, __cells: ['', '', '1', ap, nom, sx, fnac], __hasLink: false });
    const hdrIT = (ap, nom, sx, fnac) => ({ '': '', 'CODICEPAZIENTE': '1', COGNOMEINTERO: ap, NOME: nom, SESSO: sx, 'DATA DI NASCITA': fnac, __cells: ['', '', '1', ap, nom, sx, fnac], __hasLink: false });
    const repES = (toma, svc, valores, target) => Object.assign({ '': '', 'CODIGO PACIENTE': '2610260001', 'APELLIDOS COMPLETOS': toma, NOMBRE: toma, SEXO: svc, __cells: ['', '', '2610260001', toma, toma, svc], __hasLink: true, valores }, target === undefined ? {} : { __target: target });
    const repIT = (toma, svc, valores, target) => Object.assign({ '': '', 'CODICEPAZIENTE': '2610260001', COGNOMEINTERO: toma, NOME: toma, SESSO: svc, __cells: ['', '', '2610260001', toma, toma, svc], __hasLink: true, valores }, target === undefined ? {} : { __target: target });
    const row = (exp, paciente, reportes, extra) => ({ exp, paciente, fecha: D, scraped_at: new Date(Date.now() - 3600e3).toISOString(), data: Object.assign({ headers: [], reportes }, extra || {}) });
    const P = (id) => patients.find(p => p._supa_id === id || p.id === id);
    const reset = () => { patients.forEach(p => { noteData[pid(p)] = defaultData(); }); };
    const run = async (rows, only) => {
      const latest = {}, all = {};
      rows.forEach(r => { latest[r.exp] = r; (all[r.exp] = all[r.exp] || []).push(r); });
      winlabByExp = latest; winlabRowsByExp = all; _winlabExpIndex = null;
      reset();
      const st = await applyWinlabSyncToPatients({ verbose: false, only });
      return st;
    };
    const labsOf = (p) => (noteData[pid(p)].labHistory || []).map(s => ({ fecha: s.fecha, hb: s.labs.hb, leucos: s.labs.leucos }));
    return (async () => {
      const p1 = P('p1'), p2 = P('p2'), p3 = P('p3'), p4 = P('p4'), p5 = P('p5'), p6 = P('p6');
      await run([row('26-90001', p1.nombre, [hdrES('RUIZ SOTO', 'FRANCISCO JAVIER', 'MASCULINO', '02/03/1976'), repES(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('11.2', '9.1'))])], [p1]);
      out.W1 = labsOf(p1);   // sin __target (fila vieja): el nombre decide, con FCO = FRANCISCO
      // «✏️ Nombre en WinLab» guardado en la nota (apellido de casada): el encabezado se coteja también con él.
      const r2a = row('26-90002', p2.nombre, [hdrES('LOPEZ RAMIREZ', 'MARIA ELENA', 'FEMENINO', '05/06/1965'), repES(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('10.4', '7.0'), true)]);
      await run([r2a], [p2]);
      out.W2sin = labsOf(p2);   // sin alias: otro apellido → no entra aunque el robot lo marque
      { const nd2 = defaultData(); nd2.checklist = { winlab_alias: 'LOPEZ RAMIREZ, MARIA ELENA' }; noteData[pid(p2)] = nd2;
        await applyWinlabSyncToPatients({ verbose: false, only: [p2] }); }
      out.W2 = labsOf(p2);
      const twinsES = [hdrES('MENDEZ ORTIZ', 'JUAN CARLOS', 'MASCULINO', '01/02/1986'), repES(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('13.0', '8.0'), true),
                       hdrES('VEGA LUNA', 'ROSA MARIA', 'FEMENINO', '03/04/1956'), repES(Dd + ' 07:30', 'CIRUGIA GENERAL', BH('8.1', '15.2'), true)];
      await run([row('26-90003', p3.nombre, twinsES, { aliases: [p3.nombre, p4.nombre] })], [p3, p4]);
      out.W3 = { A: labsOf(p3), B: labsOf(p4) };
      const twinsIT = [hdrIT('MENDEZ ORTIZ', 'JUAN CARLOS', 'MASCHIO', '01/02/1986'), repIT(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('13.0', '8.0'), true),
                       hdrIT('VEGA LUNA', 'ROSA MARIA', 'FEMMINA', '03/04/1956'), repIT(Dd + ' 07:30', 'CIRUGIA GENERAL', BH('8.1', '15.2'), true)];
      await run([row('26-90003', p3.nombre, twinsIT, { aliases: [p3.nombre, p4.nombre] })], [p3, p4]);
      out.W4 = { A: labsOf(p3), B: labsOf(p4) };
      // Sin encabezados reconocibles y con los dos nombres en la fila: no se sabe de quién es cada reporte → de nadie.
      await run([row('26-90003', p3.nombre, [repES(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('13.0', '8.0'), true), repES(Dd + ' 07:30', 'CIRUGIA GENERAL', BH('8.1', '15.2'), true)], { aliases: [p3.nombre, p4.nombre] })], [p3, p4]);
      out.W5 = { A: labsOf(p3), B: labsOf(p4) };
      await run([row('26-90005', p5.nombre, [hdrIT('SALAS MORA', 'PEDRO', 'MASCHIO', '01/01/1993'), repIT(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('9.9', '12.0')), repIT(Ad + ' 06:10', 'NEUROCIRUGIA', BH('10.5', '11.0'))])], [p5]);
      out.W6 = labsOf(p5);
      await run([row('26-90006', p6.nombre, [hdrES('GARCIA LOPEZ', 'ANTONIA', 'FEMENINO', '09/09/1950'), repES(Ad + ' 06:10', 'MEDICINA INTERNA', BH('6.9', '22.0'))])], [p6]);
      out.W7 = labsOf(p6);
      await run([row('26-90006', p6.nombre, [hdrES('GARCIA LOPEZ', 'ANTONIO', 'MASCULINO', '01/01/1981'), repES(Dd + ' 06:10', 'CIRUGIA GENERAL', BH('12.0', '9.0'), true), hdrES('GARCIA LOPEZ', 'ANTONIO', 'MASCULINO', '09/09/1950'), repES(Dd + ' 09:10', 'MEDICINA INTERNA', BH('6.9', '22.0'), false)])], [p6]);
      out.W7b = labsOf(p6);
      out.W8 = mapSingleReportToLabs({ valores: [{ estudio: 'DENSIDAD', valor: '1.020' }, { estudio: 'PH', valor: '6.0' }, { estudio: 'LEUCOCITOS', valor: '3', unidad: '/CAMPO' }, { estudio: 'LEUCOCITOS', valor: '11.4', unidad: 'x10^3/uL', referencia: '4.5 - 11.0' }, { estudio: 'ERITROCITOS', valor: '4.1', unidad: 'x10^6/uL' }, { estudio: 'HEMOGLOBINA', valor: '12.1', unidad: 'g/dL' }, { estudio: 'HEMATOCRITO', valor: '36' }] });
      // Realtime: corrida del robot que reescribe la fila de los gemelos con el MISMO scraped_at.
      const sc = new Date(Date.now() - 600e3).toISOString();
      const r1 = row('26-90003', p3.nombre, twinsES.slice(0, 2)); r1.scraped_at = sc;
      const r2 = row('26-90003', p3.nombre, twinsES, { aliases: [p3.nombre, p4.nombre] }); r2.scraped_at = sc;
      winlabByExp = { '26-90003': r1 }; winlabRowsByExp = { '26-90003': [r1] }; _winlabExpIndex = null; _wlRtPending.clear();
      handleWinlabChange({ eventType: 'UPDATE', new: r2 });
      out.W9 = { same: winlabByExp['26-90003'] === r2, pending: Array.from(_wlRtPending).map(k => (patients.find(p => pid(p) === k) || {}).cama).sort() };
      const rOld = row('26-90003', p3.nombre, twinsES); rOld.fecha = A; rOld.scraped_at = sc;
      handleWinlabChange({ eventType: 'UPDATE', new: rOld });
      out.W9.oldIgnored = winlabByExp['26-90003'] === r2;
      return out;
    })();
  }, { D: ymd(d0), A: ymd(ayer), Dd: dmy(d0), Ad: dmy(ayer) }).catch(e => ({ err: String(e) }));
  const J = JSON.stringify, hb = (L) => (L || []).map(s => s.hb).join(',');
  check('W1 «FCO.» del censo = «FRANCISCO» de WinLab', hb(res.W1) === '11.2', J(res));
  check('W2 con «nombre en WinLab» entra aunque el encabezado use otro apellido; sin él, no', hb(res.W2) === '10.4' && hb(res.W2sin) === '', J([res.W2, res.W2sin]));
  check('W3 expediente repetido (fila juntada por el robot): cada cama recibe SOLO sus labs (3-160 ya no se queda sin)', res.W3 && hb(res.W3.A) === '13.0' && hb(res.W3.B) === '8.1', J(res.W3));
  check('W4 lo mismo con WinLab en italiano (antes 3-159 recibía los de 3-160)', res.W4 && hb(res.W4.A) === '13.0' && hb(res.W4.B) === '8.1', J(res.W4));
  check('W5 expediente repetido sin encabezados: nadie recibe labs que no se pueden atribuir', res.W5 && hb(res.W5.A) === '' && hb(res.W5.B) === '', J(res.W5));
  check('W6 WinLab en italiano + paciente de Neurocirugía: no se pierde el reporte pedido por Cirugía General', (res.W6 || []).length === 2 && /9\.9/.test(hb(res.W6)), J(res.W6));
  check('W7 homónimo de otro sexo (ANTONIA) nunca entra a la tarjeta de ANTONIO', hb(res.W7) === '', J(res.W7));
  check('W7b reporte que el robot NO marcó del paciente (__target:false) no se usa aunque el nombre coincida', hb(res.W7b) === '12.0', J(res.W7b));
  check('W8 EGO antes que la BH en el mismo reporte: Hb y leucos de sangre correctos', res.W8 && res.W8.hb === '12.1' && String(res.W8.leucos) === '11.4', J(res.W8));
  check('W9 Realtime: la fila reescrita con el mismo sello entra y se sincronizan las dos camas del expediente', res.W9 && res.W9.same && J(res.W9.pending) === '["3-159","3-160"]', J(res.W9));
  check('W9b Realtime: con el mismo sello, una fecha más vieja no reemplaza la más nueva', res.W9 && res.W9.oldIgnored, J(res.W9));
  const chips = await page.evaluate(() => {
    const p = patients[0]; const k = pid(p);
    const nd = defaultData();
    nd.labHistory = [
      { fecha: '2026-10-24', labs: { hb: '12.0' }, source: 'winlab' },
      { fecha: '2026-10-25', labs: { hb: '10.0' }, source: 'winlab' },
      { fecha: '2026-10-26', labs: { hb: '8.0', tp: '18', tp_testigo: '12' }, source: 'winlab' },
    ];
    noteData[k] = nd; activeLabDate[k] = '2026-10-26';
    let host = document.getElementById('card-' + k);
    if (!host) { host = document.createElement('div'); host.id = 'card-' + k; document.body.appendChild(host); }
    host.innerHTML = renderLabSection(nd, k);
    const cell = (key) => { const inp = host.querySelector('.lab-input[data-labkey="' + key + '"]'); const c = inp.closest('.lab-cell'); return { value: inp.value, ph: inp.placeholder, text: c.innerText.replace(/\s+/g, ' ').trim(), html: host.innerHTML.length }; };
    const before = { hb: cell('hb'), inr: cell('inr'), anemia: /Anemia/i.test(host.innerText) };
    setActiveLabDate(k, '2026-10-24');
    const after = { hb: cell('hb'), inr: cell('inr'), anemia: /Anemia/i.test(host.innerText), active: (host.querySelector('.lab-date-chip.active') || {}).textContent || '' };
    return { before, after };
  }).catch(e => ({ err: String(e) }));
  check('W10 chip de fecha: valores, tendencia, sugerencias e INR estimado son los de la fecha elegida', chips.after && chips.after.hb.value === '12.0' && !/[↓↑]/.test(chips.after.hb.text) && !/1[.,]5/.test(chips.after.inr.ph + chips.after.inr.value) && !chips.after.anemia && (/[↓↑]/.test(chips.before.hb.text) || /1[.,]5/.test(chips.before.inr.ph + chips.before.inr.value) || chips.before.anemia), J(chips));
  check('final: sin errores de JavaScript en la página', errors.length === 0 && !res.err && !chips.err, J([res.err, chips.err, errors.slice(0, 3)]));
  console.log(`\n${pass} pass, ${fail} fail`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
