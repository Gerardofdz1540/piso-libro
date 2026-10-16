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
// Flujo: login → censo ACTUAL (tabla patients, todas las especialidades) → POST tabla por ventanas
// de 14 días hasta el ingreso más antiguo del censo → cruzar por nombre (+ edad) con el censo →
// por cada estudio del censo: fila en ris_estudios y, si hay ícono de reporte y aún no lo tenemos,
// bajar/transcribir el reporte (PDF → texto con pdf-parse; HTML → texto). Un reporte que no se
// pudo bajar queda 'pendiente_descarga' (con motivo en el log) y se reintenta en la siguiente
// corrida; uno sin ícono queda 'pendiente_ris' hasta que el RIS lo transcriba.
// Modos: RIS_MODE=scrape|explore. Credenciales: env RIS_URL/RIS_USER/RIS_PASS o public.rpa_config.
// La lógica pura (cruce, ventanas, estados) vive en ris-lib.js y se prueba con `node ris.test.js`.
// ════════════════════════════════════════════════════════════════════════

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { PDFParse } from "pdf-parse";
import ws from "ws";
import fs from "node:fs";
import { todayISO } from "./lib.js";
import { pn, pu } from "./privacy.js";
import {
  filterCenso, buildWindows, oldestIngreso, rowToEstudio, estudioKey, dedupEstudios,
  matchCensoDetailed, resolveHomonyms, nearMisses,
  looksLikeLoginPage, isUsableReportText, buildHaveSet, classifyReporte, splitPayload,
  isUnknownColumnError, stripColumns, REPORTE_ESTADO, RIS_OPTIONAL_COLS,
  RIS_AGE_TOLERANCE_DEFAULT, RIS_AGE_TOLERANCE_WIDE, RIS_LOOKBACK_DAYS_DEFAULT, RIS_MIN_WINDOWS_DEFAULT, RIS_MAX_WINDOWS_DEFAULT,
} from "./ris-lib.js";

const ENV = (k, def) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : def);
const RIS_MODE = ENV("RIS_MODE", "scrape");
const DRY_RUN = ENV("DRY_RUN", "false") === "true" || process.argv.includes("--dry-run");
const SUPABASE_URL = ENV("SUPABASE_URL", "");
const SUPABASE_SERVICE_KEY = ENV("SUPABASE_SERVICE_KEY", "");
const RIS_LOOKBACK_DAYS = parseInt(ENV("RIS_LOOKBACK_DAYS", String(RIS_LOOKBACK_DAYS_DEFAULT)), 10); // el portal no permite > 14 días
const RIS_MIN_WINDOWS = parseInt(ENV("RIS_MIN_WINDOWS", String(RIS_MIN_WINDOWS_DEFAULT)), 10);
const RIS_MAX_WINDOWS = parseInt(ENV("RIS_MAX_WINDOWS", String(RIS_MAX_WINDOWS_DEFAULT)), 10);       // tope de ventanas (5 × 14 d = 70 d)
const RIS_MAX_REPORTES = parseInt(ENV("RIS_MAX_REPORTES", "60"), 10);  // reportes nuevos (intentos) por corrida
const RIS_AGE_TOLERANCE = parseInt(ENV("RIS_AGE_TOLERANCE", String(RIS_AGE_TOLERANCE_DEFAULT)), 10);
const RIS_AGE_TOLERANCE_WIDE_ENV = parseInt(ENV("RIS_AGE_TOLERANCE_WIDE", String(RIS_AGE_TOLERANCE_WIDE)), 10);
const NAV_TIMEOUT_MS = 45000;
const SEL_TIMEOUT_MS = 20000;
const MATCH_OPTS = { ageTolerance: RIS_AGE_TOLERANCE, ageToleranceWide: RIS_AGE_TOLERANCE_WIDE_ENV };

function log(...a) { console.log(...a); }
function abs(base, u) { if (!u) return ""; try { return new URL(u, base).toString(); } catch (_) { return ""; } }
function cleanText(s) { return String(s || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim(); }
function short(e) { return String((e && e.message) || e || "").split("\n")[0]; }

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

// ── CENSO ACTUAL (cada corrida lee la tabla patients: un ingreso nuevo entra en la siguiente) ──
async function loadCenso(supa) {
  const { data, error } = await supa.from("patients").select("id,exp,nombre,cama,esp,edad,es_mio,ingreso,created_at");
  if (error) throw new Error("censo: " + error.message);
  const { censo, skipped } = filterCenso(data || []);
  const ajenos = censo.filter((p) => p.es_mio === false).length;
  log(`[censo] ${censo.length} pacientes (todas las especialidades; de otros servicios es_mio=false: ${ajenos})` +
    (skipped.length ? ` · omitidos ${skipped.length}: ${skipped.map((s) => `cama ${s.cama} (${s.motivo})`).join(", ")}` : ""));
  // Alias "nombre en WinLab" fijado desde la app (notes.checklist.winlab_alias): también identifica en el RIS.
  try {
    const ids = censo.map((p) => p.id).filter(Boolean);
    if (ids.length) {
      const { data: al, error: e2 } = await supa.from("notes").select("patient_id, alias:checklist->>winlab_alias").in("patient_id", ids);
      if (e2) throw e2;
      const byId = new Map((al || []).map((r) => [r.patient_id, String(r.alias || "").trim()]));
      let n = 0;
      for (const p of censo) { const a = byId.get(p.id); if (a) { p.alias = a; n++; } }
      if (n) log(`[censo] alias de WinLab usados también para el RIS: ${n}`);
    }
  } catch (e) { log(`[censo] (alias de WinLab no disponibles: ${short(e)})`); }
  return censo;
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
    log(`       (click submit falló: ${short(e)} → Enter)`);
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
// Todas las ventanas: la primera es obligatoria (tabla vacía = portal/sesión rota); las demás,
// si fallan, se registran y se sigue (mejor cobertura parcial que ninguna).
async function fetchVentanas(page, cfg, windows) {
  let headers = [];
  const rows = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    try {
      const r = await fetchTabla(page, cfg, w.dateS, w.dateSS);
      if (i === 0 && !r.rows.length) throw new Error("La tabla llegó vacía (¿cambió el portal o la sesión?)");
      if (!headers.length && r.headers.length) headers = r.headers;
      rows.push(...r.rows);
    } catch (e) {
      if (i === 0) throw e;
      log(`       ventana ${w.dateS}..${w.dateSS} falló: ${short(e)} (se sigue con las demás)`);
    }
  }
  return { headers, rows };
}

// ── REPORTE: bajar y transcribir ────────────────────────────────────────
async function pdfText(buf) {
  try { const parser = new PDFParse({ data: buf }); const r = await parser.getText(); return cleanText(r && r.text); }
  catch (e) { log(`       pdf-parse falló: ${short(e)}`); return ""; }
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
// Devuelve { text, url, ct, motivo }: `motivo` explica el ÚLTIMO fallo cuando no hay texto útil.
async function fetchReporte(page, ctx, cfg, est) {
  const link = est.linkReporte;
  if (!link) return { text: "", url: "", motivo: "sin ícono de reporte" };
  const url = abs(cfg.base, link.dataHref || link.href);
  let motivo = "";
  if (url) {
    try {
      const resp = await page.request.get(url, { timeout: 30000 });
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const buf = await resp.body();
      if (resp.status() >= 400) { motivo = `GET ${url} → HTTP ${resp.status()}`; }
      else if (/pdf/.test(ct) || buf.slice(0, 5).toString() === "%PDF-") {
        const text = await pdfText(buf);
        if (isUsableReportText(text)) return { text, url, ct };
        motivo = `PDF sin texto (${text.length} letras; ¿escaneado?)`;
      } else {
        const html = buf.toString("utf8");
        const { text, pdfSrc } = await htmlText(page, html);
        let visorSinTexto = false;
        if (pdfSrc) {
          const u2 = abs(cfg.base, pdfSrc);
          const r2 = await page.request.get(u2, { timeout: 30000 });
          const b2 = await r2.body();
          if (b2.slice(0, 5).toString() === "%PDF-") {
            const t2 = await pdfText(b2);
            if (isUsableReportText(t2)) return { text: t2, url: u2, ct: "pdf-embebido" };
            // El HTML es solo el visor del PDF: su texto (menús, botones) NO es el reporte y no debe
            // guardarse como tal (quedaría en `have` y nunca se reintentaría). Queda pendiente_descarga.
            motivo = `PDF embebido sin texto (${t2.length} letras; ¿escaneado?)`; visorSinTexto = true;
          }
        }
        if (looksLikeLoginPage(text, html)) motivo = `GET ${url} devolvió la página de login (sesión caducada)`;
        else if (!visorSinTexto && text.length > 60) return { text: cleanText(text), url, ct };
        else motivo = motivo || `GET ${url} → ${resp.status()} ${ct} texto corto (${text.length} letras)`;
      }
      log(`       reporte ${motivo}; probando clic`);
    } catch (e) { motivo = `GET falló: ${short(e)}`; log(`       reporte ${motivo}; probando clic`); }
  }
  // Sin href utilizable: clic en el ícono (abre popup o descarga)
  try {
    const rowSel = `table#consultas_pisos tbody tr:has(td:has-text("${est.documento}"))`;
    const icon = page.locator(rowSel).first().locator("a, button").filter({ has: page.locator('[class*="print"], [class*="impres"]') }).first();
    if (!(await icon.count())) return { text: "", url: url || "", motivo: motivo || "el ícono de reporte no está en la tabla visible" };
    const popupP = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    const dlP = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    await icon.click({ timeout: 5000 });
    const [popup, dl] = await Promise.all([popupP, dlP]);
    if (dl) { const p = await dl.path(); const buf = fs.readFileSync(p); const text = await pdfText(buf); return { text, url: dl.url(), ct: "download", motivo: isUsableReportText(text) ? "" : "descarga sin texto" }; }
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
      const t = cleanText(text);
      return { text: t, url: purl, ct: "popup", motivo: isUsableReportText(t) ? "" : (looksLikeLoginPage(t) ? "el popup mostró la página de login" : `popup sin texto útil (${t.length} letras)`) };
    }
    motivo = motivo || "el clic no abrió popup ni descarga";
  } catch (e) { motivo = `clic falló: ${short(e)}`; log(`       reporte por ${motivo}`); }
  return { text: "", url: url || "", motivo };
}

// ── Guarda de precisión sobre matchCensoDetailed ──────────────────────────
// El nivel 4 va SIN guarda de edad solo cuando el nombre es IDÉNTICO (caso real: edad mal capturada).
// Un SUBCONJUNTO exacto de ≥ 4 tokens (el RIS trae un apellido/nombre de más o de menos) con edad
// conocida e incompatible (> ±5) es más probable un homónimo (apellido de casada "… DE LOPEZ", nombre
// extra) que una edad mal capturada: ese candidato no cuenta y, si era el único, el estudio no se
// cruza (queda en "casi-coincidencias"). Con edad compatible o desconocida sigue cruzando en nivel 4
// (cubre censo con 3 nombres de pila y RIS con 2). Los niveles ≤ 3 ya traen su guarda de edad.
function esHomonimoProbable(c) {
  const identico = !!(c && c.cov && c.cov.censoCovered && c.cov.risCovered);
  return !!c && c.level === 4 && !identico && c.diff != null && c.diff > RIS_AGE_TOLERANCE_WIDE_ENV;
}
function matchCensoGuarded(e, censo) {
  const m = matchCensoDetailed(e, censo, MATCH_OPTS);
  if (!m) return { m: null, descartados: [] };
  const descartados = m.candidates.filter(esHomonimoProbable);
  if (!descartados.length) return { m, descartados };
  const cands = m.candidates.filter((c) => !esHomonimoProbable(c));
  if (!cands.length) return { m: null, descartados };
  const top = cands[0], second = cands[1];
  const ambiguous = !!second && second.p.exp !== top.p.exp && second.level === top.level && second.diff === top.diff && second.cov.exact === top.cov.exact && second.cov.common === top.cov.common;
  return { m: { p: top.p, level: top.level, label: top.label, diff: top.diff, via: top.via, ambiguous, candidates: cands }, descartados };
}

// ── UPSERT tolerante: si ris_estudios aún no tiene las columnas opcionales, se reintenta sin ellas ──
let optionalColsMissing = false;
async function upsertRis(supa, batch) {
  let rows = optionalColsMissing ? stripColumns(batch, RIS_OPTIONAL_COLS) : batch;
  let { error } = await supa.from("ris_estudios").upsert(rows, { onConflict: "documento,fecha,hora,modalidad" });
  if (error && !optionalColsMissing && isUnknownColumnError(error)) {
    optionalColsMissing = true;
    log(`       (ris_estudios no tiene las columnas ${RIS_OPTIONAL_COLS.join("/")}: ${short(error)} → reintento sin ellas; para guardar el estado del reporte agrégalas, ver scripts/supabase_ris_estudios.sql)`);
    rows = stripColumns(batch, RIS_OPTIONAL_COLS);
    ({ error } = await supa.from("ris_estudios").upsert(rows, { onConflict: "documento,fecha,hora,modalidad" }));
  }
  if (error) throw new Error("upsert ris_estudios: " + error.message);
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
    // (d) El censo se lee ANTES de consultar el RIS, en cada corrida: define hasta dónde mirar atrás.
    const censo = RIS_MODE === "explore" ? [] : await loadCenso(supa);
    await login(page, cfg);
    // Ventanas de 14 días (el portal no acepta más por consulta) desde hoy (León) hacia atrás hasta
    // el ingreso más antiguo del censo: los pacientes de piso llevan semanas internados y sus
    // estudios de ingreso quedaban fuera de las 2 ventanas fijas (27 días).
    const hoy = todayISO();
    const oldest = oldestIngreso(censo);
    const windows = buildWindows({ today: hoy, lookbackDays: RIS_LOOKBACK_DAYS, oldest, minWindows: RIS_MIN_WINDOWS, maxWindows: RIS_MAX_WINDOWS });
    log(`[2/4] ${windows.length} ventana(s) de ${RIS_LOOKBACK_DAYS + 1} días: ${windows[windows.length - 1].dateS} .. ${hoy}` + (oldest ? ` (ingreso más antiguo del censo: ${oldest})` : ""));
    const tabla = await fetchVentanas(page, cfg, windows);
    const estudios = dedupEstudios(tabla.rows.map((r) => rowToEstudio(r, tabla.headers)));
    const conReporte = estudios.filter((e) => e.linkReporte);
    log(`       estudios en el rango: ${estudios.length} · con ícono de reporte: ${conReporte.length}`);

    if (RIS_MODE === "explore") {
      log(`[EXPL] 3 filas con reporte: ${JSON.stringify(conReporte.slice(0, 3).map((e) => ({ fecha: e.fecha, mod: e.modalidad, links: e.links.length })))}`);
      log(`[EXPL] tipos de enlace: ${JSON.stringify(estudios.flatMap((e) => e.links.map((l) => l.kind + ":" + (l.html.match(/class=\\"[^\\"]*\\"/) || [""])[0])).reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {}))}`);
      if (conReporte.length) {
        const e = conReporte[0];
        const rep = await fetchReporte(page, ctx, cfg, e);
        log(`[EXPL reporte] url=${pu(rep.url)} ct=${rep.ct || ""} chars=${rep.text.length} motivo=${rep.motivo || ""}`);
      }
      fs.writeFileSync(`ris-explorer-${Date.now()}.json`, JSON.stringify({ headers: tabla.headers, sample: estudios.slice(0, 20) }, null, 2));
      log(`DONE explore · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await browser.close(); process.exit(0);
    }

    // ── SCRAPE: cruce nombre (+ edad) con el censo ──
    const matchedRaw = [];
    let ambiguos = 0, homonimosProbables = 0;
    for (const e of estudios) {
      const { m, descartados } = matchCensoGuarded(e, censo);
      for (const c of descartados) { homonimosProbables++; log(`       no cruzado: ${pn(e.nombre)} ${e.edad} ${e.tipoEdad} ${e.fecha} ${e.modalidad} ≈ cama ${c.p.cama} (${c.p.edad || "?"} a): subconjunto exacto con edad incompatible (homónimo probable)`); }
      if (!m) continue;
      // Empate COMPLETO entre dos pacientes del censo con expediente distinto (mismo nombre, misma edad,
      // mismo nivel): el estudio solo puede escribirse bajo un exp (clave documento|fecha|hora|modalidad)
      // y asignarlo al primero acierta el 50 %. No se asigna: queda en el log hasta que se corrija el
      // censo o se ponga alias; la siguiente corrida lo vuelve a intentar.
      if (m.ambiguous) { ambiguos++; log(`       ambiguo: ${pn(e.nombre)} ${e.edad} ${e.tipoEdad} ${e.fecha} ${e.modalidad} empata por completo entre camas ${m.candidates.slice(0, 2).map((c) => c.p.cama).join(" y ")} → NO se asigna (corrige el censo o pon alias «Nombre en WinLab»)`); continue; }
      matchedRaw.push({ e, p: m.p, level: m.level, label: m.label, diff: m.diff, via: m.via });
    }
    const { kept: matched, dropped, ambiguous } = resolveHomonyms(matchedRaw, MATCH_OPTS);
    for (const d of dropped) log(`       homónimo descartado: cama ${d.p.cama} ← ${pn(d.e.nombre)} ${d.e.edad} ${d.e.tipoEdad} ${d.e.fecha} ${d.e.modalidad} · ninguna identidad cuadra con la edad del censo`);
    for (const a of ambiguous) log(`       cama ${a.cama}: ${a.motivo} (${a.personas.length} identidades: ${a.personas.map(pn).join(" | ")})`);
    const pacientes = new Set(matched.map((m) => m.p.exp));
    log(`[3/4] cruce por nombre: ${matched.length} estudios de ${pacientes.size}/${censo.length} pacientes del censo` +
      (ambiguos ? ` · ${ambiguos} estudio(s) ambiguo(s) entre dos camas, sin asignar` : "") + (dropped.length ? ` · ${dropped.length} descartado(s) por homonimia` : "") +
      (homonimosProbables ? ` · ${homonimosProbables} candidato(s) no cruzado(s): subconjunto exacto con edad incompatible` : ""));
    const porNivel = matched.reduce((m, x) => (m[x.level] = (m[x.level] || 0) + 1, m), {});
    log(`       por nivel de cruce: ${JSON.stringify(porNivel)} · por alias: ${matched.filter((m) => m.via === "alias").length}`);
    const sinEstudio = censo.filter((p) => !pacientes.has(p.exp));
    if (sinEstudio.length) log(`       sin estudio en el RIS desde ${windows[windows.length - 1].dateS} (${sinEstudio.length}): ${sinEstudio.map((p) => `cama ${p.cama}`).join(", ")}`);
    const nm = nearMisses(estudios, censo, pacientes);
    if (nm.length) log(`       casi-coincidencias sin cruzar (revisar nombre/edad en la app): ${nm.length} · camas ${nm.map((x) => (String(x).match(/^cama (\S+)/) || [])[1] || "?").join(", ")}`);

    // Reportes que ya tenemos con texto útil (no volver a bajarlos). Los vacíos NO cuentan → reintento.
    const docs = Array.from(new Set(matched.map((m) => m.e.documento).filter(Boolean)));
    let have = new Set();
    if (docs.length) {
      const { data: prev, error: pe } = await supa.from("ris_estudios").select("documento,fecha,hora,modalidad,reporte").in("documento", docs);
      if (pe) log(`       (no se pudo leer ris_estudios previo: ${pe.message}; se bajarán de nuevo los reportes)`);
      have = buildHaveSet(prev || []);
    }
    const items = matched.map(({ e, p, level }) => ({
      e, p, level, key: estudioKey(e), result: null,
      row: {
        exp: p.exp, paciente: e.nombre, documento: e.documento, fecha: e.fecha, hora: e.hora, sede: e.sede, estudios: e.estudios,
        modalidad: e.modalidad, procedencia: e.procedencia, critico: e.critico,
        reporte_url: e.linkReporte ? abs(cfg.base, e.linkReporte.dataHref || e.linkReporte.href) : null,
        imagen_url: e.linkImagen ? abs(cfg.base, e.linkImagen.dataHref || e.linkImagen.href) : null,
        links: e.links.map((l) => ({ kind: l.kind, href: l.href, dataHref: l.dataHref, uid: l.uid })),
        scraped_at: new Date().toISOString(),
      },
    }));
    // Pendientes de descarga, los más recientes primero (el presupuesto por corrida va a lo nuevo).
    const pendientes = items.filter((it) => it.e.linkReporte && !have.has(it.key))
      .sort((a, b) => (String(b.e.fecha) + String(b.e.hora)).localeCompare(String(a.e.fecha) + String(a.e.hora)));
    let intentos = 0;
    for (const it of pendientes) {
      if (intentos >= RIS_MAX_REPORTES) { it.result = { attempted: false, budgetExhausted: true }; continue; }
      intentos++;
      try {
        const rep = await fetchReporte(page, ctx, cfg, it.e);
        it.result = { attempted: true, text: rep.text, url: rep.url, ct: rep.ct, error: rep.motivo };
      } catch (e) { it.result = { attempted: true, text: "", error: short(e) }; }
    }
    let bajados = 0, fallidos = 0;
    const porEstado = {};
    for (const it of items) {
      const r = it.result || {};
      const cls = classifyReporte({ hasLink: !!it.e.linkReporte, alreadySaved: have.has(it.key), attempted: !!r.attempted, text: r.text, error: r.error, budgetExhausted: !!r.budgetExhausted });
      it.row.reporte_estado = cls.estado;
      it.row.reporte_motivo = cls.motivo || null;
      porEstado[cls.estado] = (porEstado[cls.estado] || 0) + 1;
      if (cls.estado === REPORTE_ESTADO.OK && r.attempted) {
        it.row.reporte = r.text; it.row.reporte_url = r.url || it.row.reporte_url; bajados++;
        log(`       reporte ✓ cama ${it.p.cama} ${it.e.modalidad} ${it.e.fecha} (${r.text.length} letras, ${r.ct || ""})`);
      } else if (cls.estado === REPORTE_ESTADO.PENDIENTE_DESCARGA && r.attempted) {
        fallidos++;
        log(`       reporte ✗ cama ${it.p.cama} ${it.e.modalidad} ${it.e.fecha} (${r.url ? pu(r.url) : "sin url"}) · ${cls.motivo}`);
      }
    }
    const presupuesto = items.filter((it) => it.result && it.result.budgetExhausted).length;
    log(`[4/4] reportes nuevos: ${bajados} · fallidos (se reintentan): ${fallidos} · pendientes por presupuesto: ${presupuesto} · sin reporte aún en el RIS: ${porEstado[REPORTE_ESTADO.PENDIENTE_RIS] || 0} · ya guardados: ${items.filter((it) => have.has(it.key)).length}`);
    const payload = items.map((it) => it.row);
    if (!DRY_RUN && payload.length) {
      const { withRep, noRep } = splitPayload(payload);
      for (const batch of [withRep, noRep]) { if (batch.length) await upsertRis(supa, batch); }
      log(`       upsert ${payload.length} filas (${withRep.length} con reporte nuevo)`);
    } else if (DRY_RUN) {
      log(`[dry-run] no se escribe. Muestra: ${JSON.stringify(items.slice(0, 3).map((it) => ({ cama: it.p.cama, nivel: it.level, fecha: it.row.fecha, mod: it.row.modalidad, est: it.row.estudios, estado: it.row.reporte_estado, rep: (it.row.reporte || "").slice(0, 200) })))}`);
    }
    log(`DONE. Estudios del censo: ${payload.length} (${pacientes.size}/${censo.length} pacientes) · reportes nuevos ${bajados} · estados ${JSON.stringify(porEstado)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await browser.close(); process.exit(0);
  } catch (err) {
    console.error("[FATAL]", err.message);
    try { const shot = `ris-failure-${Date.now()}.png`; await page.screenshot({ path: shot, fullPage: true }); console.error("Screenshot: " + shot); } catch (_) {}
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
