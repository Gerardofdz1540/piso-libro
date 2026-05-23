// Tests offline del módulo pdf-extract.js
// Corre con: `node rpa/pdf-extract.test.js` — usa pdf-parse + fixture local.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  extractLabValuesFromText,
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

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) process.exit(1);
