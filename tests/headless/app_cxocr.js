// 📷 Nota postquirúrgica → campos de la cirugía (oct 2026) y cámara de Cirugías robusta. Sin puertos: page.route sirve los
// archivos del repo (no choca con run_all). Datos inventados.   node tests/headless/app_cxocr.js [index.html] [race]
const { launch } = require('./_browser');
const fs = require('fs'); const path = require('path');
const HTML = process.argv[2] || path.join(__dirname, '..', '..', 'index.html'); const RACE_ONLY = process.argv[3] === 'race';
const REPO = path.join(__dirname, '..', '..');
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Uno');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://worker.local', token:'tok' }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ (window.__alerts=window.__alerts||[]).push(String(m)); }; window.confirm=function(){ return true; };
  window.__storage = { fail:false, delay:0, uploads:[] };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  const bucketApi = (bucket)=>({
    upload: async (p, blob, opts)=>{ if (window.__storage.delay) await new Promise(r=>setTimeout(r, window.__storage.delay)); if (window.__storage.fail) return { data:null, error:{ message:'storage down' } }; window.__storage.uploads.push({ bucket, path:p, size: blob && blob.size }); return { data:{ path:p }, error:null }; },
    createSignedUrl: async (p, sec)=>({ data:{ signedUrl:'https://mock.local/signed/'+bucket+'/'+p+'?s='+sec }, error:null }),
    getPublicUrl: (p)=>({ data:{ publicUrl:'https://mock.local/public/'+bucket+'/'+p } }),
    remove: async ()=>({ data:[], error:null }),
  });
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from: bucketApi } }) };
})();`;
(async () => {
  const browser = await launch(); const context = await browser.newContext({ viewport: { width: 1300, height: 1400 } }); const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  let aiCalls = []; let aiMode = 'ok';
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url.startsWith('http://app.local/')) {
      let p = decodeURIComponent(url.replace('http://app.local/', '').split('?')[0]) || 'index.html';
      if (p === 'index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(HTML) });
      if (/vendor\/supabase/.test(p)) return route.abort();
      const fp = path.join(REPO, p); if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return route.fulfill({ status: 200, body: fs.readFileSync(fp), contentType: p.endsWith('.js') ? 'application/javascript' : (p.endsWith('.json') ? 'application/json' : undefined) });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.startsWith('https://mock.local/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 });
    if (url.startsWith('https://worker.local/api/ai')) {
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      const content = (body && body.messages && body.messages[0] && body.messages[0].content) || [];
      aiCalls.push({ images: content.filter(c => c.type === 'image').length, mt: (content[0] && content[0].source && content[0].source.media_type), hasPrompt: content.some(c => c.type === 'text' && /JSON/.test(c.text)) });
      if (aiMode === '500') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
      const out = { es_nota_quirurgica: true, fecha: '15/10/2026', procedimiento: 'LAPE + drenaje de absceso', diagnostico_postqx: 'Absceso residual', hallazgos: 'Absceso pélvico 200 mL', tecnica: 'Línea media', drenajes: 'Penrose', complicaciones: '', importante: 'Vigilar gasto', sangrado_ml: 150, cirujano: 'Dr. Cirujano' };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(out) + '\n```' }] }) });
    }
    if (url.includes('/rest/v1/')) {
      const u = url.replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (u.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', dx: 'DX PRUEBA' }]); return json(200, [{ id: 'a1' }]); }
      if (u.startsWith('/rest/v1/notes')) {
        if (m === 'GET') return json(200, [{ patient_id: 'a1', app: '', pa: 'PA Y', pendientes: '', lab_history: [], imagen_history: [], checklist: { cultivos: '', recibo: '', cirugias: [{ id: 'c1', fecha: '', procedimiento: 'LAPE', hallazgos: '', sangrado: '', cirujano: '' }] } }]);
        return json(201, [{ patient_id: 'a1' }]);
      }
      return json(200, []);
    }
    return route.abort();
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto('http://app.local/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  check('init sin errores', errors.length === 0, errors.join(' | '));

  // RACE: Realtime replaces the checklist while the upload is in flight (same call in old and new code).
  await page.evaluate(() => { window.__storage.delay = 1500; });
  const race = await page.evaluate(async () => {
    const k = pid(patients[0]);
    try { _suppressRealtimeKeys.clear(); } catch (_) {}
    const blob = new Blob([new Uint8Array(2000)], { type: 'image/jpeg' });
    const pr = fotoAttachBlob(k, 'cx:c1', blob, 'nota.jpg', 'image/jpeg', { w: 10, h: 10, b64: btoa('x'.repeat(300)) });
    await new Promise(r => setTimeout(r, 300));
    try { _suppressRealtimeKeys.clear(); } catch (_) {}
    handleNoteChange({ eventType: 'UPDATE', new: { patient_id: 'a1', pa: 'PA Y', checklist: { cultivos: '', recibo: '', cirugias: [{ id: 'c1', fecha: '', procedimiento: 'LAPE', hallazgos: 'remoto', sangrado: '', cirujano: '' }] } } });
    await pr; await new Promise(r => setTimeout(r, 2500));
    const c = getNote(k).checklist.cirugias.find(x => x.id === 'c1');
    return { fotos: (c.fotos || []).length, hallazgos: c.hallazgos, uploads: window.__storage.uploads.length };
  });
  console.log('race result', JSON.stringify(race));
  check('RACE: la foto sobrevive a un evento Realtime durante la subida', race.fotos >= 1, JSON.stringify(race));
  await page.evaluate(() => { window.__storage.delay = 0; });
  if (RACE_ONLY) { console.log('RESULT APP-CXOCR: ' + pass + ' passed, ' + fail + ' failed'); await browser.close(); return; }

  // T1: 📷 in the row -> file chooser (global input) -> attached + AI fills ONLY empty fields
  aiCalls = [];
  await page.evaluate(() => { const k = pid(patients[0]); const c = getNote(k).checklist.cirugias.find(x => x.id === 'c1'); c.hallazgos = ''; c.fotos = []; _saveNoteNow(k, getNote(k), 'ck_cirugias'); _rerenderCard(k); });
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.pl-fotos[data-scope="cx:c1"] .pl-foto-add')]);
  check('T1 el botón 📷 abre el selector (input global, multiple)', fc.isMultiple() && (await fc.element().getAttribute('id')) === 'pl-global-foto-input');
  await fc.setFiles({ name: 'nota.png', mimeType: 'image/png', buffer: PNG_1x1 });
  await page.waitForTimeout(3500);
  const t1 = await page.evaluate(() => { const k = pid(patients[0]); const c = getNote(k).checklist.cirugias.find(x => x.id === 'c1'); return { c, undo: _undoLastLabel(k), toast: (document.getElementById('__pl_toast') || {}).textContent || '', btn: !!document.querySelector('.cx-row[data-id="c1"] .cx-ai-btn') }; });
  check('T1 foto adjunta con ruta de Storage', (t1.c.fotos || []).length === 1 && !!t1.c.fotos[0].path, JSON.stringify(t1.c.fotos));
  check('T1 IA llamada con 1 imagen JPEG y prompt JSON', aiCalls.length === 1 && aiCalls[0].images === 1 && aiCalls[0].mt === 'image/jpeg' && aiCalls[0].hasPrompt, JSON.stringify(aiCalls));
  check('T1 llena SOLO lo vacío (procedimiento LAPE intacto)', t1.c.procedimiento === 'LAPE' && t1.c.fecha === '2026-10-15' && t1.c.sangrado === '150' && t1.c.cirujano === 'Dr. Cirujano' && /Hallazgos: Absceso pélvico/.test(t1.c.hallazgos) && /⚠ Importante: Vigilar gasto/.test(t1.c.hallazgos), JSON.stringify(t1.c));
  check('T1 Regresar disponible y aviso', /transcribir nota/.test(t1.undo) && /Llené/.test(t1.toast) && /No toqué/.test(t1.toast), t1.undo + ' | ' + t1.toast);
  check('T1 botón 🤖 Transcribir en la fila', t1.btn);

  // T2: header "📷 Nota postquirúrgica" -> new row created only after choosing -> AI fills all
  aiCalls = [];
  const before = await page.evaluate(() => getNote(pid(patients[0])).checklist.cirugias.length);
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('.cx-nota')]);
  const mid = await page.evaluate(() => getNote(pid(patients[0])).checklist.cirugias.length);
  await fc2.setFiles([{ name: 'p1.png', mimeType: 'image/png', buffer: PNG_1x1 }, { name: 'p2.png', mimeType: 'image/png', buffer: PNG_1x1 }]);
  await page.waitForTimeout(3500);
  const t2 = await page.evaluate(() => { const l = getNote(pid(patients[0])).checklist.cirugias; return { n: l.length, last: l[l.length - 1] }; });
  check('T2 la fila NO se crea al abrir el selector (cancelar no deja filas)', mid === before, before + '->' + mid);
  check('T2 fila nueva con 2 páginas y todo llenado', t2.n === before + 1 && (t2.last.fotos || []).length === 2 && t2.last.procedimiento === 'LAPE + drenaje de absceso' && t2.last.fecha === '2026-10-15' && aiCalls.length === 1 && aiCalls[0].images === 2, JSON.stringify({ t2, aiCalls }));

  // T3: worker error -> photo kept, queued, never throws
  aiMode = '500';
  await page.evaluate(() => { const k = pid(patients[0]); const l = getNote(k).checklist.cirugias; const c = l[l.length - 1]; c.cirujano = ''; _saveNoteNow(k, getNote(k), 'ck_cirugias'); });
  const t3 = await page.evaluate(async () => { const k = pid(patients[0]); const l = getNote(k).checklist.cirugias; const c = l[l.length - 1]; await cxLeerNota(k, c.id); return { fotos: (c.fotos || []).length, q: JSON.parse(localStorage.getItem('pl_cx_ai_queue_v1') || '[]').length, toast: (document.getElementById('__pl_toast') || {}).textContent || '' }; });
  check('T3 error 500: foto intacta, en cola, aviso', t3.fotos === 2 && t3.q === 1 && /No se pudo leer la nota/.test(t3.toast), JSON.stringify(t3));
  aiMode = 'ok';
  await page.evaluate(async () => { await _cxAiQueueRun(); });
  const t3b = await page.evaluate(() => { const l = getNote(pid(patients[0])).checklist.cirugias; return { cir: l[l.length - 1].cirujano, q: JSON.parse(localStorage.getItem('pl_cx_ai_queue_v1') || '[]').length }; });
  check('T3 la cola se procesa al volver la red', t3b.cir === 'Dr. Cirujano' && t3b.q === 0, JSON.stringify(t3b));

  // T4: slow upload (> 4 s): inline pending first, then swapped to Storage path
  await page.evaluate(() => { window.__storage.delay = 6000; });
  const t4a = await page.evaluate(async () => { const k = pid(patients[0]); const blob = new Blob([new Uint8Array(500)], { type: 'image/jpeg' }); const f = await fotoAttachBlob(k, 'cultivos', blob, 'c.jpg', 'image/jpeg', { w: 1, h: 1, b64: btoa('y'.repeat(200)) }); return { pending: !!(f && f.pending), path: f && f.path }; });
  await page.waitForTimeout(3500);
  const t4b = await page.evaluate(() => { const l = getNote(pid(patients[0])).checklist.cultivos_fotos || []; const f = l[l.length - 1]; return { pending: !!f.pending, path: f.path, b64: !!f.b64 }; });
  check('T4 subida lenta: queda inline pendiente y luego pasa a Storage', t4a.pending && !t4a.path && !t4b.pending && !!t4b.path && !t4b.b64, JSON.stringify({ t4a, t4b }));
  await page.evaluate(() => { window.__storage.delay = 0; });

  // T5: viewer in-page
  const t5 = await page.evaluate(async () => { const k = pid(patients[0]); const c = getNote(k).checklist.cirugias.find(x => x.id === 'c1'); await fotoOpen(k, 'cx:c1', c.fotos[0].id); const ov = document.getElementById('pl-foto-viewer'); const im = document.getElementById('pl-foto-viewer-img'); return { shown: ov && ov.style.display === 'flex', src: im && im.getAttribute('src') }; });
  check('T5 visor dentro de la app con URL firmada 1 h', t5.shown && /signed\/pl-fotos\/.*\?s=3600/.test(t5.src || ''), JSON.stringify(t5));
  check('final sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('alerts:', JSON.stringify(await page.evaluate(() => window.__alerts || [])));
  console.log('RESULT APP-CXOCR: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
