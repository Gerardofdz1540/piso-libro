// 📊 Datos para el registro de pacientes (28 oct 2026). Pacientes ficticios.
// · 🩺 Dx principal de una lista corta bajo la caja DX: la app solo SUGIERE («¿Apendicitis aguda?») y se elige al tocar.
// · 📋 «Falta para el registro»: una línea discreta (APP, peso, talla, sexo, dx principal, cirugías sin clasificar);
//   desaparece al completar. No bloquea nada.
// · 🔪 Cada cirugía: urgencia/electiva, abordaje y Clavien-Dindo (con «¿Cuál?» si hubo complicación).
// · 🚪 Dar de alta: el motivo es obligatorio; el estado ALTA/DEFUNCIÓN ya lo trae (y no hereda el del alta anterior).
// · 📱 Cada dispositivo reporta su versión; 👥 Usuarios → 📱 Versiones avisa los que siguen con una vieja.
// node tests/headless/app_registro.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.__confirms = [];
  window.prompt=function(){ return null; }; window.alert=function(){}; window.confirm=function(m){ window.__confirms.push(String(m)); return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PTS = [
  { id: 'r1', cama: '3-501', exp: '26-60001', nombre: 'MARTA RUIZ COTA', esp: 'CG', edad: '41', dx: 'PO LAPE POR APENDICITIS COMPLICADA', ingreso: '' },
  { id: 'r2', cama: '3-502', exp: '26-60002', nombre: 'HUGO LARA PINO', esp: 'CG', edad: '67', dx: 'OCLUSION INTESTINAL', ingreso: '' },
  { id: 'r3', cama: '3-503', exp: '26-60003', nombre: 'IRMA SOTO VEGA', esp: 'CG', edad: '55', dx: 'COLECISTITIS', ingreso: '' },
];
const DISP = [
  { dispositivo: 'd-a1', nombre: 'R1 FICTICIO', equipo: 'iPad · Safari 17.6', build: 'VIEJA', visto: new Date(Date.now() - 3600e3).toISOString(), primer_visto: new Date(Date.now() - 20 * 86400e3).toISOString() },
  { dispositivo: 'd-a2', nombre: 'R2 FICTICIO', equipo: 'iPad · Safari 17.6 · ícono', build: '__ACTUAL__', visto: new Date(Date.now() - 600e3).toISOString(), primer_visto: new Date(Date.now() - 9 * 86400e3).toISOString() },
  { dispositivo: 'd-a3', nombre: 'R3 FICTICIO', equipo: 'Windows · Chrome', build: 'MUY-VIEJA', visto: new Date(Date.now() - 12 * 86400e3).toISOString(), primer_visto: new Date(Date.now() - 25 * 86400e3).toISOString() },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const rpcs = [], archivos = [], cuentasUrl = []; let disp = [], cuentas = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  // Panel 👥 Usuarios: la lista de cuentas viene de la Edge Function admin-users (aquí, vacía).
  await page.route('**/functions/v1/admin-users', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ users: [] }) }));
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/, '')); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (url.startsWith('/rest/v1/rpc/')) { rpcs.push({ name: url.slice('/rest/v1/rpc/'.length).split('?')[0], body: JSON.parse(req.postData() || '{}') }); return json(200, 'ok'); }
    if (url.startsWith('/rest/v1/pl_dispositivos') && m === 'GET') return json(200, disp);
    if (url.startsWith('/rest/v1/app_users') && m === 'GET' && /last_seen_at=gte\./.test(url)) { cuentasUrl.push(url); return json(200, cuentas); }
    if (url.startsWith('/rest/v1/archive') && m === 'POST') { archivos.push(JSON.parse(req.postData() || '{}')); return json(201, [{ id: '00000000-0000-0000-0000-00000000000' + archivos.length }]); }
    if (m !== 'GET') return json(200, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 900) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  // ── V: versión del dispositivo ──
  const v1 = rpcs.filter(r => r.name === 'pl_reportar_dispositivo');
  const build = await page.evaluate(() => PL_BUILD);
  check('V1 al entrar el dispositivo reporta su versión (id al azar guardado, versión y equipo, nada de pacientes)',
    v1.length === 1 && v1[0].body.p_build === build && /^d-[a-z0-9]+-[a-z0-9]+$/.test(v1[0].body.p_dispositivo) && typeof v1[0].body.p_equipo === 'string' && v1[0].body.p_equipo.length <= 60 && Object.keys(v1[0].body).sort().join() === 'p_build,p_dispositivo,p_equipo',
    JSON.stringify(v1));
  const mismoId = await page.evaluate(() => { _plReportarDispositivo(false); return localStorage.getItem('pl_dispositivo_id'); });
  await page.waitForTimeout(200);
  check('V2 no reporta otra vez antes de una hora; el id del dispositivo es el mismo', rpcs.filter(r => r.name === 'pl_reportar_dispositivo').length === 1 && mismoId === v1[0].body.p_dispositivo, mismoId);
  disp = DISP.map(d => Object.assign({}, d, { build: d.build === '__ACTUAL__' ? build : d.build }));
  await page.evaluate(() => { _myProfile = { id: 'u1', role: 'admin', status: 'active', nombre: 'ADMIN' }; openAdminPanel(); adminTab('versiones'); });
  await page.waitForSelector('[data-testid="adm-ver-row"]', { timeout: 8000 });
  const ver = await page.evaluate(() => ({ res: (document.querySelector('[data-testid="adm-ver-resumen"]') || {}).textContent || '', filas: Array.from(document.querySelectorAll('[data-testid="adm-ver-row"]')).map(r => r.textContent.replace(/\s+/g, ' ')) }));
  check('V3 📱 Versiones: avisa que 1 de 2 dispositivos de la última semana tiene una versión vieja; lista los 3 con su estado',
    /1 de 2 dispositivo\(s\) usados en los últimos 7 días NO tienen la versión/.test(ver.res) && ver.filas.length === 3 && /R1 FICTICIO.*VIEJA.*versión vieja/.test(ver.filas[0]) && /R2 FICTICIO.*al día/.test(ver.filas[1]), JSON.stringify(ver));
  disp = disp.filter(d => d.dispositivo !== 'd-a1');
  await page.evaluate(() => adminTab('versiones')); await page.waitForTimeout(500);
  const ver2 = await page.evaluate(() => (document.querySelector('[data-testid="adm-ver-resumen"]') || {}).textContent || '');
  check('V4 con todos los de la semana al día dice ✅ (el viejo de hace 12 días no cuenta)', /✅ Los 1 dispositivo\(s\) usados en los últimos 7 días tienen la versión/.test(ver2), ver2);
  // Punto ciego: cuentas que abrieron la app en la semana sin que ningún dispositivo suyo reportara (versión anterior).
  disp = disp.map(d => Object.assign({}, d, { user_id: d.dispositivo === 'd-a2' ? 'u-r2' : 'u-r3' }));
  cuentas = [{ id: 'u-r2', nombre: 'R2 FICTICIO', email: 'r2@ficticio.test', last_seen_at: new Date(Date.now() - 900e3).toISOString() },
    { id: 'u-r4', nombre: 'R4 FICTICIO SIN REPORTE', email: 'r4@ficticio.test', last_seen_at: new Date(Date.now() - 2 * 86400e3).toISOString() },
    { id: 'u-r3', nombre: 'R3 FICTICIO', email: 'r3@ficticio.test', last_seen_at: new Date(Date.now() - 86400e3).toISOString() }];
  await page.evaluate(() => adminTab('versiones'));
  await page.waitForSelector('[data-testid="adm-ver-sin-reporte"]', { timeout: 8000 }).catch(() => {});
  const ver3 = await page.evaluate(() => ({ res: (document.querySelector('[data-testid="adm-ver-resumen"]') || {}).textContent || '', sin: Array.from(document.querySelectorAll('[data-testid="adm-ver-sin-reporte"]')).map(r => r.textContent.replace(/\s+/g, ' ')) }));
  check('V5 📱 Versiones: las cuentas activas que abrieron la app en la semana sin reportar (R4, y R3 cuyo único equipo no se usa hace 12 días) salen como «sin reporte · versión anterior»; R2 (reporta) no',
    /2 cuenta\(s\) usaron la app en los últimos 7 días sin reportar su versión/.test(ver3.res) && /barra azul/.test(ver3.res) && ver3.sin.length === 2
    && /R4 FICTICIO SIN REPORTE.*sin reporte · versión anterior/.test(ver3.sin.join('|')) && /R3 FICTICIO/.test(ver3.sin.join('|')) && !/R2 FICTICIO/.test(ver3.sin.join('|'))
    && cuentasUrl.length >= 1 && /status=eq\.active/.test(cuentasUrl[cuentasUrl.length - 1]), JSON.stringify({ ver3, cuentasUrl }));
  await page.evaluate(() => closeAdminPanel());

  // Ayudante: deja la nota del paciente i vacía (o con lo que se pase) y pinta su tarjeta.
  await page.evaluate(() => {
    window.__pon = function (i, o) {
      o = o || {};
      const p = patients[i], k = pid(p);
      const nd = defaultData(); Object.assign(nd, o.nd || {}); Object.assign(nd.checklist, o.ck || {});
      noteData[k] = nd;
      if (!document.getElementById('card-' + k)) focusGoTo(k);   // en el tablero solo se pinta la tarjeta en foco
      _rerenderCard(k);
      return k;
    };
    window.__card = function (i) {
      const k = pid(patients[i]), c = document.getElementById('card-' + k);
      const q = (s) => c && c.querySelector(s);
      return { hay: !!c, auto: q('[data-testid="dxp-auto"]') ? q('[data-testid="dxp-auto"]').textContent : '', sel: q('[data-testid="dxp-sel"]') ? q('[data-testid="dxp-sel"]').value : null,
        falta: q('[data-testid="por-completar"]') ? q('[data-testid="por-completar"]').textContent : '', ck: JSON.parse(JSON.stringify((noteData[k] || {}).checklist || {})),
        labsBadge: q('[data-testid="labs-diarios"]') ? q('[data-testid="labs-diarios"]').textContent : '', labsLinea: q('[data-testid="labs-diarios-linea"]') ? q('[data-testid="labs-diarios-linea"]').textContent : '' };
    };
  });
  const pon = (i, o) => page.evaluate(([i, o]) => window.__pon(i, o), [i, o]);
  const card = (i) => page.evaluate((i) => window.__card(i), i);
  const elegir = async (sel, texto) => {
    await page.waitForFunction((s) => { const e = document.querySelector(s); if (e && !e.__trig && window.residSyncSelects) window.residSyncSelects(); return !!(e && e.__trig && e.__trig.isConnected); }, sel, { timeout: 15000 });
    await page.evaluate((s) => document.querySelector(s).__trig.click(), sel);
    await page.waitForSelector('.resid-sheet-backdrop.rs-open .resid-sheet-row');
    // Igual al texto si existe («Urgencia», no «Urgencia / electiva»); si no, el que empieza con él.
    await page.evaluate((t) => { const rs = Array.from(document.querySelectorAll('.resid-sheet-backdrop.rs-open .resid-sheet-row')); const tx = (x) => x.querySelector('.rs-tx').textContent.trim(); const r = rs.find(x => tx(x) === t) || rs.find(x => tx(x).indexOf(t) === 0); r.click(); }, texto);
    await page.waitForTimeout(500);
  };

  // ── D: diagnóstico principal (30 oct 2026: se selecciona solo con el DX del censo; no se guarda nada hasta que alguien elige otro) ──
  const k0 = await pon(0);
  let c = await card(0);
  check('D1 bajo la caja DX: «🩺 Dx principal» ya seleccionado con el DX del censo (apendicitis), marcado «auto · del DX», sin guardar nada',
    c.hay && c.sel === 'apendicitis' && /auto · del DX/.test(c.auto) && !c.ck.dx_cat && !/dx principal/.test(c.falta), JSON.stringify(c));
  // Cambia el DX (como al editar la caja): el automático lo sigue sin repintar la tarjeta.
  await page.evaluate((k) => updateField(k, 'dx', 'PANCREATITIS AGUDA BILIAR'), k0); await page.waitForTimeout(300);
  c = await card(0);
  check('D2 al cambiar el DX, el dx principal automático lo sigue (pancreatitis) y sigue sin guardarse', c.sel === 'pancreatitis' && /auto/.test(c.auto) && !c.ck.dx_cat, JSON.stringify(c));
  await elegir('#card-' + k0 + ' [data-testid="dxp-sel"]', 'Colecistitis / colelitiasis');
  c = await card(0);
  check('D3 elegir otro en el menú lo guarda y manda (ya no dice «auto»)', c.ck.dx_cat === 'colecistitis' && c.sel === 'colecistitis' && !c.auto, JSON.stringify(c));
  const etq = await page.evaluate((k) => undoLast(k), k0);
  c = await card(0);
  check('D4 ↩ Regresar lo quita y vuelve al automático', /dx principal/.test(etq) && !c.ck.dx_cat && c.sel === 'pancreatitis' && /auto/.test(c.auto), JSON.stringify({ etq, c }));
  await elegir('#card-' + k0 + ' [data-testid="dxp-sel"]', 'Pancreatitis aguda');
  await page.evaluate((k) => setDxPrincipal(k, 'pancreatitis'), k0);   // aunque llegue la elección (teclado, otro navegador)
  c = await card(0);
  check('D5 elegir el mismo que ya se ve en automático no guarda nada', !c.ck.dx_cat && c.sel === 'pancreatitis' && /auto/.test(c.auto), JSON.stringify(c));
  await elegir('#card-' + k0 + ' [data-testid="dxp-sel"]', 'Hernia de pared');
  await elegir('#card-' + k0 + ' [data-testid="dxp-sel"]', '↺ Automático');
  c = await card(0);
  check('D6 «↺ Automático» borra lo elegido y regresa al del DX', !c.ck.dx_cat && c.sel === 'pancreatitis' && /auto/.test(c.auto), JSON.stringify(c));
  const sug = await page.evaluate(() => ['OCLUSION INTESTINAL POR BRIDAS', 'PO LAPE + CA DE COLON SIGMOIDES', 'CA DE RECTO + OCLUSION', 'ABSCESO PERIANAL', 'PIE DIABETICO WAGNER 4', 'COLEDOCOLITIASIS', 'DOLOR ABDOMINAL EN ESTUDIO', 'HPAF EN ABDOMEN', 'ESTADO POSTERIOR A NADA'].map(_dxCatSugerida));
  check('D7 el automático toma el término que aparece primero; lo específico antes que lo genérico («CA DE COLON» → colorrectal)',
    JSON.stringify(sug) === JSON.stringify(['oclusion', 'ca_colorrectal', 'ca_colorrectal', 'anorrectal', 'pie_diabetico', 'coledoco', 'abdomen_agudo', 'trauma_abd', '']), JSON.stringify(sug));
  await page.evaluate((k) => setDxPrincipal(k, 'hernia'), k0);
  const malo = await page.evaluate((k) => { setDxPrincipal(k, 'inventada'); return noteData[k].checklist.dx_cat; }, k0);
  check('D8 un valor fuera de la lista no se guarda', malo === 'hernia', malo);
  await pon(0, { nd: { dx: 'ESTADO POSTERIOR A NADA' } });
  c = await card(0);
  check('D9 un DX que no coincide con ninguno: «— elegir —», el aviso «el DX no coincide» y «dx principal» en lo que falta', c.sel === '' && /no coincide/.test(c.auto) && /dx principal/.test(c.falta), JSON.stringify(c));

  // ── L: 🧪 labs diarios (colangitis, pancreatitis o intubado) ──
  await pon(0, { nd: { dx: 'COLANGITIS AGUDA GRADO II' } });
  c = await card(0);
  const sinHoy = c;
  // «Hoy» como lo cuenta la tarjeta (fecha local del equipo, igual que «días sin labs»).
  const hoyLocal = await page.evaluate(() => { const d = new Date(), z = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); });
  await pon(0, { nd: { dx: 'COLANGITIS AGUDA GRADO II', labHistory: [{ fecha: hoyLocal, labs: { hb: '12' } }] } });
  const conHoy = await card(0);
  await pon(0, { nd: { dx: 'HERNIA INGUINAL' } });
  const nada = await card(0);
  await page.evaluate((k) => toggleChecklist(k, 'pm_vent'), k0); await page.waitForTimeout(200);
  const vm = await card(0);
  const cajas = await page.evaluate((k) => ['pendientes', 'manejo', 'entrega', 'dx'].map((f) => noteData[k][f] || '').join('|'), k0);
  await page.evaluate((k) => toggleChecklist(k, 'pm_vent'), k0); await page.waitForTimeout(200);
  const sinVm = await card(0);
  const mot = await page.evaluate(() => ['PANCREATITIS AGUDA SEVERA', 'PO LAPE + IOT', 'PACIENTE INTUBADO', 'PO LAPE, IOT 28/10, EXTUBADO HOY', 'COLECISTITIS'].map((dx) => _labsDiariosMotivos({ dx }, { checklist: {} }).join(',')));
  check('L1 colangitis: «🧪 Labs diarios» en el encabezado y «Pedir labs todos los días» en la caja Labs; con labs de hoy, ✓',
    /🧪 Labs diarios/.test(sinHoy.labsBadge) && !/✓/.test(sinHoy.labsBadge) && /Pedir labs todos los días \(colangitis\)/.test(sinHoy.labsLinea) && /hoy todavía no hay labs/.test(sinHoy.labsLinea)
    && /✓/.test(conHoy.labsBadge) && /hoy ya hay labs/.test(conHoy.labsLinea), JSON.stringify({ sinHoy: [sinHoy.labsBadge, sinHoy.labsLinea], conHoy: [conHoy.labsBadge, conHoy.labsLinea] }));
  check('L2 sin colangitis, pancreatitis ni intubación no sale; al marcar 🫁 VM sale sin repintar la tarjeta y al quitarla se va; no escribe nada en ninguna caja',
    !nada.labsBadge && !nada.labsLinea && /Labs diarios/.test(vm.labsBadge) && /intubado/.test(vm.labsLinea) && !sinVm.labsBadge && !sinVm.labsLinea
    && cajas === '|||HERNIA INGUINAL', JSON.stringify({ nada: nada.labsBadge, vm: [vm.labsBadge, vm.labsLinea], sinVm: sinVm.labsBadge, cajas }));
  check('L3 motivos desde el DX: pancreatitis, IOT/intubado; «extubado» no cuenta; colecistitis no',
    JSON.stringify(mot) === JSON.stringify(['pancreatitis', 'intubado', 'intubado', '', '']), JSON.stringify(mot));

  // ── P: por completar ──
  await pon(1);
  c = await card(1);
  check('P1 «📋 Falta para el registro» enlista APP, peso, talla y sexo; el dx principal ya salió solo del DX (oclusión)', /APP · peso · talla · sexo$/.test(c.falta) && c.sel === 'oclusion', c.falta);
  await pon(1, { nd: { app: 'DM2 EN TRATAMIENTO' }, ck: { pm_peso: '70', pm_talla: '165', sexo: 'M', dx_cat: 'oclusion', cirugias: [{ id: 'q1', fecha: '2026-10-20', procedimiento: 'LAPE + ADHERENCIOLISIS', hallazgos: '', sangrado: '', cirujano: '' }] } });
  c = await card(1);
  check('P2 con todo lleno solo queda la cirugía sin urgencia/abordaje/Clavien', c.falta === '📋 Falta para el registro: 1 cirugía sin urgencia/abordaje/Clavien', c.falta);

  // ── C: cirugía estructurada ──
  const k1 = await page.evaluate(() => pid(patients[1]));
  const est = await page.evaluate((k) => { const c = document.querySelector('#card-' + k + ' [data-testid="cx-estructura"]'); return c ? Array.from(c.querySelectorAll('select')).map(s => s.dataset.testid + ':' + s.options.length) : null; }, k1);
  check('C1 cada cirugía trae tres menús: urgencia/electiva (2), abordaje (5) y Clavien-Dindo (8)', JSON.stringify(est) === JSON.stringify(['cx-tipo:3', 'cx-abordaje:6', 'cx-clavien:9']), JSON.stringify(est));
  await elegir('#card-' + k1 + ' [data-testid="cx-tipo"]', 'Urgencia');
  await elegir('#card-' + k1 + ' [data-testid="cx-abordaje"]', 'Laparoscópica convertida');
  c = await card(1);
  const noCual = await page.evaluate((k) => !document.querySelector('#card-' + k + ' [data-testid="cx-complicacion"]'), k1);
  check('C2 se guardan urgencia y abordaje; sin complicación elegida no aparece «¿Cuál?»', c.ck.cirugias[0].tipo === 'urgencia' && c.ck.cirugias[0].abordaje === 'convertida' && noCual, JSON.stringify(c.ck.cirugias[0]));
  await elegir('#card-' + k1 + ' [data-testid="cx-clavien"]', 'IIIb');
  await page.fill('#card-' + k1 + ' [data-testid="cx-complicacion"]', 'FUGA DE ANASTOMOSIS');
  await page.waitForTimeout(300);
  c = await card(1);
  check('C3 Clavien IIIb muestra «¿Cuál?» y guarda la complicación; la línea «Falta para el registro» desaparece',
    c.ck.cirugias[0].clavien === 'IIIb' && c.ck.cirugias[0].complicacion === 'FUGA DE ANASTOMOSIS' && c.falta === '', JSON.stringify({ cx: c.ck.cirugias[0], falta: c.falta }));
  const inv = await page.evaluate((k) => { updateCirugia(k, 'q1', 'clavien', 'XX'); updateCirugia(k, 'q1', 'tipo', 'otra'); const x = noteData[k].checklist.cirugias[0]; return x.clavien + '|' + x.tipo; }, k1);
  check('C4 valores fuera de las listas no se guardan', inv === 'IIIb|urgencia', inv);

  // ── A: motivo obligatorio al dar de alta ──
  const k2 = await page.evaluate(() => pid(patients[2]));
  await page.evaluate((k) => openConfirm(k), k2);
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('confirm-btn').click());
  await page.waitForTimeout(700);
  const a1 = await page.evaluate((k) => ({ sigue: patients.some(p => pid(p) === k), err: getComputedStyle(document.getElementById('confirm-egreso-err')).display, hoja: !!document.querySelector('.resid-sheet-backdrop.rs-open'), ph: document.querySelector('#confirm-egreso-tipo option').textContent }), k2);
  check('A1 sin motivo no da de alta: avisa «Elige el motivo del egreso» y abre el menú', a1.sigue && a1.err === 'block' && a1.hoja && a1.ph === '— Elige el motivo —' && archivos.length === 0, JSON.stringify(a1));
  await page.evaluate(() => { const b = document.querySelector('.resid-sheet-backdrop.rs-open'); const r = Array.from(b.querySelectorAll('.resid-sheet-row')).find(x => /^Traslado/.test(x.querySelector('.rs-tx').textContent.trim())); r.click(); });
  await page.waitForTimeout(400);
  const errOculto = await page.evaluate(() => getComputedStyle(document.getElementById('confirm-egreso-err')).display);
  await page.evaluate(() => document.getElementById('confirm-btn').click());
  await page.waitForTimeout(800);
  const a2 = archivos[0] || {};
  check('A2 al elegir el motivo se quita el aviso y el alta sale con él (traslado, con quién)', errOculto === 'none' && (a2.note_data || {})._egreso_tipo === 'traslado' && (a2.note_data || {})._egreso_tipo_por === 'Tester' && !(await page.evaluate((k) => patients.some(p => pid(p) === k), k2)), JSON.stringify({ errOculto, nd: a2.note_data && { t: a2.note_data._egreso_tipo, por: a2.note_data._egreso_tipo_por } }));
  // El menú del cuadro se quedó en «Traslado»: un alta por estado ALTA no debe heredarlo.
  await page.evaluate(() => { const sel = document.createElement('select'); sel.dataset.pk = pid(patients[0]); sel.innerHTML = '<option>ESTABLE</option><option>ALTA</option>'; sel.value = 'ALTA'; inlineEstado(sel); });
  await page.waitForTimeout(800);
  const a3 = archivos[1] || {};
  check('A3 el estado ALTA da de alta con motivo «alta» (no hereda el «Traslado» que quedó en el cuadro)', (a3.note_data || {})._egreso_tipo === 'alta', JSON.stringify(a3.note_data && a3.note_data._egreso_tipo));

  // La tabla de diagnósticos de la app y la del registro (Apps Script) deben ser la misma.
  const fs = require('fs'), path = require('path');
  const bloque = (txt, ini) => { const i = txt.indexOf(ini); if (i < 0) return ''; const j = txt.indexOf('];', i); return txt.slice(i + ini.length, j).replace(/"/g, "'").replace(/\s+/g, ' ').trim(); };
  const dxApp = bloque(fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8'), 'const DX_CATS = [');
  const dxReg = bloque(fs.readFileSync(path.join(__dirname, '../../apps-script/registro-pacientes.gs'), 'utf8'), 'var REG_DX_CATS = [');
  check('T1 la lista de diagnósticos (con CIE-10 y patrones) es idéntica en la app y en el registro', dxApp.length > 500 && dxApp === dxReg, dxApp.length + ' vs ' + dxReg.length);

  check('Z sin errores de página', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-REGISTRO: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
