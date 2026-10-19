// 🕘 Historial por caja, sección 🔄 Guardia y autor en Procedimientos (19 oct 2026, tras el incidente de la entrega:
// bloques de texto movidos/borrados entre cajas desde un iPad y sin forma de recuperarlos desde la app).
//   node tests/headless/app_guardia.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  window.__alerts=[]; window.__confirms=[]; window.prompt=function(){ return 'Tester'; }; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(m){ window.__confirms.push(String(m)); return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const T0 = '2026-10-19T13:31:24.000Z', T1 = '2026-10-19T13:28:34.000Z';
const HIST = {
  manejo: [
    { id: 19533, ts: T0, nombre: 'Gerardo', dispositivo: 'Gera', de: 'PENROSE FID 30 ML SEROSO\nSONDA FOLEY 800 ML/24 H', a: '' },
    { id: 18172, ts: '2026-10-19T10:21:55.000Z', nombre: 'Diego', dispositivo: 'Mac Chrome', de: 'PENROSE FID 30 ML SEROSO', a: 'PENROSE FID 30 ML SEROSO\nSONDA FOLEY 800 ML/24 H' },
  ],
  'ck:recibo': [{ id: 19859, ts: T1, nombre: 'Diego', dispositivo: 'Mac Chrome', de: '— Recibido 18/10 07:30 DG —\nVIGILAR SANGRADO', a: '' }],
  entrega: [{ id: 19900, ts: T1, nombre: 'Diego', dispositivo: 'Mac Chrome', de: 'PENDIENTE TAC DE CONTROL', a: '' }],
  // texto corto pero la base dice que lo almacenado llegó al tope (sub-llave del checklist escapada): la v3 manda la marca
  'ck:cultivos': [{ id: 19910, ts: T1, nombre: 'Diego', dispositivo: 'Mac Chrome', de: 'HEMOCULTIVO X2 EN PROCESO', a: '', de_cortada: true }],
};
// RPC v1 de una base SIN la v2: las sub-llaves del checklist llegan como texto JSON sin comillas (\n y \" literales) y la
// app las decodifica; una versión de 6000 letras (tope del disparador) se marca «recortada».
const HIST_OLD = {
  'ck:recibo': [{ id: 19859, ts: T1, nombre: 'Diego', dispositivo: 'Mac Chrome', de: '— Recibido 18/10 07:30 DG —\\nVIGILAR \\"SANGRADO\\"', a: '' }],
  pendientes: [{ id: 19950, ts: T1, nombre: 'Diego', dispositivo: 'Mac Chrome', de: 'X'.repeat(6000), a: 'X'.repeat(10) }],
};
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const calls = [];
  let rpcFail = false, rpcV2Missing = false;
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    calls.push({ m, url, body });
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/rpc/pl_historial_caja')) {
      if (rpcFail) return json(500, { message: 'boom' });
      const ver = /_v3$/.test(url) ? 3 : (/_v2$/.test(url) ? 2 : 1);
      // base vieja: ni v3 ni v2 existen (404 PGRST202) y la v1 devuelve las sub-llaves del checklist como texto JSON
      if (ver > 1 && rpcV2Missing) return json(404, { code: 'PGRST202', message: 'Could not find the function public.pl_historial_caja_v' + ver + '(p_campo, p_limit, p_patient) in the schema cache' });
      const rows = (rpcV2Missing ? HIST_OLD : HIST)[(body && body.p_campo) || ''] || [];
      if (ver === 3) return json(200, rows.map(r => Object.assign({ fmt: 3, de_cortada: false, a_cortada: false }, r)));   // v3: texto plano + fmt + marcas
      if (ver === 2) return json(200, rows.map(r => Object.assign({ fmt: 2 }, r)));
      return json(200, rows);
    }
    if (url.startsWith('/rest/v1/patients')) {
      if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-183', exp: '26-70001', nombre: 'RUIZ SOTO MATEO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'PO LAPE', adscrito: 'DR GARNELO', residente: 'DR FERNÁNDEZ R2' }]);
      return json(201, [{ id: 'a1' }]);
    }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, [{ patient_id: 'a1', manejo: '', pendientes: 'PEND X', checklist: { recibo: '' } }]); return json(201, [{ patient_id: 'a1' }]); }
    if (url.startsWith('/rest/v1/procedimientos_dia')) { if (m === 'GET') return json(200, []); return json(201, [{ id: 'p1' }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 1 && document.getElementById('card-' + pid(patients[0])), null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  // ── G1: botón 🕘 en las cajas y el modal lista las versiones anteriores (quién, cuándo, cuánto) ──
  const g1 = await page.evaluate(async () => {
    const k = pid(patients[0]); const card = document.getElementById('card-' + k);
    const btns = ['manejo', 'pendientes', 'entrega', 'ck-recibo', 'ck-interconsultas', 'ck-cultivos', 'dx'].map(f => !!card.querySelector('[data-testid="field-hist-' + f + '"]'));
    card.querySelector('[data-testid="field-hist-manejo"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[data-testid="hist-item"]'); i++) await new Promise(r => setTimeout(r, 100));
    const items = Array.from(document.querySelectorAll('[data-testid="hist-item"]'));
    const modal = document.getElementById('hist-modal');
    return { btns, open: modal && modal.style.display === 'flex', n: items.length, first: items[0] ? items[0].textContent.replace(/\s+/g, ' ').trim() : '',
      cur: (document.querySelector('[data-testid="hist-cur"]') || {}).textContent || '', sel: (document.getElementById('hist-field') || {}).value, restoreBtns: document.querySelectorAll('[data-testid="hist-restore"]').length };
  });
  check('G1 🕘 en Misceláneo, Pendientes, Entrega, Recibo, Interconsultas, Cultivos y DX; el modal muestra la caja actual (vacía) y 2 versiones con autor, dispositivo, hora y letras; «Restaurar» solo en las versiones con texto distinto',
    g1.btns.every(Boolean) && g1.open && g1.n === 2 && /Gerardo/.test(g1.first) && /Gera/.test(g1.first) && /PENROSE FID 30 ML SEROSO/.test(g1.first) && /48 → 0 letras/.test(g1.first) && /\(vacía\)/.test(g1.cur) && g1.sel === 'manejo' && g1.restoreBtns === 2, JSON.stringify(g1));

  // ── G2: restaurar pone el texto en la caja, lo sube como campo sucio y queda en ↩ Regresar ──
  const from2 = calls.length;
  const g2 = await page.evaluate(async () => {
    const k = pid(patients[0]);
    document.querySelector('[data-testid="hist-restore"]').click();
    await new Promise(r => setTimeout(r, 1500));
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]');
    const cur = (document.querySelector('[data-testid="hist-cur"]') || {}).textContent || '';
    const undo = (typeof _undoLoad === 'function') ? (_undoLoad()[k] || []).length : -1;
    return { nd: getNote(k).manejo, ta: ta ? ta.value : null, cur, undo, confirms: window.__confirms.length };
  });
  const post2 = calls.slice(from2).find(c => (c.m === 'POST' || c.m === 'PATCH') && c.url.startsWith('/rest/v1/notes') && c.body && typeof c.body.manejo === 'string');
  check('G2 «Restaurar esta versión»: la caja Misceláneo vuelve a tener el texto (modelo, textarea y modal); sube a la nube; queda un paso en ↩ Regresar',
    g2.nd === 'PENROSE FID 30 ML SEROSO\nSONDA FOLEY 800 ML/24 H' && g2.ta === g2.nd && /PENROSE FID 30 ML SEROSO/.test(g2.cur) && !!post2 && post2.body.manejo === g2.nd && g2.undo >= 1 && g2.confirms >= 1, JSON.stringify({ g2, post2: post2 && post2.body.manejo }));

  // ── G3: cambiar de caja en el selector consulta esa caja (sub-llave del checklist y Entrega); error de red se muestra ──
  const g3 = await page.evaluate(async () => {
    const sel = document.getElementById('hist-field'); sel.value = 'ck:recibo'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !/VIGILAR SANGRADO/.test((document.getElementById('hist-list') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 100));
    const recibo = (document.getElementById('hist-list') || {}).textContent || '';
    sel.value = 'entrega'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !/PENDIENTE TAC/.test((document.getElementById('hist-list') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 100));
    const entrega = (document.getElementById('hist-list') || {}).textContent || '';
    return { recibo: /VIGILAR SANGRADO/.test(recibo), entrega: /PENDIENTE TAC/.test(entrega) };
  });
  const rpcCampos = calls.filter(c => c.url.startsWith('/rest/v1/rpc/pl_historial_caja')).map(c => c.body && c.body.p_campo);
  rpcFail = true;
  const g3b = await page.evaluate(async () => {
    const sel = document.getElementById('hist-field'); sel.value = 'pendientes'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !/No se pudo cargar/.test((document.getElementById('hist-list') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 100));
    return (document.getElementById('hist-list') || {}).textContent || '';
  });
  rpcFail = false;
  check('G3 el selector consulta la caja elegida (ck:recibo y entrega llegan a la función SQL con ese nombre) y un fallo de red se muestra sin romper nada',
    g3.recibo && g3.entrega && rpcCampos.includes('ck:recibo') && rpcCampos.includes('entrega') && /No se pudo cargar/.test(g3b), JSON.stringify({ g3, rpcCampos, g3b: g3b.slice(0, 80) }));

  // ── G3c: base SIN v3 ni v2 (404 PGRST202): se cae a la v1; el Recibo guardado como texto JSON se muestra y se restaura decodificado;
  //        «recortada» por largo (6000) con la v1 y por la marca de_cortada con la v3 (texto corto pero almacenado al tope) ──
  rpcV2Missing = true;
  const g3c = await page.evaluate(async () => {
    const sel = document.getElementById('hist-field'); sel.value = 'ck:recibo'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !/VIGILAR/.test((document.getElementById('hist-list') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 100));
    const pre = document.querySelector('[data-testid="hist-item"] pre'); const txt = pre ? pre.textContent : '';
    const k = pid(patients[0]);
    document.querySelector('[data-testid="hist-restore"]').click(); await new Promise(r => setTimeout(r, 600));
    const recibo = (getNote(k).checklist || {}).recibo;
    sel.value = 'pendientes'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !document.querySelector('[data-testid="hist-cut"]'); i++) await new Promise(r => setTimeout(r, 100));
    const cut = !!document.querySelector('[data-testid="hist-cut"]'), cutTxt = (document.querySelector('[data-testid="hist-cut"]') || {}).textContent || '';
    return { txt, recibo, cut, cutTxt };
  });
  rpcV2Missing = false;
  const v3Calls = calls.filter(c => /\/rpc\/pl_historial_caja_v3$/.test(c.url)).length, v2Calls = calls.filter(c => /\/rpc\/pl_historial_caja_v2$/.test(c.url)).length, v1Calls = calls.filter(c => /\/rpc\/pl_historial_caja$/.test(c.url)).length;
  // de vuelta con la v3: la versión corta de Cultivos trae de_cortada = true → marca y aviso al restaurar
  const g3d = await page.evaluate(async () => {
    const sel = document.getElementById('hist-field'); sel.value = 'ck:cultivos'; sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 40 && !/HEMOCULTIVO/.test((document.getElementById('hist-list') || {}).textContent || ''); i++) await new Promise(r => setTimeout(r, 100));
    const cut = !!document.querySelector('[data-testid="hist-cut"]'); window.__confirms.length = 0;
    document.querySelector('[data-testid="hist-restore"]').click(); await new Promise(r => setTimeout(r, 300));
    return { cut, aviso: /recortada/.test(window.__confirms[0] || ''), cultivos: (getNote(pid(patients[0])).checklist || {}).cultivos };
  });
  check('G3c base sin v3 ni v2 (404): se cae a la v1 y el Recibo guardado como texto JSON se muestra y se restaura con saltos de línea y comillas reales; una versión de 6000 letras lleva la marca «recortada»; v2/v1 solo se usan en el respaldo; con la v3 una versión corta marcada de_cortada lleva la marca y avisa al restaurar',
    g3c.txt === '— Recibido 18/10 07:30 DG —\nVIGILAR "SANGRADO"' && g3c.recibo === g3c.txt && g3c.cut && /recortada a 6000/.test(g3c.cutTxt) && v3Calls >= 5 && v2Calls === 2 && v1Calls === 2
    && g3d.cut && g3d.aviso && g3d.cultivos === 'HEMOCULTIVO X2 EN PROCESO', JSON.stringify({ g3c: Object.assign({}, g3c, { cutTxt: g3c.cutTxt.slice(0, 40) }), g3d, v3Calls, v2Calls, v1Calls }));

  // ── G4: sección 🔄 Guardia: un solo encabezado, «Recibir guardia», Recibido de solo lectura y ✏️ Corregir ──
  const g4 = await page.evaluate(async () => {
    document.getElementById('hist-modal').style.display = 'none';
    const k = pid(patients[0]); const card = () => document.getElementById('card-' + k);
    const title = card().querySelector('.fc-guardia-title');
    const recibo = card().querySelector('textarea[data-ckfield="recibo"]');
    const ro1 = recibo.readOnly;
    const nd1 = getNote(k); nd1.entrega = 'VIGILAR DRENAJE 3\nK 2.9 EN REPOSICIÓN'; nd1.checklist.recibo = ''; noteData[k] = nd1; renderView();
    card().querySelector('[data-testid="gd-recibir"]').click();
    await new Promise(r => setTimeout(r, 300));
    const nd2 = getNote(k);
    const recibo2 = card().querySelector('textarea[data-ckfield="recibo"]'), entrega2 = card().querySelector('textarea[data-field="entrega"]');
    const ro2 = recibo2 && recibo2.readOnly, reciboTa = recibo2 && recibo2.value, entregaTa = entrega2 && entrega2.value;   // antes de ✏️ Corregir (es el mismo elemento)
    card().querySelector('[data-testid="gd-editar-recibo"]').click();
    const recibo3 = card().querySelector('textarea[data-ckfield="recibo"]');
    return { title: title ? title.textContent.replace(/\s+/g, ' ').trim() : null, inGrid: !!(title && title.parentElement.classList.contains('fc-guardia')), ro1, recibo: nd2.checklist.recibo, entregaVacia: nd2.entrega === '', reciboTa, entregaTa, ro2, editable: recibo3 && !recibo3.readOnly, focused: document.activeElement === recibo3,
      labels: [card().querySelector('#sec-entrega-' + k.replace(/[^a-zA-Z0-9]/g, '_') + ' .field-label').textContent, card().querySelector('#sec-recibo-' + k.replace(/[^a-zA-Z0-9]/g, '_') + ' .field-label').textContent].map(s => s.replace(/\s+/g, ' ').trim()) };
  });
  check('G4 Guardia: encabezado único «🔄 Guardia» con «📥 Recibir guardia» dentro de la rejilla (modo hoja intacto); Recibido es de solo lectura; recibir pasa el texto con sello a Recibido y vacía la entrega; ✏️ Corregir habilita la caja y la enfoca; etiquetas «Para la siguiente guardia» / «Recibido»',
    g4.title && /🔄 Guardia/.test(g4.title) && /Recibir guardia/.test(g4.title) && g4.inGrid && g4.ro1 === true
    && /^— Recibido \d{2}\/\d{2} \d{2}:\d{2}( [A-ZÁÉÍÓÚÑ]{1,3})? —\nVIGILAR DRENAJE 3\nK 2\.9 EN REPOSICIÓN$/.test(g4.recibo) && g4.entregaVacia && g4.reciboTa === g4.recibo && g4.entregaTa === '' && g4.ro2 === true
    && g4.editable && g4.focused && /Para la siguiente guardia/.test(g4.labels[0]) && /Recibido/.test(g4.labels[1]), JSON.stringify(g4));

  // ── G5: Procedimientos del día muestran quién lo agregó y a qué hora; EDITAR por el modal no cambia autor ni hora (ni en local ni en el PATCH) ──
  const from5 = calls.length;
  const g5 = await page.evaluate(async () => {
    procedimientos = [{ _id: 'p1', cama: '3-183', exp: '26-70001', nombre: 'RUIZ SOTO MATEO', edad: '58', dx: 'LAPE', esp: 'CG', adscrito: 'DR GARNELO', residente: 'DR FERNÁNDEZ', added_by: 'Diego', _addedAt: '2026-10-19T08:15:00' },
      { _id: 'p2', cama: '3-150', exp: '26-70002', nombre: 'LUNA MORA ANA', edad: '40', dx: 'HERNIA', esp: 'CG', adscrito: '', residente: '' }];
    const chipsOf = () => { const div = document.createElement('div'); div.innerHTML = renderProcSection(); return Array.from(div.querySelectorAll('[data-testid="proc-added-by"]')).map(e => e.textContent.replace(/\s+/g, ' ').trim()); };
    const chips = chipsOf();
    const rowNew = _procToRow({ cama: '3-151', nombre: 'X' });
    // editar el 1.º por el modal (otro usuario está en sesión): cambia el dx, no el autor ni la hora
    openProcModal(0); document.getElementById('pf-dx').value = 'LAPE + LAVADO'; saveProcModal(); await new Promise(r => setTimeout(r, 500));
    const after = procedimientos[0]; const chips2 = chipsOf();
    // crear uno nuevo por el modal: lleva al usuario actual y la hora de ahora
    openProcModal(); document.getElementById('pf-cama').value = '3-160'; document.getElementById('pf-nombre').value = 'PEREZ GIL LUIS'; saveProcModal(); await new Promise(r => setTimeout(r, 300));
    const nuevo = procedimientos[procedimientos.length - 1];
    const out = { chips, rowNewBy: rowNew.added_by, afterBy: after.added_by, afterAt: after._addedAt, afterDx: after.dx, chip0: chips2[0], nuevoBy: nuevo.added_by, nuevoAtOk: /^\d{4}-\d{2}-\d{2}T/.test(nuevo._addedAt || '') };
    procedimientos = []; return out;
  });
  const patch5 = calls.slice(from5).find(c => c.m === 'PATCH' && c.url.startsWith('/rest/v1/procedimientos_dia'));
  const post5 = calls.slice(from5).find(c => c.m === 'POST' && c.url.startsWith('/rest/v1/procedimientos_dia'));
  check('G5 procedimientos: cada fila dice 👤 quién lo agregó y la hora; sin dato muestra «?»; editar por el modal cambia el dx pero conserva autor y hora (el chip sigue «Diego · 08:15») y el PATCH no lleva added_by; uno nuevo lleva al usuario actual y la hora, y el POST sí lleva added_by',
    g5.chips.length === 2 && /👤 Diego · 08:15/.test(g5.chips[0]) && /👤 \?/.test(g5.chips[1]) && g5.rowNewBy === 'Gerardo Fernández'
    && g5.afterBy === 'Diego' && g5.afterAt === '2026-10-19T08:15:00' && g5.afterDx === 'LAPE + LAVADO' && /👤 Diego · 08:15/.test(g5.chip0)
    && !!patch5 && patch5.body && !('added_by' in patch5.body) && patch5.body.dx === 'LAPE + LAVADO'
    && g5.nuevoBy === 'Gerardo Fernández' && g5.nuevoAtOk && !!post5 && post5.body && post5.body.added_by === 'Gerardo Fernández', JSON.stringify({ g5, patch5: patch5 && patch5.body, post5: post5 && post5.body }));

  // ── G6: ninguna caja acepta arrastres de texto ni deja sacar texto arrastrando (el incidente: bloques movidos entre cajas) ──
  const g6 = await page.evaluate(() => {
    const k = pid(patients[0]); const card = document.getElementById('card-' + k);
    const src = card.querySelector('textarea[data-field="manejo"]'), dst = card.querySelector('textarea[data-field="pendientes"]');
    const mk = (type, el) => { const dt = new DataTransfer(); try { dt.setData('text/plain', 'BLOQUE'); } catch (_) {} const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(ev); return ev.defaultPrevented; };
    const ds = mk('dragstart', src), dov = mk('dragover', dst), drop = mk('drop', dst);
    const inp = document.createElement('input'); document.body.appendChild(inp); const dropInput = mk('drop', inp); inp.remove();
    const div = document.createElement('div'); document.body.appendChild(div); const dropDiv = mk('drop', div); div.remove();
    return { ds, dov, drop, dropInput, dropDiv, valDst: dst.value };
  });
  check('G6 arrastres: dragstart en una caja, dragover y drop sobre cajas e inputs se cancelan (el texto ni sale ni entra); un div normal sigue aceptando drops (zonas de fotos)',
    g6.ds && g6.dov && g6.drop && g6.dropInput && !g6.dropDiv && g6.valDst === 'PEND X', JSON.stringify(g6));

  // ── G7: un borrado grande de golpe en una caja deja paso en ↩ Regresar aunque la caja no suelte el foco, en el ORDEN correcto:
  //        arriba lo que había justo antes del borrón; debajo, lo que había al tomar el foco; soltar la caja no pone lo viejo encima ──
  const BIG7 = 'LINEA UNO DEL PLAN DEL DIA\nLINEA DOS CON MAS DETALLES\nLINEA TRES'; // 60+ letras
  const g7 = await page.evaluate(async (big) => {
    const k = pid(patients[0]); const card = document.getElementById('card-' + k);
    const ta = card.querySelector('textarea[data-field="pendientes"]'); const p0 = ta.value;
    ta.focus(); ta.dataset.beforeValue = ta.value;                   // como al tomar el foco (onfocus guarda beforeValue)
    ta.value = big; ta.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 50));
    const n0 = (_undoLoad()[k] || []).length;
    ta.value = ''; ta.dispatchEvent(new Event('input'));            // desaparece todo de golpe (tachadura / sobrescribir)
    const st1 = _undoLoad()[k] || []; const n1 = st1.length; const top1 = (st1[n1 - 1] || {}).note && st1[n1 - 1].note.pendientes, under1 = (st1[n1 - 2] || {}).note && st1[n1 - 2].note.pendientes;
    const toast = document.getElementById('undo-toast').style.display;
    ta.value = 'X'; ta.dispatchEvent(new Event('input'));            // teclazo normal: no apila otro paso
    const n2 = (_undoLoad()[k] || []).length;
    ta.dispatchEvent(new Event('change')); ta.blur(); await new Promise(r => setTimeout(r, 80));   // soltar la caja (onchange con beforeValue)
    const st3 = _undoLoad()[k] || []; const n3 = st3.length; const top3 = st3[n3 - 1].note.pendientes;
    // sub-caja del checklist: igual (dos pasos: lo de antes del borrón arriba, lo del foco debajo)
    const ck = card.querySelector('textarea[data-ckfield="interconsultas"]'); const ic0 = ck.value;
    ck.value = 'IC MEDICINA INTERNA VALORADO, SUGIERE AJUSTE DE ANTIBIOTICO'; ck.dispatchEvent(new Event('input'));
    const c0 = (_undoLoad()[k] || []).length; ck.value = ''; ck.dispatchEvent(new Event('input'));
    const stc = _undoLoad()[k] || []; const c1 = stc.length; const topC = stc[c1 - 1].note.checklist.interconsultas, underC = stc[c1 - 2].note.checklist.interconsultas;
    const u1 = (undoLast(k), getNote(k).checklist.interconsultas);   // 1.º Regresar: la IC tal como estaba antes del borrón
    const u2 = (undoLast(k), getNote(k).checklist.interconsultas);   // 2.º: como estaba al empezar a escribir en IC
    const u3 = (undoLast(k), getNote(k).pendientes);                 // 3.º: Pendientes justo antes del borrón
    const u4 = (undoLast(k), getNote(k).pendientes);                 // 4.º: Pendientes al tomar el foco
    return { p0, n0, n1, top1, under1, toast, n2, n3, top3, ic0, c0, c1, topC, underC, u1, u2, u3, u4 };
  }, BIG7);
  check('G7 borrado grande: al vaciar de golpe una caja se apilan dos pasos (arriba lo de justo antes del borrón, debajo lo del foco) y aparece el aviso; un teclazo normal no apila; soltar la caja no pone lo viejo encima; igual en una sub-caja del checklist; los Regresar devuelven en orden: IC borrada, IC inicial, Pendientes borrado, Pendientes inicial',
    g7.n1 === g7.n0 + 2 && g7.top1 === BIG7 && g7.under1 === g7.p0 && g7.toast === 'flex' && g7.n2 === g7.n1 && g7.n3 <= g7.n2 + 1 && g7.top3 === BIG7
    && g7.c1 === g7.c0 + 2 && /IC MEDICINA INTERNA/.test(g7.topC) && g7.underC === g7.ic0
    && /IC MEDICINA INTERNA/.test(g7.u1) && g7.u2 === g7.ic0 && g7.u3 === BIG7 && g7.u4 === g7.p0, JSON.stringify(g7));

  // ── G8: vigilante de Scribble en iPad: cuenta RÁFAGAS (los trazos de una palabra), no trazos; una palabra de 4 trazos cuyo texto
  //        llega después NO avisa; dos ráfagas seguidas sin texto → aviso «Garabatear»; pointercancel y toques cortos no cuentan ──
  const g8 = await page.evaluate(async () => {
    const k = pid(patients[0]); const card = document.getElementById('card-' + k);
    const ta = card.querySelector('textarea[data-field="manejo"]'); const r = ta.getBoundingClientRect();
    const S = window.__plScribbleWatch; S.strikes = 0; S.shownTs = 0; S.strikeTs = 0; S.wait = 600;   // espera corta para la prueba
    let nextId = 30;
    const stroke = (el, dx, endType) => { const id = nextId++; const ev = (t, x) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: id, pointerType: 'pen', isPrimary: true, clientX: r.left + x, clientY: r.top + 12, pressure: 0.5 })); ev('pointerdown', 10); ev('pointermove', 10 + dx / 2); ev('pointermove', 10 + dx); ev(endType || 'pointerup', 10 + dx); };
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const hintShown = () => { const h = document.getElementById('scribble-hint'); return !!h && h.style.display === 'flex'; };
    // fuera del iPad: nada
    window.__pl_force_ipad = false; stroke(ta, 80); await wait(900); const noIpad = S.strikes === 0 && !S.timer && !document.getElementById('scribble-hint');
    window.__pl_force_ipad = true;
    // una palabra de 4 trazos (0.3 s) y el texto de Scribble llega 0.2 s después del último: ni fallo ni aviso
    for (let i = 0; i < 4; i++) { stroke(ta, 80); await wait(100); }
    await wait(200); ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(900);
    const wordOk = S.strikes === 0 && !S.timer && !hintShown();
    // dos gestos que el sistema se queda (pointercancel: desplazar o seleccionar): no cuentan
    stroke(ta, 80, 'pointercancel'); stroke(ta, 80, 'pointercancel'); await wait(900); const cancelOk = S.strikes === 0 && !S.timer;
    // ráfaga sin texto → 1 fallo, sin aviso; otra ráfaga sin texto → aviso
    stroke(ta, 80); await wait(100); stroke(ta, 80); await wait(900); const one = S.strikes === 1 && !hintShown();
    stroke(ta, 80); await wait(900);
    const hint = document.getElementById('scribble-hint'); const shown = hintShown() && /Garabatear/.test(hint.textContent);
    const cs = hint ? getComputedStyle(hint) : {}; const rb = hint ? hint.getBoundingClientRect() : { bottom: 0, top: 0 };
    const abajo = cs.bottom === '16px' && Math.abs(window.innerHeight - rb.bottom - 16) < 2 && rb.top > 200 && parseInt(cs.zIndex, 10) < 9998;   // abajo del todo, lejos de la barra fija, bajo los modales
    hint.querySelector('button').click(); const dismissed = hint.style.display === 'none';
    // con texto que entra (Scribble funcionando) la ráfaga se descarta y los fallos previos se olvidan
    S.strikes = 1; stroke(ta, 80); ta.dispatchEvent(new Event('input', { bubbles: true })); const typedNow = S.strikes === 0 && !S.timer; await wait(900); const typedOk = typedNow && S.strikes === 0;
    // un toque corto (poner el cursor) no cuenta
    stroke(ta, 8); await wait(900); const shortOk = S.strikes === 0 && !S.timer;
    // un fallo suelto de hace más de 30 s no se suma al nuevo
    S.strikes = 1; S.strikeTs = Date.now() - 40000; S.shownTs = 0; stroke(ta, 80); await wait(900); const decayOk = S.strikes === 1 && !hintShown();
    window.__pl_force_ipad = false; S.strikes = 0; S.wait = 2200;
    return { noIpad, wordOk, cancelOk, one, shown, abajo, dismissed, typedOk, shortOk, decayOk };
  });
  check('G8 vigilante de Scribble (solo iPad): una palabra de 4 trazos con texto después no avisa; pointercancel no cuenta; una ráfaga sin texto = 1 fallo, la segunda muestra el aviso «Ajustes → Apple Pencil → Garabatear» abajo (bajo los modales) y se cierra con Entendido; texto que entra descarta la ráfaga y los fallos; toque corto no cuenta; un fallo de hace 30 s no se suma; fuera del iPad nunca',
    g8.noIpad && g8.wordOk && g8.cancelOk && g8.one && g8.shown && g8.abajo && g8.dismissed && g8.typedOk && g8.shortOk && g8.decayOk, JSON.stringify(g8));

  // ── G9: ↩ Regresar / ↪ Rehacer acotados a la caja del paso (no pisan lo que un compañero escribió en otra caja por Realtime);
  //        el ↩ Deshacer del aviso deshace al paciente que lo anunció; guarda de arrastre: beforeinput deleteByDrag/insertFromDrop y contenteditable ──
  const from9 = calls.length;
  const g9 = await page.evaluate(async () => {
    const k = pid(patients[0]); const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const p0 = getNote(k).pendientes;
    updateField(k, 'pendientes', 'PLAN A DEL RESIDENTE');                     // paso propio: solo Pendientes
    const toastKey = _toastUndoKey;
    // un compañero cambia Misceláneo desde otro dispositivo (Realtime) después del paso
    _suppressRealtimeKeys.clear();
    const nd = getNote(k); const row = { patient_id: 'a1', checklist: JSON.parse(JSON.stringify(nd.checklist || {})), entrega: nd.entrega || '' };
    ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes'].forEach(f => { row[f] = nd[f] || ''; });
    row.manejo = 'MANEJO DEL COLEGA'; handleNoteChange({ eventType: 'UPDATE', new: row }); await wait(100);
    const colega = getNote(k).manejo;
    const uLabel = undoLast(k); await wait(300);                                // ↩ Regresar: solo Pendientes vuelve
    const a = { pend: getNote(k).pendientes, manejo: getNote(k).manejo, uLabel };
    redoLast(k); await wait(300);                                              // ↪ Rehacer: solo Pendientes
    const b = { pend: getNote(k).pendientes, manejo: getNote(k).manejo };
    // el aviso «Cambio guardado ↩ Deshacer» pertenece a este paciente aunque después se apile un paso de OTRO (novedades automáticas)
    noteData['zz'] = defaultData(); _undoPush('zz', 'novedades automáticas en entrega (1)', ['entrega']); const lastKey = _lastUndoKey;
    undoLastField(); await wait(300);
    const c = { pend: getNote(k).pendientes, manejo: getNote(k).manejo, toastKey, lastKey };
    delete noteData['zz']; delete _undoLoad()['zz']; _undoSave();
    redoLast(k); await wait(1500);                                             // dejar Pendientes en PLAN A y que salgan los envíos pendientes
    // guarda de arrastre: beforeinput de arrastre cancelado, teclear no; contenteditable: selección no se arrastra, ítem sí; drop sin itemId no
    const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]');
    const bi = (type) => { const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: type, data: 'X' }); ta.dispatchEvent(ev); return ev.defaultPrevented; };
    const d = { byDrag: bi('deleteByDrag'), fromDrop: bi('insertFromDrop'), typing: bi('insertText'), paste: bi('insertFromPaste') };
    const ce = document.createElement('div'); ce.contentEditable = 'true'; ce.textContent = 'ITEM DEL TABLERO'; document.body.appendChild(ce);
    const range = document.createRange(); range.selectNodeContents(ce); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const drag = (type, el, withItem) => { const dt = new DataTransfer(); try { dt.setData('text/plain', 'T'); if (withItem) dt.setData('itemId', '1'); } catch (_) {} const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(ev); return ev.defaultPrevented; };
    d.ceSelDrag = drag('dragstart', ce, false); sel.removeAllRanges(); d.ceItemDrag = drag('dragstart', ce, true);
    d.ceDropText = drag('drop', ce, false); d.ceDropItem = drag('drop', ce, true); ce.remove();
    return { k, p0, colega, a, b, c, d };
  });
  const post9 = calls.slice(from9).filter(c => (c.m === 'POST' || c.m === 'PATCH') && c.url.startsWith('/rest/v1/notes') && c.body).map(c => c.body);
  const manejoViejo = post9.some(b => typeof b.manejo === 'string' && b.manejo !== 'MANEJO DEL COLEGA');
  check('G9 Regresar/Rehacer acotados a la caja del paso: tras un cambio ajeno en Misceláneo (Realtime), Regresar solo devuelve Pendientes y deja el Misceláneo del colega (y ningún envío lleva el Misceláneo viejo); Rehacer igual; el ↩ Deshacer del aviso deshace a ESTE paciente aunque después se apile un paso de otro; beforeinput deleteByDrag/insertFromDrop se cancelan (teclear y pegar no); en contenteditable la selección no se arrastra pero el ítem sí, y un drop de texto sin itemId se cancela',
    g9.colega === 'MANEJO DEL COLEGA' && g9.a.pend === g9.p0 && g9.a.manejo === 'MANEJO DEL COLEGA' && /Pendientes/.test(g9.a.uLabel) && !manejoViejo
    && g9.b.pend === 'PLAN A DEL RESIDENTE' && g9.b.manejo === 'MANEJO DEL COLEGA'
    && g9.c.toastKey === g9.k && g9.c.lastKey === 'zz' && g9.c.pend === g9.p0 && g9.c.manejo === 'MANEJO DEL COLEGA' && post9.length >= 1
    && g9.d.byDrag && g9.d.fromDrop && !g9.d.typing && !g9.d.paste && g9.d.ceSelDrag && !g9.d.ceItemDrag && g9.d.ceDropText && !g9.d.ceDropItem, JSON.stringify({ g9, manejoViejo, posts: post9.length }));

  // ── G10: banda de escritura del lápiz en campos chicos (iPad): FC del Pase Matutino se agranda al tocarlo con el lápiz y vuelve al soltar el foco;
  //         el dedo no la agranda; fuera del iPad nunca; una caja grande (textarea) no cambia ──
  const g10 = await page.evaluate(async () => {
    const k = pid(patients[0]); const ek = k.replace(/[^a-zA-Z0-9]/g, '_'); const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const fc = document.querySelector('#ck-row-' + ek + ' input[data-field="pm_fc"]'); const ta = document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-field="manejo"]');
    const w0 = fc.getBoundingClientRect().width;
    const pd = (el, type) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 41, pointerType: type, isPrimary: true, clientX: r.left + 5, clientY: r.top + 5, pressure: 0.5 })); };
    window.__pl_force_ipad = false; pd(fc, 'pen'); const noIpad = !fc.classList.contains('pen-band');
    window.__pl_force_ipad = true; pd(fc, 'touch'); const finger = !fc.classList.contains('pen-band');
    pd(fc, 'pen'); fc.focus(); await wait(50);
    const on = fc.classList.contains('pen-band'); const w1 = fc.getBoundingClientRect().width, h1 = fc.getBoundingClientRect().height, fs = parseFloat(getComputedStyle(fc).fontSize);
    // otro campo chico con el lápiz: la banda pasa a ese campo
    const fr = document.querySelector('#ck-row-' + ek + ' input[data-field="pm_fr"]'); pd(fr, 'pen'); fr.focus(); await wait(300);
    const moved = !fc.classList.contains('pen-band') && fr.classList.contains('pen-band');
    fr.blur(); await wait(350); const off = !fr.classList.contains('pen-band') && Math.abs(fr.getBoundingClientRect().width - w0) < 2;
    pd(ta, 'pen'); const taSame = !ta.classList.contains('pen-band');
    window.__pl_force_ipad = false;
    return { w0, noIpad, finger, on, w1, h1, fs, moved, off, taSame };
  });
  check('G10 banda de escritura (iPad): FC del Pase Matutino pasa de ~52 px a ≥ 200 px, ≥ 48 px de alto y letra ≥ 20 px al tocarlo con el lápiz; el dedo no la activa; fuera del iPad tampoco; al tocar otro campo la banda cambia de campo y al soltar el foco vuelve al tamaño original; una caja grande no cambia',
    g10.w0 < 80 && g10.noIpad && g10.finger && g10.on && g10.w1 >= 200 && g10.h1 >= 48 && g10.fs >= 20 && g10.moved && g10.off && g10.taSame, JSON.stringify(g10));

  check('final: sin errores de JavaScript en la página', errors.length === 0, JSON.stringify(errors.slice(0, 3)));
  await browser.close();
  console.log('RESULT APP-GUARDIA: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
