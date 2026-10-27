// Vasopresores (norepinefrina / vasopresina), ventilador ampliado (peso predicho, VT mL/kg, presión de
// distensión) y nota de evolución con IA en un clic (formato del servicio, sin inventar, pasar a la página).
//   node tests/headless/app_vp.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  localStorage.setItem('hgl-worker-config', JSON.stringify({ url:'https://mock.local/worker', token:'tok', notes_url:'' }));
  window.__alerts=[]; window.__prompts=[]; window.__opened=[]; window.__clip=[];
  window.prompt=function(m){ window.__prompts.push(String(m)); return window.__promptAnswer===undefined?'Tester':window.__promptAnswer; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  window.open=function(u){ window.__opened.push(String(u)); return window.__openFail?null:{ focus(){} }; };
  try{ Object.defineProperty(navigator,'clipboard',{ value:{ writeText:(t)=>{ window.__clip.push(String(t)); return Promise.resolve(); } }, configurable:true }); }catch(_){}
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
// Respuesta simulada de la IA: con markdown, minúsculas, encabezado y firma repetidos (todo eso debe limpiarse).
const AI_NOTE = '```\n# NOTA DE EVOLUCIÓN CIRUGÍA GENERAL\n**RUIZ SOTO MATEO | EDAD 58 AÑOS | FN [FN] | EXP 24-99901 | CAMA 3-170 | 14.10.2026 09:00 HRS**\n\n'
  + 'Paciente masculino en la sexta década de la vida hospitalizado con el siguiente diagnóstico: choque séptico de origen abdominal + PO LAPE + drenaje de colección + DM2 + HAS.\n\n'
  + 'Al pase de visita el paciente refiere dolor en sitio de herida quirúrgica, niega náusea y vómito.\n\n'
  + 'Paciente masculino, consciente, orientado, con FC 103 LPM, saturación de oxígeno de 96 % bajo ventilación mecánica invasiva (modo AC, FiO2 40 %, PEEP 8 cmH2O, volumen tidal 420 mL (6.4 mL/kg de peso predicho)), TA 110/70 mmHg (PAM 83 mmHg) bajo apoyo vasopresor con norepinefrina a 11.4 mcg/kg/h (0.19 mcg/kg/min) y vasopresina a 0.03 U/min. Abdomen blando, depresible, herida quirúrgica con bordes bien afrontados, [EXPLORACIÓN DE TÓRAX], extremidades íntegras con llenado capilar conservado.\n\n'
  + 'LABORATORIOS: [SIN LABORATORIOS REGISTRADOS EN LA TARJETA].\n\n'
  + '- Paciente masculino en el postoperatorio mediato de *laparotomía exploradora* con choque séptico de origen abdominal en resolución, con requerimiento vasopresor de norepinefrina a 11.4 mcg/kg/h (0.19 mcg/kg/min) y vasopresina a 0.03 U/min; se continúa el retiro progresivo del vasopresor con meta de presión arterial media mayor o igual a 65 mmHg y uresis mayor o igual a 0.5 mL/kg/h guiado por lactato y llenado capilar conforme a Surviving Sepsis Campaign 2021. Bajo ventilación mecánica protectora con volumen tidal de 6.4 mL/kg de peso predicho y presión de distensión de 12 cmH2O (ARDSNet), se valorará prueba de ventilación espontánea al retirar el vasopresor. Diabetes mellitus tipo 2 con meta de glucemia de 140 a 180 mg/dL (ADA 2025). Se mantiene tromboprofilaxis con enoxaparina, profilaxis de úlcera por estrés con inhibidor de bomba de protones, analgesia multimodal y curación diaria de herida quirúrgica. Nutrición enteral trófica al estabilizar el requerimiento vasopresor conforme a ESPEN 2023. Se solicitan biometría hemática, química sanguínea, electrolitos séricos, procalcitonina y gasometría arterial con lactato, y TAC de control. Estado de salud delicado, con pronóstico reservado a evolución.\n\n'
  + 'DR GARNELO MBCG | DR FERNÁNDEZ R2CG\n```';
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = []; const aiBodies = []; let aiMode = 'ok';
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/api/ai', async (route) => {
    let body = null; try { body = JSON.parse(route.request().postData() || 'null'); } catch (_) {}
    aiBodies.push({ model: body && body.model, text: (body && body.messages && body.messages[0] && body.messages[0].content && body.messages[0].content[0] && body.messages[0].content[0].text) || '' });
    if (aiMode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Gemini API error' }) });
    await new Promise(r => setTimeout(r, 400));   // como la IA real: tarda, y mientras tanto debe verse el borrador
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', type: 'message', role: 'assistant', content: [{ type: 'text', text: AI_NOTE }], stop_reason: 'end_turn' }) });
  });
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-170', exp: '24-99901', nombre: 'RUIZ SOTO MATEO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'CHOQUE SÉPTICO DE ORIGEN ABDOMINAL, PO LAPE + DRENAJE DE COLECCIÓN, DM2, HAS', adscrito: 'DR GARNELO MBCG', residente: 'DR FERNÁNDEZ R2CG' }]);
      return json(201, [{ id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const near = (a, b, d) => typeof a === 'number' && Math.abs(a - b) < Math.pow(10, -d) * 0.51;
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  // ── V1: fórmulas puras ──
  const v1 = await page.evaluate(() => ({
    d1: vpNoreDosis(4, 250, 10, 70), r1: vpNoreRate(4, 250, 0.1, 70), c1: vpNoreConc(8, 250),
    dH: vpNoreDosisH(4, 100, 10, 70), rH: vpNoreRateH(4, 100, 6, 70), dHnul: vpNoreDosisH(4, 100, 10, ''), rHnul: vpNoreRateH(4, 100, '', 70), def: [VP_NORE_DEF.mg, VP_NORE_DEF.ml],
    d2: vpVasoDosis(20, 100, 9), r2: vpVasoRate(20, 100, 0.03),
    pam: vpPam('110/70'), pamBad: vpPam('abc'), pbwM: vmPbw(170, 'M'), pbwF: vmPbw(170, 'F'), pbwNo: vmPbw('', 'M'), vtkg: vmVtKg(420, vmPbw(170, 'M')), dp: vmDrivingP(20, 8), dpNo: vmDrivingP('', 8),
    f1: vpFmt(0.038095), f2: vpFmt(4), f3: vpFmt(0.5), f4: vpFmt(12.345, 1), f5: vpFmt(null),
    nul: vpNoreDosis('', 250, 10, 70), nul2: vpNoreDosis(4, 250, 10, ''), nul3: vpVasoDosis(20, 100, ''), comma: vpNoreDosis('4', '250', '7,5', '70')
  }));
  check('V1 fórmulas: norepinefrina mcg/kg/min = (mg·1000/mL)·mL/h ÷ 60 ÷ kg y su inversa; en mcg/kg/h (× 60: 4 mg/100 mL a 10 mL/h en 70 kg = 5.71) y su inversa (meta 6 mcg/kg/h → 10.5 mL/h); dilución por defecto 4 mg en 100 mL; vasopresina U/min = (U/mL)·mL/h ÷ 60 y su inversa; PAM; peso predicho Devine H/M; VT/kg; presión de distensión; formato; vacíos → null; coma decimal',
    near(v1.d1, 0.0381, 3) && near(v1.r1, 26.25, 2) && v1.c1 === 32 && near(v1.d2, 0.03, 4) && near(v1.r2, 9, 4)
    && near(v1.dH, 5.714, 2) && near(v1.rH, 10.5, 3) && v1.dHnul === null && v1.rHnul === null && v1.def[0] === 4 && v1.def[1] === 100
    && v1.pam === 83 && v1.pamBad === null && near(v1.pbwM, 66.0, 1) && near(v1.pbwF, 61.5, 1) && v1.pbwNo === null && near(v1.vtkg, 6.36, 2) && v1.dp === 12 && v1.dpNo === null
    && v1.f1 === '0.038' && v1.f2 === '4' && v1.f3 === '0.5' && v1.f4 === '12.3' && v1.f5 === ''
    && v1.nul === null && v1.nul2 === null && v1.nul3 === null && near(v1.comma, 0.0286, 3), JSON.stringify(v1));

  // ── V2: fila 💉 Vasopresor en la tarjeta ──
  const v2 = await page.evaluate(async () => {
    const k = pid(patients[0]); focusGoTo(k);
    const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const set = (f, v) => { const el = q(f); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const row0 = !!document.querySelector('#ck-row-' + ek + ' .ck-r-vaso');
    const noInputs0 = !q('vp_nore_mlh');
    set('pm_peso', '70');
    toggleChecklist(k, 'vp_nore_on');
    const def = [getNote(k).checklist.vp_nore_mg, getNote(k).checklist.vp_nore_ml];
    // ⚖️ el peso también está en la fila del vasopresor (mismo pm_peso) y los dos campos se siguen
    const pesoInputs = document.querySelectorAll('#ck-row-' + ek + ' input[data-field="pm_peso"]').length;
    const pesoVp = document.querySelector('#ck-row-' + ek + ' .ck-r-vaso input[data-field="pm_peso"]');
    const pesoVpVal0 = pesoVp ? pesoVp.value : null;
    if (pesoVp) { pesoVp.value = '80'; pesoVp.dispatchEvent(new Event('input', { bubbles: true })); }
    const pesoClin80 = q('pm_peso').value; const pesoSaved80 = getNote(k).checklist.pm_peso;
    set('pm_peso', '70');
    const pesoVp70 = pesoVp ? pesoVp.value : null;
    set('vp_nore_mlh', '10');
    const res1 = document.getElementById('vp-nore-res-' + ek).textContent;
    set('vp_nore_meta', '6');                     // meta en mcg/kg/h
    const meta1 = document.getElementById('vp-nore-meta-' + ek).textContent;
    const metaPh = q('vp_nore_meta').placeholder;
    set('vp_nore_mg', '8');                       // cambiar la dilución: la dosis se duplica
    const res2 = document.getElementById('vp-nore-res-' + ek).textContent;
    set('vp_nore_mlh', '80');                     // dosis alta → rojo + sugerencia SSC
    const hi = document.getElementById('vp-nore-res-' + ek).className; const ssc = document.getElementById('vp-ssc-' + ek).textContent; const sscShown = document.getElementById('vp-ssc-' + ek).style.display !== 'none';
    set('vp_nore_mlh', '10');
    const sscHidden = document.getElementById('vp-ssc-' + ek).style.display === 'none';
    toggleChecklist(k, 'vp_vaso_on');
    const defV = [getNote(k).checklist.vp_vaso_u, getNote(k).checklist.vp_vaso_ml];
    set('vp_vaso_mlh', '9');
    const resV = document.getElementById('vp-vaso-res-' + ek).textContent;
    set('vp_vaso_mlh', '15');
    const hiV = document.getElementById('vp-vaso-res-' + ek).className;
    set('vp_vaso_mlh', '9');
    set('pm_peso', '');                            // sin peso → aviso
    const noPeso = document.getElementById('vp-nore-res-' + ek).textContent;
    set('pm_peso', '70');
    _rerenderCard(k);
    const after = { mg: q('vp_nore_mg').value, mlh: q('vp_nore_mlh').value, res: document.getElementById('vp-nore-res-' + ek).textContent, resV: document.getElementById('vp-vaso-res-' + ek).textContent };
    await new Promise(r => setTimeout(r, 900));
    const s = getNote(k).checklist;
    return { row0, noInputs0, def, pesoInputs, pesoVpVal0, pesoClin80, pesoSaved80, pesoVp70, res1, meta1, metaPh, res2, hi, ssc, sscShown, sscHidden, defV, resV, hiV, noPeso, after, saved: { on: s.vp_nore_on, mg: s.vp_nore_mg, mlh: s.vp_nore_mlh, von: s.vp_vaso_on, vmlh: s.vp_vaso_mlh, peso: s.pm_peso } };
  });
  const vpPosted = calls.some(c => c.m === 'POST' && /\/rest\/v1\/notes/.test(c.url) && c.body && c.body.checklist && c.body.checklist.vp_nore_mlh === '10' && c.body.checklist.vp_vaso_mlh === '9');
  check('V2 💉 fila de vasopresores: chips apagados sin campos; al encender norepinefrina propone 4 mg/100 mL y muestra el ⚖️ peso en la misma fila (sigue al de Clínico y viceversa); con 70 kg y 10 mL/h → 5.7 mcg/kg/h (0.095 mcg/kg/min); meta 6 mcg/kg/h → 10.5 mL/h; 8 mg/100 → 11.4 mcg/kg/h; 80 mL/h → rojo + sugerencia SSC en mcg/kg/h (se oculta al bajar); vasopresina 20 U/100 mL a 9 mL/h → 0.03 U/min (1.8 U/h), 15 mL/h → rojo; sin peso avisa; sobrevive al repintado; se guarda en la nube',
    v2.row0 && v2.noInputs0 && v2.def[0] === '4' && v2.def[1] === '100'
    && v2.pesoInputs === 2 && v2.pesoVpVal0 === '70' && v2.pesoClin80 === '80' && v2.pesoSaved80 === '80' && v2.pesoVp70 === '70'
    && v2.res1 === '5.7 mcg/kg/h (0.095 mcg/kg/min)' && v2.meta1 === '= 10.5 mL/h' && v2.metaPh === 'mcg/kg/h' && v2.res2 === '11.4 mcg/kg/h (0.19 mcg/kg/min)'
    && /vp-hi/.test(v2.hi) && /SSC 2021: con norepinefrina ≥ 15 mcg\/kg\/h/.test(v2.ssc) && v2.sscShown && v2.sscHidden
    && v2.defV[0] === '20' && v2.defV[1] === '100' && v2.resV === '0.03 U/min (1.8 U/h)' && /vp-hi/.test(v2.hiV) && /falta el peso/.test(v2.noPeso)
    && v2.after.mg === '8' && v2.after.mlh === '10' && v2.after.res === '11.4 mcg/kg/h (0.19 mcg/kg/min)' && v2.after.resV === '0.03 U/min (1.8 U/h)'
    && v2.saved.on === true && v2.saved.mg === '8' && v2.saved.mlh === '10' && v2.saved.von === true && v2.saved.vmlh === '9' && v2.saved.peso === '70' && vpPosted, JSON.stringify({ v2, vpPosted }));

  // ── V3: 🫁 ventilador ampliado ──
  const v3 = await page.evaluate(() => {
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const nd = getNote(k); nd.checklist.sexo = 'M'; noteData[k] = nd;
    toggleChecklist(k, 'pm_vent');
    const q = (f) => document.querySelector('#ck-row-' + ek + ' input[data-field="' + f + '"]');
    const set = (f, v) => { const el = q(f); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pm_vent_vt', '420'); set('pm_vent_peep', '8'); set('pm_vent_pplat', '20');
    const noTalla = document.getElementById('vm-chips-' + ek).textContent;
    set('pm_talla', '170');
    const chipTxt = () => Array.from(document.querySelectorAll('#vm-chips-' + ek + ' .vm-chip')).map(c => c.textContent + (/vm-hi/.test(c.className) ? '!' : ''));
    const chips1 = chipTxt();
    set('pm_vent_vt', '600'); set('pm_vent_pplat', '32');
    const chips2 = chipTxt();
    set('pm_vent_vt', '420'); set('pm_vent_pplat', '20'); set('pm_vent_modo', 'AC'); set('pm_vent_fio2', '40'); set('pm_vent_fr', '16'); set('pm_vent_pip', '24'); set('pm_vent_ie', '1:2'); set('pm_vent_pmedia', '12');
    const hasNew = ['pm_vent_pplat', 'pm_vent_pmedia', 'pm_vent_ie', 'pm_talla', 'pm_peso'].every(f => !!q(f));
    _rerenderCard(k);
    const chips3 = chipTxt();
    const s = getNote(k).checklist;
    return { noTalla, chips1, chips2, chips3, hasNew, saved: { pplat: s.pm_vent_pplat, ie: s.pm_vent_ie, talla: s.pm_talla, pmedia: s.pm_vent_pmedia } };
  });
  check('V3 🫁 ventilador ampliado: campos Pplat/Pmedia/I:E + peso/talla; sin talla avisa; con talla 170 y sexo M: peso predicho 66 kg, VT 6.4 mL/kg y ΔP 12 en verde; VT 600 (9.1 mL/kg), Pplat 32 (ΔP 24, > 30) en rojo; sobrevive al repintado; se guarda',
    /falta talla/.test(v3.noTalla) && v3.hasNew
    && v3.chips1.includes('PP 66 kg') && v3.chips1.includes('VT 6.4 mL/kg') && v3.chips1.includes('ΔP 12')
    && v3.chips2.includes('VT 9.1 mL/kg!') && v3.chips2.includes('ΔP 24!') && v3.chips2.includes('Pplat > 30!')
    && v3.chips3.includes('VT 6.4 mL/kg') && v3.chips3.includes('ΔP 12') && v3.saved.pplat === '20' && v3.saved.ie === '1:2' && v3.saved.talla === '170' && v3.saved.pmedia === '12', JSON.stringify(v3));

  // ── V4: texto en la nota de evolución ──
  const v4 = await page.evaluate(() => {
    const k = pid(patients[0]); const p = patients[0]; const nd = getNote(k); const ck = nd.checklist;
    ck.pm_ta = '110/70'; ck.pm_sao2 = '96'; ck.pm_fc = '103'; noteData[k] = nd;
    const conVp = _plneBuild(p, nd);
    const nd2 = JSON.parse(JSON.stringify(getNote(k))); nd2.checklist.vp_nore_on = false; nd2.checklist.vp_vaso_on = false; nd2.checklist.pm_vent = false;   // copia: getNote devuelve la nota viva
    const sinVp = _plneBuild(p, nd2);
    return { conVp, sinVp };
  });
  check('V4 nota de evolución: ventilador completo (modo, FiO2, PEEP, VT con mL/kg de peso predicho, FR, PIP, Pplat, presión de distensión, Pmedia, I:E), TA con PAM y vasopresores con dosis calculada en mcg/kg/h (y mcg/kg/min) y dilución; sin vasopresor la TA se escribe como siempre (sin PAM)',
    /SATURACIÓN DE OXÍGENO DE 96 % BAJO VENTILACIÓN MECÁNICA INVASIVA \(MODO AC, FIO2 40 %, PEEP 8 CMH2O, VOLUMEN TIDAL 420 ML \(6\.4 ML\/KG DE PESO PREDICHO\), FR 16 RPM, PIP 24 CMH2O, PRESIÓN MESETA 20 CMH2O, PRESIÓN DE DISTENSIÓN 12 CMH2O, PRESIÓN MEDIA 12 CMH2O, RELACIÓN I:E 1:2\)/.test(v4.conVp)
    && /TA 110\/70 MMHG \(PAM 83 MMHG\) BAJO APOYO VASOPRESOR CON NOREPINEFRINA A 11\.4 MCG\/KG\/H \(0\.19 MCG\/KG\/MIN\) \(8 MG EN 100 ML A 10 ML\/H\) Y VASOPRESINA A 0\.03 U\/MIN \(20 U EN 100 ML A 9 ML\/H\)/.test(v4.conVp)
    && /TA 110\/70 MMHG\./.test(v4.sinVp) && !/PAM|VASOPRESOR|VENTILACIÓN/.test(v4.sinVp), v4.conVp.slice(0, 900));

  // ── V5: 🤖 Nota IA en un clic ──
  aiMode = 'ok';
  const v5 = await page.evaluate(async () => {
    const k = pid(patients[0]); const nd = getNote(k); nd.app = 'DM2 de 10 años en tratamiento con metformina; HAS'; nd.pa = 'Ingresó por abdomen agudo'; nd.pendientes = '• TAC de control'; noteData[k] = nd;
    const menuBtn = !!document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="card-nota-ia"]');
    notaIAUnClic(k);
    const t0 = Date.now();
    await new Promise(r => setTimeout(r, 60));   // ya se mandó a la IA: mientras responde se ve el borrador y el botón está ocupado
    const early = { title: document.getElementById('plne-out-title').textContent, hasDraft: /NOTA DE EVOLUCIÓN CIRUGÍA GENERAL/.test(document.getElementById('plne-out-text').textContent), busy: document.getElementById('plne-aibtn').disabled, busyTxt: document.getElementById('plne-aibtn').textContent };
    for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); const t = document.getElementById('plne-out-title'); if (t && /redactada con IA/.test(t.textContent)) break; }
    const txt = document.getElementById('plne-out-text').textContent;
    const draft = _plneBuild(patients[0], getNote(k));
    return { menuBtn, early, shown: document.getElementById('plne-back').classList.contains('show'), title: document.getElementById('plne-out-title').textContent, txt, draftHead: draft.split('\n').slice(0, 2), draftFirma: draft.split('\n').pop(), hist: (getNote(k).checklist.nota_hist || []).map(h => ({ ia: h.ia, by: h.by, n: h.txt.length })), warn: document.getElementById('plne-warn').style.display, warnTxt: document.getElementById('plne-warn').textContent, marks: Array.from(document.querySelectorAll('#plne-out-text mark.plne-nuevo')).map(m => m.textContent), faltan: Array.from(document.querySelectorAll('#plne-out-text mark.plne-falta')).map(m => m.textContent), sel: document.getElementById('plne-hist').style.display, btn: document.getElementById('plne-aibtn').disabled, ms: Date.now() - t0 };
  });
  const l5 = v5.txt.split('\n'); const noHora = (s) => String(s || '').replace(/\d{2}:\d{2} HRS$/, ''); const ai0 = aiBodies[0] || { text: '' };
  const c5 = {
    menuBtn: v5.menuBtn, shown: v5.shown, early: !!v5.early && /redactando con IA/.test(v5.early.title) && v5.early.hasDraft && v5.early.busy && /Redactando/.test(v5.early.busyTxt),
    title: /redactada con IA/.test(v5.title), head1: l5[0] === v5.draftHead[0], head2: noHora(l5[1]) === noHora(v5.draftHead[1]), firma: l5[l5.length - 1] === v5.draftFirma, blancos: l5[2] === '' && l5[l5.length - 2] === '',
    sinMarkdown: !/[#*`]/.test(v5.txt), mayusculas: v5.txt === v5.txt.toUpperCase(), decada: /PACIENTE MASCULINO EN LA SEXTA DÉCADA/.test(v5.txt), sscNota: /SURVIVING SEPSIS CAMPAIGN 2021/.test(v5.txt), corchete: /\[EXPLORACIÓN DE TÓRAX\]/.test(v5.txt), estado: /ESTADO DE SALUD DELICADO, CON PRONÓSTICO RESERVADO A EVOLUCIÓN\./.test(v5.txt),
    encabezadoUnaVez: (v5.txt.match(/NOTA DE EVOLUCIÓN CIRUGÍA GENERAL/g) || []).length === 1, firmaUnaVez: (v5.txt.match(/DR GARNELO MBCG/g) || []).length === 1, idUnaVez: !/EDAD 58 AÑOS[\s\S]*EDAD 58 AÑOS/.test(v5.txt),
    hist: v5.hist.length === 1 && v5.hist[0].ia === true && v5.hist[0].by === 'GF', warn: v5.warn === 'block' && /La IA escribió \d+ dato/.test(v5.warnTxt),
    // Lo que la IA inventó (no venía en la tarjeta) queda resaltado; las metas permitidas, las cifras del borrador y los años de las guías no.
    inventos: ['PROFILAXIS DE ÚLCERA POR ESTRÉS', 'INHIBIDOR DE BOMBA DE PROTONES', 'ANALGESIA MULTIMODAL', 'RESERVADO A EVOLUCIÓN'].every(x => v5.marks.includes(x)),
    sinFalsos: !v5.marks.some(x => /^(65|0\.5|140|180|2021|2023|2025|6\.4|12|103|11\.4|0\.19|0\.03|96|40|8|420|110|70|83)$/.test(x)),
    corchetes: v5.faltan.includes('[EXPLORACIÓN DE TÓRAX]') && v5.faltan.includes('[FN]'), sel: v5.sel !== 'none', btn: v5.btn === false,
    aiUna: aiBodies.length === 1, modelo: ai0.model === 'claude-sonnet-4-6', borrador: /\(A\) BORRADOR:\nNOTA DE EVOLUCIÓN CIRUGÍA GENERAL/.test(ai0.text), app: /DM2 de 10 años/.test(ai0.text), pend: /PENDIENTES: TAC de control/.test(ai0.text), reglas: /NO inventes datos/.test(ai0.text), sscPrompt: /SURVIVING SEPSIS CAMPAIGN 2021/.test(ai0.text), vpPrompt: /BAJO APOYO VASOPRESOR CON NOREPINEFRINA A 11\.4 MCG\/KG\/H \(0\.19 MCG\/KG\/MIN\)/.test(ai0.text)
  };
  const bad5 = Object.keys(c5).filter(x => !c5[x]);
  check('V5 🤖 Nota IA en un clic desde la tarjeta: abre el modal, muestra el borrador mientras redacta, manda borrador + contexto (APP, pendientes, reglas) al worker, limpia la respuesta (sin markdown ni ```, mayúsculas), encabezado y firma del borrador una sola vez, "ESTADO DE SALUD", guarda en notas previas con iniciales',
    bad5.length === 0, 'fallan: ' + bad5.join(', ') + ' :: ' + JSON.stringify({ ...v5, txt: v5.txt }) + ' :: PROMPT ' + ai0.text.slice(-900));

  // ── V5b: revisar lo resaltado antes de copiar ──
  const v5b = await page.evaluate(async () => {
    const pre = document.getElementById('plne-out-text'); const n0 = pre.querySelectorAll('mark.plne-nuevo').length; const clip0 = window.__clip.length;
    let asked = ''; window.confirm = function (m) { asked = String(m); return false; };
    copyNotaEvo(); await new Promise(r => setTimeout(r, 150));
    const bloqueado = window.__clip.length === clip0;
    pre.querySelector('mark.plne-nuevo').click();
    const n1 = pre.querySelectorAll('mark.plne-nuevo').length; const warn1 = document.getElementById('plne-warn').textContent;
    pre.querySelectorAll('mark.plne-nuevo').forEach(m => m.click());
    const warnFin = document.getElementById('plne-warn').style.display;
    window.confirm = function (m) { asked = String(m); return true; };
    copyNotaEvo(); await new Promise(r => setTimeout(r, 150));
    const copiado = window.__clip.length === clip0 + 1 && window.__clip[window.__clip.length - 1] === _plneTextoActual();
    window.__clip = [];   // V7 cuenta sus propias copias
    return { n0, n1, asked, bloqueado, warn1, warnFin, copiado };
  });
  check('V5b nota con IA: «Copiar» pide confirmación mientras queden [corchetes] o datos que la IA agregó; tocar un resaltado lo marca como revisado (baja la cuenta y al final se va el aviso); al aceptar se copia el texto tal cual',
    v5b.n0 >= 4 && v5b.n1 === v5b.n0 - 1 && /corchetes/.test(v5b.asked) && v5b.bloqueado && new RegExp('escribió ' + v5b.n1 + ' dato').test(v5b.warn1) && v5b.warnFin === 'none' && v5b.copiado, JSON.stringify(v5b));

  // ── V6: la IA falla → borrador con aviso, sin perder nada ──
  aiMode = 'fail';
  const v6 = await page.evaluate(async () => {
    const k = pid(patients[0]); const alerts0 = window.__alerts.length;
    generarNotaIA();
    for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); const w = document.getElementById('plne-warn'); if (w && w.style.display !== 'none' && /no respondió/.test(w.textContent)) break; }
    const txt = document.getElementById('plne-out-text').textContent; const draft = _plneBuild(patients[0], getNote(k));
    return { warn: document.getElementById('plne-warn').textContent, title: document.getElementById('plne-out-title').textContent, draftEq: txt.split('\n').slice(2).join('\n') === draft.split('\n').slice(2).join('\n'), hist: (getNote(k).checklist.nota_hist || []).length, alerts: window.__alerts.length - alerts0, btn: document.getElementById('plne-aibtn').disabled };
  });
  check('V6 si la IA falla (HTTP 500): se muestra el borrador estructurado con aviso amarillo, sin alert, sin agregar a notas previas y con el botón 🤖 habilitado para reintentar',
    /no respondió/.test(v6.warn) && /HTTP 500/.test(v6.warn) && /Borrador sin IA/.test(v6.title) && v6.draftEq && v6.hist === 1 && v6.alerts === 0 && v6.btn === false && aiBodies.length === 2, JSON.stringify(v6));

  // ── V7: ↗ Pasar a la página de notas + configuración ──
  const v7 = await page.evaluate(async () => {
    const k = pid(patients[0]); const p0 = window.__prompts.length;
    window.__promptAnswer = 'https://notas.hospital.test/evolucion';
    pasarNotaAPagina();
    await new Promise(r => setTimeout(r, 400));
    const cfg1 = JSON.parse(localStorage.getItem('hgl-worker-config'));
    window.__promptAnswer = 'https://otra.test';   // no debe volver a preguntar
    pasarNotaAPagina();
    await new Promise(r => setTimeout(r, 400));
    const txt = document.getElementById('plne-out-text').textContent;
    openConfigModal(); const inputVal = document.getElementById('notes-url-input').value;
    document.getElementById('notes-url-input').value = 'https://notas.hospital.test/v2'; saveConfig();
    const cfg2 = JSON.parse(localStorage.getItem('hgl-worker-config'));
    document.getElementById('config-modal').style.display = 'none';
    window.__openFail = true; pasarNotaAPagina(); await new Promise(r => setTimeout(r, 200)); window.__openFail = false;
    const lastAlert = window.__alerts[window.__alerts.length - 1] || '';
    return { prompts: window.__prompts.length - p0, cfg1, opened: window.__opened.slice(), clip: window.__clip.map(t => t.length), clipEq: window.__clip[window.__clip.length - 1] === txt, hist: (getNote(k).checklist.nota_hist || []).map(h => h.ia), inputVal, cfg2, lastAlert };
  });
  const cfgPosted = calls.some(c => c.m === 'POST' && /\/rest\/v1\/config/.test(c.url) && JSON.stringify(c.body || {}).includes('notas.hospital.test/evolucion') && JSON.stringify(c.body || {}).includes('mock.local/worker'));
  check('V7 ↗ Pasar a la página: pide la dirección una sola vez, la guarda en configuración (local + nube sin pisar el worker), abre la página y copia la nota; la copia queda en notas previas una vez; ⚙️ Configuración muestra y guarda la dirección; si el navegador bloquea la ventana avisa que ya está copiada',
    v7.prompts === 1 && v7.cfg1.notes_url === 'https://notas.hospital.test/evolucion' && v7.cfg1.url === 'https://mock.local/worker' && v7.cfg1.token === 'tok'
    && v7.opened.length === 3 && v7.opened[0] === 'https://notas.hospital.test/evolucion' && v7.opened[1] === 'https://notas.hospital.test/evolucion' && v7.opened[2] === 'https://notas.hospital.test/v2'
    && v7.clip.length === 3 && v7.clipEq && v7.hist.length === 2 && v7.hist[0] === true && v7.hist[1] === false
    && v7.inputVal === 'https://notas.hospital.test/evolucion' && v7.cfg2.notes_url === 'https://notas.hospital.test/v2' && v7.cfg2.url === 'https://mock.local/worker' && v7.cfg2.token === 'tok'
    && /ya está copiada/.test(v7.lastAlert) && cfgPosted, JSON.stringify({ v7, cfgPosted }));

  // ── V8: notas previas (máx. 10) y ✏️ Editar ──
  aiMode = 'ok';
  const v8 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    const nd = getNote(k); nd.checklist.nota_hist = Array.from({ length: 10 }, (_, i) => ({ ts: new Date(Date.now() - (20 - i) * 60000).toISOString(), by: 'XX', ia: i % 2 === 0, txt: 'NOTA VIEJA ' + i })); noteData[k] = nd; _saveNoteNow(k, nd);
    generarNotaIA();
    for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 100)); if (/redactada con IA/.test(document.getElementById('plne-out-title').textContent)) break; }
    const h = getNote(k).checklist.nota_hist;
    const sel = document.getElementById('plne-hist'); const nOpts = sel.options.length; const firstOpt = sel.options[1].textContent;
    verNotaPrevia(String(h.length - 2));
    const shown = document.getElementById('plne-out-text').textContent; const selVal = sel.value;
    toggleEditarNota();
    const editable = document.getElementById('plne-out-text').contentEditable; const btnTxt = document.getElementById('plne-editbtn').textContent;
    document.getElementById('plne-out-text').textContent = 'NOTA CORREGIDA A MANO';
    toggleEditarNota();
    const editable2 = document.getElementById('plne-out-text').contentEditable;
    copyNotaEvo(); await new Promise(r => setTimeout(r, 200));
    const h2 = getNote(k).checklist.nota_hist;
    closeNotaEvo();
    return { n: h.length, first: h[0].txt, last: h[h.length - 1].ia, nOpts, firstOpt, shown, selVal, editable, btnTxt, editable2, copied: window.__clip[window.__clip.length - 1], h2n: h2.length, h2last: h2[h2.length - 1].txt, closed: !document.getElementById('plne-back').classList.contains('show') };
  });
  check('V8 notas previas: máximo 10 (se descarta la más vieja), selector con una opción por nota (la más reciente primero, con IA e iniciales), ver una anterior la muestra, ✏️ Editar habilita la corrección y lo copiado es el texto corregido (queda en notas previas)',
    v8.n === 10 && v8.first === 'NOTA VIEJA 1' && v8.last === true && v8.nOpts === 11 && /· IA · GF/.test(v8.firstOpt) && v8.shown === 'NOTA VIEJA 9' && v8.selVal === '8'
    && v8.editable === 'true' && /Listo/.test(v8.btnTxt) && v8.editable2 === 'false' && v8.copied === 'NOTA CORREGIDA A MANO' && v8.h2n === 10 && v8.h2last === 'NOTA CORREGIDA A MANO' && v8.closed, JSON.stringify(v8));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-VP: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
