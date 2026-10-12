// Indicaciones automáticas desde el Google Doc (tabla indicaciones_doc ← Apps Script).
//   node tests/headless/app_ind.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const MOCK = `(() => {
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const DOC_V1 = [
  '💯 3-101', '', 'INDICACIONES MÉDICAS DE PACIENTE UNO', 'PACIENTE UNO 54 AÑOS | CAMA 3-101 | FN 30/01/1972', '11/10/2026 8:00 am', '',
  'DIETA', 'DIETA BLANDA', '', 'SOLUCIONES', 'SOL. MIXTA 1000 CC PARA 24 HORAS', '', 'MEDICAMENTOS', 'PARACETAMOL 1 GR IV CADA 8 HORAS', 'OMEPRAZOL 40 MG IV CADA 24 HORAS', '',
  'ANTIBIÓTICOS:', 'CEFTRIAXONA 1 GR IV CADA 12 HORAS FI 09/10/2026 (3)', '', 'MEDIAS GENERALES', 'CGE Y SVPT', 'VIGILAR PATRÓN DE DOLOR', '', 'GRACIAS', 'DRA. X R2 CG', '',
  // bloque viejo del mismo paciente (fecha anterior) → debe ganar el de arriba
  'INDICACIONES MÉDICAS DE PACIENTE UNO', 'PACIENTE UNO 54 AÑOS | CAMA 3-101', '09/10/2026 8:00 am', '', 'DIETA', 'AYUNO', '', 'MEDICAMENTOS', 'METAMIZOL 1 GR IV CADA 8 HORAS', '',
  // cama 3-105: bloque a nombre de OTRA persona (paciente anterior) → aviso, no mostrar como propias
  '💯 3-105', '', 'INDICACIONES MÉDICAS DE FULANO ANTERIOR', 'FULANO ANTERIOR 70 AÑOS | CAMA 3-105', '10/10/2026 8:00 am', '', 'DIETA', 'DIETA NORMAL', '', 'MEDICAMENTOS', 'TRAMADOL 100 MG IV CADA 12 HORAS', ''
].join('\n');
const DOC_V2 = DOC_V1.replace('PARACETAMOL 1 GR IV CADA 8 HORAS', 'PARACETAMOL 1 GR IV CADA 6 HORAS');
(async()=>{
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  let docRow = { doc_id: 'DOCID', text: DOC_V1, text_hash: 'h1', doc_updated: new Date(Date.now() - 30 * 60000).toISOString(), synced_at: new Date().toISOString() };
  let indGets = 0;
  await page.route('**/supabase-js@*/**', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' }, { id: 'a2', cama: '3-105', exp: '2', nombre: 'PACIENTE DOS', esp: 'CG', estado: 'ESTABLE', dx: 'Y' }, { id: 'a3', cama: '3-107', exp: '3', nombre: 'PACIENTE TRES', esp: 'CG', estado: 'ESTABLE', dx: 'Z' }]); return json(200, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/indicaciones_doc')) { indGets++; return json(200, [docRow]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  const i1 = await page.evaluate(() => {
    const k = pid(patients[0]);
    const meta = PLIndicaciones.getMeta();
    const ind = PLIndicaciones.getForPatient(patients[0]);
    const card = document.getElementById('card-' + k);
    const sec = card && card.querySelector('.ind-section');
    const titles = sec ? Array.from(sec.querySelectorAll('.ind-block-title')).map(t => t.textContent.trim()) : [];
    const items = sec ? Array.from(sec.querySelectorAll('.ind-list li')).map(t => t.textContent.trim()) : [];
    const det = document.getElementById('sec-ind-' + k.replace(/[^a-zA-Z0-9]/g, '_'));
    const jump = Array.from(document.querySelectorAll('#board-nav .bn-jump button')).find(b => b.dataset.sec === 'ind');
    return { docHash: meta && meta.docHash, fecha: ind && ind.fecha, method: ind && ind._matchMethod, titles, items, fresh: sec ? sec.querySelector('.ind-fresh').textContent : '', open: !!(det && det.open), badge: jump ? jump.textContent : '', docLink: !!(sec && sec.querySelector('a[href*="docs.google.com/document/d/DOCID"]')) };
  });
  check('I1 al arrancar baja indicaciones_doc, parsea y pinta el bloque MÁS RECIENTE del paciente (cama+nombre) con DIETA/SOLUCIONES/MEDICAMENTOS/ANTIBIÓTICOS/MEDIDAS; sección abierta, enlace al Doc, contador en la barra',
    i1.docHash === 'h1' && i1.fecha === '2026-10-11' && /cama\+nombre/.test(i1.method || '') && i1.titles.length === 5 && /ANTIBI/.test(i1.titles[3]) && /MEDIDAS GENERALES/.test(i1.titles[4])
    && i1.items.includes('PARACETAMOL 1 GR IV CADA 8 HORAS') && i1.items.includes('CEFTRIAXONA 1 GR IV CADA 12 HORAS FI 09/10/2026 (3)') && !i1.items.some(x => /^DRA. X/.test(x)) && !i1.items.includes('METAMIZOL 1 GR IV CADA 8 HORAS')
    && /Doc editado hace/.test(i1.fresh) && /auto/.test(i1.fresh) && i1.open && /Indic\.\s*3/.test(i1.badge) && i1.docLink, JSON.stringify(i1));

  const i2 = await page.evaluate(() => {
    focusGoTo(pid(patients[1]));
    const k = pid(patients[1]);
    const card = document.getElementById('card-' + k);
    const sec = card && card.querySelector('.ind-section');
    const warn = sec && sec.querySelector('.ind-warn');
    const content = sec && sec.querySelector('.ind-content');
    const jump = Array.from(document.querySelectorAll('#board-nav .bn-jump button')).find(b => b.dataset.sec === 'ind');
    return { mismatch: !!(sec && sec.classList.contains('ind-mismatch')), warnTxt: warn ? warn.textContent : '', hidden: !!content && content.style.display === 'none', badge: jump ? jump.textContent : '' };
  });
  check('I2 cama con indicaciones a OTRO nombre: aviso rojo, contenido oculto hasta "Ver de todos modos", badge "?" en la barra',
    i2.mismatch && /no coincide/.test(i2.warnTxt) && /FULANO ANTERIOR/.test(i2.warnTxt) && i2.hidden && /\?/.test(i2.badge), JSON.stringify(i2));

  const i3 = await page.evaluate(() => {
    focusGoTo(pid(patients[2]));
    const k = pid(patients[2]);
    const sec = document.querySelector('#card-' + CSS.escape(k) + ' .ind-section');
    return { empty: !!(sec && sec.classList.contains('ind-empty')), txt: sec ? sec.textContent : '' };
  });
  check('I3 paciente sin bloque en el Doc: "Sin indicaciones en el Doc" con su cama', i3.empty && /Sin indicaciones en el Doc/.test(i3.txt) && /3-107/.test(i3.txt), JSON.stringify(i3));

  // Realtime: Apps Script sube una versión nueva → la tarjeta cambia sola, sin recargar
  docRow = Object.assign({}, docRow, { text: DOC_V2, text_hash: 'h2', doc_updated: new Date().toISOString() });
  const i4 = await page.evaluate((row) => {
    focusGoTo(pid(patients[0]));
    handleIndicacionesDocChange({ eventType: 'UPDATE', new: row });
    return new Promise(res => setTimeout(() => {
      const k = pid(patients[0]);
      const items = Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' .ind-list li')).map(t => t.textContent.trim());
      res({ hash: PLIndicaciones.getMeta().docHash, items, toast: (document.getElementById('rt-toast') || {}).textContent || '' });
    }, 800));
  }, docRow);
  check('I4 Realtime con texto nuevo → re-parsea y repinta (CADA 6 HORAS) + aviso', i4.hash === 'h2' && i4.items.includes('PARACETAMOL 1 GR IV CADA 6 HORAS') && !i4.items.includes('PARACETAMOL 1 GR IV CADA 8 HORAS') && /Indicaciones actualizadas/.test(i4.toast), JSON.stringify(i4));

  // Mismo hash → no re-importa ni repinta; botón 🔄 fuerza consulta
  const before = indGets;
  const i5 = await page.evaluate(async () => {
    const same = PLIndicaciones.importFromDoc({ text: 'OTRA COSA', text_hash: 'h2' });
    const r = await refreshIndicacionesDoc(true);
    return { same, r, blocks: PLIndicaciones.loadBlocks().length };
  });
  check('I5 mismo hash no re-importa; 🔄 consulta la tabla y mantiene los bloques', i5.same === false && i5.r === false && i5.blocks === 3 && indGets === before + 1, JSON.stringify({ i5, gets: indGets - before }));

  // Pegado manual sigue funcionando y pierde la marca "auto" (freshness por import)
  const i6 = await page.evaluate(() => { PLIndicaciones.importPasted('INDICACIONES MÉDICAS DE PACIENTE TRES\nPACIENTE TRES 40 AÑOS | CAMA 3-107\nDIETA\nLIBRE\n'); const f = PLIndicaciones.freshness(); return { label: f.label, doc: PLIndicaciones.docInfo() }; });
  check('I6 importación manual por pegado sigue disponible (sin marca de Doc)', /Importado/.test(i6.label) && i6.doc === null, JSON.stringify(i6));

  // ── Estudios de imagen del robot RIS (ris_estudios) ──
  const i7 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    focusGoTo(k);
    risByExp = {};
    handleRisChange({ eventType: 'INSERT', new: { id: 1, exp: patients[0].exp, paciente: 'PACIENTE UNO', documento: 'PAT1', fecha: '2026-10-11', hora: '19:37:31', sede: 'Hospital General de Leon', estudios: '*', modalidad: 'US', procedencia: 'CITADOS', critico: false, reporte: null, imagen_url: 'https://x/viewer/view?studyUID=1', scraped_at: new Date().toISOString() } });
    handleRisChange({ eventType: 'INSERT', new: { id: 2, exp: patients[0].exp, paciente: 'PACIENTE UNO', documento: 'PAT1', fecha: '2026-10-12', hora: '08:00:00', sede: 'Hospital General de Leon', estudios: 'TAC ABDOMEN', modalidad: 'CT', procedencia: 'HOSPITALIZADOS', critico: true, reporte: 'TOMOGRAFIA DE ABDOMEN\nHALLAZGOS: colección en FID de 4 cm.', reporte_url: 'https://x/rep/2', scraped_at: new Date().toISOString() } });
    await new Promise(r => setTimeout(r, 300));
    const card = document.getElementById('card-' + k);
    const box = card.querySelector('.ris-box');
    const items = box ? Array.from(box.querySelectorAll('.ris-item')).map(x => x.textContent.replace(/\s+/g, ' ').trim()) : [];
    const det = document.getElementById('sec-img-' + k.replace(/[^a-zA-Z0-9]/g, '_'));
    const jump = Array.from(document.querySelectorAll('#board-nav .bn-jump button')).find(b => b.dataset.sec === 'img');
    const toast = (document.getElementById('rt-toast') || {}).textContent || '';
    return { n: items.length, first: items[0] || '', second: items[1] || '', open: !!(det && det.open), badge: jump ? jump.textContent : '', toast, crit: !!box.querySelector('.ris-item.ris-crit') };
  });
  check('I7 estudios del robot RIS: llegan por Realtime, se pintan en Estudios de imagen (más reciente primero, reporte transcrito plegable, "sin reporte" cuando no hay), crítico marcado, sección abierta y contador en la barra',
    i7.n === 2 && /CT · TAC ABDOMEN/.test(i7.first) && /Reporte transcrito/.test(i7.first) && /colección en FID/.test(i7.first) && /US/.test(i7.second) && /Sin reporte todavía/.test(i7.second) && i7.crit && i7.open && /Estudios\s*2/.test(i7.badge) && /Estudio de imagen/.test(i7.toast), JSON.stringify(i7));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-IND: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
