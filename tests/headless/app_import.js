const { chromium } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={
    getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }),
    onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
    refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }),
    signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }),
    signOut: async()=>({ error:null }),
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
(async()=>{
  const browser=await chromium.launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  const calls=[];
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url().replace(/^https?:\/\/[^/]+/,''); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body, t: Date.now() });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/archive')) {
      if (m==='GET') return json(200, [{ id:'cloud-arc-1', patient_data:{ cama:'3-900', exp:'900', nombre:'CLOUD ARCH' }, note_data:{ pendientes:'de la nube' }, archived_at:'2026-10-01T10:00:00+00:00', archived_by:'x' }]);
      if (m==='POST') return json(201, [{ id:'arc-'+calls.length }]);
      return route.fulfill({ status:204, body:'' });
    }
    if (url.startsWith('/rest/v1/patients')) {
      if (m==='GET') { if (url.includes('exp=eq.4') && url.includes('cama=eq.3-104')) return json(200, [{ id:'d1' }]); return json(200, []); }
      if (m==='POST') return json(201, [{ id:'new-'+((body&&body.exp)||'x') }]);
      if (m==='PATCH') { const id=(url.match(/id=eq\.([^&]+)/)||[])[1]; return json(200, [{ id }]); }
      if (m==='DELETE') return route.fulfill({ status:204, body:'' });
    }
    if (url.startsWith('/rest/v1/notes') && m==='POST') return json(201, [{ patient_id:'x' }]);
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto('http://127.0.0.1:8771/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));

  // ── helpers de normalización ──
  const h=await page.evaluate(()=>({ k: importKeyNorm(' 3.183  x '), id: importIdentityKey({ exp:' 7 ', cama:'3.1' }), ext: isNonCensableBed('EXT'), bed: isNonCensableBed('3-101') }));
  check('T1 importKeyNorm/importIdentityKey/isNonCensableBed', h.k==='3-183 X' && h.id==='pt-7-3-1' && h.ext===true && h.bed===false, JSON.stringify(h));

  // ── papelera: cargar desde nube usa archived_at ──
  const added=await page.evaluate(async()=>{ archivados=[]; _persistArchivados(); const n=await loadArchiveFromSupabase(); return { n, at: archivados[0] && archivados[0]._archivedAt, exp: archivados[0] && archivados[0].exp }; });
  const arcGet=calls.find(c=>c.m==='GET' && c.url.startsWith('/rest/v1/archive'));
  check('T2 papelera GET ordena por archived_at y mapea _archivedAt', !!arcGet && arcGet.url.includes('order=archived_at.desc') && added.n===1 && added.at==='2026-10-01T10:00:00+00:00' && added.exp==='900', JSON.stringify({ url: arcGet&&arcGet.url, added }));
  await page.evaluate(()=>{ archivados=[]; _persistArchivados(); });

  // ── censo semilla ──
  await page.evaluate(()=>{
    patients=[
      { cama:'3-101', exp:'1', nombre:'A UNO', esp:'CG', _supa_id:'a1' },
      { cama:'3-102', exp:'2', nombre:'B DOS', esp:'CG', _supa_id:'b1' },
      { cama:'3-103', exp:'3', nombre:'C TRES', esp:'CG', _supa_id:'c1' },
      { cama:'3-104', exp:'4', nombre:'D CUATRO', esp:'CG' },
      { cama:'3-105', exp:'5', nombre:'E CINCO', esp:'CG', _supa_id:'e1' },
      { cama:'3-106', exp:'6', nombre:'F SEIS', esp:'CG', _supa_id:'f1' },
    ];
    patients.forEach(p=>{ const k=pid(p); noteData[k]={ ...defaultData(), pendientes:'nota '+p.nombre.split(' ')[0] }; lsSaveNote(k, noteData[k]); });
    lsSavePatients(patients);
  });

  // ── egreso en línea ──
  calls.length=0;
  await page.evaluate(()=>{ dischargePatient(pid(patients.find(p=>p.exp==='5'))); });
  await page.waitForTimeout(1500);
  const arcPostE=calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/archive'));
  const delE=calls.find(c=>c.m==='DELETE' && c.url.includes('/rest/v1/patients') && c.url.includes('id=eq.e1'));
  const stE=await page.evaluate(()=>({ inCenso: patients.some(p=>p.exp==='5'), arc: archivados.find(a=>a.exp==='5'), note: !!noteData['su-e1'], ls: localStorage.getItem(NOTES_PREFIX+'su-e1') }));
  check('T3 egreso: POST archive con nota + etiqueta, DELETE del paciente, fuera del censo local',
    !!arcPostE && arcPostE.body.patient_data.exp==='5' && arcPostE.body.note_data.pendientes==='nota E' && arcPostE.body.note_data._egreso==='EGRESO'
    && !!delE && !stE.inCenso && stE.arc && stE.arc._supaArchiveId && stE.arc._note.pendientes==='nota E' && !stE.note && stE.ls===null,
    JSON.stringify({ arcPostE: arcPostE&&arcPostE.body, delE: !!delE, stE }));
  check('T3b egreso: no reescribe el resto del censo (sin PATCH a otros pacientes)', !calls.some(c=>c.m==='PATCH' && c.url.includes('/rest/v1/patients')), JSON.stringify(calls.map(c=>c.m+' '+c.url)));

  // ── egreso sin red → outbox → flush ──
  calls.length=0;
  await page.evaluate(()=>{ Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }); dischargePatient(pid(patients.find(p=>p.exp==='6'))); });
  await page.waitForTimeout(600);
  const qOff=await page.evaluate(()=>outboxLoad().map(i=>i.type+':'+i.key));
  check('T4 egreso sin red: archive + delete_patient encolados, sin llamadas de red',
    qOff.includes('archive:su-f1') && qOff.includes('delete_patient:f1') && !calls.some(c=>c.url.startsWith('/rest/v1/archive') || c.url.includes('id=eq.f1')), JSON.stringify({ qOff, calls: calls.map(c=>c.m+' '+c.url) }));
  await page.evaluate(async()=>{ Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }); await flushOutbox(); });
  await page.waitForTimeout(500);
  const arcPostF=calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/archive') && c.body && c.body.patient_data && c.body.patient_data.exp==='6');
  const delF=calls.find(c=>c.m==='DELETE' && c.url.includes('id=eq.f1'));
  const stF=await page.evaluate(()=>({ q: outboxLoad().length, arc: (archivados.find(a=>a.exp==='6')||{})._supaArchiveId }));
  check('T4b al volver la red: flushOutbox archiva y borra; cola vacía; _supaArchiveId asignado', !!arcPostF && arcPostF.body.note_data.pendientes==='nota F' && !!delF && stF.q===0 && !!stF.arc, JSON.stringify({ arcPostF: !!arcPostF, delF: !!delF, stF }));

  // ── import: actualizado (A), cambio de cama (D sin _supa_id), reemplazo (B→N), alta (C) ──
  calls.length=0;
  await page.evaluate(()=>{
    const C=patients.find(p=>p.exp==='3'), B=patients.find(p=>p.exp==='2'), D=patients.find(p=>p.exp==='4');
    pendingImport={
      samePts:[{ cama:'3-101', exp:'1', nombre:'A UNO', esp:'CG', dx:'DX A' }],
      movedPts:[{ newPt:{ cama:'3-107', exp:'4', nombre:'D CUATRO', esp:'CG' }, oldPt:D }],
      changedPts:[{ newPt:{ cama:'3-102', exp:'7', nombre:'N NUEVO', esp:'CG' }, oldPt:B }],
      newPts:[], otherPts:[], otherPtsChecked:[],
      missingPts:[C], dispositions:{ [pid(C)]:'alta' }, autoDetected:{},
      altasFromExcel:[], defuncionesFromExcel:[], procedimientosFromExcel:[],
      candidatesCG:[], candidatesCgChecked:[], reingresoPts:[], reingresoPtsChecked:[], importLog:[]
    };
    confirmImport();
  });
  await page.waitForTimeout(3500);
  const arcB=calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/archive') && c.body.patient_data.exp==='2');
  const arcC=calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/archive') && c.body.patient_data.exp==='3');
  const delB=calls.find(c=>c.m==='DELETE' && c.url.includes('id=eq.b1'));
  const delC=calls.find(c=>c.m==='DELETE' && c.url.includes('id=eq.c1'));
  check('T5 import: B (reemplazado) y C (alta) van a la papelera con su nota y etiqueta ANTES del DELETE',
    !!arcB && arcB.body.note_data.pendientes==='nota B' && /FUERA DE CENSO/.test(arcB.body.note_data._egreso)
    && !!arcC && arcC.body.note_data.pendientes==='nota C' && arcC.body.note_data._egreso==='ALTA MÉDICA'
    && !!delB && !!delC && arcB.t<=delB.t && arcC.t<=delC.t,
    JSON.stringify({ arcB: arcB&&arcB.body.note_data, arcC: arcC&&arcC.body.note_data, delB: !!delB, delC: !!delC }));
  const lastDel=Math.max(...calls.filter(c=>c.m==='DELETE').map(c=>c.t));
  const writes=calls.filter(c=>(c.m==='POST'||c.m==='PATCH') && c.url.startsWith('/rest/v1/patients'));
  check('T5b import: el guardado del censo (POST/PATCH patients) ocurre DESPUÉS de los DELETE', writes.length>0 && writes.every(c=>c.t>=lastDel), JSON.stringify({ lastDel, writes: writes.map(c=>c.m+' '+c.url+' '+c.t) }));
  const lookupD=calls.find(c=>c.m==='GET' && c.url.includes('exp=eq.4') && c.url.includes('cama=eq.3-104'));
  const patchD=calls.find(c=>c.m==='PATCH' && c.url.includes('id=eq.d1'));
  const stImp=await page.evaluate(()=>({
    n: patients.length, exps: patients.map(p=>p.exp).sort().join(','),
    dSupa: (patients.find(p=>p.exp==='4')||{})._supa_id, dNote: (noteData['su-d1']||{}).pendientes, dCama: (patients.find(p=>p.exp==='4')||{}).cama,
    nSupa: (patients.find(p=>p.exp==='7')||{})._supa_id,
    hasB: !!noteData['su-b1'], hasC: !!noteData['su-c1'], lsB: localStorage.getItem(NOTES_PREFIX+'su-b1'),
    arcExps: archivados.map(a=>a.exp).sort().join(',')
  }));
  check('T5c import: D cambia de cama por PATCH sobre la fila existente (re-enlace exp+cama → id) y conserva su nota',
    !!lookupD && !!patchD && patchD.body.cama==='3-107' && stImp.dSupa==='d1' && stImp.dNote==='nota D' && stImp.dCama==='3-107'
    && !calls.some(c=>c.m==='DELETE' && c.url.includes('cama=eq.3-104')),
    JSON.stringify({ lookupD: !!lookupD, patchD: patchD&&patchD.body, stImp }));
  check('T5d import: censo final = A, D, N; N insertado; B y C fuera (sin nota local, en papelera)',
    stImp.n===3 && stImp.exps==='1,4,7' && stImp.nSupa==='new-7' && !stImp.hasB && !stImp.hasC && stImp.lsB===null && stImp.arcExps==='2,3,5,6', JSON.stringify(stImp));

  // ── restaurar desde la papelera ──
  calls.length=0;
  await page.evaluate(()=>{ const idx=archivados.findIndex(a=>a.exp==='3'); restorePatient(idx); });
  await page.waitForTimeout(2500);
  const stRes=await page.evaluate(()=>({ p: patients.find(p=>p.exp==='3'), note: noteData['su-new-3'], arcHas: archivados.some(a=>a.exp==='3') }));
  const postRes=calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/patients') && c.body && c.body.exp==='3');
  const delArc=calls.find(c=>c.m==='DELETE' && c.url.startsWith('/rest/v1/archive'));
  check('T6 restaurar: vuelve al censo con fila nueva, nota intacta sin etiqueta de egreso, registro de archive borrado',
    !!postRes && stRes.p && stRes.p._supa_id==='new-3' && stRes.note && stRes.note.pendientes==='nota C' && !stRes.note._egreso && !stRes.arcHas && !!delArc,
    JSON.stringify({ postRes: !!postRes, stRes, delArc: !!delArc }));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-IMPORT: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
