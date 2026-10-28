// 💡 Sugerencias clínicas de MANEJO (28 oct 2026, pedido de Gera). Ya no hay «Agregar al dx: Leucocitosis severa»:
// solo lo que cambia el manejo cruzando labs + indicaciones del Doc + tarjeta + cultivos. Casos ficticios:
// · antibiograma contra el antibiótico en uso (resistente, BLEE, Enterococcus, SAMS con vancomicina, desescalar,
//   Candida en orina, contaminante, cultivo sin tratamiento);
// · transfusión por Hb/edad/cardiopatía/sangrado (con negación «sin sangrado»), caída de Hb, plaquetas con heparina, TIH;
// · electrolitos con su contexto (Mg, furosemida, KCl + IECA, Na corregido por glucosa, déficit de agua, realimentación,
//   brecha aniónica, Ca corregido);
// · insulina (solo esquema, basal insuficiente, hipoglucemia con sulfonilurea, ayuno con prandial, metformina, iSGLT2);
// · interacciones y duplicados (AINE + enoxaparina, dos IBP, QT con K bajo, carbapenémico + valproato, doble anaerobio,
//   nalbufina + morfina, «SUSPENDER», tramadol + sertralina, paracetamol repetido);
// · riñón (LRA con nefrotóxicos, ClCr y ajuste, oliguria por índice urinario, ERC no cuenta) y otras (PCR en el POP,
//   ayuno prolongado, profilaxis de TVP);
// · la tarjeta: sin «Aplicar al dx», «Por qué», ➕ A pendientes (solo al tocar, sin duplicar, se regresa) e Ignorar.
// node tests/headless/app_cds.js   (ver run_all.sh)
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
const PTS = [
  { id: 'd1', cama: '3-301', exp: '26-81001', nombre: 'JUAN PEREZ SOTO', esp: 'CG', edad: '50', sexo: 'M', dx: 'APENDICITIS AGUDA' },
  { id: 'd2', cama: '3-302', exp: '26-81002', nombre: 'MARIA LOPEZ RUIZ', esp: 'CG', edad: '72', sexo: 'F', dx: 'COLECISTITIS AGUDA' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (url.startsWith('/rest/v1/notes') && m === 'POST') return json(201, [{}]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 900) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1000);

  // Ayudante en la página: arma una nota de prueba (fechas relativas a hoy), indicaciones del Doc y cultivos; evalúa.
  await page.evaluate(() => {
    const iso = (d) => { const t = new Date(); t.setDate(t.getDate() - d); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    window.__iso = iso;
    window.__esc = function (o) {
      const i = o.pi || 0; const p = Object.assign({}, patients[i], o.p || {}); const k = pid(patients[i]);
      const nd = defaultData();
      nd.dx = o.dx != null ? o.dx : p.dx; nd.app = o.app || ''; nd.pa = o.pa || ''; nd.pendientes = o.pend || ''; nd.manejo = o.manejo || '';
      nd.labHistory = (o.labs || []).map(function (x) { return { fecha: iso(x[0]), labs: x[1], extra: [] }; });
      Object.assign(nd.checklist, o.ck || {});
      if (o.ind) localStorage.setItem('pl_ind_v23_blocks', JSON.stringify([Object.assign({ cama: p.cama.replace(/^\d-/, ''), nombre: p.nombre, fecha: iso(0), DIETA: [], SOLUCIONES: [], MEDICAMENTOS: [], 'ANTIBIÓTICOS': [], 'MEDIDAS GENERALES': [] }, o.ind)]));
      else localStorage.removeItem('pl_ind_v23_blocks');
      _winlabCultByK[k] = (o.cult || []).map(function (c) { return Object.assign({ fecha: iso(c.d || 0), positivo: true, pendiente: false, muestra: '', germenes: [], sensibles: [], intermedios: [], resistentes: [] }, c); });
      const out = PLCDS.sortBySeverity(PLCDS.evaluate(p, nd));
      if (o.guardar) { noteData[k] = nd; patients[i].dx = nd.dx; }
      return out.map(function (s) { return { id: s.ruleId, sev: s.severity, crit: s.critical, t: s.suggestion.text, why: s.suggestion.why, h: s.valueHash, short: s.suggestion.short }; });
    };
  });
  const run = (o) => page.evaluate((o) => window.__esc(o), o);
  const ids = (r) => r.map(s => s.id);
  const find = (r, id) => r.find(s => s.id === id);

  // ── S: cultivos y antibiograma ──
  const s1 = await run({ labs: [[0, { leucos: '22', pcr: '250' }]] });
  check('S1 leucocitosis y PCR alta sin más contexto: NINGUNA sugerencia («Agregar al dx: Leucocitosis severa» ya no existe)', s1.length === 0 && !JSON.stringify(s1).match(/Agregar al dx/), JSON.stringify(s1));
  const kleb = { tipo: 'HEMOCULTIVO PERIFERICO', organismo: 'Klebsiella pneumoniae', germenes: [{ nombre: 'Klebsiella pneumoniae', flags: ['BLEE'], sensibles: ['MEROPENEM <=0.25', 'ERTAPENEM <=0.5', 'AMIKACINA 4'], intermedios: [], resistentes: ['CEFTRIAXONA >=64', 'CIPROFLOXACINO >=4'] }] };
  const s2 = await run({ ck: { atb: true, atb_nombre: 'CEFTRIAXONA', atb_dias: '3' }, cult: [kleb] });
  const s2r = find(s2, 'cult_resistente');
  check('S2 hemocultivo Klebsiella BLEE resistente a la ceftriaxona en uso: cambiar según antibiograma, urgente, con las opciones sensibles',
    !!s2r && s2r.crit && /RESISTENTE a ceftriaxona/.test(s2r.t) && /Sensible a: meropenem, ertapenem, amikacina\./.test(s2r.t) && /Infectología/.test(s2r.t) && /ATB de la tarjeta/.test(s2r.why), JSON.stringify(s2));
  const s2b = await run({ ck: { atb: true, atb_nombre: 'CEFTRIAXONA 1 G IV C/24 H' }, cult: [{ tipo: 'UROCULTIVO', organismo: 'Escherichia coli (BLEE)', germenes: [{ nombre: 'Escherichia coli', flags: ['BLEE'], sensibles: ['CEFTRIAXONA 1', 'NITROFURANTOINA 16', 'ERTAPENEM <=0.5'], resistentes: [] }] }] });
  const s2br = find(s2b, 'cult_resistente');
  check('S2b BLEE: aunque el antibiograma diga «ceftriaxona S», se marca como no confiable y no se ofrece', !!s2br && /BLEE/.test(s2br.t) && /Sensible a: nitrofurantoína, ertapenem\./.test(s2br.t) && !s2br.crit, JSON.stringify(s2b));
  const s3 = await run({ ind: { 'ANTIBIÓTICOS': ['CEFTRIAXONA 1 G IV CADA 12 HRS'] }, cult: [{ tipo: 'UROCULTIVO', organismo: 'Enterococcus faecalis', germenes: [{ nombre: 'Enterococcus faecalis', sensibles: ['AMPICILINA <=2', 'VANCOMICINA 1'], resistentes: [] }] }] });
  const s3r = find(s3, 'cult_resistente');
  check('S3 Enterococcus con ceftriaxona (no viene en el antibiograma): resistencia natural, ofrece ampicilina', !!s3r && /resistencia natural de Enterococcus/.test(s3r.t) && /ampicilina/.test(s3r.t) && /indicaciones del/.test(s3r.why), JSON.stringify(s3));
  const s4 = await run({ ind: { 'ANTIBIÓTICOS': ['VANCOMICINA 1 G IV C/12 H'] }, cult: [{ tipo: 'HEMOCULTIVO CENTRAL', organismo: 'Staphylococcus aureus', germenes: [{ nombre: 'Staphylococcus aureus', sensibles: ['OXACILINA 0.5', 'VANCOMICINA 1', 'CEFALOTINA 2'], resistentes: ['PENICILINA'] }] }] });
  check('S4 S. aureus sensible a oxacilina tratado con vancomicina: cambiar a betalactámico antiestafilocócico', ids(s4).includes('cult_mssa') && /cefazolina\/cefalotina u oxacilina/.test(find(s4, 'cult_mssa').t), JSON.stringify(s4));
  const s5 = await run({ ck: { atb: true, atb_nombre: 'MEROPENEM' }, cult: [{ tipo: 'LIQUIDO PERITONEAL', organismo: 'Escherichia coli', germenes: [{ nombre: 'Escherichia coli', sensibles: ['CEFTRIAXONA 1', 'CIPROFLOXACINO 0.25', 'MEROPENEM <=0.25'], resistentes: ['AMPICILINA'] }] }] });
  check('S5 E. coli sensible a ceftriaxona con meropenem: considerar desescalar (no «resistente»)', ids(s5).join() === 'cult_desescalar' && /ceftriaxona, ciprofloxacino/.test(s5[0].t), JSON.stringify(s5));
  const s6 = await run({ ck: { atb: true, atb_nombre: 'CEFTRIAXONA' }, cult: [{ tipo: 'UROCULTIVO', organismo: 'Candida albicans', germenes: [{ nombre: 'Candida albicans' }] }] });
  check('S6 Candida en orina sin antifúngico: casi siempre colonización (cambiar la sonda), no «resistente a ceftriaxona»', ids(s6).join() === 'cult_sin_atb' && /colonización/.test(s6[0].t) && !s6[0].crit, JSON.stringify(s6));
  const s7 = await run({ cult: [{ tipo: 'HEMOCULTIVO PERIFERICO', organismo: 'Staphylococcus epidermidis', germenes: [{ nombre: 'Staphylococcus epidermidis', sensibles: ['VANCOMICINA 1'] }] }] });
  check('S7 S. epidermidis en un hemocultivo sin tratamiento: posible contaminante (segundo hemocultivo), no urgente', s7.length === 1 && /contaminante/.test(s7[0].t) && !s7[0].crit, JSON.stringify(s7));
  const s8 = await run({ cult: [{ tipo: 'UROCULTIVO', organismo: 'Escherichia coli', germenes: [{ nombre: 'Escherichia coli', sensibles: ['NITROFURANTOINA 16', 'FOSFOMICINA'], resistentes: ['AMPICILINA'] }] }] });
  check('S8 cultivo positivo sin antibiótico registrado: valorar infección vs colonización y opciones sensibles', ids(s8).join() === 'cult_sin_atb' && /Sensible a: nitrofurantoína, fosfomicina\./.test(s8[0].t), JSON.stringify(s8));
  const s9 = await run({ ck: { atb: true, atb_nombre: 'CEFTRIAXONA' }, cult: [Object.assign({}, kleb, { d: 20 })] });
  check('S9 cultivo de hace 20 días: ya no se usa (ventana de 14 días)', s9.length === 0, JSON.stringify(s9));

  // ── H: hemoglobina, transfusión y plaquetas ──
  const h1 = await run({ pi: 1, app: 'CARDIOPATIA ISQUEMICA CON STENT 2019', labs: [[0, { hb: '6.8' }]], ck: { pm_peso: '60' } });
  const h1t = find(h1, 'transfusion');
  check('H1 Hb 6.8, 72 años con cardiopatía isquémica, 60 kg: umbral 8 (AABB), edad, cruce y ~2 CE estimados', !!h1t && /umbral de 8 g\/dL/.test(h1t.t) && /Tiene 72 años/.test(h1t.t) && /~2 CE/.test(h1t.t) && /Solicitar cruce/.test(h1t.t) && h1t.sev === 'moderada', JSON.stringify(h1));
  const h2 = await run({ labs: [[0, { hb: '7.5' }]] });
  check('H2 Hb 7.5 en 50 años sin cardiopatía ni sangrado: no se sugiere transfundir (umbral 7)', !ids(h2).includes('transfusion'), JSON.stringify(h2));
  const h3 = await run({ labs: [[0, { hb: '7.5' }]], pend: 'SANGRADO ACTIVO POR DRENAJE, VIGILAR' });
  check('H3 Hb 7.5 con sangrado activo en pendientes: transfusión urgente y decisión clínica', !!find(h3, 'transfusion') && find(h3, 'transfusion').crit && /decisión es clínica/.test(find(h3, 'transfusion').t), JSON.stringify(h3));
  const h4 = await run({ labs: [[0, { hb: '7.5' }]], pend: 'SIN SANGRADO ACTIVO. TOLERA VIA ORAL', app: 'STDA HACE 3 AÑOS' });
  check('H4 «SIN SANGRADO ACTIVO» y un STDA de hace años (APP) no cuentan como sangrado', !ids(h4).includes('transfusion'), JSON.stringify(h4));
  const h5 = await run({ labs: [[1, { hb: '11.0' }], [0, { hb: '8.6' }]], ck: { tvp: true, tvp_tipo: 'enoxaparina', tvp_dosis: '40 MG SC C/24 H' } });
  const h5c = find(h5, 'hb_caida');
  check('H5 caída de Hb 11 → 8.6 en un día con enoxaparina: buscar sangrado y valorar suspender el anticoagulante', !!h5c && /11 a 8.6/.test(h5c.t) && /enoxaparina/.test(h5c.t), JSON.stringify(h5));
  const h6 = await run({ labs: [[5, { plaq: '300' }], [0, { plaq: '120' }]], ind: { MEDICAMENTOS: ['HEPARINA 5000 UI SC C/12 H'] } });
  check('H6 plaquetas 300 → 120 en 5 días con heparina: descartar TIH (4T)', ids(h6).includes('tih') && /4T/.test(find(h6, 'tih').t), JSON.stringify(h6));
  const h7 = await run({ labs: [[0, { plaq: '40' }]], ck: { tvp: true, tvp_tipo: 'enoxaparina' } });
  check('H7 plaquetas 40 k con enoxaparina: suspender la profilaxis farmacológica y usar mecánica', ids(h7).includes('plaq_bajas') && /compresión mecánica/.test(find(h7, 'plaq_bajas').t), JSON.stringify(h7));

  // ── E: electrolitos ──
  const e1 = await run({ labs: [[0, { k: '2.9', mg: '1.4' }]], ind: { MEDICAMENTOS: ['FUROSEMIDA 20 MG IV C/12 HRS'] } });
  const e1k = find(e1, 'hipoK');
  check('E1 K 2.9 con Mg 1.4 y furosemida: IV con monitoreo, magnesio primero, menciona la furosemida; también la regla de Mg', !!e1k && e1k.sev === 'severa' && /monitoreo cardiaco/.test(e1k.t) && /corregir el magnesio primero/.test(e1k.t) && /furosemida/.test(e1k.t) && ids(e1).includes('hipoMg'), JSON.stringify(e1));
  const e2 = await run({ labs: [[0, { k: '6.3' }]], ind: { MEDICAMENTOS: ['ENALAPRIL 10 MG VO C/12 H'], SOLUCIONES: ['SOLUCION MIXTA 1000 ML + KCL 20 MEQ PARA 8 HRS'] } });
  const e2k = find(e2, 'hiperK');
  check('E2 K 6.3 con enalapril y KCl en soluciones: ECG, gluconato, quitar el aporte de K y el fármaco por su nombre', !!e2k && /gluconato de calcio/.test(e2k.t) && /Suspender el aporte de potasio/.test(e2k.t) && /enalapril/.test(e2k.t), JSON.stringify(e2));
  const e3 = await run({ labs: [[0, { na: '124', glu: '450' }]] });
  const e3n = find(e3, 'hipoNa');
  check('E3 Na 124 con glucosa 450: Na corregido ≈ 129.6-132.4, límite de corrección y SS 3 % si hay síntomas graves', !!e3n && /Na corregido ≈ 129.6-132.4/.test(e3n.t) && /no más de 10 mEq\/L/.test(e3n.t) && /SS 3 %/.test(e3n.t), JSON.stringify(e3));
  const e4 = await run({ labs: [[0, { na: '158' }]], ck: { pm_peso: '70', sexo: 'M' } });
  check('E4 Na 158, hombre de 50 años y 70 kg: déficit de agua libre ≈ 5.4 L', /Déficit de agua libre ≈ 5.4 L/.test((find(e4, 'hiperNa') || {}).t || ''), JSON.stringify(e4));
  const e5 = await run({ labs: [[0, { p: '1.8', k: '3.2', mg: '1.5' }]], ck: { npt: true } });
  check('E5 NPT con P 1.8 (y K/Mg bajos): síndrome de realimentación con tiamina', ids(e5).includes('realimentacion') && /tiamina/.test(find(e5, 'realimentacion').t) && !ids(e5).includes('hipoP'), JSON.stringify(e5));
  const e6 = await run({ labs: [[0, { hco3: '15', na: '140', cl: '115', alb: '4.0' }]], ind: { SOLUCIONES: ['SOLUCION SALINA 0.9% 1000 ML PARA 8 HRS'] } });
  check('E6 acidosis con brecha aniónica normal (10) y SS 0.9 %: hiperclorémica, considerar Hartmann', /Brecha aniónica 10/.test((find(e6, 'acidosis') || {}).t || '') && /Hartmann/.test(find(e6, 'acidosis').t), JSON.stringify(e6));
  const e7 = await run({ labs: [[0, { ca: '7.2', alb: '2.0' }]] });
  const e7b = await run({ labs: [[0, { ca: '6.9', alb: '4.0' }]] });
  check('E7 Ca 7.2 con albúmina 2.0 = corregido 8.8 (no se sugiere); Ca 6.9 con albúmina normal sí (calcio iónico, Mg)', !ids(e7).includes('hipoCa') && ids(e7b).includes('hipoCa') && /calcio iónico/.test(find(e7b, 'hipoCa').t), JSON.stringify([e7, e7b]));

  // ── G: glucosa e insulina ──
  const g1 = await run({ dx: 'DM2 DE 10 AÑOS + PIE DIABETICO', ck: { pm_dxtx: '250/280', pm_fecha: await page.evaluate(() => todayStr()), pm_peso: '80' }, ind: { MEDICAMENTOS: ['INSULINA RAPIDA SEGUN ESQUEMA'] } });
  const g1i = find(g1, 'insulina_basal');
  check('G1 diabético con glucosas 250/280 y solo esquema de corrección: agregar basal; 80 kg → 24-40 U/día (ADA)', !!g1i && /agregar insulina basal/.test(g1i.t) && /24-40 U/.test(g1i.t) && /ADA 2025/.test(g1i.t), JSON.stringify(g1));
  const g2 = await run({ dx: 'DIABETES MELLITUS TIPO 2', labs: [[1, { glu: '260' }], [0, { glu: '290' }]], ind: { MEDICAMENTOS: ['INSULINA GLARGINA 10 UI SC CADA NOCHE', 'INSULINA LISPRO 4 UI ANTES DE CADA ALIMENTO'] } });
  check('G2 con glargina y glucosas 260/290: subir la basal 10-20 %', /subir la basal 10-20 %/.test((find(g2, 'insulina_titular') || {}).t || ''), JSON.stringify(g2));
  const g3 = await run({ dx: 'DM2', ck: { pm_dxtx: '55', pm_fecha: await page.evaluate(() => todayStr()) }, ind: { MEDICAMENTOS: ['GLIBENCLAMIDA 5 MG VO C/12 H'] } });
  const g3h = find(g3, 'hipoglucemia');
  check('G3 glucosa capilar 55 con glibenclamida: tratar ya y suspender la sulfonilurea (por su nombre)', !!g3h && g3h.sev === 'severa' && /glibenclamida: suspender/.test(g3h.t), JSON.stringify(g3));
  const g4 = await run({ dx: 'DM2', ck: { npo: true, npo_dias: '1' }, ind: { MEDICAMENTOS: ['INSULINA LISPRO 4 UI SC ANTES DE CADA ALIMENTO', 'INSULINA NPH 10 UI SC MAÑANA'] } });
  check('G4 ayuno con insulina prandial: suspender la prandial y dejar basal reducida', ids(g4).includes('insulina_ayuno'), JSON.stringify(g4));
  const g5 = await run({ pi: 1, dx: 'DM2', labs: [[0, { cr: '3.0' }]], ck: { pm_peso: '60', sexo: 'F' }, ind: { MEDICAMENTOS: ['METFORMINA 850 MG VO C/12 H'] } });
  check('G5 metformina con ClCr ≈ 17 (72 años, mujer, 60 kg, Cr 3.0): suspender', /ClCr \(Cockcroft-Gault\) ≈ 1[67] mL\/min/.test((find(g5, 'metformina') || {}).t || ''), JSON.stringify(g5));
  const g6 = await run({ dx: 'DM2', ck: { npo: true }, ind: { MEDICAMENTOS: ['DAPAGLIFLOZINA 10 MG VO C/24 H'] } });
  check('G6 dapagliflozina en ayuno: suspender (cetoacidosis euglucémica)', /dapagliflozina/.test((find(g6, 'isglt2') || {}).t || '') && /euglucémica/.test(find(g6, 'isglt2').t), JSON.stringify(g6));

  // ── I: interacciones y duplicados ──
  const i1 = await run({ ck: { tvp: true, tvp_tipo: 'enoxaparina', tvp_dosis: '40 MG SC C/24 H' }, ind: { MEDICAMENTOS: ['KETOROLACO 30 MG IV C/8 H', 'OMEPRAZOL 40 MG IV C/24 H', 'PANTOPRAZOL 40 MG IV C/24 H'] } });
  check('I1 ketorolaco + enoxaparina profiláctica (TVP de la tarjeta) y omeprazol + pantoprazol: interacción «baja» (frecuente en el POP) y duplicado', ids(i1).includes('int_aine_anticoag') && find(i1, 'int_aine_anticoag').sev === 'leve' && ids(i1).includes('dup_ibp') && /TVP de la tarjeta/.test(find(i1, 'int_aine_anticoag').why), JSON.stringify(i1));
  const i1b = await run({ labs: [[0, { plaq: '80' }]], ind: { MEDICAMENTOS: ['KETOROLACO 30 MG IV C/8 H', 'ENOXAPARINA 60 MG SC C/12 H'] } });
  check('I1b ketorolaco + enoxaparina c/12 h (terapéutica) con plaquetas 80 k: «media», lo dice', (find(i1b, 'int_aine_anticoag') || {}).sev === 'moderada' && /dosis terapéutica/.test(find(i1b, 'int_aine_anticoag').t) && /plaquetas 80 k/.test(find(i1b, 'int_aine_anticoag').t), JSON.stringify(i1b));
  const r4 = await run({ pi: 1, labs: [[20, { cr: '1.0' }], [10, { cr: '2.5' }]] });
  check('R4 creatinina alta de hace 10 días (sin control reciente): no se sugiere LRA', !ids(r4).includes('aki'), JSON.stringify(r4));
  const i2 = await run({ labs: [[0, { k: '3.2' }]], ind: { MEDICAMENTOS: ['ONDANSETRON 8 MG IV C/8 H', 'HALOPERIDOL 2.5 MG IV PRN'], 'ANTIBIÓTICOS': ['LEVOFLOXACINO 750 MG IV C/24 H'] } });
  const i2q = find(i2, 'int_qt');
  check('I2 ondansetrón + haloperidol + levofloxacino con K 3.2: QT severa (ECG, K ≥ 4, Mg ≥ 2)', !!i2q && i2q.sev === 'severa' && /3 fármacos/.test(i2q.t) && /K 3.2/.test(i2q.t), JSON.stringify(i2));
  const i3 = await run({ ind: { MEDICAMENTOS: ['ACIDO VALPROICO 500 MG VO C/12 H'], 'ANTIBIÓTICOS': ['MEROPENEM 1 G IV C/8 H'] } });
  check('I3 meropenem + ácido valproico: severa (crisis convulsivas)', (find(i3, 'int_carba_valpro') || {}).sev === 'severa', JSON.stringify(i3));
  const i4 = await run({ ind: { 'ANTIBIÓTICOS': ['PIPERACILINA/TAZOBACTAM 4.5 G IV C/6 H', 'METRONIDAZOL 500 MG IV C/8 H'] } });
  check('I4 piperacilina/tazobactam + metronidazol: doble cobertura anaerobia', ids(i4).includes('dup_anaerobios') && /suspender metronidazol/.test(find(i4, 'dup_anaerobios').t), JSON.stringify(i4));
  const i5 = await run({ ind: { MEDICAMENTOS: ['NALBUFINA 10 MG IV C/6 H', 'MORFINA 2 MG IV PRN DOLOR'] } });
  check('I5 nalbufina + morfina: se antagonizan, usar uno solo', ids(i5).includes('int_opio_mixto'), JSON.stringify(i5));
  const i6 = await run({ ck: { tvp: true, tvp_tipo: 'enoxaparina' }, ind: { MEDICAMENTOS: ['SUSPENDER KETOROLACO', 'KETOROLACO 30 MG (SUSP.)', 'PARACETAMOL 1 G IV C/8 H'] } });
  check('I6 renglones con «SUSPENDER»/«SUSP.» no cuentan como fármaco en uso', !ids(i6).includes('int_aine_anticoag'), JSON.stringify(i6));
  const i7 = await run({ ind: { MEDICAMENTOS: ['TRAMADOL 50 MG IV C/8 H', 'SERTRALINA 50 MG VO C/24 H', 'PARACETAMOL 1 G IV C/8 H', 'PARACETAMOL 500 MG VO PRN'] } });
  check('I7 tramadol + sertralina (serotoninérgico) y paracetamol dos veces (máx. 4 g/día)', ids(i7).includes('int_serotonina') && /4 g\/día/.test((find(i7, 'dup_mismo') || {}).t || ''), JSON.stringify(i7));

  // ── R: riñón ──
  const r1 = await run({ pi: 1, labs: [[5, { cr: '1.0' }], [0, { cr: '2.0' }]], ck: { pm_peso: '60', sexo: 'F' }, ind: { MEDICAMENTOS: ['KETOROLACO 30 MG IV C/8 H'], 'ANTIBIÓTICOS': ['VANCOMICINA 1 G IV C/12 H'] } });
  const r1a = find(r1, 'aki'), r1b = find(r1, 'ajuste_renal');
  check('R1 Cr 1.0 → 2.0 con vancomicina y ketorolaco: LRA KDIGO 2 nombrando los nefrotóxicos; ClCr ≈ 24 mL/min (72 años, mujer, 60 kg) con ajuste y evitar ketorolaco',
    !!r1a && r1a.sev === 'stage2' && /(vancomicina y ketorolaco|ketorolaco y vancomicina)/.test(r1a.t) && !!r1b && /ClCr \(Cockcroft-Gault\) ≈ 24 mL\/min/.test(r1b.t) && /evitar o suspender ketorolaco/.test(r1b.t), JSON.stringify(r1));
  const r2 = await run({ ck: { pm_uresis: '600', pm_peso: '80', pm_fecha: await page.evaluate(() => todayStr()) } });
  check('R2 uresis 600 mL, 80 kg, 24 h: oliguria por índice urinario 0.31 mL/kg/h', /0.31 mL\/kg\/h/.test((find(r2, 'oliguria') || {}).t || ''), JSON.stringify(r2));
  const r3 = await run({ pi: 1, dx: 'COLECISTITIS + ERC EN HEMODIALISIS', labs: [[5, { cr: '5.0' }], [0, { cr: '7.5' }]] });
  check('R3 con ERC en hemodiálisis no se sugiere LRA', !ids(r3).includes('aki'), JSON.stringify(r3));

  // ── O: otras ──
  const o1 = await run({ labs: [[0, { pcr: '220' }]], ck: { cirugias: [{ id: 'c1', fecha: await page.evaluate(() => __iso(4)), procedimiento: 'HEMICOLECTOMIA DERECHA' }] } });
  check('O1 PCR 220 en el POP día 4: buscar complicación (fuga, colección, TAC)', /POP día 4/.test((find(o1, 'pcr_pop') || {}).t || ''), JSON.stringify(o1));
  const o2 = await run({ ck: { npo: true, npo_dias: '6' }, labs: [[0, { alb: '2.4' }]] });
  check('O2 ayuno de 6 días sin NPT: valorar soporte nutricional (ESPEN)', /ESPEN/.test((find(o2, 'nutricion') || {}).t || ''), JSON.stringify(o2));
  const o3 = await run({ ind: { MEDICAMENTOS: ['PARACETAMOL 1 G IV C/8 H'] } });
  const o3b = await run({ ind: { MEDICAMENTOS: ['PARACETAMOL 1 G IV C/8 H'], 'MEDIDAS GENERALES': ['MEDIAS DE COMPRESION EN MIEMBROS PELVICOS'] } });
  check('O3 indicaciones sin heparina ni TVP marcada: valorar profilaxis; con medias de compresión no', ids(o3).includes('tvp_sin') && !ids(o3b).includes('tvp_sin'), JSON.stringify([o3, o3b]));

  // ── U: la tarjeta ──
  const u1 = await page.evaluate(() => {
    const k = pid(patients[0]);
    window.__esc({ ck: { atb: true, atb_nombre: 'CEFTRIAXONA' }, cult: [{ tipo: 'HEMOCULTIVO PERIFERICO', organismo: 'Klebsiella pneumoniae', germenes: [{ nombre: 'Klebsiella pneumoniae', flags: ['BLEE'], sensibles: ['MEROPENEM'], resistentes: ['CEFTRIAXONA'] }] }], guardar: true });
    const html = renderCDSSection(patients[0], noteData[k], k);
    return { html: html, k: k };
  });
  check('U1 la caja: URGENTE, «Por qué», ➕ A pendientes y 🔇 Ignorar; ya no hay «Aplicar al dx» ni «Agregar al dx»',
    /URGENTE/.test(u1.html) && /Por qué:/.test(u1.html) && /A pendientes/.test(u1.html) && /Ignorar/.test(u1.html) && !/Aplicar al dx|Agregar al dx/.test(u1.html), u1.html.slice(0, 600));
  const u2 = await page.evaluate(async (k) => {
    noteData[k].pendientes = 'Control de BH'; _rerenderCard(k);
    const s = PLCDS.evaluate(patients[0], getNote(k)).find(x => x.ruleId === 'cult_resistente');
    cdsAddToPendientes(k, 'cult_resistente', s.valueHash);
    const a = getNote(k).pendientes;
    cdsAddToPendientes(k, 'cult_resistente', s.valueHash);
    const b = getNote(k).pendientes;
    undoLast(k);
    const c = getNote(k).pendientes;
    return { a, b, c };
  }, u1.k);
  check('U2 ➕ A pendientes agrega «• Cambiar ATB según antibiograma…» al final, no lo duplica y ↩ Regresar lo quita',
    u2.a === 'Control de BH\n• Cambiar ATB según antibiograma (Klebsiella pneumoniae (BLEE))' && u2.b === u2.a && u2.c === 'Control de BH', JSON.stringify(u2));
  const u3 = await page.evaluate((k) => {
    const s = PLCDS.evaluate(patients[0], getNote(k)).find(x => x.ruleId === 'cult_resistente');
    cdsIgnoreSuggestion(k, 'cult_resistente', s.valueHash);
    return renderCDSSection(patients[0], getNote(k), k);
  }, u1.k);
  check('U3 🔇 Ignorar la oculta (hasta que cambien los datos)', !/RESISTENTE a ceftriaxona/.test(u3), u3.slice(0, 300));
  const u4 = await page.evaluate(() => { const p = patients[1]; const k = pid(p); const nd = defaultData(); nd.labHistory = [{ fecha: todayStr(), labs: { leucos: '25', pcr: '300', bt: '3.1', amilasa: '600', alb: '2.1' } }]; return renderCDSSection(p, nd, k); });
  check('U4 solo hallazgos de laboratorio: la caja dice «Sin pendientes» (ya no propone diagnósticos)', /Sin pendientes/.test(u4) && !/Agregar al dx/.test(u4), u4.slice(0, 300));

  check('sin errores de página', errors.length === 0, errors.join(' | '));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
