// ═══ O6 · ¿El 🕘 de la app publicada usa la v3 y no cae a la v2/v1? (20 oct 2026) ═══════════════════════════════
// Por qué: antes de quitar EXECUTE de pl_historial_caja (v1) y _v2 a authenticated hay que saber si la app las usa.
// Se toma el código REAL de openFieldHistory del index.html publicado (main-ro, main 1ba7520): la línea `missing` y el
// bloque try/catch que llama a _sRpc, y se corre con un _sRpc simulado que responde como PostgREST.
// Uso: node otros/06_app_historial.js [ruta/index.html]   → «RESULTADO OK: n pruebas» o la primera FALLA (exit 1)
"use strict";
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, "..", "..", "main-ro", "index.html"), "utf8");

const ini = html.indexOf("const missing = e =>");
const fin = html.indexOf("if (_histState.k !== k", ini);
if (ini < 0 || fin < 0) { console.error("FALLA: no encontré el bloque del historial en index.html"); process.exit(1); }
const bloque = html.slice(ini, fin);
// El bloque usa `rows`, `args` y `_sRpc`; se envuelve en una función async que devuelve rows.
const correr = new Function("_sRpc", "args", "return (async () => { let rows;\n" + bloque + "\nreturn rows; })();");

// PostgREST: el cliente de la app (_sPost) lanza Error("POST rpc/<f> HTTP <status> <cuerpo>").
const err = (f, status, body) => new Error("POST rpc/" + f + " HTTP " + status + " " + JSON.stringify(body));
const NEGADA = (f) => err(f, 403, { code: "42501", details: null, hint: null, message: "permission denied for function " + f });
const NO_EXISTE = (f) => err(f, 404, { code: "PGRST202", details: "Searched for the function public." + f, hint: null, message: "Could not find the function public." + f });

let n = 0;
const falla = (m) => { console.error("FALLA " + m); process.exit(1); };
(async () => {
  const args = { p_patient: "00000000-0000-4000-8000-000000000000", p_campo: "pendientes", p_limit: 40 };
  // A1 producción después del revoke: v3 existe y responde → solo se llama a la v3
  {
    const llamadas = [];
    const rpc = async (f) => { llamadas.push(f); if (f === "pl_historial_caja_v3") return [{ id: 1, de: "a", a: "b", fmt: 3 }]; throw NEGADA(f); };
    const rows = await correr(rpc, args);
    if (llamadas.join(",") !== "pl_historial_caja_v3" || !Array.isArray(rows) || rows.length !== 1) falla("A1 la app llamó " + llamadas.join(","));
    n++;
  }
  // A2 si la v3 diera un error que NO es «no existe» (p. ej. sin permiso), la app NO cae a la v2/v1: muestra el error
  {
    const llamadas = [];
    const rpc = async (f) => { llamadas.push(f); throw NEGADA(f); };
    let e = null; try { await correr(rpc, args); } catch (x) { e = x; }
    if (!e || llamadas.join(",") !== "pl_historial_caja_v3") falla("A2 con la v3 negada la app llamó " + llamadas.join(","));
    n++;
  }
  // A3 efecto del revoke si la v3 FALTARA (404): cae a la v2, recibe 403 «permission denied» y se detiene ahí (no llega a
  //    la v1); el 🕘 muestra «No se pudo cargar el historial: …». No se escribe nada.
  {
    const llamadas = [];
    const rpc = async (f) => { llamadas.push(f); if (f === "pl_historial_caja_v3") throw NO_EXISTE(f); throw NEGADA(f); };
    let e = null; try { await correr(rpc, args); } catch (x) { e = x; }
    if (!e || !/permission denied/.test(e.message) || llamadas.join(",") !== "pl_historial_caja_v3,pl_historial_caja_v2") falla("A3 " + llamadas.join(",") + " · " + (e && e.message));
    n++;
  }
  // A4 (control) la regla `missing` es la que la app usa: 404/PGRST202 sí es «no existe», 42501 no
  {
    const m = new Function("return (" + bloque.match(/const missing = (e => [^;]+);/)[1] + ")")();
    if (!m(NO_EXISTE("x")) || m(NEGADA("x"))) falla("A4 la regla missing no se comporta como se describe");
    n++;
  }
  console.log("RESULTADO OK: " + n + " pruebas (bloque de " + bloque.split("\n").length + " líneas tomado de index.html)");
})().catch((e) => falla("inesperada: " + (e && e.stack || e)));
