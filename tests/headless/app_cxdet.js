// 🔎 Cirugía marcada en otra caja (28 oct 2026). Pacientes ficticios.
// · Si el DX («PO LAPE 26/10»), la Cronología («pasa a quirófano para…») o la fecha POP dicen que hubo una cirugía que no
//   está en la caja Cirugías, la caja lo avisa en un renglón discreto. Nada se escribe solo.
// · «➕ Registrar» la agrega (con fecha y procedimiento limpios; ↩ Regresar la quita); «✕» deja de avisar (se guarda en
//   la nota para todos los iPads).
// · No avisa lo planeado («programada», «pendiente», «mañana»), los antecedentes ni lo que ya está en la caja (mismo día).
// node tests/headless/app_cxdet.js   (ver run_all.sh)
const { launch } = require('./_browser');
const BASE_URL = process.env.PL_BASE_URL || 'http://127.0.0.1:8771';
const MOCK = `(() => {
  try{ navigator.serviceWorker.register=function(){ return Promise.resolve({}); }; }catch(_){}
  const KEY='__mock_session'; const listeners=[];
  sessionStorage.setItem(KEY, JSON.stringify({ access_token:'mock-token-123', refresh_token:'r', user:{ email:'t@t.t' } }));
  localStorage.setItem('pl_user_name', 'Tester');
  window.prompt=function(){ return null; }; window.alert=function(){}; window.confirm=function(){ return true; };
  const auth={ getSession: async()=>({ data:{ session: JSON.parse(sessionStorage.getItem(KEY)) }, error:null }), onAuthStateChange: (cb)=>{ listeners.push(cb); return { data:{ subscription:{ unsubscribe(){} } } }; }, refreshSession: async()=>({ data:{ session:null }, error:{ message:'no' } }), signInWithPassword: async()=>({ data:{}, error:{ message:'n/a' } }), signOut: async()=>({ error:null }) };
  const chan={ on(){ return chan; }, subscribe(){ return chan; }, unsubscribe(){ return Promise.resolve('ok'); }, send(){ return Promise.resolve('ok'); } };
  window.supabase={ createClient:()=>({ auth, channel:()=>chan, removeChannel:()=>Promise.resolve('ok'), removeAllChannels:()=>Promise.resolve([]), getChannels:()=>[], storage:{ from:()=>({}) } }) };
})();`;
const PTS = [
  { id: 'x1', cama: '3-401', exp: '26-70001', nombre: 'PEDRO SALAS VIDAL', esp: 'CG', edad: '45', dx: 'OCLUSION INTESTINAL', ingreso: '' },
  { id: 'x2', cama: '3-402', exp: '26-70002', nombre: 'LAURA NUNEZ GIL', esp: 'CG', edad: '58', dx: 'COLECISTITIS AGUDA', ingreso: '' },
];
(async () => {
  const browser = await launch(); const page = await browser.newPage({ viewport: { width: 1194, height: 834 } });
  const errors = []; page.on('pageerror', e => errors.push(String((e && e.stack) || e).slice(0, 300)));
  const posts = [];
  await page.route('**/vendor/supabase*', r => r.abort());
  await page.route('**/rest/v1/**', async (route) => {
    const req = route.request(); const url = req.url().replace(/^https?:\/\/[^/]+/, ''); const m = req.method();
    const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
    if (url.startsWith('/rest/v1/patients') && m === 'GET') return json(200, PTS);
    if (url.startsWith('/rest/v1/notes') && m !== 'GET') { posts.push(req.postData() || ''); return json(201, [{}]); }
    return json(200, []);
  });
  await page.addInitScript(MOCK);
  let pass = 0, fail = 0; const check = (n, c, x) => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.log('FAIL ' + n + (x ? ' :: ' + String(x).slice(0, 900) : '')); } };
  await page.goto(BASE_URL + '/index.html', { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => typeof patients !== 'undefined' && patients.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(1200);

  // Ayudante: pone DX, ingreso, Cronología y cirugías (fechas relativas a hoy) al paciente 0 y repinta su tarjeta.
  await page.evaluate(() => {
    const iso = (d) => { const t = new Date(); t.setDate(t.getDate() - d); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
    const dm = (d) => { const s = iso(d); return s.slice(8, 10) + '/' + s.slice(5, 7); };
    window.__iso = iso; window.__dm = dm;
    window.__pon = function (o) {
      const p = patients[0], k = pid(p);
      p.dx = o.dx || ''; p.ingreso = fmtDateFromISO(iso(o.ing != null ? o.ing : 6));
      const nd = defaultData(); nd.cronologia = o.crono || '';
      nd.checklist.cirugias = (o.cx || []).map((c, i) => ({ id: 'cx' + i, fecha: c[0] == null ? '' : iso(c[0]), procedimiento: c[1], hallazgos: '', sangrado: '', cirujano: '' }));
      if (o.qx != null) nd.checklist.qx_fecha = iso(o.qx);
      if (o.no) nd.checklist.cx_det_no = o.no;
      noteData[k] = nd;
      if (!document.getElementById('card-' + k)) { try { window.__focusPid = k; } catch (_) {} try { render(); } catch (_) {} }
      _rerenderCard(k);
      return k;
    };
    window.__det = function () {
      const k = pid(patients[0]), card = document.getElementById('card-' + k);
      const rows = card ? Array.from(card.querySelectorAll('[data-testid="cx-det"]')) : [];
      return { hayCard: !!card, n: rows.length, txt: rows.map(r => r.querySelector('.cx-det-t').textContent.trim()), keys: rows.map(r => r.querySelector('[data-testid="cx-det-add"]').dataset.key),
        cx: JSON.parse(JSON.stringify((noteData[k].checklist || {}).cirugias || [])), no: (noteData[k].checklist || {}).cx_det_no || null };
    };
  });
  const pon = (o) => page.evaluate((o) => window.__pon(o), o);
  const det = () => page.evaluate(() => window.__det());
  const dm = (d) => page.evaluate((d) => window.__dm(d), d);
  const iso = (d) => page.evaluate((d) => window.__iso(d), d);

  // X1 — DX con «PO LAPE dd/mm» y caja vacía: un renglón discreto; nada escrito.
  const f2 = await dm(2), i2 = await iso(2);
  await pon({ dx: 'PO LAPE ' + f2 + ' + ABSCESO RESIDUAL' });
  const postsAntes = posts.length;
  let r = await det();
  check('X1 DX «PO LAPE ' + f2 + '» sin cirugía en la caja: un aviso discreto «¿Cirugía sin registrar? DX: …» con su fecha',
    r.hayCard && r.n === 1 && /¿Cirugía sin registrar\? DX: «PO LAPE/.test(r.txt[0]) && r.cx.length === 0, JSON.stringify(r));
  await page.waitForTimeout(700);
  check('X2 el aviso NO escribe nada: la caja sigue vacía y no se sube ninguna nota por mostrarlo', (await det()).cx.length === 0 && posts.length === postsAntes, JSON.stringify({ antes: postsAntes, despues: posts.length }));

  // X3 — ➕ Registrar: agrega la cirugía con fecha y procedimiento limpio; el aviso se va; ↩ Regresar la quita.
  await page.click('[data-testid="cx-det-add"]');
  await page.waitForTimeout(400);
  r = await det();
  check('X3 ➕ Registrar agrega {fecha ' + i2 + ', «LAPE»} y el aviso desaparece', r.n === 0 && r.cx.length === 1 && r.cx[0].fecha === i2 && r.cx[0].procedimiento === 'LAPE', JSON.stringify(r));
  await page.waitForTimeout(900);
  check('X3b la nota con la cirugía nueva se sube (sync normal)', posts.slice(postsAntes).some(b => /LAPE/.test(b) && /cirugias/.test(b)), posts.slice(postsAntes).map(b => b.slice(0, 200)).join(' || '));
  const etiqueta = await page.evaluate(() => undoLast(pid(patients[0])));
  r = await det();
  check('X4 ↩ Regresar quita la cirugía registrada y el aviso vuelve', /registrar cirugía de DX/.test(etiqueta) && r.cx.length === 0 && r.n === 1, JSON.stringify({ etiqueta, r }));

  // X5 — ✕: deja de avisar (se guarda en la nota) y sigue así al repintar.
  const key = r.keys[0];
  await page.click('[data-testid="cx-det-no"]');
  await page.waitForTimeout(300);
  r = await det();
  check('X5 ✕ oculta el aviso y lo guarda en la nota (cx_det_no) sin tocar la caja', r.n === 0 && r.cx.length === 0 && Array.isArray(r.no) && r.no.indexOf(key) >= 0, JSON.stringify(r));
  await pon({ dx: 'PO LAPE ' + f2 + ' + ABSCESO RESIDUAL', no: [key] });
  check('X5b al repintar (o en otro iPad con la misma nota) sigue oculto', (await det()).n === 0);

  // X6 — Cronología: «pasa a quirófano para colecistectomía»; con la caja del mismo día ya no avisa.
  const f1 = await dm(1);
  await pon({ crono: f1 + ' 14:00 R3: PASA A QUIRÓFANO PARA COLECISTECTOMÍA LAPAROSCÓPICA\n' + f1 + ' 20:00 R1: SE REALIZA CURACIÓN DE HERIDA' });
  r = await det();
  check('X6 Cronología «pasa a quirófano para colecistectomía»: un aviso (la curación no cuenta)', r.n === 1 && /Cronología: «/.test(r.txt[0]), JSON.stringify(r));
  await page.click('[data-testid="cx-det-add"]'); await page.waitForTimeout(300);
  r = await det();
  check('X6b ➕ Registrar desde la Cronología: el procedimiento queda sin la hora, el autor ni «pasa a quirófano para»',
    r.cx.length === 1 && r.cx[0].procedimiento === 'COLECISTECTOMÍA LAPAROSCÓPICA' && r.cx[0].fecha === (await iso(1)) && r.n === 0, JSON.stringify(r.cx));
  await pon({ crono: f1 + ' 14:00 R3: PASA A QUIRÓFANO PARA COLECISTECTOMÍA LAPAROSCÓPICA', cx: [[1, 'COLECISTECTOMÍA LAP']] });
  check('X7 ya está en la caja (mismo día y grupo): no avisa', (await det()).n === 0);
  await pon({ dx: 'PO LAPE ' + f2, cx: [[2, 'CIRUGÍA DE URGENCIA']] });
  check('X7b un procedimiento sin grupo reconocido el mismo día también cuenta como registrado', (await det()).n === 0);
  await pon({ dx: 'OCLUSION INTESTINAL. PO LAPE + RESECCION INTESTINAL', cx: [[2, 'RESECCIÓN INTESTINAL + ENTEROENTEROANASTOMOSIS']] });
  check('X7c «PO LAPE + RESECCIÓN INTESTINAL» con la resección en la caja: la LAPE es su abordaje, no avisa', (await det()).n === 0);

  // X8 — No avisa lo planeado, los antecedentes ni fechas de antes del ingreso.
  await pon({ dx: 'COLECISTITIS, PROGRAMADA PARA COLECISTECTOMÍA + ANTECEDENTE DE PO APENDICECTOMÍA + PO HERNIOPLASTIA 02/01/2019', crono: f1 + ' 09:00 R2: PENDIENTE PASA A QUIRÓFANO MAÑANA PARA LAPE' });
  r = await det();
  check('X8 «programada», «antecedente de…», una fecha de 2019 y «pendiente… mañana» no generan aviso', r.n === 0, JSON.stringify(r));

  // X9 — Fecha de cirugía (POP) sin ninguna cirugía en la lista.
  await pon({ qx: 3 });
  r = await det();
  check('X9 fecha POP sin cirugías: «Fecha de cirugía»; ➕ la agrega con esa fecha y el procedimiento vacío para escribirlo', r.n === 1 && /Fecha de cirugía/.test(r.txt[0]), JSON.stringify(r));
  await page.click('[data-testid="cx-det-add"]'); await page.waitForTimeout(300);
  r = await det();
  check('X9b registrada con la fecha POP', r.cx.length === 1 && r.cx[0].fecha === (await iso(3)) && r.cx[0].procedimiento === '' && r.n === 0, JSON.stringify(r.cx));

  // X9c — DX sin fecha, caja vacía y fecha POP ya descartada: al registrar toma la fecha POP (no la borra).
  const kPop = await pon({ dx: 'POP COLECISTECTOMÍA', qx: 2 });
  r = await det();
  const kq = r.keys.find(x => /^Fecha de cirugía/.test(x));
  await pon({ dx: 'POP COLECISTECTOMÍA', qx: 2, no: [kq] });
  r = await det();
  check('X9c con la fecha POP descartada queda el aviso del DX (sin fecha)', r.n === 1 && /DX: «POP COLECISTECTOMÍA»/.test(r.txt[0]), JSON.stringify(r));
  await page.click('[data-testid="cx-det-add"]'); await page.waitForTimeout(300);
  const qxDespues = await page.evaluate((k) => noteData[k].checklist.qx_fecha, kPop);
  r = await det();
  check('X9d al registrarla toma la fecha POP de la tarjeta y la fecha POP no se borra', r.cx.length === 1 && r.cx[0].fecha === i2 && r.cx[0].procedimiento === 'COLECISTECTOMÍA' && qxDespues === i2, JSON.stringify({ cx: r.cx, qxDespues }));

  // X10 — Máximo 3 avisos y el renglón no se imprime.
  await pon({ dx: 'PO LAPE ' + f2 + ' + PO TRAQUEOSTOMÍA ' + f1, crono: (await dm(4)) + ' 10:00 R2: PASA A QUIRÓFANO PARA TORACOTOMÍA\n' + (await dm(5)) + ' 10:00 R2: SE REALIZA AMPUTACIÓN SUPRACONDÍLEA' });
  r = await det();
  const print = await page.evaluate(() => { const s = Array.from(document.styleSheets).flatMap(ss => { try { return Array.from(ss.cssRules); } catch (_) { return []; } }); return s.some(x => x.media && /print/.test(x.media.mediaText) && /cx-det-box/.test(x.cssText)); });
  check('X10 cuatro cirugías marcadas en otras cajas: se muestran 3 como máximo; en papel no salen', r.n === 3 && print, JSON.stringify({ n: r.n, print }));

  check('X11 sin errores de página', errors.length === 0, errors.join(' | '));
  console.log('RESULT CXDET: ' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
