// Funciones puras del scraper (sin dependencia de Playwright/Supabase).
// Separadas para poder testearlas con `node scraper.test.js` sin instalar
// las dependencias pesadas.

export const N = (s) =>
  String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

export const todayISO = () => {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
};

const ALLOWED_ESPS = new Set([
  "CG", "CCR", "CT", "CTV", "CPR", "CV", "CMF",
  "CG/GYO", "CG/CV", "GYO/CG", "CV/CG", "URG", "URGENCIAS",
]);
const EXCLUDED_ESPS = new Set([
  "NCX", "URO", "GYO", "TYO", "ONCOCIRUGIA", "ONCO",
  "COLUMNA", "ENDOS", "NEUROCX", "ORTOPEDIA", "TRAUMA",
]);
export function isAllowedEsp(esp) {
  const e = N(esp);
  if (!e) return false;
  // 24 jun 2026 — Gera: "TODOS los pacientes deben tener laboratorios". El censo (tabla
  // `patients`) YA es el piso quirúrgico activo; no hay razón para excluir por servicio.
  // Antes se excluían NCX/URO/TYO/GYO/TRASPLANTES/etc. y esos pacientes quedaban SIN labs
  // en su tarjeta (caso real: 18 pacientes nunca buscados + nombre incompleto). Ahora se
  // procesa TODO el censo con esp no vacío. Los sets ALLOWED_ESPS/EXCLUDED_ESPS se conservan
  // solo como documentación histórica (ya no filtran).
  return true;
}

export function formatDate(date, fmt = "dd/MM/yyyy") {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return fmt.replace("dd", dd).replace("MM", mm).replace("yyyy", yyyy);
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Deduplica records por la clave de conflict (default "exp,fecha"). Si hay
// duplicados (ej. tu censo tiene 2 pacientes con el mismo expediente),
// merge los reportes en una sola fila para evitar el error 21000 de
// Postgres "ON CONFLICT DO UPDATE command cannot affect row a second time".
export function dedupRecords(records, conflictCols = "exp,fecha") {
  const keys = conflictCols.split(",").map((s) => s.trim()).filter(Boolean);
  const map = new Map();
  for (const r of records) {
    const k = keys.map((c) => String(r[c] || "")).join("|");
    if (!map.has(k)) {
      map.set(k, r);
      continue;
    }
    const prev = map.get(k);
    const prevReportes = (prev.data && Array.isArray(prev.data.reportes)) ? prev.data.reportes : [];
    const currReportes = (r.data && Array.isArray(r.data.reportes)) ? r.data.reportes : [];
    const seen = new Set();
    const dedupReportes = [];
    for (const rep of [...prevReportes, ...currReportes]) {
      const sig = JSON.stringify(rep.__cells || rep);
      if (seen.has(sig)) continue;
      seen.add(sig);
      dedupReportes.push(rep);
    }
    const aliases = [
      ...(Array.isArray(prev.data?.aliases) ? prev.data.aliases : [prev.paciente].filter(Boolean)),
      r.paciente,
    ].filter(Boolean);
    map.set(k, {
      ...prev,
      paciente: prev.paciente || r.paciente,
      data: {
        ...(prev.data || {}),
        ...(r.data || {}),
        aliases: Array.from(new Set(aliases)),
        reportes: dedupReportes,
      },
    });
  }
  return Array.from(map.values());
}

// ── Discriminadores de tablas WinLab (funciones puras testeables) ─────
// La pagina ElencoRefertiLite tiene 6+ tablas; debemos elegir solo la de
// resultados, excluyendo el menu superior, el formulario de busqueda, y
// los layouts de spacing que ASP.NET WebForms genera.

// Texto del menu superior global de WinLab.
export function isMenuTableText(rawText) {
  return N(rawText).includes("INICIO REPORTES AYUDA");
}

// Texto del formulario de busqueda Y de la "lista vacia" post-search
// (varios labels juntos). WinLab cambia "BUSCA REPORTES" -> "LISTA REPORTES"
// despues de aplicar filtro, ambos son menu/header, no datos.
export function isFormTableText(rawText) {
  const txt = N(rawText).slice(0, 1500);
  const FORM_MARKERS = [
    "BUSCA REPORTES",
    "LISTA REPORTES",
    "TODAS LAS UNIDADES ORGANIZATIVAS",
    "PACIENTE APELLIDO NOMBRE",
    "FECHA REPORTE DE A",
    "CON RESULTADOS",
    "UNIDAD SOLICITANTE",
    "CODIGO PACIENTE",
    "REPORTES IMPRESOS",
    "FECHA DE TOMA",
    "CODIGO TOMA",
  ];
  let hits = 0;
  for (const m of FORM_MARKERS) if (txt.includes(m)) hits++;
  return hits >= 2;
}

// Verifica si una "fila" extraida es realmente data o solo metadata
// tecnica (COL_X / __hasLink / __rowIdxInTable). Lo usamos para no
// guardar basura en winlab_labs.
export function isMeaningfulReportRow(row) {
  if (!row || typeof row !== "object") return false;
  const technicalKeys = new Set(["__cells", "__hasLink", "__rowIdxInTable"]);

  // Si __cells tiene >= 2 celdas con contenido real, la fila tiene datos
  // aunque los headers hayan caido en fallback COL_X. __cells contiene el
  // texto crudo de cada <td> — es la fuente mas confiable de si hay data.
  if (Array.isArray(row.__cells) && row.__cells.length > 0) {
    const GARBAGE = /^(LISTA|BUSCA) REPORTES|TODAS LAS UNIDADES|^(INICIO|REPORTES|AYUDA|CIERRA)$/;
    const realCells = row.__cells.filter(
      (c) => c && typeof c === "string" && c.trim() && !GARBAGE.test(c)
    );
    if (realCells.length >= 2) return true;
  }

  for (const [key, val] of Object.entries(row)) {
    if (technicalKeys.has(key)) continue;
    if (/^COL_\d+$/.test(key)) continue;          // header generico = no real
    if (val === null || val === undefined || val === "") continue;
    if (typeof val === "string" && /^(LISTA|BUSCA) REPORTES/.test(val)) continue;
    if (typeof val === "string" && val.includes("TODAS LAS UNIDADES")) continue;
    return true; // hay al menos 1 campo con data real
  }
  return false;
}

// Extrae candidatos de "apellido" de un nombre completo.
// Convencion mexicana: "NOMBRE(s) APELLIDO_PATERNO APELLIDO_MATERNO"
// Devuelve array de candidatos en orden de preferencia:
//   1) "APELLIDO_PATERNO APELLIDO_MATERNO" (las 2 ultimas palabras)
//   2) "APELLIDO_PATERNO" (solo penultima)
// Util para fallback cuando codigo paciente no matchea.
export function extractApellidos(nombre) {
  if (!nombre) return [];
  // 24 jun 2026 — FIX cobertura: quitar ACENTOS/diéresis (Ñ→N) del término de búsqueda.
  // WinLab busca/almacena sin acentos; sin esto "RODRÍGUEZ"/"GARCÍA"/"ZUÑIGA"/"MÁRQUEZ"/
  // "PÁRAMO" se tecleaban con acento y daban NINGUN REGISTRO (los pacientes CON labs no
  // tienen acentos en el apellido — correlación clara). No agrega búsquedas (sin riesgo de
  // homónimos): solo normaliza el término existente.
  const clean = String(nombre).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const parts = clean.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  // Apellidos = últimas 2 palabras, incluyendo una PARTÍCULA líder (DE/DEL/LA/LAS/LOS/Y) si
  // precede al paterno (ej. "DEL ANGEL GOMEZ", "DE LEON MARQUEZ"), dejando >=1 palabra de nombre.
  const PART = { DE: 1, DEL: 1, LA: 1, LAS: 1, LOS: 1, Y: 1 };
  let start = parts.length - 2;
  if (start - 1 >= 1 && PART[parts[start - 1]]) start -= 1;
  out.push(parts.slice(start).join(" "));
  if (parts.length >= 3 && parts[parts.length - 2]) out.push(parts[parts.length - 2]);
  return Array.from(new Set(out));
}

// ── Match de identidad para targeting de drill-down (jun 2026) ──────────────
// WinLab busca por apellido y devuelve VARIOS pacientes homónimos. El drill-down
// debe clickear SOLO los reportes del paciente objetivo, no los primeros N a ciegas
// (causaba que p.ej. el 4º de 5 "GONZALEZ GONZALEZ" nunca se capturara y el blob
// quedara con labs de otro). Match difuso (Jaro-Winkler) tolera typos de OCR
// (ESEQUIEL≈EZEQUIEL) sin confundir personas distintas (nombre de pila diferente).
export function normNameTokens(name) {
  if (!name) return [];
  const s = String(name).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\./g, " ").replace(/[^A-Z\s]/g, " ")
    .replace(/\bMA\b/g, "MARIA").replace(/\bJ\b/g, "JOSE").replace(/\bGPE\b/g, "GUADALUPE");
  return s.split(/\s+/).filter((w) => w.length >= 3 &&
    !["DEL", "LAS", "LOS", "CON", "SIN", "POR", "PARA", "Y", "O"].includes(w));
}
function _jaro(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const dist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - dist), hi = Math.min(i + dist + 1, lb);
    for (let j = lo; j < hi; j++) { if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; matches++; break; } }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) { if (!ma[i]) continue; while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}
export function jaroWinkler(a, b) {
  const j = _jaro(a, b); if (j < 0.7) return j;
  let p = 0; const l = Math.min(4, a.length, b.length);
  while (p < l && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}
function _tokenMatch(t1, t2) {
  if (t1 === t2) return true;
  if (t1.length >= 5 && t2.length >= 5) return jaroWinkler(t1, t2) >= 0.88;
  return false;
}
// ¿el nombre del encabezado corresponde al paciente objetivo? (TODOS los tokens del
// objetivo deben matchear, difuso). Precisión > recall.
export function patientHeaderMatches(headerName, targetNombre) {
  const t = normNameTokens(targetNombre), h = normNameTokens(headerName);
  if (!t.length || !h.length) return false;
  const used = new Array(h.length).fill(false);
  let common = 0;
  for (const tk of t) {
    for (let j = 0; j < h.length; j++) { if (!used[j] && _tokenMatch(tk, h[j])) { used[j] = true; common++; break; } }
  }
  return common >= t.length;
}
// Extrae "APELLIDOS NOMBRE" de una fila-encabezado usando la posición de FEMENINO/MASCULINO
// (mismo método que el bookmarklet): apellidos = cell[sx-2], nombre = cell[sx-1].
export function extractHeaderName(cells) {
  if (!Array.isArray(cells)) return "";
  const sx = cells.findIndex((c) => { const u = String(c || "").toUpperCase().trim(); return u === "FEMENINO" || u === "MASCULINO"; });
  if (sx >= 2 && cells[sx - 2]) return String(cells[sx - 2]) + " " + String(cells[sx - 1] || "");
  return "";
}

// Genera variantes del codigo paciente para probar en WinLab. El censo
// guarda formatos como "26-06437" (con guion). WinLab puede esperar
// el numero sin guion ("2606437") o solo la parte numerica final.
export function expVariants(exp) {
  if (!exp) return [];
  const e = String(exp).trim();
  const variants = [e];
  if (e.includes("-")) {
    const noDash = e.replace(/-/g, "");
    if (noDash !== e) variants.push(noDash);
    // Tambien la parte despues del ultimo guion (ej. "06437" de "26-06437")
    const tail = e.split("-").pop();
    if (tail && tail !== e) variants.push(tail);
  }
  return Array.from(new Set(variants));
}

// Texto que indica "no hay reportes para este paciente en el rango".
export function isNoResultsText(rawText) {
  const txt = N(rawText);
  return /NING(U|Ú)N REGISTRO ENCONTRADO/.test(txt) || /NESSUN/.test(txt);
}

// Combinacion: ¿es esta tabla irrelevante para resultados?
export function isIrrelevantTable(rawText) {
  return isMenuTableText(rawText) || isFormTableText(rawText);
}
