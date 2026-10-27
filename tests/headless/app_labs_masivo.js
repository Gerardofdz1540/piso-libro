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
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 4, null, { timeout: 30000 });
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
  check('final: sin errores de JavaScript en la página', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('RESULT APP-LABS-MASIVO: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
