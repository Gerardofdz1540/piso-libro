// Test OFFLINE del robot de imagen (ris-scraper.js): sin red, sin Supabase, sin Playwright.
// Corre con: `cd rpa && node ris.test.js`. Importa solo ris-lib.js (lógica pura); ris-scraper.js
// se revisa por su código fuente (guardas de regresión) porque ejecuta main() al cargarse.
// Todos los nombres son INVENTADOS.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  filterCenso, addDaysISO, oldestIngreso, buildWindows, rowToEstudio, estudioKey, dedupEstudios,
  risAgeYears, ageDiff, lev1, isGenderVariant, tokenSimilar, nameCoverage,
  scoreMatchByName, scoreMatch, ageCompat, matchCensoDetailed, matchCenso, resolveHomonyms, nearMisses,
  looksLikeLoginPage, isUsableReportText, buildHaveSet, classifyReporte, splitPayload,
  isUnknownColumnError, stripColumns, REPORTE_ESTADO, RIS_OPTIONAL_COLS,
} from "./ris-lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const scraperSrc = readFileSync(join(__dirname, "ris-scraper.js"), "utf8");

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else      { fail++; console.error(`✗ ${name}`); }
}
const est = (nombre, edad, tipoEdad = "Años", extra = {}) => ({ nombre, edad: String(edad), tipoEdad, fecha: "2026-10-10", hora: "10:00:00", modalidad: "CT", documento: "PAT1", linkReporte: null, linkImagen: null, links: [], ...extra });
const pac = (exp, nombre, edad, extra = {}) => ({ id: "id-" + exp, exp, nombre, edad: String(edad), cama: "3-" + exp, esp: "CG", es_mio: true, ...extra });

// ── (a) Censo elegible: TODO el censo, sin filtro por especialidad ni es_mio ────────────────
{
  const raw = [
    pac("101", "JUAN PEREZ LOPEZ", 50, { esp: "CG", es_mio: true }),
    pac("102", "MARIA RUIZ SOTO", 61, { esp: "NCX", es_mio: false }),
    pac("103", "PEDRO PABLO CASTILLO MORA", 44, { esp: "URO", es_mio: false }),
    pac("104", "ANA LAURA QUIROZ VEGA", 30, { esp: "CG/URO" }),
    pac("105", "LUIS RICO PRADO", 70, { esp: "CG / NCX" }),
    pac("106", "ROSA ELENA NAVA DUARTE", 38, { esp: "CT" }),
    pac("107", "HUGO SALAS IBARRA", 29, { esp: "CPR" }),
    pac("108", "ELENA MARQUEZ RIOS", 52, { esp: "CCR" }),
    pac("109", "OSCAR TREJO LEAL", 66, { esp: "CV" }),
    pac("110", "IRMA CANO BRAVO", 47, { esp: "" }),
    pac("111", "IRENE CANO BRAVO", 47, { esp: null }),
    { id: "x", exp: "", nombre: "SIN EXPEDIENTE PACIENTE", edad: "40", cama: "3-900", esp: "CG" },
    { id: "y", exp: "112", nombre: "   ", edad: "40", cama: "3-901", esp: "CG" },
    { id: "z", exp: "113", nombre: "DE LA", edad: "40", cama: "3-902", esp: "CG" }, // sin tokens útiles
  ];
  const { censo, skipped } = filterCenso(raw);
  assert(censo.length === 11, "filterCenso: entran los 11 pacientes con nombre+exp (CG, NCX, URO, CG/URO, CG / NCX, CT, CPR, CCR, CV, esp vacío, esp null)");
  assert(censo.some((p) => p.es_mio === false && p.esp === "NCX") && censo.some((p) => p.esp === "URO"), "filterCenso: es_mio=false (NCX/URO) NO se excluye");
  assert(skipped.length === 3 && skipped.some((s) => s.cama === "3-900" && /expediente/.test(s.motivo)) && skipped.filter((s) => /sin nombre/.test(s.motivo)).length === 2, "filterCenso: omite sin exp / sin nombre y dice por qué");
  assert(filterCenso(null).censo.length === 0 && filterCenso([null]).censo.length === 0, "filterCenso: tolera null");
}

// ── (d) Ventanas de fechas hasta el ingreso más antiguo ─────────────────────────────────────
{
  assert(addDaysISO("2026-10-16", -13) === "2026-10-03" && addDaysISO("2026-03-01", -1) === "2026-02-28" && addDaysISO("", 1) === "", "addDaysISO: resta días sin zona horaria");
  const w2 = buildWindows({ today: "2026-10-16", lookbackDays: 13 });
  assert(w2.length === 2 && w2[0].dateS === "2026-10-03" && w2[0].dateSS === "2026-10-16" && w2[1].dateS === "2026-09-19" && w2[1].dateSS === "2026-10-02", "buildWindows: sin ingreso → las 2 ventanas de siempre (hoy-13..hoy, hoy-27..hoy-14)");
  const w5 = buildWindows({ today: "2026-10-16", lookbackDays: 13, oldest: "2026-08-18" });
  assert(w5.length === 5 && w5[4].dateS === "2026-08-08" && w5[4].dateSS === "2026-08-21", "buildWindows: ingreso 59 días atrás → 5 ventanas contiguas hasta cubrirlo");
  for (let i = 1; i < w5.length; i++) assert(addDaysISO(w5[i].dateSS, 1) === w5[i - 1].dateS, `buildWindows: ventana ${i} contigua y sin traslape con la ${i - 1}`);
  assert(buildWindows({ today: "2026-10-16", oldest: "2025-01-01" }).length === 5, "buildWindows: tope maxWindows=5 aunque el ingreso sea de hace un año");
  assert(buildWindows({ today: "2026-10-16", oldest: "2025-01-01", maxWindows: 3 }).length === 3, "buildWindows: maxWindows configurable");
  assert(buildWindows({ today: "2026-10-16", oldest: "2026-10-15" }).length === 2, "buildWindows: ingreso reciente → no menos de minWindows (2)");
  assert(buildWindows({ today: "2026-10-16", oldest: "2026-09-10" }).length === 3, "buildWindows: ingreso hace 36 días → 3 ventanas");
  const censo = [pac("1", "A B C", 1, { ingreso: "2026-09-02" }), pac("2", "A B C", 1, { ingreso: null, created_at: "2026-08-20T10:00:00+00:00" }), pac("3", "A B C", 1, { ingreso: "basura" })];
  assert(oldestIngreso(censo) === "2026-08-20", "oldestIngreso: mínimo entre ingreso y created_at, ignora basura");
  assert(oldestIngreso([]) === null && oldestIngreso(null) === null, "oldestIngreso: sin datos → null");
}

// ── Fila de la tabla → estudio (encabezados reales del portal) ──────────────────────────────
{
  const hdr = ["", "", "Nombre del paciente", "Número de documento", "Edad", "Tipo Edad", "Fecha de llegada", "Hora de llegada", "Sede", "Estudios", "Modalidad", "Procedencia", "Caso crítico"];
  const row = { cells: ["", "", "PEREZ LOPEZ JUAN", "PAT77", "50", "Años", "2026-10-10", "10:00:00", "Hospital", "TAC ABDOMEN", "CT", "URGENCIAS", "Si"],
    links: [{ kind: "imagen", dataHref: "/viewer/view?studyUID=1.2.3" }, { kind: "reporte", href: "/rep/1" }] };
  const e = rowToEstudio(row, hdr);
  assert(e.nombre === "PEREZ LOPEZ JUAN" && e.documento === "PAT77" && e.edad === "50" && e.tipoEdad === "Años" && e.fecha === "2026-10-10" && e.hora === "10:00:00" && e.modalidad === "CT" && e.critico === true, "rowToEstudio: mapea columnas por encabezado");
  assert(e.linkReporte && e.linkReporte.href === "/rep/1" && e.linkImagen && /studyUID/.test(e.linkImagen.dataHref), "rowToEstudio: separa ícono de reporte e imagen");
  assert(rowToEstudio({ cells: [], links: [] }, hdr).linkReporte === null, "rowToEstudio: fila vacía no truena");
  assert(estudioKey(e) === "PAT77|2026-10-10|10:00:00|CT", "estudioKey = documento|fecha|hora|modalidad (clave del upsert)");
  const dup = dedupEstudios([e, { ...e }, { ...e, modalidad: "US" }]);
  assert(dup.length === 2, "dedupEstudios: el mismo estudio en dos ventanas se guarda una vez (evita 'affect row a second time')");
  const base = { documento: "D1", fecha: "2026-10-01", hora: "10:00:00", modalidad: "CT" };
  const mg = dedupEstudios([
    { ...base, estudios: "TAC ABDOMEN", critico: false, linkReporte: null, linkImagen: { kind: "imagen", href: "i1", html: "" }, links: [{ kind: "imagen", href: "i1", html: "" }] },
    { ...base, estudios: "TAC TORAX", critico: true, linkReporte: { kind: "reporte", href: "r1", html: "" }, linkImagen: null, links: [{ kind: "reporte", href: "r1", html: "" }, { kind: "imagen", href: "i1", html: "" }] },
    { ...base, estudios: "TAC ABDOMEN", links: [] },
  ]);
  assert(mg.length === 1 && mg[0].estudios === "TAC ABDOMEN | TAC TORAX" && mg[0].linkReporte && mg[0].linkReporte.href === "r1" && mg[0].linkImagen && mg[0].critico === true && mg[0].links.length === 2,
    "dedupEstudios: dos estudios DISTINTOS con la misma clave se fusionan (descripciones con ' | ', enlace de reporte/imagen y crítico conservados, enlaces sin repetir) en vez de perder el segundo");
  assert(dedupEstudios([{ ...base, estudios: "*" , links: [] }, { ...base, estudios: "RX TORAX", links: [] }])[0].estudios === "RX TORAX", "dedupEstudios: la descripción '*' no se arrastra en la fusión");
}

// ── Edad ──────────────────────────────────────────────────────────────────────────────────────
{
  assert(risAgeYears(est("X", 50, "Años")) === 50 && risAgeYears(est("X", 50, "AÑOS")) === 50 && risAgeYears(est("X", 7, "Anos")) === 7, "risAgeYears: Años → n");
  assert(risAgeYears(est("X", 4, "Días")) === 0 && risAgeYears(est("X", 8, "Meses")) === 0, "risAgeYears: Días/Meses → 0 (menor de un año)");
  assert(risAgeYears(est("X", "", "")) === null && risAgeYears(est("X", 50, "")) === null, "risAgeYears: sin tipo → desconocida");
  assert(ageDiff(pac("1", "X", 52), est("X", 50)) === 2 && ageDiff(pac("1", "X", "52a"), est("X", 50)) === 2 && ageDiff(pac("1", "X", "3m"), est("X", 4, "Meses")) === null, "ageDiff: usa parseCensusAge; meses en el censo → desconocida");
}

// ── Tokens ────────────────────────────────────────────────────────────────────────────────────
{
  assert(lev1("RICO", "RIZO") && lev1("OVIEDO", "OBIEDO") && lev1("LOPEZ", "LOPE") && !lev1("LOPEZ", "LOPAZ2") && !lev1("GARCIA", "GRACIA"), "lev1: una sola letra (sustitución/borrado), no transposición");
  assert(isGenderVariant("MARIO", "MARIA") && isGenderVariant("ANTONIO", "ANTONIA") && isGenderVariant("JUAN", "JUANA") && isGenderVariant("MANUELA", "MANUEL"), "isGenderVariant: MARIO/MARIA, ANTONIO/ANTONIA y JUAN/JUANA (A añadida) son personas distintas");
  assert(!isGenderVariant("RICO", "RIZO") && !isGenderVariant("ROSA", "ROSAA") && !isGenderVariant("ANA", "ANAA") && !isGenderVariant("PEREZ", "PERES"), "isGenderVariant: RICO/RIZO, PEREZ/PERES no; +A tras vocal o en tokens cortos no cuenta");
  assert(tokenSimilar("JUAN", "JUANA") === null, "tokenSimilar: JUAN/JUANA ya no se emparejan como 'near'");
  assert(tokenSimilar("PEREZ", "PEREZ") === "exact", "tokenSimilar: exacto");
  assert(tokenSimilar("JULIETA", "JULIA") === "fuzzy", "tokenSimilar: JULIETA≈JULIA difuso (Jaro-Winkler)");
  assert(tokenSimilar("RICO", "RIZO") === "near", "tokenSimilar: RICO/RIZO una letra");
  assert(tokenSimilar("MARIO", "MARIA") === null && tokenSimilar("LOPEZ", "GARCIA") === null && tokenSimilar("ANA", "AMA") === null, "tokenSimilar: variante de género, nombres distintos y tokens cortos no cruzan");
  const c1 = nameCoverage("JUAN PEREZ LOPEZ", "PEREZ LOPEZ JUAN");
  assert(c1.common === 3 && c1.exact === 3 && c1.censoCovered && c1.risCovered, "nameCoverage: orden distinto (APELLIDOS NOMBRE) → idéntico");
  const c2 = nameCoverage("MA. DEL CARMEN DE LA TORRE RUIZ", "MARIA CARMEN TORRE RUIZ");
  assert(c2.common === 4 && c2.censoCovered && c2.risCovered, "nameCoverage: partículas (DEL/DE/LA) y abreviatura MA. no estorban");
  const c3 = nameCoverage("JUAN PEREZ LOPEZ", "JUAN CARLOS PEREZ LOPEZ");
  assert(c3.common === 3 && c3.censoCovered && !c3.risCovered, "nameCoverage: censo ⊆ RIS (el RIS trae un nombre más)");
  const c4 = nameCoverage("MARIA DE LOS ANGELES GUADALUPE PEREZ LOPEZ", "MARIA ANGELES PEREZ LOPEZ");
  assert(c4.common === 4 && !c4.censoCovered && c4.risCovered, "nameCoverage: 3 nombres de pila en el censo, el RIS omite uno → RIS ⊆ censo");
  const c5 = nameCoverage("LUIS RICO PRADO", "LUIS RIZO PRADO");
  assert(c5.common === 3 && c5.near === 1 && c5.exact === 2, "nameCoverage: RICO/RIZO cuenta como 'near'");
  const c6 = nameCoverage("JUAN PEREZ PEREZ", "JUAN PEREZ GARCIA");
  assert(c6.common === 2 && !c6.censoCovered && !c6.risCovered, "nameCoverage: tokens repetidos se emparejan una sola vez");
  assert(nameCoverage("", "JUAN PEREZ").common === 0 && nameCoverage("JUAN PEREZ", "").common === 0, "nameCoverage: vacío → 0");
}

// ── (b) Niveles de cruce ─────────────────────────────────────────────────────────────────────
{
  const lvl = (nombreCenso, edadCenso, nombreRis, edadRis, tipo = "Años") => { const s = scoreMatchByName(nombreCenso, est(nombreRis, edadRis, tipo), ageDiff(pac("1", nombreCenso, edadCenso), est(nombreRis, edadRis, tipo))); return s ? s.level : 0; };
  assert(lvl("JUAN PEREZ LOPEZ GARCIA", 73, "PEREZ LOPEZ GARCIA JUAN", 51) === 4, "L4: nombre idéntico de 4 palabras con 73 vs 51 años (edad mal capturada) → SIN guarda de edad");
  assert(lvl("JUAN PEREZ LOPEZ", 73, "JUAN PEREZ LOPEZ", 51) === 4, "L4: idéntico de 3 tokens exactos → sin guarda de edad");
  assert(lvl("MARIA DE LOS ANGELES GUADALUPE PEREZ LOPEZ", 40, "MARIA ANGELES PEREZ LOPEZ", 62) === 4, "L4: 3 nombres de pila en el censo, el RIS omite uno (4 exactos) → sin guarda de edad");
  assert(lvl("JUAN PEREZ LOPEZ GARCIA", 40, "JUAN CARLOS PEREZ LOPEZ GARCIA", 62) === 4, "L4: censo ⊆ RIS con 4 exactos → sin guarda de edad");
  assert(lvl("JUAN PEREZ LOPEZ", 73, "JUAN CARLOS PEREZ LOPEZ", 51) === 0, "censo de 3 ⊆ RIS de 4 con edad muy distinta (22 años) → no cruza (homónimo probable)");
  assert(lvl("JUAN PEREZ LOPEZ", 55, "JUAN CARLOS PEREZ LOPEZ", 51) === 3, "L3: censo ⊆ RIS, edad ±5 → cruza");
  assert(lvl("JUAN PEREZ LOPEZ", 57, "JUAN CARLOS PEREZ LOPEZ", 51) === 0, "L3: censo ⊆ RIS, diferencia 6 → no cruza");
  assert(lvl("JUAN PEREZ LOPEZ", 55, "JUAN CARLOS PEREZ LOPEZ", 51, "") === 3, "L3: censo ⊆ RIS con edad del RIS desconocida → cruza");
  assert(lvl("JUAN CARLOS PEREZ LOPEZ", 55, "JUAN PEREZ LOPEZ", 51) === 3, "L3: RIS ⊆ censo (el RIS omite un nombre) con edad ±5 → cruza (antes exigía ±2 y se perdía)");
  assert(lvl("JUAN CARLOS PEREZ LOPEZ", 59, "JUAN PEREZ LOPEZ", 51) === 0, "RIS ⊆ censo con diferencia 8 → no cruza");
  assert(lvl("JULIETA MORA SANDOVAL", 84, "JULIA MORA SANDOVAL", 87) === 3, "L3: JULIETA vs JULIA 84/87 (caso real) → cruza en nivel 3, no 4");
  assert(lvl("JULIETA MORA SANDOVAL", 84, "JULIA MORA SANDOVAL", 70) === 0, "difuso + edad muy distinta → no cruza (el nivel 4 exige tokens exactos)");
  assert(lvl("LUIS RICO PRADO", 84, "LUIS RIZO PRADO", 83) === 2, "L2: RICO/RIZO 84/83 (caso real) → cruza");
  assert(lvl("LUIS RICO PRADO", 84, "LUIS RIZO PRADO", 82) === 2, "L2: una letra distinta con 3 tokens y diferencia 2 → cruza");
  assert(lvl("LUIS RICO PRADO", 84, "LUIS RIZO PRADO", 80) === 0, "L2: una letra distinta exige ±2 también con 3 tokens (RAUL/SAUL, ROSA/ROSAS: hermanos con los mismos apellidos); diferencia 4 → no cruza");
  assert(lvl("LUIS RICO PRADO", 84, "LUIS RIZO PRADO", 78) === 0, "L2: una letra distinta, diferencia 6 → no cruza");
  assert(lvl("LUIS RICO", 84, "LUIS RIZO PRADO", 85) === 2 && lvl("LUIS RICO", 84, "LUIS RIZO PRADO", 88) === 0, "L2: 2 tokens con letra distinta exige ±2");
  assert(lvl("JUAN PEREZ", 50, "JUAN PEREZ", 53) === 3 && lvl("JUAN PEREZ", 50, "JUAN CARLOS PEREZ LOPEZ", 54) === 3, "L3: nombre de 2 tokens cruza con edad ±5");
  assert(lvl("JUAN PEREZ", 50, "JUAN PEREZ", 50, "") === 0 && lvl("JUAN PEREZ", 50, "JUAN PEREZ", 57) === 0, "2 tokens: sin edad o con diferencia 7 → no cruza (homónimos abiertos)");
  assert(lvl("JUAN PEREZ LOPEZ GARCIA", 50, "JUAN CARLOS PEREZ LOPEZ", 51) === 1 && lvl("JUAN PEREZ LOPEZ GARCIA", 50, "JUAN CARLOS PEREZ LOPEZ", 53) === 0, "L1: ≥ 3 tokens en común con sobrantes a ambos lados exige ±2");
  assert(lvl("JUAN HERNANDEZ PRADO GARCIA", 50, "FERNANDEZ PRADO RUIZ JUAN", 51) === 0, "L1 exige 3 tokens EXACTOS: 2 exactos + HERNANDEZ≈FERNANDEZ difuso → no cruza");
  assert(lvl("JUAN ANTONIO SALCEDO MIRELES", 50, "JUANA ANTONIA SALCEDO MIRELES", 50) === 0, "variantes de género (ANTONIO/ANTONIA) no cruzan aunque la edad cuadre");
  assert(lvl("JUAN PEREZ LOPEZ", 50, "PEDRO GOMEZ DIAZ", 50) === 0 && lvl("JUAN PEREZ LOPEZ", 50, "JUAN GOMEZ DIAZ", 50) === 0, "nombres distintos / 1 token en común → no cruza");
  // alias "nombre en WinLab" fijado desde la app
  const pAlias = pac("9", "MARIA RUIZ SOTO", 60, { alias: "RUIZ SOTOMAYOR, MARIA ELENA" });
  const sA = scoreMatch(pAlias, est("MARIA ELENA RUIZ SOTOMAYOR", 61));
  assert(sA && sA.level === 4 && sA.via === "alias", "scoreMatch: el alias de la app identifica cuando el nombre del censo no coincide");
  const sN = scoreMatch(pac("9", "MARIA RUIZ SOTO", 60), est("MARIA ELENA RUIZ SOTOMAYOR", 61));
  assert(sN === null, "sin alias ese mismo caso no cruza (SOTO ≠ SOTOMAYOR)");
  assert(ageCompat(null) === 1 && ageCompat(3) === 2 && ageCompat(9) === 0, "ageCompat: 2 cuadra, 1 desconocida, 0 no cuadra");
}

// ── (b) Entre dos candidatos del censo manda la edad ─────────────────────────────────────────
{
  const censo = [pac("A", "JUAN PEREZ LOPEZ", 73), pac("B", "JUAN PEREZ LOPEZ GARCIA", 25)];
  const m1 = matchCensoDetailed(est("JUAN PEREZ LOPEZ", 25), censo);
  assert(m1 && m1.p.exp === "B" && !m1.ambiguous, "dos candidatos: el idéntico (73 a) vs el subconjunto con edad que cuadra (25 a) → gana la edad");
  const m2 = matchCensoDetailed(est("JUAN PEREZ LOPEZ", 72), censo);
  assert(m2 && m2.p.exp === "A", "dos candidatos: ahora el de 73 a cuadra → gana A");
  const m3 = matchCensoDetailed(est("JUAN PEREZ LOPEZ", 50), censo);
  assert(m3 && m3.p.exp === "A", "ninguno cuadra por edad → el nombre idéntico (nivel 4) por encima del subconjunto");
  const dupl = [pac("C", "ANA LAURA QUIROZ VEGA", 30, { cama: "3-1" }), pac("D", "ANA LAURA QUIROZ VEGA", 30, { cama: "3-2" })];
  const m4 = matchCensoDetailed(est("ANA LAURA QUIROZ VEGA", 30), dupl);
  assert(m4 && m4.ambiguous && m4.candidates.length === 2, "mismo nombre y edad en dos camas (exp distinto) → ambiguo (el scraper NO lo asigna; ver guarda de fuente)");
  assert(matchCenso(est("ZZZ YYY", 1), censo) === null && matchCensoDetailed(est("JUAN PEREZ LOPEZ", 25), []) === null, "matchCenso: sin candidatos → null");
  const m5 = matchCensoDetailed(est("PEREZ LOPEZ JUAN", 26), [pac("E", "JUAN PEREZ LOPEZ", 73, { alias: "PEREZ LOPEZ, JUAN" }), pac("F", "JUAN PEREZ LOPEZ GARCIA", 25)]);
  assert(m5 && m5.p.exp === "F", "el alias no da ventaja sobre la edad: sigue ganando el candidato cuya edad cuadra");
}

// ── (b) Homónimos del lado del RIS: dos personas del RIS en el mismo paciente del censo ───────
{
  const p = pac("H", "MARIA RUIZ SOTO", 69);
  const rows = (nombre, edad, n, fecha) => Array.from({ length: n }, (_, i) => ({ e: est(nombre, edad, "Años", { fecha: fecha || "2026-10-0" + (i + 1), documento: "PAT" + edad + i }), p, level: 4 }));
  const r1 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 2), ...rows("MARIA RUIZ SOTO", 30, 3)]);
  assert(r1.kept.length === 2 && r1.dropped.length === 3 && /homónimo/.test(r1.dropped[0].motivo) && r1.ambiguous.length === 0, "homónimo real (mismo nombre, 70 vs 30 años, censo 69) → se conservan los de 70 y se descartan los de 30 con motivo");
  const r2 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 58, 1), ...rows("MARIA RUIZ SOTO", 60, 1)].map((m) => ({ ...m, p: pac("H", "MARIA RUIZ SOTO", 59) })));
  assert(r2.kept.length === 2 && r2.dropped.length === 0, "misma persona con 58 y 60 años en el RIS (±2) → es una sola identidad, se conserva todo");
  const r3 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 1), ...rows("MARIA ELENA RUIZ SOTO", 71, 1)]);
  assert(r3.kept.length === 2 && r3.dropped.length === 0, "nombres que se contienen y edades a ±2 → misma persona (registro doble en el RIS)");
  const r4 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 1), ...rows("MARIA RUIZ SOTO", 66, 1)]);
  assert(r4.kept.length === 2 && r4.dropped.length === 0 && r4.ambiguous.length === 1, "dos identidades que AMBAS cuadran por edad (70 y 66 vs 69) → se conservan las dos y se avisa");
  const pSin = pac("S", "MARIA RUIZ SOTO", "3m");
  const r5 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 1), ...rows("MARIA RUIZ SOTO", 30, 1)].map((m) => ({ ...m, p: pSin })));
  assert(r5.kept.length === 2 && r5.dropped.length === 0 && r5.ambiguous.length === 1 && /desconocida/.test(r5.ambiguous[0].motivo), "edad del censo desconocida → no se puede separar: se conserva todo y se avisa");
  const pMal = pac("M", "MARIA RUIZ SOTO", 45);
  const r6 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 1).map((m) => ({ ...m, p: pMal, level: 4 })), ...rows("MARIA ELENA RUIZ SOTO", 30, 1).map((m) => ({ ...m, p: pMal, level: 3 }))]);
  assert(r6.kept.length === 1 && r6.kept[0].level === 4 && r6.dropped.length === 1, "ninguna cuadra con la edad del censo (mal capturada) → gana el nombre más exacto (nivel 4)");
  const r7 = resolveHomonyms([...rows("MARIA RUIZ SOTO", 70, 1).map((m) => ({ ...m, p: pMal })), ...rows("MARIA RUIZ SOTO", 30, 1).map((m) => ({ ...m, p: pMal }))]);
  assert(r7.kept.length === 2 && r7.ambiguous.length === 1, "ninguna cuadra y empatan en nombre → se conservan todas (ambiguo)");
  assert(resolveHomonyms([]).kept.length === 0 && resolveHomonyms(rows("X Y Z", 1, 1)).kept.length === 1, "sin homónimos → passthrough");
  const nm = nearMisses([est("JUAN PEREZ GOMEZ", 50)], [pac("N", "JUAN PEREZ LOPEZ", 50, { cama: "3-7" })], new Set());
  assert(nm.length === 1 && /cama 3-7/.test(nm[0]), "nearMisses: lista al paciente sin estudio con una fila parecida (≥ 2 tokens)");
}

// ── (c) Reportes: texto útil, estado y reintento ─────────────────────────────────────────────
{
  assert(looksLikeLoginPage("", '<form><input name="_username"><input type="password" name="_password"></form>'), "looksLikeLoginPage: formulario de login en el HTML");
  assert(looksLikeLoginPage("Usuario\nContraseña\nIniciar sesión"), "looksLikeLoginPage: vocabulario de login en el texto");
  assert(!looksLikeLoginPage("Cerrar sesión · TAC DE ABDOMEN. Hígado de tamaño normal. Conclusión: sin alteraciones."), "looksLikeLoginPage: 'Cerrar sesión' es señal de página LOGUEADA, no de login (un reporte corto dentro del portal sigue siendo útil)");
  const informe = "TOMOGRAFIA DE ABDOMEN. Hallazgos: higado de tamaño normal, sin lesiones focales. Conclusión: estudio sin alteraciones. ".repeat(3);
  assert(!looksLikeLoginPage(informe) && isUsableReportText(informe), "un reporte normal es texto útil");
  assert(!isUsableReportText("") && !isUsableReportText("corto") && !isUsableReportText("Usuario Contraseña Iniciar sesión"), "isUsableReportText: vacío, corto o página de login → NO útil");
  const have = buildHaveSet([
    { documento: "P1", fecha: "2026-10-01", hora: "10:00", modalidad: "CT", reporte: informe },
    { documento: "P2", fecha: "2026-10-01", hora: "10:00", modalidad: "CT", reporte: "" },
    { documento: "P3", fecha: "2026-10-01", hora: "10:00", modalidad: "CT", reporte: null },
    { documento: "P4", fecha: "2026-10-01", hora: "10:00", modalidad: "CT", reporte: "Usuario Contraseña Iniciar sesión" },
  ]);
  assert(have.size === 1 && have.has("P1|2026-10-01|10:00|CT"), "buildHaveSet: solo cuentan los reportes con texto útil → los vacíos/login se reintentan en la siguiente corrida");
  assert(classifyReporte({ hasLink: false }).estado === REPORTE_ESTADO.PENDIENTE_RIS && /sin ícono/.test(classifyReporte({ hasLink: false }).motivo), "estado: sin ícono → pendiente_ris (el RIS no lo ha transcrito)");
  assert(classifyReporte({ hasLink: false, alreadySaved: true }).estado === REPORTE_ESTADO.OK, "estado: ya guardado antes → ok aunque hoy no se vea el ícono");
  assert(classifyReporte({ hasLink: true, attempted: false, budgetExhausted: true }).estado === REPORTE_ESTADO.PENDIENTE_DESCARGA && /presupuesto/.test(classifyReporte({ hasLink: true, attempted: false, budgetExhausted: true }).motivo), "estado: sin presupuesto → pendiente_descarga con motivo");
  assert(classifyReporte({ hasLink: true, attempted: true, text: informe }).estado === REPORTE_ESTADO.OK, "estado: descarga con texto → ok");
  const cl = classifyReporte({ hasLink: true, attempted: true, text: "Usuario Contraseña Iniciar sesión" });
  assert(cl.estado === REPORTE_ESTADO.PENDIENTE_DESCARGA && /login/.test(cl.motivo), "estado: página de login → pendiente_descarga (NO se guarda como reporte)");
  const ce = classifyReporte({ hasLink: true, attempted: true, text: "", error: "GET falló: timeout" });
  assert(ce.estado === REPORTE_ESTADO.PENDIENTE_DESCARGA && /timeout/.test(ce.motivo) && /reintenta/.test(ce.motivo), "estado: fallo de descarga → pendiente_descarga con el error y aviso de reintento");
  const cv = classifyReporte({ hasLink: true, attempted: true, text: "" });
  assert(cv.estado === REPORTE_ESTADO.PENDIENTE_DESCARGA && /sin texto|escaneado/.test(cv.motivo), "estado: PDF sin texto → pendiente_descarga");
  // Reintento efectivo: la fila fallida NO entra en `have` y vuelve a ser candidata en la siguiente corrida
  const prevRun = [{ documento: "P9", fecha: "2026-10-01", hora: "10:00", modalidad: "CT", reporte: null, reporte_estado: "pendiente_descarga" }];
  const e9 = est("X Y Z", 1, "Años", { documento: "P9", fecha: "2026-10-01", hora: "10:00", linkReporte: { href: "/r" } });
  assert(!buildHaveSet(prevRun).has(estudioKey(e9)), "reintento: un estudio con reporte fallido ayer se vuelve a intentar hoy");
  const { withRep, noRep } = splitPayload([{ documento: "a", reporte: informe, reporte_estado: "ok" }, { documento: "b", reporte: undefined, reporte_estado: "pendiente_ris" }, { documento: "c", reporte: "", reporte_estado: "pendiente_descarga" }]);
  assert(withRep.length === 1 && noRep.length === 2 && noRep.every((r) => !("reporte" in r)) && noRep.every((r) => r.reporte_estado), "splitPayload: las filas sin reporte van SIN la columna (no pisan un reporte previo) pero conservan el estado");
  assert(isUnknownColumnError({ code: "PGRST204", message: "Could not find the 'reporte_estado' column of 'ris_estudios' in the schema cache" }), "isUnknownColumnError: PGRST204 (PostgREST)");
  assert(isUnknownColumnError({ code: "42703", message: "column \"reporte_estado\" does not exist" }) && isUnknownColumnError({ message: "column ris_estudios.reporte_motivo does not exist" }), "isUnknownColumnError: 42703 (Postgres)");
  assert(!isUnknownColumnError({ code: "23505", message: "duplicate key value violates unique constraint" }) && !isUnknownColumnError(null), "isUnknownColumnError: otros errores no");
  const stripped = stripColumns([{ exp: "1", reporte_estado: "ok", reporte_motivo: "x", reporte: "t" }], RIS_OPTIONAL_COLS);
  assert(Object.keys(stripped[0]).join(",") === "exp,reporte", "stripColumns: quita solo las columnas opcionales");
}

// ── Guarda del scraper: subconjunto exacto (≥ 4 tokens) con edad incompatible = homónimo probable ──
// ris-lib da nivel 4 SIN edad a un subconjunto exacto de ≥ 4 tokens; ris-scraper.js (esHomonimoProbable)
// descarta ese candidato cuando la edad es conocida e incompatible. Se replica aquí el predicado (el
// scraper no es importable) y se comprueba sobre la salida real de matchCensoDetailed.
{
  const esHomonimoProbable = (c, tolWide = 5) => !!c && c.level === 4 && !(c.cov && c.cov.censoCovered && c.cov.risCovered) && c.diff != null && c.diff > tolWide;
  const censo = [pac("Z", "ROSA ISELA CAMPOS DUARTE", 80)];
  const casada = matchCensoDetailed(est("CAMPOS DUARTE DE MOLINA ROSA ISELA", 45), censo);
  assert(casada && casada.level === 4 && casada.diff === 35 && casada.candidates[0].cov.censoCovered && !casada.candidates[0].cov.risCovered, "lib: apellido de casada (censo ⊆ RIS, 4 exactos) con 80 vs 45 años sale nivel 4 sin guarda de edad (hueco que cierra el scraper)");
  assert(esHomonimoProbable(casada.candidates[0]), "guarda: ese candidato se descarta (homónimo probable) → el estudio NO va a la cama");
  const tresNombres = matchCensoDetailed(est("PEREZ LOPEZ MARIA GUADALUPE", 30), [pac("Y", "MARIA ANGELES GUADALUPE PEREZ LOPEZ", 80)]);
  assert(tresNombres && tresNombres.level === 4 && esHomonimoProbable(tresNombres.candidates[0]), "guarda: RIS ⊆ censo (3 nombres de pila) con 80 vs 30 años también se descarta");
  const compatible = matchCensoDetailed(est("PEREZ LOPEZ MARIA GUADALUPE", 78), [pac("Y", "MARIA ANGELES GUADALUPE PEREZ LOPEZ", 80)]);
  assert(compatible && compatible.level === 4 && !esHomonimoProbable(compatible.candidates[0]), "guarda: con edad compatible (±5) el subconjunto de 4 exactos sigue cruzando en nivel 4 (caso cama con 3 nombres)");
  const sinEdad = matchCensoDetailed(est("PEREZ LOPEZ MARIA GUADALUPE", 30, ""), [pac("Y", "MARIA ANGELES GUADALUPE PEREZ LOPEZ", 80)]);
  assert(sinEdad && sinEdad.level === 4 && !esHomonimoProbable(sinEdad.candidates[0]), "guarda: con edad desconocida no se descarta (igual que el nivel 3)");
  const identico = matchCensoDetailed(est("HERNANDEZ GARCIA JUAN", 20), [pac("X", "JUAN HERNANDEZ GARCIA", 80)]);
  assert(identico && identico.level === 4 && !esHomonimoProbable(identico.candidates[0]), "guarda: el nombre IDÉNTICO conserva el nivel 4 sin edad (caso real de edad mal capturada; no cambia)");
}

// ── Guardas de regresión sobre ris-scraper.js (ejecuta main() al cargarse: se revisa el fuente) ─
{
  assert(/function esHomonimoProbable\(c\)/.test(scraperSrc) && /matchCensoGuarded\(e, censo\)/.test(scraperSrc) && /c\.level === 4 && !identico && c\.diff != null && c\.diff > RIS_AGE_TOLERANCE_WIDE_ENV/.test(scraperSrc), "ris-scraper aplica la guarda de subconjunto exacto con edad incompatible antes de asignar el estudio");
  assert(/visorSinTexto = true/.test(scraperSrc) && /!visorSinTexto && text\.length > 60/.test(scraperSrc), "fetchReporte: el texto del visor HTML de un PDF sin texto NO se guarda como reporte (queda pendiente_descarga)");
  assert(/from "\.\/ris-lib\.js"/.test(scraperSrc), "ris-scraper importa la lógica pura de ris-lib.js");
  assert(!/isAllowedEsp/.test(scraperSrc), "ris-scraper ya NO usa isAllowedEsp (todo el censo entra al cruce)");
  assert(/filterCenso\(/.test(scraperSrc) && /select\("id,exp,nombre,cama,esp,edad,es_mio,ingreso,created_at"\)/.test(scraperSrc), "ris-scraper lee el censo actual (patients) con ingreso/created_at en cada corrida");
  assert(/await loadCenso\(supa\)/.test(scraperSrc) && scraperSrc.indexOf("await loadCenso(supa)") < scraperSrc.indexOf("await login(page, cfg)"), "ris-scraper lee el censo ANTES de consultar el RIS (define las ventanas)");
  assert(/buildWindows\(\{ today: hoy, lookbackDays: RIS_LOOKBACK_DAYS, oldest/.test(scraperSrc) && /oldestIngreso\(censo\)/.test(scraperSrc), "ris-scraper extiende las ventanas hasta el ingreso más antiguo del censo");
  assert(/dedupEstudios\(/.test(scraperSrc), "ris-scraper deduplica estudios entre ventanas");
  assert(/matchCensoDetailed\(e, censo, MATCH_OPTS\)/.test(scraperSrc) && /resolveHomonyms\(matchedRaw, MATCH_OPTS\)/.test(scraperSrc), "ris-scraper cruza con matchCensoDetailed y resuelve homónimos del RIS");
  assert(/winlab_alias/.test(scraperSrc), "ris-scraper carga el alias 'nombre en WinLab' de la app para el cruce");
  assert(/buildHaveSet\(prev \|\| \[\]\)/.test(scraperSrc) && /classifyReporte\(\{ hasLink/.test(scraperSrc) && /reporte_estado = cls\.estado/.test(scraperSrc), "ris-scraper clasifica el estado del reporte y solo omite los que ya tienen texto útil");
  assert(/isUsableReportText\(/.test(scraperSrc) && /looksLikeLoginPage\(/.test(scraperSrc), "fetchReporte no acepta la página de login ni texto vacío como reporte");
  assert(/isUnknownColumnError\(error\)/.test(scraperSrc) && /stripColumns\(batch, RIS_OPTIONAL_COLS\)/.test(scraperSrc), "upsert tolerante: si faltan las columnas opcionales reintenta sin ellas");
  assert(/splitPayload\(payload\)/.test(scraperSrc), "upsert: las filas sin reporte no pisan el reporte guardado");
  assert(/reporte ✗ cama .*cls\.motivo/.test(scraperSrc), "el log dice POR QUÉ falló cada reporte");
  assert(/sin estudio en el RIS desde/.test(scraperSrc), "el log lista las camas sin estudio en la ventana");
  assert(/process\.exit\(0\)/.test(scraperSrc) && /process\.exit\(1\)/.test(scraperSrc) && /\(async \(\) => \{/.test(scraperSrc), "el arranque (IIFE + exit codes) sigue igual para `node ris-scraper.js` del workflow");
}

// ── Empate completo entre dos camas: el estudio NO se asigna (oct 2026) ───────────────────────
{
  assert(/if \(m\.ambiguous\) \{[^\n]*NO se asigna[^\n]*continue; \}/.test(scraperSrc), "ris-scraper: un estudio que empata por completo entre dos camas con exp distinto no se asigna a ninguna (motivo en el log) y se reintenta en la siguiente corrida");
  assert(/ambiguo\(s\) entre dos camas, sin asignar/.test(scraperSrc), "ris-scraper: el resumen cuenta los ambiguos sin asignar");
  assert(!/se asignó a \$\{m\.p\.cama\}/.test(scraperSrc), "ris-scraper: ya no existe la asignación 'al primero' (50 % de acierto)");
}

console.log(`\n${pass} pasaron, ${fail} fallaron`);
process.exit(fail ? 1 : 0);
