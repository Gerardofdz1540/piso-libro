const { chromium } = require('playwright');
(async()=>{
  const browser=await chromium.launch(); const page=await browser.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String((e&&e.stack)||e)));
  const rest=[]; page.on('request',r=>{ if(r.url().includes('/rest/v1/')) rest.push(r.url().slice(0,100)); });
  await page.route('**/vendor/supabase*', r=>r.abort());
  let pass=0, fail=0; const check=(n,c,x)=>{ if(c){pass++;console.log('PASS '+n);} else {fail++;console.log('FAIL '+n+(x?' :: '+x:''));} };
  await page.goto('http://127.0.0.1:8767/index.html',{waitUntil:'load',timeout:90000});
  await page.waitForTimeout(5000);
  const ov=await page.evaluate(()=>{const o=document.getElementById('login-overlay');return o?getComputedStyle(o).display:'MISSING';});
  const err=await page.evaluate(()=>(document.getElementById('login-error')||{}).textContent||'');
  check('A no uncaught errors when supabase-js fails to load', errors.length===0, errors.join(' | '));
  check('A login overlay visible', ov==='flex', ov);
  check('A CDN-failure message shown in overlay', /No se pudo cargar (la librería de )?Supabase/.test(err), err);
  check('A no REST calls attempted', rest.length===0, 'rest='+rest.length);
  console.log('\nRESULT A: '+pass+' passed, '+fail+' failed');
  await browser.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('SCRIPT FAIL',e);process.exit(2);});
