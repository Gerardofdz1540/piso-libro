// Test offline de la logica pura del scraper.
// Corre con: `node rpa/scraper.test.js` — no usa red ni Playwright.

import {
  dedupRecords, isAllowedEsp, formatDate,
  isMenuTableText, isFormTableText, isNoResultsText, isIrrelevantTable,
  isMeaningfulReportRow, extractApellidos, expVariants,
  stripAccentsKeepEnie, buildSearchCandidates, buildSearchCandidatesWithAlias, normExp,
  jaroWinkler, patientHeaderMatches,
  extractHeaderBirthDate, extractHeaderName, ageFromBirthDate, parseCensusAge, selectTargetRows, sameBirthdayOtherYear,
  todayISO, reportKey, indexParsedReportes, mergeReportesPreservingValores,
  normNameTokens, expandNomeAbbrev,
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
assert(isAllowedEsp("") === true,          "isAllowedEsp: vacio -> true (esta en el censo, necesita labs)");
assert(isAllowedEsp(null) === true,        "isAllowedEsp: null -> true");
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
  assert(a1.includes("MENDOZA"),            "apellidos: solo penultima (paterno)");
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
  // paterno-solo y materno-solo van AL FINAL (último recurso, búsquedas más anchas), en ese orden
  assert(c[c.length - 2].tag === "paterno-solo + nombre" && c[c.length - 1].tag === "materno-solo + nombre" && c[c.length - 1].cognome === "OVIEDO" && c[c.length - 1].nome === "ADAN", "cand: paterno-solo y materno-solo son los últimos");
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

// ── WinLab en italiano (11 oct 2026: la interfaz cambió de idioma y dos corridas dieron 0/48) ──
{
  const TODAY = new Date("2026-10-11T12:00:00Z");
  const hdrIt = (ap, nom, sexo, fnac) => ({ __cells: ["", "", "", ap, nom, sexo, fnac], __hasLink: false });
  const repIt = (id) => ({ __cells: ["", "", id, "11/10/2026 07:15", "11/10/2026 10:31", "CHIRURGIA GENERALE"], __hasLink: true });
  const paciente = { nombre: "MARIA ERIKA HERNANDEZ", edad: "49" };
  const sel = selectTargetRows([hdrIt("HERNANDEZ", "MA ERIKA", "Femminile", "30/01/1977"), repIt("1"), hdrIt("HERNANDEZ", "PEDRO", "Maschile", "01/01/1950"), repIt("2")], paciente, { today: TODAY });
  assert(deepEq(sel.targetIdxs, [1]), "IT: encabezado con Femminile/Maschile se reconoce (targeting igual que en español)");
  const selF = selectTargetRows([hdrIt("HERNANDEZ", "MA ERIKA", "F", "30/01/1977"), repIt("1")], paciente, { today: TODAY });
  assert(deepEq(selF.targetIdxs, [1]), "IT: sexo abreviado F/M también se reconoce");
  const selX = selectTargetRows([hdrIt("HERNANDEZ", "MA ERIKA", "Weiblich", "30/01/1977"), repIt("1")], paciente, { today: TODAY });
  assert(deepEq(selX.targetIdxs, [1]), "idioma desconocido: la fila-encabezado se reconoce por su forma (nombre, nombre, sexo corto, fecha de nacimiento)");
  assert(extractHeaderBirthDate(["", "", "", "HERNANDEZ", "MA ERIKA", "Femminile", "30/01/1977"]) === "30/01/1977", "IT: fecha de nacimiento tras la celda de sexo");
  assert(extractHeaderName(repIt("1").__cells) === "", "IT: una fila de reporte (barcode + fechas-hora) nunca se toma por encabezado");
  assert(isMenuTableText("Home\nReferti\nAiuto\nChiudi") === true, "IT: menú superior Home Referti Aiuto");
  assert(isFormTableText("Cerca Referti Tutte le Unità organizzative Paziente Cognome Nome Codice Paziente Data Referto da a") === true, "IT: formulario de búsqueda");
  assert(isMeaningfulReportRow({ __cells: ["ELENCO REFERTI", "HOME", "REFERTI"], COL_0: "x" }) === false, "IT: fila de menú/formulario no es un reporte");
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

// ── P1 (oct 2026): variante de género A/O, abreviaturas de nombre, candidatos con puntos ──
{
  assert(patientHeaderMatches("GARCIA LOPEZ ANTONIO", "ANTONIO GARCIA LOPEZ") === true, "match: mismo nombre completo → true");
  assert(patientHeaderMatches("GARCIA LOPEZ ANTONIA", "ANTONIO GARCIA LOPEZ") === false, "match: ANTONIO vs ANTONIA (otro sexo) → false");
  assert(patientHeaderMatches("HERNANDEZ RUIZ MARIO", "MARIA HERNANDEZ RUIZ") === false, "match: MARIO vs MARIA → false");
  assert(patientHeaderMatches("HERNANDEZ RUIZ FRANCISCA", "FRANCISCO HERNANDEZ RUIZ") === false, "match: FRANCISCO vs FRANCISCA → false");
  assert(patientHeaderMatches("RAMIREZ SOTO ESEQUIEL", "EZEQUIEL RAMIREZ SOTO") === true, "match: typo ESEQUIEL≈EZEQUIEL sigue tolerado (no es variante A/O)");
  assert(patientHeaderMatches("PEREZ LUNA ROSARIO", "ROSARIO PEREZ LUNA") === true, "match: ROSARIO exacto → true");

  assert(deepEq(normNameTokens("FCO. JAVIER PEREZ"), ["FRANCISCO", "JAVIER", "PEREZ"]), "normNameTokens: FCO. → FRANCISCO");
  assert(deepEq(normNameTokens("FCA. ELENA"), ["FRANCISCA", "ELENA"]), "normNameTokens: FCA. → FRANCISCA");
  assert(expandNomeAbbrev("MA. DEL CARMEN") === "MARIA DEL CARMEN", "expandNomeAbbrev: MA. → MARIA");
  assert(expandNomeAbbrev("J. GPE") === "JOSE GUADALUPE", "expandNomeAbbrev: J. GPE → JOSE GUADALUPE");
  assert(expandNomeAbbrev("") === "" && expandNomeAbbrev(null) === "", "expandNomeAbbrev: vacío/null → ''");

  const c = buildSearchCandidates("FCO. JAVIER PEREZ LOPEZ");
  assert(c.length > 0 && c[0].cognome === "PEREZ LOPEZ" && c[0].nome === "FRANCISCO JAVIER", "cand FCO.: primer candidato = apellidos + nombre expandido FRANCISCO JAVIER");
  assert(c.some((x) => x.cognome === "PEREZ LOPEZ" && x.nome === null), "cand FCO.: segundo candidato = apellidos estándar sin nome");
  assert(c.some((x) => x.cognome === "PEREZ" && x.nome === "FRANCISCO JAVIER"), "cand FCO.: paterno-solo + nombre expandido");
  assert(!c.some((x) => !x.sibling && (/\bFCO\b|\./.test(x.cognome) || /\bFCO\b|\./.test(x.nome || ""))), "cand FCO.: ningún candidato principal lleva la abreviatura ni puntos");
  assert(c.some((x) => x.sibling && x.cognome === "PEREZ LOPEZ" && x.nome === "FCO JAVIER") && c.findIndex((x) => x.sibling) === 1, "cand FCO.: variante literal 'FCO JAVIER' como sibling justo después de la expandida (otro registro en WinLab)");
  const c3 = buildSearchCandidates("MA. ERIKA HERNANDEZ");
  assert(c3[0].cognome === "HERNANDEZ" && c3[0].nome === "MARIA ERIKA" && c3[1].sibling && c3[1].nome === "MA ERIKA", "cand MA. ERIKA: expandida y luego literal como sibling");
  assert(!c.some((x) => x.cognome === "FCO JAVIER" || x.cognome === "FRANCISCO JAVIER"), "cand FCO.: no se genera el 'invertido' con el nombre como apellido");
  const c2 = buildSearchCandidates("MA. GUADALUPE RIOS");
  assert(c2[0].cognome === "RIOS" && c2[0].nome === "MARIA GUADALUPE", "cand MA.: RIOS + nombre MARIA GUADALUPE");
  assert(c2.some((x) => x.cognome === "RIOS" && x.nome === null), "cand MA.: fallback apellido a secas");
  assert(!c2.some((x) => x.cognome === "GUADALUPE RIOS"), "cand MA.: GUADALUPE ya no se toma como apellido");
}

// ── Alias "nombre en WinLab", materno-solo + nombre y corrida dirigida (oct 2026) ──
{
  // Caso real cama 3-181 (corrida #419): paterno con letras invertidas en el censo.
  const c = buildSearchCandidates("ADRIAN HERNADNEZ CASTRO");
  assert(c.some((x) => x.cognome === "CASTRO" && x.nome === "ADRIAN" && x.tag === "materno-solo + nombre"), "cand 3-181: materno-solo + nombre (CASTRO + ADRIAN) tolera el error de dedo en el paterno");
  const iPat = c.findIndex((x) => x.tag === "paterno-solo + nombre"), iMat = c.findIndex((x) => x.tag === "materno-solo + nombre");
  assert(iPat >= 0 && iMat === iPat + 1 && iMat === c.length - 1, "cand: materno-solo va justo después del paterno-solo y es el último recurso");
  assert(jaroWinkler("HERNADNEZ", "HERNANDEZ") >= 0.88 && patientHeaderMatches("HERNANDEZ CASTRO ADRIAN", "ADRIAN HERNADNEZ CASTRO"), "match difuso: HERNADNEZ≈HERNANDEZ (letras invertidas) identifica al objetivo en el encabezado");
  const c4 = buildSearchCandidates("MARIA GARCIA DE LA TORRE");
  assert(c4.some((x) => x.cognome === "DE LA TORRE" && x.nome === "MARIA"), "cand: materno con partícula (DE LA TORRE) + nombre");
  const same = buildSearchCandidates("JUAN PEREZ PEREZ");
  assert(same.filter((x) => x.cognome === "PEREZ" && x.nome === "JUAN").length === 1, "cand: paterno = materno no duplica el candidato");
  // Alias con coma: APELLIDOS, NOMBRE (como lo lista WinLab) → primero, con respaldos; luego el censo.
  const ca = buildSearchCandidatesWithAlias("ADRIAN HERNADNEZ CASTRO", "HERNANDEZ CASTRO, ADRIAN");
  assert(ca[0].alias === true && ca[0].cognome === "HERNANDEZ CASTRO" && ca[0].nome === "ADRIAN", "alias con coma: primer candidato = apellidos de WinLab + nombre");
  assert(ca[1].alias === true && ca[1].cognome === "HERNANDEZ CASTRO" && ca[1].nome === null, "alias: segundo = apellidos solos");
  assert(ca.some((x) => x.alias && x.cognome === "HERNANDEZ" && x.nome === "ADRIAN") && ca.some((x) => x.alias && x.cognome === "CASTRO" && x.nome === "ADRIAN"), "alias: también paterno + nombre y materno + nombre");
  assert(ca.some((x) => !x.alias && x.cognome === "HERNADNEZ CASTRO"), "alias: después siguen los candidatos del censo");
  assert(buildSearchCandidatesWithAlias("ADRIAN HERNADNEZ CASTRO", "MA. DEL CARMEN RIOS, MA. ELENA")[0].nome === "MARIA ELENA", "alias: abreviaturas del nombre expandidas");
  const cb = buildSearchCandidatesWithAlias("ADRIAN HERNADNEZ CASTRO", "ADRIAN HERNANDEZ CASTRO");
  assert(cb[0].alias === true && cb[0].cognome === "HERNANDEZ CASTRO" && cb[0].nome === null, "alias sin coma: se lee como en el censo (NOMBRE APELLIDOS)");
  assert(deepEq(buildSearchCandidatesWithAlias("ADRIAN HERNADNEZ CASTRO", "  "), buildSearchCandidates("ADRIAN HERNADNEZ CASTRO")), "sin alias: mismos candidatos de siempre");
  // selectTargetRows: el alias identifica al objetivo; seenNames en formato APELLIDOS, NOMBRE; edad sigue mandando.
  const rowsW = [
    { __cells: ["", "", "", "HERNANDEZ CASTRO", "ADRIAN", "Masculino", "03/01/1990"], __hasLink: false },
    { __cells: ["", "", "2610141380", "14/10/2026 09:07", "14/10/2026 10:51", "CIRUGIA"], __hasLink: true },
    { __cells: ["", "", "", "HERNANDEZ CASTRO", "ADRIAN", "Masculino", "15/07/1960"], __hasLink: false },   // homónimo real: otra fecha de nacimiento
    { __cells: ["", "", "2610141381", "14/10/2026 09:07", "14/10/2026 10:51", "CIRUGIA"], __hasLink: true },
  ];
  const hoy = new Date("2026-10-14T12:00:00");
  const selA = selectTargetRows(rowsW, { nombre: "JUAN LOPEZ LOPEZ", alias: "HERNANDEZ CASTRO, ADRIAN", edad: "36" }, { today: hoy });
  assert(deepEq(selA.targetIdxs, [1]) && selA.matchedHeader === "HERNANDEZ CASTRO ADRIAN", "selectTargetRows: el alias identifica al objetivo aunque el censo diga otro nombre; matchedHeader");
  assert(deepEq(selA.seenNames, ["HERNANDEZ CASTRO, ADRIAN"]), "selectTargetRows: seenNames como APELLIDOS, NOMBRE sin repetir (sugerencias para la app)");
  const selB = selectTargetRows(rowsW, { nombre: "ADRIAN HERNADNEZ CASTRO", edad: "36" }, { today: hoy });
  assert(deepEq(selB.targetIdxs, [1]) && selB.ageRejected.length === 1, "selectTargetRows: sin alias, HERNADNEZ≈HERNANDEZ elige al de 36 años y descarta al homónimo de nombre completo de 66 por edad");
  const selC = selectTargetRows(rowsW, { nombre: "JUAN LOPEZ LOPEZ", edad: "36" }, { today: hoy });
  assert(deepEq(selC.targetIdxs, []) && selC.matchedHeader === "" && selC.seenNames.length === 1, "selectTargetRows: sin match no hay objetivo pero sí nombres vistos");
  assert(normExp(" 26-00001 ") === "2600001" && normExp("2600001") === "2600001" && normExp(null) === "", "normExp: con guion, sin guion y vacío");
}

// ── Rescate por año de nacimiento mal capturado (15 oct 2026, cama 3-163) ─────────────────────
// El mismo paciente tenía en WinLab tres registros con el mismo nombre: 05/03/2006, 05/03/1968 y
// 05/03/2006 (censo 58 años). La guarda de edad descartaba los dos "de 20 años" y los labs de
// hospitalización (13-14 oct) nunca se drilleaban: la app solo mostraba los de urgencias del 12.
{
  const TODAY = new Date("2026-10-15T12:00:00");
  const hdr = (ap, no, fnac) => ({ __cells: ["", "", "", ap, no, "MASCULINO", fnac], __hasLink: false });
  const rep = (id) => ({ __cells: ["", "", id, "13/10/2026 06:19", "13/10/2026 09:31", "CIRUGIA GENERAL"], __hasLink: true });
  const paciente = { nombre: "JUAN PEREZ LOPEZ", edad: "58" };
  const rows = [
    hdr("PEREZ LOPEZ", "JUAN", "05/03/2006"), rep("1"), rep("2"),   // 20 años: año mal capturado
    hdr("PEREZ LOPEZ", "JUAN", "05/03/1968"), rep("3"),             // 58: el que pasa la guarda
    hdr("PEREZ LOPEZ", "JUAN", "05/03/2006"), rep("4"), rep("5"), rep("6"),
  ];
  const sel = selectTargetRows(rows, paciente, { ageTolerance: 2, today: TODAY });
  assert(deepEq(sel.targetIdxs, [1, 2, 4, 6, 7, 8]), "rescate: los tres bloques del mismo nombre y mismo día/mes de nacimiento son del paciente (año mal capturado)");
  assert(sel.ageRejected.length === 0 && sel.ageRescued.length === 2 && sel.ageRescued[0].headerAge === 20 && sel.ageRescued[0].twinAge === 58 && sel.ageRescued[0].fnac === "05/03/2006" && sel.ageRescued[0].twinFnac === "05/03/1968",
    "rescate: queda registrado (edad del bloque, edad del gemelo aceptado, fechas) y no cuenta como rechazado");
  assert(sel.matchedHeader === "PEREZ LOPEZ JUAN", "rescate: matchedHeader sigue siendo el nombre del encabezado");
  // Homónimo real: mismo nombre pero OTRO día/mes de nacimiento → sigue descartado por edad.
  const selH = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "19/06/2004"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "05/03/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selH.targetIdxs, [3]) && selH.ageRejected.length === 1 && selH.ageRescued.length === 0, "rescate: otro día/mes de nacimiento = homónimo real → descartado");
  // 01/01 es comodín de fecha desconocida: dos registros 01/01 con años distintos NO se consideran la misma persona.
  const selP = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "01/01/2006"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "01/01/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selP.targetIdxs, [3]) && selP.ageRejected.length === 1, "rescate: 01/01 (fecha desconocida) no rescata");
  // Sin bloque aceptado no hay a quién parecerse: el censo dice 58 y WinLab solo trae registros de 20 → sin objetivo.
  const selN = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "05/03/2006"), rep("1")], paciente, { today: TODAY });
  assert(deepEq(selN.targetIdxs, []) && selN.ageRejected.length === 1 && selN.ageRescued.length === 0, "rescate: sin bloque aceptado del mismo nombre no se rescata nada");
  // La etiqueta debe ser idéntica: otra forma de escribir el nombre (aunque matchee difuso) no rescata.
  const selL = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN CARLOS", "05/03/2006"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "05/03/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selL.targetIdxs, [3]) && selL.ageRejected.length === 1, "rescate: nombre escrito distinto (JUAN CARLOS) no rescata");
  assert(sameBirthdayOtherYear("05/03/2006", "05/03/1968") === true && sameBirthdayOtherYear("05/03/2006", "05/03/2006") === false && sameBirthdayOtherYear("01/01/2006", "01/01/1968") === false && sameBirthdayOtherYear("x", "05/03/1968") === false,
    "sameBirthdayOtherYear: mismo día/mes y otro año; misma fecha, 01/01 o basura → false");
  // El caso #386 (01/01/2010 vs 01/01/1946) sigue descartando al joven (arriba) y sin edad en el censo todo sigue igual.
  const selS = selectTargetRows(rows, { nombre: "JUAN PEREZ LOPEZ", edad: "" }, { today: TODAY });
  assert(deepEq(selS.targetIdxs, [1, 2, 4, 6, 7, 8]) && selS.ageRescued.length === 0, "rescate: sin edad en el censo no interviene (todos por nombre, como antes)");
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
