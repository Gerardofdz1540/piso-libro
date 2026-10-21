// Pruebas offline del registro de pacientes (sin Google, sin Supabase, datos FICTICIOS).
// Carga registro-pacientes.gs en un sandbox con una hoja de cálculo en memoria (estricta como Google: cuadrícula de
// 1000×26 al crear una pestaña, fuera de ella getRange falla; en texto plano las cadenas se guardan tal cual) y un
// Supabase simulado (paginado, con filtros por fecha) y verifica: episodios, pestañas, fusión que nunca borra (Vigente),
// escritura segura, lecturas incrementales, respaldo semanal y que nada de pacientes llegue al registro de ejecución.
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
    sh.setFrozenRows = () => sh;
    sh.clearContents = () => { sh.cells = []; };
    sh.getRange = (r, c, nr, nc) => {
      if (r < 1 || c < 1 || r - 1 + nr > sh.maxR || c - 1 + nc > sh.maxC) throw new Error("Exception: The coordinates of the range are outside the dimensions of the sheet.");
      const range = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const row = sh.cells[r - 1 + i] || []; const v = row[c - 1 + j]; return v === undefined ? "" : v; })),
        setNumberFormat: (f) => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sh.fmt[(r + i) + ":" + (c + j)] = f; return range; },
        setValues: (vals) => {
          if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error("setValues: tamaño distinto al rango");
          if (state0.failWriteOn === sh.name) throw new Error("Exception: Service Spreadsheets timed out");
          sh.writes++;
          vals.forEach((row, i) => { sh.cells[r - 1 + i] = sh.cells[r - 1 + i] || []; row.forEach((v, j) => {
            const texto = sh.fmt[(r + i) + ":" + (c + j)] === "@";
            // Como Google: en texto plano se guarda tal cual; fuera de texto plano «=…» sería fórmula y «'» se quita.
            if (!texto && typeof v === "string" && v[0] === "=") throw new Error("se escribió una fórmula: " + v.slice(0, 20));
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
  return { sheets, id: id || "libro1", getId() { return this.id; }, getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet(n)) };
}
const state0 = {};
// URL que UrlFetchApp acepta: esquema y host simples; ruta y consulta solo con caracteres de RFC 3986 (sin [ ] # en la
// consulta) y cada % seguido de dos dígitos hexadecimales.
function urlValida(url) {
  const m = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9\-._~!$&'()*+,;=:@\/%]*)(\?[A-Za-z0-9\-._~!$&'()*+,;=:@\/?%]*)?$/.exec(url);
  return !!m && !/%(?![0-9A-Fa-f]{2})/.test(url);
}

function makeSandbox(state) {
  const calls = [], logs = [], triggers = [];
  const ss = state.ss || (state.ss = makeSpreadsheet());
  state.props = state.props || {};
  state.drive = state.drive || { files: [], trashed: [] };
  state0.failWriteOn = state.failWriteOn || null;
  const sb = {
    console, JSON, Math, Date, Object, Array, String, Number, RegExp, isNaN, encodeURIComponent, decodeURIComponent,
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k === "SUPABASE_KEY" ? (state.sinLlave ? null : "svc") : (state.props[k] === undefined ? null : state.props[k])),
      setProperty: (k, v) => { state.props[k] = v; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !state.ocupado, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => "America/Mexico_City" },
    Utilities: { formatDate: () => state.hoy || "2026-10-21" },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (state.standalone ? null : ss),
      openById: (id) => { state.abiertoPorId = id; return ss; },
      getUi: () => ({ createMenu: () => { const m = { items: [], addItem: (a, b) => { m.items.push(b); return m; }, addToUi: () => { state.menu = m.items; } }; return m; } })
    },
    DriveApp: {
      getFileById: (id) => {
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
        after: (ms) => ({ create: () => { const t = { fn, after: ms, getHandlerFunction: () => fn }; triggers.push(t); (state.continuaciones = state.continuaciones || []).push(ms); return t; } })
      }) })
    },
    UrlFetchApp: {
      fetch(url, opts) {
        // Como Google (21 oct 2026, primera corrida real): una URL con caracteres fuera de RFC 3986 (>, espacio, {, |, [ en
        // la consulta…) o un % mal formado no sale: «Exception: Invalid argument: <url>».
        if (!urlValida(url)) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Invalid argument: " + url); }
        if (state.rechazaUrl && state.rechazaUrl.test(url)) { calls.push({ m: "rechazada", raw: url, u: url }); throw new Error("Exception: Invalid argument: " + url); }
        const u = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, ""));
        calls.push({ m: (opts && opts.method) || "get", raw: url, u, headers: opts && opts.headers });
        const tabla = /\/rest\/v1\/([a-z_]+)\?/.exec(u)[1];
        if (state.codigo && state.codigo[tabla]) return { getResponseCode: () => 400, getContentText: () => JSON.stringify({ code: state.codigo[tabla], message: "column PACIENTE FICTICIO SECRETO does not exist", details: "000123" }) };
        if (state.falla && state.falla[tabla]) return { getResponseCode: () => state.falla[tabla], getContentText: () => JSON.stringify({ message: "detalle con PACIENTE FICTICIO SECRETO" }) };
        const lim = +/limit=(\d+)/.exec(u)[1], off = +/offset=(\d+)/.exec(u)[1];
        if (state.maxFilas && state.maxFilas[tabla] !== undefined && lim > state.maxFilas[tabla]) throw new Error("Exception: Response too large");
        let filas = (state.db[tabla] || []).slice();
        if (/_restaurado_a=not\.is\.null/.test(u)) filas = filas.filter((a) => a.note_data && a.note_data._restaurado_a).map((a) => ({ id: a.id, de: (a.patient_data || {})._supa_id || null, a: a.note_data._restaurado_a }));
        if (/order=(archived_at|scraped_at)\.asc/.test(u)) { const col = /order=([a-z_]+)\.asc/.exec(u)[1]; filas.sort((x, y) => String(x[col] || "").localeCompare(String(y[col] || "")) || String(x.id).localeCompare(String(y.id))); }
        const f = /&([a-z_]+)=gte\.([^&]+)/.exec(u);
        if (f) filas = filas.filter((x) => String(x[f[1]] || "") >= f[2]);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(filas.slice(off, off + lim)) };
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
    winlab_labs: [{ id: 1, exp: "000123", paciente: "PRUEBA FICTICIA UNO", fecha: "2026-10-19", data: { hb: 12.0, leucos: "11.0", vacio: "" }, scraped_at: "2026-10-19T08:00:00+00:00" },
      { id: 2, exp: "000555", paciente: "PRUEBA FICTICIA CINCO", fecha: "2026-10-01", data: { cr: "2.1" }, scraped_at: "2026-10-01T08:00:00+00:00" }],
    winlab_cultivos: [{ exp: "000123", cama: "3-201", nombre: "PRUEBA FICTICIA UNO", fecha: "2026-10-17", tipo: "HEMOCULTIVO", germen: "", resultado: "NEGATIVO", texto_origen: "SIN DESARROLLO" }],
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
  check("R1n robots: labs de WinLab (sin vacíos, también de un expediente sin episodio), cultivos y RIS con su episodio",
    tab(ss, "Labs del robot (WinLab)").length === 3 && tab(ss, "Labs del robot (WinLab)").some((x) => x["Expediente"] === "000555" && x["Valor"] === "2.1")
    && tab(ss, "Cultivos del robot (WinLab)")[0]["Resultado"] === "NEGATIVO" && tab(ss, "Imagen del robot (RIS)")[0]["ID episodio"] === "p1" && tab(ss, "Imagen del robot (RIS)")[0]["Reporte"] === "APÉNDICE ENGROSADO");
  check("R1o texto que parece fórmula («=SOLO AYUNO», «+ USG») se guarda tal cual en texto plano (sin apóstrofo)", byId.p1["Manejo"] === "=SOLO AYUNO" && byId.p1["Pendientes"] === "+ USG");
  check("R1p solo GET, con la llave, paginado y ordenado; la primera corrida lee todo (sin filtro de fecha)",
    calls.every((c) => c.m === "get" && c.headers.apikey === "svc") && calls.some((c) => /notes\?.*limit=20&offset=0/.test(c.u)) && calls.every((c) => /order=[a-z_]+\.asc/.test(c.u)) && !calls.some((c) => /gte\./.test(c.u)));
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
  st.failWriteOn = "Labs";
  let e2 = null; try { makeSandbox(st).sb.actualizarRegistro(); } catch (e) { e2 = String(e.message); }
  st.failWriteOn = null;
  check("R3b una escritura que falla no vacía la pestaña (antes se vaciaba primero)", !!e2 && tab(st.ss, "Labs").length > 0 && tab(st.ss, "Pacientes").length === pacAntes, e2);
  makeSandbox(st).sb.actualizarRegistro();
  check("R3c y la siguiente corrida sigue completa", tab(st.ss, "Labs").length === 7 && tab(st.ss, "Pacientes").length === 4);
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
  check("R3h paginado completo y la página se achica si la respuesta es demasiado grande (20 → 10 → 5)", tab(mp.ss, "Pacientes").length === 48 && mp.calls.some((c) => /notes\?.*limit=5&/.test(c.u)) && !mp.calls.some((c) => /notes\?.*limit=20&offset=5/.test(c.u)));
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
    r1.ok && r1.pendiente === true && (st.continuaciones || []).includes(600000) && !!st.props.REG_CURSOR_archive && n1 < 4 && /Sí: quedan filas/.test(JSON.stringify(st.ss.sheets["Diccionario"].cells)), JSON.stringify({ r1, n1 }));
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
    sr.hoy = "2026-10-" + String(1 + i * 7).padStart(2, "0");
    sr.props.REG_ULTIMO_RESPALDO = i === 0 ? undefined : new Date(Date.now() - 8 * 86400000).toISOString();
    makeSandbox(sr).sb.actualizarRegistro();
  }
  const vivas = sr.drive.files.filter((f) => !f.trashed).map((f) => f.name.slice(-10)).sort();
  check("R4d un respaldo por semana y quedan los últimos 5 (los viejos a la papelera de Drive)", sr.drive.files.length === 7 && vivas.length === 5 && vivas[0] === "2026-10-15" && sr.drive.trashed.length === 2, JSON.stringify(vivas));
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
    m1.sb.regUrl_("t", "a,b:c->>d", "x,id", "c->>d=not.is.null&f=gte.2026-10-01T00:00:00+00:00", 5, 10)
      === "https://vkxplmrzyqlamxpbtmes.supabase.co/rest/v1/t?select=a%2Cb%3Ac-%3E%3Ed&c-%3E%3Ed=not.is.null&f=gte.2026-10-01T00%3A00%3A00%2B00%3A00&order=x.asc%2Cid.asc&limit=5&offset=10");
  // Si Google rechaza una URL: falla de inmediato (sin achicar la página 10 veces), dice por qué, sin URL, llave ni datos.
  const sr = { db: db(), rechazaUrl: /restaurado_a/ };
  const mr = makeSandbox(sr); let er = null;
  try { mr.sb.actualizarRegistro(); } catch (e) { er = String(e.message); }
  check("R8c URL rechazada: un solo intento, el error dice «Invalid argument» sin la URL, la llave ni datos, y la hoja queda sin tocar",
    !!er && /archive: no se pudo leer \(fila 0\): Exception: Invalid argument: \[url\]/.test(er) && mr.calls.filter((c) => c.m === "rechazada").length === 1
    && !/https?:|svc|supabase\.co/.test(er) && !nombres.test(er) && !sr.ss.sheets["Pacientes"], er);
  // Error de PostgREST (p. ej. una columna que no existe): solo el código, nunca su mensaje ni sus detalles.
  const sc = { db: db(), codigo: { winlab_cultivos: "42703" } };
  const mc = makeSandbox(sc); let ec = null;
  try { mc.sb.actualizarRegistro(); } catch (e) { ec = String(e.message); }
  check("R8d HTTP 400 de PostgREST: el error trae el código (42703) y no el mensaje ni los detalles", ec === "Supabase winlab_cultivos HTTP 400 (42703)" && mc.logs.every((l) => !/SECRETO|000123/.test(l)), ec);
}

console.log("RESULT REGISTRO-PACIENTES: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
