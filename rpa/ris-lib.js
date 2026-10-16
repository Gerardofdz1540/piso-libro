// ════════════════════════════════════════════════════════════════════════
// ris-lib.js — lógica PURA del robot de imagen (ris-scraper.js): sin Playwright, sin Supabase,
// sin red. Se separa para poder probarla con `node ris.test.js` y para que importar estas
// funciones no arranque el scraper (ris-scraper.js ejecuta su main() al cargarse).
//
// Qué resuelve (corrida #22, 16 oct 2026: 2 193 estudios en 27 días, 29/46 pacientes cruzados):
//   (a) filterCenso: TODO el censo entra al cruce (es_mio=false, NCX, URO, CT, CPR, CCR, CV,
//       "CG/URO", "CG / NCX", esp vacío…). Solo se omite, y se registra, quien no tiene nombre o
//       expediente (sin exp la tarjeta no puede ligar el estudio).
//   (b) scoreMatch/matchCensoDetailed: cruce nombre ↔ censo por cobertura de tokens en AMBOS
//       sentidos (el RIS puede traer un nombre de más o de menos que el censo), con la edad como
//       guarda graduada y, entre dos candidatos, como desempate ("la edad manda"). resolveHomonyms
//       hace lo mismo del lado del RIS: si dos personas distintas del RIS caen en el mismo paciente
//       del censo, se conserva la de edad compatible y se descarta la otra con motivo.
//   (c) classifyReporte: estado explícito del reporte ('ok' | 'pendiente_ris' | 'pendiente_descarga')
//       con motivo. Un fallo de descarga NUNCA es definitivo: la siguiente corrida lo reintenta
//       (buildHaveSet solo cuenta reportes con texto útil). looksLikeLoginPage evita guardar la
//       página de login como si fuera un reporte.
//   (d) buildWindows/oldestIngreso: las ventanas de 14 días se extienden hasta el ingreso más
//       antiguo del censo (11/46 pacientes llevaban > 27 días y sus estudios de ingreso quedaban
//       fuera), con tope RIS_MAX_WINDOWS.
// ════════════════════════════════════════════════════════════════════════

import { normNameTokens, parseCensusAge, jaroWinkler } from "./lib.js";

export const RIS_AGE_TOLERANCE_DEFAULT = 2;   // ±2 años: cruces débiles (2 tokens, letra cambiada, extras a ambos lados)
export const RIS_AGE_TOLERANCE_WIDE = 5;      // ±5 años: cruces por subconjunto de ≥ 3 tokens
export const RIS_LOOKBACK_DAYS_DEFAULT = 13;  // el portal no permite consultas de más de 14 días
export const RIS_MIN_WINDOWS_DEFAULT = 2;
export const RIS_MAX_WINDOWS_DEFAULT = 5;     // 5 × 14 días = 70 días hacia atrás como máximo

export const REPORTE_ESTADO = Object.freeze({
  OK: "ok",                                 // texto del reporte guardado
  PENDIENTE_RIS: "pendiente_ris",           // el RIS aún no tiene reporte (sin ícono de impresora)
  PENDIENTE_DESCARGA: "pendiente_descarga", // hay ícono pero no se pudo bajar/transcribir → se reintenta
});
// Columnas que el robot escribe si existen en ris_estudios (ver scripts/supabase_ris_estudios.sql);
// si la tabla aún no las tiene, el upsert se reintenta sin ellas (isUnknownColumnError + stripColumns).
export const RIS_OPTIONAL_COLS = ["reporte_estado", "reporte_motivo"];

// ── (a) Censo elegible ──────────────────────────────────────────────────
// NO filtra por especialidad ni por es_mio: el usuario quiere imagen de TODOS los del censo.
export function filterCenso(censoRaw) {
  const censo = [], skipped = [];
  for (const p of censoRaw || []) {
    if (!p) continue;
    const nombre = String(p.nombre || "").replace(/\s+/g, " ").trim();
    const exp = String(p.exp || "").trim();
    if (!normNameTokens(nombre).length) { skipped.push({ cama: p.cama || "?", exp, motivo: "sin nombre" }); continue; }
    if (!exp) { skipped.push({ cama: p.cama || "?", exp, motivo: "sin expediente (la tarjeta no podría ligar el estudio)" }); continue; }
    censo.push({ ...p, nombre, exp });
  }
  return { censo, skipped };
}

// ── (d) Ventanas de fechas ──────────────────────────────────────────────
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;
export function addDaysISO(iso, n) {
  const m = ISO_RE.exec(String(iso || ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return d.toISOString().slice(0, 10);
}
// Ingreso más antiguo del censo ('YYYY-MM-DD'); si un paciente no trae `ingreso`, se usa created_at.
export function oldestIngreso(censo) {
  let min = null;
  for (const p of censo || []) {
    const raw = (p && (p.ingreso || p.created_at)) || "";
    const m = ISO_RE.exec(String(raw));
    if (!m) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (min === null || iso < min) min = iso;
  }
  return min;
}
// Ventanas contiguas de (lookbackDays+1) días, de la más reciente a la más antigua: al menos
// minWindows, y se siguen agregando hasta cubrir `oldest` (ingreso más antiguo) o llegar a maxWindows.
export function buildWindows({ today, lookbackDays = RIS_LOOKBACK_DAYS_DEFAULT, oldest = null, minWindows = RIS_MIN_WINDOWS_DEFAULT, maxWindows = RIS_MAX_WINDOWS_DEFAULT } = {}) {
  const L = Math.max(0, parseInt(lookbackDays, 10) || 0), span = L + 1;
  const minW = Math.max(1, parseInt(minWindows, 10) || 1), maxW = Math.max(minW, parseInt(maxWindows, 10) || minW);
  const out = [];
  for (let i = 0; i < maxW; i++) {
    const dateSS = addDaysISO(today, -i * span), dateS = addDaysISO(today, -(i * span + L));
    out.push({ dateS, dateSS });
    if (out.length >= minW && (!oldest || dateS <= oldest)) break;
  }
  return out;
}

// ── Fila de la tabla → estudio ──────────────────────────────────────────
export function rowToEstudio(r, hdr) {
  const H = (hdr || []).map((h) => String(h || "").toUpperCase());
  const col = (re) => H.findIndex((h) => re.test(h));
  const get = (re) => { const i = col(re); return i >= 0 ? (r.cells[i] || "") : ""; };
  const links = r.links || [];
  return {
    nombre: get(/NOMBRE/), documento: get(/DOCUMENTO/), edad: get(/^EDAD/), tipoEdad: get(/TIPO/),
    fecha: get(/FECHA/), hora: get(/HORA/), sede: get(/SEDE/), estudios: get(/ESTUDIO/), modalidad: get(/MODALIDAD/),
    procedencia: get(/PROCEDENCIA/), critico: /^S[IÍ]/i.test(get(/CR[IÍ]TICO/)),
    linkReporte: links.find((l) => l.kind === "reporte") || null,
    linkImagen: links.find((l) => l.kind === "imagen") || null,
    links,
  };
}
export function estudioKey(e) { return [e.documento, e.fecha, e.hora, e.modalidad].join("|"); }
// Con varias ventanas un estudio podría repetirse; el upsert falla si una fila aparece dos veces.
// Si la misma clave (documento|fecha|hora|modalidad) trae DOS estudios distintos (dos series TC pedidas
// el mismo minuto), no se pierde el segundo: se fusionan las descripciones (" | "), se conserva el
// enlace de reporte/imagen que alguno traiga y se unen los enlaces.
export function dedupEstudios(estudios) {
  const byKey = new Map(), out = [];
  for (const e of estudios || []) {
    const k = estudioKey(e), prev = byKey.get(k);
    if (!prev) { const c = { ...e, links: Array.isArray(e.links) ? e.links.slice() : [] }; byKey.set(k, c); out.push(c); continue; }
    const dA = String(prev.estudios || "").trim(), dB = String(e.estudios || "").trim();
    if (dB && dB !== "*" && dB !== dA && !dA.split(" | ").includes(dB)) prev.estudios = dA && dA !== "*" ? `${dA} | ${dB}` : dB;
    if (!prev.linkReporte && e.linkReporte) prev.linkReporte = e.linkReporte;
    if (!prev.linkImagen && e.linkImagen) prev.linkImagen = e.linkImagen;
    if (!prev.critico && e.critico) prev.critico = true;
    for (const l of e.links || []) if (!prev.links.some((x) => x && l && x.kind === l.kind && x.href === l.href && x.html === l.html)) prev.links.push(l);
  }
  return out;
}

// ── Edad ────────────────────────────────────────────────────────────────
// Edad del RIS en años: "Años" → n; "Meses"/"Días"/"Semanas" → 0 (menor de un año); otro → null.
export function risAgeYears(est) {
  const tipo = String((est && est.tipoEdad) || "").toUpperCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const n = parseInt(String((est && est.edad) || "").trim(), 10);
  if (/ANO|YEAR/.test(tipo)) return isNaN(n) ? null : n;
  if (/MES|DIA|SEM|MONTH|DAY|WEEK/.test(tipo)) return isNaN(n) ? null : 0;
  return null;
}
export function ageDiff(p, est) {
  const ca = parseCensusAge(p && p.edad), ra = risAgeYears(est);
  if (ca == null || ra == null) return null;
  return Math.abs(ca - ra);
}

// ── Tokens ──────────────────────────────────────────────────────────────
// ¿difieren en UNA sola letra (sustitución, inserción o borrado)? RICO/RIZO, NOVELO/NOBELO.
export function lev1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// ANTONIO/ANTONIA, MARIO/MARIA (cambia la vocal final) y JUAN/JUANA, MANUEL/MANUELA (se agrega
// una A): personas distintas aunque difieran en una sola letra; lev1 no debe emparejarlas.
export function isGenderVariant(t1, t2) {
  if (t1.length === t2.length) {
    if (t1.length < 4) return false;
    const a = t1[t1.length - 1], b = t2[t2.length - 1];
    return a !== b && "AO".includes(a) && "AO".includes(b) && t1.slice(0, -1) === t2.slice(0, -1);
  }
  const [s, l] = t1.length < t2.length ? [t1, t2] : [t2, t1];
  return s.length >= 4 && l.length === s.length + 1 && l === s + "A" && !/[AEIOU]$/.test(s);
}
// "exact" | "fuzzy" (Jaro-Winkler ≥ 0.88, ≥ 5 letras: JULIETA≈JULIA) | "near" (una letra, ≥ 4 letras) | null
export function tokenSimilar(a, b) {
  if (a === b) return "exact";
  if (isGenderVariant(a, b)) return null;
  if (a.length >= 5 && b.length >= 5 && jaroWinkler(a, b) >= 0.88) return "fuzzy";
  if (a.length >= 4 && b.length >= 4 && lev1(a, b)) return "near";
  return null;
}
// Cobertura de tokens entre el nombre del censo y el del RIS, independiente del orden (el RIS
// lista "APELLIDOS NOMBRES"; la hoja a veces también). Primero se emparejan los exactos y solo
// después los difusos, para que un difuso no se robe el token que tenía pareja exacta.
export function nameCoverage(nombreCenso, nombreRis) {
  const tC = normNameTokens(nombreCenso), tR = normNameTokens(nombreRis);
  const usedC = new Array(tC.length).fill(false), usedR = new Array(tR.length).fill(false);
  const n = { exact: 0, fuzzy: 0, near: 0 };
  for (const kind of ["exact", "fuzzy", "near"]) {
    for (let i = 0; i < tC.length; i++) {
      if (usedC[i]) continue;
      for (let j = 0; j < tR.length; j++) {
        if (usedR[j]) continue;
        if (tokenSimilar(tC[i], tR[j]) === kind) { usedC[i] = usedR[j] = true; n[kind]++; break; }
      }
    }
  }
  const common = n.exact + n.fuzzy + n.near;
  return {
    tC, tR, common, exact: n.exact, fuzzy: n.fuzzy, near: n.near,
    censoCovered: tC.length > 0 && common === tC.length,   // todos los tokens del censo están en el RIS
    risCovered: tR.length > 0 && common === tR.length,     // todos los tokens del RIS están en el censo
  };
}

// ── (b) Nivel de cruce ──────────────────────────────────────────────────
// Casos reales (oct 2026): "JULIETA" vs "JULIA" 84/87 años (misma paciente), "RICO" vs "RIZO" 84/83,
// nombre idéntico de 4 palabras con 73 vs 51 años (edad mal capturada en el censo), censo con el
// nombre invertido (APELLIDOS NOMBRES), censo con 3 nombres de pila y el RIS con 2.
//   4) mismo nombre (≥ 3 tokens exactos) o un lado omite un token con ≥ 4 exactos → SIN guarda de edad
//   3) un lado ⊆ del otro con ≥ 3 tokens (difuso permitido, sin letra cambiada) → edad ±5 o desconocida
//   3) nombre de 2 tokens idéntico/contenido, los 2 EXACTOS (corrida #23: "PEDRO SOTO" ≈ "LUIS PEDRO
//      SOTOMAYOR RUIZ" cruzaba por SOTO≈SOTOMAYOR difuso)                         → edad ±5 OBLIGATORIA
//   2) un lado ⊆ del otro con una letra cambiada (RICO/RIZO) → edad ±2 (con 2 o más tokens: una letra
//      también separa a RAUL/SAUL, ROSA/ROSAS, LAURA/MAURA, hermanos con los mismos apellidos a pocos años)
//   —  SIN nivel para "≥ 3 tokens en común con sobrantes en AMBOS lados": con los mismos apellidos y la
//      misma edad, un primer nombre distinto es casi siempre un HERMANO/GEMELO (corrida #23: dos
//      pacientes de 20 años con los mismos apellidos y segundo nombre, distinto primer nombre). Esos
//      casos quedan en "casi-coincidencias" del log para alias manual. Precisión > recall.
// La edad "desconocida" (censo en meses, RIS sin tipo de edad) solo se tolera en el nivel 3 con ≥ 3 tokens.
export function scoreMatchByName(nombreCenso, est, diff, opts = {}) {
  const tol = Number.isFinite(opts.ageTolerance) ? opts.ageTolerance : RIS_AGE_TOLERANCE_DEFAULT;
  const tolWide = Number.isFinite(opts.ageToleranceWide) ? opts.ageToleranceWide : RIS_AGE_TOLERANCE_WIDE;
  const cov = nameCoverage(nombreCenso, est && est.nombre);
  if (!cov.tC.length || !cov.tR.length || cov.common < 2) return null;
  const known = diff != null;
  const identical = cov.censoCovered && cov.risCovered;
  const subset = cov.censoCovered || cov.risCovered;
  const allExact = cov.fuzzy === 0 && cov.near === 0;
  let level = 0, label = "";
  if (allExact && ((identical && cov.common >= 3) || (subset && cov.common >= 4))) { level = 4; label = identical ? "nombre idéntico" : "subconjunto exacto (≥ 4 tokens)"; }
  else if (subset && cov.near === 0 && cov.common >= 3 && (!known || diff <= tolWide)) { level = 3; label = cov.censoCovered ? "censo ⊆ RIS" : "RIS ⊆ censo"; }
  else if (subset && allExact && cov.common === 2 && known && diff <= tolWide) { level = 3; label = "2 tokens + edad"; }
  else if (subset && cov.near > 0 && cov.common >= 3 && known && diff <= tol) { level = 2; label = "una letra distinta (≥ 3 tokens)"; }
  else if (subset && cov.near > 0 && cov.common === 2 && known && diff <= tol) { level = 2; label = "una letra distinta (2 tokens)"; }
  // (sin nivel 1: sobrantes en ambos lados = hermanos/gemelos con los mismos apellidos; ver arriba)
  if (!level) return null;
  return { level, label, cov, diff };
}
// Un paciente puede traer `alias` ("nombre en WinLab" fijado desde la app): también identifica.
// Un alias CORTO (≤ 2 tokens: el equipo a veces fija solo los apellidos, "SOTO MEDINA", para que WinLab
// busque por ellos) solo identifica en el RIS si el nombre del RIS es IDÉNTICO al alias; si no, cualquier
// homónimo de apellidos con edad parecida (corrida #23: "MARTHA SOTO MEDINA" 60 a por "AMALIA SOTO
// MEDINA" 58 a) entraría a la tarjeta. El nombre del censo sigue cruzando por su cuenta.
export function scoreMatch(p, est, opts = {}) {
  const diff = ageDiff(p, est);
  const names = [p && p.nombre, p && p.alias].filter((s) => s && String(s).trim());
  let best = null;
  for (const nm of names) {
    const s = scoreMatchByName(nm, est, diff, opts);
    if (!s) continue;
    const isAlias = nm !== p.nombre;
    if (isAlias && normNameTokens(nm).length < 3 && !(s.cov.censoCovered && s.cov.risCovered)) continue;
    if (!best || s.level > best.level || (s.level === best.level && s.cov.exact > best.cov.exact)) best = { ...s, via: isAlias ? "alias" : "nombre" };
  }
  return best;
}
// Compatibilidad de edad para ordenar candidatos: 2 = cuadra (≤ tolWide), 1 = desconocida, 0 = no cuadra.
export function ageCompat(diff, tolWide = RIS_AGE_TOLERANCE_WIDE) { return diff == null ? 1 : (diff <= tolWide ? 2 : 0); }
function _rankKey(c, tolWide) { return [ageCompat(c.diff, tolWide), c.level, -(c.diff == null ? 999 : c.diff), c.cov.exact, c.cov.common]; }
function _cmpKeys(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; }

// Mejor paciente del censo para un estudio. Entre dos candidatos la EDAD manda (compatibilidad,
// luego nivel, luego diferencia de edad). `ambiguous` = dos pacientes distintos empatan por completo.
export function matchCensoDetailed(est, censo, opts = {}) {
  const tolWide = Number.isFinite(opts.ageToleranceWide) ? opts.ageToleranceWide : RIS_AGE_TOLERANCE_WIDE;
  const scored = [];
  for (const p of censo || []) {
    if (!p || !p.nombre) continue;
    const s = scoreMatch(p, est, opts);
    if (s) scored.push({ p, ...s });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => _cmpKeys(_rankKey(b, tolWide), _rankKey(a, tolWide)));
  const top = scored[0];
  const ambiguous = scored.length > 1 && scored[1].p.exp !== top.p.exp && _cmpKeys(_rankKey(top, tolWide), _rankKey(scored[1], tolWide)) === 0;
  return { p: top.p, level: top.level, label: top.label, diff: top.diff, via: top.via, ambiguous, candidates: scored };
}
export function matchCenso(est, censo, opts = {}) { const m = matchCensoDetailed(est, censo, opts); return m ? m.p : null; }

// Del lado del RIS: ¿cayeron dos PERSONAS distintas del RIS en el mismo paciente del censo?
// Identidad RIS = nombre normalizado + edad. Dos identidades son la misma persona si sus nombres
// se contienen (el RIS registra a veces con un nombre de más/menos) y sus edades están a ≤ tol
// (o alguna se desconoce). Si hay 2+ personas: se descartan SOLO las que tienen edad conocida e
// incompatible con el censo cuando existe otra que sí cuadra; si ninguna cuadra (edad del censo
// mal capturada), gana el nombre más exacto (nivel), y si empatan se conservan todas (ambiguo).
export function resolveHomonyms(matched, opts = {}) {
  const tol = Number.isFinite(opts.ageTolerance) ? opts.ageTolerance : RIS_AGE_TOLERANCE_DEFAULT;
  const tolWide = Number.isFinite(opts.ageToleranceWide) ? opts.ageToleranceWide : RIS_AGE_TOLERANCE_WIDE;
  const byExp = new Map();
  for (const m of matched || []) { const k = String(m.p.exp); if (!byExp.has(k)) byExp.set(k, []); byExp.get(k).push(m); }
  const kept = [], dropped = [], ambiguous = [];
  for (const [exp, ms] of byExp) {
    const ids = [];
    for (const m of ms) {
      const nameKey = normNameTokens(m.e.nombre).slice().sort().join(" "), age = risAgeYears(m.e);
      let id = ids.find((x) => x.nameKey === nameKey && x.age === age);
      if (!id) { id = { nameKey, nombre: m.e.nombre, age, rows: [] }; ids.push(id); }
      id.rows.push(m);
    }
    if (ids.length <= 1) { kept.push(...ms); continue; }
    const parent = ids.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const samePerson = (a, b) => {
      const cov = nameCoverage(a.nombre, b.nombre);
      if (!(cov.censoCovered || cov.risCovered)) return false;
      return a.age == null || b.age == null || Math.abs(a.age - b.age) <= tol;
    };
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (samePerson(ids[i], ids[j])) parent[find(i)] = find(j);
    const groups = new Map();
    ids.forEach((id, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(id); });
    if (groups.size <= 1) { kept.push(...ms); continue; }
    const censusAge = parseCensusAge(ms[0].p.edad);
    const persons = Array.from(groups.values()).map((list) => {
      const rows = list.flatMap((x) => x.rows);
      const ages = list.map((x) => x.age).filter((a) => a != null);
      const ageDist = censusAge == null || !ages.length ? null : Math.min(...ages.map((a) => Math.abs(a - censusAge)));
      return { rows, bestLevel: Math.max(...rows.map((r) => r.level || 0)), ageDist, compat: ageCompat(ageDist, tolWide), label: `"${list[0].nombre}" ${ages.length ? ages.join("/") + " a" : "edad ?"}` };
    });
    const bestCompat = Math.max(...persons.map((x) => x.compat));
    if (bestCompat === 2) {
      const ok = persons.filter((x) => x.compat >= 1), bad = persons.filter((x) => x.compat === 0);
      for (const x of ok) kept.push(...x.rows);
      for (const x of bad) for (const m of x.rows) dropped.push({ ...m, motivo: `homónimo en el RIS: ${x.label} no cuadra con el censo (${censusAge} a); se conservó ${ok.map((o) => o.label).join(" y ")}` });
      if (ok.length > 1) ambiguous.push({ exp, cama: ms[0].p.cama, personas: ok.map((x) => x.label), motivo: "varias identidades del RIS compatibles por edad; se conservan todas" });
      continue;
    }
    persons.sort((a, b) => b.bestLevel - a.bestLevel);
    if (persons.length > 1 && persons[0].bestLevel === persons[1].bestLevel) {
      kept.push(...ms);
      ambiguous.push({ exp, cama: ms[0].p.cama, personas: persons.map((x) => x.label), motivo: censusAge == null ? "edad del censo desconocida: no se pueden separar" : "ninguna cuadra con la edad del censo y empatan en nombre" });
      continue;
    }
    kept.push(...persons[0].rows);
    for (const x of persons.slice(1)) for (const m of x.rows) dropped.push({ ...m, motivo: `homónimo en el RIS: ninguna identidad cuadra con la edad del censo (${censusAge == null ? "?" : censusAge} a); se conservó el nombre más exacto ${persons[0].label} y se descartó ${x.label}` });
  }
  return { kept, dropped, ambiguous };
}

// Diagnóstico: pacientes del censo sin estudio cuyo nombre se parece a alguna fila (≥ 2 tokens)
export function nearMisses(estudios, censo, matchedExps) {
  const out = [];
  for (const p of censo || []) {
    if (matchedExps.has(p.exp)) continue;
    const near = (estudios || []).filter((e) => nameCoverage(p.nombre, e.nombre).common >= 2).slice(0, 3)
      .map((e) => `"${e.nombre}" ${e.edad} ${e.tipoEdad} ${e.fecha} ${e.modalidad}`);
    if (near.length) out.push(`cama ${p.cama} (${p.edad || "?"} a, "${p.nombre}") ≈ ${near.join(" | ")}`);
  }
  return out;
}

// ── (c) Reportes: texto útil, estado y reintento ────────────────────────
// La descarga con la sesión caducada devuelve la página de login (HTML con texto > 60 letras):
// antes podía guardarse como "reporte". Se reconoce por el formulario o por su vocabulario.
export function looksLikeLoginPage(text, html) {
  if (/name=["']?_?(username|password)|id=["']?_?username|type=["']?password|id=["']?_submit/i.test(String(html || ""))) return true;
  const t = String(text || "");
  if (!t.trim()) return false;
  // OJO: "CERRAR SESIÓN" NO está en el vocabulario: es señal de página LOGUEADA (layout del portal), y un
  // reporte corto renderizado dentro del portal quedaría rechazado en cada corrida (pendiente eterno).
  return t.length < 1500 && /(INICIAR SESI[OÓ]N|INICIO DE SESI[OÓ]N|\bLOG ?IN\b|CONTRASE[ÑN]A|\bPASSWORD\b|\bUSUARIO\b.*\bINGRESAR\b)/i.test(t.toUpperCase());
}
export function isUsableReportText(text, html) {
  const t = String(text || "").trim();
  return t.length > 20 && !looksLikeLoginPage(t, html);
}
// Claves (documento|fecha|hora|modalidad) que YA tienen reporte útil guardado: no se vuelven a bajar.
// Un reporte vacío o inútil NO entra → la siguiente corrida lo reintenta.
export function buildHaveSet(prevRows) {
  const have = new Set();
  for (const r of prevRows || []) if (r && isUsableReportText(r.reporte)) have.add([r.documento, r.fecha, r.hora, r.modalidad].join("|"));
  return have;
}
// Estado del reporte de un estudio en esta corrida.
export function classifyReporte({ hasLink, alreadySaved, attempted, text, html, error, budgetExhausted } = {}) {
  if (alreadySaved) return { estado: REPORTE_ESTADO.OK, motivo: "ya guardado en una corrida previa" };
  if (!hasLink) return { estado: REPORTE_ESTADO.PENDIENTE_RIS, motivo: "el RIS aún no tiene reporte (sin ícono de impresora); se revisa en cada corrida" };
  if (!attempted) return { estado: REPORTE_ESTADO.PENDIENTE_DESCARGA, motivo: budgetExhausted ? "presupuesto de reportes de la corrida agotado; se reintenta en la siguiente" : "no se intentó en esta corrida; se reintenta" };
  if (isUsableReportText(text, html)) return { estado: REPORTE_ESTADO.OK, motivo: "" };
  if (looksLikeLoginPage(text, html)) return { estado: REPORTE_ESTADO.PENDIENTE_DESCARGA, motivo: "la descarga devolvió la página de login (sesión caducada); se reintenta" };
  if (error) return { estado: REPORTE_ESTADO.PENDIENTE_DESCARGA, motivo: `fallo de descarga/transcripción: ${String(error).split("\n")[0].slice(0, 200)}; se reintenta` };
  return { estado: REPORTE_ESTADO.PENDIENTE_DESCARGA, motivo: "el reporte no trajo texto (PDF escaneado o visor sin texto); se reintenta" };
}
// No pisar un reporte ya guardado con null: las filas sin reporte se mandan SIN la columna.
export function splitPayload(payload) {
  const withRep = [], noRep = [];
  for (const r of payload || []) {
    if (r.reporte) withRep.push(r);
    else { const c = { ...r }; delete c.reporte; noRep.push(c); }
  }
  return { withRep, noRep };
}
// PostgREST: PGRST204 "Could not find the 'x' column of 'ris_estudios' in the schema cache";
// Postgres: 42703 "column … does not exist".
export function isUnknownColumnError(err) {
  if (!err) return false;
  const code = String(err.code || ""), msg = String(err.message || err);
  return code === "PGRST204" || code === "42703" || /could not find the '[^']+' column|column\s+\S+\s+does not exist/i.test(msg);
}
export function stripColumns(rows, cols) {
  const drop = new Set(cols || []);
  return (rows || []).map((r) => { const c = {}; for (const k of Object.keys(r)) if (!drop.has(k)) c[k] = r[k]; return c; });
}
