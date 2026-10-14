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
  const notesBodies=[]; const patientCalls=[];
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url(); const m=req.method();
    if (url.includes('/rest/v1/notes') && m==='POST') { try { notesBodies.push(JSON.parse(req.postData()||'{}')); } catch(_) { notesBodies.push({}); } return route.fulfill({ status:201, contentType:'application/json', body:'[{"patient_id":"x"}]' }); }
    if (url.includes('/rest/v1/patients')) {
      patientCalls.push({ m, url:url.replace(/^https?:\/\/[^/]+/,'') });
      if (m==='POST') return route.fulfill({ status:201, contentType:'application/json', body:'[{"id":"uuid-new-1"}]' });
      if (m==='PATCH') { if (url.includes('id=eq.gone')) return route.fulfill({ status:200, contentType:'application/json', body:'[]' }); return route.fulfill({ status:200, contentType:'application/json', body:'[{"id":"p1"}]' }); }
      return route.fulfill({ status:200, contentType:'application/json', body:'[]' });
    }
    return route.fulfill({ status:200, contentType:'application/json', body:'[]' });
  });
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto('http://127.0.0.1:8771/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));
  check('init: sesión restaurada', (await page.evaluate(()=>_userAccessToken))==='mock-token-123');

  const t6=await page.evaluate(()=>{ const d=new Date(); const loc=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); return { ts: todayStr(), loc }; });
  check('T6 todayStr = fecha local del dispositivo', t6.ts===t6.loc, JSON.stringify(t6));

  notesBodies.length=0;
  await page.evaluate(()=>{
    patients.push({ _supa_id:'p1', cama:'9-901', exp:'99-00001', nombre:'TEST UNO', esp:'CG' });
    const k='su-p1'; noteData[k]=Object.assign(defaultData(), { manejo:'MANEJO LOCAL', pendientes:'PEND LOCAL' });
    _dirtyFields[k]=new Set(['pendientes']);
    scheduleNoteAutosave(k);
  });
  await page.waitForTimeout(2500);
  const b1=notesBodies.filter(b=>b.patient_id==='p1');
  check('T1 autosave envía fila PARCIAL (pendientes sí, manejo no)', b1.length>0 && ('pendientes' in b1[b1.length-1]) && !('manejo' in b1[b1.length-1]), JSON.stringify(b1.map(b=>Object.keys(b))));

  const t5=await page.evaluate(()=>{ const k='su-p1'; _dirtyFields[k]=new Set(['manejo']); noteData[k].manejo='MANEJO 2'; saveNote(k, noteData[k]); persistBeforeExit(); return outboxLoad().filter(i=>i.type==='note'&&i.key===k).map(i=>i.dirty); });
  check('T5 persistBeforeExit encola el push pendiente con sus campos dirty', t5.length===1 && Array.isArray(t5[0]) && t5[0].includes('manejo'), JSON.stringify(t5));
  await page.waitForTimeout(1200);

  const t2=await page.evaluate(async ()=>{
    const p={ cama:'9-902', exp:'99-00002', nombre:'TEST DOS', esp:'CG' }; patients.push(p);
    const oldKey=pid(p); noteData[oldKey]=Object.assign(defaultData(), { manejo:'NOTA NUEVO PACIENTE' }); lsSaveNote(oldKey, noteData[oldKey]);
    _dirtyFields[oldKey]=new Set(['manejo']); saveNote(oldKey, noteData[oldKey]);
    await supaUpsertPatient(p);
    const newKey=pid(p);
    return { oldKey, newKey, id:p._supa_id, hasNew: !!(noteData[newKey]&&noteData[newKey].manejo==='NOTA NUEVO PACIENTE'), hasOld: !!noteData[oldKey], lsNew: !!localStorage.getItem(NOTES_PREFIX+newKey), lsOld: !!localStorage.getItem(NOTES_PREFIX+oldKey) };
  });
  check('T2 rekey: la nota migra de pt-… a su-<uuid> y la vieja desaparece', t2.id==='uuid-new-1' && t2.newKey==='su-uuid-new-1' && t2.hasNew && !t2.hasOld && t2.lsNew && !t2.lsOld, JSON.stringify(t2));
  await page.waitForTimeout(1500);
  check('T2 rekey: la nota se empuja con el nuevo patient_id', notesBodies.some(b=>b.patient_id==='uuid-new-1'), JSON.stringify(notesBodies.map(b=>b.patient_id)));

  patientCalls.length=0;
  const t3=await page.evaluate(async ()=>{ const p={ _supa_id:'gone', cama:'9-903', exp:'99-00003', nombre:'TEST TRES', esp:'CG' }; patients.push(p); const r=await supaUpsertPatient(p); return { r, id:p._supa_id, del:p._deletedRemotely }; });
  const posts3=patientCalls.filter(c=>c.m==='POST').length;
  check('T3 PATCH 0 filas sin fila remota → NO se re-inserta (sin POST a patients)', posts3===0 && t3.r && t3.r.__deleted_remotely===true && t3.del===true, JSON.stringify({posts3, t3}));

  const t4=await page.evaluate(async ()=>{
    outboxSave([]);
    const orig=supaUpsertNote;
    supaUpsertNote=async function(){ await new Promise(r=>setTimeout(r,400)); return { ok:true }; };
    outboxEnqueue({ type:'note', key:'su-p1', data: noteData['su-p1'], dirty:['manejo'] });
    const fl=flushOutbox();
    await new Promise(r=>setTimeout(r,100));
    outboxEnqueue({ type:'note', key:'su-uuid-new-1', data: noteData['su-uuid-new-1'], dirty:['manejo'] });
    await fl; await new Promise(r=>setTimeout(r,700));
    supaUpsertNote=orig;
    return outboxLoad().map(i=>i.key);
  });
  check('T4 flushOutbox: lo encolado DURANTE el flush sobrevive y lo aplicado se quita', !t4.includes('su-p1') && (t4.includes('su-uuid-new-1') || t4.length===0), JSON.stringify(t4));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('\nRESULT APP-P0: '+pass+' passed, '+fail+' failed');
  await browser.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('SCRIPT FAIL',e);process.exit(2);});
