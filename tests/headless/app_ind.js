// Indicaciones automáticas desde el Google Doc (tabla indicaciones_doc ← Apps Script).
//   node tests/headless/app_ind.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
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
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  let docRow = { doc_id: 'DOCID', text: DOC_V1, text_hash: 'h1', doc_updated: new Date(Date.now() - 30 * 60000).toISOString(), synced_at: new Date().toISOString() };
  let indGets = 0; const indUrls = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', estado: 'ESTABLE', dx: 'X' }, { id: 'a2', cama: '3-105', exp: '2', nombre: 'PACIENTE DOS', esp: 'CG', estado: 'ESTABLE', dx: 'Y' }, { id: 'a3', cama: '3-107', exp: '3', nombre: 'PACIENTE TRES', esp: 'CG', estado: 'ESTABLE', dx: 'Z' }]); return json(200, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/indicaciones_doc')) {
      indGets++; indUrls.push(decodeURIComponent(url));
      const onlyHash = /select=text_hash(&|$)/.test(decodeURIComponent(url));
      return json(200, [onlyHash ? { text_hash: docRow.text_hash } : docRow]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
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

  // Revisión de rutina (cada 10 min, 27 oct 2026): con la misma huella solo se pide text_hash; con huella nueva, el texto.
  const u0 = indUrls.length;
  const i5b1 = await page.evaluate(async () => ({ r: await refreshIndicacionesDoc(false), hash: PLIndicaciones.getMeta().docHash }));
  const urls1 = indUrls.slice(u0);
  docRow = Object.assign({}, docRow, { text: DOC_V1, text_hash: 'h3', doc_updated: new Date().toISOString() });
  const u1 = indUrls.length;
  const i5b2 = await page.evaluate(async () => ({ r: await refreshIndicacionesDoc(false), hash: PLIndicaciones.getMeta().docHash }));
  const urls2 = indUrls.slice(u1);
  check('I5b revisión de rutina: misma huella → una consulta solo de text_hash; huella nueva → baja el texto y re-importa',
    i5b1.r === false && urls1.length === 1 && /select=text_hash$/.test(urls1[0].split('&id=')[0]) && i5b2.r === true && i5b2.hash === 'h3' && urls2.length === 2 && /select=doc_id,text,/.test(urls2[1]),
    JSON.stringify({ i5b1, urls1, i5b2, urls2 }));

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

  // ── 3 nov 2026 («no se están actualizando las indicaciones»): formatos reales del Doc que la app no leía ──
  // Doc ficticio con los formatos vistos en el Doc real: encabezados «PARA HOSPITALIZACIÓN» y «POSTQUIRÚRGICAS» (antes no
  // abrían bloque: el paciente se pegaba al anterior), nombre con « / EXPE:», nombre en el renglón del encabezado, un
  // diagnóstico en mayúsculas antes del nombre, fecha «FECHA 03 /11/2026» y «03.11.2026», y un \r dentro del renglón.
  const DOC_V3 = [
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'ALMA RUIZ SOTO / EXPE: 26-90001 FN: 01/01/1970', 'FECHA 03 /11/2026\t 08:00 HRS\tCAMA: 3-153', '',
    'DIETA:', 'AYUNO', '', 'MEDICAMENTOS:', 'PARACETAMOL 1 GR IV CADA 8 HRS', '', '',
    'INDICACIONES PARA HOSPITALIZACIÓN DE CIRUGÍA GENERAL', 'BRUNO DELGADO LARA PRECIADO', '03/11/2026\t15:00 HRS. CAMA 154', '',
    'DIETA:', 'DIETA BLANDA', '', 'MEDICAMENTOS:', 'KETOROLACO 30 MG IV CADA 8 HRS', 'OMEPRAZOL 40 MG IV CADA 24 HRS', '', '',
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'CIRO LEON VEGA | 40 AÑOS | EXP 26-90003', '03/11/2026 08:00 HRS CAMA: 3-185', '',
    'DIETA:', 'LÍQUIDOS CLAROS', '', 'MEDICAMENTOS:', 'METAMIZOL 1 GR IV CADA 8 HRS', '',
    // renglón del cuerpo que empieza con «Indicaciones…» SIN identidad cerca: no es paciente nuevo
    'MEDIDAS GENERALES:', 'INDICACIONES PARA ENFERMERÍA: CUIDADOS DE HERIDA', 'SIGNOS VITALES CADA 4 HRS', '', '',
    'INDICACIONES POSTQUIRÚRGICAS DE CIRUGÍA GENERAL', 'COLECISTITIS AGUDA + COLEDOCOLITIASIS', 'DORA MENA RIOS | EXP 26-90004 | CAMA 3-186\r03.11.2026 08:00 HRS',
    'DIETA:', 'AYUNO', '', 'MEDICAMENTOS:', 'CEFTRIAXONA 1 GR IV CADA 12 HRS\rTRAMADOL 50 MG IV CADA 8 HRS', '', '',
    'INDICACIONES MEDICAS CIRUGIA GENERAL | ELENA PONS GIL | 02.11.2026 |', 'EDAD 60 AÑOS | EXP 26-90005', '', 'DIETA:', 'NORMAL', '', 'MEDICAMENTOS:', 'ENOXAPARINA 40 MG SC CADA 24 HRS', '', '',
    // Bloque VIEJO del mismo paciente de la 3-185 (más abajo en el Doc, con fecha anterior): debe ganar el de hoy
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'CIRO LEON VEGA | 40 AÑOS | EXP 26-90003', 'FECHA 30/10/2026 08:00 HRS CAMA: 3-185', '',
    'DIETA:', 'AYUNO', '', 'MEDICAMENTOS:', 'MORFINA 2 MG IV CADA 6 HRS', '', '',
    // nombre justo después de «DE» en el encabezado (con identidad en el mismo renglón): no comerse «DEL…»/«LA…»
    'INDICACIONES MÉDICAS DE DELIA LARA PEREZ | 40 AÑOS | EXP 26-90006', 'FECHA 03/11/2026 CAMA: 3-189', '', 'DIETA:', 'LIBRE', '', 'MEDICAMENTOS:', 'PARACETAMOL 500 MG VO CADA 8 HRS', '', '',
    // el encabezado deja un resto que parece nombre («TURNO MATUTINO»): gana el nombre de abajo
    'INDICACIONES MÉDICAS TURNO MATUTINO', 'FELIPE SOTO ARIAS', '03/11/2026 08:00 HRS CAMA 3-190', '', 'DIETA:', 'LIBRE', '', 'MEDICAMENTOS:', 'OMEPRAZOL 20 MG VO CADA 24 HRS', '', '',
    // diagnóstico en mayúsculas (sin «+») antes del renglón con EXP: gana el renglón con identidad
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'APENDICITIS AGUDA COMPLICADA', 'GLORIA NAVA RUIZ | 33 AÑOS | EXP 26-90008', '03/11/2026 CAMA 3-191', '', 'DIETA:', 'AYUNO', '', 'MEDICAMENTOS:', 'METRONIDAZOL 500 MG IV CADA 8 HRS', '', '',
    // etiqueta desconocida con dos puntos tras el nombre
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'HUGO PAZ MORA REG: 26-90009', 'FECHA 03/11/2026 CAMA: 3-192', '', 'DIETA:', 'LIBRE', '', 'MEDICAMENTOS:', 'LORATADINA 10 MG VO CADA 24 HRS', '', '',
    // renglón de servicio y diagnóstico con «+» antes de un nombre SIN identidad
    'INDICACIONES MÉDICAS DE CIRUGÍA GENERAL', 'HOSPITALIZACIÓN CIRUGÍA GENERAL', 'HERNIA INGUINAL + EVENTRACION', 'IRMA SOLIS CANO', 'FECHA 03/11/2026 CAMA 3-193', '', 'DIETA:', 'LIBRE', '', 'MEDICAMENTOS:', 'NAPROXENO 250 MG VO CADA 12 HRS', ''
  ].join('\n');
  const i8 = await page.evaluate((txt) => {
    PLIndicaciones.importFromDoc({ doc_id: 'DOCID', text: txt, text_hash: 'h8', doc_updated: new Date().toISOString(), synced_at: new Date().toISOString() });
    const P = (cama, nombre) => PLIndicaciones.getForPatient({ cama, nombre });
    const r = {};
    [['3-153', 'ALMA RUIZ SOTO'], ['3-154', 'BRUNO DELGADO LARA PRECIADO'], ['3-185', 'CIRO LEON VEGA'], ['3-186', 'DORA MENA RIOS'], ['3-188', 'ELENA PONS GIL'],
     ['3-189', 'DELIA LARA PEREZ'], ['3-190', 'FELIPE SOTO ARIAS'], ['3-191', 'GLORIA NAVA RUIZ'], ['3-192', 'HUGO PAZ MORA'], ['3-193', 'IRMA SOLIS CANO']].forEach(([c, n]) => {
      const b = P(c, n); r[c] = b ? { metodo: b._matchMethod, aviso: !!b._matchWarn, fecha: b.fecha, meds: b.MEDICAMENTOS, medidas: b['MEDIDAS GENERALES'], nombre: b.nombre } : null;
    });
    r.bloques = PLIndicaciones.loadBlocks().length;
    return r;
  }, DOC_V3);
  check('I8 encabezados «PARA HOSPITALIZACIÓN» y «POSTQUIRÚRGICAS» abren bloque: cada cama ve SOLO lo suyo (la 185 ya no trae lo de la 186; la 153 no trae lo de la 154)',
    i8.bloques === 11 && i8['3-185'] && i8['3-185'].medidas.includes('SIGNOS VITALES CADA 4 HRS') && i8['3-153'] && JSON.stringify(i8['3-153'].meds) === '["PARACETAMOL 1 GR IV CADA 8 HRS"]'
    && i8['3-154'] && i8['3-154'].meds.length === 2 && i8['3-185'] && JSON.stringify(i8['3-185'].meds) === '["METAMIZOL 1 GR IV CADA 8 HRS"]'
    && i8['3-186'] && !i8['3-186'].meds.includes('METAMIZOL 1 GR IV CADA 8 HRS'), JSON.stringify(i8));
  check('I9 nombre: corta en « / EXPE:», respeta apellidos que empiezan como palabras del encabezado (DELGADO, LARA, PRECIADO), salta el diagnóstico «… + …» y toma el nombre del renglón del encabezado; nunca «cama-sola» para el propio paciente',
    i8['3-153'] && i8['3-153'].nombre === 'ALMA RUIZ SOTO' && !i8['3-153'].aviso && i8['3-154'] && i8['3-154'].nombre === 'BRUNO DELGADO LARA PRECIADO' && i8['3-154'].metodo === 'cama+nombre'
    && i8['3-186'] && i8['3-186'].nombre === 'DORA MENA RIOS' && i8['3-186'].metodo === 'cama+nombre' && i8['3-188'] && i8['3-188'].nombre === 'ELENA PONS GIL' && !i8['3-188'].aviso
    && ['3-189', '3-190', '3-191', '3-192', '3-193'].every(c => i8[c] && i8[c].metodo === 'cama+nombre' && !i8[c].aviso)
    && i8['3-189'].nombre === 'DELIA LARA PEREZ' && i8['3-190'].nombre === 'FELIPE SOTO ARIAS' && i8['3-191'].nombre === 'GLORIA NAVA RUIZ' && i8['3-192'].nombre === 'HUGO PAZ MORA' && i8['3-193'].nombre === 'IRMA SOLIS CANO', JSON.stringify(i8));
  check('I10 fechas «FECHA 03 /11/2026», «03.11.2026» y la del renglón del encabezado; con dos bloques del mismo paciente gana el de HOY aunque el viejo también tenga fecha',
    ['3-153', '3-154', '3-185', '3-186'].every(c => i8[c] && i8[c].fecha === '2026-11-03') && i8['3-188'] && i8['3-188'].fecha === '2026-11-02'
    && !i8['3-185'].meds.includes('MORFINA 2 MG IV CADA 6 HRS'), JSON.stringify(i8));
  check('I11 un \\r dentro del renglón separa: «CEFTRIAXONA…\\rTRAMADOL…» son dos medicamentos (antes salían pegados en uno)',
    i8['3-186'] && i8['3-186'].meds.length === 2 && i8['3-186'].meds[1] === 'TRAMADOL 50 MG IV CADA 8 HRS', JSON.stringify(i8['3-186']));

  // Memoria del iPad llena: guardar los bloques falla. Antes la tarjeta seguía con la versión anterior y, si la huella sí se
  // guardaba, el equipo quedaba «al día» con lo viejo para siempre.
  const i12 = await page.evaluate((txt) => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'pl_ind_v23_blocks') { const e = new Error('lleno'); e.name = 'QuotaExceededError'; throw e; } return orig.call(this, k, v); };
    let r;
    try {
      const cambio = PLIndicaciones.importFromDoc({ doc_id: 'DOCID', text: txt.replace('PARACETAMOL 1 GR IV CADA 8 HRS', 'PARACETAMOL 1 GR IV CADA 6 HRS'), text_hash: 'h12', doc_updated: new Date().toISOString(), synced_at: new Date().toISOString() });
      const b = PLIndicaciones.getForPatient({ cama: '3-153', nombre: 'ALMA RUIZ SOTO' });
      const metaLS = JSON.parse(localStorage.getItem('pl_ind_v23_meta') || 'null');
      r = { cambio, meds: b && b.MEDICAMENTOS, hashMem: PLIndicaciones.getMeta().docHash, hashLS: metaLS && metaLS.docHash, sinCopia: !!(metaLS && metaLS.sinCopia), alDia: PLIndicaciones.docIsCurrent('h12') };
    } finally { Storage.prototype.setItem = orig; }
    return r;
  }, DOC_V3);
  check('I12 memoria del iPad llena: la tarjeta muestra la versión NUEVA (en memoria) y la huella no se guarda en el equipo (al reabrir vuelve a bajar el Doc en vez de quedarse con lo viejo)',
    i12.cambio === true && JSON.stringify(i12.meds) === '["PARACETAMOL 1 GR IV CADA 6 HRS"]' && i12.hashMem === 'h12' && i12.hashLS === null && i12.sinCopia && i12.alDia === true, JSON.stringify(i12));

  const i13 = await page.evaluate(() => {
    const a = PLIndicaciones.getForPatient({ cama: '3-153', nombre: 'ALMA RUIZ SOTO' });
    a._matchWarn = true; a.MEDICAMENTOS.length = 0; a.nombre = 'X';
    const b = PLIndicaciones.getForPatient({ cama: '3-153', nombre: 'ALMA RUIZ SOTO' });
    // cama con bloque de OTRA persona: el aviso dice de qué fecha es ese bloque
    const html = renderIndicacionesSection({ cama: '3-153', nombre: 'OTRA PERSONA DISTINTA' }, {}, 'k-i13');
    return { warn: b._matchWarn, nombre: b.nombre, meds: b.MEDICAMENTOS.length, aviso: (html.match(/ind-warn">([^<]*<b>[^<]*<\/b>[^,]*)/) || [])[1] || '' };
  });
  check('I13 lo que devuelve getForPatient es una copia (modificarlo no ensucia la siguiente tarjeta) y el aviso «no coincide» dice la fecha del bloque ajeno',
    i13.warn === false && i13.nombre === 'ALMA RUIZ SOTO' && i13.meds >= 1 && /ALMA RUIZ SOTO<\/b> \(del /.test(i13.aviso), JSON.stringify(i13));

  // Otra pestaña del mismo equipo importa un Doc más nuevo (escribe localStorage): esta pestaña lo usa, no su memoria vieja.
  const i14 = await page.evaluate(() => {
    const otro = [{ cama: '153', nombre: 'ALMA RUIZ SOTO', fecha: '2026-11-04', DIETA: ['LIBRE'], SOLUCIONES: [], MEDICAMENTOS: ['OTRA PESTAÑA 1 GR'], 'ANTIBIÓTICOS': [], 'MEDIDAS GENERALES': [] }];
    localStorage.setItem('pl_ind_v23_blocks', JSON.stringify(otro));
    const b = PLIndicaciones.getForPatient({ cama: '3-153', nombre: 'ALMA RUIZ SOTO' });
    return { meds: b && b.MEDICAMENTOS, n: PLIndicaciones.loadBlocks().length };
  });
  check('I14 otra pestaña guardó un Doc más nuevo: esta pestaña lo lee (la copia en memoria no se queda con lo viejo)',
    i14.n === 1 && JSON.stringify(i14.meds) === '["OTRA PESTAÑA 1 GR"]', JSON.stringify(i14));

  // Exclusividad (7 nov 2026): un bloque del Doc es de UN paciente del censo. Pacientes y Doc ficticios.
  const i15 = await page.evaluate(() => {
    const blq = (cama, nombre, fecha, med) => ({ cama, nombre, fecha, DIETA: ['LIBRE'], SOLUCIONES: [], MEDICAMENTOS: [med], 'ANTIBIÓTICOS': [], 'MEDIDAS GENERALES': [] });
    localStorage.setItem('pl_ind_v23_blocks', JSON.stringify([
      blq('156', 'BRUNO PEREZ LARA', '2026-11-07', 'MED DE BRUNO'),        // de la 3-156 (cama + nombre)
      blq('153', 'OTRO ANTERIOR NAVA', '2026-11-04', 'MED DEL ANTERIOR'),  // cama 3-153 con otro nombre (paciente anterior)
      blq('199', 'DIANA SOTO MORA', '2026-11-06', 'MED DE DIANA'),         // encaja igual con dos pacientes (solo apellidos)
    ]));
    const censo = [
      { cama: '3-156', nombre: 'BRUNO PEREZ LARA' }, { cama: '3-153', nombre: 'CARLOS PEREZ LARA' },
      { cama: '3-120', nombre: 'ELSA SOTO MORA' }, { cama: '3-121', nombre: 'FELIX SOTO MORA' },
    ];
    const r = (p, c) => { const b = PLIndicaciones.getForPatient(p, c); return b ? { med: b.MEDICAMENTOS[0], warn: b._matchWarn, method: b._matchMethod } : null; };
    const out = {
      bruno: r(censo[0], censo), carlos: r(censo[1], censo), elsa: r(censo[2], censo), felix: r(censo[3], censo),
      carlosSinCenso: r(censo[1], []),
    };
    // Por defecto usa el censo de la app (patients): mismo resultado sin pasarlo.
    const old = patients.slice(); patients.length = 0; censo.forEach(p => patients.push(Object.assign({ id: 'x' + p.cama, _supa_id: 'sid-' + p.cama, exp: p.cama, esp: 'CG', estado: 'ESTABLE' }, p)));
    out.carlosCopia = r(Object.assign({}, patients[1]));   // copia del mismo paciente (otro objeto, mismo id): no se excluye a sí mismo
    out.carlosDefault = r(patients[1]); out.brunoDefault = r(patients[0]);
    out.htmlElsa = renderIndicacionesSection(patients[2], {}, 'k-i15');
    patients.length = 0; old.forEach(p => patients.push(p));
    return out;
  });
  check('I15 exclusividad: la 3-153 (comparte dos apellidos con la 3-156) ya NO muestra como propias las indicaciones de la 3-156; le queda el bloque viejo de su cama, oculto con aviso. La 3-156 conserva las suyas. Si dos pacientes encajan igual, ninguno las ve como propias («compartido», oculto con aviso). Sin censo se comporta como antes; por defecto usa el censo de la app',
    i15.bruno && i15.bruno.med === 'MED DE BRUNO' && !i15.bruno.warn && i15.carlos && i15.carlos.med === 'MED DEL ANTERIOR' && i15.carlos.warn === true && i15.carlos.method === 'cama-sola'
    && i15.elsa && i15.elsa.warn === true && i15.elsa.method === 'compartido' && i15.felix && i15.felix.warn === true && i15.felix.med === 'MED DE DIANA'
    && i15.carlosSinCenso && i15.carlosSinCenso.med === 'MED DE BRUNO' && i15.carlosDefault && i15.carlosDefault.med === 'MED DEL ANTERIOR' && i15.carlosDefault.warn && i15.carlosCopia && i15.carlosCopia.med === 'MED DEL ANTERIOR' && i15.brunoDefault && !i15.brunoDefault.warn
    && /encajan igual con otro paciente del censo/.test(i15.htmlElsa) && /ind-content" style="display:none"/.test(i15.htmlElsa) && /DIANA SOTO MORA/.test(i15.htmlElsa), JSON.stringify(Object.assign({}, i15, { htmlElsa: (i15.htmlElsa.match(/ind-warn">[^]*?<\/div>/) || [''])[0].slice(0, 300) })));

  // 🔎 Revisor de indicaciones (11 nov 2026): reglas sin IA que cruzan el bloque del Doc con la tarjeta. Paciente y Doc ficticios.
  const i16 = await page.evaluate(() => {
    const z = n => String(n).padStart(2, '0');
    const f = d => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    const hoyD = new Date(); const hoyS = f(hoyD);
    const man = new Date(); man.setDate(man.getDate() + 1); const manS = f(man);
    const ayer = new Date(); ayer.setDate(ayer.getDate() - 2); const ayerS = f(ayer);
    const p = patients.find(x => x.cama === '3-107'); const k = pid(p);
    const blq = (extra) => Object.assign({ cama: '107', nombre: 'PACIENTE TRES', fecha: hoyS, DIETA: ['DIETA BLANDA'], SOLUCIONES: [], MEDICAMENTOS: ['OMEPRAZOL 40 MG IV C/24 H'], 'ANTIBIÓTICOS': ['CEFTRIAXONA 1 G IV C/12 H'], 'MEDIDAS GENERALES': ['PREPARAR PARA QUIRÓFANO Y PASAR AL SOLICITAR', 'SIGNOS VITALES POR TURNO'], firma: '' }, extra || {});
    const poner = (b) => localStorage.setItem('pl_ind_v23_blocks', JSON.stringify([b]));
    const nd = getNote(k); nd.checklist = nd.checklist || {};
    const reglas = () => PLCDS.evaluate(p, getNote(k)).filter(s => /^ind_/.test(s.ruleId)).map(s => s.ruleId).sort();
    const r = {};
    // A: drenaje sin cuantificar, quirófano sin cirugía, ATB sin FI, sin firma
    nd.checklist.dispositivos = [{ id: 'd1', tipo: 'Saratoga', lado: 'D', fi: hoyS }]; nd.checklist.cirugias = []; nd.checklist.npo = false; nd.checklist.npt = false; noteData[k] = nd;
    poner(blq()); r.A = reglas();
    // B: todo corregido + cirugía mañana sin ayuno
    nd.checklist.cirugias = [{ id: 'c1', fecha: manS, procedimiento: 'COLECISTECTOMÍA' }];
    poner(blq({ 'MEDIDAS GENERALES': ['CUANTIFICAR GASTO DE DRENAJES POR TURNO', 'PREPARAR PARA QUIRÓFANO'], 'ANTIBIÓTICOS': ['CEFTRIAXONA 1 G IV C/12 H FI 08/11/2026 (4)'], firma: 'DR X MBCG | DRA Y R1CG' }));
    r.B = reglas();
    // B2: con ayuno ya no avisa
    poner(blq({ DIETA: ['AYUNO A PARTIR DE LAS 00:00 HRS'], 'MEDIDAS GENERALES': ['CUANTIFICAR GASTO DE DRENAJES POR TURNO'], 'ANTIBIÓTICOS': ['CEFTRIAXONA 1 G IV C/12 H FI 08/11/2026 (4)'], firma: 'DR X MBCG' }));
    r.B2 = reglas();
    // C: dieta y ayuno a la vez; con horario no
    nd.checklist.cirugias = []; nd.checklist.dispositivos = [];
    poner(blq({ DIETA: ['AYUNO', 'DIETA LÍQUIDA'], 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' }));
    r.C = reglas();
    poner(blq({ DIETA: ['AYUNO', 'DIETA LÍQUIDA A PARTIR DE LAS 18 HRS'], 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' }));
    r.C2 = reglas();
    // C3: la tarjeta en ayuno y el Doc con dieta
    nd.checklist.npo = true; poner(blq({ 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' })); r.C3 = reglas(); nd.checklist.npo = false;
    // D: NPT sin labs; con labs de hoy no
    nd.checklist.npt = true; nd.labHistory = [];
    poner(blq({ 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' })); r.D = reglas();
    nd.labHistory = [{ fecha: hoyS, labs: { k: '4.1', na: '138', trig: '180' } }]; r.D2 = reglas(); nd.checklist.npt = false; nd.labHistory = [];
    // E: bloque viejo / sin fecha / sin sección; firma ausente en bloque de versión anterior (sin llave) no se juzga
    poner(blq({ fecha: ayerS, 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' })); r.E = reglas();
    poner(blq({ fecha: '', 'MEDIDAS GENERALES': [], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' })); r.E2 = reglas();
    const vieja = blq({ 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [] }); delete vieja.firma; poner(vieja); r.E3 = reglas();
    // F: la sección de indicaciones muestra la revisión plegada; ignorar en Sugerencias la quita
    nd.checklist.dispositivos = [{ id: 'd1', tipo: 'Penrose', fi: hoyS }]; poner(blq({ 'MEDIDAS GENERALES': ['SIGNOS VITALES POR TURNO'], 'ANTIBIÓTICOS': [], firma: 'DR X MBCG' }));
    r.htmlF = renderIndicacionesSection(p, getNote(k), k);
    const s = PLCDS.evaluate(p, getNote(k)).find(x => x.ruleId === 'ind_dren_gasto');
    PLCDSStore.ignore(k, s.ruleId, s.valueHash);
    r.htmlF2 = renderIndicacionesSection(p, getNote(k), k);
    // G: el lector del Doc guarda la firma («» si no hay)
    const txt = ['💯 3-120', '', 'INDICACIONES MÉDICAS DE PACIENTE SIETE', 'PACIENTE SIETE 40 AÑOS | CAMA 3-120', hoyD.getDate() + '/' + (hoyD.getMonth() + 1) + '/' + hoyD.getFullYear() + ' 8:00 am', '', 'DIETA', 'DIETA BLANDA', '', 'MEDICAMENTOS', 'PARACETAMOL 1 G IV C/8 H', '', 'MEDIDAS GENERALES', 'SIGNOS VITALES POR TURNO', 'GRACIAS', 'DR PRUEBA MBCG | DRA OTRA R1CG', '',
      'INDICACIONES MÉDICAS DE PACIENTE OCHO', 'PACIENTE OCHO 50 AÑOS | CAMA 3-121', hoyD.getDate() + '/' + (hoyD.getMonth() + 1) + '/' + hoyD.getFullYear() + ' 8:00 am', '', 'DIETA', 'AYUNO', '', 'MEDICAMENTOS', 'OMEPRAZOL 40 MG IV C/24 H', '', 'MEDIDAS GENERALES', 'SIGNOS VITALES POR TURNO', 'GRACIAS'].join('\n');
    const pb = PLIndicaciones.parsePasted(txt).blocks;
    r.G = pb.map(b => ({ cama: b.cama, firma: b.firma, medidas: b['MEDIDAS GENERALES'] }));
    nd.checklist.dispositivos = []; noteData[k] = nd;
    return r;
  });
  const has = (arr, ...ids) => ids.every(id => arr.indexOf(id) >= 0);
  const hora = new Date().getHours();
  check('I16 revisor de indicaciones: (A) drenaje en la tarjeta sin «cuantificar gasto», «preparar para quirófano» sin cirugía programada, antibiótico sin FI ni días y sin firma → los 4 avisos; (B) corregido y con cirugía mañana → solo «cirugía mañana sin ayuno»; con ayuno → nada',
    JSON.stringify(i16.A) === JSON.stringify(['ind_atb_sin_fi', 'ind_dren_gasto', 'ind_firma', 'ind_qx_sin_programar']) && JSON.stringify(i16.B) === JSON.stringify(['ind_cx_sin_ayuno']) && i16.B2.length === 0, JSON.stringify({ A: i16.A, B: i16.B, B2: i16.B2 }));
  check('I17 revisor de indicaciones: dieta y ayuno a la vez avisa, con horario («a partir de las 18 hrs») no; tarjeta en ayuno con dieta en el Doc avisa; NPT sin electrolitos ni triglicéridos avisa y con labs de hoy no',
    JSON.stringify(i16.C) === JSON.stringify(['ind_dieta_ayuno']) && i16.C2.length === 0 && JSON.stringify(i16.C3) === JSON.stringify(['ind_npo_dieta']) && JSON.stringify(i16.D) === JSON.stringify(['ind_npt_labs']) && i16.D2.length === 0,
    JSON.stringify({ C: i16.C, C2: i16.C2, C3: i16.C3, D: i16.D, D2: i16.D2 }));
  check('I18 revisor de indicaciones: bloque de hace 2 días (después de las 11:00) avisa «no hay de hoy»; sin fecha y sin medidas avisa; un bloque guardado por la versión anterior (sin la llave firma) no se juzga por la firma',
    (hora >= 11 ? JSON.stringify(i16.E) === JSON.stringify(['ind_vieja']) : i16.E.length === 0) && has(i16.E2, 'ind_sin_fecha', 'ind_seccion') && i16.E3.length === 0, JSON.stringify({ hora, E: i16.E, E2: i16.E2, E3: i16.E3 }));
  check('I19 la sección 💊 Indicaciones muestra «🔎 Revisión de indicaciones · 1 por revisar» plegada con el aviso del drenaje; al ignorarlo en Sugerencias desaparece',
    /data-testid="ind-rev"/.test(i16.htmlF) && /Revisión de indicaciones · <b>1<\/b> por revisar/.test(i16.htmlF) && /Drenaje sin «cuantificar gasto»/.test(i16.htmlF) && !/data-testid="ind-rev"/.test(i16.htmlF2),
    (i16.htmlF.match(/<details class="ind-rev[^]*?<\/details>/) || [''])[0].slice(0, 300));
  check('I20 el lector del Doc guarda la firma del equipo y no la mete en medidas; un bloque sin firma queda con firma «»',
    i16.G.length === 2 && i16.G[0].firma === 'DR PRUEBA MBCG | DRA OTRA R1CG' && JSON.stringify(i16.G[0].medidas) === '["SIGNOS VITALES POR TURNO"]' && i16.G[1].firma === '', JSON.stringify(i16.G));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-IND: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
