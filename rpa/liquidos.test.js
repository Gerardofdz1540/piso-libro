// Tests de líquidos, citológico/citoquímico y paneles (19 nov 2026): «no aparecen paneles virales, citológicos ni
// citoquímicos». Textos SINTÉTICOS con el acomodo real de los PDF del HGL (valores inventados, sin datos de pacientes).
// Corre con: `node rpa/liquidos.test.js`

import {
  extractLabValuesFromText,
  extractLabReportFromText,
  extractCultureFromText,
  compactReportText,
  parsePdfToReport,
  REPORTE_TEXTO_MAX,
  CULTURE_PARSER_VERSION,
} from "./pdf-extract.js";
import { isPendingReport, isTextReportInProcess, hasStaleFluidValores, orderDrillCandidates, isCultureInProcess } from "./drill-order.js";
import { indexParsedReportes, mergeReportesPreservingValores, looksLikeCultureReport, parsedEsMejor } from "./lib.js";

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
  const ag = extractLabReportFromText(LCR).antigenos;
  const agBy = (n) => ag.find((x) => x.estudio === n);
  assert(agBy("Streptococcus pneumoniae") && agBy("Streptococcus pneumoniae").valor === "NEGATIVO" && agBy("Haemophilus influenzae b") && agBy("Streptococcus grupo B"),
    "LCR: antígenos con germen en `antigenos`, con su nombre COMPLETO (sin abreviar: Staphylococcus ≠ Streptococcus)");
  assert(!v.some((x) => /STREPTOCOC|HAEMOPHILUS|ESCHERICHIA|STAPHYLOCOC/i.test(x.estudio + " " + x.valor + " " + x.referencia)),
    "LCR: ningún VALOR lleva nombre de germen (una app vieja lo tomaría como cultivo positivo)");
  assert(by("Neisseria meningitidis A") && by("Neisseria meningitidis A").valor === "NEGATIVO", "LCR: Neisseria (la app no la toma por cultivo) sigue en valores");
  assert(agBy("Streptococcus pneumoniae").seccion === "LIQUIDO CEFALORRAQUIDEO · COAGLUTINACION", "LCR: coaglutinación con su sección");
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
  const faR = extractLabReportFromText(H + ["PANEL MENINGITIS/ENCEFALITIS", "Escherichia coli K1 NO DETECTADO No detectado", "Streptococcus agalactiae NO DETECTADO No detectado", "Herpes simple 1 NO DETECTADO No detectado"].join("\n") + F);
  assert(fa.length === 1 && fa[0].estudio === "Herpes simple 1" && faR.antigenos.length === 2 && faR.antigenos[0].estudio === "Escherichia coli K1" && faR.antigenos[1].estudio === "Streptococcus agalactiae"
    && !extractCultureFromText(H + "PANEL MENINGITIS/ENCEFALITIS\nEscherichia coli K1 NO DETECTADO\n" + F),
    "Panel de meningitis: gérmenes con nombre completo en `antigenos`, virus en valores, nunca un cultivo positivo");
  // Panel de hemocultivo: solo géneros (Staphylococcus / Streptococcus): cada uno con su nombre y su resultado
  const bc = extractLabReportFromText(H + ["PANEL DE IDENTIFICACION EN HEMOCULTIVO POR PCR", "Enterococcus NO DETECTADO", "Staphylococcus DETECTADO", "Streptococcus NO DETECTADO"].join("\n") + F);
  assert(J(bc.antigenos.map((x) => [x.estudio, x.valor])) === J([["Enterococcus", "NO DETECTADO"], ["Staphylococcus", "DETECTADO"], ["Streptococcus", "NO DETECTADO"]]),
    "Panel BCID: Staphylococcus DETECTADO y Streptococcus NO DETECTADO no se confunden");
  // Revisión 19 nov: un renglón que es SOLO el resultado nunca es un estudio «NO» = DETECTADO (negativo leído como positivo)
  const sueltos = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "Influenza A NO DETECTADO", "No detectado", "SARS-COV-2", "NO DETECTADO", "Cryptococcus neoformans NO REACTIVO", "No reactivo"].join("\n") + F);
  assert(!sueltos.some((x) => /^(NO|SE)$/i.test(x.estudio)) && sueltos.find((x) => x.estudio === "SARS-COV-2").valor === "NO DETECTADO" && sueltos.find((x) => x.estudio === "Influenza A").valor === "NO DETECTADO",
    "Panel: «No detectado» suelto (referencia partida) se descarta; «SARS-COV-2» / «NO DETECTADO» se unen; nunca «NO = DETECTADO»");
  const multi = extractLabValuesFromText(H + ["DETECCION DE VIRUS SINCITIAL RESPIRATORIO", "METODOLOGIA: INMUNOCROMATOGRAFIA", "DETECTADO", "DETECCION DE INFLUENZA A Y B", "METODOLOGIA: INMUNOCROMATOGRAFIA", "NO DETECTADO"].join("\n") + F);
  assert(J(multi.map((x) => [x.estudio, x.valor])) === J([["DETECCION DE VIRUS SINCITIAL RESPIRATORIO", "DETECTADO"], ["DETECCION DE INFLUENZA A Y B", "NO DETECTADO"]]),
    "Prueba con encabezado de panel y resultado abajo (formato QS): positivo y negativo, cada uno con su prueba");
  const unaLinea = extractLabValuesFromText(H + ["GENEXPERT MTB/RIF NO DETECTADO", "DETECCION DE VIRUS SINCITIAL RESPIRATORIO POSITIVO", "TINCION DE ZIEHL NEELSEN NEGATIVO", "RECUENTO CELULAR 350 cel/uL", "HEMOGLOBINA 12.0 g/dL 12.0 - 16.0"].join("\n") + F);
  assert(J(unaLinea.map((x) => [x.estudio, x.valor])) === J([["GENEXPERT MTB/RIF", "NO DETECTADO"], ["DETECCION DE VIRUS SINCITIAL RESPIRATORIO", "POSITIVO"], ["TINCION DE ZIEHL NEELSEN", "NEGATIVO"], ["RECUENTO CELULAR", "350"], ["HEMOGLOBINA", "12.0"]]) && !unaLinea[4].seccion,
    "Encabezado con su resultado en el MISMO renglón: se lee como antes (no se pierde el VSR positivo)");
  const nota = extractLabValuesFromText(H + ["PANEL RESPIRATORIO POR PCR MULTIPLEX", "Nota: prueba realizada por PCR multiplex", "Adenovirus No detectado", "Influenza B Detectado"].join("\n") + F);
  assert(nota.length === 2 && nota[1].estudio === "Influenza B" && nota[1].valor === "DETECTADO", "Panel con «Nota:» antes de sus blancos: la nota no cierra la sección");
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

// ── 5a. Revisión ronda 2: el lector no inventa ni invierte resultados y la química sérica sigue siendo sérica ──
{
  const notas = extractLabValuesFromText(H + ["DETECCION DE INFLUENZA A Y B", "METODOLOGIA: INMUNOCROMATOGRAFIA", "Nota: confirmar todo resultado", "positivo por PCR.", "INFLUENZA A NEGATIVO", "INFLUENZA B NEGATIVO"].join("\n") + F);
  assert(!notas.some((x) => x.valor === "POSITIVO") && notas.filter((x) => /^INFLUENZA [AB]$/.test(x.estudio) && x.valor === "NEGATIVO").length === 2, "Nota con texto libre «positivo por PCR.» no se vuelve resultado");
  const leyenda = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "Negativo = No detectado", "Positivo = Detectado", "Influenza A DETECTADO No detectado"].join("\n") + F);
  assert(leyenda.length === 1 && leyenda[0].estudio === "Influenza A" && leyenda[0].valor === "DETECTADO", "Leyenda «Negativo = No detectado» no es un resultado");
  const nota2 = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "SARS-COV-2", "Nota: un resultado", "negativo no excluye infección", "DETECTADO"].join("\n") + F);
  assert(!nota2.some((x) => x.valor === "NEGATIVO"), "«negativo no excluye infección» (texto de nota) nunca es el resultado del SARS-COV-2");
  const pleural = extractLabValuesFromText(H + ["LIQUIDO PLEURAL", "Aspecto TURBIO Claro", "GLUCOSA", "METODOLOGIA: QUIMICA SECA", "110.0 mg/dL 74.0 - 106.0", "PROTEINAS TOTALES", "METODOLOGIA: X", "6.0 g/dL 6.4 - 8.3"].join("\n") + F);
  assert(pleural.find((x) => x.estudio === "GLUCOSA") && !pleural.find((x) => x.estudio === "GLUCOSA").seccion && !pleural.find((x) => x.estudio === "PROTEINAS TOTALES").seccion && pleural.find((x) => x.estudio === "ASPECTO").seccion === "LIQUIDO PLEURAL",
    "Química SÉRICA después de un líquido: sin sección (la sección solo para el examen físico del líquido)");
  const vdrl = extractLabValuesFromText(H + ["RECUENTO CELULAR DE LCR", "LEUCOCITOS 0.030 10³/μL 0.000 - 5.000", "PANEL DE HEPATITIS", "VDRL REACTIVO"].join("\n") + F);
  assert(vdrl.find((x) => x.estudio === "VDRL").seccion === "PANEL DE HEPATITIS", "Panel de serología después del LCR: no hereda el líquido (el VDRL sérico no es del LCR)");
  const gramS = extractLabValuesFromText(H + ["LIQUIDO CEFALORRAQUIDEO", "TINCION", "Cocos Gram positivo NO SE OBSERVAN", "Bacilos Gram negativos ESCASOS"].join("\n") + F);
  assert(J(gramS.map((x) => [x.estudio, x.valor])) === J([["Cocos Gram positivo", "NO SE OBSERVAN"], ["Bacilos Gram negativos", "ESCASOS"]]), "Morfotipo de Gram: «positivo/negativo» es nombre; el resultado es lo que sigue");
  const para = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "PARAINFLUENZA 3", "DETECTADO", "Coronavirus 229E", "NO DETECTADO"].join("\n") + F);
  assert(J(para.map((x) => [x.estudio, x.valor])) === J([["PARAINFLUENZA 3", "DETECTADO"], ["Coronavirus 229E", "NO DETECTADO"]]), "Blanco con número en el nombre y resultado abajo");
  const encNum = extractLabValuesFromText(H + ["PANEL RESPIRATORIO 2.1", "METODOLOGIA: PCR", "Adenovirus NO DETECTADO No detectado", "Influenza A H1N1 DETECTADO No detectado", "PCR PARA HERPES SIMPLE 1 Y 2", "METODOLOGIA: PCR", "DETECTADO"].join("\n") + F);
  assert(encNum.some((x) => x.estudio === "Influenza A H1N1" && x.valor === "DETECTADO") && encNum.some((x) => x.estudio === "PCR PARA HERPES SIMPLE 1 Y 2" && x.valor === "DETECTADO") && !encNum.some((x) => x.estudio === "PANEL RESPIRATORIO"),
    "Encabezado de panel con un número («2.1», «1 Y 2») sí abre la sección; el DETECTADO no se pierde");
  const hojas = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "Adenovirus NO DETECTADO No detectado"].join("\n") + F + H + ["Influenza A H1N1 DETECTADO No detectado"].join("\n") + F);
  assert(hojas.some((x) => x.estudio === "Influenza A H1N1" && x.valor === "DETECTADO" && x.seccion === "PANEL RESPIRATORIO"), "Panel que sigue en la hoja 2: el DETECTADO de la hoja 2 sí se lee");
  const hojaQS = extractLabValuesFromText(H + ["PANEL RESPIRATORIO", "Adenovirus NO DETECTADO No detectado"].join("\n") + F + H + ["GLUCOSA 98.0 mg/dL 74.0 - 106.0", "Algo raro NEGATIVO"].join("\n") + F);
  assert(!hojaQS.find((x) => x.estudio === "GLUCOSA").seccion && !hojaQS.some((x) => x.estudio === "Algo raro"), "Tras el salto de hoja, un estudio normal termina el panel (no se reanuda)");
  // Ronda 3: blanco en MAYÚSCULAS con número en el nombre, positivo, con y sin referencia
  const may = extractLabValuesFromText(H + ["SARS COV 2 DETECTADO", "INFLUENZA A NO DETECTADO", "PANEL RESPIRATORIO", "SARS COV 2 DETECTADO NO DETECTADO", "INFLUENZA A H1N1 DETECTADO NO DETECTADO", "PARAINFLUENZA 3 DETECTADO NO DETECTADO"].join("\n") + F);
  assert(J(may.map((x) => [x.estudio, x.valor])) === J([["SARS COV 2", "DETECTADO"], ["INFLUENZA A", "NO DETECTADO"], ["SARS COV 2", "DETECTADO"], ["INFLUENZA A H1N1", "DETECTADO"], ["PARAINFLUENZA 3", "DETECTADO"]]),
    "Blanco en MAYÚSCULAS con número en el nombre (SARS COV 2, H1N1, PARAINFLUENZA 3): DETECTADO no se pierde ni se lee como NO DETECTADO");
  const sero = extractLabValuesFromText(H + ["ANTICUERPOS ANTI HIV 0.24 S/CO NO REACTIVO < 1.0", "HEPATITIS A IGM 0.19 NEGATIVO", "VITAMINA B12 NORMAL"].join("\n") + F);
  assert(sero[0].valor === "0.24" && sero[1].estudio === "HEPATITIS A IGM" && sero[1].valor === "0.19" && sero[2].estudio === "VITAMINA B12", "Serología con índice decimal: el número sigue siendo el valor (como antes)");
  const det = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 DESARROLLO\nStaphylococcus aureus DETECTADO\nmecA DETECTADO" + F);
  assert(det && det.resultado === "POSITIVO" && /Staphylococcus aureus/.test(det.germenes[0] || ""), "Cultivo: «Staphylococcus aureus DETECTADO» (identificación) sigue siendo germen POSITIVO");
  const neg = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 DESARROLLO\nNEGATIVO A 5 DIAS\nStaphylococcus aureus NO DETECTADO" + F);
  assert(neg && neg.resultado === "NEGATIVO", "Cultivo: «… NO DETECTADO» no es germen");
}

// ── 5b. Cultivos: germen suelto con su mecanismo «detectada» sigue siendo germen ─────────────────────────
{
  const k = extractCultureFromText("CULTIVO DE SECRECION BRONQUIAL\nKlebsiella pneumoniae KPC detectada\nMEROPENEM >=16 R\nAMIKACINA <=2 S");
  assert(k && k.resultado === "POSITIVO" && k.carbapenemasa === true && /Klebsiella pneumoniae/.test(k.germenes[0] || ""), "Cultivo: «Klebsiella pneumoniae KPC detectada» sigue siendo germen con carbapenemasa");
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
  assert(isTextReportInProcess(row("10/11/2026", { reporte_texto: "CARGA VIRAL\nMuestra enviada a laboratorio de referencia" }), HOY) === true
    && isTextReportInProcess(row("10/11/2026", { antigenos: [{ estudio: "Staphylococcus", valor: "DETECTADO" }] }), HOY) === true
    && isTextReportInProcess(row("10/10/2026", { reporte_texto: "PANEL X\nEN PROCESO" }), HOY) === false
    && isTextReportInProcess(row("10/11/2026", { reporte_texto: "X", valores: [{ estudio: "A", valor: "1" }] }), HOY) === false,
    "Reporte sin valores (solo texto o antígenos): se revisa al final mientras tenga ≤ 21 días (WinLab puede completarlo); viejo o con valores no");
  const stale = row("15/11/2026", { valores: [{ estudio: "CEFALORRAQUIDEO", valor: "28", unidad: "U/L" }] });
  assert(hasStaleFluidValores(stale, HOY) === true && isPendingReport(stale, looksLikeCultureReport, HOY) === true, "Valores viejos con nombre partido: se reabren una vez");
  assert(hasStaleFluidValores(row("01/09/2026", { valores: [{ estudio: "PERITONEAL", valor: "1867" }] }), HOY) === false, "Nombre partido de hace > 21 días: no se reabre");
  assert(hasStaleFluidValores(row("15/11/2026", { valores: [{ estudio: "GLUCOSA EN LIQUIDO CEFALORRAQUIDEO", valor: "73" }] }), HOY) === false, "Nombre completo: no se reabre");
  assert(hasStaleFluidValores(row("15/11/2026", { valores: [{ estudio: "LEUCOCITOS", valor: "0.640", unidad: "10³/μL", referencia: "0.000 - 5.000" }] }), HOY) === false,
    "Recuento de líquido sin sección: NO se reabre (el lector de hoy puede dejarlo igual y se reabriría en cada corrida; la app lo reconoce por su referencia)");
  const rows = [row("18/11/2026"), row("18/11/2026", { reporte_texto: "X\nEN PROCESO" }), row("18/11/2026", { reporte_texto: "X\nlisto" })];
  rows[0].__cells[2] = "A"; rows[1].__cells[2] = "B"; rows[2].__cells[2] = "C";
  assert(J(orderDrillCandidates(rows, [0, 1, 2], { looksLikeCultureReport, max: 12, hoy: HOY })) === J([0, 1, 2])
    && J(orderDrillCandidates(rows, [0, 1, 2], { looksLikeCultureReport, max: 12, hoy: HOY, revisarTextos: 1 })) === J([0, 1]),
    "Orden: el reporte nuevo primero; los que solo tienen texto al final, con su propio cupo");
  // Cupos separados: 4 textos recientes no le quitan la revisión a un cultivo en proceso
  const muchos = [0, 1, 2, 3].map((n) => row("18/11/2026", { reporte_texto: "T" + n }));
  muchos.forEach((r, n) => { r.__cells[2] = "T" + n; });
  const cultEP = row("12/11/2026", { valores: [{ estudio: "CULTIVO", valor: "EN PROCESO" }], cultivo_texto: "UROCULTIVO EN PROCESO", cultivo: { v: 3, resultado: "PENDIENTE", secciones: [{ resultado: "PENDIENTE" }] } }); cultEP.__cells[2] = "C1";
  const ord = orderDrillCandidates(muchos.concat([cultEP]), [0, 1, 2, 3, 4], { looksLikeCultureReport, max: 12, hoy: HOY });
  assert(ord[0] === 4 && ord.length === 3, "Cupos: el cultivo en proceso se revisa primero aunque haya 4 textos recientes (textos: 2)");
  assert(isPendingReport(row("18/11/2026", { cultivo_texto: "X", cultivo: { resultado: "POSITIVO" } }), looksLikeCultureReport, HOY) === false
    && isCultureInProcess(row("18/11/2026", { cultivo_texto: "UROCULTIVO\nAntibiograma pendiente", cultivo: { resultado: "POSITIVO", secciones: [{ resultado: "POSITIVO" }] } }), HOY) === true
    && isCultureInProcess(row("18/11/2026", { cultivo_texto: "ELECTROFORESIS\nInterpretación dependiente de la clínica", cultivo: { resultado: "POSITIVO", secciones: [{ resultado: "POSITIVO" }] } }), HOY) === false,
    "Cultivo con «Antibiograma pendiente»: se revisa; «dependiente» no cuenta como pendiente");
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
  assert(/row\.reporte_texto = rep\.texto;/.test(src) && /!rep\.cultivo && !valores\.length && !antigenos\.length && rep\.texto/.test(src) && /row\.antigenos = antigenos/.test(src),
    "scraper: guarda antígenos aparte y reporte_texto solo sin valores, antígenos ni cultivo");
  assert(!/extractLabReportFromText\(r\.reporte_texto\)/.test(src) && !/extractLabValuesFromText\(r\.reporte_texto\)/.test(src),
    "scraper: el texto de un reporte sin lectura NO se re-lee (un valor espurio taparía el texto completo)");
  assert(/if \(c\) r\.cultivo = c; else if \(r\.cultivo_texto\.length < 8000\) delete r\.cultivo;/.test(src) && /delete row\.cultivo; delete row\.cultivo_texto;/.test(src),
    "scraper: un cultivo falso del lector viejo se quita si el texto ya no tiene cultivo; un PDF releído sin cultivo no arrastra el viejo");
  assert(/sin lectura: texto guardado \(\$\{repPDF\.texto\.length\} car\.\)/.test(src) && !/console\.log\([^)]*repPDF\.texto\)/.test(src), "scraper: la bitácora pública solo dice cuántos caracteres (nunca el texto)");
}

// ── 11. Revisión 19 nov: la fila MÁS RECIENTE gana y una entrada «en proceso» no tapa el resultado ─────────────
{
  const con = Object.assign([{ estudio: "Influenza A", valor: "DETECTADO" }], {});
  const sin = []; Object.defineProperty(sin, "__reporte_texto", { value: "PANEL\nEN PROCESO", enumerable: false });
  const pend = []; Object.defineProperty(pend, "__cultivo", { value: { resultado: "PENDIENTE" }, enumerable: false });
  const pos = []; Object.defineProperty(pos, "__cultivo", { value: { resultado: "POSITIVO" }, enumerable: false });
  assert(parsedEsMejor(con, sin) === true && parsedEsMejor(sin, con) === false && parsedEsMejor(pos, pend) === true && parsedEsMejor(pend, pos) === false && parsedEsMejor(sin, undefined) === true,
    "parsedEsMejor: con valores > solo texto; cultivo terminado > en proceso");
  const src = (await import("fs")).readFileSync(new URL("./scraper.js", import.meta.url), "utf8");
  assert(/\.sort\(\(a, b\) => String\(b\.fecha \|\| ""\)\.localeCompare\(String\(a\.fecha \|\| ""\)\)\)/.test(src) && /!m\.has\(k\) \|\| parsedEsMejor\(v, m\.get\(k\)\)/.test(src),
    "loadParsedByExp: filas de la más nueva a la más vieja y parsedEsMejor al juntar");
  // Antígenos: se conservan entre corridas y un reporte que solo trajo antígenos no se reabre en cada corrida
  const prevRow = { data: { reportes: [{ __cells: ["", "", "B1", "18/11/2026 06:00"], __target: true, antigenos: [{ estudio: "Streptococcus pneumoniae", valor: "NEGATIVO" }] }] } };
  const nuevo = [{ __cells: ["", "", "B1", "18/11/2026 06:00"], __target: true }];
  mergeReportesPreservingValores(nuevo, indexParsedReportes([prevRow]));
  assert(nuevo[0].antigenos && nuevo[0].antigenos[0].estudio === "Streptococcus pneumoniae" && !nuevo[0].valores, "Reutilización: los antígenos viajan a la fila nueva");
  assert(isPendingReport(nuevo[0], looksLikeCultureReport, Date.UTC(2026, 10, 19)) === false, "Reporte con solo antígenos: no se reabre en cada corrida");
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
