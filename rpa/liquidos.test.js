// Tests de líquidos, citológico/citoquímico y paneles (19 nov 2026): «no aparecen paneles virales, citológicos ni
// citoquímicos». Textos SINTÉTICOS con el acomodo real de los PDF del HGL (valores inventados, sin datos de pacientes).
// Corre con: `node rpa/liquidos.test.js`

import {
  extractLabValuesFromText,
  extractCultureFromText,
  compactReportText,
  parsePdfToReport,
  REPORTE_TEXTO_MAX,
  CULTURE_PARSER_VERSION,
} from "./pdf-extract.js";
import { isPendingReport, isTextReportInProcess, hasStaleFluidValores, orderDrillCandidates } from "./drill-order.js";
import { indexParsedReportes, mergeReportesPreservingValores, looksLikeCultureReport } from "./lib.js";

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else      { fail++; console.error(`✗ ${name}`); }
}
const J = (x) => JSON.stringify(x);

const H = "HOSPITAL GENERAL DE LEON\nLABORATORIO DE ANÁLISIS CLÍNICOS\nHOJA DE RESULTADOS\nPACIENTE: PERSONA FICTICIA CURP: XXXX000000\nFECHA DE NACIMIENTO: 01/01/1970 EDAD: 56 AÑOS SEXO: MASCULINO\nDIAGNÓSTICO: DX FICTICIO\nEXAMENES RESULTADOS UNIDADES VALORES DE REFERENCIA\n";
const F = "\nQ.F.B. Nombre Apellido\nCed. Prof. 1 REG. SSG 2\nUniversidad DE Guanajuato\nNota: Los resultados deberán ser correlacionados con la clínica.\n* Resultados fuera de rango. B = Bajo, A = Alto, según corresponda.\nPágina No: 1 de 1\n\n-- 1 of 2 --\n\n";

// LCR: hoja 1 = físico + coaglutinación + tinción + cultivo NEGATIVO; hoja 2 = citoquímico (nombres en 2 renglones,
// bandera *A sola) + recuento celular. Mismo acomodo que los PDF reales.
const LCR = H + [
  "LIQUIDO CEFALORRAQUIDEO", "EXAMEN FÍSICO", "Volumen 7 ml 5.0 - 10.0", "Aspecto TURBIO Transparente (agua de", "roca)",
  "Color INCOLORO Incoloro", "COAGLUTINACIÓN", "Neisseria meningitidis A NEGATIVO Negativo",
  "Neisseria meningitidis B/E.coli NEGATIVO Negativo", "Haemophilus influenzae b NEGATIVO Negativo",
  "Streptococcus pneumoniae NEGATIVO Negativo", "Streptococcus grupo B NEGATIVO Negativo", "TINCION",
  "Gram NO SE OBSERVAN", "BACTERIAS", "No se observan", "microorganismos", "Tinta China NEGATIVO Negativo",
  "CULTIVO", "CULTIVO DESARROLLO", "NEGATIVO A 5 DIAS", "Sin desarrollo",
].join("\n") + F + H + [
  "GLUCOSA EN LIQUIDO", "CEFALORRAQUIDEO", "METODOLOGIA: QUIMICA SECA", "*A", "73.0 mg/dL 40.0 - 70.0",
  "PROTEINAS EN LIQUIDO", "CEFALORRAQUIDEO", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA", "*A", "242.8 mg/dL 15.0 - 45.0",
  "DESHIDROGENASA LACTICA EN LIQUIDO", "CEFALORRAQUIDEO", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA", "54 U/L 0 - 200",
  "CLORO EN LIQUIDO CEFALORRAQUIDEO", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA", "*B\t115 mmol/L 120 - 130",
  "RECUENTO CELULAR DE LCR", "CITOMETRIA DE FLUJO FLUORESCENTE", "LEUCOCITOS 0.030 10³/μL 0.000 - 5.000",
  "ERITROCITOS 0.001 10^6/μL Ausentes", "RECUENTO DIFERENCIAL", "POLIMORFONUCLEARES % 13.30 % Ausentes",
  "POLIMORFONUCLEARES # 0.004 10³/μL Ausentes", "MONONUCLEARES % 86.70 % Ausentes", "MONONUCLEARES # 0.026 10³/μL Ausentes",
].join("\n") + F;

// ── 1. LCR: citoquímico con el nombre completo y los valores fuera de rango ─────────────────────────────────
{
  const v = extractLabValuesFromText(LCR);
  const by = (n) => v.find((x) => x.estudio === n);
  assert(by("GLUCOSA EN LIQUIDO CEFALORRAQUIDEO") && by("GLUCOSA EN LIQUIDO CEFALORRAQUIDEO").valor === "73.0" && by("GLUCOSA EN LIQUIDO CEFALORRAQUIDEO").unidad === "mg/dL",
    "LCR: glucosa con el nombre de 2 renglones unido y el valor FUERA DE RANGO (bandera *A sola) capturado");
  assert(by("PROTEINAS EN LIQUIDO CEFALORRAQUIDEO") && by("PROTEINAS EN LIQUIDO CEFALORRAQUIDEO").valor === "242.8", "LCR: proteínas *A (antes se perdían)");
  assert(by("DESHIDROGENASA LACTICA EN LIQUIDO CEFALORRAQUIDEO") && by("DESHIDROGENASA LACTICA EN LIQUIDO CEFALORRAQUIDEO").valor === "54", "LCR: DHL con nombre completo (antes «CEFALORRAQUIDEO»)");
  assert(by("CLORO EN LIQUIDO CEFALORRAQUIDEO") && by("CLORO EN LIQUIDO CEFALORRAQUIDEO").valor === "115", "LCR: cloro *B con tabulador");
  assert(!v.some((x) => /^(CEFALORRAQUIDEO|PERITONEAL|PLEURAL)$/.test(x.estudio)), "LCR: ningún estudio queda con el nombre partido");
  const leu = by("LEUCOCITOS");
  assert(leu && leu.valor === "0.030" && leu.seccion === "LIQUIDO CEFALORRAQUIDEO", "LCR: recuento celular con seccion (la app no lo confunde con leucocitos de sangre)");
  assert(by("POLIMORFONUCLEARES %") && by("POLIMORFONUCLEARES %").valor === "13.30" && by("MONONUCLEARES %").valor === "86.70" && by("POLIMORFONUCLEARES #").valor === "0.004", "LCR: diferencial % y # (antes no se leía)");
  assert(by("Volumen") && by("Volumen").valor === "7" && by("ASPECTO").valor === "TURBIO" && by("COLOR").valor === "INCOLORO", "LCR: examen físico en minúsculas (volumen, aspecto, color)");
  assert(by("S. pneumoniae") && by("S. pneumoniae").valor === "NEGATIVO" && by("H. influenzae b") && by("Neisseria meningitidis A"), "LCR: coaglutinación con el género abreviado");
  assert(!v.some((x) => /STREPTOCOC|HAEMOPHILUS|ESCHERICHIA|STAPHYLOCOC/i.test(x.estudio + " " + x.valor + " " + x.referencia)),
    "LCR: ningún valor de panel lleva un género completo (una app vieja lo tomaría como cultivo positivo)");
  assert(by("S. pneumoniae").seccion === "LIQUIDO CEFALORRAQUIDEO · COAGLUTINACION", "LCR: coaglutinación con su sección");
  assert(by("Gram") && by("Gram").valor === "NO SE OBSERVAN BACTERIAS" && by("Tinta China") && by("Tinta China").valor === "NEGATIVO", "LCR: Gram y tinta china");
  assert(by("NEGATIVO A") && by("NEGATIVO A").valor === "5" && by("NEGATIVO A").unidad === "DIAS", "LCR: «NEGATIVO A 5 DIAS» igual que antes (la app lo usa)");
  const c = extractCultureFromText(LCR);
  assert(c && c.v === CULTURE_PARSER_VERSION && c.resultado === "NEGATIVO" && c.germenes.length === 0 && c.tipo === "Cultivo LCR",
    "LCR: el cultivo NEGATIVO ya no sale POSITIVO con «gérmenes» del citoquímico (0 mg/dL…)");
  assert(c && /5 días/.test(c.secciones[0].detalle), "LCR: detalle «negativo a 5 días»");
}

// ── 2. Cultivo de LCR positivo real: sigue igual ───────────────────────────────────────────────────────────
{
  const pos = H + ["LIQUIDO CEFALORRAQUIDEO", "TINCION", "Gram NO SE OBSERVAN", "BACTERIAS", "No se observan", "microorganismos",
    "CULTIVO", "CULTIVO POSITIVO SIN DESARROLLO", "Microrganismo", "1. Klebsiella pneumoniae", "Betalactamasa de Amplio Espectro",
    "- 1 -", "Antibioticos CMI ug/mL Cat.", "Amikacina <=4 S", "Meropenem <=0.5 S", "Ceftriaxona >4 R", "S=Sensible; R=Resistente; I=Intermedio"].join("\n") + F
    + H + ["GLUCOSA EN LIQUIDO", "CEFALORRAQUIDEO", "METODOLOGIA: QUIMICA SECA", "*B", "12.0 mg/dL 40.0 - 70.0"].join("\n") + F;
  const c = extractCultureFromText(pos);
  assert(c && c.resultado === "POSITIVO" && c.germenes.length === 1 && c.germenes[0] === "Klebsiella pneumoniae (BLEE)" && c.antibiograma.length === 3,
    "LCR positivo real: un solo germen (Klebsiella BLEE) con antibiograma; la glucosa no se vuelve germen");
  const v = extractLabValuesFromText(pos);
  assert(v.some((x) => x.estudio === "GLUCOSA EN LIQUIDO CEFALORRAQUIDEO" && x.valor === "12.0"), "LCR positivo real: glucosa baja *B capturada");
}

// ── 3. Sangre, química y EGO: idénticos a antes ─────────────────────────────────────────────────────────────
{
  const BLOOD = H + ["BIOMETRIA HEMATICA COMPLETA", "METODOLOGIA: SULFOMETAHEMOGLOBINA, IMPEDANCIA, CITOMETRIA DE FLUJO", "FLUORESCENTE",
    "LEUCOCITOS *A\t20.97 10³/μL 4.00 - 10.00", "ERITROCITOS *B\t3.81 10^6/μL 4.40 - 5.20", "HEMOGLOBINA *B\t10.10 g/dL 12.00 - 16.00",
    "PLAQUETAS *A\t408 10³/μL 130 - 400", "NEUTROFILOS 82.30 %", "GLUCOSA", "METODOLOGIA: QUIMICA SECA", "*B\t53.0 mg/dL 74.0 - 106.0",
    "RELACION A/G", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA", "*B\t0.74 1.10 - 1.80"].join("\n") + F;
  const v = extractLabValuesFromText(BLOOD);
  assert(J(v) === J([
    { estudio: "LEUCOCITOS", valor: "20.97", unidad: "10³/μL", referencia: "4.00 - 10.00" },
    { estudio: "ERITROCITOS", valor: "3.81", unidad: "10^6/μL", referencia: "4.40 - 5.20" },
    { estudio: "HEMOGLOBINA", valor: "10.10", unidad: "g/dL", referencia: "12.00 - 16.00" },
    { estudio: "PLAQUETAS", valor: "408", unidad: "10³/μL", referencia: "130 - 400" },
    { estudio: "NEUTROFILOS", valor: "82.30", unidad: "%", referencia: "" },
    { estudio: "GLUCOSA", valor: "53.0", unidad: "mg/dL", referencia: "74.0 - 106.0" },
    { estudio: "RELACION A/G", valor: "0.74", unidad: "", referencia: "1.10 - 1.80" },
  ]), "Sangre: BH + QS idénticas a antes (sin seccion, mismos campos)");
  const EGO = H + ["EXAMEN GENERAL DE ORINA", "EXAMEN FISICO", "COLOR AMARILLO PAJA - AMARILLO", "DENSIDAD 1.015 1.010 - 1.030",
    "PH *A\t8.0 5.0 - 6.5", "PROTEINAS 300 mg/dL Negativo", "GLUCOSA NEGATIVO Negativo", "NITRITOS NEGATIVO Negativo",
    "LEUCOCITOS 320.10 p/μL < 5", "BACTERIAS 508.64 p/μL < 100"].join("\n") + F;
  const e = extractLabValuesFromText(EGO);
  assert(J(e) === J([
    { estudio: "DENSIDAD", valor: "1.015", unidad: "", referencia: "1.010 - 1.030" },
    { estudio: "PH", valor: "8.0", unidad: "", referencia: "5.0 - 6.5" },
    { estudio: "PROTEINAS", valor: "300", unidad: "mg/dL", referencia: "Negativo" },
    { estudio: "GLUCOSA", valor: "NEGATIVO", unidad: "", referencia: "Negativo" },
    { estudio: "NITRITOS", valor: "NEGATIVO", unidad: "", referencia: "Negativo" },
    { estudio: "LEUCOCITOS", valor: "320.10", unidad: "p/μL", referencia: "< 5" },
    { estudio: "BACTERIAS", valor: "508.64", unidad: "p/μL", referencia: "< 100" },
  ]), "EGO: idéntico a antes");
  // Recuento de LCR seguido de una BH en la misma hoja: la sección del líquido no se le pega a la sangre.
  const leak = extractLabValuesFromText(H + ["RECUENTO CELULAR DE LCR", "LEUCOCITOS 0.030 10³/μL 0.000 - 5.000", "BIOMETRIA HEMATICA COMPLETA",
    "LEUCOCITOS *A\t20.97 10³/μL 4.00 - 10.00", "GLUCOSA", "METODOLOGIA: QUIMICA SECA", "98.0 mg/dL 74.0 - 106.0"].join("\n") + F);
  assert(leak.length === 3 && leak[0].seccion === "LIQUIDO CEFALORRAQUIDEO" && !leak[1].seccion && leak[1].valor === "20.97" && !leak[2].seccion,
    "Sangre tras un líquido en la misma hoja: sin seccion (la BH sigue siendo sangre)");
  // "PANEL DE LIPIDOS" / "PANEL HEPATICO" no abren una sección de panel.
  const lip = extractLabValuesFromText(H + ["PANEL DE LIPIDOS", "COLESTEROL TOTAL 180 mg/dL < 200", "Influenza A NO DETECTADO"].join("\n") + F);
  assert(lip.length === 1 && lip[0].estudio === "COLESTEROL TOTAL" && !lip[0].seccion, "PANEL DE LIPIDOS: química de siempre, sin sección ni renglones en minúsculas");
  // Fuera de una sección, un renglón en MAYÚSCULAS con germen se lee como siempre (sin abreviar).
  const fuera = extractLabValuesFromText(H + "STREPTOCOCCUS PNEUMONIAE NEGATIVO NEGATIVO" + F);
  assert(fuera.length === 1 && fuera[0].estudio === "STREPTOCOCCUS PNEUMONIAE" && !fuera[0].seccion, "Fuera de sección: lectura de siempre");
}

// ── 4. Paneles virales ─────────────────────────────────────────────────────────────────────────────────────
{
  const A = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "METODOLOGIA: PCR MULTIPLE EN TIEMPO REAL", "SARS-CoV-2 NO DETECTADO No detectado",
    "Influenza A NO DETECTADO No detectado", "Influenza A H1N1 NO DETECTADO No detectado", "Influenza B DETECTADO No detectado",
    "Virus Sincitial Respiratorio NO DETECTADO No detectado", "Rinovirus/Enterovirus DETECTADO No detectado"].join("\n") + F);
  const by = (n) => A.find((x) => x.estudio === n);
  assert(A.length === 6 && A.every((x) => x.seccion === "PANEL RESPIRATORIO"), "Panel respiratorio (minúsculas): 6 blancos con su sección");
  assert(by("SARS-CoV-2").valor === "NO DETECTADO" && by("Influenza A H1N1").valor === "NO DETECTADO" && by("Influenza B").valor === "DETECTADO" && by("Rinovirus/Enterovirus").valor === "DETECTADO",
    "Panel respiratorio: DETECTADO / NO DETECTADO sin invertir");
  const B = extractLabValuesFromText(H + ["SARS-COV-2 NO DETECTADO", "INFLUENZA A H1N1 NO DETECTADO", "SARS COV 2 NO DETECTADO", "INFLUENZA A NO DETECTADO", "VIH NO REACTIVO"].join("\n") + F);
  assert(J(B.map((x) => [x.estudio, x.valor])) === J([["SARS-COV-2", "NO DETECTADO"], ["INFLUENZA A H1N1", "NO DETECTADO"], ["SARS COV 2", "NO DETECTADO"], ["INFLUENZA A", "NO DETECTADO"], ["VIH", "NO REACTIVO"]]),
    "Panel en MAYÚSCULAS: el «NO» ya no se queda pegado al nombre («SARS-COV-2 NO» = DETECTADO era lo contrario)");
  const fa = extractLabValuesFromText(H + ["PANEL MENINGITIS/ENCEFALITIS", "Escherichia coli K1 NO DETECTADO No detectado", "Streptococcus agalactiae NO DETECTADO No detectado", "Herpes simple 1 NO DETECTADO No detectado"].join("\n") + F);
  assert(fa.length === 3 && fa[0].estudio === "E. coli K1" && fa[1].estudio === "S. agalactiae" && fa[2].estudio === "Herpes simple 1" && !extractCultureFromText(H + "PANEL MENINGITIS/ENCEFALITIS\nEscherichia coli K1 NO DETECTADO\n" + F),
    "Panel de meningitis: géneros abreviados y nunca un cultivo positivo");
}

// ── 5. Líquido peritoneal: valor pegado al renglón de método, recuento, examen físico ──────────────────────
{
  const v = extractLabValuesFromText(H + ["LIQUIDO PERITONEAL", "EXAMEN FÍSICO", "Volumen 17 ML 5.0 - 10.0", "Color AMARILLO Amarillo paja",
    "RECUENTO CELULAR DE LIQ PERITONEAL", "CITOMETRIA DE FLUJO FLUORESCENTE", "LEUCOCITOS 0.089 10³/μL 0.000 - 5.000",
    "POLIMORFONUCLEARES % 71.90 % Ausentes", "PROTEINA EN LIQUIDO PERITONEAL", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA < 2.0", "g/dL <3",
    "ALBUMINA EN LIQUIDO PERITONEAL", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA < 1.0", "g/dL <2",
    "DESHIDROGENASA LACTICA EN LIQUIDO", "PERITONEAL", "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA", "*A", "1867 U/L <200"].join("\n") + F);
  const by = (n) => v.find((x) => x.estudio === n);
  assert(by("PROTEINA EN LIQUIDO PERITONEAL") && by("PROTEINA EN LIQUIDO PERITONEAL").valor === "< 2.0" && by("PROTEINA EN LIQUIDO PERITONEAL").unidad === "g/dL" && by("PROTEINA EN LIQUIDO PERITONEAL").referencia === "<3",
    "Peritoneal: proteína con el valor pegado al renglón de método y la unidad en el siguiente");
  assert(by("ALBUMINA EN LIQUIDO PERITONEAL") && by("ALBUMINA EN LIQUIDO PERITONEAL").valor === "< 1.0", "Peritoneal: albúmina igual");
  assert(by("DESHIDROGENASA LACTICA EN LIQUIDO PERITONEAL") && by("DESHIDROGENASA LACTICA EN LIQUIDO PERITONEAL").valor === "1867", "Peritoneal: DHL *A con nombre completo (antes «PERITONEAL»)");
  assert(by("LEUCOCITOS").seccion === "LIQUIDO PERITONEAL" && by("POLIMORFONUCLEARES %").valor === "71.90" && by("Volumen").valor === "17", "Peritoneal: recuento, % PMN y volumen con su sección");
  assert(!extractCultureFromText(H + "LIQUIDO PERITONEAL\nLEUCOCITOS 0.089 10³/μL 0.000 - 5.000\n" + F), "Peritoneal sin cultivo: no es cultivo");
  // Citoquímico/citológico con encabezados explícitos
  const p2 = extractLabValuesFromText(H + ["CITOQUIMICO DE LIQUIDO PLEURAL", "Aspecto LIGERAMENTE", "TURBIO", "GLUCOSA EN LIQUIDO PLEURAL", "METODOLOGIA: QUIMICA SECA", "102.0 mg/dL",
    "CITOLOGICO", "LEUCOCITOS 1500 cel/μL", "PMN 80 %", "MN 20 %"].join("\n") + F);
  assert(p2.find((x) => x.estudio === "ASPECTO").valor === "LIGERAMENTE TURBIO" && p2.find((x) => x.estudio === "LEUCOCITOS").seccion === "LIQUIDO PLEURAL" && p2.find((x) => x.estudio === "PMN").valor === "80",
    "Pleural: encabezados CITOQUIMICO/CITOLOGICO, aspecto en 2 renglones y diferencial");
}

// ── 6. Reporte sin lectura: texto compacto SIN datos del paciente ──────────────────────────────────────────
{
  const raro = H + ["ESTUDIO ESPECIAL", "Resultado: ver interpretación", "Interpretación libre del laboratorio"].join("\n") + F + H + ["Segunda hoja del estudio"].join("\n") + F;
  const t = compactReportText(raro);
  assert(t.includes("ESTUDIO ESPECIAL") && t.includes("Segunda hoja del estudio"), "Texto compacto: conserva el cuerpo de las dos hojas");
  assert(!/PACIENTE|PERSONA FICTICIA|CURP|NACIMIENTO|DIAGN|HOSPITAL|Q\.F\.B|Ced\. Prof|Universidad|Página|Resultados fuera|-- 1 of/i.test(t), "Texto compacto: sin encabezado del paciente, firmas ni pies");
  assert(compactReportText("PACIENTE: PERSONA FICTICIA\nUN RENGLON SIN TABLA") === "", "Texto compacto: sin «EXAMENES RESULTADOS» no se guarda nada");
  const largo = compactReportText(H + Array.from({ length: 200 }, (_, i) => "Renglón de prueba número " + i).join("\n") + F);
  assert(largo.length <= REPORTE_TEXTO_MAX + 2 && /\n…$/.test(largo), "Texto compacto: tope de " + REPORTE_TEXTO_MAX + " caracteres con «…»");
}

// ── 7. parsePdfToReport: forma de la respuesta ─────────────────────────────────────────────────────────────
{
  const r = await parsePdfToReport(Buffer.from("no es un pdf"));
  assert(r && Array.isArray(r.valores) && r.texto === "" && r.cultivo === null, "parsePdfToReport: siempre trae `texto` (vacío si no hay PDF)");
  const r0 = await parsePdfToReport(null);
  assert(r0 && r0.texto === "", "parsePdfToReport(null): `texto` vacío");
}

// ── 8. Robot: qué se vuelve a abrir ────────────────────────────────────────────────────────────────────────
{
  const HOY = Date.UTC(2026, 10, 19, 12);
  const row = (fecha, extra) => Object.assign({ __cells: ["", "", "R1", `${fecha} 06:16`, `${fecha} 06:34`, "CIRUGIA GENERAL"], __hasLink: true, __target: true }, extra || {});
  assert(isPendingReport(row("18/11/2026"), looksLikeCultureReport, HOY) === true, "Reporte nunca abierto: pendiente");
  assert(isPendingReport(row("18/11/2026", { reporte_texto: "PANEL X\nalgo" }), looksLikeCultureReport, HOY) === false, "Reporte sin lectura ya guardado: ya no se reabre en cada corrida");
  assert(isPendingReport(row("18/11/2026", { cultivo_texto: "CULTIVO …", cultivo: { v: 3, resultado: "POSITIVO" } }), looksLikeCultureReport, HOY) === false, "Cultivo con solo germen (sin valores): ya no se reabre en cada corrida");
  assert(isTextReportInProcess(row("10/11/2026", { reporte_texto: "PANEL X\nResultado EN PROCESO" }), HOY) === true && isTextReportInProcess(row("10/10/2026", { reporte_texto: "PANEL X\nEN PROCESO" }), HOY) === false && isTextReportInProcess(row("10/11/2026", { reporte_texto: "PANEL X\nNEGATIVO" }), HOY) === false,
    "Reporte sin lectura EN PROCESO: se revisa ≤ 21 días; terminado o viejo no");
  const stale = row("15/11/2026", { valores: [{ estudio: "CEFALORRAQUIDEO", valor: "28", unidad: "U/L" }] });
  assert(hasStaleFluidValores(stale, HOY) === true && isPendingReport(stale, looksLikeCultureReport, HOY) === true, "Valores viejos con nombre partido: se reabren una vez");
  assert(hasStaleFluidValores(row("01/09/2026", { valores: [{ estudio: "PERITONEAL", valor: "1867" }] }), HOY) === false, "Nombre partido de hace > 21 días: no se reabre");
  assert(hasStaleFluidValores(row("15/11/2026", { valores: [{ estudio: "GLUCOSA EN LIQUIDO CEFALORRAQUIDEO", valor: "73" }] }), HOY) === false, "Nombre completo: no se reabre");
  const rows = [row("18/11/2026"), row("18/11/2026", { reporte_texto: "X\nEN PROCESO" }), row("18/11/2026", { reporte_texto: "X\nlisto" })];
  rows[0].__cells[2] = "A"; rows[1].__cells[2] = "B"; rows[2].__cells[2] = "C";
  assert(J(orderDrillCandidates(rows, [0, 1, 2], { looksLikeCultureReport, max: 12, hoy: HOY })) === J([0, 1]), "Orden: nuevo primero, el sin lectura en proceso al final, el terminado no se abre");
}

// ── 9. Reutilización entre corridas: el texto del reporte sin lectura se conserva ─────────────────────────
{
  const prevRow = { data: { reportes: [
    { __cells: ["", "", "A1", "18/11/2026 06:00"], __target: true, reporte_texto: "PANEL RARO\nalgo" },
    { __cells: ["", "", "A2", "18/11/2026 06:00"], __target: true, cultivo_texto: "CULTIVO…", cultivo: { v: 3, resultado: "POSITIVO" } },
    { __cells: ["", "", "A3", "18/11/2026 06:00"], __target: true, valores: [{ estudio: "GLUCOSA", valor: "90" }] },
  ] } };
  const map = indexParsedReportes([prevRow]);
  const nuevos = [{ __cells: ["", "", "A1", "18/11/2026 06:00"], __target: true }, { __cells: ["", "", "A2", "18/11/2026 06:00"], __target: true }, { __cells: ["", "", "A3", "18/11/2026 06:00"], __target: true }];
  const m = mergeReportesPreservingValores(nuevos, map);
  assert(nuevos[0].reporte_texto === "PANEL RARO\nalgo" && !nuevos[0].valores, "Reutilización: el reporte sin lectura conserva su texto y sigue sin valores");
  assert(nuevos[1].cultivo_texto === "CULTIVO…" && nuevos[1].cultivo && !nuevos[1].valores, "Reutilización: el cultivo sin valores conserva germen y texto (antes se perdía si la corrida no alcanzaba)");
  assert(J(nuevos[2].valores) === J([{ estudio: "GLUCOSA", valor: "90" }]) && nuevos[2].valores_src === "prev" && m.reused === 1, "Reutilización: valores de siempre");
}

// ── 10. scraper.js (no se puede correr sin Playwright/WinLab): el cableado está en su lugar ───────────────────
{
  const { readFileSync } = await import("fs");
  const src = readFileSync(new URL("./scraper.js", import.meta.url), "utf8");
  assert(/import \{[^}]*extractLabValuesFromText[^}]*\} from "\.\/pdf-extract\.js"/.test(src), "scraper: importa extractLabValuesFromText");
  assert(/r\.cultivo_texto\.length < 8000[\s\S]{0,200}extractLabValuesFromText\(r\.cultivo_texto\)[\s\S]{0,80}if \(v\.length\) r\.valores = v/.test(src), "scraper: con lector nuevo re-lee los VALORES del texto del cultivo guardado (sin abrir el PDF)");
  assert(/row\.reporte_texto = rep\.texto;/.test(src) && /!rep\.cultivo && !valores\.length && rep\.texto/.test(src), "scraper: guarda reporte_texto solo sin valores ni cultivo");
  assert(/extractLabValuesFromText\(r\.reporte_texto\)/.test(src) && /\\n…\$\/\.test\(r\.reporte_texto\)\) delete r\.reporte_texto/.test(src), "scraper: re-lee reporte_texto; si estaba recortado lo suelta para reabrir el PDF");
  assert(/sin lectura: texto guardado \(\$\{repPDF\.texto\.length\} car\.\)/.test(src) && !/console\.log\([^)]*repPDF\.texto\)/.test(src), "scraper: la bitácora pública solo dice cuántos caracteres (nunca el texto)");
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
