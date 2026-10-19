const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
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
const REMOTE_NOTE = { patient_id:'a1', app:'APP REMOTO', pa:'', drenajes:'DREN REMOTO', qx:'', manejo:'M1', sangrado:'', sv:'', balance:'', pendientes:'PEND REMOTO', entrega:'', checklist:{ npo:false, atb:true, atb_nombre:'CEFTRIAXONA' }, lab_history:[], imagen_history:[] };
(async()=>{
  const browser=await launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  const calls=[];
  const ctl = { slowNotesPost: 0, failNotesPostOnce: false, notesPostCount: 0 };
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url().replace(/^https?:\/\/[^/]+/,''); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body, t: Date.now() });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m==='GET') {
        if (url.includes('id=eq.')) return json(200, url.includes('id=eq.a1') ? [{ id:'a1' }] : []);
        return json(200, [{ id:'a1', cama:'3-101', exp:'1', nombre:'PACIENTE UNO', esp:'CG', estado:'ESTABLE' }]);
      }
      return json(200, [{ id:'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) {
      if (m==='GET') return json(200, [REMOTE_NOTE]);
      ctl.notesPostCount++;
      if (ctl.failNotesPostOnce) { ctl.failNotesPostOnce=false; return json(500, { message:'boom' }); }
      if (ctl.slowNotesPost) await new Promise(r=>setTimeout(r, ctl.slowNotesPost));
      return json(201, [{ patient_id:'a1' }]);
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto(BASE_URL + '/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));
  const notePosts = () => calls.filter(c=>c.m==='POST' && c.url.startsWith('/rest/v1/notes')).map(c=>Object.keys(c.body||{}).sort());

  // ── S1: línea base + diff: sin campos sucios solo viajan las columnas que cambiaron ──
  const s1 = await page.evaluate(()=>({ base: !!_noteBaseline['a1'], pend: noteData[pid(patients[0])].pendientes, basePend: _noteBaseline['a1'] && _noteBaseline['a1'].pendientes }));
  check('S1 al cargar, la fila remota queda como línea base', s1.base && s1.pend==='PEND REMOTO' && s1.basePend==='PEND REMOTO', JSON.stringify(s1));
  calls.length=0;
  await page.evaluate(()=>{ const k=pid(patients[0]); toggleChecklist(k, 'npo'); });
  await page.waitForTimeout(900);
  const s1b = notePosts();
  check('S1b toggle de checklist: POST solo con checklist (sin pendientes/manejo/lab_history)', s1b.length===1 && s1b[0].includes('checklist') && !s1b[0].includes('pendientes') && !s1b[0].includes('manejo') && !s1b[0].includes('lab_history'), JSON.stringify(s1b));
  calls.length=0;
  const s1c = await page.evaluate(async()=>{ const k=pid(patients[0]); const nd=noteData[k]; nd.manejo='M2 LOCAL'; const r=await supaUpsertNote('a1', nd, null); const r2=await supaUpsertNote('a1', nd, null); return { r: r!==null, r2: r2===true, base: _noteBaseline['a1'].manejo }; });
  const s1cPosts = notePosts();
  check('S1c guardado "completo" sin dirty: solo manejo (diff vs base); repetirlo sin cambios no hace red', s1c.r && s1c.r2 && s1cPosts.length===1 && s1cPosts[0].includes('manejo') && !s1cPosts[0].includes('pendientes') && s1c.base==='M2 LOCAL', JSON.stringify({ s1c, s1cPosts }));

  // ── S2: campos en vuelo: ocultar la app durante el push conserva el campo sucio; lo encolado antes del push exitoso se descarta ──
  calls.length=0; ctl.slowNotesPost = 1500;
  await page.evaluate(()=>{ const k=pid(patients[0]); const ta=document.querySelector('textarea[data-key][data-field="drenajes"]'); ta.value='DREN NUEVO'; ta.dispatchEvent(new Event('input',{bubbles:true})); });
  await page.waitForTimeout(1700); // autosave 900 + push 500 → POST en vuelo (lento 1500)
  const s2 = await page.evaluate(()=>{
    const k=pid(patients[0]);
    const inflight = !!_inflightDirty[k] && _inflightDirty[k].has('drenajes');
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const q = outboxLoad().filter(i=>i.type==='note' && i.key===k);
    // recarga desde la nube con el valor viejo mientras el push sigue en vuelo
    _applyLoadedNotes({ [k]: Object.assign(migrateNote(defaultData()), { drenajes:'DREN REMOTO', pendientes:'PEND REMOTO' }) });
    return { inflight, queued: q.length, dirty: q.length ? q[0].dirty : null, local: noteData[k].drenajes };
  });
  check('S2 push en vuelo: el ítem encolado lleva el campo sucio y la recarga no pisa el valor local', s2.inflight && s2.queued===1 && Array.isArray(s2.dirty) && s2.dirty.includes('drenajes') && s2.local==='DREN NUEVO', JSON.stringify(s2));
  await page.waitForTimeout(2200);
  const s2b = await page.evaluate(()=>{ Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); const k=pid(patients[0]); return { q: outboxLoad().filter(i=>i.type==='note' && i.key===k).length, inflight: !!_inflightDirty[k] }; });
  check('S2b al terminar el push con éxito, lo encolado antes se descarta (no reproduce texto viejo)', s2b.q===0 && !s2b.inflight, JSON.stringify(s2b));
  ctl.slowNotesPost = 0;

  // ── S3: el outbox reintenta un upsert que falló (antes un solo 500 dejaba el ítem "fallido") ──
  calls.length=0; ctl.notesPostCount=0; ctl.failNotesPostOnce=true;
  const s3 = await page.evaluate(async()=>{ const k=pid(patients[0]); noteData[k].pendientes='PEND OUTBOX'; outboxEnqueue({ type:'note', key:k, data: migrateNote(noteData[k]), dirty:['pendientes'] }); await flushOutbox(); return { q: outboxLoad().length }; });
  check('S3 outbox: reintento tras 500 y cola vacía', s3.q===0 && ctl.notesPostCount>=2, JSON.stringify({ s3, posts: ctl.notesPostCount }));

  // ── S4: una carga fallida (sin lista remota) NO sube todas las notas locales ──
  calls.length=0;
  const s4 = await page.evaluate(async()=>{ const a=await recoverPendingNoteSync([]); const b=await recoverPendingNoteSync(); return { a, b }; });
  check('S4 recoverPendingNoteSync sin lista remota: cero POST (sin push masivo)', notePosts().length===0 && s4.a.synced===0 && s4.b.synced===0, JSON.stringify({ posts: notePosts(), s4 }));

  // ── S5: modal de edición abierto mientras otro dispositivo cambia pendientes → al guardar solo el estado, no se pisa ──
  await page.evaluate(()=>{ try { _suppressRealtimeKeys.clear(); } catch(_){} });
  calls.length=0;
  const s5 = await page.evaluate(async()=>{
    const k=pid(patients[0]);
    openEditModal(k);
    handleNoteChange({ eventType:'UPDATE', new: { patient_id:'a1', app:'APP REMOTO', pa:'', drenajes:'DREN NUEVO', qx:'', manejo:'M2 LOCAL', sangrado:'', sv:'', balance:'', pendientes:'PEND DE B', checklist:{ npo:true }, lab_history:[], imagen_history:[] } });
    _setEstadoPill('GRAVE');
    saveModal();
    await new Promise(r=>setTimeout(r, 900));
    return { pend: noteData[k].pendientes, estado: patients[0].estado, modalOpen: document.getElementById('patient-modal').style.display };
  });
  const s5Posts = notePosts();
  const s5Patch = calls.find(c=>c.m==='PATCH' && c.url.includes('/rest/v1/patients') && c.body && c.body.estado==='GRAVE');
  check('S5 modal: pendientes de B sobrevive (no se reescribe) y el estado sí se guarda', s5.pend==='PEND DE B' && !!s5Patch && !s5Posts.some(keys=>keys.includes('pendientes')) && s5.modalOpen==='none', JSON.stringify({ s5, s5Posts, patch: !!s5Patch }));

  // ── S6: texto escrito en el modal y "Cancelar" → se sube igual (la tarjeta ya lo muestra) ──
  calls.length=0;
  const s6 = await page.evaluate(async()=>{ const k=pid(patients[0]); openEditModal(k); liveModalNote('pendientes','ESCRITO EN MODAL Y CANCELADO'); closeModal(); await new Promise(r=>setTimeout(r, 900)); return { pend: noteData[k].pendientes, dirty: _dirtyFields[k] ? _dirtyFields[k].size : 0 }; });
  const s6Post = calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body.pendientes==='ESCRITO EN MODAL Y CANCELADO');
  check('S6 closeModal con texto sucio: POST parcial con pendientes', !!s6Post && !('manejo' in s6Post.body) && s6.pend==='ESCRITO EN MODAL Y CANCELADO', JSON.stringify({ s6, post: s6Post && Object.keys(s6Post.body) }));

  // ── S7: labs en mg/dL, snapshot con sangre, manual_keys ──
  const s7 = await page.evaluate(()=>{
    const crit76 = getCriticalLabItemsFromSnapshot({ fecha:'2026-10-10', labs:{ ca:'7.60', mg:'1.9', p:'3.1' } }).map(c=>c.key);
    const crit65 = getCriticalLabItemsFromSnapshot({ fecha:'2026-10-10', labs:{ ca:'6.5' } }).map(c=>c.key);
    const latest = getLatestLabSnapshot({ labHistory:[{ fecha:'2026-10-11', labs:{ ego_ph:'6' } }, { fecha:'2026-10-10', labs:{ hb:'6.0' } }] });
    const caDef = (LAB_GROUPS.flatMap(g=>g.fields||[]).find(f=>f.key==='ca')||{});
    const snap = { fecha:'2026-10-10', labs:{ hb:'9' }, source:'winlab' };
    _markManualLabKey(snap, 'lac');
    const mig = migrateNote({ labHistory:[Object.assign({}, snap, { labs:{ hb:'9', lac:'3.2' } })] }).labHistory[0];
    const pn = parseLabNumber('>5000');
    return { crit76, crit65, latestFecha: latest && latest.fecha, caUnit: caDef.unit, mk: mig.manual_keys, pn };
  });
  check('S7 Ca 7.6 mg/dL no es crítico (6.5 sí); último snapshot con sangre; manual_keys sobrevive migrateNote; ">5000" se parsea', s7.crit76.length===0 && s7.crit65.includes('ca') && s7.latestFecha==='2026-10-10' && s7.caUnit==='mg/dL' && Array.isArray(s7.mk) && s7.mk.includes('lac') && s7.pn===5000, JSON.stringify(s7));

  // ── S8: copia local sin recorte a 30 fechas; PDF inline recortado queda marcado ──
  const s8 = await page.evaluate(()=>{
    const hist=[]; for (let i=1;i<=40;i++) hist.push({ fecha:'2026-08-'+String(i%28+1).padStart(2,'0')+(i>28?'x':''), labs:{ hb:String(i) }, source_file: i===3 ? 'data:application/pdf;base64,AAAA' : '', source_storage_path: '' });
    const c = _lsNoteCopy({ labHistory: hist });
    const stripped = c.labHistory.find(s=>s.source_file_stripped);
    return { n: c.labHistory.length, stripped: !!stripped && stripped.source_file==='' };
  });
  check('S8 _lsNoteCopy conserva las 40 fechas y marca el PDF inline recortado', s8.n===40 && s8.stripped, JSON.stringify(s8));

  // ── S9: un DELETE Realtime no se descarta aunque el paciente esté "suprimido" por un guardado propio ──
  const s9 = await page.evaluate(()=>{ suppressKey('a1', 5000); handlePatientChange({ eventType:'DELETE', old:{ id:'a1' }, new:null }); return { n: patients.length }; });
  check('S9 DELETE remoto durante la supresión: el paciente sale del censo (no resucita)', s9.n===0, JSON.stringify(s9));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-SYNC: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
