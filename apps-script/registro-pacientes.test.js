// Pruebas offline del registro de pacientes (sin Google, sin Supabase, datos FICTICIOS).
// Carga registro-pacientes.gs en un sandbox con:
//   - una hoja de cálculo en memoria estricta como Google: cuadrícula de 1000×26 al crear una pestaña, fuera de ella
//     getRange falla; en texto plano las cadenas se guardan tal cual;
//   - un PostgREST simulado: filtros (gte/gt/eq/not.is.null, or=(…) de la paginación por llave, ->>), orden por varias
//     columnas comparando fechas por valor, tope de 1000 filas por petición, sin offset (si el script lo usa, falla),
//     errores 4xx/5xx con su código, 57014 (tiempo de la base agotado) y borrados entre dos páginas;
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
function postgrest(state, url) {
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
      if (!m) return { status: 400, body: { code: "PGRST100", message: "or mal formado" } };
      filtros.push((x) => cmpPg(x[m[1]], m[2]) > 0 || (cmpPg(x[m[1]], m[3]) === 0 && cmpPg(x[m[4]], m[5]) > 0));
    } else {
      const ruta = /^([a-z_]+)->>([a-z_]+)$/.exec(k);
      const valor = (x) => ruta ? ((x[ruta[1]] || {})[ruta[2]]) : x[k];
      let m;
      if (v === "not.is.null") filtros.push((x) => valor(x) !== null && valor(x) !== undefined);
      else if ((m = /^in\.\((.*)\)$/.exec(v))) { const lista = m[1].split(",").map((x) => x.replace(/^"|"$/g, "")); filtros.push((x) => lista.includes(String(valor(x)))); }
      else if ((m = /^(gte|gt|eq)\.(.*)$/.exec(v))) filtros.push((x) => { const c = cmpPg(valor(x), m[2]); return valor(x) !== null && valor(x) !== undefined && (m[1] === "gte" ? c >= 0 : m[1] === "gt" ? c > 0 : c === 0); });
      else return { status: 400, body: { code: "PGRST100", message: "filtro desconocido " + k } };
    }
  }
  if (!sel || !orden.length || lim === null) return { status: 400, body: { code: "PGRST100", message: "falta select/order/limit" } };
  let filas = (state.db[tabla] || []).filter((x) => filtros.every((f) => f(x)));
  filas.sort((x, y) => { for (const c of orden) { const d = cmpPg(x[c], y[c]); if (d) return d; } return 0; });
  filas = filas.slice(0, Math.min(lim, 1000));   // max_rows de Supabase
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
        const r = postgrest(state, url);
        if (state.alResponder) state.alResponder(tabla, state.nLlamadas[tabla], state.db);
        return { getResponseCode: () => r.status, getContentText: () => JSON.stringify(r.body) };
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
const snap = (ss) => JSON.stringify(Object.fromEntries(Object.keys(ss.sheets).sort().map((n) => [n, ss.sheets[n].cells])));

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
  const sinCambio = Object.keys(e0).filter((n) => n !== "Diccionario").every((n) => e0[n] === e1[n]);
  si.db.notes[0].pendientes = "+ USG (HECHO)"; makeSandbox(si).sb.actualizarRegistro(); const e2 = escritas();
  check("R12j escritura incremental: una corrida sin cambios no reescribe ninguna pestaña; un cambio reescribe solo su renglón",
    sinCambio && e2["Pacientes"] - e1["Pacientes"] === 1 && e2["Labs"] === e1["Labs"] && tab(si.ss, "Pacientes").find((x) => x["ID episodio"] === "p1")["Pendientes"] === "+ USG (HECHO)", JSON.stringify({ e0, e1, e2 }));
  // Capacidad: las pestañas nuevas no guardan columnas vacías y la cuenta incluye todas las hojas.
  const tot = Object.values(si.ss.sheets).reduce((s, h) => s + h.maxR * h.maxC, 0);
  check("R12k pestañas nuevas sin columnas de sobra y la cuenta de celdas incluye todas las hojas",
    si.ss.sheets["Labs"].maxC === 9 && si.ss.sheets["Diccionario"].maxC === 2 && si.ss.sheets["Pacientes"].maxC === 48 && JSON.stringify(si.ss.sheets["Diccionario"].cells).includes('"' + tot + ' de 10000000'), String(tot));
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
  s2.alEscribir = (hoja) => { if (hoja === "Imagen del robot (RIS)") s2.reloj = 320000; };
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
  check("R29d Por completar: el hospitalizado incompleto (con nombre y cama) y los egresados de los últimos 30 días; ni el completo ni el egreso de hace 48 días",
    !PC.h1 && !PC.e3 && PC.h2 && PC.h2["Nombre"] === "PRUEBA FICTICIA INCOMPLETA" && PC.h2["Cama"] === "3-602"
    && PC.h2["Falta"] === "APP · peso · talla · dx principal · 1 cirugía sin urgencia/abordaje/Clavien" && PC.h2["Faltantes (n)"] === 5
    && PC.e2 && /^motivo del egreso · /.test(PC.e2["Falta"]) && PC.e1 && !/motivo del egreso/.test(PC.e1["Falta"]),
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

console.log("RESULT REGISTRO-PACIENTES: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
