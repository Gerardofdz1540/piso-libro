const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL_A || 'http://127.0.0.1:8766';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  const log=(m)=>{ try{ const a=JSON.parse(sessionStorage.getItem('__mock_log')||'[]'); a.push(m); sessionStorage.setItem('__mock_log', JSON.stringify(a)); }catch(e){} };
  window.prompt=function(){ log('prompt'); return 'Tester'; };
  window.alert=function(m){ log('alert:'+String(m).slice(0,40)); };
  const auth={
    // Refresh rechazado por el servidor (token revocado/vencido de verdad): debe cerrar sesión. Sin red NO (BOOT-5).
    refreshSession: async()=>({ data:{ session:null }, error:{ name:'AuthApiError', message:'Invalid Refresh Token: Already Used' } }),
    getSession: async()=>{ const s=sessionStorage.getItem(KEY); return { data:{ session: s?JSON.parse(s):null }, error:null }; },
    onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; },
    signInWithPassword: async({email,password})=>{
      log('signIn:'+email);
      if(password!=='good') return { data:{user:null,session:null}, error:{ message:'Invalid login credentials' } };
      const session={ access_token:'mock-token-123', refresh_token:'r', user:{ email } };
      sessionStorage.setItem(KEY, JSON.stringify(session));
      listeners.forEach(cb=>{ try{ cb('SIGNED_IN', session); }catch(e){} });
      return { data:{ session }, error:null };
    },
    signOut: async()=>{ log('signOut'); sessionStorage.removeItem(KEY); listeners.forEach(cb=>{ try{ cb('SIGNED_OUT', null); }catch(e){} }); return { error:null }; }
  };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); } };
  window.__mockAuth={ emit:(e,s)=>listeners.forEach(cb=>cb(e,s)), log:()=>JSON.parse(sessionStorage.getItem('__mock_log')||'[]') };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
(async()=>{
  const browser=await launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e).slice(0,300)));
  const rest=[]; page.on('request',r=>{ if(r.url().includes('/rest/v1/')) rest.push({url:r.url().slice(0,110), auth:r.headers()['authorization'], apikey:(r.headers()['apikey']||'').slice(0,10)}); });
  await page.route('**/vendor/supabase*', r=>r.abort());
  // REST local (oct 2026): antes las llamadas salían a Supabase real; cuando la red del entorno de
  // pruebas sí alcanza supabase.co, el token falso recibe un 401 auténtico y la app cierra la sesión
  // en la fase 2. Con esta respuesta local la suite no depende de la red (la fase 3 la sobreescribe con 401).
  await page.route('**/rest/v1/**', r=>r.fulfill({status:200, contentType:'application/json', body:'[]'}));
  await page.addInitScript(MOCK);
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  const ov=()=>page.evaluate(()=>{const o=document.getElementById('login-overlay');return o?getComputedStyle(o).display:'MISSING';});

  // ── Phase 1: no session ──
  await page.goto(BASE_URL + '/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(3000);
  check('P1 overlay visible without session', (await ov())==='flex', await ov());
  check('P1 no REST calls before login', rest.length===0, 'rest='+rest.length);
  const log1=await page.evaluate(()=>window.__mockAuth.log());
  check('P1 no name prompt before login', !log1.includes('prompt'), JSON.stringify(log1));
  check('P1 no uncaught errors', errors.length===0, errors.join(' | '));
  await page.evaluate(()=>{ document.getElementById('login-user').value='a@b.c'; document.getElementById('login-pwd').value='bad'; return loginSubmit(); });
  await page.waitForTimeout(500);
  const errTxt=await page.evaluate(()=>document.getElementById('login-error').textContent);
  check('P1 wrong password shows error', /Invalid login credentials/.test(errTxt), errTxt);
  check('P1 overlay still visible after bad login', (await ov())==='flex');
  const nav=page.waitForNavigation({waitUntil:'load',timeout:30000}).catch(()=>null);
  try { await page.evaluate(()=>{ document.getElementById('login-user').value='a@b.c'; document.getElementById('login-pwd').value='good'; loginSubmit(); }); } catch(e){}
  const navRes=await nav;
  check('P1 correct login triggers reload', !!navRes, 'no navigation observed');

  // ── Phase 2: session present at load ──
  rest.length=0;
  await page.waitForTimeout(4000);
  check('P2 overlay hidden with session', (await ov())==='none', await ov());
  const tok=await page.evaluate(()=>_userAccessToken);
  check('P2 _userAccessToken restored from session', tok==='mock-token-123', String(tok));
  check('P2 REST calls attempted after login', rest.length>0, 'rest='+rest.length);
  const okHdr=rest.length>0 && rest.every(r=>r.auth==='Bearer mock-token-123' && r.apikey.startsWith('eyJ'));
  check('P2 REST uses user token + anon apikey', okHdr, JSON.stringify(rest.slice(0,3)));
  check('P2 no uncaught errors', errors.length===0, errors.join(' | '));
  await page.evaluate(()=>{ window.__marker=42; window.__mockAuth.emit('SIGNED_IN',{access_token:'mock-token-123'}); });
  await page.waitForTimeout(1500);
  const marker=await page.evaluate(()=>window.__marker).catch(()=>null);
  check('P2 SIGNED_IN (tab refocus) does NOT reload', marker===42, String(marker));
  await page.evaluate(()=>window.__mockAuth.emit('TOKEN_REFRESHED',{access_token:'new-tok'}));
  check('P2 TOKEN_REFRESHED updates token', (await page.evaluate(()=>_userAccessToken))==='new-tok');

  // ── Phase 3: backend returns 401 → session invalid → back to login ──
  await page.route('**/rest/v1/**', r=>r.fulfill({status:401, contentType:'application/json', body:'{"message":"JWT expired"}'}));
  await page.evaluate(()=>_sGet('patients','select=id&limit=1').catch(()=>{}));
  await page.waitForTimeout(1500);
  check('P3 401 marks session invalid', (await page.evaluate(()=>_sessionInvalidated))===true);
  check('P3 overlay shown after 401', (await ov())==='flex', await ov());
  const e3=await page.evaluate(()=>document.getElementById('login-error').textContent);
  check('P3 expiry message shown', /expir/i.test(e3), e3);
  const log3=await page.evaluate(()=>window.__mockAuth.log());
  check('P3 signOut called on invalidation', log3.includes('signOut'), JSON.stringify(log3));
  check('P3 token cleared', (await page.evaluate(()=>_userAccessToken))===null);
  check('P3 no uncaught errors', errors.length===0, errors.join(' | '));

  console.log('\nRESULT B: '+pass+' passed, '+fail+' failed');
  await browser.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('SCRIPT FAIL',e);process.exit(2);});
