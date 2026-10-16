// Cajas donde TODO el texto cabe (oct 2026): Cirugías (procedimiento y hallazgos crecen a todo su texto; sangrado y
// cirujano con espacio) y gastos de drenajes, sondas y estomas (el número completo siempre se lee). La regla anti-zoom
// de iOS fija las cajas en 16 px: sin foco, la letra baja lo justo para que el valor quepa; con foco vuelve a 16 px.
// Datos inventados.   node tests/headless/app_cajas.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium, devices } = require('playwright');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session';
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  window.prompt=function(){ return 'Tester'; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: ()=>({ data:{ subscription:{ unsubscribe(){} } } }), refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const CASES = [
  { name: 'iPad horizontal', ctx: { ...devices['iPad Pro 11 landscape'] }, hoja: false },
  { name: 'iPad vertical', ctx: { ...devices['iPad Pro 11'] }, hoja: false },
  { name: 'iPad Hoja de visita', ctx: { ...devices['iPad Pro 11 landscape'] }, hoja: true },
  { name: 'iPhone', ctx: { ...devices['iPhone 13'] }, hoja: false },
];
// Llena la nota con cirugías y dispositivos de texto largo, pinta la ficha con las secciones CERRADAS y luego las abre
// (el ajuste debe ocurrir también al abrir una sección). Devuelve lo que quedó cortado.
const SETUP = async () => {
  const k = pid(patients[0]); const nd = getNote(k); nd.checklist = nd.checklist || {};
  nd.checklist.cirugias = [
    { id: 'c1', fecha: '2026-10-12', procedimiento: 'LAPAROTOMÍA EXPLORADORA + LAVADO DE CAVIDAD + DRENAJE DE ABSCESO SUBFRÉNICO DERECHO + ADHERENCIOLISIS EXTENSA + COLOCACIÓN DE SARATOGA BILATERAL Y BOLSA DE BOGOTÁ', hallazgos: 'ABSCESO SUBFRÉNICO DE 300 ML DE MATERIAL PURULENTO FÉTIDO, ADHERENCIAS INTERASA FIRMES, PERFORACIÓN DE 1 CM EN CARA ANTERIOR DE DUODENO CON BORDES FRIABLES, PERITONITIS GENERALIZADA. SE DEJA ABDOMEN ABIERTO CON SISTEMA DE PRESIÓN NEGATIVA.\nCOMPLICACIONES: NINGUNA.', sangrado: 'APROX 1500 ML', cirujano: 'DR. JUAN CARLOS HERNÁNDEZ ROBLES / R4 GARCÍA' },
    { id: 'c2', fecha: '2026-10-14', procedimiento: 'RELAPAROTOMÍA', hallazgos: 'SIN NUEVAS COLECCIONES', sangrado: '50', cirujano: 'DR. X' }];
  nd.checklist.dispositivos = [
    { id: 'd1', tipo: 'Saratoga', lado: 'D', sitio: 'flanco derecho subhepático', gasto: '1250 mL', carac: 'seropurulento con natas fibrinoides', fi: '2026-10-12' },
    { id: 'd2', tipo: 'Estoma', lado: '', sitio: 'ileostomía FID', gasto: '2,300 + 450', carac: 'gastrointestinal líquido', fi: '2026-10-12' },
    { id: 'd3', tipo: 'Sonda endopleural', lado: '', sitio: '5o EIC LMA', gasto: '850', carac: 'serohemático', fi: '2026-10-13' },
    { id: 'd4', tipo: 'SNG', lado: '', sitio: '', gasto: '12500', carac: 'biliar', fi: '' }];
  nd.checklist.pm_balance = '+1,250 / -350';
  noteData[k] = nd; window.__focusPid = k; renderView();
  await new Promise(r => setTimeout(r, 400));
  document.querySelectorAll('details').forEach(d => { d.open = true; });
  await new Promise(r => setTimeout(r, 400));
  const cut = [], gastos = [];
  document.querySelectorAll('.cx-in, .dv-in, .pm-input').forEach(el => {
    if (!el.getClientRects().length || !el.value) return;
    if (el.tagName === 'TEXTAREA') { if (el.scrollHeight > el.clientHeight + 2) cut.push('alto:' + el.className + ':' + el.value.slice(0, 20)); }
    else if (el.scrollWidth > el.clientWidth + 1) cut.push('ancho:' + el.className + ':' + el.value.slice(0, 20));
  });
  document.querySelectorAll('.dv-row input[data-f="gasto"]').forEach(el => gastos.push({ v: el.value, fs: parseFloat(getComputedStyle(el).fontSize), w: el.clientWidth }));
  return { cut, gastos, nCx: document.querySelectorAll('.cx-row').length, nDv: document.querySelectorAll('.dv-row').length };
};
(async () => {
  const browser = await chromium.launch();
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  for (const c of CASES) {
    const ctx = await browser.newContext(c.ctx); const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
    await page.route('**/vendor/supabase*', r => r.abort());
    await page.route('**/rest/v1/**', async (route) => {
      const url = route.request().url().replace(/^https?:\/\/[^/]+/, ''), m = route.request().method();
      const json = (s, o) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(o) });
      if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, [{ id: 'a1', cama: '3-170', exp: '24-99901', nombre: 'RUIZ SOTO MATEO', esp: 'CG', estado: 'DELICADO', edad: '58', dx: 'CHOQUE SÉPTICO', ingreso: '2026-10-10' }]);
      return json(200, []);
    });
    await page.addInitScript(MOCK);
    await page.addInitScript((h) => { try { localStorage.setItem('pl_hoja', h ? '1' : '0'); } catch (_) {} }, c.hoja);
    await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(4000);
    const r = await page.evaluate(SETUP);
    check(`K1 ${c.name}: Cirugías y drenajes completos, nada cortado (procedimiento, hallazgos, sangrado, cirujano, sitio, gasto, características, balance)`,
      r.nCx === 2 && r.nDv === 4 && r.cut.length === 0, JSON.stringify(r.cut));
    check(`K2 ${c.name}: cada gasto se lee completo con letra legible (≥ 12 px; los de 4-5 cifras a 16 px)`,
      r.gastos.length === 4 && r.gastos.every(g => g.fs >= 12) && r.gastos.filter(g => /^\d{3,5}$/.test(g.v)).every(g => g.fs >= 15.9), JSON.stringify(r.gastos));
    if (c.name === 'iPhone') {
      // K3: al tocar un cuadro reducido vuelve a 16 px (iOS no hace zoom) y al soltarlo se vuelve a ajustar
      const k3 = await page.evaluate(async () => {
        const el = Array.from(document.querySelectorAll('.dv-row input[data-f="gasto"]')).find(x => x.style.getPropertyValue('font-size'));
        if (!el) return { none: true };
        const before = parseFloat(getComputedStyle(el).fontSize);
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.focus();
        const focused = parseFloat(getComputedStyle(el).fontSize);
        el.blur(); await new Promise(r => setTimeout(r, 50));
        const after = parseFloat(getComputedStyle(el).fontSize);
        return { before, focused, after, fits: el.scrollWidth <= el.clientWidth + 1 };
      });
      check('K3 iPhone: cuadro reducido → al enfocarlo vuelve a 16 px (sin zoom de iOS) y al soltarlo se ajusta otra vez', !k3.none && k3.before < 16 && k3.focused === 16 && k3.after === k3.before && k3.fits, JSON.stringify(k3));
      // K4: un valor puesto por código (escritura a mano / sync) sin foco se ajusta en el momento
      const k4 = await page.evaluate(() => {
        const el = document.querySelector('.dv-row input[data-f="gasto"]');
        el.value = '1,250 + 980 mL'; el.dispatchEvent(new Event('input', { bubbles: true }));
        return { fits: el.scrollWidth <= el.clientWidth + 1, fs: parseFloat(getComputedStyle(el).fontSize) };
      });
      check('K4 iPhone: valor nuevo sin foco (escritura a mano) se ajusta al instante y cabe completo', k4.fits && k4.fs >= 9, JSON.stringify(k4));
    }
    check(`final ${c.name}: sin errores no capturados`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  console.log('RESULT APP-CAJAS: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
