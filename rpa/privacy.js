// Privacidad en las bitácoras de los robots (oct 2026).
// El repositorio es público y GitHub guarda las bitácoras de Actions 90 días: lo que un robot imprime lo puede leer
// cualquiera. Por defecto NUNCA se imprimen nombres, expedientes completos, fechas de nacimiento, nombres de otros
// pacientes del hospital ni direcciones de PDF. LOG_PHI=1 los muestra SOLO en una computadora propia para depurar;
// dentro de GitHub Actions se ignora siempre.
export const LOG_PHI = process.env.LOG_PHI === "1" && !process.env.GITHUB_ACTIONS;

// Nombre → iniciales ("RUIZ SOTO MATEO" → "R.S.M.").
export function pn(name) {
  if (LOG_PHI) return String(name == null ? "" : name);
  const t = String(name == null ? "" : name).trim().split(/\s+/).filter(Boolean);
  return t.length ? t.map((w) => w.charAt(0).toUpperCase() + ".").join("") : "(sin nombre)";
}
// Expediente → últimos 3 caracteres ("24-99901" → "…901").
export function pe(exp) {
  if (LOG_PHI) return String(exp == null ? "" : exp);
  const s = String(exp == null ? "" : exp).replace(/\s+/g, "");
  return s ? "…" + s.slice(-3) : "?";
}
// Dirección o nombre de archivo (rutas de PDF de WinLab/RIS) → oculto.
export function pu(url) { return LOG_PHI ? String(url == null ? "" : url) : (url ? "(ruta oculta)" : ""); }
// Fecha de nacimiento u otro dato fino → oculto.
export function pd(v) { return LOG_PHI ? String(v == null ? "" : v) : (v ? "(oculto)" : ""); }
