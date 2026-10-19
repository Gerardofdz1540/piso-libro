// Labs que NUNCA se pierden (oct 2026): un guardado con copia vieja no quita fechas de la nube, «Eliminar labs»
// sí borra (y no regresa con los mismos datos), el respaldo en segundo plano repone fechas viejas del robot solo de
// ESTE internamiento, y un encabezado de WinLab con menos nombres que el censo entra solo si el robot lo marcó __target.
// Datos inventados.
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
const DAY = 86400e3;
const pad = (n) => String(n).padStart(2, '0');
const dmy = (t) => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`; };
const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const NOW = Date.now();
const TODAY = iso(NOW), OLD = iso(NOW - 10 * DAY), PREV_ADM = iso(NOW - 90 * DAY);
const NAME = 'RUIZ SOTO MATEO ANDRES', EXP = '24-99901';
const mkReport = (t, hb, extra) => Object.assign({ __cells: ['', '', '', `${dmy(t)} 06:10`, `${dmy(t)} 08:00`, '', ''], __hasLink: true,
  valores: FIX.valores.map(v => v.estudio === 'HEMOGLOBINA' ? { ...v, valor: hb } : v) }, extra || {});
const wlRow = (t, hb, scrapedAt) => ({ exp: EXP, paciente: NAME, fecha: iso(t), scraped_at: scrapedAt, data: { headers: [], reportes: [mkReport(t, hb)] } });

(async()=>{
  const browser=await launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  const consoleWarn=[]; page.on('console', m => { if (m.type()==='warning' || m.type()==='error') consoleWarn.push(m.text().slice(0,200)); });
  const calls=[];
  // Nube: nota con 3 fechas (2 del robot + 1 manual)
  const serverNote = { patient_id:'a1', app:'', pa:'', drenajes:'', qx:'', manejo:'', sangrado:'', sv:'', balance:'', pendientes:'', checklist:{}, imagen_history:[],
    lab_history: [
      { fecha:'2026-10-01', labs:{ hb:'10.1' }, extra:[], source:'winlab' },
      { fecha:'2026-10-02', labs:{ hb:'10.4' }, extra:[], source:'winlab' },
      { fecha:'2026-10-03', labs:{ na:'139' }, extra:[], source:'manual' },
    ] };
  let failUnionGet = false;
  const wlRows = [
    wlRow(NOW, '8.20', new Date(NOW - 3600e3).toISOString()),            // reciente (ventana de 4 días)
    wlRow(NOW - 10 * DAY, '9.10', new Date(NOW - 10 * DAY).toISOString()), // este internamiento, fuera de la ventana
    wlRow(NOW - 90 * DAY, '6.60', new Date(NOW - 90 * DAY).toISOString()), // internamiento anterior (mismo expediente)
  ];
  await page.route('**/vendor/supabase*', r=>r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req=route.request(); const url=decodeURIComponent(req.url().replace(/^https?:\/\/[^/]+/,'')); const m=req.method();
    let body=null; try { body=JSON.parse(req.postData()||'null'); } catch(_) {}
    calls.push({ m, url, body });
    const json=(status, obj)=>route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) {
      if (m==='GET') return json(200, [{ id:'a1', cama:'3-101', exp:EXP, nombre:NAME, esp:'CG', edad:'60', ingreso: iso(NOW - 20 * DAY) }]);
      return json(200, [{ id:'a1' }]);
    }
    if (url.startsWith('/rest/v1/winlab_labs')) {
      const gte = (url.match(/scraped_at=gte\.([^&]+)/) || [])[1], lt = (url.match(/scraped_at=lt\.([^&]+)/) || [])[1];
      const out = wlRows.filter(r => (!gte || r.scraped_at >= gte) && (!lt || r.scraped_at < lt));
      return json(200, out.map(r => JSON.parse(JSON.stringify(r))));
    }
    if (url.startsWith('/rest/v1/notes')) {
      if (m==='GET') {
        if (failUnionGet && /select=lab_history/.test(url)) return route.fulfill({ status: 503, body: 'down' });
        return json(200, [JSON.parse(JSON.stringify(serverNote))]);
      }
      if (m==='POST') { const row = Array.isArray(body) ? body[0] : body; Object.assign(serverNote, row || {}); return json(201, [JSON.parse(JSON.stringify(serverNote))]); }
    }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto(BASE_URL + '/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(7000);
  check('init: sin errores no capturados', errors.length===0, errors.join(' | '));
  const notePosts = () => calls.filter(c => c.m==='POST' && c.url.startsWith('/rest/v1/notes'));
  const lastPost = () => { const p = notePosts(); return p.length ? (Array.isArray(p[p.length-1].body) ? p[p.length-1].body[0] : p[p.length-1].body) : null; };
  const fechasOf = (arr) => (arr || []).map(s => s && s.fecha).filter(Boolean).sort();

  const boot = await page.evaluate(() => { const k = pid(patients[0]); return { k, f: (noteData[k].labHistory || []).map(s => s.fecha).sort() }; });
  check('K0 arranque: la nota trae las 3 fechas de la nube + la de hoy del robot', ['2026-10-01','2026-10-02','2026-10-03'].every(f => boot.f.includes(f)) && boot.f.includes(TODAY), JSON.stringify(boot));

  // K1: un dispositivo con copia VIEJA (solo 1 fecha) guarda labs → la subida conserva las fechas de la nube
  const before1 = notePosts().length;
  await page.evaluate(() => {
    const k = pid(patients[0]); const nd = noteData[k];
    nd.labHistory = nd.labHistory.filter(s => s.fecha === '2026-10-03');
    nd.labHistory[0].labs.k = '4.1';
    _dirtyFields[k] = new Set(['labHistory']); saveNote(k, nd);
  });
  await page.waitForTimeout(2500);
  const k1 = await page.evaluate(() => { const k = pid(patients[0]); return (noteData[k].labHistory || []).map(s => s.fecha).sort(); });
  const p1 = lastPost();
  check('K1 copia vieja: lo que se sube conserva TODAS las fechas de la nube (no 4 → 1)', notePosts().length > before1 && p1 && ['2026-10-01','2026-10-02','2026-10-03',TODAY].every(f => fechasOf(p1.lab_history).includes(f)), JSON.stringify(p1 && fechasOf(p1.lab_history)));
  check('K1b la pantalla también recupera las fechas y conserva la edición (K 4.1)', ['2026-10-01','2026-10-02','2026-10-03',TODAY].every(f => k1.includes(f)) && (p1.lab_history.find(s => s.fecha==='2026-10-03')||{labs:{}}).labs.k === '4.1', JSON.stringify(k1));

  // K2: sin red para la consulta de unión → el guardado NO se bloquea (sube lo local)
  failUnionGet = true;
  const before2 = notePosts().length;
  await page.evaluate(() => { const k = pid(patients[0]); const nd = noteData[k]; nd.labHistory[0].labs.cl = '101'; _dirtyFields[k] = new Set(['labHistory']); saveNote(k, nd); });
  await page.waitForTimeout(2500);
  failUnionGet = false;
  check('K2 si la consulta de unión falla, el guardado sigue', notePosts().length > before2, String(notePosts().length - before2));

  // K3: «Eliminar labs» de una fecha SÍ la quita (aunque la nube aún la tenga al momento de unir)
  const before3 = notePosts().length;
  await page.evaluate(() => deleteLabDate(pid(patients[0]), '2026-10-02'));
  await page.waitForTimeout(2500);
  const p3 = lastPost();
  const k3 = await page.evaluate(() => { const k = pid(patients[0]); return { f: (noteData[k].labHistory || []).map(s => s.fecha), del: noteData[k].checklist.__lab_deleted, dl: Object.keys(noteData[k].checklist.__lab_deleted_labs || {}) }; });
  check('K3 eliminar: la fecha se va de la pantalla y de lo que se sube; las demás se quedan', notePosts().length > before3 && !fechasOf(p3.lab_history).includes('2026-10-02') && fechasOf(p3.lab_history).includes('2026-10-01') && !k3.f.includes('2026-10-02'), JSON.stringify({ up: fechasOf(p3.lab_history), k3 }));
  check('K3b el borrado viaja en la nota (checklist.__lab_deleted + valores borrados)', p3 && p3.checklist && Array.isArray(p3.checklist.__lab_deleted) && p3.checklist.__lab_deleted.includes('2026-10-02') && k3.dl.includes('2026-10-02'), JSON.stringify(p3 && p3.checklist));
  // y otro guardado con labs (copia que aún no ve el borrado en la nube) no la regresa
  await page.evaluate(() => { const k = pid(patients[0]); const nd = noteData[k]; _dirtyFields[k] = new Set(['labHistory']); saveNote(k, nd); });
  await page.waitForTimeout(2500);
  check('K3c guardados posteriores no regresan la fecha borrada', !fechasOf(lastPost().lab_history).includes('2026-10-02'), JSON.stringify(fechasOf(lastPost().lab_history)));

  // K4: respaldo en segundo plano: fecha vieja de ESTE internamiento sí, del internamiento anterior no
  await page.waitForFunction(() => !_wlBackfillRunning, null, { timeout: 30000 });
  const k4 = await page.evaluate(async () => {
    const r = await _winlabBackfillOlder({ force: true });
    const k = pid(patients[0]); const h = noteData[k].labHistory || [];
    const e = Object.keys(winlabRowsByExp).reduce((n, x) => n + winlabRowsByExp[x].length, 0);
    return { r, h: h.map(s => [s.fecha, (s.labs || {}).hb, s.source]), kept: e };
  });
  const hOld = k4.h.find(x => x[0] === OLD), hPrev = k4.h.find(x => x[0] === PREV_ADM);
  check('K4 respaldo: repone la fecha de hace 10 días (Hb 9.10, origen WinLab)', !!hOld && hOld[1] === '9.10' && hOld[2] === 'winlab', JSON.stringify(k4));
  check('K4b respaldo: NO trae labs del internamiento anterior (90 días, mismo expediente)', !hPrev, JSON.stringify(k4.h));
  check('K4c respaldo: las filas viejas se sueltan de memoria (solo queda la reciente)', k4.kept === 1, String(k4.kept));
  const k4n = await page.evaluate((OLD) => { const k = pid(patients[0]); const n = _labNewsFor(k); const ent = JSON.stringify((noteData[k].checklist || {}).__entrega_auto || '') + (noteData[k].entrega || ''); return { news: !!(n && n.items.some(i => i.fecha === OLD)), ent: ent.indexOf(OLD.slice(5).split('-').reverse().join('/')) !== -1 || ent.indexOf(OLD) !== -1 }; }, OLD);
  check('K4f la fecha vieja repuesta NO sale como «labs nuevos» ni en la entrega', !k4n.news && !k4n.ent, JSON.stringify(k4n));
  await page.waitForTimeout(2500);
  check('K4d respaldo: la fecha repuesta se sube a la nube', fechasOf(serverNote.lab_history).includes(OLD), JSON.stringify(fechasOf(serverNote.lab_history)));
  const lt0 = calls.filter(c => c.m==='GET' && /scraped_at=lt\./.test(c.url)).length;
  const k4e = await page.evaluate(() => _winlabBackfillOlder());
  check('K4e respaldo: una vez por dispositivo (sin force no vuelve a bajar)', calls.filter(c => c.m==='GET' && /scraped_at=lt\./.test(c.url)).length === lt0 && k4e.rows === 0, JSON.stringify(k4e));

  // K5: borrar una fecha del robot → el robot NO la regresa con los mismos datos, sí si trae resultados nuevos
  const k5 = await page.evaluate(async (TODAY) => {
    const k = pid(patients[0]);
    deleteLabDate(k, TODAY);
    await applyWinlabSyncToPatients({ verbose: false });
    const afterSame = (noteData[k].labHistory || []).some(s => s.fecha === TODAY);
    const r = await _winlabBackfillOlder({ force: true });
    const afterBackfill = (noteData[k].labHistory || []).some(s => s.fecha === TODAY);
    return { afterSame, afterBackfill, r };
  }, TODAY);
  check('K5 fecha borrada: el sync del robot no la regresa con los mismos valores', !k5.afterSame && !k5.afterBackfill, JSON.stringify(k5));
  const newer = wlRow(NOW, '8.90', new Date().toISOString());
  await page.evaluate((row) => { handleWinlabChange({ eventType:'INSERT', new: row }); }, newer);
  await page.waitForTimeout(3000);
  const k5b = await page.evaluate((TODAY) => { const k = pid(patients[0]); const s = (noteData[k].labHistory || []).find(x => x.fecha === TODAY); return s ? s.labs.hb : null; }, TODAY);
  check('K5b si WinLab trae un resultado NUEVO de esa fecha, sí aparece (Hb 8.90)', k5b === '8.90', String(k5b));

  // K6: encabezado de WinLab con MENOS nombres que el censo
  const k6 = await page.evaluate((args) => {
    const [NAME, rep] = args;
    const hdr = (ap, nom) => ({ __hasLink: false, 'APELLIDOS COMPLETOS': ap, NOMBRE: nom });
    const run = (h, r) => buildWinlabLabSnapshots({ exp: 'x', paciente: NAME, fecha: '2026-10-10', data: { reportes: [h, r] } }).length;
    return {
      fullNoTarget: run(hdr('RUIZ SOTO', 'MATEO ANDRES'), rep),
      partialTarget: run(hdr('RUIZ SOTO', 'MATEO'), Object.assign({}, rep, { __target: true })),
      partialNoTarget: run(hdr('RUIZ SOTO', 'MATEO'), rep),
      otherTarget: run(hdr('RUIZ SOTO', 'LUCIA'), Object.assign({}, rep, { __target: true })),
      twoTokTarget: run(hdr('RUIZ', 'MATEO'), Object.assign({}, rep, { __target: true })),
    };
  }, [NAME, mkReport(NOW - 6 * DAY, '7.00')]);
  check('K6 encabezado completo entra (regla de siempre)', k6.fullNoTarget === 1, JSON.stringify(k6));
  check('K6b encabezado con menos nombres entra SOLO si el robot lo validó (__target)', k6.partialTarget === 1 && k6.partialNoTarget === 0, JSON.stringify(k6));
  check('K6c otra persona con los mismos apellidos nunca entra (ni con __target); 2 nombres no bastan', k6.otherTarget === 0 && k6.twoTokTarget === 0, JSON.stringify(k6));

  // K7: el botón de Labs (refresco manual) termina sin «Error»
  const k7 = await page.evaluate(async () => { await refreshWinlabLabs({ skipAutoSync: true }); const l = document.getElementById('winlab-pill-lbl'); return l ? l.textContent : '(sin pill)'; });
  check('K7 refresco manual de labs sin error', !/Error/.test(k7) && !consoleWarn.some(t => /refreshWinlabLabs/.test(t)), JSON.stringify({ k7, w: consoleWarn.filter(t => /refreshWinlabLabs/.test(t)) }));

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-LABKEEP: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
