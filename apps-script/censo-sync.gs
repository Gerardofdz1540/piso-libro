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

  // 1) dedup por CAMA: si la hoja tiene el mismo cuarto repetido (dos pacientes en una cama),
  // un upsert ON CONFLICT(cama) con ambos revienta con "cannot affect row a second time" y
  // TODA la sincronización falla. Quitamos el duplicado (gana el de más abajo en la hoja) y
  // lo logueamos a sync_log para que sea visible.
  var dd = dedupByCama_(result.keep.map(toPatientRow_), key);

  // 2) RECONCILIACIÓN identidad-segura (Supabase REFLEJA la hoja, no solo acumula):
  //    (a) RETIRO — paciente que ya NO está en la hoja (alta/defunción) y cuya fila vino del
  //        sheet-sync → se retira. SIN esto los egresos quedaban como FANTASMAS en la app
  //        (la queja "el 83 ya no es Claudio"). NO toca pacientes agregados a mano en la app.
  //    (b) REASIGNACIÓN — misma cama con OTRO exp → borra fila+nota vieja para que el nuevo
  //        ocupante NO herede la nota clínica del anterior (fuga clínica del upsert-por-cama).
  //    GUARDAS anti-catástrofe dentro de syncPatients_ (hoja <10 o borrar >50% → solo upsert).
  var retired = syncPatients_(key, dd.rows);

  Logger.log('Sync OK: ' + dd.rows.length + ' upserts, ' + retired + ' retirados, ' + dd.dups + ' camas duplicadas, ' + result.quarantine.length + ' en cuarentena.');
  return { upserts: dd.rows.length, retired: retired, camas_duplicadas: dd.dups, quarantine: result.quarantine.length };
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
      // Fila-encabezado de SECCION: 1-2 celdas Y la 1a NO parece una cama. Un paciente a medio
      // capturar (cama puesta pero exp/nombre aun vacios, ej "3-184" + dx, 2 celdas) NO debe
      // leerse como encabezado: corrompia "seccion" con un numero de cama Y -peor- podia
      // DES-excluir una seccion ya excluida (si cae tras ALTAS/DEFUNCIONES) -> fuga de un egreso
      // al censo activo. La identidad de seccion la dan los nombres reales (ALTAS, UCIA, ...).
      if (nonEmpty.length >= 1 && nonEmpty.length <= 2 && !looksLikeCama_(nonEmpty[0])) section = norm_(nonEmpty[0]);
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

// ¿El texto parece una CAMA (no un encabezado de seccion)? Camas: "3-181", "2-026", "UCI 3",
// "UTI AIS", "UTI-3", "EXT", "RECU". Cuida los HOMONIMOS por \b: "UCIA"/"RECUPERACION" son
// SECCIONES (no llevan boundary tras el prefijo) y SI deben fijar seccion.
function looksLikeCama_(s) {
  var c = norm_(s);
  return /^\d/.test(c) || /^(UCI|UTI|EXT|RECU)\b/.test(c);
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

// Normaliza la cama al formato canónico de la app: GUION (no punto), MAYÚS, 1 espacio.
// "3.183" -> "3-183", " uci 8 " -> "UCI 8". Sin esto, un punto en la hoja crea un DUPLICADO
// (3.183 ≠ 3-183) → el paciente viejo nunca se reemplaza y aparece stale en la app.
function normalizeCama_(c) {
  return String(c == null ? '' : c).trim().toUpperCase().replace(/\./g, '-').replace(/\s+/g, ' ');
}

// Quita filas con CAMA repetida (la hoja a veces lista el mismo cuarto 2 veces, o dos pacientes
// distintos en una cama). Conserva la ÚLTIMA ocurrencia (la de más abajo en la hoja) y loguea el
// duplicado a sync_log. SIN esto, el upsert ON CONFLICT(cama) revienta (error 21000 "cannot affect
// row a second time") y NADA se sincroniza.
function dedupByCama_(rows, key) {
  var seen = {}, dups = [];
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i].cama;
    if (seen[c] !== undefined) {
      dups.push({ exp: rows[i].exp, camas: c, nombres: rows[seen[c]].nombre + ' | ' + rows[i].nombre, motivo: 'cama_duplicada_en_hoja' });
    }
    seen[c] = i;
  }
  var out = [];
  Object.keys(seen).forEach(function (c) { out.push(rows[seen[c]]); });
  if (dups.length && key) { try { logQuarantine_(key, dups); } catch (_) {} }
  return { rows: out, dups: dups.length };
}

/** Convierte un registro parseado a la fila censal que se manda a Supabase (incluye es_mio calculado). */
function toPatientRow_(p) {
  return {
    cama: normalizeCama_(p.cama), nombre: p.nombre, exp: p.exp, edad: p.edad || '', dx: p.dx || '',
    esp: p.esp || '', adscrito: p.adscrito || '', residente: p.residente || '',
    ingreso: p.ingreso || null, dias: (p.dias === '' ? null : p.dias),
    estado: p.estado || '', seccion: p.seccion || '', es_mio: computeEsMio_(p.esp),
    updated_by: 'sheet-sync'
  };
}

/**
 * Sincroniza el censo haciendo que Supabase REFLEJE la hoja (fuente de verdad), de forma
 * identidad-segura. Antes de upsertear:
 *   (a) REASIGNACIÓN — misma cama con OTRO exp (otra persona) → borra la fila vieja (y su nota)
 *       para que el nuevo entre como fila NUEVA. Sin esto, el upsert-por-cama heredaba la nota
 *       clínica del paciente anterior al nuevo ocupante (fuga clínica).
 *   (b) RETIRO — cama que ya NO está en la hoja Y la fila vino del sheet-sync → la retira
 *       (paciente que salió del censo). NO toca pacientes agregados a mano en la app.
 * GUARDAS: si la hoja parseó <10 o habría que borrar >50% del censo → NO reconcilia (solo upsert),
 * para que un error de lectura nunca borre el piso. Devuelve cuántas filas retiró.
 */
function syncPatients_(key, payload) {
  if (!payload.length) { Logger.log('syncPatients: payload vacío → no se toca nada.'); return 0; }
  var sheetByCama = {}, sheetCamaByExp = {};
  payload.forEach(function (p) {
    var e = String(p.exp || '').trim();
    sheetByCama[p.cama] = e;                                  // cama ya normalizada
    if (e && sheetCamaByExp[e] === undefined) sheetCamaByExp[e] = p.cama;
  });
  var nSheet = Object.keys(sheetByCama).length;

  // Estado actual en Supabase
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/patients?select=id,cama,exp,updated_by', {
    method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { Logger.log('syncPatients: GET HTTP ' + res.getResponseCode() + ' → solo upsert'); upsertPatients_(key, payload); return 0; }
  var cur = JSON.parse(res.getContentText() || '[]');

  // Camas que se quedan tal cual (misma persona en la misma cama): nadie puede moverse ahí.
  var stayCamas = {};
  cur.forEach(function (r) {
    var cama = normalizeCama_(r.cama);
    if (sheetByCama[cama] !== undefined && sheetByCama[cama] === String(r.exp || '').trim()) stayCamas[cama] = true;
  });

  var toDelete = [], toMove = [], moveTargets = {};
  cur.forEach(function (r) {
    var cama = normalizeCama_(r.cama);
    var exp = String(r.exp || '').trim();
    var sheetExp = sheetByCama[cama];
    if (sheetExp !== undefined && sheetExp === exp) return;   // sigue igual
    // (c) CAMBIO DE CAMA — la MISMA persona (mismo exp) sigue en la hoja pero en OTRA cama →
    //     se MUEVE la fila (PATCH de cama), no se borra. Antes esto caía en "retiro" + fila
    //     nueva por el upsert: la nota clínica (FK ON DELETE CASCADE) se perdía en cada cambio
    //     de cama. Si la cama destino ya la ocupa una fila que se queda (duplicado) o ya la
    //     reclamó otra fila que se mueve, esta fila es un duplicado → se retira (archivada).
    var newCama = exp ? sheetCamaByExp[exp] : undefined;
    if (newCama !== undefined && newCama !== cama && !stayCamas[newCama] && !moveTargets[newCama]) {
      toMove.push({ row: r, from: cama, to: newCama });
      moveTargets[newCama] = true;
      return;
    }
    if (sheetExp !== undefined) toDelete.push({ row: r, motivo: 'CAMA REASIGNADA (hoja)' });        // (a) reasignación
    else if (r.updated_by === 'sheet-sync') toDelete.push({ row: r, motivo: 'RETIRADO DEL CENSO (hoja)' }); // (b) retiro
  });

  // GUARDAS anti-catástrofe (los movimientos no borran nada, pero tampoco se aplican con una
  // hoja sospechosa: la cama destino podría ser basura).
  if (nSheet < 10) { Logger.log('syncPatients: solo ' + nSheet + ' en la hoja (posible error) → solo upsert, sin borrar.'); upsertPatients_(key, payload); return 0; }
  if (toDelete.length > Math.max(10, Math.floor(cur.length * 0.5))) {
    Logger.log('syncPatients: ' + toDelete.length + ' a borrar (>50%) → ABORTA reconciliación, solo upsert.');
    upsertPatients_(key, payload); return 0;
  }

  // 1) Retiros/reasignaciones: ARCHIVAR (paciente + nota → public.archive, la papelera de la app)
  //    y solo entonces borrar. Si el archivo falla, la fila NO se borra (reintenta en 5 min).
  var retired = 0;
  toDelete.forEach(function (d) { if (archiveAndDeletePatient_(key, d.row, d.motivo)) retired++; });
  if (toDelete.length) Logger.log('syncPatients: retirados ' + retired + '/' + toDelete.length + ' (reasignación/egreso): ' + toDelete.map(function (d) { return d.row.cama; }).join(', '));

  // 2) Cambios de cama: PATCH de la cama sobre la MISMA fila (id estable → la nota sigue ligada).
  //    Intercambios A↔B chocarían con UNIQUE(cama); esos pasan primero por una cama temporal.
  var moved = movePatients_(key, toMove);
  if (toMove.length) Logger.log('syncPatients: movidos ' + moved + '/' + toMove.length + ': ' + toMove.map(function (m) { return m.from + '→' + m.to; }).join(', '));

  upsertPatients_(key, payload);   // ahora sin filas conflictivas → reasignados entran limpios
  return retired;
}

/** PATCH de columnas sobre una fila de patients por id. true si 2xx. */
function patchPatient_(key, id, cols) {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/patients?id=eq.' + encodeURIComponent(id), {
    method: 'patch', contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
    payload: JSON.stringify(cols), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) { Logger.log('PATCH patients ' + id + ' HTTP ' + code + ': ' + res.getContentText()); return false; }
  return true;
}

/**
 * Aplica los cambios de cama. Si la cama destino de un movimiento es la cama ORIGEN de otro
 * (intercambio/rotación), se usa una cama temporal única ('#MV-<id>') en una primera fase; si el
 * script muriera a medias, la siguiente corrida los vuelve a detectar (exp en la hoja, cama '#MV')
 * y los termina. Devuelve cuántos quedaron en su cama final.
 */
function movePatients_(key, toMove) {
  if (!toMove.length) return 0;
  var fromCamas = {};
  toMove.forEach(function (m) { fromCamas[m.from] = true; });
  var ok = 0;
  var viaTemp = toMove.filter(function (m) { return fromCamas[m.to]; });
  viaTemp.forEach(function (m) { patchPatient_(key, m.row.id, { cama: '#MV-' + String(m.row.id).slice(0, 8) }); });
  toMove.forEach(function (m) { if (patchPatient_(key, m.row.id, { cama: m.to, updated_by: 'sheet-sync' })) ok++; });
  return ok;
}

/**
 * Archiva una fila de patients (con su nota) en public.archive con el formato que la app usa en
 * su Papelera (patient_data / note_data restaurables) y DESPUÉS la borra. Si el archivo falla
 * por cualquier motivo, NO borra: mejor un fantasma 5 min más que una nota perdida.
 */
function archiveAndDeletePatient_(key, r, motivo) {
  var H = { apikey: key, Authorization: 'Bearer ' + key };
  try {
    var pr = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/patients?id=eq.' + encodeURIComponent(r.id) + '&select=*,notes(*)', {
      method: 'get', headers: H, muteHttpExceptions: true
    });
    if (pr.getResponseCode() !== 200) { Logger.log('archive: GET paciente ' + r.cama + ' HTTP ' + pr.getResponseCode() + ' → NO se borra'); return false; }
    var rows = JSON.parse(pr.getContentText() || '[]');
    var p = rows[0];
    if (p) {   // si ya no existe, solo queda limpiar
      var n = Array.isArray(p.notes) ? (p.notes[0] || {}) : (p.notes || {});
      delete p.notes;
      var body = { patient_data: patientForArchive_(p), note_data: noteForArchive_(n, motivo), archived_by: 'sheet-sync' };
      var ar = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/archive', {
        method: 'post', contentType: 'application/json',
        headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
        payload: JSON.stringify(body), muteHttpExceptions: true
      });
      var ac = ar.getResponseCode();
      if (ac < 200 || ac >= 300) { Logger.log('archive: POST ' + r.cama + ' HTTP ' + ac + ': ' + ar.getContentText() + ' → NO se borra'); return false; }
    }
  } catch (e) { Logger.log('archive: error en ' + r.cama + ' → NO se borra: ' + e); return false; }
  // Borrar nota (FK) y luego la fila, por id.
  UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/notes?patient_id=eq.' + encodeURIComponent(r.id), { method: 'delete', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' }, muteHttpExceptions: true });
  var dr = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/patients?id=eq.' + encodeURIComponent(r.id), { method: 'delete', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' }, muteHttpExceptions: true });
  var dc = dr.getResponseCode();
  return dc >= 200 && dc < 300;
}

// Fila de patients → objeto paciente tal como lo guarda la app en su papelera (restaurable).
function patientForArchive_(p) {
  return {
    cama: p.cama || '', nombre: p.nombre || '', exp: p.exp || '', dx: p.dx || '', edad: p.edad || '',
    esp: p.esp || '', adscrito: p.adscrito || '', residente: p.residente || '', ingreso: p.ingreso || '',
    estado: p.estado || '', seccion: p.seccion || '', es_mio: p.es_mio !== false, _supa_id: p.id
  };
}
// Fila de notes → nota de la app (lab_history → labHistory, etc.) con la etiqueta de egreso.
function noteForArchive_(n, motivo) {
  n = n || {};
  var out = {
    app: n.app || '', pa: n.pa || '', drenajes: n.drenajes || '', qx: n.qx || '', manejo: n.manejo || '',
    sangrado: n.sangrado || '', sv: n.sv || '', balance: n.balance || '', pendientes: n.pendientes || '',
    checklist: n.checklist || {}, misc: n.misc || '',
    labHistory: Array.isArray(n.lab_history) ? n.lab_history : [],
    imagenHistory: Array.isArray(n.imagen_history) ? n.imagen_history : [],
    _egreso: motivo || 'RETIRADO DEL CENSO (hoja)',
    _egresoFecha: Utilities.formatDate(new Date(), 'America/Mexico_City', 'dd/MM/yyyy')
  };
  return out;
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

/**
 * Inserta filas de cuarentena/dedup en public.sync_log, UNA vez cada 6 h por (motivo, exp, camas).
 * El sync corre cada 5 min y la misma cuarentena se re-registraba en cada corrida: sync_log llegó
 * a ~29 000 filas de puro ruido y la tabla dejó de servir para diagnosticar.
 */
function logQuarantine_(key, rows) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (_) { cache = null; }
  var keyOf = function (q) { return ('sl|' + q.motivo + '|' + q.exp + '|' + q.camas).slice(0, 240); };
  var fresh = rows.filter(function (q) { return !(cache && cache.get(keyOf(q))); });
  if (!fresh.length) return 0;
  var url = SUPABASE_URL + '/rest/v1/sync_log';
  var body = fresh.map(function (q) { return { exp: q.exp, camas: q.camas, nombres: q.nombres, motivo: q.motivo }; });
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) { Logger.log('sync_log HTTP ' + code + ': ' + res.getContentText()); return 0; }
  if (cache) fresh.forEach(function (q) { try { cache.put(keyOf(q), '1', 21600); } catch (_) {} });
  return fresh.length;
}

// --- WATCHDOG DE LABORATORIOS --------------------------------------------------------------------
// El scraper de WinLab (GitHub Actions, 3 corridas/día) se quedó 5 semanas apagado en sept-oct 2026
// (GitHub desactiva los cron tras 60 días sin actividad) y nadie se enteró hasta que faltaron labs.
// Este chequeo corre cada 4 h: si el último scrape tiene más de LABS_STALE_HOURS, manda un correo
// (máximo uno cada 6 h) y deja constancia en sync_log.
var LABS_STALE_HOURS = 26;
function checkLabsFreshness() {
  var key = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
  if (!key) { Logger.log('FALTA Script Property SUPABASE_KEY'); return { ok: false, reason: 'no_key' }; }
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/winlab_labs?select=scraped_at&order=scraped_at.desc&limit=1', {
    method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) { Logger.log('labs watchdog: GET HTTP ' + res.getResponseCode()); return { ok: false, reason: 'http_' + res.getResponseCode() }; }
  var rows = JSON.parse(res.getContentText() || '[]');
  var last = rows[0] && rows[0].scraped_at;
  var hours = last ? (Date.now() - new Date(last).getTime()) / 36e5 : Infinity;
  Logger.log('labs watchdog: último scrape ' + (last || '(ninguno)') + ' → ' + (isFinite(hours) ? hours.toFixed(1) + ' h' : 'sin datos'));
  if (hours < LABS_STALE_HOURS) return { ok: true, last: last, hours: hours };

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (_) { cache = null; }
  if (cache && cache.get('labs_stale_alert')) return { ok: false, last: last, hours: hours, muted: true };
  var to = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  var h = isFinite(hours) ? Math.round(hours) + ' h' : 'nunca';
  MailApp.sendEmail(to,
    '⚠️ PisoLibro: sin laboratorios nuevos (último scrape: ' + h + ')',
    'El último scrape de WinLab guardado en Supabase (winlab_labs.scraped_at) es de ' + (last || 'nunca') + '.\n\n' +
    '1) Revisa el workflow: https://github.com/Gerardofdz1540/piso-libro/actions/workflows/winlab-scraper.yml\n' +
    '2) Si dice "This scheduled workflow is disabled", pulsa "Enable workflow".\n' +
    '3) Lanza una corrida manual con "Run workflow" y revisa el log si falla (credenciales de WinLab, layout, etc.).\n\n' +
    'Este aviso se repite como máximo cada 6 h mientras no lleguen labs nuevos.');
  if (cache) try { cache.put('labs_stale_alert', '1', 21600); } catch (_) {}
  try { logQuarantine_(key, [{ exp: '', camas: '', nombres: '', motivo: 'labs_stale_' + h.replace(/\s+/g, '') }]); } catch (_) {}
  return { ok: false, last: last, hours: hours, alerted: true };
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

/** Ejecuta esto UNA vez para instalar los 3 triggers (pide OAuth la primera vez; vuelve a correrlo al actualizar el script). */
function createTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onCensoEdit').forSpreadsheet(CENSO_SHEET_ID).onEdit().create();
  ScriptApp.newTrigger('doSyncScheduled').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('checkLabsFreshness').timeBased().everyHours(4).create();
  Logger.log('Triggers creados: onEdit (instalable) + sync cada 5 min + watchdog de labs cada 4 h.');
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
