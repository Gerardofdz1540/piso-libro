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
        setValues: (vals) => {
          if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error("setValues: tamaño distinto al rango");
          if (state0.failWriteOn === sh.name) throw new Error("Exception: Service Spreadsheets timed out");
          if (state0.st && state0.st.msPorEscritura) state0.st.reloj += state0.st.msPorEscritura;
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
    Utilities: { formatDate: () => state.hoy || "2026-10-21" },
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
        if (state.rechazaUrl && state.rechazaUrl.test(url)) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Invalid argument: " + url); }
        if (state.msPorFetch) state.reloj += state.msPorFetch;
        const u = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, ""));
        calls.push({ m: (opts && opts.method) || "get", raw: url, u, headers: opts && opts.headers });
        const tabla = /\/rest\/v1\/([a-z_]+)\?/.exec(u)[1];
        state.nLlamadas = state.nLlamadas || {}; state.nLlamadas[tabla] = (state.nLlamadas[tabla] || 0) + 1;
        if (state.codigo && state.codigo[tabla]) return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ code: state.codigo[tabla], message: "column PACIENTE FICTICIO SECRETO does not exist", details: "000123" }) };
        if (state.agotado && state.agotado[tabla]) return { getResponseCode: () => 500, getContentText: () => JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }) };
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
        { __hasLink: false, NOMBRE: "UNO", "APELLIDOS COMPLETOS": "PRUEBA FICTICIA", __cells: ["", "PRUEBA FICTICIA", "UNO"] },
        { __hasLink: true, __target: true, __cells: ["", "", "F100", "18/10/2026 06:10", "18/10/2026 07:00", "CIRUGIA GENERAL"], "APELLIDOS COMPLETOS": "18/10/2026 06:10", NOMBRE: "18/10/2026 07:00", SEXO: "CIRUGIA GENERAL",
          valores: [{ estudio: "HEMOGLOBINA", valor: "12.0", unidad: "g/dL", referencia: "12-16" }, { estudio: "LEUCOCITOS", valor: "11.0", unidad: "10^3/uL", referencia: "4-10" }] },
        { __hasLink: true, __cells: ["", "", "F101", "17/10/2026 09:00", "19/10/2026 07:30", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOCULTIVO PERIFERICO", valor: "1", unidad: "DESARROLLO" }, { estudio: "NEGATIVO A", valor: "5", unidad: "DIAS" }] },
        { __hasLink: true, __cells: ["", "", "F102", "19/10/2026 05:00", "", "CIRUGIA GENERAL"] },
        { __hasLink: false, NOMBRE: "OTRO HOMONIMO", "APELLIDOS COMPLETOS": "PRUEBA FICTICIA", __cells: ["", "PRUEBA FICTICIA", "OTRO HOMONIMO"] },
        { __hasLink: true, __cells: ["", "", "F900", "18/10/2026 06:00", "18/10/2026 06:30", "MEDICINA INTERNA"], valores: [{ estudio: "HEMOGLOBINA", valor: "7.0", unidad: "g/dL" }] }
      ] } },
      { id: 2, exp: "000555", paciente: "PRUEBA FICTICIA CINCO", fecha: "2026-10-01", scraped_at: "2026-10-01T08:00:00+00:00", data: { reportes: [
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
  check("R1h Cirugías: las de la caja (sin las vacías), la Qx de texto de p4 y la de p3; todas vigentes",
    C.length === 3 && C.every((x) => x["Vigente"] === "Sí") && C.some((x) => x["ID episodio"] === "p1" && x["Procedimiento"] === "APENDICECTOMÍA LAPAROSCÓPICA" && x["Fecha"] === "2026-10-16")
    && C.some((x) => x["ID episodio"] === "p4" && x["Sangrado"] === "500 ML") && C.some((x) => x["ID episodio"] === "p3" && x["Procedimiento"] === "PLASTIA INGUINAL"), JSON.stringify(C));
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
    && /validado por el robot/.test(wF100["Atribución"]) && W.some((x) => x["Expediente"] === "000555" && /^CREATININA: 2\.1 mg\/dL/.test(x["Valores"]) && /Sin encabezado/.test(x["Atribución"])), JSON.stringify(W));
  check("R1n2 cultivos de WinLab desde el reporte (hemocultivo negativo a 5 días) y RIS con su episodio",
    WC.length === 1 && WC[0]["Tipo"] === "Hemocultivo" && WC[0]["Resultado"] === "Negativo" && WC[0]["Detalle"] === "Sin desarrollo a 5 días" && WC[0]["Fuente"] === "Tabla del reporte" && WC[0]["Toma"] === "2026-10-17 09:00"
    && tab(ss, "Imagen del robot (RIS)")[0]["ID episodio"] === "p1" && tab(ss, "Imagen del robot (RIS)")[0]["Reporte"] === "APÉNDICE ENGROSADO", JSON.stringify(WC));
  check("R1o texto que parece fórmula («=SOLO AYUNO», «+ USG») se guarda tal cual en texto plano (sin apóstrofo)", byId.p1["Manejo"] === "=SOLO AYUNO" && byId.p1["Pendientes"] === "+ USG");
  check("R1p solo GET, con la llave, paginado y ordenado; la primera corrida lee todo (sin filtro de fecha)",
    calls.every((c) => c.m === "get" && c.headers.apikey === "svc") && calls.some((c) => /notes\?.*limit=20$/.test(c.u)) && !calls.some((c) => /offset/.test(c.u)) && !st.usoOffset && calls.every((c) => /order=[a-z_]+\.asc/.test(c.u)) && !calls.some((c) => /gte\./.test(c.u)));
  check("R1q el registro de ejecución solo tiene conteos (ningún nombre ni expediente)", logs.length >= 1 && logs.every((l) => !nombres.test(l)), logs.join(" | "));
  check("R1s el Diccionario dice cuántas celdas usa y que no hay carga pendiente", /Celdas usadas/.test(JSON.stringify(ss.sheets["Diccionario"].cells)) && /"Carga en curso","No"/.test(JSON.stringify(ss.sheets["Diccionario"].cells)));
  check("R1r respaldo semanal: la primera corrida guarda una copia y anota la fecha", st.drive.files.length === 1 && /^Respaldo — Registro de pacientes — 2026-10-21$/.test(st.drive.files[0].name) && !!st.props.REG_ULTIMO_RESPALDO && !!st.props.REG_ULTIMA_CORRIDA);
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
  const C = tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] === "p1");
  check("R2f cirugía corregida: la nueva Vigente Sí y la de antes se conserva con Vigente No", C.length === 2 && C.some((x) => /CORREGIDA/.test(x["Procedimiento"]) && x["Vigente"] === "Sí") && C.some((x) => x["Procedimiento"] === "APENDICECTOMÍA LAPAROSCÓPICA" && x["Vigente"] === "No"), JSON.stringify(C));
  check("R2g las cirugías y labs de los egresados (episodio fuera de la base hoy) siguen Vigente Sí", tab(st.ss, "Cirugías").filter((x) => x["ID episodio"] !== "p1").every((x) => x["Vigente"] === "Sí") && tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p3").length === 1);
  check("R2h Labs de p1: el nuevo se agrega, los anteriores siguen", tab(st.ss, "Labs").filter((x) => x["ID episodio"] === "p1").length === 6);
  const S = tab(st.ss, "Signos vitales").filter((x) => x["ID episodio"] === "p1").map((x) => x["Fecha"] + "=" + x["FC"]).sort();
  check("R2i Signos se acumulan: el día que la app ya soltó (20/10) sigue; el 21 toma el valor del historial; el 22 entra", JSON.stringify(S) === JSON.stringify(["2026-10-20=96", "2026-10-21=80", "2026-10-22=76"]), JSON.stringify(S));
  check("R2j robots acumulan: lo de WinLab y RIS de ayer sigue aunque hoy no venga", tab(st.ss, "Labs del robot (WinLab)").length === 3 && tab(st.ss, "Imagen del robot (RIS)").length === 1);
  check("R2k el respaldo semanal no se repite antes de 7 días", st.drive.files.length === 1);
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
  // Respaldos: a los 7 días otra copia; quedan las últimas 5.
  const sr = { db: db(), hoy: "2026-10-01", props: {} };
  for (let i = 0; i < 7; i++) {
    sr.hoy = new Date(Date.UTC(2026, 9, 1 + i * 7)).toISOString().slice(0, 10);
    makeSandbox(sr).sb.actualizarRegistro();
  }
  const vivas = sr.drive.files.filter((f) => !f.trashed).map((f) => f.name.slice(-10)).sort();
  check("R4d un respaldo por semana y quedan los últimos 5 (los viejos a la papelera de Drive)", sr.drive.files.length === 7 && vivas.length === 5 && vivas[0] === "2026-10-15" && vivas[4] === "2026-11-12" && sr.drive.trashed.length === 2, JSON.stringify(vivas));
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
  const todas = m1.calls.concat(m2.calls);
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

// ─── R9: WinLab con la regla de identidad de la app y cultivos (copias de index.html) ────────────────────────────
{
  const sb = makeSandbox({ db: db() }).sb;
  const enc = (ap, nom) => ({ __hasLink: false, NOMBRE: nom, "APELLIDOS COMPLETOS": ap, __cells: ["", ap, nom] });
  const rep = (folio, extra) => Object.assign({ __hasLink: true, __cells: ["", "", folio, "10/10/2026 06:00", "10/10/2026 07:00", "CIRUGIA GENERAL"], valores: [{ estudio: "HEMOGLOBINA", valor: "10" }] }, extra || {});
  const folios = (fila) => sb.regWlDelPaciente(fila).map((x) => x.rep.__cells[2]);
  const fila = { paciente: "PRUEBA FICTICIA ANA MARIA", reportes: [rep("A0"), enc("PRUEBA FICTICIA", "ANA"), rep("A1"), rep("A2", { __target: true }), enc("PRUEBA FICTICIA", "ANA MARIA"), rep("A3"), enc("PRUEBA FICTICIA", "LUISA"), rep("A4", { __target: true })] };
  check("R9a identidad: encabezado con el nombre completo entra; con menos nombres solo si el robot lo validó; antes del primer encabezado y de otro paciente no",
    JSON.stringify(folios(fila)) === JSON.stringify(["A2", "A3"]), JSON.stringify(folios(fila)));
  check("R9b tolera una letra cambiada por el OCR (FICTISIA ≈ FICTICIA) pero no otro nombre de pila",
    JSON.stringify(folios({ paciente: "PRUEBA FICTICIA ANA MARIA", reportes: [enc("PRUEBA FICTISIA", "ANA MARIA"), rep("B1"), enc("PRUEBA FICTICIA", "ANA LUISA"), rep("B2")] })) === JSON.stringify(["B1"]));
  check("R9c sin encabezados (búsqueda de un solo paciente) entra todo; reportes sin valores no", JSON.stringify(folios({ paciente: "X Y Z", reportes: [rep("C1"), rep("C2", { valores: [] })] })) === JSON.stringify(["C1"]));
  // Mismo reporte en dos capturas: la que trae más valores manda; una posterior con menos no la pisa.
  const acc = { labs: {}, cultivos: {} };
  const r1 = rep("D1", { valores: [{ estudio: "HB", valor: "9" }] }), r2 = rep("D1", { valores: [{ estudio: "HB", valor: "9" }, { estudio: "PLT", valor: "150" }] });
  sb.regWlAcumular(acc, [{ exp: "1", paciente: "X", scraped_at: "2026-10-10T08:00:00Z", reportes: [r1] }, { exp: "1", paciente: "X", scraped_at: "2026-10-11T08:00:00Z", reportes: [r2] }, { exp: "1", paciente: "X", scraped_at: "2026-10-12T08:00:00Z", reportes: [r1] }]);
  const L = Object.values(acc.labs);
  check("R9d el mismo reporte en varias capturas es un solo renglón, con la captura de más valores", L.length === 1 && L[0]["Estudios"] === 2 && L[0]["Capturado"] === "2026-10-11T08:00:00Z" && /PLT: 150/.test(L[0]["Valores"]), JSON.stringify(L));
  // Cultivo del PDF: germen con marcas, antibiograma S/I/R, UFC y texto; una captura posterior solo con la tabla no lo pisa.
  const pdf = rep("E1", { valores: [{ estudio: "CULTIVO", valor: "POSITIVO", referencia: "Sin desarrollo" }], cultivo_texto: "TEXTO FICTICIO DEL REPORTE",
    cultivo: { secciones: [{ tipo: "Urocultivo", muestra: "ORINA", resultado: "POSITIVO", germenes: [{ nombre: "Escherichia coli", flags: ["BLEE"], ufc: ">100000", antibiograma: [{ antibiotico: "AMIKACINA", cim: "<=2", interp: "S" }, { antibiotico: "CEFTRIAXONA", interp: "R" }, { antibiotico: "CEFEPIME", interp: "I" }] }] }] } });
  const soloTabla = rep("E1", { valores: [{ estudio: "CULTIVO", valor: "POSITIVO", referencia: "Sin desarrollo" }] });
  const ac2 = { labs: {}, cultivos: {} };
  sb.regWlAcumular(ac2, [{ exp: "2", paciente: "X", scraped_at: "2026-10-10T08:00:00Z", reportes: [pdf] }, { exp: "2", paciente: "X", scraped_at: "2026-10-11T08:00:00Z", reportes: [soloTabla] }]);
  const C = Object.values(ac2.cultivos);
  check("R9e cultivo del PDF: positivo con germen y marcas, S/I/R, UFC y texto; la captura posterior solo con la tabla no lo pisa",
    C.length === 1 && C[0]["Resultado"] === "POSITIVO" && C[0]["Germen"] === "Escherichia coli (BLEE)" && C[0]["Sensibles"] === "AMIKACINA <=2" && C[0]["Intermedios"] === "CEFEPIME" && C[0]["Resistentes"] === "CEFTRIAXONA"
    && C[0]["UFC"] === ">100000" && C[0]["Tipo"] === "Urocultivo" && C[0]["Muestra"] === "ORINA" && C[0]["Fuente"] === "PDF del reporte" && C[0]["Texto del reporte"] === "TEXTO FICTICIO DEL REPORTE", JSON.stringify(C));
  const C3 = sb.regWlCultivos(soloTabla), C4 = sb.regWlCultivos(rep("E2", { valores: [{ estudio: "CULTIVO SECRECION", valor: "Klebsiella pneumoniae" }] })), C5 = sb.regWlCultivos(rep("E3"));
  check("R9f cultivo de la tabla: POSITIVO sin germen, germen en el valor, y un reporte que no es cultivo no da nada",
    C3.length === 1 && C3[0].positivo && /POSITIVO \(germen/.test(C3[0].organismo) && C4[0].organismo === "Klebsiella pneumoniae" && C4[0].tipo === "Cultivo de herida/secreción" && C5.length === 0, JSON.stringify([C3, C4, C5]));
  check("R9g valores: sección, unidad y referencia; archivos incrustados fuera", sb.regWlValores({ valores: [{ seccion: "BH", estudio: "HB", valor: "9", unidad: "g/dL", referencia: "12-16" }, { estudio: "PDF", valor: "data:application/pdf;base64,AAAA" }, { estudio: "", valor: "" }] })
    === "[BH] HB: 9 g/dL (ref. 12-16)\nPDF: [archivo]");
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
  const st = { db: db(), reloj: 0, msPorFetch: 35000 };
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
  // Tope de vueltas extra por día (los disparadores de una cuenta personal tienen 90 min al día).
  const sc = { db: db(), hoy: "2026-10-21", props: { REG_CONTINUACIONES: JSON.stringify({ dia: "2026-10-21", n: 8 }) } };
  const mc = makeSandbox(sc); mc.sb.REG_CURSORES.archive.tope = 1;
  const rc = mc.sb.actualizarRegistro();
  check("R11f con las 8 vueltas del día usadas no programa otra: avisa y sigue en la corrida de la noche",
    rc.pendiente && !(sc.continuaciones || []).length && /vueltas extra/.test(JSON.stringify(sc.ss.sheets["Diccionario"].cells)) && mc.triggers.every((t) => t.fn !== "continuarRegistro"));
  const sd = { db: db(), hoy: "2026-10-22", props: { REG_CONTINUACIONES: JSON.stringify({ dia: "2026-10-21", n: 8 }) } };
  const md = makeSandbox(sd); md.sb.REG_CURSORES.archive.tope = 1; md.sb.actualizarRegistro(); md.sb.actualizarRegistro();
  check("R11g al día siguiente el contador empieza de nuevo y nunca quedan dos continuaciones programadas", (sd.continuaciones || []).length === 2 && md.triggers.filter((t) => t.fn === "continuarRegistro").length === 1 && JSON.parse(sd.props.REG_CONTINUACIONES).n === 2);
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
  // Respaldo por días de calendario: a los 6 días no, a los 7 sí.
  const sr = { db: db(), hoy: "2026-10-21", props: { REG_ULTIMO_RESPALDO: "2026-10-15" } }; makeSandbox(sr).sb.actualizarRegistro();
  const sr2 = { db: db(), hoy: "2026-10-22", props: { REG_ULTIMO_RESPALDO: "2026-10-15T23:59:00.000Z" } }; makeSandbox(sr2).sb.actualizarRegistro();
  check("R12h respaldo por días de calendario: a los 6 días no se repite; a los 7 sí (aunque la hora sea un poco antes)", sr.drive.files.length === 0 && sr2.drive.files.length === 1 && sr2.props.REG_ULTIMO_RESPALDO === "2026-10-22");
  const sv = { db: db(), driveFalla: true }; const rv = makeSandbox(sv).sb.actualizarRegistro();
  check("R12i si Drive falla al respaldar, avisa y escribe de todos modos", rv.ok && tab(sv.ss, "Pacientes").length === 4 && /respaldo semanal/.test(rv.avisos.join(" ")));
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
    si.ss.sheets["Labs"].maxC === 8 && si.ss.sheets["Diccionario"].maxC === 2 && si.ss.sheets["Pacientes"].maxC === 43 && JSON.stringify(si.ss.sheets["Diccionario"].cells).includes('"' + tot + ' de 10000000'), String(tot));
}

console.log("RESULT REGISTRO-PACIENTES: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
