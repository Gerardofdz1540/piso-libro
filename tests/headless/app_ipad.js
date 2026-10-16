const { chromium, devices } = require('playwright');
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
  const browser=await chromium.launch();
  // Viewport/UA de iPad (Chromium: no es WebKit, pero sí reproduce tamaño, touch y UA).
  const ctx=await browser.newContext({ ...devices['iPad Pro 11'] });
  const page=await ctx.newPage();
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
  check('init: sin errores no capturados (viewport iPad)', errors.length===0, errors.join(' | '));

  // ── H1: Hb crítica en fila PAR de la tabla de labs → fondo rojo + texto blanco (antes: invisible) ──
  const h1 = await page.evaluate(()=>{
    const nd = { labHistory: [
      { fecha:'2026-10-09', labs:{ leucos:'14.80', hb:'6.50', hct:'19.6', plaq:'425' } },
      { fecha:'2026-10-10', labs:{ leucos:'12.26', hb:'6.00', hct:'19.2', plaq:'337' } } ] };
    const html = renderFocusLabs(nd, 'x');
    const host = document.createElement('div'); host.innerHTML = html; document.body.appendChild(host);
    const rows = Array.from(host.querySelectorAll('tbody tr'));
    const hbRow = rows.find(r => r.querySelector('td.ff-an') && r.querySelector('td.ff-an').textContent.trim()==='Hb');
    const htoRow = rows.find(r => r.querySelector('td.ff-an') && r.querySelector('td.ff-an').textContent.trim()==='Hto');
    const hbIdx = rows.indexOf(hbRow) + 1;
    const td = hbRow.querySelector('td.ff-crit'); const tdHto = htoRow.querySelector('td.ff-crit');
    const cs = getComputedStyle(td); const csH = getComputedStyle(tdHto);
    const light = { hbRowIsEven: hbIdx % 2 === 0, bg: cs.backgroundColor, color: cs.color, bgHto: csH.backgroundColor, colorHto: csH.color };
    host.className = 'focus-board';
    const cs2 = getComputedStyle(td);
    const paper = { bg: cs2.backgroundColor, color: cs2.color };
    host.className = ''; document.body.classList.add('dark');
    const cs3 = getComputedStyle(td);
    const dark = { bg: cs3.backgroundColor, color: cs3.color };
    document.body.classList.remove('dark'); host.remove();
    return { light, paper, dark };
  });
  const RED='rgb(220, 38, 38)', WHITE='rgb(255, 255, 255)', DARKRED='rgb(185, 28, 28)';
  check('H1 Hb (fila par) crítica: fondo rojo y texto blanco igual que Hto', h1.light.hbRowIsEven && h1.light.bg===RED && h1.light.color===WHITE && h1.light.bgHto===RED && h1.light.colorHto===WHITE, JSON.stringify(h1.light));
  check('H1b en modo papel (.focus-board) conserva fondo rojo', h1.paper.bg===RED && h1.paper.color===WHITE, JSON.stringify(h1.paper));
  check('H1c en modo oscuro conserva fondo rojo oscuro', h1.dark.bg===DARKRED && h1.dark.color===WHITE, JSON.stringify(h1.dark));

  // ── I1: iPad cambia de app (visibilitychange→hidden) antes del autosave → texto en local + outbox + intento de subida ──
  calls.length=0;
  const i1 = await page.evaluate(()=>{
    const pick = () => document.querySelector('textarea[data-key][data-field="drenajes"]') || document.querySelector('textarea[data-key][data-field="pendientes"]');
    let ta = pick();
    if (!ta) { window.__focusPid = pid(patients[0]); renderView(); ta = pick(); }
    if (!ta) return { noTextarea: true };
    ta.focus(); ta.value = 'ESCRITO EN IPAD JUSTO ANTES DE CAMBIAR DE APP'; ta.dispatchEvent(new Event('input', { bubbles:true }));
    const k = ta.dataset.key, f = ta.dataset.field;
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const ls = lsGetNote(k);
    const q = outboxLoad().filter(i => i.type==='note' && i.key===k);
    return { k, f, lsHasText: ls[f]==='ESCRITO EN IPAD JUSTO ANTES DE CAMBIAR DE APP', queued: q.length, dirtyInQueue: q.length ? (q[0].dirty||[]).includes(f) : false };
  });
  check('I1 hidden inmediato: lo escrito ya está en localStorage y encolado con su campo sucio', !i1.noTextarea && i1.lsHasText && i1.queued===1 && i1.dirtyInQueue, JSON.stringify(i1));
  await page.waitForTimeout(1200);
  const postNote = calls.find(c=>c.m==='POST' && c.url.startsWith('/rest/v1/notes') && c.body && c.body[i1.f]==='ESCRITO EN IPAD JUSTO ANTES DE CAMBIAR DE APP');
  check('I1b con red: se intenta subir de inmediato (POST notes con el texto, parcial por campo)', !!postNote && !('manejo' in (postNote.body||{})) || (!!postNote && i1.f==='manejo'), JSON.stringify(postNote && Object.keys(postNote.body)));

  // ── I2: vuelve a la app (visible) y sigue escribiendo → NO se repinta hasta soltar el campo; el texto se conserva ──
  await page.waitForTimeout(2500); // deja pasar autosave/push pendientes
  calls.length=0;
  const i2a = await page.evaluate(async()=>{
    let ta = document.querySelector('textarea[data-key][data-field="drenajes"]') || document.querySelector('textarea[data-key][data-field="pendientes"]');
    ta.focus(); ta.dataset.marker='viva'; ta.value = 'SEGUNDA LINEA MIENTRAS CARGA'; ta.dispatchEvent(new Event('input', { bubbles:true }));
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 1500));
    const still = document.querySelector('textarea[data-marker="viva"]');
    return { stillSameNode: !!still, focused: document.activeElement === still, value: still ? still.value : null, deferred: _renderDeferred };
  });
  check('I2 visible mientras escribe: el textarea sigue siendo el mismo nodo, con foco y su texto; repintado diferido', i2a.stillSameNode && i2a.focused && i2a.value==='SEGUNDA LINEA MIENTRAS CARGA' && i2a.deferred===true, JSON.stringify(i2a));
  const i2b = await page.evaluate(async()=>{
    const ta = document.querySelector('textarea[data-marker="viva"]'); const k = ta.dataset.key, f = ta.dataset.field;
    ta.blur();
    await new Promise(r => setTimeout(r, 250));
    const early = { stillThere: !!document.querySelector('textarea[data-marker="viva"]'), deferred: _renderDeferred };   // antes repintaba a los 80 ms del focusout
    await new Promise(r => setTimeout(r, 2250));                                                                        // ventana de calma (1.8 s) + margen
    const gone = !document.querySelector('textarea[data-marker="viva"]');
    const fresh = document.querySelector('textarea[data-key="'+k+'"][data-field="'+f+'"]');
    return { early, gone, freshValue: fresh ? fresh.value : null, deferred: _renderDeferred, inMemory: noteData[k][f] };
  });
  check('I2b al soltar el campo NO se repinta de inmediato (250 ms: mismo nodo, sigue diferido); pasada la calma (1.8 s) se repinta y el textarea nuevo trae el texto escrito', i2b.early.stillThere && i2b.early.deferred===true && i2b.gone && i2b.freshValue==='SEGUNDA LINEA MIENTRAS CARGA' && i2b.deferred===false && i2b.inMemory==='SEGUNDA LINEA MIENTRAS CARGA', JSON.stringify(i2b));

  // ── I3: eventos remotos (labs del scraper, cambios de procedimientos) no roban el foco mientras se escribe ──
  const i3 = await page.evaluate(async()=>{
    const ta = document.querySelector('textarea[data-key][data-field="drenajes"]') || document.querySelector('textarea[data-key][data-field]'); ta.focus(); ta.dataset.marker='viva2';
    const srcW = (typeof handleWinlabChange === 'function') ? String(handleWinlabChange) : '';
    const srcP = (typeof handleProcChange === 'function') ? String(handleProcChange) : '';
    renderViewSoft();
    await new Promise(r => setTimeout(r, 100));
    const same = !!document.querySelector('textarea[data-marker="viva2"]') && document.activeElement === document.querySelector('textarea[data-marker="viva2"]');
    document.activeElement.blur(); await new Promise(r => setTimeout(r, 300));
    // WinLab repinta solo tarjetas afectadas y en calma (_rerenderCardSoft: sin foco ni toque reciente); procedimientos usa el repintado suave.
    return { same, winlabGuard: /_rerenderCardSoft\(/.test(srcW) && !/outerHTML/.test(srcW), procSoft: /renderViewSoft/.test(srcP) && !/renderView\(\)/.test(srcP) };
  });
  check('I3 repintado suave no roba el foco; Realtime de WinLab repinta la tarjeta sólo en calma (_rerenderCardSoft) y procedimientos usa repintado suave', i3.same && i3.winlabGuard && i3.procSoft, JSON.stringify(i3));

  // ── I4: el Dx (vive en el paciente, se copia solo al soltar el campo) también se salva si la app se oculta a media edición ──
  calls.length=0;
  const i4 = await page.evaluate(()=>{
    const k = pid(patients[0]);
    const el = document.querySelector('[data-key][data-field="dx"]') || { dataset: { key: k, field: 'dx' }, value: '' };
    if (el.focus) el.focus();
    el.value = 'DX EDITADO EN IPAD SIN SOLTAR EL CAMPO';
    if (el.dispatchEvent) el.dispatchEvent(new Event('input', { bubbles:true })); else liveUpdate(el);
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const q = outboxLoad();
    return { pDx: patients[0].dx, patientQueued: q.some(i => i.type==='patient' && i.patient && i.patient.dx==='DX EDITADO EN IPAD SIN SOLTAR EL CAMPO'),
             lsDx: (JSON.parse(localStorage.getItem('pl_patients_v1') || localStorage.getItem('patients') || '[]')[0] || {}).dx };
  });
  await page.waitForTimeout(1200);
  const ptWrite = calls.find(c=>c.m!=='GET' && c.url.startsWith('/rest/v1/patients') && c.body && ((c.body.dx==='DX EDITADO EN IPAD SIN SOLTAR EL CAMPO') || (Array.isArray(c.body) && c.body.some(b=>b.dx==='DX EDITADO EN IPAD SIN SOLTAR EL CAMPO'))));
  check('I4 Dx a medias al ocultar la app: se copia al paciente, se encola y se sube', i4.pDx==='DX EDITADO EN IPAD SIN SOLTAR EL CAMPO' && i4.patientQueued && !!ptWrite, JSON.stringify({ i4, writes: calls.filter(c=>c.m!=='GET').map(c=>c.m+' '+c.url) }));
  await page.evaluate(()=>{ Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); });

  // ── S: Tira horizontal de camas (#board-nav .bn-beds, oct 2026). Deslizarla con el dedo o un trazo del Apple Pencil
  //       NO deben cambiar de paciente; la tira conserva su desplazamiento entre renders si el foco no cambió y se centra
  //       en la cama nueva al cambiar de paciente. Se inyectan 29 pacientes en memoria (sin red) para que desborde. ──
  // Nota Chromium: Touch.touchType no existe (WebKit lo pone en "stylus"); la señal del lápiz es el pointerdown pointerType "pen".
  const sPrep = await page.evaluate(async()=>{
    for (let i=2;i<=30;i++) patients.push({ _supa_id:'b'+i, cama:'3-'+(100+i), exp:String(100+i), nombre:'JUAN PEREZ LOPEZ '+i, esp:'CG', dx:'', edad:'', adscrito:'', residente:'', estado:'', ingreso:'' });
    window.__focusPid = pid(patients[0]); renderView();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    window.__S = {
      strip: ()=>document.querySelector('#board-nav .bn-beds'),   // RE-consultar tras cada render: el nodo cambia
      touch: (el,x,y,id)=>new Touch({ identifier:id||1, target:el, clientX:x, clientY:y }),
      tev: (type,el,t)=>el.dispatchEvent(new TouchEvent(type,{ bubbles:true, cancelable:true, touches:type==='touchend'?[]:[t], targetTouches:type==='touchend'?[]:[t], changedTouches:[t] })),
      pen: (type,el,x,y)=>el.dispatchEvent(new PointerEvent(type,{ bubbles:true, cancelable:true, pointerId:7, pointerType:'pen', isPrimary:true, clientX:x, clientY:y, pressure:.5 })),
      raf2: ()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),
      wait: (ms)=>new Promise(r=>setTimeout(r,ms)),
    };
    const strip = window.__S.strip();
    return { order: (window.__boardOrder||[]).length, overflow: strip ? strip.scrollWidth - strip.clientWidth : -1, display: strip ? getComputedStyle(strip).display : null, hasTouch: typeof Touch==='function' && typeof TouchEvent==='function' };
  });
  check('S0 preparación: 30 camas en el tablero y la tira desborda', sPrep.order===30 && sPrep.overflow>100 && sPrep.display==='flex' && sPrep.hasTouch, JSON.stringify(sPrep));

  // S1 (a): mover la tira con el dedo (de derecha a izquierda, 200 px en 120 ms) NO es "siguiente paciente"
  const s1 = await page.evaluate(async()=>{
    const {strip,touch,tev,wait,raf2} = window.__S;
    const first = window.__boardOrder[0];
    focusGoTo(first); await raf2();
    const bb = strip().querySelector('.bb'); const r = bb.getBoundingClientRect();
    tev('touchstart', bb, touch(bb, r.left+300, r.top+10));
    await wait(120);
    tev('touchend', bb, touch(bb, r.left+100, r.top+10));
    await raf2();
    return { first, now: window.__focusPid };
  });
  check('S1 deslizar la tira de camas con el dedo NO cambia de paciente', s1.now===s1.first, JSON.stringify(s1));

  // S2 (b): trazo del Apple Pencil (pointerdown pointerType "pen" + toque) sobre el fondo de la tarjeta NO cambia de paciente
  const s2 = await page.evaluate(async()=>{
    const {touch,tev,pen,wait,raf2} = window.__S;
    const first = window.__boardOrder[0];
    focusGoTo(first); await raf2();
    const grid = document.getElementById('piso-grid'); const g = grid.getBoundingClientRect();
    pen('pointerdown', grid, g.left+400, g.top+200);
    tev('touchstart', grid, touch(grid, g.left+400, g.top+200, 2));
    await wait(120);
    pen('pointerup', grid, g.left+200, g.top+200);
    tev('touchend', grid, touch(grid, g.left+200, g.top+200, 2));
    await raf2();
    return { first, now: window.__focusPid };
  });
  check('S2 trazo del Apple Pencil sobre la tarjeta NO cambia de paciente', s2.now===s2.first, JSON.stringify(s2));

  // S3 (c): el dedo sobre el fondo de la tarjeta SÍ sigue hojeando pacientes (guarda contra una exclusión demasiado amplia)
  const s3 = await page.evaluate(async()=>{
    const {touch,tev,wait,raf2} = window.__S;
    await wait(200);                                   // fuera de la ventana de 100 ms del lápiz de S2
    const first = window.__boardOrder[0], second = window.__boardOrder[1];
    focusGoTo(first); await raf2();
    const grid = document.getElementById('piso-grid'); const g = grid.getBoundingClientRect();
    tev('touchstart', grid, touch(grid, g.left+400, g.top+200, 3));
    await wait(120);
    tev('touchend', grid, touch(grid, g.left+200, g.top+200, 3));
    await raf2();
    return { second, now: window.__focusPid };
  });
  check('S3 deslizar con el dedo sobre la tarjeta SÍ cambia al siguiente paciente (se conserva)', s3.now===s3.second, JSON.stringify(s3));

  // S4 (d): la tira conserva su desplazamiento entre renders si el foco no cambió (renderView directo, Realtime, focusout diferido)
  const s4 = await page.evaluate(async()=>{
    const {strip,raf2,wait} = window.__S;
    const first = window.__boardOrder[0];
    focusGoTo(first); await raf2();
    strip().scrollLeft = 300; let old = strip(); renderView(); await raf2();
    const d = { newNode: strip()!==old, left: strip().scrollLeft };
    // d2: UPDATE Realtime de OTRO paciente (su tarjeta no está en el DOM → renderViewSoft → renderView). En CALMA (sin
    // toque/foco en los últimos 1.8 s: los toques de S3 están frescos, se vence a mano) para que el repintado sea INMEDIATO
    // y la prueba vea de verdad un nodo nuevo; si no, renderViewSoft difiere y la tira "conservaría" su scroll trivialmente.
    _lastInteractTs = 0; _renderDeferred = false; clearTimeout(_renderSoftTimer); _renderSoftTimer = 0;
    strip().scrollLeft = 420; old = strip(); const other = patients[5];
    handlePatientChange({ eventType:'UPDATE', new:{ id: other._supa_id, cama: other.cama, nombre: other.nombre, exp: other.exp, esp:'CG', dx:'X' }, old:{ id: other._supa_id } });
    await raf2();
    const d2 = { newNode: strip()!==old, left: strip().scrollLeft, focus: window.__focusPid===first };
    // d3: llega el UPDATE mientras se escribe → repintado diferido; al soltar la caja (blur) se repinta pasada la calma (1.8 s)
    strip().scrollLeft = 600; old = strip();
    const ta = document.querySelector('textarea[data-key][data-field]'); ta.focus();
    handlePatientChange({ eventType:'UPDATE', new:{ id: other._supa_id, cama: other.cama, nombre: other.nombre, exp: other.exp, esp:'CG', dx:'Y' }, old:{ id: other._supa_id } });
    const deferred = _renderDeferred;
    ta.blur(); await wait(300); await raf2();
    const early = { sameNode: strip()===old, left: strip().scrollLeft };
    await wait(2200); await raf2();
    const d3 = { deferred, early, newNode: strip()!==old, deferredEnd: _renderDeferred, left: strip().scrollLeft, focus: window.__focusPid===first };
    return { d, d2, d3 };
  });
  check('S4 renderView sin cambio de foco: la tira (nodo nuevo) conserva su desplazamiento', s4.d.newNode && Math.abs(s4.d.left-300)<=8, JSON.stringify(s4.d));
  check('S4b UPDATE Realtime de otro paciente (en calma: repintado inmediato, nodo nuevo): la tira conserva su desplazamiento', s4.d2.newNode && Math.abs(s4.d2.left-420)<=8 && s4.d2.focus, JSON.stringify(s4.d2));
  check('S4c repintado diferido por focusout: a los 300 ms aún no repinta; pasada la calma repinta (nodo nuevo) y la tira conserva su desplazamiento', s4.d3.deferred===true && s4.d3.early.sameNode && s4.d3.newNode && s4.d3.deferredEnd===false && Math.abs(s4.d3.left-600)<=8 && s4.d3.focus, JSON.stringify(s4.d3));

  // S5 (e): cambiar de paciente (focusGoTo) SÍ centra la tira en la cama nueva
  const s5 = await page.evaluate(async()=>{
    const {strip,raf2} = window.__S;
    const target = window.__boardOrder[24];
    focusGoTo(target); await raf2();
    const s = strip(), cur = s.querySelector('.bb-cur');
    return { target, k: cur && cur.dataset.k, left: s.scrollLeft, off: cur ? Math.abs((cur.offsetLeft - s.scrollLeft + cur.offsetWidth/2) - s.clientWidth/2) : null };
  });
  check('S5 ir a otra cama centra la tira en la cama nueva', s5.k===s5.target && s5.left>0 && s5.off!==null && s5.off<=40, JSON.stringify(s5));

  // S6 (f): tocar un chip justo después de mover la tira (< 2 s) SÍ centra en la cama elegida (force gana a touchTs)
  const s6 = await page.evaluate(async()=>{
    const {strip,touch,tev,raf2} = window.__S;
    const s = strip(); const chip = s.querySelectorAll('.bb')[9]; const c = chip.getBoundingClientRect();
    tev('touchstart', chip, touch(chip, c.left+5, c.top+5, 4)); tev('touchend', chip, touch(chip, c.left+5, c.top+5, 4));
    chip.click(); await raf2();
    const s2 = strip(), cur = s2.querySelector('.bb-cur');
    return { want: window.__boardOrder[9], now: window.__focusPid, k: cur && cur.dataset.k, off: cur ? Math.abs((cur.offsetLeft - s2.scrollLeft + cur.offsetWidth/2) - s2.clientWidth/2) : null };
  });
  check('S6 tocar un chip tras mover la tira SÍ centra en la cama elegida', s6.now===s6.want && s6.k===s6.want && s6.off!==null && s6.off<=40, JSON.stringify(s6));

  // S7: deslizar la barra de saltos (.bn-jump) o las pestañas del header tampoco cambia de paciente (mismo gesto de desplazar)
  const s7 = await page.evaluate(async()=>{
    const {touch,tev,wait,raf2} = window.__S;
    const first = window.__boardOrder[0];
    focusGoTo(first); await raf2();
    const out = { first };
    const jump = document.querySelector('#board-nav .bn-jump'); const tabs = document.getElementById('tabs');
    for (const [name, el] of [['jump', jump], ['tabs', tabs]]) {
      if (!el) { out[name] = 'ausente'; continue; }
      const r = el.getBoundingClientRect();
      tev('touchstart', el, touch(el, r.left+300, r.top+5, 5)); await wait(120); tev('touchend', el, touch(el, r.left+100, r.top+5, 5)); await raf2();
      out[name] = window.__focusPid;
    }
    return out;
  });
  check('S7 deslizar la barra de saltos / pestañas NO cambia de paciente', (s7.jump==='ausente' || s7.jump===s7.first) && (s7.tabs==='ausente' || s7.tabs===s7.first) && s7.jump!=='ausente', JSON.stringify(s7));

  // S8 (revisor): cambiar la CAMA del paciente en foco (Editar / cambiar cama / censo → renderView con el MISMO pid) mueve su
  // chip de lugar (la tira va por cama): la tira debe volver a centrarse en él, no quedarse donde estaba (chip fuera de vista).
  const s8 = await page.evaluate(async()=>{
    const {strip,raf2} = window.__S;
    const k = window.__boardOrder[3]; const p = patients.find(x=>pid(x)===k); const cama0 = p.cama;
    focusGoTo(k); await raf2();
    const vis = ()=>{ const s = strip(), c = s.querySelector('.bb-cur'); if (!c) return null; const cr = c.getBoundingClientRect(), sr = s.getBoundingClientRect(); return { k: c.dataset.k, cama: c.dataset.cama, visible: cr.left >= sr.left - 1 && cr.right <= sr.right + 1, left: s.scrollLeft, idx: Array.prototype.indexOf.call(s.querySelectorAll('.bb'), c) }; };
    const before = vis();
    p.cama = '3-199'; renderView(); await raf2();          // como promptChangeBed/inlineCama/saveModal: renderView directo, mismo pid
    const moved = vis();
    p.cama = cama0; renderView(); await raf2();            // de regreso
    const back = vis();
    return { k, before, moved, back };
  });
  check('S8 cambiar la cama del paciente en foco (mismo pid): su chip se mueve y la tira se centra en él (ida y vuelta)',
    s8.before && s8.before.visible && s8.before.idx===3 && s8.moved && s8.moved.k===s8.k && s8.moved.cama==='3-199' && s8.moved.idx>20 && s8.moved.visible && s8.moved.left>s8.before.left && s8.back && s8.back.idx===3 && s8.back.visible, JSON.stringify(s8));

  // S9: con una ventana abierta (✏️ Editar) o con un campo enfocado (escribiendo), el dedo NO hojea pacientes detrás;
  //     cerrada la ventana y sin foco, el mismo gesto vuelve a cambiar de paciente.
  const s9 = await page.evaluate(async()=>{
    const {touch,tev,wait,raf2} = window.__S;
    await wait(200);
    const swipe = async (id) => { const grid = document.getElementById('piso-grid'); const g = grid.getBoundingClientRect(); tev('touchstart', grid, touch(grid, g.left+400, g.top+200, id)); await wait(120); tev('touchend', grid, touch(grid, g.left+200, g.top+200, id)); await raf2(); };
    const first = window.__boardOrder[0], second = window.__boardOrder[1];
    focusGoTo(first); await raf2();
    document.getElementById('patient-modal').style.display = 'flex';
    await swipe(31); const conModal = window.__focusPid;
    document.getElementById('patient-modal').style.display = 'none';
    const ta = document.querySelector('textarea[data-key]'); if (ta) ta.focus();
    await swipe(32); const conFoco = window.__focusPid;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await swipe(33); const libre = window.__focusPid;
    return { first, second, conModal, conFoco, libre, hadTa: !!ta };
  });
  check('S9 con ✏️ Editar abierto o escribiendo en una caja, deslizar el dedo NO cambia de paciente; sin ventana ni foco sí', s9.hadTa && s9.conModal===s9.first && s9.conFoco===s9.first && s9.libre===s9.second, JSON.stringify(s9));

  // ── I5: VENTANA DE CALMA entre caja A y caja B (oct 2026, "al ir a escribir te cambia de sección"). Antes el repintado
  //       diferido caía 80 ms después del focusout, justo en el hueco (200-1000 ms) entre soltar una caja y tocar la otra,
  //       y Realtime del mismo paciente reemplazaba la tarjeta entera en cuanto no había foco. Usa los 30 pacientes de S0. ──
  await page.waitForTimeout(5600); // vence el suppressKey (5 s) de guardados previos
  const i5 = await page.evaluate(async () => {
    const k = pid(patients[0]); const p = patients[0]; if (window.__focusPid !== k) focusGoTo(k);
    await new Promise(r => setTimeout(r, 2000)); // calma inicial
    const A = document.querySelector('textarea[data-key][data-field="manejo"]'), B = document.querySelector('textarea[data-key][data-field="pendientes"]');
    A.dataset.probe = 'A5'; B.dataset.probe = 'B5'; const card = document.getElementById('card-' + k);
    let renders = 0; const orig = renderView; window.renderView = function () { renders++; return orig.apply(this, arguments); };
    A.focus(); A.value = 'ESCRITO EN A'; A.dispatchEvent(new Event('input', { bubbles: true }));
    renderViewSoft();                                             // algo remoto (procedimientos/indicaciones) mientras escribe
    _suppressRealtimeKeys.clear();
    const other = patients[1];
    handleNoteChange({ eventType: 'UPDATE', new: { patient_id: other._supa_id, manejo: 'OTRO', checklist: {} } });   // OTRO paciente (no está en el DOM)
    const otherUntouched = document.getElementById('card-' + k) === card && !!document.querySelector('textarea[data-probe="A5"]');
    A.blur(); await new Promise(r => setTimeout(r, 250));         // suelta A y tarda 250 ms en tocar B (antes repintaba a los 80 ms)
    const bSame = !!document.querySelector('textarea[data-probe="B5"]');
    _suppressRealtimeKeys.clear();
    handleNoteChange({ eventType: 'UPDATE', new: { patient_id: p._supa_id, manejo: 'REMOTO', pendientes: '', checklist: {} } });   // MISMO paciente, sin foco, sin calma
    const sameCardAfterRt = document.getElementById('card-' + k) === card;
    B.focus(); B.value = 'ESCRITO EN B'; B.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    const bFocused = document.activeElement === B && B.isConnected && B.value === 'ESCRITO EN B';
    const noRenderYet = renders === 0 && _renderDeferred === true && document.getElementById('card-' + k) === card;
    B.blur(); await new Promise(r => setTimeout(r, 2400));         // calma → ahora sí: UN renderView (+ la tarjeta de Realtime)
    window.renderView = orig;
    const fresh = document.querySelector('textarea[data-key][data-field="pendientes"]');
    return { otherUntouched, bSame, sameCardAfterRt, bFocused, noRenderYet, renders, deferredEnd: _renderDeferred, freshB: fresh && fresh.value, manejoKept: noteData[k].manejo, bGone: !document.querySelector('textarea[data-probe="B5"]') };
  });
  check('I5 calma: Realtime de otro paciente no toca el DOM; soltar A y tocar B a los 250 ms no repinta; Realtime del mismo paciente sin foco tampoco; B conserva nodo, foco y texto; tras 1.8 s de calma se repinta UNA vez con el texto', i5.otherUntouched && i5.bSame && i5.sameCardAfterRt && i5.bFocused && i5.noRenderYet && i5.renders === 1 && i5.deferredEnd === false && i5.freshB === 'ESCRITO EN B' && i5.manejoKept === 'ESCRITO EN A' && i5.bGone, JSON.stringify(i5));

  // I5b: el último gesto fue un CONTROL (botón/casilla) → el repintado suave pedido por esa acción es inmediato (import, guardar, marcar)
  const i5b = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 2000));
    const k = window.__focusPid; const card = document.getElementById('card-' + k);
    const ta = document.querySelector('textarea[data-key][data-field="manejo"]'); ta.focus(); ta.blur();          // foco reciente → no hay calma
    renderViewSoft(); const deferredAfterField = _renderDeferred === true && document.getElementById('card-' + k) === card;
    const btn = document.createElement('button'); btn.type = 'button'; document.getElementById('piso-grid').appendChild(btn); btn.click(); btn.remove();   // toque en un botón de la tarjeta (inerte)
    renderViewSoft();
    const immediateAfterCtrl = _renderDeferred === false && document.getElementById('card-' + k) !== card;
    return { deferredAfterField, immediateAfterCtrl };
  });
  check('I5b tras soltar un campo el repintado suave espera; tras tocar un botón (acción pedida) es inmediato', i5b.deferredAfterField && i5b.immediateAfterCtrl, JSON.stringify(i5b));

  // ── I6: renderView del MISMO paciente conserva secciones abiertas con fcJump, scrollY (también síncrono) y scrollLeft de la tira ──
  const i6 = await page.evaluate(async () => {
    const k = window.__focusPid; const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const nd = getNote(k); nd.manejo = Array.from({ length: 60 }, (_, i) => 'LINEA DE MANEJO ' + i).join('\n'); nd.pendientes = nd.manejo; noteData[k] = nd; renderView();
    await new Promise(r => setTimeout(r, 120));
    fcJump(k, 'ic');                                               // abre la sección SIN clic (no pasa por pl_sec_open)
    // Deja terminar el scrollIntoView SUAVE de fcJump: esperar a que scrollY se quede quieto (antes 700 ms fijos; con la
    // máquina cargada la animación seguía y movía la página a mitad de la medición).
    { let last = -1, still = 0; for (let i = 0; i < 40 && still < 4; i++) { await new Promise(r => setTimeout(r, 100)); if (window.scrollY === last) still++; else { still = 0; last = window.scrollY; } } }
    const strip = document.querySelector('#board-nav .bn-beds'); strip.scrollLeft = 40; const stripBefore = strip.scrollLeft;
    const max = document.documentElement.scrollHeight - innerHeight; window.scrollTo(0, Math.min(400, max)); await new Promise(r => setTimeout(r, 300));
    const yBefore = window.scrollY;
    renderView();                                                   // repintado completo del MISMO paciente
    const yJust = window.scrollY;                                   // síncrono: antes caía (cajas con rows=3 hasta el rAF de autoResize)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); await new Promise(r => setTimeout(r, 100));
    return { icOpen: document.getElementById('sec-ic-' + ek).open, yBefore, yJust, yAfter: window.scrollY, stripBefore, stripAfter: document.querySelector('#board-nav .bn-beds').scrollLeft, pidStamp: document.getElementById('view-piso').dataset.plPid === k };
  });
  check('I6 repintado del mismo paciente: la sección abierta con fcJump sigue abierta, scrollY igual antes/después (también síncrono) y la tira no se re-centra', i6.icOpen && i6.yBefore >= 300 && i6.yJust === i6.yBefore && i6.yAfter === i6.yBefore && i6.stripBefore > 0 && i6.stripAfter === i6.stripBefore && i6.pidStamp, JSON.stringify(i6));
  // y al CAMBIAR de paciente sí se va arriba y la tira se centra en la cama nueva (regresión):
  const i6b = await page.evaluate(async () => { const k2 = pid(patients[1]); focusGoTo(k2); await new Promise(r => setTimeout(r, 900)); const cur = document.querySelector('#board-nav .bn-beds .bb-cur'); return { pid: window.__focusPid === k2, y: window.scrollY, curK: cur && cur.dataset.k === k2, curVisible: !!cur && cur.getBoundingClientRect().left >= 0, stamp: document.getElementById('view-piso').dataset.plPid === k2 }; });
  check('I6b al cambiar de paciente: arriba, sello nuevo y la tira centrada en la cama nueva', i6b.pid && i6b.y === 0 && i6b.curK && i6b.curVisible && i6b.stamp, JSON.stringify(i6b));
  await page.evaluate(() => focusGoTo(pid(patients[0])));

  // ── I7: deslizar: arrastrar la tira no cambia de paciente; el Pencil (touchType "stylus" en WebKit) y #board-nav están
  //       excluidos en el código; el dedo sobre la tarjeta sin foco SÍ cambia (regresión) ──
  const i7 = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 250));
    const before = window.__focusPid;
    const mk = (type, el, x, y) => { const t = new Touch({ identifier: 11, target: el, clientX: x, clientY: y }); return new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] }); };
    const bb = document.querySelector('#board-nav .bn-beds .bb'); const r = bb.getBoundingClientRect();
    bb.dispatchEvent(mk('touchstart', bb, r.left + 10, r.top + 10)); await new Promise(r => setTimeout(r, 60)); bb.dispatchEvent(mk('touchend', bb, r.left - 120, r.top + 12)); await new Promise(r => setTimeout(r, 50));
    const stripKept = window.__focusPid === before;
    const grid = document.getElementById('piso-grid'); const g = grid.getBoundingClientRect();
    grid.dispatchEvent(mk('touchstart', grid, g.left + 400, g.top + 150)); await new Promise(r => setTimeout(r, 60)); grid.dispatchEvent(mk('touchend', grid, g.left + 200, g.top + 155)); await new Promise(r => setTimeout(r, 50));
    const fingerSwipeWorks = window.__focusPid !== before;          // regresión: con el dedo, sin foco, sobre la tarjeta SÍ cambia
    const src = String(_bindBoardSwipe);
    return { stripKept, fingerSwipeWorks, stylusExcluded: /touchType\s*[!=]==?\s*["']stylus["']/.test(src), navExcluded: /#board-nav/.test(src) };
  });
  check('I7 deslizar: arrastrar la tira de camas no cambia de paciente; el Pencil (touchType stylus) y #board-nav están excluidos; el dedo sobre la tarjeta sin foco sí cambia', i7.stripKept && i7.fingerSwipeWorks && i7.stylusExcluded && i7.navExcluded, JSON.stringify(i7));
  await page.evaluate(() => focusGoTo(pid(patients[0])));

  // ── I8: _rerenderCard (toques: toggleDrains/addDispositivo/Realtime en calma) conserva la sección abierta y el scroll ──
  const i8 = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 200));
    const k = window.__focusPid; const ek = k.replace(/[^a-zA-Z0-9]/g, '_'); document.getElementById('sec-ic-' + ek).open = true;
    // Dos veces: el primer scroll desde y=0 activa hdr-min (la cabecera se encoge) y el scroll anchoring de Chromium lo corrige
    // hacia arriba; el segundo, ya con la cabecera encogida, queda donde se pide.
    const max = document.documentElement.scrollHeight - innerHeight; window.scrollTo(0, Math.min(400, max)); await new Promise(r => setTimeout(r, 150));
    window.scrollTo(0, Math.min(400, max)); await new Promise(r => setTimeout(r, 200)); const y = window.scrollY;
    const cardBefore = document.getElementById('card-' + k);
    _rerenderCard(k); const yJust = window.scrollY; await new Promise(r => setTimeout(r, 120));
    return { replaced: document.getElementById('card-' + k) !== cardBefore, icOpen: document.getElementById('sec-ic-' + ek).open, y, yJust, yAfter: window.scrollY };
  });
  check('I8 _rerenderCard: la sección abierta sigue abierta y el scroll no se mueve (ni síncrono ni tras el rAF)', i8.replaced && i8.icOpen && i8.y >= 300 && i8.yJust === i8.y && i8.yAfter === i8.y, JSON.stringify(i8));

  // ── I9: Realtime del paciente en foco que cambia la CAMA (censo) → vista completa suave (la tira y la barra la muestran) y,
  //       en calma, se pinta conservando scroll; un UPDATE sin cambios de cama/nombre/esp sólo repinta la tarjeta ──
  const i9 = await page.evaluate(async () => {
    await new Promise(r => setTimeout(r, 2000));
    const p = patients[0]; const k = pid(p);
    const card = document.getElementById('card-' + k); const strip = document.querySelector('#board-nav .bn-beds');
    handlePatientChange({ eventType: 'UPDATE', new: { id: p._supa_id, cama: p.cama, nombre: p.nombre, exp: p.exp, esp: p.esp, dx: 'DX NUEVO POR CENSO' }, old: { id: p._supa_id } });
    const onlyCard = document.getElementById('card-' + k) !== card && document.querySelector('#board-nav .bn-beds') === strip;
    const card2 = document.getElementById('card-' + k);
    handlePatientChange({ eventType: 'UPDATE', new: { id: p._supa_id, cama: '3-199', nombre: p.nombre, exp: p.exp, esp: p.esp, dx: 'DX NUEVO POR CENSO' }, old: { id: p._supa_id } });
    const full = document.querySelector('#board-nav .bn-beds') !== strip && document.getElementById('card-' + k) !== card2;
    const pos = (document.querySelector('#board-nav .bn-pos') || {}).textContent || '';
    return { onlyCard, full, posHasBed: /3-199/.test(pos), dx: patients[0].dx };
  });
  check('I9 UPDATE Realtime del paciente en foco: sin cambio de cama sólo la tarjeta; con cambio de cama la vista completa (barra con la cama nueva)', i9.onlyCard && i9.full && i9.posHasBed && i9.dx === 'DX NUEVO POR CENSO', JSON.stringify(i9));

  // ── I10 (revisor): mientras se espera la calma la tarjeta trae el valor VIEJO de una caja que otro dispositivo cambió.
  //        Antes, tocar esa caja y escribir subía «viejo + lo mío» y borraba lo del colega en silencio. Al enfocarla, la
  //        caja toma el valor del modelo (noteData); una caja SUCIA (lo mío sin subir) no se toca. ──
  const i10 = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const p = patients[0]; const k = pid(p);
    if (window.__focusPid !== k) focusGoTo(k);
    const nd = getNote(k); nd.pendientes = 'PEND LOCAL'; nd.manejo = 'MANEJO'; nd.entrega = 'ENTREGA LOCAL'; noteData[k] = nd; renderView();
    await wait(2200);
    const A = document.querySelector('textarea[data-key="' + k + '"][data-field="manejo"]');
    A.focus(); A.value = 'MANEJO EDITADO'; A.dispatchEvent(new Event('input', { bubbles: true }));
    _suppressRealtimeKeys.clear();
    handleNoteChange({ eventType: 'UPDATE', new: { patient_id: p._supa_id, manejo: 'MANEJO', pendientes: 'PEND REMOTO DEL COLEGA', checklist: {} } });
    A.blur(); await wait(500);                                                    // suelta A; a los 500 ms toca B (sin calma: no se repinta)
    const B = document.querySelector('textarea[data-key="' + k + '"][data-field="pendientes"]');
    const pending = _cardSoftPending.has(k), domBefore = B.value;
    B.focus(); const domOnFocus = B.value, beforeValue = B.dataset.beforeValue;
    B.value = B.value + ' + MIO'; B.dispatchEvent(new Event('input', { bubbles: true }));
    const modelAfterType = noteData[k].pendientes, manejoKept = noteData[k].manejo;
    B.blur(); await wait(2500);
    // Caja sucia: lo escrito aquí y aún sin subir gana al remoto (y el foco no lo revierte)
    const C = document.querySelector('textarea[data-key="' + k + '"][data-field="entrega"]');
    C.focus(); C.value = 'ENTREGA MIA SIN SUBIR'; C.dispatchEvent(new Event('input', { bubbles: true })); C.blur();
    _suppressRealtimeKeys.clear();
    handleNoteChange({ eventType: 'UPDATE', new: { patient_id: p._supa_id, manejo: 'MANEJO EDITADO', pendientes: 'PEND REMOTO DEL COLEGA + MIO', entrega: 'ENTREGA REMOTA', checklist: {} } });
    const C2 = document.querySelector('textarea[data-key="' + k + '"][data-field="entrega"]'); C2.focus(); const dirtyOnFocus = C2.value; C2.blur();
    return { pending, domBefore, domOnFocus, beforeValue, modelAfterType, manejoKept, dirtyOnFocus, entregaModel: noteData[k].entrega };
  });
  check('I10 caja con valor viejo (Realtime esperando la calma): al enfocarla toma el valor del colega y lo escrito se suma a él (no lo borra); una caja sucia no se toca',
    i10.pending && i10.domBefore === 'PEND LOCAL' && i10.domOnFocus === 'PEND REMOTO DEL COLEGA' && (i10.beforeValue === undefined || i10.beforeValue === 'PEND REMOTO DEL COLEGA') && i10.modelAfterType === 'PEND REMOTO DEL COLEGA + MIO' && i10.manejoKept === 'MANEJO EDITADO' && i10.dirtyOnFocus === 'ENTREGA MIA SIN SUBIR' && i10.entregaModel === 'ENTREGA MIA SIN SUBIR', JSON.stringify(i10));

  // ── I11 (revisor): con la PÁGINA desplazándose (inercia del iPad / dedo arrastrando > 1.8 s / scroll suave) no se repinta:
  //        el scrollTo de la restauración cortaba la inercia. En cuanto el scroll se detiene (400 ms) se repinta. ──
  await page.waitForTimeout(2200);
  const i11 = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms)); const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const k = window.__focusPid; const card = document.getElementById('card-' + k);
    const max = document.documentElement.scrollHeight - innerHeight;
    let sawScroll = false; const onS = () => { sawScroll = true; }; window.addEventListener('scroll', onS);
    window.scrollTo(0, window.scrollY > 250 ? 100 : Math.min(500, max)); await raf2();   // llega el evento scroll de la ventana
    window.removeEventListener('scroll', onS);
    _lastInteractTs = 0;                                                         // sin toques: sólo cuenta el scroll
    renderViewSoft();
    const deferred = _renderDeferred === true && document.getElementById('card-' + k) === card;
    await wait(900);
    return { sawScroll, deferred, renderedAfter: _renderDeferred === false && document.getElementById('card-' + k) !== card, y: window.scrollY };
  });
  check('I11 con la página desplazándose el repintado suave espera; al detenerse el scroll se repinta', i11.sawScroll && i11.deferred && i11.renderedAfter, JSON.stringify(i11));

  // ── I12 (revisor): una casilla/botón con foco (Chromium/escritorio la enfoca al hacer clic) no es "escribir" ──
  const i12 = await page.evaluate(() => {
    const cb = document.createElement('input'); cb.type = 'checkbox'; document.getElementById('piso-grid').appendChild(cb); cb.focus();
    const cbTyping = _isTypingNow(); cb.remove();
    const ta = document.querySelector('textarea[data-key]'); ta.focus(); const taTyping = _isTypingNow(); ta.blur();
    const t = document.createElement('input'); t.type = 'text'; document.getElementById('piso-grid').appendChild(t); t.focus(); const txtTyping = _isTypingNow(); t.remove();
    return { cbTyping, taTyping, txtTyping };
  });
  check('I12 casilla con foco no cuenta como escribir; textarea e input de texto sí', i12.cbTyping === false && i12.taTyping === true && i12.txtTyping === true, JSON.stringify(i12));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-IPAD: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
