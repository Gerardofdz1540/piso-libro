// Cultivos WinLab (formatos reales), la Cronología sin nada automático (labs, RIS, cultivos, ✨ Resumen), nota de
// evolución completa y paciente que reaparece (nota restaurada antes de mostrar la tarjeta).
//   node tests/headless/app_nota.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const fs = require('fs'); const path = require('path');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture_ego_bh.json'), 'utf8'));
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const iso = (d) => d.toISOString().slice(0, 10);
const today = iso(new Date()); const ayer = iso(new Date(Date.now() - 86400e3));
(async()=>{
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  // Nota "restaurada" en la nube para el paciente que reaparece (b2): labs + pendientes
  const restoredNote = { patient_id: 'b2', app: '', pa: '', drenajes: '', qx: 'LAPE 10/10', manejo: '', sangrado: '', sv: '', balance: '', pendientes: 'PERFIL DE HIERRO', checklist: { atb: true, atb_nombre: 'CEFTRIAXONA', atb_dias: '4' },
    lab_history: [{ fecha: ayer, labs: { hb: '7.7', leucos: '28.34', cr: '0.94', k: '4.38' }, source: 'winlab' }], imagen_history: [] };
  const oldWl = { exp: '26-23107', paciente: 'LOPEZ RUIZ ANA', fecha: '2026-10-09', scraped_at: new Date(Date.now() - 6 * 86400e3).toISOString(),
    data: { headers: [], reportes: [{ __cells: ['', '', '', '09/10/2026 06:10', '09/10/2026 08:00', '', ''], __hasLink: true, valores: FIX.valores.map(v => v.estudio === 'HEMOGLOBINA' ? { ...v, valor: '8.1' } : v) }] } };
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-170', exp: '24-99901', nombre: 'RUIZ SOTO MATEO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'CHOQUE SÉPTICO DE ORIGEN ABDOMINAL, PO LAPE + DRENAJE DE COLECCIÓN, DM2, HAS', adscrito: 'DR GARNELO MBCG', residente: 'DR FERNÁNDEZ R2CG' }]);
      return json(201, [{ id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET' && /patient_id=eq\.b2/.test(url)) return json(200, [restoredNote]);
      if (m === 'GET') return json(200, []);
      return json(201, [{ patient_id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/winlab_labs')) { return json(200, /26-23107|2623107/.test(decodeURIComponent(url)) && !/scraped_at=gte/.test(url) ? [oldWl] : []); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── N1: cultivos en los formatos reales de WinLab (el resultado vive en `valor`) ──
  const n1 = await page.evaluate(() => {
    const c1 = extractWinlabCulture({ valores: [{ estudio: 'LEUCOCITOS', valor: '2', unidad: '-10', referencia: 'X CAMPO 0 - 5' }, { estudio: 'CULTIVO', valor: 'NO DESARROLLO', unidad: '', referencia: 'SIN DESARROLLO' }] });
    const c2 = extractWinlabCulture({ valores: [{ estudio: 'CULTIVO', valor: 'POSITIVO', unidad: '', referencia: 'Sin desarrollo' }] });
    const c3 = extractWinlabCulture({ valores: [{ estudio: 'HEMOCULTIVO PERIFERICO', valor: '1', unidad: 'DESARROLLO', referencia: '' }, { estudio: 'NEGATIVO A', valor: '5', unidad: 'DIAS', referencia: '' }] });
    const c4 = extractWinlabCulture({ valores: [{ estudio: 'CULTIVO', valor: 'Klebsiella pneumoniae', unidad: '', referencia: 'Sin desarrollo', seccion: 'UROCULTIVO' }] });
    const c5 = extractWinlabCulture({ valores: [{ estudio: 'CULTIVO', valor: '', unidad: '', referencia: 'Escherichia coli' }] });
    const c6 = extractWinlabCulture({ valores: [{ estudio: 'GLUCOSA', valor: '93', unidad: 'mg/dL', referencia: '74-106' }] });
    return { c1, c2, c3, c4, c5, c6 };
  });
  check('N1 cultivos WinLab: NO DESARROLLO → negativo; valor POSITIVO (ref "Sin desarrollo") → POSITIVO; HEMOCULTIVO "NEGATIVO A 5 DIAS" → hemocultivo negativo a 5 días; germen en valor → positivo con germen y tipo por sección; germen en referencia (formato viejo) → positivo; sin cultivo → null',
    n1.c1 && !n1.c1.positivo && /Sin desarrollo/.test(n1.c1.organismo)
    && n1.c2 && n1.c2.positivo && /POSITIVO/.test(n1.c2.organismo)
    && n1.c3 && !n1.c3.positivo && n1.c3.tipo === 'Hemocultivo' && /5 días/.test(n1.c3.organismo)
    && n1.c4 && n1.c4.positivo && /Klebsiella/.test(n1.c4.organismo) && n1.c4.tipo === 'Urocultivo'
    && n1.c5 && n1.c5.positivo && /Escherichia/.test(n1.c5.organismo)
    && n1.c6 === null, JSON.stringify(n1));

  // ── N1b: cultivo parseado del PDF por el robot (rep.cultivo): germen, BLEE, antibiograma S/I/R y reporte íntegro en la tarjeta ──
  // Fechas relativas (la Entrega solo anota cultivos de los últimos 10 días; una fecha fija caducaba): muestra hace 2 días, reporte hoy.
  const _fx = (d) => { const s = iso(d); return { iso: s, cells: s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4), dot: s.slice(8, 10) + '.' + s.slice(5, 7) + '.' + s.slice(0, 4) }; };
  const N1B_D = { c: _fx(new Date(Date.now() - 2 * 86400e3)), r: _fx(new Date()) };
  const n1b = await page.evaluate((D) => {
    const k = pid(patients[0]); focusGoTo(k);
    const rep = { __cells: ['', '', '', D.c.cells + ' 06:00', D.r.cells + ' 08:00'], __hasLink: true, __target: true,
      valores: [{ estudio: 'CULTIVO', valor: 'POSITIVO', referencia: 'Sin desarrollo' }],
      cultivo: { v: 2, tipo: 'Urocultivo', muestra: 'ORINA', resultado: 'POSITIVO', germenes: ['Klebsiella pneumoniae (BLEE)'], blee: true, carbapenemasa: false, mrsa: false, ufc: '> 100,000 UFC/ML',
        antibiograma: [{ antibiotico: 'Amikacina', cim: '<=2', interp: 'S' }, { antibiotico: 'Meropenem', cim: '', interp: 'S' }, { antibiotico: 'Ciprofloxacino', cim: '>=4', interp: 'R' }, { antibiotico: 'Nitrofurantoina', cim: '', interp: 'I' }],
        secciones: [{ nombre: 'HEMOCULTIVO PERIFERICO 1', tipo: 'Hemocultivo periférico 1', muestra: '', resultado: 'NEGATIVO', detalle: 'negativo a 5 días', germenes: [], antibiograma: [] },
          { nombre: 'UROCULTIVO', tipo: 'Urocultivo', muestra: 'ORINA', resultado: 'POSITIVO', detalle: '', germenes: [{ nombre: 'Klebsiella pneumoniae', flags: ['BLEE'], ufc: '> 100,000 UFC/ML', deteccion: '', antibiograma: [{ antibiotico: 'Amikacina', cim: '<=2', interp: 'S' }, { antibiotico: 'Meropenem', cim: '', interp: 'S' }, { antibiotico: 'Ciprofloxacino', cim: '>=4', interp: 'R' }, { antibiotico: 'Nitrofurantoina', cim: '', interp: 'I' }] }],
            antibiograma: [{ antibiotico: 'Amikacina', cim: '<=2', interp: 'S' }, { antibiotico: 'Meropenem', cim: '', interp: 'S' }, { antibiotico: 'Ciprofloxacino', cim: '>=4', interp: 'R' }, { antibiotico: 'Nitrofurantoina', cim: '', interp: 'I' }] }] },
      cultivo_texto: 'UROCULTIVO\nMICROORGANISMO AISLADO: Klebsiella pneumoniae BLEE\nAMIKACINA <=2 S' };
    const c = extractWinlabCulture(rep);
    const cults = buildWinlabCultures({ exp: patients[0].exp, paciente: patients[0].nombre, fecha: D.r.iso, data: { reportes: [rep] } });
    _winlabCultByK[k] = cults;
    _rerenderCard(k);
    const box = document.querySelector('#card-' + CSS.escape(k) + ' .cultivos-box');
    const chips = box ? Array.from(box.querySelectorAll('.cultivo-chip')).map(x => x.textContent.replace(/\s+/g, ' ')) : [];
    const items = cults.map(x => ({ text: _cultTexto(x, false) }));
    const nota = _plneBuild(patients[0], getNote(k));
    return { nSec: Array.isArray(c) ? c.length : 0, uro: Array.isArray(c) ? c[1] : null, n: cults.length, fechas: cults.map(x => x.fecha), tipos: cults.map(x => x.tipo), chips, pre: !!(box && box.querySelector('.cultivo-chip details pre')), entrega: items.map(i => i.text), nota: /CULTIVOS: [^\n]*/.exec(nota) ? /CULTIVOS: [^\n]*/.exec(nota)[0].slice(0, 400) : '' };
  }, N1B_D);
  const _cDot = N1B_D.c.dot.replace(/\./g, '\\.');
  check('N1b cultivo del PDF (2 muestras): una entrada por muestra; urocultivo con germen + BLEE + UFC y S/I/R en la tarjeta con el reporte completo plegable; hemocultivo negativo a 5 días; la entrega y la nota dicen a qué es sensible y resistente',
    n1b.nSec === 2 && n1b.uro && n1b.uro.positivo && /Klebsiella pneumoniae \(BLEE\)/.test(n1b.uro.organismo) && n1b.uro.germenes[0].sensibles.length === 2 && n1b.uro.germenes[0].resistentes.length === 1
    && n1b.n === 2 && n1b.fechas.every(f => f === N1B_D.c.iso) && n1b.tipos.includes('Hemocultivo periférico 1') && n1b.tipos.includes('Urocultivo')
    && n1b.chips.some(ch => /Urocultivo/.test(ch) && /PDF/.test(ch) && /Klebsiella pneumoniae \(BLEE\)/.test(ch) && /100,000 UFC/.test(ch) && /S: Amikacina <=2, Meropenem/.test(ch) && /I: Nitrofurantoina/.test(ch) && /R: Ciprofloxacino >=4/.test(ch))
    && n1b.chips.some(ch => /Hemocultivo periférico 1/.test(ch) && /Sin desarrollo \(negativo a 5 días\)/.test(ch)) && n1b.pre
    && n1b.entrega.includes('Urocultivo POSITIVO a Klebsiella pneumoniae (BLEE) > 100,000 UFC/ML (S: Amikacina <=2, Meropenem; I: Nitrofurantoina; R: Ciprofloxacino >=4)')
    && n1b.entrega.includes('Hemocultivo periférico 1 sin desarrollo (negativo a 5 días)')
    && new RegExp('UROCULTIVO DEL ' + _cDot + ' POSITIVO A KLEBSIELLA PNEUMONIAE \\(BLEE\\) > 100,000 UFC/ML \\(SENSIBLE A AMIKACINA <=2, MEROPENEM; INTERMEDIO A NITROFURANTOINA; RESISTENTE A CIPROFLOXACINO >=4\\)').test(n1b.nota)
    && new RegExp('HEMOCULTIVO PERIFÉRICO 1 DEL ' + _cDot + ' SIN DESARROLLO \\(NEGATIVO A 5 DÍAS\\)').test(n1b.nota), JSON.stringify(n1b));

  // ── N2: la app NO escribe nada sola en la Cronología (27 oct 2026, pedido de Gera: «no quiero que pongas nada en las
  //        cajitas de manera automática»). Antes los labs críticos de WinLab, los estudios del RIS y los cultivos se
  //        anotaban solos como «dd-mm-aaaa: …» y ✨ Resumen escribía un bloque al final. Ahora: labs, cultivos y RIS llegan
  //        por los caminos reales (sync de WinLab y Realtime del RIS) y la caja no cambia; ✨ Resumen solo se muestra. ──
  const cAyer = ayer.slice(8, 10) + '/' + ayer.slice(5, 7) + '/' + ayer.slice(0, 4);
  const wlN2 = { exp: '24-99901', paciente: 'RUIZ SOTO MATEO', fecha: ayer, scraped_at: new Date().toISOString(),
    data: { headers: [], reportes: [
      { __cells: ['', '', '', cAyer + ' 06:10', cAyer + ' 08:00', '', ''], __hasLink: true, valores: FIX.valores.map(v => v.estudio === 'HEMOGLOBINA' ? { ...v, valor: '6.2' } : v.estudio === 'POTASIO' ? { ...v, valor: '6.3' } : v) },
      { __cells: ['', '', '', cAyer + ' 07:00', cAyer + ' 09:00'], __hasLink: true, valores: [{ estudio: 'CULTIVO', valor: 'POSITIVO', referencia: 'Sin desarrollo' }],
        cultivo: { v: 2, tipo: 'Urocultivo', muestra: 'ORINA', resultado: 'POSITIVO', germenes: ['Klebsiella pneumoniae'], ufc: '> 100,000 UFC/ML', antibiograma: [{ antibiotico: 'Amikacina', cim: '<=2', interp: 'S' }] } }] } };
  const nCalls0 = calls.length;
  const n2 = await page.evaluate(async (a) => {
    const p = patients[0]; const k = pid(p); focusGoTo(k);
    const nd = getNote(k); nd.entrega = 'PENDIENTE TRANSFUSIÓN'; noteData[k] = nd; _rerenderCard(k);
    const sinFunciones = typeof _entregaAutoAppend === 'undefined' && typeof _entregaAutoFromRis === 'undefined';
    winlabByExp[a.wl.exp] = a.wl; (winlabRowsByExp[a.wl.exp] = winlabRowsByExp[a.wl.exp] || []).push(a.wl); _winlabExpIndex = null;
    const st = await applyWinlabSyncToPatients({ only: [p] });
    handleRisChange({ eventType: 'INSERT', new: { id: 777, exp: p.exp, patient_id: p._supa_id, paciente: p.nombre, fecha: a.ayer, hora: '10:00', modalidad: 'CT', estudios: 'TAC ABDOMEN CONTRASTADA',
      reporte: 'HALLAZGOS: ... CONCLUSIÓN: DERRAME PLEURAL BILATERAL. ATENTAMENTE DR RADIOLOGO', critico: false, scraped_at: new Date().toISOString() } });
    await new Promise(r => setTimeout(r, 400));
    const btn = document.querySelector('#card-' + CSS.escape(k) + ' .pase-inteligente-btn'); if (btn) btn.click();
    await new Promise(r => setTimeout(r, 200));
    const ov = document.getElementById('resumen-overlay');
    const resumen = (document.getElementById('resumen-texto') || {}).textContent || '';
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    const snap = (getNote(k).labHistory || []).find(s => s.fecha === a.ayer) || { labs: {} };
    const out = { sinFunciones, matched: st.matched, hb: snap.labs.hb, k: snap.labs.k, cult: (_winlabCultByK[k] || []).map(c => c.tipo + ':' + (c.positivo ? 'POS' : 'NEG')),
      ris: risForPatient(p).some(r => r.id === 777), entrega: getNote(k).entrega, taVal: ta ? ta.value : null, ovVisible: !!(ov && ov.style.display === 'flex'), resumen };
    if (ov) ov.style.display = 'none';
    return out;
  }, { wl: wlN2, ayer });
  await page.waitForTimeout(1500);
  const notasN2 = calls.slice(nCalls0).filter(c => c.url.startsWith('/rest/v1/notes') && c.m !== 'GET').map(c => JSON.stringify(c.body || ''));
  check('N2 la Cronología no recibe nada automático: llegan labs críticos (Hb 6.2, K 6.3) y un urocultivo positivo por el sync de WinLab y una TAC con reporte por Realtime, y la caja sigue igual (ni en pantalla ni en lo que se sube); ✨ Resumen abre una ventana de solo lectura y no escribe',
    n2.sinFunciones && n2.matched === 1 && n2.hb === '6.2' && n2.k === '6.3' && n2.cult.includes('Urocultivo:POS') && n2.ris
    && n2.entrega === 'PENDIENTE TRANSFUSIÓN' && n2.taVal === 'PENDIENTE TRANSFUSIÓN'
    && n2.ovVisible && /^— Resumen \d{2}\/\d{2}/.test(n2.resumen) && /Hb 6\.2/.test(n2.resumen)
    && !notasN2.some(b => /: Labs: |\(RIS\)|— Resumen|POSITIVO a Klebsiella/.test(b)), JSON.stringify({ n2, notasN2: notasN2.map(b => b.slice(0, 300)) }));

  // ── N3: nota de evolución completa (formato CG, todo en mayúsculas) ──
  const n3 = await page.evaluate((ayer) => {
    const k = pid(patients[0]); const p = patients[0]; const nd = getNote(k); const ck = nd.checklist;
    ck.sexo = 'M'; ck.nota_fn = '09/01/1968'; ck.nota_s = 'dolor en sitio de herida quirúrgica, niega náusea y vómito';
    ck.nota_o = 'consciente, orientado, cooperador. Abdomen blando, depresible, herida quirúrgica con bordes bien afrontados, sin datos de irritación peritoneal';
    ck.pm_fc = '103'; ck.pm_fr = '16'; ck.pm_temp = '36.4'; ck.pm_sao2 = '96'; ck.pm_o2l = '4'; ck.pm_o2via = 'puntas nasales'; ck.pm_ta = '110/70'; ck.pm_uresis = '900';
    ck.dispositivos = [{ id: 'd1', tipo: 'Penrose', lado: 'D', sitio: '', gasto: '50', carac: 'seroso', fi: '' }, { id: 'd2', tipo: 'Penrose', lado: 'I', sitio: '', gasto: '45', carac: 'seroso', fi: '' }, { id: 'd3', tipo: 'Foley', lado: '', sitio: '', gasto: '', carac: '', fi: '' }];
    ck.npo = true; ck.atb = true; ck.atb_nombre = 'CEFTRIAXONA + METRONIDAZOL'; ck.atb_dias = '3'; ck.tvp = true; ck.tvp_tipo = 'enoxaparina'; ck.tvp_dosis = '40 mg';
    ck.nota_sis_hemo = 'choque séptico en resolución con vasopresor a dosis mínima'; ck.nota_sis_renal = 'creatinina en mejoría de 1.41 a 0.94';
    ck.nota_plan = 'retiro progresivo del vasopresor, nutrición enteral trófica al retirar vasopresor'; ck.nota_prono = '';
    nd.pendientes = '• BH, QS, ES\n• reporte de TAC';
    nd.labHistory = [
      { fecha: ayer, labs: { glu: '139', urea: '104.9', bun: '49', cr: '0.94', na: '136', k: '4.38', cl: '98.7', ca: '8.0', p: '3.5', mg: '1.4', leucos: '28.34', neu_pct: '91.2', hb: '7.7', hct: '23.7', mcv: '78.2', rdw: '23.3', plaq: '233', tp: '16.2', ttp: '25.5' } },
      { fecha: '2026-10-11', labs: { pcr: '230.7', pct: '7.21', amilasa: '95', lipasa: '54', alb: '2.6', leucos: '41.73', hb: '6.2', glu: '150' } }
    ];
    noteData[k] = nd;
    risByExp[p.exp] = [{ id: 5, exp: p.exp, fecha: ayer, hora: '10:00', modalidad: 'CT', estudios: 'TAC ABDOMEN', reporte: 'CONCLUSIÓN: COLECCIONES INTRAABDOMINALES Y DERRAME PLEURAL BILATERAL.' }];
    return _plneBuild(p, nd);
  }, ayer);
  const dAyerP = ayer.split('-').reverse().join('.');
  check('N3 nota de evolución: encabezado completo, década de la vida + diagnósticos con "+", subjetivo, vitales en texto (O₂ por puntas nasales), exploración, drenajes con gasto, Foley con uresis, labs de hoy con nombres completos y los del control previo (PCR/PCT/amilasa + tendencia leucos/Hb, sin repetir glucosa), análisis por sistemas, antibiótico, ayuno, tromboprofilaxis, TAC con conclusión, pendientes, estado/pronóstico y firma; todo en mayúsculas',
    n3.startsWith('NOTA DE EVOLUCIÓN CIRUGÍA GENERAL\nRUIZ SOTO MATEO | EDAD 58 AÑOS | FN 09.01.1968 | EXP 24-99901 | CAMA 3-170 | ')
    && / HRS\n\nPACIENTE MASCULINO EN LA SEXTA DÉCADA DE LA VIDA HOSPITALIZADO CON EL SIGUIENTE DIAGNÓSTICO: CHOQUE SÉPTICO DE ORIGEN ABDOMINAL \+ PO LAPE \+ DRENAJE DE COLECCIÓN \+ DM2 \+ HAS\./.test(n3)
    && /AL PASE DE VISITA EL PACIENTE REFIERE DOLOR EN SITIO DE HERIDA QUIRÚRGICA, NIEGA NÁUSEA Y VÓMITO\./.test(n3)
    && /PACIENTE MASCULINO, CON FC 103 LPM, FR 16 RPM, TEMPERATURA 36\.4 °C, SATURACIÓN DE OXÍGENO DE 96 % CON OXÍGENO SUPLEMENTARIO POR PUNTAS NASALES A 4 LITROS POR MINUTO, TA 110\/70 MMHG\. CONSCIENTE, ORIENTADO/.test(n3)
    && /DRENAJE TIPO PENROSE DERECHO CON GASTO DE 50 ML DE CARACTERÍSTICAS SEROSO, DRENAJE TIPO PENROSE IZQUIERDO CON GASTO DE 45 ML/.test(n3) && /FOLEY \[¿PERMEABLE A DERIVACIÓN\?\] CON URESIS CUANTIFICADA DE 900 ML/.test(n3)
    && n3.includes('LABORATORIOS DEL ' + dAyerP + ': GLUCOSA 139, UREA 104.9, BUN 49, CREATININA 0.94, SODIO 136, POTASIO 4.38, CLORO 98.7, CALCIO 8.0, FÓSFORO 3.5, MAGNESIO 1.4, LEUCOCITOS 28.34, NEUTRÓFILOS 91.2, HEMOGLOBINA 7.7, HEMATOCRITO 23.7, VCM 78.2, RDW 23.3, PLAQUETAS 233, TP 16.2, TTP 25.5.')
    && /LABORATORIOS DEL 11\.10\.2026: LEUCOCITOS 41\.73, HEMOGLOBINA 6\.2, PCR 230\.7, PROCALCITONINA 7\.21, AMILASA 95, LIPASA 54, ALBÚMINA 2\.6\./.test(n3) && !/11\.10\.2026: [^\n]*GLUCOSA 150/.test(n3)
    && /HEMODINÁMICO: CHOQUE SÉPTICO EN RESOLUCIÓN/.test(n3) && /RENAL: CREATININA EN MEJORÍA/.test(n3)
    && /SE MANTIENE EN AYUNO\./.test(n3) && /SE MANTIENE MANEJO ANTIMICROBIANO CON CEFTRIAXONA \+ METRONIDAZOL \(DÍA 3\)/.test(n3) && /TROMBOPROFILAXIS CON ENOXAPARINA 40 MG SUBCUTÁNEA\./.test(n3) && !/CADA 24 HORAS|DURACIÓN GUIADA/.test(n3)
    && n3.includes('CT TAC ABDOMEN DEL ' + dAyerP + ' CON REPORTE: COLECCIONES INTRAABDOMINALES Y DERRAME PLEURAL BILATERAL.')
    && /PLAN: RETIRO PROGRESIVO DEL VASOPRESOR/.test(n3) && /SE SOLICITAN \/ PENDIENTES: BH, QS, ES; REPORTE DE TAC\./.test(n3)
    && /ESTADO DE SALUD DELICADO, CON PRONÓSTICO \[PRONÓSTICO\]\.\nDR GARNELO MBCG \| DR FERNÁNDEZ R2CG$/.test(n3)
    && n3 === n3.toUpperCase(), n3);

  // ── N4: paciente que REAPARECE por Realtime: baja su nota (restaurada por el trigger) antes de mostrar la tarjeta
  //        y trae sus labs de WinLab aunque el scrape tenga >4 días ──
  const n4 = await page.evaluate(async () => {
    handlePatientChange({ eventType: 'INSERT', new: { id: 'b2', cama: '3-162', exp: '26-23107', nombre: 'LOPEZ RUIZ ANA', esp: 'CG', estado: 'ESTABLE', edad: '45' } });
    const immediately = patients.some(p => p._supa_id === 'b2');
    await new Promise(r => setTimeout(r, 1500));
    const p = patients.find(p => p._supa_id === 'b2'); if (!p) return { immediately, shown: false };
    const nd = getNote(pid(p));
    return { immediately, shown: true, fechas: (nd.labHistory || []).map(s => s.fecha).sort(), pend: nd.pendientes, atb: nd.checklist.atb_nombre, qx: nd.qx, hb09: ((nd.labHistory || []).find(s => s.fecha === '2026-10-09') || { labs: {} }).labs.hb, wl: !!winlabByExp['26-23107'] };
  });
  const wlNoWindow = calls.filter(c => c.m === 'GET' && c.url.startsWith('/rest/v1/winlab_labs') && !/scraped_at=gte/.test(c.url) && /23107/.test(decodeURIComponent(c.url)));
  check('N4 INSERT Realtime: la tarjeta NO se muestra hasta leer la nota de la nube; aparece con labs restaurados + pendientes + antibiótico, y suma los labs de WinLab de hace 6 días (consulta sin ventana de 4 días)',
    n4.immediately === false && n4.shown && n4.pend === 'PERFIL DE HIERRO' && n4.atb === 'CEFTRIAXONA' && n4.qx === 'LAPE 10/10'
    && n4.fechas.length === 2 && n4.fechas[0] === '2026-10-09' && n4.hb09 === '8.1' && n4.wl && wlNoWindow.length >= 1, JSON.stringify({ n4, wlNoWindow: wlNoWindow.map(c => c.url) }));

  // ── N5: la vista de cultivos se consulta acotada (exp del censo + 45 días), no completa ──
  const n5 = await page.evaluate(async () => { await window.__plLoadCultivos(); return true; });
  const cultGet = calls.filter(c => c.m === 'GET' && c.url.startsWith('/rest/v1/winlab_cultivos'));
  check('N5 winlab_cultivos: consulta con exp=in.(censo) y fecha>=45 días (antes bajaba toda la vista y PostgREST la cortaba)',
    n5 && cultGet.length >= 1 && cultGet.every(c => /exp=in\.\(/.test(c.url) && /fecha=gte\.\d{4}-\d{2}-\d{2}/.test(c.url)), JSON.stringify(cultGet.map(c => c.url)));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-NOTA: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
