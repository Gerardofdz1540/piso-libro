// Modo Hoja (oct 2026): la ficha como la hoja de visita de GoodNotes.
//  H1 toggleHojaMode: body.pl-hoja, recordado en localStorage, la ficha pasa a cuadrícula con áreas y TODAS las cajas abiertas
//  H2 ⚙ Cajas: ocultar un bloque lo quita de la hoja (display none) y se recuerda; al volver a Tarjeta no afecta la memoria Pase/Completo
//  H3 Pase matutino con fecha: vitales de ayer → al escribir hoy pasan al historial (pm_hist), la fila queda limpia, chip "hoy", Regresar disponible
//  H4 ➕ Hoy en Interconsultas / Cultivos: anota "dd/mm INI: " al final y marca el campo sucio; no duplica si ya está;
//     🕓 «➕ Ahora» en la Cronología anota "dd/mm hh:mm INI: " (19 oct 2026: ya no hay caja Recibido ni ➕ Hoy en Entrega)
//  H5 Impresión: en modo Hoja cada tarjeta corta página (break-after: page)
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
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1300, height: 1200 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  await page.route('**/vendor/supabase*', r => r.abort());
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'a1', cama: '3-101', exp: '1', nombre: 'PACIENTE UNO', esp: 'CG', dx: 'DX PRUEBA' }]); return json(200, [{ id: 'a1' }]); }
    if (url.startsWith('/rest/v1/notes')) {
      if (m === 'GET') return json(200, [{ patient_id: 'a1', app: 'APP X', pa: 'PA Y', pendientes: '', lab_history: [], imagen_history: [], checklist: { pm_fecha: yesterday, pm_fc: '94', pm_ta: '120/80', pm_temp: '36.5', interconsultas: 'MI: valorado', cultivos: '', recibo: '' } }]);
      return json(201, [{ patient_id: 'a1' }]);
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);
  check('init: sin errores no capturados', errors.length === 0, errors.join(' | '));

  // H1
  const h1 = await page.evaluate(() => {
    const k = pid(patients[0]);
    const before = { hoja: isHojaMode(), details: Array.from(document.querySelectorAll('#card-' + CSS.escape(k) + ' details.fc-sec')).map(d => d.open) };
    toggleHojaMode();
    const card = document.getElementById('card-' + k);
    const bento = card && card.querySelector('.fc-bento');
    const cs = bento ? getComputedStyle(bento) : null;
    const details = Array.from(card.querySelectorAll('details.fc-sec'));
    const hist = card.querySelector('details[data-sec="historia"]');
    return {
      before, hoja: isHojaMode(), ls: localStorage.getItem('pl_hoja'), bodyClass: document.body.classList.contains('pl-hoja'),
      display: cs && cs.display, areas: cs && cs.gridTemplateAreas, cols: cs && cs.gridTemplateColumns.split(' ').length,
      nDetails: details.length, allOpen: details.every(d => d.open), histArea: hist ? getComputedStyle(hist).gridArea : null,
      navBtn: !!Array.from(document.querySelectorAll('#board-nav .bn-mode')).find(b => /Hoja/.test(b.textContent)), cfg: !!document.querySelector('#board-nav .hoja-cfg'),
    };
  });
  check('H1 Modo Hoja: body.pl-hoja + localStorage, la ficha es una cuadrícula de 4 columnas con áreas, todas las cajas abiertas, botón y ⚙ Cajas en la barra',
    !h1.before.hoja && h1.hoja && h1.ls === '1' && h1.bodyClass && h1.display === 'grid' && /dx dx dx dx/.test(h1.areas || '') && h1.cols === 4 && h1.nDetails >= 5 && h1.allOpen && /hist/.test(h1.histArea || '') && h1.navBtn && h1.cfg, JSON.stringify(h1));

  // H2
  const h2 = await page.evaluate(() => {
    const k = pid(patients[0]);
    toggleHojaBlock('sug');
    const sug = document.querySelector('#card-' + CSS.escape(k) + ' details[data-sec="sug"]');
    const hiddenNow = sug ? getComputedStyle(sug).display === 'none' : null;
    const hid = JSON.parse(localStorage.getItem('pl_hoja_hide') || '[]');
    // clic en un summary en modo Hoja no pliega ni guarda estado
    const memBefore = localStorage.getItem('pl_sec_open');
    const d = document.querySelector('#card-' + CSS.escape(k) + ' details[data-sec="ic"]');
    d.querySelector('summary').click();
    const stillOpen = d.open;
    const memAfter = localStorage.getItem('pl_sec_open');
    toggleHojaBlock('sug');
    const sug2 = document.querySelector('#card-' + CSS.escape(k) + ' details[data-sec="sug"]');
    return { hiddenNow, hid, stillOpen, memSame: memBefore === memAfter, visibleAgain: sug2 ? getComputedStyle(sug2).display !== 'none' : null, hid2: JSON.parse(localStorage.getItem('pl_hoja_hide') || '[]') };
  });
  check('H2 ⚙ Cajas: ocultar/mostrar un bloque se aplica y se recuerda; en Hoja las cajas no se pliegan ni tocan la memoria Pase/Completo',
    h2.hiddenNow === true && h2.hid.includes('sug') && h2.stillOpen && h2.memSame && h2.visibleAgain === true && !h2.hid2.includes('sug'), JSON.stringify(h2));

  // H3
  const h3 = await page.evaluate((yesterday) => {
    const k = pid(patients[0]);
    const ek = k.replace(/[^a-zA-Z0-9]/g, '_');
    const wrap = document.getElementById('ck-row-' + ek);
    const chipBefore = wrap.querySelector('.pm-date') ? wrap.querySelector('.pm-date').textContent : null;
    const n0 = _undoCount(k);
    const inpFc = wrap.querySelector('.pm-input[data-field="pm_fc"]');
    inpFc.value = '88'; updatePmField(k, 'pm_fc', '88');
    const cl = getNote(k).checklist;
    const inpTa = wrap.querySelector('.pm-input[data-field="pm_ta"]');
    const hist = wrap.querySelector('.pm-hist');
    return {
      chipBefore, fecha: cl.pm_fecha, today: todayStr(), fc: cl.pm_fc, ta: cl.pm_ta, temp: cl.pm_temp,
      hist: cl.pm_hist, taDom: inpTa ? inpTa.value : null, fcDom: inpFc.value,
      chipAfter: wrap.querySelector('.pm-date') ? wrap.querySelector('.pm-date').textContent : null, histTxt: hist ? hist.textContent : '',
      undoLabel: _undoLastLabel(k), undoMore: _undoCount(k) > n0, pending: Array.from(_pendingDirty[k] || []),
    };
  }, yesterday);
  check('H3 Pase con fecha: vitales de ayer pasan al historial al escribir hoy; fila limpia salvo lo escrito; chip "hoy"; historial visible; Regresar; checklist pendiente de subir',
    /de /.test(h3.chipBefore || '') && h3.fecha === h3.today && h3.fc === '88' && h3.ta === '' && h3.temp === '' && Array.isArray(h3.hist) && h3.hist.length === 1 && h3.hist[0].fecha === yesterday && h3.hist[0].fc === '94' && h3.hist[0].ta === '120/80'
    && h3.taDom === '' && h3.fcDom === '88' && h3.chipAfter === 'hoy' && /FC 94/.test(h3.histTxt) && /TA 120\/80/.test(h3.histTxt) && /historial/.test(h3.undoLabel) && h3.undoMore && h3.pending.includes('checklist'), JSON.stringify(h3));

  // H4
  const h4 = await page.evaluate(() => {
    const k = pid(patients[0]);
    const d = new Date(); const ini = userInitials(); const stamp = String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + (ini ? ' ' + ini : '') + ': ';
    insertTodayStamp(k, 'interconsultas', true, 'Interconsultas');
    insertTodayStamp(k, 'interconsultas', true, 'Interconsultas'); // no duplica
    insertTodayStamp(k, 'cultivos', true, 'Cultivos');
    cronoInsertNow(k);                                             // 🕓 Cronología (19 oct 2026): «➕ Ahora» = fecha + hora + iniciales
    const nd = getNote(k);
    const dirty = Array.from(_dirtyUnion(k));
    const btns = ['interconsultas', 'cultivos'].map(f => !!document.querySelector('#card-' + CSS.escape(k) + ' button[onclick*="insertTodayStamp"][onclick*="\'' + f + '\'"]'));
    const ahoraBtn = !!document.querySelector('#card-' + CSS.escape(k) + ' [data-testid="crono-ahora"]');
    const noRecibo = !document.querySelector('#card-' + CSS.escape(k) + ' textarea[data-ckfield="recibo"]');
    return { stamp, ic: nd.checklist.interconsultas, cult: nd.checklist.cultivos, entrega: nd.entrega, dirty, btns, ahoraBtn, noRecibo };
  });
  check('H4 ➕ Hoy: anota "dd/mm INI: " al final de IC (sin duplicar) y Cultivos; 🕓 «➕ Ahora» anota "dd/mm hh:mm INI: " al final de la Cronología; campos sucios; botones presentes; ya no hay caja Recibido',
    h4.ic === 'MI: valorado\n' + h4.stamp && h4.cult === h4.stamp && /^\d{2}\/\d{2} \d{2}:\d{2}( \S+)?: $/.test(h4.entrega)
    && h4.dirty.includes('ck_interconsultas') && h4.dirty.includes('ck_cultivos') && h4.dirty.includes('entrega') && h4.btns.every(Boolean) && h4.ahoraBtn && h4.noRecibo, JSON.stringify(h4));

  // H5
  await page.emulateMedia({ media: 'print' });
  const h5 = await page.evaluate(() => {
    const k = pid(patients[0]);
    const card = document.getElementById('card-' + k);
    const cs = getComputedStyle(card);
    const nav = document.getElementById('board-nav');
    return { cls: card.className, breakAfter: cs.breakAfter || cs.pageBreakAfter, navHidden: nav ? getComputedStyle(nav).display === 'none' : null };
  });
  await page.emulateMedia({ media: 'screen' });
  check('H5 Impresión en modo Hoja: cada tarjeta corta página y la barra de navegación no se imprime',
    /page|always/.test(h5.breakAfter || '') && h5.navHidden === true, JSON.stringify(h5));

  // Volver a Tarjeta: sin clase y la cuadrícula vuelve a 2 columnas
  const back = await page.evaluate(() => {
    toggleHojaMode();
    const k = pid(patients[0]);
    const bento = document.querySelector('#card-' + CSS.escape(k) + ' .fc-bento');
    return { hoja: isHojaMode(), cls: document.body.classList.contains('pl-hoja'), cols: bento ? getComputedStyle(bento).gridTemplateColumns.split(' ').length : null };
  });
  check('H6 Volver a Tarjeta: se quita la clase y la ficha vuelve a 2 columnas', !back.hoja && !back.cls && back.cols === 2, JSON.stringify(back));

  check('final: sin errores no capturados', errors.length === 0, errors.join(' | '));
  console.log('RESULT APP-HOJA: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
