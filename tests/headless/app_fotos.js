// Fotos en las cajas, trazos a mano guardados en la caja y autor por caja (oct 2026).
//  F1 foto en una cirugía: se reduce, sube a Storage (ruta, sin b64), queda en checklist.cirugias[].fotos, miniatura con URL firmada, autor GF
//  F2 sin Storage: la foto queda inline (b64, pendiente) y al reintentar con red sube y se limpia; la copia local no guarda b64 de fotos ya subidas
//  F3 quitar foto pide confirmación y ↩ Regresar la devuelve
//  F4 ✍️ en Interconsultas → 📌 A la caja: el trazo queda como PNG en checklist.ink_fotos["ck:interconsultas"], el modal se cierra y la tira aparece bajo la caja
//  F5 autor por caja: updateField marca by.app = GF (y sube checklist), el chip aparece en la etiqueta, ➕ Hoy lleva iniciales, buildChecklistForSync conserva "by"
//  F6 updateCkText marca autor en IC y Tomar guardia en Recibo/Entrega
const { chromium } = require('playwright');
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ (window.__alerts=window.__alerts||[]).push(String(m)); }; window.confirm=function(){ return true; };
  window.__storage = { fail:false, uploads:[] };
  const auth={
    getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }),
    onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
    refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }),
    signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }),
    signOut: async()=>({ error:null }),
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  const bucketApi = (bucket)=>({
    upload: async (path, blob, opts)=>{ if (window.__storage.fail) return { data:null, error:{ message:'storage down' } }; window.__storage.uploads.push({ bucket, path, size: blob && blob.size, type: opts && opts.contentType }); return { data:{ path }, error:null }; },
    createSignedUrl: async (path, sec)=>({ data:{ signedUrl:'https://mock.local/signed/'+bucket+'/'+path }, error:null }),
    getPublicUrl: (path)=>({ data:{ publicUrl:'https://mock.local/public/'+bucket+'/'+path } }),
    remove: async ()=>({ data:[], error:null }),
  });
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from: bucketApi } }) };
})();`;
(async () => {
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 1400 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('https://mock.local/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }));
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', dx: 'DX PRUEBA' }]); return json(200, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') return json(200, [{ patient_id: 'a1', app: '', pa: 'PA Y', pendientes: '', lab_history: [], imagen_history: [], checklist: { interconsultas: 'MI: valorado', cultivos: '', recibo: '', cirugias: [{ id: 'c1', fecha: '2026-10-10', procedimiento: 'LAPE', hallazgos: '', sangrado: '', cirujano: '' }] } }]);
      if (m === 'POST') posts.push(body);
      return json(201, [{ patient_id: 'a1' }]);
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length === 0, errors.join(' | '));

  // F1
  // El 📷 ya no lleva un <input> dentro de la tarjeta (un repintado con la cámara abierta lo desprendía y la foto se
  // perdía en iPad): abre UN selector global (#pl-global-foto-input).
  const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.click('.pl-fotos[data-scope="cx:c1"] .pl-foto-add')]);
  const fc1Id = await (await fc1.element()).getAttribute('id');
  await fc1.setFiles({ name: 'nota-qx.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForTimeout(1800);
  const f1 = await page.evaluate(() => {
    const k = pid(patients[0]); const nd = getNote(k); const c = nd.checklist.cirugias[0]; const f = (c.fotos || [])[0] || null;
    const img = document.querySelector('.pl-fotos[data-scope="cx:c1"] img.pl-foto');
    const by = (nd.checklist.__pl_note_meta || {}).by || {};
    return { n: (c.fotos || []).length, path: f && f.path, bucket: f && f.bucket, hasB64: !!(f && f.b64), type: f && f.type, by: f && f.by, w: f && f.w, pending: !!(f && f.pending), img: !!img, src: img ? img.getAttribute('src') : null, uploads: window.__storage.uploads.length, upType: window.__storage.uploads[0] && window.__storage.uploads[0].type, byCx: by.cirugias && by.cirugias.i, undo: _undoLastLabel(k) };
  });
  const postCx = posts.find(b => b && b.checklist && Array.isArray(b.checklist.cirugias) && (b.checklist.cirugias[0].fotos || []).length === 1);
  check('F1 foto en cirugía: reducida a JPEG, subida a Storage (ruta, sin b64), miniatura con URL firmada, autor GF, Regresar y el checklist con la foto se sube',
    fc1Id === 'pl-global-foto-input' && f1.n === 1 && !!f1.path && f1.bucket === 'pl-fotos' && !f1.hasB64 && f1.type === 'image/jpeg' && f1.by === 'GF' && f1.w === 1 && !f1.pending && f1.img && /mock\.local\/signed\/pl-fotos\//.test(f1.src || '') && f1.uploads === 1 && f1.upType === 'image/jpeg' && f1.byCx === 'GF' && /agregar foto/.test(f1.undo) && !!postCx && !postCx.checklist.cirugias[0].fotos[0].b64 && !!postCx.checklist.cirugias[0].fotos[0].path, JSON.stringify({ f1, postCx: !!postCx }));

  // F2
  await page.evaluate(() => { window.__storage.fail = true; });
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('.pl-fotos[data-scope="cultivos"] .pl-foto-add')]);
  await fc2.setFiles({ name: 'reporte.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForTimeout(1800);
  const f2a = await page.evaluate(() => {
    const k = pid(patients[0]); const nd = getNote(k); const f = (nd.checklist.cultivos_fotos || [])[0] || null;
    const ls = JSON.parse(localStorage.getItem('note-' + k) || '{}');
    const lsF = ((ls.checklist || {}).cultivos_fotos || [])[0] || null;
    const stripped = _lsNoteCopy({ checklist: { cultivos_fotos: [{ id: 'x', b64: 'AAA', path: 'p/x.jpg', pending: true }] } });
    return { n: (nd.checklist.cultivos_fotos || []).length, pending: !!(f && f.pending), hasB64: !!(f && f.b64), path: f && f.path, lsKeepsB64: !!(lsF && lsF.b64), stripB64: stripped.checklist.cultivos_fotos[0].b64 === undefined, img: !!document.querySelector('.pl-fotos[data-scope="cultivos"] img.pl-foto[src^="data:image/jpeg"]'), wrapPending: !!document.querySelector('.pl-fotos[data-scope="cultivos"] .pl-foto-wrap.pending') };
  });
  await page.evaluate(() => { window.__storage.fail = false; });
  const f2b = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const n = await _fotosRetryPending();
    const f = (getNote(k).checklist.cultivos_fotos || [])[0] || null;
    await new Promise(r => setTimeout(r, 300));
    const img = document.querySelector('.pl-fotos[data-scope="cultivos"] img.pl-foto');
    return { n, path: f && f.path, hasB64: !!(f && f.b64), pending: !!(f && f.pending), src: img ? img.getAttribute('src') : null };
  });
  check('F2 sin Storage: la foto queda inline y pendiente (se ve, marcada), la copia local la conserva; al reintentar con red sube, pierde el b64 y la miniatura pasa a URL firmada',
    f2a.n === 1 && f2a.pending && f2a.hasB64 && !f2a.path && f2a.lsKeepsB64 && f2a.stripB64 && f2a.img && f2a.wrapPending && f2b.n === 1 && !!f2b.path && !f2b.hasB64 && !f2b.pending && /signed/.test(f2b.src || ''), JSON.stringify({ f2a, f2b }));

  // F3
  const f3 = await page.evaluate(() => {
    const k = pid(patients[0]); const id = getNote(k).checklist.cultivos_fotos[0].id;
    fotoRemove(k, 'cultivos', id);
    const after = (getNote(k).checklist.cultivos_fotos || []).length;
    const label = undoLast(k);
    const back = (getNote(k).checklist.cultivos_fotos || []).length;
    return { after, label, back, domBack: !!document.querySelector('.pl-fotos[data-scope="cultivos"] img.pl-foto') };
  });
  check('F3 quitar foto (con confirmación) y ↩ Regresar la devuelve', f3.after === 0 && /quitar foto/.test(f3.label) && f3.back === 1 && f3.domBack, JSON.stringify(f3));

  // F4
  const f4 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    openInkpadForField(k, 'ck:interconsultas', 'Interconsultas');
    await new Promise(r => setTimeout(r, 150));
    const btnShown = document.getElementById('ink-tobox-btn').style.display !== 'none';
    const modalShown = document.getElementById('inkpad-modal').style.display === 'flex';
    _inkStrokes = [{ tool: 'pen', color: '#0f172a', alpha: 1, points: [{ x: 10, y: 10, p: .5 }, { x: 60, y: 40, p: .5 }, { x: 120, y: 30, p: .5 }] }];
    await inkSaveToBox();
    await new Promise(r => setTimeout(r, 300));
    const nd = getNote(k); const list = ((nd.checklist.ink_fotos || {})['ck:interconsultas']) || []; const f = list[0] || null;
    const img = document.querySelector('.pl-fotos[data-scope="ink:ck:interconsultas"] img.pl-foto');
    const strokesKept = !!(nd._inkFields && nd._inkFields['ck:interconsultas'] && nd._inkFields['ck:interconsultas'].length === 1);
    openInkpad(k); const btnHiddenGlobal = document.getElementById('ink-tobox-btn').style.display === 'none'; closeInkpad();
    return { btnShown, modalShown, n: list.length, type: f && f.type, path: f && f.path, w: f && f.w, h: f && f.h, modalClosed: document.getElementById('inkpad-modal').style.display === 'none', img: !!img, strokesKept, btnHiddenGlobal, byIc: ((nd.checklist.__pl_note_meta || {}).by || {})['ck:interconsultas'] ? 'ck' : (((nd.checklist.__pl_note_meta || {}).by || {}).interconsultas ? 'plain' : 'none') };
  });
  check('F4 ✍️ Interconsultas → 📌 A la caja: PNG recortado al trazo subido a Storage, tira bajo la caja, modal cerrado, trazo editable conservado, botón solo en modo caja',
    f4.btnShown && f4.modalShown && f4.n === 1 && f4.type === 'image/png' && !!f4.path && f4.w >= 40 && f4.h >= 40 && f4.modalClosed && f4.img && f4.strokesKept && f4.btnHiddenGlobal && f4.byIc === 'ck', JSON.stringify(f4));

  // F5
  posts.length = 0;
  const f5 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    updateField(k, 'app', 'APP NUEVA', '');
    await new Promise(r => setTimeout(r, 1300));
    const nd = getNote(k); const by = (nd.checklist.__pl_note_meta || {}).by || {};
    const card = document.getElementById('card-' + k);
    const chips = Array.from(card.querySelectorAll('.by-chip')).map(c => c.textContent);
    const d = new Date(); const stamp = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + ' GF: ';
    insertTodayStamp(k, 'entrega', false, 'Entrega');
    const keep = buildChecklistForSync({ entrega: '', checklist: { npo: true, __pl_note_meta: { by: { app: { u: 'x', i: 'X', t: 't' } }, entrega: 'vieja' } } });
    return { ini: userInitials(), byApp: by.app && by.app.i, byUser: by.app && by.app.u, chips, entrega: nd.entrega, stamp, keepBy: !!(keep.__pl_note_meta && keep.__pl_note_meta.by && keep.__pl_note_meta.by.app), keepEntregaDropped: !(keep.__pl_note_meta && keep.__pl_note_meta.entrega) };
  });
  await page.waitForTimeout(1300);
  const postApp = posts.find(b => b && 'app' in b);
  check('F5 autor por caja: updateField marca by.app = GF y sube checklist junto con app; chip GF en la ficha; ➕ Hoy lleva iniciales; buildChecklistForSync conserva "by" y quita entrega vacía',
    f5.ini === 'GF' && f5.byApp === 'GF' && f5.byUser === 'Gerardo Fernández' && f5.chips.some(c => /^GF/.test(c)) && f5.entrega === f5.stamp && f5.keepBy && f5.keepEntregaDropped && !!postApp && ('checklist' in postApp) && postApp.checklist.__pl_note_meta && postApp.checklist.__pl_note_meta.by && postApp.checklist.__pl_note_meta.by.app, JSON.stringify({ f5, postKeys: postApp ? Object.keys(postApp) : null }));

  // F6
  const f6 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    updateCkText(k, 'interconsultas', 'MI: valorado\nUCI: no');
    const nd = getNote(k); const by = (nd.checklist.__pl_note_meta || {}).by || {};
    _rerenderCard(k);
    const icChip = document.querySelector('#card-' + CSS.escape(k) + ' .interconsultas-box .by-chip');
    nd.entrega = 'PARA LA SIGUIENTE GUARDIA'; noteData[k] = nd;
    tomarGuardia(k);
    const nd2 = getNote(k); const by2 = (nd2.checklist.__pl_note_meta || {}).by || {};
    return { byIc: by.interconsultas && by.interconsultas.i, icChip: icChip ? icChip.textContent : null, recibo: nd2.checklist.recibo, byRecibo: by2.recibo && by2.recibo.i, byEntrega: by2.entrega && by2.entrega.i };
  });
  check('F6 updateCkText marca autor en IC (chip GF); Tomar guardia sella "— Recibido dd/mm hh:mm GF —" y marca Recibo/Entrega',
    f6.byIc === 'GF' && /^GF/.test(f6.icChip || '') && /— Recibido \d{2}\/\d{2} \d{2}:\d{2} GF —\nPARA LA SIGUIENTE GUARDIA/.test(f6.recibo || '') && f6.byRecibo === 'GF' && f6.byEntrega === 'GF', JSON.stringify(f6));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-FOTOS: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
