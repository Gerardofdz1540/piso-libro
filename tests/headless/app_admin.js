// Cuentas con administrador (oct 2026): cabeceras de dispositivo/usuario, perfil al entrar, cuenta bloqueada,
// recuperación de contraseña (correo y enlace), panel 👥 Usuarios + 🕵️ Actividad (solo admin) y 👤 Mi cuenta.
//   node tests/headless/app_admin.js   (sirve el repo en 127.0.0.1:8771; ver run_all.sh)
const { chromium } = require('playwright');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
// Token con forma de JWT: la app lee sub/email del payload (myUserId / myEmail).
const tokenFor = (uid, email) => 'eyJhbGciOiJIUzI1NiJ9.' + b64({ sub: uid, email, role: 'authenticated' }) + '.firma';
const mockScript = (uid, email, extra) => `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  const TOKEN=${JSON.stringify(tokenFor(uid, email))};
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:TOKEN, refresh_token:'r', user:{ id:${JSON.stringify(uid)}, email:${JSON.stringify(email)} } }));
  localStorage.setItem('pl_user_name', 'Gerardo Fernández');
  window.__alerts=[]; window.__prompts=[]; window.__clip=[]; window.__auth=[]; window.__promptAnswer='Tester';
  window.prompt=function(m){ window.__prompts.push(String(m)); return window.__promptAnswer; };
  window.alert=function(m){ window.__alerts.push(String(m)); }; window.confirm=function(){ return true; };
  try{ Object.defineProperty(navigator,'clipboard',{ value:{ writeText:(t)=>{ window.__clip.push(String(t)); return Promise.resolve(); } }, configurable:true }); }catch(_){}
  const auth={
    getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }),
    onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
    refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }),
    signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }),
    signOut: async(o)=>{ window.__auth.push(['signOut', o]); sessionStorage.removeItem(KEY); return { error:null }; },
    updateUser: async(o)=>{ window.__auth.push(['updateUser', o]); return window.__updateFail?{ data:null, error:{ message:'falló' } }:{ data:{ user:{} }, error:null }; },
    resetPasswordForEmail: async(e,o)=>{ window.__auth.push(['resetPasswordForEmail', e, o]); return { data:{}, error:null }; },
    setSession: async(o)=>{ window.__auth.push(['setSession', o]); sessionStorage.setItem(KEY, JSON.stringify({ access_token:o.access_token, refresh_token:o.refresh_token, user:{ id:${JSON.stringify(uid)}, email:${JSON.stringify(email)} } })); return { data:{ session:JSON.parse(sessionStorage.getItem(KEY)) }, error:null }; },
    getUser: async()=>({ data:{ user:{ id:${JSON.stringify(uid)}, email:${JSON.stringify(email)} } }, error:null })
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
  ${extra || ''}
})();`;
const ADMIN_UID = 'u-admin-1', ADMIN_EMAIL = 'admin@t.t';
const USERS = [
  { id: ADMIN_UID, email: ADMIN_EMAIL, nombre: 'Dr. Fernández R2', role: 'admin', status: 'active', created_at: '2026-05-22T14:17:24Z', last_sign_in_at: '2026-10-14T18:35:36Z', last_seen_at: '2026-10-14T19:00:00Z' },
  { id: 'u-2', email: 'residente2@t.t', nombre: 'Dra. López', role: 'usuario', status: 'active', created_at: '2026-06-14T02:09:24Z', last_sign_in_at: null },
  { id: 'u-3', email: 'bloqueado@t.t', nombre: '', role: 'usuario', status: 'blocked', created_at: '2026-06-14T02:09:24Z', last_sign_in_at: '2026-06-15T02:14:16Z' },
  { id: 'u-4', email: 'nuevo@t.t', nombre: '', role: 'usuario', status: 'sin_registro', created_at: '2026-10-01T00:00:00Z', last_sign_in_at: null }
];
const AUDIT = [
  { id: 9, ts: new Date(Date.now() - 3600e3).toISOString(), user_id: 'u-2', email: 'residente2@t.t', nombre: 'Dra Lopez', dispositivo: 'iPad de Lopez', ip: '187.1.2.3', ua: 'Mozilla/5.0 (iPad; CPU OS 17) AppleWebKit Safari/605', tabla: 'notes', op: 'UPDATE', record_id: 'p1', cama: '3-170', paciente: 'PACIENTE PRUEBA', campos: ['manejo', 'checklist'], diff: { manejo: { de: '', a: 'Ceftriaxona 1 g IV c/12 h' }, checklist: { atb: { de: 'false', a: 'true' }, atb_nombre: { de: '""', a: '"CEFTRIAXONA"' } } } },
  { id: 8, ts: new Date(Date.now() - 7200e3).toISOString(), user_id: null, email: 'robot (service_role)', nombre: null, dispositivo: null, ip: null, ua: null, tabla: 'patients', op: 'UPDATE', record_id: 'p1', cama: '3-170', paciente: 'PACIENTE PRUEBA', campos: ['estado'], diff: { estado: { de: 'DELICADO', a: 'ESTABLE' } } },
  { id: 7, ts: new Date(Date.now() - 86400e3).toISOString(), user_id: ADMIN_UID, email: ADMIN_EMAIL, nombre: 'Dr. Fernandez R2', dispositivo: 'Mac Chrome', ip: '10.0.0.5', ua: 'Mozilla/5.0 (Macintosh) Chrome/130', tabla: 'app_users', op: 'ADMIN:bloquear', record_id: 'u-3', cama: null, paciente: null, campos: null, diff: { usuario: 'bloqueado@t.t' } }
];
(async () => {
  const browser = await chromium.launch();
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  const errorsAll = [];
  // Rutas comunes: REST simulado + función admin-users simulada. opts.profile: fila de app_users del usuario (o null).
  async function wire(page, opts) {
    const calls = [], fn = [];
    page.on('pageerror', e => errorsAll.push(String((e && e.stack) || e).slice(0, 300)));
    await page.route('**/vendor/supabase*', r => r.abort());
    await page.route('**/functions/v1/admin-users', async (route) => {
      const req = route.request(); let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      fn.push({ body, headers: req.headers() });
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      const a = body && body.action;
      if (a === 'list') return json(200, { users: USERS, me: { id: ADMIN_UID, role: 'admin' } });
      if (a === 'invite') return json(200, { ok: true, id: 'u-9', email: body.email, temp_password: 'Abc12345xy' });
      if (a === 'temp_password') return json(200, { ok: true, temp_password: 'Zz98765qrs' });
      if (a === 'recovery_link') return json(200, { ok: true, link: 'https://x.supabase.co/auth/v1/verify?token=abc&type=recovery' });
      if (a === 'falla') return json(400, { error: 'No puedes bloquearte a ti mismo' });
      return json(200, { ok: true });
    });
    await page.route('**/rest/v1/**', async (route) => {
      const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (_) {}
      calls.push({ m, url, body, headers: req.headers() });
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (url.startsWith('/rest/v1/app_users')) { if (m === 'GET') return json(200, opts.profile ? [opts.profile] : []); return json(200, [opts.profile || {}]); }
      if (url.startsWith('/rest/v1/audit_log')) return json(200, AUDIT);
      if (url.startsWith('/rest/v1/patients')) { if (m === 'GET') return json(200, [{ id: 'p1', cama: '3-170', exp: '1', nombre: 'PACIENTE PRUEBA', esp: 'CG', estado: 'ESTABLE', edad: '40' }]); return json(201, [{ id: 'p1' }]); }
      if (url.startsWith('/rest/v1/notes')) { if (m === 'GET') return json(200, []); return json(201, [{ patient_id: 'p1' }]); }
      return json(200, []);
    });
    return { calls, fn };
  }

  // ── Escenario A: administrador ──
  const ctxA = await browser.newContext({ viewport: { width: 1194, height: 834 } }); const page = await ctxA.newPage();
  const { calls, fn } = await wire(page, { profile: USERS[0] });
  await page.addInitScript(mockScript(ADMIN_UID, ADMIN_EMAIL));
  await page.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(5000);

  const a1 = await page.evaluate(async () => {
    await _sGet('guard_info', 'select=id');
    return { overlay: document.getElementById('login-overlay').style.display, name: localStorage.getItem('pl_user_name'), uid: myUserId(), email: myEmail(), admin: isAdmin(), btn: document.getElementById('admin-btn').style.display, chip: (document.getElementById('user-chip') || {}).textContent || '', dev: deviceLabel() };
  });
  const last = calls[calls.length - 1];
  const profileGet = calls.find(c => c.m === 'GET' && /\/rest\/v1\/app_users\?/.test(c.url));
  const seenPatch = calls.find(c => c.m === 'PATCH' && /\/rest\/v1\/app_users\?id=eq\.u-admin-1/.test(c.url) && c.body && c.body.last_seen_at);
  check('A1 al entrar: lee su perfil (id=eq.<uid>), toma el nombre de la cuenta ("Dr. Fernández R2"), marca último acceso, botón 👥 visible solo para admin; cada petición REST lleva X-PL-Device (ASCII) y X-PL-User sin acentos',
    a1.overlay === 'none' && a1.name === 'Dr. Fernández R2' && a1.uid === 'u-admin-1' && a1.email === 'admin@t.t' && a1.admin && a1.btn !== 'none'
    && !!profileGet && /id=eq\.u-admin-1/.test(profileGet.url) && !!seenPatch
    && last && last.headers['x-pl-user'] === 'Dr. Fernandez R2' && /^[\x20-\x7e]+$/.test(last.headers['x-pl-device'] || '') && last.headers['x-pl-device'].length > 2 && /^Bearer eyJ/.test(last.headers['authorization']), JSON.stringify({ a1, last: last && last.headers, seenPatch: !!seenPatch }));

  const a3 = await page.evaluate(async () => {
    openAdminPanel();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (document.querySelectorAll('[data-testid="adm-user"]').length) break; }
    const rows = Array.from(document.querySelectorAll('[data-testid="adm-user"]')).map(r => ({ uid: r.dataset.uid, txt: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 120), blocked: r.classList.contains('adm-blocked'), acts: Array.from(r.querySelectorAll('.adm-btn')).map(b => b.textContent.trim()) }));
    return { shown: document.getElementById('admin-modal').style.display, rows, selfBlock: !!document.querySelector('[data-uid="u-admin-1"] [data-testid="adm-block"]') };
  });
  const listCall = fn.find(c => c.body && c.body.action === 'list');
  check('A3 panel 👥 Usuarios: pide la lista a la función con el token del usuario y la cabecera de dispositivo; muestra activo/bloqueado/sin registro, admin, "tú"; el admin no tiene botón para bloquearse; el sin registro solo tiene "Dar acceso"',
    a3.shown === 'flex' && a3.rows.length === 4 && /tú/.test(a3.rows[0].txt) && /admin/.test(a3.rows[0].txt) && a3.rows[2].blocked && /bloqueado/.test(a3.rows[2].txt) && /sin registro/.test(a3.rows[3].txt)
    && a3.rows[3].acts.length === 1 && /Dar acceso/.test(a3.rows[3].acts[0]) && a3.rows[1].acts.some(t => /Bloquear/.test(t)) && a3.rows[2].acts.some(t => /Activar/.test(t)) && !a3.selfBlock
    && listCall && /^Bearer eyJ/.test(listCall.headers['authorization']) && listCall.headers['x-pl-device'] && listCall.body.redirect_to === 'http://127.0.0.1:8771/index.html', JSON.stringify({ a3, listHdr: listCall && listCall.headers }));

  const a4 = await page.evaluate(async () => {
    document.getElementById('adm-inv-email').value = 'Nueva@Hospital.MX'; document.getElementById('adm-inv-nombre').value = 'Dra. Nueva R1'; document.getElementById('adm-inv-role').value = 'usuario';
    await adminInvite(); await new Promise(r => setTimeout(r, 300));
    return { pass: (document.querySelector('[data-testid="adm-temp-pass"]') || {}).textContent, emailCleared: document.getElementById('adm-inv-email').value };
  });
  const inv = fn.find(c => c.body && c.body.action === 'invite');
  check('A4 crear cuenta: manda correo (en minúsculas), nombre y rol a la función y muestra la contraseña temporal una sola vez',
    inv && inv.body.email === 'nueva@hospital.mx' && inv.body.nombre === 'Dra. Nueva R1' && inv.body.role === 'usuario' && a4.pass === 'Abc12345xy' && a4.emailCleared === '', JSON.stringify({ a4, inv: inv && inv.body }));

  const a5 = await page.evaluate(async () => {
    const n0 = window.__alerts.length;
    await adminAct('set_status', 'u-2', { status: 'blocked' });
    await adminAct('temp_password', 'u-2');
    await adminAct('recovery_link', 'u-2');
    await adminAct('set_role', 'u-2', { role: 'admin' });
    window.__promptAnswer = 'Dra. López Ruiz'; await adminAct('set_nombre', 'u-2');
    window.__promptAnswer = 'Nuevo Usuario'; await adminAct('activar_registro', 'u-4');
    await adminAct('delete_user', 'u-3');
    await adminAct('falla', 'u-admin-1');
    await new Promise(r => setTimeout(r, 300));
    return { alerts: window.__alerts.slice(n0), clip: window.__clip.slice() };
  });
  const acts = fn.filter(c => c.body && ['set_status', 'temp_password', 'recovery_link', 'set_role', 'set_nombre', 'activar_registro', 'delete_user', 'falla'].includes(c.body.action)).map(c => c.body);
  check('A5 acciones: bloquear, contraseña temporal (al portapapeles + aviso), enlace de recuperación (copiado), rol, nombre, dar acceso, borrar; el error de la función se muestra tal cual',
    acts.length === 8 && acts[0].action === 'set_status' && acts[0].id === 'u-2' && acts[0].status === 'blocked'
    && acts[1].action === 'temp_password' && a5.clip.includes('Zz98765qrs') && a5.alerts.some(t => /Zz98765qrs/.test(t))
    && acts[2].action === 'recovery_link' && a5.clip.some(t => /verify\?token=abc/.test(t)) && a5.alerts.some(t => /Enlace de recuperación copiado/.test(t))
    && acts[3].action === 'set_role' && acts[3].role === 'admin' && acts[4].action === 'set_nombre' && acts[4].nombre === 'Dra. López Ruiz'
    && acts[5].action === 'activar_registro' && acts[5].id === 'u-4' && acts[5].nombre === 'Nuevo Usuario' && acts[6].action === 'delete_user' && acts[6].id === 'u-3'
    && a5.alerts.some(t => /No puedes bloquearte a ti mismo/.test(t)), JSON.stringify({ acts, a5 }));

  const a6 = await page.evaluate(async () => {
    adminTab('actividad');
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (document.querySelectorAll('[data-testid="adm-act"]').length) break; }
    const rows = Array.from(document.querySelectorAll('[data-testid="adm-act"]')).map(r => r.textContent.replace(/\s+/g, ' ').trim());
    document.getElementById('adm-act-cama').value = '3-170'; document.getElementById('adm-act-user').value = '__robot'; await adminLoadActivity(); await new Promise(r => setTimeout(r, 200));
    return { rows };
  });
  const actGets = calls.filter(c => c.m === 'GET' && /\/rest\/v1\/audit_log/.test(c.url)).map(c => decodeURIComponent(c.url));
  check('A6 🕵️ Actividad: consulta audit_log de los últimos días en orden descendente; cada renglón dice quién (nombre y cuenta), desde dónde (dispositivo · navegador · IP) y qué cambió (de → a, incluidas las claves del checklist); el robot sale como 🤖; filtros de cama y robot',
    a6.rows.length === 3
    && /Dra Lopez residente2@t\.t/.test(a6.rows[0]) && /iPad de Lopez · iPad Safari · 187\.1\.2\.3/.test(a6.rows[0]) && /editó nota · cama 3-170 · PACIENTE PRUEBA/.test(a6.rows[0]) && /manejo ∅ → Ceftriaxona 1 g IV c\/12 h/.test(a6.rows[0]) && /atb false → true/.test(a6.rows[0]) && /atb_nombre "" → "CEFTRIAXONA"/.test(a6.rows[0])
    && /🤖 robot \(service_role\)/.test(a6.rows[1]) && /editó paciente · cama 3-170/.test(a6.rows[1]) && /estado DELICADO → ESTABLE/.test(a6.rows[1])
    && /bloquear → bloqueado@t\.t/.test(a6.rows[2]) && /Mac Chrome · Mac Chrome · 10\.0\.0\.5/.test(a6.rows[2])
    && actGets.length >= 2 && /order=ts\.desc/.test(actGets[0]) && /ts=gte\.\d{4}-/.test(actGets[0]) && /limit=300/.test(actGets[0]) && /cama=eq\.3-170/.test(actGets[actGets.length - 1]) && /user_id=is\.null/.test(actGets[actGets.length - 1]), JSON.stringify({ rows: a6.rows, actGets }));

  const a7 = await page.evaluate(async () => {
    closeAdminPanel();
    openAccountPanel();
    const em = document.getElementById('acc-email').textContent;
    document.getElementById('acc-nombre').value = 'Gera F'; document.getElementById('acc-device').value = 'iPad de Gera';
    await saveAccountPanel(); await new Promise(r => setTimeout(r, 300));
    await _sGet('guard_info', 'select=id');
    openNewPasswordDialog(false);
    document.getElementById('pwd-new').value = 'corta'; document.getElementById('pwd-new2').value = 'corta'; await saveNewPassword();
    const err1 = document.getElementById('pwd-err').textContent;
    document.getElementById('pwd-new').value = 'SecretaClave123'; document.getElementById('pwd-new2').value = 'SecretaClave124'; await saveNewPassword();
    const err2 = document.getElementById('pwd-err').textContent;
    document.getElementById('pwd-new2').value = 'SecretaClave123'; await saveNewPassword(); await new Promise(r => setTimeout(r, 100));
    return { em, name: localStorage.getItem('pl_user_name'), dev: localStorage.getItem('pl_device_name'), chip: deviceLabel(), err1, err2, modal: document.getElementById('pwd-modal').style.display, auth: window.__auth.filter(a => a[0] === 'updateUser'), alerts: window.__alerts.slice(-1) };
  });
  const namePatch = calls.find(c => c.m === 'PATCH' && /app_users\?id=eq\.u-admin-1/.test(c.url) && c.body && c.body.nombre === 'Gera F');
  const lastReq = calls[calls.length - 1];
  check('A7 👤 Mi cuenta: muestra correo y rol, guarda nombre (también en la cuenta) y nombre del dispositivo (viaja en X-PL-Device); cambiar contraseña valida longitud y coincidencia y llama a updateUser',
    /admin@t\.t · administrador/.test(a7.em) && a7.name === 'Gera F' && a7.dev === 'iPad de Gera' && a7.chip === 'iPad de Gera' && !!namePatch
    && /Mínimo 12/.test(a7.err1) && /no coinciden/.test(a7.err2) && a7.modal === 'none' && a7.auth.length === 1 && a7.auth[0][1].password === 'SecretaClave123' && /Contraseña guardada/.test(a7.alerts[0] || '')
    && lastReq.headers['x-pl-device'] === 'iPad de Gera' && lastReq.headers['x-pl-user'] === 'Gera F', JSON.stringify({ a7, namePatch: !!namePatch, hdr: lastReq.headers }));

  const a8 = await page.evaluate(async () => {
    document.getElementById('login-user').value = 'olvido@t.t';
    await forgotPassword();
    const msg = document.getElementById('login-msg');
    return { auth: window.__auth.filter(a => a[0] === 'resetPasswordForEmail'), msg: msg.textContent, shown: msg.style.display, link: !!document.querySelector('[data-testid="login-forgot"]') };
  });
  check('A8 ¿Olvidaste tu contraseña?: botón en el login; pide a Supabase el correo de recuperación con el redirect a la app y avisa',
    a8.link && a8.auth.length === 1 && a8.auth[0][1] === 'olvido@t.t' && a8.auth[0][2].redirectTo === 'http://127.0.0.1:8771/index.html' && /te llegará un enlace/.test(a8.msg) && a8.shown === 'block', JSON.stringify(a8));
  await ctxA.close();

  // ── Escenario B: cuenta bloqueada ──
  const ctxB = await browser.newContext({ viewport: { width: 1194, height: 834 } }); const pageB = await ctxB.newPage();
  const wB = await wire(pageB, { profile: { id: 'u-3', email: 'bloqueado@t.t', nombre: 'Bloqueado', role: 'usuario', status: 'blocked' } });
  await pageB.addInitScript(mockScript('u-3', 'bloqueado@t.t'));
  await pageB.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await pageB.waitForTimeout(4000);
  const b1 = await pageB.evaluate(() => ({ overlay: document.getElementById('login-overlay').style.display, err: document.getElementById('login-error').textContent, token: _userAccessToken, auth: window.__auth.filter(a => a[0] === 'signOut').length, admin: document.getElementById('admin-btn').style.display }));
  const dataGets = wB.calls.filter(c => c.m === 'GET' && /\/rest\/v1\/(patients|notes)/.test(c.url)).length;
  check('B1 cuenta bloqueada: al entrar se cierra la sesión, vuelve al login con el aviso y no se piden datos',
    b1.overlay === 'flex' && /bloqueada/.test(b1.err) && b1.token === null && b1.auth >= 1 && b1.admin === 'none' && dataGets === 0, JSON.stringify({ b1, dataGets }));
  await ctxB.close();

  // ── Escenario C: cuenta sin registro ──
  const ctxC = await browser.newContext({ viewport: { width: 1194, height: 834 } }); const pageC = await ctxC.newPage();
  await wire(pageC, { profile: null });
  await pageC.addInitScript(mockScript('u-nuevo', 'nuevo@t.t'));
  await pageC.goto('http://127.0.0.1:8771/index.html', { waitUntil: 'load', timeout: 90000 });
  await pageC.waitForTimeout(4000);
  const c1 = await pageC.evaluate(() => ({ overlay: document.getElementById('login-overlay').style.display, err: document.getElementById('login-error').textContent }));
  check('C1 cuenta sin registro en app_users: fuera con aviso de pedir acceso al administrador', c1.overlay === 'flex' && /no tiene acceso autorizado/.test(c1.err), JSON.stringify(c1));
  await ctxC.close();

  // ── Escenario D: enlace de recuperación (#access_token…&type=recovery) ──
  const ctxD = await browser.newContext({ viewport: { width: 1194, height: 834 } }); const pageD = await ctxD.newPage();
  await wire(pageD, { profile: USERS[1] });
  await pageD.addInitScript(mockScript('u-2', 'residente2@t.t', "sessionStorage.removeItem('__mock_session');"));
  const recTok = tokenFor('u-2', 'residente2@t.t');
  await pageD.goto('http://127.0.0.1:8771/index.html#access_token=' + recTok + '&refresh_token=rt-1&type=recovery&expires_in=3600', { waitUntil: 'load', timeout: 90000 });
  await pageD.waitForTimeout(5000);
  const d1 = await pageD.evaluate(async () => {
    const before = { hash: location.hash, modal: (document.getElementById('pwd-modal') || {}).style ? document.getElementById('pwd-modal').style.display : 'no', hint: (document.getElementById('pwd-hint') || {}).textContent || '', overlay: document.getElementById('login-overlay').style.display, set: window.__auth.filter(a => a[0] === 'setSession').map(a => a[1].access_token.slice(0, 10)) };
    document.getElementById('pwd-new').value = 'NuevaClave2026'; document.getElementById('pwd-new2').value = 'NuevaClave2026'; await saveNewPassword(); await new Promise(r => setTimeout(r, 100));
    return { before, upd: window.__auth.filter(a => a[0] === 'updateUser').map(a => a[1].password), alert: window.__alerts.slice(-1)[0] || '' };
  });
  check('D1 enlace de recuperación: la app instala la sesión del enlace, limpia la URL, entra sin pedir login y pide la contraseña nueva; al guardarla llama a updateUser y avisa',
    d1.before.hash === '' && d1.before.modal === 'flex' && /enlace de recuperación/.test(d1.before.hint) && d1.before.overlay === 'none' && d1.before.set.length === 1 && d1.before.set[0] === 'eyJhbGciOi'
    && d1.upd.length === 1 && d1.upd[0] === 'NuevaClave2026' && /Ya puedes usar la app/.test(d1.alert), JSON.stringify(d1));
  await ctxD.close();

  check('final: sin errores no capturados', errorsAll.length === 0, errorsAll.join(' | '));
  console.log('RESULT APP-ADMIN: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch(e => { console.error('CRASH', e); process.exit(2); });
