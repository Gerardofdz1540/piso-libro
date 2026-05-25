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
  // Fragmentos de palabras truncadas por layout multi-columna (bug LUIS REY)
  /^COAGULO\.?$/i,                   // fragmento de "COAGULOMETRIA"
  /^METRIA\.?$/i,                    // segundo fragmento de "COAGULOMETRIA"
  /^OMETR[ÍI]A\.?$/i,                // posibles otros cortes
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

// Headers de sección. Si una línea coincide con uno de estos (case-insensitive),
// NO es un valor sino el encabezado de la sección que sigue. El parser trackea
// la SECCIÓN ACTIVA y la agrega a cada valor extraído como `seccion`.
//
// Esto permite distinguir LEUCOCITOS de sangre vs LEUCOCITOS de urocultivo,
// HEMOGLOBINA en sangre vs HEMOGLOBINA en EGO (tira), AMILASA en sangre vs
// AMILASA en líquido de drenaje (caso de Whipple), etc.
export const SECTION_HEADERS = new Set([
  // Sangre / química / coagulación
  "BIOMETRIA HEMATICA COMPLETA",
  "BIOMETRÍA HEMÁTICA COMPLETA",
  "QUIMICA SANGUINEA",
  "QUÍMICA SANGUÍNEA",
  "ELECTROLITOS SERICOS",
  "ELECTROLITOS SÉRICOS",
  "PERFIL HEPATICO",
  "PERFIL HEPÁTICO",
  "TIEMPO DE PROTROMBINA",
  "TIEMPO DE TROMBOPLASTINA PARCIAL",
  "PROCALCITONINA",
  // Fluidos no sanguíneos / cultivos
  "EXAMEN GENERAL DE ORINA",
  "EXAMEN GENERAL DE ORINA (EGO)",
  "UROCULTIVO",
  "HEMOCULTIVO",
  "COPROCULTIVO",
  "CULTIVO DE EXPECTORACION",
  "CULTIVO DE EXPECTORACIÓN",
  "CULTIVO DE LIQUIDO PERITONEAL",
  "CULTIVO DE LÍQUIDO PERITONEAL",
  "CULTIVO DE LIQUIDO DE DRENAJE",
  "CULTIVO DE LÍQUIDO DE DRENAJE",
  "CULTIVO DE PUNTA DE CATETER",
  "CULTIVO DE PUNTA DE CATÉTER",
  "ANTIBIOGRAMA",
  // Líquidos especiales (drenajes Whipple, ascitis, etc.)
  "LIQUIDO DE DRENAJE",
  "LÍQUIDO DE DRENAJE",
  "AMILASA EN LIQUIDO DE DRENAJE",
  "AMILASA EN LÍQUIDO DE DRENAJE",
  "LIQUIDO PERITONEAL",
  "LÍQUIDO PERITONEAL",
  "LIQUIDO PLEURAL",
  "LÍQUIDO PLEURAL",
  "LIQUIDO CEFALORRAQUIDEO",
  "LÍQUIDO CEFALORRAQUÍDEO",
  // Gasometría
  "GASOMETRIA ARTERIAL",
  "GASOMETRÍA ARTERIAL",
  "GASOMETRIA VENOSA",
  "GASOMETRÍA VENOSA",
]);

// Mapeo a categoría general para el frontend.
// Cada sección detectada se clasifica en uno de estos buckets:
//   "blood"     → BH, química, coagulación, electrolitos sangre, hepáticas
//   "urine"     → EGO, urocultivo
//   "culture"   → hemocultivo, coprocultivo, cultivos de fluidos, antibiograma
//   "fluid"     → líquido de drenaje, ascitis, pleural, LCR, amilasa de drenaje
//   "gas"       → gasometrías
//   "other"     → no clasificado
export function classifySection(seccion) {
  // Si NO hay sección activa, asumir "blood" por default (la química clínica
  // del HGL no tiene header explícito — empieza directo con GLUCOSA, UREA, etc.
  // El frontend tiene un filtro non-blood adicional como segunda capa).
  if (!seccion) return "blood";
  const s = String(seccion).toUpperCase();
  if (/BIOMETR|QUIMIC|QUÍMIC|HEPAT|HEPÁT|ELECTROL|COAGULAC|PROTROMBINA|TROMBOPLASTINA|PROCALCITONINA/.test(s)) return "blood";
  if (/UROCULTIVO|EXAMEN GENERAL DE ORINA|\bEGO\b/.test(s)) return "urine";
  if (/CULTIVO|ANTIBIOGRAMA|HEMOCULTIVO|COPROCULTIVO/.test(s)) return "culture";
  if (/L[IÍ]QUIDO|DRENAJE|ASCITIS|PLEURAL|CEFALORRAQU/.test(s)) return "fluid";
  if (/GASOMETR|GASOMETRÍ/.test(s)) return "gas";
  return "other";
}

export function extractLabValuesFromText(text) {
  if (!text || typeof text !== "string") return [];

  const valores = [];
  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, " ").trim().replace(/\s+/g, " "));

  // Sección activa: cuando encontramos un header conocido, lo guardamos.
  // Persiste para todos los valores siguientes hasta que se encuentre otro header.
  // Esto permite saber el contexto clínico de cada valor (sangre, orina, cultivo, etc.)
  let currentSection = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // ¿Es un header de sección? → actualizar contexto y NO extraer como valor
    if (SECTION_HEADERS.has(line.toUpperCase())) {
      currentSection = line.toUpperCase();
      continue;
    }

    if (PDF_NOISE_PATTERNS.some(rx => rx.test(line))) continue;

    // ── Caso A/B: línea inline ────────────────────────────────────────
    const inlineMatch = line.match(PDF_LAB_LINE_RE_INLINE);
    if (inlineMatch) {
      const [, nombre, valor, unidad, referencia] = inlineMatch;
      const cleanNombre = (nombre || "").trim();
      if (SECTION_HEADERS.has(cleanNombre.toUpperCase())) {
        // Header inline (raro): actualizar sección y skip
        currentSection = cleanNombre.toUpperCase();
        continue;
      }
      if (cleanNombre.length < 2 || cleanNombre.length > 80) continue;
      if (/^\d/.test(cleanNombre)) continue;
      const numStr = valor.replace(/[<>≤≥\s]/g, "");
      if (/^\d{7,}$/.test(numStr)) continue;
      valores.push({
        estudio: cleanNombre,
        valor: valor.trim(),
        unidad: (unidad || "").trim(),
        referencia: (referencia || "").trim(),
        seccion: currentSection,
        bucket: classifySection(currentSection),
      });
      continue;
    }

    // ── Caso C/D: NOMBRE solo, valor en líneas siguientes ─────────────
    if (!PDF_NAME_ONLY_RE.test(line)) continue;
    if (line.length < 2 || line.length > 80) continue;
    if (SECTION_HEADERS.has(line.toUpperCase())) {
      currentSection = line.toUpperCase();
      continue;
    }

    // Si termina en punto, debe ser ACRÓNIMO válido (I.N.R., A.B.) — no palabra
    // completa (COAGULO., METRIA., etc.). Acrónimo: letras individuales separadas
    // por puntos.
    if (/\.$/.test(line)) {
      const isAcronym = /^[A-ZÁÉÍÓÚÑ]\.([A-ZÁÉÍÓÚÑ]\.)*$/.test(line);
      if (!isAcronym) continue;
    }

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
          seccion: currentSection,
          bucket: classifySection(currentSection),
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
