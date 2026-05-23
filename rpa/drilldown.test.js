// Tests del fix de drill-down (popup detection + PDF + anti-confusión).
// Corre con: `node rpa/drilldown.test.js`

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scraperSource = readFileSync(join(__dirname, "scraper.js"), "utf8");
const pdfExtractSource = readFileSync(join(__dirname, "pdf-extract.js"), "utf8");

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
}

// ── 2. REGRESSION GUARDS: vía PDF presente ──────────────────────────────────
{
  assert(
    /import \{ parsePdfToLabValues, findPdfFrameUrl \} from ".\/pdf-extract\.js"/.test(scraperSource),
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
    /parsePdfToLabValues\(capturedPdfBuffer/.test(scraperSource),
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

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
