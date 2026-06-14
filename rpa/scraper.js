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
import ws from "ws";
import { N, todayISO, isAllowedEsp, formatDate as _formatDate, daysAgo, dedupRecords,
         isMenuTableText, isFormTableText, isNoResultsText, isIrrelevantTable,
         isMeaningfulReportRow, extractApellidos,
         patientHeaderMatches, extractHeaderName } from "./lib.js";
import { parsePdfToLabValues, findPdfFrameUrl } from "./pdf-extract.js";

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

// Dry-run: recorre todo el flujo de WinLab (login → búsqueda → drill-down)
// pero NO escribe en Supabase. Actívalo con DRY_RUN=1 o el argumento --dry-run.
const DRY_RUN = ENV("DRY_RUN", "0") === "1"
  || ENV("DRY_RUN", "").toLowerCase() === "true"
  || process.argv.includes("--dry-run");

// Selectores del formulario de busqueda WinLab (descubiertos via explorador).
const WL_SEARCH_EXP_SEL         = ENV("WL_SEARCH_EXP_SEL", "#pnlMain_pnlPaziente_txtCodicePaziente");
const WL_SEARCH_COGNOME_SEL     = ENV("WL_SEARCH_COGNOME_SEL", "#pnlMain_pnlPaziente_txtCognome");
const WL_SEARCH_NOME_SEL        = ENV("WL_SEARCH_NOME_SEL", "#pnlMain_pnlPaziente_txtNome");
const WL_SEARCH_FECHA_DE_SEL    = ENV("WL_SEARCH_FECHA_DE_SEL", "#pnlMain_pnlReferti_txtDataRefertoDa");
const WL_SEARCH_FECHA_A_SEL     = ENV("WL_SEARCH_FECHA_A_SEL", "#pnlMain_pnlReferti_txtDataRefertoA");
const WL_SEARCH_BTN_SEL         = ENV("WL_SEARCH_BTN_SEL", "#Intestazione_DBToolbar_pnlCerca_btnCerca");
const WL_SEARCH_CLEAR_SEL       = ENV("WL_SEARCH_CLEAR_SEL", "#Intestazione_DBToolbar_pnlPulisci_btnPulisci");
// Selector de la pestaña "Por Temporalidad" de WinLab. Cuando está configurado
// el scraper hace clic en ella antes de llenar el formulario de fechas+apellido.
// Ejemplo: "#TabTemporalidad a, .tab-temporalidad, li[data-tab='fecha'] a"
const WL_TEMPORALIDAD_TAB_SEL   = ENV("WL_TEMPORALIDAD_TAB_SEL", "");
const WL_LOOKBACK_DAYS          = parseInt(ENV("WL_LOOKBACK_DAYS", "2"), 10);  // HOY + AYER
const WL_DATE_FORMAT            = ENV("WL_DATE_FORMAT", "dd/MM/yyyy");
// Dropdown "Profilo Consultazione" — WinLab requiere seleccionarlo para que
// los filtros de fecha apliquen. Valores: "AYER Y HOY" | "HOY" | "SEMANA" | "MES".
// Si está vacío, se omite (compatible con instalaciones de WinLab que no lo tengan).
const WL_PROFILO_SEL            = ENV("WL_PROFILO_SEL", "#pnlMain_cboProfiloConsultazioneRichiesteRicerca");
const WL_PROFILO_VALUE          = ENV("WL_PROFILO_VALUE", "AYER Y HOY");
const WL_PER_PATIENT_TIMEOUT    = parseInt(ENV("WL_PER_PATIENT_TIMEOUT", "30000"), 10);
const WL_DRILLDOWN              = parseInt(ENV("WL_DRILLDOWN", "1"), 10);          // 0 = solo lista, 1 = clickear cada reporte
const WL_DRILLDOWN_MAX          = parseInt(ENV("WL_DRILLDOWN_MAX", "2"), 10);      // max reportes/paciente
const WL_DRILLDOWN_TIMEOUT      = parseInt(ENV("WL_DRILLDOWN_TIMEOUT", "20000"), 10);
// Pausa entre pacientes (ms) para no saturar WinLab con requests rapidos.
// WinLab throttlea/resetea la conexion si recibe demasiadas busquedas seguidas.
const WL_INTER_PATIENT_DELAY_MS = parseInt(ENV("WL_INTER_PATIENT_DELAY_MS", "5000"), 10);

// Flag para mostrar diagnóstico __cells solo una vez por ejecución.
let _firstCellsDumped = false;

// ── Helpers ────────────────────────────────────────────────────────────
// Wrapper local para fechas con el formato configurado por env.
const formatDate = (date) => _formatDate(date, WL_DATE_FORMAT);

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
// Un solo intento por paciente: primer + segundo apellido concatenados en
// txtCognome (ej. "MARTINEZ ROLDAN"). Sin fallbacks — los pacientes no están
// registrados por expediente en WinLab, y buscar por un solo apellido genera
// timeouts por exceso de homónimos. Si no hay resultados → sin labs en el rango.
async function searchAndScrapeOne(page, searchUrl, paciente) {
  const apellidos = extractApellidos(paciente.nombre);
  const cognome   = apellidos[0] || "";   // ej. "MARTINEZ ROLDAN"
  if (!cognome) {
    console.log(`       [skip] Sin apellidos extraíbles para: "${paciente.nombre || "(sin nombre)"}"`);
    return { rows: [], headers: [], tableCount: 0, bestTableIdx: -1, noResults: true };
  }
  console.log(`       [busqueda] Apellidos → txtCognome: "${cognome}"`);
  return await doSingleSearch(page, searchUrl, paciente, {
    codice: null, cognome, tag: `apellidos="${cognome}"`,
  });
}

// Una sola tentativa de busqueda con parametros explicitos.
// Wrap con retry interno para "Execution context was destroyed" — error
// transitorio cuando la pagina navega justo durante un page.evaluate
// (frecuente en cascada de busquedas seguidas).
async function doSingleSearch(page, searchUrl, paciente, params) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await doSingleSearchInner(page, searchUrl, paciente, params);
    } catch (e) {
      lastErr = e;
      const msg = e?.message || "";
      if (attempt === 0 && /Execution context was destroyed|Target closed|Navigation failed/.test(msg)) {
        console.log(`       (retry tras: ${msg.split("\n")[0]})`);
        // Pequena pausa explicita para dejar que la navegacion termine.
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function doSingleSearchInner(page, searchUrl, paciente, params) {
  // Volver a la pantalla de busqueda fresca (limpia el form previo).
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  // Esperar a que TODA la red descanse para evitar "context destroyed"
  // en operaciones siguientes (typical de ASP.NET con AJAX in-flight).
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  // Si hay una pestaña de temporalidad configurada, hacer clic en ella
  // antes de llenar el formulario (el formulario de esa pestaña tiene los
  // campos de fecha y apellido que el médico usa manualmente: HOY+AYER + apellidos).
  if (WL_TEMPORALIDAD_TAB_SEL) {
    const tabEl = page.locator(WL_TEMPORALIDAD_TAB_SEL);
    const tabCount = await tabEl.count();
    if (tabCount > 0) {
      console.log(`       [tab] Haciendo clic en pestaña temporalidad (${tabCount} matches)`);
      await tabEl.first().click({ force: true, timeout: 5000 }).catch(async () => {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.click();
        }, WL_TEMPORALIDAD_TAB_SEL).catch(() => {});
      });
      await waitForAspNetReady(page, 8000);
    } else {
      console.log(`       [tab] WL_TEMPORALIDAD_TAB_SEL="${WL_TEMPORALIDAD_TAB_SEL}" no encontrado — continuando sin cambiar pestaña`);
    }
  }

  await page.locator(WL_SEARCH_EXP_SEL).waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });

  // PASO 1: seleccionar el perfil temporal ("AYER Y HOY") ANTES de escribir los
  // apellidos. Replica el flujo manual del médico (elegir el perfil y luego
  // teclear apellidos) y evita que el postback AJAX del dropdown borre el campo
  // de apellido si se llenara antes.
  const usandoProfilo = !!(WL_PROFILO_SEL && WL_PROFILO_VALUE);
  if (usandoProfilo) {
    const profiloEl = page.locator(WL_PROFILO_SEL);
    if (await profiloEl.count()) {
      try {
        await profiloEl.first().selectOption({ label: WL_PROFILO_VALUE });
        console.log(`       profilo: seleccionado "${WL_PROFILO_VALUE}"`);
        await waitForAspNetReady(page, 5000);
      } catch (e) {
        // Fallback: intentar por valor en vez de label
        try {
          await profiloEl.first().selectOption({ value: WL_PROFILO_VALUE });
          console.log(`       profilo: seleccionado por value "${WL_PROFILO_VALUE}"`);
          await waitForAspNetReady(page, 5000);
        } catch (e2) {
          console.log(`       profilo: NO se pudo seleccionar "${WL_PROFILO_VALUE}" (${e2?.message?.slice(0, 100) || e2})`);
        }
      }
    }
  }

  // PASO 2: escribir el filtro de paciente (apellidos, o código si se pasó).
  if (params.codice) {
    await setField(page, WL_SEARCH_EXP_SEL, String(params.codice), `[${params.tag}]`);
  }
  if (params.cognome) {
    if (await page.locator(WL_SEARCH_COGNOME_SEL).count()) {
      await setField(page, WL_SEARCH_COGNOME_SEL, String(params.cognome), `[${params.tag}]`);
    }
  }

  // PASO 3: rango de fechas manual SOLO si NO hay perfil temporal configurado.
  // CRÍTICO: el perfil "AYER Y HOY" ya define el rango server-side. Rellenar
  // además los campos de fecha (como hacía antes) entra en conflicto con el
  // perfil y deja el rango vacío → WinLab devuelve "NINGUN REGISTRO" para todos.
  // El flujo manual del médico que sí funciona es: perfil + apellidos, sin fechas.
  if (!usandoProfilo && WL_LOOKBACK_DAYS >= 0) {
    const fechaDe = formatDate(daysAgo(WL_LOOKBACK_DAYS));
    const fechaA  = formatDate(new Date());
    if (await page.locator(WL_SEARCH_FECHA_DE_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_DE_SEL, fechaDe, "fechaDe");
    }
    if (await page.locator(WL_SEARCH_FECHA_A_SEL).count()) {
      await setField(page, WL_SEARCH_FECHA_A_SEL, fechaA, "fechaA");
    }
  }

  // Click "Busca" (postback AJAX, esperamos via waitForAspNetReady).
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

    const FORM_MARKERS = [
      // Pre-search header y post-search header (AJAX cambia BUSCA→LISTA tras click Busca)
      "BUSCA REPORTES", "LISTA REPORTES", "TODAS LAS UNIDADES ORGANIZATIVAS",
      "PACIENTE APELLIDO NOMBRE", "FECHA REPORTE DE A",
      "CON RESULTADOS", "UNIDAD SOLICITANTE", "CODIGO PACIENTE",
      "REPORTES IMPRESOS", "FECHA DE TOMA", "CODIGO TOMA",
    ];
    const isMenu = (txt) => txt.includes("INICIO REPORTES AYUDA");
    const isForm = (txt) => {
      const head = txt.slice(0, 1500);
      let hits = 0;
      for (const m of FORM_MARKERS) if (head.includes(m)) hits++;
      return hits >= 2;
    };
    const isNoResults = (txt) =>
      /NING(U|Ú)N REGISTRO ENCONTRADO/.test(txt) || /NESSUN REGISTRO/.test(txt);

    const tables = Array.from(document.querySelectorAll("table"));

    // Si en CUALQUIER lugar de la pagina sale "Ningún Registro", el paciente
    // no tiene labs en el rango. Devolvemos 0 reportes (no falsos positivos).
    const fullText = norm(document.body?.innerText || "");
    if (isNoResults(fullText)) {
      return { headers: [], rows: [], tableCount: tables.length, bestTableIdx: -1, noResults: true };
    }

    // Elegir la tabla con más filas de datos reales.
    // NO usamos isForm() aquí porque la tabla de resultados de WinLab contiene
    // los mismos marcadores que el formulario ("LISTA REPORTES", "PACIENTE APELLIDO
    // NOMBRE", "CODIGO PACIENTE") — son también headers de columna en los resultados.
    // En cambio, contamos filas con >= 3 celdas no-vacías:
    //   - Tabla de resultados: fecha + paciente + examen + estado + ... = 5-6 celdas → cuenta
    //   - Tabla de formulario: label + input-vacío = 1-2 celdas → NO cuenta
    //   - Tabla de layout/spacer: todas vacías → NO cuenta
    let best = null, bestRows = 0, bestTableIdx = -1;
    const tableScores = [];
    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti];
      const txt = norm(t.innerText);
      if (isMenu(txt)) { tableScores.push({ ti, score: 0, reason: "menu" }); continue; }
      const allTrs = Array.from(t.querySelectorAll("tr"));
      if (allTrs.length < 2) { tableScores.push({ ti, score: 0, reason: "single-row" }); continue; }
      let contentRows = 0;
      for (const tr of allTrs) {
        const cells = Array.from(tr.querySelectorAll("td,th"))
          .map((c) => norm(c.innerText)).filter((c) => c.length > 0);
        if (cells.length >= 3) contentRows++;
      }
      const ths = t.querySelectorAll("th").length;
      const score = contentRows * (1 + (ths > 0 ? 1 : 0));
      tableScores.push({ ti, score, contentRows, trs: allTrs.length });
      if (score > bestRows) { best = t; bestRows = score; bestTableIdx = ti; }
    }
    // Fallback: si ninguna tabla tiene filas de contenido denso, elegir la mas
    // grande excluyendo solo menu (comportamiento anterior).
    if (!best) {
      for (let ti = 0; ti < tables.length; ti++) {
        const t = tables[ti];
        if (isMenu(norm(t.innerText))) continue;
        const trs = t.querySelectorAll("tr").length;
        const ths = t.querySelectorAll("th").length;
        if (trs < 1) continue;
        const score = trs * (1 + (ths > 0 ? 1 : 0));
        if (score > bestRows) { best = t; bestRows = score; bestTableIdx = ti; }
      }
    }
    if (!best) return { headers: [], rows: [], tableCount: tables.length, bestTableIdx: -1, tableScores };

    const trs = Array.from(best.querySelectorAll("tr"));
    let headers = [];
    let headerIdx = -1;

    // 1) Buscar fila con TH (estandar HTML).
    for (let i = 0; i < trs.length; i++) {
      const ths = Array.from(trs[i].querySelectorAll("th"));
      if (ths.length >= 2) {
        headers = ths.map((c) => norm(c.innerText));
        headerIdx = i;
        break;
      }
    }
    // 2) Si no, primera fila con TDs cortos y no vacios.
    if (headerIdx < 0) {
      for (let i = 0; i < Math.min(3, trs.length); i++) {
        const tds = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (tds.length >= 3 && tds.filter((t) => t.length > 0 && t.length < 30).length >= 2) {
          headers = tds;
          headerIdx = i;
          break;
        }
      }
    }
    // 3) Fallback: tomar SIEMPRE la primera fila como headers (aunque
    //    esten vacios o raros) para no perder el mapeo posicional.
    if (headerIdx < 0 && trs.length > 0) {
      const firstCells = Array.from(trs[0].querySelectorAll("th, td"))
        .map((c) => norm(c.innerText));
      if (firstCells.length > 0) {
        headers = firstCells.map((c, idx) => c || `COL_${idx}`);
        headerIdx = 0;
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

    // Diagnóstico: cuando la tabla "best" existe pero no produce filas,
    // volcar su estructura para entender si los datos están en otro lugar.
    let zeroRowsDiag = null;
    if (rows.length === 0 && best && headerIdx >= 0) {
      zeroRowsDiag = {
        totalTrs: trs.length,
        headerIdx,
        firstRowTags: Array.from(trs[0]?.children || []).map((c) => c.tagName).join(","),
        firstRowText: Array.from(trs[0]?.querySelectorAll("th,td") || [])
          .map((c) => (c.innerText || "").trim().slice(0, 40)).slice(0, 8),
        dataRowSample: trs[headerIdx + 1]
          ? Array.from(trs[headerIdx + 1].querySelectorAll("td,th,span,div"))
              .slice(0, 8).map((c) => [(c.tagName || ""), (c.innerText || "").trim().slice(0, 40)])
          : null,
        bestScore: bestRows,
        tableScores,
      };
    }

    return { headers, rows, tableCount: tables.length, bestTableIdx, headerIdx, zeroRowsDiag };
  });

  // Filtrar reportes basura: filas que solo tengan COL_X/__hasLink/etc
  // (= la heuristica capto el menu/form, no datos reales). Se descartan
  // ANTES del drill-down para no clickear cosas que no son reportes.
  if (Array.isArray(result.rows) && result.rows.length > 0) {
    const before = result.rows.length;
    const firstRowSample = result.rows[0];
    result.rows = result.rows.filter(isMeaningfulReportRow);
    const filtered = before - result.rows.length;
    if (filtered > 0) {
      console.log(`       (filtradas ${filtered} filas basura: solo COL_X o markers de menu)`);
      // Diagnóstico una vez: muestra __cells y keys de la primera fila filtrada
      // para entender qué estructura tiene la tabla de resultados real en WinLab.
      if (!_firstCellsDumped && result.rows.length === 0) {
        _firstCellsDumped = true;
        console.log(`       <<<CELLS>>> __cells=${JSON.stringify(firstRowSample.__cells)}`);
        console.log(`       <<<CELLS>>> keys=${JSON.stringify(Object.keys(firstRowSample))}`);
      }
    }
  }

  // ── DRILL-DOWN: para cada reporte, click y extraer valores reales ──
  if (WL_DRILLDOWN === 1 && result.rows.length > 0 && result.bestTableIdx >= 0) {
    // TARGETING (jun 2026): WinLab busca por apellido y devuelve VARIOS homónimos.
    // Drilleamos SOLO los reportes del paciente OBJETIVO (agrupando por fila-encabezado
    // FEMENINO/MASCULINO y matcheando el nombre), no los primeros N a ciegas — eso
    // causaba que el 4º de 5 "GONZALEZ GONZALEZ" nunca se capturara y el blob quedara
    // con labs de otro paciente. FALLBACK SEGURO: si no se identifica al objetivo por
    // encabezado (tabla COL_X / sin sexo), se usa el comportamiento legacy (primeros N).
    const targetIdxs = [], linkIdxs = [];
    let curMatches = false;
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      const hdrName = extractHeaderName(row.__cells);
      if (hdrName) curMatches = patientHeaderMatches(hdrName, paciente.nombre);
      if (row.__hasLink) {
        linkIdxs.push(i);
        if (curMatches) targetIdxs.push(i);
      }
    }
    let drillIdxs;
    if (targetIdxs.length) {
      drillIdxs = targetIdxs.slice(0, WL_DRILLDOWN_MAX);
      console.log(`       [targeting] ${targetIdxs.length} reporte(s) del objetivo identificados; drilleando ${drillIdxs.length}`);
    } else {
      drillIdxs = linkIdxs.slice(0, WL_DRILLDOWN_MAX);
      console.log(`       [targeting] objetivo no identificado por encabezado → fallback: primeros ${drillIdxs.length}`);
    }
    // dumpFirst = true solo en la PRIMERA llamada real a drillDownReport.
    let firstDrilldownDone = false;
    for (const i of drillIdxs) {
      const row = result.rows[i];
      const dumpFirst = !firstDrilldownDone;
      firstDrilldownDone = true;
      try {
        const valores = await drillDownReport(page, searchUrl, paciente, result.bestTableIdx, row.__rowIdxInTable, dumpFirst);
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
// ════════════════════════════════════════════════════════════════════════
// PDF EXTRACTION — la lógica vive en pdf-extract.js (testeable sin Playwright)
// Aquí solo se usan: parsePdfToLabValues(buffer), findPdfFrameUrl(popupPage)
// ════════════════════════════════════════════════════════════════════════

// ── DRILL-DOWN: para cada reporte, click → popup → frame PDF → descargar → parsear ──

async function drillDownReport(page, searchUrl, paciente, tableIdx, rowIdxInTable, dumpFirst) {
  const link = page.locator("table").nth(tableIdx)
    .locator("tr").nth(rowIdxInTable)
    .locator('a, input[type="image"], input[type="button"], input[type="submit"]').first();
  const linkCount = await link.count();
  if (!linkCount) return null;

  // ────────────────────────────────────────────────────────────────────────────
  // FIX RAÍZ (May 2026): WinLab abre el detalle del reporte (WinReferral.htm)
  // en una NUEVA VENTANA/PESTAÑA emergente, no como postback AJAX en la misma
  // página. El código anterior nunca cambiaba de contexto y terminaba parseando
  // la página de búsqueda (lista de reportes) como si fuera detalle, lo que
  // producía "valores" con estudio="22/05/2026 14:11" y valor="2605221486"
  // (códigos de reporte) en vez de Hb/Leu/Plaq/etc.
  //
  // Solución: suscribirse al evento "page" del contexto ANTES del click;
  // si abre popup trabajamos con él, si no abre (fallback) usamos page como antes.
  // ────────────────────────────────────────────────────────────────────────────
  const ctx = page.context();
  const popupPromise = ctx.waitForEvent("page", { timeout: 4000 }).catch(() => null);

  // Click del link de detalle.
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

  // Race: popup vs postback. Resolver cuál tipo de instalación es.
  const popup = await popupPromise;
  let detailPage;
  let popupOpened = false;
  if (popup) {
    popupOpened = true;
    detailPage = popup;
    if (dumpFirst) console.log(`       [drilldown] POPUP detectado: ${detailPage.url()}`);

    // ────────────────────────────────────────────────────────────────────────
    // VÍA PRINCIPAL: interceptar la respuesta del browser al cargar EditPDF.aspx
    //
    // DESCUBRIMIENTO (May 2026 iter 3): EditPDF.aspx?FileName=...pdf retorna
    // un HTML wrapper de Microsoft Visual Studio, NO el PDF directo. El PDF
    // binario real viene en una request SEPARADA que hace ese HTML wrapper
    // (vía <embed>, <iframe>, o JavaScript).
    //
    // SOLUCIÓN v4:
    //   - Escuchar TODAS las responses del popup (no solo EditPDF)
    //   - Capturar la que tenga magic bytes %PDF o content-type application/pdf
    //   - Loggear el HTML wrapper completo para diagnosticar si no captura PDF
    // ────────────────────────────────────────────────────────────────────────
    let capturedPdfBuffer = null;
    let capturedPdfUrl = null;
    let capturedHtmlWrapper = null;
    const responseListener = async (response) => {
      const url = response.url();
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      try {
        const body = await response.body();
        // 1) Capturar cualquier PDF binario (de cualquier URL del popup)
        const isPdfBinary = body.length >= 4 && body.slice(0, 4).toString() === '%PDF';
        if (isPdfBinary || (ct.includes('pdf') && body.length > 1000)) {
          capturedPdfBuffer = body;
          capturedPdfUrl = url;
        }
        // 2) Capturar el HTML wrapper de EditPDF para diagnosticar si falla
        else if (/EditPDF\.aspx/i.test(url) && ct.includes('html')) {
          capturedHtmlWrapper = body.toString('utf-8');
        }
      } catch (_) { /* response.body() puede fallar si la página cerró */ }
    };
    detailPage.on("response", responseListener);

    // AHORA esperar la carga del popup — el frame del PDF se cargará durante esto,
    // disparando el response listener.
    await detailPage.waitForLoadState("domcontentloaded", { timeout: WL_DRILLDOWN_TIMEOUT }).catch(() => {});
    await detailPage.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    // Espera ACTIVA: si el HTML wrapper carga el PDF binario en una request posterior
    // (vía <iframe>, <embed> lazy, o JS), darle tiempo para que llegue.
    // Salimos en cuanto capturemos PDF, o tras 8s si no hay más actividad.
    const WAIT_PDF_MS = 8000;
    const CHECK_INTERVAL = 250;
    const startedWaiting = Date.now();
    while (!capturedPdfBuffer && (Date.now() - startedWaiting) < WAIT_PDF_MS) {
      if (detailPage.isClosed()) break;
      await detailPage.waitForTimeout(CHECK_INTERVAL).catch(() => {});
    }

    // Verificar también el frame (para logging)
    const pdfInfo = await findPdfFrameUrl(detailPage, 4);

    if (pdfInfo) {
      console.log(`       [drilldown] PDF frame detectado: FileName=${pdfInfo.fileName}`);
    }

    if (capturedPdfBuffer) {
      console.log(`       [drilldown] PDF capturado del browser: ${capturedPdfBuffer.length} bytes (url=${capturedPdfUrl})`);
      const valoresPDF = await parsePdfToLabValues(capturedPdfBuffer, 10000);
      console.log(`       [drilldown] PDF parseado: ${valoresPDF.length} valores`);

      // Cleanup popup antes de retornar
      detailPage.off("response", responseListener);
      try {
        if (detailPage && !detailPage.isClosed()) await detailPage.close();
      } catch (_) { /* best-effort cleanup */ }

      return valoresPDF;
    }

    // ────────────────────────────────────────────────────────────────────────
    // V5: FETCH DIRECTO DEL PDF ESTÁTICO
    //
    // DESCUBRIMIENTO (May 2026 iter 5): EditPDF.aspx retorna HTML wrapper que
    // ejecuta `showPdfTimeOut('../Temp/.../UUID.pdf')` para crear un <embed>.
    // En Chromium headless NO hay plugin de PDF → el <embed> falla silenciosamente,
    // el browser NO descarga el PDF, mi listener nunca lo ve.
    //
    // SOLUCIÓN: extraer la ruta del PDF del wrapper y hacer ctx.request.get()
    // directo. A diferencia de EditPDF.aspx (ASP.NET WebForms con ViewState),
    // /Temp/.../UUID.pdf es un ARCHIVO ESTÁTICO servido por IIS directamente,
    // sin pipeline ASP.NET. Las cookies de sesión bastan para autorizar.
    // ────────────────────────────────────────────────────────────────────────
    if (!capturedPdfBuffer && capturedHtmlWrapper) {
      // Extraer la ruta relativa del PDF del onload script
      const pdfPathMatch = capturedHtmlWrapper.match(
        /showPdfTimeOut\(\s*['"]([^'"]+\.pdf)['"]/i
      );
      if (pdfPathMatch) {
        const relPath = pdfPathMatch[1]; // p.ej. "../Temp/hash/uuid.pdf"
        try {
          // Construir URL absoluta resolviendo relativo a la URL del popup
          const popupUrl = detailPage.url();
          const pdfUrl = new URL(relPath, popupUrl).toString();
          if (dumpFirst) {
            console.log(`       [drilldown] v5: descargando PDF directo: ${pdfUrl}`);
          }
          // ctx.request.get() hereda cookies del browser context (sesión WinLab)
          const apiResp = await ctx.request.get(pdfUrl, { timeout: 15000 });
          if (apiResp.ok()) {
            const body = await apiResp.body();
            const isPdf = body.length >= 4 && body.slice(0, 4).toString() === '%PDF';
            if (isPdf && body.length > 500) {
              console.log(`       [drilldown] v5: PDF descargado directo: ${body.length} bytes`);
              const valoresPDF = await parsePdfToLabValues(body, 10000);
              console.log(`       [drilldown] v5: PDF parseado: ${valoresPDF.length} valores`);

              // Cleanup popup antes de retornar
              detailPage.off("response", responseListener);
              try {
                if (detailPage && !detailPage.isClosed()) await detailPage.close();
              } catch (_) { /* best-effort cleanup */ }

              return valoresPDF;
            } else if (dumpFirst) {
              console.log(`       [drilldown] v5: response no es PDF válido (${body.length} bytes, magic=${body.slice(0, 8).toString('hex')})`);
            }
          } else if (dumpFirst) {
            console.log(`       [drilldown] v5: HTTP ${apiResp.status()} ${apiResp.statusText()}`);
          }
        } catch (err) {
          if (dumpFirst) {
            console.log(`       [drilldown] v5: error en fetch directo: ${err.message}`);
          }
        }
      } else if (dumpFirst) {
        console.log(`       [drilldown] v5: no se encontró showPdfTimeOut(...) en HTML wrapper`);
      }
    }

    // Diagnóstico: si capturamos el HTML wrapper pero no el PDF, loggear
    // los primeros 3000 chars del HTML para entender su estructura.
    if (capturedHtmlWrapper && dumpFirst) {
      console.log(`       [drilldown] HTML wrapper de EditPDF (3000 chars):`);
      console.log(`==========================================`);
      console.log(capturedHtmlWrapper.substring(0, 3000));
      console.log(`==========================================`);
      // Buscar referencias a otras URLs .pdf dentro del HTML
      const pdfRefs = capturedHtmlWrapper.match(/[\w\/\.\?=&-]+\.pdf[\w\?=&-]*/gi) || [];
      console.log(`       [drilldown] URLs .pdf encontradas en HTML wrapper: ${JSON.stringify(pdfRefs.slice(0, 5))}`);
    }

    detailPage.off("response", responseListener);
    if (dumpFirst) {
      if (pdfInfo) {
        console.log(`       [drilldown] PDF frame detectado pero browser no entregó body — fallback DOM`);
      } else {
        console.log(`       [drilldown] No se detectó frame con PDF — intentando DOM scrape`);
      }
    }
    // Si llegamos aquí, no capturamos PDF utilizable: continuar con DOM scrape (fallback)
  } else {
    detailPage = page;
    if (dumpFirst) console.log(`       [drilldown] No hubo popup; usando página actual (postback AJAX)`);
    await waitForAspNetReady(page, WL_DRILLDOWN_TIMEOUT);
  }

  // Scrapear cualquier tabla en la pantalla de detalle que parezca tener
  // estudios/valores. Heuristica: buscar tablas con >= 3 columnas donde
  // la primera columna tiene texto y al menos otra columna parece numero/valor.
  // NOTA: usamos detailPage (popup si abrió, page si no) para no parsear la
  // página de búsqueda por accidente.
  const detail = await detailPage.evaluate(() => {
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
      // WinLab es italiano — soportar ES + EN + IT en todos los términos.
      const HDR_RE = /^(ESTUDIO|EXAMEN|ANALISIS|ANALISI|ANALITA|ESAME|PRUEBA|TEST|NOMBRE|DESCRIPCION|PARAMETRO|COMPONENTE|DETERMINAZIONE|RESULTADO|VALOR|VAL|RISULTATO|VALORE|REFERTO|ESITO|UNIDADES|UNIDAD|U\.M\.|UM|UNITA|UNITA'|REFERENCIA|RANGO|V\.R\.|VR|RANGO REFERENCIAL|VALORI DI RIFERIMENTO|RANGE|INTERVALLO|VALORI NORMALI)$/;
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
        if (tds.some((c) => HDR_RE.test(c))) {
          headers = tds;
          headerIdx = i;
          break;
        }
      }

      const idx = (re) => headers.findIndex((h) => re.test(h));
      let cE = idx(/^(ESTUDIO|EXAMEN|ANALISIS|ANALISI|ANALITA|ESAME|PRUEBA|TEST|NOMBRE|DESCRIPCION|PARAMETRO|COMPONENTE|DETERMINAZIONE)$/);
      let cV = idx(/^(RESULTADO|VALOR|VAL|RISULTATO|VALORE|REFERTO|ESITO)$/);
      let cU = idx(/^(UNIDADES|UNIDAD|U\.M\.|UM|UNITA|UNITA')$/);
      let cR = idx(/^(REFERENCIA|RANGO|V\.R\.|VR|RANGO REFERENCIAL|VALORI DI RIFERIMENTO|RANGE|INTERVALLO|VALORI NORMALI)$/);

      // Fallback: si no hay header reconocible, intentar deteccion posicional:
      // escanear filas de datos buscando col con texto largo (estudio)
      // y col con valor numerico. Aplica si hay >= 3 cols y >= 3 filas de datos.
      if ((headerIdx < 0 || cE < 0 || cV < 0) && trs.length >= 3) {
        const isNum = (s) => s.length > 0 && /^[<>≤≥]?\s*[\d]+[\d.,\s]*$/.test(s);
        const isText = (s) => s.length >= 2 && s.length <= 60 && /[A-Z]/.test(s) && !/^\d/.test(s);
        const sampleStart = headerIdx >= 0 ? headerIdx + 1 : 0;
        const sample = [];
        for (let i = sampleStart; i < Math.min(sampleStart + 6, trs.length); i++) {
          const cells = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
          if (cells.length >= 2) sample.push(cells);
        }
        if (sample.length >= 2) {
          const colCount = Math.max(...sample.map((r) => r.length));
          let textScores = new Array(colCount).fill(0);
          let numScores  = new Array(colCount).fill(0);
          for (const row of sample) {
            for (let ci = 0; ci < row.length; ci++) {
              if (isText(row[ci])) textScores[ci]++;
              if (isNum(row[ci]))  numScores[ci]++;
            }
          }
          if (cE < 0) {
            const bestText = textScores.indexOf(Math.max(...textScores));
            if (textScores[bestText] >= 2) cE = bestText;
          }
          if (cV < 0) {
            const bestNum  = numScores.indexOf(Math.max(...numScores));
            if (numScores[bestNum] >= 2) cV = bestNum;
          }
          // headerIdx remains -1 when positional: loop will start from row 0
        }
      }

      // Solo continuar si tenemos al menos columna de estudio y valor.
      // headerIdx=-1 es valido cuando el fallback posicional encontro cE/cV.
      if (cE < 0 || cV < 0) continue;

      const dataStart = headerIdx >= 0 ? headerIdx + 1 : 0;
      for (let i = dataStart; i < trs.length; i++) {
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

  // ────────────────────────────────────────────────────────────────────────────
  // VALIDACIÓN ANTI-CONFUSIÓN: si los headers extraídos son de la pantalla de
  // búsqueda (no de detalle), descartar valores. Esto sucede si el click no
  // navegó a detalle real (link muerto, popup bloqueado, etc.) y terminamos
  // parseando la lista de reportes como si fuera tabla de valores.
  // ────────────────────────────────────────────────────────────────────────────
  if (detail && Array.isArray(detail.headers)) {
    const SEARCH_PAGE_HEADERS_RE = /CODIGO PACIENTE|APELLIDOS COMPLETOS|FECHA DE NAC|UNIDAD SOLICITANTE|REPORTES IMPRESOS/i;
    const matchesSearchHeaders = detail.headers.some(h => SEARCH_PAGE_HEADERS_RE.test(String(h || "")));
    if (matchesSearchHeaders) {
      if (dumpFirst) {
        console.log(`       [drilldown] DESCARTADO — headers parecen ser de búsqueda, no detalle: ${JSON.stringify(detail.headers)}`);
      }
      detail.valores = [];
    }
  }

  if (dumpFirst && (!detail.valores || !detail.valores.length)) {
    console.log(`       <<<DETAIL>>> URL=${detail.url}`);
    const allTables = await detailPage.evaluate(() => {
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

  // ────────────────────────────────────────────────────────────────────────────
  // CLEANUP — distinto según si abrió popup o no:
  //
  //   Si abrió popup → cerrar el popup. La página original (lista de reportes)
  //                    sigue intacta; la siguiente iteración del drill-down
  //                    encuentra los mismos índices de fila sin tener que
  //                    re-ejecutar la búsqueda.
  //
  //   Si NO abrió popup → flujo viejo: volver a la pantalla de búsqueda y
  //                       re-ejecutar la query con perfil + apellido para
  //                       que los índices de tabla sean válidos otra vez.
  // ────────────────────────────────────────────────────────────────────────────
  if (popupOpened) {
    try {
      if (detailPage && !detailPage.isClosed()) await detailPage.close();
    } catch (_) { /* best-effort cleanup */ }
  } else {
    // Volver a la pantalla de busqueda y re-ejecutar la busqueda con el MISMO
    // flujo que doSingleSearchInner (perfil primero → apellidos → sin fechas
    // manuales) para que la siguiente fila siga teniendo indices validos.
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const reUsandoProfilo = !!(WL_PROFILO_SEL && WL_PROFILO_VALUE);
    if (reUsandoProfilo) {
      const profiloEl = page.locator(WL_PROFILO_SEL);
      if (await profiloEl.count()) {
        await profiloEl.first().selectOption({ label: WL_PROFILO_VALUE })
          .catch(() => profiloEl.first().selectOption({ value: WL_PROFILO_VALUE }))
          .catch(() => {});
        await waitForAspNetReady(page, 5000);
      }
    }
    // Re-buscar por apellidos (igual que la busqueda principal; el expediente no
    // esta registrado en WinLab).
    const reCognome = extractApellidos(paciente.nombre)[0] || "";
    if (reCognome && await page.locator(WL_SEARCH_COGNOME_SEL).count()) {
      await setField(page, WL_SEARCH_COGNOME_SEL, reCognome, `re-apellidos="${reCognome}"`);
    }
    if (!reUsandoProfilo && WL_LOOKBACK_DAYS >= 0) {
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
  }

  return detail.valores || [];
}

// Procesa todo el censo en serie con aislamiento por paciente.
// Cada paciente recibe su propia Page (creada del mismo BrowserContext
// para preservar la sesion de WinLab) y se destruye en finally para
// evitar fuga de memoria. Circuit breaker: 45s por paciente. Si el
// browser entero colapsa, abortamos el bucle (el contexto/proceso de
// Chrome esta muerto y no se va a recuperar).
async function scrapeForCenso(page, searchUrl, censo) {
  console.log(`[4/5] Buscando labs paciente por paciente (${censo.length} pacientes)...`);
  const records = [];
  const fechaToday = todayISO();
  const scraped_at = new Date().toISOString();
  const ctx = page.context();
  const PER_PATIENT_BUDGET_MS = 45000;
  let consecutiveErrors = 0;
  let firstDiagDumped = false;

  for (let i = 0; i < censo.length; i++) {
    const p = censo[i];
    const tag = `[${i + 1}/${censo.length}] exp=${p.exp} ${String(p.nombre || "").slice(0, 40)}`;
    let subPage = null;
    try {
      // Aislamiento: nueva Page por paciente, hereda cookies/sesion del contexto.
      subPage = await ctx.newPage();
      subPage.setDefaultNavigationTimeout(PER_PATIENT_BUDGET_MS);
      subPage.setDefaultTimeout(SEL_TIMEOUT_MS);

      // Circuit breaker: 45s estrictos por paciente via Promise.race.
      const work = searchAndScrapeOne(subPage, searchUrl, p);
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`timeout ${PER_PATIENT_BUDGET_MS}ms`)), PER_PATIENT_BUDGET_MS)
      );
      const res = await Promise.race([work, timeout]);

      const matched = res.rows.length;
      const tag2 = res.noResults ? `${matched} reportes [NINGUN REGISTRO]` : `${matched} reportes`;
      console.log(`       ${tag}: ${tag2} (tablas=${res.tableCount}, headers=[${res.headers.slice(0, 6).join(", ")}${res.headers.length > 6 ? ", ..." : ""}])`);

      // Diagnóstico: tabla encontrada pero 0 filas de datos.
      if (!firstDiagDumped && matched === 0 && !res.noResults && res.zeroRowsDiag) {
        firstDiagDumped = true;
        console.log(`       <<<ZERO-ROWS>>> best-table trs=${res.zeroRowsDiag.totalTrs} headerIdx=${res.zeroRowsDiag.headerIdx} score=${res.zeroRowsDiag.bestScore}`);
        console.log(`       <<<ZERO-ROWS>>> firstRowTags=${res.zeroRowsDiag.firstRowTags}`);
        console.log(`       <<<ZERO-ROWS>>> firstRowText=${JSON.stringify(res.zeroRowsDiag.firstRowText)}`);
        console.log(`       <<<ZERO-ROWS>>> dataRowSample=${JSON.stringify(res.zeroRowsDiag.dataRowSample)}`);
        if (res.zeroRowsDiag.tableScores) {
          console.log(`       <<<ZERO-ROWS>>> tableScores=${JSON.stringify(res.zeroRowsDiag.tableScores)}`);
        }
      }

      // Diagnostico unica vez si hay rows con headers raros.
      if (!firstDiagDumped && matched > 0 && (!res.headers.length || res.headers.every((h) => /^COL_\d+$/.test(h)))) {
        firstDiagDumped = true;
        console.log("       <<<DIAG>>> headers vacios o genericos. Dump de tablas:");
        try {
          const tablesDump = await subPage.evaluate(() => {
            return Array.from(document.querySelectorAll("table")).slice(0, 8).map((t, idx) => ({
              idx,
              rows: t.rows.length,
              rowsNested: t.querySelectorAll("tr").length,
              ths: t.querySelectorAll("th").length,
              firstRowTags: Array.from(t.rows[0]?.children || []).map((c) => c.tagName).join(","),
              firstRowText: Array.from(t.rows[0]?.children || [])
                .map((c) => (c.innerText || "").trim().slice(0, 40)).slice(0, 10),
              secondRowText: Array.from(t.rows[1]?.children || [])
                .map((c) => (c.innerText || "").trim().slice(0, 40)).slice(0, 10),
            }));
          });
          tablesDump.forEach((tb) => console.log(`       <<<DIAG TABLE ${tb.idx}>>> ${JSON.stringify(tb)}`));
        } catch (_) { /* dump best-effort */ }
      }

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
      const msg = err?.message?.split("\n")[0] || String(err);
      console.error(`       ${tag}: ERROR ${msg}`);

      // Manejo de fallo CRITICO: el navegador o contexto colapso. No tiene
      // sentido seguir intentando con los demas pacientes; hay que abortar
      // y dejar que el outer retry del workflow re-lance todo.
      if (/browser has been closed|context.*has been closed|Target page.*has been closed|Browser.*disconnected/i.test(msg)) {
        console.error(`       [CRITICO] Navegador colapsado. Abortando bucle (${i + 1}/${censo.length}).`);
        break;
      }
      // Tolerancia a errores transientes: 10 seguidos -> abort.
      if (consecutiveErrors >= 10) {
        console.error(`       [CRITICO] 10 fallos seguidos. Abortando bucle.`);
        break;
      }
    } finally {
      // SIEMPRE destruir la subPage para liberar memoria, exitosa o no.
      if (subPage) {
        try { await subPage.close(); } catch (_) { /* ignore */ }
      }
      // Pausa entre pacientes para no saturar WinLab (throttle prevention).
      if (i < censo.length - 1 && WL_INTER_PATIENT_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, WL_INTER_PATIENT_DELAY_MS));
      }
    }
  }
  console.log(`       OK busqueda. Pacientes con labs: ${records.length}/${censo.length}`);
  return records;
}

// ── 5. UPSERT MASIVO ───────────────────────────────────────────────────
async function upsert(supa, records) {
  const deduped = dedupRecords(records, SUPABASE_CONFLICT);
  if (deduped.length !== records.length) {
    console.log(`[5/5] Dedup: ${records.length} -> ${deduped.length} filas (claves duplicadas en censo: ${records.length - deduped.length})`);
  }

  if (DRY_RUN) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`[DRY-RUN] ✅  Simulación completa — NADA escrito en Supabase.`);
    console.log(`[DRY-RUN] Filas que se enviarían: ${deduped.length}`);
    console.log(`${"─".repeat(60)}`);
    for (const r of deduped) {
      const reportes = r.data?.reportes || [];
      const conValores = reportes.filter(rep => rep.valores?.length);
      const totalValores = reportes.reduce((n, rep) => n + (rep.valores?.length || 0), 0);
      const estado = reportes.length > 0
        ? `✓ ${reportes.length} reporte(s) | ${totalValores} valor(es) drill-down`
        : `✗ 0 reportes`;
      console.log(`[DRY-RUN]  exp=${String(r.exp).padEnd(12)} "${r.paciente || ""}"  →  ${estado}`);
      for (const rep of conValores.slice(0, 3)) {
        const muestra = rep.valores.slice(0, 4).map(v => `${v.estudio}=${v.valor}${v.unidad ? " " + v.unidad : ""}`).join("  |  ");
        const extra = rep.valores.length > 4 ? ` (+${rep.valores.length - 4} más)` : "";
        console.log(`[DRY-RUN]      └ ${muestra}${extra}`);
      }
    }
    console.log(`${"─".repeat(60)}\n`);
    return;
  }

  console.log(`[5/5] Upsert -> Supabase tabla="${SUPABASE_TABLE}" onConflict="${SUPABASE_CONFLICT}" (${deduped.length} filas)`);
  if (!deduped.length) {
    console.log("       0 filas para upsertear (ningun paciente con labs en el rango). Saliendo OK.");
    return;
  }
  const { error, count } = await supa
    .from(SUPABASE_TABLE)
    .upsert(deduped, { onConflict: SUPABASE_CONFLICT, count: "exact" });

  if (error) {
    throw new Error(`Supabase upsert fallo: ${error.message} (code=${error.code})`);
  }
  console.log(`       OK upsert. Filas afectadas: ${count ?? deduped.length}`);
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

  if (DRY_RUN) {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  MODO DRY-RUN ACTIVADO");
    console.log("  Recorre todo el flujo de WinLab pero NO escribe en Supabase.");
    console.log(`${"═".repeat(60)}\n`);
  }

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
      realtime: { transport: ws },
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
