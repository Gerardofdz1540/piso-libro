// 💾 Espacio en la nube (oct 2026): tamaño de la base de Supabase (función SQL pl_tamano_base) en ⚙️ Config
// (X MB de 500 MB, barra, las 3 tablas que más ocupan en palabras, hora de la revisión; dato guardado 10 min) y
// franja arriba de la app con nivel aviso/alto («Entendido» la oculta 24 h en este dispositivo, también tras recargar;
// de aviso a alto vuelve a salir). Sin la función (404) → «sin dato» y ningún error; sin red no se consulta.
//   node tests/headless/app_espacio.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const tokenFor = (uid, email) => 'eyJhbGciOiJIUzI1NiJ9.' + b64({ sub: uid, email, role: 'authenticated' }) + '.firma';
const UID = 'u-res-1', EMAIL = 'residente@t.t';
const PROFILE = { id: UID, email: EMAIL, nombre: 'Dra. López R2', role: 'usuario', status: 'active' };
const mockScript = (extra) => `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const TOKEN=${JSON.stringify(tokenFor(UID, EMAIL))};
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:TOKEN, refresh_token:'r', user:{ id:${JSON.stringify(UID)}, email:${JSON.stringify(EMAIL)} } }));
  localStorage.setItem('pl_user_name', 'Dra. López R2');
  window.__alerts=[]; window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; }; window.prompt=function(){ return 'Tester'; };
  const auth={
    getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }),
    onAuthStateChange: ()=>({ data:{ subscription:{ unsubscribe(){} } } }),
    refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }),
    signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }),
    signOut: async()=>{ sessionStorage.removeItem(KEY); return { error:null }; },
    getUser: async()=>({ data:{ user:{ id:${JSON.stringify(UID)}, email:${JSON.stringify(EMAIL)} } }, error:null })
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
  ${extra || ''}
})();`;
// Respuesta de pl_tamano_base (jsonb escalar → objeto). Tablas desordenadas a propósito: la app ordena y toma 3.
const TAMANO = (db_mb, nivel) => ({ db_mb, limite_mb: 500, nivel, audit_filas: 21345, tablas: [
  { tabla: 'sync_log', mb: 4.9 }, { tabla: 'notes', mb: 2.1 }, { tabla: 'winlab_labs', mb: 33.4 }, { tabla: 'audit_log', mb: 14.2 }, { tabla: 'patients', mb: 0.3 }
] });
(async () => {
  const browser = await launch();
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const errorsAll = [];
  // REST simulado. opts.tamano: función (→ objeto) o 'missing' (404 PGRST202, la base sin la función).
  async function wire(page, opts) {
    const rpc = [];
    page.on('pageerror', e => errorsAll.push(String((e && e.stack) || e).slice(0, 300)));
    await page.route('**/vendor/supabase*', r => r.abort());
    await page.route('**/rest/v1/**', async (route) => {
      const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (url.startsWith('/rest/v1/rpc/pl_tamano_base')) {
        rpc.push({ m, body: req.postData(), headers: req.headers() });
        if (opts.tamano === 'missing') return json(404, { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.pl_tamano_base without parameters in the schema cache' });
        return json(200, opts.tamano());
      }
      if (url.startsWith('/rest/v1/app_users')) { if (m === 'GET') return json(200, [PROFILE]); return json(200, [PROFILE]); }
      if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'p1', cama: '3-170', exp: '1', nombre: 'PACIENTE PRUEBA', esp: 'CG', estado: 'ESTABLE', edad: '40' }]); return json(201, [{ id: 'p1' }]); }
      if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'p1' }]); }
      return json(200, []);
    });
    return { rpc };
  }
  const open = async (ctx, opts, extra) => {
    const page = await ctx.newPage();
    const w = await wire(page, opts);
    await page.addInitScript(mockScript(extra));
    await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
    // Espera a que la app entre (overlay fuera) y a que llegue la revisión de arranque (1.5 s tras el perfil).
    await page.waitForFunction(() => document.getElementById('login-overlay').style.display === 'none', null, { timeout: 30000 });
    await page.waitForFunction(() => typeof _espacioCache !== 'undefined' && !!_espacioCache, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    return { page, rpc: w.rpc };
  };
  const estado = (page) => page.evaluate(() => {
    const b = document.getElementById('espacio-banner');
    const body = document.getElementById('espacio-nube-body');
    return {
      banner: b.style.display, bannerTxt: (document.getElementById('espacio-banner-txt') || {}).textContent || '', nivel: b.dataset.nivel || '', bg: b.style.background,
      modal: document.getElementById('config-modal').style.display,
      bloque: body ? body.textContent.replace(/\s+/g, ' ').trim() : '',
      mb: (document.querySelector('[data-testid="espacio-mb"]') || {}).textContent || '',
      barra: (document.querySelector('[data-testid="espacio-barra"]') || { style: {} }).style.width || '',
      top: Array.from(document.querySelectorAll('[data-testid="espacio-top"] li')).map(l => l.textContent.replace(/\s+/g, ' ').trim()),
      sinDato: !!document.querySelector('[data-testid="espacio-sin-dato"]'),
      ok: localStorage.getItem('pl_espacio_entendido'), alerts: window.__alerts.length
    };
  });

  // ── E1: nivel ok → el bloque de ⚙️ Config muestra MB, barra y las 3 tablas; sin franja; una sola consulta (cache 10 min) ──
  const ctx1 = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const e1 = await open(ctx1, { tamano: () => TAMANO(76.4, 'ok') });
  const antes = await estado(e1.page);
  await e1.page.evaluate(() => openConfigModal());
  await e1.page.waitForTimeout(400);
  const s1 = await estado(e1.page);
  const h = new Date(); const hh = String(h.getHours()).padStart(2, '0') + ':';
  check('E1 nivel ok: al entrar se consulta pl_tamano_base (POST rpc con el token del usuario) y NO hay franja; ⚙️ Config muestra «76 MB de 500 MB», la barra al 15 %, las 3 tablas más grandes en palabras (laboratorios del robot, bitácora/historial, bitácora del censo) y la hora de la revisión; abrir Config no vuelve a consultar (dato de hace < 10 min)',
    e1.rpc.length === 1 && e1.rpc[0].m === 'POST' && /^Bearer eyJ/.test(e1.rpc[0].headers['authorization']) && antes.banner === 'none' && s1.banner === 'none' && s1.modal === 'flex'
    && /76\.4 MB de 500 MB/.test(s1.mb) && s1.barra === '15%' && s1.top.length === 3 && /^laboratorios del robot \(winlab_labs\): 33\.4 MB$/.test(s1.top[0]) && /^bitácora\/historial \(audit_log\): 14\.2 MB$/.test(s1.top[1]) && /^bitácora del censo \(sync_log\): 4\.9 MB$/.test(s1.top[2])
    && new RegExp('revisado a las ' + hh.replace(':', '\\:') + '\\d\\d').test(s1.bloque) && /Bitácora: 21,345 renglones/.test(s1.bloque) && !s1.sinDato, JSON.stringify({ rpc: e1.rpc.length, antes: antes.banner, s1 }));
  await ctx1.close();

  // ── E2: nivel aviso → franja amarilla con los MB; Entendido la oculta 24 h y sigue oculta tras recargar; Config sí muestra el dato ──
  const ctx2 = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const e2 = await open(ctx2, { tamano: () => TAMANO(372, 'aviso') });
  const s2a = await estado(e2.page);
  await e2.page.click('[data-testid="espacio-entendido"]');
  await e2.page.waitForTimeout(200);
  const s2b = await estado(e2.page);
  let okGuardado = null; try { okGuardado = JSON.parse(s2b.ok); } catch (_) {}
  await e2.page.reload({ waitUntil: 'load', timeout: 90000 });
  await e2.page.waitForFunction(() => document.getElementById('login-overlay').style.display === 'none', null, { timeout: 30000 });
  await e2.page.waitForFunction(() => typeof _espacioCache !== 'undefined' && !!_espacioCache, null, { timeout: 15000 }).catch(() => {});
  await e2.page.waitForTimeout(300);
  await e2.page.evaluate(() => openConfigModal());
  await e2.page.waitForTimeout(300);
  const s2c = await estado(e2.page);
  check('E2 nivel aviso: franja amarilla «La base de datos va en 372 MB de 500: avisa al administrador»; «Entendido» la oculta y guarda en el dispositivo hasta dentro de 24 h (nivel aviso); al recargar la app vuelve a consultar y la franja sigue oculta; ⚙️ Config muestra 372 MB con la barra ámbar al 74 %',
    s2a.banner === 'flex' && s2a.nivel === 'aviso' && /La base de datos va en 372 MB de 500: avisa al administrador/.test(s2a.bannerTxt) && /254, 243, 199/.test(s2a.bg)
    && s2b.banner === 'none' && okGuardado && okGuardado.nivel === 'aviso' && okGuardado.hasta > Date.now() + 23 * 3600e3 && okGuardado.hasta <= Date.now() + 24 * 3600e3 + 5000
    && e2.rpc.length === 2 && s2c.banner === 'none' && /372 MB de 500 MB/.test(s2c.mb) && s2c.barra === '74%' && /avisa al administrador/.test(s2c.bloque), JSON.stringify({ s2a, s2b, okGuardado, rpc: e2.rpc.length, s2c }));

  // ── E3: dentro de las 24 h sube a «alto» → la franja vuelve a salir en rojo; un «Entendido» viejo no la tapa ──
  await e2.page.evaluate(() => { _espacioCache = { data: { db_mb: 455.2, limite_mb: 500, nivel: 'alto', tablas: [] }, error: '', ts: Date.now() }; _espacioRenderBanner(); });
  const s3 = await estado(e2.page);
  check('E3 de aviso a alto dentro de las 24 h: la franja vuelve a salir, en rojo y con el aviso de que la app dejaría de guardar',
    s3.banner === 'flex' && s3.nivel === 'alto' && /455 MB de 500/.test(s3.bannerTxt) && /deja de guardar/.test(s3.bannerTxt) && /254, 226, 226/.test(s3.bg), JSON.stringify(s3));
  await ctx2.close();

  // ── E4: la base no tiene la función (404 PGRST202) → «sin dato», sin franja, sin alert ni error ──
  const ctx4 = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const e4 = await open(ctx4, { tamano: 'missing' });
  await e4.page.evaluate(() => openConfigModal());
  await e4.page.waitForTimeout(400);
  const s4 = await estado(e4.page);
  check('E4 sin la función en la base (404): ⚙️ Config dice «sin dato» (y por qué), no hay franja, ningún alert y la app sigue (pacientes pintados)',
    e4.rpc.length === 1 && s4.sinDato && /sin dato · la base aún no tiene la función pl_tamano_base/.test(s4.bloque) && s4.banner === 'none' && s4.alerts === 0 && !s4.mb
    && await e4.page.evaluate(() => patients.length === 1), JSON.stringify({ rpc: e4.rpc.length, s4 }));
  await ctx4.close();

  // ── E5: sin red → no se consulta; Config dice «sin dato · sin conexión» ──
  const ctx5 = await browser.newContext({ viewport: { width: 1194, height: 834 } });
  const page5 = await ctx5.newPage();
  const w5 = await wire(page5, { tamano: () => TAMANO(480, 'alto') });
  await page5.addInitScript(mockScript("Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });"));
  await page5.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page5.waitForFunction(() => document.getElementById('login-overlay').style.display === 'none', null, { timeout: 30000 });
  await page5.waitForTimeout(2500);
  await page5.evaluate(() => openConfigModal());
  await page5.waitForTimeout(300);
  const s5 = await estado(page5);
  check('E5 sin red: no se llama a pl_tamano_base (ni al entrar ni al abrir Config), no hay franja y el bloque dice «sin dato · sin conexión»',
    w5.rpc.length === 0 && s5.banner === 'none' && /sin dato · sin conexión/.test(s5.bloque), JSON.stringify({ rpc: w5.rpc.length, s5 }));
  await ctx5.close();

  check('final: sin errores no capturados', errorsAll.length === 0, errorsAll.join(' | '));
  console.log('RESULT APP-ESPACIO: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
