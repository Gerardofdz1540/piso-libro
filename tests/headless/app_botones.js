// 🔘 Todos los botones (27 oct 2026). Pacientes ficticios.
// · cada función que llama un botón, selector o casilla (on…="…") existe en el alcance global de la página;
// · se recorre cada vista (piso con las tarjetas desplegadas y en modo Hoja, censo, impresión, No olvidar, altas,
//   pendientes, tablero, papelera) y se pulsa CADA botón visible, uno por uno, con «Cancelar» en toda confirmación y
//   en todo diálogo (nada se borra); ningún botón puede dejar un error sin atrapar en la página;
// · después del recorrido las cajas de las tarjetas siguen con su texto, sin renglones repetidos.
// node tests/headless/app_botones.js   (ver run_all.sh)
const fs = require('fs');
const path = require('path');
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester Uno');
  window.__alerts=[]; window.alert=function(m){ window.__alerts.push(String(m)); };
  window.confirm=function(){ return false; }; window.prompt=function(){ return null; };
  window.print=function(){}; window.open=function(){ const d={ write(){}, writeln(){}, close(){}, open(){}, body:{ innerHTML:'' } }; return { document:d, close(){}, focus(){}, print(){}, addEventListener(){}, closed:false }; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); },
    track(){ return Promise.resolve('ok'); }, untrack(){ return Promise.resolve('ok'); }, presenceState(){ return {}; } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({ upload: async()=>({ data:{ path:'x' }, error:null }), createSignedUrl: async()=>({ data:{ signedUrl:'about:blank' }, error:null }), remove: async()=>({ data:[], error:null }) }) } }) };
})();`;
const hoy = new Date(); const z = (n) => String(n).padStart(2, '0');
const F = (d) => d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
const HOY = F(hoy), AYER = F(new Date(Date.now() - 86400e3));
const nota = (id, extra) => Object.assign({ patient_id: id, app: 'HAS DE 10 AÑOS', pa: 'DOLOR ABDOMINAL', drenajes: '', qx: '', manejo: 'AYUNO\nSOLUCIONES', sangrado: '', sv: '', balance: '', pendientes: 'USG DE CONTROL',
  misc: '', cronologia: AYER.split('-').reverse().slice(0, 2).join('/') + ' 08:00 R2: INGRESA',
  checklist: { sexo: 'M', atb: true, atb_nombre: 'CEFTRIAXONA', cirugias: [{ id: 'c1', fecha: AYER, procedimiento: 'APENDICECTOMIA', hallazgos: 'APENDICE PERFORADO', sangrado: '50 ML' }],
    pm_fecha: HOY, pm_fc: '88', pm_ta: '120/80', pm_temp: '36.8' },
  lab_history: [{ fecha: AYER, source: 'winlab', labs: { hb: '11.2', leucos: '14.1', plaq: '250', cr: '0.9', na: '138', k: '6.3', glu: '110' } }, { fecha: HOY, source: 'winlab', labs: { hb: '10.9', tp: '13', tp_testigo: '12' } }],
  imagen_history: [{ fecha: AYER, estudios: [{ tipo: 'USG', descripcion: 'LIQUIDO LIBRE ESCASO' }] }],
  updated_at: new Date().toISOString() }, extra || {});
const store = {
  patients: [
    { id: 'b1', cama: '3-301', exp: '26-80001', nombre: 'JUAN PRUEBA BOTON', esp: 'CG', edad: '50', estado: 'ESTABLE', dx: 'APENDICITIS', ingreso: AYER, residente: 'R1 A', adscrito: 'DR B' },
    { id: 'b2', cama: '3-302', exp: '26-80002', nombre: 'PEDRO PRUEBA BOTON', esp: 'CG', edad: '61', estado: 'GRAVE', dx: 'COLECISTITIS', ingreso: AYER },
    { id: 'b3', cama: '3-303', exp: '26-80003', nombre: 'MARIA PRUEBA BOTON', esp: 'URO', edad: '40', estado: 'DELICADO', dx: 'LITIASIS', ingreso: HOY },
    { id: 'b4', cama: '3-304', exp: '26-80004', nombre: 'LUISA PRUEBA BOTON', esp: 'CG', edad: '35', estado: 'ESTABLE', dx: 'HERNIA', ingreso: HOY },
  ],
  notes: [nota('b1'), nota('b2', { pendientes: 'TAC' }), nota('b3', { checklist: { sexo: 'F' } }), nota('b4', { lab_history: [] })],
};
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; let ultimo = '(carga)';
  page.on('pageerror', (e) => errors.push(ultimo + ' → ' + String((e && e.message) || e).slice(0, 240)));
  page.on('console', (m) => { if (m.type() === 'error' && /TypeError|ReferenceError|is not defined|is not a function|Cannot read|Cannot set|undefined \(reading/.test(m.text())) errors.push(ultimo + ' → console: ' + m.text().slice(0, 240)); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('download', (d) => d.cancel().catch(() => {}));
  await page.route('**/vendor/supabase*', (r) => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients')) return m === 'GET' ? json(200, store.patients) : json(200, [{}]);
    if (url.startsWith('/rest/v1/notes')) {
      if (m !== 'GET') return json(201, [{}]);
      const id = (/patient_id=eq\.([^&]+)/.exec(url) || [])[1];
      return json(200, id ? store.notes.filter((n) => n.patient_id === id) : store.notes);
    }
    if (url.startsWith('/rest/v1/rpc/')) return json(200, 'ok');
    return m === 'GET' ? json(200, []) : json(201, [{}]);
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"content":[{"type":"text","text":"{}"}]}' }));
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + x : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 4, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  // ── B1: toda función que llama un manejador en línea existe en el alcance global ──
  const nombres = new Set();
  for (const m of HTML.matchAll(/\son([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const code = (m[2] !== undefined ? m[2] : m[3]).replace(/\$\{[^}]*\}/g, '0').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "''");
    for (const c of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) nombres.add(c[2]);
  }
  const reservadas = new Set('if for while return typeof new void delete in of instanceof function'.split(' '));
  const faltan = await page.evaluate((ns) => ns.filter((n) => { try { return typeof (0, eval)(n) !== 'function'; } catch (_) { return true; } }), Array.from(nombres).filter((n) => !reservadas.has(n)));
  check('B1 las ' + nombres.size + ' funciones que llaman los botones existen en la página (alcance global)', !faltan.length, faltan.join(', '));

  // ── B2: pulsar cada botón visible de cada vista ──
  const SALTAR = /logout|signOut|cerrarSesion|location\.|reload|_applyUpdate|actualizarAhora|forzarActualizacion|hardRefresh/i;
  const vistas = ['piso', 'census', 'print', 'noOlvidar', 'altas', 'pendientes', 'tablero', 'papelera'];
  const preparar = async (v, hoja) => page.evaluate(async ({ v, hoja }) => {
    try { localStorage.setItem('pl_hoja', hoja ? '1' : '0'); if (typeof _applyHojaClasses === 'function') _applyHojaClasses(); } catch (_) {}
    setView(v);
    if (v === 'piso') { patients.forEach((p) => { expandedCards[pid(p)] = true; }); renderView(); document.querySelectorAll('[id^="card-"]').forEach((c) => { c.classList.add('show-full'); c.querySelectorAll('details').forEach((d) => { d.open = true; }); }); }
    await new Promise((r) => setTimeout(r, 300));
  }, { v, hoja });
  // Candidatos: elementos que se pueden pulsar, visibles, dentro de `scope` (selector) o en toda la página.
  const SEL = 'button, [onclick], select[onchange], input[type="checkbox"][onchange], input[type="checkbox"][onclick]';
  const candidatos = (scope) => page.evaluate(({ saltarSrc, SEL, scope }) => {
    const saltar = new RegExp(saltarSrc, 'i');
    const raiz = scope ? document.querySelector(scope) : document;
    if (!raiz) return [];
    const vis = Array.from(raiz.querySelectorAll(SEL)).filter((e) => e.offsetParent !== null && !e.disabled && e.type !== 'file');
    const cuenta = {}; const out = [];
    vis.forEach((e) => {
      const sig = e.tagName + '|' + (e.getAttribute('onclick') || e.getAttribute('onchange') || '') + '|' + (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      cuenta[sig] = (cuenta[sig] || 0) + 1;
      if (saltar.test(sig)) return;
      out.push({ sig, n: cuenta[sig] - 1 });
    });
    return out;
  }, { saltarSrc: SALTAR.source, SEL, scope: scope || null });
  // Pulsa el n-ésimo elemento con esa firma; después marca la ventana que haya quedado abierta (data-pl-crawl-modal).
  const pulsar = (c, scope) => page.evaluate(({ c, SEL, scope }) => {
    const raiz = scope ? document.querySelector(scope) : document;
    if (!raiz) return { ok: false };
    const els = Array.from(raiz.querySelectorAll(SEL)).filter((e) => e.offsetParent !== null && !e.disabled);
    const iguales = els.filter((e) => (e.tagName + '|' + (e.getAttribute('onclick') || e.getAttribute('onchange') || '') + '|' + (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)) === c.sig);
    const el = iguales[c.n] || iguales[0];
    if (!el) return { ok: false };
    document.querySelectorAll('[data-pl-crawl-modal]').forEach((m) => m.removeAttribute('data-pl-crawl-modal'));
    const antes = new Set(Array.from(document.querySelectorAll('.modal-bg, body > *')).filter((m) => getComputedStyle(m).display !== 'none'));
    if (el.tagName === 'SELECT') { const o = el.options; if (o.length > 1) el.selectedIndex = (el.selectedIndex + 1) % o.length; el.dispatchEvent(new Event('change', { bubbles: true })); }
    else el.click();
    return { ok: true, antes: antes.size };
  }, { c, SEL, scope: scope || null });
  const marcarModal = () => page.evaluate(() => {
    const abiertas = Array.from(document.querySelectorAll('.modal-bg, body > *')).filter((m) => {
      const cs = getComputedStyle(m); return cs.display !== 'none' && cs.position === 'fixed' && (m.classList.contains('modal-bg') || +cs.zIndex >= 900) && !/^(rnav|toast|sync)/.test(m.id || '') && m.querySelector('button, [onclick]');
    });
    const m = abiertas[abiertas.length - 1];
    if (!m) return false;
    m.setAttribute('data-pl-crawl-modal', '1');
    return true;
  });
  const cerrar = (v) => page.evaluate((v) => {
    document.querySelectorAll('.modal-bg, .modal, [role="dialog"]').forEach((m) => { if (getComputedStyle(m).display !== 'none' && getComputedStyle(m).position === 'fixed') m.style.display = 'none'; });
    Array.from(document.body.children).forEach((e) => { const cs = getComputedStyle(e); if (cs.position === 'fixed' && +cs.zIndex >= 900 && !/^(rnav|toast|sync)/.test(e.id || '')) e.style.display = 'none'; });
    document.querySelectorAll('[data-pl-crawl-modal]').forEach((m) => m.removeAttribute('data-pl-crawl-modal'));
    if (typeof currentView !== 'undefined' && currentView !== v) setView(v);
  }, v);
  // Menús plegados («⋯ Más» del encabezado, «⋯» de cada tarjeta, plantillas, ajustes de la Hoja): se abren para que
  // sus botones también se pulsen (antes del recorrido y antes de cada pulsación: un repintado los vuelve a plegar).
  const abrirMenus = () => page.evaluate(() => {
    const m = document.getElementById('hc-more-menu'); if (m) m.style.display = 'block';
    document.querySelectorAll('.card-more, .hoja-cfg-menu, .tmpl-menu').forEach((e) => { e.classList.add('open'); if (e.style.display === 'none') e.style.display = 'block'; });
    document.querySelectorAll('.card-more-menu').forEach((e) => { if (getComputedStyle(e).display === 'none') e.style.display = 'block'; });
  });
  const vistos = new Set(); let pulsados = 0, enVentanas = 0;
  const norm = (sig) => sig.replace(/'[^']*'|"[^"]*"|\b\d[\w-]*/g, '_');
  for (const hoja of [false, true]) {
    for (const v of (hoja ? ['piso'] : vistas)) {
      await preparar(v, hoja);
      await abrirMenus();
      const lista = await candidatos();
      for (const c of lista) {
        const clave = v + (hoja ? '@hoja' : '') + '|' + norm(c.sig);
        if (vistos.has(clave)) continue;   // el mismo botón en otra tarjeta: basta una vez
        vistos.add(clave);
        ultimo = '[' + v + (hoja ? ' · Hoja' : '') + '] ' + c.sig.slice(0, 160);
        await abrirMenus();
        const r = await pulsar(c);
        if (!r.ok) continue;
        pulsados++;
        await page.waitForTimeout(150);
        // Si abrió una ventana (editar, labs masivo, calculadora…), se pulsa también lo que hay dentro, uno por uno;
        // si un botón la cierra, se vuelve a abrir con el mismo botón de antes.
        if (await marcarModal()) {
          const dentro = await candidatos('[data-pl-crawl-modal]');
          for (const d of dentro.slice(0, 30)) {
            const claveD = clave + ' » ' + norm(d.sig);
            if (vistos.has(claveD)) continue;
            vistos.add(claveD);
            if (!(await page.evaluate(() => !!document.querySelector('[data-pl-crawl-modal]') && getComputedStyle(document.querySelector('[data-pl-crawl-modal]')).display !== 'none'))) {
              await cerrar(v);
              await abrirMenus();
              const re = await pulsar(c); if (!re.ok) break;
              await page.waitForTimeout(150);
              if (!(await marcarModal())) break;
            }
            ultimo = '[' + v + (hoja ? ' · Hoja' : '') + '] ' + c.sig.slice(0, 80) + ' » ' + d.sig.slice(0, 120);
            const rd = await pulsar(d, '[data-pl-crawl-modal]');
            if (rd.ok) { pulsados++; enVentanas++; }
            await page.waitForTimeout(150);
            await page.evaluate(() => { if (!document.querySelector('[data-pl-crawl-modal]')) return; const abiertas = Array.from(document.querySelectorAll('.modal-bg, body > *')).filter((m) => { const cs = getComputedStyle(m); return cs.display !== 'none' && cs.position === 'fixed' && !m.hasAttribute('data-pl-crawl-modal') && (m.classList.contains('modal-bg') || +cs.zIndex >= 900) && !/^(rnav|toast|sync)/.test(m.id || ''); }); abiertas.forEach((m) => { m.style.display = 'none'; }); });
          }
        }
        await cerrar(v);
      }
    }
  }
  console.log('       pulsados: ' + pulsados + ' (' + enVentanas + ' dentro de ventanas)');
  check('B2 se pulsaron ' + pulsados + ' botones distintos (' + enVentanas + ' dentro de las ventanas que abren) en ' + vistas.length + ' vistas y el piso en modo Hoja, sin ningún error en la página', pulsados > 150 && enVentanas > 20 && !errors.length, errors.slice(0, 12).join(' || '));

  // ── B3: nada se borró ni se duplicó en las cajas ──
  ultimo = '(revisión final)';
  const b3 = await page.evaluate(() => {
    const out = {};
    patients.forEach((p) => {
      const k = pid(p), nd = noteData[k] || {};
      const dup = ['manejo', 'pendientes', 'cronologia', 'app', 'pa'].filter((f) => { const ls = String(nd[f] || '').split('\n').map((x) => x.trim()).filter(Boolean); return new Set(ls).size !== ls.length; });
      out[p._supa_id] = { manejo: nd.manejo, pend: nd.pendientes, app: nd.app, cx: ((nd.checklist || {}).cirugias || []).length, labs: (nd.labHistory || []).length, dup };
    });
    return { out, n: patients.length };
  });
  const o = b3.out;
  check('B3 tras pulsar todo (con «Cancelar» en cada confirmación) siguen los 4 pacientes con sus cajas, cirugías y labs, sin renglones repetidos',
    b3.n === 4 && o.b1 && o.b1.manejo === 'AYUNO\nSOLUCIONES' && o.b1.app === 'HAS DE 10 AÑOS' && o.b1.cx === 1 && o.b1.labs === 2 && o.b2.pend === 'TAC' && Object.values(o).every((x) => !x.dup.length), JSON.stringify(b3));
  check('final: sin errores no capturados', errors.length === 0, errors.slice(0, 5).join(' | '));
  console.log('RESULT APP-BOTONES: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
