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
async function mkPage(browser, calls, opts){
  const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url().replace(/^https?:\/\/[^/]+/,''); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/no_olvidar')) {
      if (m==='GET') return json(200, (opts && opts.noOlvidarRows) || []);
      if (m==='POST') return json(201, [{ id: 101, ...body }]);
      return route.fulfill({ status:204, body:'' });
    }
    if (url.startsWith('/rest/v1/procedimientos_dia')) {
      if (m==='GET') return json(200, []);
      if (m==='POST') return json(201, [{ id: 'proc-uuid-1', ...body }]);
      return route.fulfill({ status:204, body:'' });
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  if (opts && opts.seed) await page.addInitScript(opts.seed);
  await page.goto('http://127.0.0.1:8771/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  return { page, errors };
}
(async()=>{
  const browser=await chromium.launch();
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  const calls=[];
  const { page, errors } = await mkPage(browser, calls);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));
  const setOnline=(v)=>page.evaluate((v)=>{ Object.defineProperty(navigator, 'onLine', { get: () => v, configurable: true }); }, v);

  // ── Sin red: crear recordatorio, marcarlo hecho, crear procedimiento, toggle/borrar sobre ids reales ──
  calls.length=0;
  await setOnline(false);
  const off = await page.evaluate(()=>{
    renderNoOlvidar(); document.getElementById('no-olvidar-input').value='Pedir TAC de control';
    addNoOlvidar();
    const items=lsGetNoOlvidar(); const t=items[0];
    toggleNoOlvidar(t.id); // temp → solo local
    ['pf-cama','pf-exp','pf-nombre','pf-edad','pf-dx','pf-adscrito','pf-residente'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('pf-nombre').value='PACIENTE PRUEBA'; document.getElementById('pf-cama').value='3-101'; document.getElementById('pf-dx').value='APENDICITIS';
    _procEditIdx=-1; saveProcModal();
    supaToggleNoOlvidar(55, true); supaRemoveNoOlvidar(55);
    const q=outboxLoad();
    return { tempId: t.id, isTemp: !!t._tempId && t.id<0, done: lsGetNoOlvidar()[0].done, procs: procedimientos.length, procTemp: !!procedimientos[procedimientos.length-1]._tempId,
             keys: q.map(i=>i.type+':'+i.key) };
  });
  check('M1 sin red: recordatorio local con id temporal y hecho=true; procedimiento local con _tempId',
    off.isTemp && off.done===true && off.procs>=1 && off.procTemp, JSON.stringify(off));
  check('M2 sin red: outbox con insert de recordatorio, insert de procedimiento y delete del id 55 (el patch del 55 se canceló)',
    off.keys.includes('rest:no_olvidar|insert|'+off.tempId) && off.keys.some(k=>k.startsWith('rest:proc|insert|')) && off.keys.includes('rest:no_olvidar|delete|55') && !off.keys.includes('rest:no_olvidar|patch|55'),
    JSON.stringify(off.keys));
  check('M3 sin red: ninguna llamada REST de escritura', !calls.some(c=>c.m!=='GET'), JSON.stringify(calls.map(c=>c.m+' '+c.url)));

  // ── Vuelve la red: flush ──
  await setOnline(true);
  await page.evaluate(async()=>{ await flushOutbox(); });
  await page.waitForTimeout(800);
  const postNO = calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/no_olvidar'));
  const postPR = calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/procedimientos_dia'));
  const del55 = calls.find(c=>c.m==='DELETE' && c.url.includes('no_olvidar?id=eq.55'));
  const patch55 = calls.find(c=>c.m==='PATCH' && c.url.includes('id=eq.55'));
  const after = await page.evaluate(()=>({ items: lsGetNoOlvidar().map(i=>({ id:i.id, temp:!!i._tempId, done:i.done, texto:i.texto })), proc: procedimientos[procedimientos.length-1], q: outboxLoad().length }));
  check('M4 con red: POST del recordatorio con el estado MÁS reciente (hecho=true) y texto; id real 101 asignado, sin _tempId',
    !!postNO && postNO.body.texto==='Pedir TAC de control' && postNO.body.done===true && after.items[0].id===101 && !after.items[0].temp, JSON.stringify({ postNO: postNO&&postNO.body, items: after.items }));
  check('M5 con red: POST del procedimiento y _id asignado; DELETE del 55 ejecutado; sin PATCH del 55; cola vacía',
    !!postPR && postPR.body.nombre==='PACIENTE PRUEBA' && after.proc._id==='proc-uuid-1' && !after.proc._tempId && !!del55 && !patch55 && after.q===0, JSON.stringify({ postPR: !!postPR, proc: after.proc, del55: !!del55, patch55: !!patch55, q: after.q }));

  // ── Sin red: crear y borrar antes de subir → la inserción pendiente se cancela ──
  calls.length=0;
  await setOnline(false);
  const cancel = await page.evaluate(()=>{
    renderNoOlvidar(); document.getElementById('no-olvidar-input').value='Se borra antes de subir';
    addNoOlvidar(); const t=lsGetNoOlvidar()[0]; const before=outboxLoad().some(i=>i.key==='no_olvidar|insert|'+t.id);
    deleteNoOlvidar(t.id); const afterQ=outboxLoad().some(i=>i.key==='no_olvidar|insert|'+t.id);
    const n=procedimientos.length; document.getElementById('pf-nombre').value='PROC BORRADO'; _procEditIdx=-1; saveProcModal();
    const pr=procedimientos[procedimientos.length-1]; const pb=outboxLoad().some(i=>i.key==='proc|insert|'+pr._tempId);
    deleteProc(procedimientos.length-1); const pa=outboxLoad().some(i=>i.key==='proc|insert|'+pr._tempId);
    return { before, afterQ, pb, pa, procsBack: procedimientos.length===n };
  });
  await setOnline(true);
  check('M6 sin red: borrar un recordatorio/procedimiento que nunca subió cancela su inserción pendiente',
    cancel.before && !cancel.afterQ && cancel.pb && !cancel.pa && cancel.procsBack, JSON.stringify(cancel));

  // ── Recarga con un recordatorio creado sin red: la carga desde la nube NO lo borra y se re-encola ──
  const calls2=[];
  const seed = `localStorage.setItem('pl_no_olvidar_v1', JSON.stringify([{ id:-999, _tempId:true, texto:'Creado sin red antes de recargar', author:'Tester', fecha:'2026-10-09', done:false }]));`;
  const { page: page2, errors: errors2 } = await mkPage(browser, calls2, { seed, noOlvidarRows: [{ id: 7, texto:'De la nube', author:'Otro', fecha:'2026-10-09', done:false }] });
  await page2.waitForTimeout(1500);
  const st2 = await page2.evaluate(async()=>{ const pre=lsGetNoOlvidar().map(i=>i.id); const q=outboxLoad().map(i=>i.key); await flushOutbox(); return { pre, q, post: lsGetNoOlvidar().map(i=>({ id:i.id, texto:i.texto })) }; });
  const postNO2 = calls2.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/no_olvidar'));
  check('M7 recarga: el temporal sobrevive a la carga desde la nube, se re-encola y sube (id real 101) junto al de la nube (7)',
    st2.pre.includes(-999) && st2.pre.includes(7) && st2.q.includes('no_olvidar|insert|-999') && !!postNO2 && postNO2.body.texto==='Creado sin red antes de recargar'
    && st2.post.some(i=>i.id===101) && st2.post.some(i=>i.id===7) && !st2.post.some(i=>i.id===-999), JSON.stringify({ st2, postNO2: !!postNO2 }));
  check('M7b recarga: sin errores no capturados', errors2.length===0, errors2.join(' | '));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-MISC: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
