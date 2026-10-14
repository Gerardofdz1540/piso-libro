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
    const visibleIcons = Array.from(header.querySelectorAll(':scope > .icon-btn:not(.undo-btn):not(.redo-btn)')).length;
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

  // ── Ficha compacta (oct 2026): barra de saltos, secciones plegables con memoria, labs en dos mitades ──
  const u8 = await page.evaluate(async()=>{
    const k = pid(patients[0]);
    const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const nd = getNote(k);
    nd.labHistory = [{ fecha: todayStr(), labs: { hb:'9', leucos:'10', plaq:'200', glu:'100', cr:'1', bun:'14', k:'4', na:'138', inr:'1.1', tp:'12', ca:'8.9', mg:'2' } }];
    noteData[k] = nd; localStorage.removeItem('pl_sec_open'); renderView();
    const card = document.getElementById('card-' + k);
    const jump = document.querySelectorAll('#board-nav .bn-jump button').length;
    const split = card.querySelectorAll('.ff-labs-split .ff-labtable').length;
    const dateCols = card.querySelectorAll('.ff-labtable thead th').length / Math.max(1, split || 1) - 1;
    const atbChip = !!card.querySelector('.ck-r-dieta .ck-item[data-item="atb"]');
    const hist = document.getElementById('sec-historia-' + ek);
    const wasOpenFull = hist.open;
    // plegar en modo Completo, persistir; en modo Pase arranca cerrada por defecto y no hereda
    hist.querySelector('summary').click(); await new Promise(r=>setTimeout(r,50));
    const closedNow = !hist.open;
    const stored = JSON.parse(localStorage.getItem('pl_sec_open') || '{}');
    togglePaseMode(); // → pase
    const histP = document.getElementById('sec-historia-' + ek);
    const closedPase = !histP.open;
    fcJump(k, 'historia');
    const openedByJump = histP.open;
    const anchors = ['dx','labs','cx','manejo','plan','pase','entrega','recibo','ic','sug','ind','img','diag','rec'].every(n => !!document.getElementById('sec-' + n + '-' + ek));
    togglePaseMode(); // → completo
    const histF = document.getElementById('sec-historia-' + ek);
    const stillClosedFull = !histF.open;
    window.scrollTo(0, 900); await new Promise(r=>setTimeout(r,120));
    const hdrMin = document.body.classList.contains('hdr-min');
    window.scrollTo(0, 0); await new Promise(r=>setTimeout(r,120));
    const hdrBack = !document.body.classList.contains('hdr-min');
    return { jump, split, dateCols, atbChip, wasOpenFull, closedNow, stored, closedPase, openedByJump, anchors, stillClosedFull, hdrMin, hdrBack };
  });
  check('U8 ficha compacta: barra de 14 saltos; labs en 2 tablas lado a lado; chip ATB en la fila de dieta; sección plegada se recuerda por modo; fcJump abre; cabecera se encoge al bajar',
    u8.jump === 14 && u8.split === 2 && u8.dateCols === 1 && u8.atbChip && u8.wasOpenFull && u8.closedNow && u8.stored['historia@f'] === false && u8.closedPase && u8.openedByJump && u8.anchors && u8.stillClosedFull && u8.hdrMin && u8.hdrBack, JSON.stringify(u8));

  // ── Panel lateral de alertas (oct 2026): nada arriba del tablero, botón 🔔 con contadores, salto a la tarjeta ──
  const u9 = await page.evaluate(async()=>{
    // El fixture trae un solo paciente: agregamos otro en memoria (sin labs) para tener "sin labs de hoy"
    if (patients.length < 2) { patients.push({ _supa_id: 'a2', cama: '3-105', exp: '2', nombre: 'PACIENTE DOS', esp: 'CG', estado: 'ESTABLE', dx: '' }); }
    const k0 = pid(patients[0]), k1 = pid(patients[1]);
    const nd0 = getNote(k0); nd0.labHistory = [{ fecha: todayStr(), labs: { hb: '6.1', k: '2.4' } }]; noteData[k0] = nd0;
    const nd1 = getNote(k1); nd1.labHistory = []; noteData[k1] = nd1;
    focusGoTo(k0); renderView();
    const topBanners = !!document.querySelector('#view-piso > .alerts-panel, #view-piso > .lab-news-banner');
    const btn = document.querySelector('#board-nav .bn-alerts');
    const drawer = document.getElementById('alerts-drawer');
    const closedAtStart = !!drawer && !drawer.classList.contains('open');
    toggleAlertsDrawer();
    await new Promise(r=>setTimeout(r, 350)); // fin de la transición
    const openNow = drawer.classList.contains('open') && getComputedStyle(drawer).transform === 'none';
    const inDrawer = !!drawer.querySelector('.alerts-panel') && !!drawer.querySelector('#alerts-nolabs-today');
    const dots = document.querySelectorAll('#board-side .bs-dot').length;
    alertsGo(k1);
    await new Promise(r=>setTimeout(r, 500));
    const after = { focus: window.__focusPid, closed: !document.getElementById('alerts-drawer').classList.contains('open'), flashed: !!document.querySelector('#card-' + CSS.escape(k1) + '.fc-flash') };
    return { k1, topBanners, btnTxt: btn ? btn.textContent : '', hasCrit: !!(btn && btn.classList.contains('has-crit')), closedAtStart, openNow, inDrawer, dots, after };
  });
  check('U9 alertas en panel lateral: nada arriba del tablero; 🔔 con contadores (1 crítico, sin labs hoy); abre con el botón; un renglón cierra el panel y abre la tarjeta resaltada; puntos de estado en el carril',
    !u9.topBanners && /🔔/.test(u9.btnTxt) && /1/.test(u9.btnTxt) && /📭/.test(u9.btnTxt) && u9.hasCrit && u9.closedAtStart && u9.openNow && u9.inDrawer && u9.dots >= 2 && u9.after.focus === u9.k1 && u9.after.closed && u9.after.flashed, JSON.stringify(u9));

  // ── Drenajes y sondas personalizables (oct 2026) ──
  const u10 = await page.evaluate(async()=>{
    const k = pid(patients[0]);
    focusGoTo(k); // U9 dejó en foco al segundo paciente
    // migración una sola vez desde los chips fijos
    const legacy = migrateNote({ checklist: { pm_sng: true, pm_sng_desc: 'a derivación', pm_prs1: true, pm_prs1_desc: 'FID', pm_sep: true, pm_sep_gasto: '150', pm_sep_fuga: true, pm_sep_fuga_grado: 'B' } });
    const mig = legacy.checklist.dispositivos.map(d => d.tipo + (d.sitio ? '@' + d.sitio : '') + (d.gasto ? '=' + d.gasto : '') + (d.carac ? '/' + d.carac : ''));
    const emptyStays = migrateNote({ checklist: { pm_sng: true, dispositivos: [] } }).checklist.dispositivos.length;
    window.prompt = () => 'Drenaje biliar';
    addDispositivo(k, 'Saratoga', 'D'); addDispositivo(k, 'Saratoga', 'I'); addDispositivo(k, 'Estoma', ''); addDispositivo(k, 'Otro', '');
    const list = getNote(k).checklist.dispositivos;
    updateDispositivo(k, list[0].id, 'gasto', '30'); updateDispositivo(k, list[0].id, 'carac', 'seroso');
    updateDispositivo(k, list[2].id, 'gasto', '400'); updateDispositivo(k, list[2].id, 'carac', 'fecal');
    toggleDispositivoLado(k, list[2].id);
    const card = () => document.getElementById('card-' + k);
    const rows = card().querySelectorAll('.dv-row').length;
    const pase = (card().querySelector('.pase-line') || {}).textContent || '';
    const txt = dispositivosTexto(getNote(k).checklist, ' | ');
    const legacyOff = getNote(k).checklist.pm_sng === false && getNote(k).checklist.pm_sep === false;
    removeDispositivo(k, list[1].id);
    const after = getNote(k).checklist.dispositivos.map(d => d.tipo + (d.lado || ''));
    const dirty = Array.from(_dirtyUnion(k));
    const sepChip = !!card().querySelector('.ck-item[data-item="pm_sep"]');
    return { mig, emptyStays, rows, pase, txt, legacyOff, after, dirty, sepChip };
  });
  check('U10 drenajes personalizables: migra chips viejos (SNG, Penrose, SEP con fuga) una sola vez; agrega Saratoga D/I, Estoma, "Otro"; gasto/característica/lado; línea de pase y texto de entrega; quitar; SEP ya no está en Clínico',
    u10.mig.length === 3 && /^SNG\/a derivaci/.test(u10.mig[0]) && u10.mig[1] === 'Penrose@FID' && /^Sonda endopleural=150\/fuga gr\. B$/.test(u10.mig[2]) && u10.emptyStays === 0
    && u10.rows === 4 && /Saratoga D 30/.test(u10.pase) && /Estoma D 400/.test(u10.pase) && /Drenaje biliar/.test(u10.pase)
    && /Saratoga D 30 mL seroso d0 \| Saratoga I d0 \| Estoma D 400 mL fecal d0 \| Drenaje biliar d0/.test(u10.txt)
    && u10.legacyOff && u10.after.join(',') === 'SaratogaD,EstomaD,Drenaje biliar' && u10.dirty.includes('ck_dispositivos') && !u10.sepChip, JSON.stringify(u10));

  // ── Cirugías con varias fechas + Entrega/Recibo de guardia (oct 2026) ──
  const u11 = await page.evaluate(async()=>{
    const k = pid(patients[0]);
    focusGoTo(k);
    const iso = (d) => d.toISOString().slice(0, 10);
    const hace = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
    // 1) Migración una sola vez desde el texto Qx (dos líneas con fecha + hallazgos) y sangrado
    const leg = migrateNote({ qx: 'LAPE + drenaje de colección 10/10/2026\nhallazgos: colección interasa 300 mL\nReintervención 12/10/26', sangrado: '400', checklist: { qx_fecha: '2026-10-12' } });
    const migr = leg.checklist.cirugias.map(c => [c.fecha, c.procedimiento, c.hallazgos, c.sangrado].join('|'));
    const legPop = migrateNote({ qx: 'Apendicectomía', checklist: { qx_fecha: '2026-10-11' } }).checklist.cirugias.map(c => c.fecha + '|' + c.procedimiento);
    const emptyStays = migrateNote({ qx: 'LAPE', checklist: { cirugias: [] } }).checklist.cirugias.length;
    // 2) Lista en la tarjeta: agregar dos cirugías con fechas distintas, editar, PO día N, línea de pase, texto resumen
    const nd0 = getNote(k); nd0.checklist.cirugias = []; nd0.checklist.qx_fecha = ''; nd0.qx = ''; noteData[k] = nd0; renderView();
    const id1 = addCirugia(k, hace(5)); updateCirugia(k, id1, 'procedimiento', 'LAPE + drenaje de colección'); updateCirugia(k, id1, 'sangrado', '400');
    const id2 = addCirugia(k, hace(1)); updateCirugia(k, id2, 'procedimiento', 'Reintervención + lavado'); updateCirugia(k, id2, 'hallazgos', 'fuga de rafia');
    const card = () => document.getElementById('card-' + k);
    const rows = card().querySelectorAll('.cx-row').length;
    const po = Array.from(card().querySelectorAll('.cx-po')).map(x => x.textContent.trim());
    const dates = Array.from(card().querySelectorAll('.cx-date')).map(x => x.value);
    const pase = (card().querySelector('.pase-line') || {}).textContent || '';
    const txt = cirugiasTexto(getNote(k).checklist, ' | ');
    const qxFechaSigue = getNote(k).checklist.qx_fecha === hace(1) && popDays(getNote(k)) === 1;
    const dirty = Array.from(_dirtyUnion(k));
    const noOldBoxes = !card().querySelector('textarea[data-field="qx"]') && !card().querySelector('textarea[data-field="sangrado"]') && !card().querySelector('textarea[data-field="balance"]');
    const drenNote = !!card().querySelector('.dv-note[data-field="drenajes"]');
    const histTitle = (document.getElementById('sec-historia-' + k.replace(/[^a-zA-Z0-9]/g, '_')).querySelector('summary') || {}).textContent || '';
    const colored = !!card().querySelector('.fc-blk-cx') && !!card().querySelector('.fc-blk-entrega') && !!card().querySelector('.fc-blk-recibo') && !!card().querySelector('.fc-blk-dx');
    window.confirm = () => true;
    removeCirugia(k, id1);
    const afterRemove = getNote(k).checklist.cirugias.length;
    // 3) Entrega → Recibo: "Tomar guardia" pasa el texto con fecha/hora y vacía Entrega
    const nd1 = getNote(k); nd1.entrega = 'Pendiente TAC control\nK 2.9 en reposición'; nd1.checklist.recibo = ''; noteData[k] = nd1; renderView();
    tomarGuardia(k);
    const nd2 = getNote(k);
    const reciboTa = card().querySelector('textarea[data-ckfield="recibo"]');
    const entregaTa = card().querySelector('textarea[data-field="entrega"]');
    const dirty2 = Array.from(_dirtyUnion(k));
    // sin texto en Entrega no hace nada
    window.alert = () => {};
    tomarGuardia(k);
    return { migr, legPop, emptyStays, rows, po, dates, pase, txt, qxFechaSigue, dirty, noOldBoxes, drenNote, histTitle, colored, afterRemove,
      recibo: nd2.checklist.recibo, entregaVacia: nd2.entrega === '', reciboTa: reciboTa ? reciboTa.value : null, entregaTa: entregaTa ? entregaTa.value : null, dirty2, reciboSigue: getNote(k).checklist.recibo === nd2.checklist.recibo };
  });
  check('U11 cirugías con fechas: migra el texto Qx (líneas con fecha + hallazgos + sangrado + fecha POP) una sola vez; lista con PO dN, más reciente primero, línea de pase, texto resumen, POP sigue a la última; sin cajas Qx/Sangrado/Balance (nota de drenajes sigue); bloques con color; Entrega → Recibo con "Tomar guardia"',
    u11.migr.length === 2 && u11.migr[0] === '2026-10-10|LAPE + drenaje de colección|hallazgos: colección interasa 300 mL|' && u11.migr[1] === '2026-10-12|Reintervención||400'
    && u11.legPop.length === 1 && u11.legPop[0] === '2026-10-11|Apendicectomía' && u11.emptyStays === 0
    && u11.rows === 2 && u11.po[0] === 'PO d1' && u11.po[1] === 'PO d5' && u11.dates[0] > u11.dates[1]
    && /POP d1 · Reintervención \+ lavado/.test(u11.pase) && /^Reintervención \+ lavado \(.+, PO d1\) \| LAPE \+ drenaje de colección \(.+, PO d5\) sangrado 400 mL$/.test(u11.txt)
    && u11.qxFechaSigue && u11.dirty.includes('ck_cirugias') && u11.noOldBoxes && u11.drenNote && /APP \/ PA/.test(u11.histTitle) && !/Qx/.test(u11.histTitle) && u11.colored && u11.afterRemove === 1
    && /^— Recibido \d{2}\/\d{2} \d{2}:\d{2}( [A-ZÁÉÍÓÚÑ]{1,3})? —\nPendiente TAC control\nK 2\.9 en reposición$/.test(u11.recibo) && u11.entregaVacia && u11.reciboTa === u11.recibo && u11.entregaTa === '' && u11.dirty2.includes('entrega') && u11.dirty2.includes('ck_recibo') && u11.reciboSigue, JSON.stringify(u11));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-UI: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
