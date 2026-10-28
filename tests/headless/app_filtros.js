// 🔎 Filtros de camas, ✏️ corregir labs a mano y 💧 índice urinario (28 oct 2026, pedido de Gera). Datos ficticios.
// · Filtros del tablero: especialidad, adscrito, servicio (sala del censo), ingresos, camas libres (por servicio, con
//   «+ Agregar paciente»), «Sin pacientes» con los filtros a la mano y «Quitar filtros».
// · ✏️ Corregir: el valor corregido queda con autor y lo que decía antes, se marca ✎, el robot ya no lo pisa (ni lo
//   que se borró a propósito), avisa del punto decimal y se regresa con ↩ Regresar.
// · Índice urinario = uresis ÷ peso ÷ horas (vacío = 24 h), con colores KDIGO, en la nota y en el resumen.
// node tests/headless/app_filtros.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const fs = require('fs'); const path = require('path');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture_ego_bh.json'), 'utf8'));
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
const DAY = 86400e3; const NOW = Date.now();
const pad = (n) => String(n).padStart(2, '0');
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dmy = (t) => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
const TODAY = iso(NOW);
const PTS = [
  { id: 'f1', cama: '3-150', exp: '26-70001', nombre: 'ANA DIAZ RIOS', esp: 'CG', edad: '40', adscrito: 'DR. ALFA', residente: 'R2 UNO', ingreso: TODAY, seccion: 'PISO' },
  { id: 'f2', cama: '3-151', exp: '26-70002', nombre: 'LUIS MORA PENA', esp: 'CCR', edad: '55', adscrito: 'DR. BETA', residente: 'R3 DOS', ingreso: iso(NOW - 10 * DAY), seccion: 'PISO' },
  { id: 'f3', cama: 'UCI 2', exp: '26-70003', nombre: 'EVA SOLIS CANO', esp: 'CG', edad: '70', adscrito: 'DR. ALFA', residente: 'R2 UNO', ingreso: iso(NOW - 1 * DAY), seccion: 'UCIA' },
  { id: 'f4', cama: '2-061', exp: '26-70004', nombre: 'IVAN ROJO LARA', esp: 'URO', edad: '12', adscrito: 'DR. GAMA', residente: 'R1 TRES', ingreso: iso(NOW - 5 * DAY), seccion: 'PEDIATRIA' },
];
// WinLab de hoy para ANA con un K mal transcrito (44.3 en vez de 4.43)
let sodio = '140.0'; let scraped = NOW - 3600e3;
const wlRow = () => ({ exp: '26-70001', paciente: 'ANA DIAZ RIOS', fecha: TODAY, scraped_at: new Date(scraped).toISOString(),
  data: { headers: [], reportes: [{ __cells: ['', '', '', `${dmy(NOW)} 06:10`, `${dmy(NOW)} 08:00`, '', ''], __hasLink: true,
    valores: FIX.valores.map(v => v.estudio === 'POTASIO' ? { ...v, valor: '44.3' } : (v.estudio === 'SODIO' ? { ...v, valor: sodio } : v)) }] } });

(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/, '')); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, PTS) : json(200, [{}]);
    if (url.startsWith('/rest/v1/winlab_labs')) return json(200, [wlRow()]);
    if (url.startsWith('/rest/v1/notes') && m === 'POST') return json(201, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 700) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 4, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  const estado = () => page.evaluate(() => ({
    orden: (window.__boardOrder || []).map(k => (patients.find(p => pid(p) === k) || {}).cama),
    btn: (document.querySelector('[data-testid="flt-btn"]') || {}).textContent || '',
    panel: !!document.querySelector('[data-testid="flt-panel"]'),
    vacio: /Sin pacientes en esta vista/.test((document.getElementById('view-piso') || {}).textContent || ''),
    libres: document.querySelectorAll('[data-testid="libre-bed"]').length,
  }));

  // Los <select> los sustituye el menú de la app (botón + hoja); se elige como lo haría una persona.
  const elegir = async (testid, texto) => {
    // El menú sustituye al <select> en el siguiente cuadro (requestAnimationFrame): en CI, más lento, la prueba llegaba
    // antes. Se espera a su botón (y se fuerza el barrido si hace falta).
    await page.waitForFunction((id) => { const s = document.querySelector('[data-testid="' + id + '"]'); if (s && !s.__trig && window.residSyncSelects) window.residSyncSelects(); return !!(s && s.__trig && s.__trig.isConnected); }, testid, { timeout: 15000 });
    await page.evaluate((id) => { const sel = document.querySelector('[data-testid="' + id + '"]'); sel.__trig.click(); }, testid);
    await page.waitForSelector('.resid-sheet-backdrop.rs-open .resid-sheet-row');
    await page.evaluate((t) => { const r = Array.from(document.querySelectorAll('.resid-sheet-backdrop.rs-open .resid-sheet-row')).find(x => x.querySelector('.rs-tx').textContent.trim().indexOf(t) === 0); r.click(); }, texto);
    await page.waitForTimeout(400);
  };
  // ── F: filtros ──
  const f0 = await page.evaluate(() => ({ btn: !!document.querySelector('#board-nav [data-testid="flt-btn"]'), seccion: patients.map(p => p.seccion), serv: patients.map(servicioDe) }));
  check('F0 el tablero trae el botón 🔎 Filtros; la sala del censo llega al paciente (servicio)', f0.btn && f0.serv.join() === 'PISO,PISO,UCIA,PEDIATRIA', JSON.stringify(f0));
  await page.click('[data-testid="flt-btn"]');
  const f1 = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-testid="flt-panel"]'),
    serv: Array.from(document.querySelectorAll('[data-testid="flt-servicio"] option')).map(o => o.textContent),
    ads: Array.from(document.querySelectorAll('[data-testid="flt-adscrito"] option')).map(o => o.textContent),
    esp: Array.from(document.querySelectorAll('[data-testid="flt-esp"] option')).map(o => o.textContent),
    ing: (document.querySelector('[data-testid="flt-ingresos"]') || {}).textContent, lib: (document.querySelector('[data-testid="flt-libres"]') || {}).textContent }));
  check('F1 el panel trae especialidad, adscrito, servicio (con nombre bonito y cuántos), ingresos y libres',
    f1.panel && f1.serv.join('|') === 'Todos|Pediatría (1)|Piso (2)|UCIA (1)' && f1.ads.includes('DR. ALFA (2)') && f1.esp.includes('CG (2)') && /Ingresos \(2\)/.test(f1.ing) && /Libres \(44\)/.test(f1.lib), JSON.stringify(f1));
  await elegir('flt-servicio', 'UCIA');
  let e = await estado();
  check('F2 servicio UCIA: solo la cama UCI 2 en el tablero y el botón dice cuántos filtros hay', e.orden.join() === 'UCI 2' && /Filtrar camas · 1/.test(e.btn) && e.panel, JSON.stringify(e));
  await elegir('flt-servicio', 'Todos');
  await elegir('flt-adscrito', 'DR. ALFA');
  e = await estado();
  check('F3 adscrito DR. ALFA: sus dos camas (3-150 y UCI 2)', e.orden.join() === '3-150,UCI 2', JSON.stringify(e));
  await elegir('flt-esp', 'CCR');
  e = await estado();
  check('F4 adscrito ALFA + especialidad CCR: «Sin pacientes» con los filtros todavía a la mano', e.vacio && e.panel && e.orden.length === 0, JSON.stringify(e));
  await page.click('[data-testid="flt-limpiar"]');
  e = await estado();
  check('F5 «Quitar filtros» regresa las 4 camas', e.orden.length === 4 && !/·/.test(e.btn), JSON.stringify(e));
  await page.evaluate(() => toggleFiltrosTablero(true));
  await page.click('[data-testid="flt-ingresos"]');
  e = await estado();
  check('F6 🆕 Ingresos: los de hoy y ayer (3-150 y UCI 2)', e.orden.join() === '3-150,UCI 2', JSON.stringify(e));
  await page.click('[data-testid="flt-libres"]');
  e = await estado();
  const f7 = await page.evaluate(() => ({ grupos: Array.from(document.querySelectorAll('.fl-grp-h')).map(x => x.textContent), ingresos: showSoloIngresos }));
  check('F7 🛏 Libres: 44 camas libres agrupadas por servicio (Piso, UCIA, otras) y se apaga «Ingresos»', e.libres === 44 && f7.grupos.join('|') === 'Piso · 40|UCIA · 3|Recuperación · 1' && !f7.ingresos, JSON.stringify({ e, f7 }));
  await elegir('flt-servicio', 'UCIA');
  e = await estado();
  const f8c = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="libre-bed"]')).map(x => x.dataset.cama).join());
  check('F8 libres + servicio UCIA: UCI 1, UCI 3 y UCI 4', e.libres === 3 && f8c === 'UCI 1,UCI 3,UCI 4', f8c);
  await page.click('[data-testid="libre-bed"][data-cama="UCI 3"] .fl-add');
  await page.waitForFunction(() => (document.getElementById('mf-cama') || {}).value === 'UCI 3', null, { timeout: 5000 }).catch(() => {});
  const f9 = await page.evaluate(() => ({ cama: (document.getElementById('mf-cama') || {}).value, visible: (document.getElementById('modal') || document.querySelector('.modal-bg')) ? true : false }));
  check('F9 «+ Agregar paciente» abre el alta con la cama puesta (UCI 3)', f9.cama === 'UCI 3', JSON.stringify(f9));
  await page.evaluate(() => { try { closeModal(); } catch (_) { document.querySelectorAll('.modal-bg').forEach(m => m.style.display = 'none'); } });
  await page.click('[data-testid="libres-salir"]');
  e = await estado();
  check('F10 «✕ Ver pacientes» regresa a las fichas (con el filtro de servicio que seguía puesto)', e.libres === 0 && e.orden.join() === 'UCI 2', JSON.stringify(e));
  await page.evaluate(() => { quitarFiltrosTodo(); toggleFiltrosTablero(true); });
  // Buscar por cama o nombre desde el panel (en «Piso Libro» la barra de búsqueda de arriba no se ve).
  await page.click('[data-testid="flt-buscar"]');
  await page.keyboard.type('3-15');
  await page.waitForTimeout(900);
  e = await estado();
  const enfoque = await page.evaluate(() => { const a = document.activeElement; return a && a.dataset && a.dataset.testid; });
  check('F12 «Cama o nombre» 3-15: solo 3-150 y 3-151; el cursor sigue en el campo para seguir escribiendo', e.orden.join() === '3-150,3-151' && enfoque === 'flt-buscar' && /Filtrar camas · 1/.test(e.btn), JSON.stringify({ e, enfoque }));
  await page.keyboard.type('1');
  await page.waitForTimeout(900);
  e = await estado();
  check('F13 al seguir escribiendo (3-151) queda una cama', e.orden.join() === '3-151', JSON.stringify(e));
  await page.click('[data-testid="flt-buscar-x"]');
  await page.fill('[data-testid="flt-buscar"]', 'solis');
  await page.waitForTimeout(900);
  e = await estado();
  check('F14 también por nombre (solis → UCI 2) y la ✕ quita la búsqueda', e.orden.join() === 'UCI 2', JSON.stringify(e));
  await page.evaluate(() => quitarBusqueda());
  const res = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="flt-residente"] option')).map(o => o.textContent));
  await elegir('flt-residente', 'R2 UNO');
  e = await estado();
  check('F15 filtro por residente (R2 UNO: 3-150 y UCI 2)', res.join('|') === 'Todos|R1 TRES (1)|R2 UNO (2)|R3 DOS (1)' && e.orden.join() === '3-150,UCI 2', JSON.stringify({ res, e }));
  await page.evaluate(() => { quitarFiltrosTodo(); toggleFiltrosTablero(false); });
  const f11 = await page.evaluate(() => ({ manual: servicioDe({ cama: 'UCI 4', seccion: '' }), piso: servicioDe({ cama: '3-170' }), lbl: servicioLabel('ONCOLOGIA / GINECOLOGIA') }));
  check('F11 paciente agregado a mano (sin sala del censo): el servicio sale de la cama; etiqueta con acentos', f11.manual === 'UCIA' && f11.piso === 'PISO' && f11.lbl === 'Oncología / Ginecología', JSON.stringify(f11));

  // ── L: corregir labs a mano ──
  await page.evaluate(() => focusGoTo(pid(patients.find(p => p.cama === '3-150'))));
  await page.waitForTimeout(400);
  const l0 = await page.evaluate(() => { const k = pid(patients.find(p => p.cama === '3-150')); const s = (noteData[k].labHistory || []).find(x => x.fecha === todayStr()); return { k, src: s && s.source, kv: s && s.labs.k, btn: !!document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="lab-corregir"]') }; });
  check('L0 el robot trajo el K mal transcrito (44.3) y la tabla de labs trae «✏️ Corregir»', l0.src === 'winlab' && l0.kv === '44.3' && l0.btn, JSON.stringify(l0));
  const K = l0.k;
  await page.evaluate((k) => document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="lab-corregir"]').click(), K);
  await page.waitForSelector('[data-testid="lab-editor"]');
  await page.fill('.le-in[data-labkey="k"]', '4.43');
  await page.click('[data-testid="lab-editor-guardar"]');
  await page.waitForTimeout(400);
  const l1 = await page.evaluate((k) => { const s = noteData[k].labHistory.find(x => x.fecha === todayStr()); return { k: s.labs.k, mk: s.manual_keys, by: s.manual_by, cel: Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' .ff-man')).map(x => x.title), conf: window.__confirms.length, open: (document.getElementById('labedit-overlay') || {}).style.display }; }, K);
  check('L1 guardar la corrección: K 4.43, entra a manual_keys, queda autor y «antes 44.3», la tabla marca ✎ y el editor se cierra sin preguntar',
    l1.k === '4.43' && (l1.mk || []).includes('k') && l1.by && l1.by.k && l1.by.k.u === 'Tester' && l1.by.k.antes === '44.3' && l1.cel.some(t => /Tester/.test(t) && /44.3/.test(t)) && l1.conf === 0 && l1.open === 'none', JSON.stringify(l1));
  sodio = '133.0'; scraped = NOW - 600e3;
  await page.evaluate((row) => handleWinlabChange({ eventType: 'INSERT', new: row }), wlRow());
  await page.waitForTimeout(3000);
  const l2 = await page.evaluate(async (k) => { await applyWinlabSyncToPatients({ verbose: false }); const s = noteData[k].labHistory.find(x => x.fecha === todayStr()); return { k: s.labs.k, na: s.labs.na }; }, K);
  check('L2 el siguiente sync del robot NO pisa la corrección (K sigue 4.43) y sí trae lo nuevo (Na 133)', l2.k === '4.43' && /^133/.test(l2.na), JSON.stringify(l2));
  await page.evaluate((k) => openLabEditor(k), K);
  await page.fill('.le-in[data-labkey="hb"]', '');
  await page.click('[data-testid="lab-editor-guardar"]');
  await page.waitForTimeout(300);
  scraped = NOW - 300e3;
  await page.evaluate((row) => handleWinlabChange({ eventType: 'INSERT', new: row }), wlRow());
  await page.waitForTimeout(3000);
  const l3 = await page.evaluate(async (k) => { await applyWinlabSyncToPatients({ verbose: false }); const s = noteData[k].labHistory.find(x => x.fecha === todayStr()); return { hb: s.labs.hb, antes: (s.manual_by.hb || {}).antes }; }, K);
  check('L3 un valor borrado a propósito (Hb) no regresa con el sync del robot; queda lo que decía', (l3.hb === undefined || l3.hb === '') && l3.antes === '7.70', JSON.stringify(l3));
  await page.evaluate((k) => openLabEditor(k), K);
  await page.fill('.le-in[data-labkey="na"]', '1330');
  await page.click('[data-testid="lab-editor-guardar"]');
  await page.waitForTimeout(300);
  const l4 = await page.evaluate((k) => ({ conf: window.__confirms.slice(-1)[0] || '', na: noteData[k].labHistory.find(x => x.fecha === todayStr()).labs.na }), K);
  check('L4 valor imposible (Na 1330): avisa del punto decimal antes de guardar', /punto decimal/.test(l4.conf) && /Na 1330/.test(l4.conf) && l4.na === '1330', JSON.stringify(l4));
  const l5 = await page.evaluate((k) => { const antes = noteData[k].labHistory.find(x => x.fecha === todayStr()).client_updated_at || 0; undoLast(k); const s = noteData[k].labHistory.find(x => x.fecha === todayStr()); return { na: s.labs.na, nueva: (s.client_updated_at || 0) > antes }; }, K);
  check('L5 ↩ Regresar deshace la última corrección (Na vuelve a 133) con hora nueva (la nube no la regresa)', /^133(\.0)?$/.test(l5.na) && l5.nueva, JSON.stringify(l5));
  const l6 = await page.evaluate((k) => { openLabEditor(k, '2020-01-05'); const t = document.querySelector('[data-testid="lab-editor"]').textContent; closeLabEditor(); return /fecha nueva/.test(t); }, K);
  check('L6 se puede capturar otra fecha (queda como captura manual)', l6, String(l6));

  // ── I: índice urinario ──
  const iu = await page.evaluate((k) => {
    const txt = () => { const el = document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="iu-res"]'); return el ? el.textContent + ' |' + el.className : 'SIN'; };
    const out = {};
    out.sinPeso = (updatePmField(k, 'pm_uresis', '600'), txt());
    updatePmField(k, 'pm_peso', '80'); out.u24 = txt();
    updatePmField(k, 'pm_uresis_h', '6'); out.u6 = txt();
    updatePmField(k, 'pm_uresis_h', ''); updatePmField(k, 'pm_uresis', '1.5 L'); out.litros = txt();
    updatePmField(k, 'pm_uresis', '1,200'); out.miles = txt();
    updatePmField(k, 'pm_uresis', '900/12 h'); out.texto = txt();
    updatePmField(k, 'pm_uresis', '600');
    const p = patients.find(x => pid(x) === k); const nd = getNote(k);
    out.nota = (_plneBuild(p, nd).match(/URESIS CUANTIFICADA.{0,80}/) || [''])[0];
    out.resumen = (entregaResumenTexto(p, nd).match(/Uresis[^\n·]*/) || [''])[0];
    return out;
  }, K);
  check('I1 sin peso avisa «falta el peso»; 600 mL ÷ 80 kg ÷ 24 h = 0.31 (oliguria, ámbar); en 6 h = 1.25 (verde)',
    /falta el peso/.test(iu.sinPeso) && /IU 0.31 mL\/kg\/h \(24 h\) \|iu-res iu-lo/.test(iu.u24) && /IU 1.25 mL\/kg\/h \|iu-res iu-ok/.test(iu.u6), JSON.stringify(iu));
  check('I2 «1.5 L» = 1500 mL (0.78); «1,200» = 1200 mL (0.63); «900/12 h» toma las 12 h (0.94)',
    /IU 0.78/.test(iu.litros) && /IU 0.63/.test(iu.miles) && /IU 0.94 mL\/kg\/h \|/.test(iu.texto), JSON.stringify(iu));
  check('I3 la nota y el resumen llevan el índice urinario calculado (no se escribe en ninguna caja)',
    /ÍNDICE URINARIO 0.31 ML\/KG\/H/.test(iu.nota) && /IU 0.31 mL\/kg\/h/.test(iu.resumen), JSON.stringify(iu));

  check('sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
