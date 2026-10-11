// Ejecuta el bloque WinLab de index.html (WINLAB_ALIASES … mapWinlabReportesToLabs) aislado en Node
// sobre un reporte real (fixture sin identificadores) y compara la versión indicada.
//   node pw/mapper_harness.js <ruta/index.html> [egoOnly]
const fs = require("fs"), vm = require("vm"), path = require("path");
const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
const start = html.indexOf("    const WINLAB_ALIASES = {");
const end = html.indexOf("    // Extrae la fecha (YYYY-MM-DD) de un reporte", start);
if (start < 0 || end < 0) { console.error("no se encontró el bloque"); process.exit(2); }
const src = html.slice(start, end) + "\n;globalThis.__map = mapWinlabReportesToLabs;";
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: "winlab-block.js" });
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture_ego_bh.json"), "utf8"));
const cut = fixture.valores.findIndex(v => v.estudio === "DENSIDAD");
const egoOnly = { __cells: fixture.__cells, valores: fixture.valores.slice(cut) };          // EGO suelto
const bhOnly = { __cells: fixture.__cells, valores: fixture.valores.slice(0, cut) };        // química+BH suelto
const cases = {
  "reporte combinado (química+BH+EGO)": [fixture],
  "EGO solo": [egoOnly],
  "EGO antes que BH (dos reportes, mismo día)": [egoOnly, bhOnly],
};
const KEYS = ["hb", "leucos", "plaq", "cr", "ph", "glu", "ptot", "alt", "ast", "ck", "bd", "bi", "bun", "urea", "ego_ph", "ego_leuco", "ego_hem", "ego_prot", "ego_bact", "ego_dens", "ego_glu"];
for (const [name, reps] of Object.entries(cases)) {
  const labs = ctx.__map(reps);
  const out = {}; KEYS.forEach(k => { if (k in labs) out[k] = labs[k]; });
  console.log(name + " → " + JSON.stringify(out));
}
// Veredicto sobre el combinado y EGO-antes-que-BH
const combo = ctx.__map([fixture]);
const ordered = ctx.__map([egoOnly, bhOnly]);
const ego = ctx.__map([egoOnly]);
const ok = combo.hb === "7.70" && combo.leucos === "11.37" && combo.plaq === "472" && combo.cr === "0.52" && !("ph" in combo)
  && combo.ego_ph === "8.5" && combo.ego_prot === "30" && combo.ego_bact === "178.20" && combo.ego_dens === "1.015" && ["5", "15.84"].includes(combo.ego_leuco)
  && combo.alt === "84.0" && combo.ck === "93.0" && combo.bd === "0.41" && combo.bi === "0.04" && combo.bun === "27.0" && combo.urea === "57.8"
  && ordered.hb === "7.70" && ordered.leucos === "11.37" && !("ph" in ordered) && ordered.ego_ph === "8.5"
  && !("hb" in ego) && !("leucos" in ego) && !("ph" in ego) && !("glu" in ego) && !("ptot" in ego);
console.log(ok ? "MAPPER OK" : "MAPPER FAIL");
process.exit(ok ? 0 : 1);
