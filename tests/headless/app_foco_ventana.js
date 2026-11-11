// ✍️ Firma por renglón al cambiar de pestaña o de ventana con la caja abierta (11 nov 2026). Necesita un Chromium CON ventana
// (Playwright sin ventana no simula la pérdida de foco de la página): xvfb-run -a node tests/headless/app_foco_ventana.js
// con el repo servido en 127.0.0.1:8771 (o PL_BASE_URL). No está en run_all.sh por eso. Pacientes ficticios.
const { chromium } = require('playwright');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const SHOT = process.env.PL_SHOT || '';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Gerardo Prueba');
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PT = { id: '7b000000-0000-4000-8000-000000000001', cama: '3-301', exp: '26-70001', nombre: 'LUIS PRUEBA UNO', esp: 'CG', estado: 'ESTABLE', dx: 'APENDICITIS', edad: '30' };
(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] }); const ctx0 = await browser.newContext({ viewport: { width: 1194, height: 834 } }); const page = await ctx0.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [PT]); return json(201, [{ id: PT.id }]); }
    if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); posts.push(body); return json(201, [{ patient_id: PT.id }]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  const mismoRect = (a, b) => { try { const x = JSON.parse(a), y = JSON.parse(b); return ['x', 'y', 'width', 'height'].every(k => Math.abs(x[k] - y[k]) < 0.6); } catch (_) { return false; } };
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);


  const cdp = await ctx0.newCDPSession(page); try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }); } catch (_) {}
  const k = await page.evaluate(async () => { const k = pid(patients[0]); focusGoTo(k); await new Promise(r => setTimeout(r, 400)); const nd = getNote(k); nd.pendientes = 'Ana 10.11.26 08:00 - Pedir BH'; noteData[k] = nd; _rerenderCard(k); await new Promise(r => setTimeout(r, 300)); return k; });
  const sel = 'textarea[data-key="' + k + '"][data-field="pendientes"]';
  await page.click(sel); await page.keyboard.press('Control+Home'); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Llamar a ciru', { delay: 10 });
  const p2 = await ctx0.newPage(); await p2.bringToFront(); await p2.waitForTimeout(400);
  const medio = await page.evaluate((s) => ({ v: document.querySelector(s).value, act: document.activeElement === document.querySelector(s) }), sel);
  await page.bringToFront(); await page.waitForTimeout(400);
  await page.keyboard.type('gía', { delay: 10 }); await page.keyboard.press('Enter'); await page.keyboard.type('  y avisar a MI', { delay: 10 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.waitForTimeout(300);
  const fin = await page.evaluate((s) => document.querySelector(s).value, sel);
  // y una salida normal (clic fuera) sí reinicia la base: un renglón nuevo después se firma aparte
  await page.click(sel); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('Otro', { delay: 10 });
  await page.mouse.click(5, 5); await page.waitForTimeout(300);
  const fin2 = await page.evaluate((s) => document.querySelector(s).value, sel);
  const ok = /^Gerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Llamar a ciru(gía)?/.test(medio.v) && /^Gerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Llamar a cirugía\n  y avisar a MI\nAna 10\.11\.26 08:00 - Pedir BH$/.test(fin)
    && /\nAna 10\.11\.26 08:00 - Pedir BH\nGerardo \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} - Otro$/.test(fin2);
  console.log((ok && !errors.length ? 'PASS' : 'FAIL') + ' cambio de pestaña con la caja abierta :: ' + JSON.stringify({ medio, fin, fin2, errors }));
  console.log('RESULT APP-FOCO-VENTANA: ' + (ok && !errors.length ? 1 : 0) + ' passed, ' + (ok && !errors.length ? 0 : 1) + ' failed');
  process.exitCode = ok && !errors.length ? 0 : 1;
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
