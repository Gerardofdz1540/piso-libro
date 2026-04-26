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
  if (EXCLUDED_ESPS.has(e)) return false;
  if (ALLOWED_ESPS.has(e)) return true;
  if (/(^|[\/\s])CG([\/\s]|$)/.test(e)) return true;
  return false;
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

// Texto que indica "no hay reportes para este paciente en el rango".
export function isNoResultsText(rawText) {
  const txt = N(rawText);
  return /NING(U|Ú)N REGISTRO ENCONTRADO/.test(txt) || /NESSUN/.test(txt);
}

// Combinacion: ¿es esta tabla irrelevante para resultados?
export function isIrrelevantTable(rawText) {
  return isMenuTableText(rawText) || isFormTableText(rawText);
}
