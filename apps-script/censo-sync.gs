/***************************************************************************************************
 * PisoLibro — Sync Censo (Google Sheet) -> Supabase (patients)
 * --------------------------------------------------------------------------------------------------
 * Flujo:  Editas la hoja  ->  Apps Script empuja SOLO columnas censales  ->  Supabase  ->  Realtime
 *         (canal patients-changes del monolito)  ->  la app se re-renderiza sola.
 *
 * REGLA DE ORO (P0): este script SOLO escribe columnas censales de `patients`
 *   (cama, nombre, exp, edad, dx, esp, adscrito, residente, ingreso, dias, estado, seccion, es_mio).
 *   NUNCA toca la tabla `notes` ni ninguna otra columna clinica. UPSERT por ON CONFLICT(cama):
 *   actualiza censales y deja intacto el resto de la fila (id estable -> la nota sigue ligada).
 *
 * SEGURIDAD: la SERVICE KEY de Supabase vive SOLO en Script Properties (clave SUPABASE_KEY),
 *   nunca en la hoja ni en el repo. La PHI viaja autenticada por HTTPS a Supabase, jamas por una
 *   URL publica de Google.
 *
 * INSTALACION (1 sola vez): ver apps-script/README.md. Resumen:
 *   1) Pega este archivo en Extensiones -> Apps Script.
 *   2) Project Settings -> Script Properties -> agrega  SUPABASE_KEY = <service_role key>.
 *   3) Ejecuta createTriggers() una vez (acepta el OAuth).
 ***************************************************************************************************/

// --- CONFIG -------------------------------------------------------------------------------------
var SUPABASE_URL   = 'https://vkxplmrzyqlamxpbtmes.supabase.co';
var CENSO_SHEET_ID = '1ChvdR-DZ8K5Bhl0MYmwW7mLbWioNlc-T';
var CENSO_GID      = 14179734;

// Secciones que NO se sincronizan (se ignoran por completo).
var EXCLUDE_SECTION_RE = [
  /^ALTAS/, /^DEFUNCION/, /^PROCEDIMIENTO/, /^INGRESOS/, /MOVIMIENTO/, /^TPN/,
  /ONCOLOG/, /HEMATOLOG/, /GINECOLOG/
];

// Servicios "ajenos" para es_mio (FALSE solo si TODOS los componentes estan aqui).
var ES_MIO_EXCL = ['URO', 'UROLOGIA', 'NCX', 'NEUROCX', 'NEUROCIRUGIA', 'TYO'];

// --- ENTRADAS (triggers) ------------------------------------------------------------------------

/** Trigger INSTALABLE onEdit (el simple no permite UrlFetchApp). Sincroniza al editar el censo. */
function onCensoEdit(e) {
  try {
    if (e && e.range && e.range.getSheet && e.range.getSheet().getSheetId() !== CENSO_GID) return;
  } catch (_) { /* si no hay contexto de rango, sincroniza igual */ }
  // Lock no bloqueante: si ya hay un sync corriendo, ese leera el estado mas reciente de la hoja.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { doSync(); } finally { lock.releaseLock(); }
}

/** Respaldo time-driven (cada 5 min): captura ediciones que el onEdit no haya alcanzado. */
function doSyncScheduled() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { doSync(); } finally { lock.releaseLock(); }
}

// --- NUCLEO -------------------------------------------------------------------------------------

/** Lee la hoja, parsea, deduplica/cuarentena y hace UPSERT column-scoped a Supabase. */
function doSync() {
  var key = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
  if (!key) { Logger.log('FALTA Script Property SUPABASE_KEY'); throw new Error('Falta SUPABASE_KEY en Script Properties'); }

  var rows = readCensoRows_();                 // valores crudos de la hoja
  var parsed = parseCenso_(rows);              // [{cama,exp,nombre,...,seccion}] ya filtrado por seccion
  var result = dedupAndQuarantine_(parsed);    // {keep:[...], quarantine:[...]}

  if (result.quarantine.length) logQuarantine_(key, result.quarantine);

  var payload = result.keep.map(toPatientRow_);
  upsertPatients_(key, payload);

  Logger.log('Sync OK: ' + payload.length + ' upserts, ' + result.quarantine.length + ' en cuarentena.');
  return { upserts: payload.length, quarantine: result.quarantine.length };
}

/** Lee todas las filas de la pestana del censo (por gid). */
function readCensoRows_() {
  var ss = SpreadsheetApp.openById(CENSO_SHEET_ID);
  var sheet = null, sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) { if (sheets[i].getSheetId() === CENSO_GID) { sheet = sheets[i]; break; } }
  if (!sheet) sheet = ss.getSheets()[0];
  return sheet.getDataRange().getValues();
}

/**
 * Parser robusto a la menseria:
 *  - Encuentra la fila de encabezados (CAMA + NOMBRE + EXPEDIENTE) y mapea columnas por nombre.
 *  - Fila = PACIENTE si EXP y NOMBRE no vacios. Fila-encabezado de seccion = exp vacio y 1-2 celdas.
 *  - seccion = ultimo encabezado visto. Excluye las secciones de EXCLUDE_SECTION_RE.
 */
function parseCenso_(rows) {
  var headerRow = -1, col = {};
  for (var r = 0; r < Math.min(rows.length, 8); r++) {
    var up = rows[r].map(function (c) { return norm_(c); });
    if (up.indexOf('CAMA') >= 0 && contains_(up, 'NOMBRE') && contains_(up, 'EXPEDIENTE')) { headerRow = r; mapCols_(up, col); break; }
  }
  if (headerRow < 0) throw new Error('No se encontro la fila de encabezados (CAMA/NOMBRE/EXPEDIENTE).');

  var out = [], section = 'PISO';   // primer bloque es PISO (implicito)
  for (var i = headerRow + 1; i < rows.length; i++) {
    var row = rows[i];
    // DETENER en una 2a fila-encabezado: la hoja trae OTRA tabla mas abajo con columnas en
    // distinto orden (ej. "NUMERO DE EXPEDIENTE | NOMBRE DEL PACIENTE | EDAD | CIRUJANO A
    // CARGO | ..."). Reusar el mapeo de la 1a tabla la corrompia (exp<-nombre, nombre<-edad,
    // el header entraba como paciente). Esa 2a tabla NO se sincroniza.
    if (looksLikeHeader_(row)) break;
    var exp = cell_(row, col.exp), nombre = cell_(row, col.nombre);
    if (exp && nombre) {
      // Guarda anti-mismap: un expediente real es numerico (ej. "26-13060"). Si "exp" trae
      // un nombre (letras), la fila esta mal mapeada (2a tabla) -> saltarla.
      if (!expLooksValid_(exp)) continue;
      if (sectionExcluded_(section)) continue;   // seccion ignorada -> no se sincroniza
      out.push({
        cama:      cell_(row, col.cama),
        exp:       exp,
        nombre:    nombre,
        edad:      cell_(row, col.edad),
        dx:        cell_(row, col.dx),
        esp:       cell_(row, col.esp),
        adscrito:  cell_(row, col.adscrito),
        residente: cell_(row, col.residente),
        ingreso:   toISODate_(row[col.ingreso]),
        dias:      toInt_(cell_(row, col.dias)),
        estado:    cell_(row, col.estado),
        seccion:   section
      });
    } else if (!exp) {
      var nonEmpty = row.map(function (c) { return String(c == null ? '' : c).trim(); }).filter(Boolean);
      if (nonEmpty.length >= 1 && nonEmpty.length <= 2) section = norm_(nonEmpty[0]);  // fila-encabezado de seccion
    }
  }
  return out;
}

// ¿La fila parece un ENCABEZADO de columnas (otra tabla)? True si >=2 celdas son keywords
// de encabezado. Las filas-encabezado de SECCION (1 sola celda "PISO"/"UCIA") NO disparan.
function looksLikeHeader_(row) {
  var KW = ['CAMA', 'EXPEDIENTE', 'NUMERO DE EXPEDIENTE', 'NOMBRE', 'PACIENTE', 'EDAD',
    'DIAGNOSTICO', 'ESPECIALIDAD', 'SERVICIO', 'ADSCRITO', 'RESIDENTE', 'CIRUJANO', 'ESTADO'];
  var hits = 0;
  for (var i = 0; i < row.length; i++) {
    var c = norm_(row[i]);
    if (!c) continue;
    for (var j = 0; j < KW.length; j++) { if (c.indexOf(KW[j]) >= 0) { hits++; break; } }
    if (hits >= 2) return true;
  }
  return false;
}

// Un expediente real es numerico (ej. "26-13060", "2613060"). Rechaza valores con corridas
// de >=3 letras (un nombre mal mapeado a la columna exp).
function expLooksValid_(exp) {
  var e = String(exp == null ? '' : exp).trim();
  return /\d/.test(e) && !/[A-Za-z]{3,}/.test(e);
}

/**
 * Dedup + cuarentena (precision > recall: "mejor sin dato que dato ajeno").
 *  - Mismo exp en 2+ camas, MISMA persona -> conserva SOLO la cama de UCI/UTI, descarta piso.
 *  - Mismo exp con NOMBRES distintos -> cuarentena: no sincroniza NINGUNA, loguea a sync_log.
 */
function dedupAndQuarantine_(list) {
  var byExp = {};
  list.forEach(function (p) { (byExp[p.exp] = byExp[p.exp] || []).push(p); });

  var keep = [], quarantine = [];
  Object.keys(byExp).forEach(function (exp) {
    var grp = byExp[exp];
    if (grp.length === 1) { keep.push(grp[0]); return; }

    var ref = grp.slice().sort(function (a, b) { return nameTokens_(b.nombre).length - nameTokens_(a.nombre).length; })[0];
    var allSame = grp.every(function (p) { return samePerson_(p.nombre, ref.nombre); });

    if (!allSame) {
      quarantine.push({ exp: exp, camas: grp.map(function (p) { return p.cama; }).join(', '),
                        nombres: grp.map(function (p) { return p.nombre; }).join(' | '),
                        motivo: 'exp_duplicado_nombres_distintos' });
      return;  // no se sincroniza ninguna
    }
    // misma persona en varias camas -> UCI/UTI gana a piso
    var uci = grp.filter(function (p) { return /^(UCI|UTI)/i.test(String(p.cama || '').trim()); });
    keep.push(uci.length ? uci[0] : grp[0]);
    quarantine.push({ exp: exp, camas: grp.map(function (p) { return p.cama; }).join(', '),
                      nombres: ref.nombre, motivo: uci.length ? 'dedup_uci_gana_a_piso' : 'dedup_misma_persona_multi_cama' });
  });
  return { keep: keep, quarantine: quarantine };
}

/** Convierte un registro parseado a la fila censal que se manda a Supabase (incluye es_mio calculado). */
function toPatientRow_(p) {
  return {
    cama: p.cama, nombre: p.nombre, exp: p.exp, edad: p.edad || '', dx: p.dx || '',
    esp: p.esp || '', adscrito: p.adscrito || '', residente: p.residente || '',
    ingreso: p.ingreso || null, dias: (p.dias === '' ? null : p.dias),
    estado: p.estado || '', seccion: p.seccion || '', es_mio: computeEsMio_(p.esp),
    updated_by: 'sheet-sync'
  };
}

/** UPSERT column-scoped en lotes. Prefer: resolution=merge-duplicates -> ON CONFLICT(cama) DO UPDATE. */
function upsertPatients_(key, payload) {
  if (!payload.length) return;
  var url = SUPABASE_URL + '/rest/v1/patients?on_conflict=cama';
  var CHUNK = 200;
  for (var i = 0; i < payload.length; i += CHUNK) {
    var batch = payload.slice(i, i + CHUNK);
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(batch), muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('UPSERT patients HTTP ' + code + ': ' + res.getContentText());
  }
}

/** Inserta filas de cuarentena/dedup en public.sync_log. */
function logQuarantine_(key, rows) {
  var url = SUPABASE_URL + '/rest/v1/sync_log';
  var body = rows.map(function (q) { return { exp: q.exp, camas: q.camas, nombres: q.nombres, motivo: q.motivo }; });
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) Logger.log('sync_log HTTP ' + code + ': ' + res.getContentText());
}

// --- HELPERS ------------------------------------------------------------------------------------

// Quita acentos por codigo de caracter (rango combinante U+0300..U+036F) sin literales fragiles.
function stripAccents_(s) {
  var d = String(s == null ? '' : s).normalize('NFD'), out = '';
  for (var i = 0; i < d.length; i++) { var c = d.charCodeAt(i); if (c < 0x300 || c > 0x36f) out += d.charAt(i); }
  return out;
}
function norm_(s) { return stripAccents_(s).toUpperCase().replace(/\s+/g, ' ').trim(); }
function contains_(arr, kw) { for (var i = 0; i < arr.length; i++) { if (arr[i].indexOf(kw) >= 0) return true; } return false; }
function cell_(row, idx) { return (idx == null || idx < 0) ? '' : String(row[idx] == null ? '' : row[idx]).trim(); }

function mapCols_(up, col) {
  for (var i = 0; i < up.length; i++) {
    var h = up[i];
    if (h.indexOf('CAMA') >= 0 && col.cama == null) col.cama = i;
    else if (h.indexOf('EXPEDIENTE') >= 0) col.exp = i;
    else if (h.indexOf('NOMBRE') >= 0) col.nombre = i;
    else if (h.indexOf('EDAD') >= 0) col.edad = i;
    else if (h.indexOf('DIAGNOS') >= 0) col.dx = i;
    else if (h.indexOf('ESPECIALIDAD') >= 0 || h === 'ESP' || h.indexOf('SERVICIO') >= 0) col.esp = i;
    else if (h.indexOf('ADSCRITO') >= 0) col.adscrito = i;
    else if (h.indexOf('RESIDENTE') >= 0) col.residente = i;
    else if (h.indexOf('INGRESO') >= 0) col.ingreso = i;
    else if (h.indexOf('DIAS') >= 0) col.dias = i;
    else if (h.indexOf('ESTADO') >= 0) col.estado = i;
  }
}

function sectionExcluded_(section) {
  var s = norm_(section);
  for (var i = 0; i < EXCLUDE_SECTION_RE.length; i++) { if (EXCLUDE_SECTION_RE[i].test(s)) return true; }
  return false;
}

function computeEsMio_(esp) {
  var toks = norm_(esp).split(/[\/,+]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  if (!toks.length) return true;
  return toks.some(function (t) { return ES_MIO_EXCL.indexOf(t) === -1; });
}

// Nombre -> tokens normalizados (NFD, upper, expansion de abreviaturas, sin palabras cortas/stopwords).
function nameTokens_(name) {
  var s = norm_(name).replace(/[^A-Z\s]/g, ' ');
  var EXP = { MA: 'MARIA', J: 'JOSE', GPE: 'GUADALUPE' };
  var STOP = { DE: 1, DEL: 1, LA: 1, LAS: 1, LOS: 1, Y: 1, O: 1, CON: 1, SIN: 1, POR: 1, PARA: 1 };
  return s.split(/\s+/).map(function (w) { return EXP[w] != null ? EXP[w] : w; })
    .filter(function (w) { return w && w.length >= 2 && !STOP[w]; });
}

// Misma persona? Order-independent: un set de tokens es subconjunto del otro.
function samePerson_(n1, n2) {
  var a = nameTokens_(n1), b = nameTokens_(n2);
  if (!a.length || !b.length) return false;
  var sa = {}, sb = {};
  a.forEach(function (t) { sa[t] = 1; }); b.forEach(function (t) { sb[t] = 1; });
  var aInB = a.every(function (t) { return sb[t]; });
  var bInA = b.every(function (t) { return sa[t]; });
  return aInB || bInA;
}

function toInt_(v) { var n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? '' : n; }

// Fecha de la hoja -> 'YYYY-MM-DD' (acepta Date nativo o texto DD/MM/AA[AA]); '' si no se entiende.
function toISODate_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'America/Mexico_City', 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    var d = ('0' + m[1]).slice(-2), mo = ('0' + m[2]).slice(-2), y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    return y + '-' + mo + '-' + d;
  }
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : '';
}

// --- INSTALACION / DIAGNOSTICO (se ejecutan a mano una vez) -------------------------------------

/** Ejecuta esto UNA vez para instalar los 2 triggers (pide OAuth la primera vez). */
function createTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onCensoEdit').forSpreadsheet(CENSO_SHEET_ID).onEdit().create();
  ScriptApp.newTrigger('doSyncScheduled').timeBased().everyMinutes(5).create();
  Logger.log('Triggers creados: onEdit (instalable) + cada 5 min.');
}

/** Diagnostico sin escribir nada: cuantos pacientes parsea y cuantos quedan en cuarentena. */
function testParseOnly() {
  var rows = readCensoRows_();
  var parsed = parseCenso_(rows);
  var res = dedupAndQuarantine_(parsed);
  Logger.log('Parseados: ' + parsed.length + ' | A sincronizar: ' + res.keep.length + ' | Cuarentena/dedup: ' + res.quarantine.length);
  Logger.log('Cuarentena: ' + JSON.stringify(res.quarantine, null, 2));
  return res;
}
