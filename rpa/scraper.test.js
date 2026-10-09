// Test offline de la logica pura del scraper.
// Corre con: `node rpa/scraper.test.js` — no usa red ni Playwright.

import {
  dedupRecords, isAllowedEsp, formatDate,
  isMenuTableText, isFormTableText, isNoResultsText, isIrrelevantTable,
  isMeaningfulReportRow, extractApellidos, expVariants,
  stripAccentsKeepEnie, buildSearchCandidates,
  jaroWinkler, patientHeaderMatches,
  extractHeaderBirthDate, ageFromBirthDate, parseCensusAge, selectTargetRows,
  todayISO, reportKey, indexParsedReportes, mergeReportesPreservingValores,
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
// 24 jun 2026 — Gera: "TODOS los pacientes deben tener labs". isAllowedEsp ahora procesa
// TODO el censo (cualquier esp no vacío). Antes excluía URO/GYO/NCX y esos quedaban sin labs.
assert(isAllowedEsp("URO") === true,       "isAllowedEsp: URO -> true (todos)");
assert(isAllowedEsp("GYO") === true,       "isAllowedEsp: GYO -> true (todos)");
assert(isAllowedEsp("") === false,         "isAllowedEsp: vacio -> false");
assert(isAllowedEsp(null) === false,       "isAllowedEsp: null -> false");
assert(isAllowedEsp("URGENCIAS") === true, "isAllowedEsp: URGENCIAS -> true");
assert(isAllowedEsp("CMF/CT") === true,    "isAllowedEsp: CMF/CT -> true");
assert(isAllowedEsp("URO/CG") === true,    "isAllowedEsp: URO/CG -> true");
assert(isAllowedEsp("CT/URO") === true,    "isAllowedEsp: CT/URO -> true");
assert(isAllowedEsp("CG/CT") === true,     "isAllowedEsp: CG/CT -> true");
assert(isAllowedEsp("NCX/CG") === true,    "isAllowedEsp: NCX/CG -> true");
assert(isAllowedEsp("URO/GYO") === true,   "isAllowedEsp: URO/GYO -> true (todos)");
assert(isAllowedEsp("NCX") === true,       "isAllowedEsp: NCX -> true (todos)");

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

// ── 14b. isMeaningfulReportRow: COL_X + __cells (caso real WinLab con headers genericos)
// Cuando WinLab usa headers COL_X pero __cells tiene data real, la fila ES valida.
assert(isMeaningfulReportRow({
  COL_0: "BIOMETRIA HEMATICA",
  COL_1: "25/04/2026",
  COL_2: "COMPLETO",
  __cells: ["BIOMETRIA HEMATICA", "25/04/2026", "COMPLETO"],
  __hasLink: true,
  __rowIdxInTable: 2,
}) === true, "meaningful: COL_X + __cells con data real -> true (fix headers genericos WinLab)");

assert(isMeaningfulReportRow({
  COL_0: "LISTA REPORTES TODAS LAS UNIDADES ORGANIZATIVAS ACCESIBLES AL USUARIO",
  __cells: ["LISTA REPORTES TODAS LAS UNIDADES ORGANIZATIVAS ACCESIBLES AL USUARIO"],
  __hasLink: false,
  __rowIdxInTable: 0,
}) === false, "meaningful: COL_X + __cells con 1 celda basura -> false (no >= 2 celdas reales)");

assert(isMeaningfulReportRow({
  COL_0: "BIOMETRIA HEMATICA",
  COL_1: "25/04/2026",
  __cells: ["BIOMETRIA HEMATICA", "25/04/2026"],
}) === true, "meaningful: exactamente 2 celdas reales en __cells -> true");

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
// FIX cobertura (24 jun 2026): acentos y partículas líderes.
// FIX jul 2026: la Ñ se PRESERVA (WinLab es Ñ-sensible: MUÑIZ matcheaba con Ñ literal
// pre-24jun; "ZUNIGA" post-strip daba NINGUN REGISTRO). Solo se quitan acentos de vocales.
assert(extractApellidos("JOSE ADRIÁN ARREGUIN RODRÍGUEZ")[0] === "ARREGUIN RODRIGUEZ", "apellidos: sin acentos");
assert(extractApellidos("AARON ZUÑIGA PÁRAMO")[0] === "ZUÑIGA PARAMO", "apellidos: Ñ preservada + acento vocal fuera");
assert(extractApellidos("ELIZABETH GARCÍA MÁRQUEZ")[0] === "GARCIA MARQUEZ", "apellidos: GARCIA MARQUEZ sin acento");
assert(extractApellidos("JUAN DANIEL DEL ANGEL GOMEZ")[0] === "DEL ANGEL GOMEZ", "apellidos: incluye partícula DEL");
assert(extractApellidos("MA GUADALUPE DIAZ DE LEON MARQUEZ")[0] === "DE LEON MARQUEZ", "apellidos: incluye partícula DE");
assert(extractApellidos("JOSE DE JESUS LUNA MELENDEZ")[0] === "LUNA MELENDEZ", "apellidos: 'DE JESUS' (nombre) NO altera apellido");

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

// ── 17. stripAccentsKeepEnie (jul 2026) ───────────────────────────────
assert(stripAccentsKeepEnie("RODRÍGUEZ ZUÑIGA") === "RODRIGUEZ ZUÑIGA", "strip: acento fuera, Ñ intacta");
assert(stripAccentsKeepEnie("pérez ñato") === "PEREZ ÑATO", "strip: uppercase + ñ minúscula preservada");
assert(stripAccentsKeepEnie("PIÑON") === "PIÑON", "strip: PIÑON intacto");
assert(stripAccentsKeepEnie("ÑATO") === "ÑATO", "strip: Ñ descompuesta (N+U+0303) se recompone y preserva");
assert(stripAccentsKeepEnie("  ÁÉÍÓÚÜ  ") === "AEIOUU", "strip: todas las vocales acentuadas + trim");
assert(stripAccentsKeepEnie(null) === "", "strip: null -> ''");

// ── 18. buildSearchCandidates (jul 2026) — escalera de búsqueda ───────
{
  // Caso Ñ (TADEO, 3-143): primaria con Ñ, retry con N.
  const c = buildSearchCandidates("TADEO DE JESUS RODRIGUEZ ZUÑIGA");
  assert(c[0].cognome === "RODRIGUEZ ZUÑIGA" && !c[0].nome, "cand: primaria Ñ preservada");
  assert(c.some((x) => x.cognome === "RODRIGUEZ ZUNIGA"), "cand: variante N-por-Ñ presente");
}
{
  // Caso nombre invertido en la hoja (MARQUEZ VALLEJO JUAN JOSE, 3-188).
  const c = buildSearchCandidates("MARQUEZ VALLEJO JUAN JOSE");
  assert(c[0].cognome === "JUAN JOSE", "cand: primaria = últimas 2 (convención)");
  assert(c.some((x) => x.cognome === "MARQUEZ VALLEJO" && x.nome === "JUAN JOSE"),
    "cand: retry invertido apellidos-primero con nome");
}
{
  // Caso apellido extranjero de 3 palabras (PIERROT, 3-150).
  const c = buildSearchCandidates("PIERROT TONY ZAKHIA EL DOVAIHY");
  assert(c[0].cognome === "EL DOVAIHY", "cand: primaria últimas 2");
  assert(c.some((x) => x.cognome === "ZAKHIA EL DOVAIHY"), "cand: retry apellido 3 palabras");
}
{
  // Caso 2 palabras (ARMANDO RIOS): apellido+nombre y su swap.
  const c = buildSearchCandidates("ARMANDO RIOS");
  assert(c[0].cognome === "RIOS" && c[0].nome === "ARMANDO", "cand: 2-palabras apellido+nombre");
  assert(c.some((x) => x.cognome === "ARMANDO" && x.nome === "RIOS"), "cand: 2-palabras swap");
}
{
  // Nombre normal de 4 palabras: la primaria correcta va PRIMERO (sin regresión).
  const c = buildSearchCandidates("AGUSTIN JAIME MENDOZA GONZALEZ");
  assert(c[0].cognome === "MENDOZA GONZALEZ" && !c[0].nome, "cand: normal 4 palabras sin cambio");
}
{
  // Caso ADAN LOPEZ OVIEDO (37 días, sin labs con apellidos exactos → typo en materno).
  // Último recurso: paterno-solo + nombre de pila (el match difuso confirma OVIEDO≈OBIEDO).
  const c = buildSearchCandidates("ADAN LOPEZ OVIEDO");
  assert(c[0].cognome === "LOPEZ OVIEDO" && !c[0].nome, "cand: primaria apellidos");
  assert(c.some((x) => x.cognome === "LOPEZ" && x.nome === "ADAN"), "cand: retry paterno-solo + nombre");
  // el paterno-solo va AL FINAL (es el último recurso, más ancho)
  assert(c[c.length - 1].tag === "paterno-solo + nombre", "cand: paterno-solo es el último");
}
{
  // El match difuso de encabezado reconoce el typo V/B en el materno.
  assert(jaroWinkler("OVIEDO", "OBIEDO") >= 0.88, "match: OVIEDO≈OBIEDO Jaro-Winkler ≥0.88");
  assert(patientHeaderMatches("LOPEZ OBIEDO ADAN", "ADAN LOPEZ OVIEDO") === true,
    "match: header con materno mal escrito aún identifica al objetivo");
  assert(patientHeaderMatches("LOPEZ HERNANDEZ PEDRO", "ADAN LOPEZ OVIEDO") === false,
    "match: homónimo de apellido distinto NO se confunde (nombre de pila distinto)");
}
{
  // Sin candidatos duplicados.
  const c = buildSearchCandidates("JUAN PEREZ PEREZ");
  const keys = c.map((x) => x.key);
  assert(new Set(keys).size === keys.length, "cand: sin duplicados");
}
assert(buildSearchCandidates("MARIA").length === 0, "cand: 1 palabra -> []");
assert(buildSearchCandidates(null).length === 0, "cand: null -> []");

// ── Guarda de edad en el targeting (oct 2026) ─────────────────────────
{
  const TODAY = new Date(2026, 9, 9); // 9 oct 2026 (mes 0-based)
  // Fila-encabezado real de WinLab: ["", "", codigo(vacío), APELLIDOS, NOMBRE, SEXO, FECHA DE NAC.]
  const hdr = (ap, no, sexo, fnac) => ({ __cells: ["", "", "", ap, no, sexo, fnac], __hasLink: false });
  const rep = (id) => ({ __cells: ["", id, "08/10/2026 06:16", "08/10/2026 06:34", "08/10/2026 12:56", ""], __hasLink: true });

  assert(extractHeaderBirthDate(hdr("PEREZ LOPEZ", "JUAN", "MASCULINO", "01/01/1946").__cells) === "01/01/1946",
    "fnac: se extrae de la celda siguiente a SEXO");
  assert(extractHeaderBirthDate(rep("1").__cells) === "", "fnac: fila de reporte (sin SEXO) -> ''");
  assert(ageFromBirthDate("10/05/1973", TODAY) === 53, "edad: 10/05/1973 -> 53 el 9 oct 2026");
  assert(ageFromBirthDate("15/12/2010", TODAY) === 15, "edad: cumpleaños pendiente resta 1");
  assert(ageFromBirthDate("09/10/2010", TODAY) === 16, "edad: cumple hoy -> 16");
  assert(ageFromBirthDate("garbage", TODAY) === null && ageFromBirthDate("", TODAY) === null, "edad: inválida -> null");
  assert(parseCensusAge("52") === 52 && parseCensusAge("52a") === 52 && parseCensusAge("52 años") === 52,
    "censo edad: '52' / '52a' / '52 años' -> 52");
  assert(parseCensusAge("3m") === null && parseCensusAge("20 dias") === null && parseCensusAge("") === null && parseCensusAge(null) === null,
    "censo edad: meses/días/vacío -> null (guarda no aplica)");

  // Caso real corrida #386 (cama 2-024): homónimo de nombre COMPLETO, 16 años, listado
  // ANTES del paciente real (80). Sin guarda, el bloque del joven se drilleaba.
  const paciente = { nombre: "JUAN PEREZ LOPEZ", edad: "80" };
  const rows = [
    hdr("PEREZ LOPEZ", "JUAN", "MASCULINO", "01/01/2010"), rep("1"), rep("2"),   // idx 0..2 → 16 años
    hdr("PEREZ LOPEZ", "JUAN", "MASCULINO", "01/01/1946"), rep("3"), rep("4"),   // idx 3..5 → 80 años
    hdr("PEREZ HERNANDEZ", "PEDRO", "MASCULINO", "01/01/1946"), rep("5"),         // idx 6..7 → otro nombre
  ];
  const sel = selectTargetRows(rows, paciente, { ageTolerance: 2, today: TODAY });
  assert(deepEq(sel.targetIdxs, [4, 5]), "target: solo el bloque con edad compatible (80)");
  assert(sel.ageRejected.length === 1 && sel.ageRejected[0].headerAge === 16 && sel.ageRejected[0].censusAge === 80,
    "target: el homónimo de 16 años queda registrado como rechazado por edad");
  assert(deepEq(sel.linkIdxs, [1, 2, 4, 5, 7]), "target: linkIdxs lista todos los enlaces (diagnóstico)");

  // Tolerancia: censo 75 vs WinLab 74 (cumpleaños reciente / edad del censo sin actualizar) sí pasa.
  const sel2 = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "MASCULINO", "01/01/1952"), rep("1")], { nombre: "JUAN PEREZ LOPEZ", edad: "75" }, { today: TODAY });
  assert(deepEq(sel2.targetIdxs, [1]) && sel2.ageRejected.length === 0, "target: diferencia de 1 año dentro de la tolerancia");

  // Sin edad en el censo → la guarda no aplica (comportamiento previo: solo nombre).
  const sel3 = selectTargetRows(rows, { nombre: "JUAN PEREZ LOPEZ", edad: "" }, { today: TODAY });
  assert(deepEq(sel3.targetIdxs, [1, 2, 4, 5]) && sel3.censusAge === null, "target: sin edad en censo -> ambos bloques homónimos (legacy)");

  // Encabezado sin fecha de nacimiento (6 celdas) → no se puede verificar → se mantiene el match por nombre.
  const sel4 = selectTargetRows([{ __cells: ["", "", "", "PEREZ LOPEZ", "JUAN", "MASCULINO"], __hasLink: false }, rep("1")], paciente, { today: TODAY });
  assert(deepEq(sel4.targetIdxs, [1]), "target: encabezado sin fnac -> match por nombre se mantiene");

  // Nombre distinto nunca entra, con o sin edad compatible.
  const sel5 = selectTargetRows([hdr("PEREZ HERNANDEZ", "PEDRO", "MASCULINO", "01/01/1946"), rep("1")], paciente, { today: TODAY });
  assert(deepEq(sel5.targetIdxs, []) && sel5.ageRejected.length === 0, "target: nombre distinto no es objetivo (sin pasar por guarda de edad)");
}

// ── Fecha en zona León y fusión de valores entre corridas (oct 2026) ───
{
  const at = new Date("2026-10-10T02:30:00Z"); // 20:30 del 9 de octubre en León
  assert(todayISO("America/Mexico_City", at) === "2026-10-09", "todayISO: 02:30Z es 9 oct en León (no 10 oct)");
  assert(todayISO("UTC", at) === "2026-10-10", "todayISO: en UTC sí sería 10 oct (comportamiento viejo del runner)");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(todayISO("Zona/Invalida", at)), "todayISO: zona inválida → fallback con formato ISO");

  const rep = (code, valores, target) => ({
    __cells: ["", "", code, "08/10/2026 06:16", "08/10/2026 06:34", ""], __hasLink: true,
    ...(target ? { __target: true } : {}), ...(valores ? { valores } : {}),
  });
  const prevRows = [{ exp: "X", data: { reportes: [
    rep("A1", [{ estudio: "GLUCOSA", valor: "90" }], true), // objetivo con valores → reutilizable
    rep("B2", [{ estudio: "HB", valor: "13" }], false),     // homónimo con valores → NO reutilizable
    rep("C3", null, true),                                   // objetivo sin valores → nada que reutilizar
  ] } }];
  const parsed = indexParsedReportes(prevRows);
  assert(parsed.size === 1 && parsed.has(reportKey(rep("A1"))), "indexParsed: solo refertos __target con valores");
  assert(reportKey(rep("A1")) === reportKey(rep("A1", null, true)), "reportKey: depende solo de __cells (no de flags)");

  const nuevos = [rep("A1", null, true), rep("B2", null, true), rep("D4", [{ estudio: "K", valor: "4" }], true), rep("A1", null, false)];
  const m = mergeReportesPreservingValores(nuevos, parsed);
  assert(m.reused === 1, "merge: reutiliza exactamente 1 (A1 objetivo sin valores)");
  assert(nuevos[0].valores && nuevos[0].valores[0].estudio === "GLUCOSA" && nuevos[0].valores_src === "prev", "merge: A1 recibe valores previos marcados src=prev");
  assert(!nuevos[1].valores, "merge: B2 (valores previos de un homónimo) no recibe nada");
  assert(nuevos[2].valores[0].valor === "4" && !nuevos[2].valores_src, "merge: valores propios de esta corrida se respetan");
  assert(!nuevos[3].valores, "merge: una fila no-objetivo nunca recibe valores");
  assert(mergeReportesPreservingValores(nuevos, new Map()).reused === 0, "merge: mapa vacío → 0 reutilizados");
  assert(indexParsedReportes([]).size === 0 && indexParsedReportes(null).size === 0, "indexParsed: entradas vacías → mapa vacío");
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
