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
const WINLAB_USER_SELECTOR   = ENV("WINLAB_USER_SELECTOR", '#Intestazione_TextBox1, input[name="Intestazione$TextBox1"], input[type="text"]:not([type="hidden"])');
const WINLAB_PASS_SELECTOR   = ENV("WINLAB_PASS_SELECTOR", '#Intestazione_TextBox2, input[name="Intestazione$TextBox2"], input[type="password"]');
const WINLAB_SUBMIT_SELECTOR = ENV("WINLAB_SUBMIT_SELECTOR", '#Intestazione_ImageButton1, input[name="Intestazione$ImageButton1"], #Intestazione_Button1, input[name="Intestazione$Button1"], button[type="submit"], input[type="submit"], input[type="image"]');
const WINLAB_TABLE_SELECTOR  = ENV("WINLAB_TABLE_SELECTOR", "table");
const WINLAB_LOGGED_SELECTOR = ENV("WINLAB_LOGGED_SELECTOR", "");
const WINLAB_NEXT_SELECTOR   = ENV("WINLAB_NEXT_SELECTOR", "");
const WINLAB_MAX_PAGES       = parseInt(ENV("WINLAB_MAX_PAGES", "30"), 10);
const NAV_TIMEOUT_MS         = parseInt(ENV("NAV_TIMEOUT_MS", "45000"), 10);
const SEL_TIMEOUT_MS         = parseInt(ENV("SEL_TIMEOUT_MS", "20000"), 10);

const SUPABASE_URL           = ENV("SUPABASE_URL");
const SUPABASE_SERVICE_KEY   = ENV("SUPABASE_SERVICE_KEY");
const SUPABASE_TABLE         = ENV("SUPABASE_TABLE", "winlab_labs");
const SUPABASE_CONFLICT      = ENV("SUPABASE_ON_CONFLICT", "exp,fecha");

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

// Fill robusto: funciona con campos visibles, hidden, o detras de overlays.
// Estrategia: 1) waitFor attached (el nodo existe en DOM, sin importar visibilidad)
//             2) intenta fill con force
//             3) fallback: setea value + dispara input/change events via JS
async function setField(page, selector, value, label) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });
  try {
    await loc.fill(value, { force: true, timeout: 5000 });
    return;
  } catch (e) {
    console.log(`       (fill normal fallo en ${label}: ${e.message.split("\n")[0]} -> JS fallback)`);
  }
  await page.evaluate(([sel, val]) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("No element for " + sel);
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, value]);
}

// ── 1. LOGIN ───────────────────────────────────────────────────────────
async function login(page) {
  console.log(`[1/4] Login -> ${WINLAB_URL}`);
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
  console.log(`       Inputs en pagina (${inputs.length}):`, JSON.stringify(inputs).slice(0, 800));

  await setField(page, WINLAB_USER_SELECTOR, WINLAB_USER, "user");
  await setField(page, WINLAB_PASS_SELECTOR, WINLAB_PASS, "pass");

  const submit = page.locator(WINLAB_SUBMIT_SELECTOR).first();
  await submit.waitFor({ state: "attached", timeout: SEL_TIMEOUT_MS });

  // Click + esperar navegacion. Si el boton esta hidden, dispatchEvent(click) tambien funciona.
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
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("No submit element for " + sel);
        // Para ASP.NET con __doPostBack, simular click es la forma correcta.
        if (typeof el.click === "function") el.click();
        else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }, WINLAB_SUBMIT_SELECTOR),
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

// ── 2. NAVEGAR A RESULTADOS ────────────────────────────────────────────
async function gotoResults(page) {
  if (!WINLAB_RESULTS_URL) {
    console.log("[2/4] WINLAB_RESULTS_URL vacio: asumo que el post-login YA esta en la lista de resultados.");
  } else {
    console.log(`[2/4] Navegando a resultados -> ${WINLAB_RESULTS_URL}`);
    await page.goto(WINLAB_RESULTS_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  }
  await page.locator(WINLAB_TABLE_SELECTOR).first().waitFor({ state: "visible", timeout: SEL_TIMEOUT_MS });
  // Esperar a que la tabla tenga >=1 fila (deterministico, sin sleeps).
  await page.waitForFunction(
    (sel) => {
      const t = document.querySelector(sel);
      return !!t && t.querySelectorAll("tr").length > 1;
    },
    WINLAB_TABLE_SELECTOR,
    { timeout: SEL_TIMEOUT_MS }
  );
}

// ── 3. SCRAPE (mapeo dinamico + paginacion) ────────────────────────────
async function scrapeAllPages(page) {
  const all = [];
  let pageIdx = 0;

  while (pageIdx < WINLAB_MAX_PAGES) {
    pageIdx++;
    console.log(`[3/4] Scraping pagina ${pageIdx}...`);

    const rows = await page.evaluate((tableSel) => {
      const norm = (s) =>
        String(s || "")
          .toUpperCase()
          .normalize("NFD")
          .replace(/\p{Diacritic}/gu, "")
          .replace(/\s+/g, " ")
          .trim();

      const table = document.querySelector(tableSel);
      if (!table) return { headers: [], data: [] };

      const trs = Array.from(table.querySelectorAll("tr"));

      // Mapeo dinamico de columnas: primera fila con TH, o primera con
      // tokens reconocibles (APELLIDO/NOMBRE/PACIENTE/EXP/FECHA).
      let headers = [];
      let headerRowIdx = -1;
      const isHeaderToken = (t) =>
        /^(APELLIDO|APELLIDOS|NOMBRE|NOMBRES|PACIENTE|EXP|EXPEDIENTE|FECHA|EDAD|SEXO|ESP|ESPECIALIDAD|CAMA|HABITACION|ESTUDIO|EXAMEN|RESULTADO|VALOR|UNIDADES|REFERENCIA)$/;

      for (let i = 0; i < trs.length; i++) {
        const ths = Array.from(trs[i].querySelectorAll("th"));
        if (ths.length >= 2) {
          headers = ths.map((c) => norm(c.innerText));
          headerRowIdx = i;
          break;
        }
        const tds = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (tds.length >= 2 && tds.filter((t) => isHeaderToken(t)).length >= 2) {
          headers = tds;
          headerRowIdx = i;
          break;
        }
      }

      const idx = (re) => headers.findIndex((h) => re.test(h));
      const cExp = idx(/^(EXP|EXPEDIENTE)$/);
      const cAp  = idx(/^APELLIDO(S)?$/);
      const cNo  = idx(/^NOMBRE(S)?$/);
      const cPac = idx(/^PACIENTE(S)?$/);
      const cFec = idx(/^FECHA$/);
      const cEst = idx(/^(ESTUDIO|EXAMEN)$/);
      const cVal = idx(/^(RESULTADO|VALOR)$/);

      const data = [];
      let current = null;

      for (let i = headerRowIdx + 1; i < trs.length; i++) {
        const cells = Array.from(trs[i].querySelectorAll("td")).map((c) => norm(c.innerText));
        if (!cells.length) continue;

        const isPatientHeader =
          cells.some((t) => t === "FEMENINO" || t === "MASCULINO") ||
          (cExp >= 0 && cells[cExp] && /^\d{3,}$/.test(cells[cExp]));

        if (isPatientHeader) {
          if (current) data.push(current);
          const exp =
            (cExp >= 0 && cells[cExp]) ||
            cells.find((t) => /^\d{6,}$/.test(t)) ||
            "";
          let paciente = "";
          if (cPac >= 0 && cells[cPac]) paciente = cells[cPac];
          else if (cAp >= 0) paciente = [cells[cAp], cNo >= 0 ? cells[cNo] : ""].filter(Boolean).join(" ");
          else {
            const sx = cells.findIndex((c) => c === "FEMENINO" || c === "MASCULINO");
            if (sx >= 2) paciente = [cells[sx - 2], cells[sx - 1]].filter(Boolean).join(" ");
          }
          const fecha = cFec >= 0 ? cells[cFec] : "";
          const cols = {};
          headers.forEach((h, k) => {
            if (h && cells[k] !== undefined) cols[h] = cells[k];
          });
          current = {
            exp: exp || paciente,
            paciente: paciente || null,
            fecha: fecha || null,
            data: { columnas: cols, estudios: [] },
          };
        } else if (current) {
          // Fila hija = un estudio/examen.
          const estudio = cEst >= 0 ? cells[cEst] : cells[0] || "";
          const valor   = cVal >= 0 ? cells[cVal] : cells[1] || "";
          if (estudio || valor) {
            const row = {};
            headers.forEach((h, k) => {
              if (h && cells[k] !== undefined) row[h] = cells[k];
            });
            current.data.estudios.push(row);
          }
        }
      }
      if (current) data.push(current);

      return { headers, data };
    }, WINLAB_TABLE_SELECTOR);

    console.log(`       Headers detectados: [${rows.headers.join(", ")}]`);
    console.log(`       Pacientes en pagina ${pageIdx}: ${rows.data.length}`);
    all.push(...rows.data);

    // Paginacion: si no hay selector configurado, una sola pagina.
    if (!WINLAB_NEXT_SELECTOR) break;
    const next = page.locator(WINLAB_NEXT_SELECTOR).first();
    const visible = await next.isVisible().catch(() => false);
    const enabled = visible ? await next.isEnabled().catch(() => false) : false;
    if (!visible || !enabled) {
      console.log("       Sin pagina siguiente.");
      break;
    }
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }),
      next.click(),
    ]);
    await page.locator(WINLAB_TABLE_SELECTOR).first().waitFor({ state: "visible", timeout: SEL_TIMEOUT_MS });
  }

  return all;
}

// ── 4. UPSERT MASIVO ───────────────────────────────────────────────────
async function upsert(records) {
  console.log(`[4/4] Upsert -> Supabase tabla="${SUPABASE_TABLE}" onConflict="${SUPABASE_CONFLICT}" (${records.length} filas)`);
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const fecha = todayISO();
  const scraped_at = new Date().toISOString();
  const payload = records.map((r) => ({
    exp: String(r.exp).slice(0, 64),
    paciente: r.paciente,
    fecha: r.fecha && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha) ? r.fecha : fecha,
    data: r.data,
    scraped_at,
  }));

  const { error, count } = await supa
    .from(SUPABASE_TABLE)
    .upsert(payload, { onConflict: SUPABASE_CONFLICT, count: "exact" });

  if (error) {
    throw new Error(`Supabase upsert fallo: ${error.message} (code=${error.code})`);
  }
  console.log(`       OK upsert. Filas afectadas: ${count ?? payload.length}`);
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
    await login(page);
    await gotoResults(page);
    const records = await scrapeAllPages(page);

    if (!records.length) {
      throw new Error("Scraping completo pero 0 pacientes extraidos. Probable cambio de DOM en WinLab.");
    }

    await upsert(records);
    console.log(`DONE en ${((Date.now() - t0) / 1000).toFixed(1)}s. Total pacientes: ${records.length}`);
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
