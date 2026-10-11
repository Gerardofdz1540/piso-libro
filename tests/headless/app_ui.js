const { chromium } = require('playwright');
const MOCK = `(() => {
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
  await page.route('**/supabase-js@*/**', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url().replace(/^https?:\/\/[^/]+/,''); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m==='GET') return json(200, [{ id:'a1', cama:'3-101', exp:'1', nombre:'PACIENTE UNO', esp:'CG' }]);
      return json(200, [{ id:'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m==='GET') return json(200, []); return json(201, [{ patient_id:'a1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto('http://127.0.0.1:8771/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));

  // U1: una sola definición viva de togglePtReminder (la que marca dirty y repinta la tarjeta)
  const u1 = await page.evaluate(()=>{
    const src = togglePtReminder.toString();
    const k = pid(patients[0]);
    const nd = migrateNote(noteData[k] || defaultData()); nd.checklist = nd.checklist || {}; nd.checklist._ptReminders = [{ text:'Retirar sonda', done:false }];
    noteData[k] = nd;
    togglePtReminder(k, 0);
    // El guardado inmediato (_saveNoteNow) marca "checklist" como sucio, lo pasa al push pendiente y lo desmarca al instante
    return { k, hasRerender: src.includes('_rerenderCard'), dirty: Array.from(_dirtyFields[k] || []), pending: Array.from(_pendingDirty[k] || []), done: noteData[k].checklist._ptReminders[0].done };
  });
  check('U1 togglePtReminder: definición única, "checklist" pasa al push pendiente (parcial) sin quedar pegado, repintado y estado cambiado', u1.hasRerender && u1.pending.includes('checklist') && !u1.dirty.includes('checklist') && u1.done===true, JSON.stringify(u1));

  // U2: upsert parcial con solo "checklist" → el cuerpo lleva checklist y NO texto clínico
  calls.length=0;
  const u2 = await page.evaluate(async(k)=>{
    const nd = noteData[k]; nd.manejo = 'texto local que NO debe viajar'; nd.pendientes = 'tampoco';
    const r = await supaUpsertNote('a1', nd, new Set(['checklist']));
    return { ok: r !== null };
  }, u1.k);
  const post = calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/notes'));
  check('U2 upsert parcial: POST con checklist y sin manejo/pendientes', u2.ok && !!post && ('checklist' in post.body) && !('manejo' in post.body) && !('pendientes' in post.body) && ('patient_id' in post.body),
    JSON.stringify(post && Object.keys(post.body)));
  const u2b = await page.evaluate(async(k)=>{ const nd = noteData[k]; return (await supaUpsertNote('a1', nd, new Set(['body_diagram_ant']))) !== null; }, u1.k);
  const post2 = calls.filter(c=>c.m==='POST' && c.url.startsWith('/rest/v1/notes'))[1];
  check('U2b dirty body_diagram_ant → también parcial (checklist)', u2b && !!post2 && ('checklist' in post2.body) && !('manejo' in post2.body), JSON.stringify(post2 && Object.keys(post2.body)));

  // U3: atajos — Ctrl+F / Cmd+P no se capturan; "f" sola sí enfoca la búsqueda
  const u3 = await page.evaluate(()=>{
    document.activeElement && document.activeElement.blur();
    const fire = (init)=>{ const ev = new KeyboardEvent('keydown', Object.assign({ bubbles:true, cancelable:true }, init)); document.dispatchEvent(ev); return ev.defaultPrevented; };
    const ctrlF = fire({ key:'f', ctrlKey:true });
    const cmdP = fire({ key:'p', metaKey:true });
    const plainF = fire({ key:'f' });
    const searchExists = !!document.getElementById('search');
    return { ctrlF, cmdP, plainF, searchExists };
  });
  check('U3 Ctrl+F y Cmd+P pasan al navegador; "f" sola sigue siendo atajo de búsqueda', u3.ctrlF===false && u3.cmdP===false && u3.plainF===true && u3.searchExists, JSON.stringify(u3));

  // ── Ficha para el pase (oct 2026) ──
  const u4 = await page.evaluate(()=>{
    const k = pid(patients[0]);
    const card = () => document.getElementById('card-' + k);
    const vis = (sel) => { const el = card() && card().querySelector(sel); return !!el && getComputedStyle(el).display !== 'none' && !!el.offsetParent; };
    const before = { app: vis('textarea[data-field="app"]'), pa: vis('textarea[data-field="pa"]'), manejo: vis('textarea[data-field="manejo"]'), mode: isPaseMode() };
    togglePaseMode();
    const on = { app: vis('textarea[data-field="app"]'), pa: vis('textarea[data-field="pa"]'), manejo: vis('textarea[data-field="manejo"]'), pend: vis('textarea[data-field="pendientes"]'), mode: isPaseMode(), bodyCls: document.body.classList.contains('pase-mode'), btn: (document.querySelector('#board-nav .bn-mode')||{}).textContent };
    toggleCardFull(k);
    const shown = { app: vis('textarea[data-field="app"]') };
    togglePaseMode();
    return { before, on, shown, after: isPaseMode() };
  });
  check('U4 modo Pase: oculta APP/PA y deja Manejo/Pendientes; "Ver" los muestra en esa tarjeta; se persiste', u4.before.app && !u4.before.mode && u4.on.mode && u4.on.bodyCls && !u4.on.app && !u4.on.pa && u4.on.manejo && u4.on.pend && /Pase/.test(u4.on.btn||'') && u4.shown.app && !u4.after, JSON.stringify(u4));

  const u5 = await page.evaluate(()=>{
    const k = pid(patients[0]);
    const ta = document.querySelector('textarea[data-key="'+k+'"][data-field="pendientes"]');
    ta.value = 'Pedir TAC\n- IC nefro'; ta.dispatchEvent(new Event('input',{bubbles:true}));
    pendInsertToday(k);
    const d = new Date(); const stamp = String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0');
    const v1 = document.querySelector('textarea[data-key="'+k+'"][data-field="pendientes"]').value;
    pendInsertToday(k); // segunda vez no duplica
    const v2 = document.querySelector('textarea[data-key="'+k+'"][data-field="pendientes"]').value;
    togglePendList(k);
    const rows = Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' .pend-row')).map(r => r.textContent.trim());
    const dateRow = !!document.querySelector('#card-' + CSS.escape(k) + ' .pend-date');
    togglePendLine(k, 1); // "Pedir TAC" (línea 0 es la fecha)
    const after = noteData[k].pendientes.split('\n');
    const doneRow = !!document.querySelector('#card-' + CSS.escape(k) + ' .pend-row.done');
    togglePendLine(k, 1);
    const undone = noteData[k].pendientes.split('\n')[1];
    return { stamp, v1, v2, rows, dateRow, after, doneRow, undone };
  });
  check('U5 "➕ Hoy" antepone la fecha una sola vez; lista marcable tacha/destacha con "✓ " sin perder texto', u5.v1.indexOf(u5.stamp + ' — \n') === 0 && u5.v1 === u5.v2 && u5.rows.length === 2 && u5.dateRow && u5.after[1] === '✓ Pedir TAC' && u5.doneRow && u5.undone === 'Pedir TAC', JSON.stringify(u5));

  const u6 = await page.evaluate(()=>{
    const k = pid(patients[0]);
    const d = new Date(); d.setDate(d.getDate() - 3);
    const iso = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    window.prompt = () => iso;
    setQxFecha(k);
    const line = (document.querySelector('#card-' + CSS.escape(k) + ' .pase-line') || {}).textContent || '';
    const header = document.querySelector('#card-' + CSS.escape(k) + ' .card-badges');
    const visibleIcons = Array.from(header.querySelectorAll(':scope > .icon-btn')).length;
    const moreItems = header.querySelectorAll('.card-more-menu button').length;
    const pmDecimal = Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' .pm-input[data-field="pm_fc"]')).every(i => i.getAttribute('inputmode') === 'decimal');
    return { line, ck: noteData[k].checklist.qx_fecha, visibleIcons, moreItems, pmDecimal, dirty: Array.from(_dirtyFields[k] || []) };
  });
  check('U6 fecha Qx → chip "POP d3"; cabecera con 4 iconos + menú "Más" (8 acciones); vitales con teclado numérico', /POP d3/.test(u6.line) && !!u6.ck && u6.visibleIcons === 4 && u6.moreItems === 8 && u6.pmDecimal, JSON.stringify(u6));

  // ── Hoja de alertas en el tablero: críticos + "sin labs de hoy" ──
  const u7 = await page.evaluate(()=>{
    const k = pid(patients[0]);
    const nd = getNote(k); nd.labHistory = []; noteData[k] = nd; renderView();
    const panel = document.querySelector('#view-piso .alerts-panel');
    const body = document.getElementById('alerts-panel-body');
    const open = !!body && body.style.display !== 'none';
    const noLabs = document.getElementById('alerts-nolabs-today');
    const listed = !!noLabs && /3-101/.test(noLabs.textContent) && /nunca/.test(noLabs.textContent);
    const title = (panel && panel.querySelector('.alerts-panel-title') || {}).textContent || '';
    // con labs de hoy (sangre) desaparece de la lista; con solo EGO sigue apareciendo
    nd.labHistory = [{ fecha: todayStr(), labs: { ego_ph: '6' } }]; noteData[k] = nd; renderView();
    const stillListedEgo = !!document.getElementById('alerts-nolabs-today') && /3-101/.test(document.getElementById('alerts-nolabs-today').textContent);
    nd.labHistory = [{ fecha: todayStr(), labs: { hb: '6.1', k: '2.4' } }]; noteData[k] = nd; renderView();
    const after = document.getElementById('alerts-nolabs-today');
    const crit = /críticas/.test((document.querySelector('#view-piso .alerts-panel-title') || {}).textContent || '');
    const allOk = /Todos los pacientes tienen labs de hoy/.test((document.getElementById('alerts-panel-body') || {}).textContent || '');
    return { hasPanel: !!panel, open, listed, title, stillListedEgo, afterListed: !!after, crit, allOk };
  });
  check('U7 hoja de alertas en el tablero: abierta, lista "sin labs de hoy" (EGO no cuenta), al llegar sangre sale de la lista y aparece como crítico', u7.hasPanel && u7.open && u7.listed && /sin labs hoy/.test(u7.title) && u7.stillListedEgo && !u7.afterListed && u7.crit && u7.allOk, JSON.stringify(u7));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-UI: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
