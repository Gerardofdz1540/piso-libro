// ═══════════════════════════════════════════════════════════════════════
// piso-libro · WinLab RPA scraper
//   - Login determinista (waitForSelector + waitForLoadState)
//   - Mapeo dinamico de columnas (header -> indices)
//   - Agrupacion patient-header (FEMENINO/MASCULINO) + filas hijas
//   - Upsert masivo unico a Supabase (1 round-trip HTTP)
//   - Falla con process.exit(1) si: login KO, tabla ausente, 0 filas,
//     o respuesta Supabase no-2xx -> el Action queda en rojo y GitHub
//     dispara el correo automatico de "workflow failed".
// ═══════════════════════════════════════════════════════════════════════

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

// ── ENV (todo via process.env, cero hard-code) ─────────────────────────
const ENV = (k, def) => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (def === undefined) {
      console.error(`[FATAL] Falta variable de entorno: ${k}`);
      process.exit(1);
    }
    return def;
  }
  return v;
};

const WINLAB_URL             = ENV("WINLAB_URL");
const WINLAB_USER            = ENV("WINLAB_USER");
const WINLAB_PASS            = ENV("WINLAB_PASS");
const WINLAB_RESULTS_URL     = ENV("WINLAB_RESULTS_URL", "");
// Selectores que cubren los 2 forms tipicos de WinLab (header oculto + body visible).
// setField() resuelve el match VISIBLE entre los candidatos, asi nunca se llena el oculto.
const WINLAB_USER_SELECTOR   = ENV("WINLAB_USER_SELECTOR", '#txtUserName, #txtUsuario, #txtUser, input[name="txtUserName"], #Intestazione_TextBox1, input[name="Intestazione$TextBox1"], input[type="text"]:not([type="hidden"])');
const WINLAB_PASS_SELECTOR   = ENV("WINLAB_PASS_SELECTOR", '#txtPassword, #txtContrasena, #txtPass, input[name="txtPassword"], #Intestazione_TextBox2, input[name="Intestazione$TextBox2"], input[type="password"]');
const WINLAB_SUBMIT_SELECTOR = ENV("WINLAB_SUBMIT_SELECTOR", '#btnLogin, #btnEntrar, #btnAcceder, #btnAceptar, input[name="btnLogin"], #Intestazione_ImageButton1, input[name="Intestazione$ImageButton1"], #Intestazione_Button1, input[name="Intestazione$Button1"], button[type="submit"], input[type="submit"], input[type="image"]');
const WINLAB_TABLE_SELECTOR  = ENV("WINLAB_TABLE_SELECTOR", "table");
const WINLAB_LOGGED_SELECTOR = ENV("WINLAB_LOGGED_SELECTOR", "");
const WINLAB_NEXT_SELECTOR   = ENV("WINLAB_NEXT_SELECTOR", "");
const WINLAB_MAX_PAGES       = parseInt(ENV("WINLAB_MAX_PAGES", "30"), 10);
const NAV_TIMEOUT_MS         = parseInt(ENV("NAV_TIMEOUT_MS", "45000"), 10);
const SEL_TIMEOUT_MS         = parseInt(ENV("SEL_TIMEOUT_MS", "20000"), 10);

const SUPABASE_URL            = ENV("SUPABASE_URL");
const SUPABASE_SERVICE_KEY    = ENV("SUPABASE_SERVICE_KEY");
const SUPABASE_TABLE          = ENV("SUPABASE_TABLE", "winlab_labs");
const SUPABASE_CONFLICT       = ENV("SUPABASE_ON_CONFLICT", "exp,fecha");
const SUPABASE_CENSO_TABLE    = ENV("SUPABASE_CENSO_TABLE", "patients");
const SUPABASE_CENSO_SELECT   = ENV("SUPABASE_CENSO_SELECT", "cama,exp,nombre,esp");

// Selectores del formulario de busqueda WinLab (descubiertos via explorador).
const WL_SEARCH_EXP_SEL       = ENV("WL_SEARCH_EXP_SEL", "#pnlMain_pnlPaziente_txtCodicePaziente");
const WL_SEARCH_COGNOME_SEL   = ENV("WL_SEARCH_COGNOME_SEL", "#pnlMain_pnlPaziente_txtCognome");
const WL_SEARCH_NOME_SEL      = ENV("WL_SEARCH_NOME_SEL", "#pnlMain_pnlPaziente_txtNome");
const WL_SEARCH_FECHA_DE_SEL  = ENV("WL_SEARCH_FECHA_DE_SEL", "#pnlMain_pnlReferti_txtDataRefertoDa");
const WL_SEARCH_FECHA_A_SEL   = ENV("WL_SEARCH_FECHA_A_SEL", "#pnlMain_pnlReferti_txtDataRefertoA");
const WL_SEARCH_BTN_SEL       = ENV("WL_SEARCH_BTN_SEL", "#Intestazione_DBToolbar_pnlCerca_btnCerca");
const WL_SEARCH_CLEAR_SEL     = ENV("WL_SEARCH_CLEAR_SEL", "#Intestazione_DBToolbar_pnlPulisci_btnPulisci");
const WL_LOOKBACK_DAYS        = parseInt(ENV("WL_LOOKBACK_DAYS", "1"), 10);
const WL_DATE_FORMAT          = ENV("WL_DATE_FORMAT", "dd/MM/yyyy");
const WL_PER_PATIENT_TIMEOUT  = parseInt(ENV("WL_PER_PATIENT_TIMEOUT", "30000"), 10);
const WL_DRILLDOWN            = parseInt(ENV("WL_DRILLDOWN", "1"), 10);          // 1 = clickear cada reporte para sacar valores
const WL_DRILLDOWN_MAX        = parseInt(ENV("WL_DRILLDOWN_MAX", "3"), 10);      // max reportes por paciente
const WL_DRILLDOWN_TIMEOUT    = parseInt(ENV("WL_DRILLDOWN_TIMEOUT", "15000"), 10);

// ── Helpers ────────────────────────────────────────────────────────────
const N = (s) =>
  String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
};

// Filtro de especialidad copiado del tampermonkey existente.
// Mantiene CG, CT, CV, CCR, CPR, CMF, URG y combinaciones; excluye GYO/URO/etc.
const ALLOWED_ESPS = new Set([
  "CG", "CCR", "CT", "CTV", "CPR", "CV", "CMF",
  "CG/GYO", "CG/CV", "GYO/CG", "CV/CG", "URG", "URGENCIAS",
]);
const EXCLUDED_ESPS = new Set([
  "NCX", "URO", "GYO", "TYO", "ONCOCIRUGIA", "ONCO",
  "COLUMNA", "ENDOS", "NEUROCX", "ORTOPEDIA", "TRAUMA",
]);
function isAllowedEsp(esp) {
  const e = N(esp);
  if (!e) return false;
  if (EXCLUDED_ESPS.has(e)) return false;
  if (ALLOWED_ESPS.has(e)) return true;
  if (/(^|[\/\s])CG([\/\s]|$)/.test(e)) return true;
  return false;
}

// Formatea fecha segun WL_DATE_FORMAT (default "dd/MM/yyyy").
function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return WL_DATE_FORMAT
    .replace("dd", dd)
    .replace("MM", mm)
    .replace("yyyy", yyyy);
}
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Resuelve el primer match VISIBLE entre todos los candidatos del selector.
// Si ninguno es visible, regresa el primero attached. Esto es CRITICO en WinLab
// porque la pagina tiene 2 forms de login (header oculto + body visible) y
// con .first() llenabamos el oculto.
async function pickVisible(page, selector) {
  const all = page.locator(selector);
  const total = await all.count();
  for (let i = 0; i < total; i++) {
    const el = all.nth(i);
    if (await el.isVisible().catch(() => false)) return { el, idx: i, total };
  }
  return { el: all.first(), idx: -1, total };
}

// WinLab usa ASP.NET AJAX UpdatePanel: el click "Busca" NO navega, solo
// hace un partial postback (XMLHttpRequest). domcontentloaded resuelve
// inmediatamente porque la URL no cambia.
//
// Esperar correctamente requiere:
//   1) networkidle (500ms sin trafico XHR)
//   2) Sys.WebForms.PageRequestManager.get_isInAsyncPostBack() === false
async function waitForAspNetReady(page, timeout = 15000) {
  try {
    await page.waitForLoadState("networkidle", { timeout });
  } catch (_) { /* networkidle puede colgarse en SPAs ruidosas */ }
  try {
    await page.waitForFunction(
      () => {
        if (typeof window.Sys === "undefined" || !window.Sys.WebForms) return true;
        const prm = window.Sys.WebForms.PageRequestManager.getInstance();
        return !prm || !prm.get_isInAsyncPostBack();
      },
      { timeout: 5000 }
    );
  } catch (_) { /* si Sys no existe tras 5s, asumimos que ya termino */ }
}

// Fill robusto: 1) prefiere visible, 2) fill force, 3) fallback JS via descriptor.
async function setField(page, selector, value, label) {
  const { el, idx, total } = await pickVisible(page, selector);
  console.log(`       ${label}: ${total} matches, usando indice ${idx >= 0 ? idx + " (visible)" : "0 (ninguno visible)"}`);
  await el.waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });
  try {
    await el.fill(value, { force: true, timeout: 5000 });
    return;
  } catch (e) {
    console.log(`       (fill normal fallo en ${label}: ${e.message.split("\n")[0]} -> JS fallback)`);
  }
  // Fallback JS: ubica el mismo elemento por indice y setea via descriptor.
  await page.evaluate(([sel, val, i]) => {
    const list = document.querySelectorAll(sel);
    const target = i >= 0 && list[i] ? list[i] : list[0];
    if (!target) throw new Error("No element for " + sel);
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(target, val);
    target.dispatchEvent(new Event("input",  { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, value, idx]);
}

// ── 1. LOGIN ───────────────────────────────────────────────────────────
async function login(page) {
  console.log(`[1/5] Login -> ${WINLAB_URL}`);
  await page.goto(WINLAB_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

  // Diagnostico: mapear todos los inputs presentes en la pagina (visibles u ocultos).
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input")).map((i) => ({
      id: i.id || null,
      name: i.name || null,
      type: i.type || null,
      visible: !!(i.offsetParent || i.getClientRects().length),
    }))
  );
  // Sin truncar para no perder ningun campo en logs.
  console.log(`       Inputs en pagina (${inputs.length}):`, JSON.stringify(inputs));

  // Tambien volcamos botones/submit visibles para diagnostico.
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input[type="submit"], input[type="image"], input[type="button"]')).map((b) => ({
      id: b.id || null,
      name: b.name || null,
      type: b.type || b.tagName.toLowerCase(),
      value: b.value || null,
      text: (b.innerText || "").trim().slice(0, 40) || null,
      visible: !!(b.offsetParent || b.getClientRects().length),
    }))
  );
  console.log(`       Botones en pagina (${buttons.length}):`, JSON.stringify(buttons));

  await setField(page, WINLAB_USER_SELECTOR, WINLAB_USER, "user");
  await setField(page, WINLAB_PASS_SELECTOR, WINLAB_PASS, "pass");

  const { el: submit, idx: subIdx, total: subTotal } = await pickVisible(page, WINLAB_SUBMIT_SELECTOR);
  console.log(`       submit: ${subTotal} matches, usando indice ${subIdx >= 0 ? subIdx + " (visible)" : "0 (ninguno visible)"}`);
  await submit.waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });

  // Click + esperar navegacion. Fallback JS si force falla.
  let clicked = false;
  try {
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }),
      submit.click({ force: true, timeout: 5000 }),
    ]);
    clicked = true;
  } catch (e) {
    console.log(`       (click normal fallo: ${e.message.split("\n")[0]} -> JS fallback)`);
  }
  if (!clicked) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }),
      page.evaluate(([sel, i]) => {
        const list = document.querySelectorAll(sel);
        const target = i >= 0 && list[i] ? list[i] : list[0];
        if (!target) throw new Error("No submit for " + sel);
        if (typeof target.click === "function") target.click();
        else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, [WINLAB_SUBMIT_SELECTOR, subIdx]),
    ]);
  }

  // Verificacion determinista: el campo password ya no debe estar attached.
  const stillOnLogin = await page.locator(WINLAB_PASS_SELECTOR).count();
  if (stillOnLogin > 0) {
    throw new Error("Login fallido: el campo password sigue presente tras submit. Revisa credenciales o WINLAB_LOGGED_SELECTOR.");
  }
  if (WINLAB_LOGGED_SELECTOR) {
    await page.locator(WINLAB_LOGGED_SELECTOR).first().waitFor({ state: "visible", timeout: SEL_TIMEOUT_MS });
  }
  console.log("       OK login.");
}

// ── 2. CARGAR CENSO DESDE SUPABASE ─────────────────────────────────────
// Lee la tabla `patients` (mismo Supabase que la PWA) y filtra por especialidad
// quirurgica con la misma logica que el tampermonkey existente.
async function loadCenso(supa) {
  console.log(`[2/5] Leyendo censo de Supabase tabla="${SUPABASE_CENSO_TABLE}" select="${SUPABASE_CENSO_SELECT}"...`);
  const { data, error } = await supa
    .from(SUPABASE_CENSO_TABLE)
    .select(SUPABASE_CENSO_SELECT);
  if (error) throw new Error(`Lectura de censo fallo: ${error.message}`);

  const total = data?.length || 0;
  const filtrados = (data || []).filter((p) => isAllowedEsp(p.esp));
  console.log(`       Censo total=${total}, despues de filtro especialidad=${filtrados.length}`);
  if (!filtrados.length) {
    throw new Error(`Censo vacio o sin pacientes de las especialidades permitidas (CG/CT/CV/CCR/CPR/CMF/URG). Revisa la columna 'esp' en ${SUPABASE_CENSO_TABLE}.`);
  }
  return filtrados;
}

// ── 3. UBICAR LA PANTALLA DE BUSQUEDA ─────────────────────────────────
// Captura la URL post-login (que es la pantalla de busqueda) para volver
// a ella entre paciente y paciente sin perder sesion.
async function captureSearchUrl(page) {
  const explicit = WINLAB_RESULTS_URL || "";
  const url = explicit || page.url();
  console.log(`[3/5] Pantalla de busqueda: ${url}`);
  return url;
}

// ── 4. BUSQUEDA + SCRAPE POR PACIENTE ─────────────────────────────────
async function searchAndScrapeOne(page, searchUrl, paciente) {
  // Volver a la pantalla de busqueda fresca (limpia el form previo).
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await page.locator(WL_SEARCH_EXP_SEL).waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });

  // Llenar codigo paciente (= exp del censo).
  await setField(page, WL_SEARCH_EXP_SEL, String(paciente.exp || ""), `exp=${paciente.exp}`);

  // Llenar rango de fechas (default: ultimos N dias hasta hoy).
  if (WL_LOOKBACK_DAYS >= 0) {
    const fechaDe = formatDate(daysAgo(WL_LOOKBACK_DAYS));
    const fechaA  = formatDate(new Date());
    if (await page.locator(WL_SEARCH_FECHA_DE_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_DE_SEL, fechaDe, "fechaDe");
    }
    if (await page.locator(WL_SEARCH_FECHA_A_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_A_SEL, fechaA, "fechaA");
    }
  }

  // Click "Busca". Es un postback AJAX (UpdatePanel), no navegacion: por eso
  // NO usamos waitForLoadState('domcontentloaded'). Esperamos que ASP.NET
  // AJAX termine via waitForAspNetReady.
  const { el: btn } = await pickVisible(page, WL_SEARCH_BTN_SEL);
  await btn.waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });
  try {
    await btn.click({ force: true, timeout: 5000 });
  } catch {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.click();
    }, WL_SEARCH_BTN_SEL);
  }
  await waitForAspNetReady(page, WL_PER_PATIENT_TIMEOUT);

  // Scrapear la(s) tabla(s) de resultados con mapeo dinamico.
  const result = await page.evaluate(() => {
    const norm = (s) =>
      String(s || "")
        .toUpperCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();

    const tables = Array.from(document.querySelectorAll("table"));
    let best = null, bestRows = 0, bestTableIdx = -1;
    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti];
      const trs = t.querySelectorAll("tr").length;
      const ths = t.querySelectorAll("th").length;
      const score = trs * (1 + (ths > 0 ? 1 : 0));
      const txt = norm(t.innerText).slice(0, 200);
      if (txt.includes("INICIO REPORTES AYUDA")) continue;
      if (score > bestRows) { best = t; bestRows = score; bestTableIdx = ti; }
    }
    if (!best) return { headers: [], rows: [], tableCount: tables.length, bestTableIdx: -1 };

    const trs = Array.from(best.querySelectorAll("tr"));
    let headers = [];
    let headerIdx = -1;
    for (let i = 0; i < trs.length; i++) {
      const ths = Array.from(trs[i].querySelectorAll("th"));
      if (ths.length >= 2) {
        headers = ths.map((c) => norm(c.innerText));
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) {
      for (let i = 0; i < Math.min(3, trs.length); i++) {
        const tds = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (tds.length >= 3 && tds.every((t) => t.length > 0 && t.length < 30)) {
          headers = tds;
          headerIdx = i;
          break;
        }
      }
    }

    const rows = [];
    for (let i = headerIdx + 1; i < trs.length; i++) {
      const cells = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
      if (!cells.length) continue;
      const row = {};
      headers.forEach((h, k) => {
        if (h && cells[k] !== undefined) row[h] = cells[k];
      });
      row.__cells = cells;
      // Detectar si la fila tiene un link/boton clickable para drill-down.
      const link = trs[i].querySelector('a, input[type="image"], input[type="button"], input[type="submit"]');
      row.__hasLink = !!link;
      row.__rowIdxInTable = i;
      rows.push(row);
    }
    return { headers, rows, tableCount: tables.length, bestTableIdx, headerIdx };
  });

  // ── DRILL-DOWN: para cada reporte, click y extraer valores reales ──
  if (WL_DRILLDOWN === 1 && result.rows.length > 0 && result.bestTableIdx >= 0) {
    const max = Math.min(result.rows.length, WL_DRILLDOWN_MAX);
    for (let i = 0; i < max; i++) {
      const row = result.rows[i];
      if (!row.__hasLink) continue;
      try {
        const valores = await drillDownReport(page, searchUrl, paciente, result.bestTableIdx, row.__rowIdxInTable, i === 0);
        if (valores && valores.length) {
          row.valores = valores;
        }
      } catch (e) {
        console.log(`       drill-down [${i}]: ${e.message.split("\n")[0]}`);
      }
    }
  }

  return result;
}

// Click en una fila especifica de la tabla de resultados, scrapea la
// pantalla de detalle (lab values) y vuelve a la lista para la siguiente.
// Si dumpFirst=true, vuelca el DOM del detalle para diagnostico (1ra vez).
async function drillDownReport(page, searchUrl, paciente, tableIdx, rowIdxInTable, dumpFirst) {
  const link = page.locator("table").nth(tableIdx)
    .locator("tr").nth(rowIdxInTable)
    .locator('a, input[type="image"], input[type="button"], input[type="submit"]').first();
  const linkCount = await link.count();
  if (!linkCount) return null;

  // Click del link de detalle. Tambien es postback AJAX (o nueva navegacion
  // si abre otra .aspx). Probamos waitForAspNetReady; si fue navegacion
  // completa, networkidle igual la cubre.
  try {
    await link.click({ force: true, timeout: 5000 });
  } catch {
    await page.evaluate((args) => {
      const el = document.querySelectorAll("table")[args.t]
        ?.querySelectorAll("tr")[args.r]
        ?.querySelector('a, input[type="image"], input[type="button"], input[type="submit"]');
      if (el) el.click();
    }, { t: tableIdx, r: rowIdxInTable });
  }
  await waitForAspNetReady(page, WL_DRILLDOWN_TIMEOUT);

  // Scrapear cualquier tabla en la pantalla de detalle que parezca tener
  // estudios/valores. Heuristica: buscar tablas con >= 3 columnas donde
  // la primera columna tiene texto y al menos otra columna parece numero/valor.
  const detail = await page.evaluate(() => {
    const norm = (s) =>
      String(s || "")
        .toUpperCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();

    const out = { url: location.href, valores: [], headers: [] };
    const tables = Array.from(document.querySelectorAll("table"));
    for (const t of tables) {
      const txt = norm(t.innerText).slice(0, 200);
      if (txt.includes("INICIO REPORTES AYUDA")) continue;
      const trs = Array.from(t.querySelectorAll("tr"));
      if (trs.length < 2) continue;

      // Detectar header: TH primero, o primera fila con tokens reconocibles.
      let headers = [];
      let headerIdx = -1;
      for (let i = 0; i < Math.min(5, trs.length); i++) {
        const ths = Array.from(trs[i].querySelectorAll("th"));
        if (ths.length >= 2) {
          headers = ths.map((c) => norm(c.innerText));
          headerIdx = i;
          break;
        }
        const tds = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (tds.some((c) => /^(ESTUDIO|EXAMEN|ANALISIS|PRUEBA|TEST|RESULTADO|VALOR|UNIDADES|UNIDAD|REFERENCIA|RANGO|VR)$/.test(c))) {
          headers = tds;
          headerIdx = i;
          break;
        }
      }
      if (headerIdx < 0) continue;

      const idx = (re) => headers.findIndex((h) => re.test(h));
      const cE = idx(/^(ESTUDIO|EXAMEN|ANALISIS|PRUEBA|TEST|NOMBRE|DESCRIPCION)$/);
      const cV = idx(/^(RESULTADO|VALOR|VAL)$/);
      const cU = idx(/^(UNIDADES|UNIDAD|U\.M\.|UM)$/);
      const cR = idx(/^(REFERENCIA|RANGO|V\.R\.|VR|RANGO REFERENCIAL)$/);
      if (cE < 0 || cV < 0) continue;

      for (let i = headerIdx + 1; i < trs.length; i++) {
        const cells = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (!cells.length) continue;
        const estudio = cells[cE];
        const valor = cells[cV];
        if (!estudio && !valor) continue;
        out.valores.push({
          estudio,
          valor,
          unidad: cU >= 0 ? (cells[cU] || "") : "",
          referencia: cR >= 0 ? (cells[cR] || "") : "",
        });
      }
      out.headers = headers;
      if (out.valores.length) break; // Ya encontramos la tabla buena.
    }
    return out;
  });

  if (dumpFirst && (!detail.valores || !detail.valores.length)) {
    console.log(`       <<<DETAIL>>> URL=${detail.url}`);
    const allTables = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("table")).slice(0, 5).map((t, i) => ({
        idx: i,
        rows: t.querySelectorAll("tr").length,
        ths: t.querySelectorAll("th").length,
        firstRow: Array.from(t.querySelectorAll("tr")[0]?.querySelectorAll("th, td") || [])
          .map((c) => (c.innerText || "").trim().slice(0, 40)),
        sample: (t.innerText || "").slice(0, 200),
      }));
    });
    allTables.forEach((tb) => console.log(`       <<<DETAIL TABLE ${tb.idx}>>> ${JSON.stringify(tb)}`));
  }

  // Volver a la pantalla de busqueda y re-ejecutar la busqueda para que
  // la siguiente fila siga teniendo indices validos.
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await setField(page, WL_SEARCH_EXP_SEL, String(paciente.exp || ""), `re-exp=${paciente.exp}`);
  if (WL_LOOKBACK_DAYS >= 0) {
    const fechaDe = formatDate(daysAgo(WL_LOOKBACK_DAYS));
    const fechaA  = formatDate(new Date());
    if (await page.locator(WL_SEARCH_FECHA_DE_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_DE_SEL, fechaDe, "re-fechaDe");
    }
    if (await page.locator(WL_SEARCH_FECHA_A_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_A_SEL, fechaA, "re-fechaA");
    }
  }
  const { el: btn } = await pickVisible(page, WL_SEARCH_BTN_SEL);
  await btn.click({ force: true, timeout: 5000 }).catch(() => {});
  await waitForAspNetReady(page, WL_PER_PATIENT_TIMEOUT);

  return detail.valores || [];
}

// Procesa todo el censo en serie. Si hay >1 fallo seguido, aborta.
async function scrapeForCenso(page, searchUrl, censo) {
  console.log(`[4/5] Buscando labs paciente por paciente (${censo.length} pacientes)...`);
  const records = [];
  let consecutiveErrors = 0;
  const fechaToday = todayISO();
  const scraped_at = new Date().toISOString();

  for (let i = 0; i < censo.length; i++) {
    const p = censo[i];
    const tag = `[${i + 1}/${censo.length}] exp=${p.exp} ${String(p.nombre || "").slice(0, 40)}`;
    try {
      const res = await searchAndScrapeOne(page, searchUrl, p);
      const matched = res.rows.length;
      console.log(`       ${tag}: ${matched} reportes (tablas=${res.tableCount}, headers=[${res.headers.slice(0, 6).join(", ")}${res.headers.length > 6 ? ", ..." : ""}])`);

      if (matched > 0) {
        records.push({
          exp: String(p.exp).slice(0, 64),
          paciente: p.nombre || null,
          fecha: fechaToday,
          data: {
            esp: p.esp || null,
            cama: p.cama || null,
            headers: res.headers,
            reportes: res.rows,
          },
          scraped_at,
        });
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.log(`       ${tag}: ERROR ${err.message.split("\n")[0]}`);
      if (consecutiveErrors >= 3) {
        throw new Error(`3 fallos seguidos buscando pacientes. Ultimo: ${err.message}`);
      }
    }
  }
  console.log(`       OK busqueda. Pacientes con labs: ${records.length}/${censo.length}`);
  return records;
}

// ── 5. UPSERT MASIVO ───────────────────────────────────────────────────
async function upsert(supa, records) {
  console.log(`[5/5] Upsert -> Supabase tabla="${SUPABASE_TABLE}" onConflict="${SUPABASE_CONFLICT}" (${records.length} filas)`);
  if (!records.length) {
    console.log("       0 filas para upsertear (ningun paciente con labs en el rango). Saliendo OK.");
    return;
  }
  const { error, count } = await supa
    .from(SUPABASE_TABLE)
    .upsert(records, { onConflict: SUPABASE_CONFLICT, count: "exact" });

  if (error) {
    throw new Error(`Supabase upsert fallo: ${error.message} (code=${error.code})`);
  }
  console.log(`       OK upsert. Filas afectadas: ${count ?? records.length}`);
}

// ── MODO EXPLORADOR ────────────────────────────────────────────────────
// Cuando no hay pacientes: vuelca el mapa completo de la pantalla actual
// para que podamos descubrir los IDs reales de los campos de busqueda.
async function explorePage(page) {
  const url = page.url();
  console.log(`[EXPLORADOR] URL actual: ${url}`);
  console.log(`[EXPLORADOR] Titulo: ${await page.title()}`);

  const map = await page.evaluate(() => {
    const isVisible = (el) => !!(el.offsetParent || el.getClientRects().length);
    const labelOf = (el) => {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) return (lbl.innerText || "").trim().slice(0, 60);
      }
      const wrap = el.closest("label");
      if (wrap) return (wrap.innerText || "").trim().slice(0, 60);
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === "LABEL") return (prev.innerText || "").trim().slice(0, 60);
      return null;
    };

    const inputs = Array.from(document.querySelectorAll("input"))
      .filter(isVisible)
      .map((i) => ({
        id: i.id || null, name: i.name || null, type: i.type || null,
        value: (i.value || "").slice(0, 40) || null,
        placeholder: i.placeholder || null,
        label: labelOf(i),
      }));

    const selects = Array.from(document.querySelectorAll("select"))
      .filter(isVisible)
      .map((s) => ({
        id: s.id || null, name: s.name || null,
        label: labelOf(s),
        selected: s.value || null,
        options: Array.from(s.options).slice(0, 80).map((o) => ({
          value: o.value, text: (o.text || "").trim().slice(0, 60),
        })),
      }));

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a[onclick], a[href*="javascript"]'))
      .filter(isVisible)
      .map((b) => ({
        tag: b.tagName.toLowerCase(),
        id: b.id || null, name: b.name || null, type: b.type || null,
        value: b.value || null,
        text: (b.innerText || b.alt || "").trim().slice(0, 60) || null,
      }));

    const links = Array.from(document.querySelectorAll("a[href]"))
      .filter(isVisible)
      .map((a) => ({
        text: (a.innerText || a.title || "").trim().slice(0, 60) || null,
        href: (a.getAttribute("href") || "").slice(0, 120),
      }))
      .filter((l) => l.text);

    return { inputs, selects, buttons, links };
  });

  console.log(`[EXPLORADOR] Inputs visibles (${map.inputs.length}):`);
  map.inputs.forEach((i, k) => console.log(`<<<EXPL input:${k}>>> ${JSON.stringify(i)}`));
  console.log(`[EXPLORADOR] Selects visibles (${map.selects.length}):`);
  map.selects.forEach((s, k) => console.log(`<<<EXPL select:${k}>>> ${JSON.stringify(s)}`));
  console.log(`[EXPLORADOR] Botones visibles (${map.buttons.length}):`);
  map.buttons.forEach((b, k) => console.log(`<<<EXPL button:${k}>>> ${JSON.stringify(b)}`));
  console.log(`[EXPLORADOR] Links visibles (${map.links.length}, primeros 50):`);
  map.links.slice(0, 50).forEach((l, k) => console.log(`<<<EXPL link:${k}>>> ${JSON.stringify(l)}`));

  // Tambien escribir archivo JSON completo: se sube como artifact por
  // el workflow. Asi el usuario tiene 2 caminos: copiar las lineas <<<EXPL>>>
  // del log, o bajar el zip del artifact y mandar el archivo.
  try {
    const fs = await import("node:fs");
    const fname = `explorer-${Date.now()}.json`;
    fs.writeFileSync(fname, JSON.stringify({ url, title: await page.title(), ...map }, null, 2));
    console.log(`[EXPLORADOR] Dump completo guardado en artifact: ${fname}`);
  } catch (e) {
    console.log(`[EXPLORADOR] No pude escribir archivo: ${e.message}`);
  }
}

// ── MAIN ───────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(SEL_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  try {
    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    await login(page);
    const censo = await loadCenso(supa);
    const searchUrl = await captureSearchUrl(page);
    const records = await scrapeForCenso(page, searchUrl, censo);

    if (!records.length) {
      // No es necesariamente un fallo: puede que ningun paciente tenga
      // labs en el rango. Activamos explorador y salimos en exit(0) tras
      // upsert vacio para no spammear el correo de "fail" todos los dias.
      console.log("[!] 0 pacientes con labs. Dump de la ultima pantalla para diagnostico...");
      await explorePage(page);
    }

    await upsert(supa, records);
    console.log(`DONE en ${((Date.now() - t0) / 1000).toFixed(1)}s. Pacientes con labs: ${records.length}/${censo.length}.`);
    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error("[FATAL]", err.message);
    try {
      const shot = `failure-${Date.now()}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      console.error(`Screenshot guardado: ${shot}`);
    } catch (_) {}
    await browser.close().catch(() => {});
    process.exit(1);
  }
})();
