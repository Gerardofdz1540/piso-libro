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

// ── 13) Revisión: el expediente sigue siendo ambiguo mientras Supabase tenga a las DOS personas, aunque la hoja
//        ya lo muestre una sola vez (alta de una, exp corregido, intercambio a medias) ─────────────────────────
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : []; };
  const A = "PEREZ RUIZ JUAN CARLOS", B = "LOPEZ SOTO MIGUEL ANGEL";
  const a4 = { id: "a4", cama: "3-154", exp: "X", nombre: A, updated_by: "sheet-sync" }, b9 = { id: "b9", cama: "3-189", exp: "X", nombre: B, updated_by: "sheet-sync" };
  const full = { a4: { ...a4, notes: [{ patient_id: "a4", pendientes: "nota de A" }] }, b9: { ...b9, notes: [{ patient_id: "b9", pendientes: "nota de B" }] } };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));

  // (i) B se dio de alta y A pasó a la cama de B: la fila de B (con su nota) NO recibe el nombre de A
  {
    const { sb, calls } = makeSandbox({ cur: [a4, b9], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-189", "X", { nombre: A })]));
    const arc = calls.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre);
    const ps = patches(calls);
    check("T13a alta de B + A pasa a 3-189 (exp ya único en la hoja): b9 se archiva como cama reasignada y a4 se MUEVE a 3-189; nunca se le pone el nombre de A a b9",
      arc.includes(B) && !arc.includes(A) && ps.some((p) => p.startsWith("a4:") && p.includes('"cama":"3-189"')) && !ps.some((p) => p.startsWith("b9:"))
      && calls.some((c) => c.m === "DELETE" && c.u.includes("id=eq.b9")), JSON.stringify({ arc, ps, up: upsertOf(calls) }));
  }
  // (iii) a B le corrigen el exp a Z y A se mueve a 3-160, con b9 PRIMERO en la lista de Supabase
  {
    const { sb, calls } = makeSandbox({ cur: [b9, a4], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-160", "X", { nombre: A }), row("3-189", "Z", { nombre: B })]));
    const ps = patches(calls);
    check("T13b exp de B corregido a Z + A a 3-160 (b9 primero): a4 se mueve a 3-160 por nombre; a b9 solo se le corrige el exp; nadie se archiva",
      ps.some((p) => p.startsWith("a4:") && p.includes('"cama":"3-160"')) && ps.some((p) => p.startsWith("b9:") && p.includes('"exp":"Z"')) && !ps.some((p) => p.startsWith("b9:") && p.includes('"cama"'))
      && !calls.some((c) => c.u.startsWith("/rest/v1/archive") || c.m === "DELETE"), JSON.stringify(ps));
  }
  // (iv) B ya no está en la hoja (gracia) y A pasa a una cama libre, b9 primero → b9 no se mueve a la cama de A
  {
    const st = { cur: [b9, a4], full, props: {} };
    const { sb, calls } = makeSandbox(st);
    sb.syncPatients_("svc", fill([row("3-170", "X", { nombre: A })]));
    const ps = patches(calls);
    check("T13c B fuera de la hoja + A a 3-170 (b9 primero): se mueve a4 (no b9); b9 queda en gracia",
      ps.length === 1 && ps[0].startsWith("a4:") && ps[0].includes('"cama":"3-170"') && typeof JSON.parse(st.props.PL_MISSING_SINCE || "{}").b9 === "number" && !calls.some((c) => c.m === "DELETE"), JSON.stringify(ps));
  }
  // (ii) intercambio a medias (dedupByCama dejó solo a A en 3-189): b9 no recibe el nombre de A
  {
    const { sb, calls } = makeSandbox({ cur: [a4, b9], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-189", "X", { nombre: A })]));
    check("T13d intercambio a medias: el upsert de 3-189 (A) nunca cae sobre b9 sin archivarlo antes",
      !upsertOf(calls).includes("3-189:X:" + A) || seq(calls, (c) => c.m === "DELETE" && c.u.includes("id=eq.b9")) >= 0, JSON.stringify(upsertOf(calls)));
  }
  // S3: con exp ambiguo, un nombre CORREGIDO en la hoja (una letra / abreviatura) sigue siendo la misma persona
  {
    const a4b = { ...a4, nombre: "PERES RUIZ JUAN CARLOS" }, hd = { id: "h1", cama: "3-170", exp: "X", nombre: "HDZ MORA PEDRO", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a4b, b9, hd], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: A }), row("3-189", "X", { nombre: B }), row("3-170", "X", { nombre: "HERNANDEZ MORA PEDRO" })]));
    check("T13e exp ambiguo + nombre corregido en la hoja (PERES→PEREZ, HDZ→HERNANDEZ): misma persona, sin archivo ni fila nueva",
      !calls.some((c) => c.u.startsWith("/rest/v1/archive") || c.m === "DELETE") && !calls.some((c) => c.m === "PATCH"), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
  // ...pero si el nombre de la hoja es el de la OTRA persona, no se confunde
  {
    const { sb, calls } = makeSandbox({ cur: [a4, b9], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: B }), row("3-189", "X", { nombre: A })]));
    const finals = calls.filter((c) => c.m === "PATCH" && c.body.cama && !/#MV-/.test(c.body.cama)).map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + c.body.cama);
    check("T13f intercambio completo con exp ambiguo: se mueven por nombre (a4→3-189, b9→3-154), sin archivar", finals.includes("a4:3-189") && finals.includes("b9:3-154") && !calls.some((c) => c.m === "DELETE"), JSON.stringify(finals));
  }
  // closeName_ / groupPeople_ directos
  {
    const { sb } = makeSandbox({});
    check("T13g closeName_: una letra (5+ letras) y abreviatura de apellido sí; nombres de pila parecidos (ANA/ADRIANA, JUAN/JULIAN, LUIS/LUISA, ROSA/ROSARIO), dos palabras distintas o distinto número de palabras no",
      sb.closeName_("PERES RUIZ JUAN", "PEREZ RUIZ JUAN") && sb.closeName_("HDZ MORA PEDRO", "HERNANDEZ MORA PEDRO") && sb.closeName_("HDEZ MORA PEDRO", "HERNANDEZ MORA PEDRO")
      && !sb.closeName_("PEREZ JUAN", "PEREZ RUIZ JUAN") && !sb.closeName_("PEREZ RUIZ JUAN", "LOPEZ SOTO MIGUEL") && !sb.closeName_("JUAN PEREZ", "MARIA PEREZ LOPEZ SOTO")
      && !sb.closeName_("HERNANDEZ ANA", "HERNANDEZ ADRIANA") && !sb.closeName_("PEREZ LOPEZ JUAN", "PEREZ LOPEZ JULIAN") && !sb.closeName_("SOTO LUIS", "SOTO LUISA")
      && !sb.closeName_("DIAZ ROSA", "DIAZ ROSARIO") && !sb.closeName_("PERES RUIS JUAN", "PEREZ RUIZ JUAN"));
    const g = sb.groupPeople_([{ nombre: "PEREZ RUIZ" }, { nombre: "PEREZ RUIZ JUAN CARLOS" }, { nombre: "PEREZ RUIZ MARIA ELENA" }]);
    const d = sb.dedupAndQuarantine_([{ cama: "3-101", exp: "X", nombre: "PEREZ RUIZ" }, { cama: "3-154", exp: "X", nombre: "PEREZ RUIZ JUAN CARLOS" }, { cama: "3-189", exp: "X", nombre: "PEREZ RUIZ MARIA ELENA" }]);
    check("T13h solo apellidos que encajan con dos personas: va aparte y no las junta; entran las 3 filas con aviso de exp repetido",
      g.length === 3 && d.keep.length === 3 && d.avisos.some((a) => a.motivo === "exp_repetido_sincronizado"), JSON.stringify({ g: g.length, keep: d.keep.map((p) => p.cama) }));
  }
}

// ── 14) Revisión: un movimiento que falla no deja que el upsert pise la fila que no se movió ─────────────────
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const cur = [{ id: "p1", cama: "3-101", exp: "1", nombre: "P 1", updated_by: "sheet-sync" }];
  const { sb, calls } = makeSandbox({ cur, props: {}, handler: (m, u) => (m === "PATCH" && u.includes("id=eq.p1") ? { code: 409, body: "duplicate key" } : null) });
  sb.syncPatients_("svc", fill([row("3-102", "1"), row("3-101", "3", { nombre: "R NUEVO" })]));
  const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
  const camas = up && Array.isArray(up.body) ? up.body.map((p) => p.cama) : [];
  check("T14 PATCH de cama fallido: ni 3-101 (origen) ni 3-102 (destino) van al upsert esta corrida (la nota de p1 no recibe el nombre de R)",
    !!up && !camas.includes("3-101") && !camas.includes("3-102") && camas.length === 12, JSON.stringify(camas));
}

// ── 15) Segunda revisión: el "nombre casi igual" nunca le da la fila (y la nota) de alguien a otra persona ──────
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.nombre) : []; };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));
  const MARIO = "LOPEZ GARCIA MARIO", MARIA = "LOPEZ GARCIA MARIA";
  // MARIO se mueve a 3-189 y en su cama entra MARIA (apellidos iguales, una letra en el nombre, exp copiado)
  for (const edades of [[40, 38], [40, 40]]) {
    const a4 = { id: "a4", cama: "3-154", exp: "X", nombre: MARIO, edad: String(edades[0]), updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a4], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: MARIA, edad: edades[1] }), row("3-189", "X", { nombre: MARIO, edad: edades[0] })]));
    const ps = patches(calls);
    check("T15a MARIO→3-189 y MARIA entra a 3-154 (edades " + edades.join("/") + "): a4 (MARIO, con su nota) se MUEVE a 3-189; MARIA entra nueva; nunca se renombra a4",
      ps.length === 1 && ps[0].startsWith("a4:") && ps[0].includes('"cama":"3-189"') && upsertOf(calls).includes("3-154:" + MARIA) && !calls.some((c) => c.m === "DELETE"), JSON.stringify({ ps, up: upsertOf(calls) }));
  }
  // MARIO ya no está; MARIA (otra edad) entra con su exp a una cama libre y una tercera persona también tiene X
  {
    const a4 = { id: "a4", cama: "3-154", exp: "X", nombre: MARIO, edad: "40", updated_by: "sheet-sync" }, t1 = { id: "t1", cama: "3-110", exp: "X", nombre: "DIAZ MORA PEDRO", edad: "60", updated_by: "sheet-sync" };
    const st = { cur: [a4, t1], props: {} };
    const { sb, calls } = makeSandbox(st);
    sb.syncPatients_("svc", fill([row("3-110", "X", { nombre: "DIAZ MORA PEDRO", edad: 60 }), row("3-170", "X", { nombre: MARIA, edad: 25 })]));
    check("T15b MARIO sale y MARIA (25 años) entra con su exp a 3-170: a4 NO se mueve a la cama de MARIA (queda en gracia); MARIA entra nueva",
      !patches(calls).some((p) => p.startsWith("a4:")) && typeof JSON.parse(st.props.PL_MISSING_SINCE || "{}").a4 === "number" && upsertOf(calls).includes("3-170:" + MARIA), JSON.stringify({ ps: patches(calls), up: upsertOf(calls) }));
  }
  // fila con solo apellidos + JUAN cambia de cama: se mueve JUAN (no se retira ni se recrea vacío)
  {
    const cur = [{ id: "s1", cama: "3-101", exp: "X", nombre: "PEREZ RUIZ", updated_by: "sheet-sync" }, { id: "j1", cama: "3-154", exp: "X", nombre: "PEREZ RUIZ JUAN CARLOS", updated_by: "sheet-sync" }, { id: "m1", cama: "3-189", exp: "X", nombre: "PEREZ RUIZ MARIA ELENA", updated_by: "sheet-sync" }];
    const { sb, calls } = makeSandbox({ cur, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: "PEREZ RUIZ" }), row("3-160", "X", { nombre: "PEREZ RUIZ JUAN CARLOS" }), row("3-189", "X", { nombre: "PEREZ RUIZ MARIA ELENA" })]));
    const ps = patches(calls);
    check("T15c exp con una fila de solo apellidos: JUAN CARLOS pasa a 3-160 por PATCH (su nota viaja); s1 y m1 se quedan; nada se archiva",
      ps.length === 1 && ps[0].startsWith("j1:") && ps[0].includes('"cama":"3-160"') && !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive")), JSON.stringify(ps));
  }
}

// ── 16) Caso real 18 oct: a la 3-189 le corrigen el exp y el viejo queda solo en la 3-154, de OTRA persona ──────
//        Antes: la fila de la 3-189 (con su nota) se movía a la 3-154 por expediente y recibía el otro nombre.
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : []; };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));
  const A = "PEREZ RUIZ JUAN CARLOS", B = "LOPEZ SOTO MIGUEL ANGEL";
  {
    const b9 = { id: "b9", cama: "3-189", exp: "X", nombre: B, edad: "31", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: A, edad: 44 }), row("3-189", "Y", { nombre: B, edad: 31 })]));
    const ps = patches(calls), up = upsertOf(calls);
    check("T16a exp corregido en 3-189 y el viejo solo en 3-154 (otra persona): b9 se queda en 3-189 y solo se le corrige el exp; NUNCA se mueve a 3-154 ni recibe el otro nombre",
      ps.length === 1 && ps[0] === 'b9:{"exp":"Y","updated_by":"sheet-sync"}' && up.includes("3-154:X:" + A) && up.includes("3-189:Y:" + B)
      && !calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive")), JSON.stringify({ ps, up }));
  }
  // misma cama + mismo exp (único) pero OTRA persona (exp copiado a un ingreso nuevo): cama reasignada, no renombrar
  {
    const a1 = { id: "a1", cama: "3-101", exp: "X", nombre: A, edad: "44", updated_by: "sheet-sync" };
    const full = { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de A" }] } };
    const { sb, calls } = makeSandbox({ cur: [a1], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: B, edad: 31 })]));
    const arc = calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive"));
    const iDel = seq(calls, (c) => c.m === "DELETE" && c.u.includes("/patients?id=eq.a1")), iUp = seq(calls, (c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
    check("T16b exp único copiado a otra persona en la misma cama: a1 (con su nota) se archiva como cama reasignada ANTES de insertar a la otra persona; no se renombra",
      !!arc && arc.body.patient_data.nombre === A && /CAMA REASIGNADA/.test(arc.body.note_data._egreso) && iDel >= 0 && iUp > iDel && upsertOf(calls).includes("3-101:X:" + B), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
  // flujo normal: nombre corregido en la hoja (abreviatura/una letra) con exp único → misma persona, sin archivar
  {
    const a1 = { id: "a1", cama: "3-101", exp: "X", nombre: "GARCIA LOPZ JUAN", edad: "50", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: "GARCIA LOPEZ JUAN", edad: 50 })]));
    check("T16c exp único + nombre corregido (LOPZ→LOPEZ): sigue siendo la misma fila (sin archivo, sin PATCH)", !calls.some((c) => c.m === "DELETE" || c.m === "PATCH" || c.u.startsWith("/rest/v1/archive")));
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [{ ...a1, nombre: "JUAN GARCIA" }], props: {} });
    sb2.syncPatients_("svc", fill([row("3-107", "X", { nombre: "JUAN CARLOS GARCIA LOPEZ", edad: 50 })]));
    const ps = patches(c2);
    check("T16d exp único + cambio de cama con nombre más completo: se MUEVE por expediente como siempre", ps.length === 1 && ps[0].includes('"cama":"3-107"'), JSON.stringify(ps));
    const { sb: sb3, calls: c3 } = makeSandbox({ cur: [{ id: "a1", cama: "3-101", exp: "X", nombre: "", updated_by: "sheet-sync" }], props: {} });
    sb3.syncPatients_("svc", fill([row("3-107", "X", { nombre: B })]));
    check("T16e fila sin nombre en Supabase: se decide por expediente como antes", patches(c3).some((p) => p.includes('"cama":"3-107"')), JSON.stringify(patches(c3)));
  }
}

// ── 17) Revisión del #191: con exp único, una corrección NORMAL del nombre sigue siendo la misma fila (con su
//        nota); solo un nombre que prueba que es otra persona cuenta como cama reasignada o bloquea el movimiento.
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i))); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : []; };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));
  const touched = (calls) => calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive"));
  // misma cama: [nombre en Supabase, edad, nombre en la hoja, edad]
  const fixes = [
    ["PEREZ DIAS JUAN", 40, "PEREZ DIAZ JUAN", 40], ["GOMEZ GRACIA LUIS", 40, "GOMEZ GARCIA LUIS", 40], ["GARCIA LOPEZ JUNA", 40, "GARCIA LOPEZ JUAN", 40],
    ["PERES RUIS JUAN", 40, "PEREZ RUIZ JUAN", 40], ["HERNADES RUIZ JUAN", 40, "HERNANDEZ RUIZ JUAN", 40],
    ["HDZ LOPEZ JUAN", 40, "HERNANDEZ LOPEZ JUAN CARLOS", 40], ["GARCIA LOPEZ J", 40, "GARCIA LOPEZ JUAN", 40],
    ["PEREZ DELACRUZ JUAN", 40, "PEREZ DE LA CRUZ JUAN", 40], ["DESCONOCIDO MASCULINO", "", "PEREZ LOPEZ JUAN", 40],
    ["PERES RUIZ JUAN", 45, "PEREZ RUIZ JUAN", 54]
  ];
  const kept = fixes.filter(([n1, e1, n2, e2]) => {
    const a1 = { id: "a1", cama: "3-101", exp: "X", nombre: n1, edad: String(e1), updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: n2, edad: e2 })]));
    return !touched(calls) && !calls.some((c) => c.m === "PATCH") && upsertOf(calls).includes("3-101:X:" + n2);
  });
  check("T17a exp único, misma cama, nombre corregido (DIAS→DIAZ, GRACIA→GARCIA, JUNA→JUAN, dos letras, HDZ + 2º nombre, J→JUAN, DELACRUZ, DESCONOCIDO→nombre, edad corregida): misma fila, sin archivo",
    kept.length === fixes.length, JSON.stringify(fixes.filter((f) => !kept.includes(f)).map((f) => f[0] + "→" + f[2])));
  // cambio de cama + nombre corregido en la misma corrida → se MUEVE (la nota viaja)
  for (const [n1, n2, dest] of [["DIAS LOPEZ JUAN", "DIAZ LOPEZ JUAN", "3-162"], ["HDZ LOPEZ JUAN", "HERNANDEZ LOPEZ JUAN CARLOS", "UCI 3"]]) {
    const a1 = { id: "a1", cama: "3-150", exp: "X", nombre: n1, edad: "45", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row(dest, "X", { nombre: n2, edad: 45 })]));
    const ps = patches(calls);
    check("T17b cambio de cama 3-150→" + dest + " + nombre corregido (" + n1 + "→" + n2 + "): PATCH de cama sobre a1, sin archivo",
      ps.length === 1 && ps[0].startsWith("a1:") && ps[0].includes('"cama":"' + dest + '"') && !touched(calls), JSON.stringify(ps));
  }
  // cama cambiada desde la app + nombre corregido en la app; la hoja sigue con la cama y la grafía viejas → pin
  {
    const a1 = { id: "a1", cama: "3-105", exp: "X", nombre: "DIAZ LOPEZ JUAN", edad: "45", updated_by: "residente", cama_app_ts: "2026-10-19T05:00:00Z", cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: "DIAS LOPEZ JUAN", edad: 45 })]));
    const ps = patches(calls), up = upsertOf(calls);
    check("T17c Editar mueve a 3-105 y corrige DIAS→DIAZ; la hoja aún dice 3-101 con DIAS: se fija la cama (cama_hoja_prev=3-101), 3-101 no se duplica",
      ps.length === 1 && ps[0] === 'a1:{"cama_hoja_prev":"3-101"}' && !up.some((u) => u.startsWith("3-101:")) && !touched(calls), JSON.stringify({ ps, up }));
  }
  // el caso real con UN apellido en común y otra edad: nunca se mueve ni se renombra
  {
    const b9 = { id: "b9", cama: "3-189", exp: "X", nombre: "PEREZ SOTO MIGUEL", edad: "31", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: "PEREZ RUIZ JUAN CARLOS", edad: 44 }), row("3-189", "Y", { nombre: "PEREZ SOTO MIGUEL", edad: 31 })]));
    const ps = patches(calls);
    check("T17d exp corregido en 3-189 y el viejo en 3-154 con un apellido en común: b9 solo corrige su exp, no se mueve",
      ps.length === 1 && ps[0] === 'b9:{"exp":"Y","updated_by":"sheet-sync"}' && !touched(calls), JSON.stringify(ps));
  }
  // hermanos (mismos apellidos, otro nombre de pila, otra edad) con el exp copiado en la misma cama → cama reasignada
  {
    const a1 = { id: "a1", cama: "3-101", exp: "X", nombre: "PEREZ LOPEZ JUAN", edad: "31", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de JUAN" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "X", { nombre: "PEREZ LOPEZ MARIA", edad: 44 })]));
    const arc = calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive"));
    check("T17e mismos apellidos, otro nombre de pila y otra edad (exp copiado): a1 se archiva como cama reasignada, no se renombra",
      !!arc && arc.body.patient_data.nombre === "PEREZ LOPEZ JUAN" && /CAMA REASIGNADA/.test(arc.body.note_data._egreso), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
  // nombre parecido en la cama del exp, pero su nombre tal cual está en otra cama (con otro exp): ahí está su fila
  {
    const b9 = { id: "b9", cama: "3-189", exp: "X", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: "PEREZ LOPEZ MARIA", edad: 40 }), row("3-189", "Y", { nombre: "PEREZ LOPEZ JUAN", edad: 40 })]));
    const ps = patches(calls);
    check("T17f su nombre sigue en 3-189 con exp corregido: no se mueve a 3-154 aunque el nombre de ahí se parezca",
      ps.length === 1 && ps[0] === 'b9:{"exp":"Y","updated_by":"sheet-sync"}' && !touched(calls), JSON.stringify(ps));
  }
  // reglas directas
  {
    const { sb } = makeSandbox({});
    const P = (n, e) => ({ nombre: n, edad: e });
    check("T17g namesCompatible_: errores de dedo, abreviaturas, espacios y no identificados sí; un apellido en común o hermanos con otra edad no",
      sb.namesCompatible_(P("CRUS LOPEZ ANA", "40"), P("CRUZ LOPEZ ANA", 40)) && sb.namesCompatible_(P("GOMEZ MARIAJOSE", "40"), P("GOMEZ MARIA JOSE", 40))
      && sb.namesCompatible_(P("RN DE PEREZ", ""), P("GOMEZ PEREZ LUIS", 1)) && sb.namesCompatible_(P("HDZ LOPEZ FCO JAVIER", "40"), P("HERNANDEZ LOPEZ FRANCISCO JAVIER", 40))
      && !sb.namesCompatible_(P("PEREZ RUIZ JUAN CARLOS", "44"), P("PEREZ SOTO MIGUEL", 31)) && !sb.namesCompatible_(P("GARCIA ANA", "30"), P("LOPEZ ANA", 30))
      && !sb.namesCompatible_(P("PEREZ LOPEZ JUAN", "31"), P("PEREZ LOPEZ MARIA", 44)) && !sb.namesCompatible_(P("PEREZ", "40"), P("GOMEZ", 40)));
  }
}

// ── 18) Tercera revisión: la regla de exp único no depende de la edad ni de nombres de otras camas ───────────────
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i), { nombre: "RELLENO " + "ABCDEFGHIJKL"[i] + " SOTO" })); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : []; };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));
  const touched = (calls) => calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive"));
  const sameBed = (n1, n2, extraSheet, e1, e2) => {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: n1, edad: String(e1 == null ? 40 : e1), updated_by: "sheet-sync" };
    const full = { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de a1" }] } };
    const { sb, calls } = makeSandbox({ cur: [a1], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "77", { nombre: n2, edad: e2 == null ? 40 : e2 })].concat(extraSheet || [])));
    return calls;
  };
  // correcciones que la versión anterior archivaba
  const keep = [["PEREZ J", "PEREZ JUAN"], ["JUAN PEREZ", "J PEREZ"], ["J. PEREZ L.", "JUAN PEREZ LOPEZ"], ["DE LA CRUZ ANA", "DELACRUZ ANA MARIA"],
    ["DELACRUZ ANA", "DE LA CRUS ANA"], ["MONTESDEOCA ANA", "MONTES DE OCA ANA LUISA"], ["MARIA JOSE PEREZ", "MARIAJOSE PERES"], ["ALEJ PEREZ", "ALEJANDRO PEREZ"],
    ["BAEZ ANA", "VAES ANA"], ["FEMENINA", "PEREZ LOPEZ ANA"], ["NO IDENT.", "PEREZ ANA"], ["XX", "PEREZ JUAN"], ["SIN DATOS", "PEREZ JUAN"], ["DESCONOSIDO", "PEREZ JUAN"],
    ["N.N.", "PEREZ JUAN"], ["PEREZ LOPEZ J", "PEREZ LOPEZ JUAN", 40, 43]];
  const lost = keep.filter(([n1, n2, e1, e2]) => { const c = sameBed(n1, n2, [], e1, e2); return touched(c) || !upsertOf(c).includes("3-101:77:" + n2); });
  check("T18a exp único, misma cama: inicial J, partículas juntas/separadas, palabras pegadas, abreviatura ALEJ, mismo sonido (BAEZ/VAES), no identificados (FEMENINA, NO IDENT., XX, SIN DATOS, DESCONOSIDO, N.N.) y edad cambiada: misma fila, sin archivo",
    lost.length === 0, JSON.stringify(lost.map((f) => f[0] + "→" + f[1])));
  // un tocayo en otra cama (con otro exp) ya no hace que una corrección parezca otra persona
  const namesake = [["PEREZ JOSE", "PEREZ JOSUE", "PEREZ SOTO JOSE"], ["PEREZ DIAS", "PEREZ DIAZ", "PEREZ DIAS ROSA"], ["GARCIA ANA", "GARCIA ANNA", "GARCIA LOPEZ ANA"], ["LOPEZ MARIA", "LOPES MARIA ELENA", "LOPEZ RUIZ MARIA"]];
  const lost2 = namesake.filter(([n1, n2, other]) => touched(sameBed(n1, n2, [row("3-140", "55", { nombre: other, edad: 70 })])));
  check("T18b corrección con un tocayo en otra cama (PEREZ JOSE→JOSUE con PEREZ SOTO JOSE en 3-140, etc.): misma fila, sin archivo", lost2.length === 0, JSON.stringify(lost2.map((f) => f[0])));
  // cambio de cama + inicial completada
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ J", edad: "40", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("UCI 3", "77", { nombre: "PEREZ JUAN", edad: 40 })]));
    const ps = patches(calls);
    check("T18c cambio de cama + inicial completada (PEREZ J → PEREZ JUAN en UCI 3): PATCH de cama, la nota viaja", ps.length === 1 && ps[0].includes('"cama":"UCI 3"') && !touched(calls), JSON.stringify(ps));
  }
  // otra persona: exp copiado a un conocido → DESCONOCIDO, hermanos JUAN/JUANA y LUIS/LUISA con cualquier edad, dos nombres de pila iguales
  const other = [["HERNANDEZ LOPEZ MARIA ELENA", "DESCONOCIDO"], ["PEREZ LOPEZ JUAN", "PEREZ LOPEZ JUANA"], ["SOTO LUIS", "SOTO LUISA"], ["PEREZ LOPEZ MARIO", "PEREZ LOPEZ MARIA"],
    ["LOPEZ PEREZ MARIA GUADALUPE", "SANCHEZ RUIZ MARIA GUADALUPE"], ["TORRES NAVA JUAN CARLOS", "MENDEZ SOLIS JUAN CARLOS"], ["MARIA LOPEZ", "HIJO DE MARIA LOPEZ"]];
  const renamed = other.filter(([n1, n2]) => {
    const c = sameBed(n1, n2, [], 40, 40);   // misma edad a propósito: en la hoja suele quedarse la del ocupante anterior
    const arc = c.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/archive"));
    return !(arc && arc.body.patient_data.nombre === n1 && /CAMA REASIGNADA/.test(arc.body.note_data._egreso));
  });
  check("T18d exp copiado a OTRA persona en la misma cama, aun con la edad del ocupante anterior (DESCONOCIDO, JUANA, LUISA, MARIA, mismos nombres de pila y otros apellidos, HIJO DE…): cama reasignada, nunca se renombra la fila con su nota",
    renamed.length === 0, JSON.stringify(renamed.map((f) => f[0] + "→" + f[1])));
  // caso real con un DESCONOCIDO en la 3-189: no se mueve a la cama de la otra persona; solo se le corrige el exp
  {
    const b9 = { id: "b9", cama: "3-189", exp: "26-1500", nombre: "DESCONOCIDO", edad: "", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "26-1500", { nombre: "TORRES NAVA RAUL", edad: 52 }), row("3-189", "26-1777", { nombre: "DESCONOCIDO" })]));
    const ps = patches(calls), up = upsertOf(calls);
    // La misma foto también es "lo identificaron, se fue a la 3-154 y en la 3-189 entró otro desconocido": sin fecha de
    // ingreso que lo aclare no se adivina (T19f): nada se mueve ni se archiva, las dos camas esperan y hay aviso.
    check("T18e exp corregido a un DESCONOCIDO en 3-189 y el viejo en 3-154 (otra persona con nombre): empate → b9 no se mueve ni se archiva; 3-154 y 3-189 esperan a que la hoja lo aclare",
      ps.length === 0 && !touched(calls) && !up.some((u) => u.startsWith("3-154:") || u.startsWith("3-189:")) && calls.some((c) => c.m === "POST" && c.u.startsWith("/rest/v1/sync_log") && JSON.stringify(c.body).includes("no_identificado_ambiguo")), JSON.stringify({ ps, up }));
    // ...pero un DESCONOCIDO que de verdad cambió de cama (su cama vieja quedó libre) sí se mueve por expediente
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [b9], props: {} });
    sb2.syncPatients_("svc", fill([row("3-154", "26-1500", { nombre: "DESCONOCIDO" })]));
    check("T18f DESCONOCIDO que cambia de cama (3-189 → 3-154): se mueve por expediente con su nota", patches(c2).some((p) => p.startsWith("b9:") && p.includes('"cama":"3-154"')) && !touched(c2), JSON.stringify(patches(c2)));
  }
  // turnover reescribiendo celdas: primero el exp (se corrige en la misma fila), luego el nombre de OTRA persona → cama reasignada
  {
    const a1 = { id: "a1", cama: "3-101", exp: "26-1111", nombre: "LOPEZ PEREZ MARIA GUADALUPE", edad: "67", updated_by: "sheet-sync" };
    const full = { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de MARIA GUADALUPE" }] } };
    const { sb, calls } = makeSandbox({ cur: [{ ...a1, exp: "26-2222" }], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "26-2222", { nombre: "SANCHEZ RUIZ MARIA GUADALUPE", edad: 67 })]));
    const arc = calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive"));
    check("T18g cama que se reescribe celda por celda (exp ya corregido, luego el nombre de otra persona con la edad vieja): se archiva la anterior, no se renombra",
      !!arc && arc.body.patient_data.nombre === "LOPEZ PEREZ MARIA GUADALUPE" && upsertOf(calls).includes("3-101:26-2222:SANCHEZ RUIZ MARIA GUADALUPE"), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
  }
}

// ── 19) Cuarta revisión: correcciones hechas en la app, apellidos con A/O, apodos, más no identificados, palabras de 3
//        letras, el empate del no identificado que se mueve y el caso real con nombres parecidos ────────────────────────
{
  const fill = (sheet) => { for (let i = 0; i < 12; i++) sheet.push(row("4-" + (10 + i), String(100 + i), { nombre: "RELLENO " + "ABCDEFGHIJKL"[i] + " SOTO" })); return sheet; };
  const upsertOf = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama + ":" + p.exp + ":" + p.nombre) : []; };
  const patches = (calls) => calls.filter((c) => c.m === "PATCH").map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + JSON.stringify(c.body));
  const touched = (calls) => calls.some((c) => c.m === "DELETE" || c.u.startsWith("/rest/v1/archive"));
  const sameBed = (n1, n2, extra) => {
    const a1 = Object.assign({ id: "a1", cama: "3-101", exp: "77", nombre: n1, edad: "40", updated_by: "sheet-sync" }, extra || {});
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de a1" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "77", { nombre: n2, edad: 40 })]));
    return calls;
  };
  const moved = (n1, n2) => {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: n1, edad: "40", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-120", "77", { nombre: n2, edad: 40 })]));
    return patches(calls).some((p) => p.startsWith("a1:") && p.includes('"cama":"3-120"')) && !touched(calls);
  };
  // (a) fila escrita desde la APP (updated_by ≠ sheet-sync) con OTRO nombre en la hoja y el mismo exp: pudo ser que el
  //     residente identificó o corrigió el nombre y la hoja va atrasada, o que la hoja puso un ingreso nuevo encima con
  //     el exp copiado. No se adivina: ni Papelera (perdería la corrección) ni renombrar (la nota quedaría bajo otro
  //     nombre): la cama queda fuera del upsert, sin PATCH, y hay aviso nombre_app_vs_hoja en sync_log.
  const appHold = [["TORRES NAVA RAUL", "DESCONOCIDO MASCULINO"], ["PEREZ LOPEZ JUAN", "PEREZ LOPEZ JOSE"], ["PEREZ GOMEZ JUAN", "PEREZ LOPEZ JUAN"],
    ["PEREZ RUIZ JUAN CARLOS", "LOPEZ SOTO MIGUEL ANGEL"], ["PEREZ RUIZ JUAN CARLOS", "GOMEZ VEGA ANA LAURA"]];
  // La única escritura permitida mientras espera: la marca ok@hold (una vez) para que el retiro con gracia lo alcance.
  const MARK = 'a1:{"cama_hoja_prev":"ok@hold"}';
  const badHold = appHold.filter(([app, hoja]) => {
    const c = sameBed(app, hoja, { updated_by: "residente" }), up = upsertOf(c), ps = patches(c);
    const log = c.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    return touched(c) || ps.length !== 1 || ps[0] !== MARK || up.some((u) => u.startsWith("3-101:")) || up.length !== 12 || !log || !JSON.stringify(log.body).includes("nombre_app_vs_hoja");
  });
  check("T19a fila escrita desde la app con OTRO nombre en la hoja (identificación/corrección atrasada o ingreso nuevo con el exp copiado): ni Papelera ni renombrar; la cama espera fuera del upsert, hay aviso nombre_app_vs_hoja y solo se escribe la marca ok@hold", badHold.length === 0, JSON.stringify(badHold));
  {
    // ...y con la marca ya puesta no se vuelve a escribir nada; updated_by sigue siendo el del residente (la espera persiste)
    const c = sameBed("TORRES NAVA RAUL", "DESCONOCIDO MASCULINO", { updated_by: "residente", cama_hoja_prev: "ok@hold" });
    check("T19a-m con la marca ok@hold puesta, en espera no hay ningún PATCH más ni upsert de esa cama", patches(c).length === 0 && !touched(c) && !upsertOf(c).some((u) => u.startsWith("3-101:")), JSON.stringify(patches(c)));
  }
  // ...pero si el nombre de la hoja SÍ es compatible (la app solo cambió dx/estado, o la hoja completó el nombre), sigue igual
  const appSame = [["PEREZ RUIZ JUAN CARLOS", "PEREZ RUIZ JUAN CARLOS"], ["PEREZ LOPEZ JUAN", "PEREZ LOPEZ JUAN CARLOS"], ["DESCONOCIDO", "PEREZ LOPEZ JUAN"]];
  const badSame = appSame.filter(([app, hoja]) => { const c = sameBed(app, hoja, { updated_by: "residente" }); return touched(c) || patches(c).length || !upsertOf(c).includes("3-101:77:" + hoja); });
  check("T19a' fila escrita desde la app con nombre compatible en la hoja (solo cambió dx/estado, nombre completado, no identificado que la hoja identifica): sigue igual y se upsertea", badSame.length === 0, JSON.stringify(badSame));
  // ...y cuando la hoja ya cambió el exp de esa cama, es cama reasignada normal (se archiva con su nota, entra el nuevo)
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ RUIZ JUAN CARLOS", edad: "44", updated_by: "residente" };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de a1" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "88", { nombre: "LOPEZ SOTO MIGUEL ANGEL", edad: 31 })]));
    const arc = calls.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre);
    check("T19a'' fila escrita desde la app y la hoja ya puso OTRO exp y otro nombre en su cama: cama reasignada normal (se archiva con su nota y entra el nuevo)", arc.length === 1 && arc[0] === "PEREZ RUIZ JUAN CARLOS" && upsertOf(calls).includes("3-101:88:LOPEZ SOTO MIGUEL ANGEL"), JSON.stringify({ arc, up: upsertOf(calls).slice(0, 2) }));
  }
  // (h) la hoja MUEVE (cortar/pegar) al paciente que el residente identificó en la app, aún como no identificado:
  //     se mueve conservando su nombre (el PATCH no toca updated_by), la cama nueva no se upsertea y en la siguiente
  //     corrida espera ahí; cuando la hoja escribe el nombre, sigue igual. Si la hoja lo mueve con OTRO nombre, las dos
  //     camas esperan (ni se mueve, ni se archiva, ni entra el nuevo ocupante de la cama vieja sobre su fila).
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const full = { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de JUAN" }] } };
    const { sb, calls } = makeSandbox({ cur: [a1], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO", edad: 40 })]));
    const ps = patches(calls), up = upsertOf(calls);
    check("T19h la hoja mueve a 3-105 (aún DESCONOCIDO) al que la app identificó: se MUEVE con su nota conservando updated_by; 3-105 no se upsertea; sin archivo ni duplicado",
      ps.length === 1 && ps[0] === 'a1:{"cama":"3-105"}' && !touched(calls) && !up.some((u) => u.startsWith("3-105:")) && up.length === 12, JSON.stringify({ ps, up: up.filter((u) => /3-10/.test(u)) }));
    const a1m = { ...a1, cama: "3-105" };
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [a1m], full: { a1: { ...a1m, notes: [] } }, props: {} });
    sb2.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO", edad: 40 })]));
    const log2 = c2.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    check("T19h' en la cama nueva sigue esperando (aviso nombre_app_vs_hoja, marca ok@hold, sin upsert de 3-105)", patches(c2).length === 1 && patches(c2)[0] === 'a1:{"cama_hoja_prev":"ok@hold"}' && !touched(c2) && !upsertOf(c2).some((u) => u.startsWith("3-105:")) && !!log2 && JSON.stringify(log2.body).includes("3-105"), JSON.stringify(patches(c2)));
    const { sb: sb3, calls: c3 } = makeSandbox({ cur: [{ ...a1m, cama_hoja_prev: "ok@hold" }], props: {} });
    sb3.syncPatients_("svc", fill([row("3-105", "77", { nombre: "PEREZ LOPEZ JUAN", edad: 40 })]));
    check("T19h'' la hoja escribe su nombre en 3-105: sigue igual y se upsertea", patches(c3).length === 0 && !touched(c3) && upsertOf(c3).includes("3-105:77:PEREZ LOPEZ JUAN"), JSON.stringify(upsertOf(c3).slice(0, 2)));
    // otro nombre en la cama nueva y un ingreso nuevo en la vieja: esperan las dos camas
    const { sb: sb4, calls: c4 } = makeSandbox({ cur: [a1], full, props: {} });
    sb4.syncPatients_("svc", fill([row("3-105", "77", { nombre: "LOPEZ SOTO MIGUEL ANGEL", edad: 31 }), row("3-101", "88", { nombre: "GOMEZ RUIZ ANA", edad: 60 })]));
    const up4 = upsertOf(c4), log4 = c4.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    check("T19h''' la hoja tiene su exp en 3-105 con OTRO nombre y a otra persona en 3-101: ni se mueve ni se archiva; 3-101 y 3-105 esperan fuera del upsert (la fila con su nota no recibe a nadie) y el aviso nombra las dos camas",
      patches(c4).length === 1 && patches(c4)[0] === 'a1:{"cama_hoja_prev":"ok@hold"}' && !touched(c4) && !up4.some((u) => u.startsWith("3-101:") || u.startsWith("3-105:")) && up4.length === 12 && !!log4 && JSON.stringify(log4.body).includes("3-101, 3-105"), JSON.stringify({ ps: patches(c4), up: up4.filter((u) => /3-10/.test(u)), log: log4 && log4.body }));
  }
  // (i) fila en espera que la hoja da de alta (la cama desaparece): con la marca ok@hold entra a la gracia y se retira
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: "ok@hold" };
    const st = { cur: [a1], full: { a1: { ...a1, notes: [] } }, props: {} };
    const { sb, calls } = makeSandbox(st);
    sb.syncPatients_("svc", fill([]));
    const since = JSON.parse(st.props.PL_MISSING_SINCE || "{}");
    check("T19i fila en espera (marca ok@hold) cuya cama ya no está en la hoja: entra al periodo de gracia", !!since.a1 && !touched(calls), JSON.stringify(st.props));
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [] } }, props: missingOld(["a1"]) });
    sb2.syncPatients_("svc", fill([]));
    const arc = c2.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre);
    check("T19i' ...y tras la gracia se retira del censo (archivada con su nota)", arc.length === 1 && arc[0] === "PEREZ LOPEZ JUAN" && c2.some((c) => c.m === "DELETE" && c.u.includes("id=eq.a1")), JSON.stringify(arc));
  }
  // (j) exp corregido en la hoja en una fila que SIGUE como no identificado (el residente ya lo identificó en la app):
  //     espera en vez de archivarse; cuando la hoja escribe su nombre, corrección de exp sobre la misma fila
  {
    const a1 = { id: "a1", cama: "3-101", exp: "26-1500", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const full = { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de JUAN" }] } };
    const { sb, calls } = makeSandbox({ cur: [a1], full, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "26-1050", { nombre: "DESCONOCIDO", edad: 40 })]));
    const log = calls.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    check("T19j exp corregido en la hoja con la fila aún DESCONOCIDO y la app ya con nombre: espera (sin archivo, solo la marca ok@hold, 3-101 fuera del upsert, aviso)", !touched(calls) && patches(calls).length === 1 && patches(calls)[0] === 'a1:{"cama_hoja_prev":"ok@hold"}' && !upsertOf(calls).some((u) => u.startsWith("3-101:")) && !!log && JSON.stringify(log.body).includes("nombre_app_vs_hoja"), JSON.stringify(patches(calls)));
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [{ ...a1, cama_hoja_prev: "ok@hold" }], full, props: {} });
    sb2.syncPatients_("svc", fill([row("3-101", "26-1050", { nombre: "PEREZ LOPEZ JUAN", edad: 40 })]));
    check("T19j' la hoja escribe su nombre: corrección de exp sobre la misma fila (la nota sigue), sin archivo", patches(c2).length === 1 && patches(c2)[0] === 'a1:{"exp":"26-1050","updated_by":"sheet-sync"}' && !touched(c2), JSON.stringify(patches(c2)));
    const { sb: sb3, calls: c3 } = makeSandbox({ cur: [{ ...a1, cama_hoja_prev: "ok@hold" }], full, props: {} });
    sb3.syncPatients_("svc", fill([row("3-101", "26-1050", { nombre: "GOMEZ RUIZ ANA", edad: 60 })]));
    const arc3 = c3.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre);
    check("T19j'' la hoja escribe OTRO nombre con el exp nuevo: cama reasignada normal (se archiva con su nota, entra la nueva)", arc3.length === 1 && arc3[0] === "PEREZ LOPEZ JUAN" && upsertOf(c3).includes("3-101:26-1050:GOMEZ RUIZ ANA"), JSON.stringify(arc3));
  }
  // (l) fila escrita desde la app a la que la hoja le CORRIGIÓ el exp en su cama y el exp viejo quedó en otra cama (el
  //     caso real de la 3-189): manda la corrección de exp; ni se mueve ni espera, aunque en la otra cama haya un no identificado
  for (const other of ["TORRES NAVA RAUL", "DESCONOCIDO"]) {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "78", { nombre: "PEREZ LOPEZ JUAN", edad: 40 }), row("3-105", "77", { nombre: other, edad: 52 })]));
    const ps = patches(calls), up = upsertOf(calls);
    // (tras el PATCH del exp, el upsert de 3-101 cae sobre la misma fila a1 por cama: no es un duplicado)
    check("T19l (app) exp corregido en su cama y el viejo en 3-105 (" + other + "): solo PATCH del exp sobre a1 (sin mover ni esperar), la hoja de 3-101 cae sobre a1 y 3-105 entra como ingreso nuevo",
      ps.length === 1 && ps[0] === 'a1:{"exp":"78","updated_by":"sheet-sync"}' && !touched(calls) && up.includes("3-105:77:" + other) && up.includes("3-101:78:PEREZ LOPEZ JUAN"), JSON.stringify({ ps, up: up.filter((u) => /3-10/.test(u)) }));
  }
  // (m) appMove hacia una cama que en Supabase ocupa OTRO no identificado con otro exp (q), mientras la hoja ahí tiene
  //     el exp de r: dos filas reclaman la misma fila de la hoja. Decide la fecha de ingreso; sin ella, esperan.
  {
    const mk = (ingR, ingQ, ingS, extraSheet) => {
      const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null, ingreso: ingR };
      const q1 = { id: "q1", cama: "3-105", exp: "99", nombre: "DESCONOCIDO", edad: "", updated_by: "sheet-sync", ingreso: ingQ };
      const { sb, calls } = makeSandbox({ cur: [a1, q1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de JUAN" }] }, q1: { ...q1, notes: [] } }, props: {} });
      sb.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO", ingreso: ingS })].concat(extraSheet || [])));
      return { ps: patches(calls), up: upsertOf(calls), arc: calls.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre + "@" + c.body.patient_data.cama), log: calls.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log")) };
    };
    const r1 = mk("2026-10-10", "2026-10-05", "2026-10-10");
    check("T19m la fecha de la fila de la hoja es la de r: q (3-105, otro exp) es cama reasignada (archivada) y r se mueve a 3-105 con su nombre y su nota", r1.arc.length === 1 && r1.arc[0] === "DESCONOCIDO@3-105" && r1.ps.length === 1 && r1.ps[0] === 'a1:{"cama":"3-105"}' && !r1.up.some((u) => u.startsWith("3-105:")), JSON.stringify(r1));
    const r2 = mk("2026-10-10", "2026-10-05", "2026-10-05");
    check("T19m' la fecha es la de q: q corrige su exp a 77 y r (ya no está en la hoja) entra a la gracia con la marca de censo, sin archivo", r2.arc.length === 0 && r2.ps.length === 2 && r2.ps.includes('q1:{"exp":"77","updated_by":"sheet-sync"}') && r2.ps.includes('a1:{"cama_hoja_prev":"ok@hold"}'), JSON.stringify(r2));
    const r2b = mk("2026-10-10", "2026-10-05", "2026-10-05", [row("3-101", "88", { nombre: "GOMEZ RUIZ ANA", edad: 60 })]);
    check("T19m'' la fecha es la de q y en la cama de r ya hay otra persona: q corrige su exp y r se archiva como cama reasignada (no se pisa su fila)", r2b.arc.length === 1 && r2b.arc[0] === "PEREZ LOPEZ JUAN@3-101" && r2b.ps.some((p) => p === 'q1:{"exp":"77","updated_by":"sheet-sync"}') && r2b.up.includes("3-101:88:GOMEZ RUIZ ANA"), JSON.stringify(r2b));
    const r3 = mk(null, null, null);
    check("T19m''' sin fecha que lo aclare: ni se mueve, ni se corrige el exp, ni se archiva; 3-105 espera fuera del upsert y hay aviso cama_en_disputa", r3.arc.length === 0 && r3.ps.length === 0 && !r3.up.some((u) => u.startsWith("3-105:")) && !!r3.log && JSON.stringify(r3.log.body).includes("cama_en_disputa"), JSON.stringify(r3));
  }
  // (n) fila movida desde la APP (cama_app_ts) a la que la hoja ya alcanzó en esa cama pero aún como no identificado: la
  //     espera no impide dar por resuelto el movimiento (marca ok@ts); así un movimiento posterior de la hoja no se toma
  //     como "primera divergencia" con la app ganando para siempre
  {
    const TS = "2026-10-18T10:00:00.000Z";
    const a1 = { id: "a1", cama: "3-120", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_app_ts: TS, cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-120", "77", { nombre: "DESCONOCIDO" })]));
    check("T19n en espera en la cama que fijó la app y la hoja ya la alcanzó: el movimiento de la app queda resuelto (cama_app_ts null, marca ok@ts) y la cama sigue fuera del upsert", patches(calls).length === 1 && patches(calls)[0] === 'a1:{"cama_app_ts":null,"cama_hoja_prev":"ok@' + TS + '"}' && !touched(calls) && !upsertOf(calls).some((u) => u.startsWith("3-120:")), JSON.stringify(patches(calls)));
    // ...y después la hoja lo mueve (aún DESCONOCIDO): se mueve con su nombre (appMove), no se fija la cama vieja
    const a1r = { ...a1, cama_app_ts: null, cama_hoja_prev: "ok@" + TS };
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [a1r], props: {} });
    sb2.syncPatients_("svc", fill([row("3-130", "77", { nombre: "DESCONOCIDO" })]));
    check("T19n' ...y si luego la hoja lo mueve a 3-130 aún como DESCONOCIDO: se mueve con su nombre (no queda fijado en 3-120)", patches(c2).length === 1 && patches(c2)[0] === 'a1:{"cama":"3-130"}' && !touched(c2), JSON.stringify(patches(c2)));
  }
  // (o) exp corregido con el exp nuevo repetido en otra cama (ambiguo): igual espera, no se archiva
  {
    const a1 = { id: "a1", cama: "3-101", exp: "26-1500", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "26-1050", { nombre: "DESCONOCIDO" }), row("3-110", "26-1050", { nombre: "DIAZ MORA PEDRO", edad: 50 })]));
    check("T19o exp corregido a un número que la hoja repite en otra cama, con la fila aún DESCONOCIDO: espera (sin archivo) y la otra cama entra normal", !touched(calls) && !upsertOf(calls).some((u) => u.startsWith("3-101:")) && upsertOf(calls).includes("3-110:26-1050:DIAZ MORA PEDRO"), JSON.stringify(upsertOf(calls).filter((u) => /3-1[01]/.test(u))));
  }
  // (p) dispositivo sin nombre de usuario (updated_by vacío): la fila también cuenta como escrita desde la app
  {
    const c = sameBed("TORRES NAVA RAUL", "DESCONOCIDO MASCULINO", { updated_by: "" });
    check("T19p updated_by vacío (dispositivo sin nombre) con otro nombre en la hoja: también espera, no se archiva", !touched(c) && !upsertOf(c).some((u) => u.startsWith("3-101:")), JSON.stringify(patches(c)));
  }
  // (q) exp corregido en su cama con el nombre compatible pero no igual (inicial, error de dedo, apodo) y el exp viejo
  //     en otra cama: a (d) no le basta y antes se archivaba con su nota; ahora espera hasta que la hoja escriba el nombre
  for (const sheetName of ["PEREZ LOPEZ J", "PERES LOPEZ JUAN", "PEREZ LOPEZ JUNA"]) {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "78", { nombre: sheetName, edad: 40 }), row("3-105", "77", { nombre: "DESCONOCIDO" })]));
    const up = upsertOf(calls), log = calls.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    check("T19q (app) exp corregido en su cama con nombre compatible pero no igual (" + sheetName + ") y el viejo en 3-105: ni archivo ni movimiento; espera con aviso", !touched(calls) && patches(calls).length === 1 && patches(calls)[0] === 'a1:{"cama_hoja_prev":"ok@hold"}' && !up.some((u) => u.startsWith("3-101:")) && !!log && JSON.stringify(log.body).includes("nombre_app_vs_hoja"), JSON.stringify({ ps: patches(calls), up: up.filter((u) => /3-10/.test(u)) }));
  }
  // (r) la hoja reescribe SU fila (exp nuevo, aún DESCONOCIDO) conservando su fecha de ingreso y su exp viejo aparece en
  //     otra cama con otro no identificado: la fecha dice que sigue en su cama → espera ahí, no se mueve
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null, ingreso: "2026-10-10" };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-101", "99", { nombre: "DESCONOCIDO", ingreso: "2026-10-10" }), row("3-105", "77", { nombre: "DESCONOCIDO", ingreso: "2026-10-18" })]));
    const up = upsertOf(calls);
    check("T19r su fecha sigue en su cama (fila reescrita con exp nuevo) y su exp viejo en 3-105 con otra fecha: no se mueve; 3-101 y 3-105 esperan", !touched(calls) && !patches(calls).some((p) => p.includes('"cama"')) && !up.some((u) => u.startsWith("3-101:") || u.startsWith("3-105:")), JSON.stringify({ ps: patches(calls), up: up.filter((u) => /3-10/.test(u)) }));
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [{ ...a1, cama_hoja_prev: "ok@hold" }], props: {} });
    sb2.syncPatients_("svc", fill([row("3-101", "99", { nombre: "PEREZ LOPEZ JUAN", ingreso: "2026-10-10" }), row("3-105", "77", { nombre: "TORRES NAVA RAUL", ingreso: "2026-10-18" })]));
    check("T19r' ...y cuando la hoja escribe los nombres: corrección de exp en su cama y 3-105 entra nuevo", patches(c2).some((p) => p === 'a1:{"exp":"99","updated_by":"sheet-sync"}') && !touched(c2) && upsertOf(c2).includes("3-105:77:TORRES NAVA RAUL"), JSON.stringify(patches(c2)));
  }
  // (s) en la disputa que gana q por fecha, r (ya fuera de la hoja) lleva la marca de censo para que la gracia termine
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null, ingreso: "2026-10-10" };
    const q1 = { id: "q1", cama: "3-105", exp: "99", nombre: "DESCONOCIDO", edad: "", updated_by: "sheet-sync", ingreso: "2026-10-05" };
    const { sb, calls } = makeSandbox({ cur: [a1, q1], props: {} });
    sb.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO", ingreso: "2026-10-05" })]));
    check("T19s disputa que gana q por fecha: r entra a la gracia con la marca ok@hold", patches(calls).includes('a1:{"cama_hoja_prev":"ok@hold"}') && patches(calls).includes('q1:{"exp":"77","updated_by":"sheet-sync"}') && !touched(calls), JSON.stringify(patches(calls)));
    // corrida siguiente: q ya con exp 77 (ambiguo con r), r marcado, gracia vencida → r se retira
    const a1m = { ...a1, cama_hoja_prev: "ok@hold" }, q1f = { ...q1, exp: "77" };
    const { sb: sb2, calls: c2 } = makeSandbox({ cur: [a1m, q1f], full: { a1: { ...a1m, notes: [] }, q1: { ...q1f, notes: [] } }, props: missingOld(["a1"]) });
    sb2.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO", ingreso: "2026-10-05" })]));
    const arc2 = c2.filter((c) => c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.nombre);
    check("T19s' ...y tras la gracia r se retira (archivado con su nota) y q se queda", arc2.length === 1 && arc2[0] === "PEREZ LOPEZ JUAN" && c2.some((c) => c.m === "DELETE" && c.u.includes("id=eq.a1")), JSON.stringify(arc2));
  }
  // (t) appMove hacia una cama que otra fila escrita desde la app dejó en espera: no se intenta el PATCH (chocaría con
  //     UNIQUE en cada corrida y dejaba la cama de origen fuera del upsert sin aviso); esperan las dos con aviso
  {
    const a1 = { id: "a1", cama: "3-101", exp: "77", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "residente", cama_hoja_prev: null };
    const q1 = { id: "q1", cama: "3-105", exp: "99", nombre: "DIAZ MORA PEDRO", edad: "50", updated_by: "residente", cama_hoja_prev: null };
    const { sb, calls } = makeSandbox({ cur: [a1, q1], props: {} });
    sb.syncPatients_("svc", fill([row("3-105", "77", { nombre: "DESCONOCIDO" }), row("3-101", "88", { nombre: "GOMEZ RUIZ ANA", edad: 60 })]));
    const up = upsertOf(calls), logs = calls.filter((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log")).map((x) => JSON.stringify(x.body)).join(" ");
    check("T19t appMove hacia la cama que q (app) dejó en espera: sin PATCH de cama, sin archivo; 3-101 y 3-105 fuera del upsert y aviso cama_en_disputa que nombra 3-101", !patches(calls).some((p) => p.includes('"cama"')) && !touched(calls) && !up.some((u) => u.startsWith("3-101:") || u.startsWith("3-105:")) && logs.includes("cama_en_disputa") && logs.includes("3-101, 3-105"), JSON.stringify({ ps: patches(calls), up: up.filter((u) => /3-10/.test(u)), logs }));
  }
  // (k) no identificado que se movió en la hoja mientras su cama se reescribe para alguien CON nombre que conserva su
  //     fecha de ingreso: la fecha "rancia" no lo deja quieto (no puede ser corrección de exp con otro nombre) → EMPATE
  for (const ingDest of ["2026-10-12", null]) {
    const a1 = { id: "a1", cama: "3-150", exp: "26-1500", nombre: "DESCONOCIDO", edad: "", updated_by: "sheet-sync", ingreso: "2026-10-10" };
    const { sb, calls } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota" }] } }, props: {} });
    sb.syncPatients_("svc", fill([row("3-150", "26-1777", { nombre: "GOMEZ RUIZ ANA", edad: 60, ingreso: "2026-10-10" }), row("3-160", "26-1500", { nombre: "TORRES NAVA RAUL", edad: 52, ingreso: ingDest })]));
    const up = upsertOf(calls), log = calls.find((x) => x.m === "POST" && x.u.startsWith("/rest/v1/sync_log"));
    check("T19k DESCONOCIDO con su exp en 3-160 (nombre, ingreso " + ingDest + ") y en 3-150 otra persona con nombre que conserva SU fecha: no se archiva; empate (3-150 y 3-160 esperan, aviso)",
      !touched(calls) && patches(calls).length === 0 && !up.some((u) => u.startsWith("3-150:") || u.startsWith("3-160:")) && !!log && JSON.stringify(log.body).includes("no_identificado_ambiguo"), JSON.stringify({ ps: patches(calls), up: up.filter((u) => /3-1[56]0/.test(u)) }));
  }
  // (b) apellidos con una A de más o de menos, o A/O: captura, no otra persona; los nombres de pila sí distinguen
  const surn = [["JUAN PEREZ GARCI", "JUAN PEREZ GARCIA"], ["MEDIN LUIS", "MEDINA LUIS"], ["OCHO ANA", "OCHOA ANA"], ["SOTA JUAN", "SOTO JUAN"], ["ZAMORO ANA", "ZAMORA ANA"], ["PEREZ LUN ANA", "PEREZ LUNA ANA"]];
  const lostSurn = surn.filter(([n1, n2]) => touched(sameBed(n1, n2)));
  check("T19b apellido con A de más/menos o A/O (GARCI/GARCIA, SOTA/SOTO, OCHO/OCHOA): misma fila; y se mueve con esa corrección", lostSurn.length === 0 && moved("JUAN PEREZ GARCI", "JUAN PEREZ GARCIA"), JSON.stringify(lostSurn));
  const sib = [["PEREZ LOPEZ JUAN", "PEREZ LOPEZ JUANA"], ["SOTO LUIS", "SOTO LUISA"], ["PEREZ LOPEZ MARIO", "PEREZ LOPEZ MARIA"], ["SOTO RUIZ PAULA", "SOTO RUIZ PAULO"], ["SOTO RUIZ JOSE", "SOTO RUIZ JOSEFA"],
    ["SOTO RUIZ EUGENIO", "SOTO RUIZ EUGENIA"], ["SOTO RUIZ GREGORIO", "SOTO RUIZ GREGORIA"], ["SOTO RUIZ NICOLAS", "SOTO RUIZ NICOLASA"], ["SOTO RUIZ PAULINA", "SOTO RUIZ PAULINO"], ["SOTO RUIZ GERARDO", "SOTO RUIZ GERARDA"],
    ["SOTO RUIZ IVAN", "SOTO RUIZ IVANA"], ["SOTO RUIZ FEDERICO", "SOTO RUIZ FEDERICA"]].filter(([n1, n2]) => !touched(sameBed(n1, n2)));
  check("T19b' JUAN/JUANA, LUIS/LUISA, MARIO/MARIA, PAULA/PAULO, JOSE/JOSEFA y los de 7+ letras (EUGENIO/EUGENIA, GREGORIO/GREGORIA, NICOLAS/NICOLASA…) siguen siendo otra persona (cama reasignada)", sib.length === 0, JSON.stringify(sib));
  // Un apellido largo con A/O al final SÍ se trata como otra persona (regla general de 7+ letras: antes era así en main)
  // pero los cortos (SOTA/SOTO, OCHO/OCHOA) y los nombres de pila de la lista no se confunden con captura.
  // (b'') palabras cortas de 3 letras que son nombres de pila distintos: otra persona (hermanos con los mismos apellidos)
  const sh3other = [["GARCIA LOPEZ LUZ", "GARCIA LOPEZ LUIS"], ["GARCIA LOPEZ LUZ", "GARCIA LOPEZ LIZ"], ["GARCIA LOPEZ EVA", "GARCIA LOPEZ IVA"], ["GARCIA LOPEZ IAN", "GARCIA LOPEZ IVAN"],
    ["GARCIA LOPEZ ELI", "GARCIA LOPEZ ELIA"], ["GARCIA LOPEZ NOE", "GARCIA LOPEZ NOEL"], ["GARCIA LOPEZ LIA", "GARCIA LOPEZ LILA"], ["GARCIA LOPEZ ANA", "GARCIA LOPEZ ADA"], ["GARCIA LOPEZ ANA", "GARCIA LOPEZ LANA"]].filter(([n1, n2]) => !touched(sameBed(n1, n2)));
  check("T19b'' LUZ/LUIS, LUZ/LIZ, EVA/IVA, IAN/IVAN, ELI/ELIA, NOE/NOEL, LIA/LILA, ANA/ADA, ANA/LANA: nombres de pila distintos → otra persona", sh3other.length === 0, JSON.stringify(sh3other));
  // (b''') una N suelta vale por el apellido que falta, pero las palabras reales sí tienen que encajar
  const nWild = [["PEREZ N JUAN", "PEREZ GOMEZ JUAN"], ["NAVA N JUAN", "NAVA LOPEZ JUAN"], ["JUAN N", "JUAN PEREZ LOPEZ"], ["N N", "PEREZ GOMEZ JUAN"]].filter(([n1, n2]) => touched(sameBed(n1, n2)));
  const nReal = [["PEREZ N JUAN", "GOMEZ RUIZ ANA"], ["NAVA N JUAN", "SOTO VEGA LUIS"], ["PEREZ X JUAN", "GOMEZ RUIZ ANA"]].filter(([n1, n2]) => !touched(sameBed(n1, n2)));
  check("T19b''' PEREZ N JUAN → PEREZ GOMEZ JUAN y JUAN N → JUAN PEREZ LOPEZ: misma fila; PEREZ N JUAN → GOMEZ RUIZ ANA: otra persona (la N no vuelve comodín al nombre)", nWild.length === 0 && nReal.length === 0, JSON.stringify({ nWild, nReal }));
  // (c) apodos
  const nick = [["LUPE PEREZ SOTO", "GUADALUPE PEREZ SOTO"], ["PACO LOPEZ RUIZ", "FRANCISCO LOPEZ RUIZ"], ["PEPE RUIZ MORA", "JOSE RUIZ MORA"], ["CHUY GARCIA VEGA", "JESUS GARCIA VEGA"]].filter(([n1, n2]) => touched(sameBed(n1, n2)));
  check("T19c apodo → nombre completo (LUPE, PACO, PEPE, CHUY): misma fila; y se mueve", nick.length === 0 && moved("LUPE PEREZ SOTO", "GUADALUPE PEREZ SOTO"), JSON.stringify(nick));
  // (d) más formas de no identificado
  const ph = [["S/N", "PEREZ JUAN"], ["SIN IDENTIFICAR", "PEREZ JUAN"], ["DECONOCIDO", "PEREZ JUAN"], ["NO IDENTIF.", "PEREZ JUAN"], ["JUAN N", "JUAN PEREZ LOPEZ"], ["N/I", "PEREZ ANA"], ["ANONIMO", "PEREZ ANA"], ["IGNORADO", "PEREZ ANA"]].filter(([n1, n2]) => touched(sameBed(n1, n2)));
  check("T19d no identificado escrito de otras formas (S/N, SIN IDENTIFICAR, DECONOCIDO, NO IDENTIF., JUAN N, N/I, ANONIMO): al identificarlo sigue su fila", ph.length === 0, JSON.stringify(ph));
  // (e) palabras de 3 letras con un error, si todo lo demás es igual
  const sh3 = [["GARCIA LOPEZ AMA", "GARCIA LOPEZ ANA"], ["PEREZ DIA JUAN", "PEREZ DIAZ JUAN"], ["PEREZ LOPEZ LUI", "PEREZ LOPEZ LUIS"]].filter(([n1, n2]) => touched(sameBed(n1, n2)));
  check("T19e palabra de 3 letras con un error (AMA/ANA, DIA/DIAZ, LUI/LUIS) y el resto igual: misma fila", sh3.length === 0, JSON.stringify(sh3));
  // (f) no identificado que se mueve mientras OTRO no identificado (otro exp) toma su cama: la foto admite dos lecturas
  const tie = (ingA1, ingOwn, ingDest) => {
    const a1 = { id: "a1", cama: "3-150", exp: "26-1500", nombre: "DESCONOCIDO", edad: "", updated_by: "sheet-sync", ingreso: ingA1 };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-150", "26-1777", { nombre: "DESCONOCIDO", ingreso: ingOwn }), row("3-160", "26-1500", { nombre: "TORRES NAVA RAUL", edad: 52, ingreso: ingDest })]));
    return { ps: patches(calls), up: upsertOf(calls), touched: touched(calls), log: calls.find((c) => c.m === "POST" && c.u.startsWith("/rest/v1/sync_log")) };
  };
  const t0 = tie(null, null, null);
  check("T19f sin fecha de ingreso que lo aclare: EMPATE → ni se mueve, ni se le cambia el exp, ni se archiva; las dos camas quedan fuera del upsert y hay aviso en sync_log",
    t0.ps.length === 0 && !t0.touched && !t0.up.some((u) => u.startsWith("3-150:") || u.startsWith("3-160:")) && t0.up.length === 12 && !!t0.log && JSON.stringify(t0.log.body).includes("no_identificado_ambiguo"), JSON.stringify({ ps: t0.ps, up: t0.up.slice(0, 3), log: !!t0.log }));
  const t1 = tie("2026-10-10", "2026-10-18", "2026-10-10");
  check("T19f' su fecha de ingreso viajó a 3-160: se MUEVE con su nota (identificado y cambiado de cama) y 3-150 entra como ingreso nuevo", t1.ps.length === 1 && t1.ps[0].startsWith("a1:") && t1.ps[0].includes('"cama":"3-160"') && !t1.touched && t1.up.includes("3-150:26-1777:DESCONOCIDO"), JSON.stringify(t1.ps));
  const t2 = tie("2026-10-10", "2026-10-10", "2026-10-18");
  check("T19f'' su fecha de ingreso sigue en 3-150: le corrigieron el exp (se queda) y 3-160 entra nuevo", t2.ps.length === 1 && t2.ps[0] === 'a1:{"exp":"26-1777","updated_by":"sheet-sync"}' && !t2.touched && t2.up.includes("3-160:26-1500:TORRES NAVA RAUL"), JSON.stringify(t2.ps));
  // (f''') la fecha de ingreso de SU cama solo cuenta si el nombre de esa cama puede ser él: mientras se reescribe la fila
  //       para otra persona la hoja conserva la fecha anterior (como la edad) y con ella se le archivaba en vez de moverlo.
  for (const dest of [["PEREZ LOPEZ JUAN CARLOS", "2026-10-12"], ["PEREZ LOPEZ JUAN CARLOS", null], ["PEREZ LOPEZ J", "2026-10-12"], ["DIAZ LOPEZ JUAN", null]]) {
    const a1 = { id: "a1", cama: "3-189", exp: "X", nombre: dest[0] === "DIAZ LOPEZ JUAN" ? "DIAS LOPEZ JUAN" : "PEREZ LOPEZ JUAN", edad: "40", ingreso: "2026-10-10", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [a1], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: dest[0], edad: 40, ingreso: dest[1] }), row("3-189", "Y", { nombre: "GOMEZ RUIZ ANA", edad: 60, ingreso: "2026-10-10" })]));
    const ps = patches(calls);
    check("T19f''' movido a 3-154 con el nombre completado (" + dest[0] + ", ingreso " + dest[1] + ") y en 3-189 otra persona cuya fila aún trae SU fecha de ingreso: se MUEVE con su nota, no se archiva", ps.length === 1 && ps[0].startsWith("a1:") && ps[0].includes('"cama":"3-154"') && !touched(calls), JSON.stringify(ps));
  }
  // (g) caso real con nombres PARECIDOS en la otra cama: su nombre exacto sigue en su cama → solo exp
  for (const other of ["PEREZ LOPEZ JUAN CARLOS", "FERNANDEZ LOPEZ JUAN", "PEREZ LOPEZ J"]) {
    const b9 = { id: "b9", cama: "3-189", exp: "X", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: other, edad: 40 }), row("3-189", "Y", { nombre: "PEREZ LOPEZ JUAN", edad: 40 })]));
    const ps = patches(calls);
    check("T19g exp corregido en 3-189 y el viejo en 3-154 con nombre parecido (" + other + "): b9 se queda y solo corrige su exp", ps.length === 1 && ps[0] === 'b9:{"exp":"Y","updated_by":"sheet-sync"}' && !touched(calls), JSON.stringify(ps));
  }
  // ...y al revés: su nombre exacto está en la cama destino y en su cama hay otro con otro exp → se mueve
  {
    const b9 = { id: "b9", cama: "3-189", exp: "X", nombre: "PEREZ LOPEZ JUAN", edad: "40", updated_by: "sheet-sync" };
    const { sb, calls } = makeSandbox({ cur: [b9], props: {} });
    sb.syncPatients_("svc", fill([row("3-154", "X", { nombre: "PEREZ LOPEZ JUAN", edad: 40 }), row("3-189", "Y", { nombre: "GOMEZ RUIZ ANA", edad: 60 })]));
    const ps = patches(calls);
    check("T19g' su nombre exacto está en 3-154 y en 3-189 ya hay otra persona: se MUEVE a 3-154", ps.length === 1 && ps[0].startsWith("b9:") && ps[0].includes('"cama":"3-154"') && !touched(calls), JSON.stringify(ps));
  }
}

// ── 20) Con la GUARDA puesta (hoja < 10 o > 50 % a borrar) el upsert no le pone a una fila vieja (con su nota)
//        el nombre de otra persona: camas reasignadas, cambios de cama y su destino quedan fuera hasta reconciliar ─
{
  const upsertCamas = (calls) => { const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama")); return up && Array.isArray(up.body) ? up.body.map((p) => p.cama) : []; };
  const onlyUpsert = (calls) => !calls.some((c) => c.m !== "GET" && !c.u.startsWith("/rest/v1/patients?on_conflict=cama") && !c.u.startsWith("/rest/v1/sync_log"));
  const guardLog = (calls) => calls.filter((c) => c.m === "POST" && c.u.startsWith("/rest/v1/sync_log")).flatMap((c) => c.body);
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  // Supabase: 26 pacientes en 5-10..5-35 (exp 500..525).
  const cur = range(0, 25).map((i) => ({ id: "x" + i, cama: "5-" + (10 + i), exp: String(500 + i), nombre: "P " + (500 + i), updated_by: "sheet-sync" }));
  const full = Object.fromEntries(cur.map((r) => [r.id, { ...r, notes: [{ patient_id: r.id, pendientes: "nota de " + r.id }] }]));
  // Hoja: 14 camas con gente nueva (5-10..5-23), intercambio 5-24↔5-25, 5-26 pasa a 7-50 (vacía en Supabase),
  // 5-27..5-30 igual, 3 ingresos en camas libres (6-10..6-12); 5-31..5-35 ya no están (gracia).
  const reasignadas = range(10, 23).map((n) => "5-" + n);
  const sheet = reasignadas.map((c, i) => row(c, String(900 + i)))
    .concat([row("5-24", "515"), row("5-25", "514"), row("7-50", "516")])
    .concat(range(27, 30).map((n) => row("5-" + n, String(490 + n))))
    .concat([row("6-10", "950"), row("6-11", "951"), row("6-12", "952")]);
  const retenidas = reasignadas.concat(["5-24", "5-25", "7-50"]);
  {
    const { sb, calls, logs } = makeSandbox({ cur, full, props: {} });
    const r = sb.syncPatients_("svc", sheet);
    const up = upsertCamas(calls);
    check("T20a recambio masivo (14 reasignadas de 26 → guarda >50 %): se loguea ABORTA y no hay DELETE/archive/PATCH",
      r === 0 && logs.some((l) => /ABORTA reconciliación, solo upsert/.test(l)) && onlyUpsert(calls), JSON.stringify(calls.map((c) => c.m + " " + c.u)));
    check("T20b guarda >50 %: ninguna cama REASIGNADA ni de un cambio de cama (origen 5-24/5-25, destino 7-50) va al upsert",
      retenidas.every((c) => !up.includes(c)), JSON.stringify(up));
    check("T20c guarda >50 %: las camas que no necesitan reconciliar (misma persona 5-27..5-30, ingresos en camas libres 6-10..6-12) SÍ entran",
      up.length === 7 && ["5-27", "5-28", "5-29", "5-30", "6-10", "6-11", "6-12"].every((c) => up.includes(c)), JSON.stringify(up));
    const sl = guardLog(calls);
    check("T20d guarda >50 %: aviso en sync_log (guarda_borrado_masivo) con las 17 camas retenidas y log con la lista",
      sl.length === 1 && sl[0].motivo === "guarda_borrado_masivo" && retenidas.every((c) => sl[0].camas.split(", ").includes(c)) && sl[0].camas.split(", ").length === 17
      && logs.some((l) => /retenida/.test(l) && /5-24/.test(l) && /7-50/.test(l)), JSON.stringify({ sl, logs }));
  }
  // Caso T16b (misma cama, mismo exp único, OTRA persona) en una hoja de 6 filas → guarda de hoja < 10
  {
    const A = "PEREZ RUIZ JUAN CARLOS", B = "LOPEZ SOTO MIGUEL ANGEL";
    const a1 = { id: "a1", cama: "3-101", exp: "X", nombre: A, edad: "44", updated_by: "sheet-sync" };
    const small = [row("3-101", "X", { nombre: B, edad: 31 })].concat(range(1, 5).map((i) => row("4-" + (10 + i), String(100 + i))));
    const { sb, calls, logs } = makeSandbox({ cur: [a1], full: { a1: { ...a1, notes: [{ patient_id: "a1", pendientes: "nota de A" }] } }, props: {} });
    sb.syncPatients_("svc", small);
    const up = calls.find((c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
    const sl = guardLog(calls);
    check("T20e exp copiado a otra persona en hoja de 6 filas (guarda <10): la fila de A (con su nota) NO recibe el nombre de B; las 5 camas libres sí entran; aviso guarda_hoja_chica",
      !!up && !up.body.some((p) => p.cama === "3-101") && up.body.length === 5 && !up.body.some((p) => p.nombre === B) && onlyUpsert(calls)
      && sl.length === 1 && sl[0].motivo === "guarda_hoja_chica" && sl[0].camas === "3-101" && logs.some((l) => /solo 6 en la hoja/.test(l)), JSON.stringify({ up: up && up.body.map((p) => p.cama + ":" + p.nombre), sl }));
  }
  // Hoja < 10 con un cambio de cama hacia una cama LIBRE: el destino tampoco entra (crearía una copia vacía del paciente)
  {
    const d1 = { id: "d1", cama: "3-104", exp: "4", nombre: "P 4", updated_by: "sheet-sync" };
    const small = [row("3-107", "4")].concat(range(1, 4).map((i) => row("4-" + (10 + i), String(100 + i))));
    const { sb, calls } = makeSandbox({ cur: [d1], props: {} });
    sb.syncPatients_("svc", small);
    const up = upsertCamas(calls);
    check("T20f guarda <10 con cambio de cama 3-104→3-107 (libre): 3-107 fuera del upsert, sin PATCH; las otras 4 entran",
      !up.includes("3-107") && up.length === 4 && onlyUpsert(calls), JSON.stringify(up));
  }
  // Guarda sin camas retenidas (todo son camas libres o la misma persona): solo upsert, sin aviso en sync_log (T6 intacto)
  {
    const { sb, calls } = makeSandbox({ cur: [{ id: "k1", cama: "4-11", exp: "101", nombre: "P 101", updated_by: "sheet-sync" }], props: {} });
    sb.syncPatients_("svc", range(1, 5).map((i) => row("4-" + (10 + i), String(100 + i))));
    check("T20g guarda <10 sin nada que retener: las 5 camas al upsert y ningún POST a sync_log", upsertCamas(calls).length === 5 && guardLog(calls).length === 0);
  }
  // doSyncForce: salta UNA vez la guarda de >50 % (recambio masivo real) → archiva, mueve y luego upsert completo
  {
    const { sb, calls, logs } = makeSandbox({ cur, full, props: {} });
    const r = sb.syncPatients_("svc", sheet, { force: true });
    const arcs = calls.filter((c) => c.m === "POST" && c.u.startsWith("/rest/v1/archive")).map((c) => c.body.patient_data.cama + "|" + c.body.note_data._egreso);
    const finals = calls.filter((c) => c.m === "PATCH" && c.body.cama && !/#MV-/.test(c.body.cama)).map((c) => c.u.match(/id=eq\.(\w+)/)[1] + ":" + c.body.cama);
    const up = upsertCamas(calls);
    const iLastDel = calls.map((c) => c.m).lastIndexOf("DELETE"), iUp = seq(calls, (c) => c.u.startsWith("/rest/v1/patients?on_conflict=cama"));
    check("T20h force: las 14 reasignadas se archivan (CAMA REASIGNADA) ANTES del upsert; el intercambio y 5-26→7-50 se mueven por PATCH",
      r === 14 && arcs.length === 14 && reasignadas.every((c) => arcs.includes(c + "|CAMA REASIGNADA (hoja)")) && iUp > iLastDel
      && finals.includes("x14:5-25") && finals.includes("x15:5-24") && finals.includes("x16:7-50") && finals.length === 3, JSON.stringify({ r, arcs, finals }));
    check("T20i force: el upsert lleva las 24 camas de la hoja, ningún retiro en gracia se archiva y queda auditoría sync_forzado",
      up.length === 24 && !arcs.some((a) => /RETIRADO/.test(a)) && guardLog(calls).some((q) => q.motivo === "sync_forzado") && logs.some((l) => /doSyncForce/.test(l)), JSON.stringify({ up: up.length, sl: guardLog(calls) }));
    // force NO salta la guarda de hoja < 10 (eso huele a error de lectura, no a recambio)
    const { sb: sb2, calls: c2 } = makeSandbox({ cur, full, props: {} });
    sb2.syncPatients_("svc", sheet.slice(0, 6), { force: true });
    check("T20j force con hoja de 6 filas: sigue la guarda <10 (sin DELETE/archive/PATCH, camas reasignadas fuera)",
      onlyUpsert(c2) && upsertCamas(c2).length === 0, JSON.stringify(upsertCamas(c2)));
    // la entrada manual pasa force a doSync con el lock; las automáticas no
    const { sb: sb3 } = makeSandbox({});
    const seen = [];
    sb3.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
    sb3.doSync = (o) => { seen.push(o); return {}; };
    sb3.doSyncForce(); sb3.doSyncScheduled();
    check("T20k doSyncForce llama doSync({force:true}); doSyncScheduled sin force", seen.length === 2 && seen[0] && seen[0].force === true && !(seen[1] && seen[1].force), JSON.stringify(seen));
  }
}

// ── 21) Selección de la pestaña: nunca leer a ciegas una portada u otro censo ──────────────────
{
  const header = [["CAMA", "EXPEDIENTE", "NOMBRE"], ["3-101", "26-10001", "PACIENTE DE PRUEBA"]];
  const sheet = (id, rows) => ({ getSheetId: () => id, getDataRange: () => ({ getValues: () => rows }) });
  const { sb, calls } = makeSandbox({});
  sb.SpreadsheetApp = { openById: () => ({ getSheets: () => [sheet(7, header), sheet(sb.CENSO_GID, header)] }) };
  check("T21 usa el gid configurado incluso con otros censos en el archivo", sb.readCensoRows_() === header);
  sb.SpreadsheetApp = { openById: () => ({ getSheets: () => [sheet(7, [["PORTADA"]]), sheet(8, header)] }) };
  check("T21b gid cambiado: encuentra censo aunque no sea la primera pestaña", sb.readCensoRows_() === header);
  sb.SpreadsheetApp = { openById: () => ({ getSheets: () => [sheet(7, header), sheet(8, header)] }) };
  let error = ""; try { sb.doSync(); } catch (e) { error = String(e); }
  check("T21c dos censos posibles: aborta sin escrituras", /encontradas: 2/.test(error) && !calls.length);
  sb.SpreadsheetApp = { openById: () => ({ getSheets: () => [sheet(7, [["PORTADA"]])] }) };
  error = ""; try { sb.doSync(); } catch (e) { error = String(e); }
  check("T21d sin pestaña censal: aborta sin escrituras", /encontradas: 0/.test(error) && !calls.length);
}

// ── 22) Reinstalación: Excel no bloquea el reloj ni elimina triggers de otros módulos ─────────
{
  const trigger = (handler) => ({ getHandlerFunction: () => handler });
  function installer(failAt) {
    const { sb } = makeSandbox({});
    const unrelated = trigger("registroScheduled"), old = trigger("doSyncScheduled");
    let active = [unrelated, old];
    sb.ScriptApp = {
      getProjectTriggers: () => active.slice(),
      deleteTrigger: (t) => { active = active.filter((q) => q !== t); },
      newTrigger: (handler) => {
        const builder = {
          timeBased: () => builder, everyMinutes: () => builder, everyHours: () => builder,
          forSpreadsheet: () => builder, onEdit: () => builder,
          create: () => {
            if (handler === failAt || handler === "onCensoEdit") throw new Error("Trigger rechazado");
            const t = trigger(handler); active.push(t); return t;
          }
        };
        return builder;
      }
    };
    sb.syncIndicaciones = () => {};
    return { sb, unrelated, old, active: () => active };
  }
  {
    const env = installer(); env.sb.createTriggers();
    const active = env.active();
    check("T22 Excel sin onEdit: tres relojes instalados; conserva registroScheduled", active.length === 4 && active.includes(env.unrelated) && !active.includes(env.old) && ["doSyncScheduled", "checkLabsFreshness", "syncIndicacionesScheduled"].every((h) => active.some((t) => t.getHandlerFunction() === h)));
    env.sb.createTriggers();
    check("T22b reinstalar no duplica triggers y conserva módulos ajenos", env.active().length === 4 && env.active().includes(env.unrelated));
  }
  {
    const env = installer("checkLabsFreshness");
    let error = ""; try { env.sb.createTriggers(); } catch (e) { error = String(e); }
    check("T22c falla reloj obligatorio: elimina solo nuevos y conserva todos los anteriores", /se conservaron los anteriores/.test(error) && env.active().length === 2 && env.active().includes(env.old) && env.active().includes(env.unrelated));
  }
}

// ── 23) No anunciar éxito si Supabase rechazó la lectura de identidad ─────────────────────────
{
  const { sb, calls, logs } = makeSandbox({ handler: (m, u) => m === "GET" && u.startsWith("/rest/v1/patients?") ? { code: 403, body: "Forbidden" } : null });
  sb.readCensoRows_ = () => [];
  sb.parseCenso_ = () => [row("3-101", "26-10001")];
  let error = ""; try { sb.doSync(); } catch (e) { error = String(e); }
  check("T23 GET 403: ejecución fallida visible, sin Sync OK y sin escrituras", /GET patients HTTP 403/.test(error) && calls.every((c) => c.m === "GET") && !logs.some((s) => /Sync OK/.test(s)), error);
}

console.log("RESULT CENSO-SYNC: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
