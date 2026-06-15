// ════════════════════════════════════════════════════════════════════════
// pdf-extract.js — extracción de valores de lab desde PDFs de WinLab
//
// Módulo aislado para que las funciones de parsing sean testeables sin
// Playwright. Importado por scraper.js.
//
// Pipeline:
//   PDF buffer (descargado por scraper)
//     ↓ pdf-parse@2.4.5 (PDFParse.getText())
//   Texto plano
//     ↓ extractLabValuesFromText() — regex línea por línea
//   Array de { estudio, valor, unidad, referencia }
//     ↓ scraper persiste en winlab_labs.data.reportes[].valores[]
//     ↓ cliente (mapWinlabReportesToLabs) mapea a campos tipados
//   Tarjeta de paciente con Hb/Leu/Plaq/etc llenos
// ════════════════════════════════════════════════════════════════════════

import { PDFParse } from "pdf-parse";

// Patrones de "ruido" — líneas que NO son valores de lab y deben descartarse.
// Cubrir headers, info de paciente, paginación, separadores, en ES/IT/EN.
export const PDF_NOISE_PATTERNS = [
  /^HOSPITAL/i,
  /^DEPARTAMENTO/i,
  /^LABORATORIO/i,
  /^PACIENTE[:\s]/i,
  /^EXPEDIENTE[:\s]/i,
  /^EXP[:\s.]/i,
  /^FECHA[:\s]/i,
  /^EDAD[:\s]/i,
  /^SEXO[:\s]/i,
  /^MEDICO[:\s]/i,
  /^MÉDICO[:\s]/i,
  /^SERVICIO[:\s]/i,
  /^CAMA[:\s]/i,
  /^FOLIO[:\s]/i,
  /^ESTUDIO\s+RESULTADO/i,           // header de tabla ES
  /^DETERMINAZIONE\s+RISULTATO/i,    // header IT
  /^TEST\s+VALUE/i,                  // header EN
  /^EXAMEN\s+RESULTADO/i,
  /^EX[AÁ]MENES?\s+RESULTADOS?/i,    // header "EXAMENES RESULTADOS UNIDADES..."
  /^METODOLOG[IÍ]A/i,                // "METODOLOGIA: QUIMICA SECA" — entre nombre y valor (QS/hepática)
  /^V[AÁ]LIDADO\s+POR/i,
  /^Q\.?F\.?B\.?/i,                  // firma química
  /^T\.?L\.?C\.?/i,
  /^CED\.?\s*PROF/i,
  /^REG\.?\s*SSG/i,
  /^UNIVERSIDAD/i,
  /^JEFE\s+DE\s+LAB/i,
  /^NOTA[:\s]/i,
  /^RESULTADOS?[:\s]/i,
  /^T\.?\s*PACIENTE/i,
  /^DIAGN[OÓ]STICO[:\s]/i,
  /^PROCEDENCIA[:\s]/i,
  /^C[OÓ]DIGO\s+DE\s+ADMISI[OÓ]N/i,
  /^TOMA\s+DE\s+MUESTRA/i,
  /^CURP[:\s]/i,
  /^G[EÉ]NERO[:\s]/i,
  /^TURNO[:\s]/i,
  /^[\-=_*]{3,}$/,                   // separadores
  /^\d+\s+of\s+\d+$/i,               // paginación "1 of 1"
  /^P[áa]gina\s+\d+/i,
  /^FIRMADO\s+POR/i,
  /^VALIDADO\s+POR/i,
  /^OBSERVACIONES?[:\s]/i,
  /^\s*$/,                            // líneas vacías
  /^[<>]?\s*\d+[.,]?\d*\s*[-]\s*\d+[.,]?\d*\s*$/,  // solo rangos sueltos
  /^[\d\s\/:.,\-]+$/,                // sólo dígitos/separadores
];

// Pattern principal para línea de lab: NOMBRE + VALOR + UNIDAD? + RANGO?
//   - Nombre: 2+ chars, empieza con MAYÚSCULA, puede tener espacios/slash/paréntesis
//   - Valor:  número (entero o decimal), opcionalmente prefijado con < > ≤ ≥
//   - Unidad: opcional (g/dL, mg/dL, mmol/L, U/L, k/uL, %, ng/mL, μL, etc.)
//   - Rango:  opcional ("N - N" o "N a N")
export const PDF_LAB_LINE_RE =
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s\/.,()'\-]*?[A-ZÁÉÍÓÚÑ\)])\s+([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/;

// Formato MULTI-LÍNEA (química sanguínea / función hepática de WinLab HGL):
//   GLUCOSA                          ← nombre del estudio, solo
//   METODOLOGIA: QUIMICA SECA        ← línea de método (ruido, no pisa el pendiente)
//   *B  53.0 mg/dL 74.0 - 106.0      ← línea de VALOR (prefijo opcional *A/*B = fuera de rango)
// Sin este manejo el parser line-by-line dropea TODA la QS/hepática (sólo capturaba BH).
//
// Línea de VALOR: prefijo opcional *A/*B, número, luego (unidad? + rango?).
export const PDF_VALUE_LINE_RE =
  /^(?:\*[AB]\s+)?([<>≤≥]?\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/;
// Línea de NOMBRE de estudio: TODO mayúsculas (sin dígitos), 3+ chars, sin ":" (eso es método/header).
export const PDF_ESTUDIO_NAME_RE =
  /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s\/().'\-]{2,}$/;

/**
 * Extrae valores de lab tipados desde texto plano de un PDF.
 * @param {string} text - Texto extraído del PDF
 * @returns {Array<{estudio:string,valor:string,unidad:string,referencia:string}>}
 */
export function extractLabValuesFromText(text) {
  if (!text || typeof text !== "string") return [];

  const valores = [];
  const lines = text.split(/\r?\n/);
  // `pending` = nombre de estudio cuya línea de VALOR viene después (formato QS/hepática
  // multi-línea). Las líneas de método (METODOLOGIA) son ruido y NO lo pisan.
  let pending = null;

  // Si la "unidad" capturada es en realidad un número (ej. analito sin unidad como
  // "RELACION A/G  0.74  1.10 - 1.80"), muévela al rango.
  const fixUnit = (unidad, ref) => {
    const u = (unidad || "").trim(), r = (ref || "").trim();
    if (/^[<>≤≥]?\d/.test(u)) return { unidad: "", referencia: (u + " " + r).trim() };
    return { unidad: u, referencia: r };
  };

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/\s+/g, " ");
    if (!line) continue;

    // Filtrar ruido conocido (METODOLOGIA, firmas, headers...) — NO toca `pending`.
    if (PDF_NOISE_PATTERNS.some(rx => rx.test(line))) continue;

    // 1) Formato de UNA línea (BH): NOMBRE VALOR UNIDAD RANGO.
    const m = line.match(PDF_LAB_LINE_RE);
    if (m) {
      const cleanNombre = (m[1] || "").trim();
      if (cleanNombre.length >= 2 && !/^\d/.test(cleanNombre)) {
        const f = fixUnit(m[3], m[4]);
        valores.push({ estudio: cleanNombre, valor: (m[2] || "").trim(), unidad: f.unidad, referencia: f.referencia });
        pending = null;
        continue;
      }
    }

    // 2) Línea de VALOR de un estudio cuyo NOMBRE vino antes (formato QS/hepática).
    if (pending) {
      const vm = line.match(PDF_VALUE_LINE_RE);
      if (vm) {
        const f = fixUnit(vm[2], vm[3]);
        valores.push({ estudio: pending, valor: (vm[1] || "").trim(), unidad: f.unidad, referencia: f.referencia });
        pending = null;
        continue;
      }
    }

    // 3) Línea de NOMBRE de estudio (sin valor) → recordarla para la línea de valor siguiente.
    if (PDF_ESTUDIO_NAME_RE.test(line)) {
      pending = line;
      continue;
    }

    // 4) Línea desconocida → limpiar pendiente (evita asociaciones erróneas).
    pending = null;
  }

  return valores;
}

/**
 * Parsea un buffer de PDF y extrae valores de lab tipados.
 * @param {Buffer} buffer - PDF crudo descargado
 * @returns {Promise<Array<{estudio,valor,unidad,referencia}>>}
 */
export async function parsePdfToLabValues(buffer) {
  if (!buffer || !buffer.length) return [];
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (!result || !result.text) return [];
    return extractLabValuesFromText(result.text);
  } catch (e) {
    console.log(`       [pdf-parse] Error: ${e.message.split("\n")[0]}`);
    return [];
  }
}

/**
 * Busca en los frames de un popup el que contiene el PDF de WinLab.
 * El PDF se sirve vía EditPDF.aspx?FileName=...pdf.
 * Reintenta varias veces porque el frameset puede tardar en cargar.
 * @param {import('playwright').Page} popupPage
 * @param {number} maxAttempts
 * @returns {Promise<{pdfUrl:string, fileName:string}|null>}
 */
export async function findPdfFrameUrl(popupPage, maxAttempts = 10) {
  const PDF_URL_RE = /EditPDF\.aspx[^"]*FileName=[^"&]+\.pdf/i;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frames = popupPage.frames();
    for (const frame of frames) {
      const url = frame.url() || "";
      if (PDF_URL_RE.test(url)) {
        const match = url.match(/FileName=([^&]+)/);
        const fileName = match ? decodeURIComponent(match[1]) : null;
        return { pdfUrl: url, fileName };
      }
    }
    await popupPage.waitForTimeout(500).catch(() => {});
  }
  return null;
}
