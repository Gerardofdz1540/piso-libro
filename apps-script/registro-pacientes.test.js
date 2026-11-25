// Pruebas offline del registro de pacientes (sin Google, sin Supabase, datos FICTICIOS).
// Carga registro-pacientes.gs en un sandbox con:
//   - una hoja de cálculo en memoria estricta como Google: cuadrícula de 1000×26 al crear una pestaña, fuera de ella
//     getRange falla; en texto plano las cadenas se guardan tal cual;
//   - un PostgREST simulado: filtros (gte/gt/eq/not.is.null, or=(…) de la paginación por llave, ->>), orden por varias
//     columnas comparando fechas por valor, tope de 1000 filas por petición, sin offset (si el script lo usa, falla),
//     errores 4xx/5xx con su código, 57014 (tiempo de la base agotado) y borrados entre dos páginas;
//     24 nov 2026: alias de ruta JSON de varios saltos (a:diff->checklist->atb), or=(col.in.(…),arr.ov.{…}) y varios
//     «or» en la misma consulta, para el historial de auditoría (audit_log);
//   - UrlFetchApp que rechaza las URLs que Google rechaza; un reloj simulado para los presupuestos de tiempo.
// Verifica: episodios, pestañas, fusión que nunca borra (Vigente), escritura segura e incremental, lecturas por cursor
// reanudables, WinLab con la regla de identidad de la app, respaldo semanal y que nada de pacientes llegue al registro.
//   node apps-script/registro-pacientes.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "registro-pacientes.gs"), "utf8");

function makeSpreadsheet(id) {
  const sheets = {};
  function makeSheet(name) {
    const sh = { name, cells: [], fmt: {}, maxR: 1000, maxC: 26, writes: 0 };
    sh.getLastRow = () => { let n = sh.cells.length; while (n > 0 && !(sh.cells[n - 1] || []).some((v) => v !== "" && v !== undefined)) n--; return n; };
    sh.getLastColumn = () => sh.cells.reduce((m, r) => { let n = (r || []).length; while (n > 0 && (r[n - 1] === "" || r[n - 1] === undefined)) n--; return Math.max(m, n); }, 0);
    sh.getMaxRows = () => sh.maxR; sh.getMaxColumns = () => sh.maxC;
    sh.insertRowsAfter = (after, n) => { sh.maxR += n; return sh; };
    sh.insertColumnsAfter = (after, n) => { sh.maxC += n; return sh; };
    sh.deleteColumns = (desde, n) => {
      if (desde < 1 || n < 1 || desde - 1 + n > sh.maxC || desde === 1 && n === sh.maxC) throw new Error("Exception: deleteColumns fuera de la hoja");
      sh.cells.forEach((r) => { if (r) r.splice(desde - 1, n); }); sh.maxC -= n; return sh;
    };
    sh.setFrozenRows = () => sh;
    sh.clearContents = () => { sh.cells = []; };
    sh.getRange = (r, c, nr, nc) => {
      if (r < 1 || c < 1 || nr < 1 || nc < 1 || r - 1 + nr > sh.maxR || c - 1 + nc > sh.maxC) throw new Error("Exception: The coordinates of the range are outside the dimensions of the sheet.");
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const row = sh.cells[r - 1 + i] || []; const v = row[c - 1 + j]; return v === undefined ? "" : v; })),
        setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.fmt[(r + i) + ":" + (c + j)] = f; return range; },
        setNumberFormats: (m) => {
          if (!Array.isArray(m) || m.length !== nr || m.some((row) => !Array.isArray(row) || row.length !== nc || row.some((f) => typeof f !== "string" || !f))) throw new Error("setNumberFormats: tamaño o formato inválido");
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.fmt[(r + i) + ":" + (c + j)] = m[i][j]; return range;
        },
        setValues: (vals) => {
          if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error("setValues: tamaño distinto al rango");
          if (state0.failWriteOn === sh.name) throw new Error("Exception: Service Spreadsheets timed out");
          if (state0.st && state0.st.msPorEscritura) state0.st.reloj += state0.st.msPorEscritura;
          if (state0.st && state0.st.alEscribir) state0.st.alEscribir(sh.name, nr);
          sh.writes++; sh.filasEscritas = (sh.filasEscritas || 0) + nr;
          vals.forEach((row, i) => { sh.cells[r - 1 + i] = sh.cells[r - 1 + i] || []; row.forEach((v, j) => {
            const texto = sh.fmt[(r + i) + ":" + (c + j)] === "@";
            // Como Google: en texto plano se guarda tal cual; fuera de texto plano «=…» sería fórmula y «'» se quita.
            if (!texto && typeof v === "string" && v[0] === "=") throw new Error("se escribió una fórmula: " + v.slice(0, 20));
            if (typeof v === "string" && v.length > 50000) throw new Error("Exception: celda de más de 50000 caracteres");
            sh.cells[r - 1 + i][c - 1 + j] = (!texto && typeof v === "string" && v[0] === "'") ? v.slice(1) : v;
          }); });
          return range;
        },
        clearContent: () => { for (let i = 0; i < nr; i++) { const row = sh.cells[r - 1 + i]; if (row) for (let j = 0; j < nc; j++) row[c - 1 + j] = ""; } return range; }
      };
      return range;
    };
    return sh;
  }
  const ss = { sheets, id: id || "libro1", getId() { return this.id; }, getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => { if (sheets[n]) throw new Error("Exception: ya existe la hoja " + n); return (sheets[n] = makeSheet(n)); } };
  ss.getSheets = () => Object.values(sheets);
  return ss;
}
const state0 = {};
// URL que UrlFetchApp acepta: esquema y host simples; ruta y consulta solo con caracteres de RFC 3986 (sin [ ] # en la
// consulta) y cada % seguido de dos dígitos hexadecimales.
function urlValida(url) {
  const m = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9\-._~!$&'()*+,;=:@\/%]*)(\?[A-Za-z0-9\-._~!$&'()*+,;=:@\/?%]*)?$/.exec(url);
  return !!m && !/%(?![0-9A-Fa-f]{2})/.test(url);
}
// Comparación como Postgres: marcas de tiempo por valor (no como texto: «…+00:00» vs «…Z»), números como números.
function cmpPg(a, b) {
  const esTs = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(x);
  if (esTs(a) && esTs(b)) return Date.parse(a.replace(" ", "T")) - Date.parse(b.replace(" ", "T"));
  if ((typeof a === "number" || typeof b === "number") && !isNaN(Number(a)) && !isNaN(Number(b))) return Number(a) - Number(b);
  return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
}
// PostgREST simulado sobre state.db (solo lo que usa el script). Devuelve { status, body }.
function postgrest(state, url, headers) {
  const u = new URL(url);
  const tabla = /\/rest\/v1\/([a-z_]+)$/.exec(u.pathname)[1];
  let sel = "", orden = [], lim = null;
  const filtros = [];
  for (const [k, v] of u.searchParams) {
    if (k === "select") sel = v;
    else if (k === "order") orden = v.split(",").map((x) => x.replace(/\.asc$/, ""));
    else if (k === "limit") lim = +v;
    else if (k === "offset") { state.usoOffset = true; return { status: 400, body: { code: "OFFSET", message: "el script no debe paginar con offset" } }; }
    else if (k === "or") {
      const m = /^\(([a-z_]+)\.gt\."([^"]*)",and\(\1\.eq\."([^"]*)",([a-z_]+)\.gt\."([^"]*)"\)\)$/.exec(v);
      // 24 nov 2026 (auditoría): or=(col.in.(A,B),arr.ov.{x,y}) — `in` sobre texto y `ov` (traslape) sobre text[]. Como en
      // PostgREST, varios «or» en la misma consulta se suman con AND (aquí: este y el de la paginación por llave).
      const m2 = /^\(([a-z_]+)\.in\.\(([^()]*)\),([a-z_]+)\.ov\.\{([^{}]*)\}\)$/.exec(v);
      if (m) filtros.push((x) => cmpPg(x[m[1]], m[2]) > 0 || (cmpPg(x[m[1]], m[3]) === 0 && cmpPg(x[m[4]], m[5]) > 0));
      else if (m2) { const lista = m2[2].split(","), arr = m2[4].split(","); filtros.push((x) => lista.includes(String(x[m2[1]])) || (Array.isArray(x[m2[3]]) && x[m2[3]].some((c) => arr.includes(c)))); }
      else return { status: 400, body: { code: "PGRST100", message: "or mal formado" } };
    } else {
      const ruta = /^([a-z_]+)->>([a-z_]+)$/.exec(k);
      const valor = (x) => ruta ? ((x[ruta[1]] || {})[ruta[2]]) : x[k];
      let m;
      if (v === "not.is.null") filtros.push((x) => valor(x) !== null && valor(x) !== undefined);
      else if ((m = /^in\.\((.*)\)$/.exec(v))) { const lista = m[1].split(",").map((x) => x.replace(/^"|"$/g, "")); filtros.push((x) => lista.includes(String(valor(x)))); }
      else if ((m = /^(gte|gt|eq|lt)\.(.*)$/.exec(v))) filtros.push((x) => { const c = cmpPg(valor(x), m[2]); return valor(x) !== null && valor(x) !== undefined && (m[1] === "gte" ? c >= 0 : m[1] === "gt" ? c > 0 : m[1] === "lt" ? c < 0 : c === 0); });
      else return { status: 400, body: { code: "PGRST100", message: "filtro desconocido " + k } };
    }
  }
  if (!sel || !orden.length || lim === null) return { status: 400, body: { code: "PGRST100", message: "falta select/order/limit" } };
  let filas = (state.db[tabla] || []).filter((x) => filtros.every((f) => f(x)));
  // Como PostgREST: una columna que no existe (en el filtro o en el select) es 400 con 42703.
  const cols = state.columnas && state.columnas[tabla];
  if (cols) {
    const usadas = [...u.searchParams].filter(([k]) => !["select", "order", "limit", "or"].includes(k)).map(([k]) => k.split("->")[0]).concat(sel.split(",").map((c) => c.split(":").pop().split("->")[0]));
    if (usadas.some((c) => !cols.includes(c))) return { status: 400, body: { code: "42703", message: "column does not exist" } };
  }
  // Conteo sin cuerpo (24 nov 2026): limit=0 con «Prefer: count=exact» → «[]» y el total en Content-Range.
  if (lim === 0) {
    if (!headers || headers.Prefer !== "count=exact") return { status: 400, body: { code: "PGRST100", message: "limit=0 sin Prefer: count=exact" } };
    return { status: 200, body: [], headers: { "Content-Range": "*/" + filas.length } };
  }
  filas.sort((x, y) => { for (const c of orden) { const d = cmpPg(x[c], y[c]); if (d) return d; } return 0; });
  filas = filas.slice(0, Math.min(lim, 1000));   // max_rows de Supabase
  // Proyección estricta (24 nov 2026) en las tablas nuevas y en todo select con alias de ruta JSON (a:col->>k, a:col->k):
  // la respuesta trae SOLO lo pedido (así una columna privada que no se pide no puede llegar a la hoja).
  const estricta = ["guardia_cortes", "archive_eliminados", "audit_log"].includes(tabla) || (/:[a-z_]+->/.test(sel) && !/de:patient_data->>_supa_id|reportes:data->reportes/.test(sel));
  if (estricta) filas = filas.map((x) => Object.fromEntries(sel.split(",").map((c) => {
    // Alias y ruta JSON de uno o más saltos (a:diff->checklist->atb): -> devuelve JSON, ->> texto.
    const m = /^(?:([a-z_0-9]+):)?([a-z_]+)((?:->>?[a-z_]+)*)$/i.exec(c);
    if (!m) throw new Error("select no entendido: " + c);
    let v = x[m[2]], ultimo = m[2];
    for (const h of m[3].match(/->>?[a-z_]+/gi) || []) {
      const texto = h.startsWith("->>"); ultimo = h.replace(/^->>?/, "");
      v = v !== null && typeof v === "object" ? v[ultimo] : undefined;
      if (texto && v !== null && v !== undefined && typeof v !== "string") v = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    return [m[1] || ultimo, v === undefined ? null : v];
  })));
  if (/de:patient_data->>_supa_id/.test(sel)) filas = filas.map((a) => ({ id: a.id, de: (a.patient_data || {})._supa_id || null, a: (a.note_data || {})._restaurado_a || null }));
  else if (/reportes:data->reportes/.test(sel)) filas = filas.map((w) => ({ id: w.id, exp: w.exp, paciente: w.paciente, fecha: w.fecha, scraped_at: w.scraped_at, reportes: (w.data || {}).reportes }));
  return { status: 200, body: JSON.parse(JSON.stringify(filas)) };
}
function makeDate(state) {
  const R = Date;
  class D extends R {
    constructor(...a) { if (!a.length && state.reloj !== undefined) super(state.reloj); else super(...a); }
    static now() { return state.reloj !== undefined ? state.reloj : R.now(); }
  }
  return D;
}

function makeSandbox(state) {
  const calls = [], logs = [], triggers = state.triggers || (state.triggers = []);
  const ss = state.ss || (state.ss = makeSpreadsheet());
  state.props = state.props || {};
  state.drive = state.drive || { files: [], trashed: [] };
  state0.failWriteOn = state.failWriteOn || null;
  state0.st = state;
  const sb = {
    console, JSON, Math, Date: makeDate(state), Object, Array, String, Number, RegExp, isNaN, encodeURIComponent, decodeURIComponent,
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k === "SUPABASE_KEY" ? (state.sinLlave ? null : "svc") : (state.props[k] === undefined ? null : state.props[k])),
      setProperty: (k, v) => { if (typeof v !== "string") throw new Error("setProperty: valor no es texto"); if (v.length > 9000) throw new Error("Exception: propiedad de más de 9 KB"); state.props[k] = v; },
      deleteProperty: (k) => { delete state.props[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.ocupado, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => "America/Mexico_City" },
    // computeDigest como Google: arreglo de bytes CON signo (-128..127).
    Utilities: { formatDate: () => state.hoy || "2026-10-21", getUuid: () => "uuid-" + (state.nUuid = (state.nUuid || 0) + 1),
      DigestAlgorithm: { SHA_256: "SHA_256" }, Charset: { UTF_8: "UTF_8" },
      computeDigest: (alg, texto, cs) => { if (alg !== "SHA_256" || cs !== "UTF_8" || typeof texto !== "string") throw new Error("computeDigest: argumentos"); return Array.from(require("crypto").createHash("sha256").update(texto, "utf8").digest()).map((b) => (b > 127 ? b - 256 : b)); } },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (state.standalone ? null : ss),
      openById: (id) => { if (state.idMalo) throw new Error("Exception: Unexpected error while getting the method or property openById on object SpreadsheetApp."); state.abiertoPorId = id; return ss; },
      getUi: () => ({ createMenu: () => { const m = { items: [], addItem: (a, b) => { m.items.push(b); return m; }, addToUi: () => { state.menu = m.items; } }; return m; } })
    },
    DriveApp: {
      getFileById: (id) => {
        if (state.driveFalla) throw new Error("Exception: Drive no disponible");
        const carpeta = { getFiles: () => { const fs2 = state.drive.files.filter((f) => !f.trashed); let i = 0; return { hasNext: () => i < fs2.length, next: () => fs2[i++] }; } };
        return { getName: () => "Registro de pacientes", getParents: () => { let d = false; return { hasNext: () => !d, next: () => { d = true; return carpeta; } }; },
          makeCopy: (name) => { const f = { name, trashed: false, getName: () => name, setTrashed: (t) => { f.trashed = t; if (t) state.drive.trashed.push(name); } }; state.drive.files.push(f); return f; } };
      }
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => ({ timeBased: () => ({
        everyDays: (d) => ({ atHour: (h) => ({ create: () => { const t = { fn, d, h, getHandlerFunction: () => fn }; triggers.push(t); return t; } }) }),
        after: (ms) => ({ create: () => { if (triggers.length >= 20) throw new Error("Exception: This script has too many triggers."); const t = { fn, after: ms, getHandlerFunction: () => fn }; triggers.push(t); (state.continuaciones = state.continuaciones || []).push(ms); return t; } })
      }) })
    },
    UrlFetchApp: {
      fetch(url, opts) {
        // Como Google (21 oct 2026, primera corrida real): una URL con caracteres fuera de RFC 3986 (>, espacio, {, |, [ en
        // la consulta…) o un % mal formado no sale: «Exception: Invalid argument: <url>».
        if (!urlValida(url)) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Invalid argument: " + url); }
        if (url.length > 2048) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Limit Exceeded: URLFetch URL Length."); }
        if (state.rechazaUrl && state.rechazaUrl.test(url)) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Invalid argument: " + url); }
        if (state.msPorFetch) state.reloj += state.msPorFetch;
        const u = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, ""));
        calls.push({ m: (opts && opts.method) || "get", raw: url, u, headers: opts && opts.headers, body: opts && opts.payload });
        // Reporte de la versión instalada (27 oct 2026): una llamada a una función de la base, no una lectura de tabla.
        if (u === "/rest/v1/rpc/pl_reportar_version") { state.versiones = (state.versiones || 0) + 1; return { getResponseCode: () => (state.versionFalla || 200), getContentText: () => '"ok"' }; }
        const tabla = /\/rest\/v1\/([a-z_]+)\?/.exec(u)[1];
        state.nLlamadas = state.nLlamadas || {}; state.nLlamadas[tabla] = (state.nLlamadas[tabla] || 0) + 1;
        if (state.codigo && state.codigo[tabla]) return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ code: state.codigo[tabla], message: "column PACIENTE FICTICIO SECRETO does not exist", details: "000123" }) };
        if (state.agotado && state.agotado[tabla]) return { getResponseCode: () => 500, getContentText: () => JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }) };
        if (state.cortada && state.cortada[tabla]) return { getResponseCode: () => 200, getContentText: () => '[{"nombre":"PRUEBA FICTICIA SECRETA","exp":"000123"' };
        if (state.falla && state.falla[tabla]) return { getResponseCode: () => state.falla[tabla], getContentText: () => JSON.stringify({ message: "detalle con PACIENTE FICTICIO SECRETO" }) };
        const lim = +(/[?&]limit=(\d+)/.exec(u) || [0, 0])[1];
        if (state.maxFilas && state.maxFilas[tabla] !== undefined && lim > state.maxFilas[tabla]) throw new Error("Exception: Response too large");
        const r = postgrest(state, url, opts && opts.headers);
        if (state.alResponder) state.alResponder(tabla, state.nLlamadas[tabla], state.db);
        return { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body), getHeaders: () => r.headers || {} };
      }
    }
  };
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  return { sb, ss, calls, logs, triggers };
}

let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); } }
const tab = (ss, n) => { const sh = ss.sheets[n]; if (!sh || !sh.cells.length) return []; const h = sh.cells[0]; return sh.cells.slice(1).filter((r) => r && r.some((v) => v !== "")).map((r) => Object.fromEntries(h.map((c, i) => [c, r[i] === undefined ? "" : r[i]]))); };
// «Integridad» (24 nov 2026) gana una fila en CADA corrida (es su historial): no entra en la comparación de «hoja igual».
const snap = (ss) => JSON.stringify(Object.fromEntries(Object.keys(ss.sheets).filter((n) => n !== "Integridad").sort().map((n) => [n, ss.sheets[n].cells])));

// ─── Datos FICTICIOS ─────────────────────────────────────────────────────────────────────────────────────────────
const PDF = "data:application/pdf;base64," + "A".repeat(5000);
function db() {
  return {
    patients: [
      { id: "p1", cama: "3-201", nombre: "PRUEBA FICTICIA UNO", exp: "000123", dx: "APENDICITIS AGUDA", edad: "34", esp: "CG", adscrito: "DR. FICTICIO", residente: "R1 FICTICIO", ingreso: "2026-10-15", estado: "ESTABLE", updated_at: "2026-10-21T10:00:00+00:00" },
      { id: "p2", cama: "3-202", nombre: "PRUEBA FICTICIA DOS", exp: "000456", dx: "COLECISTITIS", edad: "61", esp: "CG", ingreso: "2026-10-20", estado: "DELICADO" },
      { id: "fantasma", cama: "3-299", nombre: "", exp: "" }
    ],
    notes: [
      { patient_id: "p1", app: "HAS", pa: "DOLOR EN FID", drenajes: "PENROSE", qx: "", manejo: "=SOLO AYUNO", pendientes: "+ USG", misc: "", updated_at: "2026-10-21T10:00:00+00:00",
        checklist: { sexo: "M", atb: true, atb_nombre: "CEFTRIAXONA", atb_dias: "3", cultivos: "HEMOCULTIVO NEGATIVO", interconsultas: "IM", dieta: "LÍQUIDOS", npo: false, tvp: true, tvp_tipo: "enoxaparina", tvp_dosis: "40 MG",
          pm_vent: false, vp_nore_on: true, vp_nore_mlh: "5",
          pm_fecha: "2026-10-21", pm_fc: "88", pm_ta: "120/80", pm_hist: [{ fecha: "2026-10-20", fc: "96", fr: "18", temp: "37.9", ta: "110/70" }, { fecha: "2026-10-19", fc: "", fr: "" }],
          nota_hist: [{ ts: "2026-10-20T14:00:00.000Z", by: "R2", ia: true, txt: "NOTA DE EVOLUCIÓN FICTICIA" }, { ts: "x", txt: "" }],
          cirugias: [{ id: "c1", fecha: "2026-10-16", procedimiento: "APENDICECTOMÍA LAPAROSCÓPICA", hallazgos: "APÉNDICE PERFORADO", sangrado: "20 ML", cirujano: "DR. FICTICIO" }, { id: "c2", fecha: "", procedimiento: "", hallazgos: "" }],
          dispositivos: [{ id: "d1", tipo: "SONDA FOLEY", fecha: "2026-10-16", foto: PDF, activo: true }],
          __ink: { cultivos: PDF },
          __pl_note_meta: { entrega: "20/10 22:00 R1: SIN EVENTOS\n\n20/10 23:00 R1: AFEBRIL" } },
        lab_history: [
          { fecha: "2026-10-16", source: "winlab", labs: { hb: "13.1", leucos: "15.2", pcr: "", cr: 0.8 }, extra: [{ nombre: "LACTATO", valor: "1.1" }], source_file: PDF },
          { fecha: "2026-10-18", labs: { hb: "12.4" } }
        ],
        imagen_history: [{ fecha: "2026-10-15", estudios: [{ tipo: "USG", descripcion: "APÉNDICE 9 MM", link: "https://pacs.ejemplo/1", file: PDF }, { tipo: "RX", descripcion: "", link: "data:image/png;base64,AAAA" }] }],
        cronologia: "16/10 08:00 R2: POSTQX INMEDIATO\n17/10 08:00 R2: TOLERA VÍA ORAL" }
    ],
    archive: [
      { id: "a1", archived_at: "2026-10-10T10:00:00+00:00", patient_data: { _supa_id: "p3", cama: "3-210", nombre: "PRUEBA FICTICIA TRES", exp: "000789", ingreso: "01/10/2026", dx: "HERNIA", estado: "ESTABLE" }, note_data: { pendientes: "VIEJO" } },
      { id: "a2", archived_at: "2026-10-12T10:00:00+00:00", patient_data: { _supa_id: "p3", cama: "3-210", nombre: "PRUEBA FICTICIA TRES", exp: "000789", ingreso: "01/10/2026", dx: "HERNIA INGUINAL", estado: "ALTA" }, note_data: { _egreso: "alta médica", _egresoFecha: "12/10/2026", pendientes: "CITA EN CONSULTA", labHistory: [{ fecha: "2026-10-11", labs: { hb: "14" } }], checklist: { cirugias: [{ fecha: "2026-10-02", procedimiento: "PLASTIA INGUINAL" }] } } },
      { id: "a3", archived_at: "2026-10-17T10:00:00+00:00", patient_data: { _supa_id: "p1", nombre: "PRUEBA FICTICIA UNO", exp: "000123" }, note_data: { _egreso: "CAMA REASIGNADA", pendientes: "COPIA VIEJA" } },
      { id: "a4", archived_at: "2026-10-05T10:00:00+00:00", patient_data: { id: "p4", nombre: "PRUEBA FICTICIA CUATRO", exp: "000999", ingreso: "2026-09-28", estado: "DEFUNCIÓN" }, note_data: { qx: "LAPAROTOMÍA EXPLORADORA", sangrado: "500 ML", lab_history: [{ fecha: "2026-09-29", labs: { hb: "7.9" } }] } },
      { id: "a5", archived_at: "2026-10-06T10:00:00+00:00", patient_data: { nombre: "", exp: "" }, note_data: {} }
    ],
    cronologia_respaldo: [{ patient_id: "p3", exp: "000789", nombre: "PRUEBA FICTICIA TRES", cronologia: "02/10 08:00 R2: POSTQX SIN EVENTOS", actualizado: "2026-10-12T06:15:00+00:00" },
      { patient_id: "p1", cronologia: "16/10 08:00 R2: POSTQX INMEDIATO\n15/10 22:00 R1: INGRESA DE URGENCIAS" }],
    procedimientos_dia: [{ id: "x1", fecha_dia: "2026-10-21", cama: "3-201", exp: "000123", nombre: "PRUEBA FICTICIA UNO", dx: "APENDICITIS", esp: "CG", added_by: "R2 FICTICIO" }],
    // winlab_labs con la forma real: data.reportes = encabezados (__hasLink:false, nombre del paciente) y reportes
    // (__cells = [.., .., folio, toma, resultado, servicio], valores). La búsqueda por apellido trae homónimos.
    winlab_labs: [
      { id: 1, exp: "000123", paciente: "PRUEBA FICTICIA UNO", fecha: "2026-10-19", scraped_at: "2026-10-19T08:00:00.123456+00:00", data: { esp: "CG", cama: "3-201", run_id: "r1", headers: ["x"], reportes: [
        { __hasLink: false, NOMBRE: "UNO", "APELLIDOS COMPLETOS": "PRUEBA FICTICIA", __cells: ["", "", "000123", "PRUEBA FICTICIA", "UNO", "MASCULINO", "15/03/1992"] },
        { __hasLink: true, __target: true, __cells: ["", "", "F100", "18/10/2026 06:10", "18/10/2026 07:00", "CIRUGIA GENERAL"], "APELLIDOS COMPLETOS": "18/10/2026 06:10", NOMBRE: "18/10/2026 07:00", SEXO: "CIRUGIA GENERAL",
          valores: [{ estudio: "HEMOGLOBINA", valor: "12.0", unidad: "g/dL", referencia: "12-16" }, { estudio: "LEUCOCITOS", valor: "11.0", unidad: "10^3/uL", referencia: "4-10" }] },
        { __hasLink: true, __target: true, __cells: ["", "", "F101", "17/10/2026 09:00", "19/10/2026 07:30", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOCULTIVO PERIFERICO", valor: "1", unidad: "DESARROLLO" }, { estudio: "NEGATIVO A", valor: "5", unidad: "DIAS" }] },
        { __hasLink: true, __cells: ["", "", "F102", "19/10/2026 05:00", "", "CIRUGIA GENERAL"] },
        { __hasLink: false, NOMBRE: "OTRO HOMONIMO", "APELLIDOS COMPLETOS": "PRUEBA FICTICIA", __cells: ["", "", "000124", "PRUEBA FICTICIA", "OTRO HOMONIMO", "MASCULINO", "02/02/1960"] },
        { __hasLink: true, __cells: ["", "", "F900", "18/10/2026 06:00", "18/10/2026 06:30", "MEDICINA INTERNA"], valores: [{ estudio: "HEMOGLOBINA", valor: "7.0", unidad: "g/dL" }] }
      ] } },
      // Captura anterior al 9 oct (sin __target): el registro aplica la regla del robot (encabezado con el nombre).
      { id: 2, exp: "000555", paciente: "PRUEBA FICTICIA CINCO", fecha: "2026-10-01", scraped_at: "2026-10-01T08:00:00+00:00", data: { reportes: [
        { __hasLink: false, __cells: ["", "", "000555", "PRUEBA FICTICIA", "CINCO", "FEMENINO", "10/10/1950"] },
        { __hasLink: true, __cells: ["", "", "F200", "01/10/2026 05:00", "01/10/2026 06:00", "MEDICINA INTERNA"], valores: [{ estudio: "CREATININA", valor: "2.1", unidad: "mg/dL", referencia: "0.6-1.2" }] }
      ] } }
    ],
    ris_estudios: [{ id: 10, patient_id: "p1", exp: "000123", paciente: "PRUEBA FICTICIA UNO", fecha: "15/10/2026", hora: "09:00", modalidad: "US", estudios: "USG ABDOMINAL", critico: false, reporte_estado: "listo", reporte: "APÉNDICE ENGROSADO", reporte_url: "https://ris.ejemplo/10", scraped_at: "2026-10-15T10:00:00+00:00" }]
  };
}
const nombres = /FICTICI|000123|000456|000789|000999/;

// ─── R1: construcción y primera escritura ────────────────────────────────────────────────────────────────────────
{
  const st = { db: db(), hoy: "2026-10-21" };
  const { sb, ss, calls, logs } = makeSandbox(st);
  const r = sb.actualizarRegistro();
  const P = tab(ss, "Pacientes"), byId = Object.fromEntries(P.map((x) => [x["ID episodio"], x]));
  const todas = ["Pacientes", "Cirugías", "Labs", "Imagen", "Signos vitales", "Notas de evolución", "Guardia y cronología", "Procedimientos programados", "Labs del robot (WinLab)", "Cultivos del robot (WinLab)", "Imagen del robot (RIS)", "Diccionario"];
  check("R1a corre y escribe las 12 pestañas (Pacientes con más de 26 columnas: la cuadrícula se agranda)",
    r && r.ok && todas.every((n) => ss.sheets[n] && ss.sheets[n].cells.length > 0) && ss.sheets["Pacientes"].cells[0].length > 26, JSON.stringify(r));
  check("R1b episodios: p1 y p2 del censo, p3 y p4 de la Papelera; sin fantasmas ni copias repetidas",
    P.length === 4 && ["p3", "p4", "p1", "p2"].every((id) => byId[id]) && !byId.fantasma && !byId["archivo-a5"], JSON.stringify(P.map((x) => x["ID episodio"])));
  check("R1c el censo gana sobre la copia de la Papelera (p1 Hospitalizado, sus Pendientes)",
    byId.p1["Estado en registro"] === "Hospitalizado" && byId.p1["Pendientes"] === "+ USG" && byId.p1["Fuente"] === "Censo (patients)" && byId.p1["Motivo de egreso"] === "");
  check("R1d de la Papelera gana la copia más nueva (p3: alta médica, egreso 12/10, dx nuevo, días 11)",
    byId.p3["Estado en registro"] === "Egresado" && byId.p3["Motivo de egreso"] === "alta médica" && byId.p3["Fecha de egreso"] === "2026-10-12"
    && byId.p3["Fecha de ingreso"] === "2026-10-01" && byId.p3["Diagnóstico"] === "HERNIA INGUINAL" && String(byId.p3["Días de estancia"]) === "11" && byId.p3["Pendientes"] === "CITA EN CONSULTA", JSON.stringify(byId.p3));
  check("R1e copia en formato de fila (id, lab_history, Qx de texto): DEFUNCIÓN, egreso = fecha de archivo",
    byId.p4["Motivo de egreso"] === "DEFUNCIÓN" && byId.p4["Fecha de egreso"] === "2026-10-05" && byId.p4["Cirugías (resumen)"] === "LAPAROTOMÍA EXPLORADORA" && byId.p4["Labs (fechas)"] === "2026-09-29", JSON.stringify(byId.p4));
  check("R1f hospitalizado: sexo, antibiótico, cultivos, interconsultas, dieta, TVP, vasopresores, días, dispositivos sin la foto, guardia",
    byId.p1["Sexo"] === "M" && byId.p1["Antibiótico"] === "CEFTRIAXONA, 3 días" && byId.p1["Cultivos"] === "HEMOCULTIVO NEGATIVO" && byId.p1["Interconsultas"] === "IM"
    && byId.p1["Dieta y NPO"] === "LÍQUIDOS" && byId.p1["TVP"] === "Sí · enoxaparina · 40 MG" && byId.p1["Vasopresores"] === "Norepinefrina 5 mL/h" && byId.p1["Ventilación"] === ""
    && String(byId.p1["Días de estancia"]) === "6" && byId.p1["Drenajes y dispositivos"] === "PENROSE | SONDA FOLEY 2026-10-16 activo" && /SIN EVENTOS/.test(byId.p1["Guardia vigente"]) && byId.p1["Expediente"] === "000123", JSON.stringify(byId.p1));
  check("R1g nota y checklist completos en JSON, sin archivos incrustados ni las listas que tienen pestaña",
    /"app":"HAS"/.test(byId.p1["Nota completa (JSON)"]) && !/lab_history|base64/.test(byId.p1["Nota completa (JSON)"]) && /"dieta":"LÍQUIDOS"/.test(byId.p1["Checklist completo (JSON)"])
    && !/base64|pm_hist|nota_hist|__pl_note_meta|__ink/.test(byId.p1["Checklist completo (JSON)"]) && /\[archivo\]/.test(byId.p1["Checklist completo (JSON)"]), byId.p1["Checklist completo (JSON)"].slice(0, 300));
  const C = tab(ss, "Cirugías");
  const Cc = C.filter((x) => x["Fuente"] !== "Programación del día (sin confirmar)");
  check("R1h Cirugías: las de la caja (sin las vacías), la Qx de texto de p4 y la de p3; todas vigentes; la POSTQX de la Cronología no se repite",
    Cc.length === 3 && C.every((x) => x["Vigente"] === "Sí") && !C.some((x) => /Cronología/.test(x["Fuente"])) && C.some((x) => x["ID episodio"] === "p1" && x["Procedimiento"] === "APENDICECTOMÍA LAPAROSCÓPICA" && x["Fecha"] === "2026-10-16")
    && C.some((x) => x["ID episodio"] === "p4" && x["Sangrado"] === "500 ML") && C.some((x) => x["ID episodio"] === "p3" && x["Procedimiento"] === "PLASTIA INGUINAL"), JSON.stringify(C));
  check("R1h2 la programación del día de p1 (21/10, 5 días después de su cirugía) entra sin confirmar, con el dx y sin grupo inventado",
    C.length === 4 && C.some((x) => x["ID episodio"] === "p1" && x["Fecha"] === "2026-10-21" && x["Fuente"] === "Programación del día (sin confirmar)" && x["Procedimiento"] === "Programada — dx: APENDICITIS" && x["Grupo"] === "Cirugía (procedimiento no especificado)")
    && /\[Programación del día \(sin confirmar\)\]/.test(byId.p1["Cirugías (resumen)"]) && byId.p4["Cirugías (resumen)"] === "LAPAROTOMÍA EXPLORADORA", JSON.stringify(C));
  const L = tab(ss, "Labs");
  const lp1 = L.filter((x) => x["ID episodio"] === "p1").map((x) => x["Fecha"] + " " + x["Estudio"] + "=" + x["Valor"]).sort();
  check("R1i Labs: una fila por fecha y estudio (sin vacíos, con extra y números), sin el PDF",
    JSON.stringify(lp1) === JSON.stringify(["2026-10-16 LACTATO=1.1", "2026-10-16 cr=0.8", "2026-10-16 hb=13.1", "2026-10-16 leucos=15.2", "2026-10-18 hb=12.4"].sort())
    && L.some((x) => x["ID episodio"] === "p3" && x["Valor"] === "14") && !L.some((x) => /base64/.test(x["Valor"]))
    && L.filter((x) => x["ID episodio"] === "p1" && x["Fecha"] === "2026-10-16").every((x) => x["Origen"] === "winlab"), JSON.stringify(lp1));
  const I = tab(ss, "Imagen");
  check("R1j Imagen: USG con su enlace http y RX sin su enlace data:; ningún archivo", I.length === 2 && I[0]["Enlace"] === "https://pacs.ejemplo/1" && I[1]["Tipo"] === "RX" && I[1]["Enlace"] === "" && !JSON.stringify(I).includes("base64"), JSON.stringify(I));
  const S = tab(ss, "Signos vitales");
  check("R1k Signos: el historial (sin días vacíos) y el pase de hoy", S.length === 2 && S.some((x) => x["Fecha"] === "2026-10-20" && x["Temp"] === "37.9") && S.some((x) => x["Fecha"] === "2026-10-21" && x["FC"] === "88" && x["TA"] === "120/80"), JSON.stringify(S));
  const N = tab(ss, "Notas de evolución");
  check("R1l Notas de evolución: la nota con autor e IA (sin las vacías)", N.length === 1 && N[0]["Autor"] === "R2" && N[0]["Con IA"] === "Sí" && N[0]["Texto"] === "NOTA DE EVOLUCIÓN FICTICIA", JSON.stringify(N));
  const G = tab(ss, "Guardia y cronología");
  check("R1m Cronología de la nota + la del respaldo de la base (sin repetir), también del egresado; Guardia renglón por renglón",
    G.filter((x) => x["ID episodio"] === "p1" && x["Caja"] === "Cronología").map((x) => x["Renglón"]).join("|") === "16/10 08:00 R2: POSTQX INMEDIATO|17/10 08:00 R2: TOLERA VÍA ORAL|15/10 22:00 R1: INGRESA DE URGENCIAS"
    && G.some((x) => x["ID episodio"] === "p3" && x["Renglón"] === "02/10 08:00 R2: POSTQX SIN EVENTOS")
    && G.filter((x) => x["Caja"] === "Guardia vigente").map((x) => x["Renglón"]).join("|") === "20/10 22:00 R1: SIN EVENTOS|20/10 23:00 R1: AFEBRIL", JSON.stringify(G));
  const W = tab(ss, "Labs del robot (WinLab)"), WC = tab(ss, "Cultivos del robot (WinLab)");
  const wF100 = W.find((x) => x["Folio"] === "F100");
  check("R1n WinLab: un renglón por reporte del paciente (sin el homónimo ni el reporte sin valores), con toma, resultado, servicio y valores; también de un expediente sin episodio",
    W.length === 3 && !W.some((x) => x["Folio"] === "F900" || x["Folio"] === "F102") && wF100 && wF100["Toma"] === "2026-10-18 06:10" && wF100["Resultado"] === "2026-10-18 07:00" && wF100["Servicio"] === "CIRUGIA GENERAL"
    && wF100["Valores"] === "HEMOGLOBINA: 12.0 g/dL (ref. 12-16)\nLEUCOCITOS: 11.0 10^3/uL (ref. 4-10)" && String(wF100["Estudios"]) === "2" && wF100["Nombre en WinLab"] === "PRUEBA FICTICIA UNO"
    && /Marcado por el robot/.test(wF100["Atribución"]) && W.some((x) => x["Expediente"] === "000555" && /^CREATININA: 2\.1 mg\/dL/.test(x["Valores"]) && /Regla del robot aplicada por el registro/.test(x["Atribución"]) && x["Nombre en WinLab"] === "PRUEBA FICTICIA CINCO"), JSON.stringify(W));
  check("R1n2 cultivos de WinLab desde el reporte (hemocultivo negativo a 5 días) y RIS con su episodio",
    WC.length === 1 && WC[0]["Tipo"] === "Hemocultivo" && WC[0]["Resultado"] === "Negativo" && WC[0]["Detalle"] === "Sin desarrollo a 5 días" && WC[0]["Fuente"] === "Tabla del reporte" && WC[0]["Toma"] === "2026-10-17 09:00"
    && tab(ss, "Imagen del robot (RIS)")[0]["ID episodio"] === "p1" && tab(ss, "Imagen del robot (RIS)")[0]["Reporte"] === "APÉNDICE ENGROSADO", JSON.stringify(WC));
  check("R1o texto que parece fórmula («=SOLO AYUNO», «+ USG») se guarda tal cual en texto plano (sin apóstrofo)", byId.p1["Manejo"] === "=SOLO AYUNO" && byId.p1["Pendientes"] === "+ USG");
  check("R1p solo GET, con la llave, paginado y ordenado; la primera corrida lee todo (sin filtro de fecha)",
    ((lect) => lect.every((c) => c.m === "get" && c.headers.apikey === "svc") && lect.some((c) => /notes\?.*limit=20$/.test(c.u)) && !lect.some((c) => /offset/.test(c.u)) && !st.usoOffset && lect.every((c) => /order=[a-z_]+\.asc/.test(c.u)) && !lect.some((c) => /gte\./.test(c.u)))(calls.filter((c) => !/\/rpc\/pl_reportar_version$/.test(c.u))));
  check("R1q el registro de ejecución solo tiene conteos (ningún nombre ni expediente)", logs.length >= 1 && logs.every((l) => !nombres.test(l)), logs.join(" | "));
  check("R1s el Diccionario dice cuántas celdas usa y que no hay carga pendiente", /Celdas usadas/.test(JSON.stringify(ss.sheets["Diccionario"].cells)) && /"Carga en curso","No"/.test(JSON.stringify(ss.sheets["Diccionario"].cells)));
  check("R1r una sola hoja: la corrida NO crea copias en la carpeta (el respaldo es el historial de versiones de Sheets)", st.drive.files.length === 0 && !st.props.REG_ULTIMO_RESPALDO && !!st.props.REG_COPIAS_QUITADAS && !!st.props.REG_ULTIMA_CORRIDA);
}

// ─── R2: segunda corrida — nunca borra, Vigente, incremental ─────────────────────────────────────────────────────
{
  const st = { db: db(), hoy: "2026-10-21" };
  makeSandbox(st).sb.actualizarRegistro();
  const antes = snap(st.ss);
  const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  check("R2a idempotente: dos corridas seguidas con la misma base dejan la hoja igual", snap(st.ss) === antes);
  check("R2b la segunda corrida lee incremental la Papelera y los robots (desde 2 días antes) y completo lo demás",
    m2.calls.some((c) => /archive\?.*archived_at=gte\./.test(c.u)) && m2.calls.some((c) => /winlab_labs\?.*scraped_at=gte\./.test(c.u)) && m2.calls.some((c) => /ris_estudios\?.*scraped_at=gte\./.test(c.u)) && !m2.calls.some((c) => /patients\?.*gte/.test(c.u)));

  // Al día siguiente: p2 sale del censo sin pasar por la Papelera; p1 tiene un lab nuevo, se corrigió una cirugía y pm_hist
  // perdió su día más viejo; la Papelera (incremental) ya no trae nada viejo; el robot no trae nada nuevo.
  const d2 = db();
  d2.patients = d2.patients.filter((p) => p.id !== "p2");
  d2.archive = []; d2.winlab_labs = []; d2.ris_estudios = [];
  d2.notes[0].lab_history.push({ fecha: "2026-10-22", labs: { hb: "12.9" } });
  d2.notes[0].checklist.cirugias[0].procedimiento = "APENDICECTOMÍA LAPAROSCÓPICA (CORREGIDA)";
  d2.notes[0].checklist.pm_hist = [{ fecha: "2026-10-21", fc: "80" }];
  d2.notes[0].checklist.pm_fecha = "2026-10-22"; d2.notes[0].checklist.pm_fc = "76";
  st.db = d2; st.hoy = "2026-10-22";
  makeSandbox(st).sb.actualizarRegistro();
  const P = tab(st.ss, "Pacientes"), byId = Object.fromEntries(P.map((x) => [x["ID episodio"], x]));
  check("R2c nunca borra: p3 y p4 (ya no los trae la Papelera incremental) siguen con sus datos", byId.p3 && byId.p3["Motivo de egreso"] === "alta médica" && byId.p3["Última vez en la base"] === "2026-10-21" && byId.p4 && byId.p4["Estado en registro"] === "Egresado");
  check("R2d p2 salió del censo sin egreso: se conserva y queda marcado", byId.p2 && byId.p2["Estado en registro"] === "Salió de la base sin egreso registrado" && byId.p2["Última vez en la base"] === "2026-10-21");
  check("R2e lo presente se actualiza (p1: días 7, última vez hoy) sin duplicar filas", P.length === 4 && String(byId.p1["Días de estancia"]) === "7" && byId.p1["Última vez en la base"] === "2026-10-22");
  const C = tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] === "p1" && x["Fuente"] === "Caja Cirugías");
  check("R2f cirugía corregida: la nueva Vigente Sí y la de antes se conserva con Vigente No", C.length === 2 && C.some((x) => /CORREGIDA/.test(x["Procedimiento"]) && x["Vigente"] === "Sí") && C.some((x) => x["Procedimiento"] === "APENDICECTOMÍA LAPAROSCÓPICA" && x["Vigente"] === "No"), JSON.stringify(C));
  check("R2g las cirugías y labs de los egresados (episodio fuera de la base hoy) siguen Vigente Sí", tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] !== "p1").every((x) => x["Vigente"] === "Sí") && tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p3").length === 1);
  check("R2h Labs de p1: el nuevo se agrega, los anteriores siguen", tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p1").length === 6);
  const S = tab(st.ss, "Signos vitales").filter((x) => x["ID episodio"] === "p1").map((x) => x["Fecha"] + "=" + x["FC"]).sort();
  check("R2i Signos se acumulan: el día que la app ya soltó (20/10) sigue; el 21 toma el valor del historial; el 22 entra", JSON.stringify(S) === JSON.stringify(["2026-10-20=96", "2026-10-21=80", "2026-10-22=76"]), JSON.stringify(S));
  check("R2j robots acumulan: lo de WinLab y RIS de ayer sigue aunque hoy no venga", tab(st.ss, "Labs del robot (WinLab)").length === 3 && tab(st.ss, "Imagen del robot (RIS)").length === 1);
  check("R2k la segunda corrida tampoco crea copias (una sola hoja)", st.drive.files.length === 0);
}

// ─── R3: seguridad de la escritura y de la lectura ───────────────────────────────────────────────────────────────
{
  const st = { db: db() };
  makeSandbox(st).sb.actualizarRegistro();
  const antes = snap(st.ss);
  st.falla = { archive: 500 };
  const m = makeSandbox(st);
  let err = null; try { m.sb.actualizarRegistro(); } catch (e) { err = String(e && e.message || e); }
  check("R3a Supabase falla a la mitad: error sin el cuerpo de la respuesta y la hoja intacta", !!err && /archive HTTP 500/.test(err) && !/FICTICIO|SECRETO/.test(err) && snap(st.ss) === antes && m.logs.every((l) => !/SECRETO/.test(l)), err);
  delete st.falla;
  // Una escritura que falla a la mitad (Sheets se cae): la pestaña no queda vacía y la siguiente corrida no pierde nada.
  const pacAntes = tab(st.ss, "Pacientes").length;
  st.db.notes[0].lab_history.push({ fecha: "2026-10-19", labs: { hb: "11.5" } });   // un cambio que Labs sí tiene que escribir
  st.failWriteOn = "Labs";
  let e2 = null; try { makeSandbox(st).sb.actualizarRegistro(); } catch (e) { e2 = String(e.message); }
  st.failWriteOn = null;
  check("R3b una escritura que falla no vacía la pestaña (antes se vaciaba primero)", !!e2 && tab(st.ss, "Labs").length > 0 && tab(st.ss, "Pacientes").length === pacAntes, e2);
  makeSandbox(st).sb.actualizarRegistro();
  check("R3c y la siguiente corrida sigue completa", tab(st.ss, "Labs").length === 8 && tab(st.ss, "Pacientes").length === 4);
  // Primera corrida que lee todo pero falla al escribir: el cursor de la Papelera no avanza y la siguiente lee de nuevo.
  const sc = { db: db(), failWriteOn: "Pacientes" };
  let e6 = null; try { makeSandbox(sc).sb.actualizarRegistro(); } catch (e) { e6 = String(e.message); }
  sc.failWriteOn = null;
  makeSandbox(sc).sb.actualizarRegistro();
  const idsC = tab(sc.ss, "Pacientes").map((x) => x["ID episodio"]).sort();
  check("R3m si la escritura falla, los cursores no avanzan: la siguiente corrida vuelve a leer toda la Papelera", !!e6 && !sc.props.REG_CURSOR_archive_fallido && JSON.stringify(idsC) === JSON.stringify(["p1", "p2", "p3", "p4"]), JSON.stringify({ e6, idsC }));
  // Encabezado renombrado a mano: no se escribe nada.
  st.ss.sheets["Pacientes"].cells[0][0] = "Id";
  const antes2 = snap(st.ss);
  let e3 = null; try { makeSandbox(st).sb.actualizarRegistro(); } catch (e) { e3 = String(e.message); }
  check("R3d con la columna clave renombrada en la fila 1 se detiene sin tocar la hoja", /no tiene la columna «ID episodio»/.test(e3 || "") && snap(st.ss) === antes2, e3);
  st.ss.sheets["Pacientes"].cells[0][0] = "ID episodio";
  // Columnas agregadas a la derecha por un investigador se respetan.
  const shP = st.ss.sheets["Pacientes"], nc = shP.cells[0].length;
  shP.maxC = Math.max(shP.maxC, nc + 1); shP.cells[0][nc] = "Grupo del estudio"; shP.cells[1][nc] = "A";   // como en Sheets: agrega la columna y escribe
  makeSandbox(st).sb.actualizarRegistro();
  check("R3e una columna agregada a la derecha se conserva junto a su fila", shP.cells[0][nc] === "Grupo del estudio" && shP.cells[1][nc] === "A");
  const s2 = makeSandbox({ db: db(), sinLlave: true }).sb;
  let e4 = null; try { s2.actualizarRegistro(); } catch (e) { e4 = String(e.message); }
  check("R3f sin SUPABASE_KEY: error claro", /SUPABASE_KEY/.test(e4 || ""), e4);
  const r5 = makeSandbox({ db: db(), ocupado: true }).sb.actualizarRegistro();
  check("R3g con otra corrida en curso (lock): no hace nada", r5 && r5.ok === false && r5.motivo === "ocupado");
  // Paginado y respuestas demasiado grandes.
  const d = db(); for (let i = 0; i < 44; i++) { d.patients.push({ id: "q" + i, nombre: "PRUEBA FICTICIA EXTRA " + i, exp: "9" + i }); d.notes.push({ patient_id: "q" + i, pendientes: "P" + i }); }
  const mp = makeSandbox({ db: d, maxFilas: { notes: 6 } });
  mp.sb.actualizarRegistro();
  check("R3h paginado completo y la página se achica si la respuesta es demasiado grande (20 → 10 → 5)", tab(mp.ss, "Pacientes").length === 48 && mp.calls.some((c) => /notes\?.*limit=5$/.test(c.u)) && !mp.calls.some((c) => /offset/.test(c.u)));
  const mt = makeSandbox({ db: db(), maxFilas: { archive: 0 } });
  let e5 = null; try { mt.sb.actualizarRegistro(); } catch (e) { e5 = String(e.message); }
  check("R3i una fila que no cabe ni sola: error sin datos y nada escrito", /archive: no se pudo leer/.test(e5 || "") && !nombres.test(e5 || "") && !mt.ss.sheets["Pacientes"], e5);
  // Celdas.
  const sb = mp.sb;
  check("R3j celda larga recortada bajo el límite", sb.regCelda("X".repeat(60000)).length < 50000 && /recortado/.test(sb.regCelda("X".repeat(60000))));
  check("R3k fechas: ISO, d/m/aaaa, d/m/aa; raras vacías; días negativos vacíos; Date de Sheets como texto",
    sb.regFecha("2026-10-05T10:00:00Z") === "2026-10-05" && sb.regFecha("5/10/2026") === "2026-10-05" && sb.regFecha("05/10/26") === "2026-10-05" && sb.regFecha("ayer") === "" && sb.regDias("2026-10-10", "2026-10-01") === "" && sb.regTexto(new Date(Date.UTC(2026, 9, 5, 6))) === "2026-10-05");
  // Pestaña con columnas en otro orden (versión vieja): se lee por nombre.
  const st4 = { db: db() }; const sh = makeSpreadsheet(); st4.ss = sh; const vieja = sh.insertSheet("Pacientes");
  vieja.cells = [["Nombre", "ID episodio", "Estado en registro"], ["PRUEBA FICTICIA VIEJA", "viejo1", "Hospitalizado"]];
  makeSandbox(st4).sb.actualizarRegistro();
  const v = tab(sh, "Pacientes").find((x) => x["ID episodio"] === "viejo1");
  check("R3l columnas en otro orden: la fila vieja se conserva con sus datos y marcada fuera de la base", v && v["Nombre"] === "PRUEBA FICTICIA VIEJA" && v["Estado en registro"] === "Salió de la base sin egreso registrado", JSON.stringify(v));
}

// ─── R5: la Papelera con la copia de la base (_copia_base) ────────────────────────────────────────────────────────
{
  const d = db();
  d.archive.push({ id: "a6", archived_at: "2026-10-18T10:00:00+00:00", patient_data: { _supa_id: "p6", nombre: "PRUEBA FICTICIA SEIS", exp: "000666", ingreso: "2026-10-14" },
    note_data: { _egreso: "alta médica", pendientes: "", app: "DM2 (EQUIPO)", labHistory: [{ fecha: "2026-10-15", labs: { hb: "10" } }], checklist: { cultivos: "", __lab_deleted: ["2026-10-14"] },
      _copia_base: { pendientes: "CITA EN 7 DÍAS (BASE)", app: "DM2 (BASE)", cronologia: "15/10 08:00 R2: RENGLÓN DE LA BASE", checklist: { cultivos: "UROCULTIVO E. COLI", cirugias: [{ id: "cb1", fecha: "2026-10-15", procedimiento: "CX DE LA BASE" }], nota_hist: [{ ts: "2026-10-16T10:00:00Z", by: "R3", txt: "NOTA SOLO EN LA BASE" }], __pl_note_meta: { entrega: "17/10 22:00 R1: GUARDIA DE LA BASE" } },
        labHistory: [{ fecha: "2026-10-15", labs: { hb: "9" } }, { fecha: "2026-10-16", labs: { hb: "11" } }, { fecha: "2026-10-14", labs: { hb: "8" } }],
        imagenHistory: [{ fecha: "2026-10-15", estudios: [{ tipo: "TAC", descripcion: "DE LA BASE" }] }] } } });
  const st = { db: d };
  makeSandbox(st).sb.actualizarRegistro();
  const p6 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p6");
  const l6 = tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p6").map((x) => x["Fecha"] + "=" + x["Valor"]).sort();
  check("R5a egreso con copia de la base: caja vacía del equipo toma la de la base; la escrita por el equipo se respeta",
    p6 && p6["Pendientes"] === "CITA EN 7 DÍAS (BASE)" && p6["Antecedentes (APP)"] === "DM2 (EQUIPO)" && p6["Cultivos"] === "UROCULTIVO E. COLI" && /RENGLÓN DE LA BASE/.test(p6["Cronología"]), JSON.stringify(p6));
  const p1 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p1");
  check("R5c censo + copia de la Papelera del mismo id: el censo manda (Pendientes) y la copia no borra nada del censo", p1["Pendientes"] === "+ USG" && p1["Estado en registro"] === "Hospitalizado");
  check("R5b labs unidos por fecha (la del equipo gana) sin revivir la fecha borrada a propósito; imagen y cirugías de la base",
    JSON.stringify(l6) === JSON.stringify(["2026-10-15=10", "2026-10-16=11"]) && tab(st.ss, "Imagen").some((x) => x["ID episodio"] === "p6" && x["Tipo"] === "TAC") && tab(st.ss, "Cirugías").some((x) => x["ID episodio"] === "p6" && x["Procedimiento"] === "CX DE LA BASE")
    && !/_copia_base/.test(p6["Nota completa (JSON)"]), JSON.stringify(l6));
  check("R5d de la copia de la base también las notas de evolución y la Guardia (la del equipo venía vacía)",
    tab(st.ss, "Notas de evolución").some((x) => x["ID episodio"] === "p6" && x["Texto"] === "NOTA SOLO EN LA BASE") && /GUARDIA DE LA BASE/.test(p6["Guardia vigente"]));
  // Dos copias del mismo episodio en la Papelera: la más nueva manda y la vieja rellena (un lab que solo tenía la vieja).
  const d2 = db(); d2.archive[0].note_data.labHistory = [{ fecha: "2026-10-03", labs: { hb: "12" } }];
  const s2 = { db: d2 }; makeSandbox(s2).sb.actualizarRegistro();
  const p3 = tab(s2.ss, "Pacientes").find((x) => x["ID episodio"] === "p3");
  check("R5e dos copias en la Papelera: la nueva manda (Pendientes, dx) y la vieja aporta el lab que solo ella tenía",
    p3["Pendientes"] === "CITA EN CONSULTA" && p3["Diagnóstico"] === "HERNIA INGUINAL" && p3["Labs (fechas)"] === "2026-10-03, 2026-10-11", JSON.stringify(p3["Labs (fechas)"]));
}

// ─── R6: primera carga grande en varias vueltas (tope por corrida) ───────────────────────────────────────────────
{
  const st = { db: db() };
  const m1 = makeSandbox(st); m1.sb.REG_CURSORES.archive.tope = 2;
  const r1 = m1.sb.actualizarRegistro();
  const n1 = tab(st.ss, "Pacientes").length;
  check("R6a con el tope alcanzado escribe lo leído, deja el cursor y programa una continuación en 10 min",
    r1.ok && r1.pendiente === true && (st.continuaciones || []).includes(600000) && !!st.props.REG_SIGUE_archive && !st.props.REG_CURSOR_archive && n1 < 4 && /Sí: quedan filas/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)), JSON.stringify({ r1, n1 }));
  for (let i = 0; i < 4; i++) { const m = makeSandbox(st); m.sb.REG_CURSORES.archive.tope = 2; m.sb.continuarRegistro(); }
  const P = tab(st.ss, "Pacientes");
  check("R6b las vueltas siguientes completan la carga sin repetir episodios", P.length === 4 && new Set(P.map((x) => x["ID episodio"])).size === 4 && /"Carga en curso","No"/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)), JSON.stringify(P.map((x) => x["ID episodio"])));
}

// ─── R7: restaurar desde la Papelera crea otro id: episodios relacionados ────────────────────────────────────────
{
  const d = db();
  d.archive.push({ id: "a7", archived_at: "2026-10-19T10:00:00+00:00", patient_data: { _supa_id: "p7", nombre: "PRUEBA FICTICIA SIETE", exp: "000777" }, note_data: { _egreso: "EGRESO", _restaurado_a: "p8" } });
  d.patients.push({ id: "p8", nombre: "PRUEBA FICTICIA SIETE", exp: "000777", cama: "3-208" });
  const st = { db: d }; makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  check("R7a el episodio restaurado y el nuevo quedan relacionados (Continúa en / Viene de)", P.p7 && P.p7["Episodio relacionado"] === "Continúa en p8" && P.p8 && P.p8["Episodio relacionado"] === "Viene de p7", JSON.stringify({ p7: P.p7 && P.p7["Episodio relacionado"], p8: P.p8 && P.p8["Episodio relacionado"] }));
}

// ─── R4: menú, instalación, proyecto aparte, respaldos ───────────────────────────────────────────────────────────
{
  const st = { db: db() };
  const { sb, triggers } = makeSandbox(st);
  sb.onOpen();
  check("R4a menú «Registro» con Actualizar ahora e Instalar", JSON.stringify(st.menu) === JSON.stringify(["actualizarRegistro", "instalarRegistroDiario"]));
  sb.instalarRegistroDiario(); sb.instalarRegistroDiario();
  check("R4b instalar dos veces deja UNA actualización diaria (23 h) y hace la primera corrida", triggers.length === 1 && triggers[0].fn === "actualizarRegistro" && triggers[0].d === 1 && triggers[0].h === 23);
  const sa = { db: db(), standalone: true, props: { REGISTRO_SHEET_ID: "hoja-del-registro" } };
  makeSandbox(sa).sb.actualizarRegistro();
  check("R4c proyecto aparte: abre la hoja por REGISTRO_SHEET_ID", sa.abiertoPorId === "hoja-del-registro" && tab(sa.ss, "Pacientes").length === 4);
  // Una sola hoja (27 oct 2026): las copias «Respaldo — …» que hizo la versión anterior van UNA vez a la papelera; ninguna nueva.
  const copia = (name) => { const f = { name, trashed: false, getName: () => name, setTrashed: (t) => { f.trashed = t; if (t) sr.drive.trashed.push(name); } }; return f; };
  const sr = { db: db(), hoy: "2026-10-27", props: { REG_ULTIMO_RESPALDO: "2026-10-20" }, drive: { files: [], trashed: [] } };
  sr.drive.files.push(copia("Respaldo — Registro de pacientes — 2026-10-13"), copia("Respaldo — Registro de pacientes — 2026-10-20"), copia("LÉEME — Cómo activar el registro"), copia("Respaldo — Otra hoja — 2026-10-20"));
  makeSandbox(sr).sb.actualizarRegistro();
  const quitadas1 = sr.drive.trashed.slice();
  sr.drive.files.push(copia("Respaldo — Registro de pacientes — 2026-11-03"));   // apareció otra después: ya no se busca (una sola vez)
  for (let i = 0; i < 3; i++) { sr.hoy = new Date(Date.UTC(2026, 9, 28 + i * 7)).toISOString().slice(0, 10); makeSandbox(sr).sb.actualizarRegistro(); }
  check("R4d una sola hoja: las copias viejas de ESTE registro van a la papelera una vez (no el LÉEME ni las de otra hoja) y nunca se crean copias nuevas",
    JSON.stringify(quitadas1) === JSON.stringify(["Respaldo — Registro de pacientes — 2026-10-13", "Respaldo — Registro de pacientes — 2026-10-20"]) && sr.drive.trashed.length === 2
    && sr.drive.files.length === 5 && !sr.props.REG_ULTIMO_RESPALDO && !!sr.props.REG_COPIAS_QUITADAS, JSON.stringify({ quitadas1, t: sr.drive.trashed, n: sr.drive.files.length }));
}

// ─── R8: URLs que Google acepta (21 oct 2026: la primera corrida real falló con «Supabase archive: no se pudo leer
// (fila 0)» porque el filtro note_data->>_restaurado_a iba sin codificar y UrlFetchApp rechaza el >) ────────────────
{
  check("R8 el simulador rechaza lo que Google rechaza", !urlValida("https://x.supabase.co/rest/v1/archive?select=id&note_data->>_a=not.is.null")
    && !urlValida("https://x.supabase.co/rest/v1/a?select=a b") && !urlValida("https://x.supabase.co/rest/v1/a?x=%G1") && !urlValida("https://x.supabase.co/rest/v1/a?x=[1]")
    && urlValida("https://x.supabase.co/rest/v1/a?select=id%2Cde%3Ax&order=id.asc&limit=10&offset=0"));
  // Primera corrida y una incremental (con cursores): cada URL que sale es válida y los filtros van codificados.
  const st = { db: db() };
  makeSandbox(st).sb.actualizarRegistro();
  const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  const m1 = makeSandbox({ db: db() }); m1.sb.actualizarRegistro();
  const todas = m1.calls.concat(m2.calls).filter((c) => !/\/rpc\/pl_reportar_version$/.test(c.u));
  check("R8a todas las URLs (primera corrida e incremental) son válidas para UrlFetchApp; el filtro ->> y la fecha del cursor van codificados",
    todas.length > 10 && todas.every((c) => c.m === "get" && urlValida(c.raw))
    && todas.some((c) => /archive\?.*&note_data-%3E%3E_restaurado_a=not\.is\.null&/.test(c.raw))
    && m2.calls.some((c) => /archive\?.*&archived_at=gte\.\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A\d{2}/.test(c.raw)),
    JSON.stringify(todas.filter((c) => !urlValida(c.raw)).map((c) => c.raw).slice(0, 3)));
  check("R8b regUrl_: cada nombre y valor codificado, varios filtros, orden ascendente con desempate",
    m1.sb.regUrl_("t", "a,b:c->>d", "x,id", "c->>d=not.is.null&f=gte.2026-10-01T00:00:00+00:00", 5)
      === "https://vkxplmrzyqlamxpbtmes.supabase.co/rest/v1/t?select=a%2Cb%3Ac-%3E%3Ed&c-%3E%3Ed=not.is.null&f=gte.2026-10-01T00%3A00%3A00%2B00%3A00&order=x.asc%2Cid.asc&limit=5");
  // Si Google rechaza una URL: falla de inmediato (sin achicar la página 10 veces), dice por qué, sin URL, llave ni datos.
  const sr = { db: db(), rechazaUrl: /restaurado_a/ };
  const mr = makeSandbox(sr); let er = null;
  try { mr.sb.actualizarRegistro(); } catch (e) { er = String(e.message); }
  check("R8c URL rechazada: un solo intento, el error dice «Invalid argument» sin la URL, la llave ni datos, y la hoja queda sin tocar",
    !!er && /archive: no se pudo leer \(fila 0\): Exception: Invalid argument: \[url\]/.test(er) && mr.calls.filter((c) => c.m === "rechazada").length === 1
    && !/https?:|svc|supabase\.co/.test(er) && !nombres.test(er) && !sr.ss.sheets["Pacientes"], er);
  // Error de PostgREST (p. ej. una columna que no existe): solo el código, nunca su mensaje ni sus detalles.
  const sc = { db: db(), codigo: { cronologia_respaldo: "42703" } };
  const mc = makeSandbox(sc); let ec = null;
  try { mc.sb.actualizarRegistro(); } catch (e) { ec = String(e.message); }
  check("R8d HTTP 400 de PostgREST: el error trae el código (42703) y no el mensaje ni los detalles", ec === "Supabase cronologia_respaldo HTTP 400 (42703)" && mc.logs.every((l) => !/SECRETO|000123/.test(l)), ec);
}

// ─── R9: WinLab con la regla de identidad del ROBOT (rpa/lib.js) y cultivos (copias de index.html) ──────────────
{
  const sb = makeSandbox({ db: db() }).sb;
  // Encabezado real: 7 celdas (…, APELLIDOS, NOMBRE, SEXO, NACIMIENTO); en italiano el sexo dice MASCHIO/FEMMINA.
  const enc = (ap, nom, nac, sexo) => ({ __hasLink: false, __cells: ["", "", "X", ap, nom, sexo || "FEMENINO", nac || "01/02/1986"] });
  const rep = (folio, extra) => Object.assign({ __hasLink: true, __cells: ["", "", folio, "10/10/2026 06:00", "10/10/2026 07:00", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOGLOBINA", valor: "10" }] }, extra || {});
  const folios = (fila, ctx, acc) => sb.regWlDelPaciente(Object.assign({ exp: "1", scraped_at: "2026-10-05T08:00:00Z" }, fila), ctx || {}, acc).map((x) => x.rep.__cells[2]);
  // Capturas SIN marca (antes del 9 oct): la regla del robot.
  const sinMarca = { paciente: "PRUEBA FICTICIA ANA MARIA", reportes: [rep("A0"), enc("PRUEBA FICTICIA", "ANA"), rep("A1"), enc("PRUEBA FICTICIA", "ANA MARIA"), rep("A3"), enc("PRUEBA FICTICIA", "LUISA"), rep("A4")] };
  check("R9a sin marca: entra el encabezado con el nombre completo; el parcial no compite si hay uno completo; antes del primer encabezado y de otra persona no",
    JSON.stringify(folios(sinMarca)) === JSON.stringify(["A3"]), JSON.stringify(folios(sinMarca)));
  const soloParcial = { paciente: "PRUEBA FICTICIA ANA MARIA", reportes: [enc("PRUEBA FICTICIA", "ANA", "01/02/1986"), rep("P1")] };
  check("R9b encabezado con menos nombres: entra si la edad cuadra (40 años) o no se conoce; no si no cuadra",
    folios(soloParcial, { "1": { edad: "40" } }).length === 1 && folios(soloParcial, {}).length === 1 && folios(soloParcial, { "1": { edad: "70" } }).length === 0);
  check("R9c una letra del OCR (FICTISIA) sí; variante A/O (MARIO/MARIA) no; FCO. = FRANCISCO; encabezado en italiano (MASCHIO)",
    folios({ paciente: "PRUEBA FICTICIA ANA MARIA", reportes: [enc("PRUEBA FICTISIA", "ANA MARIA"), rep("B1")] }).length === 1
    && folios({ paciente: "MARIO PRUEBA FICTICIA", reportes: [enc("PRUEBA FICTICIA", "MARIA"), rep("B2")] }).length === 0
    && folios({ paciente: "FCO. JAVIER PRUEBA FICTICIA", reportes: [enc("PRUEBA FICTICIA", "FRANCISCO JAVIER", null, "MASCHIO"), rep("B3")] }).length === 1);
  check("R9d alias «nombre en WinLab» de la app: el encabezado con el alias entra",
    folios({ paciente: "NOMBRE DEL CENSO DISTINTO", reportes: [enc("PRUEBA FICTICIA", "ALIAS"), rep("C1")] }, { "1": { alias: "PRUEBA FICTICIA ALIAS" } }).length === 1
    && folios({ paciente: "NOMBRE DEL CENSO DISTINTO", reportes: [enc("PRUEBA FICTICIA", "ALIAS"), rep("C1")] }, {}).length === 0);
  // Homónimos: dos personas con el mismo nombre (otra fecha de nacimiento) → decide la edad; sin edad no se copia nada.
  const homonimos = { paciente: "PRUEBA FICTICIA UNO", reportes: [enc("PRUEBA FICTICIA", "UNO", "01/02/1990"), rep("H1"), enc("PRUEBA FICTICIA", "UNO", "05/06/1950"), rep("H2")] };
  const acc = { ambiguos: 0 };
  check("R9e homónimos con el mismo nombre: la edad del censo elige (36 → el de 1990); sin edad no se copia ninguno y se cuenta",
    JSON.stringify(folios(homonimos, { "1": { edad: "36" } })) === JSON.stringify(["H1"]) && folios(homonimos, {}, acc).length === 0 && acc.ambiguos === 2);
  check("R9f el mismo paciente registrado dos veces con el año mal escrito (mismo día y mes): entran los dos",
    folios({ paciente: "PRUEBA FICTICIA UNO", reportes: [enc("PRUEBA FICTICIA", "UNO", "01/02/1990"), rep("Y1"), enc("PRUEBA FICTICIA", "UNO", "01/02/1909"), rep("Y2")] }, { "1": { edad: "36" } }).length === 2);
  const tres = { paciente: "PRUEBA FICTICIA UNO", reportes: [enc("PRUEBA FICTICIA", "UNO", "01/02/1990"), rep("Z1"), enc("PRUEBA FICTICIA", "UNO", "01/02/1909"), rep("Z2"), enc("PRUEBA FICTICIA", "UNO", "05/06/1950"), rep("Z3")] };
  check("R9f2 con un homónimo de verdad además: la edad elige y el registro con el año mal escrito se rescata; el homónimo no",
    JSON.stringify(folios(tres, { "1": { edad: "36" } })) === JSON.stringify(["Z1", "Z2"]), JSON.stringify(folios(tres, { "1": { edad: "36" } })));
  // Capturas CON marca (desde el 9 oct): solo lo que marcó el robot, aunque el encabezado no coincida (alias, FCO…).
  const conMarca = { paciente: "PRUEBA FICTICIA UNO", reportes: [enc("OTRA PERSONA", "ALIAS"), rep("M1", { __target: true }), enc("PRUEBA FICTICIA", "UNO"), rep("M2")] };
  check("R9g con marca del robot: solo los reportes marcados (__target), aunque el encabezado no coincida", JSON.stringify(folios(conMarca)) === JSON.stringify(["M1"]));
  check("R9h contexto de edad y alias: del censo (y su nota) y de la Papelera", (() => {
    const c = sb.regWlContexto([{ id: "p1", exp: "000123", edad: "34" }], [{ patient_id: "p1", checklist: { winlab_alias: "PRUEBA, ALIAS" } }], [{ archived_at: "2026-10-01", patient_data: { exp: "000789", edad: "61" }, note_data: { checklist: { winlab_alias: "OTRO, ALIAS" } } }]);
    return c["000123"].edad === "34" && c["000123"].alias === "PRUEBA, ALIAS" && c["000789"].edad === "61" && c["000789"].alias === "OTRO, ALIAS";
  })());
  // Mismo reporte en dos capturas: la que trae más valores manda; una posterior con menos no la pisa.
  const ac1 = { labs: {}, cultivos: {} };
  const r1 = rep("D1", { __target: true, valores: [{ estudio: "HB", valor: "9" }] }), r2 = rep("D1", { __target: true, valores: [{ estudio: "HB", valor: "9" }, { estudio: "PLT", valor: "150" }] });
  sb.regWlAcumular(ac1, [{ exp: "1", paciente: "X", scraped_at: "2026-10-10T08:00:00Z", reportes: [r1] }, { exp: "1", paciente: "X", scraped_at: "2026-10-11T08:00:00Z", reportes: [r2] }, { exp: "1", paciente: "X", scraped_at: "2026-10-12T08:00:00Z", reportes: [r1] }]);
  const L = Object.values(ac1.labs);
  check("R9i el mismo reporte en varias capturas es un solo renglón, con la captura de más valores", L.length === 1 && L[0]["Estudios"] === 2 && L[0]["Capturado"] === "2026-10-11T08:00:00Z" && /PLT: 150/.test(L[0]["Valores"]), JSON.stringify(L));
  // Cultivo del PDF: el robot repite el antibiograma en la sección y en el germen: no se duplica.
  const ab = [{ antibiotico: "AMIKACINA", cim: "<=2", interp: "S" }, { antibiotico: "CEFTRIAXONA", interp: "R" }, { antibiotico: "CEFEPIME", interp: "I" }];
  const pdf = rep("E1", { __target: true, valores: [{ estudio: "CULTIVO", valor: "POSITIVO", referencia: "Sin desarrollo" }], cultivo_texto: "TEXTO FICTICIO DEL REPORTE",
    cultivo: { secciones: [{ tipo: "Urocultivo", muestra: "ORINA", resultado: "POSITIVO", antibiograma: ab, germenes: [{ nombre: "Escherichia coli", flags: ["BLEE"], ufc: ">100000", antibiograma: ab }] }] } });
  const soloTabla = rep("E1", { __target: true, valores: [{ estudio: "CULTIVO", valor: "POSITIVO", referencia: "Sin desarrollo" }] });
  const ac2 = { labs: {}, cultivos: {} };
  sb.regWlAcumular(ac2, [{ exp: "2", paciente: "X", scraped_at: "2026-10-10T08:00:00Z", reportes: [pdf] }, { exp: "2", paciente: "X", scraped_at: "2026-10-11T08:00:00Z", reportes: [soloTabla] }]);
  const C = Object.values(ac2.cultivos);
  check("R9j cultivo del PDF: germen con marcas, S/I/R sin duplicar, UFC y texto; la captura posterior solo con la tabla no lo pisa",
    C.length === 1 && C[0]["Resultado"] === "POSITIVO" && C[0]["Germen"] === "Escherichia coli (BLEE)" && C[0]["Sensibles"] === "AMIKACINA <=2" && C[0]["Intermedios"] === "CEFEPIME" && C[0]["Resistentes"] === "CEFTRIAXONA"
    && C[0]["UFC"] === ">100000" && C[0]["Tipo"] === "Urocultivo" && C[0]["Muestra"] === "ORINA" && C[0]["Fuente"] === "PDF del reporte" && C[0]["Texto del reporte"] === "TEXTO FICTICIO DEL REPORTE", JSON.stringify(C));
  const poli = sb.regWlCultivosPdf({ cultivo: { secciones: [{ tipo: "Cultivo de herida", resultado: "POSITIVO", germenes: [
    { nombre: "Escherichia coli", antibiograma: [{ antibiotico: "CEFTRIAXONA", interp: "S" }] }, { nombre: "Klebsiella pneumoniae", antibiograma: [{ antibiotico: "CEFTRIAXONA", interp: "R" }] }] }] } });
  check("R9k polimicrobiano: el antibiograma va con el nombre de cada germen (un antibiótico puede ser S para uno y R para otro)",
    poli[0].sensibles.join(poli[0].separador) === "Escherichia coli: CEFTRIAXONA" && poli[0].resistentes.join(poli[0].separador) === "Klebsiella pneumoniae: CEFTRIAXONA", JSON.stringify(poli));
  const C3 = sb.regWlCultivos(soloTabla), C4 = sb.regWlCultivos(rep("E2", { valores: [{ estudio: "CULTIVO SECRECION", valor: "Klebsiella pneumoniae" }] })), C5 = sb.regWlCultivos(rep("E3"));
  check("R9l cultivo de la tabla: POSITIVO sin germen, germen en el valor, y un reporte que no es cultivo no da nada",
    C3.length === 1 && C3[0].positivo && /POSITIVO \(germen/.test(C3[0].organismo) && C4[0].organismo === "Klebsiella pneumoniae" && C4[0].tipo === "Cultivo de herida/secreción" && C5.length === 0, JSON.stringify([C3, C4, C5]));
  check("R9m valores: sección, unidad y referencia; archivos incrustados fuera", sb.regWlValores({ valores: [{ seccion: "BH", estudio: "HB", valor: "9", unidad: "g/dL", referencia: "12-16" }, { estudio: "PDF", valor: "data:application/pdf;base64,AAAA" }, { estudio: "", valor: "" }] })
    === "[BH] HB: 9 g/dL (ref. 12-16)\nPDF: [archivo]");
  // Entre corridas: una captura posterior más pobre no pisa lo que ya está en la hoja.
  const d = db(); const st = { db: d }; makeSandbox(st).sb.actualizarRegistro();
  const w = d.winlab_labs[0]; w.scraped_at = "2026-10-20T08:00:00+00:00"; w.data.reportes[1].valores = [{ estudio: "HEMOGLOBINA", valor: "12.0", unidad: "g/dL" }];
  w.data.reportes[2] = { __hasLink: true, __target: true, __cells: ["", "", "F101", "17/10/2026 09:00", "19/10/2026 07:30", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOCULTIVO PERIFERICO", valor: "1", unidad: "DESARROLLO" }, { estudio: "NEGATIVO A", valor: "5", unidad: "DIAS" }],
    cultivo: { secciones: [{ tipo: "Hemocultivo", muestra: "PERIFERICO", resultado: "NEGATIVO", detalle: "a 5 días" }] } };
  makeSandbox(st).sb.actualizarRegistro();
  w.scraped_at = "2026-10-21T08:00:00+00:00"; delete w.data.reportes[2].cultivo;
  makeSandbox(st).sb.actualizarRegistro();
  const W = tab(st.ss, "Labs del robot (WinLab)").find((x) => x["Folio"] === "F100"), WC = tab(st.ss, "Cultivos del robot (WinLab)");
  check("R9n entre corridas: una captura con menos valores no pisa el reporte completo, y la tabla no pisa el cultivo del PDF",
    String(W["Estudios"]) === "2" && /LEUCOCITOS/.test(W["Valores"]) && WC.length === 1 && WC[0]["Fuente"] === "PDF del reporte" && WC[0]["Muestra"] === "PERIFERICO", JSON.stringify([W, WC]));
}

// ─── R10: paginación por llave y cursores (sin offset, sin saltos) ───────────────────────────────────────────────
{
  // Un borrado entre dos páginas (un egreso mientras se leen las notas) no se salta la nota siguiente.
  const d = db(); for (let i = 0; i < 44; i++) { d.patients.push({ id: "q" + String(i).padStart(2, "0"), nombre: "PRUEBA FICTICIA EXTRA " + i, exp: "9" + i }); d.notes.push({ patient_id: "q" + String(i).padStart(2, "0"), pendientes: "P" + i }); }
  const st = { db: d, alResponder: (tabla, n, base) => { if (tabla === "notes" && n === 1) base.notes = base.notes.filter((x) => x.patient_id !== "q00"); } };
  makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  const faltan = []; for (let i = 1; i < 44; i++) { const id = "q" + String(i).padStart(2, "0"); if (!P[id] || P[id]["Pendientes"] !== "P" + i) faltan.push(id); }
  check("R10a un borrado entre dos páginas no salta la fila siguiente (con offset se perdía la nota de otro paciente)", faltan.length === 0 && !st.usoOffset, JSON.stringify(faltan));
  // Más filas que el tope dentro de 2 días, en varias vueltas: no se salta ninguna (antes el cursor se inflaba).
  const d2 = db(); d2.archive = [];
  for (let i = 0; i < 6; i++) d2.archive.push({ id: "z" + i, archived_at: new Date(Date.UTC(2026, 9, 20, i * 3)).toISOString().replace(".000Z", i % 2 ? "Z" : "+00:00"), patient_data: { _supa_id: "e" + i, nombre: "PRUEBA FICTICIA E" + i, exp: "8" + i }, note_data: {} });
  const s2 = { db: d2 };
  // Carga inicial: 2 + 2 + 2 filas y una vuelta más que confirma el final (la 3.ª llena el tope y no sabe si quedan).
  for (let v = 0; v < 4; v++) { const m = makeSandbox(s2); m.sb.REG_CURSORES.archive.tope = 2; v ? m.sb.continuarRegistro() : m.sb.actualizarRegistro(); }
  const ids = tab(s2.ss, "Pacientes").map((x) => x["ID episodio"]).filter((x) => /^e/.test(x)).sort();
  check("R10b seis egresos en 15 h con tope 2 por vuelta: entran los seis (con y sin «Z»), sin repetir", JSON.stringify(ids) === JSON.stringify(["e0", "e1", "e2", "e3", "e4", "e5"]) && !s2.props.REG_SIGUE_archive && !!s2.props.REG_CURSOR_archive, JSON.stringify({ ids, props: s2.props }));
  // Una página más grande que el tope del servidor (1000) no corta la lectura antes de tiempo.
  const d3 = db(); d3.patients = []; for (let i = 0; i < 2500; i++) d3.patients.push({ id: "m" + String(i).padStart(5, "0"), nombre: "N", exp: "E" });
  const m3 = makeSandbox({ db: d3 });
  const r3 = m3.sb.regLeerTabla_("svc", "patients", "id", "id", "", 5000, {});
  check("R10c páginas de más de 1000 filas (max_rows): se piden de 1000 y se leen las 2500", r3.completa && r3.filas.length === 2500 && m3.calls.every((c) => /limit=1000$/.test(c.u)), JSON.stringify({ n: r3.filas.length, llamadas: m3.calls.length }));
}

// ─── R11: presupuestos de tiempo (la ejecución de Apps Script se corta a los 6 min) ──────────────────────────────
{
  // Lectura: a los 2.5 min las lecturas por cursor se detienen; escribe lo leído y sigue en 10 min.
  const st = { db: db(), reloj: 0, msPorFetch: 25000 };
  const r1 = makeSandbox(st).sb.actualizarRegistro();
  check("R11a lectura lenta: las lecturas por cursor se detienen a los 2.5 min, se escribe lo leído y se programa la continuación",
    r1.ok && r1.pendiente && (st.continuaciones || []).length === 1 && tab(st.ss, "Pacientes").length === 4 && tab(st.ss, "Labs del robot (WinLab)").length === 0 && !st.props.REG_CURSOR_winlab_labs, JSON.stringify(r1));
  st.msPorFetch = 0; st.reloj = 0;
  const r2 = makeSandbox(st).sb.continuarRegistro();
  check("R11b la continuación termina: WinLab y RIS completos y los cursores guardados", r2.ok && !r2.pendiente && tab(st.ss, "Labs del robot (WinLab)").length === 3 && tab(st.ss, "Imagen del robot (RIS)").length === 1 && !!st.props.REG_CURSOR_winlab_labs && !!st.props.REG_CURSOR_archive, JSON.stringify(r2));
  // Una lectura de tabla chica que se pasa de 4 min: no escribe nada.
  const sh = { db: db(), reloj: 0, msPorFetch: 250000 };
  let eh = null; try { makeSandbox(sh).sb.actualizarRegistro(); } catch (e) { eh = String(e.message); }
  check("R11c lectura de más de 4 min: falla sin escribir", /pasó de 4 min/.test(eh || "") && !sh.ss.sheets["Pacientes"], eh);
  // Escritura lenta: después de 5 min 15 s no empieza otra pestaña; los cursores no avanzan y sigue en 10 min.
  const sw = { db: db(), reloj: 0, msPorEscritura: 100000 };
  const w1 = makeSandbox(sw).sb.actualizarRegistro();
  const dic = JSON.stringify(sw.ss.sheets["Diccionario"].cells);
  check("R11d escritura lenta: se detiene antes de los 6 min, no guarda cursores, avisa y programa la continuación",
    w1.ok && w1.pendiente && !sw.ss.sheets["Notas de evolución"] && !!sw.ss.sheets["Pacientes"] && !sw.props.REG_CURSOR_archive && !sw.props.REG_ULTIMA_CORRIDA && (sw.continuaciones || []).length === 1 && /Se acabó el tiempo al escribir/.test(dic), JSON.stringify(w1));
  sw.msPorEscritura = 0; sw.reloj = 0;
  makeSandbox(sw).sb.continuarRegistro();
  check("R11e la continuación escribe lo que faltó y guarda los cursores", !!sw.ss.sheets["Imagen del robot (RIS)"] && tab(sw.ss, "Labs del robot (WinLab)").length === 3 && !!sw.props.REG_CURSOR_archive && !!sw.props.REG_ULTIMA_CORRIDA);
  // Tope de vueltas extra: 8 en 24 h corridas (los disparadores de una cuenta personal tienen 90 min al día).
  const ahora = Date.UTC(2026, 9, 21, 23, 30);
  const sc = { db: db(), reloj: ahora, props: { REG_CONTINUACIONES: JSON.stringify(Array.from({ length: 8 }, (_, i) => ahora - (i + 1) * 3600000)) } };
  const mc = makeSandbox(sc); mc.sb.REG_CURSORES.archive.tope = 1;
  const rc = mc.sb.actualizarRegistro();
  check("R11f con 8 vueltas extra en las últimas 24 h no programa otra (aunque haya cambiado el día): avisa y sigue en la corrida de la noche",
    rc.pendiente && !(sc.continuaciones || []).length && /vueltas extra/.test(JSON.stringify(sc.ss.sheets["Diccionario"].cells)) && mc.triggers.every((t) => t.fn !== "continuarRegistro"));
  const sd = { db: db(), reloj: ahora, props: { REG_CONTINUACIONES: JSON.stringify(Array.from({ length: 8 }, (_, i) => ahora - 25 * 3600000 - i)) } };
  const md = makeSandbox(sd); md.sb.REG_CURSORES.archive.tope = 1; md.sb.actualizarRegistro(); md.sb.actualizarRegistro();
  check("R11g las de hace más de 24 h ya no cuentan, y nunca quedan dos continuaciones programadas", (sd.continuaciones || []).length === 2 && md.triggers.filter((t) => t.fn === "continuarRegistro").length === 1 && JSON.parse(sd.props.REG_CONTINUACIONES).length === 2);
  // Si la corrida de la noche termina la carga, la continuación que quedaba programada se borra (no corre de más).
  md.sb.REG_CURSORES.archive.tope = 400; md.sb.actualizarRegistro();
  check("R11h al terminar la carga se borra cualquier continuación pendiente", md.triggers.every((t) => t.fn !== "continuarRegistro") && /"Carga en curso","No"/.test(JSON.stringify(sd.ss.sheets["Diccionario"].cells)));
}

// ─── R12: fuentes que fallan, hoja que no abre, fechas, escritura incremental, capacidad ──────────────────────────
{
  // WinLab con la consulta más lenta que la base permite (57014): un solo intento; lo demás se escribe; WinLab no se toca.
  const st = { db: db(), agotado: { winlab_labs: true } };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  check("R12a una fuente acumulativa que falla (57014) no frena lo demás: un intento, aviso con el código, sus pestañas sin tocar y su cursor sin avanzar",
    r.ok && st.nLlamadas.winlab_labs === 1 && tab(st.ss, "Pacientes").length === 4 && !st.ss.sheets["Labs del robot (WinLab)"] && !st.props.REG_CURSOR_winlab_labs && !!st.props.REG_CURSOR_ris_estudios
    && /winlab_labs.*57014/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)) && m.logs.every((l) => !nombres.test(l)), JSON.stringify({ r, n: st.nLlamadas }));
  delete st.agotado;
  makeSandbox(st).sb.actualizarRegistro();
  check("R12b al día siguiente WinLab entra completo", tab(st.ss, "Labs del robot (WinLab)").length === 3 && !!st.props.REG_CURSOR_winlab_labs);
  const sp = { db: db(), agotado: { patients: true } };
  let ep = null; try { makeSandbox(sp).sb.actualizarRegistro(); } catch (e) { ep = String(e.message); }
  check("R12c el censo con 57014: un intento y error claro, sin escribir", ep === "Supabase patients HTTP 500 (57014)" && sp.nLlamadas.patients === 1 && !sp.ss.sheets["Pacientes"], ep);
  // Proyecto aparte sin REGISTRO_SHEET_ID, o con un id que no abre: error claro ANTES de leer Supabase.
  const sa = { db: db(), standalone: true }; const ma = makeSandbox(sa); let ea = null; try { ma.sb.actualizarRegistro(); } catch (e) { ea = String(e.message); }
  const sb2 = { db: db(), standalone: true, idMalo: true, props: { REGISTRO_SHEET_ID: "id-malo " } }; const mb = makeSandbox(sb2); let eb = null; try { mb.sb.actualizarRegistro(); } catch (e) { eb = String(e.message); }
  check("R12d sin REGISTRO_SHEET_ID o con uno que no abre: lo dice de inmediato, sin leer Supabase", /Falta REGISTRO_SHEET_ID/.test(ea || "") && ma.calls.length === 0 && /REGISTRO_SHEET_ID no abre/.test(eb || "") && mb.calls.length === 0, JSON.stringify([ea, eb]));
  // Fechas locales y labs sin marcas internas.
  const d = db();
  d.archive.push({ id: "a8", archived_at: "2026-10-12T02:00:00+00:00", patient_data: { _supa_id: "p9", nombre: "PRUEBA FICTICIA NUEVE", exp: "000909", ingreso: "2026-10-10" }, note_data: { labHistory: [{ fecha: "2026-10-11", labs: { hb: "10", fecha_labs: "2026-10-11", hora_labs: "06:00", _src: "x" } }] } });
  const sf = { db: d }; makeSandbox(sf).sb.actualizarRegistro();
  const p9 = tab(sf.ss, "Pacientes").find((x) => x["ID episodio"] === "p9");
  check("R12e fecha de egreso en hora de Ciudad de México (archivado a las 20:00 del 11 = 02:00 UTC del 12) y estancia de 1 día", p9 && p9["Fecha de egreso"] === "2026-10-11" && String(p9["Días de estancia"]) === "1", JSON.stringify(p9));
  check("R12f Labs sin fecha_labs, hora_labs ni marcas internas", JSON.stringify(tab(sf.ss, "Labs").filter((x) => x["ID episodio"] === "p9").map((x) => x["Estudio"])) === JSON.stringify(["hb"]));
  const s0 = makeSandbox({ db: db() }).sb;
  check("R12g regFechaLocal: 05:59 UTC es el día anterior, 06:00 UTC ya es el mismo día; fechas sin hora tal cual",
    s0.regFechaLocal("2026-10-12T05:59:00Z") === "2026-10-11" && s0.regFechaLocal("2026-10-12T06:00:00+00:00") === "2026-10-12" && s0.regFechaLocal("12/10/2026") === "2026-10-12" && s0.regFechaLocal("2026-10-12") === "2026-10-12");
  // Ya no hay respaldo semanal: ni a los 7 días ni después se crea una copia.
  const sr = { db: db(), hoy: "2026-10-21", props: { REG_ULTIMO_RESPALDO: "2026-10-01" } }; makeSandbox(sr).sb.actualizarRegistro();
  const sr2 = { db: db(), hoy: "2026-12-22", props: {} }; makeSandbox(sr2).sb.actualizarRegistro();
  check("R12h sin respaldo semanal: aunque hayan pasado 7 días o más no se crea ninguna copia (la carpeta queda con una sola hoja)", sr.drive.files.length === 0 && sr2.drive.files.length === 0 && !sr.props.REG_ULTIMO_RESPALDO);
  const sv = { db: db(), driveFalla: true }; const rv = makeSandbox(sv).sb.actualizarRegistro();
  check("R12i si Drive falla al quitar las copias viejas, avisa y escribe de todos modos (y lo vuelve a intentar la próxima vez)", rv.ok && tab(sv.ss, "Pacientes").length === 4 && /copias de respaldo viejas/.test(rv.avisos.join(" ")) && !sv.props.REG_COPIAS_QUITADAS);
  // Escritura incremental: una corrida igual no reescribe nada; un cambio reescribe solo su renglón.
  const si = { db: db() }; makeSandbox(si).sb.actualizarRegistro();
  const escritas = () => Object.fromEntries(Object.entries(si.ss.sheets).map(([n, h]) => [n, h.filasEscritas || 0]));
  const e0 = escritas(); makeSandbox(si).sb.actualizarRegistro(); const e1 = escritas();
  const sinCambio = Object.keys(e0).filter((n) => n !== "Diccionario" && n !== "Integridad").every((n) => e0[n] === e1[n]);
  si.db.notes[0].pendientes = "+ USG (HECHO)"; makeSandbox(si).sb.actualizarRegistro(); const e2 = escritas();
  check("R12j escritura incremental: una corrida sin cambios no reescribe ninguna pestaña; un cambio reescribe solo su renglón",
    sinCambio && e2["Pacientes"] - e1["Pacientes"] === 1 && e2["Labs"] === e1["Labs"] && tab(si.ss, "Pacientes").find((x) => x["ID episodio"] === "p1")["Pendientes"] === "+ USG (HECHO)", JSON.stringify({ e0, e1, e2 }));
  // Capacidad: las pestañas nuevas no guardan columnas vacías y la cuenta incluye todas las hojas.
  const tot = Object.values(si.ss.sheets).reduce((s, h) => s + h.maxR * h.maxC, 0);
  check("R12k pestañas nuevas sin columnas de sobra y la cuenta de celdas incluye todas las hojas",
    si.ss.sheets["Labs"].maxC === 9 && si.ss.sheets["Diccionario"].maxC === 2 && si.ss.sheets["Pacientes"].maxC === 56 && JSON.stringify(si.ss.sheets["Diccionario"].cells).includes('"' + tot + ' de 10000000'), String(tot));
}

// ─── R13: una respuesta cortada no cuela datos al error ──────────────────────────────────────────────────────────
{
  const st = { db: db(), cortada: { patients: true } };
  let e = null; try { makeSandbox(st).sb.actualizarRegistro(); } catch (x) { e = String(x.message); }
  const sr = { db: db(), cortada: { ris_estudios: true } }; const r = makeSandbox(sr).sb.actualizarRegistro();
  check("R13 respuesta cortada (JSON inválido): el error y el aviso no citan el texto recibido",
    e === "Supabase patients: la respuesta no es JSON válido (fila 0)" && r.ok && /ris_estudios/.test(r.avisos.join(" ")) && !nombres.test(r.avisos.join(" ")) && !nombres.test(e), JSON.stringify([e, r.avisos]));
}

// ─── R14: la hoja es del investigador también: columnas por nombre, filas en su renglón ─────────────────────────
{
  const colDe = (sh, nombre) => sh.cells[0].indexOf(nombre);
  // Columna del investigador a la derecha y, después, una versión del script con una columna más.
  const st = { db: db() }; makeSandbox(st).sb.actualizarRegistro();
  const sh = st.ss.sheets["Pacientes"], nc = sh.cells[0].length;
  sh.maxC = nc + 1; sh.cells[0][nc] = "Grupo del estudio";
  for (let i = 1; i < sh.cells.length; i++) if (sh.cells[i] && sh.cells[i][0]) sh.cells[i][nc] = "GRUPO-" + sh.cells[i][0];
  const m2 = makeSandbox(st); m2.sb.REG_PESTANAS[0].columnas.splice(5, 0, "Columna nueva de la versión siguiente");
  st.db.notes[0].pendientes = "CAMBIO DEL DÍA";
  const r2 = m2.sb.actualizarRegistro();
  const P = tab(st.ss, "Pacientes");
  check("R14a una versión con una columna más: la del investigador sigue con sus valores en su fila; la nueva va al final y se avisa",
    colDe(sh, "Grupo del estudio") === nc && colDe(sh, "Columna nueva de la versión siguiente") === nc + 1 && P.every((x) => x["Grupo del estudio"] === "GRUPO-" + x["ID episodio"])
    && P.find((x) => x["ID episodio"] === "p1")["Pendientes"] === "CAMBIO DEL DÍA" && /Columna nueva/.test(r2.avisos.join(" ")), JSON.stringify(sh.cells[0].slice(-3)));
  // Un encabezado renombrado (no clave): sus datos siguen en la columna renombrada; la del registro se agrega al final.
  const s3 = { db: db() }; makeSandbox(s3).sb.actualizarRegistro();
  const h3 = s3.ss.sheets["Pacientes"]; h3.cells[0][colDe(h3, "Diagnóstico")] = "Dx";
  const d3 = db(); d3.archive = d3.archive.filter((a) => a.id !== "a1" && a.id !== "a2"); s3.db = d3;   // p3 ya no se lee
  const r3 = makeSandbox(s3).sb.actualizarRegistro();
  const p3 = tab(s3.ss, "Pacientes").find((x) => x["ID episodio"] === "p3");
  check("R14b encabezado renombrado: lo que tenía sigue en la columna renombrada (nada en blanco) y se avisa", p3 && p3["Dx"] === "HERNIA INGUINAL" && /Diagnóstico/.test(r3.avisos.join(" ")), JSON.stringify(p3 && { dx: p3["Dx"], diag: p3["Diagnóstico"] }));
  // Un renglón sin clave en medio y una columna del investigador: ninguna fila se recorre.
  const s4 = { db: db() }; makeSandbox(s4).sb.actualizarRegistro();
  const h4 = s4.ss.sheets["Pacientes"], n4 = h4.cells[0].length;
  h4.maxC = n4 + 1; h4.cells[0][n4] = "Incluido";
  h4.cells.splice(2, 0, Array(n4).fill("")); h4.cells[2][1] = "NOTA SUELTA DEL INVESTIGADOR";
  for (let i = 1; i < h4.cells.length; i++) if (h4.cells[i] && h4.cells[i][0]) h4.cells[i][n4] = "SI-" + h4.cells[i][0];
  s4.db.notes[0].pendientes = "OTRO CAMBIO"; s4.db.patients.push({ id: "p9", nombre: "PRUEBA FICTICIA NUEVA", exp: "000999X", cama: "3-250" });
  makeSandbox(s4).sb.actualizarRegistro();
  const P4 = tab(s4.ss, "Pacientes");
  check("R14c con un renglón sin clave en medio: cada fila sigue junto a su marca del investigador, la nota suelta intacta y la nueva al final",
    P4.filter((x) => x["ID episodio"] && x["ID episodio"] !== "p9").every((x) => x["Incluido"] === "SI-" + x["ID episodio"]) && h4.cells[2][1] === "NOTA SUELTA DEL INVESTIGADOR"
    && P4[P4.length - 1]["ID episodio"] === "p9" && P4.find((x) => x["ID episodio"] === "p1")["Pendientes"] === "OTRO CAMBIO", JSON.stringify(P4.map((x) => [x["ID episodio"], x["Incluido"]])));
  // Una columna borrada en medio: se agrega de nuevo al final; nada se recorre sobre la del investigador.
  const s5 = { db: db() }; makeSandbox(s5).sb.actualizarRegistro();
  const h5 = s5.ss.sheets["Pacientes"], n5 = h5.cells[0].length, cm = colDe(h5, "Misceláneo");
  h5.maxC = n5 + 1; h5.cells[0][n5] = "Grupo";
  for (let i = 1; i < h5.cells.length; i++) if (h5.cells[i] && h5.cells[i][0]) h5.cells[i][n5] = "G-" + h5.cells[i][0];
  h5.deleteColumns(cm + 1, 1);
  makeSandbox(s5).sb.actualizarRegistro();
  const P5 = tab(s5.ss, "Pacientes");
  check("R14d una columna borrada en medio: se vuelve a agregar al final y la del investigador sigue intacta", P5.every((x) => x["Grupo"] === "G-" + x["ID episodio"]) && colDe(h5, "Misceláneo") === n5, JSON.stringify(h5.cells[0].slice(-3)));
  // Escritura cortada a la mitad de una pestaña (6 min): nada se revuelve; la siguiente vuelta completa.
  // Empieza la pestaña a los 5 min 10 s; el encabezado tarda 40 s; antes de escribir las filas (5 min 50 s) se corta.
  // Justo después de escribir el encabezado de Pacientes el reloj salta a 5 min 50 s: las filas ya no se escriben.
  const s6 = { db: db(), reloj: 0 };
  s6.alEscribir = (hoja, n) => { if (hoja === "Pacientes" && n === 1 && s6.reloj < 300000) s6.reloj = 350000; };
  const r6 = makeSandbox(s6).sb.actualizarRegistro();
  const aMedias = s6.ss.sheets["Pacientes"].cells.length === 1 && /Se acabó el tiempo/.test(r6.avisos.join(" ")) && !s6.props.REG_CURSOR_archive;
  delete s6.alEscribir; s6.reloj = 0;
  makeSandbox(s6).sb.continuarRegistro();
  const s7 = { db: db() }; makeSandbox(s7).sb.actualizarRegistro();
  const igual = ["Pacientes", "Labs", "Cirugías", "Labs del robot (WinLab)"].every((n) => JSON.stringify(tab(s6.ss, n)) === JSON.stringify(tab(s7.ss, n)));
  check("R14e una escritura cortada a la mitad de una pestaña no revuelve nada: tras la vuelta siguiente la hoja queda igual que sin corte", aMedias && igual, JSON.stringify({ aMedias, igual }));
  // Pasados los 5 min 15 s no empieza otra pestaña, aunque aún no llegue al corte de dentro de la pestaña (5 min 40 s).
  const s8 = { db: db(), reloj: 0 };
  s8.alEscribir = (hoja, n) => { if (hoja === "Pacientes" && n > 1) s8.reloj = 320000; };
  makeSandbox(s8).sb.actualizarRegistro();
  check("R14f pasados los 5 min 15 s no empieza otra pestaña", !!s8.ss.sheets["Pacientes"] && tab(s8.ss, "Pacientes").length === 4 && !s8.ss.sheets["Cirugías"]);
}

// ─── R15: todas las copias de la Papelera de un episodio, y «Carga en curso» fiel ────────────────────────────────
{
  // Día 1: p3 con sus dos copias. Día 2: la Papelera incremental ya no trae la vieja (a1), pero p3 vuelve a aparecer
  // con una copia nueva (a9): la unión sigue viendo las tres, así que lo que solo traía a1 no se pierde ni se marca «No».
  const d = db(); d.archive[0].note_data.labHistory = [{ fecha: "2026-10-03", labs: { hb: "12" } }]; d.archive[0].patient_data.adscrito = "DR. SOLO EN LA COPIA VIEJA";
  const st = { db: d }; makeSandbox(st).sb.actualizarRegistro();
  st.props.REG_CURSOR_archive = "2026-10-20T00:00:00+00:00";
  d.archive.push({ id: "a9", archived_at: "2026-10-21T10:00:00+00:00", patient_data: { _supa_id: "p3", nombre: "PRUEBA FICTICIA TRES", exp: "000789" }, note_data: { _egreso: "alta médica", pendientes: "COPIA NUEVA" } });
  const m = makeSandbox(st); m.sb.actualizarRegistro();
  const p3 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p3");
  const l3 = tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p3");
  check("R15a una copia nueva en la Papelera se une con TODAS las anteriores del episodio (no solo las de la ventana incremental)",
    p3["Pendientes"] === "COPIA NUEVA" && p3["Adscrito"] === "DR. SOLO EN LA COPIA VIEJA" && l3.length === 2 && l3.every((x) => x["Vigente"] === "Sí") && m.calls.some((c) => /archive\?.*patient_data->>_supa_id=in\.\(/.test(c.u)), JSON.stringify({ p3, l3 }));
  // Una fuente opcional falla a mitad de su primera carga: la carga sigue «en curso» y se programa otra vuelta.
  const s2 = { db: db() }; const m1 = makeSandbox(s2); m1.sb.REG_CURSORES.winlab_labs.tope = 1; m1.sb.actualizarRegistro();
  const sigue = !!s2.props.REG_SIGUE_winlab_labs; s2.continuaciones = [];
  s2.agotado = { winlab_labs: true };
  const r2 = makeSandbox(s2).sb.continuarRegistro();
  check("R15b WinLab falla a la mitad de su primera carga: el Diccionario dice que la carga sigue y se programa otra vuelta",
    sigue && r2.pendiente && s2.continuaciones.length === 1 && /"Carga en curso","Sí/.test(JSON.stringify(s2.ss.sheets["Diccionario"].cells)) && !!s2.props.REG_SIGUE_winlab_labs);
}

// ─── R16: URLs de 2 KB como máximo (límite de UrlFetchApp), con un censo grande de ids uuid ─────────────────────
{
  const d = db(); const uuid = (i) => "8f0c2a4e-" + String(1000 + i) + "-4b7a-9c1d-" + String(100000000000 + i);
  for (let i = 0; i < 60; i++) { d.patients.push({ id: uuid(i), nombre: "PRUEBA FICTICIA U" + i, exp: "U" + i }); d.archive.push({ id: "c" + i, archived_at: "2026-10-1" + (i % 9) + "T10:00:00+00:00", patient_data: { _supa_id: uuid(i), nombre: "PRUEBA FICTICIA U" + i, exp: "U" + i }, note_data: { pendientes: "COPIA " + i } }); }
  const st = { db: d }; const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const largo = Math.max.apply(null, m.calls.map((c) => c.raw.length));
  check("R16 con 60 episodios las URLs miden menos de 2 KB (las copias de la Papelera van de 20 en 20) y todo se lee", r.ok && largo < 2048 && m.calls.filter((c) => /_supa_id%3E/.test(c.raw) || /_supa_id=in/.test(c.u)).length >= 3 && tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === uuid(59))["Pendientes"] === "COPIA 59", String(largo));
}

// ─── R17–R22: pestañas de análisis para investigación (27 oct 2026) ──────────────────────────────────────────────
// Datos FICTICIOS con cada caso de precisión: hospitalización restaurada desde la Papelera (dos ids), reingreso, dos
// personas con el mismo expediente, copia técnica que no tapa el alta, duplicado, valores rechazados/imposibles/sin
// unidad/con «<», clave vieja (hto), identificadores dentro de labs, signos con texto y fuera de rango, cultivos.
const AN = ["Análisis · Episodios", "Análisis · Labs", "Análisis · Signos vitales", "Análisis · Cultivos"];
function dbAn() {
  return {
    patients: [
      { id: "q2", cama: "3-301", nombre: "PRUEBA FICTICIA RESTAURADA", exp: "0001111", edad: "8 meses", ingreso: "2026-10-12", estado: "ESTABLE", esp: "CG" },
      { id: "v1", cama: "3-302", nombre: "PRUEBA FICTICIA VALORES", exp: "0004444", edad: "70", ingreso: "2026-10-18", estado: "GRAVE", dx: "PERITONITIS", esp: "CG" },
      { id: "w1", cama: "3-303", nombre: "PRUEBA FICTICIA SALIO", exp: "0005555", edad: "40", ingreso: "2026-10-15", estado: "ESTABLE" }
    ],
    notes: [
      { patient_id: "q2", checklist: { sexo: "Femenino" }, lab_history: [{ fecha: "2026-10-11", source: "winlab", labs: { hb: "10.2", k: "4.0" } }, { fecha: "2026-10-12", source: "winlab", labs: { hb: "9.5" } }] },
      { patient_id: "v1", checklist: { sexo: "F", atb: true, atb_nombre: "MEROPENEM",
          cirugias: [{ id: "c1", fecha: "2026-10-19", procedimiento: "LAPAROTOMIA", sangrado: "MÍNIMO" }, { id: "c2", fecha: "2026-10-20", procedimiento: "LAVADO QUIRURGICO", sangrado: "100 ML" }],
          pm_hist: [{ fecha: "2026-10-19", fc: "400", fr: "20 rpm", temp: "36,5", sao2: "95%", o2l: "AA", ta: "80/120", uresis: "1,200", dxtx: "HI", iu: "4", balance: "-300" }] },
        lab_history: [{ fecha: "2026-10-19", source: "winlab", labs: { hb: "RECHAZADA", k: "6.3", na: "REVISAR UNIDAD (MEQ/24H)", pct: "<0.05", cr: "1,4", leucos: "ABUNDANTES", hto: "31", plaq: "125000",
          paciente: "PRUEBA FICTICIA VALORES", ego_nitri: "NEGATIVO", glu: "45" }, extra: [{ nombre: "LIPASA SERICA", valor: "80" }] }] },
      { patient_id: "w1", checklist: {} }
    ],
    archive: [
      { id: "b1", archived_at: "2026-10-12T15:00:00+00:00", patient_data: { _supa_id: "q1", nombre: "PRUEBA FICTICIA RESTAURADA", exp: "0001111", ingreso: "2026-10-10", edad: "8 meses" },
        note_data: { _egreso: "RETIRADO DEL CENSO (hoja)", _restaurado_a: "q2", labHistory: [{ fecha: "2026-10-11", source: "winlab", labs: { hb: "10.2", k: "4.4" } }] } },
      { id: "b2", archived_at: "2026-09-10T18:00:00+00:00", patient_data: { _supa_id: "r1", nombre: "PRUEBA FICTICIA REINGRESO", exp: "0002222", ingreso: "2026-09-01", edad: "55" }, note_data: { _egreso: "alta médica", _egresoFecha: "10/09/2026" } },
      { id: "b3", archived_at: "2026-10-03T10:00:00+00:00", patient_data: { _supa_id: "r2", nombre: "PRUEBA FICTICIA REINGRSO", exp: "0002222", ingreso: "2026-09-25", edad: "55", estado: "DEFUNCIÓN" }, note_data: {} },
      { id: "b4", archived_at: "2026-09-08T10:00:00+00:00", patient_data: { _supa_id: "s1", nombre: "OTRA PERSONA FICTICIA", exp: "0002222", ingreso: "2026-09-05" }, note_data: { _egreso: "RETIRADO DEL CENSO (hoja)" } },
      { id: "b5", archived_at: "2026-10-05T12:00:00+00:00", patient_data: { _supa_id: "t1", nombre: "PRUEBA FICTICIA RESCATE", exp: "0003333", ingreso: "2026-10-01" }, note_data: { _egreso: "alta médica", _egresoFecha: "05/10/2026" } },
      { id: "b6", archived_at: "2026-10-07T12:00:00+00:00", patient_data: { _supa_id: "t1", nombre: "PRUEBA FICTICIA RESCATE", exp: "0003333" }, note_data: { _egreso: "CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)", _egresoFecha: "07/10/2026" } },
      { id: "b7", archived_at: "2026-10-02T12:00:00+00:00", patient_data: { _supa_id: "d1", nombre: "PRUEBA FICTICIA RESCATE", exp: "0003333", ingreso: "2026-10-01" }, note_data: { _egreso: "DUPLICADO (eliminado a mano)" } }
    ],
    cronologia_respaldo: [], procedimientos_dia: [], ris_estudios: [],
    winlab_labs: [
      { id: 50, exp: "0004444", paciente: "PRUEBA FICTICIA VALORES", fecha: "2026-10-19", scraped_at: "2026-10-19T08:00:00+00:00", data: { reportes: [
        { __hasLink: true, __target: true, __cells: ["", "", "F500", "17/10/2026 23:00", "19/10/2026 07:00", "CIRUGIA GENERAL"], valores: [{ estudio: "UROCULTIVO", valor: "POSITIVO" }],
          cultivo: { secciones: [{ tipo: "Urocultivo", muestra: "ORINA", resultado: "POSITIVO", germenes: [{ nombre: "Escherichia coli", flags: ["BLEE"], ufc: ">100,000", antibiograma: [{ antibiotico: "AMIKACINA", interp: "S" }, { antibiotico: "CEFTRIAXONA", interp: "R" }] }] }] } }] } },
      { id: 51, exp: "0004444", paciente: "OTRA PERSONA FICTICIA", fecha: "2026-10-19", scraped_at: "2026-10-19T09:00:00+00:00", data: { reportes: [
        { __hasLink: true, __target: true, __cells: ["", "", "F501", "19/10/2026 06:00", "19/10/2026 08:00", "MEDICINA INTERNA"], valores: [{ estudio: "HEMOCULTIVO", valor: "1", unidad: "DESARROLLO" }, { estudio: "NEGATIVO A", valor: "5", unidad: "DIAS" }] }] } }
    ]
  };
}
const fichas = /FICTICI|0001111|0002222|0003333|0004444|0005555|000123|000456|000789|000999/;
{
  const st = { db: dbAn(), hoy: "2026-10-21" };
  const r = makeSandbox(st).sb.actualizarRegistro();
  const E = tab(st.ss, AN[0]), L = tab(st.ss, AN[1]), S = tab(st.ss, AN[2]), C = tab(st.ss, AN[3]), K = tab(st.ss, "Clave de seudónimos");
  const cod = Object.fromEntries(K.map((x) => [x["ID episodio"], x]));
  const ep = (id) => E.find((x) => x["ID episodio"] === cod[id]["ID episodio (análisis)"]);
  check("R17a corre sin avisos y crea la clave, las cuatro pestañas de análisis y el diccionario de variables",
    r.ok && !r.avisos.length && AN.concat(["Clave de seudónimos", "Diccionario de variables"]).every((n) => st.ss.sheets[n] && st.ss.sheets[n].cells.length > 1), JSON.stringify(r.avisos));
  const todoAn = JSON.stringify(AN.concat(["Diccionario de variables"]).map((n) => st.ss.sheets[n].cells));
  check("R17b ningún nombre ni expediente en las pestañas de análisis (tampoco el «paciente» que venía dentro de los labs)", !fichas.test(todoAn), (todoAn.match(fichas) || [])[0]);
  check("R17c seudónimos con formato fijo (P-/E-/C- + 12 hexadecimales) y la sal guardada en las propiedades del script",
    E.every((x) => /^E-[0-9A-F]{12}$/.test(x["ID episodio"]) && /^P-[0-9A-F]{12}$/.test(x["ID paciente"])) && C.every((x) => /^C-[0-9A-F]{12}$/.test(x["ID cultivo"])) && /^uuid-/.test(st.props.REG_SAL || ""));
  check("R17d restaurada desde la Papelera (q1 → q2): UN episodio con 2 partes, ingreso más antiguo, sigue hospitalizado, misma clave en las dos partes",
    E.length === 8 && cod.q1["ID episodio (análisis)"] === cod.q2["ID episodio (análisis)"] && ep("q2")["Partes del registro"] === 2 && ep("q2")["Fecha de ingreso"] === "2026-10-10"
    && ep("q2")["Estado"] === "Hospitalizado" && ep("q2")["Egreso observado"] === 0 && ep("q2")["Tipo de egreso"] === "" && ep("q2")["Defunción"] === "" && /2 partes/.test(ep("q2")["Calidad de datos"])
    && ep("q2")["Edad (años)"] === 0.67 && ep("q2")["Sexo"] === "F" && ep("q2")["Días de estancia"] === 11, JSON.stringify(ep("q2")));
  const lq = L.filter((x) => x["ID episodio"] === cod.q2["ID episodio (análisis)"]);
  check("R17e labs de las dos partes en un solo episodio; el mismo día con dos valores distintos se dice en Observaciones (gana la parte más reciente)",
    lq.length === 2 && lq[0]["Fecha"] === "2026-10-11" && lq[0]["Hemoglobina (g/dL)"] === 10.2 && lq[0]["Potasio (mmol/L)"] === 4 && /Potasio: otra parte del episodio decía 4\.4 \(se tomó 4\.0, la más reciente\)/.test(lq[0]["Observaciones"])
    && lq[1]["Hemoglobina (g/dL)"] === 9.5 && lq[0]["Día de estancia"] === 1 && lq[1]["Día de estancia"] === 2, JSON.stringify(lq));
  check("R17f reingreso: misma persona aunque el nombre tenga un error de una letra; 15 días entre egreso e ingreso; defunción en el segundo",
    cod.r1["ID paciente (análisis)"] === cod.r2["ID paciente (análisis)"] && ep("r1")["N.º de episodio del paciente"] === 1 && ep("r1")["Reingreso a 30 días"] === 1 && ep("r1")["Tipo de egreso"] === "Alta" && ep("r1")["Defunción"] === 0
    && ep("r2")["N.º de episodio del paciente"] === 2 && ep("r2")["Días desde el egreso previo"] === 15 && ep("r2")["Es reingreso (≤30 días)"] === 1 && ep("r2")["Tipo de egreso"] === "Defunción"
    && ep("r2")["Defunción"] === 1 && ep("r2")["Reingreso a 30 días"] === "" && ep("r2")["Fecha de egreso"] === "2026-10-03", JSON.stringify([ep("r1"), ep("r2")]));
  check("R17g otra persona con el MISMO expediente: otro ID paciente, no entra en la serie de reingresos del primero; las dos dicen «expediente compartido»",
    cod.s1["ID paciente (análisis)"] !== cod.r1["ID paciente (análisis)"] && ep("s1")["N.º de episodio del paciente"] === 1 && ep("r2")["N.º de episodio del paciente"] === 2
    && cod.s1["Identidad del paciente por"] === "Expediente + nombre (expediente compartido)" && cod.r1["Identidad del paciente por"] === "Expediente + nombre (expediente compartido)"
    && ep("s1")["Tipo de egreso"] === "Motivo no registrado" && ep("s1")["Defunción"] === "", JSON.stringify(K));
  const pt1 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "t1");
  check("R17h una copia técnica más nueva (rescate de cambios sin subir) NO tapa el alta real ni su fecha (en Pacientes y en Análisis)",
    pt1["Motivo de egreso"] === "alta médica" && pt1["Fecha de egreso"] === "2026-10-05" && ep("t1")["Tipo de egreso"] === "Alta" && ep("t1")["Días de estancia"] === 4, JSON.stringify(pt1));
  check("R17i duplicado eliminado a mano: Excluir = 1, sin egreso observado y fuera de la serie de reingresos",
    ep("d1")["Excluir (duplicado)"] === 1 && ep("d1")["Egreso observado"] === 0 && ep("d1")["N.º de episodio del paciente"] === "" && ep("t1")["N.º de episodio del paciente"] === 1 && ep("t1")["Excluir (duplicado)"] === 0);
  const lv = L.find((x) => x["ID episodio"] === cod.v1["ID episodio (análisis)"]);
  check("R17j labs: rechazada, unidad no reconocida, texto e imposible quedan VACÍOS y explicados; «<0.05» → 0.05; «1,4» → 1.4; hto → Hematocrito; cualitativo como texto; otros estudios aparte",
    lv["Hemoglobina (g/dL)"] === "" && lv["Sodio (mmol/L)"] === "" && lv["Leucocitos (k/µL)"] === "" && lv["Plaquetas (k/µL)"] === "" && lv["Procalcitonina (ng/mL)"] === 0.05 && lv["Creatinina (mg/dL)"] === 1.4
    && lv["Hematocrito (%)"] === 31 && lv["Orina: nitritos"] === "NEGATIVO" && lv["Otros estudios"] === "LIPASA SERICA: 80"
    && ["Hemoglobina: muestra rechazada", "Sodio: unidad no reconocida (MEQ/24H)", "Leucocitos: «ABUNDANTES» no es un número", "Plaquetas: 125000 fuera de lo posible", "Procalcitonina: <0.05 (se anotó 0.05)"].every((t) => lv["Observaciones"].indexOf(t) !== -1),
    JSON.stringify(lv));
  check("R17k valores críticos con la tabla única de la app (glucosa ≤50, potasio ≥6) y su cuenta en el episodio; resumen del episodio",
    lv["Valores críticos"] === "Glucosa 45; Potasio 6.3" && ep("v1")["Valores críticos (n)"] === 2 && ep("v1")["Potasio máximo (mmol/L)"] === 6.3 && ep("v1")["Creatinina inicial (mg/dL)"] === 1.4 && ep("v1")["Hb mínima (g/dL)"] === "", JSON.stringify(ep("v1")));
  const sv = S.find((x) => x["ID episodio"] === cod.v1["ID episodio (análisis)"]);
  check("R17l signos: «36,5» → 36.5, «95%» → 95, «AA» → 0 L/min, «1,200» mL → 1200, «-300» → -300, unidad escrita aceptada; FC 400, DxTx «HI» y TA 80/120 vacíos y explicados",
    sv["Temperatura (°C)"] === 36.5 && sv["SaO2 (%)"] === 95 && sv["O2 (L/min)"] === 0 && sv["Uresis (mL)"] === 1200 && sv["Balance (mL)"] === -300 && sv["FR (rpm)"] === 20 && sv["Insulina (UI)"] === 4
    && sv["FC (lpm)"] === "" && sv["Glucemia capilar (mg/dL)"] === "" && sv["TA sistólica (mmHg)"] === "" && /FC 400 fuera de lo posible/.test(sv["Observaciones"]) && /DxTx «HI»/.test(sv["Observaciones"]) && /TA «80\/120» no interpretable/.test(sv["Observaciones"]), JSON.stringify(sv));
  check("R17m cirugías: dos fechas, días a la primera; un sangrado «MÍNIMO» deja el total vacío y lo dice",
    ep("v1")["Cirugías (n)"] === 2 && ep("v1")["Primera cirugía"] === "2026-10-19" && ep("v1")["Días ingreso a 1.ª cirugía"] === 1 && ep("v1")["Sangrado total (mL)"] === "" && /sangrado sin número en 1/.test(ep("v1")["Calidad de datos"])
    && ep("v1")["Antibiótico (registrado)"] === 1 && ep("v1")["Procedimientos"] === "2026-10-19 LAPAROTOMIA | 2026-10-20 LAVADO QUIRURGICO");
  const cv = C.find((x) => x["ID episodio"] === cod.v1["ID episodio (análisis)"]), co = C.find((x) => x["ID episodio"] === "");
  check("R17n cultivo tomado en urgencias (1 día antes del ingreso) va al episodio con su germen y antibiograma; el de OTRA persona con ese expediente no, y con otro ID paciente",
    C.length === 2 && cv && cv["Día de estancia"] === -1 && cv["Positivo"] === 1 && cv["Germen"] === "Escherichia coli (BLEE)" && cv["Sensibles"] === "AMIKACINA" && cv["Resistentes"] === "CEFTRIAXONA" && cv["Hora de toma"] === "23:00"
    && ep("v1")["Cultivos (n)"] === 1 && ep("v1")["Cultivos positivos (n)"] === 1 && ep("v1")["Gérmenes aislados"] === "Escherichia coli"
    && co && co["ID paciente"] !== cod.v1["ID paciente (análisis)"] && co["Positivo"] === 0, JSON.stringify(C));
  const sh = st.ss.sheets[AN[1]], h = sh.cells[0], col = (n) => h.indexOf(n) + 1;
  check("R17o números guardados como número con formato numérico (no texto); fechas y textos en texto plano",
    sh.fmt["2:" + col("Hemoglobina (g/dL)")] === "0.0#####" && sh.fmt["2:" + col("Día de estancia")] === "0" && sh.fmt["2:" + col("Fecha")] === "@" && sh.fmt["2:" + col("Observaciones")] === "@"
    && typeof lv["Potasio (mmol/L)"] === "number" && typeof ep("v1")["Días de estancia"] === "number" && typeof ep("v1")["Fecha de ingreso"] === "string");

  // Día 2: w1 sale de la base sin pasar por la Papelera; se corrige (borra) el lab del 19/10 de v1. Sin la sal (otro
  // proyecto de Apps Script): los seudónimos se conservan por la clave guardada.
  const d2 = dbAn(); d2.patients = d2.patients.filter((p) => p.id !== "w1"); d2.notes[1].lab_history = [];
  st.db = d2; st.hoy = "2026-10-22"; const salVieja = st.props.REG_SAL; delete st.props.REG_SAL;
  const r2 = makeSandbox(st).sb.actualizarRegistro();
  const E2 = tab(st.ss, AN[0]), L2 = tab(st.ss, AN[1]), K2 = tab(st.ss, "Clave de seudónimos");
  const ew = E2.find((x) => x["ID episodio"] === cod.w1["ID episodio (análisis)"]);
  check("R18a salió de la base sin egreso: «Sin egreso registrado», estancia hasta el último día visto, censurado (egreso observado 0) y defunción desconocida",
    r2.ok && ew["Estado"] === "Sin egreso registrado" && ew["Días de estancia"] === 6 && ew["Egreso observado"] === 0 && ew["Tipo de egreso"] === "Motivo no registrado" && ew["Defunción"] === "", JSON.stringify(ew));
  const lv2 = L2.find((x) => x["ID episodio"] === cod.v1["ID episodio (análisis)"]);
  check("R18b un lab corregido en la tarjeta: la fila de análisis de ese día queda marcada Vigente = No (no se borra) y deja de contar en el episodio",
    lv2 && lv2["Vigente"] === "No" && L2.length === L.length && E2.find((x) => x["ID episodio"] === cod.v1["ID episodio (análisis)"])["Valores críticos (n)"] === 0);
  check("R18c sin la sal (otro proyecto): los seudónimos de la clave guardada se conservan; la sal nueva no cambia nada de lo ya escrito",
    !!st.props.REG_SAL && st.props.REG_SAL !== salVieja && K2.every((x) => cod[x["ID episodio"]] && cod[x["ID episodio"]]["ID paciente (análisis)"] === x["ID paciente (análisis)"] && cod[x["ID episodio"]]["ID episodio (análisis)"] === x["ID episodio (análisis)"])
    && E2.length === E.length && E2.every((x) => x["Vigente"] === "Sí"), JSON.stringify(K2));
  const antes = snap(st.ss); makeSandbox(st).sb.actualizarRegistro();
  check("R18d idempotente: otra corrida con los mismos datos deja todo igual (análisis incluido)", snap(st.ss) === antes);
}
{
  // R19: la sal sí importa: con otra sal (libro nuevo) cambian todos los seudónimos.
  const a = { db: dbAn(), hoy: "2026-10-21", props: { REG_SAL: "sal-uno" } }, b = { db: dbAn(), hoy: "2026-10-21", props: { REG_SAL: "sal-dos" } };
  makeSandbox(a).sb.actualizarRegistro(); makeSandbox(b).sb.actualizarRegistro();
  const ka = tab(a.ss, "Clave de seudónimos"), kb = tab(b.ss, "Clave de seudónimos");
  check("R19 con otra sal los seudónimos son otros (sin la sal no se puede volver al expediente)", ka.length === kb.length && ka.every((x) => !kb.some((y) => y["ID paciente (análisis)"] === x["ID paciente (análisis)"] || (x["ID episodio (análisis)"] && y["ID episodio (análisis)"] === x["ID episodio (análisis)"]))));
}
{
  // R20: si el análisis falla, el registro se escribe igual y se avisa; si no alcanza el tiempo, se pospone.
  const st = { db: dbAn(), hoy: "2026-10-21" };
  const m = makeSandbox(st); m.sb.Utilities.computeDigest = () => { throw new Error("Exception: Service unavailable"); };
  const r = m.sb.actualizarRegistro();
  check("R20a una falla del análisis no detiene el registro: Pacientes escrito y aviso en el Diccionario", r.ok && tab(st.ss, "Pacientes").length === 9 && r.avisos.some((a) => /pestañas de análisis/.test(a)) && !st.ss.sheets[AN[0]]
    && /pestañas de análisis/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)), JSON.stringify(r.avisos));
  const s2 = { db: dbAn(), reloj: 0 };
  // 24 nov 2026: la última pestaña del registro ya no es la de RIS sino la de actividad (auditoría).
  s2.alEscribir = (hoja) => { if (hoja === "Actividad por episodio y día") s2.reloj = 320000; };
  s2.db.ris_estudios = [{ id: 10, patient_id: "v1", exp: "0004444", paciente: "PRUEBA FICTICIA VALORES", fecha: "19/10/2026", modalidad: "TC", estudios: "TC ABDOMEN", scraped_at: "2026-10-19T10:00:00+00:00" }];
  const r2 = makeSandbox(s2).sb.actualizarRegistro();
  check("R20b pasados los 5 min 15 s no empieza el análisis: se avisa y se hace en la siguiente corrida", r2.ok && !s2.ss.sheets[AN[0]] && r2.avisos.some((a) => /No alcanzó el tiempo para las pestañas de análisis/.test(a)) && !!s2.ss.sheets["Imagen del robot (RIS)"], JSON.stringify(r2.avisos));
}
{
  // R21: la tabla de labs del registro es COPIA de la de la app (index.html): clave, unidad, rangos, críticos e imposibles.
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const ini = html.indexOf("const LAB_GROUPS = ["), fin = html.indexOf("];", html.indexOf("id: \"lipidos_otros\""));
  const grupos = vm.runInNewContext("(" + html.slice(ini + "const LAB_GROUPS = ".length, fin + 1) + ")");
  const campos = grupos.flatMap((g) => g.fields);
  const imp = vm.runInNewContext("(" + /const LAB_IMPOSIBLE = (\{[\s\S]*?\});/.exec(html)[1] + ")");
  const { sb } = makeSandbox({ db: dbAn() });
  const meta = sb.REG_LAB_META, porK = Object.fromEntries(meta.map((m) => [m.k, m]));
  const malos = campos.filter((f) => { const m = porK[f.key]; const nn = (x) => (x === undefined || x === null ? null : x);
    return !m || m.u !== f.unit || nn(m.lo) !== nn(f.low) || nn(m.hi) !== nn(f.high) || nn(m.cl) !== nn(f.cl) || nn(m.ch) !== nn(f.ch) || (m.t === "texto") !== (f.low === null && f.high === null); });
  const sobran = meta.filter((m) => !m.extra && !campos.some((f) => f.key === m.k));
  check("R21a REG_LAB_META = LAB_FIELDS de la app (" + campos.length + " estudios: clave, unidad, referencia, críticos, cualitativos)", campos.length > 70 && !malos.length && !sobran.length, JSON.stringify(malos.map((f) => f.key).concat(sobran.map((m) => m.k))));
  check("R21b REG_LAB_IMPOSIBLE = LAB_IMPOSIBLE de la app", JSON.stringify(sb.REG_LAB_IMPOSIBLE) === JSON.stringify(imp));
  const dup = sb.REG_ANALISIS.filter((cfg) => new Set(cfg.columnas).size !== cfg.columnas.length);
  check("R21c columnas únicas en cada pestaña de análisis y la clave de cada una está entre sus columnas", !dup.length && sb.REG_ANALISIS.every((cfg) => cfg.clave.every((c) => cfg.columnas.indexOf(c) !== -1)) && sb.REG_ANALISIS.every((cfg) => cfg.columnas.indexOf("Vigente") !== -1));
  // Cada columna de cada pestaña de análisis está definida en el diccionario de variables (por su nombre exacto).
  const vars = sb.regVariables_().slice(1);
  const falta = [];
  sb.REG_ANALISIS.forEach((cfg) => cfg.columnas.forEach((c) => { if (!vars.some((v) => (v[0] === cfg.nombre || v[0] === "Todas") && v[1].split(" · ").indexOf(c) !== -1)) falta.push(cfg.nombre + " / " + c); }));
  check("R21d el diccionario de variables define TODAS las columnas de las pestañas de análisis", !falta.length, falta.join(" | "));
}
{
  // R22: funciones puras de precisión.
  const { sb } = makeSandbox({ db: dbAn() });
  const n = (v, op) => { const x = sb.regNumero(v, op); return x ? x.n + (x.comp ? "/" + x.comp : "") : null; };
  check("R22a regNumero: limpio o nada (nunca el primer número de un texto)",
    n("7.4") === "7.4" && n("7,4") === "7.4" && n("<0.05") === "0.05/<" && n(".5") === "0.5" && n("1,200") === null && n("0,125") === "0.125" && n("12,5") === "12.5" && n("1,200", { miles: true }) === "1200" && n("12 mg") === null && n("12 mg", { unidad: /^MG$/ }) === "12"
    && n("7.4 aprox") === null && n("3-4") === null && n("1.2.3") === null && n("") === null && n("-0") === "0" && n(5) === "5");
  check("R22b edad, sexo y expediente",
    sb.regEdadAnios("34") === 34 && sb.regEdadAnios("34 AÑOS") === 34 && sb.regEdadAnios("6 meses") === 0.5 && sb.regEdadAnios("10 días") === 0.027 && sb.regEdadAnios("130") === "" && sb.regEdadAnios("ADULTO") === ""
    && sb.regSexo("masculino") === "M" && sb.regSexo("Mujer") === "F" && sb.regSexo("X") === "" && sb.regExpValido(" 000-1234 ") === "0001234" && sb.regExpValido("S/N") === "" && sb.regExpValido("0000") === "");
  check("R22c misma persona con el mismo expediente: palabras del nombre más corto en el otro, un error de una letra, no identificados",
    sb.regMismaPersona("PRUEBA FICTICIA UNO", "PRUEBA FICTICIA") && sb.regMismaPersona("PRUEBA FICTICIA REINGRESO", "PRUEBA FICTICIA REINGRSO") && sb.regMismaPersona("DESCONOCIDO", "PRUEBA FICTICIA")
    && !sb.regMismaPersona("PRUEBA FICTICIA UNO", "OTRA PERSONA FICTICIA") && !sb.regMismaPersona("JUAN FICTICIO", "JUANA FICTICIO"));
  check("R22d tipo de egreso: la etiqueta de la hoja no es alta ni defunción; DEFUNCIÓN por estado; duplicado y borrado aparte",
    sb.regEgresoTipo("RETIRADO DEL CENSO (hoja)", "ESTABLE") === "Motivo no registrado" && sb.regEgresoTipo("EGRESO", "") === "Motivo no registrado" && sb.regEgresoTipo("DEFUNCIÓN", "") === "Defunción"
    && sb.regEgresoTipo("", "DEFUNCION") === "Defunción" && sb.regEgresoTipo("alta médica", "") === "Alta" && sb.regEgresoTipo("ALTA MÉDICA", "") === "Alta" && sb.regEgresoTipo("TRASLADO", "") === "Traslado"
    && sb.regEgresoTipo("DUPLICADO (import)", "") === "Duplicado (no es otro episodio)" && sb.regEgresoTipo("BORRADO EN BD (service_role)", "") === "Borrado en la base (revisar)" && sb.regEgresoTipo("CAMA REASIGNADA (hoja)", "") === "Motivo no registrado");
}

{
  // R23: el motivo del egreso registrado en la app (Papelera) llega al registro aunque la copia sea vieja, y manda.
  const st = { db: dbAn(), hoy: "2026-10-21" };
  makeSandbox(st).sb.actualizarRegistro();
  st.props.REG_CURSOR_archive = "2026-10-20T00:00:00+00:00";   // la ventana incremental ya no ve las copias de septiembre
  const s1 = st.db.archive.find((a) => a.id === "b4");          // RETIRADO DEL CENSO (hoja), archivada el 8 sep
  // La clasifica alguien hoy (la base pone la hora UTC sin milésimas); ninguna otra copia de s1 entra en la ventana.
  s1.note_data._egreso_tipo = "defuncion"; s1.note_data._egreso_tipo_por = "R2 FICTICIO"; s1.note_data._egreso_tipo_ts = new Date().toISOString().slice(0, 19) + "Z";
  const m = makeSandbox(st); m.sb.actualizarRegistro();
  const leida = m.calls.filter((c) => /archive\?.*note_data->>_egreso_tipo_ts=gte\./.test(c.u));
  const motivo = () => tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "s1")["Motivo de egreso"];
  const k = tab(st.ss, "Clave de seudónimos").find((x) => x["ID episodio"] === "s1");
  const es1 = () => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === k["ID episodio (análisis)"]);
  check("R23a una copia vieja (fuera de la ventana) clasificada hoy en la Papelera se relee: Defunción en Pacientes y en Análisis",
    leida.length === 1 && motivo() === "Defunción (registrado en la app)" && es1()["Tipo de egreso"] === "Defunción" && es1()["Defunción"] === 1, JSON.stringify([leida.length, motivo()]));
  // Después llega una copia más nueva del mismo episodio con la etiqueta de la hoja: no tapa el motivo registrado.
  st.db.archive.push({ id: "b8", archived_at: "2026-10-21T16:00:00+00:00", patient_data: { _supa_id: "s1", nombre: "OTRA PERSONA FICTICIA", exp: "0002222" }, note_data: { _egreso: "RETIRADO DEL CENSO (hoja)" } });
  makeSandbox(st).sb.actualizarRegistro();
  check("R23a2 una copia más nueva con «RETIRADO DEL CENSO (hoja)» no tapa el motivo registrado en la app", motivo() === "Defunción (registrado en la app)" && es1()["Defunción"] === 1, motivo());
  const { sb } = m;
  check("R23b los cuatro motivos de la app se traducen a su tipo (alta, defunción, traslado, alta voluntaria)",
    ["alta", "defuncion", "traslado", "alta_voluntaria"].map((t) => sb.regEgresoTipo(sb.REG_EGRESO_APP[t] + " (registrado en la app)", "")).join("|") === "Alta|Defunción|Traslado|Alta voluntaria"
    && sb.regEgresoPeso("Defunción (registrado en la app)", "") > sb.regEgresoPeso("alta médica", ""));
}
{
  // R24: hallazgos de la revisión independiente (27 oct 2026), cada uno con su caso.
  // a) Una persona que aparece DESPUÉS con un ingreso ANTERIOR y el mismo expediente no se queda con el código de otra.
  const base = () => ({ patients: [], notes: [], cronologia_respaldo: [], procedimientos_dia: [], ris_estudios: [], winlab_labs: [], archive: [] });
  const d = base();
  d.patients.push({ id: "pa", cama: "3-401", nombre: "PRUEBA FICTICIA ALFA", exp: "0007777", ingreso: "2026-10-15" });
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const pa1 = tab(st.ss, "Clave de seudónimos").find((x) => x["ID episodio"] === "pa")["ID paciente (análisis)"];
  d.archive.push({ id: "z1", archived_at: "2026-10-20T10:00:00+00:00", patient_data: { _supa_id: "pb", nombre: "OTRA FICTICIA BETA", exp: "0007777", ingreso: "2026-09-01" }, note_data: { _egreso: "RETIRADO DEL CENSO (hoja)" } });
  makeSandbox(st).sb.actualizarRegistro();
  const K = tab(st.ss, "Clave de seudónimos"), pa2 = K.find((x) => x["ID episodio"] === "pa")["ID paciente (análisis)"], pb = K.find((x) => x["ID episodio"] === "pb")["ID paciente (análisis)"];
  check("R24a dos personas con el mismo expediente nunca comparten ID paciente, aunque la segunda llegue después con un ingreso anterior; la primera conserva el suyo",
    pa1 === pa2 && pb !== pa2 && /^P-[0-9A-F]{12}$/.test(pb), JSON.stringify({ pa1, pa2, pb }));
}
{
  // b) En la tarjeta restaurada (q2) se borra el potasio del 11/10 y una cirugía: no vuelven desde la copia vieja (q1).
  const d = dbAn();
  d.archive[0].note_data.checklist = { cirugias: [{ id: "x1", fecha: "2026-10-10", procedimiento: "LAPAROTOMIA" }] };
  d.notes[0].checklist.cirugias = [{ id: "x1", fecha: "2026-10-10", procedimiento: "LAPAROTOMIA" }];
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  d.notes[0].lab_history[0].labs = { hb: "10.2" }; d.notes[0].checklist.cirugias = [];
  makeSandbox(st).sb.actualizarRegistro();
  const k = tab(st.ss, "Clave de seudónimos").find((x) => x["ID episodio"] === "q2")["ID episodio (análisis)"];
  const l = tab(st.ss, AN[1]).find((x) => x["ID episodio"] === k && x["Fecha"] === "2026-10-11" && x["Vigente"] === "Sí");
  const e = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === k);
  const kq1 = tab(st.ss, "Labs").find((x) => x["ID episodio"] === "q1" && x["Estudio"] === "k");
  check("R24b un valor y una cirugía borrados en la tarjeta restaurada no reviven desde la copia vieja de la Papelera (aunque esa copia siga «Vigente: Sí»)",
    kq1 && kq1["Vigente"] === "Sí" && l && l["Potasio (mmol/L)"] === "" && /no se usaron: k/.test(l["Observaciones"]) && e["Cirugías (n)"] === 0, JSON.stringify({ kq1, l: l && [l["Potasio (mmol/L)"], l["Observaciones"]], cx: e && e["Cirugías (n)"] }));
}
{
  // c) Un cultivo del paciente con tarjeta duplicada va al episodio real, no al duplicado.
  const d = dbAn();
  d.winlab_labs.push({ id: 60, exp: "0003333", paciente: "PRUEBA FICTICIA RESCATE", fecha: "2026-10-02", scraped_at: "2026-10-02T08:00:00+00:00", data: { reportes: [
    { __hasLink: true, __target: true, __cells: ["", "", "F600", "01/10/2026 10:00", "02/10/2026 07:00", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOCULTIVO", valor: "1", unidad: "DESARROLLO" }, { estudio: "NEGATIVO A", valor: "5", unidad: "DIAS" }] }] } });
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const c = tab(st.ss, AN[3]).find((x) => x["Fecha de toma"] === "2026-10-01");
  const E = Object.fromEntries(tab(st.ss, AN[0]).map((x) => [x["ID episodio"], x]));
  check("R24c el cultivo va al episodio real y no a la tarjeta duplicada (Excluir = 1)", c && c["ID episodio"] === K.t1 && E[K.t1]["Cultivos (n)"] === 1 && E[K.d1]["Cultivos (n)"] === 0, JSON.stringify({ c: c && c["ID episodio"], t1: K.t1, d1: K.d1 }));
}
{
  // d) «1,500 ML» de sangrado son 1500 mL; «1,250» en un laboratorio es ambiguo: vacío y explicado.
  const d = dbAn();
  d.notes[1].checklist.cirugias = [{ id: "c1", fecha: "2026-10-19", procedimiento: "LAPAROTOMIA", sangrado: "1,500 ML" }];
  d.notes[1].lab_history[0].labs.ck = "1,250";
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const k = tab(st.ss, "Clave de seudónimos").find((x) => x["ID episodio"] === "v1")["ID episodio (análisis)"];
  const e = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === k), l = tab(st.ss, AN[1]).find((x) => x["ID episodio"] === k);
  check("R24d sangrado «1,500 ML» = 1500 mL; CK «1,250» queda vacía con «ambiguo (¿miles o decimales?)»",
    e["Sangrado total (mL)"] === 1500 && l["CK (U/L)"] === "" && /CK: «1,250» es ambiguo/.test(l["Observaciones"]), JSON.stringify([e["Sangrado total (mL)"], l["CK (U/L)"], l["Observaciones"]]));
}
{
  // e) Sin la sal (otro proyecto de Apps Script): los cultivos conservan su ID (no se duplica la pestaña).
  const st = { db: dbAn(), hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const antes = tab(st.ss, AN[3]).map((x) => x["ID cultivo"]).sort();
  delete st.props.REG_SAL; makeSandbox(st).sb.actualizarRegistro();
  const despues = tab(st.ss, AN[3]);
  check("R24e sin la sal los cultivos conservan su ID y la pestaña no se duplica", JSON.stringify(despues.map((x) => x["ID cultivo"]).sort()) === JSON.stringify(antes) && despues.every((x) => x["Vigente"] === "Sí"), JSON.stringify({ antes, despues: despues.map((x) => x["ID cultivo"] + ":" + x["Vigente"]) }));
}
{
  // f) Una copia de rescate («… (alta en otro dispositivo)») no es un alta; g) episodios traslapados: reingreso sin calcular.
  const { sb } = makeSandbox({ db: dbAn() });
  check("R24f «CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)» y «CAMA REASIGNADA (otra persona…)» no se cuentan como Alta",
    sb.regEgresoTipo("CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)", "") === "Motivo no registrado" && sb.regEgresoTipo("CAMA REASIGNADA (otra persona con el mismo expediente)", "ESTABLE") === "Motivo no registrado");
  const d = { patients: [], notes: [], cronologia_respaldo: [], procedimientos_dia: [], ris_estudios: [], winlab_labs: [], archive: [
    { id: "o1", archived_at: "2026-08-12T18:00:00+00:00", patient_data: { _supa_id: "e1", nombre: "PRUEBA FICTICIA TRASLAPE", exp: "0008888", ingreso: "2026-08-01" }, note_data: { _egreso: "alta médica", _egresoFecha: "12/08/2026" } },
    { id: "o2", archived_at: "2026-08-20T18:00:00+00:00", patient_data: { _supa_id: "e2", nombre: "PRUEBA FICTICIA TRASLAPE", exp: "0008888", ingreso: "2026-08-10" }, note_data: { _egreso: "alta médica", _egresoFecha: "20/08/2026" } }] };
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const e1 = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K.e1);
  check("R24g si el episodio siguiente empieza antes del egreso (se traslapan), «Reingreso a 30 días» queda vacío y se explica", e1["Reingreso a 30 días"] === "" && /se traslapan/.test(e1["Calidad de datos"]), JSON.stringify([e1["Reingreso a 30 días"], e1["Calidad de datos"]]));
}
// ─── R25: versión instalada (27 oct 2026, hallazgo 58): una vez al día, después de escribir; si falla no detiene nada ──
{
  const st = { db: db() };
  const r1 = makeSandbox(st); r1.sb.actualizarRegistro();
  const r2 = makeSandbox(st); r2.sb.actualizarRegistro();
  const rpc = r1.calls.concat(r2.calls).filter((c) => /\/rpc\/pl_reportar_version$/.test(c.u));
  const cuerpo = rpc[0] ? JSON.parse(rpc[0].body) : {};
  check("R25a versión: se reporta una sola vez al día (dos corridas el mismo día → una llamada) con la constante del archivo y la llave",
    st.versiones === 1 && rpc.length === 1 && rpc[0].m === "post" && cuerpo.p_pieza === "registro" && cuerpo.p_version === r1.sb.REGISTRO_VERSION && rpc[0].headers.apikey === "svc", JSON.stringify({ n: st.versiones, cuerpo }));
  const st2 = { db: db(), versionFalla: 404 };
  const r3 = makeSandbox(st2); const res = r3.sb.actualizarRegistro();
  check("R25b si la base aún no tiene la función (404) el registro se escribe igual y se reintenta en la siguiente corrida",
    res && res.ok === true && !st2.props.REG_VERSION_REPORTADA && st2.versiones === 1, JSON.stringify({ ok: res && res.ok }));
}

// ─── R26: motivos de egreso nuevos (28 oct 2026, aviso «🚪 Egreso sin motivo» de la app) ──
{
  const mk = (id, tipo, dia) => ({ id: "x" + id, archived_at: "2026-10-" + dia + "T18:00:00+00:00", patient_data: { _supa_id: "m" + id, nombre: "PRUEBA FICTICIA MOTIVO " + id, exp: "00077" + id, ingreso: "2026-10-01" }, note_data: { _egreso: "RETIRADO DEL CENSO (hoja)", _egreso_tipo: tipo, _egreso_tipo_ts: "2026-10-" + dia + "T18:00:00Z" } });
  const d = { patients: [], notes: [], cronologia_respaldo: [], procedimientos_dia: [], ris_estudios: [], winlab_labs: [],
    archive: [mk(1, "cambio_servicio", "10"), mk(2, "contrarreferencia", "11"), mk(3, "fuga", "12"), mk(4, "otro", "13"), mk(5, "no_egreso", "14"), mk(6, "traslado", "15")] };
  const st = { db: d, hoy: "2026-10-28" }; makeSandbox(st).sb.actualizarRegistro();
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const ep = (n) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K["m" + n]) || {};
  const r = [1, 2, 3, 4, 5, 6].map((n) => [ep(n)["Tipo de egreso"], ep(n)["Defunción"], ep(n)["Egreso observado"]]);
  check("R26 motivos nuevos: cambio de servicio, contrarreferencia, fuga y traslado = salió vivo (Defunción 0); «otro» = desconocido; «no fue egreso» no cuenta como egreso observado",
    JSON.stringify(r) === JSON.stringify([["Cambio de servicio", 0, 1], ["Contrarreferencia", 0, 1], ["Fuga", 0, 1], ["Otro", "", 1], ["No fue egreso", "", 0], ["Traslado", 0, 1]]), JSON.stringify(r));
}

// ─── R27: cirugías desde donde estén marcadas (28 oct 2026): DX, Cronología, fecha POP, programación del día ──
{
  const pt = (id, extra) => Object.assign({ id, cama: "3-5" + id.slice(1), nombre: "PRUEBA FICTICIA CX " + id.toUpperCase(), exp: "00055" + id.slice(1), ingreso: "2026-10-20", estado: "ESTABLE" }, extra);
  const nt = (id, extra, ck) => Object.assign({ patient_id: id, updated_at: "2026-10-27T10:00:00+00:00", checklist: Object.assign({ sexo: "F" }, ck || {}) }, extra);
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], archive: [],
    patients: [
      pt("c1", { dx: "PO LAPE 25/10 + ABSCESO RESIDUAL" }),                                   // solo en el DX, con fecha
      pt("c2", { dx: "COLECISTITIS AGUDA" }),                                                  // solo en la Cronología
      pt("c3", { dx: "COLECISTITIS LITIASICA" }),                                              // caja + Cronología el mismo día → una
      pt("c4", { dx: "OCLUSION INTESTINAL" }),                                                 // solo fecha POP
      pt("c5", { dx: "HERNIA INGUINAL. PROGRAMADO PARA HERNIOPLASTIA" }),                     // plan: no es cirugía
      pt("c6", { dx: "PIE DIABETICO" }),                                                       // solo programación del día
      pt("c7", { dx: "ABSCESO PERIANAL, AMERITA DRENAJE DE ABSCESO" }),                         // nombra el procedimiento sin decir que se hizo
      pt("c8", { dx: "PO APENDICECTOMIA 02/03 + PO COLECISTECTOMIA 2019 + ANTECEDENTE DE PO HERNIOPLASTIA INGUINAL + POP FISTULECTOMIA DE ANO 21/10" }),  // tres de antes y una del episodio
      pt("c9", { dx: "PO LAPE 24/10 POR OCLUSION" }),                                           // caja con texto sin grupo el mismo día
      pt("c10", { dx: "OCLUSION INTESTINAL. PO LAPE + RESECCION INTESTINAL" })                  // la LAPE es el abordaje de la resección
    ],
    notes: [
      nt("c1", { cronologia: "26/10 08:00 R2: TOLERA DIETA" }),
      nt("c2", { cronologia: "24/10 14:00 R3: PASA A QUIRÓFANO PARA COLECISTECTOMÍA LAPAROSCÓPICA\n25/10 08:00 R1: SE REALIZA CURACIÓN DE HERIDA" }),
      nt("c3", { cronologia: "24/10 15:00 R3: SE REALIZA COLECISTECTOMIA LAPAROSCOPICA SIN INCIDENTES" }, { cirugias: [{ id: "k1", fecha: "2026-10-24", procedimiento: "COLECISTECTOMÍA LAPAROSCÓPICA", sangrado: "30 ML" }] }),
      nt("c4", {}, { qx_fecha: "2026-10-23" }),
      nt("c5", { cronologia: "27/10 09:00 R2: SE COMENTA CON ADSCRITO, PENDIENTE QUIRÓFANO\n27/10 13:00 R2: PASA A QUIRÓFANO MAÑANA PARA HERNIOPLASTIA" }),
      nt("c6", {}), nt("c7", {}), nt("c8", {}),
      nt("c9", {}, { cirugias: [{ id: "k5", fecha: "2026-10-24", procedimiento: "CIRUGÍA DE URGENCIA" }] }),
      nt("c10", {}, { cirugias: [{ id: "k6", fecha: "2026-10-22", procedimiento: "RESECCIÓN INTESTINAL + ENTEROENTEROANASTOMOSIS" }] })
    ],
    procedimientos_dia: [
      { id: "y6", fecha_dia: "2026-10-26", cama: "3-56", exp: "000556", nombre: "PRUEBA FICTICIA CX C6", dx: "PIE DIABETICO - AMPUTACION SUPRACONDILEA", esp: "CG" },
      { id: "y3", fecha_dia: "2026-10-24", cama: "3-53", exp: "000553", nombre: "PRUEBA FICTICIA CX C3", dx: "COLECISTITIS", esp: "CG" },
      { id: "yx", fecha_dia: "2026-10-22", cama: "3-56", exp: "000556", nombre: "OTRA PERSONA DISTINTA", dx: "HERNIA", esp: "CG" }
    ] };
  const st = { db: d, hoy: "2026-10-28" }; makeSandbox(st).sb.actualizarRegistro();
  const C = tab(st.ss, "Cirugías"), de = (id) => C.filter((x) => x["ID episodio"] === id);
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  const c1 = de("c1")[0] || {}, c2 = de("c2")[0] || {}, c4 = de("c4")[0] || {}, c6 = de("c6")[0] || {};
  check("R27a DX «PO LAPE 25/10»: una cirugía del 25/10, grupo Laparotomía exploradora, Fuente «DX (inferida)»",
    de("c1").length === 1 && c1["Fecha"] === "2026-10-25" && c1["Grupo"] === "Laparotomía exploradora" && c1["Fuente"] === "DX (inferida)" && c1["Vigente"] === "Sí", JSON.stringify(de("c1")));
  check("R27b Cronología «pasa a quirófano para colecistectomía»: cirugía del 24/10 (Colecistectomía); «se realiza curación» no cuenta",
    de("c2").length === 1 && c2["Fecha"] === "2026-10-24" && c2["Grupo"] === "Colecistectomía" && c2["Fuente"] === "Cronología (inferida)", JSON.stringify(de("c2")));
  check("R27c lo que ya está en la caja no se repite (ni la Cronología ni la programación del mismo día)",
    de("c3").length === 1 && de("c3")[0]["Fuente"] === "Caja Cirugías" && de("c3")[0]["Sangrado"] === "30 ML" && P.c3["Cirugías (resumen)"] === "2026-10-24 COLECISTECTOMÍA LAPAROSCÓPICA", JSON.stringify(de("c3")));
  check("R27d solo la fecha POP de la tarjeta: cirugía del 23/10 sin procedimiento especificado",
    de("c4").length === 1 && c4["Fecha"] === "2026-10-23" && c4["Fuente"] === "Fecha POP de la tarjeta" && c4["Grupo"] === "Cirugía (procedimiento no especificado)", JSON.stringify(de("c4")));
  check("R27e «PROGRAMADO PARA…», «PENDIENTE QUIRÓFANO» o «pasa a quirófano mañana» no es una cirugía hecha", de("c5").length === 0, JSON.stringify(de("c5")));
  check("R27f programación del día: entra sin confirmar con su grupo (Amputación); la de otra persona con el mismo expediente no",
    de("c6").length === 1 && c6["Fuente"] === "Programación del día (sin confirmar)" && c6["Grupo"] === "Amputación" && c6["Fecha"] === "2026-10-26" && /\[Programación del día \(sin confirmar\)\]/.test(P.c6["Cirugías (resumen)"]), JSON.stringify(de("c6")));
  check("R27f2 «amerita drenaje» (sin «PO» ni fecha) no es cirugía; «PO … 02/03», «… 2019» y «ANTECEDENTE DE…» son de antes; la del episodio sí («ANO» no es «AÑO»)",
    de("c7").length === 0 && de("c8").length === 1 && de("c8")[0]["Fecha"] === "2026-10-21" && de("c8")[0]["Grupo"] === "Anorrectal", JSON.stringify(de("c7").concat(de("c8"))));
  check("R27f3 la caja con un procedimiento sin grupo («CIRUGÍA DE URGENCIA», Otro) empata con «PO LAPE 24/10» del DX: una sola cirugía",
    de("c9").length === 1 && de("c9")[0]["Fuente"] === "Caja Cirugías", JSON.stringify(de("c9")));
  check("R27f4 «PO LAPE + RESECCIÓN INTESTINAL» con la resección en la caja: la LAPE es su abordaje, no otra cirugía",
    de("c10").length === 1 && de("c10")[0]["Fuente"] === "Caja Cirugías", JSON.stringify(de("c10")));
  check("R27g el resumen marca la fuente de lo inferido", P.c1["Cirugías (resumen)"] === "2026-10-25 PO LAPE 25/10 [DX (inferida)]" && /\[Cronología \(inferida\)\]/.test(P.c2["Cirugías (resumen)"]), JSON.stringify([P.c1["Cirugías (resumen)"], P.c2["Cirugías (resumen)"]]));
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const E = (id) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K[id]) || {};
  const r = ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => [E(id)["Cirugías (n)"], E(id)["Grupo de la 1.ª cirugía"], E(id)["Cirugías inferidas (n)"], E(id)["Programadas sin confirmar (n)"], E(id)["Reintervención"]]);
  check("R27h análisis: las inferidas cuentan como cirugía (y se avisa en Calidad de datos); la programada sin confirmar no",
    JSON.stringify(r) === JSON.stringify([[1, "Laparotomía exploradora", 1, 0, 0], [1, "Colecistectomía", 1, 0, 0], [1, "Colecistectomía", 0, 0, 0], [1, "Cirugía (procedimiento no especificado)", 1, 0, 0], [0, "", 0, 0, ""], [0, "", 0, 1, ""]])
    && /tomada de otra caja/.test(E("c1")["Calidad de datos"]) && /programación del día/.test(E("c6")["Calidad de datos"]), JSON.stringify(r));
  // Al día siguiente el residente pasa la cirugía de c1 a la caja: la inferida queda Vigente No y no se cuenta doble.
  d.notes[0].checklist.cirugias = [{ id: "k9", fecha: "2026-10-25", procedimiento: "LAPAROTOMÍA EXPLORADORA", hallazgos: "ABSCESO PÉLVICO" }];
  st.hoy = "2026-10-29"; makeSandbox(st).sb.actualizarRegistro();
  const c1b = tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] === "c1");
  const e1 = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K.c1) || {};
  check("R27i cuando se pasa a la caja: la fila de la caja Vigente Sí, la inferida Vigente No; el análisis cuenta una sola cirugía",
    c1b.length === 2 && c1b.some((x) => x["Fuente"] === "Caja Cirugías" && x["Vigente"] === "Sí") && c1b.some((x) => x["Fuente"] === "DX (inferida)" && x["Vigente"] === "No")
    && e1["Cirugías (n)"] === 1 && e1["Cirugías inferidas (n)"] === 0, JSON.stringify([c1b, e1["Cirugías (n)"], e1["Cirugías inferidas (n)"]]));
}

// ─── R28: comorbilidades (APP + DX, con negación), peso/talla/IMC e índice urinario (28 oct 2026) ──
{
  const { sb } = makeSandbox({ db: db() });
  const C = (app, dx) => { const o = sb.regComorbilidades(app, dx || ""); return Object.keys(o).filter((k) => o[k] === 1).join(",") || (Object.values(o).every((v) => v === "") ? "?" : "-"); };
  const casos = [
    ["DM2 DE 10 AÑOS EN TRATAMIENTO CON METFORMINA, HAS NEGADA", "", "Diabetes"],
    ["NIEGA DM, HAS, ERC", "", "-"],
    ["NIEGA ALERGIAS, DM2 DX HACE 5 AÑOS", "", "Diabetes"],
    ["NIEGA ALERGIAS, DM2 EN TRATAMIENTO CON INSULINA, HAS", "", "Diabetes,Hipertensión"],
    ["CRONICODEGENERATIVOS NEGADOS", "", "-"],
    ["HAS EN TRATAMIENTO CON LOSARTÁN Y NIEGA DM", "", "Hipertensión"],
    ["TABAQUISMO NEGADO. CA DE COLON EN QT", "", "Cáncer"],
    ["TABAQUISMO POSITIVO IT 20. EPOC", "", "EPOC / asma,Tabaquismo"],
    ["SIN ANTECEDENTES DE IMPORTANCIA", "HIPERTENSIÓN PORTAL POR CIRROSIS", "Cirrosis / hepatopatía crónica"],
    ["ERC KDIGO 5 EN HEMODIÁLISIS. CARDIOPATÍA ISQUÉMICA", "", "Enfermedad renal crónica,Cardiopatía"],
    ["SIN DM", "", "-"],
    ["VIH NEGATIVO. OBESIDAD GRADO II", "", "Obesidad"],
    ["", "PIE DIABÉTICO", "Diabetes"],
    ["", "", "?"],
    ["DMO BAJA, ADM", "", "-"]
  ];
  const r = casos.map(([a, d]) => C(a, d)), esperado = casos.map((c) => c[2]);
  check("R28a comorbilidades con negación («NIEGA DM, HAS», «HAS NEGADA», «SIN DM»), lo que afirma después de negar («NIEGA ALERGIAS, DM2 DX HACE 5 AÑOS») y sin falsos («HIPERTENSIÓN PORTAL», «DMO»)",
    JSON.stringify(r) === JSON.stringify(esperado), JSON.stringify(r.map((x, i) => x === esperado[i] ? "ok" : x + " ≠ " + esperado[i])));
  const sinApp = sb.regComorbilidades("", "PIE DIABÉTICO");
  check("R28b sin APP: el DX solo pone 1 (diabetes); lo demás queda vacío (desconocido), no 0", sinApp["Diabetes"] === 1 && sinApp["Hipertensión"] === "" && sb.regComorbilidades("NIEGA TODO", "")["Hipertensión"] === 0);
  const pt = (peso, talla, json) => sb.regPesoTalla({ "Peso (kg)": peso, "Talla": talla, "Checklist completo (JSON)": json || "" });
  check("R28c peso y talla: «165» cm → 1.65 m, «1.70 M» m; IMC a un decimal; imposibles vacíos; filas viejas desde el JSON del checklist",
    JSON.stringify(pt("70", "165")) === JSON.stringify({ peso: 70, talla: 1.65, imc: 25.7 }) && JSON.stringify(pt("80 KG", "1.70 M")) === JSON.stringify({ peso: 80, talla: 1.7, imc: 27.7 })
    && JSON.stringify(pt("70 KG.", "1.65 M.")) === JSON.stringify({ peso: 70, talla: 1.65, imc: 25.7 }) && JSON.stringify(pt("700", "3")) === JSON.stringify({ peso: "", talla: "", imc: "" }) && JSON.stringify(pt("", "", '{"pm_peso":"95","pm_talla":"160"}')) === JSON.stringify({ peso: 95, talla: 1.6, imc: 37.1 }),
    JSON.stringify([pt("70", "165"), pt("80 KG", "1.70 M"), pt("700", "3"), pt("", "", '{"pm_peso":"95","pm_talla":"160"}')]));

  // Corrida completa: p1 con APP «HAS», peso y talla, y uresis de tres días (con horas, «/12 H» y sin horas).
  const d = db();
  const ck = d.notes[0].checklist;
  ck.pm_peso = "75"; ck.pm_talla = "170";
  ck.pm_hist = [{ fecha: "2026-10-19", uresis: "900", uresis_h: "12" }, { fecha: "2026-10-20", fc: "96", uresis: "300/12 H" }];
  ck.pm_fecha = "2026-10-21"; ck.pm_uresis = "1200"; ck.pm_uresis_h = "";
  d.patients.push({ id: "p9", cama: "3-209", nombre: "PRUEBA FICTICIA NUEVE", exp: "000909", edad: "50", ingreso: "2026-10-18" });
  d.notes.push({ patient_id: "p9", app: "", checklist: { pm_peso: "100", pm_talla: "160" } });
  d.notes[0].lab_history[1].labs.k = "4.3"; d.notes[0].lab_history[1].manual_keys = ["k"];
  d.notes[0].lab_history[1].manual_by = { k: { u: "R2 FICTICIO", t: "2026-10-18T09:30:00.000Z", antes: "43" } };
  const st = { db: d, hoy: "2026-10-21" }; makeSandbox(st).sb.actualizarRegistro();
  const P1 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p1");
  const Lk = tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p1" && x["Fecha"] === "2026-10-18");
  check("R28h Labs: la corrección a mano dice quién, cuándo y qué decía antes; lo demás queda vacío",
    Lk.find((x) => x["Estudio"] === "k")["Corregido a mano"] === "Sí · R2 FICTICIO · 2026-10-18 09:30 · antes: 43" && Lk.find((x) => x["Estudio"] === "hb")["Corregido a mano"] === "", JSON.stringify(Lk));
  const SV = tab(st.ss, "Signos vitales").filter((x) => x["ID episodio"] === "p1");
  check("R28d Pacientes guarda Peso y Talla; Signos vitales guarda «Horas de uresis»",
    P1["Peso (kg)"] === "75" && P1["Talla"] === "170" && SV.find((x) => x["Fecha"] === "2026-10-19")["Horas de uresis"] === "12", JSON.stringify(SV));
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const AS = tab(st.ss, AN[2]).filter((x) => x["ID episodio"] === K.p1), dia = (f) => AS.find((x) => x["Fecha"] === f) || {};
  check("R28e índice urinario por día: 900 ÷ 75 ÷ 12 = 1; «300/12 H» = 0.33 (horas de la uresis); 1200 sin horas = 0.67 con 24 h y aviso",
    dia("2026-10-19")["Índice urinario (mL/kg/h)"] === 1 && dia("2026-10-19")["Horas de uresis (h)"] === 12
    && dia("2026-10-20")["Uresis (mL)"] === 300 && dia("2026-10-20")["Índice urinario (mL/kg/h)"] === 0.33
    && dia("2026-10-21")["Índice urinario (mL/kg/h)"] === 0.67 && dia("2026-10-21")["Horas de uresis (h)"] === 24 && /24 h/.test(dia("2026-10-21")["Observaciones"]),
    JSON.stringify(AS.map((x) => [x["Fecha"], x["Uresis (mL)"], x["Horas de uresis (h)"], x["Índice urinario (mL/kg/h)"], x["Observaciones"]])));
  const E1 = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K.p1) || {}, E2 = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K.p2) || {};
  check("R28f episodio: peso, talla, IMC, HAS = 1 desde el APP, comorbilidades 1, IU mínimo 0.33 y 1 día con oliguria; sin APP (p2) comorbilidades vacías y se avisa",
    E1["Peso (kg)"] === 75 && E1["Talla (m)"] === 1.7 && E1["IMC (kg/m²)"] === 26 && E1["Hipertensión"] === 1 && E1["Diabetes"] === 0 && E1["Comorbilidades (n)"] === 1
    && E1["Índice urinario mínimo (mL/kg/h)"] === 0.33 && E1["Días con oliguria (IU < 0.5)"] === 1
    && E2["Hipertensión"] === "" && E2["Comorbilidades (n)"] === "" && /sin antecedentes \(APP\)/.test(E2["Calidad de datos"]) && /sin peso registrado/.test(E2["Calidad de datos"]),
    JSON.stringify([E1["Peso (kg)"], E1["Talla (m)"], E1["IMC (kg/m²)"], E1["Hipertensión"], E1["Comorbilidades (n)"], E1["Índice urinario mínimo (mL/kg/h)"], E1["Días con oliguria (IU < 0.5)"], E2["Hipertensión"], E2["Calidad de datos"]]));
  const E9 = tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K.p9) || {};
  check("R28g IMC ≥ 30 en un adulto marca Obesidad aunque no haya APP (el conteo sigue vacío)", E9["IMC (kg/m²)"] === 39.1 && E9["Obesidad"] === 1 && E9["Diabetes"] === "" && E9["Comorbilidades (n)"] === "", JSON.stringify([E9["IMC (kg/m²)"], E9["Obesidad"], E9["Comorbilidades (n)"]]));
}

// ─── R29: cirugía estructurada, Dx principal, «Por completar» y «Resumen mensual» (28 oct 2026) ──
{
  const arch = (id, sid, nombre, exp, ingreso, archivado, dx, tipo, extra) => ({ id, archived_at: archivado + "T18:00:00+00:00",
    patient_data: Object.assign({ _supa_id: sid, cama: "3-6" + id.slice(-2), nombre, exp, ingreso, dx, edad: "50" }, extra || {}),
    note_data: Object.assign({ _egreso: "RETIRADO DEL CENSO (hoja)" }, tipo ? { _egreso_tipo: tipo, _egreso_tipo_ts: archivado + "T18:00:00Z" } : {}) });
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [],
    patients: [
      { id: "h1", cama: "3-601", nombre: "PRUEBA FICTICIA COMPLETA", exp: "000611", dx: "APENDICITIS AGUDA", edad: "30", ingreso: "2026-10-20", estado: "ESTABLE" },
      { id: "h2", cama: "3-602", nombre: "PRUEBA FICTICIA INCOMPLETA", exp: "000612", dx: "OCLUSION INTESTINAL POR BRIDAS", edad: "70", ingreso: "2026-10-22", estado: "DELICADO" }
    ],
    notes: [
      { patient_id: "h1", app: "NIEGA CRONICODEGENERATIVOS", checklist: { sexo: "F", pm_peso: "60", pm_talla: "160", dx_cat: "apendicitis",
        cirugias: [{ id: "a1", fecha: "2026-10-21", procedimiento: "APENDICECTOMIA LAPAROSCOPICA", tipo: "urgencia", abordaje: "laparoscopica", clavien: "0" }] } },
      { patient_id: "h2", app: "", checklist: { sexo: "M",
        cirugias: [{ id: "b1", fecha: "2026-10-23", procedimiento: "LAPE + RESECCION INTESTINAL", tipo: "urgencia", abordaje: "convertida", clavien: "IIIb", complicacion: "FUGA DE ANASTOMOSIS" },
          { id: "b2", fecha: "2026-10-26", procedimiento: "RELAPE + LAVADO", tipo: "urgencia", abordaje: "abierta", clavien: "ZZ", complicacion: "NO DEBE SALIR" }] } }
    ],
    archive: [
      arch("z01", "e1", "PRUEBA FICTICIA DEFUNCION", "000621", "2026-10-01", "2026-10-10", "PANCREATITIS AGUDA GRAVE", "defuncion"),
      arch("z02", "e2", "PRUEBA FICTICIA SIN MOTIVO", "000622", "2026-10-12", "2026-10-15", "HERNIA INGUINAL", ""),
      arch("z03", "e3", "PRUEBA FICTICIA VIEJA", "000623", "2026-09-01", "2026-09-10", "COLECISTITIS", "")
    ] };
  const st = { db: d, hoy: "2026-10-28" }; makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  check("R29a Pacientes: Dx principal elegido (con CIE-10) o inferido del DX, y de dónde salió",
    P.h1["Dx principal"] === "Apendicitis aguda" && P.h1["CIE-10 (grupo)"] === "K35" && P.h1["Dx principal (fuente)"] === "Elegido en la app"
    && P.h2["Dx principal"] === "Oclusión intestinal" && P.h2["Dx principal (fuente)"] === "Inferido del DX" && P.e1["Dx principal"] === "Pancreatitis aguda",
    JSON.stringify([P.h1["Dx principal"], P.h1["CIE-10 (grupo)"], P.h1["Dx principal (fuente)"], P.h2["Dx principal"], P.h2["Dx principal (fuente)"], P.e1 && P.e1["Dx principal"]]));
  const C = tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] === "h2");
  const b1 = C.find((x) => /RESECCION/.test(x["Procedimiento"])) || {}, b2 = C.find((x) => /RELAPE/.test(x["Procedimiento"])) || {};
  check("R29b Cirugías: urgencia, abordaje, Clavien y complicación como se eligieron; un grado inventado queda vacío (y su complicación también)",
    b1["Tipo"] === "Urgencia" && b1["Abordaje"] === "Convertida (laparoscópica → abierta)" && b1["Clavien-Dindo"] === "IIIb" && b1["Complicación"] === "FUGA DE ANASTOMOSIS"
    && b2["Abordaje"] === "Abierta" && b2["Clavien-Dindo"] === "" && b2["Complicación"] === "", JSON.stringify(C));
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const E = (id) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K[id]) || {};
  const e2 = E("h2"), e1 = E("h1");
  check("R29c Análisis · Episodios: urgencia, abordaje, conversión, Clavien máximo, complicación mayor y cirugías sin clasificar",
    e2["Urgencia (1.ª cirugía)"] === 1 && e2["Abordaje (1.ª cirugía)"] === "Convertida (laparoscópica → abierta)" && e2["Conversión"] === 1 && e2["Clavien-Dindo máximo"] === "IIIb"
    && e2["Complicación mayor (Clavien ≥ IIIa)"] === 1 && e2["Cirugías sin clasificar (n)"] === 1 && e2["Dx principal (fuente)"] === "Inferido del DX"
    && e1["Conversión"] === 0 && e1["Clavien-Dindo máximo"] === "Sin complicación" && e1["Complicación mayor (Clavien ≥ IIIa)"] === 0 && e1["Cirugías sin clasificar (n)"] === 0 && E("e1")["Urgencia (1.ª cirugía)"] === "",
    JSON.stringify([e2["Urgencia (1.ª cirugía)"], e2["Abordaje (1.ª cirugía)"], e2["Conversión"], e2["Clavien-Dindo máximo"], e2["Complicación mayor (Clavien ≥ IIIa)"], e2["Cirugías sin clasificar (n)"], e1["Conversión"], e1["Clavien-Dindo máximo"]]));
  const PC = Object.fromEntries(tab(st.ss, "Por completar").map((x) => [x["ID episodio"], x]));
  // 24 nov 2026: la talla ya no se pide por paciente, y el egresado sin motivo entra aunque hayan pasado más de 30 días (e3: 48).
  check("R29d Por completar: el hospitalizado incompleto (con nombre y cama, sin pedir la talla), los egresados de los últimos 30 días y el egreso sin motivo de hace 48 días; no el completo",
    !PC.h1 && PC.e3 && /^motivo del egreso · /.test(PC.e3["Falta"]) && PC.h2 && PC.h2["Nombre"] === "PRUEBA FICTICIA INCOMPLETA" && PC.h2["Cama"] === "3-602"
    && PC.h2["Falta"] === "APP · peso · 1 cirugía sin urgencia/abordaje/Clavien" && PC.h2["Faltantes (n)"] === 3
    && PC.e2 && /^motivo del egreso · /.test(PC.e2["Falta"]) && PC.e1 && !/motivo del egreso/.test(PC.e1["Falta"]) && !Object.values(PC).some((x) => /talla/.test(x["Falta"])),
    JSON.stringify(Object.values(PC).map((x) => x["ID episodio"] + ": " + x["Falta"])));
  const R = Object.fromEntries(tab(st.ss, "Resumen mensual").map((x) => [x["Mes"], x]));
  const o = R["2026-10"] || {}, se = R["2026-09"] || {};
  const esperado = { "Ingresos (n)": 4, "Egresos (n)": 2, "Egresos con desenlace conocido (n)": 1, "Defunciones (n)": 1, "Mortalidad (%)": 100, "Egresos sin motivo (n)": 1,
    "Estancia mediana (días)": 6, "Estancia media (días)": 6, "Pacientes operados (n)": 2, "Cirugías (n)": 3, "Cirugías de urgencia (%)": 100, "Abordaje laparoscópico (%)": 66.7,
    "Conversiones (n)": 1, "Complicación mayor (Clavien ≥ IIIa) (n)": 1, "Reintervenciones (n)": 0, "Ingresos con datos incompletos (n)": 3,
    "Dx principales (más frecuentes)": "Apendicitis aguda (1); Hernia de pared (1); Oclusión intestinal (1); Pancreatitis aguda (1)" };
  const dif = Object.keys(esperado).filter((k) => o[k] !== esperado[k]).map((k) => k + ": " + JSON.stringify(o[k]) + " ≠ " + JSON.stringify(esperado[k]));
  check("R29e Resumen mensual de octubre: ingresos, egresos, mortalidad sobre desenlace conocido, estancia, cirugías, urgencias, laparoscopía, conversiones, Clavien ≥ IIIa, dx",
    !dif.length && se["Ingresos (n)"] === 1 && se["Egresos (n)"] === 1 && se["Mortalidad (%)"] === "" && se["Cirugías (n)"] === 0, JSON.stringify(dif.length ? dif : se));
  const sinNombres = JSON.stringify(st.ss.sheets["Resumen mensual"].cells);
  check("R29f el Resumen mensual no tiene nombres ni expedientes", !/FICTICIA|00061|00062/.test(sinNombres));
  // Al completar la tarjeta, su fila de «Por completar» queda «Vigente: No» (resuelta).
  Object.assign(d.notes[1], { app: "HAS" });
  Object.assign(d.notes[1].checklist, { pm_peso: "80", pm_talla: "170", dx_cat: "oclusion" });
  d.notes[1].checklist.cirugias[1].clavien = "IIIb";
  makeSandbox(st).sb.actualizarRegistro();
  const h2b = tab(st.ss, "Por completar").find((x) => x["ID episodio"] === "h2") || {};
  check("R29g al completar la tarjeta, su fila de «Por completar» queda Vigente: No (resuelta)", h2b["Vigente"] === "No", JSON.stringify(h2b));
}
{
  // Umbral de complicación mayor: IIIa sí (≥ IIIa), II no.
  const pt = (id, cl) => ({ id, cama: "3-7" + id.slice(-1), nombre: "PRUEBA FICTICIA GRADO " + id, exp: "00071" + id.slice(-1), dx: "HERNIA", edad: "40", ingreso: "2026-10-20" });
  const nt = (id, cl) => ({ patient_id: id, app: "NIEGA", checklist: { sexo: "F", cirugias: [{ id: "c" + id, fecha: "2026-10-21", procedimiento: "HERNIOPLASTIA", tipo: "electiva", abordaje: "abierta", clavien: cl }] } });
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [], archive: [], patients: [pt("g1"), pt("g2")], notes: [nt("g1", "IIIa"), nt("g2", "II")] };
  const st = { db: d, hoy: "2026-10-28" }; makeSandbox(st).sb.actualizarRegistro();
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const E = (id) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K[id]) || {};
  check("R29h Clavien IIIa = complicación mayor (1); II = no (0); electiva = 0 en «Urgencia»",
    E("g1")["Clavien-Dindo máximo"] === "IIIa" && E("g1")["Complicación mayor (Clavien ≥ IIIa)"] === 1 && E("g2")["Complicación mayor (Clavien ≥ IIIa)"] === 0 && E("g2")["Urgencia (1.ª cirugía)"] === 0,
    JSON.stringify([E("g1")["Clavien-Dindo máximo"], E("g1")["Complicación mayor (Clavien ≥ IIIa)"], E("g2")["Complicación mayor (Clavien ≥ IIIa)"]]));
}

// ─── R30: sexo de WinLab cuando la tarjeta no lo tiene, marcado «de WinLab» (29 oct 2026) ─────────────────────────
{
  const { sb } = makeSandbox({ db: db() });
  const enc = (sx) => ["", "", "x", "PRUEBA FICTICIA", "NOMBRE", sx, "01/01/1980"];
  check("R30a sexo del encabezado de WinLab en español, italiano o inglés; sin celda de sexo o desconocido → vacío",
    sb.regWlSexoDe(enc("FEMENINO")) === "F" && sb.regWlSexoDe(enc("MASCULINO")) === "M" && sb.regWlSexoDe(enc("FEMMINILE")) === "F" && sb.regWlSexoDe(enc("MASCHILE")) === "M"
    && sb.regWlSexoDe(enc("DONNA")) === "F" && sb.regWlSexoDe(enc("MALE")) === "M" && sb.regWlSexoDe(enc("FEMALE")) === "F" && sb.regWlSexoDe(enc("F")) === "F"
    && sb.regWlSexoDe(enc("XYZ")) === "" && sb.regWlSexoDe(["", "", "F100", "27/10/2026 06:00", "", "CIRUGIA"]) === "" && sb.regWlSexoDe(null) === "");
}
{
  const wl = (id, exp, paciente, nom, sexo, folio, nVal, scraped) => ({ id, exp, paciente, fecha: "2026-10-27", scraped_at: scraped || "2026-10-27T08:00:00+00:00", data: { reportes: [
    { __hasLink: false, __cells: ["", "", exp, "PRUEBA FICTICIA", nom, sexo, "01/01/1980"] },
    { __hasLink: true, __target: true, __cells: ["", "", folio, "27/10/2026 06:00", "27/10/2026 07:00", "CIRUGIA GENERAL"],
      valores: [{ estudio: "HEMOGLOBINA", valor: "12.0" }, { estudio: "LEUCOCITOS", valor: "9.0" }, { estudio: "PLAQUETAS", valor: "250" }].slice(0, nVal) }] } });
  const pt = (id, nombre, exp) => ({ id, cama: "3-8" + id.slice(-2), nombre, exp, dx: "HERNIA INGUINAL", edad: "45", ingreso: "2026-10-25", estado: "ESTABLE" });
  const d = { cronologia_respaldo: [], ris_estudios: [], procedimientos_dia: [], archive: [],
    patients: [pt("s01", "PRUEBA FICTICIA SINSEXO", "000811"), pt("s02", "PRUEBA FICTICIA TARJETA", "000812"), pt("s03", "PRUEBA FICTICIA GEMELA UNO", "000813"),
      pt("s04", "PRUEBA FICTICIA DOBLE", "000814"), pt("s06", "PRUEBA FICTICIA SEXTA", "000816")],
    notes: [{ patient_id: "s02", checklist: { sexo: "M" } }],
    winlab_labs: [
      wl(1, "000811", "PRUEBA FICTICIA SINSEXO", "SINSEXO", "FEMENINO", "F811", 3),
      wl(2, "000812", "PRUEBA FICTICIA TARJETA", "TARJETA", "FEMENINO", "F812", 3),
      // Expediente compartido por dos personas: el renglón de la otra (MASCULINO) no cuenta para la gemela.
      wl(3, "000813", "PRUEBA FICTICIA GEMELA UNO", "GEMELA UNO", "FEMENINO", "F813", 3),
      wl(4, "000813", "OTRA FICTICIA DISTINTA", "OTRA DISTINTA", "MASCULINO", "F913", 3),
      // La misma persona con los dos sexos en WinLab: no se usa ninguno.
      wl(5, "000814", "PRUEBA FICTICIA DOBLE", "DOBLE", "FEMENINO", "F814", 3),
      wl(6, "000814", "PRUEBA FICTICIA DOBLE", "DOBLE", "MASCULINO", "F815", 3)
    ] };
  const st = { db: d, hoy: "2026-10-29" }; makeSandbox(st).sb.actualizarRegistro();
  const P = () => Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  const p = P();
  check("R30b Pacientes: sin sexo en la tarjeta → el de WinLab, marcado «de WinLab»; con sexo en la tarjeta → el de la tarjeta («Tarjeta»)",
    p.s01["Sexo"] === "F" && p.s01["Sexo (fuente)"] === "de WinLab" && p.s02["Sexo"] === "M" && p.s02["Sexo (fuente)"] === "Tarjeta",
    JSON.stringify([p.s01["Sexo"], p.s01["Sexo (fuente)"], p.s02["Sexo"], p.s02["Sexo (fuente)"]]));
  check("R30c expediente compartido: solo cuenta el renglón de WinLab de la misma persona; con los dos sexos en WinLab queda vacío",
    p.s03["Sexo"] === "F" && p.s03["Sexo (fuente)"] === "de WinLab" && p.s04["Sexo"] === "" && p.s04["Sexo (fuente)"] === "" && p.s06["Sexo"] === "" && p.s06["Sexo (fuente)"] === "",
    JSON.stringify([p.s03["Sexo"], p.s04["Sexo"], p.s04["Sexo (fuente)"], p.s06["Sexo"]]));
  const W = tab(st.ss, "Labs del robot (WinLab)");
  check("R30d «Labs del robot» guarda el sexo del encabezado de cada reporte", W.length === 6 && W.find((x) => x["Folio"] === "F811")["Sexo en WinLab"] === "F" && W.find((x) => x["Folio"] === "F913")["Sexo en WinLab"] === "M",
    JSON.stringify(W.map((x) => x["Folio"] + ":" + x["Sexo en WinLab"])));
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const E = (id) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K[id]) || {};
  check("R30e Análisis: sexo y su fuente; la tarjeta manda y si WinLab dice otro se anota; los dos sexos en WinLab se anotan y no se usan",
    E("s01")["Sexo"] === "F" && E("s01")["Sexo (fuente)"] === "de WinLab" && !/sin sexo/.test(E("s01")["Calidad de datos"])
    && E("s02")["Sexo"] === "M" && E("s02")["Sexo (fuente)"] === "Tarjeta" && /el sexo de la tarjeta \(M\) no coincide con el de WinLab \(F\)/.test(E("s02")["Calidad de datos"])
    && E("s04")["Sexo"] === "" && /WinLab trae los dos sexos/.test(E("s04")["Calidad de datos"]) && /sin sexo registrado/.test(E("s04")["Calidad de datos"]),
    JSON.stringify([E("s01")["Sexo (fuente)"], E("s02")["Calidad de datos"], E("s04")["Calidad de datos"]]));
  const PC = Object.fromEntries(tab(st.ss, "Por completar").map((x) => [x["ID episodio"], x["Falta"]]));
  check("R30f «Por completar» ya no pide el sexo que vino de WinLab (sí el que falta en los dos lados)", !/sexo/.test(PC.s01) && /sexo/.test(PC.s04) && /sexo/.test(PC.s06), JSON.stringify(PC));
  // Una fila de una corrida anterior (versión sin «Sexo en WinLab») con MÁS valores se conserva, pero el sexo se llena.
  const hW = st.ss.sheets["Labs del robot (WinLab)"], cS = hW.cells[0].indexOf("Sexo en WinLab"), fila = hW.cells.findIndex((r) => r && r.includes("F811"));
  hW.cells[fila][cS] = "";
  // s06 sale de la base sin egreso y su expediente aparece en WinLab: su fila conservada también toma el sexo.
  d.patients = d.patients.filter((x) => x.id !== "s06");
  d.winlab_labs = [wl(7, "000811", "PRUEBA FICTICIA SINSEXO", "SINSEXO", "FEMENINO", "F811", 2, "2026-10-28T08:00:00+00:00"),
    wl(8, "000816", "PRUEBA FICTICIA SEXTA", "SEXTA", "MASCULINO", "F816", 1, "2026-10-28T08:00:00+00:00")];
  makeSandbox(st).sb.actualizarRegistro();
  const W2 = tab(st.ss, "Labs del robot (WinLab)"), f811 = W2.find((x) => x["Folio"] === "F811"), p2 = P();
  check("R30g la fila con más valores se conserva y aun así toma el sexo; la fila conservada de quien salió de la base también",
    String(f811["Estudios"]) === "3" && f811["Sexo en WinLab"] === "F" && p2.s06["Sexo"] === "M" && p2.s06["Sexo (fuente)"] === "de WinLab"
    && p2.s06["Estado en registro"] === "Salió de la base sin egreso registrado" && p2.s01["Sexo"] === "F",
    JSON.stringify([f811["Estudios"], f811["Sexo en WinLab"], p2.s06["Sexo"], p2.s06["Sexo (fuente)"]]));
  // Si la tarjeta luego trae el sexo, manda la tarjeta.
  d.notes.push({ patient_id: "s01", checklist: { sexo: "M" } });
  makeSandbox(st).sb.actualizarRegistro();
  check("R30h cuando la tarjeta trae el sexo, reemplaza al de WinLab («Tarjeta»)", P().s01["Sexo"] === "M" && P().s01["Sexo (fuente)"] === "Tarjeta", JSON.stringify(P().s01["Sexo (fuente)"]));
  // La fila conservada de quien salió de la base (s06, M «de WinLab») se vuelve a revisar: si WinLab ahora trae los dos sexos, se quita.
  d.winlab_labs = [wl(9, "000816", "PRUEBA FICTICIA SEXTA", "SEXTA", "FEMENINO", "F818", 1, "2026-10-29T09:00:00+00:00")];
  makeSandbox(st).sb.actualizarRegistro();
  check("R30j fila conservada con sexo «de WinLab»: si WinLab trae después el otro sexo de la misma persona, el sexo se quita (no se adivina)",
    P().s06["Sexo"] === "" && P().s06["Sexo (fuente)"] === "" && P().s06["Estado en registro"] === "Salió de la base sin egreso registrado", JSON.stringify([P().s06["Sexo"], P().s06["Sexo (fuente)"]]));
}
{
  // Relectura única: un registro que ya había leído WinLab (cursor guardado) lo vuelve a leer completo una sola vez.
  const st = { db: db(), hoy: "2026-10-29", props: { REG_CURSOR_winlab_labs: "2026-10-28T08:00:00.000Z", REG_SIGUE_winlab_labs: '{"v":"2026-10-01","id":1}' } };
  const m1 = makeSandbox(st), r1 = m1.sb.actualizarRegistro();
  const leyoTodo = m1.calls.some((c) => /winlab_labs\?/.test(c.u) && !/scraped_at=gte\./.test(c.u) && !/or=/.test(c.u));
  const m2 = makeSandbox(st), r2 = m2.sb.actualizarRegistro();
  check("R30i la primera corrida de esta versión vuelve a leer WinLab desde el principio (con aviso) y la siguiente ya es incremental",
    leyoTodo && r1.avisos.some((a) => /WinLab se vuelve a leer completo/.test(a)) && st.props.REG_WL_RELECTURA === m1.sb.REG_WL_RELECTURA
    && tab(st.ss, "Labs del robot (WinLab)").some((x) => x["Sexo en WinLab"] === "M")
    && m2.calls.some((c) => /winlab_labs\?.*scraped_at=gte\./.test(c.u)) && !r2.avisos.some((a) => /se vuelve a leer/.test(a)),
    JSON.stringify({ leyoTodo, a1: r1.avisos, a2: r2.avisos }));
}

// ─── R31: dx principal automático (30 oct 2026): el inferido del DX ya no se pide en «Por completar» ─────────────
{
  const pt = (id, dx) => ({ id, cama: "3-9" + id.slice(-2), nombre: "PRUEBA FICTICIA DX " + id, exp: "00091" + id.slice(-1), dx, edad: "40", ingreso: "2026-10-28", estado: "ESTABLE" });
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [], archive: [],
    patients: [pt("x1", "PANCREATITIS AGUDA BILIAR"), pt("x2", "ESTADO POSTERIOR A NADA"), pt("x3", "COLECISTITIS")],
    notes: [{ patient_id: "x3", checklist: { dx_cat: "otro" } }] };
  const st = { db: d, hoy: "2026-10-30" }; makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  const PC = Object.fromEntries(tab(st.ss, "Por completar").map((x) => [x["ID episodio"], x["Falta"]]));
  check("R31 dx principal: el inferido del DX (pancreatitis) no se pide; un DX sin coincidencia sí; el elegido en la app manda sobre el DX",
    P.x1["Dx principal"] === "Pancreatitis aguda" && P.x1["Dx principal (fuente)"] === "Inferido del DX" && !/dx principal/.test(PC.x1)
    && P.x2["Dx principal"] === "" && /dx principal/.test(PC.x2) && P.x3["Dx principal"] === "Otro" && P.x3["Dx principal (fuente)"] === "Elegido en la app" && !/dx principal/.test(PC.x3),
    JSON.stringify({ x1: [P.x1["Dx principal"], P.x1["Dx principal (fuente)"]], x2: P.x2["Dx principal"], x3: [P.x3["Dx principal"], P.x3["Dx principal (fuente)"]], PC }));
}

// ─── R32: copias de rescate de un iPad sin id de la base (30 oct 2026: 30 copias de una persona inflaban los egresos) ───
{
  const ETQ = "CAMBIOS DE ESTE iPad SIN SUBIR (el paciente ya no estaba en el censo)";
  const resc = (id, t, pd, nd) => ({ id, archived_at: t, patient_data: pd, note_data: Object.assign({ _egreso: ETQ, _egresoFecha: "30/10/2026", _cambiosLocales: { en_cola: true } }, nd) });
  const HOSP = { nombre: "PRUEBA FICTICIA HOSP", exp: "000771", cama: "3-169" };
  const h1 = { id: "h1", cama: "3-169", nombre: "PRUEBA FICTICIA HOSP", exp: "000771", dx: "COLECISTITIS", edad: "50", ingreso: "2026-10-25", estado: "ESTABLE" };
  const h9 = { id: "h9", cama: "3-170", nombre: "PRUEBA FICTICIA OTRA CAMA", exp: "000779", dx: "HERNIA", edad: "40", ingreso: "2026-10-25", estado: "ESTABLE" };
  const r2 = resc("r2", "2026-10-30T11:26:00+00:00", HOSP, { pendientes: "VIEJO DEL IPAD", labHistory: [{ fecha: "2026-10-26", labs: { hb: "10.5" } }] });
  // Corrida anterior (sin el paciente en el censo): la copia quedó en la hoja como un episodio propio «archivo-r2».
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [], patients: [h9], notes: [], archive: [r2] };
  const st = { db: d, hoy: "2026-10-30" }; makeSandbox(st).sb.actualizarRegistro();
  const antes = tab(st.ss, "Pacientes").map((x) => x["ID episodio"]);
  d.patients = [h1, h9];
  d.notes = [{ patient_id: "h1", pendientes: "EN TARJETA", manejo: "", lab_history: [{ fecha: "2026-10-28", labs: { hb: "12" } }] }];
  d.archive = [
    // Egreso anterior de la misma persona (reingresó): la copia del iPad se une a la hospitalización actual, no a esta.
    // (Capturada dentro de la ventana de lectura de la Papelera; su egreso fue el 15/10.)
    { id: "e0", archived_at: "2026-10-29T10:00:00+00:00", patient_data: { _supa_id: "h0", nombre: "PRUEBA FICTICIA HOSP", exp: "000771", cama: "3-150", ingreso: "2026-10-10", estado: "ESTABLE" }, note_data: { _egreso: "EGRESO", _egreso_tipo: "alta", _egresoFecha: "15/10/2026" } },
    { id: "e1", archived_at: "2026-10-29T18:00:00+00:00", patient_data: { _supa_id: "e1", nombre: "PRUEBA FICTICIA EGRESO", exp: "000772", cama: "3-185", ingreso: "2026-10-20", estado: "ESTABLE" }, note_data: { _egreso: "EGRESO", _egreso_tipo: "alta", _egresoFecha: "29/10/2026" } },
    resc("r1", "2026-10-30T11:25:00+00:00", HOSP, { pendientes: "VIEJO DEL IPAD", manejo: "SOLO EN LA COPIA", labHistory: [{ fecha: "2026-10-27", labs: { hb: "11" } }] }),
    r2,
    resc("r3", "2026-10-30T11:27:00+00:00", { nombre: "PRUEBA FICTICIA EGRESO", exp: "000772", cama: "3-185" }, { pendientes: "DEL EGRESADO" }),
    resc("r4", "2026-10-30T11:28:00+00:00", { nombre: "PRUEBA FICTICIA SIN BASE", exp: "", cama: "" }, { pendientes: "A" }),
    resc("r5", "2026-10-30T11:29:00+00:00", { nombre: "PRUEBA FICTICIA SIN BASE", exp: "", cama: "" }, { pendientes: "B" }),
    resc("r6", "2026-10-30T11:30:00+00:00", { nombre: "OTRA PERSONA DISTINTA", exp: "000771", cama: "3-171" }, { pendientes: "C" })
  ];
  makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  const L = tab(st.ss, "Labs");
  check("R32a la copia de un iPad sin id se une a la tarjeta de la misma persona (mismo expediente y nombre): solo rellena; la tarjeta manda",
    antes.includes("archivo-r2") && P.h1["Estado en registro"] === "Hospitalizado" && P.h1["Pendientes"] === "EN TARJETA" && P.h1["Manejo"] === "SOLO EN LA COPIA" && P.h0["Manejo"] === "" && P.h0["Estado en registro"] === "Egresado"
    && L.some((x) => x["ID episodio"] === "h1" && x["Fecha"] === "2026-10-27" && x["Vigente"] === "Sí") && L.some((x) => x["ID episodio"] === "h1" && x["Fecha"] === "2026-10-26"),
    JSON.stringify({ antes, h1: [P.h1["Pendientes"], P.h1["Manejo"]], L: L.map((x) => x["ID episodio"] + ":" + x["Fecha"] + ":" + x["Vigente"]) }));
  check("R32b ya no hay un episodio por copia: unidas (r1, r2, r3) o juntas por persona (r4 + r5); con el mismo expediente y otro nombre (r6) no se une; el egreso real conserva su motivo",
    !P["archivo-r1"] && !P["archivo-r3"] && !P["archivo-r5"] && P["archivo-r4"] && P["archivo-r6"] && /^Alta a domicilio/.test(P.e1["Motivo de egreso"])
    && L.filter((x) => x["ID episodio"] === "archivo-r2").every((x) => x["Vigente"] === "No") && L.some((x) => x["ID episodio"] === "archivo-r2"),
    JSON.stringify({ ids: Object.keys(P), e1: P.e1["Motivo de egreso"], r2: L.filter((x) => x["ID episodio"] === "archivo-r2") }));
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  const E = (id) => tab(st.ss, AN[0]).find((x) => x["ID episodio"] === K[id]) || {};
  const observados = tab(st.ss, AN[0]).filter((x) => String(x["Egreso observado"]) === "1").length;
  const R = tab(st.ss, "Resumen mensual").find((x) => String(x["Mes"]).indexOf("2026-10") === 0) || {};
  check("R32c en el análisis las copias sin episodio (también la fila vieja «archivo-r2») son «Duplicado» y se excluyen: en el mes, solo los dos egresos reales",
    ["archivo-r2", "archivo-r4", "archivo-r6"].every((id) => E(id)["Tipo de egreso"] === "Duplicado (no es otro episodio)" && String(E(id)["Excluir (duplicado)"]) === "1")
    && E("e1")["Tipo de egreso"] === "Alta" && E("h0")["Tipo de egreso"] === "Alta" && observados === 2 && String(R["Egresos (n)"]) === "2",
    JSON.stringify({ r2: E("archivo-r2")["Tipo de egreso"], r4: E("archivo-r4")["Tipo de egreso"], r6: E("archivo-r6")["Tipo de egreso"], e1: E("e1")["Tipo de egreso"], observados, R }));
}

// ─── R33: días que la app cuenta sola (30 oct 2026): con fecha de inicio el registro anota «desde AAAA-MM-DD» ───
{
  const pt = (id) => ({ id, cama: "3-7" + id.slice(-2), nombre: "PRUEBA FICTICIA DIAS " + id, exp: "00073" + id.slice(-1), dx: "COLANGITIS", edad: "40", ingreso: "2026-10-25", estado: "ESTABLE" });
  const d = { cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [], archive: [], patients: [pt("y1"), pt("y2")],
    notes: [{ patient_id: "y1", checklist: { atb: true, atb_nombre: "CEFTRIAXONA", atb_dias: "9", atb_inicio: "2026-10-27", npo: true, npo_inicio: "2026-10-28", npt: true, npt_pct: "80", npt_inicio: "2026-10-26" } },
      { patient_id: "y2", checklist: { atb: true, atb_nombre: "MEROPENEM", atb_dias: "3", npo: true, npo_dias: "2" } }] };
  const st = { db: d, hoy: "2026-10-30" }; makeSandbox(st).sb.actualizarRegistro();
  const P = Object.fromEntries(tab(st.ss, "Pacientes").map((x) => [x["ID episodio"], x]));
  check("R33 con fecha de inicio: «desde AAAA-MM-DD» (sin los días escritos a mano); sin ella, los días escritos como antes",
    P.y1["Antibiótico"] === "CEFTRIAXONA, desde 2026-10-27" && P.y1["Dieta y NPO"] === "NPO desde 2026-10-28" && P.y1["NPT"] === "Sí · 80% · desde 2026-10-26"
    && P.y2["Antibiótico"] === "MEROPENEM, 3 días" && P.y2["Dieta y NPO"] === "NPO 2 días",
    JSON.stringify([P.y1["Antibiótico"], P.y1["Dieta y NPO"], P.y1["NPT"], P.y2["Antibiótico"], P.y2["Dieta y NPO"]]));
}

// ─── R34 (15 nov 2026): el «nombre en WinLab» sin coma solo identifica al MISMO nombre (como el robot) ───
{
  const { sb } = makeSandbox({ db: {} });
  const hoy = new Date(Date.UTC(2026, 10, 15));
  const hdr = (ap, no, sexo, fnac) => ({ __cells: ["", "", "", ap, no, sexo, fnac], __hasLink: false });
  const rep = (id) => ({ __cells: ["", id, "12/11/2026 06:16", "12/11/2026 06:34", "12/11/2026 12:56", ""], __hasLink: true });
  const lista = [hdr("ROJAS PRUEBA", "LUIS", "MASCULINO", "01/01/1961"), rep("2")];
  const k = (r) => JSON.stringify(Object.keys(r.idx));
  const a1 = sb.regWlObjetivo(lista, { nombre: "ROJAS PRUEBA ANDRES", edad: "", alias: "ROJAS PRUEBA" }, hoy);
  const a2 = sb.regWlObjetivo([hdr("LOPEZ HERNANDEZ", "SANTIAGO", "MASCULINO", "03/04/2019"), rep("9")], { nombre: "MARIA SANTIAGO LOPEZ", edad: "70", alias: "SANTIAGO LOPEZ" }, hoy);
  const a3 = sb.regWlObjetivo([hdr("LOPEZ DIAS", "ANA MARIA", "FEMENINO", "01/01/1960"), rep("1")], { nombre: "ANA MARIA LOPEZ DIAZ", edad: "", alias: "LOPEZ DIAS ANA MARIA" }, hoy);
  const a4 = sb.regWlObjetivo(lista, { nombre: "ROJAS PRUEBA ANDRES", edad: "", alias: "ROJAS PRUEBA, LUIS" }, hoy);
  const a5 = sb.regWlObjetivo([hdr("DIAZ DE LEON LOPEZ", "LUIS", "MASCULINO", "01/01/1961"), rep("2")], { nombre: "DIAZ DE LEON LOPEZ ANDRES", edad: "", alias: "DIAZ DE LEON LOPEZ" }, hoy);
  check("R34 alias sin coma: solo los apellidos no toman al hermano ni a un extraño; el nombre completo sí identifica; con coma, como antes",
    k(a1) === "[]" && k(a2) === "[]" && k(a3) === '["1"]' && k(a4) === '["1"]' && k(a5) === "[]"
    && sb.regWlAliasIdentifica("ROJAS PRUEBA,") === false && sb.regWlAliasIdentifica("ROJAS PRUEBA, ANDRES") === true
    && sb.regWlAliasMismoNombre("DIAZ DE LEON LOPEZ", "DIAZ LOPEZ LEON") === false && sb.regWlAliasMismoNombre("ANA MARIA LOPEZ RAMIRES", "LOPEZ RAMIREZ ANA MARIA") === true,
    JSON.stringify([k(a1), k(a2), k(a3), k(a4), k(a5)]));
}

// ─── I1-I5 (24 nov 2026): «Integridad», margen por tabla, celdas recortadas, borrados de la Papelera, guardia_cortes ──
const INT = "Integridad", GC = "Guardia · renglones retirados";
const conteos = (m) => m.calls.filter((c) => /limit=0$/.test(c.u));
{
  // I1: una fila por corrida, con tiempos, bytes y cuadre; nunca se pisa.
  const st = { db: db(), hoy: "2026-10-21" };
  const m1 = makeSandbox(st); const r1 = m1.sb.actualizarRegistro();
  const f1 = tab(st.ss, INT);
  const bytes = JSON.parse((f1[0] || {})["Bytes leídos por tabla"] || "{}");
  check("I1a la primera corrida deja su fila: Completa, versión, duración en número, bytes por tabla y cuadre en 0",
    r1.ok && f1.length === 1 && f1[0]["Resultado"] === "Completa" && f1[0]["Versión"] === m1.sb.REGISTRO_VERSION && typeof f1[0]["Duración total (s)"] === "number" && typeof f1[0]["Lectura (s)"] === "number"
    && bytes.patients > 100 && bytes.archive > 100 && bytes.winlab_labs > 100 && bytes.notes > 100
    && f1[0]["Episodios en base (n)"] === 4 && f1[0]["Episodios en Pacientes (n)"] === 4 && f1[0]["Diferencia (en base y no en Pacientes)"] === 0
    && f1[0]["WinLab: filas en base (n)"] === 2 && f1[0]["WinLab: reportes en hoja (n)"] === 3 && f1[0]["RIS: filas en base (n)"] === 1 && f1[0]["RIS: filas en hoja (n)"] === 1
    && f1[0]["Celdas recortadas (n)"] === 0 && f1[0]["Hospitalizados que salieron sin egreso (n)"] === 0 && f1[0]["Celdas usadas"] > 0 && f1[0]["WinLab actualizadas en sitio (n)"] === "", JSON.stringify(f1));
  check("I1b los conteos van sin cuerpo: GET con limit=0 y «Prefer: count=exact» (2 en la primera corrida), y la lectura ligera de la Papelera no pide nombres",
    conteos(m1).length === 2 && conteos(m1).every((c) => c.m === "get" && c.headers.Prefer === "count=exact" && c.headers.apikey === "svc")
    && m1.calls.some((c) => /archive\?select=id,s:patient_data->>_supa_id,i:patient_data->>id&/.test(c.u)) && m1.calls.filter((c) => !/limit=0$/.test(c.u)).every((c) => !(c.headers || {}).Prefer));
  check("I1c «Integridad» no trae nombres ni expedientes, tiene sus 21 columnas justas y la corrida completa queda anotada en las propiedades",
    !nombres.test(JSON.stringify(st.ss.sheets[INT].cells)) && st.ss.sheets[INT].maxC === 21 && !!st.props.REG_ULTIMA_COMPLETA && m1.logs.every((l) => !nombres.test(l)));
  const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  const f2 = tab(st.ss, INT);
  check("I1d dos corridas seguidas dejan 2 filas (la primera intacta) y la segunda ya cuenta lo de WinLab en sitio (0)",
    f2.length === 2 && JSON.stringify(f2[0]) === JSON.stringify(f1[0]) && f2[1]["Resultado"] === "Completa" && f2[1]["WinLab actualizadas en sitio (n)"] === 0 && conteos(m2).length === 3, JSON.stringify(f2));
  // Una copia de la Papelera que la lectura por fecha no alcanza (archivada «antes» de la ventana) no está en Pacientes.
  st.db.archive.push({ id: "a77", archived_at: "2026-10-01T10:00:00+00:00", patient_data: { _supa_id: "p77", nombre: "PRUEBA FICTICIA SETENTA", exp: "000777" }, note_data: {} });
  const r3 = makeSandbox(st).sb.actualizarRegistro(), f3 = tab(st.ss, INT);
  check("I1e una copia de archive que no está en Pacientes: Diferencia 1, 5 episodios en base y aviso (sin nombres)",
    f3.length === 3 && f3[2]["Diferencia (en base y no en Pacientes)"] === 1 && f3[2]["Episodios en base (n)"] === 5 && f3[2]["Episodios en Pacientes (n)"] === 4
    && r3.avisos.some((a) => /1 episodio\(s\) de la base no están en «Pacientes»/.test(a)) && /no están en «Pacientes»/.test(f3[2]["Avisos"]) && !nombres.test(JSON.stringify(st.ss.sheets[INT].cells)), JSON.stringify(f3[2]));
  // La escritura falla: la corrida lanza, pero deja su fila «Falló» sin datos de pacientes.
  st.db.notes[0].pendientes = "+ USG (CAMBIO FICTICIO)";
  st.failWriteOn = "Pacientes";
  const m4 = makeSandbox(st); let e4 = null; try { m4.sb.actualizarRegistro(); } catch (e) { e4 = String(e.message); }
  const f4 = tab(st.ss, INT);
  check("I1f si la escritura falla la corrida lanza igual y su fila dice «Falló», sin nombre ni expediente (tampoco en el registro de ejecución)",
    /timed out/.test(e4 || "") && f4.length === 4 && /^Falló: .*timed out/.test(f4[3]["Resultado"]) && typeof f4[3]["Lectura (s)"] === "number" && f4[3]["Análisis (s)"] === ""
    && !nombres.test(JSON.stringify(st.ss.sheets[INT].cells)) && m4.logs.every((l) => !nombres.test(l)), JSON.stringify([e4, f4[3]]));
  delete st.failWriteOn;
  // La lectura falla: fila «Falló» con el código y sin el cuerpo de la respuesta.
  st.falla = { archive: 500 };
  const m5 = makeSandbox(st); let e5 = null; try { m5.sb.actualizarRegistro(); } catch (e) { e5 = String(e.message); }
  const f5 = tab(st.ss, INT);
  check("I1g si Supabase falla, la fila «Falló» trae el código HTTP y nada del cuerpo de la respuesta",
    /archive HTTP 500/.test(e5 || "") && f5.length === 5 && f5[4]["Resultado"] === "Falló: Supabase archive HTTP 500" && !/SECRETO|FICTICIO/.test(JSON.stringify(st.ss.sheets[INT].cells)), JSON.stringify(f5[4]));
  delete st.falla;
  // Una fuente opcional caída: Parcial, no se vuelve a pedir para contarla y la «última completa» no avanza.
  const completa = st.props.REG_ULTIMA_COMPLETA;
  st.agotado = { winlab_labs: true }; st.nLlamadas = {};
  const r6 = makeSandbox(st).sb.actualizarRegistro(), f6 = tab(st.ss, INT);
  check("I1h con WinLab caído: «Parcial: faltó leer winlab_labs», un solo intento (no se cuenta), su conteo vacío y REG_ULTIMA_COMPLETA sin avanzar",
    r6.ok && f6[5]["Resultado"] === "Parcial: faltó leer winlab_labs" && st.nLlamadas.winlab_labs === 1 && f6[5]["WinLab: filas en base (n)"] === "" && f6[5]["WinLab: reportes en hoja (n)"] === 3
    && f6[5]["RIS: filas en base (n)"] === 1 && st.props.REG_ULTIMA_COMPLETA === completa, JSON.stringify(f6[5]));
  delete st.agotado;
  // Dos corridas que empiezan en el mismo segundo no se pisan.
  const sr = { db: db(), reloj: Date.parse("2026-11-25T05:00:03Z") };
  makeSandbox(sr).sb.actualizarRegistro(); makeSandbox(sr).sb.actualizarRegistro();
  const fr = tab(sr.ss, INT);
  check("I1i «Corrida» es la hora de inicio en Ciudad de México; si dos empiezan en el mismo segundo la segunda lleva «(2)»",
    fr.length === 2 && fr[0]["Corrida"] === "2026-11-24 23:00:03" && fr[1]["Corrida"] === "2026-11-24 23:00:03 (2)", JSON.stringify(fr.map((x) => x["Corrida"])));
  // regContar_: sin la cabecera del total, o con error, lanza (y el cuadre lo deja vacío sin detener la corrida).
  const mc = makeSandbox({ db: db() });
  const n1 = mc.sb.regContar_("svc", "ris_estudios", "scraped_at=not.is.null");
  mc.sb.UrlFetchApp.fetch = () => ({ getResponseCode: () => 206, getContentText: () => "[]", getHeaders: () => ({ "content-range": "*/17" }) });
  const n2 = mc.sb.regContar_("svc", "ris_estudios", "");
  mc.sb.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => "[]", getHeaders: () => ({}) });
  let ec = null; try { mc.sb.regContar_("svc", "ris_estudios", ""); } catch (e) { ec = String(e.message); }
  mc.sb.UrlFetchApp.fetch = () => ({ getResponseCode: () => 400, getContentText: () => JSON.stringify({ code: "42703", message: "column PACIENTE FICTICIO SECRETO does not exist" }), getHeaders: () => ({}) });
  let ed = null; try { mc.sb.regContar_("svc", "ris_estudios", ""); } catch (e) { ed = String(e.message); }
  check("I1j regContar_: lee el total de Content-Range (200 o 206, cabecera en cualquier caja); sin total o con error lanza, solo con el código",
    n1 === 1 && n2 === 17 && /Content-Range/.test(ec || "") && ed === "Supabase ris_estudios HTTP 400 (42703)", JSON.stringify([n1, n2, ec, ed]));
  const sq = { db: db(), falla: { ris_estudios: 0 } };
  const mq = makeSandbox(sq);
  const fetch0 = mq.sb.UrlFetchApp.fetch;
  mq.sb.UrlFetchApp.fetch = (url, opts) => { if (/limit=0$/.test(url)) return { getResponseCode: () => 503, getContentText: () => "{}", getHeaders: () => ({}) }; return fetch0(url, opts); };
  const rq = mq.sb.actualizarRegistro(), fq = tab(sq.ss, INT);
  check("I1k si los conteos fallan la corrida sigue y queda Completa: números vacíos y la causa solo en «Avisos» de Integridad",
    rq.ok && !rq.avisos.length && fq[0]["Resultado"] === "Completa" && fq[0]["RIS: filas en base (n)"] === "" && fq[0]["WinLab: filas en base (n)"] === "" && fq[0]["Episodios en base (n)"] === 4
    && /No se pudo contar ris_estudios \(Supabase ris_estudios HTTP 503\)/.test(fq[0]["Avisos"]), JSON.stringify([rq.avisos, fq[0]]));
  const vars = mc.sb.regVariables_();
  const def = (pest) => vars.filter((v) => v[0] === pest).map((v) => v[1]).join(" · ");
  check("I1l cada columna de «Integridad» y de «Guardia · renglones retirados» está en el Diccionario de variables, con su sesgo",
    mc.sb.REG_INTEGRIDAD.columnas.every((c) => def(INT).includes(c)) && ["ID", "Orden", "ID episodio", "Fecha y hora", "Motivo", "Renglón"].every((c) => def(GC).includes(c))
    && vars.filter((v) => v[0] === INT || v[0] === GC).some((v) => /Sesgo/.test(v[4])) && vars.some((v) => v[0] === "Pacientes" && /Nota completa \(JSON\) · 2/.test(v[1])));
}
{
  // I2: margen de relectura por tabla (WinLab 6 h; Papelera y RIS 2 días) y vigilancia de lo que cambia en sitio.
  const st = { db: db(), hoy: "2026-10-21" };
  makeSandbox(st).sb.actualizarRegistro();
  // Una captura un día antes del cursor (fuera de las 6 h) y otra 2 h antes (dentro): solo la segunda se relee.
  st.db.winlab_labs.push({ id: 3, exp: "000123", paciente: "PRUEBA FICTICIA UNO", fecha: "2026-10-19", scraped_at: "2026-10-19T06:30:00+00:00", data: st.db.winlab_labs[0].data });
  const m2 = makeSandbox(st); const r2 = m2.sb.actualizarRegistro();
  const gte = (t, col) => (m2.calls.map((c) => new RegExp(t + "\\?.*" + col + "=gte\\.([0-9TZ:.-]+)").exec(c.u)).filter(Boolean)[0] || [])[1];
  check("I2a con el cursor en T, WinLab relee desde T−6 h y la Papelera y RIS desde T−2 días",
    st.props.REG_CURSOR_winlab_labs === "2026-10-19T08:00:00.123456+00:00" && gte("winlab_labs", "scraped_at") === "2026-10-19T02:00:00.123Z"
    && gte("archive", "archived_at") === "2026-10-15T10:00:00.000Z" && gte("ris_estudios", "scraped_at") === "2026-10-13T10:00:00.000Z", JSON.stringify([gte("winlab_labs", "scraped_at"), gte("archive", "archived_at"), gte("ris_estudios", "scraped_at")]));
  const bytes2 = JSON.parse(tab(st.ss, INT)[1]["Bytes leídos por tabla"]), bytes1 = JSON.parse(tab(st.ss, INT)[0]["Bytes leídos por tabla"]);
  check("I2b lo que cae dentro de las 6 h se relee y no se duplica (clave Expediente + Reporte); la captura del 1 de oct ya no se baja",
    r2.ok && tab(st.ss, "Labs del robot (WinLab)").length === 3 && tab(st.ss, "Cultivos del robot (WinLab)").length === 1 && bytes2.winlab_labs > 100 && bytes2.winlab_labs > bytes1.winlab_labs - 600, JSON.stringify([bytes1.winlab_labs, bytes2.winlab_labs]));
  // El robot corrige EN SITIO una fila vieja (updated_at nuevo, scraped_at fuera de la ventana): no se relee; se cuenta y se avisa.
  st.db.winlab_labs[1].updated_at = new Date(Date.now() + 60000).toISOString();
  const m3 = makeSandbox(st); const r3 = m3.sb.actualizarRegistro(), f3 = tab(st.ss, INT)[2];
  check("I2c una fila de WinLab actualizada en sitio fuera de la ventana: «WinLab actualizadas en sitio (n)» = 1 y aviso; el conteo filtra por updated_at y scraped_at",
    r3.ok && f3["WinLab actualizadas en sitio (n)"] === 1 && r3.avisos.some((a) => /1 fila\(s\) de WinLab cambiaron en la base/.test(a))
    && conteos(m3).some((c) => /winlab_labs\?select=id&updated_at=gte\..*&scraped_at=lt\.2026-10-19T02:00:00\.123Z&/.test(c.u)), JSON.stringify([r3.avisos, f3]));
  // Si winlab_labs no tuviera updated_at (42703), el número queda vacío, no hay aviso en el Diccionario y la corrida es Completa.
  st.columnas = { winlab_labs: ["id", "exp", "paciente", "fecha", "scraped_at", "data"] };
  const r4 = makeSandbox(st).sb.actualizarRegistro(), f4 = tab(st.ss, INT)[3];
  check("I2d sin la columna updated_at en la base: conteo vacío, corrida Completa y la causa (42703) solo en «Integridad»",
    r4.ok && f4["Resultado"] === "Completa" && f4["WinLab actualizadas en sitio (n)"] === "" && !r4.avisos.some((a) => /WinLab/.test(a)) && /actualizadas en sitio \(Supabase winlab_labs HTTP 400 \(42703\)\)/.test(f4["Avisos"]), JSON.stringify([r4.avisos, f4]));
}
{
  // I3: la nota larga sigue en la columna «· 2» en vez de cortarse; lo que sí se recorta se cuenta y se avisa.
  const d = db();
  const largo = (n, semilla) => { let t = ""; while (t.length < n) t += "RENGLÓN FICTICIO " + semilla + " " + t.length + "; "; return t.slice(0, n); };
  Object.assign(d.notes[0], { pa: largo(24000, "PA"), misc: largo(24000, "MISC"), manejo: largo(22000, "MANEJO"),
    documentVault: [{ nombre: "DOCUMENTO FICTICIO", texto: "BOVEDA-NO-DEBE-SALIR" }], dicomFiles: ["DICOM-NO-DEBE-SALIR"], drainageScreenshots: ["CAPTURA-NO-DEBE-SALIR"], cvc_image: "CVC-NO-DEBE-SALIR", imagen_file: "IMG-NO-DEBE-SALIR",
    body_diagram_lat_l: "LATL-NO-DEBE-SALIR", body_diagram_lat_r: "LATR-NO-DEBE-SALIR" });
  const st = { db: d, hoy: "2026-10-21" };
  const r = makeSandbox(st).sb.actualizarRegistro();
  const p1 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p1"), junto = p1["Nota completa (JSON)"] + p1["Nota completa (JSON) · 2"];
  let nota = null; try { nota = JSON.parse(junto); } catch (_) {}
  check("I3a nota de 70 000 caracteres: las dos columnas pegadas son JSON válido y completo, cada una cabe en su celda y nada se recortó",
    r.ok && junto.length > 70000 && p1["Nota completa (JSON)"].length === 45000 && p1["Nota completa (JSON) · 2"].length > 20000 && !!nota && nota.pa === d.notes[0].pa && nota.misc === d.notes[0].misc && nota.manejo === d.notes[0].manejo
    && !/recortado/.test(junto) && tab(st.ss, INT)[0]["Celdas recortadas (n)"] === 0 && !r.avisos.some((a) => /recortad/.test(a)), JSON.stringify([junto.length, r.avisos]));
  check("I3b la nota completa ya no lleva la bóveda, los DICOM, las capturas, la foto del catéter ni los diagramas laterales", !/NO-DEBE-SALIR|documentVault|dicomFiles|drainageScreenshots|cvc_image|imagen_file|body_diagram_lat/.test(junto));
  check("I3c una nota corta deja la columna «· 2» vacía y la columna nueva quedó al final de Pacientes", tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p3")["Nota completa (JSON) · 2"] === ""
    && st.ss.sheets["Pacientes"].cells[0].indexOf("Nota completa (JSON) · 2") === 49
    && JSON.stringify(st.ss.sheets["Pacientes"].cells[0].slice(50)) === JSON.stringify(["Egresado por", "Motivo de egreso registrado por", "Motivo registrado el", "Última modificación por", "Nota restaurada el", "Alias WinLab"]));
  // Un texto de 60 000 en otra columna sí se recorta: contador 1 y aviso (en cada corrida mientras siga así).
  d.notes[0].pa = "DOLOR FICTICIO"; d.notes[0].misc = ""; d.notes[0].manejo = ""; d.notes[0].app = largo(60000, "APP");
  const m2 = makeSandbox(st); const r2 = m2.sb.actualizarRegistro(), f2 = tab(st.ss, INT)[1];
  const q1 = tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p1");
  check("I3d texto de 60 000 en otra columna: se guarda recortado, «Celdas recortadas (n)» = 1 y aviso en la corrida y en el Diccionario",
    r2.ok && / …\[recortado\]$/.test(q1["Antecedentes (APP)"]) && q1["Antecedentes (APP)"].length < 50000 && f2["Celdas recortadas (n)"] === 1 && r2.avisos.some((a) => /^1 celda\(s\) pasaron de 45000 caracteres/.test(a))
    && /1 celda\(s\) pasaron de 45000/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)) && JSON.parse(q1["Nota completa (JSON)"] + q1["Nota completa (JSON) · 2"]).app.length === 60000, JSON.stringify([f2["Celdas recortadas (n)"], r2.avisos]));
  const r3 = makeSandbox(st).sb.actualizarRegistro(), f3 = tab(st.ss, INT)[2];
  check("I3e a la noche siguiente el mismo texto largo se vuelve a contar una vez (lo ya recortado en la hoja no se cuenta doble)", r3.ok && f3["Celdas recortadas (n)"] === 1, String(f3["Celdas recortadas (n)"]));
  const s0 = makeSandbox({ db: db() }).sb;
  const par = s0.regPartir_("A".repeat(44999) + "😀" + "B".repeat(10));
  check("I3f regPartir_: no parte un carácter de dos unidades, y regCelda cuenta solo los recortes nuevos",
    par[0].length === 44999 && par[1].length === 12 && par[0] + par[1] === "A".repeat(44999) + "😀" + "B".repeat(10) && JSON.stringify(s0.regPartir_("CORTO")) === JSON.stringify(["CORTO", ""])
    && (() => { s0.REG_CORRIDA.recortes = 0; const c = s0.regCelda("ñ".repeat(60000)); s0.regCelda(c); s0.regCelda("ñ".repeat(45000)); s0.regCelda(7); return s0.REG_CORRIDA.recortes === 1 && c.length === 45013; })());
}
{
  // I4: lo borrado de la Papelera (archive_eliminados) y el aviso de corrida incompleta.
  const d = db();
  d.archive_eliminados = [{ id: 1, eliminado_en: "2026-10-20T15:00:00+00:00", archive_id: "a9", quien_email: "secreto.ficticio@ejemplo.test", quien_nombre: "QUIEN FICTICIO SECRETO", ip: "10.0.0.9", ua: "UA SECRETO", dispositivo: "IPAD SECRETO",
    fila: { id: "a9", archived_at: "2026-10-20T09:00:00+00:00", archived_by: "R1", patient_data: { _supa_id: "p9", cama: "3-209", nombre: "PRUEBA FICTICIA BORRADA", exp: "000909", ingreso: "2026-10-18", estado: "ALTA" }, note_data: { _egreso: "alta médica", _egresoFecha: "20/10/2026", pendientes: "CITA FICTICIA" } } },
  // La misma copia sigue en archive (alguien la repuso): manda la de archive.
  { id: 2, eliminado_en: "2026-10-20T16:00:00+00:00", archive_id: "a2", fila: { id: "a2", archived_at: "2026-10-12T10:00:00+00:00", patient_data: { _supa_id: "p3", nombre: "PRUEBA FICTICIA TRES", exp: "000789" }, note_data: { _egreso: "OTRO MOTIVO FICTICIO" } } }];
  const st = { db: d, hoy: "2026-10-21" };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const P = tab(st.ss, "Pacientes"), p9 = P.find((x) => x["ID episodio"] === "p9"), p3 = P.find((x) => x["ID episodio"] === "p3");
  check("I4a una copia que solo existe en archive_eliminados: su episodio aparece en Pacientes como egresado, con Fuente «Papelera (borrado)»",
    r.ok && P.length === 5 && p9 && p9["Estado en registro"] === "Egresado" && p9["Fuente"] === "Papelera (borrado)" && p9["Motivo de egreso"] === "alta médica" && p9["Fecha de egreso"] === "2026-10-20" && p9["Pendientes"] === "CITA FICTICIA"
    && p3["Fuente"] === "Papelera (archive)" && p3["Motivo de egreso"] === "alta médica", JSON.stringify([p9, p3 && p3["Fuente"]]));
  check("I4b de archive_eliminados solo se piden id, fecha, archive_id y fila (nada de quién borró) y nada de eso llega a la hoja ni al registro de ejecución",
    m.calls.filter((c) => /archive_eliminados\?/.test(c.u)).length === 1 && m.calls.filter((c) => /archive_eliminados\?/.test(c.u)).every((c) => /\?select=id,eliminado_en,archive_id,fila&eliminado_en=not\.is\.null&order=eliminado_en\.asc,id\.asc&limit=10$/.test(c.u))
    && !/SECRETO|secreto\.ficticio|10\.0\.0\.9/.test(snap(st.ss) + JSON.stringify(st.ss.sheets[INT].cells) + m.logs.join("|")) && st.props.REG_CURSOR_archive_eliminados === "2026-10-20T16:00:00+00:00");
  const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  check("I4c la segunda corrida lee los borrados por cursor (desde 2 días antes) y no duplica el episodio",
    tab(st.ss, "Pacientes").length === 5 && m2.calls.some((c) => /archive_eliminados\?.*eliminado_en=gte\.2026-10-18T16:00:00\.000Z/.test(c.u)) && tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p9")["Fuente"] === "Papelera (borrado)");
  // Tabla vacía: nada cambia. Tabla que falla: lo demás se escribe y se avisa.
  const sv = { db: db(), hoy: "2026-10-21" }; sv.db.archive_eliminados = [];
  const rv = makeSandbox(sv).sb.actualizarRegistro();
  const sn = { db: db(), hoy: "2026-10-21" }; makeSandbox(sn).sb.actualizarRegistro();
  check("I4d con archive_eliminados vacía nada cambia (misma hoja que sin la tabla) y la corrida es Completa", rv.ok && !rv.avisos.length && snap(sv.ss) === snap(sn.ss) && tab(sv.ss, INT)[0]["Resultado"] === "Completa");
  const sf = { db: db(), falla: { archive_eliminados: 500 } };
  const rf = makeSandbox(sf).sb.actualizarRegistro();
  check("I4e si archive_eliminados falla, lo demás se escribe, sale el aviso y la corrida queda «Parcial»",
    rf.ok && tab(sf.ss, "Pacientes").length === 4 && rf.avisos.some((a) => /No se pudo leer archive_eliminados \(Supabase archive_eliminados HTTP 500\)/.test(a)) && tab(sf.ss, INT)[0]["Resultado"] === "Parcial: faltó leer archive_eliminados" && !sf.props.REG_ULTIMA_COMPLETA);
  check("I4f regFilasEliminadas_: usa archive_id (o el id de la fila), descarta lo que no trae fila y marca la copia como borrada",
    JSON.stringify(m.sb.regFilasEliminadas_([{ id: 1, archive_id: "x1", eliminado_en: "2026-10-20T15:00:00Z", fila: { id: "x1", patient_data: { nombre: "N" }, note_data: {} } }, { id: 2, archive_id: null, fila: { id: "x2" } }, { id: 3, archive_id: "x3", fila: null }, null]))
    === JSON.stringify([{ id: "x1", patient_data: { nombre: "N" }, note_data: {}, archived_at: "2026-10-20T15:00:00Z", __borrado: true }, { id: "x2", __borrado: true }]));
  // Corrida cortada: REG_ULTIMA_COMPLETA no avanza; pasadas 36 h sin una completa, se avisa.
  const T0 = Date.parse("2026-11-01T05:00:00Z");
  const sc = { db: db(), reloj: T0 };
  makeSandbox(sc).sb.actualizarRegistro();
  const c0 = sc.props.REG_ULTIMA_COMPLETA;
  sc.reloj = T0 + 24 * 3600000; sc.db.notes[0].pendientes = "+ USG (CAMBIO FICTICIO)";
  sc.alEscribir = (hoja) => { if (hoja === "Pacientes") sc.reloj += 330000; };
  const rc = makeSandbox(sc).sb.actualizarRegistro(); delete sc.alEscribir;
  const fc = tab(sc.ss, INT);
  check("I4g corrida cortada por tiempo: «Parcial: faltó escribir todas las pestañas», REG_ULTIMA_COMPLETA no avanza y no se hicieron conteos fuera de tiempo",
    c0 === new Date(T0).toISOString() && rc.ok && rc.pendiente && sc.props.REG_ULTIMA_COMPLETA === c0 && fc.length === 2 && fc[1]["Resultado"] === "Parcial: faltó escribir todas las pestañas"
    && fc[1]["Duración total (s)"] === 330 && fc[1]["RIS: filas en base (n)"] === "" && /Sin tiempo para contar ris_estudios/.test(fc[1]["Avisos"]), JSON.stringify(fc[1]));
  sc.reloj = T0 + 40 * 3600000;
  const rd = makeSandbox(sc).sb.actualizarRegistro(), fd = tab(sc.ss, INT);
  check("I4h a las 40 h de la última completa: aviso en la corrida, en el Diccionario y en «Integridad»; al completarse, la marca avanza y el aviso no se repite",
    rd.ok && rd.avisos.some((a) => /^Pasaron 40 h desde la última corrida completa/.test(a)) && /Pasaron 40 h/.test(JSON.stringify(sc.ss.sheets["Diccionario"].cells)) && /Pasaron 40 h/.test(fd[2]["Avisos"]) && fd[2]["Resultado"] === "Completa"
    && sc.props.REG_ULTIMA_COMPLETA === new Date(T0 + 40 * 3600000).toISOString() && ((sc.reloj = T0 + 64 * 3600000), !makeSandbox(sc).sb.actualizarRegistro().avisos.some((a) => /Pasaron/.test(a))), JSON.stringify(rd.avisos));
}
{
  // I5: renglones de guardia retirados (guardia_cortes: la base los purga a los 7 días).
  const d = db();
  d.guardia_cortes = [
    { id: 501, patient_id: "p1", ts: "2026-10-20T12:15:00+00:00", lineas: ["19/10 22:00 R1: RENGLÓN FICTICIO A", "19/10 23:30 R1: RENGLÓN FICTICIO B"], motivo: "corte", interno: "NO-DEBE-SALIR" },
    { id: 502, patient_id: "p2", ts: "2026-10-21T03:00:00+00:00", lineas: ["20/10 21:00 R2: RENGLÓN FICTICIO C", "  "], motivo: "borrado" },
    { id: 503, patient_id: "p2", ts: "2026-10-21T03:05:00+00:00", lineas: [], motivo: "corte" }];
  const st = { db: d, hoy: "2026-10-21" };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const G = tab(st.ss, GC);
  check("I5a dos cortes con 2 y 1 renglones → 3 filas, con ID, episodio, fecha, motivo y orden; sin columnas de nombre ni expediente",
    r.ok && !r.avisos.length && G.length === 3 && JSON.stringify(st.ss.sheets[GC].cells[0]) === JSON.stringify(["ID", "ID episodio", "Fecha y hora", "Motivo", "Orden", "Renglón"]) && st.ss.sheets[GC].maxC === 6
    && JSON.stringify(G.map((x) => [x["ID"], x["ID episodio"], x["Motivo"], String(x["Orden"]), x["Renglón"]])) === JSON.stringify([["501", "p1", "corte", "1", "19/10 22:00 R1: RENGLÓN FICTICIO A"], ["501", "p1", "corte", "2", "19/10 23:30 R1: RENGLÓN FICTICIO B"], ["502", "p2", "borrado", "1", "20/10 21:00 R2: RENGLÓN FICTICIO C"]])
    && G[0]["Fecha y hora"] === "2026-10-20T12:15:00+00:00" && r.cuentas[GC] === 3, JSON.stringify(G));
  check("I5b se lee por cursor con solo sus 5 columnas y queda anotado cuándo se copió",
    m.calls.some((c) => /guardia_cortes\?select=id,patient_id,ts,lineas,motivo&ts=not\.is\.null&order=ts\.asc,id\.asc&limit=500$/.test(c.u)) && st.props.REG_CURSOR_guardia_cortes === "2026-10-21T03:05:00+00:00" && !!st.props.REG_GUARDIA_LEIDA && !/NO-DEBE-SALIR/.test(snap(st.ss)));
  // La base purga lo viejo y llega un corte nuevo: la hoja conserva todo y no duplica lo releído (margen de 1 h).
  d.guardia_cortes = d.guardia_cortes.filter((g) => g.id !== 501);
  d.guardia_cortes.push({ id: 504, patient_id: "p1", ts: "2026-10-21T12:15:00+00:00", lineas: ["20/10 23:00 R1: RENGLÓN FICTICIO D"], motivo: "corte" });
  const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  const G2 = tab(st.ss, GC);
  check("I5c segunda corrida: relee desde 1 h antes, no duplica, agrega el corte nuevo y conserva lo que la base ya purgó",
    G2.length === 4 && G2.filter((x) => x["ID"] === "501").length === 2 && G2.filter((x) => x["ID"] === "502").length === 1 && G2.filter((x) => x["ID"] === "504").length === 1
    && m2.calls.some((c) => /guardia_cortes\?.*ts=gte\.2026-10-21T02:05:00\.000Z/.test(c.u)), JSON.stringify(G2.map((x) => x["ID"])));
  // Si guardia_cortes falla: lo demás se escribe, su pestaña no se toca y sale el aviso de la fuente.
  st.falla = { guardia_cortes: 500 }; st.db.notes[0].pendientes = "+ USG (CAMBIO FICTICIO)";
  const antesG = JSON.stringify(st.ss.sheets[GC].cells), leida = st.props.REG_GUARDIA_LEIDA;
  const r3 = makeSandbox(st).sb.actualizarRegistro();
  check("I5d si guardia_cortes responde 500: las demás pestañas sí se escriben, la suya queda igual, sale el aviso y no se marca como copiada",
    r3.ok && tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "p1")["Pendientes"] === "+ USG (CAMBIO FICTICIO)" && JSON.stringify(st.ss.sheets[GC].cells) === antesG
    && r3.avisos.some((a) => /No se pudo leer guardia_cortes \(Supabase guardia_cortes HTTP 500\): sus pestañas no se tocaron/.test(a)) && st.props.REG_GUARDIA_LEIDA === leida && st.props.REG_CURSOR_guardia_cortes === "2026-10-21T12:15:00+00:00", JSON.stringify(r3.avisos));
  // Más de 6 días sin copiarla: aviso (la base purga a los 7).
  st.props.REG_GUARDIA_LEIDA = new Date(Date.now() - 6.5 * 86400000).toISOString();
  const r4 = makeSandbox(st).sb.actualizarRegistro();
  delete st.falla;
  const r5 = makeSandbox(st).sb.actualizarRegistro(), r6 = makeSandbox(st).sb.actualizarRegistro();
  check("I5e pasados 6 días sin copiar la guardia se avisa (también en el Diccionario de esa corrida); al volver a leerla, el aviso se va",
    r4.avisos.some((a) => /Pasaron 7 días sin copiar los renglones retirados de la guardia/.test(a)) && r5.ok && !r6.avisos.some((a) => /renglones retirados/.test(a)), JSON.stringify([r4.avisos, r6.avisos]));
  // Si se acaba el tiempo, la guardia ya quedó escrita antes que las pestañas grandes de los robots.
  const nombresPest = m.sb.REG_PESTANAS.map((c) => c.nombre);
  check("I5f la pestaña de la guardia se escribe antes que las de los robots (WinLab, RIS) y entra a las de fuente opcional",
    nombresPest.indexOf(GC) > 0 && nombresPest.indexOf(GC) < nombresPest.indexOf("Labs del robot (WinLab)") && m.sb.REG_PESTANAS.find((c) => c.nombre === GC).fuente === "guardia_cortes" && m.sb.REG_CURSORES.guardia_cortes.margenMs === 3600000 && m.sb.REG_CURSORES.winlab_labs.margenMs === 6 * 3600000);
}

// ═══ Lote 24 nov 2026: correcciones de cálculo (4-7, 16) y columnas nuevas de Pacientes (10) y Cirugías (11) ═══════
const VACIO = () => ({ cronologia_respaldo: [], ris_estudios: [], winlab_labs: [], procedimientos_dia: [], archive: [], patients: [], notes: [] });
const porId = (ss, n) => Object.fromEntries(tab(ss, n).map((x) => [x["ID episodio"], x]));
const episodiosDe = (ss) => { const K = Object.fromEntries(tab(ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]])); const E = tab(ss, AN[0]); return (id) => E.find((x) => x["ID episodio"] === K[id] && x["Vigente"] === "Sí") || {}; };
const egresado = (id, sid, nombre, exp, ingreso, archivado, extraPd, nd, extra) => Object.assign({ id, archived_at: archivado + "T18:00:00+00:00",
  patient_data: Object.assign({ _supa_id: sid, nombre, exp, ingreso, edad: "50" }, extraPd || {}), note_data: Object.assign({ _egreso: "RETIRADO DEL CENSO (hoja)" }, nd || {}) }, extra || {});

// ─── C4: cirugía sin fecha en el Resumen mensual; DX con marca de postoperado y sin grupo; grupos de otras especialidades ──
{
  const d = VACIO();
  const pt = (id, n, dx, ingreso) => ({ id, cama: "3-8" + n, nombre: "PRUEBA FICTICIA CUATRO " + id.toUpperCase(), exp: "00084" + n, dx, edad: "45", ingreso: ingreso || "2026-10-20", estado: "ESTABLE" });
  d.patients = [pt("m2", 2, "TCE SEVERO + PO CRANEOTOMIA"), pt("m3", 3, "PO PROCEDIMIENTO X"), pt("m4", 4, "LITIASIS. PENDIENTE PO PROCEDIMIENTO Y + ANTECEDENTE DE PO PROCEDIMIENTO Z + PROGRAMADO PARA NEFRECTOMIA"),
    pt("m5", 5, "DOLOR ABDOMINAL 21/10 + SEPSIS")];
  d.notes = d.patients.map((p) => ({ patient_id: p.id, checklist: { sexo: "F" } }));
  d.archive = [egresado("am1", "m1", "PRUEBA FICTICIA CUATRO M1", "000841", "2026-03-10", "2026-03-20", { dx: "HERNIA INGUINAL + PO PLASTIA INGUINAL" })];
  const st = { db: d, hoy: "2026-10-28" }; const r = makeSandbox(st).sb.actualizarRegistro();
  const C = tab(st.ss, "Cirugías"), de = (id) => C.filter((x) => x["ID episodio"] === id), E = episodiosDe(st.ss);
  const R = Object.fromEntries(tab(st.ss, "Resumen mensual").map((x) => [x["Mes"], x]));
  const mar = R["2026-03"] || {};
  check("C4a ingreso en marzo y cirugía inferida sin fecha: marzo cuenta Cirugías (n) = 1, 1 paciente operado y «sin fecha exacta» = 1; el episodio dice «Cirugías sin fecha (n)» = 1",
    r.ok && de("m1").length === 1 && de("m1")[0]["Fecha"] === "" && mar["Cirugías (n)"] === 1 && mar["Pacientes operados (n)"] === 1 && mar["Cirugías sin fecha exacta (n)"] === 1
    && E("m1")["Cirugías (n)"] === 1 && E("m1")["Cirugías sin fecha (n)"] === 1 && E("m1")["Primera cirugía"] === "" && /sin fecha: en el Resumen mensual/.test(E("m1")["Calidad de datos"]),
    JSON.stringify([de("m1"), mar, E("m1")["Cirugías sin fecha (n)"]]));
  check("C4b «PO CRANEOTOMIA» sin fecha: una cirugía del grupo nuevo «Neurocirugía (cráneo)»; cuenta en octubre (mes del ingreso)",
    de("m2").length === 1 && de("m2")[0]["Grupo"] === "Neurocirugía (cráneo)" && de("m2")[0]["Fuente"] === "DX (inferida)" && E("m2")["Grupo de la 1.ª cirugía"] === "Neurocirugía (cráneo)"
    && (R["2026-10"] || {})["Cirugías (n)"] === 2 && (R["2026-10"] || {})["Cirugías sin fecha exacta (n)"] === 2, JSON.stringify([de("m2"), R["2026-10"]]));
  check("C4c «PO PROCEDIMIENTO X» (con marca y sin grupo) se conserva con grupo «Otro»; antes se perdía",
    de("m3").length === 1 && de("m3")[0]["Grupo"] === "Otro" && de("m3")[0]["Procedimiento"] === "PO PROCEDIMIENTO X" && E("m3")["Cirugías (n)"] === 1, JSON.stringify(de("m3")));
  check("C4d los segmentos de plan (PENDIENTE, PROGRAMADO) o de antecedente siguen sin contar, y una fecha sola sin marca ni grupo tampoco",
    de("m4").length === 0 && E("m4")["Cirugías (n)"] === 0 && de("m5").length === 0, JSON.stringify([de("m4"), de("m5")]));
  const sb = makeSandbox({ db: VACIO() }).sb, g = (t) => sb.regCxGrupo(t);
  check("C4e grupos nuevos (NCX, URO, CT, CV, CPR, CMF) sin mover los que ya tenían grupo",
    g("NEFRECTOMÍA RADICAL LAPAROSCÓPICA") === "Urología" && g("RTUP") === "Urología" && g("LAMINECTOMIA L4-L5") === "Neurocirugía (columna)" && g("COLOCACION DE DVP") === "Neurocirugía (cráneo)"
    && g("CAMBIO VALVULAR AORTICO") === "Cirugía cardiovascular" && g("LOBECTOMIA POR VATS") === "Cirugía de tórax" && g("PLEURODESIS") === "Cirugía de tórax" && g("TOMA Y APLICACION DE INJERTO") === "Cirugía plástica y reconstructiva"
    && g("REDUCCION ABIERTA DE FRACTURA DE MANDIBULA") === "Cirugía maxilofacial" && g("COLECISTECTOMIA LAPAROSCOPICA") === "Colecistectomía" && g("DRENAJE DE HEMATOMA SUBDURAL") === "Drenaje de absceso / colección"
    && g("LAPAROSCOPIA DIAGNOSTICA") === "Laparoscopia" && g("CURACION") === "",
    JSON.stringify(["NEFRECTOMÍA RADICAL LAPAROSCÓPICA", "RTUP", "LAMINECTOMIA L4-L5", "COLOCACION DE DVP", "CAMBIO VALVULAR AORTICO", "LOBECTOMIA POR VATS", "TOMA Y APLICACION DE INJERTO", "REDUCCION ABIERTA DE FRACTURA DE MANDIBULA", "DRENAJE DE HEMATOMA SUBDURAL"].map(g)));
  const rm = sb.regResumenMensual([{ ingreso: "2026-03-10", egreso: "", excluir: 0 }], [{ f: "", fEstimada: "2026-03-10", ep: "E-1" }, { f: "2026-04-02", fEstimada: "", ep: "E-1" }, { f: "", fEstimada: "", ep: "E-2" }], []);
  check("C4f regResumenMensual: sin fecha → mes estimado y contada aparte; con fecha → su mes y 0; sin fecha ni ingreso ni egreso no se cuenta",
    rm.length === 2 && rm[0]["Mes"] === "2026-03" && rm[0]["Cirugías (n)"] === 1 && rm[0]["Cirugías sin fecha exacta (n)"] === 1 && rm[1]["Mes"] === "2026-04" && rm[1]["Cirugías (n)"] === 1 && rm[1]["Cirugías sin fecha exacta (n)"] === 0, JSON.stringify(rm));
  const tA = JSON.stringify(AN.concat(["Resumen mensual"]).map((n) => st.ss.sheets[n].cells));
  check("C4g las pestañas de análisis siguen sin nombres ni expedientes", !/FICTICIA|00084\d/.test(tA), (tA.match(/FICTICIA|00084\d/) || [])[0]);
}

// ─── C5: el motivo elegido en una copia de rescate sin id llega al episodio ──────────────────────────────────────
{
  const ETQ = "CAMBIOS DE ESTE iPad SIN SUBIR (el paciente ya no estaba en el censo)";
  const resc = (id, pd, nd, por) => ({ id, archived_at: "2026-11-02T12:00:00+00:00", archived_by: por || "", patient_data: pd, note_data: Object.assign({ _egreso: ETQ, _egresoFecha: "01/11/2026" }, nd) });
  const d = VACIO();
  d.archive = [
    egresado("g1", "s1", "PRUEBA FICTICIA CINCO UNO", "000851", "2026-10-25", "2026-11-01", {}, {}, { archived_by: "R4 FICTICIO" }),
    resc("g2", { nombre: "PRUEBA FICTICIA CINCO UNO", exp: "000851" }, { _egreso_tipo: "defuncion", _egreso_tipo_por: "DRA. FICTICIA", _egreso_tipo_ts: "2026-11-02T10:00:00Z" }, "IPAD FICTICIO"),
    // Ya tenía un motivo elegido por una persona: el de la copia de rescate no lo tapa.
    egresado("g3", "s2", "PRUEBA FICTICIA CINCO DOS", "000852", "2026-10-20", "2026-11-01", {}, { _egreso_tipo: "alta", _egreso_tipo_por: "R1 FICTICIO", _egreso_tipo_ts: "2026-11-01T18:30:00Z" }),
    resc("g4", { nombre: "PRUEBA FICTICIA CINCO DOS", exp: "000852" }, { _egreso_tipo: "defuncion", _egreso_tipo_por: "OTRA FICTICIA", _egreso_tipo_ts: "2026-11-02T11:00:00Z" }),
    // Sin episodio en la base: con motivo elegido deja de ser «duplicado»; sin él sigue como antes.
    resc("g5", { nombre: "PRUEBA FICTICIA CINCO TRES", exp: "000853", ingreso: "2026-10-28" }, { _egreso_tipo: "alta", _egreso_tipo_por: "R2 FICTICIO", _egreso_tipo_ts: "2026-11-02T12:00:00Z" }),
    resc("g6", { nombre: "PRUEBA FICTICIA CINCO CUATRO", exp: "000854", ingreso: "2026-10-28" }, {}),
    // Un tipo que la app no conoce no se toma.
    egresado("g7", "s5", "PRUEBA FICTICIA CINCO CINCO", "000855", "2026-10-22", "2026-11-01"),
    resc("g8", { nombre: "PRUEBA FICTICIA CINCO CINCO", exp: "000855" }, { _egreso_tipo: "inventado", _egreso_tipo_por: "X FICTICIO" })
  ];
  const st = { db: d, hoy: "2026-11-03" }; makeSandbox(st).sb.actualizarRegistro();
  const P = porId(st.ss, "Pacientes"), E = episodiosDe(st.ss);
  check("C5a episodio archivado sin motivo + copia de rescate sin id con _egreso_tipo «defuncion»: Pacientes «Defunción (registrado en la app)» y Episodios Defunción = 1",
    P.s1 && P.s1["Motivo de egreso"] === "Defunción (registrado en la app)" && !P["archivo-g2"] && E("s1")["Defunción"] === 1 && E("s1")["Tipo de egreso"] === "Defunción" && E("s1")["Egreso observado"] === 1,
    JSON.stringify([P.s1 && P.s1["Motivo de egreso"], E("s1")["Defunción"]]));
  check("C5b un motivo que ya había elegido una persona no lo tapa la copia de rescate; un tipo desconocido no se toma",
    P.s2["Motivo de egreso"] === "Alta a domicilio (registrado en la app)" && P.s2["Motivo de egreso registrado por"] === "R1 FICTICIO" && E("s2")["Defunción"] === 0
    && P.s5["Motivo de egreso"] === "RETIRADO DEL CENSO (hoja)" && P.s5["Motivo de egreso registrado por"] === "", JSON.stringify([P.s2["Motivo de egreso"], P.s5["Motivo de egreso"]]));
  check("C5c rescate sin episodio en la base: con motivo elegido es un egreso real (Alta, no duplicado); sin motivo sigue «Duplicado»",
    P["archivo-g5"] && P["archivo-g5"]["Motivo de egreso"] === "Alta a domicilio (registrado en la app)" && E("archivo-g5")["Tipo de egreso"] === "Alta" && E("archivo-g5")["Excluir (duplicado)"] === 0
    && E("archivo-g6")["Tipo de egreso"] === "Duplicado (no es otro episodio)" && E("archivo-g6")["Excluir (duplicado)"] === 1,
    JSON.stringify([P["archivo-g5"] && P["archivo-g5"]["Motivo de egreso"], E("archivo-g5")["Tipo de egreso"], E("archivo-g6")["Tipo de egreso"]]));
  check("C5d quién registró ese motivo y cuándo llegan con él; «Egresado por» sigue siendo quien archivó el egreso real (no el iPad)",
    P.s1["Motivo de egreso registrado por"] === "DRA. FICTICIA" && P.s1["Motivo registrado el"] === "2026-11-02T10:00:00Z" && P.s1["Egresado por"] === "R4 FICTICIO"
    && P["archivo-g5"]["Motivo de egreso registrado por"] === "R2 FICTICIO", JSON.stringify([P.s1["Motivo de egreso registrado por"], P.s1["Motivo registrado el"], P.s1["Egresado por"]]));
}

// ─── C6: reintervención planeada / no planeada, estancia posoperatoria, cirugía temprana y defunción posoperatoria ──
{
  const d = VACIO();
  const pt = (id, n) => ({ id, cama: "3-9" + n, nombre: "PRUEBA FICTICIA SEIS " + id.toUpperCase(), exp: "00086" + n, dx: "ABDOMEN AGUDO", edad: "45", ingreso: "2026-10-20", estado: "ESTABLE" });
  const cx = (id, fecha, procedimiento) => ({ id, fecha, procedimiento, tipo: "urgencia", abordaje: "abierta", clavien: "0" });
  d.patients = [pt("n1", 1), pt("n2", 2), pt("n3", 3), pt("n4", 4), pt("n8", 8), pt("n9", 9)];
  d.notes = [
    { patient_id: "n1", checklist: { sexo: "F", cirugias: [cx("a", "2026-10-21", "LAPE"), cx("b", "2026-10-23", "CIERRE DE PARED")] } },
    { patient_id: "n2", checklist: { sexo: "F", cirugias: [cx("a", "2026-10-21", "LAPE"), cx("b", "2026-10-25", "RELAPAROTOMIA")] } },
    { patient_id: "n3", checklist: { sexo: "F", cirugias: [cx("a", "2026-10-23", "APENDICECTOMIA")] } },
    { patient_id: "n4", checklist: { sexo: "F" } },
    { patient_id: "n8", checklist: { sexo: "F", cirugias: [cx("a", "2026-10-21", "LAPE"), cx("b", "", "LAVADO QUIRURGICO")] } },             // sin fecha, estancia corta: ≤30 días seguro
    { patient_id: "n9", checklist: { sexo: "F", cirugias: [cx("a", "2026-10-22", "RELAPAROTOMIA")] } }                                   // la índice no se capturó
  ];
  d.archive = [
    // Sin fecha y la estancia desde la índice pasa de 30 días: no se adivina.
    egresado("an5", "n5", "PRUEBA FICTICIA SEIS N5", "000865", "2026-09-01", "2026-10-20", {}, { checklist: { cirugias: [cx("a", "2026-09-02", "LAPE"), cx("b", "", "LAVADO QUIRURGICO")] } }),
    egresado("an6", "n6", "PRUEBA FICTICIA SEIS N6", "000866", "2026-10-01", "2026-10-08", {}, { _egreso_tipo: "defuncion", _egreso_tipo_ts: "2026-10-08T18:00:00Z", checklist: { cirugias: [cx("a", "2026-10-02", "LAPE")] } }),
    egresado("an7", "n7", "PRUEBA FICTICIA SEIS N7", "000867", "2026-10-02", "2026-10-12", {}, { _egreso_tipo: "alta", _egreso_tipo_ts: "2026-10-12T18:00:00Z", checklist: { cirugias: [cx("a", "2026-10-03", "LAPE"), cx("b", "2026-10-06", "RE LAPE + LAVADO")] } }),
    // Reintervención a los 40 días de la índice: fuera de la ventana.
    egresado("an10", "n10", "PRUEBA FICTICIA SEIS N10", "000860", "2026-08-01", "2026-09-20", {}, { _egreso_tipo: "alta", _egreso_tipo_ts: "2026-09-20T18:00:00Z", checklist: { cirugias: [cx("a", "2026-08-02", "LAPE"), cx("b", "2026-09-11", "COLOSTOMIA")] } })
  ];
  const st = { db: d, hoy: "2026-10-28" }; makeSandbox(st).sb.actualizarRegistro();
  const E = episodiosDe(st.ss), PL = "Reintervención planeada (probable)", NP = "Reintervención no planeada (probable)";
  const par = (id) => [E(id)[PL], E(id)[NP], E(id)["Reintervención"]];
  check("C6a LAPE día 1 + «CIERRE DE PARED» día 3: planeada = 1, no planeada = 0 (la columna vieja «Reintervención» sigue en 1: 2.ª cirugía de cualquier tipo)",
    JSON.stringify(par("n1")) === "[1,0,1]", JSON.stringify(par("n1")));
  check("C6b LAPE + «RELAPAROTOMIA» día 5: no planeada = 1 y planeada = 0", JSON.stringify(par("n2")) === "[0,1,1]", JSON.stringify(par("n2")));
  check("C6c una sola cirugía: las dos en 0; sin cirugías: las dos vacías", JSON.stringify(par("n3")) === "[0,0,0]" && JSON.stringify(par("n4")) === '["","",""]', JSON.stringify([par("n3"), par("n4")]));
  check("C6d 2.ª cirugía sin fecha: cuenta si todo lo que siguió a la índice duró ≤30 días; si no, queda vacía y dicha en Calidad de datos; a los 40 días no cuenta",
    JSON.stringify(par("n8")) === "[0,1,1]" && E("n5")[NP] === "" && E("n5")[PL] === 0 && /reintervención sin fecha/.test(E("n5")["Calidad de datos"]) && JSON.stringify(par("n10")) === "[0,0,1]",
    JSON.stringify([par("n8"), par("n5"), par("n10")]));
  check("C6e una relaparotomía como única cirugía registrada es no planeada (la índice no se capturó)", JSON.stringify(par("n9")) === "[0,1,1]", JSON.stringify(par("n9")));
  check("C6f estancia posoperatoria (primera cirugía → egreso o hoy), cirugía en ≤1 día del ingreso (1/0/vacío) y defunción posoperatoria (solo operados)",
    E("n6")["Estancia posoperatoria (días)"] === 6 && E("n3")["Estancia posoperatoria (días)"] === 5 && E("n4")["Estancia posoperatoria (días)"] === ""
    && E("n1")["Cirugía en ≤1 día del ingreso"] === 1 && E("n3")["Cirugía en ≤1 día del ingreso"] === 0 && E("n4")["Cirugía en ≤1 día del ingreso"] === ""
    && E("n6")["Defunción posoperatoria (hospitalaria)"] === 1 && E("n7")["Defunción posoperatoria (hospitalaria)"] === 0 && E("n1")["Defunción posoperatoria (hospitalaria)"] === "" && E("n4")["Defunción posoperatoria (hospitalaria)"] === "",
    JSON.stringify(["n6", "n3", "n4", "n1", "n7"].map((id) => [E(id)["Estancia posoperatoria (días)"], E(id)["Cirugía en ≤1 día del ingreso"], E(id)["Defunción posoperatoria (hospitalaria)"]])));
  const R = Object.fromEntries(tab(st.ss, "Resumen mensual").map((x) => [x["Mes"], x]));
  check("C6g Resumen mensual: «Reintervenciones no planeadas (n)» por mes de egreso (octubre 1: n7; septiembre 0 aunque «Reintervenciones (n)» sea 1)",
    R["2026-10"]["Reintervenciones no planeadas (n)"] === 1 && R["2026-10"]["Reintervenciones (n)"] === 2 && R["2026-09"]["Reintervenciones no planeadas (n)"] === 0 && R["2026-09"]["Reintervenciones (n)"] === 1,
    JSON.stringify([R["2026-10"], R["2026-09"]]));
  const sh = st.ss.sheets[AN[0]], col = (n) => sh.cells[0].indexOf(n);
  check("C6h las columnas nuevas van al final de «Análisis · Episodios» (después de «Vigente») y los 0/1 se guardan como número",
    col("Unión (fuente)") === col("Vigente") + 1 && col("Defunción posoperatoria (hospitalaria)") === col("Vigente") + 7 && typeof E("n2")[NP] === "number" && sh.fmt["2:" + (col(NP) + 1)] === "0" && sh.fmt["2:" + (col("Unión (fuente)") + 1)] === "@",
    JSON.stringify(sh.cells[0].slice(col("Vigente"))));
}

// ─── C7: «Por completar» (sin talla, egreso sin motivo sin límite y primero), atb_fecha_inicio y nota del lactato ──
{
  const d = VACIO();
  const pt = (id, n, extra) => Object.assign({ id, cama: "3-7" + n, nombre: "PRUEBA FICTICIA SIETE " + id.toUpperCase(), exp: "00087" + n, dx: "APENDICITIS AGUDA", edad: "40", ingreso: "2026-10-25", estado: "ESTABLE" }, extra);
  d.patients = [pt("t1", 1), pt("t2", 2), pt("t3", 3)];
  d.notes = [
    { patient_id: "t1", app: "NIEGA CRONICODEGENERATIVOS", checklist: { sexo: "F", pm_peso: "60" } },                                   // solo le falta la talla
    { patient_id: "t2", app: "", checklist: { sexo: "M", pm_peso: "70", pm_talla: "170" } },                                              // le falta el APP
    { patient_id: "t3", app: "HAS", checklist: { sexo: "M", pm_peso: "70", pm_talla: "170", atb: true, atb_nombre: "ERTAPENEM", atb_dias: "4", atb_fecha_inicio: "2026-10-26", npo: true, npo_fecha_inicio: "27/10/2026" } }
  ];
  d.archive = [
    egresado("at4", "t4", "PRUEBA FICTICIA SIETE T4", "000874", "2026-08-20", "2026-08-31", { dx: "COLECISTITIS" }),                       // egresó hace 60 días sin motivo
    egresado("at5", "t5", "PRUEBA FICTICIA SIETE T5", "000875", "2026-09-20", "2026-09-28", { dx: "COLECISTITIS" }),                       // hace 32 días sin motivo
    egresado("at6", "t6", "PRUEBA FICTICIA SIETE T6", "000876", "2026-08-20", "2026-08-31", { dx: "COLECISTITIS" }, { _egreso_tipo: "alta", _egreso_tipo_ts: "2026-08-31T18:00:00Z" })   // hace 60 días CON motivo
  ];
  const st = { db: d, hoy: "2026-10-30" }; makeSandbox(st).sb.actualizarRegistro();
  const filas = tab(st.ss, "Por completar"), PC = Object.fromEntries(filas.map((x) => [x["ID episodio"], x])), P = porId(st.ss, "Pacientes");
  check("C7a el egresado de hace 60 días sin motivo aparece; con motivo (y más de 30 días) no; al que solo le falta la talla no aparece y nadie tiene «talla» en su lista",
    PC.t4 && /^motivo del egreso/.test(PC.t4["Falta"]) && PC.t5 && !PC.t6 && !PC.t1 && PC.t2 && PC.t2["Falta"] === "APP" && !filas.some((x) => /talla/.test(x["Falta"])),
    JSON.stringify(filas.map((x) => x["ID episodio"] + ": " + x["Falta"])));
  check("C7b los egresos sin motivo van primero (el más reciente arriba) y después los demás",
    JSON.stringify(filas.map((x) => x["ID episodio"])) === JSON.stringify(["t5", "t4", "t2"]), JSON.stringify(filas.map((x) => x["ID episodio"])));
  const R = Object.fromEntries(tab(st.ss, "Resumen mensual").map((x) => [x["Mes"], x]));
  check("C7c la talla se reporta solo como cobertura: «Ingresos sin talla (n)» del mes (octubre: 1 de 3) y ya no cuenta en «Ingresos con datos incompletos (n)»",
    R["2026-10"]["Ingresos sin talla (n)"] === 1 && R["2026-10"]["Ingresos (n)"] === 3 && R["2026-10"]["Ingresos con datos incompletos (n)"] === 1 && R["2026-08"]["Ingresos sin talla (n)"] === 2, JSON.stringify([R["2026-10"], R["2026-08"]]));
  check("C7d respaldo «…_fecha_inicio» cuando no viene «…_inicio»: antibiótico y ayuno «desde AAAA-MM-DD»",
    P.t3["Antibiótico"] === "ERTAPENEM, desde 2026-10-26" && P.t3["Dieta y NPO"] === "NPO desde 2026-10-27", JSON.stringify([P.t3["Antibiótico"], P.t3["Dieta y NPO"]]));
  const vars = makeSandbox({ db: VACIO() }).sb.regVariables_();
  const lac = vars.find((v) => v[1] === "Lactato máximo (mmol/L)"), hb = vars.find((v) => v[1] === "Hb mínima (g/dL)");
  check("C7e el Diccionario de variables dice que «Lactato máximo» está vacío porque ninguna captura trae la clave (y no lo dice de los demás)",
    lac && /VACÍA/.test(lac[4]) && /clave «lac»/.test(lac[4]) && hb && !/VACÍA/.test(hb[4]), lac && lac[4]);
}

// ─── C10: Pacientes: quién egresó, quién registró el motivo, quién modificó, nota restaurada y alias de WinLab ──────
{
  // Columnas REALES de la base (confirmadas el 24 nov 2026): si el script pidiera una que no existe, el simulador responde 42703.
  const COLS = {
    patients: ["id", "cama", "nombre", "exp", "dx", "edad", "esp", "adscrito", "residente", "ingreso", "estado", "created_at", "updated_at", "created_by", "updated_by", "seccion", "dias", "es_mio", "cama_app_ts", "cama_hoja_prev", "hoja_azul"],
    notes: ["patient_id", "app", "pa", "drenajes", "qx", "manejo", "sangrado", "sv", "balance", "pendientes", "checklist", "updated_at", "updated_by", "lab_history", "imagen_history", "misc", "cronologia", "restaurada_en"],
    archive: ["id", "patient_data", "note_data", "archived_at", "archived_by"]
  };
  const NUEVAS = ["Egresado por", "Motivo de egreso registrado por", "Motivo registrado el", "Última modificación por", "Nota restaurada el", "Alias WinLab"];
  const d = VACIO();
  d.archive = [egresado("ak0", "k0", "PRUEBA FICTICIA DIEZ VIEJA", "000890", "2026-10-01", "2026-10-09", { dx: "HERNIA" }, { pendientes: "DE LA VERSIÓN ANTERIOR" }, { archived_by: "R9 FICTICIO" })];
  // 1) Una corrida de la versión anterior (sin las 6 columnas) deja la hoja como está hoy en producción.
  const st = { db: d, hoy: "2026-10-10", columnas: COLS };
  const vieja = makeSandbox(st); vieja.sb.REG_PESTANAS[0].columnas.splice(-6, 6); vieja.sb.actualizarRegistro();
  const encAntes = st.ss.sheets["Pacientes"].cells[0].slice();
  // 2) Versión nueva: k0 ya no está en la base; hay un hospitalizado y dos egresos.
  d.patients = [
    { id: "k1", cama: "3-801", nombre: "PRUEBA FICTICIA DIEZ UNO", exp: "000891", dx: "COLECISTITIS", edad: "50", ingreso: "2026-11-10", estado: "ESTABLE", updated_at: "2026-11-12T09:00:00+00:00", updated_by: "censo-hoja-ficticio" },
    { id: "k2", cama: "3-802", nombre: "PRUEBA FICTICIA DIEZ DOS", exp: "000892", dx: "HERNIA", edad: "51", ingreso: "2026-11-11", estado: "ESTABLE", updated_by: "censo-hoja-ficticio" }
  ];
  d.notes = [{ patient_id: "k1", updated_at: "2026-11-12T10:00:00+00:00", updated_by: "R2 FICTICIO", restaurada_en: "2026-11-11T08:00:00+00:00", checklist: { sexo: "F", winlab_alias: "FICTICIA DIEZ, UNO ALIAS" } },
    { patient_id: "k2", checklist: { sexo: "M" } }];
  d.archive = [
    egresado("ak3", "k3", "PRUEBA FICTICIA DIEZ TRES", "000893", "2026-11-01", "2026-11-08", {}, { _egreso_tipo: "traslado", _egreso_tipo_por: "DR. FICTICIO DIEZ", _egreso_tipo_ts: "2026-11-09T15:00:00Z", updated_by: "R5 FICTICIO" }, { archived_by: "R3 FICTICIO" }),
    // Dos copias: el egreso real (alta médica) y una copia técnica posterior de otra cuenta: manda quien archivó el egreso real.
    egresado("ak4", "k4", "PRUEBA FICTICIA DIEZ CUATRO", "000894", "2026-11-01", "2026-11-05", {}, { _egreso: "alta médica", _egresoFecha: "05/11/2026" }, { archived_by: "R6 FICTICIO" }),
    egresado("ak5", "k4", "PRUEBA FICTICIA DIEZ CUATRO", "000894", "2026-11-01", "2026-11-07", {}, { _egreso: "CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)" }, { archived_by: "IPAD FICTICIO" })
  ];
  st.hoy = "2026-11-12"; st.reloj = undefined;
  const nueva = makeSandbox(st); const r = nueva.sb.actualizarRegistro();
  const P = porId(st.ss, "Pacientes"), enc = st.ss.sheets["Pacientes"].cells[0];
  check("C10a con las columnas reales de patients, notes y archive la corrida es completa (ningún 42703) y los selects piden updated_by, restaurada_en y archived_by",
    r.ok && !r.avisos.some((a) => /42703|No se pudo leer/.test(a)) && nueva.calls.some((c) => /\/patients\?select=[^&]*,updated_by&/.test(c.u)) && nueva.calls.some((c) => /\/notes\?select=[^&]*,updated_by,restaurada_en&/.test(c.u))
    && nueva.calls.filter((c) => /\/archive\?select=id,patient_data,note_data,archived_at/.test(c.u)).every((c) => /archived_at,archived_by&/.test(c.u)), JSON.stringify(r.avisos));
  check("C10b egreso con motivo elegido: quién archivó, quién registró el motivo y cuándo",
    P.k3["Egresado por"] === "R3 FICTICIO" && P.k3["Motivo de egreso registrado por"] === "DR. FICTICIO DIEZ" && P.k3["Motivo registrado el"] === "2026-11-09T15:00:00Z" && P.k3["Última modificación por"] === "R5 FICTICIO",
    JSON.stringify(NUEVAS.map((c) => P.k3[c])));
  check("C10c hospitalizado: última modificación por la nota (o, sin ella, por el censo), nota restaurada y alias de WinLab; sin datos de egreso",
    P.k1["Última modificación por"] === "R2 FICTICIO" && P.k1["Nota restaurada el"] === "2026-11-11T08:00:00+00:00" && P.k1["Alias WinLab"] === "FICTICIA DIEZ, UNO ALIAS" && P.k1["Egresado por"] === "" && P.k1["Motivo de egreso registrado por"] === ""
    && P.k2["Última modificación por"] === "censo-hoja-ficticio" && P.k2["Nota restaurada el"] === "" && P.k2["Alias WinLab"] === "", JSON.stringify([NUEVAS.map((c) => P.k1[c]), NUEVAS.map((c) => P.k2[c])]));
  check("C10d una copia técnica posterior no cambia «Egresado por» (va con el motivo que queda) y sin motivo elegido no hay «registrado por»",
    P.k4["Motivo de egreso"] === "alta médica" && P.k4["Egresado por"] === "R6 FICTICIO" && P.k4["Motivo de egreso registrado por"] === "" && P.k4["Motivo registrado el"] === "", JSON.stringify(NUEVAS.map((c) => P.k4[c])));
  check("C10e la fila vieja (episodio que ya no está en la base) se conserva con sus datos y gana las 6 columnas al final, vacías; el orden anterior no cambia y se avisa",
    encAntes.length === 50 && !NUEVAS.some((c) => encAntes.includes(c)) && JSON.stringify(enc.slice(0, 50)) === JSON.stringify(encAntes) && JSON.stringify(enc.slice(50)) === JSON.stringify(NUEVAS)
    && P.k0 && P.k0["Pendientes"] === "DE LA VERSIÓN ANTERIOR" && P.k0["Estado en registro"] === "Egresado" && NUEVAS.every((c) => P.k0[c] === "") && r.avisos.some((a) => /«Pacientes» no tenía.*«Egresado por»/.test(a)),
    JSON.stringify([enc.slice(48), r.avisos]));
  const vars = nueva.sb.regVariables_();
  check("C10f las columnas nuevas de Pacientes y Cirugías están en el Diccionario de variables y no llegan a ninguna pestaña de análisis",
    NUEVAS.concat(["ID cirugía", "Fotos (n)", "Foto subida por", "Foto subida el"]).every((c) => vars.some((v) => (v[0] === "Pacientes" || v[0] === "Cirugías") && v[1].split(" · ").includes(c)))
    && !/FICTICI/.test(JSON.stringify(AN.concat(["Resumen mensual"]).map((n) => st.ss.sheets[n].cells))));
  check("C10g el registro de ejecución sigue con solo conteos", nueva.logs.length > 0 && !/FICTICI|00089\d/.test(nueva.logs.join("\n")), nueva.logs.join(" | "));
  // Si la base NO tuviera una de esas columnas la corrida se detendría (no van en opcional): por eso se confirmaron antes.
  const sinCol = { db: d, hoy: "2026-11-12", columnas: Object.assign({}, COLS, { archive: ["id", "patient_data", "note_data", "archived_at"] }) };
  let e1 = ""; try { makeSandbox(sinCol).sb.actualizarRegistro(); } catch (e) { e1 = e.message; }
  check("C10h (por qué se confirmó el esquema) sin archived_by en la base la corrida falla con 42703 y no escribe Pacientes", /42703/.test(e1) && !(sinCol.ss.sheets["Pacientes"]), e1);
}

// ─── C11: Cirugías: ID de la cirugía y fotos (conteo, autor y fecha; nunca la imagen ni su ruta) ───────────────────
{
  const d = VACIO();
  const fotos = [{ id: "f1", by: "R2 FICTICIO", ts: "2026-10-22T10:00:00.000Z", path: "RUTA-SECRETA/f1.jpg" }, { id: "f2", by: "R3 FICTICIO", ts: "2026-10-23T09:00:00.000Z", b64: "data:image/jpeg;base64,IMAGENSECRETA", pending: true }, null];
  d.patients = [{ id: "j1", cama: "3-811", nombre: "PRUEBA FICTICIA ONCE UNO", exp: "000911", dx: "OCLUSION. PO LAPE", edad: "50", ingreso: "2026-10-20", estado: "ESTABLE" },
    { id: "j3", cama: "3-813", nombre: "PRUEBA FICTICIA ONCE TRES", exp: "000913", dx: "PERITONITIS", edad: "50", ingreso: "2026-10-18", estado: "ESTABLE" }];
  d.notes = [{ patient_id: "j1", checklist: { sexo: "F", cirugias: [{ id: "cx-a1", fecha: "2026-10-21", procedimiento: "LAPE", fotos }, { id: "cx-a2", fecha: "2026-10-24", procedimiento: "COLOSTOMIA" }] } },
    // Restaurada (j2 → j3): la copia vieja trae la cirugía con el texto de antes; la tarjeta actual, el mismo id con el texto corregido.
    { patient_id: "j3", checklist: { sexo: "M", cirugias: [{ id: "cx-r", fecha: "2026-10-19", procedimiento: "LAPE + RESECCION INTESTINAL" }] } }];
  d.archive = [egresado("aj2", "j2", "PRUEBA FICTICIA ONCE TRES", "000913", "2026-10-18", "2026-10-20", {}, { _restaurado_a: "j3", checklist: { cirugias: [{ id: "cx-r", fecha: "2026-10-19", procedimiento: "LAPE" }] } })];
  const st = { db: d, hoy: "2026-10-25" }; makeSandbox(st).sb.actualizarRegistro();
  let C = tab(st.ss, "Cirugías"); const a1 = C.find((x) => x["Procedimiento"] === "LAPE" && x["ID episodio"] === "j1") || {}, a2 = C.find((x) => x["Procedimiento"] === "COLOSTOMIA") || {};
  check("C11a cirugía con id y 2 fotos: «ID cirugía», «Fotos (n)» = 2 y quién y cuándo subió la última; sin fotos = 0",
    a1["ID cirugía"] === "cx-a1" && a1["Fotos (n)"] === 2 && a1["Foto subida por"] === "R3 FICTICIO" && a1["Foto subida el"] === "2026-10-23T09:00:00.000Z" && a2["ID cirugía"] === "cx-a2" && a2["Fotos (n)"] === 0 && a2["Foto subida por"] === "",
    JSON.stringify([a1, a2]));
  const todo = JSON.stringify(Object.values(st.ss.sheets).map((h) => h.cells));
  check("C11b ni la imagen ni su ruta llegan a ninguna pestaña", !/RUTA-SECRETA|IMAGENSECRETA/.test(todo));
  const enc = st.ss.sheets["Cirugías"].cells[0];
  check("C11c las 4 columnas van al final de «Cirugías» y la clave de la pestaña no cambió",
    JSON.stringify(enc.slice(-4)) === JSON.stringify(["ID cirugía", "Fotos (n)", "Foto subida por", "Foto subida el"]) && enc.indexOf("Complicación") === enc.length - 5
    && JSON.stringify(makeSandbox({ db: VACIO() }).sb.REG_PESTANAS[1].clave) === JSON.stringify(["ID episodio", "Fecha", "Procedimiento"]), JSON.stringify(enc));
  const E0 = episodiosDe(st.ss);
  check("C11d restaurada con el texto corregido en la tarjeta nueva (mismo id de cirugía en las dos partes): UNA cirugía, la del texto corregido",
    E0("j3")["Partes del registro"] === 2 && E0("j3")["Cirugías (n)"] === 1 && /RESECCION/.test(E0("j3")["Procedimientos"]), JSON.stringify([E0("j3")["Cirugías (n)"], E0("j3")["Procedimientos"]]));
  // Al día siguiente corrigen el procedimiento de cx-a1 (el DX ya no dice «PO LAPE»: la cirugía sigue siendo una).
  d.notes[0].checklist.cirugias[0].procedimiento = "LAPE + ADHERENCIOLISIS";
  st.hoy = "2026-10-26"; makeSandbox(st).sb.actualizarRegistro();
  C = tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] === "j1" && x["ID cirugía"] === "cx-a1");
  const E = episodiosDe(st.ss);
  check("C11e procedimiento corregido al día siguiente: 2 filas con el mismo «ID cirugía» (una Vigente: No) y «Cirugías (n)» del episodio sigue en 2 (no 3)",
    C.length === 2 && C.filter((x) => x["Vigente"] === "No").length === 1 && C.find((x) => x["Vigente"] === "Sí")["Procedimiento"] === "LAPE + ADHERENCIOLISIS" && E("j1")["Cirugías (n)"] === 2,
    JSON.stringify([C.map((x) => x["Procedimiento"] + ":" + x["Vigente"]), E("j1")["Cirugías (n)"]]));
  // regAnalisis directo: filas viejas sin id (escritas antes de esta versión) y el orden de las filas en la hoja.
  const sb = makeSandbox({ db: VACIO() }).sb, cod = (pre, ident) => pre + "-" + ident;
  const Pac = [{ "ID episodio": "a", "Estado en registro": "Egresado", "Motivo de egreso": "RETIRADO DEL CENSO (hoja)", "Episodio relacionado": "Continúa en b", "Expediente": "000919", "Nombre": "PRUEBA FICTICIA ONCE NUEVE", "Fecha de ingreso": "2026-10-20", "Fecha de egreso": "2026-10-22" },
    { "ID episodio": "b", "Estado en registro": "Hospitalizado", "Expediente": "000919", "Nombre": "PRUEBA FICTICIA ONCE NUEVE", "Fecha de ingreso": "2026-10-20" }];
  const fx = (ep, id, proc, vig) => ({ "ID episodio": ep, "ID cirugía": id, "Fecha": "2026-10-21", "Procedimiento": proc, "Fuente": "Caja Cirugías", "Vigente": vig });
  const n = (cxs) => sb.regAnalisis({ "Pacientes": Pac, "Cirugías": cxs }, [], [], "2026-10-28", cod)[AN[0]][0];
  const viejaSinId = n([fx("a", "", "LAPE", "Sí"), fx("b", "cx1", "LAPE", "No"), fx("b", "cx1", "LAPE CORREGIDA", "Sí")]);
  const alReves = n([fx("a", "", "LAPE", "Sí"), fx("b", "cx1", "LAPE CORREGIDA", "Sí"), fx("b", "cx1", "LAPE", "No")]);
  const borrada = n([fx("a", "cx1", "LAPE", "Sí"), fx("b", "cx1", "LAPE", "No")]);
  const dos = n([fx("b", "cx1", "LAPE", "Sí"), fx("b", "cx2", "COLOSTOMIA", "Sí")]);
  check("C11f fila vieja sin id + la misma cirugía con id y texto corregido = 1 (en cualquier orden de la hoja); borrada en la parte nueva = 0; dos ids distintos = 2",
    viejaSinId["Cirugías (n)"] === 1 && viejaSinId["Procedimientos"] === "2026-10-21 LAPE CORREGIDA" && alReves["Cirugías (n)"] === 1 && alReves["Procedimientos"] === "2026-10-21 LAPE CORREGIDA" && borrada["Cirugías (n)"] === 0 && dos["Cirugías (n)"] === 2,
    JSON.stringify([viejaSinId["Procedimientos"], alReves["Procedimientos"], borrada["Cirugías (n)"], dos["Cirugías (n)"]]));
}

// ─── C16: episodios partidos (la misma hospitalización con varios id, sin restauración) ────────────────────────────
{
  const d = VACIO();
  const pt = (id, nombre, exp, ingreso) => ({ id, cama: "3-9" + id.slice(-2), nombre, exp, dx: "COLECISTITIS", edad: "50", ingreso, estado: "ESTABLE" });
  d.patients = [
    pt("u2", "PRUEBA FICTICIA PARTIDA", "000921", "2026-10-05"),          // mismo ingreso que u1
    pt("v2", "OTRA PERSONA DISTINTA", "000922", "2026-10-05"),            // mismo expediente e ingreso, nombre incompatible
    pt("w2", "PRUEBA FICTICIA CERRADA", "000923", "2026-10-05"),          // el anterior cerró con defunción registrada
    pt("x2", "PRUEBA FICTICIA CONTIGUA", "000924", "2026-10-11"),         // ingresa 1 día después de un egreso sin motivo
    pt("y2", "PRUEBA FICTICIA ALTA REAL", "000925", "2026-10-11"),        // 1 día después de un egreso que SÍ dice alta
    pt("z2", "PRUEBA FICTICIA LEJANA", "000926", "2026-10-13"),           // 3 días después
    pt("q2", "PRUEBA FICTICIA NO FUE", "000927", "2026-10-11")            // el egreso anterior «no fue egreso»
  ];
  d.notes = d.patients.map((p) => ({ patient_id: p.id, checklist: { sexo: "F" } }));
  d.archive = [
    egresado("au1", "u1", "PRUEBA FICTICIA PARTIDA", "000921", "2026-10-05", "2026-10-09"),
    egresado("av1", "v1", "PRUEBA FICTICIA VECINA", "000922", "2026-10-05", "2026-10-09"),
    egresado("aw1", "w1", "PRUEBA FICTICIA CERRADA", "000923", "2026-10-05", "2026-10-09", {}, { _egreso_tipo: "defuncion", _egreso_tipo_ts: "2026-10-09T18:00:00Z" }),
    egresado("ax1", "x1", "PRUEBA FICTICIA CONTIGUA", "000924", "2026-10-03", "2026-10-10"),
    egresado("ay1", "y1", "PRUEBA FICTICIA ALTA REAL", "000925", "2026-10-03", "2026-10-10", {}, { _egreso: "alta médica" }),
    egresado("az1", "z1", "PRUEBA FICTICIA LEJANA", "000926", "2026-10-03", "2026-10-10"),
    egresado("aq1", "q1", "PRUEBA FICTICIA NO FUE", "000927", "2026-10-03", "2026-10-10", {}, { _egreso_tipo: "no_egreso", _egreso_tipo_ts: "2026-10-10T19:00:00Z" }),
    // Tres ids de la misma hospitalización, todos egresados: mismo ingreso + contiguo.
    egresado("ao1", "o1", "PRUEBA FICTICIA TRIPLE", "000928", "2026-09-01", "2026-09-04"),
    egresado("ao2", "o2", "PRUEBA FICTICIA TRIPLE", "000928", "2026-09-01", "2026-09-08"),
    egresado("ao3", "o3", "PRUEBA FICTICIA TRIPLE", "000928", "2026-09-09", "2026-09-15", {}, { _egreso_tipo: "alta", _egreso_tipo_ts: "2026-09-15T18:00:00Z" })
  ];
  const st = { db: d, hoy: "2026-10-28" }; const r = makeSandbox(st).sb.actualizarRegistro();
  const E = episodiosDe(st.ss), todas = tab(st.ss, AN[0]).filter((x) => x["Vigente"] === "Sí");
  const K = Object.fromEntries(tab(st.ss, "Clave de seudónimos").map((x) => [x["ID episodio"], x["ID episodio (análisis)"]]));
  check("C16a dos id con el mismo expediente, nombre compatible y el mismo ingreso: UNA fila con Partes = 2, «Unión (fuente)» = Mismo ingreso, hospitalizado, y se avisa en Calidad de datos",
    r.ok && K.u1 === K.u2 && E("u1")["Partes del registro"] === 2 && E("u1")["Unión (fuente)"] === "Mismo ingreso" && E("u1")["Estado"] === "Hospitalizado" && E("u1")["Egreso observado"] === 0
    && /2 partes en el registro unidas por mismo ingreso/.test(E("u1")["Calidad de datos"]), JSON.stringify(E("u1")));
  check("C16b mismo expediente e ingreso con nombre incompatible: 2 filas (dos personas)",
    K.v1 !== K.v2 && E("v1")["Partes del registro"] === 1 && E("v2")["Partes del registro"] === 1 && E("v1")["ID paciente"] !== E("v2")["ID paciente"] && E("v1")["Unión (fuente)"] === "", JSON.stringify([E("v1"), E("v2")]));
  check("C16c el anterior cerró con «Defunción (registrado en la app)»: no se une (2 filas, la defunción se conserva) y se dice en Calidad de datos",
    K.w1 !== K.w2 && E("w1")["Defunción"] === 1 && E("w1")["Partes del registro"] === 1 && /no se unieron/.test(E("w1")["Calidad de datos"]) && /no se unieron/.test(E("w2")["Calidad de datos"]), JSON.stringify([E("w1"), E("w2")]));
  check("C16d el siguiente ingresa 1 día después de un egreso sin motivo: UNA fila «Contiguo», con el ingreso más antiguo y la estancia completa",
    K.x1 === K.x2 && E("x1")["Unión (fuente)"] === "Contiguo" && E("x1")["Partes del registro"] === 2 && E("x1")["Fecha de ingreso"] === "2026-10-03" && E("x1")["Días de estancia"] === 25, JSON.stringify(E("x1")));
  check("C16e si el egreso anterior SÍ dice el motivo (alta médica) o el siguiente entra 3 días después: no se unen y el segundo cuenta como reingreso",
    K.y1 !== K.y2 && E("y2")["Es reingreso (≤30 días)"] === 1 && E("y1")["Reingreso a 30 días"] === 1 && K.z1 !== K.z2 && E("z2")["Es reingreso (≤30 días)"] === 1, JSON.stringify([E("y1"), E("y2"), E("z2")]));
  check("C16f «no fue egreso» registrado por una persona sí deja unir al siguiente (contiguo)", K.q1 === K.q2 && E("q1")["Unión (fuente)"] === "Contiguo", JSON.stringify(E("q1")));
  check("C16g tres id egresados (mismo ingreso + contiguo): UN egreso con el motivo de la última parte; «Unión (fuente)» = Mismo ingreso + Contiguo",
    K.o1 === K.o2 && K.o2 === K.o3 && E("o1")["Partes del registro"] === 3 && E("o1")["Unión (fuente)"] === "Mismo ingreso + Contiguo" && E("o1")["Tipo de egreso"] === "Alta" && E("o1")["Fecha de egreso"] === "2026-09-15" && E("o1")["Días de estancia"] === 14,
    JSON.stringify(E("o1")));
  const R = Object.fromEntries(tab(st.ss, "Resumen mensual").map((x) => [x["Mes"], x]));
  check("C16h el Resumen mensual ya no infla: septiembre 1 ingreso y 1 egreso (antes 3 y 3); 12 episodios en total para 17 id",
    R["2026-09"]["Ingresos (n)"] === 1 && R["2026-09"]["Egresos (n)"] === 1 && todas.length === 12 && tab(st.ss, "Pacientes").length === 17, JSON.stringify([R["2026-09"], todas.length, tab(st.ss, "Pacientes").length]));
  const s1 = snap(st.ss); makeSandbox(st).sb.actualizarRegistro();
  check("C16i idempotente: otra corrida con la misma base deja todo igual (los seudónimos de las partes unidas no cambian)", snap(st.ss) === s1);
  // Restauración y «mismo ingreso» juntas, y las tarjetas duplicadas (Excluir) fuera de la unión: regAnalisis directo.
  const sb = makeSandbox({ db: VACIO() }).sb, cod = (pre, ident) => pre + "-" + ident;
  const fp = (id, estado, motivo, ingreso, egreso, rel) => ({ "ID episodio": id, "Estado en registro": estado, "Motivo de egreso": motivo, "Episodio relacionado": rel || "", "Expediente": "000929", "Nombre": "PRUEBA FICTICIA MIXTA", "Fecha de ingreso": ingreso, "Fecha de egreso": egreso });
  const an = sb.regAnalisis({ "Pacientes": [fp("r1", "Egresado", "RETIRADO DEL CENSO (hoja)", "2026-10-01", "2026-10-03", "Continúa en r2"), fp("r2", "Egresado", "RETIRADO DEL CENSO (hoja)", "2026-10-01", "2026-10-06", "Viene de r1"),
    fp("r3", "Hospitalizado", "", "2026-10-01", ""), fp("r4", "Egresado", "DUPLICADO (eliminado a mano)", "2026-10-01", "2026-10-02")] }, [], [], "2026-10-28", cod)[AN[0]];
  check("C16j restauración + mismo ingreso: una fila de 3 partes «Restauración + Mismo ingreso»; la tarjeta duplicada sigue aparte con Excluir = 1",
    an.length === 2 && an.some((x) => x["Partes del registro"] === 3 && x["Unión (fuente)"] === "Restauración + Mismo ingreso" && x["Estado"] === "Hospitalizado") && an.some((x) => x["Partes del registro"] === 1 && x["Excluir (duplicado)"] === 1 && x["Unión (fuente)"] === ""),
    JSON.stringify(an.map((x) => [x["Partes del registro"], x["Unión (fuente)"], x["Excluir (duplicado)"]])));
}

// ═══ Lote 24 nov 2026: foto diaria (8), dispositivos y drenajes (9) e historial de auditoría (14, 15) ══════════════════
const ED = "Estado diario", DI = "Dispositivos", DD = "Drenajes · diario", MV = "Movimientos y estado", SO = "Soporte y exposiciones (historial)", AC = "Actividad por episodio y día";
const NUEVAS = [ED, DI, DD, MV, SO, AC];
const SECRETOS = /FICTICI[AO] SECRET[AO]|NAVEGADOR SECRETO|secreto@|203\.0\.113|cuenta-secreta|ipad-secreto/;
const hospitalizado = (id, nombre, exp, extra, nota) => [Object.assign({ id, cama: "3-201", nombre, exp, dx: "APENDICITIS", edad: "40", esp: "CG", ingreso: "2026-10-18", estado: "ESTABLE" }, extra || {}), Object.assign({ patient_id: id }, nota || {})];
// Fila de audit_log como la guarda la base: con sus columnas privadas, que el registro NUNCA debe pedir ni escribir.
const aud = (id, ts, tabla, op, rec, user, campos, diff, cama) => ({ id, ts, tabla, op, record_id: rec, user_id: user, campos, diff, cama: cama || null,
  email: "secreto@ejemplo.test", nombre: "DRA. FICTICIA SECRETA", paciente: "PACIENTE FICTICIO SECRETO", ip: "203.0.113.9", ua: "NAVEGADOR SECRETO", dispositivo: "ipad-secreto" });
{
  // C9: regFusionar con cfg.conservarViejo (unitaria).
  const sb = makeSandbox({ db: VACIO() }).sb;
  const cfg = { nombre: "x", modo: "vigente", clave: ["ID episodio", "ID dispositivo"], conservarViejo: ["Primera vez visto"] };
  const vieja = { "ID episodio": "e", "ID dispositivo": "d", "Gasto (último)": "80", "Primera vez visto": "2026-10-01", "Última vez visto": "2026-10-05", "Vigente": "Sí", __fila: 7 };
  const hoyF = { "ID episodio": "e", "ID dispositivo": "d", "Gasto (último)": "40", "Primera vez visto": "2026-10-21", "Última vez visto": "2026-10-21", "Vigente": "Sí" };
  const f1 = sb.regFusionar([vieja], [hoyF], cfg, { e: true }, "2026-10-21", null)[0];
  const f2 = sb.regFusionar([vieja], [hoyF], Object.assign({}, cfg, { conservarViejo: undefined }), { e: true }, "2026-10-21", null)[0];
  const f3 = sb.regFusionar([Object.assign({}, vieja, { "Primera vez visto": "" })], [hoyF], cfg, { e: true }, "2026-10-21", null)[0];
  const f4 = sb.regFusionar([vieja], [], cfg, { e: true }, "2026-10-22", null)[0];
  check("C9a regFusionar con conservarViejo: la fila de hoy reemplaza a la vieja en su renglón, pero «Primera vez visto» se queda como estaba en la hoja",
    f1["Primera vez visto"] === "2026-10-01" && f1["Última vez visto"] === "2026-10-21" && f1["Gasto (último)"] === "40" && f1.__fila === 7, JSON.stringify(f1));
  check("C9b sin la opción reemplaza completa (como antes); si la hoja la tenía vacía toma la de hoy; el que hoy no viene queda Vigente: No con sus fechas",
    f2["Primera vez visto"] === "2026-10-21" && f3["Primera vez visto"] === "2026-10-21" && f4["Vigente"] === "No" && f4["Primera vez visto"] === "2026-10-01" && f4["Última vez visto"] === "2026-10-05", JSON.stringify([f2, f3, f4]));
  check("C9c catálogo de grupos y gasto en mL: el tipo se agrupa por palabras; el gasto solo si es un número limpio",
    JSON.stringify(["Penrose", "Sonda endopleural", "SNG", "Ileostomía", "TPN", "Drenovac", "Blake", "Saratoga", "CVC", "Herida quirúrgica", "Cosa rara", ""].map(sb.regDispGrupo))
    === JSON.stringify(["Penrose", "Sonda pleural", "Sonda nasogástrica / enteral", "Estoma", "Presión negativa", "Drenovac / Hemovac", "Blake / Jackson-Pratt", "Saratoga", "Catéter vascular", "Herida", "Otro", ""])
    && JSON.stringify(["80", "80 ml", "30 CC/24 H", "1,200", "ESCASO", "50-100", "<10", ""].map(sb.regGastoMl)) === JSON.stringify([80, 80, 30, 1200, "", "", "", ""]));
}
{
  // C8 + C9: tres noches seguidas. h1 con antibiótico, soporte y un penrose; h2 con «SIN MEROPENEM» y una sección con
  // texto libre; e1 egresado con una sonda. h1 tiene además una copia vieja en la Papelera con OTRO dispositivo.
  const d = VACIO();
  const ck1 = { atb: true, atb_nombre: "MEROPENEM", atb_dias: "3", atb_inicio: "2026-10-18", npo: true, dieta: "", npt: true, npt_pct: "50", tvp: true, tvp_tipo: "enoxaparina", tvp_dosis: "40 MG",
    pm_vent: true, pm_vent_modo: "AC", pm_vent_fio2: "40", pm_vent_peep: "5", pm_o2l: "3", vp_nore_on: true, vp_nore_mlh: "5", vp_nore_mg: "8", vp_nore_ml: "250", vp_vaso_on: false, vp_vaso_mlh: "9", pm_peso: "70",
    cur_necesita: true, cur_realizada: false, dispositivos: [{ id: "dp1", tipo: "Penrose", lado: "D", sitio: "FID", gasto: "80", carac: "SEROSO", fi: "2026-10-19" }, { id: "dp2", tipo: "SNG", gasto: "", foto: PDF }] };
  const [p1, n1] = hospitalizado("h1", "PRUEBA FICTICIA DIARIA", "000810", { seccion: "Piso", estado: "Delicado" }, { manejo: "MERO 1 G C/8 H + METRO\nSIN VANCOMICINA", checklist: ck1 });
  const [p2, n2] = hospitalizado("h2", "PRUEBA FICTICIA SEGUNDA", "000811", { cama: "3-202", seccion: "PRUEBA FICTICIA TEXTO LIBRE" }, { manejo: "SIN MEROPENEM", checklist: {} });
  d.patients = [p1, p2]; d.notes = [n1, n2];
  d.archive = [egresado("ae1", "e1", "PRUEBA FICTICIA EGRESADA", "000812", "2026-10-10", "2026-10-18", {}, { checklist: { atb: true, dispositivos: [{ id: "de1", tipo: "Sonda endopleural", gasto: "200" }] } }),
    egresado("ah1", "h1", "PRUEBA FICTICIA DIARIA", "000810", "2026-10-18", "2026-10-19", {}, { _egreso: "CAMA REASIGNADA", checklist: { dispositivos: [{ id: "viejo1", tipo: "Blake", gasto: "10" }] } })];
  const st = { db: d, hoy: "2026-10-21" };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const dia = (ep, f) => tab(st.ss, ED).find((x) => x["ID episodio"] === ep && x["Fecha"] === f) || {};
  const disp = (id) => tab(st.ss, DI).find((x) => x["ID dispositivo"] === id) || {};
  const e1 = dia("h1", "2026-10-21"), e2 = dia("h2", "2026-10-21");
  check("C8a dos hospitalizados y un egresado → 2 filas de «Estado diario» (solo hospitalizados), con la fecha de hoy",
    r.ok && !r.avisos.length && tab(st.ss, ED).length === 2 && !!e1["Fecha"] && !!e2["Fecha"] && r.cuentas[ED] === 2, JSON.stringify(r.avisos));
  check("C8b la foto de h1: casillas, antibiótico, ayuno, NPT, TVP, ventilador, vasopresor (mL/h y mg/mL), peso, curación y n.º de dispositivos",
    e1["Cama"] === "3-201" && e1["Sección"] === "PISO" && e1["Estado clínico"] === "DELICADO" && e1["ATB (casilla)"] === "Sí" && e1["Antibiótico (texto)"] === "MEROPENEM" && e1["Días ATB (escritos)"] === "3" && e1["ATB inicio"] === "2026-10-18"
    && e1["NPO"] === "Sí" && e1["NPT"] === "Sí" && e1["NPT %"] === "50" && e1["TVP"] === "Sí · enoxaparina · 40 MG" && e1["VM"] === "Sí" && e1["Modo"] === "AC" && e1["FiO2"] === "40" && e1["PEEP"] === "5" && e1["O2 L/min"] === "3"
    && e1["Norepinefrina mL/h"] === "5" && e1["Norepinefrina mg/mL"] === 0.032 && e1["Vasopresina mL/h"] === "" && e1["Peso"] === "70" && e1["Curación (necesaria/hecha)"] === "Necesaria · pendiente" && e1["Dispositivos (n)"] === 2, JSON.stringify(e1));
  check("C8c «Antibióticos en Manejo»: detecta MERO y METRO con nombre normalizado; «SIN VANCOMICINA» y «SIN MEROPENEM» no se detectan",
    e1["Antibióticos en Manejo (detectados)"] === "MEROPENEM · METRONIDAZOL" && e2["Antibióticos en Manejo (detectados)"] === "" && e2["ATB (casilla)"] === "No" && e2["TVP"] === "No", JSON.stringify([e1, e2]));
  check("C8d la sección con texto libre del censo se escribe «valor no válido»; las filas no llevan Nombre ni Expediente ni texto de identidad",
    e2["Sección"] === "valor no válido" && NUEVAS.slice(0, 3).every((n) => st.ss.sheets[n].cells[0].indexOf("Nombre") === -1 && st.ss.sheets[n].cells[0].indexOf("Expediente") === -1 && !/PRUEBA FICTICIA|00081/.test(JSON.stringify(st.ss.sheets[n].cells)))
    && NUEVAS.every((n) => st.ss.sheets[n].maxC === m.sb.REG_PESTANAS.find((c) => c.nombre === n).columnas.length));
  const g1 = disp("dp1"), g2 = disp("de1");
  check("C9d día 1: el penrose de h1 con su grupo, sitio, colocación, gasto y visto hoy; la SNG sin gasto también; el dispositivo de la copia vieja de la Papelera NO revive",
    tab(st.ss, DI).length === 3 && g1["ID episodio"] === "h1" && g1["Tipo"] === "Penrose" && g1["Tipo (grupo)"] === "Penrose" && g1["Lado"] === "D" && g1["Sitio"] === "FID" && g1["Características"] === "SEROSO" && g1["Fecha de colocación"] === "2026-10-19"
    && g1["Gasto (último)"] === "80" && g1["Primera vez visto"] === "2026-10-21" && g1["Última vez visto"] === "2026-10-21" && g1["Vigente"] === "Sí" && disp("dp2")["Tipo (grupo)"] === "Sonda nasogástrica / enteral" && !disp("viejo1")["ID dispositivo"]
    && /Blake/.test(tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "h1")["Drenajes y dispositivos"]), JSON.stringify(tab(st.ss, DI)));
  check("C9e el dispositivo de un egresado: «Última vez visto» = fecha de egreso, «Primera vez visto» vacía (el registro no lo vio hospitalizado) y sin fila en «Drenajes · diario»",
    g2["ID episodio"] === "e1" && g2["Tipo (grupo)"] === "Sonda pleural" && g2["Primera vez visto"] === "" && g2["Última vez visto"] === "2026-10-18" && g2["Vigente"] === "Sí", JSON.stringify(g2));
  const D1 = tab(st.ss, DD);
  check("C9f «Drenajes · diario» día 1: una fila (solo el hospitalizado con gasto escrito), con el gasto en texto y en mL como número",
    D1.length === 1 && D1[0]["ID episodio"] === "h1" && D1[0]["ID dispositivo"] === "dp1" && D1[0]["Fecha"] === "2026-10-21" && D1[0]["Gasto (texto)"] === "80" && D1[0]["Gasto (mL)"] === 80 && D1[0]["Tipo"] === "Penrose", JSON.stringify(D1));
  const s1 = snap(st.ss); makeSandbox(st).sb.actualizarRegistro();
  check("C8e dos corridas el mismo día no duplican nada (misma hoja)", snap(st.ss) === s1 && tab(st.ss, ED).length === 2 && tab(st.ss, DD).length === 1);
  // Día 2: se apaga el antibiótico y el gasto baja a 40.
  st.hoy = "2026-10-22"; ck1.atb = false; ck1.dispositivos[0].gasto = "40";
  makeSandbox(st).sb.actualizarRegistro();
  check("C8f al día siguiente con el antibiótico apagado: 4 filas, la de hoy dice No y la de ayer queda intacta",
    tab(st.ss, ED).length === 4 && dia("h1", "2026-10-22")["ATB (casilla)"] === "No" && dia("h1", "2026-10-21")["ATB (casilla)"] === "Sí" && JSON.stringify(dia("h1", "2026-10-21")) === JSON.stringify(e1), JSON.stringify(tab(st.ss, ED).map((x) => [x["ID episodio"], x["Fecha"], x["ATB (casilla)"]])));
  check("C9g día 2 (gasto 40): «Dispositivos» sigue con una fila del penrose, misma «Primera vez visto», «Última vez visto» de hoy; «Drenajes · diario» ya tiene 2",
    tab(st.ss, DI).length === 3 && disp("dp1")["Primera vez visto"] === "2026-10-21" && disp("dp1")["Última vez visto"] === "2026-10-22" && disp("dp1")["Gasto (último)"] === "40"
    && JSON.stringify(tab(st.ss, DD).map((x) => [x["Fecha"], x["Gasto (mL)"]])) === JSON.stringify([["2026-10-21", 80], ["2026-10-22", 40]]) && disp("de1")["Última vez visto"] === "2026-10-18", JSON.stringify([disp("dp1"), tab(st.ss, DD)]));
  // Día 3: retiran el penrose.
  st.hoy = "2026-10-23"; ck1.dispositivos = [ck1.dispositivos[1]];
  const r3 = makeSandbox(st).sb.actualizarRegistro();
  check("C9h día 3 sin el penrose: queda Vigente: No con «Última vez visto» = día 2 (retiro aproximado); nada se borra y la foto del día cuenta 1 dispositivo",
    r3.ok && tab(st.ss, DI).length === 3 && disp("dp1")["Vigente"] === "No" && disp("dp1")["Última vez visto"] === "2026-10-22" && disp("dp1")["Primera vez visto"] === "2026-10-21" && disp("dp2")["Vigente"] === "Sí" && disp("dp2")["Última vez visto"] === "2026-10-23"
    && tab(st.ss, DD).length === 2 && tab(st.ss, ED).length === 6 && dia("h1", "2026-10-23")["Dispositivos (n)"] === 1, JSON.stringify([disp("dp1"), disp("dp2")]));
  const sb = m.sb;
  check("C8g detección de antibióticos: combinaciones, abreviaturas, negación en la misma frase y lo que no es antibiótico",
    JSON.stringify([["SE SUSPENDE TRATAMIENTO CON VANCOMICINA, INICIA LINEZOLID"], ["SUSPENDER MEROPENEM Y VANCO"], ["SIN FIEBRE, CONTINÚA PIP/TAZO D5"], ["ALERGIA A PENICILINA. CEFTRIAXONA 1 G"], ["NO TOLERA VO CONTINUA ERTAPENEM"],
      ["CEFTAZIDIMA AVIBACTAM + TMP/SMX"], ["LEVOTIROXINA 100 MCG"], [""]].map((x) => sb.regAtbDetectar(x[0]).join(" · ")))
    === JSON.stringify(["LINEZOLID", "", "PIPERACILINA/TAZOBACTAM", "CEFTRIAXONA", "ERTAPENEM", "CEFTAZIDIMA/AVIBACTAM · TRIMETOPRIMA/SULFAMETOXAZOL", "", ""]) && sb.REG_ATB.length >= 30 && sb.REG_ATB.every((a) => a.length === 4));
  check("C8h valores del censo para pestañas sin nombres: pasa lo que tiene forma de cama / sala / estado / especialidad; lo demás es «valor no válido»",
    JSON.stringify([["cama", "UCI 3"], ["cama", "PRUEBA FICTICIA"], ["cama", "2613060"], ["seccion", "Piso 3"], ["seccion", "GINECOLOGIA / HEMATOLOGIA / ONCOLOGIA"], ["seccion", "PRUEBA FICTICIA"], ["estado", "DEFUNCIÓN"], ["estado", "FICTICIO"],
      ["esp", "CG/URO"], ["esp", "PRUEBA FICTICIA"], ["esp", ""]].map((x) => sb.regValorCenso_(x[0], x[1])))
    === JSON.stringify(["UCI 3", "valor no válido", "valor no válido", "PISO 3", "GINECOLOGIA / HEMATOLOGIA / ONCOLOGIA", "valor no válido", "DEFUNCION", "valor no válido", "CG/URO", "valor no válido", ""]));
  // Todas las columnas de las seis pestañas nuevas están en el Diccionario de variables.
  const vars = sb.regVariables_().slice(1), falta = [];
  sb.REG_PESTANAS.filter((c) => NUEVAS.indexOf(c.nombre) !== -1).forEach((cfg) => cfg.columnas.forEach((c) => { if (!vars.some((v) => v[0] === cfg.nombre && v[1].split(" · ").indexOf(c) !== -1)) falta.push(cfg.nombre + " / " + c); }));
  check("C8i el Diccionario de variables define TODAS las columnas de las seis pestañas nuevas (y cada una tiene su nota de privacidad)",
    !falta.length && NUEVAS.every((n) => vars.some((v) => v[0] === n && v[1] === "Privacidad")) && sb.REG_PESTANAS.filter((c) => NUEVAS.indexOf(c.nombre) !== -1).length === 6, falta.join(" | "));
}
{
  // C14: «Movimientos y estado» desde audit_log (patients) y sus columnas derivadas en «Análisis · Episodios».
  const d = VACIO();
  const [p1, n1] = hospitalizado("m1", "PRUEBA FICTICIA MOVIDA", "000820", { cama: "3-205", ingreso: null, seccion: "PISO", estado: "DELICADO" }, {});
  const [p3, n3] = hospitalizado("m3", "PRUEBA FICTICIA QUIETA", "000822", { cama: "3-207" }, {});
  const [p4, n4] = hospitalizado("m4", "PRUEBA FICTICIA EN TERAPIA", "000823", { cama: "UCI 4" }, {});
  d.patients = [p1, p3, p4]; d.notes = [n1, n3, n4];
  d.archive = [egresado("am2", "m2", "PRUEBA FICTICIA SALIDA", "000821", "2026-10-12", "2026-10-18")];
  d.audit_log = [
    aud(9001, "2026-10-15T15:00:00+00:00", "patients", "INSERT", "m1", null, ["cama", "exp", "nombre"], { registro: "{\"nombre\": \"PACIENTE FICTICIO SECRETO\"}" }, "3-201"),
    aud(9002, "2026-10-16T16:00:00+00:00", "patients", "UPDATE", "m1", "cuenta-secreta-1", ["cama", "seccion"], { cama: { de: "3-201", a: "UCI 2" }, seccion: { de: "PISO", a: "UCIA" } }, "UCI 2"),
    aud(9003, "2026-10-17T15:00:00+00:00", "patients", "UPDATE", "m1", null, ["seccion"], { seccion: { de: "UCIA", a: "BASURA FICTICIA 000123 DEL CENSO" } }, "UCI 2"),
    aud(9004, "2026-10-17T18:00:00+00:00", "patients", "UPDATE", "m1", "cuenta-secreta-1", ["estado"], { estado: { de: "ESTABLE", a: "GRAVE" } }, "UCI 2"),
    aud(9005, "2026-10-18T06:00:00+00:00", "patients", "UPDATE", "m1", null, ["dias"], { dias: { de: "2", a: "3" } }, "UCI 2"),
    aud(9006, "2026-10-19T12:00:00+00:00", "patients", "UPDATE", "m1", null, ["cama", "estado"], { cama: { de: "UCI 2", a: "3-205" }, estado: { de: "GRAVE", a: "DELICADO" } }, "3-205"),
    aud(9007, "2026-10-18T20:30:00+00:00", "patients", "DELETE", "m2", null, null, { registro: "{\"nombre\": \"PACIENTE FICTICIO SECRETO\"}" }, "3-210"),
    aud(9008, "2026-10-18T21:00:00+00:00", "notes", "UPDATE", "m1", null, ["cama"], { cama: { de: "x", a: "y" } }, "3-205")];
  const st = { db: d, hoy: "2026-10-21" };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const M = tab(st.ss, MV), fm = (id, campo) => M.find((x) => String(x["ID"]) === String(id) && x["Campo"] === campo) || {};
  check("C14a alta en el censo, cambios de cama, sección y estado y baja: una fila por campo cambiado (8), sin las filas de notas ni los campos que no se piden",
    r.ok && !r.avisos.length && M.length === 8 && fm(9001, "Cama")["Operación"] === "Alta en censo" && fm(9001, "Cama")["A"] === "3-201" && fm(9001, "Cama")["Origen"] === "hoja o proceso automático"
    && fm(9002, "Cama")["De"] === "3-201" && fm(9002, "Cama")["A"] === "UCI 2" && fm(9002, "Cama")["Origen"] === "app" && fm(9002, "Sección")["A"] === "UCIA" && fm(9004, "Estado clínico")["A"] === "GRAVE"
    && fm(9007, "Cama")["Operación"] === "Baja del censo" && fm(9007, "Cama")["De"] === "3-210" && fm(9007, "Cama")["ID episodio"] === "m2" && !M.some((x) => ["9005", "9008"].includes(String(x["ID"])))
    && fm(9006, "Estado clínico")["A"] === "DELICADO" && fm(9006, "Cama")["Fecha y hora"] === "2026-10-19T12:00:00+00:00", JSON.stringify(M));
  check("C14b la sección con texto basura del censo se escribe «valor no válido»: la basura no llega a ninguna celda",
    fm(9003, "Sección")["De"] === "UCIA" && fm(9003, "Sección")["A"] === "valor no válido" && !/BASURA|000123/.test(snap(st.ss)));
  const llamadas = m.calls.filter((c) => /\/audit_log\?/.test(c.u)), sel = (c) => /select=([^&]*)/.exec(c.u)[1].split(",");
  check("C14c PRIVACIDAD: de audit_log solo se piden sub-rutas del diff con alias; nunca email, nombre, paciente, ip, ua, dispositivo ni el diff entero, y nada de eso llega a la hoja ni al registro de ejecución",
    llamadas.length >= 2 && llamadas.every((c) => sel(c).every((x) => !/^(email|nombre|paciente|ip|ua|dispositivo|diff)$/.test(x) && !/:(email|nombre|paciente|ip|ua|dispositivo|diff)$/.test(x) && !/registro/.test(x)))
    && !SECRETOS.test(snap(st.ss) + JSON.stringify(st.ss.sheets["Integridad"].cells) + m.logs.join(" ")));
  check("C14d se lee por cursor (ts, id) con su filtro y solo sus columnas; el cursor queda en la última fila leída",
    llamadas.some((c) => /audit_log\?select=id,ts,op,record_id,user_id,campos,c:cama,cama:diff->cama,estado:diff->estado,seccion:diff->seccion,esp:diff->esp&tabla=eq\.patients&or=\(op\.in\.\(INSERT,DELETE\),campos\.ov\.\{cama,estado,seccion,esp\}\)&ts=not\.is\.null&order=ts\.asc,id\.asc&limit=1000$/.test(c.u))
    && st.props.REG_CURSOR_audit_pacientes === "2026-10-19T12:00:00+00:00" && m.sb.REG_CURSORES.audit_pacientes.tabla === "audit_log" && m.sb.REG_CURSORES.audit_pacientes.margenMs === 3600000, JSON.stringify(llamadas.map((c) => c.u)));
  const E = episodiosDe(st.ss), a1 = E("m1"), a2 = E("m2"), a3 = E("m3"), a4 = E("m4");
  check("C14e Análisis · Episodios de m1: 2 cambios de cama, pasó por UCI 3 días (16 → 19 oct), peor estado GRAVE desde el 17, ingreso estimado por el alta en el censo (la tarjeta no lo trae)",
    a1["Cambios de cama (n)"] === 2 && a1["Pasó por UCI"] === 1 && a1["Días en UCI"] === 3 && a1["Peor estado clínico"] === "GRAVE" && a1["Fecha del primer GRAVE"] === "2026-10-17"
    && a1["Fecha de ingreso (estimada)"] === "2026-10-15" && a1["Fecha de ingreso (fuente)"] === "Alta en el censo (auditoría)" && a1["Fecha de ingreso"] === "" && a1["Hora de egreso del censo"] === "", JSON.stringify(a1));
  check("C14f el egresado: hora de la baja del censo en hora de Ciudad de México e ingreso de la tarjeta; el que no tiene movimientos queda VACÍO (no 0), salvo «Pasó por UCI» = 1 si hoy está en cama de UCI",
    a2["Hora de egreso del censo"] === "2026-10-18 14:30" && a2["Fecha de ingreso (fuente)"] === "Tarjeta" && a2["Fecha de ingreso (estimada)"] === "2026-10-12" && a2["Cambios de cama (n)"] === 0 && a2["Pasó por UCI"] === 0
    && a3["Cambios de cama (n)"] === "" && a3["Pasó por UCI"] === "" && a3["Días en UCI"] === "" && a3["Peor estado clínico"] === "" && a4["Pasó por UCI"] === 1 && a4["Días en UCI"] === "", JSON.stringify([a2, a3, a4]));
  const s1 = snap(st.ss); const m2 = makeSandbox(st); m2.sb.actualizarRegistro();
  check("C14g segunda corrida: relee desde 1 h antes de lo último, no duplica y deja la hoja igual",
    snap(st.ss) === s1 && tab(st.ss, MV).length === 8 && m2.calls.some((c) => /audit_log\?.*tabla=eq\.patients.*ts=gte\.2026-10-19T11:00:00\.000Z/.test(c.u)));
  // Si audit_log falla, lo demás se escribe y sus tres pestañas no se tocan.
  st.falla = { audit_log: 500 }; st.db.notes[0].pendientes = "PENDIENTE FICTICIO NUEVO";
  const antes = JSON.stringify([MV, SO, AC].map((n) => st.ss.sheets[n].cells)), cur = st.props.REG_CURSOR_audit_pacientes;
  const r3 = makeSandbox(st).sb.actualizarRegistro();
  check("C14h si audit_log responde 500: las demás pestañas sí se escriben, las tres de auditoría quedan igual, salen los dos avisos, el cursor no se mueve y el análisis conserva lo ya copiado",
    r3.ok && tab(st.ss, "Pacientes").find((x) => x["ID episodio"] === "m1")["Pendientes"] === "PENDIENTE FICTICIO NUEVO" && JSON.stringify([MV, SO, AC].map((n) => st.ss.sheets[n].cells)) === antes
    && r3.avisos.some((a) => /No se pudo leer audit_pacientes \(Supabase audit_log HTTP 500\)/.test(a)) && r3.avisos.some((a) => /No se pudo leer audit_notas \(Supabase audit_log HTTP 500\)/.test(a))
    && st.props.REG_CURSOR_audit_pacientes === cur && episodiosDe(st.ss)("m1")["Cambios de cama (n)"] === 2 && /Parcial: faltó leer audit_pacientes; leer audit_notas/.test(tab(st.ss, "Integridad").pop()["Resultado"]), JSON.stringify(r3.avisos));
  delete st.falla;
  // Carga inicial en vueltas con tope: la continuación lleva los DOS «or» (el del filtro y el de la paginación por llave).
  const s4 = { db: JSON.parse(JSON.stringify(d)), hoy: "2026-10-21" }; let urls = [];
  for (let v = 0; v < 5; v++) { const mm = makeSandbox(s4); mm.sb.REG_CURSORES.audit_pacientes.tope = 3; v ? mm.sb.continuarRegistro() : mm.sb.actualizarRegistro(); urls = urls.concat(mm.calls.filter((c) => /audit_log\?.*tabla=eq\.patients/.test(c.u)).map((c) => c.u)); }
  check("C14i con tope de 3 filas por vuelta la carga sigue desde la posición exacta (dos «or» en la URL), termina con las mismas 8 filas y no queda nada pendiente",
    tab(s4.ss, MV).length === 8 && !s4.props.REG_SIGUE_audit_pacientes && s4.props.REG_CURSOR_audit_pacientes === "2026-10-19T12:00:00+00:00" && urls.some((u) => (u.match(/[?&]or=/g) || []).length === 2)
    && JSON.stringify(tab(s4.ss, MV).map((x) => [String(x["ID"]), x["Campo"]]).sort()) === JSON.stringify(M.map((x) => [String(x["ID"]), x["Campo"]]).sort()) && episodiosDe(s4.ss)("m1")["Días en UCI"] === 3, JSON.stringify(urls.slice(0, 3)));
  // regMovEpisodio_ directo: baja en UCI cierra el tramo; un valor no válido no cuenta como cambio de cama.
  const mv = (id, ts, op, campo, de, a) => ({ "ID": id, "Fecha y hora": ts, "Operación": op, "Campo": campo, "De": de, "A": a });
  const x = m.sb.regMovEpisodio_([{ movs: [mv(1, "2026-10-10T18:00:00+00:00", "Alta en censo", "Cama", "", "UTI 1"), mv(2, "2026-10-11T18:00:00+00:00", "Cambio", "Cama", "UTI 1", "valor no válido"),
    mv(3, "2026-10-14T18:00:00+00:00", "Baja del censo", "Cama", "UTI 1", "")], fila: { "Cama": "UTI 1", "Estado clínico": "MUY GRAVE" } }], "2026-10-10", "2026-10-20");
  check("C14j una baja del censo estando en UCI cierra el tramo (4 días, no hasta hoy); un valor no válido no cuenta como cambio de cama; el estado de la tarjeta cuenta para el peor estado",
    x["Días en UCI"] === 4 && x["Pasó por UCI"] === 1 && x["Cambios de cama (n)"] === 0 && x["Peor estado clínico"] === "MUY GRAVE" && x["Fecha del primer GRAVE"] === "" && x["Hora de egreso del censo"] === "2026-10-14 12:00" && x["Fecha de ingreso (fuente)"] === "Tarjeta", JSON.stringify(x));
}
{
  // C15: «Soporte y exposiciones (historial)» y «Actividad por episodio y día» desde audit_log (notes).
  const d = VACIO();
  const [p1, n1] = hospitalizado("s1", "PRUEBA FICTICIA SOPORTE", "000830", {}, {});
  d.patients = [p1]; d.notes = [n1];
  const filasAud = () => [
    aud(9101, "2026-10-20T15:00:00+00:00", "notes", "UPDATE", "s1", "cuenta-secreta-a", ["checklist"], { checklist: { vp_nore_on: { de: "false", a: "true" }, dispositivos: { de: 1, a: 2, tipo: "elementos" }, sexo: { de: "\"\"", a: "\"M\"" } } }),
    aud(9102, "2026-10-20T16:30:00+00:00", "notes", "UPDATE", "s1", "cuenta-secreta-b", ["checklist"], { checklist: { atb_nombre: { de: "\"CEFTRIAXONA\"", a: "\"MEROPENEM\"" } } }),
    aud(9103, "2026-10-21T05:10:00+00:00", "notes", "UPDATE", "s1", "cuenta-secreta-a", ["pendientes"], { pendientes: { de: "", a: "TEXTO LIBRE FICTICIO SECRETO" } }),
    aud(9104, "2026-10-20T17:00:00+00:00", "notes", "UPDATE", "s1", null, ["lab_history"], { lab_history: { de: 3, a: 4, tipo: "elementos" } }),
    aud(9105, "2026-10-20T18:00:00+00:00", "patients", "UPDATE", "s1", null, ["dx"], { dx: { de: "A", a: "B" } })];
  d.audit_log = filasAud();
  const st = { db: d, hoy: "2026-10-21" };
  const m = makeSandbox(st); const r = m.sb.actualizarRegistro();
  const S = tab(st.ss, SO), A = tab(st.ss, AC);
  const sN = S.find((x) => x["Variable"] === "Norepinefrina") || {}, sA = S.find((x) => x["Variable"] === "Antibiótico (texto)") || {};
  check("C15a tres ediciones (prende norepinefrina, cambia el antibiótico, solo toca pendientes) → 2 filas en el historial, con De / A legibles y fecha de la base",
    r.ok && !r.avisos.length && S.length === 2 && String(sN["ID"]) === "9101" && sN["ID episodio"] === "s1" && sN["De"] === "No" && sN["A"] === "Sí" && sN["Fecha y hora"] === "2026-10-20T15:00:00+00:00"
    && String(sA["ID"]) === "9102" && sA["De"] === "CEFTRIAXONA" && sA["A"] === "MEROPENEM", JSON.stringify(S));
  check("C15b «Quién» es un seudónimo de la cuenta (U-…, distinto por cuenta, estable) y la cuenta no aparece en ningún lado",
    /^U-[0-9A-F]{12}$/.test(sN["Quién"]) && /^U-[0-9A-F]{12}$/.test(sA["Quién"]) && sN["Quién"] !== sA["Quién"] && !SECRETOS.test(snap(st.ss) + m.logs.join(" ")));
  check("C15c «Actividad por episodio y día»: UNA fila con 3 ediciones (la del robot no cuenta), 2 usuarios, primera y última hora locales, 1 de noche y las cajas tocadas",
    A.length === 1 && A[0]["ID episodio"] === "s1" && A[0]["Fecha"] === "2026-10-20" && A[0]["Ediciones (n)"] === 3 && A[0]["Usuarios (n)"] === 2 && A[0]["Primera hora"] === "09:00" && A[0]["Última hora"] === "23:10"
    && A[0]["Ediciones de noche (n)"] === 1 && A[0]["Cajas tocadas"] === "checklist · pendientes" && A[0]["Último ID"] === 9103 && A[0]["Usuarios"] === [sN["Quién"], sA["Quién"]].sort().join(" · "), JSON.stringify(A));
  const llamadas = m.calls.filter((c) => /audit_log\?.*tabla=eq\.notes/.test(c.u));
  check("C15d una sola petición por página, de menos de 2 KB aun con la paginación por llave, solo con sub-rutas del checklist (alias de una letra) y sin columnas privadas",
    llamadas.length === 1 && llamadas.every((c) => c.raw.length < 2048) && /select=id,ts,record_id,user_id,campos,a:diff->checklist->atb,b:diff->checklist->atb_nombre,.*l:diff->checklist->pm_vent&tabla=eq\.notes&op=eq\.UPDATE&ts=not\.is\.null&order=ts\.asc,id\.asc&limit=1000$/.test(llamadas[0].u)
    && !/email|nombre:|paciente|[,=]ip|[,=]ua|dispositivo[,&]|select=[^&]*diff[,&]/.test(llamadas[0].u.replace(/atb_nombre/g, ""))
    && m.sb.regUrl_("audit_log", m.sb.regAudNotasSelect_(), "ts,id", m.sb.REG_CURSORES.audit_notas.filtro + "&ts=not.is.null&" + m.sb.regKeyset_(["ts", "id"], ["2026-11-24T05:00:00.123456+00:00", "123456789012"]), 1000).length < 2048, llamadas.map((c) => c.raw.length + " " + c.u).join(" | "));
  const s1 = snap(st.ss); makeSandbox(st).sb.actualizarRegistro();
  check("C15e segunda corrida (relee 1 h por el margen): no duplica el historial ni vuelve a contar las ediciones", snap(st.ss) === s1 && tab(st.ss, AC)[0]["Ediciones (n)"] === 3);
  // Llega otra edición de la misma noche (otra cuenta) y una del día siguiente: se SUMA a la fila del día y se crea la nueva.
  st.db.audit_log.push(aud(9106, "2026-10-21T05:30:00+00:00", "notes", "UPDATE", "s1", "cuenta-secreta-c", ["manejo"], { manejo: { de: "", a: "x" } }),
    aud(9107, "2026-10-21T14:00:00+00:00", "notes", "UPDATE", "s1", "cuenta-secreta-a", ["checklist"], { checklist: { vp_nore_on: { de: "true", a: "false" }, npo: { de: "", a: "true" } } }));
  makeSandbox(st).sb.actualizarRegistro();
  const A2 = tab(st.ss, AC), S2 = tab(st.ss, SO);
  check("C15f lo nuevo se suma a la fila del día (4 ediciones, 3 usuarios, última hora 23:30) y el día siguiente tiene su fila; el historial gana el apagado y el ayuno (casilla que no existía: De vacío)",
    A2.length === 2 && A2[0]["Ediciones (n)"] === 4 && A2[0]["Usuarios (n)"] === 3 && A2[0]["Última hora"] === "23:30" && A2[0]["Ediciones de noche (n)"] === 2 && A2[0]["Cajas tocadas"] === "checklist · manejo · pendientes" && A2[0]["Último ID"] === 9106
    && A2[1]["Fecha"] === "2026-10-21" && A2[1]["Ediciones (n)"] === 1 && S2.length === 4 && S2.some((x) => String(x["ID"]) === "9107" && x["Variable"] === "Norepinefrina" && x["De"] === "Sí" && x["A"] === "No")
    && S2.some((x) => String(x["ID"]) === "9107" && x["Variable"] === "Ayuno (NPO)" && x["De"] === "" && x["A"] === "Sí"), JSON.stringify([A2, S2]));
  // Cursor reanudable con tope: 2 filas por vuelta; el total no cambia y nada se cuenta dos veces.
  const s4 = { db: Object.assign(VACIO(), { patients: [p1], notes: [n1], audit_log: filasAud() }), hoy: "2026-10-21" }; const cont = [];
  for (let v = 0; v < 5; v++) { const mm = makeSandbox(s4); mm.sb.REG_CURSORES.audit_notas.tope = 2; const rr = v ? mm.sb.continuarRegistro() : mm.sb.actualizarRegistro(); cont.push([rr.pendiente, (tab(s4.ss, AC)[0] || {})["Ediciones (n)"], !!s4.props.REG_SIGUE_audit_notas]); }
  check("C15g con tope de 2 filas por vuelta: la primera vuelta deja 2 ediciones y la posición guardada; al terminar son las mismas 3 ediciones y 2 filas de historial, sin nada pendiente",
    cont[0][0] === true && cont[0][1] === 2 && cont[0][2] === true && tab(s4.ss, AC).length === 1 && tab(s4.ss, AC)[0]["Ediciones (n)"] === 3 && tab(s4.ss, AC)[0]["Usuarios (n)"] === 2 && tab(s4.ss, AC)[0]["Última hora"] === "23:10"
    && tab(s4.ss, SO).length === 2 && cont[4][0] === false && !s4.props.REG_SIGUE_audit_notas && s4.props.REG_CURSOR_audit_notas === "2026-10-21T05:10:00+00:00", JSON.stringify(cont));
  // Unitarias: el valor del sub-diff y la suma idempotente.
  const sb = m.sb;
  check("C15h valor de un sub-diff (texto JSON de la base): casillas a Sí / No, texto sin comillas, vacío y listas a vacío, recorte a 300",
    JSON.stringify(["true", "false", "\"MEROPENEM\"", "", "null", "[1,2]", "5", "\"TEXTO CORTADO SIN CERRAR", "\"" + "A".repeat(400) + "\""].map(sb.regAudValor_).map((x) => x.length > 50 ? x.length : x))
    === JSON.stringify(["Sí", "No", "MEROPENEM", "", "", "", "5", "TEXTO CORTADO SIN CERRAR", 300]));
  const vieja = { "ID episodio": "s1", "Fecha": "2026-10-20", "Ediciones (n)": 3, "Usuarios (n)": 1, "Primera hora": "09:00", "Última hora": "10:00", "Ediciones de noche (n)": 0, "Cajas tocadas": "manejo", "Usuarios": "U-A", "Último ID": 50, __fila: 4 };
  const ed = (id, hora, u) => ({ id, hora, noche: false, usuario: u, cajas: ["pa"] });
  const c1 = sb.regFusionar([vieja], [Object.assign(sb.regActividadFila_("s1", "2026-10-20", [ed(49, "08:00", "U-B"), ed(51, "11:00", "U-B")], null), { __ediciones: [ed(49, "08:00", "U-B"), ed(51, "11:00", "U-B")] })],
    sb.REG_PESTANAS.find((c) => c.nombre === AC), null, "2026-10-21", null)[0];
  const c2 = sb.regActividadCombinar(vieja, { "ID episodio": "s1", "Fecha": "2026-10-20", __ediciones: [ed(50, "10:00", "U-A")] });
  check("C15i la suma solo toma las ediciones con id mayor que el «Último ID» ya contado (lo releído no se cuenta); sin nuevas, la fila queda idéntica",
    c1["Ediciones (n)"] === 4 && c1["Usuarios (n)"] === 2 && c1["Usuarios"] === "U-A · U-B" && c1["Primera hora"] === "09:00" && c1["Última hora"] === "11:00" && c1["Cajas tocadas"] === "manejo · pa" && c1["Último ID"] === 51 && c1.__fila === 4 && c2 === vieja, JSON.stringify(c1));
}

// ═══ Lote C, 24 nov 2026: días observados (18), «Análisis · Cirugías» (19), KDIGO y laboratorio (20), cultivos (21) y
//     Charlson simplificado (22). Egress 0: todo sale de lo ya fusionado. Datos FICTICIOS. ═══════════════════════════════
const AQ = "Análisis · Cirugías";
{
  const sb = makeSandbox({ db: VACIO() }).sb, cod = (pre, ident) => pre + "-" + ident;
  const pac = (id, exp, nombre, extra) => Object.assign({ "ID episodio": id, "Estado en registro": "Egresado", "Motivo de egreso": "ALTA (registrado en la app)", "Expediente": exp, "Nombre": nombre, "Edad": "45", "Sexo": "F",
    "Fecha de ingreso": "2026-11-24", "Fecha de egreso": "2026-11-28", "Diagnóstico": "COLECISTITIS" }, extra || {});
  const noche = (id, fecha, o) => Object.assign({ "ID episodio": id, "Fecha": fecha, "ATB (casilla)": "No", "Antibióticos en Manejo (detectados)": "", "Antibiótico (texto)": "", "NPO": "No", "NPT": "No", "NPT %": "", "TVP": "No", "VM": "No",
    "Norepinefrina mL/h": "", "Vasopresina mL/h": "" }, o || {});
  const ev = (id, idEp, ts, variable, de, a) => ({ "ID": String(id), "ID episodio": idEp, "Fecha y hora": ts, "Variable": variable, "De": de, "A": a, "Quién": "U-X" });
  const ep = (fus, i) => sb.regAnalisis(fus, [], [], "2026-12-20", cod)[AN[0]][i || 0];

  // ─── C18: días observados ───────────────────────────────────────────────────────────────────────────────────────
  const fusA = { "Pacientes": [pac("d1", "000931", "PRUEBA FICTICIA DIARIO UNO"), pac("d2", "000932", "PRUEBA FICTICIA DIARIO DOS")],
    "Estado diario": [noche("d1", "2026-11-24", { "ATB (casilla)": "Sí", "Antibiótico (texto)": "CEFTRIAXONA", "NPO": "Sí" }), noche("d1", "2026-11-25", { "Antibióticos en Manejo (detectados)": "MEROPENEM · VANCOMICINA" }), noche("d1", "2026-11-26")] };
  const a1 = ep(fusA, 0), a2 = ep(fusA, 1);
  check("C18a 3 noches de «Estado diario» (antibiótico 2, ayuno 1) y estancia de 4 días: días con antibiótico = 2 (casilla o detectado en Manejo), ayuno = 1, cobertura = 75 %, primer y último día, 3 antibióticos distintos y carbapenémico",
    a1["Días con antibiótico (observados)"] === 2 && a1["Días en ayuno"] === 1 && a1["Cobertura del diario (%)"] === 75 && a1["Primer día ATB"] === "2026-11-24" && a1["Último día ATB"] === "2026-11-25"
    && a1["Antibióticos distintos (n)"] === 3 && a1["Carbapenémico"] === 1 && a1["Días con NPT"] === 0 && a1["Días con ventilación"] === 0 && a1["Días con vasopresor"] === 0 && a1["Días con tromboprofilaxis"] === 0 && a1["Ayuno >5 días sin NPT"] === 0,
    JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, a1[c]])));
  check("C18b episodio sin filas de diario, de historial ni de dispositivos: TODAS las columnas de días observados quedan vacías (no 0)", sb.REG_EP_DIARIO.every((c) => a2[c] === ""), JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, a2[c]])));
  // El historial de auditoría llena SOLO las noches sin foto. Prendido el 14 (hora local) y apagado el 17: noches 14, 15 y 16.
  const fusB = { "Pacientes": [pac("d3", "000933", "PRUEBA FICTICIA HISTORIAL", { "Fecha de ingreso": "2026-11-13", "Fecha de egreso": "2026-11-20" })],
    "Soporte y exposiciones (historial)": [ev(1, "d3", "2026-11-14T16:00:00+00:00", "Antibiótico (casilla)", "No", "Sí"), ev(2, "d3", "2026-11-17T15:00:00+00:00", "Antibiótico (casilla)", "Sí", "No"),
      ev(3, "d3", "2026-11-15T15:00:00+00:00", "Antibiótico (texto)", "", "ERTAPENEM 1 G"), ev(4, "d3", "2026-11-13T15:00:00+00:00", "NPT", "Sí", "No"),                    // apagado sin su prendido: no suma
      ev(5, "d3", "2026-11-18T03:00:00+00:00", "Ventilación mecánica", "No", "Sí"),                                                                                           // 17 por la noche (hora local); sigue prendida
      ev(6, "d3", "2026-11-16T15:00:00+00:00", "Norepinefrina", "No", "Sí"), ev(7, "d3", "2026-11-17T15:00:00+00:00", "Norepinefrina", "Sí", "No"), ev(8, "d3", "2026-11-17T16:00:00+00:00", "Vasopresina", "No", "Sí"),
      ev(9, "d3", "2026-11-18T16:00:00+00:00", "Vasopresina", "Sí", "No"), ev(10, "d3", "2026-11-15T15:00:00+00:00", "NPT %", "", "60")],
    "Estado diario": [noche("d3", "2026-11-15", { "ATB (casilla)": "No" })] };
  const b1 = ep(fusB);
  check("C18c sin foto, el historial de la casilla da los días (del prendido a la víspera del apagado); la noche CON foto manda (15 en «No» no cuenta); un apagado sin prendido no suma; lo que sigue prendido llega a la última noche del episodio",
    b1["Días con antibiótico (observados)"] === 2 && b1["Primer día ATB"] === "2026-11-14" && b1["Último día ATB"] === "2026-11-16" && b1["Antibióticos distintos (n)"] === 1 && b1["Carbapenémico"] === 1
    && b1["Días con NPT"] === 0 && b1["Días con ventilación"] === 3 && b1["Días con vasopresor"] === 2 && b1["Días con tromboprofilaxis"] === 0 && b1["Días en ayuno"] === 0 && b1["Cobertura del diario (%)"] === 14.3,
    JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, b1[c]])));
  const x = (foto, evs, desde, hasta) => sb.regDiasExpuesto_(foto, evs, desde, hasta).join(",");
  check("C18d regDiasExpuesto_: prendido y apagado el mismo día no cuenta; nunca antes del ingreso; dos tramos; sin eventos solo las fotos prendidas",
    x({}, [{ fecha: "2026-11-10", a: "Sí" }, { fecha: "2026-11-10", a: "No" }], "2026-11-01", "2026-11-20") === "" && x({}, [{ fecha: "2026-10-28", a: "Sí" }, { fecha: "2026-11-03", a: "No" }], "2026-11-01", "2026-11-20") === "2026-11-01,2026-11-02"
    && x({ "2026-11-06": true }, [{ fecha: "2026-11-02", a: "Sí" }, { fecha: "2026-11-03", a: "No" }, { fecha: "2026-11-19", a: "Sí" }], "2026-11-01", "2026-11-20") === "2026-11-02,2026-11-06,2026-11-19,2026-11-20"
    && x({ "2026-11-06": true, "2026-11-07": false }, [], "", "") === "2026-11-06");
  // Ayuno posoperatorio, inicio de dieta y más de 5 noches seguidas en ayuno sin NPT; dispositivos y drenajes.
  const nochesE = ["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01"].map((f, i) => noche("d4", f, { "NPO": i < 6 ? "Sí" : "No", "NPT": i === 6 ? "Sí" : "No", "NPT %": i === 6 ? "50 %" : "", "TVP": "Sí · ENOXAPARINA · 40 MG" }));
  const fusE = { "Pacientes": [pac("d4", "000934", "PRUEBA FICTICIA AYUNO", { "Fecha de ingreso": "2026-11-24", "Fecha de egreso": "2026-12-04" }), pac("d5", "000935", "PRUEBA FICTICIA SIN VER", { "Fecha de ingreso": "2026-10-01", "Fecha de egreso": "2026-10-05" })],
    "Cirugías": [{ "ID episodio": "d4", "Fecha": "2026-11-26", "Procedimiento": "LAPE + RESECCION INTESTINAL", "Grupo": "Laparotomía exploradora", "Fuente": "Caja Cirugías", "Vigente": "Sí" }],
    "Estado diario": nochesE,
    "Dispositivos": [{ "ID episodio": "d4", "ID dispositivo": "x1", "Tipo": "PENROSE", "Tipo (grupo)": "Penrose", "Primera vez visto": "2026-11-26", "Última vez visto": "2026-11-28", "Vigente": "No" },
      { "ID episodio": "d4", "ID dispositivo": "x2", "Tipo": "ILEOSTOMIA", "Tipo (grupo)": "Estoma", "Primera vez visto": "2026-11-26", "Última vez visto": "2026-12-01", "Vigente": "Sí" },
      { "ID episodio": "d4", "ID dispositivo": "x3", "Tipo": "SONDA FOLEY", "Tipo (grupo)": "Sonda urinaria", "Primera vez visto": "2026-11-25", "Última vez visto": "2026-11-27", "Vigente": "No" },
      { "ID episodio": "d5", "ID dispositivo": "y1", "Tipo": "DRENOVAC", "Tipo (grupo)": "Drenovac / Hemovac", "Primera vez visto": "", "Última vez visto": "2026-10-05", "Vigente": "Sí" }],
    "Drenajes · diario": [{ "ID episodio": "d4", "ID dispositivo": "x1", "Fecha": "2026-11-27", "Tipo": "PENROSE", "Gasto (texto)": "120 ML", "Gasto (mL)": 120 }, { "ID episodio": "d4", "ID dispositivo": "x1", "Fecha": "2026-11-29", "Tipo": "PENROSE", "Gasto (texto)": "ESCASO", "Gasto (mL)": "" },
      { "ID episodio": "d4", "ID dispositivo": "x3", "Fecha": "2026-11-26", "Tipo": "SONDA FOLEY", "Gasto (texto)": "900", "Gasto (mL)": 900 }] };
  const e1 = ep(fusE, 1), e0 = ep(fusE, 0);
  check("C18e ayuno: 6 noches (5 desde la cirugía), dieta al día 5 posoperatorio (primera noche sin ayuno), más de 5 noches seguidas sin NPT = 1; NPT 1 día al 50 %; tromboprofilaxis 7; cobertura 70 %",
    e1["Días en ayuno"] === 6 && e1["Ayuno posoperatorio (días)"] === 5 && e1["Día posoperatorio de inicio de dieta"] === 5 && e1["Ayuno >5 días sin NPT"] === 1 && e1["Días con NPT"] === 1 && e1["NPT % máximo"] === 50
    && e1["Días con tromboprofilaxis"] === 7 && e1["Cobertura del diario (%)"] === 70, JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, e1[c]])));
  check("C18f dispositivos: 3 distintos, estoma 1, sonda pleural 0 y presión negativa 0; días con drenaje = 26–28 del Penrose + la fecha con gasto (4); gasto máximo 120 mL (la sonda urinaria no es drenaje)",
    e1["Dispositivos (n)"] === 3 && e1["Estoma"] === 1 && e1["Sonda endopleural"] === 0 && e1["Terapia de presión negativa"] === 0 && e1["Días con drenaje"] === 4 && e1["Gasto máximo (mL)"] === 120, JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, e1[c]])));
  check("C18g egresado que el registro nunca vio hospitalizado: su drenaje cuenta en «Dispositivos (n)» pero «Días con drenaje» queda vacío (no 0), igual que los días de exposición y la cobertura",
    e0["Dispositivos (n)"] === 1 && e0["Días con drenaje"] === "" && e0["Gasto máximo (mL)"] === "" && e0["Estoma"] === 0 && e0["Días con antibiótico (observados)"] === "" && e0["Cobertura del diario (%)"] === "", JSON.stringify(sb.REG_EP_DIARIO.map((c) => [c, e0[c]])));

  // ─── C20: KDIGO y laboratorio ───────────────────────────────────────────────────────────────────────────────────
  const lab = (id, fecha, estudio, valor) => ({ "ID episodio": id, "Fecha": fecha, "Estudio": estudio, "Valor": valor, "Origen": "winlab", "Vigente": "Sí" });
  const fusL = { "Pacientes": [pac("k1", "000936", "PRUEBA FICTICIA RENAL", { "Fecha de ingreso": "2026-11-01", "Fecha de egreso": "2026-11-12" }), pac("k2", "000937", "PRUEBA FICTICIA UNA CREAT", { "Fecha de ingreso": "2026-11-01", "Fecha de egreso": "2026-11-05", "Sexo": "M" })],
    "Cirugías": [{ "ID episodio": "k1", "Fecha": "2026-11-02", "Procedimiento": "LAPE", "Grupo": "Laparotomía exploradora", "Fuente": "Caja Cirugías", "Vigente": "Sí" }],
    "Labs": [lab("k1", "2026-11-02", "cr", "0.8"), lab("k1", "2026-11-03", "cr", "1.7"), lab("k1", "2026-11-04", "cr", "2.6"), lab("k1", "2026-11-01", "hb", "12"), lab("k1", "2026-11-03", "hb", "9"), lab("k1", "2026-11-04", "hb", "10"),
      lab("k1", "2026-11-01", "alb", "2.8"), lab("k1", "2026-11-01", "leucos", "14.2"), lab("k1", "2026-11-01", "plaq", "250"), lab("k1", "2026-11-01", "na", "131"), lab("k1", "2026-11-05", "pcr", "180"), lab("k1", "2026-11-06", "pcr", "90"),
      lab("k1", "2026-11-01", "glu", "210"), lab("k1", "2026-11-03", "glu", "150"), lab("k1", "2026-11-04", "glu", "181"),
      lab("k2", "2026-11-01", "cr", "3.1"), lab("k2", "2026-11-01", "hb", "12.5")] };
  const k1 = ep(fusL, 0), k2 = ep(fusL, 1);
  check("C20a creatininas 0.8 → 1.7 → 2.6 en días seguidos: KDIGO 3 (≥3 veces la basal), basal 0.8, fecha del PRIMER criterio (el día del 1.7) y lesión posoperatoria = 1 (no la tenía el día de la cirugía)",
    k1["LRA KDIGO (estadio máx.)"] === 3 && k1["Creatinina basal (mg/dL)"] === 0.8 && k1["Fecha de LRA"] === "2026-11-03" && k1["LRA posoperatoria"] === 1, JSON.stringify(sb.REG_EP_LAB.map((c) => [c, k1[c]])));
  check("C20b con una sola creatinina: basal, estadio, fecha y posoperatoria quedan VACÍOS (no 0)",
    k2["LRA KDIGO (estadio máx.)"] === "" && k2["Creatinina basal (mg/dL)"] === "" && k2["Fecha de LRA"] === "" && k2["LRA posoperatoria"] === "" && k2["Creatinina inicial (mg/dL)"] === 3.1, JSON.stringify(sb.REG_EP_LAB.map((c) => [c, k2[c]])));
  check("C20c Hb 12 → 9 → 10: caída máxima 3, inicial 12, preoperatoria 12 (la última hasta el día de la cirugía); anemia OMS: 12 en mujer = 0, 12.5 en hombre = 1",
    k1["Caída máxima de Hb (g/dL)"] === 3 && k1["Hb inicial (g/dL)"] === 12 && k1["Hb preoperatoria (g/dL)"] === 12 && k1["Anemia al ingreso (OMS)"] === 0 && k2["Anemia al ingreso (OMS)"] === 1 && k2["Caída máxima de Hb (g/dL)"] === "" && k2["Hb preoperatoria (g/dL)"] === "",
    JSON.stringify([k1["Caída máxima de Hb (g/dL)"], k1["Hb inicial (g/dL)"], k1["Hb preoperatoria (g/dL)"], k1["Anemia al ingreso (OMS)"], k2["Anemia al ingreso (OMS)"]]));
  check("C20d albúmina inicial 2.8: <3.5 = 1 y <3.0 = 1; iniciales de leucocitos, plaquetas y sodio; PCR del día 3 posoperatorio (no la del 4); glucosa >180 en 2 fechas; sin el estudio, vacío",
    k1["Hipoalbuminemia (<3.5)"] === 1 && k1["Albúmina <3.0"] === 1 && k1["Leucocitos iniciales (k/µL)"] === 14.2 && k1["Plaquetas iniciales (k/µL)"] === 250 && k1["Sodio inicial (mmol/L)"] === 131 && k1["PCR día 3-4 posoperatorio (mg/L)"] === 180
    && k1["Glucosa >180 (días)"] === 2 && k2["Hipoalbuminemia (<3.5)"] === "" && k2["Glucosa >180 (días)"] === "" && k2["PCR día 3-4 posoperatorio (mg/L)"] === "", JSON.stringify(sb.REG_EP_LAB.map((c) => [c, k1[c]])));
  const kd = (l) => { const r = sb.regKdigo_(l.map((n, i) => ({ f: "2026-11-" + ("0" + (i * 1 + 1)).slice(-2), n }))); return [r.estadio, r.fecha.slice(-2)].join("/"); };
  const kdF = (pares) => { const r = sb.regKdigo_(pares.map(([f, n]) => ({ f, n }))); return [r.estadio, r.fecha.slice(-2)].join("/"); };
  check("C20e regKdigo_: sin cambio = 0; +0.3 en 48 h = 1; el mismo +0.3 con 5 días de por medio = 0; 1.5 veces = 1; 2 veces = 2; ≥4.0 con criterio = 3; quien llega lesionado y mejora: el día del ingreso",
    kd([1, 1.1]) === "0/" && kd([1, 1.3]) === "1/02" && kdF([["2026-11-01", 1], ["2026-11-06", 1.3]]) === "0/" && kd([0.8, 1.2]) === "1/02" && kd([0.9, 1.8]) === "2/02" && kd([2.9, 4.1]) === "3/02" && kd([3, 1.5, 1]) === "3/01",
    JSON.stringify([kd([1, 1.1]), kd([1, 1.3]), kdF([["2026-11-01", 1], ["2026-11-06", 1.3]]), kd([0.8, 1.2]), kd([0.9, 1.8]), kd([2.9, 4.1]), kd([3, 1.5, 1])]));
  const lp = sb.regLabsEpisodio_({ cr: [{ f: "2026-11-01", n: 2 }, { f: "2026-11-03", n: 1 }, { f: "2026-11-05", n: 1.9 }] }, "2026-11-02", "", "");
  check("C20f lesión que ya estaba ANTES de la cirugía no es posoperatoria (0); sin sexo ni Hb la anemia queda vacía", lp["LRA posoperatoria"] === 0 && lp["LRA KDIGO (estadio máx.)"] === 2 && lp["Anemia al ingreso (OMS)"] === "", JSON.stringify(lp));

  // ─── C21: cultivos ──────────────────────────────────────────────────────────────────────────────────────────────
  const cul = (exp, nombre, rep, toma, tipo, muestra, res, germen, resist, sens) => ({ "Expediente": exp, "Paciente": nombre, "Reporte": rep, "N": "1", "Toma": toma, "Tipo": tipo, "Muestra": muestra, "Resultado": res, "Germen": germen || "",
    "Sensibles": sens || "", "Intermedios": "", "Resistentes": resist || "", "UFC": "", "Fuente": "PDF" });
  const cx = (id, fecha, proc) => ({ "ID episodio": id, "Fecha": fecha, "Procedimiento": proc, "Grupo": "Laparotomía exploradora", "Fuente": "Caja Cirugías", "Vigente": "Sí" });
  const pc = (id, exp, nombre, extra) => pac(id, exp, nombre, Object.assign({ "Fecha de ingreso": "2026-11-01", "Fecha de egreso": "2026-11-15" }, extra || {}));
  const fusC = { "Pacientes": [pc("c1", "000941", "PRUEBA FICTICIA HERIDA"), pc("c2", "000942", "PRUEBA FICTICIA SANGRE"), pc("c3", "000943", "PRUEBA FICTICIA NEGATIVO"), pc("c4", "000944", "PRUEBA FICTICIA SIN CULTIVO", { "Manejo": "CURACION DIARIA. SIN DATOS DE ISQ" }),
      pc("c5", "000945", "PRUEBA FICTICIA CONTAMINANTE", { "Diagnóstico": "PO LAPE + INFECCION DE SITIO QUIRURGICO SUPERFICIAL" })],
    "Cirugías": [cx("c1", "2026-11-02", "LAPE"), cx("c3", "2026-11-02", "LAPE"), cx("c4", "2026-11-02", "LAPE"), cx("c5", "2026-11-02", "LAPE")],
    "Cultivos del robot (WinLab)": [
      cul("000941", "PRUEBA FICTICIA HERIDA", "r1", "2026-11-07 09:10", "Cultivo de secreción", "SECRECION DE HERIDA QUIRURGICA", "POSITIVO", "Escherichia coli (BLEE)", "CEFTRIAXONA >=64 · CIPROFLOXACINO >=4", "MEROPENEM <=0.25"),
      cul("000941", "PRUEBA FICTICIA HERIDA", "r2", "2026-11-02 12:00", "Cultivo de líquido", "LIQUIDO PERITONEAL", "POSITIVO", "Klebsiella pneumoniae", "", "MEROPENEM <=0.25 · AMIKACINA <=2"),
      cul("000942", "PRUEBA FICTICIA SANGRE", "r3", "2026-11-04 08:00", "Hemocultivo", "SANGRE PERIFERICA", "POSITIVO", "Pseudomonas aeruginosa", "MEROPENEM >=16 · CEFEPIME 32", "AMIKACINA 8"),
      cul("000942", "PRUEBA FICTICIA SANGRE", "r4", "2026-11-05 08:00", "Urocultivo", "ORINA", "POSITIVO", "Enterococcus faecalis", "", "AMPICILINA <=2"),
      cul("000942", "PRUEBA FICTICIA SANGRE", "r5", "2026-11-01 08:00", "Urocultivo", "ORINA", "POSITIVO", "Escherichia coli", "", ""),
      cul("000943", "PRUEBA FICTICIA NEGATIVO", "r6", "2026-11-07 09:00", "Cultivo de secreción", "SECRECION DE HERIDA", "Negativo"), cul("000943", "PRUEBA FICTICIA NEGATIVO", "r7", "2026-11-07 09:00", "Hemocultivo", "SANGRE", "Negativo"),
      cul("000943", "PRUEBA FICTICIA NEGATIVO", "r8", "2026-11-07 09:00", "Urocultivo", "ORINA", "Negativo"),
      cul("000945", "PRUEBA FICTICIA CONTAMINANTE", "r9", "2026-11-06 09:00", "Hemocultivo", "SANGRE", "POSITIVO", "Staphylococcus epidermidis", "OXACILINA >=4", "VANCOMICINA 1"),
      cul("000945", "PRUEBA FICTICIA CONTAMINANTE", "r10", "2026-11-06 09:00", "Cultivo", "PUNTA DE CATETER", "En proceso")] };
  const anC = sb.regAnalisis(fusC, [], [], "2026-12-20", cod), EC = (n) => anC[AN[0]].find((r) => r["Diagnóstico"] !== undefined && anC["Clave de seudónimos"].find((k) => k["ID episodio"] === n)["ID episodio (análisis)"] === r["ID episodio"]);
  const CU = (rep) => anC[AN[3]].find((r) => r["ID cultivo"].indexOf("|" + rep + "|") !== -1);
  check("C21a cultivo positivo de secreción de herida 5 días después de la cirugía: sitio herida, 5 días, posoperatorio 1, BLEE = multirresistente 1 → «ISQ probable (cultivo)» = 1 y «Germen multirresistente» = 1",
    CU("r1")["Sitio (grupo)"] === "Herida / tejidos blandos" && CU("r1")["Días desde la última cirugía"] === 5 && CU("r1")["Posoperatorio (1-30 d)"] === 1 && CU("r1")["Multirresistente (probable)"] === 1 && CU("r1")["Contaminante probable"] === 0
    && EC("c1")["ISQ probable (cultivo)"] === 1 && EC("c1")["Germen multirresistente"] === 1 && EC("c1")["Bacteriemia"] === "" && EC("c1")["Urocultivo positivo ≥ día 3"] === "", JSON.stringify([CU("r1"), sb.REG_EP_CULT.map((c) => EC("c1")[c])]));
  check("C21b la muestra tomada el MISMO día de la cirugía (líquido peritoneal, día 0) es abdominal pero no posoperatoria; sensible a todo = multirresistente 0",
    CU("r2")["Sitio (grupo)"] === "Abdominal (líquido, bilis o colección)" && CU("r2")["Días desde la última cirugía"] === 0 && CU("r2")["Posoperatorio (1-30 d)"] === 0 && CU("r2")["Multirresistente (probable)"] === 0, JSON.stringify(CU("r2")));
  check("C21c hemocultivo positivo → Bacteriemia = 1; resistente a meropenem → multirresistente 1; urocultivo positivo del día de estancia 4 → 1 (el del día del ingreso solo no contaría); sin cirugía con fecha la ISQ por cultivo queda vacía",
    EC("c2")["Bacteriemia"] === 1 && CU("r3")["Multirresistente (probable)"] === 1 && CU("r3")["Sitio (grupo)"] === "Sangre" && EC("c2")["Urocultivo positivo ≥ día 3"] === 1 && CU("r4")["Sitio (grupo)"] === "Orina" && CU("r5")["Multirresistente (probable)"] === ""
    && EC("c2")["Germen multirresistente"] === 1 && EC("c2")["ISQ probable (cultivo)"] === "" && CU("r3")["Días desde la última cirugía"] === "" && CU("r3")["Posoperatorio (1-30 d)"] === 0, JSON.stringify([CU("r3"), CU("r4"), CU("r5"), sb.REG_EP_CULT.map((c) => EC("c2")[c])]));
  check("C21d cultivos negativos → ISQ 0, Bacteriemia 0, urocultivo 0 y multirresistente 0 (en el cultivo y en el episodio)",
    EC("c3")["ISQ probable (cultivo)"] === 0 && EC("c3")["Bacteriemia"] === 0 && EC("c3")["Urocultivo positivo ≥ día 3"] === 0 && EC("c3")["Germen multirresistente"] === 0 && CU("r6")["Multirresistente (probable)"] === 0 && CU("r6")["Contaminante probable"] === 0
    && CU("r6")["Posoperatorio (1-30 d)"] === 1, JSON.stringify([CU("r6"), sb.REG_EP_CULT.map((c) => EC("c3")[c])]));
  check("C21e operado sin ningún cultivo: ISQ por cultivo 0, lo demás vacío; «SIN DATOS DE ISQ» en Manejo no es mención (0)",
    EC("c4")["ISQ probable (cultivo)"] === 0 && EC("c4")["Bacteriemia"] === "" && EC("c4")["Urocultivo positivo ≥ día 3"] === "" && EC("c4")["Germen multirresistente"] === "" && EC("c4")["ISQ mencionada (texto)"] === 0, JSON.stringify(sb.REG_EP_CULT.map((c) => EC("c4")[c])));
  check("C21f hemocultivo con solo estafilococo coagulasa negativo: contaminante probable 1 y Bacteriemia 0; el cultivo «En proceso» queda vacío; la ISQ escrita en el diagnóstico sí es mención (1)",
    CU("r9")["Contaminante probable"] === 1 && EC("c5")["Bacteriemia"] === 0 && CU("r10")["Multirresistente (probable)"] === "" && CU("r10")["Contaminante probable"] === "" && CU("r10")["Sitio (grupo)"] === "Punta de catéter" && EC("c5")["ISQ mencionada (texto)"] === 1,
    JSON.stringify([CU("r9"), CU("r10"), sb.REG_EP_CULT.map((c) => EC("c5")[c])]));
  const sitios = [["Urocultivo", "ORINA DE SONDA (CATETER)"], ["Cultivo", "ASPIRADO BRONQUIAL"], ["Cultivo", "LIQUIDO PLEURAL"], ["Cultivo", "LCR"], ["Coprocultivo", "HECES"], ["Cultivo", "BILIS"], ["Cultivo", "TEJIDO"], ["Cultivo", "EXUDADO VAGINAL"], ["", ""]].map(([t, m]) => sb.regCultivoSitio(t, m));
  check("C21g regCultivoSitio: orina de sonda es orina (no catéter), respiratorio / pleural, LCR, heces, bilis abdominal, tejido; lo no reconocido es «Otro» y sin texto queda vacío",
    JSON.stringify(sitios) === JSON.stringify(["Orina", "Respiratorio / pleural", "Respiratorio / pleural", "Líquido cefalorraquídeo", "Heces", "Abdominal (líquido, bilis o colección)", "Herida / tejidos blandos", "Otro", ""]), JSON.stringify(sitios));
  const m = (g, r, s) => sb.regCultivoMdr(1, g, s || "X", "", r);
  check("C21h regCultivoMdr: S. aureus resistente a oxacilina, enterococo resistente a vancomicina, 3 clases resistentes = 1; 2 clases = 0; positivo sin antibiograma ni marca = vacío; negativo = 0; sin resultado = vacío",
    m("Staphylococcus aureus", "OXACILINA >=4") === 1 && m("Enterococcus faecium", "VANCOMICINA >=32") === 1 && m("Escherichia coli", "CEFTRIAXONA · CIPROFLOXACINO · GENTAMICINA") === 1 && m("Escherichia coli", "CEFTRIAXONA · CIPROFLOXACINO") === 0
    && sb.regCultivoMdr(1, "Escherichia coli", "", "", "") === "" && sb.regCultivoMdr(0, "", "", "", "") === 0 && sb.regCultivoMdr("", "", "", "", "") === "" && sb.regCultivoMdr(1, "Klebsiella pneumoniae KPC", "", "", "") === 1);
  const isq = ["PO LAPE + ISQ SUPERFICIAL", "SIN DATOS DE SANGRADO NI ISQ", "SIN FIEBRE, CON ISQ PROFUNDA", "VIGILAR DATOS DE INFECCION DE HERIDA QUIRURGICA", "HERIDA QX INFECTADA, SE ABRE", "PROBABLE ISQ", "HERIDA LIMPIA. AFEBRIL", "NO ISQ. TOLERA DIETA"].map(sb.regIsqTexto);
  check("C21i regIsqTexto: cuenta la mención afirmada; no la negada, la vigilancia ni la sospecha en la misma oración", JSON.stringify(isq) === JSON.stringify([true, false, true, false, true, false, false, false]), JSON.stringify(isq));
  check("C21j las columnas nuevas de «Análisis · Cultivos» van al final, después de «Vigente»; nada del orden anterior cambió",
    JSON.stringify(sb.REG_ANALISIS[3].columnas.slice(-6)) === JSON.stringify(["Vigente", "Sitio (grupo)", "Días desde la última cirugía", "Posoperatorio (1-30 d)", "Multirresistente (probable)", "Contaminante probable"]) && sb.REG_ANALISIS[3].columnas.indexOf("Fuente") === 15);

  // ─── C22: Charlson simplificado y riesgo preoperatorio ──────────────────────────────────────────────────────────
  const X = (app, dx) => sb.regComorbilidades(app, dx || "", sb.REG_COMORB_1124), unos = (o) => Object.keys(o).filter((k) => o[k] === 1).join(",");
  const ch = (app, dx, edad) => { const r = sb.regCharlson_(sb.regComorbilidades(app, dx || ""), X(app, dx), edad, !!app.trim()); return [r.puntos, r.conEdad, r.calculable].join("/"); };
  const appPlan = "DM2, ERC EN HEMODIALISIS, NIEGA EVC";
  check("C22a «DM2, ERC EN HEMODIALISIS, NIEGA EVC» → Charlson 1 + 2 = 3 y EVC = 0; con 72 años, ajustado = 6; sin APP → puntos vacíos y «calculable» = 0",
    ch(appPlan, "", 72) === "3/6/1" && X(appPlan)["EVC"] === 0 && ch(appPlan, "", "") === "3//1" && ch("", "PIE DIABETICO", 60) === "//0", JSON.stringify([ch(appPlan, "", 72), X(appPlan), ch("", "PIE DIABETICO", 60)]));
  const casos = [["EVC ISQUEMICO HACE 2 AÑOS CON HEMIPARESIA DERECHA. USA CLOPIDOGREL", "", "EVC,Hemiplejía,Anticoagulante / antiagregante"], ["NIEGA EVC, DEMENCIA", "", ""], ["CIRROSIS CHILD B CON VARICES ESOFAGICAS", "", "Hepatopatía grave"],
    ["CA DE COLON CON METASTASIS HEPATICAS", "", "Metástasis"], ["LINFOMA NO HODGKIN EN QT", "", "Leucemia / linfoma"], ["VIH EN TRATAMIENTO. ALCOHOLISMO SOCIAL", "", "VIH / SIDA"], ["VIH NEGATIVO. ALCOHOLISMO CRONICO", "", "Alcoholismo"],
    ["QX: COLECISTECTOMIA HACE 5 AÑOS, CESAREA", "PO LAPE", "Cirugía abdominal previa"], ["NIEGA CRONICODEGENERATIVOS", "PO LAPE POR ULCERA DUODENAL PERFORADA", "Úlcera péptica"], ["ASA II. LUPUS, RETINOPATIA DIABETICA", "", "Enfermedad del tejido conectivo,Diabetes con daño a órgano blanco"],
    ["QUIRURGICOS NEGADOS", "PO COLECISTECTOMIA", ""]];
  const rc = casos.map(([a, d]) => unos(X(a, d)));
  check("C22b comorbilidades nuevas con la misma regla de negación; «ASA II» no es aspirina; el alcoholismo social no cuenta; la cirugía previa y el anticoagulante solo se buscan en el APP (el «PO LAPE» del diagnóstico es de este episodio)",
    JSON.stringify(rc) === JSON.stringify(casos.map((c) => c[2])), JSON.stringify(rc.map((v, i) => v === casos[i][2] ? "ok" : v + " ≠ " + casos[i][2])));
  check("C22c pesos: hepatopatía grave 3 (no 1 + 3), diabetes con daño 2 (no 1 + 2), metástasis 6 (no 2 + 6), VIH 6; edad: 49 = +0, 50 = +1, 85 = +4",
    ch("CIRROSIS CON HIPERTENSION PORTAL", "", 49) === "3/3/1" && ch("DM2 CON NEFROPATIA DIABETICA", "", 50) === "2/3/1" && ch("CANCER DE COLON METASTASICO", "", 85) === "6/10/1" && ch("VIH", "", 30) === "6/6/1" && ch("NIEGA CRONICODEGENERATIVOS", "", 30) === "0/0/1",
    JSON.stringify([ch("CIRROSIS CON HIPERTENSION PORTAL", "", 49), ch("DM2 CON NEFROPATIA DIABETICA", "", 50), ch("CANCER DE COLON METASTASICO", "", 85), ch("VIH", "", 30), ch("NIEGA CRONICODEGENERATIVOS", "", 30)]));
  check("C22d la lista original no cambió: regComorbilidades sin tercer argumento devuelve las mismas 10 columnas, y «Comorbilidades (n)» no cuenta las nuevas",
    Object.keys(sb.regComorbilidades("EVC", "")).length === 10 && sb.regComorbilidades("EVC", "")["EVC"] === undefined);
  const fusR = { "Pacientes": [pac("h1", "000951", "PRUEBA FICTICIA RIESGO", { "Edad": "74", "Sexo": "M", "Antecedentes (APP)": appPlan + ". EVC NEGADO", "Fecha de ingreso": "2026-11-01", "Fecha de egreso": "2026-11-09" }),
      pac("h2", "000952", "PRUEBA FICTICIA SIN APP", { "Edad": "74", "Fecha de ingreso": "2026-11-01", "Fecha de egreso": "2026-11-09" }), pac("h3", "000953", "PRUEBA FICTICIA NO OPERADA", { "Edad": "40", "Antecedentes (APP)": "NIEGA CRONICODEGENERATIVOS" })],
    "Cirugías": [cx("h1", "2026-11-01", "LAPE"), cx("h2", "2026-11-01", "LAPE")],
    "Labs": [lab("h1", "2026-11-01", "hb", "10"), lab("h1", "2026-11-01", "alb", "3.1"), lab("h1", "2026-11-01", "cr", "6.2")] };
  const anR = sb.regAnalisis(fusR, [], [], "2026-12-20", cod)[AN[0]];
  check("C22e en el episodio: Charlson 3 y 6 con edad; riesgo preoperatorio 6 de 6 (≥70 años, Charlson ≥3, cirugía el día del ingreso, albúmina <3.5, anemia, creatinina ≥1.5); «Comorbilidades (n)» sigue en 2",
    anR[0]["Charlson (puntos)"] === 3 && anR[0]["Charlson ajustado por edad"] === 6 && anR[0]["Charlson (calculable)"] === 1 && anR[0]["Riesgo preoperatorio simple (0-6)"] === 6 && anR[0]["EVC"] === 0 && anR[0]["Comorbilidades (n)"] === 2,
    JSON.stringify(sb.REG_EP_RIESGO.map((c) => [c, anR[0][c]])));
  check("C22f sin APP: Charlson vacío, «calculable» = 0, comorbilidades nuevas vacías y riesgo vacío; con APP y sin cirugía: Charlson 0 y riesgo vacío",
    anR[1]["Charlson (puntos)"] === "" && anR[1]["Charlson ajustado por edad"] === "" && anR[1]["Charlson (calculable)"] === 0 && anR[1]["EVC"] === "" && anR[1]["Riesgo preoperatorio simple (0-6)"] === ""
    && anR[2]["Charlson (puntos)"] === 0 && anR[2]["Charlson (calculable)"] === 1 && anR[2]["Riesgo preoperatorio simple (0-6)"] === "", JSON.stringify([anR[1], anR[2]].map((r) => sb.REG_EP_RIESGO.map((c) => r[c]))));

  // ─── Estructura: lo nuevo va AL FINAL de «Análisis · Episodios» y todo está en el Diccionario de variables ──────
  const colsE = sb.REG_ANALISIS[0].columnas, iMov = colsE.indexOf("Hora de egreso del censo");
  check("C18h las columnas nuevas de Episodios van al final, después de las del 24 nov anteriores, y ninguna columna que ya existía cambió de lugar",
    colsE.indexOf("Días con antibiótico (observados)") === iMov + 1 && colsE[colsE.length - 1] === "Riesgo preoperatorio simple (0-6)" && colsE.length === iMov + 1 + sb.REG_EP_LOTE_C.length
    && colsE.indexOf("Tabaquismo") === colsE.indexOf("Comorbilidades (n)") - 1 && colsE.indexOf("INR máximo") === colsE.indexOf("Cultivos (n)") - 1 && sb.REG_ANALISIS[sb.REG_ANALISIS.length - 1].nombre === AQ);
  const vars = sb.regVariables_().slice(1), sinDef = [];
  sb.REG_EP_LOTE_C.concat(sb.REG_CULT_NUEVAS).forEach((c) => { const v = vars.find((r) => r[1].split(" · ").indexOf(c) !== -1 && (r[0] === AN[0] || r[0] === AN[3])); if (!v || !/Sesgo|sesgo/.test(v[4])) sinDef.push(c); });
  sb.REG_CX_AN_COLUMNAS.forEach((c) => { if (!vars.some((r) => (r[0] === AQ || r[0] === "Todas") && r[1].split(" · ").indexOf(c) !== -1)) sinDef.push(AQ + "/" + c); });
  check("C18i el Diccionario de variables define cada columna nueva de Episodios y Cultivos CON su sesgo conocido, y todas las de «Análisis · Cirugías»", !sinDef.length, sinDef.join(" | "));
}

// ─── C19: «Análisis · Cirugías» (una fila por cirugía) y lo derivado, de punta a punta por actualizarRegistro ─────────
{
  const d = VACIO();
  const [p1, n1] = hospitalizado("q1", "PRUEBA FICTICIA QUIROFANO", "000961", { ingreso: "2026-11-10", dx: "PO HEMICOLECTOMIA DERECHA + APENDICITIS COMPLICADA", edad: "61" }, { app: "DM2, HAS",
    manejo: "MEROPENEM 1 G C/8 H", checklist: { sexo: "M", atb: true, atb_nombre: "MEROPENEM", npo: true, dispositivos: [{ id: "dv1", tipo: "PENROSE", lado: "DERECHO", sitio: "FID", gasto: "80 ML" }], cirugias: [
      { id: "cx-q1", fecha: "2026-11-10", procedimiento: "COLECISTECTOMIA LAPAROSCOPICA", sangrado: "50 ML", tipo: "urgencia", abordaje: "laparoscopica", clavien: "II", complicacion: "ILEO" },
      { id: "cx-q2", fecha: "2026-11-14", procedimiento: "DRENAJE DE ABSCESO RESIDUAL ABIERTO", sangrado: "MINIMO", cirujano: "DR. FICTICIO CIRUJANO" }] } });
  d.patients = [p1]; d.notes = [n1];
  d.archive = [egresado("aq9", "q9", "PRUEBA FICTICIA DUPLICADA", "000962", "2026-11-01", "2026-11-03", {}, { _egreso: "DUPLICADO (eliminado a mano)", checklist: { cirugias: [{ id: "cx-dup", fecha: "2026-11-02", procedimiento: "APENDICECTOMIA" }] } })];
  const st = { db: d, hoy: "2026-11-24" }; const r = makeSandbox(st).sb.actualizarRegistro();
  const Q = tab(st.ss, AQ).filter((x) => x["Vigente"] === "Sí"), E = episodiosDe(st.ss)("q1");
  const mias = Q.filter((x) => x["ID episodio"] === E["ID episodio"]).sort((a, b) => a["N.º de cirugía en el episodio"] - b["N.º de cirugía en el episodio"]);
  check("C19a 2 cirugías de la caja y 1 inferida del DX: 3 filas, numeradas por fecha (la inferida sin fecha al final) y solo la primera es índice; las mismas que «Cirugías (n)»",
    r.ok && mias.length === 3 && E["Cirugías (n)"] === 3 && JSON.stringify(mias.map((x) => [x["N.º de cirugía en el episodio"], x["Fecha"], x["Fuente"], x["Es índice"]]))
    === JSON.stringify([[1, "2026-11-10", "Caja Cirugías", 1], [2, "2026-11-14", "Caja Cirugías", 0], [3, "", "DX (inferida)", 0]]), JSON.stringify(mias));
  check("C19b «COLECISTECTOMIA LAPAROSCOPICA» → abordaje inferido Laparoscópica (y el elegido aparte); «DRENAJE … ABIERTO» → Abierta; día de estancia, días desde la previa, urgencia inferida, sangrado número o vacío, Clavien",
    mias[0]["Abordaje (inferido del texto)"] === "Laparoscópica" && mias[0]["Abordaje"] === "Laparoscópica" && mias[0]["Tipo"] === "Urgencia" && mias[0]["Clavien-Dindo"] === "II" && mias[0]["Sangrado (mL)"] === 50 && mias[0]["Día de estancia"] === 0
    && mias[0]["Urgencia inferida (día 0-1)"] === 1 && mias[0]["Días desde la cirugía previa"] === "" && mias[1]["Abordaje (inferido del texto)"] === "Abierta" && mias[1]["Días desde la cirugía previa"] === 4 && mias[1]["Urgencia inferida (día 0-1)"] === 0
    && mias[1]["Sangrado (mL)"] === "" && /sangrado sin número/.test(mias[1]["Revisar"]) && /sin urgencia/.test(mias[1]["Revisar"]) && mias[1]["Grupo"] === "Drenaje de absceso / colección", JSON.stringify(mias.slice(0, 2)));
  check("C19c reintervención por fila: la 2.ª a 4 días de la índice es no planeada (1); la inferida sin fecha con episodio de ≤30 días también; la índice 0 / 0; la sin fecha lleva «Fecha estimada» = ingreso y se dice en «Revisar»",
    mias[0]["Reintervención no planeada (probable)"] === 0 && mias[0]["Reintervención planeada (probable)"] === 0 && mias[1]["Reintervención no planeada (probable)"] === 1 && mias[2]["Reintervención no planeada (probable)"] === 1
    && mias[2]["Fecha estimada"] === "2026-11-10" && mias[0]["Fecha estimada"] === "" && /sin fecha/.test(mias[2]["Revisar"]) && /tomada de otra caja/.test(mias[2]["Revisar"]) && E["Reintervención no planeada (probable)"] === 1, JSON.stringify(mias));
  check("C19d datos del episodio repetidos en cada fila (dx principal, edad, defunción desconocida = vacío, sin egreso = vacío); la tarjeta DUPLICADA no entra en la pestaña",
    mias.every((x) => x["Dx principal"] === E["Dx principal"] && x["Edad (años)"] === 61 && x["Defunción en el episodio"] === "" && x["Días cirugía→egreso"] === "" && x["ID paciente"] === E["ID paciente"]) && Q.length === 3 && !Q.some((x) => /APENDICECTOMIA/.test(x["Procedimiento"])),
    JSON.stringify(Q.map((x) => x["Procedimiento"])));
  const tQ = JSON.stringify(st.ss.sheets[AQ].cells) + JSON.stringify(st.ss.sheets[AN[0]].cells) + JSON.stringify(st.ss.sheets[AN[3]].cells);
  check("C19e ni «Análisis · Cirugías» ni las columnas nuevas de Episodios y Cultivos llevan nombres, expedientes, el cirujano ni el id de la base", !/FICTICI[AO] (QUIROFANO|DUPLICADA|CIRUJANO)|00096\d|"q1"|cx-q1|dv1/.test(tQ), (tQ.match(/FICTICI[AO] (QUIROFANO|DUPLICADA|CIRUJANO)|00096\d|"q1"|cx-q1|dv1/) || [])[0]);
  check("C19f ids de cirugía únicos con prefijo Q-; el encabezado de la pestaña es el de la configuración y termina en «Vigente»",
    new Set(Q.map((x) => x["ID cirugía"])).size === 3 && Q.every((x) => /^Q-[0-9A-F]{12}$/.test(x["ID cirugía"])) && JSON.stringify(st.ss.sheets[AQ].cells[0]) === JSON.stringify(makeSandbox({ db: VACIO() }).sb.REG_CX_AN_COLUMNAS), JSON.stringify(Q.map((x) => x["ID cirugía"])));
  // Lo derivado de la foto de esa noche (cambio 18) llega a la hoja: una noche con antibiótico y ayuno, y el Penrose.
  check("C19g de punta a punta: la noche fotografiada da 1 día de antibiótico (meropenem: carbapenémico) y 1 de ayuno; 1 dispositivo, drenaje 1 día con gasto 80 mL; Charlson 1 (diabetes) y 3 con la edad; riesgo preoperatorio 1 (solo la cirugía de urgencia)",
    E["Días con antibiótico (observados)"] === 1 && E["Carbapenémico"] === 1 && E["Días en ayuno"] === 1 && E["Dispositivos (n)"] === 1 && E["Días con drenaje"] === 1 && E["Gasto máximo (mL)"] === 80 && E["Cobertura del diario (%)"] === 7.1
    && E["Charlson (puntos)"] === 1 && E["Charlson ajustado por edad"] === 3 && E["Riesgo preoperatorio simple (0-6)"] === 1 && E["Ayuno posoperatorio (días)"] === 1, JSON.stringify(makeSandbox({ db: VACIO() }).sb.REG_EP_LOTE_C.map((c) => [c, E[c]])));
  const s1 = snap(st.ss); makeSandbox(st).sb.actualizarRegistro();
  check("C19h idempotente: otra corrida con la misma base deja «Análisis · Cirugías» y todo lo demás igual", snap(st.ss) === s1);
  // Al día siguiente corrigen el texto de la cirugía de la caja: mismo «ID cirugía» de análisis (sale del id de la caja), sin fila nueva.
  const idAntes = mias[1]["ID cirugía"];
  d.notes[0].checklist.cirugias[1].procedimiento = "DRENAJE DE ABSCESO RESIDUAL ABIERTO + CIERRE DE PARED";
  st.hoy = "2026-11-25"; makeSandbox(st).sb.actualizarRegistro();
  const Q2 = tab(st.ss, AQ), fila2 = Q2.find((x) => x["ID cirugía"] === idAntes);
  check("C19i texto corregido en la caja al día siguiente: la fila conserva su ID (sale del id de la caja) y ahora es reintervención PLANEADA (cierre de pared); la pestaña nunca pierde filas",
    Q2.length === 3 && fila2 && fila2["Vigente"] === "Sí" && /CIERRE DE PARED/.test(fila2["Procedimiento"]) && fila2["Reintervención planeada (probable)"] === 1 && fila2["Reintervención no planeada (probable)"] === 0, JSON.stringify(Q2.map((x) => [x["ID cirugía"], x["Procedimiento"], x["Vigente"]])));
  const sbq = makeSandbox({ db: VACIO() }).sb;
  const ab = ["LAPAROSCOPIA DIAGNOSTICA CONVERTIDA A LAPE", "COLELAP", "CPRE + ESFINTEROTOMIA", "HERNIOPLASTIA INGUINAL ABIERTA", "APENDICECTOMIA", "RTUP"].map(sbq.regCxAbordajeTexto);
  check("C19j regCxAbordajeTexto: convertida, laparoscópica, endoscópica, abierta; si el texto no lo dice queda vacío (no se asume abierta)",
    JSON.stringify(ab) === JSON.stringify(["Convertida (laparoscópica → abierta)", "Laparoscópica", "Endoscópica / percutánea", "Abierta", "", "Endoscópica / percutánea"]), JSON.stringify(ab));
}

console.log("RESULT REGISTRO-PACIENTES: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
