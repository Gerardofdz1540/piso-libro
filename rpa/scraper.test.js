// Test offline de la logica pura del scraper.
// Corre con: `node rpa/scraper.test.js` — no usa red ni Playwright.

import {
  dedupRecords, isAllowedEsp, formatDate,
  isMenuTableText, isFormTableText, isNoResultsText, isIrrelevantTable,
  isMeaningfulReportRow, extractApellidos, expVariants,
} from "./lib.js";

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else      { fail++; console.error(`✗ ${name}`); }
}
function deepEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── 1. Sin duplicados: passthrough ────────────────────────────────────
{
  const recs = [
    { exp: "A", fecha: "2026-04-25", paciente: "Pac1", data: { reportes: [{__cells: ["x"]}] } },
    { exp: "B", fecha: "2026-04-25", paciente: "Pac2", data: { reportes: [{__cells: ["y"]}] } },
  ];
  const out = dedupRecords(recs, "exp,fecha");
  assert(out.length === 2, "Sin duplicados: passthrough conserva 2");
}

// ── 2. Duplicados (mismo exp + mismo fecha) → 1 fila con merge ────────
{
  const recs = [
    { exp: "X", fecha: "2026-04-25", paciente: "Pac A", data: { reportes: [{__cells: ["lab1"]}] } },
    { exp: "X", fecha: "2026-04-25", paciente: "Pac B", data: { reportes: [{__cells: ["lab2"]}] } },
  ];
  const out = dedupRecords(recs, "exp,fecha");
  assert(out.length === 1, "Duplicados: 2 -> 1 fila");
  assert(out[0].data.reportes.length === 2, "Merge: 2 reportes en la fila resultante");
  assert(deepEq(out[0].data.aliases, ["Pac A", "Pac B"]), "Merge: aliases tiene ambos pacientes");
}

// ── 3. Duplicados con reportes IDENTICOS no se duplican ───────────────
{
  const lab = { __cells: ["foo", "bar"] };
  const recs = [
    { exp: "Y", fecha: "2026-04-25", paciente: "P1", data: { reportes: [lab] } },
    { exp: "Y", fecha: "2026-04-25", paciente: "P2", data: { reportes: [lab] } },
  ];
  const out = dedupRecords(recs, "exp,fecha");
  assert(out.length === 1 && out[0].data.reportes.length === 1, "Reportes identicos no se duplican (dedup interno)");
}

// ── 4. Caso real del usuario: 2 pacientes con exp 24-19161 ────────────
{
  const recs = [
    { exp: "24-19161", fecha: "2026-04-25", paciente: "ISAAC RAMIREZ",
      data: { reportes: [{__cells: ["bh", "10.3"]}] } },
    { exp: "24-19161", fecha: "2026-04-25", paciente: "MARTHA AIDA MARTINEZ GUZMAN",
      data: { reportes: [{__cells: ["glu", "120"]}] } },
  ];
  const out = dedupRecords(recs, "exp,fecha");
  assert(out.length === 1, "Censo bug exp duplicado: 2 -> 1 fila (no rompe upsert)");
  assert(out[0].data.reportes.length === 2, "Bug exp duplicado: ambos labs preservados");
  assert(out[0].data.aliases.includes("ISAAC RAMIREZ") && out[0].data.aliases.includes("MARTHA AIDA MARTINEZ GUZMAN"),
    "Bug exp duplicado: ambos nombres en aliases para que veas el conflicto");
}

// ── 5. Diferente fecha → no se mergea ─────────────────────────────────
{
  const recs = [
    { exp: "Z", fecha: "2026-04-25", paciente: "P", data: { reportes: [{__cells: ["a"]}] } },
    { exp: "Z", fecha: "2026-04-24", paciente: "P", data: { reportes: [{__cells: ["b"]}] } },
  ];
  const out = dedupRecords(recs, "exp,fecha");
  assert(out.length === 2, "Mismo exp + fecha distinta: NO se mergea (preserva historial)");
}

// ── 6. Lista vacia ────────────────────────────────────────────────────
{
  const out = dedupRecords([], "exp,fecha");
  assert(Array.isArray(out) && out.length === 0, "Lista vacia: passthrough");
}

// ── 7. isAllowedEsp ───────────────────────────────────────────────────
assert(isAllowedEsp("CG") === true,        "isAllowedEsp: CG -> true");
assert(isAllowedEsp("CT") === true,        "isAllowedEsp: CT -> true");
assert(isAllowedEsp("CG/GYO") === true,    "isAllowedEsp: CG/GYO -> true");
assert(isAllowedEsp("URO") === false,      "isAllowedEsp: URO -> false (excluida)");
assert(isAllowedEsp("GYO") === false,      "isAllowedEsp: GYO -> false (excluida)");
assert(isAllowedEsp("") === false,         "isAllowedEsp: vacio -> false");
assert(isAllowedEsp(null) === false,       "isAllowedEsp: null -> false");
assert(isAllowedEsp("URGENCIAS") === true, "isAllowedEsp: URGENCIAS -> true");

// ── 8. formatDate ─────────────────────────────────────────────────────
{
  const d = new Date(2026, 3, 25); // 25 abril 2026 (mes 0-indexed)
  assert(formatDate(d, "dd/MM/yyyy") === "25/04/2026", "formatDate dd/MM/yyyy");
  assert(formatDate(d, "yyyy-MM-dd") === "2026-04-25", "formatDate ISO");
  assert(formatDate(d, "MM/dd/yyyy") === "04/25/2026", "formatDate US");
}

// ── 9. isMenuTableText ────────────────────────────────────────────────
assert(isMenuTableText("Inicio Reportes Ayuda Cierra") === true,  "menu: Inicio Reportes Ayuda Cierra");
assert(isMenuTableText("Inicio\nReportes\nAyuda\nCierra") === true, "menu: con saltos de linea");
assert(isMenuTableText("INICIO   REPORTES   AYUDA") === true,     "menu: espacios extra");
assert(isMenuTableText("Tabla cualquiera con datos") === false,    "menu: NO en texto de datos");
assert(isMenuTableText("") === false,                              "menu: vacio false");

// ── 10. isFormTableText ───────────────────────────────────────────────
{
  // Texto real del log: contiene varios markers del formulario.
  const formText = "Inicio Reportes Ayuda Cierra Busca Reportes Todas las Unidades organizativas accesibles al usuario Paciente Apellido Nombre Codigo Paciente RFC Reportes Con Resultados Todos Completos Incompletos Reportes Impresos Si No Fecha Reporte De A";
  assert(isFormTableText(formText) === true, "form: dump real del log -> true");
}
assert(isFormTableText("Hb 10.3 g/dL Glucosa 120 mg/dL") === false, "form: tabla de labs reales -> false");
assert(isFormTableText("Busca Reportes") === false,                  "form: solo 1 marker -> false (necesita 2+)");
assert(isFormTableText("Busca Reportes Codigo Paciente") === true,   "form: 2 markers -> true");

// ── 11. isNoResultsText ───────────────────────────────────────────────
assert(isNoResultsText("Ningún Registro Encontrado") === true, "no-results: con tilde");
assert(isNoResultsText("NINGUN REGISTRO ENCONTRADO") === true, "no-results: sin tilde mayusculas");
assert(isNoResultsText("Nessun registro presente") === true,    "no-results: italiano nessun");
assert(isNoResultsText("3 reportes encontrados") === false,     "no-results: tabla con datos -> false");

// ── 12. isIrrelevantTable ─────────────────────────────────────────────
assert(isIrrelevantTable("Inicio Reportes Ayuda") === true,       "irrelevant: menu");
assert(isIrrelevantTable("Busca Reportes Codigo Paciente Fecha Reporte De A") === true, "irrelevant: form");
assert(isIrrelevantTable("Hb 10.3 Glucosa 120 Creatinina 0.8") === false, "irrelevant: tabla de labs reales");

// ── 13. isFormTableText: post-search 'LISTA REPORTES' ─────────────────
{
  // Texto exacto del bug reportado por el usuario en la captura.
  const postSearchText = "LISTA REPORTES TODAS LAS UNIDADES ORGANIZATIVAS ACCESIBLES AL USUARIO";
  assert(isFormTableText(postSearchText) === true, "form: 'LISTA REPORTES TODAS LAS UNIDADES' -> true (post-search header)");
}
assert(isFormTableText("LISTA REPORTES") === false, "form: solo 'LISTA REPORTES' (1 marker) -> false");

// ── 14. isMeaningfulReportRow ─────────────────────────────────────────
// Reporte basura del bug: solo COL_X y markers tecnicos.
assert(isMeaningfulReportRow({
  COL_0: "LISTA REPORTES TODAS LAS UNIDADES ORGANIZATIVAS ACCESIBLES AL USUARIO",
  __hasLink: true,
  __rowIdxInTable: 1,
}) === false, "meaningful: fila basura COL_0+LISTA REPORTES -> false");

assert(isMeaningfulReportRow({
  COL_0: "TODAS LAS UNIDADES ORGANIZATIVAS ACCESIBLES AL USUARIO",
  __rowIdxInTable: 3,
}) === false, "meaningful: solo TODAS LAS UNIDADES -> false");

assert(isMeaningfulReportRow({
  __hasLink: true,
  __rowIdxInTable: 4,
}) === false, "meaningful: solo metadata tecnica -> false");

assert(isMeaningfulReportRow({
  FECHA: "25/04/2026",
  ESTUDIO: "BIOMETRIA HEMATICA",
  ESTADO: "COMPLETO",
  __cells: ["..."],
}) === true, "meaningful: fila con FECHA/ESTUDIO -> true (data real)");

assert(isMeaningfulReportRow({
  COL_0: "BIOMETRIA HEMATICA",
  COL_1: "25/04/2026",
}) === false, "meaningful: solo COL_X (no semantico) -> false");

assert(isMeaningfulReportRow(null) === false, "meaningful: null -> false");
assert(isMeaningfulReportRow({}) === false,    "meaningful: objeto vacio -> false");

// ── 15. extractApellidos ──────────────────────────────────────────────
{
  const a1 = extractApellidos("AGUSTIN JAIME MENDOZA GONZALEZ");
  assert(a1.includes("MENDOZA GONZALEZ"), "apellidos: 2 ultimas palabras");
  assert(a1.includes("MENDOZA"),          "apellidos: solo penultima (paterno)");
}
{
  const a2 = extractApellidos("ALEJANDRO RAMIREZ HERNANDEZ");
  assert(a2.includes("RAMIREZ HERNANDEZ"), "apellidos: nombre simple + 2 apellidos");
  assert(a2.includes("RAMIREZ"),           "apellidos: paterno");
}
{
  const a3 = extractApellidos("MARIA");
  assert(a3.length === 0, "apellidos: una sola palabra -> []");
}
assert(extractApellidos(null).length === 0,  "apellidos: null -> []");
assert(extractApellidos("").length === 0,    "apellidos: vacio -> []");
{
  const a5 = extractApellidos("  Pedro  Romero  Juarez  ");
  assert(a5[0] === "ROMERO JUAREZ", "apellidos: trim + uppercase");
}

// ── 16. expVariants ───────────────────────────────────────────────────
{
  const v = expVariants("26-06437");
  assert(v.includes("26-06437"), "expVariants: original con dash");
  assert(v.includes("2606437"),  "expVariants: sin dash");
  assert(v.includes("06437"),    "expVariants: parte despues del ultimo dash");
}
{
  const v = expVariants("12345");
  assert(v.length === 1 && v[0] === "12345", "expVariants: sin dash -> 1 variante");
}
{
  const v = expVariants("25-023804");
  assert(v.includes("25-023804") && v.includes("25023804") && v.includes("023804"),
    "expVariants: 3 variantes con dash");
}
assert(expVariants(null).length === 0, "expVariants: null -> []");
assert(expVariants("").length === 0,   "expVariants: vacio -> []");

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
