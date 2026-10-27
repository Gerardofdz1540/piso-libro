// Regresiones del censo recibido por Realtime. Red simulada y pacientes ficticios.
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  navigator.serviceWorker.register = () => Promise.resolve({});
  window.prompt=()=> 'Tester'; window.alert=()=>{}; window.confirm=()=>true;
  const session={access_token:'test-token',refresh_token:'r',user:{email:'test@example.com'}};
  const chan={on(){return chan},subscribe(){return chan},unsubscribe(){return Promise.resolve('ok')},send(){return Promise.resolve('ok')}};
  window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),refreshSession:async()=>({data:{session},error:null})},channel:()=>chan,removeChannel:async()=>{},removeAllChannels:async()=>[],getChannels:()=>[]})};
})();`;
const base = (id, extra={}) => ({id,cama:'3-101',exp:'26-10001',nombre:'ANA LOPEZ PRUEBA',esp:'CG',dx:'INICIAL',updated_at:'2026-10-24T10:00:00Z',...extra});
(async()=>{
  const browser=await launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  let rows=[base('a1')], noteDelay=0, gate=null, noteStarted=null, keepaliveStatus=200;
  const calls=[];
  await page.route('**/vendor/supabase*',r=>r.abort());
  await page.route('**/rest/v1/**',async route=>{
    const u=new URL(route.request().url()), m=route.request().method();
    calls.push({path:u.pathname,query:u.search,m});
    const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    if(m!=='GET') return json([]);
    if(u.pathname.endsWith('/guard_info') && keepaliveStatus!==200) return route.fulfill({status:keepaliveStatus,contentType:'application/json',body:JSON.stringify({message:'Service unavailable'})});
    if(u.pathname.endsWith('/patients')) {
      const id=u.searchParams.get('id');
      return json(rows.filter(r=>!id || id==='eq.'+r.id || id.startsWith('in.')&&id.slice(4,-1).split(',').includes(r.id)));
    }
    if(u.pathname.endsWith('/notes')) {
      const snapshot=rows.map(r=>({patient_id:r.id,pendientes:'NOTA CONSERVADA',checklist:{},lab_history:[],imagen_history:[]}));
      if(noteStarted){noteStarted();noteStarted=null;}
      if(gate) await gate;
      if(noteDelay) await new Promise(r=>setTimeout(r,noteDelay));
      return json(snapshot);
    }
    return json([]);
  });
  await page.addInitScript(MOCK);
  await page.goto(BASE_URL+'/index.html',{waitUntil:'load'});
  await page.waitForFunction(()=>patients.length===1 && !_rtPatientLoads.size);
  let passed=0,failed=0;
  const check=(name,ok,detail)=>{if(ok){passed++;console.log('PASS '+name)}else{failed++;console.log('FAIL '+name+' '+JSON.stringify(detail))}};
  const prepare=async remote=>{
    rows=remote; noteDelay=0; gate=null;
    await page.evaluate(remote=>{
      _suppressRealtimeKeys.clear(); _suppressRealtimeUntil.clear(); _rtPatientMissed.clear();
      patients=remote.map(supaRowToPatient); noteData={};
      patients.forEach(p=>{noteData[pid(p)]=migrateNote({pendientes:'NOTA LOCAL'});});
      lsSavePatients(patients); renderViewSoft();
    },remote);
  };

  await prepare([base('a1')]);
  rows=[base('a1',{dx:'CORREGIDO'})];
  await page.evaluate(row=>{suppressKey('a1',100);handlePatientChange({eventType:'UPDATE',new:row});},rows[0]);
  await page.waitForFunction(()=>patients[0]?.dx==='CORREGIDO');
  check('C1 cambio censal durante guardado se recupera sin perder nota',await page.evaluate(()=>noteData[pid(patients[0])].pendientes==='NOTA LOCAL'));

  await prepare([base('a1')]);
  rows=[base('a1',{cama:'3-102'})];
  await page.evaluate(row=>{suppressKey('__all__',100);handlePatientChange({eventType:'UPDATE',new:row});},rows[0]);
  await page.waitForFunction(()=>patients[0]?.cama==='3-102');
  check('C2 supresión global recupera cambio de cama y su nota',await page.evaluate(()=>noteData[pid(patients[0])].pendientes==='NOTA LOCAL'));

  await prepare([base('a1')]);
  rows=[base('a1',{dx:'NUEVO'})];
  await page.evaluate(row=>{suppressKey('a1',50);suppressKey('a1',300);handlePatientChange({eventType:'UPDATE',new:row});},rows[0]);
  await page.waitForTimeout(120);
  check('C3 un temporizador anterior no libera la supresión más reciente',await page.evaluate(()=>_suppressRealtimeKeys.has('a1')&&patients[0].dx==='INICIAL'));
  await page.waitForFunction(()=>patients[0]?.dx==='NUEVO');

  await prepare([]); rows=[base('b1')]; noteDelay=200;
  await page.evaluate(row=>{handlePatientChange({eventType:'INSERT',new:row});handlePatientChange({eventType:'UPDATE',new:{...row,cama:'3-120',dx:'ULTIMO'}});},rows[0]);
  await page.waitForFunction(()=>patients.some(p=>p._supa_id==='b1'));
  check('C4 INSERT lento conserva UPDATE posterior y nota bajo cama vigente',await page.evaluate(()=>patients.length===1&&patients[0].cama==='3-120'&&patients[0].dx==='ULTIMO'&&noteData[pid(patients[0])].pendientes==='NOTA CONSERVADA'));

  await prepare([]); rows=[base('c1')]; noteDelay=200;
  await page.evaluate(row=>{handlePatientChange({eventType:'INSERT',new:row});handlePatientChange({eventType:'DELETE',old:{id:row.id}});},rows[0]);
  await page.waitForTimeout(400);
  check('C5 DELETE mientras llega la nota impide resucitar al paciente',await page.evaluate(()=>patients.length===0&&_rtInsertPending.size===0));

  await prepare([]); rows=[base('d1')];
  await page.evaluate(row=>handlePatientChange({eventType:'UPDATE',new:row}),rows[0]);
  await page.waitForFunction(()=>patients.some(p=>p._supa_id==='d1'));
  check('C6 UPDATE de paciente ausente recupera el ingreso',await page.evaluate(()=>patients.length===1&&noteData[pid(patients[0])].pendientes==='NOTA CONSERVADA'));

  await prepare([base('a1'),base('e1',{cama:'3-110',exp:'26-10002',nombre:'PEDRO PRUEBA'})]);
  let release; gate=new Promise(resolve=>{release=resolve});
  const started=new Promise(resolve=>{noteStarted=resolve});
  await page.evaluate(()=>{window.__censoLoad=supaLoadAll()}); await started;
  await page.evaluate(row=>{handlePatientChange({eventType:'UPDATE',new:{...row,cama:'3-130',dx:'VIGENTE',updated_at:'2026-10-24T11:00:00Z'}});handlePatientChange({eventType:'DELETE',old:{id:'e1'}});},rows[0]);
  gate=null; release();
  const loaded=await page.evaluate(async()=>{const r=await window.__censoLoad;return{pts:r?.patients.map(p=>({id:p._supa_id,cama:p.cama,dx:p.dx})),pending:_rtPatientLoads.size,cached:_rtPatientChanges.size}});
  check('C7 carga lenta no regresa cama ni revive egresado',loaded.pts?.length===1&&loaded.pts[0].cama==='3-130'&&loaded.pts[0].dx==='VIGENTE',loaded);
  check('C8 se libera la memoria de eventos al terminar la carga',loaded.pending===0&&loaded.cached===0,loaded);
  check('C9 sin errores de ejecución',errors.length===0,errors);
  const paused=await page.evaluate(()=>({service:isSupabasePausedError(new Error('GET guard_info HTTP 503')),explicit:isSupabasePausedError(new Error('project is paused'))}));
  check('C10 un HTTP 503 no afirma que el proyecto está pausado',!paused.service&&paused.explicit,paused);
  keepaliveStatus=503;
  const unavailable=await page.evaluate(async()=>({ok:await supaKeepAlive(),label:document.getElementById('sync-label').textContent}));
  check('C11 un keepalive rechazado queda como error de conexión, sin anunciar guardado ni pausa',!unavailable.ok&&unavailable.label.includes('Sin conexión con la base'),unavailable);
  console.log('RESULT APP-CENSO-RT: '+passed+' passed, '+failed+' failed');
  await browser.close(); process.exitCode=failed?1:0;
})().catch(e=>{console.error('CRASH',e);process.exit(2)});
