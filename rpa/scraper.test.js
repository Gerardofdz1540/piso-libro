// Test offline de la logica pura del scraper.
// Corre con: `node rpa/scraper.test.js` — no usa red ni Playwright.

import {
  dedupRecords, isAllowedEsp, formatDate,
  isMenuTableText, isFormTableText, isNoResultsText, isIrrelevantTable,
  isMeaningfulReportRow, extractApellidos, expVariants,
  stripAccentsKeepEnie, buildSearchCandidates, buildSearchCandidatesWithAlias, normExp,
  jaroWinkler, patientHeaderMatches,
  extractHeaderBirthDate, extractHeaderName, ageFromBirthDate, parseCensusAge, selectTargetRows, sameBirthdayOtherYear, possiblySameWinlabPerson,
  todayISO, reportKey, indexParsedReportes, mergeReportesPreservingValores,
  normNameTokens, expandNomeAbbrev,
  isGarbageCell, looksLikeReportLinkRow, patientHeaderMatchKind,
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
  // Caso real anonimizado (nombre ficticio) RUBEN SOLIS NOVELO: 37 días, sin labs con apellidos exactos → typo en materno.
  // Último recurso: paterno-solo + nombre de pila (el match difuso confirma NOVELO≈NOBELO).
  const c = buildSearchCandidates("RUBEN SOLIS NOVELO");
  assert(c[0].cognome === "SOLIS NOVELO" && !c[0].nome, "cand: primaria apellidos");
  assert(c.some((x) => x.cognome === "SOLIS" && x.nome === "RUBEN"), "cand: retry paterno-solo + nombre");
  // paterno-solo y materno-solo van AL FINAL (último recurso, búsquedas más anchas), en ese orden
  assert(c[c.length - 2].tag === "paterno-solo + nombre" && c[c.length - 1].tag === "materno-solo + nombre" && c[c.length - 1].cognome === "NOVELO" && c[c.length - 1].nome === "RUBEN", "cand: paterno-solo y materno-solo son los últimos");
}
{
  // El match difuso de encabezado reconoce el typo V/B en el materno.
  assert(jaroWinkler("NOVELO", "NOBELO") >= 0.88, "match: NOVELO≈NOBELO Jaro-Winkler ≥0.88");
  assert(patientHeaderMatches("SOLIS NOBELO RUBEN", "RUBEN SOLIS NOVELO") === true,
    "match: header con materno mal escrito aún identifica al objetivo");
  assert(patientHeaderMatches("SOLIS HERNANDEZ PEDRO", "RUBEN SOLIS NOVELO") === false,
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
{
  // Caso cama 3-160 (oct 2026, corrida #441): hoja con APELLIDOS primero y nombre de pila que WinLab
  // guarda distinto ("MA DEL ROSARIO"): el invertido CON nome dio NINGÚN REGISTRO. Además del invertido
  // con nome debe existir el invertido con apellidos SOLOS (sin filtro de nombre), después de aquel.
  const c = buildSearchCandidates("SOTO MEDINA MARIA DEL ROSARIO");
  const iNome = c.findIndex((x) => x.cognome === "SOTO MEDINA" && x.nome === "MARIA DEL ROSARIO");
  const iSolo = c.findIndex((x) => x.cognome === "SOTO MEDINA" && !x.nome);
  assert(iNome >= 0 && iSolo >= 0 && iSolo === iNome + 1, "cand: invertido apellidos-primero con nome y, justo después, invertido apellidos SOLOS");
  assert(c[iSolo].tag === "invertido apellidos solos", "cand: etiqueta 'invertido apellidos solos'");
  assert(c[c.length - 1].tag === "materno-solo + nombre", "cand: paterno/materno-solo siguen siendo los últimos");
  assert(c.length <= 7, "cand: la escalera de 5 palabras cabe en los 7 intentos del scraper");
  // Con Ñ (una variante más) tampoco se pasa de 7, para que materno-solo no quede fuera.
  assert(buildSearchCandidates("PEÑA LOYOLA MARIA DEL ROSARIO").length <= 7, "cand: 5 palabras + Ñ ≤ 7 candidatos");
  // El encabezado real que lista WinLab ("SOTO MEDINA, MA DEL ROSARIO") identifica al objetivo del censo
  // invertido (MA→MARIA, orden libre, DEL ignorado) y un homónimo de apellidos no.
  assert(patientHeaderMatches("SOTO MEDINA MA DEL ROSARIO", "SOTO MEDINA MARIA DEL ROSARIO") === true, "match: encabezado con MA. identifica al censo invertido");
  assert(patientHeaderMatches("SOTO MEDINA ROSARIO", "SOTO MEDINA MARIA DEL ROSARIO") === true, "match: WinLab con un solo nombre de pila (3 tokens ⊆ censo) identifica");
  assert(patientHeaderMatches("SOTO MEDINA MARIA JOSE", "SOTO MEDINA MARIA DEL ROSARIO") === false, "match: otro nombre de pila (JOSE) sigue siendo otra persona");
  // Nombre con abreviatura al inicio: el orden es evidente y NO se agrega el invertido solos.
  assert(!buildSearchCandidates("MA GUADALUPE RIOS PEREZ").some((x) => x.tag === "invertido apellidos solos"), "cand: con nombre abreviado al inicio no hay invertido solos");
  // Nombre normal de 4 palabras: el invertido solos existe pero va DESPUÉS de la primaria (no cambia el orden útil).
  const n = buildSearchCandidates("AGUSTIN JAIME MENDOZA GONZALEZ");
  assert(n[0].cognome === "MENDOZA GONZALEZ" && n.findIndex((x) => x.tag === "invertido apellidos solos") > 0, "cand: 4 palabras normales: primaria primero, invertido solos después");
}
{
  // Menú/formulario de WinLab en italiano con las palabras pegadas (blobs del 11-12 oct 2026).
  for (const s of ["ELENCOREFERTI", "ELENCO REFERTI", "CERCAREFERTI", "TUTTE ENTITA UTENTE", "TUTTE LE UNITÀ", "HOME REFERTI HELP CHIUDI", "HELP"])
    assert(isGarbageCell(s) === true, `garbage IT: "${s}" es menú/formulario`);
  for (const s of ["REFERTO EMOCROMO", "UNITA DI TERAPIA INTENSIVA", "HOMERO LOPEZ", "TUTTI I RISULTATI"])
    assert(isGarbageCell(s) === false, `garbage IT: "${s}" NO es basura`);
  assert(isMeaningfulReportRow({ __cells: ["HOME REFERTI HELP CHIUDI"], __hasLink: true }) === false, "fila de menú IT de una celda con enlace no es reporte");
  assert(isMeaningfulReportRow({ __cells: Array(16).fill("ELENCOREFERTI TUTTE ENTITA UTENTE"), __hasLink: true }) === false, "fila de formulario IT repetida en 16 celdas no es reporte");
}

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
  const paciente = { nombre: "MARIA ELISA HERNANDEZ", edad: "49" };
  const sel = selectTargetRows([hdrIt("HERNANDEZ", "MA ELISA", "Femminile", "12/06/1977"), repIt("1"), hdrIt("HERNANDEZ", "PEDRO", "Maschile", "01/01/1950"), repIt("2")], paciente, { today: TODAY });
  assert(deepEq(sel.targetIdxs, [1]), "IT: encabezado con Femminile/Maschile se reconoce (targeting igual que en español)");
  const selF = selectTargetRows([hdrIt("HERNANDEZ", "MA ELISA", "F", "12/06/1977"), repIt("1")], paciente, { today: TODAY });
  assert(deepEq(selF.targetIdxs, [1]), "IT: sexo abreviado F/M también se reconoce");
  const selX = selectTargetRows([hdrIt("HERNANDEZ", "MA ELISA", "Weiblich", "12/06/1977"), repIt("1")], paciente, { today: TODAY });
  assert(deepEq(selX.targetIdxs, [1]), "idioma desconocido: la fila-encabezado se reconoce por su forma (nombre, nombre, sexo corto, fecha de nacimiento)");
  assert(extractHeaderBirthDate(["", "", "", "HERNANDEZ", "MA ELISA", "Femminile", "12/06/1977"]) === "12/06/1977", "IT: fecha de nacimiento tras la celda de sexo");
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
  const c3 = buildSearchCandidates("MA. ELISA HERNANDEZ");
  assert(c3[0].cognome === "HERNANDEZ" && c3[0].nome === "MARIA ELISA" && c3[1].sibling && c3[1].nome === "MA ELISA", "cand MA. ELISA: expandida y luego literal como sibling");
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
  assert(deepEq(sel.targetIdxs, [1, 2, 4, 6, 7, 8]), "mismo paciente: los 3 bloques del mismo nombre y mismo día/mes de nacimiento (año mal escrito) son del paciente");
  assert(sel.ageRejected.length === 0, "mismo paciente: la edad no descarta ningún bloque");
  assert(sel.matchedHeader === "PEREZ LOPEZ JUAN", "matchedHeader sigue siendo el nombre del encabezado");
  // UN SOLO registro con el nombre exacto: aunque la edad no cuadre, NO se tira el único match (#434: 3-168).
  const selN = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "05/03/2006"), rep("1")], paciente, { today: TODAY });
  assert(deepEq(selN.targetIdxs, [1]) && selN.ageRejected.length === 0, "un solo registro con el nombre: se acepta aunque la edad (20) no cuadre con el censo (58)");
  // DOS personas DISTINTAS con el mismo nombre completo (homónimos reales) → la edad elige (#386).
  const selH = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "19/06/2004"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "05/03/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selH.targetIdxs, [3]) && selH.ageRejected.length === 1, "homónimo real (otro día/mes de nacimiento): la edad descarta al que no es");
  // 01/01 es comodín: dos registros 01/01 de años distintos son posibles homónimos → la edad decide.
  const selP = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN", "01/01/2006"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "01/01/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selP.targetIdxs, [3]) && selP.ageRejected.length === 1, "01/01 (fecha desconocida) no une a dos registros → homónimos, la edad decide");
  // El homónimo que NO coincide por nombre completo no es competidor: el único que sí coincide se acepta
  // aunque su edad no cuadre (#434: 3-181, "MUÑOZ GUTIERREZ MA GUILLERMINA" vs "… PAOLA ISABEL").
  const selU = selectTargetRows([hdr("MUNOZ GUTIERREZ", "MA GUILLERMINA", "05/03/2006"), rep("1"), hdr("MUNOZ GUTIERREZ", "PAOLA ISABEL", "05/03/1990"), rep("2")], { nombre: "MARIA GUILLERMINA MUÑOZ GUTIERREZ", edad: "58" }, { today: TODAY });
  assert(deepEq(selU.targetIdxs, [1]) && selU.ageRejected.length === 0, "solo un nombre coincide (el otro es otra persona): se acepta aunque la edad no cuadre");
  // Nombre escrito distinto (JUAN CARLOS vs JUAN) → son posibles personas distintas → la edad decide.
  const selL = selectTargetRows([hdr("PEREZ LOPEZ", "JUAN CARLOS", "05/03/2006"), rep("1"), hdr("PEREZ LOPEZ", "JUAN", "05/03/1968"), rep("2")], paciente, { today: TODAY });
  assert(deepEq(selL.targetIdxs, [3]) && selL.ageRejected.length === 1, "nombre escrito distinto (JUAN CARLOS) → la edad decide, se queda el de 58");
  assert(sameBirthdayOtherYear("05/03/2006", "05/03/1968") === true && sameBirthdayOtherYear("05/03/2006", "05/03/2006") === false && sameBirthdayOtherYear("01/01/2006", "01/01/1968") === false && sameBirthdayOtherYear("x", "05/03/1968") === false,
    "sameBirthdayOtherYear: mismo día/mes y otro año; misma fecha, 01/01 o basura → false");
  assert(possiblySameWinlabPerson({ label: "PEREZ LOPEZ, JUAN", fnac: "05/03/2006" }, { label: "PEREZ LOPEZ, JUAN", fnac: "05/03/1968" }) === true
    && possiblySameWinlabPerson({ label: "PEREZ LOPEZ, JUAN", fnac: "05/03/2006" }, { label: "PEREZ LOPEZ, JUAN CARLOS", fnac: "05/03/1968" }) === false
    && possiblySameWinlabPerson({ label: "A, B", fnac: "19/06/2004" }, { label: "A, B", fnac: "05/03/1968" }) === false
    && possiblySameWinlabPerson({ label: "A, B", fnac: "" }, { label: "A, B", fnac: "05/03/1968" }) === true,
    "possiblySameWinlabPerson: mismo nombre + año distinto = sí; nombre distinto = no; día/mes distinto = no; sin fecha = sí");
  // Sin edad en el censo no interviene (todos por nombre, como antes).
  const selS = selectTargetRows(rows, { nombre: "JUAN PEREZ LOPEZ", edad: "" }, { today: TODAY });
  assert(deepEq(selS.targetIdxs, [1, 2, 4, 6, 7, 8]), "sin edad en el censo: todos los bloques del nombre (como antes)");
}

// ── Cotejo simétrico: censo con TRES nombres de pila y WinLab con dos (16 oct 2026, cama 3-162) ──
// El censo trae tres nombres de pila (p.ej. "JUAN PABLO ANDRES SOTO MEDINA") y WinLab lista solo dos
// ("SOTO MEDINA, JUAN PABLO"): el tercer nombre no está en el encabezado y el paciente caía en
// "homónimos" sin labs (solo funcionaba con alias puesto a mano). Nombres inventados.
{
  assert(patientHeaderMatches("SOTO MEDINA JUAN PABLO", "JUAN PABLO ANDRES SOTO MEDINA") === true,
    "match 3 nombres: encabezado con 2 nombres ⊆ censo con 3 → true");
  assert(patientHeaderMatches("SOTO MEDINA, JUAN PABLO", "JUAN PABLO ANDRES SOTO MEDINA") === true,
    "match 3 nombres: también en formato APELLIDOS, NOMBRE (coma) → true");
  assert(patientHeaderMatches("GARCIA RUIZ ANA", "ANA MARIA GARCIA RUIZ") === true,
    "match 3 nombres: GARCIA RUIZ ANA ⊆ ANA MARIA GARCIA RUIZ → true");
  assert(patientHeaderMatches("PEREZ LOPEZ JUAN", "PEDRO PEREZ LOPEZ") === false,
    "match 3 nombres: nombre de pila distinto (JUAN vs PEDRO) sigue siendo otra persona → false");
  assert(patientHeaderMatches("SOTO MEDINA PEDRO", "JUAN PABLO ANDRES SOTO MEDINA") === false,
    "match 3 nombres: mismos apellidos pero otro nombre de pila → false");
  assert(patientHeaderMatches("LOPEZ JUAN", "JUAN CARLOS LOPEZ RUIZ") === false,
    "match 3 nombres: encabezado de solo 2 tokens NO usa la regla nueva (le falta un apellido) → false");
  assert(patientHeaderMatches("LOPEZ JUAN", "JUAN LOPEZ") === true,
    "match 3 nombres: la regla original (censo ⊆ encabezado) sigue intacta con 2 tokens");
  // La precisión por token no cambia con la regla nueva.
  assert(patientHeaderMatches("GARCIA RUIZ ANTONIA", "ANTONIO MANUEL GARCIA RUIZ") === false,
    "match 3 nombres: variante de género ANTONIA/ANTONIO tampoco pasa por la regla nueva → false");
  assert(patientHeaderMatches("RAMIREZ SOTO ESEQUIEL", "EZEQUIEL JOSE RAMIREZ SOTO") === true,
    "match 3 nombres: typo ESEQUIEL≈EZEQUIEL (Jaro-Winkler, tokens ≥5) tolerado también en la regla nueva");
  assert(patientHeaderMatches("GARCIA LOPEZ ANTONIA", "ANTONIO GARCIA LOPEZ") === false
    && patientHeaderMatches("HERNANDEZ RUIZ MARIO", "MARIA HERNANDEZ RUIZ") === false
    && patientHeaderMatches("SOLIS NOBELO RUBEN", "RUBEN SOLIS NOVELO") === true
    && patientHeaderMatches("SOLIS HERNANDEZ PEDRO", "RUBEN SOLIS NOVELO") === false,
    "match 3 nombres: los casos previos de género/typo/homónimo no cambian");
  assert(patientHeaderMatches("", "JUAN PEREZ") === false && patientHeaderMatches("PEREZ JUAN", "") === false,
    "match 3 nombres: vacío → false");

  // De punta a punta: encabezado de WinLab con 2 nombres, censo con 3 → ahora sí hay objetivo.
  const TODAY = new Date("2026-10-16T12:00:00");
  const rows = [
    { __cells: ["", "", "", "SOTO MEDINA", "JUAN PABLO", "Masculino", "12/05/1960"], __hasLink: false },
    { __cells: ["", "", "2610151234", "15/10/2026 06:20", "15/10/2026 09:02", "CIRUGIA GENERAL"], __hasLink: true },
    { __cells: ["", "", "2610161235", "16/10/2026 06:11", "16/10/2026 08:40", "CIRUGIA GENERAL"], __hasLink: true },
    { __cells: ["", "", "", "SOTO MEDINA", "PEDRO", "Masculino", "01/01/1980"], __hasLink: false },      // otro paciente
    { __cells: ["", "", "2610161236", "16/10/2026 07:00", "16/10/2026 09:30", "URGENCIAS"], __hasLink: true },
  ];
  const sel = selectTargetRows(rows, { nombre: "JUAN PABLO ANDRES SOTO MEDINA", edad: "66" }, { today: TODAY });
  assert(deepEq(sel.targetIdxs, [1, 2]) && sel.matchedHeader === "SOTO MEDINA JUAN PABLO",
    "selectTargetRows 3 nombres: el bloque con 2 nombres es el objetivo sin alias; el otro apellido-homónimo no");
  assert(deepEq(sel.seenNames, ["SOTO MEDINA, JUAN PABLO", "SOTO MEDINA, PEDRO"]), "selectTargetRows 3 nombres: seenNames lista ambos encabezados");
  assert(sel.ageRejected.length === 0, "selectTargetRows 3 nombres: la edad del único match (66) cuadra, nada rechazado");
}

// ── Cautela con la coincidencia PARCIAL (revisión 16 oct 2026) ───────────────────────────────
// "SOTO MEDINA, JUAN PABLO" ⊆ "JUAN PABLO ANDRES SOTO MEDINA" también puede ser OTRA persona. Por eso la
// coincidencia parcial (regla b) NO goza de la excepción de registro único (#434: si la edad no cuadra se
// descarta aunque sea el único bloque) y NO compite con un bloque que coincide por nombre completo.
{
  assert(patientHeaderMatchKind("SOTO MEDINA JUAN PABLO ANDRES", "JUAN PABLO ANDRES SOTO MEDINA") === "full", "matchKind: nombre completo → full");
  assert(patientHeaderMatchKind("SOTO MEDINA JUAN PABLO", "JUAN PABLO ANDRES SOTO MEDINA") === "partial", "matchKind: encabezado ⊆ censo (le falta un nombre) → partial");
  assert(patientHeaderMatchKind("SOTO MEDINA PEDRO", "JUAN PABLO ANDRES SOTO MEDINA") === "" && patientHeaderMatchKind("", "JUAN PEREZ") === "", "matchKind: otra persona / vacío → ''");
  assert(patientHeaderMatchKind("LOPEZ JUAN", "JUAN LOPEZ RUIZ") === "", "matchKind: encabezado de 2 tokens no usa la regla parcial");
  assert(patientHeaderMatchKind("HERNANDEZ CASTRO ADRIAN", "ADRIAN HERNADNEZ CASTRO") === "full", "matchKind: difuso (letras invertidas) sigue siendo full");
  assert([["SOTO MEDINA JUAN PABLO", "JUAN PABLO ANDRES SOTO MEDINA"], ["SOTO MEDINA PEDRO", "JUAN PABLO ANDRES SOTO MEDINA"], ["LOPEZ JUAN", "JUAN LOPEZ"], ["LOPEZ JUAN", "JUAN LOPEZ RUIZ"]]
    .every(([h, t]) => patientHeaderMatches(h, t) === (patientHeaderMatchKind(h, t) !== "")), "patientHeaderMatches equivale a matchKind !== ''");

  const TODAY = new Date("2026-10-16T12:00:00");
  const hdr = (ap, no, fnac) => ({ __cells: ["", "", "", ap, no, "Masculino", fnac], __hasLink: false });
  const rep = (id) => ({ __cells: ["", "", id, "15/10/2026 06:20", "15/10/2026 09:02", "CIRUGIA GENERAL"], __hasLink: true });
  const pac = { nombre: "JUAN PABLO ANDRES SOTO MEDINA", edad: "66" };
  // Único bloque, parcial, edad que cuadra → objetivo (caso real de la cama 3-162), marcado partialMatch.
  const s1 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/1960"), rep("2610151234")], pac, { today: TODAY });
  assert(deepEq(s1.targetIdxs, [1]) && s1.partialMatch === true && s1.ageRejected.length === 0, "parcial: único bloque con edad compatible → objetivo (partialMatch=true)");
  // Único bloque, parcial, edad que NO cuadra → se descarta: puede ser otra persona (sin excepción #434).
  const s2 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/2001"), rep("2610151234")], pac, { today: TODAY });
  assert(deepEq(s2.targetIdxs, []) && s2.ageRejected.length === 1 && s2.ageRejected[0].headerAge === 25 && s2.partialMatch === false && s2.matchedHeader === "",
    "parcial: único bloque con edad 25 vs censo 66 → descartado (la excepción de registro único NO aplica a la parcial)");
  // Mismo caso con nombre COMPLETO: la excepción #434 sigue igual (comportamiento previo intacto).
  const s3 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO ANDRES", "12/05/2001"), rep("2610151234")], pac, { today: TODAY });
  assert(deepEq(s3.targetIdxs, [1]) && s3.partialMatch === false, "completo: único registro con nombre completo se acepta aunque la edad no cuadre (#434, como antes)");
  // Edad del censo desconocida (vacía/meses) o sin fecha de nacimiento en WinLab → la parcial se acepta (no hay con qué contrastar).
  const s4 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/2001"), rep("1")], { nombre: pac.nombre, edad: "" }, { today: TODAY });
  const s4m = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/2001"), rep("1")], { nombre: pac.nombre, edad: "3m" }, { today: TODAY });
  const s5 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", ""), rep("1")], pac, { today: TODAY });
  assert(deepEq(s4.targetIdxs, [1]) && deepEq(s4m.targetIdxs, [1]) && deepEq(s5.targetIdxs, [1]) && s4.partialMatch && s5.partialMatch,
    "parcial: sin edad del censo (vacía o en meses) o sin fecha de nacimiento en WinLab → se acepta");
  // Bloque COMPLETO + bloque PARCIAL: el parcial no compite. Aunque la edad del completo no cuadre (año mal
  // capturado) y la del parcial sí, el objetivo es el completo — exactamente lo que pasaba antes de la regla b.
  const s6 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO ANDRES", "12/05/2001"), rep("1"), hdr("SOTO MEDINA", "JUAN PABLO", "12/05/1960"), rep("2")], pac, { today: TODAY });
  assert(deepEq(s6.targetIdxs, [1]) && s6.ageRejected.length === 0 && s6.matchedHeader === "SOTO MEDINA JUAN PABLO ANDRES" && s6.partialMatch === false,
    "completo + parcial: el parcial no compite ni como homónimo; el completo se acepta como registro único (igual que antes)");
  const s7 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO ANDRES", "12/05/1960"), rep("1"), hdr("SOTO MEDINA", "JUAN PABLO", "12/05/1960"), rep("2")], pac, { today: TODAY });
  assert(deepEq(s7.targetIdxs, [1]) && deepEq(s7.seenNames, ["SOTO MEDINA, JUAN PABLO ANDRES", "SOTO MEDINA, JUAN PABLO"]),
    "completo + parcial con la misma edad: solo los reportes del completo; seenNames lista ambos");
  // Dos bloques PARCIALES con distinta fecha de nacimiento (dos personas posibles): la edad elige.
  const s8 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "19/06/2001"), rep("1"), hdr("SOTO MEDINA", "JUAN PABLO", "12/05/1960"), rep("2")], pac, { today: TODAY });
  assert(deepEq(s8.targetIdxs, [3]) && s8.ageRejected.length === 1 && s8.partialMatch === true, "dos parciales (otro día/mes): la edad elige al de 66");
  // Dos parciales con el mismo día/mes y otro año = mismo paciente con el año mal escrito → rescate (como con nombre completo).
  const s8b = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/2001"), rep("1"), hdr("SOTO MEDINA", "JUAN PABLO", "12/05/1960"), rep("2")], pac, { today: TODAY });
  assert(deepEq(s8b.targetIdxs, [1, 3]) && s8b.ageRescued.length === 1 && s8b.ageRejected.length === 0, "dos parciales con mismo día/mes: el del año mal capturado se rescata");
  // Alias = nombre que lista WinLab → coincidencia COMPLETA: conserva la excepción #434 (vía manual intacta).
  const s9 = selectTargetRows([hdr("SOTO MEDINA", "JUAN PABLO", "12/05/2001"), rep("1")], { ...pac, alias: "SOTO MEDINA, JUAN PABLO" }, { today: TODAY });
  assert(deepEq(s9.targetIdxs, [1]) && s9.partialMatch === false, "alias con el nombre de WinLab: coincidencia completa, se acepta aunque la edad no cuadre");
}

// ── Paginación de WinLab colada como reporte (16 oct 2026, cama 3-154) ───────────────────────
// La tabla de resultados termina con ["Elementos Encontrados : 20", "", "Inicio Página"] y
// ["", "", "", "INICIO PAGINA"], ambas con enlaces de paginación. Pasaban isMeaningfulReportRow,
// caían bajo el bloque del paciente y se drilleaban en vano (0 valores, cupo gastado).
{
  // isGarbageCell: formas reales (normaliza acento/mayúsculas/espacios)
  for (const c of ["Inicio Página", "INICIO PAGINA", "Fin Página", "FIN DE PAGINA", "Elementos Encontrados : 20", "ELEMENTOS ENCONTRADOS: 3",
                   "Selecciona Todo", "Página 2", "PAGINA 1 DE 3", "Inizio Pagina", "Fine Pagina", "Elementi trovati : 5", "Seleziona tutto", "  Inicio   Página  ",
                   // formas reales guardadas en los blobs (IT con palabras pegadas)
                   "RECORDTROVATI : 4", "SELEZIONATUTTO", "PAGINA 1 DI 2", "ELEMENTOSENCONTRADOS : 7"])
    assert(isGarbageCell(c) === true, `isGarbageCell: "${c}" es paginación → true`);
  for (const c of ["BIOMETRIA HEMATICA", "14/10/2026 09:07", "2610141380", "CIRUGIA GENERAL", "INICIO DE TRATAMIENTO", "PAGINADOR", "", null, 20])
    assert(isGarbageCell(c) === false, `isGarbageCell: "${c}" no es basura → false`);

  // isMeaningfulReportRow: las filas de paginación reales → false; un reporte real → true
  assert(isMeaningfulReportRow({ COL_0: "Elementos Encontrados : 20", COL_1: "", COL_2: "Inicio Página", __cells: ["Elementos Encontrados : 20", "", "Inicio Página"], __hasLink: true, __rowIdxInTable: 21 }) === false,
    "meaningful: fila 'Elementos Encontrados : 20' / 'Inicio Página' (headers COL_X) → false");
  assert(isMeaningfulReportRow({ COL_3: "INICIO PAGINA", __cells: ["", "", "", "INICIO PAGINA"], __hasLink: true, __rowIdxInTable: 22 }) === false,
    "meaningful: fila ['', '', '', 'INICIO PAGINA'] → false");
  assert(isMeaningfulReportRow({ PACIENTE: "Elementos Encontrados : 20", FECHA: "Inicio Página", __cells: ["Elementos Encontrados : 20", "", "Inicio Página"], __hasLink: true }) === false,
    "meaningful: paginación bajo headers REALES (no COL_X) tampoco cuenta como dato");
  assert(isMeaningfulReportRow({ __cells: ["Fin de Página", "Selecciona Todo", "Página 1 de 3"], __hasLink: true }) === false,
    "meaningful: FIN DE PAGINA / SELECCIONA TODO / PAGINA N → false");
  // Formas reales de los blobs (9-15 oct 2026): pie en español con 2 páginas y pie en italiano (palabras pegadas).
  assert(isMeaningfulReportRow({ __cells: ["", "ELEMENTOS ENCONTRADOS : 26", "PAGINA 1 DE 2", "INICIO PAGINA"], __hasLink: true }) === false,
    "meaningful: pie real ES con 'PAGINA 1 DE 2' → false");
  assert(isMeaningfulReportRow({ __cells: ["SELEZIONATUTTO", "RECORDTROVATI : 4", "", "FINE PAGINA"], __hasLink: true }) === false
    && isMeaningfulReportRow({ __cells: ["", "RECORDTROVATI : 36", "PAGINA 1 DI 2", "INIZIO PAGINA"], __hasLink: true }) === false,
    "meaningful: pie real IT (SELEZIONATUTTO / RECORDTROVATI / FINE-INIZIO PAGINA / PAGINA 1 DI 2) → false");
  assert(isMeaningfulReportRow({ __cells: ["", "", "2610141380", "14/10/2026 09:07", "14/10/2026 10:51", "CIRUGIA"], __hasLink: true }) === true,
    "meaningful: reporte real (barcode + fechas-hora) → true");
  assert(isMeaningfulReportRow({ __cells: ["", "", "", "PEREZ LOPEZ", "JUAN", "MASCULINO", "01/01/1946"], __hasLink: false }) === true,
    "meaningful: fila-encabezado de paciente sigue siendo significativa");
  assert(isMeaningfulReportRow({ COL_0: "BIOMETRIA HEMATICA", COL_1: "25/04/2026", __cells: ["BIOMETRIA HEMATICA", "25/04/2026"] }) === true
    && isMeaningfulReportRow({ __cells: ["LISTA REPORTES TODAS LAS UNIDADES", "INICIO", "REPORTES"], COL_0: "x" }) === false,
    "meaningful: los casos previos (data real / menú ES) no cambian");

  // looksLikeReportLinkRow directo
  assert(looksLikeReportLinkRow(["", "", "2610141380", "14/10/2026 09:07", "14/10/2026 10:51", "CIRUGIA"]) === true, "reportLinkRow: barcode + fecha-hora → true");
  assert(looksLikeReportLinkRow(["", "1", "08/10/2026 06:16", "08/10/2026 06:34", "08/10/2026 12:56", ""]) === true, "reportLinkRow: solo fecha-hora (sin barcode largo) → true");
  assert(looksLikeReportLinkRow(["", "", "2610141380", "", "", "CIRUGIA"]) === true, "reportLinkRow: solo barcode ≥8 dígitos → true");
  assert(looksLikeReportLinkRow(["Elementos Encontrados : 20", "", "Inicio Página"]) === false, "reportLinkRow: paginación 'Elementos Encontrados' → false");
  assert(looksLikeReportLinkRow(["", "", "", "INICIO PAGINA"]) === false, "reportLinkRow: paginación 'INICIO PAGINA' → false");
  assert(looksLikeReportLinkRow(["1", "2", "3", "Siguiente"]) === false, "reportLinkRow: números de página → false");
  assert(looksLikeReportLinkRow(["25/04/2026", "BIOMETRIA"]) === false, "reportLinkRow: fecha sin hora ni barcode → false (no es fila de reporte de WinLab)");
  assert(looksLikeReportLinkRow([]) === false && looksLikeReportLinkRow(null) === false && looksLikeReportLinkRow(undefined) === false, "reportLinkRow: vacío/null → false");

  // selectTargetRows: bloque del paciente seguido de 2 filas de paginación con __hasLink → solo el reporte real
  const TODAY = new Date("2026-10-16T12:00:00");
  const rows = [
    { __cells: ["", "", "", "PEREZ LOPEZ", "JUAN", "Masculino", "03/01/1990"], __hasLink: false },
    { __cells: ["", "", "2610151380", "15/10/2026 09:07", "15/10/2026 10:51", "CIRUGIA"], __hasLink: true },
    { COL_0: "Elementos Encontrados : 20", COL_2: "Inicio Página", __cells: ["Elementos Encontrados : 20", "", "Inicio Página"], __hasLink: true },
    { COL_3: "INICIO PAGINA", __cells: ["", "", "", "INICIO PAGINA"], __hasLink: true },
  ];
  const sel = selectTargetRows(rows, { nombre: "JUAN PEREZ LOPEZ", edad: "36" }, { today: TODAY });
  assert(deepEq(sel.targetIdxs, [1]), "selectTargetRows paginación: targetIdxs solo trae el reporte real");
  assert(deepEq(sel.linkIdxs, [1]), "selectTargetRows paginación: las filas de paginación tampoco cuentan como enlaces (diagnóstico)");
  assert(sel.matchedHeader === "PEREZ LOPEZ JUAN", "selectTargetRows paginación: el encabezado del paciente se sigue reconociendo");
  // Y en la práctica el scraper filtra antes con isMeaningfulReportRow: el mismo resultado.
  const filtered = rows.filter(isMeaningfulReportRow);
  assert(filtered.length === 2 && deepEq(selectTargetRows(filtered, { nombre: "JUAN PEREZ LOPEZ", edad: "36" }, { today: TODAY }).targetIdxs, [1]),
    "selectTargetRows paginación: tras el filtro isMeaningfulReportRow quedan encabezado + reporte, objetivo = [1]");
  // Reportes reales de distintos formatos (ES e IT) nunca se descartan por la capa (b).
  const selIt = selectTargetRows([
    { __cells: ["", "", "", "HERNANDEZ", "MA ELISA", "Femminile", "12/06/1977"], __hasLink: false },
    { __cells: ["", "", "1", "11/10/2026 07:15", "11/10/2026 10:31", "CHIRURGIA GENERALE"], __hasLink: true },
    { __cells: ["SELEZIONATUTTO", "RECORDTROVATI : 1", "", "FINE PAGINA"], __hasLink: true },
    { __cells: ["", "RECORDTROVATI : 1", "", "INIZIO PAGINA"], __hasLink: true },
  ], { nombre: "MARIA ELISA HERNANDEZ", edad: "49" }, { today: TODAY });
  assert(deepEq(selIt.targetIdxs, [1]) && deepEq(selIt.linkIdxs, [1]), "selectTargetRows paginación: reporte real en italiano (fecha-hora) sigue siendo objetivo; el pie IT no");
}

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
