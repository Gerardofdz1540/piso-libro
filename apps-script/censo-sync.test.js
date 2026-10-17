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

// ── 10) Salas de otros servicios: se capta a NUESTRO paciente quirúrgico, no a los de ese servicio ─
{
  const H = ['CAMA', 'EXPEDIENTE', 'NOMBRE', 'EDAD', 'DIAGNOSTICO', 'ESPECIALIDAD', 'ADSCRITO', 'RESIDENTE', 'INGRESO', 'DIAS', 'ESTADO'];
  const pr = (cama, exp, esp) => [cama, exp, 'P ' + exp, '40', 'DX', esp, 'ADSC', 'RES', '14/10/2026', '1', 'ESTABLE'];
  const rows = [
    H,
    ['PISO'],
    pr('3-101', '26-0001', 'CG'),            // piso, nuestro
    pr('3-102', '26-0008', 'NCX'),           // piso, otro servicio quirúrgico que el piso sí lista
    ['GINECOLOGIA'],
    pr('2-092', '26-0002', 'CG'),            // embarazada de cirugía general en cama de gine → SE CAPTA
    pr('2-093', '26-0003', 'GO'),            // paciente de ginecología → NO
    pr('2-094', '26-0004', ''),              // sin especialidad en sala ajena → NO
    pr('2-095', '26-0009', 'CG/URO'),        // combinado con componente quirúrgico → SE CAPTA
    ['ONCOLOGIA'],
    pr('5-010', '26-0005', 'CG'),            // nuestro en onco → SE CAPTA
    pr('5-011', '26-0006', 'ONC'),           // oncología médica → NO
    ['ALTAS'],
    pr('3-109', '26-0007', 'CG'),            // alta, aunque sea CG → NO (sección administrativa)
  ];
  const { sb } = makeSandbox({});
  const parsed = sb.parseCenso_(rows);
  const byExp = {}; parsed.forEach((p) => { byExp[p.exp] = p; });
  const got = parsed.map((p) => p.exp + ':' + p.seccion + ':' + p.esp).sort();
  check('T10 gine/onco/hemato: se capta al paciente quirúrgico hospedado (CG en gine 2-092, CG/URO, CG en onco) con su sección; NO a los del servicio (GO, ONC, sin esp); ALTAS nunca entra aunque sea CG; el piso sigue igual (CG + NCX)',
    !!byExp['26-0001'] && !!byExp['26-0008']
    && !!byExp['26-0002'] && byExp['26-0002'].seccion === 'GINECOLOGIA' && byExp['26-0002'].cama === '2-092'
    && !byExp['26-0003'] && !byExp['26-0004'] && !!byExp['26-0009']
    && !!byExp['26-0005'] && byExp['26-0005'].seccion === 'ONCOLOGIA' && !byExp['26-0006']
    && !byExp['26-0007'] && parsed.length === 5, JSON.stringify(got));
  // helpers directos
  check('T10b isSurgicalService_: CG/CT/CV/CPR/NCX/URO/CG-URO sí; GO/GINE/ONC/HEM/vacío no',
    sb.isSurgicalService_('CG') && sb.isSurgicalService_('CT') && sb.isSurgicalService_('CV') && sb.isSurgicalService_('CPR')
    && sb.isSurgicalService_('NCX') && sb.isSurgicalService_('URO') && sb.isSurgicalService_('CG / URO')
    && !sb.isSurgicalService_('GO') && !sb.isSurgicalService_('GINE') && !sb.isSurgicalService_('ONC') && !sb.isSurgicalService_('HEM')
    && !sb.isSurgicalService_('CARD') && !sb.isSurgicalService_(''),
    JSON.stringify(['CG', 'GO', 'ONC', 'CARD', ''].map((e) => e + '=' + sb.isSurgicalService_(e))));
}

// ── 11) Cama cambiada desde la APP (cama_app_ts / cama_hoja_prev): la app gana hasta que la hoja cambie ─
{
  const TS = "2026-10-16T10:00:00Z";
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp) : null; };
  const patchesOf = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => ({ id: c.u.match(/id=eq\.(\w+)/)[1], body: c.body }));
  const noDestroy = (calls) => !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive"));
  // El residente movió a JUAN PEREZ LOPEZ (exp 7) de 3-101 a 3-105 desde la app; la hoja sigue diciendo 3-101.
  const p7 = (extra) => Object.assign({ id: "p7", cama: "3-105", exp: "7", nombre: "JUAN PEREZ LOPEZ", updated_by: "Dr. Residente", cama_app_ts: TS, cama_hoja_prev: null }, extra || {});

  // (1) primera divergencia → se anota cama_hoja_prev, la cama NO se toca, la fila 3-101 de exp 7 no va al upsert
  {
    const { sb, calls } = makeSandbox({ cur: [p7()], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const ps = patchesOf(calls), up = upsertOf(calls);
    check("T11a app movió 3-101→3-105, hoja dice 3-101 (1ª vez): un solo PATCH {cama_hoja_prev:'3-101'} sin cama; sin DELETE/archive",
      ps.length === 1 && ps[0].id === "p7" && ps[0].body.cama === undefined && ps[0].body.cama_hoja_prev === "3-101" && Object.keys(ps[0].body).length === 1 && noDestroy(calls), JSON.stringify(ps));
    check("T11b el upsert NO lleva la fila 3-101 de exp 7 (evita el duplicado en la cama vieja) y sí las otras 12",
      !!up && !up.includes("3-101:7") && up.length === 12, JSON.stringify(up));
  }
  // (2) segunda corrida: prev='3-101' y la hoja sigue en 3-101 → nada se mueve, nada se parchea, sin duplicado
  {
    const { sb, calls, logs } = makeSandbox({ cur: [p7({ cama_hoja_prev: "3-101" })], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const up = upsertOf(calls);
    check("T11c 2ª corrida (hoja sin cambios): sin PATCH, sin DELETE, la fila 3-101 sigue fuera del upsert y se loguea que la app gana",
      !calls.some((c) => c.m === "PATCH") && noDestroy(calls) && !!up && !up.includes("3-101:7") && up.length === 12
      && logs.some((l) => /fijada\(s\) desde la app/.test(l) && /3-101/.test(l)), JSON.stringify({ up, logs }));
  }
  // (3) la hoja alcanza a la app (3-105) → se limpian cama_app_ts/cama_hoja_prev; la cama no se toca; 3-105 entra al upsert
  {
    const { sb, calls } = makeSandbox({ cur: [p7({ cama_hoja_prev: "3-101" })], props: {} });
    sb.syncPatients_("svc", fill([row("3-105", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const ps = patchesOf(calls), up = upsertOf(calls);
    check("T11d hoja ya dice 3-105: un PATCH que resuelve {cama_app_ts:null, cama_hoja_prev:'ok@<ts>'} sin mover; 3-105 va al upsert",
      ps.length === 1 && ps[0].id === "p7" && ps[0].body.cama === undefined && ps[0].body.cama_app_ts === null && ps[0].body.cama_hoja_prev === "ok@" + TS
      && noDestroy(calls) && !!up && up.includes("3-105:7") && up.length === 13, JSON.stringify({ ps, up }));
    // ya resuelto (ts null + marca) y la hoja sigue igual → ningún PATCH (no hay bucle de limpiezas cada 5 min)
    const { sb: sbR, calls: cR } = makeSandbox({ cur: [p7({ cama_app_ts: null, cama_hoja_prev: "ok@" + TS })], props: {} });
    sbR.syncPatients_("svc", fill([row("3-105", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    check("T11d2 resuelto y la hoja igual: sin PATCH en las corridas siguientes", !cR.some((c) => c.m === "PATCH"), JSON.stringify(cR.map((c) => c.m + " " + c.u)));
  }
  // (4) la hoja cambió a 3-120 (≠ prev 3-101) después del movimiento → manda la hoja: PATCH cama 3-120 + limpieza
  {
    const { sb, calls } = makeSandbox({ cur: [p7({ cama_hoja_prev: "3-101" })], props: {} });
    sb.syncPatients_("svc", fill([row("3-120", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const ps = patchesOf(calls), up = upsertOf(calls);
    check("T11e hoja cambió a 3-120 ≠ prev: PATCH {cama:'3-120', cama_app_ts:null, cama_hoja_prev:'ok@<ts>', updated_by:'sheet-sync'}; 3-120 en el upsert; sin DELETE",
      ps.length === 1 && ps[0].id === "p7" && ps[0].body.cama === "3-120" && ps[0].body.cama_app_ts === null && ps[0].body.cama_hoja_prev === "ok@" + TS
      && ps[0].body.updated_by === "sheet-sync" && noDestroy(calls) && !!up && up.includes("3-120:7"), JSON.stringify({ ps, up }));
  }
  // (5) fila SIN cama_app_ts (movida por la hoja o por nadie) → comportamiento de siempre: la hoja manda
  {
    const { sb, calls } = makeSandbox({ cur: [p7({ cama_app_ts: null })], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const ps = patchesOf(calls), up = upsertOf(calls);
    check("T11f sin cama_app_ts: PATCH de cama a 3-101 como siempre (sin columnas de control) y 3-101 en el upsert",
      ps.length === 1 && ps[0].id === "p7" && ps[0].body.cama === "3-101" && ps[0].body.cama_app_ts === undefined && !!up && up.includes("3-101:7"), JSON.stringify({ ps, up }));
  }
  // (6) en la cama vieja (3-101) la hoja ya puso a OTRA persona (exp 9) → esa fila sí va al upsert (reasignación normal)
  {
    // 6a: exp 7 ya aparece en 3-105 (coincide) → limpieza; 3-101:9 entra
    const { sb, calls } = makeSandbox({ cur: [p7({ cama_hoja_prev: "3-101" })], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "9", { nombre: "MARIA RUIZ SOTO" }), row("3-105", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const ps = patchesOf(calls), up = upsertOf(calls);
    check("T11g otra persona en la cama vieja + exp 7 ya en 3-105: la fila 3-101:9 SÍ va al upsert; p7 solo se limpia",
      !!up && up.includes("3-101:9") && up.includes("3-105:7") && ps.length === 1 && ps[0].body.cama_app_ts === null && ps[0].body.cama === undefined && noDestroy(calls), JSON.stringify({ ps, up }));
    // 6b: exp 7 ya no está en la hoja; 3-101 es de exp 9 → 3-101:9 entra; p7 (hecho en la app) no se retira ni se parchea
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [p7({ cama_hoja_prev: "3-101" })], props: {} });
    sb2.syncPatients_("svc", fill([row("3-101", "9", { nombre: "MARIA RUIZ SOTO" })]));
    const up2 = upsertOf(c2);
    check("T11h exp 7 fuera de la hoja y otra persona en 3-101: 3-101:9 al upsert; p7 sin PATCH ni DELETE en la 1ª corrida",
      !!up2 && up2.includes("3-101:9") && !c2.some((c) => c.m === "PATCH") && noDestroy(c2), JSON.stringify({ up2 }));
  }
  // (7) protección: la hoja pone a OTRO exp (8) en la cama que la app fijó (3-105) → esa fila NO se upsertea (pisaría a p7 y su
  //     nota quedaría bajo otro nombre) y la fila de exp 8 ni se mueve ahí (UNIQUE) ni se retira
  {
    const cur = [p7({ cama_hoja_prev: "3-101" }), { id: "p8", cama: "3-120", exp: "8", nombre: "PEDRO GOMEZ DIAZ", updated_by: "sheet-sync" }];
    const st = { cur, props: {} };
    const { sb, calls, logs } = makeSandbox(st);
    sb.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" }), row("3-105", "8", { nombre: "PEDRO GOMEZ DIAZ" })]));
    const up = upsertOf(calls);
    const since = JSON.parse(st.props.PL_MISSING_SINCE || "{}");
    check("T11i otro exp en la cama fijada: ni 3-101:7 ni 3-105:8 van al upsert; p8 no se mueve ni entra en gracia; sin DELETE; se loguea",
      !!up && !up.includes("3-101:7") && !up.includes("3-105:8") && up.length === 12 && !calls.some((c) => c.m === "PATCH" && c.u.includes("id=eq.p8"))
      && !since.p8 && noDestroy(calls) && logs.some((l) => /en espera/.test(l) && /3-120→3-105/.test(l)), JSON.stringify({ up, since, logs }));
  }
  // (8) duplicado viejo: antes de este arreglo el upsert ya había recreado a exp 7 en 3-101 (fila sheet-sync vacía) →
  //     p7 (app) se respeta y el duplicado p7b pasa a "fuera de la hoja": gracia y luego retiro normal
  {
    const dup = { id: "p7b", cama: "3-101", exp: "7", nombre: "JUAN PEREZ LOPEZ", updated_by: "sheet-sync" };
    const full = { p7b: { id: "p7b", cama: "3-101", exp: "7", nombre: "JUAN PEREZ LOPEZ", notes: [] } };
    const st = { cur: [p7({ cama_hoja_prev: "3-101" }), dup], full, props: {} };
    const { sb, calls } = makeSandbox(st);
    sb.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    const since = JSON.parse(st.props.PL_MISSING_SINCE || "{}");
    check("T11j duplicado sheet-sync en la cama vieja: 1ª corrida entra en gracia (sin DELETE), p7 sin PATCH, 3-101 fuera del upsert",
      typeof since.p7b === "number" && noDestroy(calls) && !calls.some((c) => c.m === "PATCH") && !upsertOf(calls).includes("3-101:7"), JSON.stringify({ since, calls: calls.map((c) => c.m + " " + c.u) }));
    const st2 = { cur: [p7({ cama_hoja_prev: "3-101" }), dup], full, props: missingOld(["p7b"]) };
    const { sb: sb2, calls: c2 } = makeSandbox(st2);
    const r2 = sb2.syncPatients_("svc", fill([row("3-101", "7", { nombre: "JUAN PEREZ LOPEZ" })]));
    check("T11k ... y tras la gracia se archiva y borra SOLO p7b; p7 (la fila con la nota) intacta",
      r2 === 1 && c2.some((c) => c.m === "DELETE" && c.u.includes("id=eq.p7b")) && !c2.some((c) => c.u.includes("id=eq.p7&") || c.u.endsWith("id=eq.p7")) , JSON.stringify(c2.map((c) => c.m + " " + c.u)));
  }
}

// ── 12) Mismo expediente con NOMBRES distintos (error de captura): ya NO hay cuarentena, entran todos.
//        Caso real 17 oct 2026: 3-154 y 3-189 con el mismo exp → no entraba ninguno y el de la 3-189,
//        que ya estaba en la app, se retiraba a los 12 min. Las personas se distinguen por nombre.
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : null; };
  const noDestroy = (calls) => !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive"));
  const A = "PEREZ RUIZ JUAN CARLOS", B = "LOPEZ SOTO MIGUEL ANGEL", C = "DIAZ MORA PEDRO";
  const { sb } = makeSandbox({});

  // dedup: dos personas con el mismo exp → las dos se quedan y queda un aviso
  const d1 = sb.dedupAndQuarantine_([{ cama: "3-154", exp: "X", nombre: A }, { cama: "3-189", exp: "X", nombre: B }]);
  check("T12a mismo exp, nombres distintos: se sincronizan LAS DOS y queda un aviso exp_repetido_sincronizado",
    d1.keep.length === 2 && d1.avisos.length === 1 && d1.avisos[0].motivo === "exp_repetido_sincronizado" && d1.avisos[0].camas === "3-154, 3-189", JSON.stringify(d1));
  // misma persona (nombres en otro orden) en dos camas → sigue siendo una sola (como antes)
  const d2 = sb.dedupAndQuarantine_([{ cama: "3-157", exp: "Y", nombre: "ANA LUISA PEREZ GOMEZ" }, { cama: "3-186", exp: "Y", nombre: "LUISA ANA PEREZ GOMEZ" }]);
  check("T12b misma persona en dos camas → una sola fila (sin cambio)", d2.keep.length === 1 && d2.keep[0].cama === "3-157" && d2.avisos[0].motivo === "dedup_misma_persona_multi_cama", JSON.stringify(d2));
  // mezcla: A en piso y en UCI + B con el mismo exp → A una vez (UCI gana) y B
  const d3 = sb.dedupAndQuarantine_([{ cama: "3-101", exp: "Z", nombre: A }, { cama: "UCI 2", exp: "Z", nombre: A }, { cama: "3-120", exp: "Z", nombre: B }]);
  check("T12c mezcla: A en 3-101 y UCI 2 + B → entran UCI 2 (A) y 3-120 (B)",
    d3.keep.length === 2 && d3.keep.some((p) => p.cama === "UCI 2") && d3.keep.some((p) => p.cama === "3-120") && d3.avisos.some((a) => a.motivo === "dedup_uci_gana_a_piso"), JSON.stringify(d3));

  // caso real: B estaba en la app en 3-189; la hoja agrega a A en 3-154 con el MISMO exp → nada se borra, entran los dos
  {
    const cur = [{ id: "b9", cama: "3-189", exp: "X", nombre: B, updated_by: "sheet-sync" }];
    const st = { cur, props: missingOld(["b9"]) };
    const { sb: s, calls } = makeSandbox(st);
    const r = s.syncPatients_("svc", fill([row("3-154", "X", { nombre: A }), row("3-189", "X", { nombre: B })]));
    const up = upsertOf(calls);
    check("T12d caso 3-154/3-189: sin archivo ni DELETE ni PATCH; el upsert lleva a 3-154 (A) y 3-189 (B); b9 sale del mapa de ausentes",
      r === 0 && noDestroy(calls) && !calls.some((c) => c.m === "PATCH") && !!up && up.includes("3-154:X:" + A) && up.includes("3-189:X:" + B)
      && !JSON.parse(st.props.PL_MISSING_SINCE || "{}").b9, JSON.stringify({ up, calls: calls.map((c) => c.m + " " + c.u) }));
  }
  // la persona correcta se mueve por NOMBRE: A estaba en 3-154; la hoja pone a B en 3-154 y a A en 3-170 (mismo exp)
  {
    const cur = [{ id: "a4", cama: "3-154", exp: "X", nombre: A, updated_by: "sheet-sync" }];
    const { sb: s, calls } = makeSandbox({ cur, props: {} });
    s.syncPatients_("svc", fill([row("3-154", "X", { nombre: B }), row("3-170", "X", { nombre: A })]));
    const ps = calls.filter((c) => c.m === "PATCH");
    const up = upsertOf(calls);
    check("T12e exp repetido: A se MUEVE a 3-170 (su nombre), no se queda en 3-154 con el nombre de B; B entra nuevo en 3-154; sin borrar",
      ps.length === 1 && ps[0].u.includes("id=eq.a4") && ps[0].body.cama === "3-170" && noDestroy(calls)
      && !!up && up.includes("3-154:X:" + B) && up.includes("3-170:X:" + A), JSON.stringify({ ps: ps.map((c) => c.u + " " + JSON.stringify(c.body)), up }));
    const iPatch = seq(calls, (c) => c.m === "PATCH"), iUp = seq(calls, (c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
    check("T12e2 el PATCH de A ocurre antes del upsert (así 3-154 queda libre para B)", iPatch >= 0 && iUp > iPatch);
  }
  // A estaba en 3-154 y ya no está en la hoja; ahí ahora está B con el MISMO exp → A se archiva (su nota NO pasa a B)
  {
    const cur = [{ id: "a4", cama: "3-154", exp: "X", nombre: A, updated_by: "sheet-sync" }];
    const full = { a4: { id: "a4", cama: "3-154", exp: "X", nombre: A, notes: [{ patient_id: "a4", pendientes: "nota de A" }] } };
    const { sb: s, calls } = makeSandbox({ cur, full, props: {} });
    s.syncPatients_("svc", fill([row("3-154", "X", { nombre: B }), row("3-189", "X", { nombre: C })]));
    const arc = calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive"));
    const iDel = seq(calls, (c) => c.m === "DELETE" && c.u.includes("/patients?id=eq.a4")), iUp = seq(calls, (c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
    check("T12f otra persona con el mismo exp en la cama: CAMA REASIGNADA (archivo con la nota de A + DELETE) ANTES del upsert de B",
      !!arc && arc.body.patient_data.nombre === A && /CAMA REASIGNADA/.test(arc.body.note_data._egreso) && iDel >= 0 && iUp > iDel
      && upsertOf(calls).includes("3-154:X:" + B), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
  // intercambio de camas entre dos personas con el mismo exp → dos movimientos por nombre (fase temporal), sin borrar
  {
    const cur = [{ id: "a4", cama: "3-154", exp: "X", nombre: A, updated_by: "sheet-sync" }, { id: "b9", cama: "3-189", exp: "X", nombre: B, updated_by: "sheet-sync" }];
    const { sb: s, calls } = makeSandbox({ cur, props: {} });
    s.syncPatients_("svc", fill([row("3-154", "X", { nombre: B }), row("3-189", "X", { nombre: A })]));
    const finals = calls.filter((c) => c.m === "PATCH" && !/#MV-/.test(c.body.cama)).map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + c.body.cama);
    check("T12g intercambio con exp repetido: a4→3-189 y b9→3-154 (por nombre), sin DELETE",
      finals.length === 2 && finals.includes("a4:3-189") && finals.includes("b9:3-154") && noDestroy(calls), JSON.stringify(finals));
  }
  // nombre que no coincide con ninguna de las filas del exp repetido → no se adivina a dónde moverlo
  {
    const cur = [{ id: "c1", cama: "3-110", exp: "X", nombre: C, updated_by: "sheet-sync" }];
    const st = { cur, props: {} };
    const { sb: s, calls } = makeSandbox(st);
    s.syncPatients_("svc", fill([row("3-154", "X", { nombre: A }), row("3-189", "X", { nombre: B })]));
    check("T12h exp repetido y ninguna fila es esa persona: no se mueve a la cama de otro; entra en gracia como ausente",
      !calls.some((c) => c.m === "PATCH") && noDestroy(calls) && typeof JSON.parse(st.props.PL_MISSING_SINCE || "{}").c1 === "number", JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
  // exp único (lo normal): el cambio de cama sigue siendo por expediente aunque el nombre se haya corregido
  {
    const cur = [{ id: "d1", cama: "3-104", exp: "4", nombre: "GARCIA LOPZ JUAN", updated_by: "sheet-sync" }];
    const { sb: s, calls } = makeSandbox({ cur });
    s.syncPatients_("svc", fill([row("3-107", "4", { nombre: "GARCIA LOPEZ JUAN" })]));
    const ps = calls.filter((c) => c.m === "PATCH");
    check("T12i exp único: el movimiento sigue siendo por expediente (sin exigir el mismo nombre), como antes",
      ps.length === 1 && ps[0].u.includes("id=eq.d1") && ps[0].body.cama === "3-107", JSON.stringify(ps));
  }
  // cama fijada desde la app y la hoja pone ahí a OTRA persona con el MISMO exp → esa fila no pisa la cama fijada
  {
    const TS = "2026-10-16T10:00:00Z";
    const cur = [{ id: "p7", cama: "3-105", exp: "X", nombre: A, updated_by: "Dr. Residente", cama_app_ts: TS, cama_hoja_prev: "3-101" }];
    const { sb: s, calls } = makeSandbox({ cur, props: {} });
    s.syncPatients_("svc", fill([row("3-101", "X", { nombre: A }), row("3-105", "X", { nombre: B })]));
    const up = upsertOf(calls);
    check("T12j cama fijada desde la app con el mismo exp de otra persona: ni 3-101 (A, cama vieja) ni 3-105 (B) pisan la fila de A; sin borrar",
      !!up && !up.some((u) => u.startsWith("3-101:")) && !up.some((u) => u.startsWith("3-105:")) && noDestroy(calls) && !calls.some((c) => c.m === "PATCH" && c.body.cama), JSON.stringify({ up }));
  }
}

console.log("RESULT CENSO-SYNC: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
