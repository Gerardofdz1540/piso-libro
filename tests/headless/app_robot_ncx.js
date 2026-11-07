// 🤖 NCX y Urología fuera de los robots (7 nov 2026) + horario de fin de semana + freno de presencia.
// · _plSinRobot (app) es copia EXACTA de esServicioSinRobot (rpa/lib.js): mismas respuestas en un corpus amplio.
// · Tarjeta de NCX/URO: línea gris discreta, sin 🔎 Buscar ahora ni sugerencias; 🔎 no dispara al robot.
// · «📭 sin labs de hoy» y «🧪 Labs hoy» no cuentan NCX/URO (falsa alarma); sus críticos sí.
// · Indicador del robot: la corrida de 13:00 León solo cuenta sábado y domingo.
// · Presencia: un track por cambio real de paciente y como mucho uno cada 2 s (Supabase cortaba el canal).
//   node tests/headless/app_robot_ncx.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh). Pacientes ficticios.
const path = require('path');
const { pathToFileURL } = require('url');
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Uno');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PTS = [
  { id: '9a000000-0000-4000-8000-000000000001', cama: '3-201', exp: '26-90001', nombre: 'ANA LOPEZ RUIZ', esp: 'CG', estado: 'ESTABLE', dx: 'PANCREATITIS AGUDA', edad: '40' },
  { id: '9a000000-0000-4000-8000-000000000002', cama: '3-202', exp: '26-90002', nombre: 'BETO DIAZ SOLIS', esp: 'NCX', estado: 'ESTABLE', dx: 'PANCREATITIS AGUDA', edad: '50' },
  { id: '9a000000-0000-4000-8000-000000000003', cama: '3-203', exp: '26-90003', nombre: 'CARLA MORA VEGA', esp: 'URO', estado: 'ESTABLE', dx: 'COLANGITIS', edad: '60' },
  { id: '9a000000-0000-4000-8000-000000000004', cama: '3-204', exp: '26-90004', nombre: 'DAVID LUNA PAZ', esp: 'CG/URO', estado: 'ESTABLE', dx: 'COLANGITIS', edad: '45' },
  { id: '9a000000-0000-4000-8000-000000000005', cama: '3-205', exp: '26-90005', nombre: 'ELENA RIOS CANO', esp: 'Neurocirugía', estado: 'ESTABLE', dx: 'TCE', edad: '33' },
];
(async () => {
  const lib = await import(pathToFileURL(path.join(__dirname, '..', '..', 'rpa', 'lib.js')).href);
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const scrapes = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/api/scrape', async (route) => { scrapes.push(route.request().postData()); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dispatched: true }) }); });
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, PTS); return json(201, [{ id: PTS[0].id }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: PTS[0].id }]); }
    // Indicador del robot: última corrida = ahora (al día).
    if (url.startsWith('/rest/v1/winlab_match') && /select=checked_at&/.test(decodeURIComponent(url))) return json(200, [{ checked_at: new Date().toISOString() }]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── N1: la regla de la app es copia exacta de la del robot ──
  const toks = ['NCX', 'URO', 'CG', 'CT', 'NEURO', 'NEUROCX', 'Urología', 'neurocirugía', 'UROLOGIA', 'GYO', 'CCR', 'CP', 'UROCG', 'NCXX', 'TYO', ''];
  const seps = ['/', ' / ', ',', ';', '+', '-', ' ', ' & ', '|', ''];
  const corpus = [null, undefined, '', '   ', '/', '--', 'ncx', ' Uro ', 'Neurocirugía', 'NCX/URO', 'CG / NCX', 'URO/CG', 'GINECOURO', 12, 'Ñ'];
  toks.forEach(a => { corpus.push(a); toks.forEach(b => seps.forEach(s => corpus.push(a + s + b))); });
  const esperado = corpus.map(e => lib.esServicioSinRobot(e));
  const enApp = await page.evaluate((c) => c.map(e => _plSinRobot(e === '__undef' ? undefined : e)), corpus.map(e => e === undefined ? '__undef' : e));
  const difs = corpus.filter((e, i) => esperado[i] !== enApp[i]).slice(0, 8);
  check('N1 _plSinRobot (app) responde EXACTAMENTE igual que esServicioSinRobot (robot) en ' + corpus.length + ' variantes (NCX/URO solos fuera; compartidos con CG, vacío y otros dentro)',
    difs.length === 0 && esperado.filter(Boolean).length > 20 && esperado.some(x => !x) && lib.esServicioSinRobot('NCX') && !lib.esServicioSinRobot('CG/URO'), JSON.stringify(difs));

  // ── N2: tarjeta de NCX/URO → línea gris discreta, sin 🔎 ni sugerencias; CG y CG/URO siguen con su línea normal ──
  const n2 = await page.evaluate(() => {
    const out = {};
    patients.forEach(p => { const k = pid(p); out[p.cama] = renderRobotLine(p, getNote(k), k); });
    const pN = patients.find(p => p.cama === '3-202'); const kN = pid(pN); focusGoTo(kN);
    // En pantalla, NCX/URO (es_mio=false) se pintan con la tarjeta sencilla: ahí no aparece ningún 🔎 ni línea del robot.
    const card = document.getElementById('card-' + kN);
    const dom = { card: !!card, line: !!document.querySelector('[data-testid="robot-line"]'), anyGo: !!document.querySelector('[data-testid="robot-go"]') };
    return { out, dom };
  });
  const sinR = (h) => /data-testid="robot-sinrobot"/.test(h) && /NCX\/Urología: el robot no revisa labs, cultivos ni imagen/.test(h) && !/robot-go|rb-chip|robot-alias/.test(h);
  check('N2 NCX, URO y «Neurocirugía»: la tarjeta muestra solo la línea gris «🤖 NCX/Urología: el robot no revisa…» (sin 🔎 Buscar ahora, sin sugerencias); CG y CG/URO conservan su línea con 🔎',
    sinR(n2.out['3-202']) && sinR(n2.out['3-203']) && sinR(n2.out['3-205']) && /robot-go/.test(n2.out['3-201']) && /robot-go/.test(n2.out['3-204']) && !/robot-sinrobot/.test(n2.out['3-201'] + n2.out['3-204'])
    && n2.dom.card && !n2.dom.line && !n2.dom.anyGo && /color:#64748b/.test(n2.out['3-202']), JSON.stringify(n2));

  // ── N3: 🔎 en un paciente de NCX no dispara al robot (aviso), en CG sí ──
  const n3 = await page.evaluate(async () => {
    const kN = pid(patients.find(p => p.cama === '3-202')), kC = pid(patients.find(p => p.cama === '3-201'));
    await robotBuscarAhora(kN); await new Promise(r => setTimeout(r, 300));
    const toastN = (document.getElementById('__pl_toast') || {}).textContent || '';
    const antes = window.__scrN = true;
    await robotBuscarAhora(kC); await new Promise(r => setTimeout(r, 300));
    return { toastN, antes };
  });
  check('N3 🔎 Buscar ahora en un paciente de NCX: no llama al worker y avisa que el robot no revisa ese servicio; en uno de CG sí llama',
    /NCX\/Urología: el robot no revisa/.test(n3.toastN) && scrapes.length === 1 && /ID-9a000000-0000-4000-8000-000000000001/.test(scrapes[0] || ''), JSON.stringify({ n3, scrapes }));

  // ── N4: alertas «sin labs de hoy» y «🧪 Labs hoy» sin NCX/URO; el crítico de un URO sí se avisa ──
  const n4 = await page.evaluate(() => {
    const ayer = (() => { const d = new Date(); d.setDate(d.getDate() - 1); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); })();
    const kU = pid(patients.find(p => p.cama === '3-203'));
    const nd = getNote(kU); nd.labHistory = [{ fecha: ayer, labs: { hb: '6.1', k: '2.4' } }]; noteData[kU] = nd;
    const d = _collectSpecialAlertsData(patients);
    const camas = (arr) => arr.map(x => x.p.cama).sort();
    const lh = _labsHoyPendientes(patients).map(x => x.p.cama).sort();
    return { noHoy: camas(d.noLabsToday), noRec: camas(d.noRecentLabs), crit: camas(d.criticalCases), lh };
  });
  check('N4 «📭 sin labs de hoy» y «sin labs recientes» solo cuentan a quien revisa el robot (CG y CG/URO, no NCX/URO); el crítico ya guardado de un URO sí sale; «🧪 Labs hoy» tampoco recuerda NCX/URO',
    JSON.stringify(n4.noHoy) === '["3-201","3-204"]' && JSON.stringify(n4.noRec) === '["3-201","3-204"]' && JSON.stringify(n4.crit) === '["3-203"]' && JSON.stringify(n4.lh) === '["3-201","3-204"]', JSON.stringify(n4));

  // ── N5: indicador del robot · la corrida de 13:00 León (19:00 UTC) solo existe sábado y domingo ──
  const n5 = await page.evaluate(async () => {
    await checkScraperStatus();
    const est = window._wlRobotEstado || {};
    const iso = (t) => { const x = _wlUltimaProgramada(Date.parse(t)); return x ? x.toISOString() : null; };
    return {
      sab: iso('2026-11-07T21:30:00Z'), dom: iso('2026-11-08T21:05:00Z'), vie: iso('2026-11-06T21:30:00Z'),
      sabAntes: iso('2026-11-07T20:59:00Z'), lun: iso('2026-11-09T21:30:00Z'),
      titulo: est.title || '', status: est.status || ''
    };
  });
  check('N5 indicador del robot: sábado y domingo la última corrida esperada a las 21:30 UTC es la de 19:00 UTC (13:00 León); viernes y lunes sigue siendo la de 18:30 UTC (12:30); antes de las 2 h de margen tampoco cuenta; el indicador (al día) dice el horario nuevo',
    n5.sab === '2026-11-07T19:00:00.000Z' && n5.dom === '2026-11-08T19:00:00.000Z' && n5.vie === '2026-11-06T18:30:00.000Z' && n5.lun === '2026-11-09T18:30:00.000Z' && n5.sabAntes === '2026-11-07T18:30:00.000Z' && n5.status === 'fresh' && /Corre a las 05:00, 12:30 y 20:07; sábado y domingo también a las 13:00\./.test(n5.titulo), JSON.stringify(n5));

  // ── N6: presencia con freno ──
  const n6 = await page.evaluate(async () => {
    const sent = []; const fake = { track(o) { sent.push(o.editing); return Promise.resolve('ok'); }, unsubscribe() { return Promise.resolve('ok'); } };
    _presenceChannel = fake; _presenceSentKey = undefined; _presenceLastSent = 0;
    _presenceSetEditing('k1'); _presenceSetEditing('k1'); _presenceSetEditing('k1');           // mismo paciente: 1 envío
    const tras1 = sent.slice();
    _presenceSetEditing(null); _presenceSetEditing('k2'); _presenceSetEditing('k3');           // ráfaga: nada inmediato
    const rafaga = sent.slice();
    await new Promise(r => setTimeout(r, 2300));                                                // al cumplirse 2 s: solo el último
    const final = sent.slice();
    _presenceSetEditing('k3');                                                                  // igual al enviado: nada
    await new Promise(r => setTimeout(r, 2300));
    const igual = sent.slice();
    _presenceTrack(true);                                                                       // canal recién suscrito: manda ya
    const force = sent.slice();
    _presenceChannel = null;
    return { tras1, rafaga, final, igual, force };
  });
  check('N6 presencia: varios focos en el mismo paciente = 1 envío; una ráfaga de cambios se junta en uno solo (el último) al cumplirse 2 s; repetir lo ya enviado no manda nada; al suscribirse el canal se manda de inmediato',
    JSON.stringify(n6.tras1) === '["k1"]' && JSON.stringify(n6.rafaga) === '["k1"]' && JSON.stringify(n6.final) === '["k1","k3"]' && JSON.stringify(n6.igual) === '["k1","k3"]' && JSON.stringify(n6.force) === '["k1","k3","k3"]', JSON.stringify(n6));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-ROBOT-NCX: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
