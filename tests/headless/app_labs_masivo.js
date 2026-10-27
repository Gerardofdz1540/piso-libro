// 📦 Labs Masivo (24 oct 2026, «no identifica a los pacientes»): el PDF de WinLab con varios pacientes se reparte por
// nombre a TODO el censo (antes solo Cirugía General: los de Neurocirugía nunca se identificaban) y los nombres se comparan
// igual en los dos lados (antes el censo contaba «DE», «LA», «MA.» y «MA. DE LA LUZ …» no alcanzaba las coincidencias).
// La extracción del Worker se simula; pacientes ficticios.
//   node tests/headless/app_labs_masivo.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  window.__alerts=[]; window.__confirms=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(m){ window.__confirms.push(String(m)); return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PATS = [
  { id: 'm1', cama: '3-201', exp: '26-90001', nombre: 'RUIZ SOTO MATEO', esp: 'CG', estado: 'ESTABLE', edad: '58' },
  { id: 'm2', cama: '3-202', exp: '26-90002', nombre: 'MA. DE LA LUZ PEREZ GOMEZ', esp: 'NCX', estado: 'ESTABLE', edad: '61' },
  { id: 'm3', cama: '3-203', exp: '26-90003', nombre: 'FCO JAVIER LOPEZ DIAZ', esp: 'URO', estado: 'ESTABLE', edad: '47' },
  { id: 'm4', cama: '3-204', exp: '26-90004', nombre: 'ANA SOFIA LOPEZ DIAZ', esp: 'CG', estado: 'ESTABLE', edad: '30' },
  { id: 'm5', cama: '3-205', exp: '26-90005', nombre: 'ANA MARIA LOPEZ DIAZ', esp: 'CG', estado: 'ESTABLE', edad: '33' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, PATS) : json(201, [{}]);
    if (url.startsWith('/rest/v1/notes')) return m === 'GET' ? json(200, PATS.map(p => ({ patient_id: p.id, checklist: {} }))) : json(201, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  await page.addInitScript(() => { try { localStorage.setItem('pl_config_v1', JSON.stringify({ url: 'https://worker.example' })); } catch (_) {} });
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 5, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: 'https://worker.example' })); } catch (_) {}
    // Lo que devolvería el Worker al leer un PDF de WinLab con varios pacientes (nombre como lo imprime WinLab).
    window.callLabsExtractionWorker = async function () { return { raw: {}, base64: '', patients: [
      { paciente: 'RUIZ SOTO, MATEO', fecha_labs: '2026-10-23', values: { hb: '11.1' } },
      { paciente: 'PEREZ GOMEZ, MARIA DE LA LUZ', fecha_labs: '2026-10-23', values: { hb: '9.4' } },
      { paciente: 'LOPEZ DIAZ, FRANCISCO JAVIER', fecha_labs: '2026-10-23', values: { hb: '13.0' } },
      { paciente: 'GARCIA NADIE, PERSONA AJENA', fecha_labs: '2026-10-23', values: { hb: '7.0' } },
    ] }; };
    window.attachLabSourceToSnap = async function () {};
    openBulkLabsModal();
    handleBulkLabsFiles([new File(['%PDF-1.4'], 'winlab.pdf', { type: 'application/pdf' })]);
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 100)); if (/PERSONA AJENA|Sin asignar|sin asignar|No se encontr/i.test(document.getElementById('bulk-labs-results').textContent)) break; }
    await new Promise(r => setTimeout(r, 500));
    const hb = (id) => { const cama = { m1: '3-201', m2: '3-202', m3: '3-203', m4: '3-204' }[id]; const p = patients.find(x => x.cama === cama); const k = pid(p); const s = (noteData[k] && noteData[k].labHistory || []).find(x => x.fecha === '2026-10-23'); return s ? JSON.stringify(s.labs || {}).match(/"hb":"([^"]*)"/) ? JSON.parse(JSON.stringify(s.labs)).hb : JSON.stringify(s.labs) : ''; };
    return { m1: hb('m1'), m2: hb('m2'), m3: hb('m3'), m4: hb('m4'), txt: document.getElementById('bulk-labs-results').textContent.replace(/\s+/g, ' ').slice(0, 600) };
  });
  check('L1 cada paciente del PDF va a su tarjeta: Cirugía General, Neurocirugía con «MA. DE LA LUZ» y Urología con «FCO»', r.m1 === '11.1' && r.m2 === '9.4' && r.m3 === '13.0', JSON.stringify(r));
  check('L2 nadie recibe labs ajenos: la persona que no está en el censo no se asigna y quien comparte apellidos no recibe nada', r.m4 === '' && /PERSONA AJENA/.test(r.txt), JSON.stringify(r));
  // ── L3–L7 (27 oct 2026): valor imposible, el mismo PDF dos veces, unión con WinLab del mismo día, un PDF que falla y
  //    una asignación dudosa que no se escribe hasta confirmarla ──
  const r2 = await page.evaluate(async () => {
    const snapDe = (cama, fecha) => { const p = patients.find(x => x.cama === cama); const nd = noteData[pid(p)] || {}; return (nd.labHistory || []).filter(x => x.fecha === fecha); };
    const correr = async (porArchivo, nombres) => {
      window.callLabsExtractionWorker = async function (file) { const f = porArchivo[file.name]; if (f instanceof Error) throw f; return { raw: {}, base64: '', patients: f }; };
      openBulkLabsModal();
      handleBulkLabsFiles((nombres || Object.keys(porArchivo)).map(n => new File(['%PDF-1.4'], n, { type: 'application/pdf' })));
      for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 100)); if (/asignados/.test(document.getElementById('bulk-labs-progress').textContent)) break; }
      await new Promise(r => setTimeout(r, 300));
      return document.getElementById('bulk-labs-results').textContent.replace(/\s+/g, ' ');
    };
    const out = {};
    // L3: Hb 125 (imposible) no se guarda y se dice; el K del mismo día sí.
    out.t3 = await correr({ 'a.pdf': [{ paciente: 'RUIZ SOTO, MATEO', fecha_labs: '2026-10-24', values: { hb: '125', k: '4.1' } }] });
    const s3 = snapDe('3-201', '2026-10-24')[0] || { labs: {} };
    out.l3 = { hb: s3.labs.hb, k: s3.labs.k };
    // L4: el mismo PDF otra vez: una sola copia del día y el mismo valor.
    await correr({ 'a.pdf': [{ paciente: 'RUIZ SOTO, MATEO', fecha_labs: '2026-10-24', values: { k: '4.1' } }] });
    out.l4 = snapDe('3-201', '2026-10-24').length;
    // L5: ya hay labs de WinLab de ese día: se suman (no se pisan) y lo subido a mano queda protegido del siguiente sync.
    { const p = patients.find(x => x.cama === '3-203'); const nd = getNote(pid(p)); nd.labHistory.push({ fecha: '2026-10-25', source: 'winlab', labs: { k: '3.9' }, extra: [] }); noteData[pid(p)] = nd; }
    await correr({ 'b.pdf': [{ paciente: 'LOPEZ DIAZ, FRANCISCO JAVIER', fecha_labs: '2026-10-25', values: { hb: '12.0' } }] });
    const s5 = snapDe('3-203', '2026-10-25');
    out.l5 = { n: s5.length, k: s5[0] && s5[0].labs.k, hb: s5[0] && s5[0].labs.hb, manual: s5[0] && s5[0].manual_keys };
    // L6: un PDF que falla no detiene a los demás.
    out.t6 = await correr({ 'roto.pdf': new Error('el Worker no respondió'), 'c.pdf': [{ paciente: 'PEREZ GOMEZ, MARIA DE LA LUZ', fecha_labs: '2026-10-26', values: { hb: '10.0' } }] }, ['roto.pdf', 'c.pdf']);
    out.l6 = (snapDe('3-202', '2026-10-26')[0] || { labs: {} }).labs.hb;
    // L7: «LOPEZ DIAZ, ANA» encaja igual con dos pacientes: queda pendiente y nadie recibe nada hasta confirmar.
    out.t7 = await correr({ 'd.pdf': [{ paciente: 'LOPEZ DIAZ, ANA', fecha_labs: '2026-10-26', values: { hb: '8.8' } }] });
    out.l7antes = [snapDe('3-204', '2026-10-26').length, snapDe('3-205', '2026-10-26').length];
    const amb = window.__bulkAmbiguities || [];
    const bCama = amb[0] && amb[0].second && amb[0].second.cama;
    if (amb.length) await resolveBulkAmbiguity(0, 'swap');
    await new Promise(r => setTimeout(r, 300));
    out.l7 = { pend: amb.length, bCama, a: snapDe('3-204', '2026-10-26').map(x => x.labs.hb), b: snapDe('3-205', '2026-10-26').map(x => x.labs.hb) };
    return out;
  });
  check('L3 valor imposible leído por la IA (Hb 125): no se guarda, se avisa en el resultado y lo demás del día sí entra',
    r2.l3.hb === undefined && r2.l3.k === '4.1' && /No se guardaron \(valor imposible.*Hb 125/.test(r2.t3), JSON.stringify({ l3: r2.l3, t3: r2.t3.slice(0, 300) }));
  check('L4 el mismo PDF subido dos veces: una sola copia del día (sin duplicar)', r2.l4 === 1, JSON.stringify(r2.l4));
  check('L5 con labs de WinLab del mismo día: se suman sin pisar (K de WinLab sigue, Hb nueva) y lo subido queda protegido del siguiente sync',
    r2.l5.n === 1 && r2.l5.k === '3.9' && r2.l5.hb === '12.0' && Array.isArray(r2.l5.manual) && r2.l5.manual.includes('hb'), JSON.stringify(r2.l5));
  check('L6 un PDF que falla se reporta como error y los demás se asignan igual', /Error: roto\.pdf/.test(r2.t6) && r2.l6 === '10.0', JSON.stringify({ l6: r2.l6, t6: r2.t6.slice(0, 300) }));
  check('L7 nombre que encaja igual con dos pacientes: pendiente, nadie recibe nada hasta confirmar; al confirmar va SOLO al elegido',
    r2.l7.pend === 1 && r2.l7antes[0] === 0 && r2.l7antes[1] === 0 && ((r2.l7.bCama === '3-205' && r2.l7.b[0] === '8.8' && !r2.l7.a.length) || (r2.l7.bCama === '3-204' && r2.l7.a[0] === '8.8' && !r2.l7.b.length)), JSON.stringify(r2.l7));

  check('final: sin errores de JavaScript en la página', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('RESULT APP-LABS-MASIVO: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
