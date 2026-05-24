// ════════════════════════════════════════════════════════════════════════
// pdf-extract.js — extracción de valores de lab desde PDFs de WinLab
//
// v2 (mayo 2026): rewrite para soportar formatos multi-línea + marcadores
// *B/*A. Tras detectar (con PDF de GERMAN ALVAREZ) que el parser previo
// perdía ~50% de los valores: TODA la página 1 (QUÍMICA: glucosa, urea,
// creatinina, electrolitos, función hepática) + HEMOGLOBINA, HEMATOCRITO,
// ERITROCITOS, MCHC de página 2.
//
// Formatos soportados:
//   A) "NOMBRE VALOR UNIDAD RANGO"
//      → LEUCOCITOS 8.45 10³/µL 4.00 - 10.00
//
//   B) "NOMBRE *B VALOR UNIDAD RANGO" (marcador fuera de rango)
//      → HEMOGLOBINA *B  8.70 g/dL 12.00 - 16.00
//
//   C) Multi-línea (página de química):
//      "NOMBRE"
//      "METODOLOGIA: ..."
//      "VALOR UNIDAD RANGO"
//      → GLUCOSA \n METODOLOGIA: QUIMICA SECA \n 89.0 mg/dL 74.0 - 106.0
//
//   D) Multi-línea con marcador:
//      "NOMBRE"
//      "METODOLOGIA: ..."
//      "*B VALOR UNIDAD RANGO"
// ════════════════════════════════════════════════════════════════════════

import { PDFParse } from "pdf-parse";

export const PDF_NOISE_PATTERNS = [
  /^HOSPITAL/i,
  /^DEPARTAMENTO/i,
  /^LABORATORIO/i,
  /^BLVD\./i,
  /^FRACC\./i,
  /^HOJA DE RESULTADOS$/i,
  /^PACIENTE[:\s]/i,
  /^EXPEDIENTE[:\s]/i,
  /^EXP[:\s.]/i,
  /^CURP[:\s]/i,
  /^FECHA[:\s]/i,
  /^EDAD[:\s]/i,
  /^SEXO[:\s]/i,
  /^GENERO[:\s]/i,
  /^GÉNERO[:\s]/i,
  /^MEDICO[:\s]/i,
  /^MÉDICO[:\s]/i,
  /^SERVICIO[:\s]/i,
  /^PROCEDENCIA[:\s]/i,
  /^DIAGN[OÓ]STICO[:\s]/i,
  /^C[OÓ]DIGO[:\s]/i,
  /^TOMA DE MUESTRA[:\s]/i,
  /^TURNO[:\s]/i,
  /^FECHA DE [A-Z]/i,
  /^T\.PACIENTE/i,
  /^CAMA[:\s]/i,
  /^FOLIO[:\s]/i,
  /^EXAMENES?\s+RESULTADOS?/i,
  /^DETERMINAZIONE\s+RISULTATO/i,
  /^TEST\s+VALUE/i,
  /^METODOLOGIA[:\s]/i,
  /^FLUORESCENTE$/i,
  /^[\-=_*]{3,}$/,
  /^-- \d+ of \d+ --$/i,
  /^\d+\s+of\s+\d+$/i,
  /^P[áa]gina\s+(N|n)?o?:?\s*\d+/i,
  /^FIRMADO\s+POR/i,
  /^VALIDADO\s+POR/i,
  /^Validado\s+por/i,
  /^Q\.F\.B\./,
  /^Ced\.\s*Prof\./i,
  /^Universidad/i,
  /^Jefe de Laboratorio/i,
  /^Resultados? fuera de rango/i,
  /^\*\s*Resultados? fuera de rango/i,
  /^B = Bajo/i,
  /^Nota[:\s]/i,
  /^OBSERVACIONES?[:\s]/i,
  /^\s*$/,
];

export const PDF_LAB_LINE_RE_INLINE =
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s\/.,()'\-]*?[A-ZÁÉÍÓÚÑ0-9#%.\)])\s+(?:\*[BA]\s*)?\s*([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/;

// Alias legacy para retrocompatibilidad con pdf-extract.test.js
export const PDF_LAB_LINE_RE = PDF_LAB_LINE_RE_INLINE;

export const PDF_NAME_ONLY_RE =
  /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s\/.,()'\-]*[A-ZÁÉÍÓÚÑ.\)]$/;

export const PDF_VALUE_ONLY_RE =
  /^(?:\*[BA]\s+)?([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/;

export const SECTION_HEADERS = new Set([
  "BIOMETRIA HEMATICA COMPLETA",
  "BIOMETRÍA HEMÁTICA COMPLETA",
  "QUIMICA SANGUINEA",
  "QUÍMICA SANGUÍNEA",
  "ELECTROLITOS SERICOS",
  "ELECTROLITOS SÉRICOS",
  "PERFIL HEPATICO",
  "PERFIL HEPÁTICO",
  "EXAMEN GENERAL DE ORINA",
]);

export function extractLabValuesFromText(text) {
  if (!text || typeof text !== "string") return [];

  const valores = [];
  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim().replace(/\s+/g, " "));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (PDF_NOISE_PATTERNS.some(rx => rx.test(line))) continue;

    // ── Caso A/B: línea inline ────────────────────────────────────────
    const inlineMatch = line.match(PDF_LAB_LINE_RE_INLINE);
    if (inlineMatch) {
      const [, nombre, valor, unidad, referencia] = inlineMatch;
      const cleanNombre = (nombre || "").trim();
      if (SECTION_HEADERS.has(cleanNombre.toUpperCase())) continue;
      if (cleanNombre.length < 2 || cleanNombre.length > 80) continue;
      if (/^\d/.test(cleanNombre)) continue;
      const numStr = valor.replace(/[<>≤≥\s]/g, "");
      if (/^\d{7,}$/.test(numStr)) continue;
      valores.push({
        estudio: cleanNombre,
        valor: valor.trim(),
        unidad: (unidad || "").trim(),
        referencia: (referencia || "").trim(),
      });
      continue;
    }

    // ── Caso C/D: NOMBRE solo, valor en líneas siguientes ─────────────
    if (!PDF_NAME_ONLY_RE.test(line)) continue;
    if (line.length < 2 || line.length > 80) continue;
    if (SECTION_HEADERS.has(line.toUpperCase())) continue;

    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      const next = lines[j];
      if (!next) continue;
      if (PDF_NOISE_PATTERNS.some(rx => rx.test(next))) continue;
      if (PDF_NAME_ONLY_RE.test(next) && !PDF_VALUE_ONLY_RE.test(next)) break;
      const valMatch = next.match(PDF_VALUE_ONLY_RE);
      if (valMatch) {
        const [, valor, unidad, referencia] = valMatch;
        const numStr = (valor || "").replace(/[<>≤≥\s]/g, "");
        if (/^\d{7,}$/.test(numStr)) break;
        valores.push({
          estudio: line.trim(),
          valor: (valor || "").trim(),
          unidad: (unidad || "").trim(),
          referencia: (referencia || "").trim(),
        });
        i = j;
        break;
      }
    }
  }

  return valores;
}

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
