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
export const CULTURE_TEXT_MARKERS = /CULTIVO|ANTIBIOGRAMA|MICROORGANISMO|GERMEN|AISLAD[OA]|UFC\s*\/\s*ML|SENSIBILIDAD\s+ANTIMICROBIANA|TINCI[OÓ]N\s+DE\s+GRAM/i;
export const CULTURE_GENUS_RE = /\b(ESCHERICHIA|KLEBSIELLA|ENTEROBACTER|PROTEUS|PSEUDOMONAS|ACINETOBACTER|STAPHYLOCOCCUS|STREPTOCOCCUS|ENTEROCOCCUS|CANDIDA|SERRATIA|MORGANELLA|CITROBACTER|STENOTROPHOMONAS|PROVIDENCIA|SALMONELLA|SHIGELLA|HAEMOPHILUS|BURKHOLDERIA|BACTEROIDES|CLOSTRIDI(?:UM|OIDES)|LISTERIA|NEISSERIA|MORAXELLA|AEROMONAS|ACHROMOBACTER|CORYNEBACTERIUM|MICROCOCCUS|KOCURIA|RAOULTELLA|HAFNIA|PANTOEA|SPHINGOMONAS|ELIZABETHKINGIA|CHRYSEOBACTERIUM|ASPERGILLUS|CRYPTOCOCCUS|TRICHOSPORON|BACILLUS|LACTOBACILLUS|PEPTOSTREPTOCOCCUS|FUSOBACTERIUM|PREVOTELLA|ALCALIGENES|OCHROBACTRUM|RALSTONIA|EDWARDSIELLA|YERSINIA|VIBRIO|CAMPYLOBACTER|HELICOBACTER|MYCOBACTERIUM|NOCARDIA|ACTINOMYCES|GARDNERELLA|TRICHOMONAS|E\.\s?COLI|S\.\s?AUREUS)\b/i;
export const CULTURE_ANTIBIOTIC_RE = /\b(AMIKACINA|GENTAMICINA|TOBRAMICINA|ESTREPTOMICINA|CIPROFLOXACIN[OA]|LEVOFLOXACIN[OA]|MOXIFLOXACIN[OA]|NORFLOXACIN[OA]|OFLOXACIN[OA]|CEFTRIAXONA|CEFOTAXIMA|CEFTAZIDIMA(?:[\s\-\/]+AVIBACTAM)?|CEFEPIM[AE]|CEFUROXIMA|CEFAZOLINA|CEFOXITINA|CEFALOTINA|CEFALEXINA|CEFIXIMA|CEFTAROLINA|CEFTOLOZAN[OA](?:[\s\-\/]+TAZOBACTAM)?|CEFIDEROCOL|AMPICILINA(?:[\s\-\/]+SULBACTAM)?|AMOXICILINA(?:[\s\-\/]+(?:[AÁ]C(?:IDO)?\.?\s+)?CLAVUL[AÁ]NICO)?|PIPERACILINA(?:[\s\-\/]+TAZOBACTAM)?|TICARCILINA(?:[\s\-\/]+CLAVULANATO)?|OXACILINA|PENICILINA(?:\s+G)?|DICLOXACILINA|MEROPENEM|IMIPENEM(?:[\s\-\/]+CILASTATINA)?|ERTAPENEM|DORIPENEM|AZTREONAM|VANCOMICINA|TEICOPLANINA|LINEZOLID|DAPTOMICINA|CLINDAMICINA|ERITROMICINA|CLARITROMICINA|AZITROMICINA|TRIMETOPRIM(?:A)?(?:[\s\-\/]+SULFAMETOXAZOL)?|SULFAMETOXAZOL(?:[\s\-\/]+TRIMETOPRIM(?:A)?)?|NITROFURANTO[IÍ]NA|FOSFOMICINA|COLISTINA|POLIMIXINA\s*B|TIGECICLINA|DOXICICLINA|MINOCICLINA|TETRACICLINA|RIFAMPICINA|CLORANFENICOL|METRONIDAZOL|QUINUPRISTINA(?:[\s\-\/]+DALFOPRISTINA)?|FLUCONAZOL|VORICONAZOL|ITRACONAZOL|POSACONAZOL|ANFOTERICINA\s*B|CASPOFUNGINA|MICAFUNGINA|ANIDULAFUNGINA|FLUCITOSINA|BENZILPENICILINA|CEFOTETAN|CEFACLOR|CEFPODOXIMA|CEFDITOREN|LOMEFLOXACIN[OA]|GATIFLOXACIN[OA]|NETILMICINA|KANAMICINA|TEDIZOLID|DALBAVANCINA|ORITAVANCINA|FUSIDICO|MUPIROCINA)\b/i;
const CULTURE_INTERP_RE = /^(S|I|R|SDD|SENSIBLE|SUSCEPTIBLE|INTERMEDI[OA]|RESISTENTE|SENSIBLE\s+DOSIS\s+DEPENDIENTE)$/i;
const CULTURE_CIM_RE = /^(?:CIM|MIC)?\s*[:=]?\s*([<>≤≥]=?\s*\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?(?:\s*(?:ug|µg|μg|mg)\s*\/\s*m?l)?)$/i;
const CULTURE_NEG_RE = /SIN\s+DESARROLLO|NO\s+(?:HUBO|HAY|SE\s+OBSERV[OÓ])?\s*DESARROLLO|NO\s+DESARROLLO|SIN\s+CRECIMIENTO|NEGATIV[OA]\s+A\s+(?:LOS\s+|LAS\s+)?\d+|AUSENCIA\s+DE\s+(?:DESARROLLO|CRECIMIENTO)|FLORA\s+(?:NORMAL|HABITUAL|MIXTA\s+NORMAL)|NO\s+SE\s+AISL/i;
const CULTURE_POS_RE = /\bPOSITIV[OA]\b|DESARROLLO\s+DE\b|SE\s+AISL[AO]|CRECIMIENTO\s+DE\b|MICROORGANISMO\s+AISLADO|GERMEN\s+AISLADO|\bUFC\b/i;
const CULTURE_PENDING_RE = /PRELIMINAR|EN\s+PROCESO|PENDIENTE|INCUBACI[OÓ]N|EN\s+CURSO/i;

function _interp(tok) {
  const t = String(tok || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!CULTURE_INTERP_RE.test(t)) return "";
  if (t === "SDD" || /DOSIS DEPENDIENTE/.test(t)) return "SDD";
  return t[0]; // S / I / R
}
function _cleanGenus(g) {
  const u = String(g || "").toUpperCase();
  if (/^E\.?\s?COLI/.test(u)) return "Escherichia coli";
  if (/^S\.?\s?AUREUS/.test(u)) return "Staphylococcus aureus";
  return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
}

/**
 * @param {string} text - texto plano del PDF del reporte
 * @returns {null | { tipo, muestra, resultado, germenes: string[], blee: boolean, carbapenemasa: boolean,
 *                    ufc: string, antibiograma: Array<{antibiotico, cim, interp}>, pendiente: boolean }}
 */
export function extractCultureFromText(text) {
  if (!text || typeof text !== "string" || !CULTURE_TEXT_MARKERS.test(text)) return null;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const up = (s) => s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const all = up(lines.join("\n"));

  // Tipo y muestra
  const tipo = /HEMOCULTIVO/.test(all) ? "Hemocultivo"
    : /UROCULTIVO|CULTIVO\s+DE\s+ORINA/.test(all) ? "Urocultivo"
    : /L[IÍ]QUIDO\s+PLEURAL|PLEURAL/.test(all) ? "Cultivo líquido pleural"
    : /L[IÍ]QUIDO\s+PERITONEAL|PERITONEAL|ASC[IÍ]TICO/.test(all) ? "Cultivo líquido peritoneal"
    : /L[IÍ]QUIDO\s+CEFALORRAQU[IÍ]DEO|\bLCR\b/.test(all) ? "Cultivo LCR"
    : /PUNTA\s+DE\s+CAT[EÉ]TER|CAT[EÉ]TER/.test(all) ? "Cultivo punta de catéter"
    : /SECRECI[OÓ]N\s+BRONQUIAL|ASPIRADO\s+(?:BRONQUIAL|TRAQUEAL)|EXPECTORACI[OÓ]N|ESPUTO|LAVADO\s+BRONCO/.test(all) ? "Cultivo de secreción bronquial"
    : /HERIDA|SECRECI[OÓ]N|ABSCESO|EXUDADO/.test(all) ? "Cultivo de herida/secreción"
    : /COPROCULTIVO|HECES/.test(all) ? "Coprocultivo"
    : "Cultivo";
  let muestra = "";
  const mm = all.match(/(?:MUESTRA|TIPO\s+DE\s+MUESTRA|ESPECIMEN|PRODUCTO)\s*[:\-]\s*([A-ZÑ][A-ZÑ0-9 ,.\/()\-]{2,60})/);
  if (mm) muestra = mm[1].trim().replace(/\s+(FECHA|HORA|METODO|METODOLOGIA|RESULTADO).*$/, "");

  // Gérmenes (género + especie), flags de resistencia
  const germenes = [];
  const seen = new Set();
  const addGerm = (g) => { const key = g.toUpperCase(); if (!seen.has(key)) { seen.add(key); germenes.push(g); } };
  for (const line of lines) {
    const L = up(line);
    if (CULTURE_ANTIBIOTIC_RE.test(L) && !CULTURE_GENUS_RE.test(L)) continue;
    let m;
    const re = new RegExp(CULTURE_GENUS_RE.source, "gi");
    while ((m = re.exec(line))) {
      const genus = _cleanGenus(m[1]);
      let species = "";
      if (!/ /.test(genus)) {
        const rest = line.slice(m.index + m[0].length).match(/^\s+(SP\.?|SPP\.?|[A-Za-zñÑ\-]{3,})(?:\s+(?:SUBSP\.?|VAR\.?)\s+([A-Za-z\-]{3,}))?/);
        if (rest && !/^(SENSIBLE|RESISTENTE|INTERMEDIO|AISLADO|POSITIVO|NEGATIVO|UFC|BLEE|ESBL|CIM|MIC|SIN|CON|POR|EN|DE|DEL|LA|EL|AL|METICILINO|MRSA|MSSA)$/i.test(rest[1])) {
          species = " " + rest[1].toLowerCase() + (rest[2] ? " " + rest[2].toLowerCase() : "");
        }
      }
      addGerm(genus + species);
    }
  }
  const blee = /\bBLEE\b|\bESBL\b|BETA\s*-?\s*LACTAMASA\s+DE\s+ESPECTRO\s+EXTENDIDO/.test(all) && !/\bBLEE\s*[:\-]?\s*(NEGATIV[OA]|NO\s+PRODUCTOR|AUSENTE)/.test(all);
  const carbapenemasa = /CARBAPENEMASA|\bKPC\b|\bNDM\b|\bOXA-?48\b|\bVIM\b|\bIMP\b/.test(all) && !/CARBAPENEMASA\s*[:\-]?\s*(NEGATIV[OA]|NO\s+PRODUCTOR|AUSENTE)/.test(all);
  const mrsa = /\bMRSA\b|METICILINO\s*-?\s*RESISTENTE|RESISTENTE\s+A\s+METICILINA/.test(all);
  const ufcM = all.match(/([<>]?\s*\d[\d.,]*\s*(?:X\s*10\s*\^?\s*\d|E\d)?)\s*UFC\s*\/\s*ML/);
  const ufc = ufcM ? ufcM[0].replace(/\s+/g, " ").trim() : "";

  // Antibiograma: línea con antibiótico + (CIM)? + interpretación, o interpretación primero.
  const antibiograma = [];
  const seenAb = new Set();
  for (const line of lines) {
    const L = up(line);
    const am = L.match(CULTURE_ANTIBIOTIC_RE);
    if (!am) continue;
    const name = am[1].replace(/\s+/g, " ").trim();
    const before = L.slice(0, am.index).trim();
    const after = L.slice(am.index + am[0].length).trim();
    const toks = after.split(/\s+/).filter(Boolean);
    let interp = "", cim = "";
    // "NOMBRE  <=2  S" / "NOMBRE S" / "NOMBRE  SENSIBLE  <=2" / "NOMBRE 4 ug/mL R"
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!interp && _interp(t)) { interp = _interp(t); continue; }
      if (!interp && i + 2 < toks.length && _interp(toks[i] + " " + toks[i + 1] + " " + toks[i + 2])) { interp = "SDD"; i += 2; continue; }
      if (!cim) {
        const joined = [t, toks[i + 1] || "", toks[i + 2] || ""].join(" ").trim();
        const cm = (CULTURE_CIM_RE.test(t) ? t : (CULTURE_CIM_RE.test(joined) ? joined : (CULTURE_CIM_RE.test(t + " " + (toks[i + 1] || "")) ? t + " " + toks[i + 1] : "")));
        if (cm) { cim = cm.replace(/^(CIM|MIC)\s*[:=]?\s*/i, "").replace(/\s+/g, " "); i += cm.split(" ").length - 1; continue; }
      }
    }
    if (!interp && before) { const bt = before.split(/\s+/); const last = bt[bt.length - 1]; if (_interp(last)) interp = _interp(last); }
    if (!interp) continue; // antibiótico mencionado sin S/I/R (p.ej. en el tratamiento) → no es antibiograma
    const key = name;
    if (seenAb.has(key)) continue;
    seenAb.add(key);
    antibiograma.push({ antibiotico: name.charAt(0) + name.slice(1).toLowerCase(), cim, interp });
  }

  const pendiente = CULTURE_PENDING_RE.test(all) && !germenes.length && !antibiograma.length;
  let resultado = "";
  if (germenes.length || antibiograma.length) resultado = "POSITIVO";
  else if (CULTURE_NEG_RE.test(all)) resultado = "NEGATIVO";
  else if (CULTURE_POS_RE.test(all)) resultado = "POSITIVO";
  else if (pendiente) resultado = "PENDIENTE";
  else return null; // texto con la palabra CULTIVO pero sin resultado reconocible
  if (resultado === "POSITIVO" && germenes.length === 0 && mrsa) germenes.push("Staphylococcus aureus");
  return { tipo, muestra, resultado, germenes, blee, carbapenemasa, mrsa, ufc, antibiograma, pendiente: resultado === "PENDIENTE" };
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
