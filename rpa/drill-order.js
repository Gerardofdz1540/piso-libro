// ═══════════════════════════════════════════════════════════════════════
// piso-libro · orden de drill-down por paciente (funciones PURAS, sin Playwright)
//
// CULTIVOS PRIMERO (oct 2026). WinLab lista los refertos del más reciente al más viejo y
// el scraper abre (drillea) como máximo WL_DRILLDOWN_MAX de los pendientes por corrida.
// Un cultivo tarda 5-7 días de incubación, así que su referto queda DETRÁS de los labs
// diarios (BH, QS, gases...) de un paciente de UCI/piso con muchos estudios: con más de
// WL_DRILLDOWN_MAX pendientes el `slice(0, max)` lo dejaba fuera corrida tras corrida y
// la app nunca mostraba germen/antibiograma (que solo viven en el PDF del referto).
//
// Regla: primero TODOS los cultivos pendientes (sin texto del PDF), después el resto de
// pendientes en su orden original (recencia). El tope `max` aplica solo a los no-cultivo;
// los cultivos entran siempre, hasta un tope ABSOLUTO de max + extraCultivos (por defecto
// +6) para no reventar el presupuesto de tiempo por paciente. El soft-deadline del
// scraper sigue cortando si se agota el tiempo: por eso los cultivos van al frente.
//
// `looksLikeCultureReport` vive en lib.js y se pasa por parámetro (solo reconoce un
// cultivo por sus `valores`, es decir, un referto que ya se drilleó al menos una vez).
// ═══════════════════════════════════════════════════════════════════════

export const DRILL_EXTRA_CULTIVOS = 6;

const hasValores = (row) => !!row && Array.isArray(row.valores) && row.valores.length > 0;

// Cultivo cuyo PDF (germen + antibiograma + texto íntegro) aún no se guardó.
export function isPendingCulture(row, looksLikeCultureReport) {
  if (!row || typeof row !== "object") return false;
  if (typeof looksLikeCultureReport !== "function") return false;
  return !row.cultivo_texto && looksLikeCultureReport(row) === true;
}

// Cultivo ya leído pero AÚN EN PROCESO en el laboratorio (7 nov 2026, «no se están actualizando los cultivos»). Antes,
// en cuanto el PDF tenía texto, el referto dejaba de ser pendiente y el robot ya no volvía a abrirlo: si WinLab lo tenía
// «en proceso» (o con un frasco positivo y otro en proceso, o con el germen preliminar y el antibiograma pendiente), el
// resultado final nunca llegaba a la app. En proceso = alguna sección del lector quedó PENDIENTE (o el resumen, si no hay
// secciones) o el texto dice «en proceso / en curso / preliminar». «SIN MUESTRA» no cuenta: no va a cambiar. Solo los
// recientes (≤ CULTIVO_REVISAR_DIAS por la primera fecha de la fila): uno que nunca se cierra no se revisa para siempre.
export const CULTIVO_REVISAR_DIAS = 21;
export const DRILL_REVISAR_CULTIVOS = 4;   // por paciente y corrida, DESPUÉS de los refertos nuevos (no les quita lugar)
const EN_PROCESO_RE = /\bEN\s+PROCESO\b|\bEN\s+CURSO\b|\bPRELIMINAR\b|\bPENDIENTES?\b/i;
export const DRILL_REVISAR_TEXTOS = 2;   // reportes sin valores (solo texto o solo antígenos): por paciente y corrida, después de los cultivos
function fechaFila(row) {
  for (const c of (row && Array.isArray(row.__cells)) ? row.__cells : []) {
    const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(c || ""));
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  }
  return null;
}
export function isCultureInProcess(row, hoy = Date.now()) {
  if (!row || typeof row !== "object" || !row.cultivo_texto) return false;
  const c = row.cultivo && typeof row.cultivo === "object" ? row.cultivo : null;
  const secs = c && Array.isArray(c.secciones) ? c.secciones : [];
  // «Antibiograma pendiente» también cuenta (EN_PROCESO_RE incluye PENDIENTE, como palabra completa).
  const enProceso = (secs.length ? secs.some((s) => s && s.resultado === "PENDIENTE") : !!(c && c.resultado === "PENDIENTE"))
    || EN_PROCESO_RE.test(String(row.cultivo_texto));
  if (!enProceso) return false;
  const f = fechaFila(row);
  if (f === null) return true;
  const dias = Math.floor(hoy / 86400000) - Math.floor(f / 86400000);   // días de calendario, no horas
  return dias <= CULTIVO_REVISAR_DIAS;
}

// Reporte ya abierto SIN valores (solo reporte_texto o solo antígenos, 19 nov 2026): WinLab puede completarlo después
// («Muestra enviada a laboratorio de referencia» → «45 copias/mL»), así que se vuelve a abrir al final de cada corrida
// mientras sea reciente (≤ CULTIVO_REVISAR_DIAS), con su propio cupo (DRILL_REVISAR_TEXTOS) después de los cultivos.
export function isTextReportInProcess(row, hoy = Date.now()) {
  if (!row || typeof row !== "object" || hasValores(row) || row.cultivo_texto) return false;
  if (!row.reporte_texto && !(Array.isArray(row.antigenos) && row.antigenos.length)) return false;
  const f = fechaFila(row);
  if (f === null) return true;
  return Math.floor(hoy / 86400000) - Math.floor(f / 86400000) <= CULTIVO_REVISAR_DIAS;
}
// Valores escritos por el lector viejo con el nombre del analito PARTIDO ("CEFALORRAQUIDEO" 28 U/L = DHL en LCR):
// sin texto guardado no se pueden re-leer → se vuelven a abrir (el lector nuevo ya no produce estos nombres). Solo
// reportes de ≤ CULTIVO_REVISAR_DIAS días: un formato que aún los produjera no se reabre para siempre.
const STALE_FLUID_NAME_RE = /^(CEFALORRAQU[IÍ]DEO|PERITONEAL|PLEURAL|AS[CS][IÍ]TICO|SINOVIAL|PERIC[AÁ]RDICO)$/i;
// (El recuento celular viejo sin nombre de líquido NO se reabre: el lector de hoy también puede dejarlo sin sección y
// se reabriría en cada corrida. La app lo reconoce por su referencia, ver _wlValEsCelLiquido en index.html.)
export function hasStaleFluidValores(row, hoy = Date.now()) {
  if (!hasValores(row) || row.cultivo_texto) return false;
  if (!row.valores.some((v) => v && STALE_FLUID_NAME_RE.test(String(v.estudio || "").trim()))) return false;
  const f = fechaFila(row);
  return f === null || Math.floor(hoy / 86400000) - Math.floor(f / 86400000) <= CULTIVO_REVISAR_DIAS;
}
// Pendiente de drill = sin valores, o cultivo sin texto del PDF. Un reporte ya abierto que solo dejó cultivo_texto o
// reporte_texto (sin valores) NO es pendiente: antes se reabría en cada corrida (21-29 % de los PDFs leídos).
export function isPendingReport(row, looksLikeCultureReport, hoy = Date.now()) {
  if (!row || typeof row !== "object") return false;
  if (!hasValores(row)) return !row.cultivo_texto && !row.reporte_texto && !(Array.isArray(row.antigenos) && row.antigenos.length);
  if (hasStaleFluidValores(row, hoy)) return true;
  return isPendingCulture(row, looksLikeCultureReport);
}

// Devuelve los índices (sobre `rows`) a drillear, en orden: cultivos pendientes primero
// (orden original entre ellos), luego los demás pendientes por recencia (orden original).
//   - `max`: tope para los NO-cultivo (WL_DRILLDOWN_MAX). No finito → sin tope.
//   - `extraCultivos`: cuántos cultivos pueden sumarse por encima de `max`; el total
//     devuelto nunca supera max + extraCultivos (los cultivos van al frente, así que el
//     recorte absoluto quita primero no-cultivos y solo después cultivos).
export function orderDrillCandidates(rows, targetIdxs, opts = {}) {
  const { looksLikeCultureReport } = opts;
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : Infinity;
  const extra = Number.isFinite(opts.extraCultivos) ? Math.max(0, Math.floor(opts.extraCultivos)) : DRILL_EXTRA_CULTIVOS;
  const absMax = max + extra;
  const list = Array.isArray(rows) ? rows : [];
  const revisar = Number.isFinite(opts.revisarCultivos) ? Math.max(0, Math.floor(opts.revisarCultivos)) : DRILL_REVISAR_CULTIVOS;
  const hoy = Number.isFinite(opts.hoy) ? opts.hoy : Date.now();
  const cultivos = [], otros = [], enProceso = [], textos = [];
  const revisarTextos = Number.isFinite(opts.revisarTextos) ? Math.max(0, Math.floor(opts.revisarTextos)) : DRILL_REVISAR_TEXTOS;
  const seen = new Set();
  for (const i of Array.isArray(targetIdxs) ? targetIdxs : []) {
    if (!Number.isInteger(i) || i < 0 || i >= list.length || seen.has(i)) continue;
    seen.add(i);
    const row = list[i];
    if (isCultureInProcess(row, hoy)) { enProceso.push(i); continue; }
    if (isTextReportInProcess(row, hoy)) { textos.push(i); continue; }
    if (!isPendingReport(row, looksLikeCultureReport, hoy)) continue;
    if (isPendingCulture(row, looksLikeCultureReport)) cultivos.push(i);
    else otros.push(i);
  }
  // Los cultivos en proceso se revisan al final: un referto nuevo nunca pierde su lugar por ellos (y dentro del tope total).
  return cultivos.concat(otros.slice(0, max)).slice(0, absMax).concat(enProceso.slice(0, revisar)).concat(textos.slice(0, revisarTextos));
}
