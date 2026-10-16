// Tests del fix de drill-down (popup detection + PDF + anti-confusión).
// Corre con: `node rpa/drilldown.test.js`

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scraperSource = readFileSync(join(__dirname, "scraper.js"), "utf8");
const pdfExtractSource = readFileSync(join(__dirname, "pdf-extract.js"), "utf8");
import { orderDrillCandidates, isPendingCulture, isPendingReport, DRILL_EXTRA_CULTIVOS } from "./drill-order.js";
import { looksLikeCultureReport } from "./lib.js";

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else      { fail++; console.error(`✗ ${name}`); }
}

// ── 1. REGRESSION GUARDS: hooks del fix presentes en scraper.js ──────────────
{
  assert(
    /ctx\.waitForEvent\("page"/.test(scraperSource),
    "fix presente: suscripción a evento 'page' del contexto (popup detection)"
  );
  assert(
    /const popup = await popupPromise/.test(scraperSource),
    "fix presente: await del popupPromise antes de decidir detailPage"
  );
  assert(
    /detailPage\.waitForLoadState\("domcontentloaded"/.test(scraperSource),
    "fix presente: espera carga del popup (frameset RefertiSel.htm)"
  );
  // oct 2026: con 4 s de espera ~60 % de los primeros drills caían al fallback (lista de búsqueda) y
  // el reporte se descartaba; 12 s por defecto + búsqueda de la ventana nueva en ctx.pages().
  assert(
    /WL_POPUP_TIMEOUT_MS \|\| 12000/.test(scraperSource) && /pagesBefore\.has\(pg\)/.test(scraperSource),
    "popup: espera de 12 s configurable y rescate de ventana nueva en ctx.pages()"
  );
}

// ── 2. REGRESSION GUARDS: vía PDF presente ──────────────────────────────────
{
  assert(
    /import \{ parsePdfToReport, findPdfFrameUrl[^}]*\} from ".\/pdf-extract\.js"/.test(scraperSource),
    "vía PDF: import desde módulo separado pdf-extract.js"
  );
  assert(
    /findPdfFrameUrl\(detailPage/.test(scraperSource),
    "vía PDF: scraper busca frame con PDF antes de DOM scrape"
  );
  assert(
    /detailPage\.on\("response"/.test(scraperSource),
    "vía PDF: intercepta response del browser al cargar el frame (hereda sesión completa)"
  );
  assert(
    /parsePdfToReport\(capturedPdfBuffer/.test(scraperSource),
    "vía PDF: parseo del buffer capturado"
  );
  assert(
    /body\.slice\(0, 4\)\.toString\(\) === '%PDF'/.test(scraperSource),
    "vía PDF: valida magic bytes %PDF antes de aceptar buffer"
  );
}

// ── 3. REGRESSION GUARDS: DOM scrape sigue como fallback ────────────────────
{
  assert(
    /await detailPage\.evaluate/.test(scraperSource),
    "fallback DOM: detailPage.evaluate sigue presente (por si PDF falla)"
  );
  assert(
    /SEARCH_PAGE_HEADERS_RE/.test(scraperSource),
    "fallback DOM: validación anti-confusión sigue presente"
  );
}

// ── 4. REGRESSION GUARDS: cleanup correcto ──────────────────────────────────
{
  assert(
    /if \(detailPage && !detailPage\.isClosed\(\)\) await detailPage\.close\(\)/.test(scraperSource),
    "cleanup: cierra popup correctamente con guard isClosed"
  );
}

// ── 5. PDF URL REGEX: detecta el patrón real de WinLab ──────────────────────
{
  const PDF_URL_RE = /EditPDF\.aspx[^"]*FileName=[^"&]+\.pdf/i;
  // URL real reportada por el usuario en diagnóstico
  const realUrl = "http://hgleon.ddns.net/winlabweb/WW/EditPDF.aspx?FileName=../Temp/rawlqfj5rqpf0blyvmil4yui/a3445c18-3b21-4781-b838-18b19ba3b6c5.pdf&OffuscaPDF=False";
  assert(PDF_URL_RE.test(realUrl), "regex PDF: detecta URL real de WinLab HGL León");

  // Variantes
  assert(PDF_URL_RE.test("http://example.com/EditPDF.aspx?FileName=test.pdf"),
    "regex PDF: variante simple");
  assert(!PDF_URL_RE.test("http://example.com/RefertiSelHeader.aspx"),
    "regex PDF: NO matchea el frame del header");
  assert(!PDF_URL_RE.test("http://example.com/blank.htm"),
    "regex PDF: NO matchea blank/about");

  // OffuscaPDF=True caso: el patrón aún matchea porque el FileName sí tiene .pdf
  assert(PDF_URL_RE.test("EditPDF.aspx?FileName=protected.pdf&OffuscaPDF=True"),
    "regex PDF: matchea aún con OffuscaPDF=True (manejo lo decide el body)");
}

// ── 6. FileName extraction: separa el query param correctamente ─────────────
{
  const url = "http://hgleon.ddns.net/winlabweb/WW/EditPDF.aspx?FileName=../Temp/rawlqfj5rqpf0blyvmil4yui/a3445c18-3b21-4781-b838-18b19ba3b6c5.pdf&OffuscaPDF=False";
  const match = url.match(/FileName=([^&]+)/);
  assert(match !== null, "FileName regex matchea");
  assert(match[1] === "../Temp/rawlqfj5rqpf0blyvmil4yui/a3445c18-3b21-4781-b838-18b19ba3b6c5.pdf",
    "FileName extrae path completo (incluido ../ y hash/uuid)");
  const decoded = decodeURIComponent(match[1]);
  assert(decoded.endsWith(".pdf"), "FileName decodificado termina en .pdf");
}

// ── 7. ANTI-CONFUSIÓN regex (mantenida del fix anterior) ────────────────────
{
  const SEARCH_PAGE_HEADERS_RE = /CODIGO PACIENTE|APELLIDOS COMPLETOS|FECHA DE NAC|UNIDAD SOLICITANTE|REPORTES IMPRESOS/i;

  const buggyHeaders = ["", "", "CODIGO PACIENTE", "APELLIDOS COMPLETOS", "NOMBRE", "SEXO", "FECHA DE NAC."];
  assert(
    buggyHeaders.some(h => SEARCH_PAGE_HEADERS_RE.test(String(h || ""))),
    "anti-confusión: detecta headers reales del bug original"
  );

  const validHeaders = ["ESTUDIO", "RESULTADO", "UNIDAD", "REFERENCIA"];
  assert(
    !validHeaders.some(h => SEARCH_PAGE_HEADERS_RE.test(h)),
    "anti-confusión: NO descarta headers válidos"
  );
}

// ── 8. pdf-extract.js: tiene las exports correctas ──────────────────────────
{
  assert(/export function extractLabValuesFromText/.test(pdfExtractSource),
    "pdf-extract exporta: extractLabValuesFromText");
  assert(/export async function parsePdfToLabValues/.test(pdfExtractSource),
    "pdf-extract exporta: parsePdfToLabValues");
  assert(/export async function findPdfFrameUrl/.test(pdfExtractSource),
    "pdf-extract exporta: findPdfFrameUrl");
  assert(/import \{ PDFParse \} from "pdf-parse"/.test(pdfExtractSource),
    "pdf-extract usa: PDFParse de pdf-parse v2");
}

// ── 9. package.json: pdf-parse declarado como dependencia ───────────────────
{
  const pkgPath = join(__dirname, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert(typeof pkg.dependencies["pdf-parse"] === "string",
    "package.json: pdf-parse declarado como dependencia");
  assert(/^\^?2\./.test(pkg.dependencies["pdf-parse"]),
    "package.json: pdf-parse version 2.x (API v2)");
  assert(pkg.engines?.node === ">=20",
    "package.json: requiere Node 20+ (compatible con pdf-parse@2)");
}

// ── 10. V4 REGRESSION GUARDS: captura por content + diagnóstico HTML wrapper ─
{
  // v4 captura PDF de CUALQUIER URL (no solo EditPDF.aspx con FileName=)
  // porque EditPDF.aspx es un wrapper HTML, el PDF binario viene en otra request
  assert(
    /capturedHtmlWrapper/.test(scraperSource),
    "v4: variable capturedHtmlWrapper presente (diagnóstico del wrapper)"
  );
  assert(
    /HTML wrapper de EditPDF \(3000 chars\)/.test(scraperSource),
    "v4: dump del HTML wrapper para diagnóstico cuando no captura PDF"
  );
  assert(
    /URLs \.pdf encontradas en HTML wrapper/.test(scraperSource),
    "v4: regex busca URLs .pdf dentro del HTML wrapper"
  );
  // v4 tiene espera activa (no solo networkidle fijo)
  assert(
    /while \(!capturedPdfBuffer && \(Date\.now\(\) - startedWaiting\)/.test(scraperSource),
    "v4: espera activa hasta capturar PDF o timeout"
  );
  assert(
    /WAIT_PDF_MS = 8000/.test(scraperSource),
    "v4: timeout de 8s para captura del PDF binario"
  );
}

// ── 11. V5 REGRESSION GUARDS: fetch directo PDF estático (bypass embed) ─────
{
  // v5: extraer URL del PDF del onload script showPdfTimeOut('../Temp/...pdf')
  assert(
    /showPdfTimeOut\\\(\\s\*\['"]\(\[\^'"]\+\\\.pdf\)\['"]/.test(scraperSource),
    "v5: regex extrae URL del PDF de showPdfTimeOut() en HTML wrapper"
  );
  // v5: ctx.request.get del PDF estático directo (no de EditPDF.aspx)
  assert(
    /ctx\.request\.get\(pdfUrl/.test(scraperSource),
    "v5: ctx.request.get del PDF estático (no del wrapper ASP.NET)"
  );
  // v5: valida magic bytes %PDF antes de parsear
  assert(
    /v5: PDF descargado directo/.test(scraperSource),
    "v5: log de PDF descargado directo presente"
  );
  // v5: integración con parsePdfToLabValues
  assert(
    /v5: PDF parseado:/.test(scraperSource),
    "v5: integración con parsePdfToLabValues"
  );
  // v5: URL absoluta resolvida con base popup URL
  assert(
    /new URL\(relPath, popupUrl\)/.test(scraperSource),
    "v5: resuelve URL absoluta a partir del path relativo y URL del popup"
  );
}

// ── P1 (oct 2026): cierre garantizado del popup y salida temprana de la espera del PDF ────────
{
  assert(/const st = \{ popup: null, listener: null \};[\s\S]*?finally \{[\s\S]*?st\.popup\.close\(\)/.test(scraperSource),
    "P1: drillDownReport envuelve el drill en try/finally que cierra el popup");
  assert(/st\.popup = popupFound;/.test(scraperSource), "P1: el popup se registra en st para el finally");
  assert(/st\.listener = responseListener;/.test(scraperSource), "P1: el listener de responses se registra para quitarlo en el finally");
  assert(/WRAPPER_GRACE_MS/.test(scraperSource) && /if \(capturedHtmlWrapper\) \{/.test(scraperSource),
    "P1: la espera del PDF sale en cuanto llega el HTML wrapper (+ margen corto)");
  assert(/parser\.destroy\(\)/.test(pdfExtractSource), "P1: parsePdfToLabValues libera el documento con destroy()");
}

// ── CULTIVOS PRIMERO (oct 2026): orden de drill en drill-order.js ──────────────────────────
{
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Fila de la lista de WinLab (la lista viene más-reciente-primero). `kind`:
  //   "new"    referto nunca drilleado (sin valores)            → pendiente
  //   "lab"    BH/QS con valores (propios o de corrida previa)  → NO pendiente
  //   "cult"   cultivo con valores pero SIN texto del PDF        → pendiente (va primero)
  //   "cultOk" cultivo con texto del PDF ya guardado             → NO pendiente
  const row = (code, kind) => {
    const r = { __cells: ["", "", code, "08/10/2026 06:16", "08/10/2026 06:34", "CIRUGIA GENERAL"], __hasLink: true, __target: true };
    if (kind === "lab") r.valores = [{ estudio: "GLUCOSA", valor: "90" }];
    if (kind === "cult" || kind === "cultOk") r.valores = [{ estudio: "CULTIVO", valor: "POSITIVO" }];
    if (kind === "cultOk") { r.cultivo_texto = "CULTIVO DE SECRECION: ESCHERICHIA COLI"; r.cultivo = { v: 2 }; }
    return r;
  };
  const rows = (...kinds) => kinds.map((k, i) => row(`26100${i}`, k));
  const allIdx = (rs) => rs.map((_, i) => i);
  const opts = { max: 12, looksLikeCultureReport };

  // Regression guards: scraper.js usa el módulo en vez del slice ciego.
  assert(/import \{ orderDrillCandidates, isPendingCulture \} from ".\/drill-order\.js"/.test(scraperSource),
    "cultivos primero: scraper importa orderDrillCandidates/isPendingCulture de drill-order.js");
  assert(/orderDrillCandidates\(result\.rows, targetIdxs, \{ max: WL_DRILLDOWN_MAX, looksLikeCultureReport \}\)/.test(scraperSource),
    "cultivos primero: el drill usa orderDrillCandidates con WL_DRILLDOWN_MAX y looksLikeCultureReport por parámetro");
  assert(!/pendientes\.slice\(0, WL_DRILLDOWN_MAX\)/.test(scraperSource),
    "cultivos primero: el slice ciego de pendientes ya no existe");
  assert(/drilleando \$\{drillIdxs\.length\} \(\$\{nCultivos\} cultivos primero\)/.test(scraperSource),
    "cultivos primero: log '[targeting] … drilleando N (M cultivos primero)'");
  // WL_DRILLDOWN_MAX saneado en la definición: una env mal puesta ("abc", negativa) vuelve al 12, así el
  // drill del objetivo y el fallback legacy comparten tope y ninguno queda en 0 drills ni "sin tope".
  assert(/const WL_DRILLDOWN_MAX\s*=\s*\(\(\) => \{ const n = parseInt\(ENV\("WL_DRILLDOWN_MAX", "12"\), 10\); return Number\.isFinite\(n\) && n >= 0 \? n : 12; \}\)\(\)/.test(scraperSource),
    "WL_DRILLDOWN_MAX: parseInt saneado (NaN o negativo → 12)");

  // 1. Los cultivos van PRIMERO aunque sean los más viejos de la lista.
  const r1 = rows("new", "new", "lab", "new", "cult", "lab", "cult");
  assert(deepEq(orderDrillCandidates(r1, allIdx(r1), opts), [4, 6, 0, 1, 3]),
    "orden: cultivos pendientes (viejos, al final de la lista) van antes que los refertos nuevos");

  // 2. El tope `max` aplica solo a los NO-cultivo.
  const r2 = rows("new", "new", "new", "new", "new", "cult", "cult");
  assert(deepEq(orderDrillCandidates(r2, allIdx(r2), { ...opts, max: 3 }), [5, 6, 0, 1, 2]),
    "tope: con max=3 entran los 2 cultivos + los 3 no-cultivo más recientes (5 en total)");

  // 3. Sin cultivos = comportamiento anterior (pendientes por recencia, slice(0, max)).
  const r3 = rows("new", "lab", "new", "new", "new");
  assert(deepEq(orderDrillCandidates(r3, allIdx(r3), { ...opts, max: 2 }), [0, 2]),
    "sin cultivos: pendientes por recencia topados a max (igual que antes)");
  assert(deepEq(orderDrillCandidates(r3, allIdx(r3), opts), [0, 2, 3, 4]),
    "sin cultivos: con max holgado entran todos los pendientes en orden original");

  // 4. Un cultivo YA leído (cultivo_texto presente) no se vuelve a drillear.
  const r4 = rows("cultOk", "new", "cult", "cultOk");
  assert(deepEq(orderDrillCandidates(r4, allIdx(r4), opts), [2, 1]),
    "cultivo con texto del PDF guardado no se repite; el que falta sí va primero");

  // 5. Tope ABSOLUTO: nunca más de max + extraCultivos (por defecto +6), cultivos al frente.
  const r5 = rows(...Array(10).fill("cult"), "new", "new", "new");
  const o5 = orderDrillCandidates(r5, allIdx(r5), { ...opts, max: 2 });
  assert(DRILL_EXTRA_CULTIVOS === 6 && o5.length === 2 + 6, "tope absoluto: max=2 → como mucho 8 drills aunque haya 10 cultivos + 3 nuevos");
  assert(o5.every((i) => r5[i].valores[0].estudio === "CULTIVO") && deepEq(o5, [0, 1, 2, 3, 4, 5, 6, 7]),
    "tope absoluto: el recorte quita primero los no-cultivo y después los cultivos sobrantes (orden original)");
  assert(orderDrillCandidates(r5, allIdx(r5), { ...opts, max: 2, extraCultivos: 1 }).length === 3,
    "tope absoluto: extraCultivos configurable (max=2, extra=1 → 3)");
  const r5b = rows("cult", "cult", "new", "new", "new", "new", "new", "new", "new", "new", "new", "new");
  assert(deepEq(orderDrillCandidates(r5b, allIdx(r5b), { ...opts, max: 4 }), [0, 1, 2, 3, 4, 5]),
    "tope absoluto: con pocos cultivos el total es cultivos + max (2 + 4), no max + 6");

  // 6. Solo se consideran los índices del objetivo (homónimos fuera) y sin duplicados.
  const r6 = rows("cult", "new", "new", "cult");
  assert(deepEq(orderDrillCandidates(r6, [1, 3, 3, 1], opts), [3, 1]),
    "targetIdxs: solo índices del objetivo, duplicados ignorados, cultivo primero");
  assert(deepEq(orderDrillCandidates(r6, [], opts), []) && deepEq(orderDrillCandidates([], [0, 1], opts), []),
    "targetIdxs/rows vacíos → nada que drillear");
  assert(deepEq(orderDrillCandidates(r6, [0, 7, -1, "1"], opts), [0]),
    "targetIdxs fuera de rango o no enteros se ignoran");

  // 7. Predicados.
  assert(isPendingCulture(row("X", "cult"), looksLikeCultureReport) === true, "isPendingCulture: cultivo sin texto → true");
  assert(isPendingCulture(row("X", "cultOk"), looksLikeCultureReport) === false, "isPendingCulture: cultivo con texto → false");
  assert(isPendingCulture(row("X", "new"), looksLikeCultureReport) === false, "isPendingCulture: sin valores no se puede saber que es cultivo → false");
  assert(isPendingCulture(row("X", "lab"), looksLikeCultureReport) === false, "isPendingCulture: BH/QS → false");
  assert(isPendingReport(row("X", "new"), looksLikeCultureReport) === true && isPendingReport(row("X", "lab"), looksLikeCultureReport) === false,
    "isPendingReport: sin valores pendiente, con valores no");
  assert(isPendingReport(row("X", "cult"), looksLikeCultureReport) === true && isPendingReport(row("X", "cultOk"), looksLikeCultureReport) === false,
    "isPendingReport: cultivo sin texto pendiente, con texto no");
  assert(isPendingCulture(null, looksLikeCultureReport) === false && isPendingReport(undefined, looksLikeCultureReport) === false,
    "predicados: fila nula → false");

  // 8. `max` inválido (env mal puesta) → sin tope para no-cultivo; el soft-deadline sigue acotando.
  assert(orderDrillCandidates(r2, allIdx(r2), { ...opts, max: NaN }).length === 7, "max no finito → sin tope (7 pendientes)");
  assert(deepEq(orderDrillCandidates(r2, allIdx(r2), { ...opts, max: 0 }), [5, 6]), "max=0 → solo cultivos pendientes");
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
