// 🩺 Seguridad clínica (lote B, 27 oct 2026). Casos reales de winlab_labs (solo nombres de estudio, valores y unidades)
// y de la revisión de la app, con pacientes ficticios:
// · muestra rechazada (TP «MUESTRA MAL AFORADA» = 11.00 = límite del rango) y unidades (troponina en ng/mL, glucosa en
//   MINUTOS, 25-OH, cristales de orina, unidad desconocida);
// · tabla única de valores críticos (glucosa 210, leucos 15, PCR 200, Hb 7.5… ya no son rojo) y mensajes rápidos
//   (fibrinógeno en mg/dL, dímero D en ng/mL, sin dosis peligrosas);
// · calculadora (CE con fórmula correcta, sin 70 kg supuestos, Na con clasificación estándar), peso predicho sin sexo,
//   INR con ISI, antibiograma SDD, borrador sin dosis ni pronóstico inventados, LRA sin basal, revisión de la nota IA,
//   Análisis IA con rangos de la tabla y sin dosis.
// node tests/headless/app_clin.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok' }));
  window.prompt=function(){ return null; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PTS = [
  { id: 'c1', cama: '3-301', exp: '26-80001', nombre: 'JUAN PEREZ SOTO', esp: 'CG', edad: '50', sexo: 'M', dx: 'APENDICITIS AGUDA' },
  { id: 'c2', cama: '3-302', exp: '26-80002', nombre: 'MARIA LOPEZ RUIZ', esp: 'CG', edad: '64', sexo: 'F', dx: 'COLECISTITIS + ERC EN HEMODIALISIS' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const aiBodies = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/api/ai', async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) {}
    const c = body && body.messages && body.messages[0] && body.messages[0].content;
    aiBodies.push(typeof c === 'string' ? c : (c && c[0] && c[0].text) || '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '{"alteraciones":[],"resumen":"ok","prioridad":"baja"}' }] }) });
  });
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
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  // ── C1: muestra rechazada ──
  const c1 = await page.evaluate(() => {
    const v = (estudio, valor, unidad) => ({ estudio, valor, unidad, referencia: '' });
    const coag = [v('TIEMPO DE PROTROMBINA MUESTRA MAL AFORADA', '11.00', '-'), v('TESTIGO', '12.5', 'segundos'), v('TIEMPO DE TROMBOPLASTINA PARCIAL MUESTRA MAL AFORADA', '26.00', '-')];
    const a = mapWinlabReportesToLabs([{ valores: coag }]);
    const bh = mapWinlabReportesToLabs([{ valores: [v('HEMOGLOBINA MUESTRA COAGULADA', '12.00', '-'), v('PLAQUETAS MUESTRA COAGULADA', '130', '-'), v('VOL. CORPUSCULAR MEDIO MUESTRA COAGULADA', '80.00', '-'), v('MUESTRA COAGULADA', '11.00', '-')] }]);
    // En el mismo reporte un TP real gana sobre el rechazado (venga antes o después)
    const real = mapWinlabReportesToLabs([{ valores: [v('TIEMPO DE PROTROMBINA MUESTRA COAGULADA', '11.00', '-'), v('TIEMPO DE PROTROMBINA', '13.4', 'segundos')] }]);
    // EGO sin muestra: no marca llaves de sangre ni del EGO
    const ego = mapWinlabReportesToLabs([{ valores: [v('GLUCOSA', '95', 'mg/dL'), v('DENSIDAD SIN MUESTRA', '0', '-'), v('LEUCOCITOS SIN MUESTRA', '0', '')] }]);
    // Dos tomas el mismo día: la nueva fue rechazada → se queda el TP real de la anterior
    const row = { exp: '26-80001', fecha: '2026-10-26', scraped_at: new Date().toISOString(), data: { reportes: [
      { __cells: ['', '', '1', '26/10/2026 18:00', '26/10/2026 19:00', 'CG'], valores: [v('TIEMPO DE PROTROMBINA MUESTRA MAL AFORADA', '11.00', '-'), v('TESTIGO', '12.5', 'segundos')] },
      { __cells: ['', '', '1', '26/10/2026 06:00', '26/10/2026 07:00', 'CG'], valores: [v('TIEMPO DE PROTROMBINA', '14.8', 'segundos'), v('TESTIGO', '12.5', 'segundos')] }] } };
    const snaps = buildWinlabLabSnapshots(row, null, null);
    const cell = labCellHtml(LAB_FIELDS.find(f => f.key === 'tp'), a.tp, 'k1', '2026-10-26', undefined, null);
    const ent = (function () { const nd = defaultData(); nd.labHistory = [{ fecha: _egIsoOffset(0), labs: Object.assign({ hb: '9.1' }, a) }]; return _egLabsPuntuales(nd); })();
    return { a, inr: inrOf(a), bh, real, ego, snapTp: snaps.length === 1 ? snaps[0].labs.tp : 'n=' + snaps.length, cellAviso: /lab-aviso/.test(cell) && /⚠/.test(cell) && !/lab-cell crit|lab-input crit/.test(cell) && /rechazada/i.test(cell), entTxt: ent ? ent.items.map(i => i.text) : null };
  });
  check('C1 muestra rechazada: TP/TTP «MUESTRA MAL AFORADA» (11.00 = límite del rango) quedan RECHAZADA y no hay INR estimado; BH coagulada igual; un TP real gana en el mismo reporte y en el mismo día; «SIN MUESTRA» del EGO no marca nada; la celda avisa (⚠, sin rojo) y la entrega pide repetir',
    c1.a.tp === 'RECHAZADA' && c1.a.ttp === 'RECHAZADA' && c1.a.tp_testigo === '12.5' && c1.inr === null
    && c1.bh.hb === 'RECHAZADA' && c1.bh.plaq === 'RECHAZADA' && c1.bh.mcv === 'RECHAZADA'
    && c1.real.tp === '13.4' && c1.ego.glu === '95' && !('ego_dens' in c1.ego) && !('ego_leuco' in c1.ego) && !('leucos' in c1.ego)
    && c1.snapTp === '14.8' && c1.cellAviso && Array.isArray(c1.entTxt) && c1.entTxt.some(t => /TP muestra rechazada — repetir/.test(t)), JSON.stringify(c1));

  // ── C2: unidades ──
  const c2 = await page.evaluate(() => {
    const v = (estudio, valor, unidad) => ({ estudio, valor, unidad, referencia: '' });
    const m = (vals) => mapWinlabReportesToLabs([{ valores: vals }]);
    return {
      tropNg: m([v('TROPONINA I', '0.08', 'ng/mL')]).tropI, tropNgAlta: m([v('TROPONINA I', '8.45', 'NG/ML')]).tropI, tropPg: m([v('TROPONINA I', '10.14', 'pg/mL')]).tropI,
      gluMin: m([v('GLUCOSA', '120', 'MINUTOS'), v('GLUCOSA', '98', 'mg/dL')]).glu, gluNeg: m([v('GLUCOSA', 'NEGATIVO', ''), v('GLUCOSA', '101', 'mg/dL')]).glu,
      fibOH: m([v('FIBRINOGENO CLAUSS', '25', '-OH')]).fibrinogeno, fibGL: m([v('FIBRINOGENO CLAUSS', '2.5', 'g/L')]).fibrinogeno, fibOk: m([v('FIBRINOGENO CLAUSS', '310', 'mg/dL')]).fibrinogeno,
      caCrist: m([v('CALCIO', '11.44', 'p/μL')]).ca, pVerif: m([v('FOSFORO', '1.6', 'VERIFICADO')]).p, kRaro: m([v('POTASIO', '4.1', 'mg/dL')]).k,
      leuOrina: m([v('LEUCOCITOS', '2', '-1')]).leucos, leuSangre: m([v('LEUCOCITOS', '9.8', '10³/μL')]).leucos, plaqSin: m([v('PLAQUETAS', '150', '')]).plaq,
      gluMmol: m([v('GLUCOSA', '5.5', 'mmol/L')]).glu, ckmb: m([v('CKMB', '<16', '')]).ck_mb, ttpOH: m([v('TIEMPO DE TROMBOPLASTINA PARCIAL', '25', '-OH')]).ttp,
      dimUg: m([v('DIMERO D', '0.8', 'ug/mL')]).dimero_d
    };
  });
  check('C2 unidades: troponina I en ng/mL → pg/mL (0.08 → 80, 8.45 → 8450), glucosa en MINUTOS y «NEGATIVO» no ocupan la llave, 25-OH y cristales de orina se descartan, FOSFORO «VERIFICADO» se guarda, g/L y mmol/L se convierten, unidad desconocida → REVISAR UNIDAD (no un número)',
    c2.tropNg === '80' && c2.tropNgAlta === '8450' && c2.tropPg === '10.14' && c2.gluMin === '98' && c2.gluNeg === '101'
    && c2.fibOH === undefined && c2.fibGL === '250' && c2.fibOk === '310' && c2.caCrist === undefined && c2.pVerif === '1.6' && /^REVISAR UNIDAD \(mg\/dL\)$/.test(c2.kRaro)
    && c2.leuOrina === undefined && c2.leuSangre === '9.8' && c2.plaqSin === '150' && c2.gluMmol === '99' && c2.ckmb === '<16' && c2.ttpOH === undefined && c2.dimUg === '800', JSON.stringify(c2));

  // ── C3: tabla única de críticos ──
  const c3 = await page.evaluate(() => {
    const keys = (labs) => getCriticalLabItemsFromSnapshot({ fecha: '2026-10-27', labs }).map(c => c.key + '=' + c.value).sort();
    const soloAlterados = keys({ glu: '210', leucos: '15', pcr: '200', hb: '7.5', alb: '2.2', bt: '2.5', lipasa: '500', amilasa: '400', cr: '3.4', pct: '4', ast: '250', dimero_d: '6000', p: '5', tp: '22' });
    const criticos = keys({ k: '6.2', na: '119', hb: '6.9', glu: '45', tp: '40', tp_testigo: '12', fibrinogeno: '90', lac: '4.4' });
    const nd = defaultData(); nd.labHistory = [{ fecha: _egIsoOffset(0), labs: { glu: '210', leucos: '15', hb: '7.5', pcr: '200' } }];
    const semaforo = computePatientStatus(nd, 'x');
    const nd2 = defaultData(); nd2.labHistory = [{ fecha: _egIsoOffset(0), labs: { k: '6.2' } }];
    const cellGlu = labCellHtml(LAB_FIELDS.find(f => f.key === 'glu'), '210', 'k', '2026-10-27', undefined, null);
    return { soloAlterados, criticos, semaforo, semaforo2: computePatientStatus(nd2, 'x'), gluAbn: /lab-cell abn/.test(cellGlu) && !/lab-cell crit|lab-input crit/.test(cellGlu), cellGlu: cellGlu.slice(0, 300) };
  });
  check('C3 tabla única de valores críticos: glucosa 210, leucos 15, PCR 200, Hb 7.5, Alb 2.2, BT 2.5, lipasa 500, Cr 3.4, PCT 4, AST 250, dímero D 6000 ya NO son rojo (amarillo); K 6.2, Na 119, Hb 6.9, glucosa 45, fibrinógeno 90, lactato 4.4 e INR estimado 3.33 sí; el semáforo sigue la misma tabla',
    c3.soloAlterados.length === 0 && JSON.stringify(c3.criticos) === JSON.stringify(['fibrinogeno=90', 'glu=45', 'hb=6.9', 'inr=≈3.33', 'k=6.2', 'lac=4.4', 'na=119'])
    && c3.semaforo !== 'red' && c3.semaforo2 === 'red' && c3.gluAbn, JSON.stringify(c3));

  // ── C4: mensajes rápidos ──
  const c4 = await page.evaluate(() => {
    const q = (k, v) => labQuick(k, v);
    const all = Object.keys(LAB_QUICK).map(k => [k, LAB_QUICK[k]]).flatMap(([k, f]) => [0.5, 1, 2, 6, 7, 50, 100, 200, 500, 5000].map(v => { const r = f(v); return r ? r.rec + ' ' + r.title : ''; })).join(' | ');
    return {
      fib80: q('fibrinogeno', 80), fib150: q('fibrinogeno', 150), fib350: q('fibrinogeno', 350), fib450: q('fibrinogeno', 450),
      dd300: q('dimero_d', 300), dd800: q('dimero_d', 800), dd08: q('dimero_d', 0.8),
      hb65: q('hb', 6.5), mg11: q('mg', 1.1), lip500: q('lipasa', 500), inr35: q('inr', 3.5), glu250: q('glu', 250), k27: q('k', 2.7),
      peligrosas: /indicada|1-2g\/h|hidrataci[oó]n IV agresiva|hidrataci[oó]n agresiva IV|Vitamina K IV 10mg|20-40mEq\/h|TEP\/TVP probable|<1\.5 g\/L|g\/L con sangrado|≥1 µg\/mL/i.test(all.replace(/evitar la hidratación agresiva/gi, ''))
    };
  });
  check('C4 mensajes rápidos: fibrinógeno en mg/dL (80 → críticamente bajo/rojo, 150 → bajo, 350 → normal, 450 → elevado), dímero D en ng/mL (300 normal, 800 elevado sin «TEP probable» ni rojo, 0.8 → revisa la unidad); sin «indicada», Mg 1-2 g/h, hidratación agresiva, vitamina K fija ni KCl 40 mEq/h; INR alto pregunta por anticoagulante',
    c4.fib80 && c4.fib80.sev === 'crit' && /críticamente bajo/.test(c4.fib80.title) && c4.fib150 && c4.fib150.sev === 'abn' && /bajo/.test(c4.fib150.title) && c4.fib350 === null && /elevado/.test(c4.fib450.title)
    && c4.dd300 === null && c4.dd800 && c4.dd800.sev === 'abn' && /DESCARTAR/.test(c4.dd800.rec) && /unidad/.test(c4.dd08.title)
    && /1 CE/.test(c4.hb65.rec) && c4.hb65.sev === 'crit' && /REDUCIR/.test(c4.mg11.rec) && /moderada/.test(c4.lip500.rec) && c4.lip500.sev === 'abn' && /anticoagulante/.test(c4.inr35.rec) && c4.glu250.sev === 'abn' && /10 mEq\/h/.test(c4.k27.rec)
    && !c4.peligrosas, JSON.stringify(c4).slice(0, 1500));

  // ── C5: calculadora de corrección ──
  const c5 = await page.evaluate(() => {
    const k = pid(patients[1]); const ndS = getNote(k); ndS.checklist.sexo = 'F'; noteData[k] = ndS; openCorreccionModal(k);
    const run = (tab, vals) => { setCorrecTab(tab); Object.keys(vals).forEach(id => { const el = document.getElementById(id); if (el) el.value = vals[id]; }); calcCorrec(); return document.querySelector('.cm-result-' + tab).textContent; };
    const out = {
      hb6: run('hb', { 'cm-hb-val': '6', 'cm-hb-meta': '10', 'cm-hb-peso': '70' }), hb6m8: run('hb', { 'cm-hb-val': '6', 'cm-hb-meta': '8', 'cm-hb-peso': '50' }),
      hbSinPeso: run('hb', { 'cm-hb-val': '6.5', 'cm-hb-meta': '8', 'cm-hb-peso': '' }), hbMuchas: run('hb', { 'cm-hb-val': '5', 'cm-hb-meta': '10', 'cm-hb-peso': '90' }),
      metaDef: (setCorrecTab('hb'), document.getElementById('cm-hb-meta').value),
      kSinPeso: run('k', { 'cm-k-val': '3.0', 'cm-k-peso': '' }), kPeso: run('k', { 'cm-k-val': '3.0', 'cm-k-peso': '50' }), k53: run('k', { 'cm-k-val': '5.3', 'cm-k-peso': '' }),
      na128: run('na', { 'cm-na-val': '128', 'cm-na-peso': '60' }), na122: run('na', { 'cm-na-val': '122', 'cm-na-peso': '' }), na148: run('na', { 'cm-na-val': '148', 'cm-na-peso': '60' }),
      naMeta: !!document.getElementById('cm-na-meta')
    };
    document.getElementById('correc-modal').classList.remove('open');
    return out;
  });
  check('C5 calculadora: CE ≈ (meta − Hb) × peso ÷ 70 (Hb 6→10 en 70 kg = ~4, no 86; 6→8 en 50 kg = ~1), meta por defecto 8 con umbral 7, aviso >4 CE; sin peso pide el peso (K y Hb, sin suponer 70 kg); K 5.3 ya es hiperkalemia; Na con clasificación estándar, agua corporal de mujer (0.5) y cuánto sube 1 L de SS 3%; Na 148 es hipernatremia; sin campo «meta 140»',
    /~4 \(1 CE/.test(c5.hb6) && !/86/.test(c5.hb6) && /~1 \(1 CE/.test(c5.hb6m8) && /Captura el peso/.test(c5.hbSinPeso) && /Más de 4 CE/.test(c5.hbMuchas) && c5.metaDef === '8' && /Umbral restrictivo 7/.test(c5.hb6)
    && /Captura el peso/.test(c5.kSinPeso) && !/mEq \(aprox/.test(c5.kSinPeso) && /~10 mEq/.test(c5.kPeso) && /Hiperkalemia/.test(c5.k53)
    && /Hiponatremia moderada/.test(c5.na128) && /30 L \(mujer 0\.5/.test(c5.na128) && /SS 3% sube ≈ 12\.4/.test(c5.na128) && /HIPONATREMIA GRAVE/.test(c5.na122) && /Captura el peso/.test(c5.na122)
    && /Hipernatremia/.test(c5.na148) && /Déficit de agua libre: 1\.7 L/.test(c5.na148) && !c5.naMeta, JSON.stringify(c5));

  // ── C6: peso predicho, INR con ISI, antibiograma SDD ──
  const c6 = await page.evaluate(() => {
    const out = { pbwSin: vmPbw(160, ''), pbwF: Math.round(vmPbw(160, 'F') * 10) / 10, pbwM: Math.round(vmPbw(160, 'Masculino') * 10) / 10 };
    out.inr1 = inrOf({ tp: '17.5', tp_testigo: '12.5' }).txt; PL_INR_ISI = 1.3; out.inr13 = inrOf({ tp: '17.5', tp_testigo: '12.5' }).txt; PL_INR_ISI = 1.0;
    out.sdd = _abLists([{ antibiotico: 'CEFEPIMA', interp: 'SDD', cim: '4' }, { antibiotico: 'MEROPENEM', interp: 'S', cim: '<=0.25' }, { antibiotico: 'CIPROFLOXACINO', interp: 'R', cim: '' }]);
    return out;
  });
  check('C6 peso predicho sin sexo = sin cálculo (antes suponía hombre); INR estimado = (TP ÷ testigo)^ISI (1.40 con ISI 1, 1.55 con ISI 1.3); SDD conserva «dosis alta» junto a los sensibles',
    c6.pbwSin === null && c6.pbwF === 52.4 && c6.pbwM === 56.9 && c6.inr1 === '1.40' && c6.inr13 === '1.55'
    && c6.sdd.sensibles[0] === 'CEFEPIMA (SDD: dosis alta) 4' && c6.sdd.sensibles[1] === 'MEROPENEM <=0.25' && c6.sdd.resistentes[0] === 'CIPROFLOXACINO', JSON.stringify(c6));

  // ── C7: borrador de la nota sin datos inventados + LRA sin basal ──
  const c7 = await page.evaluate(() => {
    const p = patients[0]; const nd = defaultData(); const ck = nd.checklist;
    ck.tvp = true; ck.tvp_tipo = 'enoxaparina'; ck.tvp_dosis = ''; ck.atb = true; ck.atb_nombre = 'CEFTRIAXONA'; ck.atb_dias = '2';
    ck.dispositivos = [{ id: 'd1', tipo: 'Foley', lado: '', sitio: '', gasto: '', carac: '', fi: '' }];
    const draft = _plneBuild(p, nd);
    const aki = (pt, hist) => { const n = defaultData(); n.labHistory = hist; n.dx = pt.dx; return PLCDS.evaluate(pt, n).filter(s => s.ruleId === 'aki').map(s => s.result.stage + (s.critical ? '!' : '')); };
    const sinBasal = aki(patients[0], [{ fecha: '2026-10-27', labs: { cr: '4.5' } }]);
    const conBasal = aki(patients[0], [{ fecha: '2026-10-20', labs: { cr: '1.0' } }, { fecha: '2026-10-27', labs: { cr: '4.5' } }]);
    const erc = aki(patients[1], [{ fecha: '2026-10-20', labs: { cr: '5.0' } }, { fecha: '2026-10-27', labs: { cr: '7.5' } }]);
    return { draft, sinBasal, conBasal, erc };
  });
  check('C7 borrador: enoxaparina sin dosis → [DOSIS Y FRECUENCIA] (ya no «40 MG CADA 24 HORAS»), pronóstico → [PRONÓSTICO], Foley → [¿PERMEABLE A DERIVACIÓN?], sin «DURACIÓN GUIADA…»; LRA: Cr 4.5 sin basal no se sugiere, con basal 1.0 es etapa 3, con ERC en hemodiálisis no se sugiere',
    /ENOXAPARINA \[DOSIS Y FRECUENCIA\] SUBCUTÁNEA/.test(c7.draft) && !/40 MG|CADA 24 HORAS/.test(c7.draft) && /CON PRONÓSTICO \[PRONÓSTICO\]\./.test(c7.draft) && /FOLEY \[¿PERMEABLE A DERIVACIÓN\?\]/.test(c7.draft) && !/DURACIÓN GUIADA/.test(c7.draft)
    && c7.sinBasal.length === 0 && c7.conBasal.join() === '3!' && c7.erc.length === 0, JSON.stringify({ ...c7, draft: c7.draft.slice(-700) }));

  // ── C8: revisión de lo que agrega la IA ──
  const c8 = await page.evaluate(() => {
    const fuente = 'PACIENTE CON FC 98 LPM. CEFTRIAXONA (DÍA 2). ESTADO DE SALUD DELICADO, CON PRONÓSTICO [PRONÓSTICO].';
    const nota = 'PACIENTE CON FC 98 LPM, META PAM ≥ 65 MMHG (SURVIVING SEPSIS CAMPAIGN 2021). CEFTRIAXONA DÍA 2 Y OMEPRAZOL 40 MG IV, PROFILAXIS DE ÚLCERA POR ESTRÉS, CMH2O. ESTADO DE SALUD DELICADO, CON PRONÓSTICO RESERVADO A EVOLUCIÓN.';
    const marcas = _plneRevisar(nota, fuente).map(m => m.t);
    const html = _plneHtml('A [FALTA] 3 < 4', [{ i: 10, f: 11, t: '3' }]);
    return { marcas, html };
  });
  check('C8 revisión de la nota con IA: se marcan OMEPRAZOL, 40, PROFILAXIS DE ÚLCERA POR ESTRÉS y el pronóstico que nadie capturó; no se marcan las cifras de la fuente, las metas (65), el año de la guía ni el «2» de CMH2O; el HTML escapa el texto y marca los [corchetes]',
    JSON.stringify(c8.marcas) === JSON.stringify(['OMEPRAZOL', '40', 'PROFILAXIS DE ÚLCERA POR ESTRÉS', 'RESERVADO A EVOLUCIÓN'])
    && c8.html === 'A <mark class="plne-falta" title="Dato que falta: complétalo antes de pegar la nota">[FALTA]</mark> <mark class="plne-nuevo" title="La IA escribió esto y NO venía en la tarjeta. Revísalo; toca para marcarlo como revisado.">3</mark> &lt; 4', JSON.stringify(c8));

  // ── C9: 🧠 Análisis IA: rangos de la tabla (mg/dL) y sin dosis ──
  const c9 = await page.evaluate(async () => {
    const k = pid(patients[0]); const nd = getNote(k); nd.labHistory = [{ fecha: '2026-10-27', labs: { ca: '7.6', mg: '1.5', k: '3.1' } }]; noteData[k] = nd;
    await analyzeLabsAI(k, '2026-10-27');
    return true;
  });
  const prompt9 = aiBodies[aiBodies.length - 1] || '';
  check('C9 🧠 Análisis IA: los rangos salen de la tabla de la app (Ca 8.5–10.5 mg/dL con crítico ≤6.5, Mg en mg/dL; ya no 2.1/0.7/0.81 mmol/L), «crítica» solo en el rango crítico, pide sugerencias SIN dosis y explica RECHAZADA',
    c9 && /Ca \(mg\/dL\): normal 8\.5–10\.5 mg\/dL; CRÍTICO ≤6\.5 o ≥13 mg\/dL/.test(prompt9) && /Mg \(mg\/dL\): normal 1\.7–2\.4/.test(prompt9) && !/<2\.1|<0\.7|<0\.81/.test(prompt9)
    && /NO escribas dosis/.test(prompt9) && /sugerencia para considerar, sin dosis/.test(prompt9) && !/tratamiento específico con dosis/.test(prompt9) && /RECHAZADA/.test(prompt9), prompt9.slice(0, 600));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-CLIN: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
