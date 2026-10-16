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

// Pendiente de drill = sin valores, o cultivo sin texto del PDF.
export function isPendingReport(row, looksLikeCultureReport) {
  if (!row || typeof row !== "object") return false;
  if (!hasValores(row)) return true;
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
  const cultivos = [], otros = [];
  const seen = new Set();
  for (const i of Array.isArray(targetIdxs) ? targetIdxs : []) {
    if (!Number.isInteger(i) || i < 0 || i >= list.length || seen.has(i)) continue;
    seen.add(i);
    const row = list[i];
    if (!isPendingReport(row, looksLikeCultureReport)) continue;
    if (isPendingCulture(row, looksLikeCultureReport)) cultivos.push(i);
    else otros.push(i);
  }
  return cultivos.concat(otros.slice(0, max)).slice(0, absMax);
}
