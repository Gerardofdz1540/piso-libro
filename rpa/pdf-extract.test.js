// Tests offline del módulo pdf-extract.js
// Corre con: `node rpa/pdf-extract.test.js` — usa pdf-parse + fixture local.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  extractLabValuesFromText,
  extractCultureFromText,
  parsePdfToReport,
  parsePdfToLabValues,
  PDF_NOISE_PATTERNS,
  PDF_LAB_LINE_RE,
} from "./pdf-extract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else      { fail++; console.error(`✗ ${name}`); }
}

// ── 1. extractLabValuesFromText: edge cases ─────────────────────────────────
{
  assert(extractLabValuesFromText("").length === 0, "vacío → []");
  assert(extractLabValuesFromText(null).length === 0, "null → []");
  assert(extractLabValuesFromText(undefined).length === 0, "undefined → []");
  assert(extractLabValuesFromText(12345).length === 0, "número (no string) → []");
}

// ── 2. extractLabValuesFromText: una línea simple ───────────────────────────
{
  const v = extractLabValuesFromText("HEMOGLOBINA 11.2 g/dL 12-17");
  assert(v.length === 1, "1 línea válida → 1 valor");
  assert(v[0].estudio === "HEMOGLOBINA", "  estudio correcto");
  assert(v[0].valor === "11.2", "  valor correcto");
  assert(v[0].unidad === "g/dL", "  unidad correcta");
  assert(v[0].referencia === "12-17", "  referencia correcta");
}

// ── 3. extractLabValuesFromText: descarta ruido (headers, paciente, etc) ────
{
  const noisy = `HOSPITAL GENERAL DE LEON
DEPARTAMENTO DE LABORATORIO
Paciente: GARCIA LOPEZ JUAN
Exp: 12-345
Fecha: 22/05/2026
ESTUDIO    RESULTADO    UNIDAD    REFERENCIA
HEMOGLOBINA 14.5 g/dL 12-17
LEUCOCITOS 9.2 k/uL 4-10
--------------------
1 of 1
Página 1
FIRMADO POR: DR. PEREZ`;
  const v = extractLabValuesFromText(noisy);
  assert(v.length === 2, "texto con ruido → solo 2 valores reales");
  assert(v.map(x => x.estudio).includes("HEMOGLOBINA"), "  HEMOGLOBINA extraída");
  assert(v.map(x => x.estudio).includes("LEUCOCITOS"), "  LEUCOCITOS extraído");
  assert(!v.map(x => x.estudio).includes("HOSPITAL"), "  HOSPITAL descartado");
  assert(!v.map(x => x.estudio).includes("Paciente"), "  Paciente descartado");
}

// ── 4. extractLabValuesFromText: estudios con slash/espacios ────────────────
{
  const text = `TGO/AST 34 U/L 0-40
TGP/ALT 28 U/L 0-40
PROTEINA C REACTIVA 85.2 mg/L 0-10
BILIRRUBINA TOTAL 0.8 mg/dL 0.1-1.2`;
  const v = extractLabValuesFromText(text);
  assert(v.length === 4, "4 estudios con nombres compuestos → 4 valores");
  assert(v[0].estudio === "TGO/AST", "  TGO/AST conserva slash");
  assert(v[2].estudio === "PROTEINA C REACTIVA", "  nombres multi-palabra OK");
}

// ── 5. extractLabValuesFromText: valores con < y > ──────────────────────────
{
  const text = `TROPONINA <0.01 ng/mL 0-0.04
DIMERO D >5000 ng/mL 0-500`;
  const v = extractLabValuesFromText(text);
  assert(v.length === 2, "valores con < y > → 2 valores");
  assert(v[0].valor.includes("0.01"), "  valor con < preservado");
  assert(v[1].valor.includes("5000"), "  valor con > preservado");
}

// ── 6. extractLabValuesFromText: solo nombre + valor (sin unidad/ref) ───────
{
  const text = "POTASIO 4.1";
  const v = extractLabValuesFromText(text);
  assert(v.length === 1, "solo nombre+valor → 1 valor");
  assert(v[0].estudio === "POTASIO", "  estudio OK");
  assert(v[0].valor === "4.1", "  valor OK");
  assert(v[0].unidad === "", "  unidad vacía sin error");
  assert(v[0].referencia === "", "  referencia vacía sin error");
}

// ── 7. extractLabValuesFromText: descarta líneas que parecen labs pero no ───
{
  const fake = `12345 100 mg 50-100
- 5 g 1-10
21/05/2026 5.0 unidad 0-10`;
  const v = extractLabValuesFromText(fake);
  assert(v.length === 0, "líneas que parecen labs pero empiezan con dígito/separador → descartadas");
}

// ── 8. parsePdfToLabValues: con buffer real de fixture ──────────────────────
{
  const pdfPath = join(__dirname, "test-fixtures", "winlab_sample.pdf");
  let buffer;
  try {
    buffer = readFileSync(pdfPath);
  } catch (e) {
    console.error(`✗ fixture no existe en ${pdfPath}`);
    fail++;
  }
  if (buffer) {
    const valores = await parsePdfToLabValues(buffer);
    assert(valores.length === 14, `PDF fixture parseado: ${valores.length} valores (esperado 14)`);
    const estudios = valores.map(v => v.estudio);
    const expected = [
      "HEMOGLOBINA", "LEUCOCITOS", "PLAQUETAS", "CREATININA",
      "UREA", "GLUCOSA", "SODIO", "POTASIO", "CLORO",
      "PROTEINA C REACTIVA", "TGO/AST", "TGP/ALT",
      "BILIRRUBINA TOTAL", "FOSFATASA ALCALINA"
    ];
    for (const exp of expected) {
      assert(estudios.includes(exp), `  ${exp} extraído del PDF real`);
    }
    // Verificar que valores numéricos son correctos
    const hb = valores.find(v => v.estudio === "HEMOGLOBINA");
    assert(hb?.valor === "11.2", "  HEMOGLOBINA valor=11.2");
    assert(hb?.unidad === "g/dL", "  HEMOGLOBINA unidad=g/dL");
    const pcr = valores.find(v => v.estudio === "PROTEINA C REACTIVA");
    assert(pcr?.valor === "85.2", "  PCR valor=85.2");
  }
}

// ── 9. parsePdfToLabValues: edge cases ──────────────────────────────────────
{
  const v1 = await parsePdfToLabValues(null);
  assert(v1.length === 0, "buffer null → []");
  const v2 = await parsePdfToLabValues(Buffer.alloc(0));
  assert(v2.length === 0, "buffer vacío → []");
  const v3 = await parsePdfToLabValues(Buffer.from("not a pdf"));
  assert(v3.length === 0, "buffer no-PDF → [] (graceful error)");
}

// ── 10. Smoke test del regex principal ──────────────────────────────────────
{
  assert(PDF_LAB_LINE_RE.test("HEMOGLOBINA 11.2 g/dL 12-17"), "regex match línea válida");
  assert(!PDF_LAB_LINE_RE.test(""), "regex no match string vacío");
  assert(!PDF_LAB_LINE_RE.test("12345 100 mg"), "regex no match línea que empieza con dígito");
}

// ── 11. Formato MULTI-LÍNEA química sanguínea / función hepática (HGL) ───────
// Caso real (PDF 3-155): nombre del estudio, línea METODOLOGIA, luego valor con
// prefijo *A/*B. El parser line-by-line viejo dropeaba TODOS estos valores.
{
  const txt = [
    "EXAMENES RESULTADOS UNIDADES VALORES DE REFERENCIA",
    "GLUCOSA",
    "METODOLOGIA: QUIMICA SECA",
    "*B\t53.0 mg/dL 74.0 - 106.0",
    "UREA",
    "METODOLOGIA: QUIMICA SECA",
    "23.0 mg/dL 15.0 - 36.0",
    "ALANINO AMINO TRANSFERASA",
    "METODOLOGIA: QUIMICA SECA",
    "27.0 U/L 4.0 - 35.0",
    "FOSFATASA ALCALINA",
    "METODOLOGIA: QUIMICA SECA",
    "*A\t219.0 U/L 38.0 - 126.0",
    "RELACION A/G",
    "METODOLOGIA: ESPECTROFOTOMETRIA AUTOMATIZADA",
    "*B\t0.74 1.10 - 1.80",
    "Validado por : Reyes García",
    "Página No: 1 de 2",
  ].join("\n");
  const v = extractLabValuesFromText(txt);
  const byName = (n) => v.find(x => x.estudio === n);
  assert(byName("GLUCOSA") && byName("GLUCOSA").valor === "53.0", "multi-línea: GLUCOSA=53.0 (con prefijo *B)");
  assert(byName("GLUCOSA").unidad === "mg/dL", "multi-línea: GLUCOSA unidad=mg/dL");
  assert(byName("UREA") && byName("UREA").valor === "23.0", "multi-línea: UREA=23.0 (sin prefijo)");
  assert(byName("ALANINO AMINO TRANSFERASA") && byName("ALANINO AMINO TRANSFERASA").valor === "27.0", "multi-línea: ALT=27.0");
  assert(byName("FOSFATASA ALCALINA") && byName("FOSFATASA ALCALINA").valor === "219.0", "multi-línea: FA=219.0 (prefijo *A)");
  const rag = byName("RELACION A/G");
  assert(rag && rag.valor === "0.74" && rag.unidad === "", "multi-línea: RELACION A/G=0.74 sin unidad (rango no se confunde con unidad)");
  assert(!v.some(x => /METODOLOG/i.test(x.estudio)), "multi-línea: METODOLOGIA nunca se emite como estudio");
  assert(!v.some(x => /VALIDADO|P[áa]gina/i.test(x.estudio)), "multi-línea: firmas/paginación filtradas");
}

// ── 12. BIOMETRIA HEMATICA: línea ÚNICA con flag *A/*B entre nombre y valor ──
// Caso real (PDF 3-155 pág 2): "HEMOGLOBINA *B\t10.10 g/dL 12.00 - 16.00". El flag
// rompía el regex de una línea → hb/hct/leucos/plaq (fuera de rango) se dropeaban;
// solo pasaban los analitos EN rango (el diferencial). Bug "no se reporta hemoglobina".
{
  const txt = [
    "BIOMETRIA HEMATICA COMPLETA",
    "METODOLOGIA: SULFOMETAHEMOGLOBINA, IMPEDANCIA, CITOMETRIA DE FLUJO",
    "FLUORESCENTE",
    "LEUCOCITOS *A\t20.97 10³/μL 4.00 - 10.00",
    "ERITROCITOS *B\t3.81 10^6/μL 4.40 - 5.20",
    "HEMOGLOBINA *B\t10.10 g/dL 12.00 - 16.00",
    "HEMATOCRITO *B\t32.80 % 36.00 - 48.00",
    "VOL. CORPUSCULAR MEDIO 86.10 fL 80.00 - 95.00",
    "PLAQUETAS *A\t408 10³/μL 130 - 400",
    "NEUTROFILOS 82.30 %",
  ].join("\n");
  const v = extractLabValuesFromText(txt);
  const by = (n) => v.find(x => x.estudio === n);
  assert(by("HEMOGLOBINA") && by("HEMOGLOBINA").valor === "10.10", "BH flag: HEMOGLOBINA=10.10 (prefijo *B en una línea)");
  assert(by("HEMOGLOBINA").unidad === "g/dL", "BH flag: HEMOGLOBINA unidad=g/dL");
  assert(by("LEUCOCITOS") && by("LEUCOCITOS").valor === "20.97" && by("LEUCOCITOS").unidad === "10³/μL", "BH flag: LEUCOCITOS=20.97 unidad 10³/μL (unidad con dígito NO se confunde con rango)");
  assert(by("HEMATOCRITO") && by("HEMATOCRITO").valor === "32.80", "BH flag: HEMATOCRITO=32.80");
  assert(by("PLAQUETAS") && by("PLAQUETAS").valor === "408", "BH flag: PLAQUETAS=408");
  assert(by("ERITROCITOS") && by("ERITROCITOS").valor === "3.81", "BH flag: ERITROCITOS=3.81");
  assert(by("VOL. CORPUSCULAR MEDIO") && by("VOL. CORPUSCULAR MEDIO").valor === "86.10", "BH sin flag: VOL CORPUSCULAR sigue OK (sin regresión)");
  assert(by("NEUTROFILOS") && by("NEUTROFILOS").valor === "82.30", "BH diferencial: NEUTROFILOS 82.30 OK");
  assert(!v.some(x => /METODOLOG|FLUORESCENTE|BIOMETRIA/i.test(x.estudio)), "BH: método/sección/continuación nunca se emiten como estudio");
}

// ── P1 (oct 2026): resultados CUALITATIVOS (cultivos, serologías, tira reactiva) ─────────────
{
  const v = extractLabValuesFromText([
    "UROCULTIVO SIN DESARROLLO",
    "VIH NO REACTIVO",
    "ANTIGENO DE SUPERFICIE HEPATITIS B NEGATIVO",
    "NITRITOS",
    "NEGATIVO",
    "HEMOCULTIVO",
    "METODOLOGIA: AUTOMATIZADO",
    "*A SIN DESARROLLO A LAS 48 HRS",
    "RESULTADO NEGATIVO",      // encabezado/ruido: no es un estudio
    "NEGATIVO",                // suelto, sin estudio pendiente → se ignora
    "HEMOGLOBINA 11.2 g/dL 12-17",
  ].join("\n"));
  const by = (n) => v.find((x) => x.estudio === n);
  assert(by("UROCULTIVO") && by("UROCULTIVO").valor === "SIN DESARROLLO", "cualitativo 1 línea: UROCULTIVO SIN DESARROLLO");
  assert(by("VIH") && by("VIH").valor === "NO REACTIVO", "cualitativo 1 línea: VIH NO REACTIVO");
  assert(by("ANTIGENO DE SUPERFICIE HEPATITIS B") && by("ANTIGENO DE SUPERFICIE HEPATITIS B").valor === "NEGATIVO", "cualitativo nombre largo: NEGATIVO");
  assert(by("NITRITOS") && by("NITRITOS").valor === "NEGATIVO", "cualitativo multilínea: NITRITOS / NEGATIVO");
  assert(by("HEMOCULTIVO") && by("HEMOCULTIVO").valor === "SIN DESARROLLO" && /48 HRS/.test(by("HEMOCULTIVO").referencia), "cualitativo multilínea con flag y método en medio: HEMOCULTIVO");
  assert(!v.some((x) => /^RESULTADO/.test(x.estudio)), "cualitativo: 'RESULTADO NEGATIVO' (encabezado) no se emite");
  assert(!v.some((x) => x.estudio === "NEGATIVO"), "cualitativo: un NEGATIVO suelto no genera estudio");
  assert(by("HEMOGLOBINA") && by("HEMOGLOBINA").valor === "11.2", "cualitativo: las líneas numéricas siguen igual");
  assert(v.length === 6, "cualitativo: exactamente 6 valores emitidos");
}

// ── 10. extractCultureFromText: germen + antibiograma desde el texto del PDF ─────────────
{
  const c1 = extractCultureFromText([
    "HOSPITAL GENERAL DE LEON", "UROCULTIVO", "METODOLOGIA: AUTOMATIZADO", "RESULTADO: POSITIVO",
    "MICROORGANISMO AISLADO: Klebsiella pneumoniae BLEE", "> 100,000 UFC/mL", "ANTIBIOGRAMA",
    "AMIKACINA <=2 S", "CIPROFLOXACINO >=4 R", "MEROPENEM <=0.25 S", "CEFTRIAXONA >=64 R",
    "TRIMETOPRIM/SULFAMETOXAZOL <=20 S", "NITROFURANTOINA 64 I", "VALIDADO POR QFB X",
  ].join("\n"));
  assert(c1 && c1.tipo === "Urocultivo" && c1.resultado === "POSITIVO" && c1.v === 2, "cultivo PDF: urocultivo positivo (v2)");
  assert(c1 && c1.germenes.length === 1 && c1.germenes[0] === "Klebsiella pneumoniae (BLEE)" && c1.blee === true && /100,000 UFC/.test(c1.ufc), "cultivo PDF: germen género+especie, BLEE y UFC");
  const by = (n) => c1.antibiograma.find((a) => a.antibiotico === n);
  assert(c1.antibiograma.length === 6 && by("Amikacina").interp === "S" && by("Amikacina").cim === "<=2" && by("Ciprofloxacino").interp === "R" && by("Nitrofurantoina").interp === "I" && by("Trimetoprim/sulfametoxazol").interp === "S", "cultivo PDF: antibiograma NOMBRE CIM S/I/R (filas sueltas)");
  const c2 = extractCultureFromText("HEMOCULTIVO PERIFERICO\nSIN DESARROLLO A LOS 5 DIAS");
  assert(c2 && /Hemocultivo/.test(c2.tipo) && c2.resultado === "NEGATIVO" && c2.germenes.length === 0, "cultivo PDF: hemocultivo negativo");
  const c3 = extractCultureFromText("CULTIVO DE SECRECION DE HERIDA\nSe aisla Staphylococcus aureus\nOXACILINA RESISTENTE\nVANCOMICINA SENSIBLE CIM 1\nLINEZOLID S\nCLINDAMICINA R");
  assert(c3 && /secreci/.test(c3.tipo) && c3.germenes[0] === "Staphylococcus aureus" && c3.antibiograma.length === 4 && c3.antibiograma.find((a) => a.antibiotico === "Oxacilina").interp === "R" && c3.antibiograma.find((a) => a.antibiotico === "Vancomicina").interp === "S", "cultivo PDF: formato SENSIBLE/RESISTENTE en palabra y S/R");
  const c4 = extractCultureFromText("CULTIVO\nPRELIMINAR: EN PROCESO DE INCUBACION");
  assert(c4 && c4.resultado === "PENDIENTE" && c4.pendiente === true, "cultivo PDF: preliminar → pendiente");
  assert(extractCultureFromText("BIOMETRIA HEMATICA\nHEMOGLOBINA 11.2 g/dL") === null, "cultivo PDF: un reporte sin cultivo → null");
  assert(extractCultureFromText("") === null && extractCultureFromText(null) === null, "cultivo PDF: vacío → null");
  const c5 = extractCultureFromText("CULTIVO DE EXPECTORACION\nDesarrollo de Pseudomonas aeruginosa y Escherichia coli\nPIPERACILINA/TAZOBACTAM S\nCEFTAZIDIMA I\nTRATAMIENTO SUGERIDO: MEROPENEM");
  assert(c5 && c5.germenes.length === 2 && c5.germenes.includes("Pseudomonas aeruginosa") && c5.germenes.includes("Escherichia coli") && c5.antibiograma.length === 2 && !c5.antibiograma.some((a) => a.antibiotico === "Meropenem"), "cultivo PDF: dos gérmenes; antibiótico sin S/I/R (tratamiento) no entra al antibiograma");
  const r = await parsePdfToReport(Buffer.from("not a pdf"));
  assert(r && Array.isArray(r.valores) && r.valores.length === 0 && r.text === "" && r.cultivo === null, "parsePdfToReport: buffer inválido → vacío sin lanzar");
}

// ── 11. extractCultureFromText: formato REAL del laboratorio del HGL (oct 2026) ───────────────
{
  const H = "HOSPITAL GENERAL DE LEON\nLABORATORIO DE ANÁLISIS CLÍNICOS\nHOJA DE RESULTADOS\nPACIENTE: X CURP: Y\nFECHA DE NACIMIENTO: 01/01/1970 EDAD: 56 AÑOS SEXO: MASCULINO\nEXAMENES RESULTADOS UNIDADES VALORES DE REFERENCIA\n";
  const F = "\nQ.F.B. Nombre Apellido\nCed. Prof. 1 REG. SSG 2\nUniversidad DE Guanajuato\nNota: Los resultados deberán ser correlacionados con la clínica.\n* Resultados fuera de rango. B = Bajo, A = Alto, según corresponda.\nPágina No: 1 de 1\n\n-- 1 of 1 --\n";
  // Secreción con 3 gérmenes y antibiograma en columnas ("- 1 - - 2 - - 3 -"); una celda pegada con tabulador
  const m = extractCultureFromText(H + "CULTIVO DE SECRECIONES\nTIPO DE MUESTRA Pared abdominal\nCULTIVO POSITIVO SIN DESARROLLO\nMicrorganismo\n1. Escherichia coli\nBetalactamasa de Amplio Espectro\n2. Klebsiella pneumoniae\nTest negativo para ESBL\t3. Morganella morganii\n- 1 - - 2 - - 3 -\nAntibioticos CMI ug/mL Cat. CMI Cat. CMI Cat.\nAmikacina <=4 S <=4 S <=4 S\nCiprofloxacino >2 R\nCeftriaxona >4 R <=1 S\nAmpicilina-Sulbactam 8/4 R 8/4 S >16/8 R\nS=Sensible; R=Resistente; I=Intermedio\nGRAM\nLEUCOCITOS Abundantes ESCASOS" + F);
  const g = (i) => m.secciones[0].germenes[i];
  assert(m && m.resultado === "POSITIVO" && m.tipo === "Cultivo de secreción" && m.muestra === "Pared abdominal" && m.secciones.length === 1, "HGL secreción: una sección, tipo y muestra");
  assert(m.germenes.length === 3 && m.germenes[0] === "Escherichia coli (BLEE)" && m.germenes[1] === "Klebsiella pneumoniae" && m.germenes[2] === "Morganella morganii" && m.blee === true, "HGL secreción: 3 gérmenes (uno pegado con tab), BLEE solo en el 1º (test negativo para ESBL en el 2º)");
  assert(g(0).antibiograma.find((a) => a.antibiotico === "Ciprofloxacino").interp === "R" && g(1).antibiograma.find((a) => a.antibiotico === "Ceftriaxona").interp === "S" && g(2).antibiograma.find((a) => a.antibiotico === "Ampicilina-sulbactam").cim === ">16/8" && !g(1).antibiograma.some((a) => a.antibiotico === "Ciprofloxacino"), "HGL secreción: columnas del antibiograma asignadas a cada germen (CIM por columna)");
  assert(m.antibiograma.find((a) => a.antibiotico === "Amikacina").interp === "S" && m.antibiograma.find((a) => a.antibiotico === "Ceftriaxona").interp === "R" && m.antibiograma.find((a) => a.antibiotico === "Ceftriaxona").cols.length === 2, "HGL secreción: resumen por antibiótico = peor interpretación entre columnas");
  // Hemocultivo periférico negativo + urocultivo KPC + (2ª página) hemocultivo central con S. epidermidis MRSA
  const x = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 DESARROLLO\nNEGATIVO A 5 DIAS\nSIN DESARROLLO\nUROCULTIVO\nLEUCOCITOS 2 a 4 xc en 40 X X CAMPO 0 - 5\nCULTIVO DESARROLLO DE: SIN DESARROLLO\nMicrorganismo\n1. Klebsiella oxytoca\nDesarrollo de más de 100,000 UFC/mL\nProductor de carbapenemasa de clase\nA, tipo KPC.\n- 1 -\nAntibioticos CMI ug/mL Cat.\nAmikacina 32 I\nCeftazitima-Avibactam 2/4 S\nErtapenem >1 R\nMeropenem 32 R\nS=Sensible; R=Resistente; I=Intermedio" + F + H + "HEMOCULTIVO CENTRAL\nCULTIVO POSITIVO SIN DESARROLLO\nMicrorganismo\n1. Staphylococcus epidermidis\nDetección a 18:06 horas.\nStaphylococcus productor de\nbetalactamasa\nTest Positivo para Meticilino\nresistencia\n- 1 -\nAntibioticos CMI ug/mL Cat.\nOxacilina >2 R\nVancomicina <=0.5 S\nS=Sensible; R=Resistente; I=Intermedio" + F);
  const sec = (n) => x.secciones.find((s) => s.nombre === n);
  assert(x && x.secciones.length === 3 && sec("HEMOCULTIVO PERIFERICO 1").resultado === "NEGATIVO" && /5 días/.test(sec("HEMOCULTIVO PERIFERICO 1").detalle), "HGL mixto: 3 secciones; periférico negativo a 5 días");
  const u = sec("UROCULTIVO");
  assert(u.resultado === "POSITIVO" && u.germenes[0].nombre === "Klebsiella oxytoca" && u.germenes[0].flags.includes("carbapenemasa KPC") && />\s*100,000 UFC/.test(u.germenes[0].ufc) && u.germenes[0].antibiograma.find((a) => a.antibiotico === "Ceftazitima-avibactam").interp === "S" && u.germenes[0].antibiograma.find((a) => a.antibiotico === "Meropenem").interp === "R", "HGL mixto: urocultivo con carbapenemasa KPC (tipo en la línea siguiente), UFC y antibiograma con nombre fuera de la lista (Ceftazitima-Avibactam)");
  const hc = sec("HEMOCULTIVO CENTRAL");
  assert(hc.resultado === "POSITIVO" && hc.germenes.length === 1 && hc.germenes[0].nombre === "Staphylococcus epidermidis" && hc.germenes[0].flags.includes("MRSA") && hc.germenes[0].flags.includes("betalactamasa") && hc.germenes[0].deteccion === "18:06 h" && hc.germenes[0].antibiograma.find((a) => a.antibiotico === "Vancomicina").interp === "S", "HGL mixto: central con S. epidermidis MRSA, hora de detección, sin germen falso por la línea cortada 'Staphylococcus productor de'");
  assert(x.resultado === "POSITIVO" && x.germenes.length === 2 && x.carbapenemasa && x.mrsa, "HGL mixto: resumen positivo con 2 gérmenes y banderas");
  const n = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 DESARROLLO\nNEGATIVO A 5 DIAS\nSIN DESARROLLO\nHEMOCULTIVO CENTRAL DESARROLLO\nNEGATIVO A 5 DIAS\nSIN DESARROLLO" + F);
  assert(n && n.resultado === "NEGATIVO" && n.secciones.length === 2 && n.secciones.every((s) => s.resultado === "NEGATIVO" && /5 días/.test(s.detalle)), "HGL hemocultivos negativos (2 frascos)");
  const b = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 En proceso\nHEMOCULTIVO CENTRAL\nCULTIVO POSITIVO SIN DESARROLLO\nMicrorganismo\n1. Bacillus spp.\nDetección a 14:28 horas.\nREPORTE NO VALIDADO" + F);
  assert(b && b.resultado === "POSITIVO" && sec && b.secciones[0].resultado === "PENDIENTE" && b.secciones[1].germenes[0].nombre === "Bacillus spp" && b.secciones[1].germenes[0].deteccion === "14:28 h" && b.tipo === "Hemocultivo central", "HGL: frasco en proceso + central positivo a Bacillus spp (preliminar)");
  const neg = extractCultureFromText(H + "UROCULTIVO\nLEUCOCITOS 0-1 X CAMPO 0 - 5\nCULTIVO NO DESARROLLO SIN DESARROLLO" + F);
  assert(neg && neg.resultado === "NEGATIVO" && neg.tipo === "Urocultivo", "HGL urocultivo negativo ('NO DESARROLLO' en la columna de resultado)");
  const tox = extractCultureFromText(H + "SANGRE OCULTA EN HECES\nMETODOLOGIA: ACTIVIDAD DE LA PEROXIDASA TRAZAS\nNEGATIVO\nAg GDH Y TOXINAS A+B DE Clostridium difficile\nMETODOLOGIA: INMUNOENSAYO CROMATOGRAFICO\nAg GDH NEGATIVO NEGATIVO\nTOXINA A NEGATIVO NEGATIVO" + F);
  assert(tox === null, "HGL: un test de toxinas que menciona un germen NO es un cultivo positivo");
  const sm = extractCultureFromText(H + "HEMOCULTIVO PERIFERICO 1 SIN MUESTRA SIN DESARROLLO\nHEMOCULTIVO CENTRAL SIN MUESTRA SIN DESARROLLO" + F);
  assert(sm && sm.pendiente && sm.secciones.every((s) => s.resultado === "SIN MUESTRA"), "HGL: 'SIN MUESTRA' no cuenta como negativo");
  const mssa = extractCultureFromText(H + "CULTIVO DE SECRECIONES\nTIPO DE MUESTRA Herida cervical\nCULTIVO DESARROLLO DE: SIN DESARROLLO\nMicrorganismo\n1. Staphylococcus aureus\nTest Negativo para Meticilino\nresistencia\n- 1 -\nAntibioticos CMI ug/mL Cat.\nOxacilina <=0.25 S\nTrimetoprim-Sulfametoxazol <=1/19 S\nS=Sensible; R=Resistente; I=Intermedio" + F);
  assert(mssa && mssa.germenes[0] === "Staphylococcus aureus" && !mssa.mrsa && mssa.muestra === "Herida cervical" && mssa.antibiograma.length === 2 && mssa.antibiograma[1].cim === "<=1/19", "HGL: S. aureus meticilino-sensible, muestra sin dos puntos, CIM con barra");
}

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
