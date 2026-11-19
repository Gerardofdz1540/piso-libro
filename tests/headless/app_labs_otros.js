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
      { estudio: 'S. pneumoniae', valor: 'NEGATIVO', unidad: '', referencia: 'Negativo', seccion: 'LIQUIDO CEFALORRAQUIDEO · COAGLUTINACION' },
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
        rep(Dd + ' 09:30', LCR_NUEVO, { cultivo: { v: 3, tipo: 'Cultivo LCR', resultado: 'NEGATIVO', germenes: [], antibiograma: [], secciones: [{ nombre: '', tipo: 'Cultivo LCR', muestra: '', resultado: 'NEGATIVO', detalle: 'negativo a 5 días', germenes: [], antibiograma: [] }] }, cultivo_texto: 'LIQUIDO CEFALORRAQUIDEO\nCULTIVO DESARROLLO\nNEGATIVO A 5 DIAS' }),
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
    out.items = o1.map(it => ({ f: it.fecha, g: it.grupo, s: it.sub, n: it.nombre, v: it.valor, u: it.unidad, pos: !!it.pos, av: !!it.aviso, inc: !!it.incompleto, tx: it.texto ? it.texto.length : 0, llave: it.llave || '' }));
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
  check('O1c HbA1c, NO EJECUTADO, TP fuera de límite y creatinina urinaria no ensucian la tabla', res.labsHoy.hct === '37.0' && !('tp' in res.labsHoy) && res.labsHoy.cr === '0.80', JSON.stringify(res.labsHoy));
  // ── Líquidos ──────────────────────────────────────────────────────────────────────────────────────────────
  const liq = it(x => x.g === 'liq');
  check('O2 LCR (robot nuevo): citoquímico, citológico, físico, coaglutinación y Gram en «Líquidos»',
    ['GLUCOSA EN LIQUIDO CEFALORRAQUIDEO', 'LEUCOCITOS', 'POLIMORFONUCLEARES %', 'Volumen', 'ASPECTO', 'S. pneumoniae', 'Gram'].every(n => liq.some(x => x.n === n && x.f === D && x.s === 'LCR')), JSON.stringify(liq));
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
  check('O4b avisos del laboratorio: HEMATOCRITO «NO EJECUTADO» y TP «por encima del límite medible», sin número',
    otr.some(x => x.n === 'HEMATOCRITO' && x.av && /NO EJECUTADO/.test(x.v)) && otr.some(x => x.n === 'TIEMPO DE PROTROMBINA' && x.av && /ENCIMA/.test(x.v)), JSON.stringify(otr));
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
  check('O9b insignia roja «1 positivo» y los 3 grupos', /1 positivo/.test(card.badge) && card.grupos.length >= 3, JSON.stringify([card.badge, card.grupos]));
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
