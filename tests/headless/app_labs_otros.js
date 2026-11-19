// 🧪 «Otros estudios» de WinLab (19 nov 2026): «no aparecen paneles virales, citológicos ni citoquímicos».
// · Líquidos (LCR, peritoneal…): citoquímico, citológico, examen físico, coaglutinación y Gram en su caja, y NUNCA en la
//   tabla de sangre (el recuento del LCR se pintaba como «Leu 0.850»).
// · Virología / serología / cualitativas (panel respiratorio, toxinas, VIH…) con los positivos en rojo.
// · Otros (HbA1c, hormonas, química de orina) y avisos del laboratorio (NO EJECUTADO, fuera del límite medible) que antes
//   salían como un número normal en la tabla.
// · Reportes que el robot no supo leer (reporte_texto): su texto tal cual.
// · Mismas reglas de identidad que labs y cultivos; solo memoria (nada se guarda en la nota); texto escapado.
// Pacientes ficticios.   node tests/headless/app_labs_otros.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
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
const d0 = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const ayer = new Date(d0.getTime() - 86400000), antier = new Date(d0.getTime() - 2 * 86400000);
const PTS = [
  { id: 'o1', cama: '3-301', exp: '26-91001', nombre: 'ANA LUCIA FICTICIA PRUEBA', esp: 'CG', edad: '50', sexo: 'F', estado: 'ESTABLE', dx: 'DX FICTICIO', ingreso: ymd(antier) },
  { id: 'o2', cama: '3-302', exp: '26-91002', nombre: 'BRUNO FICTICIO EJEMPLO', esp: 'CG', edad: '61', sexo: 'M', estado: 'ESTABLE', dx: 'DX FICTICIO', ingreso: ymd(antier) },
  { id: 'o3', cama: '3-303', exp: '26-91003', nombre: 'CARLA FICTICIA MUESTRA', esp: 'CG', edad: '40', sexo: 'F', estado: 'ESTABLE', dx: 'DX FICTICIO', ingreso: ymd(antier) },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 834, height: 1194 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (url.startsWith('/rest/v1/notes') && m !== 'GET') { posts.push(req.postData() || ''); return json(201, [{}]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3, null, { timeout: 30000 });
  await page.waitForTimeout(1500);

  const res = await page.evaluate(async ({ D, A, Dd, Ad, AAd }) => {
    const out = {};
    const hdr = (ap, nom, sx, fnac) => ({ '': '', 'CODIGO PACIENTE': '1', 'APELLIDOS COMPLETOS': ap, NOMBRE: nom, SEXO: sx, 'FECHA DE NAC.': fnac, __cells: ['', '', '1', ap, nom, sx, fnac], __hasLink: false });
    let n = 0;
    const rep = (toma, valores, extra) => { n++; const code = '26111900' + String(n).padStart(2, '0'); return Object.assign({ '': '', 'CODIGO PACIENTE': code, 'APELLIDOS COMPLETOS': toma, NOMBRE: toma, SEXO: 'CIRUGIA GENERAL', __cells: ['', '', code, toma, toma, 'CIRUGIA GENERAL'], __hasLink: true, __target: true }, valores ? { valores } : {}, extra || {}); };
    const row = (exp, paciente, reportes, fecha) => ({ exp, paciente, fecha: fecha || D, scraped_at: new Date(Date.now() - 3600e3).toISOString(), data: { headers: [], reportes } });
    const P = (id) => patients.find(p => p._supa_id === id || p.id === id);
    const BH = [{ estudio: 'LEUCOCITOS', valor: '9.10', unidad: '10³/μL', referencia: '4.00 - 10.00' }, { estudio: 'ERITROCITOS', valor: '4.20', unidad: '10^6/μL', referencia: '4.40 - 5.20' }, { estudio: 'HEMOGLOBINA', valor: '12.10', unidad: 'g/dL', referencia: '12.00 - 16.00' }, { estudio: 'HEMATOCRITO', valor: '37.0', unidad: '%', referencia: '' }, { estudio: 'PLAQUETAS', valor: '250', unidad: '10³/μL', referencia: '130 - 400' }, { estudio: 'RELACION A/G', valor: '0.74', unidad: '', referencia: '1.10 - 1.80' }];
    // LCR leído por el robot nuevo (con seccion y nombres completos)
    const LCR_NUEVO = [
      { estudio: 'Volumen', valor: '7', unidad: 'ml', referencia: '5.0 - 10.0', seccion: 'LIQUIDO CEFALORRAQUIDEO' },
      { estudio: 'ASPECTO', valor: 'TURBIO', unidad: '', referencia: 'Transparente (agua de', seccion: 'LIQUIDO CEFALORRAQUIDEO' },
      { estudio: 'Gram', valor: 'NO SE OBSERVAN BACTERIAS', unidad: '', referencia: '', seccion: 'LIQUIDO CEFALORRAQUIDEO · TINCION' },
      { estudio: 'NEGATIVO A', valor: '5', unidad: 'DIAS', referencia: '' },
      { estudio: 'GLUCOSA EN LIQUIDO CEFALORRAQUIDEO', valor: '73.0', unidad: 'mg/dL', referencia: '40.0 - 70.0' },
      { estudio: 'LEUCOCITOS', valor: '0.850', unidad: '10³/μL', referencia: '0.000 - 5.000', seccion: 'LIQUIDO CEFALORRAQUIDEO' },
      { estudio: 'POLIMORFONUCLEARES %', valor: '71.90', unidad: '%', referencia: 'Ausentes', seccion: 'LIQUIDO CEFALORRAQUIDEO' },
    ];
    // LCR leído por el robot VIEJO (nombre partido y recuento SIN seccion): antes «Leu 0.640» caía en la BH.
    const LCR_VIEJO = [
      { estudio: 'CEFALORRAQUIDEO', valor: '54', unidad: 'U/L', referencia: '0 - 200' },
      { estudio: 'CLORO EN LIQUIDO CEFALORRAQUIDEO', valor: '115', unidad: 'mmol/L', referencia: '120 - 130' },
      { estudio: 'LEUCOCITOS', valor: '0.640', unidad: '10³/μL', referencia: '0.000 - 5.000' },
      { estudio: 'ERITROCITOS', valor: '0.001', unidad: '10^6/μL', referencia: 'Ausentes' },
    ];
    const VIRAL = [
      { estudio: 'SARS-CoV-2', valor: 'NO DETECTADO', unidad: '', referencia: 'No detectado', seccion: 'PANEL RESPIRATORIO' },
      { estudio: 'Influenza B', valor: 'DETECTADO', unidad: '', referencia: 'No detectado', seccion: 'PANEL RESPIRATORIO' },
    ];
    const VARIOS = [
      { estudio: 'HEMOGLOBINA GLICADA', valor: '7.10', unidad: '%', referencia: '4.0 - 5.6' },
      { estudio: 'TOXINA A', valor: 'NEGATIVO', unidad: '', referencia: 'NEGATIVO' },
      { estudio: 'HEMATOCRITO NO EJECUTADO', valor: '36.00', unidad: '%', referencia: '' },
      { estudio: 'TIEMPO DE PROTROMBINA VALOR POR ENCIMA DEL LIMITE MEDIBLE', valor: '11.00', unidad: 'seg', referencia: '' },
      { estudio: 'CREATININA URINARIA', valor: '48.78', unidad: 'mg/dL', referencia: '' },
      { estudio: 'CREATININA', valor: '0.80', unidad: 'mg/dL', referencia: '0.6 - 1.1' },
      { estudio: 'ALFAFETOPROTEINA', valor: '<img src=x onerror="window.__xss=1">', unidad: 'ng/mL', referencia: '<b>x</b>' },
      { estudio: 'HORMONA <img src=x onerror="window.__xss3=1">', valor: '1.2', unidad: '<i>u</i>', referencia: '' },
      { estudio: 'ANTICUERPOS IGG CONTRA ANTIGENO NUCLEAR EXTRAIBLE RIBONUCLEOPROTEINA SM/RNP CUANTITATIVO POR QUIMIOLUMINISCENCIA', valor: '123456.78', unidad: 'U/mL', referencia: 'MENOR DE 20 U/mL NEGATIVO; 20 A 40 INDETERMINADO; MAYOR DE 40 POSITIVO' },
    ];
    const EGO = [{ estudio: 'DENSIDAD', valor: '1.015', unidad: '', referencia: '1.010 - 1.030' }, { estudio: 'PH', valor: '6.0', unidad: '', referencia: '5.0 - 6.5' }, { estudio: 'AGREGADOS LEUCOCITARIOS', valor: '7.92', unidad: 'p/μL', referencia: 'Ausentes' }];
    // Coaglutinación de un robot viejo (género COMPLETO, sin cultivo del PDF): nunca un cultivo positivo.
    const COAG_VIEJO = [{ estudio: 'STREPTOCOCCUS PNEUMONIAE', valor: 'NEGATIVO', unidad: '', referencia: 'NEGATIVO' }, { estudio: 'HAEMOPHILUS INFLUENZAE B', valor: 'NEGATIVO', unidad: '', referencia: 'NEGATIVO' }];
    const p1 = P('o1'), p2 = P('o2'), p3 = P('o3');
    const k1 = pid(p1), k2 = pid(p2), k3 = pid(p3);
    patients.forEach(p => { noteData[pid(p)] = defaultData(); });
    const rows = [
      row('26-91001', p1.nombre, [
        hdr('FICTICIA PRUEBA', 'ANA LUCIA', 'FEMENINO', '01/01/1976'),
        rep(Dd + ' 06:10', BH),
        rep(Dd + ' 09:30', LCR_NUEVO, { antigenos: [{ estudio: 'Streptococcus pneumoniae', valor: 'NEGATIVO', unidad: '', referencia: 'Negativo', seccion: 'LIQUIDO CEFALORRAQUIDEO · COAGLUTINACION' }], cultivo: { v: 3, tipo: 'Cultivo LCR', resultado: 'NEGATIVO', germenes: [], antibiograma: [], secciones: [{ nombre: '', tipo: 'Cultivo LCR', muestra: '', resultado: 'NEGATIVO', detalle: 'negativo a 5 días', germenes: [], antibiograma: [] }] }, cultivo_texto: 'LIQUIDO CEFALORRAQUIDEO\nCULTIVO DESARROLLO\nNEGATIVO A 5 DIAS' }),
        rep(Ad + ' 08:00', LCR_VIEJO),
        rep(Ad + ' 07:00', BH.map(v => Object.assign({}, v, v.estudio === 'LEUCOCITOS' ? { valor: '8.40' } : {}))),
        rep(Dd + ' 11:00', VIRAL),
        rep(Dd + ' 12:00', VARIOS),
        rep(Dd + ' 12:30', EGO),
        rep(Dd + ' 13:00', null, { reporte_texto: 'PANEL GASTROINTESTINAL\nRotavirus <script>window.__xss2=1</script> No detectado\nNorovirus GI/GII No detectado' }),
        rep(AAd + ' 08:00', COAG_VIEJO),
        // Otra persona con los mismos apellidos en la misma búsqueda: nada suyo entra
        hdr('FICTICIA PRUEBA', 'MARTA', 'FEMENINO', '02/02/1950'),
        rep(Dd + ' 10:00', [{ estudio: 'Influenza A', valor: 'DETECTADO', unidad: '', referencia: '', seccion: 'PANEL RESPIRATORIO' }, { estudio: 'GLUCOSA EN LIQUIDO PLEURAL', valor: '99', unidad: 'mg/dL', referencia: '' }]),
      ]),
      row('26-91002', p2.nombre, [hdr('FICTICIO EJEMPLO', 'BRUNO', 'MASCULINO', '03/03/1965'), rep(Dd + ' 06:00', BH)]),
    ];
    const latest = {}, all = {};
    rows.forEach(r => { latest[r.exp] = r; (all[r.exp] = all[r.exp] || []).push(r); });
    winlabByExp = latest; winlabRowsByExp = all; _winlabExpIndex = null;
    const st1 = await applyWinlabSyncToPatients({ verbose: false });
    const snap = (k, f) => ((noteData[k].labHistory || []).find(s => s.fecha === f) || { labs: {} }).labs;
    const o1 = (_winlabOtrosByK[k1] || []);
    out.st1otros = st1.otros || 0;
    out.labsHoy = snap(k1, D); out.labsAyer = snap(k1, A);
    out.items = o1.map(it => ({ f: it.fecha, g: it.grupo, s: it.sub, n: it.nombre, v: it.valor, u: it.unidad, pos: !!it.pos, av: !!it.aviso, crit: !!it.crit, inc: !!it.incompleto, tx: it.texto ? it.texto.length : 0, llave: it.llave || '' }));
    out.ordenOk = o1.every((it, i) => i === 0 || String(o1[i - 1].fecha) > String(it.fecha) || (o1[i - 1].fecha === it.fecha && o1[i - 1].ts >= it.ts));
    out.p2items = (_winlabOtrosByK[k2] || []).length;
    out.p3items = (_winlabOtrosByK[k3] || []).length;
    out.cult = (_winlabCultByK[k1] || []).map(c => ({ f: c.fecha, t: c.tipo, o: c.organismo, pos: !!c.positivo }));
    // 2ª pasada sin cambios: no sube nada ni cambia «otros»
    const postsAntes = window.__postsCount || 0;
    const st2 = await applyWinlabSyncToPatients({ verbose: false });
    out.st2otros = st2.otros || 0; out.st2saved = st2.saved || 0;
    // Nota: nada de «otros» viaja a la nota
    out.notaTieneOtros = JSON.stringify(noteData[k1]).indexOf('Influenza') >= 0 || JSON.stringify(noteData[k1]).indexOf('POLIMORFONUCLEARES') >= 0;
    return out;
  }, { D: ymd(d0), A: ymd(ayer), Dd: dmy(d0), Ad: dmy(ayer), AAd: dmy(antier) });

  const it = (pred) => res.items.filter(pred);
  const D = ymd(d0), A = ymd(ayer), AA = ymd(antier);
  // ── Tabla de sangre: el líquido ya no entra; la BH real se queda ──────────────────────────────────────────
  check('O1 BH real intacta (Leu 9.10, Hb 12.10) aunque el LCR sea más tarde ese día', res.labsHoy.leucos === '9.10' && res.labsHoy.hb === '12.10', JSON.stringify(res.labsHoy));
  check('O1b el recuento del LCR (0.850 nuevo / 0.640 viejo sin sección) nunca llena «Leu» de sangre', res.labsHoy.leucos !== '0.850' && res.labsAyer.leucos === '8.40', JSON.stringify(res.labsAyer));
  check('O1c HbA1c, NO EJECUTADO y creatinina urinaria no ensucian la tabla; TP fuera del límite medible = «> LÍMITE» (extremo), no 11.00', res.labsHoy.hct === '37.0' && res.labsHoy.tp === '> LÍMITE' && res.labsHoy.cr === '0.80', JSON.stringify(res.labsHoy));
  // ── Líquidos ──────────────────────────────────────────────────────────────────────────────────────────────
  const liq = it(x => x.g === 'liq');
  check('O2 LCR (robot nuevo): citoquímico, citológico, físico, coaglutinación y Gram en «Líquidos»',
    ['GLUCOSA EN LIQUIDO CEFALORRAQUIDEO', 'LEUCOCITOS', 'POLIMORFONUCLEARES %', 'Volumen', 'ASPECTO', 'Streptococcus pneumoniae', 'Gram'].every(n => liq.some(x => x.n === n && x.f === D && x.s === 'LCR')), JSON.stringify(liq));
  check('O2b LCR (robot viejo): CLORO, LEUCOCITOS 0.640 y el nombre partido marcado «incompleto»',
    liq.some(x => x.f === A && x.n === 'CLORO EN LIQUIDO CEFALORRAQUIDEO') && liq.some(x => x.f === A && x.n === 'LEUCOCITOS' && x.v === '0.640') && liq.some(x => x.f === A && x.n === 'CEFALORRAQUIDEO' && x.inc), JSON.stringify(liq.filter(x => x.f === A)));
  check('O2c el cultivo «NEGATIVO A 5 DIAS» no se repite en Líquidos (ya está en Cultivos)', !liq.some(x => /^NEGATIVO A$/.test(x.n)));
  // ── Virología / serología ────────────────────────────────────────────────────────────────────────────────
  const vir = it(x => x.g === 'viro');
  check('O3 Panel respiratorio: Influenza B DETECTADO en rojo, SARS-CoV-2 NO DETECTADO sin rojo',
    vir.some(x => x.n === 'Influenza B' && x.v === 'DETECTADO' && x.pos && x.s === 'Panel respiratorio') && vir.some(x => x.n === 'SARS-CoV-2' && !x.pos), JSON.stringify(vir));
  check('O3b Toxina A (C. difficile) en Virología/serología', vir.some(x => x.n === 'TOXINA A' && x.v === 'NEGATIVO' && !x.pos));
  check('O3c Reporte sin lectura (reporte_texto): su texto, en Virología por decir «PANEL»', vir.some(x => x.tx > 20 && /PANEL GASTROINTESTINAL/.test(x.n)));
  // ── Otros ─────────────────────────────────────────────────────────────────────────────────────────────────
  const otr = it(x => x.g === 'otros');
  check('O4 HbA1c y alfafetoproteína en «Otros»', otr.some(x => x.n === 'HEMOGLOBINA GLICADA' && x.v === '7.10') && otr.some(x => x.n === 'ALFAFETOPROTEINA'));
  check('O4b avisos: HEMATOCRITO «NO EJECUTADO» (no es resultado) y TP «por encima del límite medible» como CRÍTICO (extremo)',
    otr.some(x => x.n === 'HEMATOCRITO' && x.av && /NO EJECUTADO/.test(x.v)) && otr.some(x => x.n === 'TIEMPO DE PROTROMBINA' && x.crit && x.pos && /ENCIMA/.test(x.v)), JSON.stringify(otr));
  check('O4c creatinina URINARIA en Otros (no en la creatinina sérica)', otr.some(x => x.n === 'CREATININA URINARIA' && x.v === '48.78'));
  check('O5 sin ruido: ni ERITROCITOS de la BH, ni RELACION A/G, ni sedimento del EGO, ni lo que ya está en la tabla',
    !res.items.some(x => (x.g !== 'liq' && x.n === 'ERITROCITOS') || /RELACION A\/G|AGREGADOS|^DENSIDAD$|^PH$|^HEMOGLOBINA$|^CREATININA$/.test(x.n)), JSON.stringify(res.items.map(x => x.n)));
  // ── Identidad ─────────────────────────────────────────────────────────────────────────────────────────────
  check('O6 nada de la otra persona con los mismos apellidos (Influenza A, glucosa pleural)', !res.items.some(x => x.n === 'Influenza A' || /PLEURAL/.test(x.n)));
  check('O6b otros pacientes: el de solo BH no tiene «Otros»; el sin fila tampoco', res.p2items === 0 && res.p3items === 0, res.p2items + '/' + res.p3items);
  // ── Cultivos ──────────────────────────────────────────────────────────────────────────────────────────────
  check('O7 coaglutinación vieja (género completo, NEGATIVO) NO es cultivo positivo; el LCR negativo sí aparece negativo',
    !res.cult.some(c => c.pos) && res.cult.some(c => c.t === 'Cultivo LCR' && !c.pos), JSON.stringify(res.cult));
  // ── Memoria / base ────────────────────────────────────────────────────────────────────────────────────────
  check('O8 primera pasada marca cambio en «otros» (repinta); la 2ª no cambia ni sube nada', res.st1otros > 0 && res.st2otros === 0 && res.st2saved === 0, JSON.stringify([res.st1otros, res.st2otros, res.st2saved]));
  check('O8b nada de «Otros estudios» se guarda en la nota', !res.notaTieneOtros);

  // ── Tarjeta ───────────────────────────────────────────────────────────────────────────────────────────────
  const K = await page.evaluate(() => { const p = patients.find(x => x.cama === '3-301'); focusGoTo(pid(p)); return pid(p); });
  await page.waitForTimeout(700);
  const card = await page.evaluate((k) => {
    const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const sec = document.getElementById('sec-wlotros-' + ek);
    const labs = document.getElementById('sec-labs-' + ek);
    return {
      existe: !!sec, open: !!(sec && sec.open), dentroDeLabs: !!(labs && sec && labs.contains(sec)),
      badge: sec ? (sec.querySelector('.fcs-badge') || {}).textContent : '',
      grupos: sec ? Array.from(sec.querySelectorAll('.wlo-grupo .wlo-gt')).map(x => x.textContent) : [],
      rojo: sec ? Array.from(sec.querySelectorAll('.wlo-row.wlo-pos .wlo-n')).map(x => x.textContent) : [],
      ambar: sec ? Array.from(sec.querySelectorAll('.wlo-row.wlo-alt .wlo-n')).map(x => x.textContent) : [],
      xss: !!(window.__xss || window.__xss2 || window.__xss3), imgs: sec ? sec.querySelectorAll('img').length : -1, scripts: sec ? sec.querySelectorAll('script').length : -1,
      textoXss: sec ? /<img src=x/.test(sec.textContent) && /<script>/.test(sec.textContent) && /HORMONA <img/.test(sec.textContent) && /<i>u<\/i>/.test(sec.textContent) : false,
      fechas: sec ? Array.from(sec.querySelectorAll('.wlo-dia')).map(x => x.dataset.fecha) : [],
      sx: document.documentElement.scrollWidth > innerWidth + 1,
      wide: sec ? Array.from(sec.querySelectorAll('.wlo-row, .wlo-grupo, .wlo-n, .wlo-v, .wlo-ref')).filter(x => x.getBoundingClientRect().right > innerWidth + 1 || x.scrollWidth > x.clientWidth + 1).length : -1,
    };
  }, K);
  check('O9 la caja «🧪 Otros estudios» está en la tarjeta, dentro de Labs y abierta (hay resultados recientes)', card.existe && card.open && card.dentroDeLabs, JSON.stringify(card));
  check('O9b insignias rojas «1 positivo» y «1 fuera de límite» y los 3 grupos', /1 positivo/.test(card.badge) && /1 fuera de límite/.test(card.badge) && card.grupos.length >= 3, JSON.stringify([card.badge, card.grupos]));
  check('O9c positivo en rojo (Influenza B) y fuera de rango en ámbar (glucosa del LCR 73 > 70)', card.rojo.includes('Influenza B') && card.ambar.includes('GLUCOSA EN LIQUIDO CEFALORRAQUIDEO'), JSON.stringify([card.rojo, card.ambar]));
  check('O9d texto del robot escapado (sin <img>/<script> ejecutados)', !card.xss && card.imgs === 0 && card.scripts === 0 && card.textoXss, JSON.stringify(card));
  check('O9e fechas de la más nueva a la más vieja (pantalla y memoria; dentro del día, la toma más nueva primero)', card.fechas.join(',') === [D, A, AA].join(',') && res.ordenOk, card.fechas.join(',') + ' orden=' + res.ordenOk);
  check('O10 iPad vertical (834): nada se sale de la pantalla', !card.sx && card.wide === 0, JSON.stringify(card));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const ph = await page.evaluate((k) => { const ek = k.replace(/[^a-zA-Z0-9]/g, '_'); const sec = document.getElementById('sec-wlotros-' + ek); return { sx: document.documentElement.scrollWidth > innerWidth + 1, wide: sec ? Array.from(sec.querySelectorAll('.wlo-row, .wlo-grupo, .wlo-n, .wlo-v, .wlo-ref')).filter(x => x.getBoundingClientRect().right > innerWidth + 1 || x.scrollWidth > x.clientWidth + 1).length : -1 }; }, K);
  check('O10b teléfono (390): nada se sale de la pantalla', !ph.sx && ph.wide === 0, JSON.stringify(ph));
  await page.setViewportSize({ width: 834, height: 1194 });
  // Hoja: abierta, 2 fechas más nuevas y el texto del reporte abierto
  const hoja = await page.evaluate(async (k) => {
    try { exitFocus && exitFocus(); } catch (_) {}
    if (typeof toggleHojaMode === 'function') toggleHojaMode(); else if (typeof setHojaMode === 'function') setHojaMode(true);
    await new Promise(r => setTimeout(r, 600));
    const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const sec = document.getElementById('sec-wlotros-' + ek);
    const r = { hoja: typeof isHojaMode === 'function' && isHojaMode(), open: !!(sec && sec.open), fechas: sec ? sec.querySelectorAll('.wlo-dia').length : -1, txtOpen: sec ? Array.from(sec.querySelectorAll('details.wlo-txt')).every(d => d.open) : false };
    if (typeof toggleHojaMode === 'function') toggleHojaMode(); else if (typeof setHojaMode === 'function') setHojaMode(false);
    return r;
  }, K);
  check('O11 Hoja: la caja abierta, solo las 2 fechas más nuevas y el texto del reporte visible', hoja.hoja && hoja.open && hoja.fechas === 2 && hoja.txtOpen, JSON.stringify(hoja));
  // ── Revisión adversarial (19 nov): casos que fallaban ────────────────────────────────────────────────────────
  const rv = await page.evaluate(async ({ D, A, Dd, Ad }) => {
    const out = {};
    const hdr = (ap, nom, sx, fnac) => ({ '': '', 'CODIGO PACIENTE': '1', 'APELLIDOS COMPLETOS': ap, NOMBRE: nom, SEXO: sx, 'FECHA DE NAC.': fnac, __cells: ['', '', '1', ap, nom, sx, fnac], __hasLink: false });
    const rep = (code, toma, valores, extra) => Object.assign({ '': '', __cells: ['', '', code, toma, toma, 'CIRUGIA GENERAL'], __hasLink: true, __target: true }, valores ? { valores } : {}, extra || {});
    const row = (exp, paciente, reportes, fecha, scr) => ({ exp, paciente, fecha, scraped_at: scr, data: { headers: [], reportes } });
    const p3 = patients.find(p => p.cama === '3-303'), k3 = pid(p3);
    const H3 = hdr('FICTICIA MUESTRA', 'CARLA', 'FEMENINO', '01/01/1986');
    const OTRA = hdr('FICTICIA MUESTRA', 'ROSA', 'FEMENINO', '02/02/1950');
    const viejo = row('26-91003', p3.nombre, [
      H3,
      rep('R1', Ad + ' 06:00', null, { reporte_texto: 'PANEL RESPIRATORIO\nInfluenza A EN PROCESO' }),   // ayer en proceso; hoy final
      OTRA, rep('R9', Ad + ' 07:00', [{ estudio: 'VIH', valor: 'REACTIVO', unidad: '', referencia: '' }]),
    ], A, new Date(Date.now() - 30 * 3600e3).toISOString());
    const nuevo = row('26-91003', p3.nombre, [
      H3,
      rep('R1', Ad + ' 06:00', [{ estudio: 'Influenza A', valor: 'NO DETECTADO', unidad: '', referencia: '', seccion: 'PANEL RESPIRATORIO' }]),
      // Química del día + amilasa del drenaje en la MISMA orden
      rep('R2', Dd + ' 06:00', [{ estudio: 'CREATININA', valor: '0.90', unidad: 'mg/dL', referencia: '0.6 - 1.1' }, { estudio: 'POTASIO', valor: '3.1', unidad: 'mmol/L', referencia: '3.5 - 5.1' }, { estudio: 'AMILASA', valor: '80', unidad: 'U/L', referencia: '28 - 100' }, { estudio: 'AMILASA EN LIQUIDO DE DRENAJE', valor: '4500', unidad: 'U/L', referencia: '' }]),
      // Recuento de LCR seguido de una BH en el mismo reporte (robot nuevo: la sección solo en el líquido)
      rep('R3', Dd + ' 07:00', [{ estudio: 'LEUCOCITOS', valor: '0.030', unidad: '10³/μL', referencia: '0.000 - 5.000', seccion: 'LIQUIDO CEFALORRAQUIDEO' }, { estudio: 'LEUCOCITOS', valor: '20.97', unidad: '10³/μL', referencia: '4.00 - 10.00' }, { estudio: 'HEMOGLOBINA', valor: '11.0', unidad: 'g/dL', referencia: '12 - 16' }]),
      // LCR con cultivo POSITIVO y el citoquímico después
      rep('R4', Dd + ' 08:00', [{ estudio: 'Gram', valor: 'SE OBSERVAN COCOS GRAM POSITIVOS EN CADENAS', unidad: '', referencia: '', seccion: 'LIQUIDO CEFALORRAQUIDEO · TINCION' }, { estudio: 'CULTIVO', valor: 'POSITIVO', unidad: '', referencia: 'SIN DESARROLLO' }, { estudio: 'GLUCOSA EN LIQUIDO CEFALORRAQUIDEO', valor: '12.0', unidad: 'mg/dL', referencia: '40.0 - 70.0' }, { estudio: 'COLOR', valor: 'AMARILLO', unidad: '', referencia: 'Incoloro', seccion: 'LIQUIDO CEFALORRAQUIDEO' }]),
      // Perfil prequirúrgico con EGO y luego serologías; grupo y Rh; comentario del laboratorio en vez del número
      rep('R5', Dd + ' 09:00', [{ estudio: 'GRUPO SANGUINEO', valor: 'O', unidad: '', referencia: '' }, { estudio: 'FACTOR RH', valor: 'POSITIVO', unidad: '', referencia: '' }, { estudio: 'SODIO', valor: '139', unidad: 'mmol/L', referencia: '' }, { estudio: 'POTASIO', valor: 'MUESTRA HEMOLIZADA, FAVOR DE REPETIR', unidad: '', referencia: '' }, { estudio: 'DENSIDAD', valor: '1.015', unidad: '', referencia: '' }, { estudio: 'PH', valor: '6.0', unidad: '', referencia: '' }, { estudio: 'VDRL', valor: 'REACTIVO', unidad: '', referencia: '' }]),
      // Recuento de un líquido leído por el robot VIEJO sin ninguna palabra de líquido (toma más nueva que la BH de R3)
      rep('R8', Dd + ' 12:00', [{ estudio: 'LEUCOCITOS', valor: '0.640', unidad: '10³/μL', referencia: '0.000 - 5.000' }, { estudio: 'ERITROCITOS', valor: '0.001', unidad: '10^6/μL', referencia: 'Ausentes' }]),
      // Hemocultivo con identificación rápida «DETECTADO» (formato viejo, sin sección): SÍ es cultivo positivo
      rep('R10', Dd + ' 12:30', [{ estudio: 'HEMOCULTIVO PERIFERICO', valor: 'POSITIVO', unidad: '', referencia: '' }, { estudio: 'Staphylococcus aureus', valor: 'DETECTADO', unidad: '', referencia: '' }]),
      // Glucosa SÉRICA tomada junto con el LCR (robot nuevo: la sección solo en el líquido) → la sérica a la tabla
      rep('R11', Dd + ' 13:00', [{ estudio: 'LEUCOCITOS', valor: '0.050', unidad: '10³/μL', referencia: '0.000 - 5.000', seccion: 'LIQUIDO CEFALORRAQUIDEO' }, { estudio: 'GLUCOSA EN LIQUIDO CEFALORRAQUIDEO', valor: '60.0', unidad: 'mg/dL', referencia: '40.0 - 70.0' }, { estudio: 'GLUCOSA', valor: '98.0', unidad: 'mg/dL', referencia: '74.0 - 106.0' }]),
      // Formato viejo (sin sección): amilasa y lipasa séricas con la amilasa del drenaje → las séricas a la tabla
      rep('R12', Dd + ' 13:30', [{ estudio: 'LIPASA', valor: '40', unidad: 'U/L', referencia: '13 - 60' }, { estudio: 'AMILASA EN LIQUIDO DE DRENAJE', valor: '5200', unidad: 'U/L', referencia: '' }]),
      // Formato viejo: creatinina sérica en la misma orden que la albúmina del líquido peritoneal → la sérica a la tabla
      rep('R13', Dd + ' 14:00', [{ estudio: 'BILIRRUBINA TOTAL', valor: '1.10', unidad: 'mg/dL', referencia: '0.2 - 1.2' }, { estudio: 'ALBUMINA EN LIQUIDO PERITONEAL', valor: '1.0', unidad: 'g/dL', referencia: '' }]),
      // Valor basura guardado por un lector que partió la referencia («NO» = «DETECTADO»): nunca un positivo
      rep('R14', Dd + ' 14:30', [{ estudio: 'NO', valor: 'DETECTADO', unidad: '', referencia: '', seccion: 'PANEL RESPIRATORIO' }]),
      // Panel de hemocultivo solo con antígenos (sin valores)
      rep('R6', Dd + ' 10:00', null, { antigenos: [{ estudio: 'Staphylococcus', valor: 'DETECTADO', unidad: '', referencia: '', seccion: 'PANEL DE IDENTIFICACION EN HEMOCULTIVO P' }, { estudio: 'Streptococcus', valor: 'NO DETECTADO', unidad: '', referencia: '', seccion: 'PANEL DE IDENTIFICACION EN HEMOCULTIVO P' }] }),
    ], D, new Date(Date.now() - 3600e3).toISOString());
    // Un EGO capturado a mano el mismo día con COLOR AMARILLO (no debe dar aviso de «también en la tabla de sangre»)
    noteData[k3] = defaultData(); noteData[k3].labHistory = [{ fecha: D, labs: { ego_color: 'AMARILLO' }, extra: [], source: 'manual' }];
    winlabByExp = Object.assign({}, winlabByExp, { '26-91003': nuevo }); winlabRowsByExp = Object.assign({}, winlabRowsByExp, { '26-91003': [viejo, nuevo] }); _winlabExpIndex = null;
    await applyWinlabSyncToPatients({ verbose: false, only: [p3] });
    const it = (_winlabOtrosByK[k3] || []);
    const snap = (f) => ((noteData[k3].labHistory || []).find(s => s.fecha === f) || { labs: {} }).labs;
    out.labs = snap(D);
    out.cult3 = (_winlabCultByK[k3] || []).map(c => ({ t: c.tipo, o: c.organismo, pos: !!c.positivo }));
    out.items = it.map(x => ({ n: x.nombre, v: x.valor, g: x.grupo, s: x.sub, pos: !!x.pos, av: !!x.aviso, llave: x.llave, f: x.fecha }));
    // Card render for warnings
    const html = renderWinlabOtrosSection(p3, noteData[k3], k3);
    out.warnColor = /también aparece en la tabla de sangre/.test(html);
    // Cambio de identidad: con «nombre en WinLab» de la otra persona aparecen sus estudios; al quitarlo y soltar la fila vieja, se van.
    noteData[k3].checklist = Object.assign({}, noteData[k3].checklist || {}, { winlab_alias: 'FICTICIA MUESTRA, ROSA' });
    await applyWinlabSyncToPatients({ verbose: false, only: [p3] });
    out.conAliasOtra = (_winlabOtrosByK[k3] || []).some(x => x.nombre === 'VIH');
    winlabRowsByExp = Object.assign({}, winlabRowsByExp, { '26-91003': [nuevo] }); _winlabExpIndex = null;   // el respaldo suelta la fila vieja
    delete noteData[k3].checklist.winlab_alias;
    await applyWinlabSyncToPatients({ verbose: false, only: [p3] });
    out.sinAliasOtra = (_winlabOtrosByK[k3] || []).some(x => x.nombre === 'VIH');
    // Misma identidad: lo de una fila que ya salió de memoria se conserva aunque las filas nuevas no traigan «otros»
    const soloBH = row('26-91003', p3.nombre, [H3, rep('R7', Dd + ' 11:00', [{ estudio: 'HEMOGLOBINA', valor: '11.5', unidad: 'g/dL', referencia: '' }])], D, new Date().toISOString());
    winlabByExp = Object.assign({}, winlabByExp, { '26-91003': soloBH }); winlabRowsByExp = Object.assign({}, winlabRowsByExp, { '26-91003': [nuevo, soloBH] }); _winlabExpIndex = null;
    await applyWinlabSyncToPatients({ verbose: false, only: [p3] });
    const antes = (_winlabOtrosByK[k3] || []).length;
    winlabRowsByExp = Object.assign({}, winlabRowsByExp, { '26-91003': [soloBH] }); _winlabExpIndex = null;
    await applyWinlabSyncToPatients({ verbose: false, only: [p3] });
    out.respaldo = { antes, despues: (_winlabOtrosByK[k3] || []).length };
    return out;
  }, { D: ymd(d0), A: ymd(ayer), Dd: dmy(d0), Ad: dmy(ayer) });
  const ri = (pred) => rv.items.filter(pred);
  check('R-O14 química + amilasa del drenaje en la misma orden: Cr, K y amilasa SÉRICAS siguen en la tabla; solo la del drenaje va a Líquidos',
    rv.labs.cr === '0.90' && rv.labs.k === '3.1' && rv.labs.amilasa === '80' && ri(x => x.g === 'liq').some(x => x.n === 'AMILASA EN LIQUIDO DE DRENAJE' && x.s === 'Líquido de drenaje') && !ri(x => x.g === 'liq').some(x => /^(CREATININA|POTASIO|AMILASA)$/.test(x.n)), JSON.stringify(rv.labs));
  check('R-O15 recuento de LCR + BH en el mismo reporte (robot nuevo): Leu 20.97 y Hb 11.0 de sangre en la tabla; 0.030 en Líquidos', rv.labs.leucos === '20.97' && rv.labs.hb === '11.0' && ri(x => x.g === 'liq' && x.n === 'LEUCOCITOS' && x.v === '0.030').length === 1, JSON.stringify(rv.labs));
  check('R-O15b recuento de líquido del robot viejo SIN palabra de líquido (ref. 0.000 - 5.000, eritrocitos «Ausentes»): no pisa la BH; sale en Líquidos', rv.labs.leucos === '20.97' && ri(x => x.g === 'liq' && x.n === 'LEUCOCITOS' && x.v === '0.640').length === 1, JSON.stringify(rv.labs));
  check('R-O15d glucosa sérica tomada con el LCR (robot nuevo): 98 a la tabla; la del LCR (60) en Líquidos', rv.labs.glu === '98.0' && ri(x => x.g === 'liq' && x.n === 'GLUCOSA EN LIQUIDO CEFALORRAQUIDEO' && x.v === '60.0').length === 1, JSON.stringify(rv.labs));
  check('R-O15e formato viejo: lipasa sérica con la amilasa del drenaje (líquido que no es de cavidad) → lipasa a la tabla', rv.labs.lipasa === '40' && ri(x => x.n === 'AMILASA EN LIQUIDO DE DRENAJE' && x.v === '5200').length === 1, JSON.stringify(rv.labs));
  check('R-O15f formato viejo: bilirrubina sérica con la albúmina del líquido peritoneal → bilirrubina a la tabla', rv.labs.bt === '1.10' && ri(x => x.n === 'ALBUMINA EN LIQUIDO PERITONEAL').length === 1, JSON.stringify(rv.labs));
  check('R-O15g un «NO» = «DETECTADO» suelto (referencia partida) nunca sale ni cuenta como positivo', !ri(x => /^NO$/i.test(x.n)).length);
  check('R-O15c hemocultivo con «Staphylococcus aureus DETECTADO» (identificación rápida, sin sección) sigue siendo cultivo POSITIVO', rv.cult3.some(c => c.pos && /Staphylococcus aureus/.test(c.o)), JSON.stringify(rv.cult3));
  check('R-O16 LCR con cultivo POSITIVO: el citoquímico de después (glucosa 12) sí sale; Gram con cocos en rojo', ri(x => x.g === 'liq' && x.n === 'GLUCOSA EN LIQUIDO CEFALORRAQUIDEO' && x.v === '12.0').length === 1 && ri(x => x.n === 'Gram' && x.pos).length === 1);
  check('R-O17 grupo y Rh en «Otros» sin rojo (Rh POSITIVO es normal)', ri(x => x.n === 'FACTOR RH' && x.g === 'otros' && !x.pos).length === 1 && ri(x => x.n === 'GRUPO SANGUINEO').length === 1);
  check('R-O18 comentario del laboratorio en lugar del K («MUESTRA HEMOLIZADA») sale como aviso en «Otros»', ri(x => x.n === 'POTASIO' && x.av && /HEMOLIZADA/.test(x.v)).length === 1 && rv.labs.na === '139');
  check('R-O19 VDRL REACTIVO después del EGO en el mismo reporte: en Virología, en rojo', ri(x => x.n === 'VDRL' && x.g === 'viro' && x.pos).length === 1, JSON.stringify(ri(x => /VDRL/.test(x.n))));
  check('R-O20 un reporte en la fila de ayer («en proceso») y en la de hoy (final): solo el de hoy', ri(x => x.n === 'Influenza A' && x.v === 'NO DETECTADO').length === 1 && !ri(x => /EN PROCESO/.test(x.n + ' ' + x.v) || /PANEL RESPIRATORIO$/.test(x.n)).length, JSON.stringify(ri(x => /Influenza|PANEL/.test(x.n))));
  check('R-O21 panel de hemocultivo con solo antígenos: Staphylococcus DETECTADO en rojo y Streptococcus NO DETECTADO, con nombre completo', ri(x => x.n === 'Staphylococcus' && x.pos && x.g === 'viro').length === 1 && ri(x => x.n === 'Streptococcus' && !x.pos).length === 1);
  check('R-O22 COLOR del líquido igual al del EGO: sin aviso falso de «también en la tabla de sangre»', !rv.warnColor && ri(x => x.n === 'COLOR' && x.llave === '').length === 1);
  check('R-O23 alias de otra persona y luego quitado: sus estudios (VIH) no se quedan pegados', rv.conAliasOtra === true && rv.sinAliasOtra === false, JSON.stringify([rv.conAliasOtra, rv.sinAliasOtra]));
  check('R-O24 misma identidad: lo de una fila que el respaldo ya soltó se conserva aunque las filas nuevas no traigan «otros»', rv.respaldo.antes > 0 && rv.respaldo.despues === rv.respaldo.antes, JSON.stringify(rv.respaldo));

  // ── Al abrir la app: la caja aparece sola aunque el paciente solo tenga un líquido (sin labs de sangre nuevos) ──
  {
    const page2 = await browser.newPage({ viewport: { width: 834, height: 1194 } });
    page2.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
    const scr = new Date(Date.now() - 3600e3).toISOString();
    const wl = [{ exp: '26-91001', paciente: 'ANA LUCIA FICTICIA PRUEBA', fecha: ymd(d0), scraped_at: scr, data: { headers: [], reportes: [
      { '': '', 'CODIGO PACIENTE': '1', 'APELLIDOS COMPLETOS': 'FICTICIA PRUEBA', NOMBRE: 'ANA LUCIA', SEXO: 'FEMENINO', 'FECHA DE NAC.': '01/01/1976', __cells: ['', '', '1', 'FICTICIA PRUEBA', 'ANA LUCIA', 'FEMENINO', '01/01/1976'], __hasLink: false },
      { '': '', 'CODIGO PACIENTE': '2611190999', __cells: ['', '', '2611190999', dmy(d0) + ' 07:00', dmy(d0) + ' 09:00', 'CIRUGIA GENERAL'], __hasLink: true, __target: true,
        valores: [{ estudio: 'GLUCOSA EN LIQUIDO PERITONEAL', valor: '40.0', unidad: 'mg/dL', referencia: '' }, { estudio: 'LEUCOCITOS', valor: '1.900', unidad: '10³/μL', referencia: '0.000 - 5.000', seccion: 'LIQUIDO PERITONEAL' }, { estudio: 'POLIMORFONUCLEARES %', valor: '80.0', unidad: '%', referencia: 'Ausentes', seccion: 'LIQUIDO PERITONEAL' }] },
    ] } }];
    await page2.route('**/vendor/supabase*', r => r.abort());
    await page2.route('**/rest/v1/**', async (route) => {
      const url = route.request().url().replace(/^https?:\/\/[^/]+/, ''); const m = route.request().method();
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
      if (url.startsWith('/rest/v1/winlab_labs') && m === 'GET') return json(200, wl);
      if (url.startsWith('/rest/v1/notes') && m !== 'GET') return json(201, [{}]);
      return json(200, []);
    });
    await page2.addInitScript(MOCK);
    await page2.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
    await page2.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 3, null, { timeout: 30000 });
    // Sin ningún repintado a mano: la pasada inicial del sync debe repintar sola si cambió «Otros estudios» (el tablero
    // muestra la primera cama, 3-301).
    const ok = await page2.waitForFunction(() => { const p = patients.find(x => x.cama === '3-301'); const k = pid(p); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
      return (_winlabOtrosByK[k] || []).length > 0 && !!document.getElementById('sec-wlotros-' + ek); }, null, { timeout: 6000 }).then(() => true, () => false);
    const st = await page2.evaluate(() => { const p = patients.find(x => x.cama === '3-301'); const k = pid(p); return { n: (_winlabOtrosByK[k] || []).length, leu: ((noteData[k] && noteData[k].labHistory) || []).map(s => s.labs && s.labs.leucos).filter(Boolean) }; });
    check('O13 al abrir la app, un paciente con solo un líquido ya muestra «Otros estudios» (repintado de la pasada inicial) y su recuento no entra a la tabla', ok && st.n === 3 && st.leu.length === 0, JSON.stringify({ ok, st }));
    await page2.close();
  }
  check('O12 sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
