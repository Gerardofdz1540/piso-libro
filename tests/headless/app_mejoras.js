// 🧪 Mejoras del tablero (30 oct 2026). Pacientes ficticios.
// · 🧪 Labs hoy: camas con labs diarios (colangitis, pancreatitis, intubado, NPT, vasopresor, sepsis, LRA) sin labs de hoy,
//   con «📋 Copiar lista» y renglón que lleva a la cama.
// · 📅 Días que se cuentan solos: antibiótico, ayuno y NPT con fecha de inicio (el día de inicio = día 1).
// · 🔎 Búsqueda dentro de las cajas (DX, Cirugías, Pendientes, Otros, APP/PA) que lleva directo a la caja.
// · ⬆ Punto por cama con cambios sin subir.
// · 🕘 Qué cambió: lo escrito en las últimas horas con su autor; solo se muestra (no escribe nada).
// node tests/headless/app_mejoras.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.__copiado = null; window.__prompts = [];
  window.prompt=function(m, v){ window.__prompts.push(String(v || '')); return null; }; window.alert=function(){}; window.confirm=function(){ return true; };
  try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: function (t) { window.__copiado = String(t); return Promise.resolve(); } } }); } catch (_) {}
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PTS = [
  { id: 'm1', cama: '3-601', exp: '26-61001', nombre: 'ANA FICTICIA UNO', esp: 'CG', edad: '41', dx: 'COLANGITIS AGUDA', ingreso: '' },
  { id: 'm2', cama: '3-602', exp: '26-61002', nombre: 'BETO FICTICIO DOS', esp: 'CG', edad: '67', dx: 'SEPSIS ABDOMINAL', ingreso: '' },
  { id: 'm3', cama: '3-603', exp: '26-61003', nombre: 'CARLA FICTICIA TRES', esp: 'CG', edad: '55', dx: 'COLEDOCOLITIASIS', ingreso: '' },
  { id: 'm4', cama: '3-604', exp: '26-61004', nombre: 'DAVID FICTICIO CUATRO', esp: 'CG', edad: '70', dx: 'LRA AKIN 2', ingreso: '' },
  { id: 'm5', cama: '3-605', exp: '26-61005', nombre: 'ELSA FICTICIA CINCO', esp: 'CG', edad: '62', dx: 'COLECISTITIS', ingreso: '' },
  { id: 'm6', cama: '3-606', exp: '26-61006', nombre: 'FIDEL FICTICIO SEIS', esp: 'CG', edad: '33', dx: 'PO LAPE, SIN SEPSIS', ingreso: '' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const escrituras = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/, '')); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (m !== 'GET' && url.startsWith('/rest/v1/notes')) escrituras.push({ m, url, t: Date.now() });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (m !== 'GET') return json(200, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 900) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 6, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Estado de partida: m2 con labs de hoy; m3 con NPT y una CPRE en Cirugías; m5 con norepinefrina.
  await page.evaluate(() => {
    const k = (id) => pid(patients.find(x => x._supa_id === id));
    const d = new Date(), z = (n) => String(n).padStart(2, '0'), hoy = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    getNote(k('m2')).labHistory = [{ fecha: hoy, labs: { hb: '12' } }];
    const n3 = getNote(k('m3')); n3.checklist = Object.assign(n3.checklist || {}, { npt: true, cirugias: [{ id: 'c1', fecha: '', procedimiento: 'CPRE CON ESFINTEROTOMIA', hallazgos: '' }] });
    const n5 = getNote(k('m5')); n5.checklist = Object.assign(n5.checklist || {}, { vp_nore_on: true });
    getNote(k('m4')).qx = 'HEMICOLECTOMIA DERECHA';   // caja Qx de antes: también se busca
    window.__focusPid = k('m6'); renderView();
  });

  // ── M1: 🧪 Labs hoy ──
  const m1 = await page.evaluate(async () => {
    const motivos = (id) => _labsDiariosMotivos(patients.find(x => x._supa_id === id), getNote(pid(patients.find(x => x._supa_id === id))));
    const btn = document.querySelector('[data-testid="labs-hoy-btn"]');
    const txtBtn = btn ? btn.textContent : '';
    btn.click(); await new Promise(r => setTimeout(r, 50));
    const filas = Array.from(document.querySelectorAll('[data-testid="labs-hoy-row"]')).map(b => b.textContent.replace(/\s+/g, ' ').trim());
    document.querySelector('[data-testid="labs-hoy-copiar"]').click(); await new Promise(r => setTimeout(r, 50));
    return { m: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(motivos), txtBtn, filas, copiado: window.__copiado || '' };
  });
  check('M1a motivos de labs diarios: colangitis, sepsis, NPT, LRA y vasopresor; «SIN SEPSIS» no cuenta',
    JSON.stringify(m1.m) === JSON.stringify([['colangitis'], ['sepsis'], ['NPT'], ['LRA'], ['vasopresor'], []]), JSON.stringify(m1.m));
  check('M1b «🧪 Labs hoy · 4»: lista las camas sin labs de hoy (no la que ya tiene) con su motivo y la copia con un toque',
    /Labs hoy · 4/.test(m1.txtBtn) && m1.filas.length === 4 && /^3-601 .*colangitis$/.test(m1.filas[0]) && !m1.filas.some(f => /3-602|3-606/.test(f))
    && /Pedir labs hoy/.test(m1.copiado) && /3-601 · ANA FICTICIA UNO · EXP 26-61001 · colangitis/.test(m1.copiado) && /3-605 .*vasopresor/.test(m1.copiado) && !/3-602/.test(m1.copiado),
    JSON.stringify(m1));
  const m1c = await page.evaluate(async () => {
    document.querySelectorAll('[data-testid="labs-hoy-row"]')[2].click(); await new Promise(r => setTimeout(r, 200));
    const foco = window.__focusPid;
    toggleLabsHoy();
    return { foco, cama: (patients.find(x => pid(x) === foco) || {}).cama, cerrado: !document.querySelector('[data-testid="labs-hoy-panel"]') };
  });
  check('M1c un renglón lleva a esa cama; ✕ cierra la lista', m1c.cama === '3-604' && m1c.cerrado, JSON.stringify(m1c));

  // ── M2: 📅 días que se cuentan solos ──
  const m2 = await page.evaluate(async () => {
    const k = pid(patients.find(x => x._supa_id === 'm1')); window.__focusPid = k; renderView();
    const nd = getNote(k); nd.checklist.atb = true; nd.checklist.atb_nombre = 'CEFTRIAXONA'; nd.checklist.atb_dias = '9'; nd.checklist.npo = true;
    renderView();
    const manualAntes = !!document.querySelector('#card-' + CSS.escape(k) + ' [data-field="atb_dias"]');
    const d = new Date(); d.setDate(d.getDate() - 3); const z = (n) => String(n).padStart(2, '0');
    const ini = d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    setInicioTx(k, 'atb', ini); setInicioTx(k, 'npo', ini);
    const card = document.getElementById('card-' + k);
    const dia = (x) => ((card.querySelector('[data-testid="dia-' + x + '"]') || {}).textContent || '');
    const r = { manualAntes, manualDespues: !!card.querySelector('[data-field="atb_dias"]'), diaAtb: dia('atb'), diaNpo: dia('npo'), ckDia: _ckDia(nd.checklist, 'atb'), guardado: getNote(k).checklist.atb_inicio === ini };
    let nota = ''; try { nota = String(_plneBuild(patients.find(x => pid(x) === k), migrateNote(getNote(k)))); } catch (e) { nota = 'ERR ' + e.message; }
    r.nota = /ANTIMICROBIANO CON CEFTRIAXONA \(DÍA 4\)/.test(nota) && /AYUNO \(DÍA 4\)/.test(nota);
    // Fecha futura o borrada: vuelven los días escritos a mano.
    setInicioTx(k, 'atb', '');
    r.sinFecha = _ckDia(getNote(k).checklist, 'atb'); r.manualOtraVez = !!document.getElementById('card-' + k).querySelector('[data-field="atb_dias"]');
    const f = new Date(); f.setDate(f.getDate() + 2); r.futura = _ckDia({ atb_inicio: f.getFullYear() + '-' + z(f.getMonth() + 1) + '-' + z(f.getDate()), atb_dias: '2' }, 'atb');
    r.hoy = _ckDia({ npt_inicio: new Date().getFullYear() + '-' + z(new Date().getMonth() + 1) + '-' + z(new Date().getDate()) }, 'npt');
    return r;
  });
  check('M2 con fecha de inicio la app cuenta los días (inicio = día 1) en la tarjeta y en la nota; sin fecha (o futura) quedan los escritos a mano',
    m2.manualAntes && !m2.manualDespues && m2.diaAtb === 'día 4' && m2.diaNpo === 'día 4' && m2.ckDia === '4' && m2.guardado && m2.nota
    && m2.sinFecha === '9' && m2.manualOtraVez && m2.futura === '2' && m2.hoy === '1', JSON.stringify(m2));

  // ── M3: 🔎 búsqueda dentro de las cajas ──
  const buscar = async (t) => page.evaluate(async (t) => {
    document.getElementById('search').value = t; renderView();
    await new Promise(r => setTimeout(r, 400));
    const k = window.__focusPid, ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const strip = document.querySelector('[data-testid="busq-cajas"]');
    return { orden: (window.__boardOrder || []).map(x => (patients.find(p => pid(p) === x) || {}).cama), strip: strip ? Array.from(strip.querySelectorAll('button')).map(b => b.dataset.sec).join(',') : '',
      saltado: window.__busqSaltado || '', flash: !!document.querySelector('#sec-cx-' + ek + '.fc-flash, #sec-dx-' + ek + '.fc-flash') };
  }, t);
  const s1 = await buscar('cpre'), s2 = await buscar('lape'), s3 = await buscar('3-60'), s4 = await buscar('po'), s5 = await buscar('hemicolec');
  check('M3 «CPRE» encuentra la cama por su caja Cirugías y lleva ahí; «LAPE» por el DX; cama/nombre como antes (sin franja); con 2 letras no busca en las cajas',
    JSON.stringify(s1.orden) === '["3-603"]' && s1.strip === 'cx' && /^cpre\|/.test(s1.saltado) && s1.flash
    && JSON.stringify(s2.orden) === '["3-606"]' && s2.strip === 'dx'
    && s3.orden.length === 6 && s3.strip === '' && s4.strip === '' && !s4.orden.includes('3-606')
    && JSON.stringify(s5.orden) === '["3-604"]' && s5.strip === 'cx',
    JSON.stringify({ s1, s2, s3, s4, s5 }));
  await page.evaluate(() => { document.getElementById('search').value = ''; renderView(); });

  // ── M4: ⬆ punto por cama con cambios sin subir ──
  const m4 = await page.evaluate(async () => {
    const k = pid(patients.find(x => x._supa_id === 'm2'));
    const dots = () => Array.from(document.querySelectorAll('[data-testid="sin-subir"]')).map(d => d.parentElement.dataset.k);
    const antes = dots();
    outboxEnqueue({ type: 'note', key: k, data: getNote(k), dirty: ['pendientes'], who: { nombre: 'X' } });
    const con = dots();
    outboxRemoveKey(k);
    return { k, antes, con, despues: dots() };
  });
  check('M4 la cama con cambios en la cola de este equipo lleva su punto (sin repintar la tarjeta) y se quita al subir',
    !m4.antes.includes(m4.k) && m4.con.filter(x => x === m4.k).length >= 1 && !m4.despues.includes(m4.k), JSON.stringify(m4));

  // ── M5: 🕘 qué cambió ──
  const n0 = escrituras.length;
  const m5 = await page.evaluate(async () => {
    const k1 = pid(patients.find(x => x._supa_id === 'm1')), k5 = pid(patients.find(x => x._supa_id === 'm5'));
    const hace = (h) => new Date(Date.now() - h * 3600e3).toISOString();
    const meta = (k) => { const nd = getNote(k); nd.checklist = nd.checklist || {}; const m = nd.checklist[NOTE_SYNC_META_KEY] = nd.checklist[NOTE_SYNC_META_KEY] || {}; m.by = m.by || {}; return m.by; };
    Object.assign(meta(k1), { pendientes: { u: 'Dra Ficticia', i: 'DF', t: hace(2) }, dx: { u: 'Dr Ficticio', i: 'RF', t: hace(20) } });
    Object.assign(meta(k5), { manejo: { u: 'Dr Ficticio', i: 'RF', t: hace(1) } });
    const antes = JSON.stringify(_lsNoteCopy(getNote(k1)));
    renderView();
    const btn = document.querySelector('[data-testid="qc-btn"]').textContent;
    document.querySelector('[data-testid="qc-btn"]').click(); await new Promise(r => setTimeout(r, 50));
    const filas = () => Array.from(document.querySelectorAll('[data-testid="qc-row"]')).map(r => r.dataset.k + ':' + Array.from(r.querySelectorAll('.qc-c')).map(c => c.dataset.sec + '/' + c.textContent.replace(/\s+/g, ' ').trim()).join('|'));
    const f12 = filas();
    const sel = document.querySelector('[data-testid="qc-horas"]'); sel.value = '24'; sel.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 50));
    const f24 = filas();
    document.querySelector('[data-testid="qc-row"][data-k="' + k1 + '"] .qc-c[data-sec="plan"]').click(); await new Promise(r => setTimeout(r, 300));
    const ek = k1.replace(/[^a-zA-Z0-9]/g, '_');
    const hl = !!document.querySelector('#sec-plan-' + ek + '.qc-hl') && !!document.querySelector('#sec-dx-' + ek + '.qc-hl') && !document.querySelector('#sec-manejo-' + ek + '.qc-hl');
    const r = { btn, f12, f24, foco: window.__focusPid === k1, hl, k1, k5, igual: JSON.stringify(_lsNoteCopy(getNote(k1))) === antes, cola: outboxLoad().length };
    toggleQueCambio();
    r.cerrado = !document.querySelector('[data-testid="qc-panel"]') && !document.querySelector('.qc-hl');
    return r;
  });
  await page.waitForTimeout(800);
  check('M5a «🕘 Cambios · 2»: por cama, las cajas escritas en las últimas 12 h con iniciales y hora (lo más reciente primero); con 24 h entra lo de hace 20 h',
    /Cambios · 2/.test(m5.btn) && m5.f12.length === 2 && m5.f12[0].startsWith(m5.k5 + ':manejo/Otros RF') && m5.f12[1].startsWith(m5.k1 + ':') && /^.*:plan\/Pendientes DF · \d\d:\d\d$/.test(m5.f12[1]) && !/dx\//.test(m5.f12[1])
    && /plan\/Pendientes DF/.test(m5.f24[1]) && /dx\/DX RF/.test(m5.f24[1]),
    JSON.stringify(m5));
  check('M5b tocar una caja lleva a la tarjeta y resalta lo que cambió; solo se muestra: no escribe ni encola nada; al cerrar se quita el resaltado',
    m5.foco && m5.hl && m5.igual && m5.cola === 0 && escrituras.length === n0 && m5.cerrado, JSON.stringify({ m5, escrituras: escrituras.slice(n0) }));

  check('M6 sin errores de JavaScript', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-MEJORAS: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
