// ════════════════════════════════════════════════════════════════════════
// ris-scraper.js — estudios de imagen (RIS "consultas-pisos") → Supabase
//
// Igual que el scraper de WinLab pero para el visor radiológico del hospital:
//   login → consultas-pisos → rango de fechas (≤ 14 días) → Buscar → tabla con
//   TODOS los estudios del rango → cruzar por nombre con el censo → para cada
//   estudio del censo: guardar fecha/hora/modalidad/estudio y, si hay reporte,
//   el texto transcrito (ícono impresora). Tabla destino: public.ris_estudios.
//
// Modos (env RIS_MODE):
//   explore  — solo navega y vuelca la estructura de la página (inputs, botones,
//              selects, peticiones XHR, cabeceras y primeras filas de la tabla,
//              enlaces de los íconos). Para construir/ajustar el parser.
//   scrape   — corrida normal (default).
//
// Credenciales: env RIS_URL/RIS_USER/RIS_PASS o, si faltan, la tabla public.rpa_config
// (claves RIS_URL, RIS_USER, RIS_PASS) leída con la service key de Supabase.
// ════════════════════════════════════════════════════════════════════════

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "node:fs";
import { patientHeaderMatches, isAllowedEsp, normNameTokens } from "./lib.js";

const ENV = (k, def) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : def);
const RIS_MODE = ENV("RIS_MODE", "scrape");
const DRY_RUN = ENV("DRY_RUN", "false") === "true" || process.argv.includes("--dry-run");
const SUPABASE_URL = ENV("SUPABASE_URL", "");
const SUPABASE_SERVICE_KEY = ENV("SUPABASE_SERVICE_KEY", "");
const RIS_LOOKBACK_DAYS = parseInt(ENV("RIS_LOOKBACK_DAYS", "13"), 10); // el portal no permite > 14 días
const NAV_TIMEOUT_MS = 45000;
const SEL_TIMEOUT_MS = 20000;

function log(...a) { console.log(...a); }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

async function loadConfig(supa) {
  const cfg = { url: ENV("RIS_URL", ""), user: ENV("RIS_USER", ""), pass: ENV("RIS_PASS", "") };
  if (cfg.url && cfg.user && cfg.pass) return cfg;
  const { data, error } = await supa.from("rpa_config").select("key,value").in("key", ["RIS_URL", "RIS_USER", "RIS_PASS"]);
  if (error) throw new Error("rpa_config: " + error.message);
  for (const r of data || []) {
    if (r.key === "RIS_URL" && !cfg.url) cfg.url = r.value;
    if (r.key === "RIS_USER" && !cfg.user) cfg.user = r.value;
    if (r.key === "RIS_PASS" && !cfg.pass) cfg.pass = r.value;
  }
  if (!cfg.url || !cfg.user || !cfg.pass) throw new Error("Faltan RIS_URL / RIS_USER / RIS_PASS (env o rpa_config)");
  return cfg;
}

async function dumpForms(page, tag) {
  const d = await page.evaluate(() => {
    const vis = (e) => !!(e.offsetParent || e.getClientRects().length);
    const inputs = Array.from(document.querySelectorAll("input, textarea")).map((i) => ({ id: i.id || null, name: i.name || null, type: i.type || null, ph: i.placeholder || null, value: (i.value || "").slice(0, 40), visible: vis(i) }));
    const selects = Array.from(document.querySelectorAll("select")).map((s) => ({ id: s.id || null, name: s.name || null, visible: vis(s), options: Array.from(s.options).slice(0, 12).map((o) => o.value + ":" + o.text.trim()) }));
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn')).map((b) => ({ tag: b.tagName.toLowerCase(), id: b.id || null, cls: (b.className || "").toString().slice(0, 60), type: b.type || null, text: (b.innerText || b.value || "").trim().slice(0, 40), visible: vis(b) }));
    return { url: location.href, title: document.title, inputs, selects, buttons };
  });
  log(`[EXPL ${tag}] url=${d.url} title=${d.title}`);
  log(`[EXPL ${tag}] inputs(${d.inputs.length}): ${JSON.stringify(d.inputs)}`);
  log(`[EXPL ${tag}] selects(${d.selects.length}): ${JSON.stringify(d.selects)}`);
  log(`[EXPL ${tag}] buttons(${d.buttons.length}): ${JSON.stringify(d.buttons.filter((b) => b.visible).slice(0, 40))}`);
  return d;
}

// ── LOGIN (heurístico: campo password + el campo de texto anterior) ────
async function login(page, cfg) {
  log(`[1/4] Login → ${cfg.url}`);
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(1500);
  await dumpForms(page, "login");
  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.count())) { log("       (no hay campo password: ¿ya logueado?)"); return; }
  const userSel = ENV("RIS_USER_SELECTOR", 'input[name*="user" i], input[id*="user" i], input[name*="login" i], input[id*="login" i], input[name*="email" i], input[type="text"]');
  const user = page.locator(userSel).first();
  await user.fill(cfg.user);
  await pass.fill(cfg.pass);
  const submitSel = ENV("RIS_SUBMIT_SELECTOR", 'button[type="submit"], input[type="submit"], button:has-text("Ingresar"), button:has-text("Iniciar"), button:has-text("Login"), button:has-text("Entrar")');
  const submit = page.locator(submitSel).first();
  try {
    await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }), submit.click({ timeout: 5000 })]);
  } catch (e) {
    log(`       (click submit falló: ${String(e.message).split("\n")[0]} → Enter)`);
    await pass.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  }
  await page.waitForTimeout(2500);
  if (await page.locator('input[type="password"]').count()) {
    await dumpForms(page, "post-login");
    throw new Error("Login fallido: sigue el campo password. Revisa usuario/contraseña o selectores.");
  }
  log(`       OK login → ${page.url()}`);
}

// ── BÚSQUEDA: rango de fechas + Buscar; registra XHR para encontrar la API ──
async function buscar(page, cfg) {
  if (!page.url().includes("consultas-pisos")) {
    await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(1500);
  }
  const forms = await dumpForms(page, "consultas");
  const desde = iso(daysAgo(RIS_LOOKBACK_DAYS)), hasta = iso(new Date());
  // Inputs de fecha: los que ya traen AAAA-MM-DD, o type=date, o name/id con "fecha/date"
  const dateSel = 'input[type="date"], input[value*="20"], input[name*="fecha" i], input[id*="fecha" i], input[name*="date" i], input[id*="date" i]';
  const dates = page.locator(dateSel);
  const nDates = await dates.count();
  log(`       campos de fecha encontrados: ${nDates} → ${desde} .. ${hasta}`);
  const xhr = [];
  const onResp = async (resp) => {
    try {
      const req = resp.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;
      const ct = resp.headers()["content-type"] || "";
      let body = "";
      if (/json|text/i.test(ct)) { try { body = (await resp.text()).slice(0, 600); } catch (_) {} }
      xhr.push({ m: req.method(), url: resp.url().slice(0, 300), st: resp.status(), ct: ct.slice(0, 60), post: (req.postData() || "").slice(0, 300), body });
    } catch (_) {}
  };
  page.on("response", onResp);
  if (nDates >= 2) {
    for (const [i, v] of [[0, desde], [1, hasta]]) {
      const el = dates.nth(i);
      try { await el.fill(""); await el.fill(v); await el.dispatchEvent("change"); } catch (e) { log(`       fecha[${i}] fill falló: ${String(e.message).split("\n")[0]}`); await el.evaluate((n, val) => { n.value = val; n.dispatchEvent(new Event("input", { bubbles: true })); n.dispatchEvent(new Event("change", { bubbles: true })); }, v); }
    }
  }
  const btn = page.locator('button:has-text("Buscar"), a:has-text("Buscar"), input[value*="Buscar" i]').first();
  if (await btn.count()) { await btn.click({ timeout: 5000 }).catch((e) => log("       click Buscar falló: " + e.message.split("\n")[0])); }
  else log("       (no encontré botón Buscar)");
  await page.waitForTimeout(6000);
  // "Show N entries" → el máximo disponible
  const lenSel = page.locator('select[name$="_length"], select[name*="length" i]').first();
  if (await lenSel.count()) {
    const opts = await lenSel.evaluate((s) => Array.from(s.options).map((o) => o.value));
    const pick = opts.includes("-1") ? "-1" : opts.map(Number).filter((n) => n > 0).sort((a, b) => b - a)[0];
    if (pick !== undefined) { await lenSel.selectOption(String(pick)).catch(() => {}); log(`       Show entries → ${pick}`); await page.waitForTimeout(4000); }
  }
  page.off("response", onResp);
  log(`[EXPL xhr] ${xhr.length} peticiones: ${JSON.stringify(xhr.slice(0, 15))}`);
  return { forms, xhr };
}

// ── TABLA: cabeceras + filas + enlaces de los íconos ──────────────────
async function leerTabla(page) {
  const t = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, bestRows = 0;
    for (const tb of tables) { const n = tb.querySelectorAll("tbody tr").length; if (n > bestRows) { best = tb; bestRows = n; } }
    if (!best) return { headers: [], rows: [], info: "" };
    const headers = Array.from(best.querySelectorAll("thead tr")).map((tr) => Array.from(tr.querySelectorAll("th")).map((th) => norm(th.innerText)));
    const rows = Array.from(best.querySelectorAll("tbody tr")).map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => norm(td.innerText));
      const links = Array.from(tr.querySelectorAll("a, button")).map((a) => ({ tag: a.tagName.toLowerCase(), href: a.getAttribute("href"), onclick: (a.getAttribute("onclick") || "").slice(0, 200), cls: (a.className || "").toString().slice(0, 80), title: a.getAttribute("title") || a.getAttribute("data-original-title") || "", data: Object.assign({}, a.dataset), html: a.outerHTML.slice(0, 260) }));
      return { cells, links };
    });
    const info = norm((document.querySelector(".dataTables_info") || {}).innerText || "");
    return { headers, rows, info, nTables: tables.length };
  });
  log(`[tabla] ${t.nTables} tablas · filas=${t.rows.length} · info="${t.info}" · headers=${JSON.stringify(t.headers)}`);
  return t;
}

// ── MATCH censo ↔ fila RIS (nombre) ────────────────────────────────────
function matchCenso(nombreRis, censo) {
  let best = null;
  for (const p of censo) {
    if (patientHeaderMatches(nombreRis, p.nombre)) { best = p; break; }
  }
  return best;
}

(async () => {
  const t0 = Date.now();
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });
  const cfg = await loadConfig(supa);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: "es-MX", timezoneId: "America/Mexico_City", acceptDownloads: true, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(SEL_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  try {
    await login(page, cfg);
    const { xhr } = await buscar(page, cfg);
    const tabla = await leerTabla(page);
    if (RIS_MODE === "explore") {
      log(`[EXPL filas] primeras 3: ${JSON.stringify(tabla.rows.slice(0, 3))}`);
      // Probar el ícono de reporte (impresora) de la primera fila: ¿abre popup, descarga o navega?
      const first = page.locator("table tbody tr").first();
      const icons = first.locator("a, button");
      const n = await icons.count();
      log(`[EXPL iconos] ${n} en la primera fila`);
      for (let i = 0; i < Math.min(n, 2); i++) {
        const popupP = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
        const dlP = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
        const before = page.url();
        await icons.nth(i).click({ timeout: 5000 }).catch((e) => log(`       icono[${i}] click falló: ${e.message.split("\n")[0]}`));
        const [popup, dl] = await Promise.all([popupP, dlP]);
        await page.waitForTimeout(3000);
        if (popup) {
          await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          const txt = await popup.evaluate(() => (document.body && document.body.innerText || "").slice(0, 1500)).catch(() => "");
          log(`[EXPL icono ${i}] POPUP url=${popup.url()} title=${await popup.title().catch(() => "")} texto=${JSON.stringify(txt)}`);
          const frames = popup.frames().map((f) => f.url()).slice(0, 5);
          log(`[EXPL icono ${i}] frames=${JSON.stringify(frames)}`);
          await popup.close().catch(() => {});
        } else if (dl) {
          log(`[EXPL icono ${i}] DOWNLOAD ${dl.suggestedFilename()} url=${dl.url()}`);
        } else {
          const after = page.url();
          const modal = await page.evaluate(() => { const m = document.querySelector(".modal.show, .modal.in, [role=dialog]"); return m ? (m.innerText || "").slice(0, 1500) : ""; });
          log(`[EXPL icono ${i}] sin popup/descarga · url ${before === after ? "igual" : "→ " + after} · modal=${JSON.stringify(modal)}`);
          if (before !== after) { await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await page.waitForTimeout(2000); }
        }
      }
      fs.writeFileSync(`ris-explorer-${Date.now()}.json`, JSON.stringify({ xhr, tabla }, null, 2));
      log(`DONE explore · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await browser.close();
      process.exit(0);
    }
    // ── SCRAPE: cruzar con censo y guardar ──
    const { data: censoRaw, error } = await supa.from("patients").select("id,exp,nombre,cama,esp");
    if (error) throw new Error("censo: " + error.message);
    const censo = (censoRaw || []).filter((p) => isAllowedEsp(p.esp));
    const hdr = (tabla.headers[0] || []).map((h) => h.toUpperCase());
    const col = (re) => hdr.findIndex((h) => re.test(h));
    const iNombre = col(/NOMBRE/), iDoc = col(/DOCUMENTO/), iFecha = col(/FECHA/), iHora = col(/HORA/), iSede = col(/SEDE/), iEst = col(/ESTUDIO/), iMod = col(/MODALIDAD/), iProc = col(/PROCEDENCIA/), iCrit = col(/CR[IÍ]TICO/);
    const rows = [];
    for (const r of tabla.rows) {
      const nombre = r.cells[iNombre] || "";
      if (!nombre) continue;
      const p = matchCenso(nombre, censo);
      if (!p) continue;
      rows.push({
        exp: p.exp, paciente: nombre, documento: r.cells[iDoc] || "", fecha: r.cells[iFecha] || "", hora: r.cells[iHora] || "",
        sede: r.cells[iSede] || "", estudios: r.cells[iEst] || "", modalidad: r.cells[iMod] || "", procedencia: r.cells[iProc] || "", critico: /S[IÍ]/i.test(r.cells[iCrit] || ""),
        links: r.links, scraped_at: new Date().toISOString(),
      });
    }
    log(`[match] ${rows.length} estudios del censo (de ${tabla.rows.length} en el rango) · pacientes del censo: ${censo.length}`);
    // TODO (tras explore): abrir ícono de reporte y extraer texto; upsert a ris_estudios.
    if (!DRY_RUN) {
      const payload = rows.map((r) => ({ exp: r.exp, paciente: r.paciente, documento: r.documento, fecha: r.fecha, hora: r.hora, sede: r.sede, estudios: r.estudios, modalidad: r.modalidad, procedencia: r.procedencia, critico: r.critico, links: r.links, scraped_at: r.scraped_at }));
      if (payload.length) {
        const { error: upErr } = await supa.from("ris_estudios").upsert(payload, { onConflict: "documento,fecha,hora,modalidad" });
        if (upErr) throw new Error("upsert ris_estudios: " + upErr.message);
        log(`[upsert] ${payload.length} filas`);
      }
    }
    log(`DONE. Estudios del censo: ${rows.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("[FATAL]", err.message);
    try { const shot = `ris-failure-${Date.now()}.png`; await page.screenshot({ path: shot, fullPage: true }); console.error("Screenshot: " + shot); } catch (_) {}
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
