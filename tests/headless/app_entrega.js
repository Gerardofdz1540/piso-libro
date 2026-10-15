// Entrega de guardia que RESUME (quirófano, atención, gastos, labs puntuales, lo nuevo del día, pendientes),
// INR siempre visible (estimado TP ÷ testigo cuando WinLab no lo reporta) y novedades de labs solo críticas.
//   node tests/headless/app_entrega.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  window.__alerts=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
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
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-170', exp: '24-20852', nombre: 'HERNANDEZ GONZALEZ FAUSTINO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'CHOQUE SÉPTICO DE ORIGEN ABDOMINAL, PO LAPE', adscrito: 'DR GARNELO MBCG', residente: 'DR FERNÁNDEZ R2CG' }]);
      return json(201, [{ id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── E1: INR estimado desde TP + TESTIGO (secuencia REAL de WinLab, verificada en la BD el 15-oct-2026) ──
  const e1 = await page.evaluate(() => {
    const rep = { valores: [
      { estudio: 'TIEMPO DE PROTROMBINA', valor: '20.70', unidad: 'segundos', referencia: '11.00 - 15.00' },
      { estudio: 'TESTIGO', valor: '13.00', unidad: 'segundos', referencia: '' },
      { estudio: 'TIEMPO DE TROMBOPLASTINA PARCIAL', valor: '26.40', unidad: 'segundos', referencia: '26.00 - 36.00' },
      { estudio: 'RANGO DE REFERENCIA', valor: '30', unidad: 'segundos', referencia: '' }] };
    const labs = mapWinlabReportesToLabs([rep]);
    return { labs, garbage: isWinlabGarbageEstudio('TESTIGO'), garbageRango: isWinlabGarbageEstudio('RANGO DE REFERENCIA'),
      est: inrOf(labs), real: inrOf({ inr: '1.8', tp: '20.7', tp_testigo: '13' }), none: inrOf({ tp: '20.7' }), txt: inrOf({ inr: 'pendiente' }),
      meta: LAB_META_KEYS.has('tp_testigo'), lista: _plneLabsLista(labs), listaReal: _plneLabsLista({ tp: '16.2', inr: '1.3', ttp: '25' }) };
  });
  check('E1 INR: WinLab solo trae TP + TESTIGO + TTP (+ RANGO DE REFERENCIA): el testigo ya no se descarta (tp_testigo), RANGO sí; inrOf estima TP ÷ testigo = 1.59 marcado como estimado, respeta el INR real, null sin testigo; es llave meta (no se lista como analito); la nota dice "INR 1.59 (ESTIMADO TP/TESTIGO)" y con INR real lo escribe normal',
    e1.labs.tp === '20.70' && e1.labs.tp_testigo === '13.00' && e1.labs.ttp === '26.40' && Object.keys(e1.labs).length === 3
    && e1.garbage === false && e1.garbageRango === true
    && e1.est && e1.est.est === true && e1.est.v === 1.59 && e1.est.txt === '1.59'
    && e1.real && e1.real.est === false && e1.real.v === 1.8 && e1.real.txt === '1.8' && e1.none === null && e1.txt && e1.txt.est === false && e1.txt.txt === 'pendiente'
    && e1.meta === true
    && e1.lista.join(' | ') === 'TP 20.70 CON TESTIGO DE 13.00 | INR 1.59 (ESTIMADO TP/TESTIGO) | TTP 26.40'
    && e1.listaReal.join(' | ') === 'TP 16.2 | INR 1.3 | TTP 25', JSON.stringify(e1));

  // ── E2: la fila INR SIEMPRE en la tabla de la ficha (modo Pase), con el estimado "≈" y su color; celda de la lista; línea de pase ──
  const e2 = await page.evaluate(() => {
    const k = pid(patients[0]); const nd = getNote(k);
    const hoy = _egIsoOffset(0), ayer = _egIsoOffset(-1);
    const hist2 = [
      { fecha: ayer, labs: { hb: '9.1', tp: '15.6', tp_testigo: '13', ttp: '28', k: '4.0' } },
      { fecha: hoy, labs: { hb: '7.4', tp: '20.7', tp_testigo: '13', ttp: '26.4', k: '6.1', lac: '3.1' } }];
    nd.labHistory = JSON.parse(JSON.stringify(hist2)); noteData[k] = nd;
    localStorage.setItem('pl_pase_mode', '1');     // modo Pase: las filas vacías se ocultan… menos el INR
    focusGoTo(k);
    const sel = '#card-' + CSS.escape(k);
    const rowsOf = () => Array.from(document.querySelectorAll(sel + ' .ff-labtable tbody tr'));
    const rowTxt = (tr) => tr.textContent.replace(/\s+/g, '');
    const inrTr = rowsOf().find(tr => /^INR/.test(rowTxt(tr)));
    const inrTds = inrTr ? Array.from(inrTr.querySelectorAll('td')).slice(1) : [];
    const note = rowsOf().map(rowTxt).find(t => /INRestimado/.test(t)) || '';
    const pase = (document.querySelector(sel + ' .pase-line') || {}).textContent || '';
    // sin TP ni INR: la fila INR sigue ahí (vacía) y TP se oculta como las demás
    nd.labHistory = [{ fecha: hoy, labs: { hb: '7.4' } }]; noteData[k] = nd; _rerenderCard(k);
    const rows2 = rowsOf().map(rowTxt);
    // lista (sin foco): la celda vacía del INR trae el estimado como marca de agua con su color y tendencia
    nd.labHistory = JSON.parse(JSON.stringify(hist2)); noteData[k] = nd;
    const div = document.createElement('div'); div.innerHTML = renderLabSection(getNote(k), k);
    const cell = div.querySelector('.lab-cell.lab-est'); const inp = cell ? cell.querySelector('input[data-labkey="inr"]') : null;
    localStorage.removeItem('pl_pase_mode');
    return { inrRow: inrTr ? rowTxt(inrTr) : null, cls: inrTds.map(td => td.className), titles: inrTds.map(td => td.title), note, pase, rows2, inrRowEmpty: rows2.find(t => /^INR/.test(t)) || null, tpHidden: !rows2.some(t => /^TP/.test(t)),
      cellPh: inp ? inp.placeholder : null, cellCls: inp ? inp.className : null, cellTitle: inp ? inp.title : null, cellTrend: cell ? cell.textContent.replace(/\s+/g, '') : null };
  });
  check('E2 tabla de la ficha (modo Pase): fila INR con ≈1.20 (ayer) y ≈1.59▲ (hoy, ámbar, con explicación); pie "≈ INR estimado = TP ÷ testigo"; línea de pase con INR ≈1.59▲; sin TP ni INR la fila INR sigue visible ("—") mientras TP se oculta; en la lista la celda vacía del INR muestra ≈1.59 como marca de agua en ámbar con tendencia ↑0.4',
    e2.inrRow === 'INR≈1.20≈1.59▲' && e2.cls[0] === '' && e2.cls[1] === 'ff-hi' && /INR estimado = TP ÷ testigo/.test(e2.titles[1]) && /INRestimado=TP÷testigo/.test(e2.note)
    && /INR ≈1\.59▲/.test(e2.pase) && /Hb 7\.4▼/.test(e2.pase)
    && e2.inrRowEmpty === 'INR—' && e2.tpHidden
    && e2.cellPh === '≈1.59' && e2.cellCls === 'lab-input abn' && /INR estimado/.test(e2.cellTitle) && /↑0\.4/.test(e2.cellTrend), JSON.stringify(e2));

  // ── E3: resumen de entrega — construcción, texto, botón ✨ Resumen idempotente ──
  const e3 = await page.evaluate(() => {
    const k = pid(patients[0]); const nd = getNote(k); const ck = nd.checklist;
    const hoy = _egIsoOffset(0), ayer = _egIsoOffset(-1);
    const dm = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7); const dmy = (iso) => iso.split('-').reverse().join('-');
    ck.cirugias = [{ id: 'c1', fecha: '2026-10-01', procedimiento: 'LAPE + drenaje de colección', hallazgos: '', sangrado: '300', cirujano: '' },
      { id: 'c2', fecha: hoy, procedimiento: 'Relaparotomía + lavado', hallazgos: 'Absceso subfrénico 200 mL', sangrado: '150', cirujano: 'Dr. X' }];
    ck.dispositivos = [{ id: 'd1', tipo: 'Penrose', lado: 'D', sitio: 'FID', gasto: '50', carac: 'seroso', fi: '2026-10-01' }, { id: 'd2', tipo: 'Saratoga', lado: 'I', sitio: '', gasto: '120', carac: 'hemático', fi: hoy }, { id: 'd3', tipo: 'Foley', lado: '', sitio: '', gasto: '', carac: '', fi: '' }];
    ck.pm_uresis = '900'; ck.pm_balance = '+450'; ck.npo = true; ck.npo_dias = '2';
    ck.vp_nore_on = true; ck.vp_nore_mg = '4'; ck.vp_nore_ml = '100'; ck.vp_nore_mlh = '10'; ck.pm_peso = '70';
    ck.interconsultas = dm(hoy) + ' GF: IC a nefrología por LRA';
    ck.cultivos = '01/10: hemocultivos tomados';
    ck._ptReminders = [{ text: 'Pedir CE', done: false }, { text: 'Hecho', done: true }];
    nd.manejo = 'Meropenem 1 g c/8 h';
    nd.pendientes = dm(hoy) + ' — \n• TAC de control\n✓ BH, QS\n20/09 — \n• Valoración por nutrición';
    const orig = 'Vigilar sangrado por Saratoga\n' + dm(ayer) + ' GF: se solicitó TAC de control\n' + dmy(ayer) + ': Labs: Anemia severa (Hb 7.4)\n' + dmy(ayer) + ': US (RIS): estudio realizado, reporte pendiente';
    nd.entrega = orig;
    nd.labHistory = [
      { fecha: ayer, labs: { hb: '9.1', tp: '15.6', tp_testigo: '13', ttp: '28', k: '4.0', cr: '0.9', na: '138', glu: '150' } },
      { fecha: hoy, labs: { hb: '7.4', tp: '19.8', tp_testigo: '13', ttp: '26.4', k: '6.1', lac: '3.1', cr: '1.1', na: '137', glu: '160', plaq: '180' } }];
    noteData[k] = nd;
    risByExp[_risKey(patients[0].exp)] = [{ id: 9, exp: patients[0].exp, fecha: hoy, hora: '10:00', modalidad: 'CT', estudios: 'TAC ABDOMEN', reporte: 'HALLAZGOS: ... CONCLUSIÓN: COLECCIÓN SUBFRÉNICA DE 6 CM. ATENTAMENTE DR R', scraped_at: new Date().toISOString() }];
    const lines = _egLineasFechadas(nd.pendientes);
    const R = buildEntregaResumen(patients[0], nd);
    const txt = entregaResumenTexto(patients[0], nd);
    const btn = document.querySelector('#card-' + CSS.escape(k) + ' .pase-inteligente-btn');
    applyPaseInteligente(k); const e1 = getNote(k).entrega;
    applyPaseInteligente(k); const e2 = getNote(k).entrega;
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="entrega"]');
    return { hoy, ayer, dmH: dm(hoy), dmA: dm(ayer), lines, R, txt, orig, e1, e2, taVal: ta ? ta.value : null, sin: _entregaSinResumen(e2), btn: btn ? btn.textContent.trim() : null, alerts: window.__alerts.length };
  });
  await page.waitForTimeout(1200);
  const tl = e3.txt.split('\n');
  const c3 = {
    lineas: e3.lines.length === 3 && e3.lines[0].fecha === e3.hoy && e3.lines[0].text === 'TAC de control' && e3.lines[1].text === '✓ BH, QS' && e3.lines[2].fecha === '2026-09-20' && e3.lines[2].text === 'Valoración por nutrición',
    qx: JSON.stringify(e3.R.qx) === JSON.stringify(['HOY pasó a quirófano: Relaparotomía + lavado · Absceso subfrénico 200 mL · sangrado 150 mL · Dr. X', '+1 cirugía previa']),
    alertas: JSON.stringify(e3.R.alertas) === JSON.stringify(['Norepinefrina 5.7 mcg/kg/h a 10 mL/h', 'Ayuno d2']),
    gastos: e3.R.gastos.length === 3 && /^Penrose D \(FID\) 50 mL seroso d\d+ · Saratoga I 120 mL hemático d0 · Foley$/.test(e3.R.gastos[0]) && e3.R.gastos[1] === 'Uresis 900 mL' && e3.R.gastos[2] === 'Balance +450',
    labs: e3.R.labs && e3.R.labs.fecha === e3.hoy && e3.R.labs.extra === 0 && e3.R.labs.dias === 0 && JSON.stringify(e3.R.labs.items.map(i => i.text)) === JSON.stringify(['Hb 7.4▼ (de 9.1)', 'K 6.1▲ (de 4.0)', 'Lac 3.1', 'INR ≈1.52▲ (de 1.20)']) && JSON.stringify(e3.R.labs.items.map(i => i.crit)) === JSON.stringify([true, true, false, false]),
    nuevo: JSON.stringify(e3.R.nuevo) === JSON.stringify([e3.dmH + ' Pendientes: TAC de control', e3.dmH + ' IC: IC a nefrología por LRA', e3.dmA + ' se solicitó TAC de control', e3.dmA + ' US (RIS): estudio realizado, reporte pendiente', e3.dmH + ' se colocó Saratoga I', e3.dmH + ' CT TAC ABDOMEN: COLECCIÓN SUBFRÉNICA DE 6 CM.']),
    pend: JSON.stringify(e3.R.pend) === JSON.stringify(['TAC de control', 'Valoración por nutrición', 'No olvidar: Pedir CE']),
    txtHdr: tl.length === 7 && /^— Resumen \d{2}\/\d{2} \d{2}:\d{2} GF —$/.test(tl[0]),
    txtQx: tl[1] === '🔪 HOY pasó a quirófano: Relaparotomía + lavado · Absceso subfrénico 200 mL · sangrado 150 mL · Dr. X · +1 cirugía previa',
    txtAl: tl[2] === '⚠️ Norepinefrina 5.7 mcg/kg/h a 10 mL/h · Ayuno d2',
    txtGas: /^💧 Gastos: Penrose D \(FID\) 50 mL seroso d\d+ · Saratoga I 120 mL hemático d0 · Foley · Uresis 900 mL · Balance \+450$/.test(tl[3]),
    txtLabs: tl[4] === '🧪 Labs ' + e3.dmH + ': Hb 7.4▼ (de 9.1) · K 6.1▲ (de 4.0) · Lac 3.1 · INR ≈1.52▲ (de 1.20)',   // TP 19.8 es "anormal", no crítico → no estorba
    txtNuevo: tl[5] === '🆕 Nuevo: ' + e3.dmH + ' Pendientes: TAC de control · ' + e3.dmH + ' IC: IC a nefrología por LRA · ' + e3.dmA + ' se solicitó TAC de control · ' + e3.dmA + ' US (RIS): estudio realizado, reporte pendiente · ' + e3.dmH + ' se colocó Saratoga I · ' + e3.dmH + ' CT TAC ABDOMEN: COLECCIÓN SUBFRÉNICA DE 6 CM.',
    txtPend: tl[6] === '📋 Pendientes: TAC de control · Valoración por nutrición · No olvidar: Pedir CE',
    btn: e3.btn === '✨ Resumen',
    apply1: e3.e1.startsWith(e3.orig + '\n\n— Resumen ') && e3.e1.split('\n').slice(-6).join('\n') === tl.slice(1).join('\n'),
    idem: (e3.e2.match(/— Resumen /g) || []).length === 1 && e3.e2.startsWith(e3.orig + '\n\n— Resumen ') && e3.sin === e3.orig && e3.taVal === e3.e2 && e3.alerts === 0,
    // la Entrega viaja dentro de checklist.__pl_note_meta (buildChecklistForSync), no como columna propia
    posted: calls.some(c => (c.m === 'POST' || c.m === 'PATCH') && /\/rest\/v1\/notes/.test(c.url) && (function (b) { b = Array.isArray(b) ? b[0] : b; const m = b && b.checklist && b.checklist.__pl_note_meta; return !!(m && typeof m.entrega === 'string' && /— Resumen /.test(m.entrega)); })(c.body))
  };
  const bad3 = Object.keys(c3).filter(x => !c3[x]);
  check('E3 resumen de entrega: renglones por fecha (sellos ➕ Hoy / "dd/mm —"), 🔪 HOY pasó a quirófano (hallazgos, sangrado, cirujano, +1 previa), ⚠️ norepinefrina en mcg/kg/h + ayuno, 💧 gastos (drenajes con característica y día, uresis, balance), 🧪 labs PUNTUALES (crítico, cambio grande, lactato, INR estimado con tendencia y valor previo; nada de transcribir todo), 🆕 nuevo del día (pendiente, IC, lo pedido ayer, RIS, drenaje colocado hoy, TAC con conclusión), 📋 pendientes abiertos + No olvidar; botón ✨ Resumen escribe el bloque al final sin tocar lo escrito y al repetirlo lo REEMPLAZA (uno solo); se guarda en la nube',
    bad3.length === 0, 'fallan: ' + bad3.join(', ') + ' :: ' + JSON.stringify({ R: e3.R, txt: e3.txt, e2: e3.e2, lines: e3.lines, notesCalls: calls.filter(c => /\/rest\/v1\/notes/.test(c.url)).map(c => c.m + ' ' + c.url + ' ' + JSON.stringify(c.body || null).slice(0, 300)) }));

  // ── E4: vista 📤 Entrega — ficha por paciente con el mismo resumen y sin tabla de analitos ──
  const e4 = await page.evaluate(() => {
    renderPrint(patients);
    const card = document.querySelector('#view-print .eg-c');
    return { labels: Array.from(card.querySelectorAll('.eg-biglbl')).map(x => x.textContent.trim()),
      chips: Array.from(card.querySelectorAll('.eg-biglab')).map(x => x.textContent + (/crit/.test(x.className) ? '!' : '')),
      li: card.querySelectorAll('.eg-list li').length, hasTable: !!card.querySelector('table'), pre: (card.querySelector('.eg-pre') || {}).textContent || null,
      dx: (card.querySelector('.eg-bigval') || {}).textContent || '' };
  });
  check('E4 vista Entrega: Dx + Quirófano + Atención + Gastos + Labs puntuales (chips: críticos en rojo, cambios en ámbar) + Nuevo del día + Pendientes + Entrega escrita (lo escrito a mano, sin el bloque de resumen); ya no hay tabla de todos los analitos',
    e4.labels.length === 8 && e4.labels[0] === '🩺 Diagnóstico' && e4.labels[1] === '🔪 Quirófano' && e4.labels[2] === '⚠️ Atención' && e4.labels[3] === '💧 Gastos' && /^🧪 Labs puntuales · /.test(e4.labels[4]) && e4.labels[5] === '🆕 Nuevo del día' && e4.labels[6] === '📋 Pendientes' && e4.labels[7] === '📤 Entrega escrita'
    && JSON.stringify(e4.chips) === JSON.stringify(['Hb 7.4▼ (de 9.1)!', 'K 6.1▲ (de 4.0)!', 'Lac 3.1', 'INR ≈1.52▲ (de 1.20)'])
    && e4.li === 16 && e4.hasTable === false && e4.pre === e3.orig && /CHOQUE SÉPTICO/.test(e4.dx), JSON.stringify(e4));

  // ── E5: novedades automáticas de labs: solo CRÍTICOS (+ INR estimado ≥ 1.5), idempotente ──
  const e5 = await page.evaluate(() => {
    const ayer = _egIsoOffset(-1);
    const before = []; const after = [{ fecha: ayer, labs: { hb: '6.2', glu: '160', k: '5.5', tp: '19.8', tp_testigo: '13' } }];
    const items = _entregaItemsFromLabs(after, before);
    const again = _entregaItemsFromLabs(after, after);
    const soloAbn = _entregaItemsFromLabs([{ fecha: ayer, labs: { glu: '160', k: '5.5', tp: '15', tp_testigo: '13' } }], []);
    return { items: items.map(i => i.text), again: again.length, soloAbn: soloAbn.length };
  });
  check('E5 novedades automáticas de labs: anota los críticos ("Anemia severa (Hb 6.2)") y el INR estimado ≥ 1.5; los solo anormales (glucosa 160, K 5.5, INR 1.15) ya no ensucian la entrega; nada cambió → nada',
    e5.items.length === 1 && e5.items[0] === 'Labs: Anemia severa (Hb 6.2), INR estimado 1.52 (TP ÷ testigo)' && e5.again === 0 && e5.soloAbn === 0, JSON.stringify(e5));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-ENTREGA: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
