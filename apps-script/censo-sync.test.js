// Pruebas offline del Apps Script de sincronización (sin Google, sin Supabase).
// Carga censo-sync.gs en un sandbox con stubs de UrlFetchApp/Logger/CacheService/MailApp y
// verifica la RECONCILIACIÓN: archivar antes de borrar, mover en vez de borrar, intercambios,
// guardas, throttle de sync_log y watchdog de labs.
//   node apps-script/censo-sync.test.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "censo-sync.gs"), "utf8");

function makeSandbox(state) {
  const calls = [];
  const cache = {};
  const logs = [];
  const mails = [];
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const sb = {
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k === "SUPABASE_KEY" ? "svc" : state.props && state.props[k] || null),
      setProperty: (k, v) => { state.props = state.props || {}; state.props[k] = v; },
      deleteProperty: (k) => { if (state.props) delete state.props[k]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    Utilities: { formatDate: () => "09/10/2026" },
    ScriptApp: {}, SpreadsheetApp: {}, LockService: {},
    UrlFetchApp: {
      fetch(url, opts) {
        const m = ((opts && opts.method) || "get").toUpperCase();
        const u = url.replace(/^https?:\/\/[^/]+/, "");
        let body = null;
        try { body = opts && opts.payload ? JSON.parse(opts.payload) : null; } catch (_) { body = opts.payload; }
        calls.push({ m, u, body });
        const h = state.handler && state.handler(m, u, body, calls);
        if (h) return resp(h.code, h.body);
        if (m === "GET" && u.startsWith("/rest/v1/patients?select=id,cama,exp,nombre,updated_by")) return resp(200, state.cur || []);
        if (m === "GET" && /^\/rest\/v1\/patients\?id=eq\./.test(u)) {
          const id = decodeURIComponent(u.match(/id=eq\.([^&]+)/)[1]);
          const row = (state.full || {})[id];
          return resp(200, row ? [row] : []);
        }
        if (m === "POST" && u.startsWith("/rest/v1/archive")) return resp(201, "");
        if (m === "POST" && u.startsWith("/rest/v1/sync_log")) return resp(201, "");
        if (m === "POST" && u.startsWith("/rest/v1/patients?on_conflict=cama")) return resp(201, "");
        if (m === "PATCH") return resp(204, "");
        if (m === "DELETE") return resp(204, "");
        if (m === "GET" && u.startsWith("/rest/v1/winlab_labs")) return resp(200, state.labs || []);
        return resp(500, "unhandled " + m + " " + u);
      }
    }
  };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: "censo-sync.gs" });
  return { sb, calls, logs, mails, cache };
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); } };
const row = (cama, exp, extra) => Object.assign({ cama, nombre: "P " + exp, exp, es_mio: true }, extra || {});
const seq = (calls, pred) => calls.findIndex(pred);
// Mapa "fuera de la hoja desde…" ya vencido (20 min) para los ids dados → el retiro procede.
const missingOld = (ids) => ({ PL_MISSING_SINCE: JSON.stringify(Object.fromEntries(ids.map((id) => [id, Date.now() - 20 * 60000]))) });

// ── 0) Periodo de gracia: la primera corrida sin el paciente NO lo retira (corte/pegado en la hoja)
{
  const cur = [{ id: "a1", cama: "3-101", exp: "1", updated_by: "sheet-sync" }, { id: "b1", cama: "UCI 7", exp: "2", updated_by: "sheet-sync" }];
  const full = { b1: { id: "b1", cama: "UCI 7", nombre: "B DOS", exp: "2", notes: [{ patient_id: "b1", lab_history: [{ fecha: "2026-10-11", labs: { hb: "9" } }] }] } };
  const sheet = [row("3-101", "1")]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const st = { cur, full, props: {} };
  const { sb, calls } = makeSandbox(st);
  const retired = sb.syncPatients_("svc", sheet);
  const since = JSON.parse(st.props.PL_MISSING_SINCE || "{}");
  check("T0 gracia: UCI 7 desaparece de la hoja → NO se archiva ni borra; se anota desde cuándo falta; el upsert sigue",
    retired === 0 && !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive")) && typeof since.b1 === "number" && Date.now() - since.b1 < 5000
    && calls.some((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")), JSON.stringify({ retired, since, calls: calls.map((c) => c.m + " " + c.u) }));
  // 2ª corrida (3 s después): la fila ya está pegada en 3-162 → se MUEVE (PATCH), nada se borra y sale del mapa
  const sheet2 = sheet.concat([row("3-162", "2")]);
  const { sb: sb2, calls: c2 } = makeSandbox(st);
  sb2.syncPatients_("svc", sheet2);
  const patches = c2.filter((c) => c.m === "PATCH");
  check("T0b pegado en 3-162 dentro de la gracia → PATCH de cama b1→3-162, sin DELETE, y b1 sale del mapa de ausentes",
    patches.length === 1 && patches[0].u.includes("id=eq.b1") && patches[0].body.cama === "3-162" && !c2.some((c) => c.m === "DELETE")
    && !JSON.parse(st.props.PL_MISSING_SINCE || "{}").b1, JSON.stringify({ patches, props: st.props }));
  // Egreso real: sigue ausente 20 min → ahora sí se archiva y se retira
  const st3 = { cur, full, props: missingOld(["b1"]) };
  const { sb: sb3, calls: c3 } = makeSandbox(st3);
  const r3 = sb3.syncPatients_("svc", sheet);
  check("T0c ausente >12 min → archive + DELETE (egreso real)", r3 === 1 && c3.some((c) => c.u.startsWith("/rest/v1/archive")) && c3.some((c) => c.m === "DELETE" && c.u.includes("id=eq.b1")));
}

// ── 0d) Expediente corregido (misma cama, misma persona, otro exp) → PATCH del exp, nunca archivo ─
{
  const cur = [{ id: "a1", cama: "3-101", exp: "26-1234", nombre: "GARCIA LOPEZ JUAN", updated_by: "sheet-sync" }];
  const sheet = [row("3-101", "26-12345", { nombre: "GARCIA LOPEZ JUAN" })]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur, props: {} });
  sb.syncPatients_("svc", sheet);
  const patches = calls.filter((c) => c.m === "PATCH");
  check("T0d typo de expediente corregido en la hoja: PATCH exp sobre la misma fila; sin archive ni DELETE",
    patches.length === 1 && patches[0].u.includes("id=eq.a1") && patches[0].body.exp === "26-12345" && !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive")), JSON.stringify(patches));
  // Otra persona en la misma cama (nombre distinto) → sigue siendo reasignación (archivo inmediato)
  const cur2 = [{ id: "a1", cama: "3-101", exp: "26-1234", nombre: "GARCIA LOPEZ JUAN", updated_by: "sheet-sync" }];
  const sheet2 = [row("3-101", "26-9999", { nombre: "PEREZ RUIZ MARIA" })]; for (let i = 0; i < 12; i++) sheet2.push(row("4-" + (10 + i), String(100 + i)));
  const { sb: sb2, calls: c2 } = makeSandbox({ cur: cur2, full: { a1: { id: "a1", cama: "3-101", exp: "26-1234", nombre: "GARCIA LOPEZ JUAN", notes: [] } }, props: {} });
  sb2.syncPatients_("svc", sheet2);
  check("T0e otra persona en la cama → CAMA REASIGNADA (archive + DELETE), sin PATCH", c2.some((c) => c.u.startsWith("/rest/v1/archive")) && c2.some((c) => c.m === "DELETE") && !c2.some((c) => c.m === "PATCH"));
}

// ── 1) Retiro: archivar (con nota mapeada) ANTES de borrar nota y fila ───────────────────────────
{
  const cur = [{ id: "a1", cama: "3-101", exp: "1", updated_by: "sheet-sync" }, { id: "b1", cama: "3-102", exp: "2", updated_by: "sheet-sync" }];
  const full = { b1: { id: "b1", cama: "3-102", nombre: "B DOS", exp: "2", dx: "DX", esp: "CG", notes: [{ patient_id: "b1", pendientes: "nota B", lab_history: [{ fecha: "2026-10-08", labs: { hb: "12" } }], checklist: { atb: true } }] } };
  const sheet = [row("3-101", "1")].concat([]).concat([]); // 10+ filas para pasar la guarda
  for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur, full, props: missingOld(["b1"]) });
  const retired = sb.syncPatients_("svc", sheet);
  const iArc = seq(calls, (c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive"));
  const iDelN = seq(calls, (c) => c.m === "DELETE" && c.u.includes("/notes?patient_id=eq.b1"));
  const iDelP = seq(calls, (c) => c.m === "DELETE" && c.u.includes("/patients?id=eq.b1"));
  const arc = calls[iArc] && calls[iArc].body;
  check("T1 retiro: archive POST antes de los DELETE", iArc >= 0 && iDelN > iArc && iDelP > iDelN, JSON.stringify({ iArc, iDelN, iDelP }));
  check("T1b archive lleva paciente + nota en formato de la app (labHistory, _egreso) y archived_by sheet-sync",
    arc && arc.archived_by === "sheet-sync" && arc.patient_data.exp === "2" && arc.patient_data._supa_id === "b1"
    && arc.note_data.pendientes === "nota B" && Array.isArray(arc.note_data.labHistory) && arc.note_data.labHistory[0].labs.hb === "12"
    && arc.note_data.checklist.atb === true && /RETIRADO/.test(arc.note_data._egreso), JSON.stringify(arc));
  check("T1c el paciente que sigue (a1) no se toca; retired=1 y upsert al final", retired === 1 && !calls.some((c) => c.m === "DELETE" && c.u.includes("a1")) && calls[calls.length - 1].u.startsWith("/rest/v1/patients?on_conflict=cama"));
}

// ── 2) Si el archivo falla, NO se borra ──────────────────────────────────────────────────────────
{
  const cur = [{ id: "b1", cama: "3-102", exp: "2", updated_by: "sheet-sync" }];
  const full = { b1: { id: "b1", cama: "3-102", nombre: "B", exp: "2", notes: [] } };
  const sheet = []; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur, full, props: missingOld(["b1"]), handler: (m, u) => (m === "POST" && u.startsWith("/rest/v1/archive") ? { code: 500, body: "boom" } : null) });
  const retired = sb.syncPatients_("svc", sheet);
  check("T2 archive falla → sin DELETE, retired=0, upsert sigue", retired === 0 && !calls.some((c) => c.m === "DELETE") && calls.some((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")));
}
// ── 2b) Cama REASIGNADA cuyo archivo falla: el upsert NO toca esa cama (si no, la fila vieja se
//        reescribía con el exp nuevo y la nota del paciente anterior quedaba pegada al nuevo) ──────
{
  const cur = [{ id: "b1", cama: "3-102", exp: "2", updated_by: "sheet-sync" }];
  const full = { b1: { id: "b1", cama: "3-102", nombre: "B", exp: "2", notes: [] } };
  const sheet = [row("3-102", "9")]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur, full, handler: (m, u) => (m === "POST" && u.startsWith("/rest/v1/archive") ? { code: 500, body: "boom" } : null) });
  sb.syncPatients_("svc", sheet);
  const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
  const camas = up && Array.isArray(up.body) ? up.body.map((p) => p.cama) : [];
  check("T2b archivo fallido en cama reasignada: esa cama queda fuera del upsert y las demás entran",
    !!up && !camas.includes("3-102") && camas.length === 12 && !calls.some((c) => c.m === "DELETE"), JSON.stringify({ camas }));
}

// ── 3) Cambio de cama: PATCH de la misma fila, nunca DELETE ni archive ───────────────────────────
{
  const cur = [{ id: "d1", cama: "3-104", exp: "4", updated_by: "sheet-sync" }];
  const sheet = [row("3-107", "4")]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur });
  sb.syncPatients_("svc", sheet);
  const patches = calls.filter((c) => c.m === "PATCH");
  check("T3 movido: un PATCH id=d1 con cama 3-107 + updated_by sheet-sync; sin DELETE ni archive",
    patches.length === 1 && patches[0].u.includes("id=eq.d1") && patches[0].body.cama === "3-107" && patches[0].body.updated_by === "sheet-sync"
    && !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive")), JSON.stringify(patches));
  const iPatch = seq(calls, (c) => c.m === "PATCH"), iUp = seq(calls, (c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
  check("T3b el PATCH ocurre antes del upsert (así el upsert por cama cae en la misma fila)", iPatch >= 0 && iUp > iPatch);
}

// ── 4) Intercambio A↔B: fase temporal para no chocar con UNIQUE(cama) ────────────────────────────
{
  const cur = [{ id: "a1", cama: "3-101", exp: "1", updated_by: "sheet-sync" }, { id: "b1", cama: "3-102", exp: "2", updated_by: "sheet-sync" }];
  const sheet = [row("3-102", "1"), row("3-101", "2")]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur });
  sb.syncPatients_("svc", sheet);
  const patches = calls.filter((c) => c.m === "PATCH").map((c) => (c.u.match(/id=eq\.(\w+)/)[1]) + ":" + c.body.cama);
  const temps = patches.filter((p) => /#MV-/.test(p));
  const finals = patches.filter((p) => !/#MV-/.test(p));
  check("T4 swap: 2 PATCH temporales primero y luego los 2 finales; sin DELETE",
    temps.length === 2 && finals.length === 2 && patches.indexOf(temps[1]) < patches.indexOf(finals[0])
    && finals.includes("a1:3-102") && finals.includes("b1:3-101") && !calls.some((c) => c.m === "DELETE"), JSON.stringify(patches));
}

// ── 5) Reasignación (otra persona en la cama) + duplicado del mismo exp ──────────────────────────
{
  // 3-101 la ocupa ahora exp 9 (otra persona) → a1 se archiva como CAMA REASIGNADA.
  // exp 4 está dos veces en Supabase (3-104 y 3-105) y la hoja lo pone en 3-105 → 3-104 es duplicado → se retira, NO se mueve.
  const cur = [{ id: "a1", cama: "3-101", exp: "1", updated_by: "sheet-sync" }, { id: "d1", cama: "3-104", exp: "4", updated_by: "sheet-sync" }, { id: "d2", cama: "3-105", exp: "4", updated_by: "app" }];
  const full = { a1: { id: "a1", cama: "3-101", exp: "1", nombre: "A", notes: [] }, d1: { id: "d1", cama: "3-104", exp: "4", nombre: "D", notes: [] } };
  const sheet = [row("3-101", "9"), row("3-105", "4")]; for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i)));
  const { sb, calls } = makeSandbox({ cur, full, props: missingOld(["d1"]) });
  sb.syncPatients_("svc", sheet);
  const arcs = calls.filter((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.exp + "|" + c.body.note_data._egreso);
  check("T5 reasignación archiva a1 con etiqueta CAMA REASIGNADA; duplicado d1 se retira; d2 intacto; sin PATCH",
    arcs.some((a) => a.startsWith("1|CAMA REASIGNADA")) && calls.some((c) => c.m === "DELETE" && c.u.includes("id=eq.a1"))
    && calls.some((c) => c.m === "DELETE" && c.u.includes("id=eq.d1")) && !calls.some((c) => c.u.includes("d2") && (c.m === "DELETE" || c.m === "PATCH"))
    && !calls.some((c) => c.m === "PATCH"), JSON.stringify({ arcs, calls: calls.map((c) => c.m + " " + c.u) }));
}

// ── 6) Guardas: hoja <10 o >50% a borrar → solo upsert ───────────────────────────────────────────
{
  const cur = []; for (let i = 0; i < 20; i++) cur.push({ id: "x" + i, cama: "5-" + (10 + i), exp: String(500 + i), updated_by: "sheet-sync" });
  const sheetSmall = [row("3-101", "1")];
  const { sb: sb1, calls: c1 } = makeSandbox({ cur });
  sb1.syncPatients_("svc", sheetSmall);
  const sheetBig = []; for (let i = 0; i < 12; i++) sheetBig.push(row("6-" + (10 + i), String(600 + i)));
  const { sb: sb2, calls: c2 } = makeSandbox({ cur });
  sb2.syncPatients_("svc", sheetBig);
  check("T6 guardas: ni DELETE ni archive ni PATCH; solo upsert",
    !c1.some((c) => c.m !== "GET" && !c.u.startsWith("/rest/v1/patients?on_conflict=cama")) && !c2.some((c) => c.m !== "GET" && !c.u.startsWith("/rest/v1/patients?on_conflict=cama")));
}

// ── 7) sync_log con throttle de 6 h ──────────────────────────────────────────────────────────────
{
  const { sb, calls } = makeSandbox({});
  const q = [{ exp: "1", camas: "3-101, 3-102", nombres: "A | B", motivo: "exp_duplicado_nombres_distintos" }];
  const n1 = sb.logQuarantine_("svc", q);
  const n2 = sb.logQuarantine_("svc", q);
  const n3 = sb.logQuarantine_("svc", [{ exp: "2", camas: "3-103", nombres: "C", motivo: "cama_duplicada_en_hoja" }]);
  const posts = calls.filter((c) => c.m === "POST" && c.u.startsWith("/rest/v1/sync_log"));
  check("T7 sync_log: la misma cuarentena se inserta una vez; una distinta sí entra", n1 === 1 && n2 === 0 && n3 === 1 && posts.length === 2, JSON.stringify({ n1, n2, n3, posts: posts.length }));
}

// ── 8) Watchdog de labs ──────────────────────────────────────────────────────────────────────────
{
  const fresh = new Date(Date.now() - 5 * 36e5).toISOString();
  const { sb: s1, mails: m1 } = makeSandbox({ labs: [{ scraped_at: fresh }] });
  const r1 = s1.checkLabsFreshness();
  const stale = new Date(Date.now() - 40 * 36e5).toISOString();
  const { sb: s2, mails: m2, calls: c2 } = makeSandbox({ labs: [{ scraped_at: stale }], props: { ALERT_EMAIL: "jefe@hospital.mx" } });
  const r2 = s2.checkLabsFreshness();
  const r3 = s2.checkLabsFreshness();
  check("T8 labs frescos (5 h): ok, sin correo", r1.ok === true && m1.length === 0);
  check("T8b labs viejos (40 h): correo a ALERT_EMAIL con el enlace del workflow, registro en sync_log, segundo chequeo silenciado",
    r2.ok === false && r2.alerted === true && m2.length === 1 && m2[0].to === "jefe@hospital.mx" && /winlab-scraper\.yml/.test(m2[0].body)
    && c2.some((c) => c.u.startsWith("/rest/v1/sync_log") && /labs_stale/.test(JSON.stringify(c.body))) && r3.muted === true && m2.length === 1,
    JSON.stringify({ r2, r3, mails: m2.length }));
  const { sb: s3, mails: m3 } = makeSandbox({ labs: [] });
  const r4 = s3.checkLabsFreshness();
  check("T8c sin filas: alerta (nunca hubo scrape)", r4.ok === false && m3.length === 1);
}

// ── 9) Doc de indicaciones → indicaciones_doc (fila única), solo si el Doc cambió ────────────────
{
  const DOC = "💯 3-150\n\nINDICACIONES MÉDICAS DE PACIENTE UNO\nPACIENTE UNO 48 AÑOS | CAMA 3-150\n11/10/2026 8:00 am\nDIETA\nDIETA BLANDA\nMEDICAMENTOS\nPARACETAMOL 1 GR IV CADA 8 HORAS\n";
  const props = {};
  const mk = (updated) => {
    const st = { props, handler: (m, u) => (m === "POST" && u.startsWith("/rest/v1/indicaciones_doc") ? { code: 201, body: "" } : null) };
    const r = makeSandbox(st);
    r.sb.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k === "SUPABASE_KEY" ? "svc" : props[k] || null), setProperty: (k, v) => { props[k] = v; } }) };
    r.sb.DriveApp = { getFileById: () => ({ getLastUpdated: () => new Date(updated) }) };
    r.sb.DocumentApp = { openById: () => ({ getBody: () => ({ getText: () => DOC }) }) };
    r.sb.Utilities = { computeDigest: (a, s) => Array.from(Buffer.from(String(s))).slice(0, 16).map((b) => (b > 127 ? b - 256 : b)), DigestAlgorithm: { MD5: 1 }, Charset: { UTF_8: 1 }, formatDate: () => "" };
    return r;
  };
  const a = mk("2026-10-11T19:00:00Z");
  const r1 = a.sb.syncIndicaciones(false);
  const up = a.calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/indicaciones_doc?on_conflict=id"));
  check("T9 primera corrida: UPSERT de la fila id=1 con texto, hash y fecha del Doc; cuenta 1 bloque",
    r1.ok === true && r1.bloques === 1 && !!up && up.body.id === 1 && up.body.text === DOC && /^[0-9a-f]{32}$/.test(up.body.text_hash) && up.body.doc_updated === "2026-10-11T19:00:00.000Z",
    JSON.stringify({ r1, body: up && Object.keys(up.body) }));
  const b = mk("2026-10-11T19:00:00Z");
  const r2 = b.sb.syncIndicaciones(false);
  check("T9b mismo Doc (misma fecha de edición) → no vuelve a subir", r2.skipped === true && !b.calls.some((c) => c.u.startsWith("/rest/v1/indicaciones_doc")));
  const c = mk("2026-10-11T19:30:00Z");
  const r3 = c.sb.syncIndicaciones(false);
  check("T9c Doc editado después → vuelve a subir", r3.ok === true && !r3.skipped && c.calls.some((c2) => c2.u.startsWith("/rest/v1/indicaciones_doc")));
  const d = mk("2026-10-11T19:30:00Z");
  const r4 = d.sb.syncIndicaciones(true);
  check("T9d force=true sube aunque no haya cambios", r4.ok === true && !r4.skipped);
}

console.log("RESULT CENSO-SYNC: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
