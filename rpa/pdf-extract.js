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

// Pattern principal para línea de lab: NOMBRE + [*A/*B] + VALOR + UNIDAD? + RANGO?
//   - Nombre: 2+ chars, empieza con MAYÚSCULA, puede tener espacios/slash/paréntesis
//   - Flag opcional *A/*B entre nombre y valor (fuera de rango). FIX (jun 2026): la
//     BIOMETRIA HEMATICA del HGL usa "LEUCOCITOS *A\t20.97 ..." / "HEMOGLOBINA *B\t10.10 ..."
//     en UNA línea con el flag en medio; sin tolerar el flag, hb/hct/leucos/plaq (fuera de
//     rango) se dropeaban y solo pasaban los analitos EN rango (el diferencial). 3-155.
//   - Valor:  número (entero o decimal), opcionalmente prefijado con < > ≤ ≥
//   - Unidad: opcional (g/dL, mg/dL, mmol/L, U/L, k/uL, %, ng/mL, μL, etc.)
//   - Rango:  opcional ("N - N" o "N a N")
export const PDF_LAB_LINE_RE =
  /^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\s\/.,()'\-]*?[A-ZÁÉÍÓÚÑ\)])\s+(?:\*[AB]\s+)?([<>≤≥]?\s*-?\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/; // -? : EXCESO DE BASE -4.2

// Formato MULTI-LÍNEA (química sanguínea / función hepática de WinLab HGL):
//   GLUCOSA                          ← nombre del estudio, solo
//   METODOLOGIA: QUIMICA SECA        ← línea de método (ruido, no pisa el pendiente)
//   *B  53.0 mg/dL 74.0 - 106.0      ← línea de VALOR (prefijo opcional *A/*B = fuera de rango)
// Sin este manejo el parser line-by-line dropea TODA la QS/hepática (sólo capturaba BH).
//
// Línea de VALOR: prefijo opcional *A/*B, número, luego (unidad? + rango?).
export const PDF_VALUE_LINE_RE =
  /^(?:\*[AB]\s+)?([<>≤≥]?\s*-?\d+(?:[.,]\d+)?)\s*(?:(\S+)\s*(.*))?$/; // -? : gasometría con valores negativos
// Línea de NOMBRE de estudio: TODO mayúsculas (sin dígitos), 3+ chars, sin ":" (eso es método/header).
export const PDF_ESTUDIO_NAME_RE =
  /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s\/().'\-]{2,}$/;

// Resultados CUALITATIVOS (oct 2026): cultivos, serologías y tiras reactivas no traen número
// ("UROCULTIVO  SIN DESARROLLO", "VIH  NO REACTIVO", "NITRITOS  NEGATIVO"). Antes se dropeaban
// por completo (PDF_LAB_LINE_RE exige un número) y los cultivos nunca llegaban a la app.
// Lista cerrada de palabras-resultado para no capturar encabezados ni texto libre.
export const PDF_QUALITATIVE_VALUES =
  "NEGATIVO|NEGATIVA|POSITIVO|POSITIVA|NO REACTIVO|REACTIVO|NO DETECTADO|DETECTADO|SIN DESARROLLO|NO DESARROLLO|" +
  "AUSENTE|AUSENTES|PRESENTE|PRESENTES|NORMAL|ANORMAL|TRAZAS|INDETERMINADO|NO SE OBSERVAN?|ESCASOS?|ABUNDANTES?|MODERADOS?";
export const PDF_QUALITATIVE_LINE_RE = new RegExp(
  "^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9\\s\\/.,()'\\-]*?[A-ZÁÉÍÓÚÑ\\)])\\s+(?:\\*[AB]\\s+)?(" + PDF_QUALITATIVE_VALUES + ")(?:\\s+(.*))?$"
);
export const PDF_QUALITATIVE_VALUE_LINE_RE = new RegExp("^(?:\\*[AB]\\s+)?(" + PDF_QUALITATIVE_VALUES + ")(?:\\s+(.*))?$");

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

  // Si la "unidad" capturada es en realidad un número PURO (ej. analito sin unidad como
  // "RELACION A/G  0.74  1.10 - 1.80" → "1.10" es el inicio del rango), muévela al rango.
  // OJO: NO mover unidades que EMPIEZAN con dígito pero son unidades reales (10³/μL, 10^6/μL):
  // exigir que el token sea SOLO número (con coma/punto), sin más caracteres detrás.
  const fixUnit = (unidad, ref) => {
    const u = (unidad || "").trim(), r = (ref || "").trim();
    if (/^[<>≤≥]?\d+(?:[.,]\d+)?$/.test(u)) return { unidad: "", referencia: (u + " " + r).trim() };
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

    // 1b) Formato de UNA línea con resultado CUALITATIVO: NOMBRE RESULTADO [REFERENCIA].
    //     El nombre NO puede ser él mismo una palabra-resultado ni un encabezado.
    const q = line.match(PDF_QUALITATIVE_LINE_RE);
    if (q) {
      const cleanNombre = (q[1] || "").trim();
      const qualRe = new RegExp("^(" + PDF_QUALITATIVE_VALUES + ")$");
      if (cleanNombre.length >= 3 && !/^\d/.test(cleanNombre) && !qualRe.test(cleanNombre)) {
        valores.push({ estudio: cleanNombre, valor: (q[2] || "").trim(), unidad: "", referencia: (q[3] || "").trim() });
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
      // 2b) Línea de resultado CUALITATIVO del estudio pendiente ("SIN DESARROLLO", "NEGATIVO"...).
      const qv = line.match(PDF_QUALITATIVE_VALUE_LINE_RE);
      if (qv) {
        valores.push({ estudio: pending, valor: (qv[1] || "").trim(), unidad: "", referencia: (qv[2] || "").trim() });
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

// ════════════════════════════════════════════════════════════════════════
// CULTIVOS (13 oct 2026): el germen y el antibiograma viven en el PDF del reporte, no en la
// tabla de WinLab (que solo dice "CULTIVO  POSITIVO"). extractCultureFromText() saca del texto:
//   - tipo de cultivo (hemo/uro/secreción/líquido…) y muestra
//   - resultado: POSITIVO / NEGATIVO / PENDIENTE (preliminar)
//   - gérmenes aislados (género + especie, p.ej. "Klebsiella pneumoniae"), BLEE/carbapenemasa
//   - antibiograma: [{ antibiotico, cim, interp: S|I|R }] en cualquiera de los formatos usuales
//     ("AMIKACINA  <=2  S", "AMIKACINA S", "AMIKACINA SENSIBLE", "S  AMIKACINA  <=2")
// Precisión > recall: lista cerrada de géneros y antibióticos; lo que no reconoce no se inventa.
// El scraper guarda ADEMÁS el texto completo del PDF (cultivo_texto) para que la tarjeta lo
// muestre tal cual y para afinar este parser con reportes reales.
// ════════════════════════════════════════════════════════════════════════
export const CULTURE_PARSER_VERSION = 2;
export const CULTURE_TEXT_MARKERS = /CULTIVO|ANTIBIOGRAMA|ANTIBIOTICOS\s+CMI|MICROORGANISMO|MICRORGANISMO|GERMEN|AISLAD[OA]|UFC\s*\/\s*ML|SENSIBILIDAD\s+ANTIMICROBIANA|TINCI[OÓ]N\s+DE\s+GRAM/i;
export const CULTURE_GENUS_RE = /\b(ESCHERICHIA|KLEBSIELLA|ENTEROBACTER|PROTEUS|PSEUDOMONAS|ACINETOBACTER|STAPHYLOCOCCUS|STREPTOCOCCUS|ENTEROCOCCUS|CANDIDA|SERRATIA|MORGANELLA|CITROBACTER|STENOTROPHOMONAS|PROVIDENCIA|SALMONELLA|SHIGELLA|HAEMOPHILUS|BURKHOLDERIA|BACTEROIDES|CLOSTRIDI(?:UM|OIDES)|LISTERIA|NEISSERIA|MORAXELLA|AEROMONAS|ACHROMOBACTER|CORYNEBACTERIUM|MICROCOCCUS|KOCURIA|RAOULTELLA|HAFNIA|PANTOEA|SPHINGOMONAS|ELIZABETHKINGIA|CHRYSEOBACTERIUM|ASPERGILLUS|CRYPTOCOCCUS|TRICHOSPORON|BACILLUS|LACTOBACILLUS|PEPTOSTREPTOCOCCUS|FUSOBACTERIUM|PREVOTELLA|ALCALIGENES|OCHROBACTRUM|RALSTONIA|EDWARDSIELLA|YERSINIA|VIBRIO|CAMPYLOBACTER|HELICOBACTER|MYCOBACTERIUM|NOCARDIA|ACTINOMYCES|GARDNERELLA|TRICHOMONAS|E\.\s?COLI|S\.\s?AUREUS)\b/i;
export const CULTURE_ANTIBIOTIC_RE = /\b(AMIKACINA|GENTAMICINA|TOBRAMICINA|ESTREPTOMICINA|CIPROFLOXACIN[OA]|LEVOFLOXACIN[OA]|MOXIFLOXACIN[OA]|NORFLOXACIN[OA]|OFLOXACIN[OA]|CEFTRIAXONA|CEFOTAXIMA|CEFTAZI[DT]IMA(?:[\s\-\/]+AVIBACTAM)?|CEFEPIM[AE]|CEFUROXIMA|CEFAZOLINA|CEFOXITINA|CEFALOTINA|CEFALEXINA|CEFIXIMA|CEFTAROLINA|CEFTOLOZAN[OA](?:[\s\-\/]+TAZOBACTAM)?|CEFIDEROCOL|AMPICILINA(?:[\s\-\/]+SULBACTAM)?|AMOXICILINA(?:[\s\-\/]+(?:[AÁ]C(?:IDO)?\.?\s+)?CLAVUL[AÁ]NICO)?|PIPERACILINA(?:[\s\-\/]+TAZOBACTAM)?|TICARCILINA(?:[\s\-\/]+CLAVULANATO)?|OXACILINA|PENICILINA(?:\s+G)?|DICLOXACILINA|MEROPENEM|IMIPENEM(?:[\s\-\/]+CILASTATINA)?|ERTAPENEM|DORIPENEM|AZTREONAM|VANCOMICINA|TEICOPLANINA|LINEZOLID|DAPTOMICINA|CLINDAMICINA|ERITROMICINA|CLARITROMICINA|AZITROMICINA|TRIMETOPRIM(?:A)?(?:[\s\-\/]+SULFAMETOXAZOL)?|SULFAMETOXAZOL(?:[\s\-\/]+TRIMETOPRIM(?:A)?)?|NITROFURANTO[IÍ]NA|FOSFOMICINA|COLISTINA|POLIMIXINA\s*B|TIGECICLINA|DOXICICLINA|MINOCICLINA|TETRACICLINA|RIFAMPICINA|CLORANFENICOL|METRONIDAZOL|QUINUPRISTINA(?:[\s\-\/]+DALFOPRISTINA)?|FLUCONAZOL|VORICONAZOL|ITRACONAZOL|POSACONAZOL|ANFOTERICINA\s*B|CASPOFUNGINA|MICAFUNGINA|ANIDULAFUNGINA|FLUCITOSINA|BENZILPENICILINA|CEFOTETAN|CEFACLOR|CEFPODOXIMA|CEFDITOREN|LOMEFLOXACIN[OA]|GATIFLOXACIN[OA]|NETILMICINA|KANAMICINA|TEDIZOLID|DALBAVANCINA|ORITAVANCINA|FUSIDICO|MUPIROCINA)\b/i;
const CULTURE_INTERP_RE = /^(S|I|R|SDD|SENSIBLE|SUSCEPTIBLE|INTERMEDI[OA]|RESISTENTE)\*?$/i;
const CULTURE_CIM_TOKEN_RE = /^[<>≤≥]*=?\s*\d+(?:[.,]\d+)?(?:\/\d+(?:[.,]\d+)?)?$/;
const CULTURE_NEG_RE = /SIN\s+DESARROLLO|NO\s+(?:HUBO|HAY|SE\s+OBSERV[OÓ])?\s*DESARROLLO|SIN\s+CRECIMIENTO|NEGATIV[OA]\s+A\s+(?:LOS\s+|LAS\s+)?\d+|AUSENCIA\s+DE\s+(?:DESARROLLO|CRECIMIENTO)|FLORA\s+(?:NORMAL|HABITUAL|MIXTA\s+NORMAL)|NO\s+SE\s+AISL/i;
const CULTURE_POS_RE = /\bPOSITIV[OA]\b|DESARROLLO\s+DE\s+(?!:?\s*SIN\b)|SE\s+AISL[AO]|CRECIMIENTO\s+DE\b|MICROORGANISMO\s+AISLADO|GERMEN\s+AISLADO|\bUFC\b/i;
const CULTURE_PENDING_RE = /PRELIMINAR|EN\s+PROCESO|PENDIENTE|INCUBACI[OÓ]N|EN\s+CURSO|SIN\s+MUESTRA/i;
// Inicio de una SECCIÓN (una muestra) en el PDF del HGL: "HEMOCULTIVO PERIFERICO 1 …", "HEMOCULTIVO CENTRAL",
// "UROCULTIVO", "CULTIVO DE SECRECIONES", "COPROCULTIVO", "CULTIVO DE LIQUIDO …". Lo que sigue en la
// misma línea es el resultado en línea ("DESARROLLO", "En proceso", "SIN MUESTRA SIN DESARROLLO").
const CULTURE_SECTION_RE = /^(HEMOCULTIVO(?:\s+(?:PERIF[EÉ]RICO|CENTRAL|ARTERIAL|VENOSO))?(?:\s+\d)?|UROCULTIVO|COPROCULTIVO|CULTIVO\s+DE\s+[A-ZÑÁÉÍÓÚ]+(?:\s+(?:DE|DEL|Y)\s+[A-ZÑÁÉÍÓÚ]+)*(?:\s+[A-ZÑÁÉÍÓÚ]+)?|CULTIVO\s+(?:DE\s+)?L[IÍ]QUIDO\s+[A-ZÑÁÉÍÓÚ]+|CULTIVO\s+PUNTA\s+DE\s+CAT[EÉ]TER)\b\s*(.*)$/i;
const CULTURE_STOP_RE = /^(S\s*=\s*SENSIBLE|Q\.?F\.?B\.?|CED\.?\s*PROF|UNIVERSIDAD|NOTA:|\*\s*RESULTADOS\s+FUERA|P[AÁ]GINA\s+NO|REPORTE\s+NO\s+VALIDADO|JEFE\s+DE\s+LABORATORIO|--\s*\d+\s+of\s+\d+|HOSPITAL\s+GENERAL|LABORATORIO\s+DE\s+AN|BLVD\.|FRACC\.|HOJA\s+DE\s+RESULTADOS|PACIENTE:|FECHA\s+DE\s+NACIMIENTO|C[OÓ]DIGO\s+DE\s+ADMISI[OÓ]N|M[EÉ]DICO:|PROCEDENCIA:|EXAMENES\s+RESULTADOS|DIAGN[OÓ]STICO:|GRAM$|TINCI[OÓ]N\s+DE\s+GRAM)/i;
const TEST_LINE_RE = /\bAG\b|ANT[IÍ]GENO|TOXINA|ANTICUERPO|\bPCR\b|DETECCI[OÓ]N\s+DE|PRUEBA\s+DE|SEROLOG|REACTIVO|\bIG[GMA]\b/i;

function _up(s) { return String(s || "").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function _interp(tok) {
  const t = String(tok || "").trim().toUpperCase().replace(/\*+$/, "");
  if (!CULTURE_INTERP_RE.test(t)) return "";
  if (t === "SDD") return "SDD";
  return t[0];
}
function _cleanGenus(g) {
  const u = _up(g);
  if (/^E\.?\s?COLI/.test(u)) return "Escherichia coli";
  if (/^S\.?\s?AUREUS/.test(u)) return "Staphylococcus aureus";
  return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
}
// "1. Klebsiella oxytoca" / "Klebsiella pneumoniae BLEE" → "Klebsiella pneumoniae" (género + especie/spp)
function _germFromLine(line) {
  const m = line.match(CULTURE_GENUS_RE);
  if (!m) return "";
  const genus = _cleanGenus(m[1]);
  if (/ /.test(genus)) return genus;
  const rest = line.slice(m.index + m[0].length).match(/^\s+(SP\.?|SPP\.?|[A-Za-zñÑ\-]{3,})(?:\s+(?:SUBSP\.?|VAR\.?|SSP\.?)\s+([A-Za-z\-]{3,}))?/);
  if (rest && !/^(SENSIBLE|RESISTENTE|INTERMEDIO|AISLADO|POSITIVO|NEGATIVO|UFC|BLEE|ESBL|CIM|MIC|SIN|CON|POR|EN|DE|DEL|LA|EL|AL|METICILINO|MRSA|MSSA|PRODUCTOR|PRODUCTORA|TEST|DESARROLLO|DETECCION|MULTIRRESISTENTE)$/i.test(rest[1])) {
    return genus + " " + rest[1].toLowerCase().replace(/\.$/, "") + (rest[2] ? " " + rest[2].toLowerCase() : "");
  }
  return genus;
}
function _tipoFrom(nameUp, all) {
  const n = nameUp;
  if (/HEMOCULTIVO/.test(n)) return "Hemocultivo" + (/CENTRAL/.test(n) ? " central" : (/PERIF/.test(n) ? " periférico" : "")) + ((n.match(/\b(\d)\b/) || [])[1] ? " " + n.match(/\b(\d)\b/)[1] : "");
  if (/UROCULTIVO|CULTIVO\s+DE\s+ORINA/.test(n)) return "Urocultivo";
  if (/COPROCULTIVO|HECES/.test(n)) return "Coprocultivo";
  if (/PLEURAL/.test(n)) return "Cultivo líquido pleural";
  if (/PERITONEAL|ASCIT/.test(n)) return "Cultivo líquido peritoneal";
  if (/CEFALORRAQU|\bLCR\b/.test(n)) return "Cultivo LCR";
  if (/CATETER/.test(n)) return "Cultivo punta de catéter";
  if (/BRONQUIAL|TRAQUEAL|EXPECTORACION|ESPUTO|LAVADO/.test(n)) return "Cultivo de secreción bronquial";
  if (/SECRECION|HERIDA|ABSCESO|EXUDADO/.test(n)) return "Cultivo de secreción";
  if (/LIQUIDO/.test(n)) return "Cultivo de líquido";
  if (/CULTIVO\s+DE\s+/.test(n)) return "Cultivo de " + n.replace(/^CULTIVO\s+DE\s+/, "").toLowerCase();
  if (all) return _tipoFrom(all, "");
  return "Cultivo";
}
function _parseAbRows(rows, nOrgs) {
  // rows: líneas del bloque "Antibioticos CMI ug/mL Cat." → [{antibiotico, cols:[{cim,interp}], cim, interp}]
  const out = [];
  for (const raw of rows) {
    const L = raw.trim(); if (!L) continue;
    const U = _up(L);
    if (/^ANTIBIOTICOS?\b/.test(U) || /^-\s*\d+\s*-/.test(U) || /^CMI\b/.test(U) || CULTURE_STOP_RE.test(U)) continue;
    const toks = L.split(/\s+/);
    // nombre = tokens iniciales hasta el primer CIM o interpretación
    let i = 0; const nameToks = [];
    while (i < toks.length && !CULTURE_CIM_TOKEN_RE.test(toks[i]) && !_interp(toks[i])) { nameToks.push(toks[i]); i++; }
    if (!nameToks.length || i >= toks.length) continue;
    const name = nameToks.join(" ");
    if (/^\d/.test(name) || name.length < 3) continue;
    const cols = []; let cim = "";
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (CULTURE_CIM_TOKEN_RE.test(t)) { cim = t.replace(/\s+/g, ""); continue; }
      if (/^(ug|µg|μg|mg)\/?m?l$/i.test(t)) continue;
      const it = _interp(t);
      if (it) { cols.push({ cim, interp: it }); cim = ""; continue; }
      if (/^(SENSIBLE|RESISTENTE|INTERMEDI[OA])$/i.test(t)) { cols.push({ cim, interp: _interp(t) }); cim = ""; continue; }
      break;
    }
    if (!cols.length) continue;
    const worst = cols.some((c) => c.interp === "R") ? "R" : (cols.some((c) => c.interp === "I") ? "I" : (cols.some((c) => c.interp === "SDD") ? "SDD" : "S"));
    out.push({ antibiotico: name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(), cim: cols[0].cim, interp: worst, cols: cols.length > 1 || nOrgs > 1 ? cols : undefined });
  }
  return out;
}
function _newSection(nameLine, inline) {
  return { nombre: nameLine, tipo: "", muestra: "", resultado: "", detalle: "", germenes: [], antibiograma: [], ufc: "", deteccion: "", _inline: inline || "", _lines: [] };
}

/**
 * Lee el texto plano del PDF de un reporte con cultivos del HGL (o formatos similares) y devuelve
 * una sección por muestra (hemocultivo periférico/central, urocultivo, secreción…), cada una con
 * resultado, gérmenes (con BLEE/carbapenemasa/MRSA, UFC, hora de detección) y antibiograma por
 * germen cuando el reporte trae varias columnas ("- 1 - - 2 - - 3 -").
 * @returns {null | { v, tipo, muestra, resultado, germenes: string[], blee, carbapenemasa, mrsa, ufc,
 *                    antibiograma: Array<{antibiotico,cim,interp,cols?}>, pendiente, secciones: Array }}
 */
export function extractCultureFromText(text) {
  if (!text || typeof text !== "string" || !CULTURE_TEXT_MARKERS.test(text)) return null;
  // El PDF pega columnas con tabulador ("Test negativo para ESBL\t3. Morganella morganii"): cada tab es línea aparte.
  const lines = text.split(/\r?\n|\t/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const bodyStart = lines.findIndex((l) => /^EXAMENES\s+RESULTADOS/i.test(_up(l)));
  const body = bodyStart >= 0 ? lines.slice(bodyStart + 1) : lines;

  // 1) Partir en secciones (muestras)
  const secciones = [];
  let cur = null;
  for (const line of body) {
    const U = _up(line);
    if (CULTURE_STOP_RE.test(U)) { if (/^GRAM$|TINCION DE GRAM/.test(U)) cur = null; continue; }
    const sm = line.match(CULTURE_SECTION_RE);
    if (sm && !/^CULTIVO\s+(POSITIVO|NEGATIVO|NO\s+DESARROLLO|DESARROLLO|SIN)/i.test(line)) {
      cur = _newSection(sm[1].trim(), sm[2] || "");
      secciones.push(cur);
      continue;
    }
    if (!cur) {
      // Formatos sin encabezado de sección: una sola sección implícita
      if (/CULTIVO|MICROORGANISMO|MICRORGANISMO|ANTIBIOGRAMA|ANTIBIOTICOS|UFC|SE AISL|DESARROLLO/.test(U) || CULTURE_GENUS_RE.test(line) || CULTURE_ANTIBIOTIC_RE.test(U)) {
        cur = _newSection("", ""); secciones.push(cur);
      } else continue;
    }
    cur._lines.push(line);
  }
  if (!secciones.length) return null;

  // 2) Interpretar cada sección
  const allUp = _up(text);
  for (const s of secciones) {
    const nameUp = _up(s.nombre);
    s.tipo = _tipoFrom(nameUp, nameUp ? "" : allUp);
    const inlineUp = _up(s._inline);
    const L = s._lines;
    const LU = L.map(_up);
    for (const ml of L) {
      const mm = ml.match(/^(?:TIPO\s+DE\s+MUESTRA|MUESTRA|ESP[EÉ]CIMEN|PRODUCTO)\b\s*[:\-]?\s*([A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ,.\/()\-]{2,60})/i);
      if (mm) { s.muestra = mm[1].trim().replace(/\s+(FECHA|HORA|METODO|METODOLOGIA|RESULTADO|CULTIVO).*$/i, ""); break; }
    }
    // Gérmenes: "Microrganismo" + "N. Nombre", "MICROORGANISMO AISLADO: X", "Se aisla X", "Desarrollo de X (y Y)"
    let inOrgList = false, lastGerm = null;
    let abStart = -1;
    for (let i = 0; i < L.length; i++) {
      const line = L[i], U = LU[i];
      if (/^ANTIBIOTICOS?\b/.test(U) || /^ANTIBIOGRAMA/.test(U)) { abStart = i; break; }
      if (/^MICRO+RGANISMOS?\s*(AISLADOS?)?\s*:?$/.test(U)) { inOrgList = true; continue; }
      const mkGerm = (g) => { lastGerm = { nombre: g, flags: [], ufc: "", deteccion: "", antibiograma: [] }; s.germenes.push(lastGerm); };
      let germLine = false;
      const numbered = line.match(/^(\d+)\.\s*(.+)$/);
      if (numbered && (inOrgList || CULTURE_GENUS_RE.test(numbered[2]))) {
        mkGerm(_germFromLine(numbered[2]) || numbered[2].replace(/\.$/, "").trim());
        germLine = true;
      }
      if (!germLine) {
        const inlineOrg = line.match(/(?:MICRO+RGANISMOS?\s+AISLADOS?|GERMEN(?:ES)?\s+AISLADOS?|SE\s+AISL[AO]N?|CRECIMIENTO\s+DE|DESARROLLO\s+DE)\s*:?\s*(.+)$/i);
        if (inlineOrg && !/^\s*(SIN|NO)\s+DESARROLLO/i.test(inlineOrg[1]) && !TEST_LINE_RE.test(U)) {
          const parts = inlineOrg[1].split(/\s+(?:Y|E|\+|,)\s+|,\s*/i);
          for (const p of parts) { const g = _germFromLine(p); if (g) { mkGerm(g); germLine = true; } }
        }
      }
      if (!germLine && !inOrgList && !lastGerm && CULTURE_GENUS_RE.test(line) && !TEST_LINE_RE.test(U) && !/CULTIVO/.test(U) && !CULTURE_ANTIBIOTIC_RE.test(U) && !/NEGATIV|POSITIV/.test(U)) {
        // Germen suelto en su propia línea (formatos sin "Microrganismo")
        const g = _germFromLine(line);
        if (g && /^[A-Za-z]/.test(line) && line.split(" ").length <= 5) { mkGerm(g); germLine = true; }
      }
      // Notas del germen (en su misma línea o en las siguientes)
      const target = lastGerm;
      if (/BETALACTAMASA\s+DE\s+(?:AMPLIO|ESPECTRO)|\bBLEE\b|\bESBL\b/.test(U)) {
        if (/NEGATIV|NO\s+PRODUCTOR|AUSENTE/.test(U)) { /* test negativo */ } else if (target && !target.flags.includes("BLEE")) target.flags.push("BLEE");
      }
      if (/CARBAPENEMASA|\bKPC\b|\bNDM\b|OXA-?48|\bVIM\b/.test(U) && !/NEGATIV|NO\s+PRODUCTOR|AUSENTE/.test(U)) {
        const tipoC = ((U + " " + (LU[i + 1] || "")).match(/\b(KPC|NDM|OXA-?48|VIM|IMP)\b/) || [])[1];
        const f = "carbapenemasa" + (tipoC ? " " + tipoC : "");
        if (target && !target.flags.some((x) => /carbapenemasa/.test(x))) target.flags.push(f);
      }
      if (/METICILIN|\bMRSA\b/.test(U)) {
        const neg = /NEGATIV|SENSIBLE|\bMSSA\b/.test(U) || (i + 1 < L.length && /NEGATIV/.test(LU[i + 1]) && !/RESISTENCIA$/.test(U));
        if (!neg && /POSITIV|RESISTENTE|\bMRSA\b/.test(U) && target && !target.flags.includes("MRSA")) target.flags.push("MRSA");
      }
      if (/PRODUCTOR(?:A)?\s+DE\s+BETALACTAM/.test(U + " " + (LU[i + 1] || "")) && !/ESPECTRO|AMPLIO|BLEE|ESBL/.test(U + " " + (LU[i + 1] || "")) && target && !target.flags.includes("betalactamasa")) target.flags.push("betalactamasa");
      if (/MULTIRRESISTENTE|\bMDR\b|\bXDR\b/.test(U) && target && !target.flags.includes("multirresistente")) target.flags.push("multirresistente");
      const ufcM = line.match(/([<>]?\s*(?:M[AÁ]S\s+DE\s+)?\d[\d.,]*\s*(?:X\s*10\s*\^?\s*\d|E\d)?)\s*UFC\s*\/\s*M?L/i);
      if (ufcM) { const u = ufcM[0].replace(/\s+/g, " ").trim().replace(/^m[aá]s de\s*/i, "> ").replace(/^menos de\s*/i, "< "); if (target) target.ufc = u; else s.ufc = u; }
      const det = line.match(/DETECCI[OÓ]N\s+A\s+(?:LAS\s+)?(\d{1,2}:\d{2})\s*H/i);
      if (det && target) target.deteccion = det[1] + " h";
    }
    // Antibiograma
    if (abStart >= 0) {
      const rows = L.slice(abStart);
      const marker = rows.find((r) => /^-\s*\d+\s*-/.test(r));
      const nCols = marker ? (marker.match(/-\s*\d+\s*-/g) || []).length : 1;
      s.antibiograma = _parseAbRows(rows, nCols);
      // Asignar columnas a gérmenes cuando el conteo coincide
      if (s.germenes.length > 1 && s.antibiograma.length) {
        for (const ab of s.antibiograma) {
          const cols = ab.cols || [{ cim: ab.cim, interp: ab.interp }];
          cols.forEach((c, ci) => { if (s.germenes[ci]) s.germenes[ci].antibiograma.push({ antibiotico: ab.antibiotico, cim: c.cim, interp: c.interp }); });
        }
      } else if (s.germenes.length === 1) {
        s.germenes[0].antibiograma = s.antibiograma.map((ab) => ({ antibiotico: ab.antibiotico, cim: ab.cim, interp: ab.interp }));
      }
    } else {
      // Sin bloque: filas sueltas "AMIKACINA <=2 S" / "VANCOMICINA SENSIBLE CIM 1" con antibiótico conocido
      const rows = L.filter((l) => CULTURE_ANTIBIOTIC_RE.test(_up(l)) && !CULTURE_GENUS_RE.test(l));
      const parsed = [];
      for (const r of rows) {
        const U = _up(r); const am = U.match(CULTURE_ANTIBIOTIC_RE); if (!am) continue;
        const after = U.slice(am.index + am[0].length).replace(/\b(CIM|MIC)\s*[:=]?/g, " ").trim();
        const toks = after.split(/\s+/).filter(Boolean);
        let interp = "", cim = "";
        for (const t of toks) { if (!interp && _interp(t)) interp = _interp(t); else if (!cim && CULTURE_CIM_TOKEN_RE.test(t)) cim = t; }
        if (!interp) continue;
        const name = am[1].replace(/\s+/g, " ");
        if (parsed.some((p) => _up(p.antibiotico) === name)) continue;
        parsed.push({ antibiotico: name.charAt(0) + name.slice(1).toLowerCase(), cim, interp });
      }
      s.antibiograma = parsed;
      if (s.germenes.length === 1) s.germenes[0].antibiograma = parsed.slice();
    }
    // Resultado de la sección
    const bodyUp = (inlineUp + "\n" + LU.join("\n"));
    const negLine = LU.find((u) => /^NEGATIVO\s+A\s+(?:LOS\s+)?\d+\s+DIAS?/.test(u) || /^CULTIVO\s+(NO\s+DESARROLLO|SIN\s+DESARROLLO|NEGATIVO)/.test(u) || /^(SIN|NO)\s+DESARROLLO$/.test(u));
    if (s.germenes.length || s.antibiograma.length) { s.resultado = "POSITIVO"; }
    else if (/SIN\s+MUESTRA/.test(bodyUp)) { s.resultado = "SIN MUESTRA"; s.detalle = "sin muestra"; }
    else if (/EN\s+PROCESO|PRELIMINAR|INCUBACION|PENDIENTE/.test(bodyUp) && !negLine) { s.resultado = "PENDIENTE"; s.detalle = "en proceso"; }
    else if (negLine || /^(DESARROLLO|NO\s+DESARROLLO|SIN\s+DESARROLLO)$/.test(inlineUp) || CULTURE_NEG_RE.test(bodyUp)) {
      s.resultado = "NEGATIVO";
      const d = bodyUp.match(/NEGATIVO\s+A\s+(?:LOS\s+)?(\d+)\s+DIAS?/) || bodyUp.match(/SIN\s+DESARROLLO\s+A\s+(?:LAS\s+)?(\d+)\s+H/);
      s.detalle = d ? (/DIAS?/.test(d[0]) ? "negativo a " + d[1] + " días" : "sin desarrollo a " + d[1] + " h") : "sin desarrollo";
    }
    else if (/\bPOSITIV[OA]\b/.test(bodyUp)) { s.resultado = "POSITIVO"; s.detalle = "positivo (germen en el reporte)"; }
    else { s.resultado = ""; }
    delete s._lines; delete s._inline;
  }
  const valid = secciones.filter((s) => s.resultado);
  if (!valid.length) return null;

  // 3) Resumen compatible (primera sección positiva; si no hay, la primera)
  const prim = valid.find((s) => s.resultado === "POSITIVO") || valid[0];
  const flat = (arr) => [].concat(...arr);
  const germNames = flat(valid.map((s) => s.germenes.map((g) => g.nombre + (g.flags.length ? " (" + g.flags.join(", ") + ")" : ""))));
  const antibiograma = flat(valid.map((s) => s.antibiograma));
  const anyPos = valid.some((s) => s.resultado === "POSITIVO");
  const anyPend = valid.some((s) => s.resultado === "PENDIENTE" || s.resultado === "SIN MUESTRA");
  const resultado = anyPos ? "POSITIVO" : (valid.every((s) => s.resultado === "NEGATIVO") ? "NEGATIVO" : (anyPend ? "PENDIENTE" : valid[0].resultado));
  const allFlags = flat(valid.map((s) => flat(s.germenes.map((g) => g.flags))));
  return {
    v: CULTURE_PARSER_VERSION,
    tipo: prim.tipo || "Cultivo", muestra: prim.muestra || "", resultado,
    germenes: germNames,
    blee: allFlags.includes("BLEE"), carbapenemasa: allFlags.some((f) => /carbapenemasa/.test(f)), mrsa: allFlags.includes("MRSA"),
    ufc: (flat(valid.map((s) => s.germenes.map((g) => g.ufc))).find(Boolean)) || prim.ufc || "",
    antibiograma,
    pendiente: resultado === "PENDIENTE",
    secciones: valid.map((s) => ({ nombre: s.nombre, tipo: s.tipo, muestra: s.muestra, resultado: s.resultado, detalle: s.detalle, germenes: s.germenes, antibiograma: s.antibiograma })),
  };
}

/**
 * Parsea un buffer de PDF y devuelve valores tipados + texto plano (el texto solo se conserva si
 * el reporte es un cultivo: la app lo muestra íntegro y sirve para afinar extractCultureFromText).
 * @param {Buffer} buffer
 * @returns {Promise<{valores: Array, text: string, cultivo: object|null}>}
 */
export async function parsePdfToReport(buffer) {
  if (!buffer || !buffer.length) return { valores: [], text: "", cultivo: null };
  let parser = null;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result && result.text) ? String(result.text) : "";
    if (!text) return { valores: [], text: "", cultivo: null };
    const valores = extractLabValuesFromText(text);
    const cultivo = extractCultureFromText(text);
    return { valores, text: cultivo ? text.slice(0, 8000) : "", cultivo };
  } catch (e) {
    console.log(`       [pdf-parse] Error: ${e.message.split("\n")[0]}`);
    return { valores: [], text: "", cultivo: null };
  } finally {
    try { if (parser && typeof parser.destroy === "function") await parser.destroy(); } catch (_) {}
  }
}

/**
 * Parsea un buffer de PDF y extrae valores de lab tipados.
 * @param {Buffer} buffer - PDF crudo descargado
 * @returns {Promise<Array<{estudio,valor,unidad,referencia}>>}
 */
export async function parsePdfToLabValues(buffer) {
  if (!buffer || !buffer.length) return [];
  let parser = null;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    if (!result || !result.text) return [];
    return extractLabValuesFromText(result.text);
  } catch (e) {
    console.log(`       [pdf-parse] Error: ${e.message.split("\n")[0]}`);
    return [];
  } finally {
    // Liberar el documento de pdf.js (oct 2026): sin destroy() cada PDF quedaba vivo en memoria
    // durante toda la corrida (~500 PDFs) — contribuía al colapso por memoria del proceso.
    try { if (parser && typeof parser.destroy === "function") await parser.destroy(); } catch (_) {}
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
