const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const fs = require('fs'); const path = require('path');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture_ego_bh.json'), 'utf8'));
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
const d = new Date(); const dd = String(d.getDate()).padStart(2,'0'), mm = String(d.getMonth()+1).padStart(2,'0'), yyyy = d.getFullYear();
const todayLocal = `${yyyy}-${mm}-${dd}`;
const mkReport = (hb) => ({ __cells: ['', '', '', `${dd}/${mm}/${yyyy} 06:10`, `${dd}/${mm}/${yyyy} 08:00`, '', ''], __hasLink: true,
  valores: FIX.valores.map(v => v.estudio === 'HEMOGLOBINA' ? { ...v, valor: hb } : v) });
const wlRow = (hb, scrapedAt) => ({ exp: '26-05099', paciente: 'PEREZ LOPEZ JUAN', fecha: todayLocal, scraped_at: scrapedAt, data: { headers: [], reportes: [mkReport(hb)] } });
(async()=>{
  const browser=await launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  const calls=[];
  let wlRows = [wlRow('7.70', '2026-01-01T05:00:00+00:00')];
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=req.url().replace(/^https?:\/\/[^/]+/,''); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      // Dos camas (nombres inventados): la segunda no tiene fila de WinLab al arrancar (ver W10).
      if (m==='GET') return json(200, [{ id:'a1', cama:'3-101', exp:'26-05099', nombre:'PEREZ LOPEZ JUAN', esp:'CG', edad:'60' }, { id:'a2', cama:'3-102', exp:'26-07777', nombre:'GOMEZ DIAZ ANA', esp:'CG', edad:'45' }]);
      if (m==='PATCH') return json(200, [{ id:'a1' }]);
      return json(201, [{ id:'a1' }]);
    }
    if (url.startsWith('/rest/v1/winlab_labs')) { wlRows.forEach(r => { r.scraped_at = r.scraped_at; }); return json(200, wlRows.map(r => ({ ...r, scraped_at: r.scraped_at }))); }
    if (url.startsWith('/rest/v1/notes') && m==='POST') { const row = Array.isArray(body) ? body[0] : body; return json(201, [{ patient_id: (row && row.patient_id) || 'a1' }]); }
    return json(200, []);
  });
  // scraped_at reciente para pasar el filtro de 4 días del mock (el mock no filtra, pero la app sí lo manda)
  wlRows[0].scraped_at = new Date(Date.now() - 3600e3).toISOString();
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto(BASE_URL + '/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(6000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));

  // Consulta acotada
  const wlGet = calls.find(c => c.m==='GET' && c.url.startsWith('/rest/v1/winlab_labs'));
  const q = await page.evaluate(() => _winlabRowsQuery([{ exp: '26-05099' }, { exp: '' }]));
  check('W1 consulta winlab_labs acotada: exp=in.(variantes) + scraped_at=gte.(4 días) + limit',
    !!wlGet && /exp=in\.\(/.test(wlGet.url) && /scraped_at=gte\./.test(wlGet.url) && q.includes('26-05099') && q.includes('2605099') && q.includes('05099') && /scraped_at=gte\.\d{4}/.test(q),
    JSON.stringify({ url: wlGet && wlGet.url, q }));
  const since = decodeURIComponent((q.match(/scraped_at=gte\.([^&]+)/)||[])[1] || '');
  const ageDays = (Date.now() - new Date(since).getTime()) / 86400e3;
  check('W1b ventana de 4 días', ageDays > 3.9 && ageDays < 4.1, String(ageDays));

  // Sync aplicado al arranque: mapeo correcto (sin pH/leucos urinarios en sangre) y fila PARCIAL
  const st = await page.evaluate(async () => {
    await applyWinlabSyncToPatients({ verbose:false });
    const k = pid(patients[0]); const nd = noteData[k]; const s = (nd.labHistory||[])[0] || {};
    return { k, fecha: s.fecha, labs: s.labs, source: s.source };
  });
  check('W2 mapeo: hb/leucos/plaq de sangre, pH/proteínas/leucos urinarios en ego_*',
    st.labs && st.labs.hb==='7.70' && st.labs.leucos==='11.37' && st.labs.plaq==='472' && !('ph' in st.labs) && st.labs.ego_ph==='8.5' && st.labs.ego_prot==='30' && st.source==='winlab' && st.fecha===todayLocal,
    JSON.stringify(st));
  await page.waitForTimeout(2500);
  const notePosts = () => calls.filter(c => c.m==='POST' && c.url.startsWith('/rest/v1/notes'));
  const np1 = notePosts();
  check('W3 el push de la nota es PARCIAL (lab_history, sin texto clínico)', np1.length>=1 && np1.every(c => c.body && ('lab_history' in c.body) && !('manejo' in c.body) && !('pendientes' in c.body)),
    JSON.stringify(np1.map(c => Object.keys(c.body||{}))));

  // Idempotencia: volver a sincronizar sin cambios no vuelve a guardar
  const before = notePosts().length;
  const st2 = await page.evaluate(async () => { const s = await applyWinlabSyncToPatients({ verbose:false }); return s; });
  await page.waitForTimeout(2500);
  check('W4 sync idempotente: sin cambios → unchanged, sin nuevo POST a notes', notePosts().length===before && st2.unchanged>=1 && !st2.saved, JSON.stringify({ posts: notePosts().length - before, st2 }));

  // Realtime: fila nueva → sync + tarjeta
  const before2 = notePosts().length;
  const newRow = wlRow('8.00', new Date().toISOString());
  await page.evaluate((row) => { handleWinlabChange({ eventType:'INSERT', new: row }); }, newRow);
  await page.waitForTimeout(3000);
  const st3 = await page.evaluate(() => { const k = pid(patients[0]); const s = (noteData[k].labHistory||[])[0] || {}; return { hb: s.labs && s.labs.hb, n: (noteData[k].labHistory||[]).length }; });
  check('W5 handleWinlabChange aplica el sync (hb 7.70 → 8.00) y guarda una vez', st3.hb==='8.00' && st3.n===1 && notePosts().length===before2+1, JSON.stringify({ st3, posts: notePosts().length-before2 }));

  // Novedades de labs: tras el sync hay aviso (banda, chip del rail, botón en tarjeta) y "Visto" lo quita
  const w6 = await page.evaluate(() => {
    const k = pid(patients[0]);
    const news = _labNewsFor(k);
    const banner = document.getElementById('lab-news-banner');
    const bannerVisible = !!banner && banner.style.display !== 'none' && /3-101/.test(banner.textContent) && /Hb 8\.00/.test(banner.textContent);
    const rail = !!document.querySelector('.bs-btn[data-k="' + k + '"] .bs-new');
    const badge = !!document.querySelector('#card-' + CSS.escape(k) + ' .badge-labnew');
    const pase = (document.querySelector('#card-' + CSS.escape(k) + ' .pase-line') || {}).textContent || '';
    labNewsMarkSeen(k);
    const after = { news: !!_labNewsFor(k), bannerHidden: (document.getElementById('lab-news-banner') || {}).style.display === 'none', rail: !!document.querySelector('.bs-btn[data-k="' + k + '"] .bs-new') };
    return { hasNews: !!news && news.items.some(i => i.key==='hb' && i.valor==='8.00'), bannerVisible, rail, badge, pase, after };
  });
  check('W6 novedades de labs: banda con cama y Hb, 🧪 en el rail, botón en la tarjeta; "Visto" lo limpia', w6.hasNews && w6.bannerVisible && w6.rail && w6.badge && !w6.after.news && w6.after.bannerHidden && !w6.after.rail, JSON.stringify(w6));
  check('W7 línea de pase en la cabecera con los labs clave (Hb con flecha ▲ 7.70→8.00)', /🧪/.test(w6.pase) && /Hb 8\.00/.test(w6.pase), JSON.stringify(w6.pase));

  // ── Bucle de labs (19 oct 2026): jsonb reordena las llaves de `labs`; antes cada sync "veía" un cambio y re-subía
  //    lab_history de todos (audit_log + Realtime + toast en cada iPad). Mismos valores ⇒ nada que guardar. ──
  const before8 = notePosts().length;
  const w8 = await page.evaluate(async () => {
    const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
    const k = pid(patients[0]); const nd = noteData[k];
    const naive = JSON.stringify(nd.labHistory[0].labs);
    // Como regresa de Postgres: mismas cifras, llaves en otro orden (en el snapshot y en labs)
    nd.labHistory = nd.labHistory.map(s => rev(Object.assign({}, s, { labs: rev(s.labs) })));
    lsSaveNote(k, nd);
    const syncedBefore = nd.labHistory[0].synced_at;
    const st = await applyWinlabSyncToPatients({ verbose: false });
    const after = noteData[k].labHistory[0];
    return { saved: st.saved || 0, unchanged: st.unchanged || 0, changed: st.changed_keys || [], syncedSame: after.synced_at === syncedBefore, orderDiffers: JSON.stringify(after.labs) !== naive, hb: after.labs.hb,
      sigSame: typeof _wlHistSig === 'function' && _wlHistSig(noteData[k].labHistory) === _wlHistSig([{ fecha: after.fecha, labs: rev(after.labs), source: 'winlab', synced_at: 'otro' }]) };
  });
  await page.waitForTimeout(2500);
  check('W8 mismos labs con las llaves en otro orden (vuelta por jsonb): firma igual, sin guardar, sin POST a notes, synced_at intacto',
    w8.saved === 0 && w8.unchanged >= 1 && w8.changed.length === 0 && w8.syncedSame && w8.orderDiffers && w8.sigSame && w8.hb === '8.00' && notePosts().length === before8, JSON.stringify({ w8, posts: notePosts().length - before8 }));

  // W9: un analito nuevo en la misma fecha → exactamente un guardado (y solo ese paciente en changed_keys)
  const before9 = notePosts().length;
  const row9 = wlRow('8.00', new Date(Date.now() + 1000).toISOString());
  row9.data.reportes[0].valores.push({ valor: '140', unidad: 'U/L', estudio: 'AMILASA', referencia: '28 - 100' });
  const w9 = await page.evaluate(async (row) => {
    winlabByExp[row.exp] = row; winlabRowsByExp[row.exp] = [row]; _winlabExpIndex = null;
    const st = await applyWinlabSyncToPatients({ verbose: false });
    const k = pid(patients[0]); const s = noteData[k].labHistory[0];
    return { saved: st.saved || 0, changed: st.changed_keys || [], k, amilasa: s.labs.amilasa, hb: s.labs.hb, n: noteData[k].labHistory.length };
  }, row9);
  await page.waitForTimeout(2500);
  check('W9 un analito nuevo (amilasa 140) → exactamente un guardado y un POST; changed_keys solo trae a ese paciente',
    w9.saved === 1 && w9.changed.length === 1 && w9.changed[0] === w9.k && w9.amilasa === '140' && w9.hb === '8.00' && w9.n === 1 && notePosts().length === before9 + 1, JSON.stringify({ w9, posts: notePosts().length - before9 }));

  // W10: Realtime de winlab_labs de ANA (3-102) → UNA pasada del sync SOLO para ANA (no todo el censo) y un POST, el de ANA
  await page.evaluate(() => {
    window.__wlRuns = []; const orig = applyWinlabSyncToPatients;
    applyWinlabSyncToPatients = function (o) { window.__wlRuns.push(o && Array.isArray(o.only) ? o.only.map(p => pid(p)) : 'TODOS'); return orig.apply(this, arguments); };
  });
  const before10 = notePosts().length;
  const rowB = { exp: '26-07777', paciente: 'GOMEZ DIAZ ANA', fecha: todayLocal, scraped_at: new Date().toISOString(), data: { headers: [], reportes: [mkReport('12.10')] } };
  await page.evaluate((row) => { handleWinlabChange({ eventType: 'INSERT', new: row }); }, rowB);
  await page.waitForTimeout(2300);
  const w10 = await page.evaluate(() => {
    const a = pid(patients[0]), b = pid(patients[1]); const hB = (noteData[b] && noteData[b].labHistory) || [];
    return { runs: window.__wlRuns, a, b, hbB: hB[0] && hB[0].labs && hB[0].labs.hb, toast: (document.getElementById('rt-toast') || {}).textContent || '' };
  });
  await page.waitForTimeout(1200);
  const posts10 = notePosts().slice(before10);
  check('W10 fila de WinLab de ANA: una sola pasada, solo para ANA; Hb 12.10 en su nota; un POST (el de ANA) y el aviso 🧪 la nombra',
    w10.runs.length === 1 && Array.isArray(w10.runs[0]) && w10.runs[0].length === 1 && w10.runs[0][0] === w10.b && w10.hbB === '12.10' && posts10.length === 1 && posts10[0].body.patient_id === 'a2' && /🧪 Labs WinLab actualizados: GOMEZ DIAZ ANA/.test(w10.toast) && !/PEREZ/.test(w10.toast),
    JSON.stringify({ w10, posts: posts10.map(c => c.body && c.body.patient_id) }));

  // W11: ráfaga del robot: 5 filas de JUAN en 1 s → UNA pasada y UN POST (queda la Hb de la última fila)
  await page.evaluate(() => { window.__wlRuns = []; });
  const before11 = notePosts().length;
  for (let i = 1; i <= 5; i++) {
    const r = wlRow('8.' + i + '0', new Date(Date.now() + 2000 + i * 1000).toISOString());   // scraped_at creciente: ninguna fila se descarta como vieja
    await page.evaluate((row) => { handleWinlabChange({ eventType: 'UPDATE', new: row }); }, r);
    await page.waitForTimeout(180);
  }
  await page.waitForTimeout(3200);
  const w11 = await page.evaluate(() => { const k = pid(patients[0]); return { runs: window.__wlRuns, k, hb: noteData[k].labHistory[0].labs.hb, pend: typeof _wlRtPending === 'object' ? _wlRtPending.size : -1, timer: typeof _wlRtTimer === 'number' ? _wlRtTimer : -1 }; });
  const posts11 = notePosts().slice(before11);
  check('W11 5 filas del robot en 1 s → una sola pasada (solo JUAN) y un solo POST; queda la Hb de la última fila (8.50)',
    w11.runs.length === 1 && w11.runs[0].length === 1 && w11.runs[0][0] === w11.k && w11.hb === '8.50' && posts11.length === 1 && posts11[0].body.patient_id === 'a1' && w11.pend === 0 && w11.timer === 0,
    JSON.stringify({ w11, posts: posts11.map(c => c.body && c.body.patient_id) }));

  // W12: un evento de `notes` que no cambia nada (eco del sync: mismas cifras, llaves en otro orden, synced_at nuevo)
  //      no avisa «📡 Actualización recibida» ni repinta; uno con un cambio real sí avisa
  await page.waitForTimeout(5200); // vence suppressKey (5 s) del último guardado
  const w12 = await page.evaluate(async () => {
    const rev = (o) => Object.fromEntries(Object.entries(o).reverse());
    _suppressRealtimeKeys.clear();
    const k = pid(patients[0]); const nd = noteData[k];
    const row = { patient_id: 'a1', app: nd.app || '', pa: nd.pa || '', drenajes: nd.drenajes || '', qx: nd.qx || '', manejo: nd.manejo || '', sangrado: nd.sangrado || '', sv: nd.sv || '', balance: nd.balance || '', pendientes: nd.pendientes || '',
      checklist: rev(JSON.parse(JSON.stringify(buildChecklistForSync(nd)))), imagen_history: [],
      lab_history: nd.labHistory.map(s => rev(Object.assign(JSON.parse(JSON.stringify(s)), { labs: rev(s.labs), synced_at: new Date(Date.now() + 60000).toISOString() }))) };
    const t0 = document.getElementById('rt-toast'); if (t0) t0.remove();
    const card0 = document.getElementById('card-' + k);
    handleNoteChange({ eventType: 'UPDATE', new: JSON.parse(JSON.stringify(row)) });
    const toastSame = (document.getElementById('rt-toast') || {}).textContent || '';
    await new Promise(r => setTimeout(r, 2200)); // más que la calma de repintado (1.8 s)
    const cardSame = document.getElementById('card-' + k) === card0;
    const hbSame = noteData[k].labHistory[0].labs.hb;
    handleNoteChange({ eventType: 'UPDATE', new: Object.assign(JSON.parse(JSON.stringify(row)), { manejo: 'MANEJO DEL COLEGA' }) });
    const toastChanged = (document.getElementById('rt-toast') || {}).textContent || '';
    return { toastSame, cardSame, hbSame, toastChanged, manejo: noteData[k].manejo };
  });
  check('W12 evento de notes idéntico (labs en otro orden, synced_at nuevo): sin «📡» y sin repintar la tarjeta; con un cambio real (manejo) sí avisa',
    !/📡/.test(w12.toastSame) && w12.cardSame && w12.hbSame === '8.50' && /📡 Actualización recibida: PEREZ LOPEZ JUAN/.test(w12.toastChanged) && w12.manejo === 'MANEJO DEL COLEGA', JSON.stringify(w12));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-WINLAB: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
