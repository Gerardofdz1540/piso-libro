// 🆕 Ingresos del día en el navegador de camas (12 nov 2026): la cama se pinta de azul claro en la tira (iPad) y en el
// riel (laptop) si la hoja la tiene pintada de azul (patients.hoja_azul) o si su fecha de ingreso es HOY; NCX y Urología no.
//   node tests/headless/app_ingresos.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh). Pacientes ficticios.
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const TZ = 'America/Mexico_City';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Prueba');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
// Día de hoy, ayer y mañana en la zona del hospital (la del navegador de la prueba), en ISO como los guarda la base.
const isoMx = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const HOY = isoMx(new Date()), AYER = isoMx(new Date(Date.now() - 86400000)), MANANA = isoMx(new Date(Date.now() + 86400000));
const id = (n) => '7c000000-0000-4000-8000-0000000000' + String(n).padStart(2, '0');
const pt = (n, cama, esp, ingreso, azul, nombre) => ({ id: id(n), cama, exp: '26-71' + String(n).padStart(3, '0'), nombre, esp, estado: 'ESTABLE', dx: 'DX FICTICIO', edad: '40', ingreso, hoja_azul: azul, seccion: 'PISO' });
const PTS = [
  pt(1, '3-301', 'CG', HOY, false, 'ANA FICTICIA UNO'),          // fecha de hoy → ingreso
  pt(2, '3-302', 'CG', AYER, false, 'BETO FICTICIO DOS'),         // ayer → no
  pt(3, '3-303', 'NCX', HOY, false, 'CARLA FICTICIA TRES'),       // NCX → no
  pt(4, '3-304', 'URO', HOY, true, 'DARIO FICTICIO CUATRO'),      // Urología, aunque esté azul → no
  pt(5, '3-305', 'CG', null, true, 'ELSA FICTICIA CINCO'),        // azul en la hoja, sin fecha → ingreso
  pt(6, '3-306', 'CG/URO', HOY, false, 'FIDEL FICTICIO SEIS'),    // servicio compartido con el nuestro → ingreso
  pt(7, '3-307', 'CCR', '2026-10-01', false, 'GABY FICTICIA SIETE'),   // fecha vieja → no (cambia por Realtime en N4)
  pt(8, '3-308', 'UROLOGIA', HOY, false, 'HUGO FICTICIO OCHO'),   // Urología → no
  pt(9, '3-309', 'CG', MANANA, false, 'INES FICTICIA NUEVE'),     // fecha de mañana → no
  pt(10, '3-310', 'CT', '2026-10-20', true, 'JAIME FICTICIO DIEZ'),    // azul en la hoja con fecha vieja → ingreso
];
const ESPERADAS = ['3-301', '3-305', '3-306', '3-310'];
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1194, height: 834 }, timezoneId: TZ });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const escrituras = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, PTS); escrituras.push({ m, url, body }); return json(m === 'POST' ? 201 : 200, [{ id: PTS[0].id }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: PTS[0].id }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 10 && document.querySelectorAll('#board-nav .bn-beds .bb').length === 10, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── N1: la regla, con el día fijado (21:30 del 11 nov en México = 03:30 UTC del 12: cuenta el día LOCAL) ──
  const n1 = await page.evaluate(() => {
    const noche = new Date('2026-11-12T03:30:00Z'), madrugada = new Date('2026-11-11T06:00:01Z');
    const f = (o, h) => _plIngresoHoy(o, h || noche);
    return {
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone, dia: noche.getDate(),
      hoy: f({ esp: 'CG', ingreso: '11/11/26' }), hoyLargo: f({ esp: 'CG', ingreso: '11/11/2026' }), hoyIso: f({ esp: 'CG', ingreso: '2026-11-11' }),
      utcNoCuenta: f({ esp: 'CG', ingreso: '12/11/26' }), isoUtcNoCuenta: f({ esp: 'CG', ingreso: '2026-11-12' }), ayer: f({ esp: 'CG', ingreso: '10/11/26' }),
      primerSegundo: f({ esp: 'CG', ingreso: '11/11/26' }, madrugada), ayerPrimerSegundo: f({ esp: 'CG', ingreso: '10/11/26' }, madrugada),
      sinFecha: f({ esp: 'CG', ingreso: '' }), basura: f({ esp: 'CG', ingreso: 'pendiente' }), imposible: f({ esp: 'CG', ingreso: '31/02/26' }),
      azul: f({ esp: 'CG', ingreso: '', hoja_azul: true }), azulViejo: f({ esp: 'CCR', ingreso: '01/10/26', hoja_azul: true }), azulTexto: f({ esp: 'CG', hoja_azul: 'true' }),
      ncx: f({ esp: 'NCX', ingreso: '11/11/26' }), ncxAzul: f({ esp: 'NCX', hoja_azul: true }), uro: f({ esp: 'URO', ingreso: '11/11/26', hoja_azul: true }),
      urologia: f({ esp: 'Urología', ingreso: '11/11/26' }), neuro: f({ esp: 'NEUROCX', hoja_azul: true }), dos: f({ esp: 'NCX/URO', ingreso: '11/11/26' }),
      mixto: f({ esp: 'CG/URO', ingreso: '11/11/26' }), mixtoAzul: f({ esp: 'CG / NCX', hoja_azul: true }), sinEsp: f({ esp: '', ingreso: '11/11/26' }),
      nulo: f(null), vacio: f({}),
    };
  });
  check('N1 regla: fecha de HOY (día local del equipo, no el de UTC; dd/mm/aa, dd/mm/aaaa o ISO) o fila azul en la hoja; ayer, mañana, sin fecha o fecha inválida no; NCX y Urología nunca (ni azules); servicio compartido con el nuestro sí',
    n1.tz === TZ && n1.dia === 11 && n1.hoy && n1.hoyLargo && n1.hoyIso && !n1.utcNoCuenta && !n1.isoUtcNoCuenta && !n1.ayer && n1.primerSegundo && !n1.ayerPrimerSegundo
    && !n1.sinFecha && !n1.basura && !n1.imposible && n1.azul && n1.azulViejo && !n1.azulTexto
    && !n1.ncx && !n1.ncxAzul && !n1.uro && !n1.urologia && !n1.neuro && !n1.dos && n1.mixto && n1.mixtoAzul && n1.sinEsp && !n1.nulo && !n1.vacio, JSON.stringify(n1));

  // ── N2: la tira (iPad) y el riel (laptop) marcan las mismas camas, con su aviso al pasar el cursor ──
  const leer = () => page.evaluate(() => {
    const camaDe = {}; patients.forEach(p => { camaDe[pid(p)] = p.cama; });
    const tira = Array.from(document.querySelectorAll('#board-nav .bn-beds .bb'));
    const riel = Array.from(document.querySelectorAll('#board-side .bs-btn'));
    return {
      tira: tira.filter(b => b.classList.contains('bb-ing')).map(b => b.dataset.cama).sort(),
      riel: riel.filter(b => b.classList.contains('bs-ing')).map(b => camaDe[b.dataset.k]).sort(),
      titTira: tira.filter(b => /🆕 Ingreso/.test(b.title)).map(b => b.dataset.cama).sort(),
      titRiel: riel.filter(b => /🆕 Ingreso/.test(b.title)).map(b => camaDe[b.dataset.k]).sort(),
      nTira: tira.length, nRiel: riel.length,
    };
  });
  const n2 = await leer();
  const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('N2 navegador de camas: en la tira y en el riel quedan marcadas solo las camas de ingreso nuestras (hoy o azul en la hoja), con «🆕 Ingreso» en su aviso; NCX, URO, ayer y mañana no',
    n2.nTira === 10 && n2.nRiel === 10 && igual(n2.tira, ESPERADAS) && igual(n2.riel, ESPERADAS) && igual(n2.titTira, ESPERADAS) && igual(n2.titRiel, ESPERADAS), JSON.stringify(n2));

  // ── N3: el color se ve (azul claro), distinto de una cama normal y de la cama abierta ──
  const colores = () => page.evaluate(() => {
    const bg = (el) => el ? getComputedStyle(el).backgroundColor : null, sh = (el) => el ? getComputedStyle(el).boxShadow : null;
    const t = (c) => document.querySelector('#board-nav .bn-beds .bb[data-cama="' + c + '"]');
    const k = (c) => pid(patients.find(p => p.cama === c)), r = (c) => document.querySelector('#board-side .bs-btn[data-k="' + k(c) + '"]');
    return { tIng: bg(t('3-305')), tNormal: bg(t('3-307')), tNcx: bg(t('3-303')), tCur: bg(document.querySelector('#board-nav .bn-beds .bb-cur')), tCurSh: sh(document.querySelector('#board-nav .bn-beds .bb-cur')),
      rIng: bg(r('3-305')), rNormal: bg(r('3-307')), rCur: bg(document.querySelector('#board-side .bs-cur')), rCurSh: sh(document.querySelector('#board-side .bs-cur')),
      cur: (document.querySelector('#board-nav .bn-beds .bb-cur') || {}).dataset.cama, stripVisible: getComputedStyle(document.querySelector('#board-nav .bn-beds')).display };
  });
  await page.evaluate(() => { focusGoTo(pid(patients.find(p => p.cama === '3-302'))); });
  await page.waitForTimeout(500);
  const c1 = await colores();
  await page.evaluate(() => { focusGoTo(pid(patients.find(p => p.cama === '3-301'))); });
  await page.waitForTimeout(500);
  const c2 = await colores();
  check('N3 color: el ingreso va en azul claro en la tira y en el riel, la cama normal y la de NCX siguen igual; la cama abierta conserva su color (blanca / marina) y, si es ingreso, lleva una franja azul',
    c1.stripVisible === 'flex' && c1.cur === '3-302' && c1.tIng === 'rgb(125, 211, 252)' && c1.tNormal !== c1.tIng && c1.tNcx === c1.tNormal && c1.tCur === 'rgb(255, 255, 255)' && c1.tCurSh === 'none'
    && c1.rIng === 'rgb(219, 234, 254)' && c1.rNormal === 'rgb(255, 255, 255)' && c1.rCur === 'rgb(10, 22, 40)' && c1.rCurSh === 'none'
    && c2.cur === '3-301' && c2.tCur === 'rgb(255, 255, 255)' && /rgb\(56, 189, 248\)/.test(c2.tCurSh) && c2.rCur === 'rgb(10, 22, 40)' && /rgb\(56, 189, 248\)/.test(c2.rCurSh), JSON.stringify({ c1, c2 }));

  // ── N4: la hoja pinta o despinta una fila (Realtime): el color cambia en su sitio, sin rehacer la tira ──
  const n4 = await page.evaluate(async (rows) => {
    const fila = (cama, cambios) => Object.assign({}, rows.find(r => r.cama === cama), cambios);
    const tira = document.querySelector('#board-nav .bn-beds'); const btn = (c) => document.querySelector('#board-nav .bn-beds .bb[data-cama="' + c + '"]');
    const riel = (c) => document.querySelector('#board-side .bs-btn[data-k="' + pid(patients.find(p => p.cama === c)) + '"]');
    const r = {}; const b7 = btn('3-307');
    r.antes = b7.classList.contains('bb-ing');
    // Alguien está usando la pantalla (toque reciente): el repintado suave queda en espera y el color se pone en el botón que ya está.
    _lastInteractTs = Date.now(); _lastInteractCtrl = false;
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-307', { hoja_azul: true }) });
    r.pintada = btn('3-307').classList.contains('bb-ing') && riel('3-307').classList.contains('bs-ing') && /🆕 Ingreso/.test(btn('3-307').title);
    r.mismaTira = document.querySelector('#board-nav .bn-beds') === tira && btn('3-307') === b7;
    _lastInteractTs = 0;
    r.llave = patients.find(p => p.cama === '3-307').hoja_azul === true;
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-307', { hoja_azul: false }) });
    r.despintada = !btn('3-307').classList.contains('bb-ing') && !riel('3-307').classList.contains('bs-ing') && !/Ingreso/.test(btn('3-307').title);
    r.sinLlave = !('hoja_azul' in patients.find(p => p.cama === '3-307'));
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-303', { hoja_azul: true }) });           // NCX pintado de azul: no se marca
    r.ncx = btn('3-303').classList.contains('bb-ing') || riel('3-303').classList.contains('bs-ing');
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-305', { hoja_azul: false }) });          // la hoja despinta al de sin fecha
    r.quitado = !btn('3-305').classList.contains('bb-ing');
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-305', { hoja_azul: true }) });
    r.repuesto = btn('3-305').classList.contains('bb-ing');
    await new Promise(res => setTimeout(res, 2600));                                                  // el repintado en calma no lo deshace
    r.trasCalma = btn('3-305').classList.contains('bb-ing') && !btn('3-307').classList.contains('bb-ing') && !btn('3-303').classList.contains('bb-ing');
    handlePatientChange({ eventType: 'UPDATE', new: fila('3-303', { hoja_azul: false }) });
    return r;
  }, PTS);
  check('N4 Realtime: cuando la hoja pinta la fila la cama se pone azul en la tira y en el riel sin rehacerlos, y cuando la despinta se quita (y la marca no se queda guardada); un NCX pintado de azul no se marca',
    !n4.antes && n4.pintada && n4.mismaTira && n4.llave && n4.despintada && n4.sinLlave && !n4.ncx && n4.quitado && n4.repuesto && n4.trasCalma, JSON.stringify(n4));
  const n4b = await leer();
  check('N4b después de los cambios el navegador vuelve a marcar las mismas camas', igual(n4b.tira, ESPERADAS) && igual(n4b.riel, ESPERADAS), JSON.stringify(n4b));

  // ── N5: a medianoche los de fecha de ayer dejan de ser ingreso (los azules de la hoja siguen hasta que la hoja cambie) ──
  const n5 = await page.evaluate(() => {
    const marcadas = () => Array.from(document.querySelectorAll('#board-nav .bn-beds .bb.bb-ing')).map(b => b.dataset.cama).sort();
    const man = new Date(); man.setDate(man.getDate() + 1); man.setHours(0, 0, 5, 0);
    _marcarIngresos(man); const manana = marcadas();
    _marcarIngresos(); const hoy = marcadas();
    return { manana, hoy };
  });
  check('N5 al cambiar el día: los ingresos por fecha de ayer se despintan (la de mañana pasa a ser de hoy) y los azules de la hoja siguen; al volver al día real queda como estaba',
    igual(n5.manana, ['3-305', '3-309', '3-310']) && igual(n5.hoy, ESPERADAS), JSON.stringify(n5));

  // ── N6: la marca solo se lee: la copia local no crece por los que no la tienen y la app nunca la manda a la base ──
  escrituras.length = 0;
  const n6 = await page.evaluate(async () => {
    const guard = lsGetPatients() || [];
    const con = guard.filter(p => 'hoja_azul' in p).map(p => p.cama).sort();
    const p = patients.find(x => x.cama === '3-305'); p.dx = 'DX CAMBIADO FICTICIO';
    try { await supaUpsertPatient(p, ['dx']); } catch (e) { return { con, err: String(e) }; }
    const p2 = patients.find(x => x.cama === '3-310'); p2.estado = 'DELICADO';
    try { await supaUpsertPatient(p2); } catch (e) { return { con, err: String(e) }; }
    return { con, sigue: patients.find(x => x.cama === '3-305').hoja_azul === true };
  });
  await page.waitForTimeout(300);
  check('N6 solo lectura: en la copia local la llave existe solo en las filas azules (3-304, 3-305, 3-310) y al guardar un paciente desde la app ninguna petición manda hoja_azul',
    !n6.err && igual(n6.con, ['3-304', '3-305', '3-310']) && n6.sigue && escrituras.length >= 2 && escrituras.every(e => !/hoja_azul/.test(JSON.stringify(e.body || '') + e.url)), JSON.stringify({ n6, escrituras: escrituras.map(e => e.m + ' ' + Object.keys((Array.isArray(e.body) ? e.body[0] : e.body) || {}).join(',')) }));

  // ── N7: un repintado completo deja lo mismo (la marca viene del modelo, no del DOM) ──
  await page.evaluate(() => { renderView(); });
  await page.waitForTimeout(400);
  const n7 = await leer();
  check('N7 repintado completo: las mismas camas marcadas en la tira y en el riel', igual(n7.tira, ESPERADAS) && igual(n7.riel, ESPERADAS), JSON.stringify(n7));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-INGRESOS: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
