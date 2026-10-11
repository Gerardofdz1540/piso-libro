const { chromium, devices } = require('playwright');
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
  const browser=await chromium.launch();
  // Viewport/UA de iPad (Chromium: no es WebKit, pero sí reproduce tamaño, touch y UA).
  const ctx=await browser.newContext({ ...devices['iPad Pro 11'] });
  const page=await ctx.newPage();
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
    await new Promise(r => setTimeout(r, 400));
    const gone = !document.querySelector('textarea[data-marker="viva"]');
    const fresh = document.querySelector('textarea[data-key="'+k+'"][data-field="'+f+'"]');
    return { gone, freshValue: fresh ? fresh.value : null, deferred: _renderDeferred, inMemory: noteData[k][f] };
  });
  check('I2b al soltar el campo: se repinta y el textarea nuevo trae el texto escrito', i2b.gone && i2b.freshValue==='SEGUNDA LINEA MIENTRAS CARGA' && i2b.deferred===false && i2b.inMemory==='SEGUNDA LINEA MIENTRAS CARGA', JSON.stringify(i2b));

  // ── I3: eventos remotos (labs del scraper, cambios de procedimientos) no roban el foco mientras se escribe ──
  const i3 = await page.evaluate(async()=>{
    const ta = document.querySelector('textarea[data-key][data-field="drenajes"]') || document.querySelector('textarea[data-key][data-field]'); ta.focus(); ta.dataset.marker='viva2';
    const srcW = (typeof handleWinlabChange === 'function') ? String(handleWinlabChange) : '';
    const srcP = (typeof handleProcChange === 'function') ? String(handleProcChange) : '';
    renderViewSoft();
    await new Promise(r => setTimeout(r, 100));
    const same = !!document.querySelector('textarea[data-marker="viva2"]') && document.activeElement === document.querySelector('textarea[data-marker="viva2"]');
    document.activeElement.blur(); await new Promise(r => setTimeout(r, 300));
    // WinLab repinta solo tarjetas afectadas y respeta la que tiene el foco; procedimientos usa el repintado suave.
    return { same, winlabGuard: /contains\(document\.activeElement\)/.test(srcW), procSoft: /renderViewSoft/.test(srcP) && !/renderView\(\)/.test(srcP) };
  });
  check('I3 repintado suave no roba el foco; Realtime de WinLab respeta la tarjeta con foco y procedimientos usa repintado suave', i3.same && i3.winlabGuard && i3.procSoft, JSON.stringify(i3));

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

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-IPAD: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
