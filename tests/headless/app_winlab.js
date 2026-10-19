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
      if (m==='GET') return json(200, [{ id:'a1', cama:'3-101', exp:'26-05099', nombre:'PEREZ LOPEZ JUAN', esp:'CG', edad:'60' }]);
      if (m==='PATCH') return json(200, [{ id:'a1' }]);
      return json(201, [{ id:'a1' }]);
    }
    if (url.startsWith('/rest/v1/winlab_labs')) { wlRows.forEach(r => { r.scraped_at = r.scraped_at; }); return json(200, wlRows.map(r => ({ ...r, scraped_at: r.scraped_at }))); }
    if (url.startsWith('/rest/v1/notes') && m==='POST') return json(201, [{ patient_id:'a1' }]);
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

  check('final: sin errores no capturados', errors.length===0, errors.join(' | '));
  console.log('RESULT APP-WINLAB: '+pass+' passed, '+fail+' failed');
  await browser.close();
})().catch(e=>{ console.error('CRASH', e); process.exit(2); });
