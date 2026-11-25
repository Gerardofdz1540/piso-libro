// 📄 Nota de alta automática + Drive (25 nov 2026, pedido de Gera). Pacientes y datos FICTICIOS.
// · Botón «📄 Alta» en la tarjeta de cada paciente: abre la ventana «Nota de alta» con todos los campos del formato del
//   hospital prellenados con la tarjeta (servicio, días, DX de ingreso/egreso, cirugías, Cronología, cita a la consulta
//   externa con el adscrito del censo, medicamentos de egreso si se operó o no, ATB oral activo).
// · Lo editado se guarda en checklist.alta_borrador (y la CURP en checklist.curp) por el guardado normal.
// · «⬇️ Descargar Word» baja un .docx que se abre: se descomprime aquí y se revisan word/document.xml y el encabezado.
// · «☁️ Guardar en Drive» sube a /storage/v1/object/altas/<patient_id>/… y hace POST a /rest/v1/altas_docs; con
//   drive_url aparece «Abrir en Drive». Sin red se descarga igual, queda en cola y se sube al volver la red.
// node tests/headless/app_alta.js   (ver run_all.sh)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const ROOT = path.join(__dirname, '..', '..');
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
const ID1 = '0b1e2c3d-0000-4000-8000-00000000a001', ID2 = '0b1e2c3d-0000-4000-8000-00000000a002';
const isoMenos = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
const dmy = (iso, sep, corto) => iso.slice(8, 10) + sep + iso.slice(5, 7) + sep + (corto ? iso.slice(2, 4) : iso.slice(0, 4));
const PTS = [
  { id: ID1, cama: '3-501', exp: '26-55501', nombre: 'PEDRO SALAS VIDAL', esp: 'CG', edad: '45', dx: 'APENDICITIS AGUDA + PO APENDICECTOMIA ABIERTA', ingreso: dmy(isoMenos(5), '/', true), adscrito: 'FERRO', residente: 'ROSAS R1', estado: 'ESTABLE' },
  { id: ID2, cama: '3-502', exp: '26-55502', nombre: 'LUNA GIL MARIA', esp: 'URO', edad: '63', dx: 'PIELONEFRITIS AGUDA', ingreso: dmy(isoMenos(3), '/', true), adscrito: 'Dr. Lara', residente: 'PONCE', estado: 'ESTABLE' },
];
// Descompresor mínimo de .zip (el .docx es un zip): directorio central + inflateRaw.
function unzip(buf) {
  const out = {}; let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no es zip');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const ini = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const data = buf.slice(ini, ini + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
(async () => {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const notePosts = [], storage = [], altasPosts = [], ALTAS = [];
  // Modo del bucket simulado: 'ok' | 'sinBucket' (lo que responde Supabase antes de aplicar supabase_altas.sql) y demora.
  const ST = { modo: 'ok', demora: 0 };
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/storage/v1/object/altas/**', async (route) => {
    const req = route.request();
    storage.push({ m: req.method(), url: req.url(), ct: req.headers()['content-type'] || '', auth: req.headers()['authorization'] || '', size: (req.postDataBuffer() || Buffer.alloc(0)).length });
    if (ST.demora) await new Promise(r => setTimeout(r, ST.demora));
    if (ST.modo === 'sinBucket') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ Key: 'altas/x' }) });
  });
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/, '')); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, PTS) : json(200, [{}]);
    if (url.startsWith('/rest/v1/notes') && m !== 'GET') { notePosts.push(req.postData() || ''); return json(201, [{}]); }
    if (url.startsWith('/rest/v1/altas_docs')) {
      if (m === 'POST') { const b = JSON.parse(req.postData() || '{}'); altasPosts.push({ body: b, auth: req.headers()['authorization'] || '' }); const row = Object.assign({ id: 'r' + ALTAS.length, creado_en: new Date().toISOString(), drive_url: null, error: null }, b); ALTAS.unshift(row); return json(201, [row]); }
      const pidm = /patient_id=eq\.([^&]+)/.exec(url);
      return json(200, ALTAS.filter(r => !pidm || r.patient_id === pidm[1]));
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 900) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  // Notas ficticias: P1 operado (caja de Cirugías + Cronología con firmas), P2 sin cirugía con ATB oral y pendiente externo.
  const cx = isoMenos(4), c1 = isoMenos(3), c2 = isoMenos(2);
  const fx = await page.evaluate(({ cx, c1, c2 }) => {
    const dm = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(2, 4);
    const ks = patients.map(pid);
    const n1 = defaultData();
    n1.app = 'Niega';
    n1.checklist.sexo = 'M';
    n1.checklist.cirugias = [{ id: 'cxa', fecha: cx, procedimiento: 'Apendicectomía abierta', hallazgos: 'apéndice fase II, sin perforación', sangrado: '', cirujano: '' }];
    n1.entrega = 'Gerardo ' + dm(c2) + ' 09:10 - Tolera dieta blanda, canaliza gases\n'
      + 'Gerardo ' + dm(c1) + ' 22:00 - Se retira sonda Foley\n'
      + 'Gerardo ' + dm(c1) + ' 08:00 - Inicia dieta líquida\n'
      + 'Gerardo ' + dm(c1) + ' 07:00 - Inicia dieta líquida';
    n1.pendientes = 'Revisar herida hoy';
    noteData[ks[0]] = n1;
    const n2 = defaultData();
    n2.app = 'DM2 de 10 años en tratamiento con metformina';
    n2.checklist.atb = true; n2.checklist.atb_nombre = 'Ciprofloxacino 500 mg VO';
    n2.pendientes = 'Cita a consulta externa de urología para retiro de sonda\nPedir BH hoy';
    noteData[ks[1]] = n2;
    try { renderView(); } catch (_) {}
    ks.forEach(k => { try { _rerenderCard(k); } catch (_) {} });
    return ks;
  }, { cx, c1, c2 });
  const [K1, K2] = fx;
  await page.waitForTimeout(500);

  // A1 — botón en la tarjeta de cada paciente
  // El tablero muestra un paciente a la vez (tarjeta completa o sencilla según el servicio): se recorre cada uno.
  const btns = [];
  for (const k of fx) btns.push(await page.evaluate((k) => {
    window.__focusPid = k; renderView();
    const card = document.getElementById('card-' + k);
    const b = card ? card.querySelector('[data-testid="alta-doc"]') : null;
    const r = b ? b.getBoundingClientRect() : null;
    const egr = card ? card.querySelector('[data-confirmkey]') : null;
    const vecino = (el) => { let x = el; do { x = x && x.previousElementSibling; } while (x && x.tagName !== 'BUTTON'); return x; };
    const sig = (el) => { let x = el; do { x = x && x.nextElementSibling; } while (x && x.tagName !== 'BUTTON'); return x; };
    return { card: !!card, b: !!b, vis: !!(r && r.width > 10 && r.height > 10), txt: b ? b.textContent.trim() : '', simple: !!(card && card.classList.contains('simple-card')),
      lbl: !!(b && b.classList.contains('has-lbl')), egrTxt: egr ? egr.textContent.trim() : '', junto: !!(b && egr && (vecino(b) === egr || sig(b) === egr)) };
  }, k));
  await page.evaluate((k) => { window.__focusPid = k; renderView(); }, K1);
  check('A1 cada tarjeta (completa y sencilla) trae el botón «📄» de la nota de alta (data-testid="alta-doc") visible', btns.every(x => x.card && x.b && x.vis && /📄/.test(x.txt)) && btns.some(x => x.simple) && btns.some(x => !x.simple), JSON.stringify(btns));
  // Revisión 25 nov 2026: «📄 Alta» quedaba pegado a «🚪 Alta» (egresar) con la misma etiqueta. Ahora: «Nota alta» en la
  // completa, sin etiqueta en la sencilla (no crece su encabezado) y en las dos con otro botón de por medio.
  const bc = btns.find(x => !x.simple), bs = btns.find(x => x.simple);
  check('A1b el botón de la nota dice «Nota alta» (distinto de «🚪 Alta») y no queda junto a 🚪; en la tarjeta sencilla va sin etiqueta',
    /Nota alta/.test(bc.txt) && /🚪/.test(bc.egrTxt) && !/Nota/.test(bc.egrTxt) && !bc.junto && !bs.junto && !bs.lbl && bs.txt === '📄', JSON.stringify(btns));

  // A2 — prellenado del operado
  await page.click('#card-' + K1.replace(/([^a-zA-Z0-9_-])/g, '\\$1') + ' [data-testid="alta-doc"]');
  await page.waitForSelector('#alta-doc-modal', { state: 'visible' });
  const val = (f) => page.evaluate((f) => document.getElementById('alta-f-' + f).value, f);
  const hoy = isoMenos(0);
  const f = {}; for (const k of ['fecha_elab', 'hora', 'nombre', 'edad', 'sexo', 'exp', 'servicio', 'ingreso', 'egreso', 'dias', 'dx_ingreso', 'dx_egreso', 'antecedentes', 'evolucion', 'pendientes', 'meds', 'recomendaciones', 'factores', 'pronostico', 'motivo', 'firma_adscrito', 'firma_residente']) f[k] = await val(k);
  check('A2 datos generales: fecha de elaboración y egreso hoy (DD.MM.AAAA), hora HH:MM, servicio CG → CIRUGÍA GENERAL, ingreso y 5 días, sexo de la tarjeta',
    f.fecha_elab === dmy(hoy, '.') && f.egreso === dmy(hoy, '.') && /^\d{2}:\d{2}$/.test(f.hora) && f.servicio === 'CIRUGÍA GENERAL' && f.ingreso === dmy(isoMenos(5), '.') && f.dias === '5'
      && f.sexo === 'MASCULINO' && f.nombre === 'PEDRO SALAS VIDAL' && f.edad === '45' && f.exp === '26-55501', JSON.stringify(f));
  check('A3 DX de ingreso sin «+ PO …» y DX de egreso completo', f.dx_ingreso === 'APENDICITIS AGUDA' && f.dx_egreso === 'APENDICITIS AGUDA + PO APENDICECTOMIA ABIERTA', JSON.stringify([f.dx_ingreso, f.dx_egreso]));
  check('A4 antecedentes: «PACIENTE MASCULINO DE LA QUINTA DÉCADA DE LA VIDA SIN ANTECEDENTES…» (APP «Niega»)', f.antecedentes === 'PACIENTE MASCULINO DE LA QUINTA DÉCADA DE LA VIDA SIN ANTECEDENTES DE IMPORTANCIA PARA EL PADECIMIENTO ACTUAL.', f.antecedentes);
  const ev = f.evolucion;
  check('A5 narrativa: introducción, la cirugía con su fecha, procedimiento y hallazgos, los renglones de la Cronología (sin firmas, sin repetir, del más viejo al más reciente) y el cierre por mejoría',
    /^PACIENTE MASCULINO DE LA QUINTA DÉCADA DE LA VIDA, QUIEN ACUDE .* CUADRO COMPATIBLE CON APENDICITIS AGUDA/.test(ev)
      && ev.indexOf('SE DECIDE PASAR A QUIRÓFANO PARA LA REALIZACIÓN DE APENDICECTOMÍA ABIERTA EL ' + dmy(cx, '.') + ', MISMA QUE REPORTA COMO HALLAZGOS APÉNDICE FASE II, SIN PERFORACIÓN.') >= 0
      && ev.indexOf('EL ' + dmy(c1, '.') + ' INICIA DIETA LÍQUIDA; SE RETIRA SONDA FOLEY.') >= 0 && ev.indexOf('EL ' + dmy(c2, '.') + ' TOLERA DIETA BLANDA, CANALIZA GASES.') >= 0
      && ev.indexOf(dmy(c1, '.')) < ev.indexOf(dmy(c2, '.')) && (ev.match(/INICIA DIETA LÍQUIDA/g) || []).length === 1 && !/GERARDO/.test(ev)
      && /SE DA DE ALTA DEL SERVICIO DE CIRUGÍA GENERAL POR MEJORÍA CLÍNICA\.$/.test(ev), ev);
  const pend = f.pendientes.split('\n');
  check('A6 pendientes: cita a la consulta externa con el adscrito del censo, retiro de puntos y reposo (no lo de «hoy» de la caja)',
    pend[0] === 'CITA A LA CONSULTA EXTERNA DE CIRUGÍA GENERAL CON EL DR. FERRO A DISPONIBILIDAD' && pend.includes('RETIRO DE PUNTOS EN 10 DÍAS EN CENTRO DE SALUD') && pend.includes('REPOSO RELATIVO EN CASA DURANTE 10 DÍAS') && pend.length === 3, f.pendientes);
  const meds = f.meds.split('\n');
  check('A7 operado → cefalexina + paracetamol + diclofenaco con posología', meds.length === 3 && /^CEFALEXINA TABLETAS 500 MG\. TOMAR 1 TABLETA VÍA ORAL CADA 8 HORAS POR 7 DÍAS$/.test(meds[0]) && /^PARACETAMOL .*CADA 8 HORAS POR 4 DÍAS$/.test(meds[1]) && /^DICLOFENACO .*CADA 12 HORAS POR 4 DÍAS$/.test(meds[2]), f.meds);
  check('A8 recomendaciones del formato (lavado de herida), factores, pronóstico, motivo y firmas',
    /LAVADO DE HERIDA QUIRÚRGICA/.test(f.recomendaciones) && /NO ESFUERZOS FÍSICOS.*10 KG/.test(f.recomendaciones) && /DATOS DE ALARMA CON CITA ABIERTA A URGENCIAS/.test(f.recomendaciones)
      && f.factores === 'ATENCIÓN POR PARTE DEL SERVICIO DE CIRUGÍA GENERAL' && f.pronostico === 'RESERVADO A EVOLUCIÓN' && f.motivo === 'MEJORÍA'
      && f.firma_adscrito === 'DR FERRO MBCG' && f.firma_residente === 'DR ROSAS R1CG', JSON.stringify([f.recomendaciones, f.firma_adscrito, f.firma_residente]));
  const posts0 = notePosts.length;
  await page.waitForTimeout(1200);
  check('A9 solo abrir la ventana no escribe nada en la nota', notePosts.length === posts0 && !(await page.evaluate((k) => !!(noteData[k].checklist || {}).alta_borrador, K1)), String(notePosts.length - posts0));

  // A10 — edición: se guarda en el checklist (borrador + CURP) y sube con el guardado normal; el cierre sigue al motivo.
  await page.selectOption('#alta-f-motivo', 'PASE A OTRO HOSPITAL');
  await page.fill('#alta-f-motivo_hosp', 'HOSPITAL REGIONAL FICTICIO');
  await page.dispatchEvent('#alta-f-motivo_hosp', 'change');
  await page.fill('#alta-f-pronostico', 'BUENO PARA LA VIDA');
  await page.fill('#alta-f-curp', 'XAXX010101HGTLLL09');
  await page.selectOption('#alta-med-sel', 'omeprazol');
  await page.click('[data-testid="alta-med-add"]');
  await page.waitForTimeout(1500);
  const ed = await page.evaluate((k) => { const ck = noteData[k].checklist || {}; return { b: ck.alta_borrador || null, curp: ck.curp || '', ev: document.getElementById('alta-f-evolucion').value, hosp: getComputedStyle(document.getElementById('alta-hosp-wrap')).display }; }, K1);
  check('A10 lo editado se guarda en checklist.alta_borrador (motivo, hospital, pronóstico, medicamento agregado) y la CURP en checklist.curp',
    ed.b && ed.b.motivo === 'PASE A OTRO HOSPITAL' && ed.b.motivo_hosp === 'HOSPITAL REGIONAL FICTICIO' && ed.b.pronostico === 'BUENO PARA LA VIDA' && ed.b.meds.length === 4 && /^OMEPRAZOL/.test(ed.b.meds[3]) && ed.b.por === 'Tester' && ed.curp === 'XAXX010101HGTLLL09' && ed.hosp !== 'none',
    JSON.stringify(ed).slice(0, 600));
  check('A11 el cierre de la narrativa sigue al motivo del egreso', /SE EGRESA DEL SERVICIO DE CIRUGÍA GENERAL POR PASE A OTRO HOSPITAL \(HOSPITAL REGIONAL FICTICIO\)\.$/.test(ed.ev), ed.ev.slice(-200));
  check('A12 el borrador sube a la nube con el guardado normal de la nota', notePosts.slice(posts0).some(b => /alta_borrador/.test(b) && /HOSPITAL REGIONAL FICTICIO/.test(b)), notePosts.slice(posts0).map(b => b.slice(0, 150)).join(' || '));
  await page.click('[data-testid="alta-cerrar"]');
  await page.click('#card-' + K1.replace(/([^a-zA-Z0-9_-])/g, '\\$1') + ' [data-testid="alta-doc"]');
  await page.waitForSelector('#alta-doc-modal', { state: 'visible' });
  const re = { pr: await val('pronostico'), mot: await val('motivo'), curp: await val('curp'), aviso: await page.textContent('[data-testid="alta-aviso"]'), cambio: await page.$('[data-testid="alta-cambio"]') };
  check('A13 al cerrar y volver a abrir sale el borrador (no se pierde lo editado) y, como la tarjeta no cambió, sin aviso de cambio', re.pr === 'BUENO PARA LA VIDA' && re.mot === 'PASE A OTRO HOSPITAL' && re.curp === 'XAXX010101HGTLLL09' && /Borrador guardado/.test(re.aviso) && /Tester/.test(re.aviso) && !re.cambio, JSON.stringify(re));

  // A14 — Word: se descarga y se abre (zip con document.xml, encabezado con la imagen del formato)
  let dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('[data-testid="alta-descargar"]');
  let d1 = await dl;
  const buf = fs.readFileSync(await d1.path());
  let z = {}; try { z = unzip(buf); } catch (e) { z = { err: String(e) }; }
  const doc = z['word/document.xml'] ? z['word/document.xml'].toString('utf8') : '';
  const txt = (doc.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
  const hdrName = Object.keys(z).find(n => /^word\/header\d*\.xml$/.test(n));
  const hdr = hdrName ? z[hdrName].toString('utf8') : '';
  const media = Object.keys(z).filter(n => /^word\/media\/.+\.png$/.test(n));
  const pngSize = fs.statSync(path.join(ROOT, 'vendor', 'alta-encabezado.png')).size;
  check('A14 el .docx descargado se llama «ALTA <exp> <NOMBRE> <fecha>.docx» y se abre (zip con word/document.xml)', d1.suggestedFilename() === 'ALTA 26-55501 PEDRO SALAS VIDAL ' + hoy + '.docx' && !!doc, d1.suggestedFilename() + ' ' + Object.keys(z).join(','));
  check('A15 document.xml trae los textos clave del formato y de la nota',
    ['FECHA DE ELABORACIÓN:', 'NOMBRE DEL PACIENTE:', 'PEDRO SALAS VIDAL', 'XAXX010101HGTLLL09', 'NO. DE DÍAS DE HOSPITALIZACIÓN:', 'DIAGNÓSTICO DE INGRESO:', 'RESUMEN CLÍNICO:', 'ANTECEDENTES DE IMPORTANCIA',
      'EVOLUCIÓN, MANEJO Y ESTADO ACTUAL', 'APENDICECTOMÍA ABIERTA EL ' + dmy(cx, '.'), 'CITA A LA CONSULTA EXTERNA DE CIRUGÍA GENERAL CON EL DR. FERRO A DISPONIBILIDAD', 'CEFALEXINA TABLETAS 500 MG', 'OMEPRAZOL',
      'RECOMENDACIONES PARA VIGILANCIA AMBULATORIA', 'BUENO PARA LA VIDA', 'MOTIVO DEL EGRESO', 'MEJORÍA / (X) PASE A OTRO HOSPITAL CUAL: HOSPITAL REGIONAL FICTICIO / DEFUNCIÓN: ________', 'DR FERRO MBCG', 'DR ROSAS R1CG',
      'SELLO Y FIRMA DE MÉDICO ADSCRITO', 'NOMBRE CÉDULA Y FIRMA DE MÉDICO RESIDENTE'].every(s => txt.indexOf(s) >= 0)
      && /<w:pgSz w:w="11909" w:h="16834"/.test(doc) && /<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/.test(doc) && /w:ascii="Calibri"/.test(z['word/styles.xml'] ? z['word/styles.xml'].toString('utf8') + doc : doc) && /<w:numPr>/.test(doc),
    txt.slice(0, 900));
  check('A16 el encabezado del Word lleva la imagen del formato (logo + recuadro), del mismo tamaño que vendor/alta-encabezado.png',
    !!hdr && /<w:drawing>/.test(hdr) && /behindDoc="1"/.test(hdr) && media.length === 1 && z[media[0]].length === pngSize, JSON.stringify({ hdrName, media, pngSize, len: media[0] && z[media[0]].length }));

  // A17 — Guardar en Drive (con red): descarga + subida al bucket + fila en altas_docs; luego «Abrir en Drive»
  dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('[data-testid="alta-drive"]');
  const d2 = await dl;
  await page.waitForFunction(() => /Subido; aparecerá en Drive en ≤5 min/.test(document.getElementById('alta-estado').textContent), null, { timeout: 15000 }).catch(() => {});
  const est = await page.textContent('[data-testid="alta-estado"]');
  const up = storage[storage.length - 1] || {};
  const ap = altasPosts[altasPosts.length - 1] || { body: {} };
  const rx = new RegExp('/storage/v1/object/altas/' + ID1 + '/' + hoy + '_26-55501_\\d{12,}\\.docx$');
  check('A17 «☁️ Guardar en Drive» descarga el Word y lo sube a /storage/v1/object/altas/<patient_id>/<AAAA-MM-DD>_<exp>_<ms>.docx con el token del usuario',
    !!d2 && storage.length === 1 && up.m === 'POST' && rx.test(up.url) && up.ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && up.auth === 'Bearer mock-token-123' && up.size > 5000, JSON.stringify(up));
  check('A18 y registra la fila en altas_docs (patient_id, exp, nombre, fecha, storage_path, creado_por); muestra «Subido; aparecerá en Drive en ≤5 min»',
    altasPosts.length === 1 && ap.body.patient_id === ID1 && ap.body.exp === '26-55501' && ap.body.nombre === 'PEDRO SALAS VIDAL' && ap.body.fecha === hoy && ap.body.creado_por === 'Tester'
      && up.url.endsWith('/' + ap.body.storage_path) && ap.auth === 'Bearer mock-token-123' && /Subido; aparecerá en Drive en ≤5 min/.test(est), JSON.stringify({ ap, est }));
  ALTAS[0].drive_url = 'https://drive.google.com/file/d/FICTICIO123/view';
  ALTAS.push({ id: 'viejo', patient_id: ID1, fecha: isoMenos(30), storage_path: ID1 + '/viejo.docx', creado_en: new Date(Date.now() - 30 * 864e5).toISOString(), creado_por: 'Otro', drive_url: 'javascript:alert(1)', error: null });
  await page.evaluate((k) => _altaListar(k), K1);
  await page.waitForTimeout(300);
  const lista = await page.evaluate(() => ({ est: document.getElementById('alta-estado').innerHTML, rows: Array.from(document.querySelectorAll('[data-testid="alta-row"]')).map(r => r.innerHTML) }));
  check('A19 cuando altas_docs ya tiene drive_url aparece «Abrir en Drive» (estado y lista de altas previas); un enlace que no es de Google Drive no se pinta',
    /href="https:\/\/drive\.google\.com\/file\/d\/FICTICIO123\/view"/.test(lista.est) && /Abrir en Drive/.test(lista.est) && lista.rows.length === 2 && /FICTICIO123/.test(lista.rows[0]) && !/javascript:/.test(lista.rows.join('')), JSON.stringify(lista));
  await page.click('[data-testid="alta-cerrar"]');

  // A20 — paciente sin cirugía: urología, sexo por el nombre, ATB oral activo, pendiente externo de la caja
  await page.evaluate((k) => openAltaDoc(k), K2);
  const g = {}; for (const k of ['sexo', 'servicio', 'dias', 'dx_ingreso', 'antecedentes', 'evolucion', 'pendientes', 'meds', 'recomendaciones', 'firma_adscrito', 'firma_residente']) g[k] = await val(k);
  check('A20 sin cirugía: UROLOGÍA, 3 días, sexo deducido del nombre, APP en antecedentes, sin cirugía en la narrativa',
    g.servicio === 'UROLOGÍA' && g.dias === '3' && g.sexo === 'FEMENINO' && g.dx_ingreso === 'PIELONEFRITIS AGUDA'
      && g.antecedentes === 'PACIENTE FEMENINO DE LA SÉPTIMA DÉCADA DE LA VIDA CON ANTECEDENTES DE DM2 DE 10 AÑOS EN TRATAMIENTO CON METFORMINA.'
      && !/QUIRÓFANO|POSTQUIRÚRGICA/.test(g.evolucion) && /SE DA DE ALTA DEL SERVICIO DE UROLOGÍA POR MEJORÍA CLÍNICA\.$/.test(g.evolucion), JSON.stringify(g).slice(0, 900));
  check('A21 sin cirugía: cita con el adscrito (sin «Dr.» repetido), sin retiro de puntos, más el pendiente externo de la caja (no «Pedir BH hoy»)',
    g.pendientes === 'CITA A LA CONSULTA EXTERNA DE UROLOGÍA CON EL DR. LARA A DISPONIBILIDAD\nREPOSO RELATIVO EN CASA DURANTE 10 DÍAS\nCITA A CONSULTA EXTERNA DE UROLOGÍA PARA RETIRO DE SONDA'
      && !/LAVADO DE HERIDA/.test(g.recomendaciones) && g.firma_adscrito === 'DR LARA MBURO' && g.firma_residente === 'DR PONCE R_URO', JSON.stringify([g.pendientes, g.firma_adscrito, g.firma_residente]));
  check('A22 sin cirugía y con ciprofloxacino oral activo → ciprofloxacino + paracetamol', /^CIPROFLOXACINO TABLETAS 500 MG\..*\nPARACETAMOL TABLETAS 500 MG\./.test(g.meds) && g.meds.split('\n').length === 2, g.meds);

  // A23 — sin red: el Word se descarga, queda en cola y se sube solo al volver la red
  const s0 = storage.length, a0 = altasPosts.length;
  await context.setOffline(true);
  dl = page.waitForEvent('download', { timeout: 20000 });
  await page.click('[data-testid="alta-drive"]');
  const d3 = await dl;
  await page.waitForFunction(() => /Sin conexión/.test(document.getElementById('alta-estado').textContent), null, { timeout: 15000 }).catch(() => {});
  const off = await page.evaluate(() => ({ est: document.getElementById('alta-estado').textContent, cola: JSON.parse(localStorage.getItem('pl_altas_cola_v1') || '[]').map(x => ({ id: x.id, pidt: x.patient_id, rel: x.rel, b64: (x.b64 || '').length })), lista: document.getElementById('alta-lista').textContent }));
  check('A23 sin red: se descarga igual, avisa «Sin conexión…» y queda 1 en la cola de este iPad (con el .docx en base64)',
    !!d3 && /Sin conexión/.test(off.est) && off.cola.length === 1 && off.cola[0].pidt === ID2 && off.cola[0].b64 > 5000 && storage.length === s0 && /en cola en este iPad/.test(off.lista), JSON.stringify(off));
  await context.setOffline(false);
  await page.waitForFunction(() => !localStorage.getItem('pl_altas_cola_v1'), null, { timeout: 20000 }).catch(() => {});
  const after = { cola: await page.evaluate(() => localStorage.getItem('pl_altas_cola_v1')), up: storage.slice(s0), ap: altasPosts.slice(a0).map(x => x.body) };
  check('A24 al volver la red la cola se sube sola (bucket + altas_docs) y se vacía',
    !after.cola && after.up.length === 1 && new RegExp('/storage/v1/object/altas/' + ID2 + '/' + hoy + '_26-55502_\\d+\\.docx$').test(after.up[0].url) && after.ap.length === 1 && after.ap[0].patient_id === ID2 && after.up[0].url.endsWith('/' + after.ap[0].storage_path), JSON.stringify(after));
  await page.waitForTimeout(500);
  await page.click('[data-testid="alta-cerrar"]');


  // ══ Revisión adversarial (25 nov 2026): una prueba por arreglo ══════════════════════════════════════════════════════
  const cerrarSiAbierta = () => page.evaluate(() => { if (document.getElementById('alta-doc-modal') && document.getElementById('alta-doc-modal').style.display !== 'none') altaDocCerrar(); });
  const tieneBorrador = (k) => page.evaluate((k) => !!((noteData[k].checklist || {}).alta_borrador), k);
  await cerrarSiAbierta();

  // R1 — abrir y cerrar sin editar no escribe borrador (ni en la nota ni en la nube)
  {
    const p0 = notePosts.length;
    const antes = await tieneBorrador(K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    await page.waitForTimeout(300);
    await page.click('[data-testid="alta-cerrar"]');
    await page.waitForTimeout(1500);
    check('R1 abrir y cerrar la ventana sin editar NO crea checklist.alta_borrador ni sube nada (tampoco «Guardar en Drive» sin editar, en A23)',
      !antes && !(await tieneBorrador(K2)) && !notePosts.slice(p0).some(b => /alta_borrador/.test(b)), String(notePosts.length - p0));
  }
  // R2 — huella del prellenado: si la tarjeta cambió desde el borrador, aviso visible junto a «↻ Rehacer»
  {
    await page.evaluate((k) => openAltaDoc(k), K2);
    await page.fill('#alta-f-pronostico', 'BUENO PARA LA FUNCIÓN');
    await page.waitForTimeout(1300);
    await page.click('[data-testid="alta-cerrar"]');
    const b1 = await page.evaluate((k) => noteData[k].checklist.alta_borrador, K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const sinCambio = !(await page.$('[data-testid="alta-cambio"]'));
    await page.click('[data-testid="alta-cerrar"]');
    await page.evaluate((k) => { noteData[k].app = 'HAS de 5 años'; }, K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const av = await page.evaluate(() => { const c = document.querySelector('[data-testid="alta-cambio"]'); const r = c && c.getBoundingClientRect(); return { txt: c ? c.textContent : '', vis: !!(r && r.width > 0 && r.height > 0), rehacer: !!document.querySelector('#alta-aviso [data-testid="alta-rehacer"]'), pr: document.getElementById('alta-f-pronostico').value }; });
    check('R2 el borrador guarda la huella del prellenado; al reabrir sin cambios no avisa, y si la tarjeta cambió (APP) avisa visible «La tarjeta cambió…» junto a «↻ Rehacer» (sin perder lo editado)',
      !!b1 && /^h/.test(b1.huella || '') && sinCambio && /La tarjeta cambió/.test(av.txt) && av.vis && av.rehacer && av.pr === 'BUENO PARA LA FUNCIÓN', JSON.stringify({ b1h: b1 && b1.huella, sinCambio, av }));
    await page.click('[data-testid="alta-rehacer"]');
    await page.waitForTimeout(300);
    await page.click('[data-testid="alta-cerrar"]');
    await page.evaluate((k) => openAltaDoc(k), K2);
    const tras = { cambio: !!(await page.$('[data-testid="alta-cambio"]')), ant: await val('antecedentes') };
    check('R2b «↻ Rehacer» toma la tarjeta nueva y su huella: al reabrir ya no avisa', !tras.cambio && /HAS DE 5 AÑOS/.test(tras.ant), JSON.stringify(tras));
    await page.click('[data-testid="alta-cerrar"]');
  }
  // R3 — no pisar el borrador de otro iPad si aquí no se editó; si los dos editaron gana el último, con aviso
  {
    const otro = (k) => page.evaluate((k) => { const b = Object.assign({}, noteData[k].checklist.alta_borrador, { ts: Date.now() + 5, por: 'iPadB', pronostico: 'BUENO (B)', meds: ['OMEPRAZOL B'] }); noteData[k].checklist.alta_borrador = b; }, k);
    await page.evaluate((k) => openAltaDoc(k), K2);
    await otro(K2);
    const p0 = notePosts.length;
    await page.click('[data-testid="alta-cerrar"]');
    await page.waitForTimeout(1200);
    const b = await page.evaluate((k) => noteData[k].checklist.alta_borrador, K2);
    check('R3 con la ventana abierta llega el borrador de otro iPad; se cierra sin editar → se queda el de B (nada sube un borrador que no sea el de B)',
      b.por === 'iPadB' && b.pronostico === 'BUENO (B)' && b.meds.join() === 'OMEPRAZOL B' && !notePosts.slice(p0).some(x => { try { const a = (JSON.parse(x).checklist || {}).alta_borrador; return !!a && a.por !== 'iPadB'; } catch (_) { return true; } }), JSON.stringify({ por: b.por, pr: b.pronostico, posts: notePosts.slice(p0).map(x => { try { const c = JSON.parse(x).checklist || {}; return c.alta_borrador ? c.alta_borrador.por + '|' + c.alta_borrador.pronostico : '-'; } catch (_) { return x.slice(0, 100); } }) }));
    await page.evaluate((k) => openAltaDoc(k), K2);
    await otro(K2);
    await page.fill('#alta-f-pronostico', 'BUENO PARA LA VIDA (A)');
    await page.waitForTimeout(1300);
    const r = await page.evaluate((k) => ({ b: noteData[k].checklist.alta_borrador, est: document.getElementById('alta-estado').textContent, cls: document.getElementById('alta-estado').className }), K2);
    check('R3b si los dos editaron gana el último (este) pero avisa «se guardó otro borrador (iPadB…)… quedó el tuyo encima»',
      r.b.por === 'Tester' && r.b.pronostico === 'BUENO PARA LA VIDA (A)' && /otro borrador/.test(r.est) && /iPadB/.test(r.est) && r.cls === 'warn', JSON.stringify({ por: r.b.por, est: r.est }));
    await page.click('[data-testid="alta-cerrar"]');
  }
  // R4 — doble toque en «Guardar en Drive» durante la subida: una sola subida y una sola fila; botones deshabilitados
  {
    await page.evaluate((k) => openAltaDoc(k), K1);
    const s0 = storage.length, a0 = altasPosts.length;
    ST.demora = 1500;
    const r = await page.evaluate(async () => {
      const est = () => document.getElementById('alta-estado').textContent;
      const p1 = altaGuardarDrive();
      for (let i = 0; i < 200 && !/Subiendo/.test(est()); i++) await new Promise(r => setTimeout(r, 25));
      const dis = ['alta-drive', 'alta-descargar'].map(t => document.querySelector('[data-testid="' + t + '"]').disabled);
      const p2 = altaGuardarDrive();
      await Promise.all([p1, p2]);
      return { dis, des: ['alta-drive', 'alta-descargar'].map(t => document.querySelector('[data-testid="' + t + '"]').disabled), est: est() };
    });
    ST.demora = 0;
    await page.waitForTimeout(300);
    check('R4 doble toque en «☁️ Guardar en Drive» mientras dice «Subiendo…»: 1 subida al bucket y 1 fila en altas_docs; Drive y Descargar deshabilitados mientras dura',
      storage.length - s0 === 1 && altasPosts.length - a0 === 1 && r.dis.every(Boolean) && r.des.every(x => !x) && /Subido/.test(r.est), JSON.stringify({ up: storage.length - s0, rows: altasPosts.length - a0, r }));
  }
  // R5 — error permanente (bucket aún sin crear): no se reintenta solo; queda marcado con Reintentar / Descartar
  {
    const s0 = storage.length;
    ST.modo = 'sinBucket';
    await page.evaluate(() => altaGuardarDrive());
    await page.waitForTimeout(300);
    const c1 = await page.evaluate(() => JSON.parse(localStorage.getItem('pl_altas_cola_v1') || '[]').map(x => ({ perm: !!x.permanente, int: x.intentos, uid: x.uid })));
    const s1 = storage.length;
    for (let i = 0; i < 3; i++) await page.evaluate(() => _altaColaSubir());
    await page.evaluate((k) => _altaListar(k), K1);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({ est: document.getElementById('alta-estado').textContent, row: !!document.querySelector('[data-testid="alta-row-cola-error"]'), re: !!document.querySelector('[data-testid="alta-cola-reintentar"]'), de: !!document.querySelector('[data-testid="alta-cola-descartar"]'), poll: _altaPollT }));
    check('R5 bucket inexistente (HTTP 400 «Bucket not found») → error permanente: queda 1 en la cola marcado, 3 pasadas de la cola NO lo resuben, y la lista lo muestra con «Reintentar» y «Descartar»',
      s1 - s0 === 1 && c1.length === 1 && c1[0].perm && storage.length === s1 && /no se arregla solo/.test(r.est) && r.row && r.re && r.de, JSON.stringify({ c1, sub: storage.length - s0, r }));
    ST.modo = 'ok';
    await page.click('[data-testid="alta-cola-reintentar"]', { timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => !localStorage.getItem('pl_altas_cola_v1'), null, { timeout: 8000 }).catch(() => {});
    check('R5b «↻ Reintentar» (ya con el bucket) lo sube y vacía la cola', storage.length === s1 + 1 && !(await page.evaluate(() => localStorage.getItem('pl_altas_cola_v1'))), String(storage.length - s1));
    ST.modo = 'sinBucket';
    await page.evaluate(() => altaGuardarDrive());
    await page.waitForSelector('[data-testid="alta-cola-descartar"]', { timeout: 8000 }).catch(() => {});
    await page.click('[data-testid="alta-cola-descartar"]', { timeout: 5000 }).catch(() => {});
    ST.modo = 'ok';
    check('R5c «✕ Descartar» lo quita de la cola', !(await page.evaluate(() => localStorage.getItem('pl_altas_cola_v1'))));
    await page.evaluate(() => localStorage.removeItem('pl_altas_cola_v1'));
    await page.click('[data-testid="alta-cerrar"]');
  }
  // R6 — la cola guarda la cuenta (myUserId) y no se sube con otra; caducidad por días, intentos y paciente que ya no está
  {
    const s0 = storage.length;
    const r = await page.evaluate((ID1) => {
      const ahora = Date.now(), b64 = btoa('PK-FICTICIO');
      const base = { exp: '26-55501', nombre: 'FICTICIO', fecha: '2026-11-25', b64, intentos: 0 };
      localStorage.setItem('pl_altas_cola_v1', JSON.stringify([
        Object.assign({}, base, { id: 'otra', key: 'x', patient_id: ID1, rel: 'a_otra.docx', ts: ahora, uid: 'cuenta-de-otro' }),
        Object.assign({}, base, { id: 'vieja', key: 'x', patient_id: ID1, rel: 'a_vieja.docx', ts: ahora - 8 * 864e5, uid: myUserId() }),
        Object.assign({}, base, { id: 'muchos', key: 'x', patient_id: ID1, rel: 'a_muchos.docx', ts: ahora, uid: myUserId(), intentos: 20 }),
        Object.assign({}, base, { id: 'sinpac', key: 'pt-nadie-0', exp: 'NO-EXISTE', patient_id: '', rel: 'a_sinpac.docx', ts: ahora - 25 * 3600e3, uid: myUserId() })
      ]));
      return _altaColaSubir().then(() => JSON.parse(localStorage.getItem('pl_altas_cola_v1') || '[]').map(x => x.id));
    }, ID1);
    check('R6 cola: el elemento de OTRA cuenta no se sube con esta sesión (se queda), y se descartan sin subir los de >7 días, los de 20 intentos y los sin patient_id cuyo paciente ya no está (>24 h)',
      storage.length === s0 && JSON.stringify(r) === JSON.stringify(['otra']), JSON.stringify({ r, sub: storage.length - s0 }));
    const t = await page.evaluate(() => { const els = Array.from(document.querySelectorAll('div')).filter(d => /Se descartaron 3 notas de alta/.test(d.textContent) && d.children.length === 0); return els.length > 0; });
    check('R6b al descartar por caducidad avisa «Se descartaron 3 notas de alta…»', t);
    const f = await page.evaluate(() => {
      const ahora = Date.now(), b64 = btoa('PK');
      localStorage.setItem('pl_altas_cola_v1', JSON.stringify([1, 2, 3].map(i => ({ id: 'q' + i, key: 'x', patient_id: '', b64, ts: ahora - i * 1000, uid: '' }))));
      const freed = lsFreeSpace();
      return { freed, q: JSON.parse(localStorage.getItem('pl_altas_cola_v1') || '[]').map(x => x.id) };
    });
    check('R6c lsFreeSpace() libera la cola de altas: se queda solo la más reciente', f.freed && JSON.stringify(f.q) === '["q1"]', JSON.stringify(f));
    const tope = await page.evaluate(() => ALTA_COLA_MAX_TOTAL);
    check('R6d el tope total de la cola bajó (≤ 1.5 MB de base64) para no competir con notas y outbox', tope <= 1500000, String(tope));
    await page.evaluate(() => localStorage.removeItem('pl_altas_cola_v1'));
  }
  // R7 — prellenado: sexo por el/los nombre(s) del final, DX de ingreso, narrativa de la cirugía, DRA., edad en meses
  {
    const sx = await page.evaluate(() => ['SANTIAGO LOPEZ MARIA FERNANDA', 'MARTIN RUIZ ANA', 'LORENZO DIAZ JUAN CARLOS', 'LOPEZ PEREZ MARIA DEL CARMEN', 'DE LA CRUZ LOPEZ JOSE',
      'SALVADOR PEREZ GUADALUPE', 'VICENTE GOMEZ XIOMARA', 'ESTEBAN RUIZ ANA MARTIN', 'PEREZ JUAN'].map(n => _altaSexo({ nombre: n }, { checklist: {} })));
    check('R7a sexo deducido del nombre de pila (censo «APELLIDO APELLIDO NOMBRE(S)»): MARÍA FERNANDA/ANA → F aunque el apellido sea SANTIAGO/MARTIN; ambiguos, desconocidos o con nombres de los dos sexos → vacío',
      JSON.stringify(sx) === JSON.stringify(['FEMENINO', 'FEMENINO', 'MASCULINO', 'FEMENINO', 'MASCULINO', '', '', '', 'MASCULINO']), JSON.stringify(sx));
    const dx = await page.evaluate(() => ['COLECISTITIS AGUDA PO COLECISTECTOMIA LAPAROSCOPICA', 'APENDICITIS AGUDA. PO APENDICECTOMIA', 'HERNIA INGUINAL DERECHA / PO PLASTIA INGUINAL',
      'APENDICITIS AGUDA COMPLICADA (PO APENDICECTOMIA)', 'ABSCESO HEPÁTICO + PO DRENAJE PERCUTÁNEO + PO LAPE 20/11 + DM2 + HAS - POP LAVADO', 'OBESIDAD MÓRBIDA + PO MANGA GÁSTRICA', 'TIPO III DE HINCHEY + PO LAPE'].map(_altaDxIngreso));
    check('R7b DX de ingreso: recorta «PO …» también sin «+» (espacio, «.», «/», «(») y deja fuera las comorbilidades (DM2, HAS) salvo que sean el motivo',
      JSON.stringify(dx) === JSON.stringify(['COLECISTITIS AGUDA', 'APENDICITIS AGUDA', 'HERNIA INGUINAL DERECHA', 'APENDICITIS AGUDA COMPLICADA', 'ABSCESO HEPÁTICO', 'OBESIDAD MÓRBIDA', 'TIPO III DE HINCHEY']), JSON.stringify(dx));
    const c0 = isoMenos(3), c1b = isoMenos(2);
    const pre = await page.evaluate(({ c0, c1b }) => {
      const dm = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(2, 4);
      const ing = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return String(t.getDate()).padStart(2, '0') + '/' + String(t.getMonth() + 1).padStart(2, '0') + '/' + String(t.getFullYear()).slice(2); };
      const mk = (id, extra, nd) => { const p = Object.assign({ cama: '3-7' + id, exp: '26-777' + id, esp: 'CG', edad: '52', ingreso: ing(4), adscrito: 'MORA', residente: 'SOTO R1', estado: 'ESTABLE' }, extra); patients.push(p); noteData[pid(p)] = Object.assign(defaultData(), nd); return pid(p); };
      const kA = mk('1', { nombre: 'PEREZ LOPEZ JUAN', dx: 'COLECISTITIS AGUDA', adscrito: 'Dra. Hernández', edad: '8 MESES' },
        { app: '', entrega: 'Ana ' + dm(c1b) + ' 08:00 - Inicia dieta líquida\nGerardo ' + dm(c0) + ' 18:00 - Pasa a quirófano para colecistectomía laparoscópica, hallazgos vesícula Parkland 3' });
      const n3 = { app: 'HAS, DM2', entrega: 'Gerardo ' + dm(c1b) + ' 10:00 - Inicia rehabilitación\nGerardo ' + dm(c0) + ' 12:00 - Pasa a quirófano para RAFI de cadera derecha sin complicaciones' };
      n3.checklist = Object.assign(defaultData().checklist, { sexo: 'F', cirugias: [{ id: 'cx3', fecha: c0, procedimiento: 'RAFI de cadera derecha', hallazgos: 'fractura intertrocantérea', sangrado: '', cirujano: '' }] });
      const kB = mk('2', { nombre: 'GIL ROSA MARIA', dx: 'FRACTURA DE CADERA DERECHA + PO RAFI', esp: 'TYO', edad: '18 MESES' }, n3);
      const a = _altaPrefill(kA), b = _altaPrefill(kB);
      patients.splice(patients.length - 2, 2);
      return { a, b };
    }, { c0, c1b });
    const q = (t) => (t.match(/QUIRÓFANO/g) || []).length;
    check('R7c cirugía que sale de la Cronología: procedimiento y hallazgos por separado, la fecha junto al procedimiento y SIN repetir el renglón «pasa a quirófano» en «Durante su estancia»',
      pre.a.evolucion.indexOf('SE DECIDE PASAR A QUIRÓFANO PARA LA REALIZACIÓN DE COLECISTECTOMÍA LAPAROSCÓPICA EL ' + dmy(c0, '.') + ', MISMA QUE REPORTA COMO HALLAZGOS VESÍCULA PARKLAND 3.') >= 0
        && q(pre.a.evolucion) === 1 && /DURANTE SU ESTANCIA: EL \S+ INICIA DIETA LÍQUIDA\./.test(pre.a.evolucion), pre.a.evolucion);
    check('R7d con la caja de Cirugías (RAFI) y la Cronología que también dice «pasa a quirófano para RAFI…», la cirugía se narra UNA vez',
      q(pre.b.evolucion) === 1 && /RAFI DE CADERA DERECHA EL .*MISMA QUE REPORTA COMO HALLAZGOS FRACTURA INTERTROCANTÉREA\./.test(pre.b.evolucion) && /INICIA REHABILITACIÓN/.test(pre.b.evolucion), pre.b.evolucion);
    check('R7e adscrita «Dra. Hernández» → «CON LA DRA. HERNÁNDEZ» y firma «DRA HERNÁNDEZ MBCG»',
      pre.a.pendientes[0] === 'CITA A LA CONSULTA EXTERNA DE CIRUGÍA GENERAL CON LA DRA. HERNÁNDEZ A DISPONIBILIDAD' && pre.a.firma_adscrito === 'DRA HERNÁNDEZ MBCG', JSON.stringify([pre.a.pendientes[0], pre.a.firma_adscrito]));
    check('R7f edad en meses: se conserva «8 MESES» (no «8» años) y la década es la PRIMERA también con «18 MESES»',
      pre.a.edad === '8 MESES' && /PRIMERA DÉCADA/.test(pre.a.antecedentes) && pre.b.edad === '18 MESES' && /PRIMERA DÉCADA/.test(pre.b.antecedentes), JSON.stringify([pre.a.edad, pre.a.antecedentes, pre.b.edad, pre.b.antecedentes]));
    // Word: edad con su unidad, sin caracteres de control y MOTIVO DEL EGRESO igual al machote
    const b64 = await page.evaluate(async (d) => {
      d.antecedentes = 'APP CON CAMPANA\u0007 PEGADA DE PDF\u000b Y \u001f'; d.motivo = 'MEJORÍA';
      return (await _altaDocxBlob(d)).b64;
    }, pre.a);
    const zz = unzip(Buffer.from(b64, 'base64')); const dxml = zz['word/document.xml'].toString('utf8');
    const tx = (dxml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('');
    check('R7g el Word no lleva caracteres de control (un \\u0007 pegado de PDF dejaba document.xml mal formado)', !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(dxml) && /APP CON CAMPANA PEGADA DE PDF/.test(tx), JSON.stringify(tx.slice(0, 400)));
    check('R7h el Word pone «EDAD: 8 MESES» (sin « AÑOS») y «MOTIVO DEL EGRESO: (X) MEJORÍA / PASE A OTRO HOSPITAL ____ CUAL / DEFUNCIÓN: ________» como el machote (sin ALTA VOLUNTARIA si no se eligió)',
      /EDAD: 8 MESES {4}SEXO/.test(tx) && !/MESES AÑOS/.test(tx) && tx.indexOf('MOTIVO DEL EGRESO: (X) MEJORÍA / PASE A OTRO HOSPITAL ____ CUAL / DEFUNCIÓN: ________') >= 0 && !/ALTA VOLUNTARIA/.test(tx), tx.slice(tx.indexOf('EDAD'), tx.indexOf('EDAD') + 60) + ' … ' + tx.slice(tx.indexOf('MOTIVO'), tx.indexOf('MOTIVO') + 140));
  }
  // R8 — SQL: autor verificable (creado_uid = auth.uid()) y contador de intentos del Apps Script
  {
    const sql = fs.readFileSync(path.join(ROOT, 'scripts', 'supabase_altas.sql'), 'utf8');
    const pol = (sql.match(/create policy altas_docs_insert[\s\S]*?;/) || [''])[0];
    check('R8 supabase_altas.sql: altas_docs.creado_uid uuid not null default auth.uid() y la política de INSERT exige creado_uid = auth.uid() (e intentos = 0)',
      /creado_uid uuid not null default auth\.uid\(\)/.test(sql) && /creado_uid = \(select auth\.uid\(\)\)/.test(pol) && /intentos int not null default 0/.test(sql) && /intentos = 0/.test(pol), pol);
    const b = altasPosts[altasPosts.length - 1].body;
    check('R8b la app no manda creado_uid (lo pone la base con el token)', !('creado_uid' in b), JSON.stringify(b));
    // Revisión 25 nov 2026 (2.ª vuelta): «add column if not exists creado_uid uuid not null default auth.uid()» fallaba con
    // una tabla que ya tenía filas (auth.uid() es null en el SQL Editor). Se agrega nullable, luego default, y not null
    // solo si no quedan filas en null. ultimo_intento (espera del Apps Script) nace null. Probado en postgres 16 local
    // con stubs de auth/storage: tabla nueva y tabla de la versión anterior con filas, el archivo corrido dos veces.
    check('R8c supabase_altas.sql idempotente con filas viejas: creado_uid se agrega nullable + set default + not null condicionado (do $$ … not exists … creado_uid is null); ultimo_intento timestamptz y la política de INSERT exige ultimo_intento is null',
      !/add column if not exists creado_uid uuid not null/.test(sql) && /add column if not exists creado_uid uuid;/.test(sql) && /alter column creado_uid set default auth\.uid\(\)/.test(sql)
      && /if not exists \(select 1 from public\.altas_docs where creado_uid is null\) then\s+alter table public\.altas_docs alter column creado_uid set not null/.test(sql)
      && /add column if not exists ultimo_intento timestamptz/.test(sql) && /ultimo_intento is null/.test(pol), pol);
  }
  // R10 — «Durante su estancia» solo quita el renglón que narra la MISMA cirugía (antes se iba todo «se realiza…» a ±1 día
  // de la cirugía, o de cualquier día si la cirugía no tenía fecha: TAC, transfusión, relaparotomía, lavado, drenaje).
  {
    const c = [isoMenos(4), isoMenos(3), isoMenos(2)];
    const ev = await page.evaluate(({ c }) => {
      const dm = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(2, 4);
      const ing = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return String(t.getDate()).padStart(2, '0') + '/' + String(t.getMonth() + 1).padStart(2, '0') + '/' + String(t.getFullYear()).slice(2); };
      const ks = [];
      const mk = (id, cx, entrega) => {
        const p = { cama: '3-88' + id, exp: '26-888' + id, nombre: 'PEREZ LOPEZ JUAN', esp: 'CG', edad: '52', dx: 'OCLUSION INTESTINAL', ingreso: ing(6), adscrito: 'MORA', residente: 'SOTO R1', estado: 'ESTABLE' };
        patients.push(p); const n = defaultData(); n.app = 'Niega'; n.checklist.cirugias = cx; n.entrega = entrega; noteData[pid(p)] = n; ks.push(pid(p));
      };
      mk('1', [{ id: 'a', fecha: c[0], procedimiento: 'LAPE con resección intestinal', hallazgos: 'brida', sangrado: '', cirujano: '' }],
        'Ana ' + dm(c[2]) + ' 09:00 - Inicia dieta líquida\nAna ' + dm(c[1]) + ' 08:00 - Se realiza transfusión de 2 CE por Hb 6.8\n'
        + 'Ana ' + dm(c[0]) + ' 23:00 - Se realiza TAC de control: sin colecciones\nAna ' + dm(c[0]) + ' 18:00 - Pasa a quirófano para LAPE');
      mk('2', [{ id: 'b', fecha: c[0], procedimiento: 'LAPE', hallazgos: '', sangrado: '', cirujano: '' }],
        'Ana ' + dm(c[1]) + ' 20:00 - Pasa a quirófano para relaparotomía por fuga de anastomosis\nAna ' + dm(c[0]) + ' 18:00 - Pasa a quirófano para LAPE');
      mk('3', [{ id: 'c', fecha: '', procedimiento: 'LAPE', hallazgos: '', sangrado: '', cirujano: '' }],
        'Ana ' + dm(c[2]) + ' 20:00 - Pasa a quirófano para lavado de cavidad\nAna ' + dm(c[1]) + ' 10:00 - Se realiza drenaje percutáneo guiado por TAC');
      // Caja vacía: la cirugía se infiere de la Cronología y junta los quirófanos a ±2 días; el del otro día se queda.
      mk('4', [], 'Ana ' + dm(c[2]) + ' 18:00 - Pasa a quirófano para LAPE\nAna ' + dm(c[0]) + ' 18:00 - Pasa a quirófano para LAPE + resección intestinal');
      const out = ks.map(k => _altaPrefill(k).evolucion);
      patients.splice(patients.length - 4, 4); ks.forEach(k => { delete noteData[k]; });
      return out;
    }, { c });
    const est = (t) => (t.split('DURANTE SU ESTANCIA:')[1] || '').split('\n')[0];
    check('R10 «Durante su estancia» conserva TAC y transfusión del día de la LAPE / el siguiente y quita SOLO «pasa a quirófano para LAPE» (ya narrada)',
      /SE REALIZA TAC DE CONTROL/.test(est(ev[0])) && /SE REALIZA TRANSFUSIÓN DE 2 CE/.test(est(ev[0])) && /INICIA DIETA LÍQUIDA/.test(est(ev[0])) && !/QUIRÓFANO/.test(est(ev[0])), ev[0]);
    check('R10b la reintervención del día siguiente (relaparotomía) se queda aunque la caja solo tenga la LAPE',
      /PASA A QUIRÓFANO PARA RELAPAROTOMÍA POR FUGA DE ANASTOMOSIS/.test(est(ev[1])) && !/PARA LAPE\b/.test(est(ev[1])), ev[1]);
    check('R10c con la cirugía SIN fecha no se quita nada por fecha: lavado de cavidad y drenaje percutáneo se quedan',
      /PASA A QUIRÓFANO PARA LAVADO DE CAVIDAD/.test(est(ev[2])) && /SE REALIZA DRENAJE PERCUTÁNEO GUIADO POR TAC/.test(est(ev[2])), ev[2]);
    check('R10d caja vacía (cirugía inferida): la reintervención de otro día con el mismo texto se queda en «Durante su estancia»',
      // (_cxDetectadas junta las dos en una cirugía inferida; cuál queda en el párrafo de cirugía depende del orden de la
      // Cronología: lo que importa es que ninguna de las dos se pierde de la nota.)
      /RESECCIÓN INTESTINAL/.test(ev[3]) && (ev[3].match(/\bLAPE\b/g) || []).length >= 2 && /DURANTE SU ESTANCIA: .*QUIRÓFANO/.test(ev[3]), ev[3]);
  }
  // R11 — huella del borrador: editar y guardar después del aviso la renueva (no se repite en cada apertura); un borrador
  // sin huella (formato anterior) avisa «posiblemente desactualizado» una vez; el aviso de «otro borrador» no lo tapa
  // el mensaje de Descargar.
  {
    await cerrarSiAbierta();
    const hay = () => page.evaluate(() => { const c = document.querySelector('[data-testid="alta-cambio"]'); return c ? c.textContent : ''; });
    await page.evaluate((k) => { noteData[k].app = 'HAS de 5 años, hipotiroidismo'; }, K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const av1 = await hay();
    await page.fill('#alta-f-pronostico', 'BUENO PARA LA VIDA (revisado)');
    await page.waitForTimeout(1300);
    await page.click('[data-testid="alta-cerrar"]');
    const h = await page.evaluate((k) => ({ b: noteData[k].checklist.alta_borrador.huella, f: _altaHuellaDe(_altaPrefill(k)) }), K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const av2 = await hay();
    await page.click('[data-testid="alta-cerrar"]');
    check('R11 tras el aviso «La tarjeta cambió…», editar a mano y guardar renueva la huella con la de la tarjeta actual: al reabrir ya no avisa',
      /La tarjeta cambió/.test(av1) && h.b === h.f && !av2, JSON.stringify({ av1, h, av2 }));
    // Borrador de formato anterior (sin huella)
    await page.evaluate((k) => { const b = noteData[k].checklist.alta_borrador; delete b.huella; b.ts = Date.now() - 86400000; }, K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const l1 = await hay();
    await page.click('[data-testid="alta-cerrar"]');
    const sinH = await page.evaluate((k) => noteData[k].checklist.alta_borrador.huella, K2);
    await page.evaluate((k) => openAltaDoc(k), K2);
    const l2 = await hay();
    await page.fill('#alta-f-pronostico', 'BUENO PARA LA VIDA (viejo revisado)');
    await page.waitForTimeout(1300);
    await page.click('[data-testid="alta-cerrar"]');
    const h2 = await page.evaluate((k) => ({ b: noteData[k].checklist.alta_borrador.huella, f: _altaHuellaDe(_altaPrefill(k)) }), K2);
    check('R11b borrador sin huella (formato anterior): NO toma la huella actual en silencio; avisa «posiblemente desactualizado» una vez (no en la siguiente apertura) y al editar y guardar toma la de la tarjeta actual',
      /posiblemente desactualizado/.test(l1) && !sinH && !l2 && h2.b === h2.f, JSON.stringify({ l1, sinH, l2, h2 }));
    // «Se guardó otro borrador» + Descargar
    await page.evaluate((k) => openAltaDoc(k), K2);
    await page.evaluate((k) => { noteData[k].checklist.alta_borrador = Object.assign({}, noteData[k].checklist.alta_borrador, { ts: Date.now() + 5, por: 'iPadC', pronostico: 'BUENO (C)' }); }, K2);
    await page.fill('#alta-f-pronostico', 'BUENO PARA LA VIDA (D)');
    await page.waitForTimeout(1300);
    const dlx = page.waitForEvent('download', { timeout: 20000 });
    await page.click('[data-testid="alta-descargar"]');
    await dlx;
    await page.waitForTimeout(200);
    const est = await page.evaluate(() => ({ t: document.getElementById('alta-estado').textContent, c: document.getElementById('alta-estado').className }));
    await page.click('[data-testid="alta-cerrar"]');
    check('R11c el aviso «se guardó otro borrador (iPadC…)» sigue en la línea de estado después de «✅ Word descargado» (concatenados, en ámbar)',
      /Word descargado/.test(est.t) && /otro borrador/.test(est.t) && /iPadC/.test(est.t) && est.c === 'warn', JSON.stringify(est));
  }
  check('sin errores de página', errors.length === 0, errors.join(' | '));
  // R9 — logout() borra la cola de altas del iPad (la siguiente cuenta no hereda los .docx de la anterior)
  {
    await page.evaluate(() => localStorage.setItem('pl_altas_cola_v1', JSON.stringify([{ id: 'z', key: 'x', b64: 'UEs=', ts: Date.now(), uid: '' }])));
    await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => {}), page.evaluate(() => { logout(); })]);
    check('R9 logout() borra pl_altas_cola_v1', !(await page.evaluate(() => localStorage.getItem('pl_altas_cola_v1'))));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
