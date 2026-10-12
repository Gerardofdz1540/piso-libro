// ════════════════════════════════════════════════════════════════════════
// ris-scraper.js — estudios de imagen (RIS "consultas-pisos", AQUILA) → Supabase
//
// Hallazgos de la corrida de exploración (12 oct 2026, run #1):
//   • Login en /login: #username (_username), #password (_password), botón #_submit.
//   • /common/consultas-pisos: inputs #documento, #dateS (inicial) y #dateSS (final); el botón
//     Buscar hace un POST XHR a la MISMA url con documento=&dateS=…&dateSS=… y recibe JSON
//     { tabConPisos: "<table id=consultas_pisos …>" } con TODOS los estudios del rango (≈1 000
//     en 14 días). DataTables solo pagina en el cliente → leemos la tabla completa del JSON.
//   • Columnas: [ícono reporte] [ícono imagen] Nombre · Nº documento (PAT…) · Edad · Tipo edad ·
//     Fecha llegada · Hora · Sede · Estudios · Modalidad · Procedencia · Caso crítico.
//   • Ícono imagen: <a class="viewer-xen" data-href="/viewer/view?studyUID=…"> (abre el visor;
//     el visor muestra "ID paciente" = expediente del hospital). El ícono impresora solo existe
//     cuando hay reporte.
//
// Flujo: login → POST tabla → cruzar por nombre (+ edad) con el censo → por cada estudio del
// censo: fila en ris_estudios y, si hay ícono de reporte y aún no lo tenemos, bajar/transcribir
// el reporte (PDF → texto con pdf-parse; HTML → texto). Modos: RIS_MODE=scrape|explore.
// Credenciales: env RIS_URL/RIS_USER/RIS_PASS o public.rpa_config (service key).
// ════════════════════════════════════════════════════════════════════════

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";
import ws from "ws";
import fs from "node:fs";
import { patientHeaderMatches, isAllowedEsp, parseCensusAge, normNameTokens } from "./lib.js";

const ENV = (k, def) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : def);
const RIS_MODE = ENV("RIS_MODE", "scrape");
const DRY_RUN = ENV("DRY_RUN", "false") === "true" || process.argv.includes("--dry-run");
const SUPABASE_URL = ENV("SUPABASE_URL", "");
const SUPABASE_SERVICE_KEY = ENV("SUPABASE_SERVICE_KEY", "");
const RIS_LOOKBACK_DAYS = parseInt(ENV("RIS_LOOKBACK_DAYS", "13"), 10); // el portal no permite > 14 días
const RIS_MAX_REPORTES = parseInt(ENV("RIS_MAX_REPORTES", "60"), 10);  // reportes nuevos por corrida
const RIS_AGE_TOLERANCE = parseInt(ENV("RIS_AGE_TOLERANCE", "2"), 10);
const NAV_TIMEOUT_MS = 45000;
const SEL_TIMEOUT_MS = 20000;

function log(...a) { console.log(...a); }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function abs(base, u) { if (!u) return ""; try { return new URL(u, base).toString(); } catch (_) { return ""; } }
function cleanText(s) { return String(s || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim(); }

async function loadConfig(supa) {
  const cfg = { url: ENV("RIS_URL", ""), user: ENV("RIS_USER", ""), pass: ENV("RIS_PASS", "") };
  if (!(cfg.url && cfg.user && cfg.pass)) {
    const { data, error } = await supa.from("rpa_config").select("key,value").in("key", ["RIS_URL", "RIS_USER", "RIS_PASS"]);
    if (error) throw new Error("rpa_config: " + error.message);
    for (const r of data || []) {
      if (r.key === "RIS_URL" && !cfg.url) cfg.url = r.value;
      if (r.key === "RIS_USER" && !cfg.user) cfg.user = r.value;
      if (r.key === "RIS_PASS" && !cfg.pass) cfg.pass = r.value;
    }
  }
  if (!cfg.url || !cfg.user || !cfg.pass) throw new Error("Faltan RIS_URL / RIS_USER / RIS_PASS (env o rpa_config)");
  cfg.base = new URL(cfg.url).origin;
  return cfg;
}

// ── LOGIN ──────────────────────────────────────────────────────────────
async function login(page, cfg) {
  log(`[1/4] Login → ${cfg.url}`);
  await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(1200);
  const pass = page.locator('input[type="password"]').first();
  if (!(await pass.count())) { log("       (sin campo password: sesión ya abierta)"); return; }
  const user = page.locator('#username, input[name="_username"], input[name*="user" i], input[type="text"]').first();
  await user.fill(cfg.user);
  await pass.fill(cfg.pass);
  const submit = page.locator('#_submit, button[type="submit"], input[type="submit"]').first();
  try {
    await Promise.all([page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }), submit.click({ timeout: 5000 })]);
  } catch (e) {
    log(`       (click submit falló: ${String(e.message).split("\n")[0]} → Enter)`);
    await pass.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  if (await page.locator('input[type="password"]').count()) throw new Error("Login fallido: sigue el campo password. Revisa usuario/contraseña.");
  if (!page.url().includes("consultas-pisos")) { await page.goto(cfg.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }); await page.waitForTimeout(1200); }
  log(`       OK login → ${page.url()}`);
}

// ── TABLA COMPLETA por POST (lo que hace el botón Buscar) ─────────────
async function fetchTabla(page, cfg, dateS, dateSS) {
  log(`[2/4] POST consultas-pisos ${dateS} .. ${dateSS}`);
  const res = await page.evaluate(async ({ url, dateS, dateSS }) => {
    const r = await fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/javascript, */*; q=0.01" },
      body: new URLSearchParams({ documento: "", dateS, dateSS }).toString(),
    });
    const ct = r.headers.get("content-type") || "";
    const txt = await r.text();
    let html = "";
    try { const j = JSON.parse(txt); html = j.tabConPisos || j.html || ""; } catch (_) { html = txt; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const table = doc.querySelector("table#consultas_pisos") || doc.querySelector("table");
    if (!table) return { status: r.status, ct, len: txt.length, headers: [], rows: [], sample: txt.slice(0, 300) };
    const headers = Array.from(table.querySelectorAll("thead th")).map((th) => norm(th.textContent));
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => norm(td.textContent));
      const links = Array.from(tr.querySelectorAll("a, button")).map((a) => {
        const cls = (a.className || "").toString();
        const icon = (a.querySelector("span, i") || {}).className || "";
        const kind = /print|impres/i.test(cls + " " + icon) ? "reporte" : (/picture|image|viewer/i.test(cls + " " + icon) ? "imagen" : "otro");
        return { kind, href: a.getAttribute("href"), dataHref: a.getAttribute("data-href"), uid: a.getAttribute("data-uid"), onclick: (a.getAttribute("onclick") || "").slice(0, 200), data: Object.assign({}, a.dataset), html: a.outerHTML.slice(0, 300) };
      });
      return { cells, links };
    });
    return { status: r.status, ct, len: txt.length, headers, rows };
  }, { url: cfg.url, dateS, dateSS });
  log(`       HTTP ${res.status} ${res.ct} (${res.len} bytes) · filas=${res.rows.length} · headers=${JSON.stringify(res.headers)}${res.sample ? " · muestra=" + JSON.stringify(res.sample) : ""}`);
  return res;
}

// ── CRUCE censo ↔ fila ─────────────────────────────────────────────────
function rowToEstudio(r, hdr) {
  const H = hdr.map((h) => h.toUpperCase());
  const col = (re) => H.findIndex((h) => re.test(h));
  const get = (re) => { const i = col(re); return i >= 0 ? (r.cells[i] || "") : ""; };
  return {
    nombre: get(/NOMBRE/), documento: get(/DOCUMENTO/), edad: get(/^EDAD/), tipoEdad: get(/TIPO/),
    fecha: get(/FECHA/), hora: get(/HORA/), sede: get(/SEDE/), estudios: get(/ESTUDIO/), modalidad: get(/MODALIDAD/),
    procedencia: get(/PROCEDENCIA/), critico: /^S[IÍ]/i.test(get(/CR[IÍ]TICO/)),
    linkReporte: r.links.find((l) => l.kind === "reporte") || null,
    linkImagen: r.links.find((l) => l.kind === "imagen") || null,
    links: r.links,
  };
}
// Cruce nombre ↔ censo. Niveles (precisión > recall, con la edad como guarda):
//   A) todos los tokens del censo están en el nombre del RIS (difuso)           → edad compatible o desconocida
//   B) todos los tokens del RIS están en el del censo (el RIS omite un apellido)  → exige edad compatible (ambas conocidas)
//   C) ≥ 3 tokens en común                                                       → exige edad compatible (ambas conocidas)
function _ageOk(p, est) {
  const risAge = /A[ÑN]OS/i.test(est.tipoEdad) ? parseInt(est.edad, 10) : NaN;
  const ca = parseCensusAge(p.edad);
  if (ca == null || isNaN(risAge)) return null; // desconocida
  return Math.abs(ca - risAge) <= RIS_AGE_TOLERANCE;
}
function _commonTokens(a, b) {
  const ta = normNameTokens(a), tb = normNameTokens(b);
  let n = 0; const used = new Set();
  for (const x of ta) { const j = tb.findIndex((y, i) => !used.has(i) && (x === y)); if (j >= 0) { used.add(j); n++; } }
  return n;
}
function matchCenso(est, censo) {
  const scored = [];
  for (const p of censo) {
    const age = _ageOk(p, est);
    if (age === false) continue;
    let level = 0;
    if (patientHeaderMatches(est.nombre, p.nombre)) level = 3;
    else if (age === true && normNameTokens(est.nombre).length >= 2 && patientHeaderMatches(p.nombre, est.nombre)) level = 2;
    else if (age === true && _commonTokens(est.nombre, p.nombre) >= 3) level = 1;
    if (level) scored.push({ p, level, both: patientHeaderMatches(p.nombre, est.nombre) && patientHeaderMatches(est.nombre, p.nombre) });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.both - a.both) || (b.level - a.level));
  return scored[0].p;
}
// Diagnóstico: pacientes del censo sin estudio cuyo nombre se parece a alguna fila (≥ 2 tokens)
function nearMisses(estudios, censo, matchedExps) {
  const out = [];
  for (const p of censo) {
    if (matchedExps.has(p.exp)) continue;
    const near = estudios.filter((e) => _commonTokens(e.nombre, p.nombre) >= 2).slice(0, 3)
      .map((e) => `"${e.nombre}" ${e.edad} ${e.tipoEdad} ${e.fecha} ${e.modalidad}`);
    if (near.length) out.push(`cama ${p.cama} (${p.edad || "?"} a, "${p.nombre}") ≈ ${near.join(" | ")}`);
  }
  return out;
}

// ── REPORTE: bajar y transcribir ────────────────────────────────────────
async function pdfText(buf) {
  try { const parser = new PDFParse({ data: buf }); const r = await parser.getText(); return cleanText(r && r.text); }
  catch (e) { log(`       pdf-parse falló: ${e.message}`); return ""; }
}
async function htmlText(page, html) {
  return page.evaluate((h) => {
    const doc = new DOMParser().parseFromString(h, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
    const pdf = doc.querySelector('iframe[src*=".pdf" i], embed[src*=".pdf" i], object[data*=".pdf" i], iframe[src*="pdf" i]');
    const txt = (doc.body ? doc.body.innerText || doc.body.textContent : doc.documentElement.textContent) || "";
    return { text: txt.replace(/\t/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim(), pdfSrc: pdf ? (pdf.getAttribute("src") || pdf.getAttribute("data")) : null };
  }, html);
}
async function fetchReporte(page, ctx, cfg, est) {
  const link = est.linkReporte;
  if (!link) return { text: "", url: "" };
  const url = abs(cfg.base, link.dataHref || link.href);
  if (url) {
    try {
      const resp = await page.request.get(url, { timeout: 30000 });
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const buf = await resp.body();
      if (/pdf/.test(ct) || buf.slice(0, 5).toString() === "%PDF-") return { text: await pdfText(buf), url, ct };
      const { text, pdfSrc } = await htmlText(page, buf.toString("utf8"));
      if (pdfSrc) {
        const u2 = abs(cfg.base, pdfSrc);
        const r2 = await page.request.get(u2, { timeout: 30000 });
        const b2 = await r2.body();
        if (b2.slice(0, 5).toString() === "%PDF-") return { text: await pdfText(b2), url: u2, ct: "pdf-embebido" };
      }
      if (text.length > 60) return { text: cleanText(text), url, ct };
      log(`       reporte GET ${url} → ${resp.status()} ${ct} texto corto (${text.length}); probando clic`);
    } catch (e) { log(`       reporte GET falló (${String(e.message).split("\n")[0]}); probando clic`); }
  }
  // Sin href utilizable: clic en el ícono (abre popup o descarga)
  try {
    const rowSel = `table#consultas_pisos tbody tr:has(td:has-text("${est.documento}"))`;
    const icon = page.locator(rowSel).first().locator("a, button").filter({ has: page.locator('[class*="print"], [class*="impres"]') }).first();
    if (!(await icon.count())) return { text: "", url: url || "" };
    const popupP = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    const dlP = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    await icon.click({ timeout: 5000 });
    const [popup, dl] = await Promise.all([popupP, dlP]);
    if (dl) { const p = await dl.path(); const buf = fs.readFileSync(p); return { text: await pdfText(buf), url: dl.url(), ct: "download" }; }
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      await popup.waitForTimeout(2500);
      const purl = popup.url();
      let text = await popup.evaluate(() => (document.body && document.body.innerText) || "").catch(() => "");
      if (text.length < 60) {
        // visor de PDF: bajar el documento con la sesión
        const r2 = await page.request.get(purl, { timeout: 30000 }).catch(() => null);
        if (r2) { const b2 = await r2.body(); if (b2.slice(0, 5).toString() === "%PDF-") text = await pdfText(b2); }
      }
      await popup.close().catch(() => {});
      return { text: cleanText(text), url: purl, ct: "popup" };
    }
  } catch (e) { log(`       reporte por clic falló: ${String(e.message).split("\n")[0]}`); }
  return { text: "", url: url || "" };
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
    // Dos ventanas (el portal no acepta más de 14 días por consulta): hoy-13..hoy y hoy-27..hoy-14.
    // Los pacientes de piso llevan semanas internados y sus estudios de ingreso quedaban fuera.
    const w1 = await fetchTabla(page, cfg, iso(daysAgo(RIS_LOOKBACK_DAYS)), iso(new Date()));
    if (!w1.rows.length) throw new Error("La tabla llegó vacía (¿cambió el portal o la sesión?)");
    const w2 = await fetchTabla(page, cfg, iso(daysAgo(2 * RIS_LOOKBACK_DAYS + 1)), iso(daysAgo(RIS_LOOKBACK_DAYS + 1))).catch((e) => { log("       ventana 2 falló: " + e.message); return { rows: [] }; });
    const tabla = { headers: w1.headers, rows: w1.rows.concat(w2.rows) };
    const estudios = tabla.rows.map((r) => rowToEstudio(r, tabla.headers));
    const conReporte = estudios.filter((e) => e.linkReporte);
    log(`       estudios en el rango: ${estudios.length} · con ícono de reporte: ${conReporte.length}`);

    if (RIS_MODE === "explore") {
      log(`[EXPL] 3 filas con reporte: ${JSON.stringify(conReporte.slice(0, 3).map((e) => ({ doc: e.documento, fecha: e.fecha, mod: e.modalidad, links: e.links })))}`);
      log(`[EXPL] tipos de enlace: ${JSON.stringify(estudios.flatMap((e) => e.links.map((l) => l.kind + ":" + (l.html.match(/class=\\"[^\\"]*\\"/) || [""])[0])).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}))}`);
      if (conReporte.length) {
        const e = conReporte[0];
        const rep = await fetchReporte(page, ctx, cfg, e);
        log(`[EXPL reporte] doc=${e.documento} url=${rep.url} ct=${rep.ct || ""} chars=${rep.text.length} texto=${JSON.stringify(rep.text.slice(0, 1200))}`);
      }
      fs.writeFileSync(`ris-explorer-${Date.now()}.json`, JSON.stringify({ headers: tabla.headers, sample: estudios.slice(0, 20) }, null, 2));
      log(`DONE explore · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await browser.close(); process.exit(0);
    }

    // ── SCRAPE ──
    const { data: censoRaw, error } = await supa.from("patients").select("id,exp,nombre,cama,esp,edad");
    if (error) throw new Error("censo: " + error.message);
    const censo = (censoRaw || []).filter((p) => isAllowedEsp(p.esp) && p.nombre);
    const matched = [];
    for (const e of estudios) { const p = matchCenso(e, censo); if (p) matched.push({ e, p }); }
    const pacientes = new Set(matched.map((m) => m.p.exp));
    log(`[3/4] cruce por nombre: ${matched.length} estudios de ${pacientes.size} pacientes del censo (censo: ${censo.length})`);
    const nm = nearMisses(estudios, censo, pacientes);
    if (nm.length) log(`       casi-coincidencias sin cruzar (revisar nombre/edad):\n       ` + nm.join("\n       "));

    // Reportes que ya tenemos (no volver a bajarlos)
    const docs = Array.from(new Set(matched.map((m) => m.e.documento).filter(Boolean)));
    const have = new Set();
    if (docs.length) {
      const { data: prev } = await supa.from("ris_estudios").select("documento,fecha,hora,modalidad,reporte").in("documento", docs);
      (prev || []).forEach((r) => { if (r.reporte && r.reporte.length > 20) have.add([r.documento, r.fecha, r.hora, r.modalidad].join("|")); });
    }
    let bajados = 0, fallidos = 0;
    const payload = [];
    for (const { e, p } of matched) {
      const key = [e.documento, e.fecha, e.hora, e.modalidad].join("|");
      const row = {
        exp: p.exp, paciente: e.nombre, documento: e.documento, fecha: e.fecha, hora: e.hora, sede: e.sede, estudios: e.estudios,
        modalidad: e.modalidad, procedencia: e.procedencia, critico: e.critico,
        reporte_url: e.linkReporte ? abs(cfg.base, e.linkReporte.dataHref || e.linkReporte.href) : null,
        imagen_url: e.linkImagen ? abs(cfg.base, e.linkImagen.dataHref || e.linkImagen.href) : null,
        links: e.links.map((l) => ({ kind: l.kind, href: l.href, dataHref: l.dataHref, uid: l.uid })),
        scraped_at: new Date().toISOString(),
      };
      if (e.linkReporte && !have.has(key) && bajados + fallidos < RIS_MAX_REPORTES) {
        const rep = await fetchReporte(page, ctx, cfg, e);
        if (rep.text && rep.text.length > 20) { row.reporte = rep.text; row.reporte_url = rep.url || row.reporte_url; bajados++; log(`       reporte ✓ cama ${p.cama} ${e.modalidad} ${e.fecha} (${rep.text.length} letras, ${rep.ct || ""})`); }
        else { fallidos++; log(`       reporte ✗ cama ${p.cama} ${e.modalidad} ${e.fecha} (${rep.url || "sin url"})`); }
      }
      payload.push(row);
    }
    log(`[4/4] reportes nuevos: ${bajados} · fallidos: ${fallidos} · ya guardados: ${have.size}`);
    if (!DRY_RUN && payload.length) {
      // No pisar un reporte ya guardado con null: las filas sin reporte se mandan sin la columna
      const withRep = payload.filter((r) => r.reporte), noRep = payload.filter((r) => !r.reporte).map((r) => { const c = { ...r }; delete c.reporte; return c; });
      for (const batch of [withRep, noRep]) {
        if (!batch.length) continue;
        const { error: upErr } = await supa.from("ris_estudios").upsert(batch, { onConflict: "documento,fecha,hora,modalidad" });
        if (upErr) throw new Error("upsert ris_estudios: " + upErr.message);
      }
      log(`       upsert ${payload.length} filas (${withRep.length} con reporte)`);
    } else if (DRY_RUN) {
      log(`[dry-run] no se escribe. Muestra: ${JSON.stringify(payload.slice(0, 3).map((r) => ({ cama: matched.find((m) => m.p.exp === r.exp)?.p.cama, fecha: r.fecha, mod: r.modalidad, est: r.estudios, rep: (r.reporte || "").slice(0, 200) })))}`);
    }
    log(`DONE. Estudios del censo: ${payload.length} (${pacientes.size} pacientes) · reportes nuevos ${bajados} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await browser.close(); process.exit(0);
  } catch (err) {
    console.error("[FATAL]", err.message);
    try { const shot = `ris-failure-${Date.now()}.png`; await page.screenshot({ path: shot, fullPage: true }); console.error("Screenshot: " + shot); } catch (_) {}
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
