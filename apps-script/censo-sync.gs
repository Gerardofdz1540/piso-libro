/***************************************************************************************************
 * PisoLibro — Sync Censo (Google Sheet) -> Supabase (patients)
 * --------------------------------------------------------------------------------------------------
 * Flujo:  Editas la hoja  ->  Apps Script empuja SOLO columnas censales  ->  Supabase  ->  Realtime
 *         (canal patients-changes del monolito)  ->  la app se re-renderiza sola.
 *
 * REGLA DE ORO (P0): este script SOLO escribe columnas censales de `patients`
 *   (cama, nombre, exp, edad, dx, esp, adscrito, residente, ingreso, dias, estado, seccion, es_mio)
 *   y las dos columnas de control de cama (cama_app_ts, cama_hoja_prev; ver caso (e) en syncPatients_).
 *   NUNCA toca la tabla `notes` ni ninguna otra columna clinica. UPSERT por ON CONFLICT(cama):
 *   actualiza censales y deja intacto el resto de la fila (id estable -> la nota sigue ligada).
 *
 * SEGURIDAD: la SERVICE KEY de Supabase vive SOLO en Script Properties (clave SUPABASE_KEY),
 *   nunca en la hoja ni en el repo. El censo (PHI) viaja de este script a Supabase autenticado por
 *   HTTPS; la hoja no se expone por ningun enlace publico. OJO: el Doc de indicaciones
 *   (INDICACIONES_DOC_ID) SI se descarga por su enlace publico de Google ("cualquiera con el
 *   enlace", export?format=txt) desde Supabase (pg_cron + pg_net, scripts/supabase_indicaciones_doc.sql):
 *   quien tenga ese enlace lee las indicaciones de todo el piso. syncIndicaciones() de este script
 *   lo lee con la cuenta de Google (DocumentApp) y es el camino si el Doc deja de ser publico.
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
// Google Doc "INDICACIONES HOSPITALIZACION": su texto completo se empuja a Supabase
// (tabla indicaciones_doc, una sola fila) y la app lo cruza por cama + nombre en cada tarjeta.
var INDICACIONES_DOC_ID = '1gRCydpjiByBjMxp5edTbuiEwrzHTh8Ir2IvgYqZY73A';

// Secciones ADMINISTRATIVAS (no son pacientes activos del piso): se ignoran por completo.
var EXCLUDE_ALWAYS_RE = [
  /^ALTAS/, /^DEFUNCION/, /^PROCEDIMIENTO/, /^INGRESOS/, /MOVIMIENTO/, /^TPN/
];
// Salas de OTROS servicios: se ignoran SUS pacientes, pero un paciente NUESTRO (quirúrgico)
// hospedado ahí SÍ se capta — p. ej. una embarazada de cirugía general en cama de gine (oct 2026,
// cama 2-092): antes la sección entera se descartaba y el paciente no aparecía en el tablero.
var OTHER_WARD_RE = [/ONCOLOG/, /HEMATOLOG/, /GINECOLOG/];

// Servicios "ajenos" para es_mio (FALSE solo si TODOS los componentes estan aqui).
var ES_MIO_EXCL = ['URO', 'UROLOGIA', 'NCX', 'NEUROCX', 'NEUROCIRUGIA', 'TYO'];

// ¿La especialidad es un servicio QUIRÚRGICO que el piso sigue? Se usa para rescatar a nuestros
// pacientes hospedados en salas de otros servicios (gine/onco/hemato). Cirugía = empieza con C y no
// es cardiología; más las subespecialidades quirúrgicas conocidas. Un paciente del servicio de esa
// sala (GO/GINE, ONC, HEM) o sin especialidad NO se capta. Combinaciones ("CG/URO") entran si algún
// componente es quirúrgico.
function isSurgicalService_(esp) {
  var toks = norm_(esp).split(/[\/,+&]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  if (!toks.length) return false;
  return toks.some(function (t) {
    if (/^C[A-Z]*$/.test(t) && t.length <= 5 && !/^CARD/.test(t)) return true;   // CG, CT, CV, CP, CPR, CCR, CMF, CYC, CPL…
    return /^(NCX|NEUROCX|NEUROCIRUGIA|URO|UROLOGIA|ANGIO|MAXILO|PLASTICA|COLOPROCTO|PROCTO|ONCOQX|TRASPLANTE)$/.test(t);
  });
}

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
  var result = dedupAndQuarantine_(parsed);    // {keep:[...], avisos:[...]}

  if (result.avisos.length) logQuarantine_(key, result.avisos);

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

  Logger.log('Sync OK: ' + dd.rows.length + ' upserts, ' + retired + ' retirados, ' + dd.dups + ' camas duplicadas, ' + result.avisos.length + ' avisos de expediente repetido.');
  return { upserts: dd.rows.length, retired: retired, camas_duplicadas: dd.dups, avisos: result.avisos.length };
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
 *  - seccion = ultimo encabezado visto. Ignora las secciones administrativas (EXCLUDE_ALWAYS_RE) y,
 *    en salas de otro servicio (OTHER_WARD_RE: gine/onco/hemato), deja solo a nuestros quirúrgicos.
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
    // Una fila con expediente válido es un PACIENTE aunque su dx/adscrito contengan palabras de
    // encabezado ("PACIENTE POSTOPERADA…", "CIRUJANO DE GUARDIA"): antes cortaba la tabla ahí y
    // todos los de abajo se "retiraban" (archivo + borrado) en la siguiente corrida.
    if (looksLikeHeader_(row) && !expLooksValid_(cell_(row, col.exp))) break;
    var exp = cell_(row, col.exp), nombre = cell_(row, col.nombre);
    if (exp && nombre) {
      // Guarda anti-mismap: un expediente real es numerico (ej. "26-13060"). Si "exp" trae
      // un nombre (letras), la fila esta mal mapeada (2a tabla) -> saltarla.
      if (!expLooksValid_(exp)) continue;
      if (sectionExcludedAlways_(section)) continue;   // ALTAS/DEFUNCIONES/… -> nunca se sincroniza
      // Sala de otro servicio (gine/onco/hemato): solo NUESTROS pacientes quirúrgicos.
      if (sectionOtherWard_(section) && !isSurgicalService_(cell_(row, col.esp))) continue;
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
    if (!c || c.length > 30) continue;   // un encabezado es corto; un dx largo con "PACIENTE" no lo es
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
 * Dedup por expediente, agrupando por PERSONA (mismo exp ya no implica misma persona).
 *  - Mismo exp en 2+ camas, MISMA persona -> conserva SOLO una cama (UCI/UTI gana a piso).
 *  - Mismo exp con NOMBRES distintos (error de captura en la hoja) -> se sincronizan TODOS (17 oct
 *    2026): es más importante que el paciente aparezca en la app. Antes se ponían en cuarentena: no
 *    entraba ninguno y el que ya estaba en la app se retiraba a los 12 min (caso real 3-154/3-189).
 *    Se deja aviso en sync_log para corregirlo en la hoja; syncPatients_ distingue a esas personas
 *    por nombre (sheetCamaFor_ / sameOccupant_) para no cruzar sus notas.
 * Devuelve { keep, avisos } (avisos = filas para sync_log).
 */
function dedupAndQuarantine_(list) {
  var byExp = {};
  list.forEach(function (p) { (byExp[p.exp] = byExp[p.exp] || []).push(p); });

  var keep = [], avisos = [];
  Object.keys(byExp).forEach(function (exp) {
    var grp = byExp[exp];
    if (grp.length === 1) { keep.push(grp[0]); return; }

    var people = groupPeople_(grp);
    if (people.length > 1) {
      avisos.push({ exp: exp, camas: grp.map(function (p) { return p.cama; }).join(', '),
                    nombres: grp.map(function (p) { return p.nombre; }).join(' | '),
                    motivo: 'exp_repetido_sincronizado' });
    }

    people.forEach(function (rows) {
      if (rows.length === 1) { keep.push(rows[0]); return; }
      // misma persona en varias camas -> UCI/UTI gana a piso
      var ref = rows.slice().sort(function (a, b) { return nameTokens_(b.nombre).length - nameTokens_(a.nombre).length; })[0];
      var uci = rows.filter(function (p) { return /^(UCI|UTI)/i.test(String(p.cama || '').trim()); });
      keep.push(uci.length ? uci[0] : rows[0]);
      avisos.push({ exp: exp, camas: rows.map(function (p) { return p.cama; }).join(', '),
                    nombres: ref.nombre, motivo: uci.length ? 'dedup_uci_gana_a_piso' : 'dedup_misma_persona_multi_cama' });
    });
  });
  return { keep: keep, avisos: avisos };
}

// Agrupa filas por PERSONA. Una fila entra a un grupo solo si es la misma persona que TODOS sus miembros
// y no encaja también en otro grupo: un nombre incompleto ("PEREZ RUIZ", solo apellidos) que encaja con
// dos personas distintas queda aparte en vez de juntarlas (antes se quedaba una sola fila y las otras dos
// personas no entraban al censo).
function groupPeople_(rows) {
  rows = rows || [];
  // Fila ambigua: encaja con dos filas que entre sí son personas distintas → va sola.
  var amb = rows.map(function (r, i) {
    var m = rows.filter(function (s, j) { return j !== i && samePerson_(r.nombre, s.nombre); });
    return m.some(function (s) { return m.some(function (t) { return s !== t && !samePerson_(s.nombre, t.nombre); }); });
  });
  var people = [];
  rows.forEach(function (p, i) {
    if (amb[i]) { var solo = [p]; solo.ambig = true; people.push(solo); return; }
    var fits = people.filter(function (g) { return !g.ambig && g.every(function (q) { return samePerson_(p.nombre, q.nombre); }); });
    if (fits.length === 1) fits[0].push(p); else people.push([p]);
  });
  return people;
}

// ¿Dos nombres son casi iguales (corrección de dedo en la hoja)? Mismo número de palabras y todas iguales
// salvo UNA, que solo puede diferir por una letra (palabras de 5+ letras: PERES/PEREZ) o ser abreviatura
// de apellido (HDZ/HDEZ ↔ HERNANDEZ: misma inicial, a lo más una vocal y sus letras en orden). Así
// ANA/ADRIANA, JUAN/JULIAN, LUIS/LUISA o ROSA/ROSARIO NO son "casi iguales". Solo se usa con expediente
// ambiguo, junto con la edad (closePerson_) y con "no es el nombre de la otra persona".
function closeName_(n1, n2) {
  var a = nameTokens_(n1), b = nameTokens_(n2);
  if (!a.length || a.length !== b.length) return false;
  var used = {}, diffs = 0;
  var ok = a.every(function (t) {
    for (var i = 0; i < b.length; i++) if (!used[i] && b[i] === t) { used[i] = true; return true; }
    for (var j = 0; j < b.length; j++) if (!used[j] && tokenClose_(t, b[j])) { used[j] = true; diffs++; return true; }
    return false;
  });
  return ok && diffs <= 1;
}
function tokenClose_(t, u) {
  if (t === u) return true;
  if (t.length >= 5 && u.length >= 5 && editDistance1_(t, u)) return true;
  var sh = t.length <= u.length ? t : u, lo = t.length <= u.length ? u : t;
  var vowels = (sh.match(/[AEIOU]/g) || []).length;
  if (sh.length >= 2 && sh.length <= 5 && vowels <= 1 && lo.length > sh.length && sh[0] === lo[0]) {   // abreviatura
    var j = 0;
    for (var i = 0; i < lo.length && j < sh.length; i++) if (lo[i] === sh[j]) j++;
    if (j === sh.length) return true;
  }
  return false;
}
// ── Expediente ÚNICO: ¿la fila de Supabase (r) y la de la hoja (s) son la misma persona? ─────────────────────────
// Manda el expediente (como siempre) salvo que el nombre PRUEBE que es otra persona:
//   · MISMA persona si TODAS las palabras de uno de los dos nombres encajan, una a una, en el otro: iguales, mismo
//     sonido (DIAS/DIAZ, BAEZ/VAES), error de dedo o letras cruzadas (JUAM/JUAN, JUNA/JUAN, GRACIA/GARCIA; dos
//     letras en palabras de 7+), abreviatura (HDZ, FCO, ALEJ), inicial (J, L) o palabras juntas o separadas
//     (DELACRUZ / DE LA CRUZ, MONTESDEOCA, MARIAJOSE). Así siguen las correcciones y los nombres que se completan.
//   · OTRA persona si a LOS DOS nombres les sobra alguna palabra: hermanos (JUAN/MARIA, JUAN/JUANA), un exp copiado a
//     otro ingreso, el caso real de la 3-154/3-189 (un solo apellido en común).
//   · La EDAD no cuenta: mientras se reescribe una fila, la hoja conserva la edad del ocupante anterior.
//   · No identificados (DESCONOCIDO, FEMENINA, N.N., RN, HIJO DE…): el que se identifica sigue siendo él; uno con
//     nombre que pasa a no identificado es OTRO ingreso. Sin nombre en alguno: decide el expediente.
function namesCompatible_(r, s) {
  if (!s) return true;
  var a = nameWords_(r && r.nombre || ''), b = nameWords_(s.nombre || '');
  if (!a.length || !b.length || namePlaceholder_(a)) return true;
  if (namePlaceholder_(b)) return false;
  var cov = coverWords_(a, b);
  return cov.a || cov.b;
}
// Palabras para namesCompatible_: sin acentos ni signos; DE/DEL/LA/LAS/LOS se pegan a la palabra siguiente
// (DE LA CRUZ → DELACRUZ, núcleo CRUZ); abreviaturas y apodos usuales al nombre completo (MA → MARIA, LUPE →
// GUADALUPE, PACO → FRANCISCO); las iniciales (J, L) se quedan. Solo apodos que no son ambiguos (BETO, FER, ALE no).
var NAME_PARTICLE = { DE: 1, DEL: 1, LA: 1, LAS: 1, LOS: 1 };
var NAME_EXPAND = { MA: 'MARIA', GPE: 'GUADALUPE', LUPE: 'GUADALUPE', LUPITA: 'GUADALUPE', PACO: 'FRANCISCO', PANCHO: 'FRANCISCO',
  PEPE: 'JOSE', CHUY: 'JESUS', CHUCHO: 'JESUS', CONCHA: 'CONCEPCION', CONCHITA: 'CONCEPCION', NACHO: 'IGNACIO', MEMO: 'GUILLERMO',
  LALO: 'EDUARDO', TONO: 'ANTONIO', TONA: 'ANTONIA', CHAVA: 'SALVADOR', QUIQUE: 'ENRIQUE', LOLA: 'DOLORES', TERE: 'TERESA',
  PATY: 'PATRICIA', MAGO: 'MARGARITA', MAGOS: 'MARGARITA', FCO: 'FRANCISCO', FCA: 'FRANCISCA' };
function nameWords_(name) {
  var out = [], pre = '';
  norm_(name).replace(/[^A-Z\s]/g, ' ').split(/\s+/).forEach(function (w) {
    if (!w || w === 'Y') return;
    if (NAME_PARTICLE[w]) { pre += w; return; }
    w = NAME_EXPAND[w] || w;
    out.push({ w: pre + w, core: w }); pre = '';
  });
  if (pre) out.push({ w: pre, core: pre });
  return out;
}
// Nombre de paciente aún no identificado (DESCONOCIDO y sus errores de dedo, FEMENINA, N.N., S/N, RN, HIJO DE…, SIN
// IDENTIFICAR, IGNORADO, ANÓNIMO, SIN DATOS, XX) o solo iniciales (N N, X). Una "N" suelta junto a palabras reales
// (PEREZ N JUAN: apellido que aún no se sabe) NO vuelve comodín al nombre entero: vale por una palabra (coverWords_).
var NAME_PLACEHOLDER_RE = /^(DESCON[A-Z]*|DESCO|DESC|NN|RN|RECIEN|NACID[OA]|IDENT|IDENTIF[A-Z]*|IGNORAD[OA]|ANONIM[OA]|INCOGNIT[OA]|FILIAD[OA]|REGISTRAD[OA]|REGISTRO|NI|NOMBRE|PACIENTE|MASC|MASCULIN[OA]|FEM|FEMENIN[OA]|XX+|DATOS|HIJ[OA]|BEBE|PRODUCTO|MUJER|HOMBRE)$/;
function namePlaceholder_(words) {
  return words.some(function (x) { return NAME_PLACEHOLDER_RE.test(x.core) || (x.core.length >= 9 && editDistance_(x.core, 'DESCONOCIDO') <= 2); })
    || words.every(function (x) { return /^[NXSDI]$/.test(x.core); });
}
// "N" o "X" sueltas: apellido/nombre que aún no se sabe → encaja con cualquier palabra que sobre del otro nombre.
function nameWild_(x) { return /^[NX]$/.test(x.core); }
// ¿Mismo nombre (palabra por palabra, ya normalizado y con apodos/abreviaturas expandidos)?
function exactName_(r, s) {
  var a = nameWords_(r && r.nombre || ''), b = nameWords_(s && s.nombre || '');
  return a.length > 0 && a.length === b.length && a.every(function (x, i) { return x.w === b[i].w; });
}
// ¿Todas las palabras de a (o todas las de b) encajan, una a una, en el otro nombre? → { a, b }
function coverWords_(a, b) {
  var ua = a.map(function () { return 0; }), ub = b.map(function () { return 0; });   // 0 = sin par; 1 = igual; 2 = parecida
  var pass = function (eq, kind) {
    a.forEach(function (x, i) {
      if (ua[i]) return;
      for (var j = 0; j < b.length; j++) if (!ub[j] && eq(x, b[j])) { ua[i] = ub[j] = kind; return; }
    });
  };
  pass(function (x, y) { return x.w === y.w; }, 1);
  pass(function (x, y) { return x.core === y.core || x.w === y.core || x.core === y.w; }, 1);
  pass(function (x, y) { return wordClose_(x.core, y.core) || wordClose_(x.w, y.w); }, 2);
  joinCover_(a, ua, b, ub); joinCover_(b, ub, a, ua);
  // "N"/"X" sueltas que quedaron sin par valen por UNA palabra que sobre del otro nombre (PEREZ N JUAN / PEREZ GOMEZ JUAN).
  var wild = function (a, ua, b, ub) {
    a.forEach(function (x, i) {
      if (ua[i] || !nameWild_(x)) return;
      for (var j = 0; j < b.length; j++) if (!ub[j]) { ua[i] = ub[j] = 1; return; }
    });
  };
  wild(a, ua, b, ub); wild(b, ub, a, ua);
  // Una sola palabra corta (3 letras: ANA/AMA, DIA/DIAZ, LUI/LUIS) con un error de dedo, si TODAS las demás son iguales.
  var ia = ua.indexOf(0), ib = ub.indexOf(0);
  if (ia >= 0 && ib >= 0 && ua.indexOf(0, ia + 1) < 0 && ub.indexOf(0, ib + 1) < 0
      && ua.every(function (k, i) { return i === ia || k === 1; }) && ub.every(function (k, j) { return j === ib || k === 1; })) {
    if (shortWordFix_(a[ia].core, b[ib].core)) ua[ia] = ub[ib] = 2;
  }
  return { a: ua.every(Boolean), b: ub.every(Boolean) };
}
// Palabra corta (3 letras) con un error de dedo: solo si una es la otra sin la última letra (DIA/DIAZ, LUI/LUIS) o cambia
// UNA consonante (AMA/ANA). Una vocal distinta o una letra de más en medio ya es otro nombre (LUZ/LIZ, EVA/IVA, LUZ/LUIS,
// IAN/IVAN, LIA/LILA); y si la corta es un nombre de pila completo (NOE/NOEL, ELI/ELIA, LEO/LEON) o las dos lo son
// (ANA/ADA), son dos personas, como JUAN/JUANA.
var SHORT_GIVEN_NAMES = {};
'ANA EVA IVA LUZ LIZ LIA MIA ZOE NOE ELI ELY IAN LEO SOL PAZ ALI ADA IDA EMA AMY RUT GIL ABI ABY ARI BEA ISA IVO JOB JON KIM LEA LIS LUA MAX MEL NOA NIA PIA RAY REY ROY SAM TEO UMA VAL JOE GUS TOM ANI ANY AZU LUIS IVAN NOEL ELIA ELIO LILA LANA LEON EVAN JOEL LIAM ADAN JUAN JOSE RAUL SAUL ABEL ALAN ALMA ARON AXEL CLOE DANA ELSA EMMA ERIK GAEL HUGO IKER INES IRIS ISAI JADE LUNA LEVI LOLA LUCA MARA NOAH OMAR OTTO RITA ROSA RUTH SARA'.split(' ').forEach(function (n) { SHORT_GIVEN_NAMES[n] = 1; });
function shortWordFix_(x, y) {
  var sh = x.length <= y.length ? x : y, lo = x.length <= y.length ? y : x;
  if (sh.length < 3 || genderPair_(x, y)) return false;
  if (lo.length === sh.length + 1) return lo.indexOf(sh) === 0 && !SHORT_GIVEN_NAMES[sh];
  if (lo.length !== sh.length) return false;
  var d = 0, k = -1;
  for (var i = 0; i < sh.length; i++) if (sh[i] !== lo[i]) { d++; k = i; }
  if (d !== 1 || /[AEIOU]/.test(sh[k]) || /[AEIOU]/.test(lo[k])) return false;
  return !(SHORT_GIVEN_NAMES[sh] && SHORT_GIVEN_NAMES[lo]);
}
// Una palabra que son dos o tres seguidas del otro nombre, pegadas (MONTESDEOCA / MONTES DE OCA, MARIAJOSE / MARIA JOSE).
function joinCover_(a, ua, b, ub) {
  a.forEach(function (x, i) {
    if (ua[i]) return;
    for (var j = 0; j + 1 < b.length; j++) {
      for (var k = j + 1; k < b.length && k <= j + 2; k++) {
        var free = true, s = '', q;
        for (q = j; q <= k; q++) { if (ub[q]) free = false; s += b[q].w; }
        if (free && editDistance_(phon_(s), phon_(x.w)) <= 1) { ua[i] = 2; for (q = j; q <= k; q++) ub[q] = 2; return; }
      }
    }
  });
}
// ¿Dos palabras de nombre son la misma con un error de captura?
function wordClose_(t, u) {
  if (t === u) return true;
  if (t.length === 1 || u.length === 1) return t[0] === u[0];                 // inicial: J = JUAN
  if (genderPair_(t, u)) return false;                                        // JUAN/JUANA, MARIO/MARIA: otro nombre
  var pt = phon_(t), pu = phon_(u);
  if (pt === pu || tokenClose_(t, u)) return true;                            // DIAS/DIAZ; una letra (5+); HDZ, FCO
  var sh = t.length <= u.length ? t : u, lo = t.length <= u.length ? u : t;
  if (sh.length >= 3 && lo.length >= sh.length + 2 && /[^AEIOU]$/.test(sh) && lo.indexOf(sh) === 0) return true;   // ALEJ
  var d = editDistance_(pt, pu), n = Math.min(pt.length, pu.length);
  return (d <= 1 && n >= 4) || (d <= 2 && n >= 7);                           // JUNA/JUAN; HERNADES/HERNANDEZ
}
// Masculino/femenino del mismo nombre de pila (JUAN/JUANA, LUIS/LUISA, MARIO/MARIA): son personas distintas, no un error
// de dedo. Lista de nombres de pila conocidos (cortos) y, para palabras de 7+ letras, la regla general (una A al final o
// O/A final: EUGENIO/EUGENIA, NICOLAS/NICOLASA, GREGORIO/GREGORIA). En un apellido corto, una A de más o de menos o una A
// por O (GARCI/GARCIA, SOTA/SOTO, OCHO/OCHOA) es captura, y los hermanos comparten apellidos, así que ahí no distingue a nadie.
var NAME_GENDER_PAIRS = ['JUAN JUANA', 'LUIS LUISA', 'MARIO MARIA', 'JOSE JOSEFA', 'JOSE JOSEFINA', 'FRANCISCO FRANCISCA', 'ANTONIO ANTONIA',
  'DANIEL DANIELA', 'ALEJANDRO ALEJANDRA', 'ADRIAN ADRIANA', 'CRISTIAN CRISTINA', 'JULIO JULIA', 'ROBERTO ROBERTA', 'FERNANDO FERNANDA',
  'MANUEL MANUELA', 'RAFAEL RAFAELA', 'ANGEL ANGELA', 'VICTOR VICTORIA', 'ANDRES ANDREA', 'GABRIEL GABRIELA', 'EMILIO EMILIA',
  'PAULO PAULA', 'PABLO PAULA', 'PABLO PABLA', 'MARIANO MARIANA', 'AGUSTIN AGUSTINA', 'JOAQUIN JOAQUINA', 'MARTIN MARTINA', 'VALENTIN VALENTINA',
  'RAMON RAMONA', 'LORENZO LORENZA', 'VICENTE VICENTA', 'CARLOS CARLA', 'EDUARDO EDUARDA', 'RICARDO RICARDA', 'IGNACIO IGNACIA',
  'PEDRO PETRA', 'JESUS JESUSA', 'TOMAS TOMASA', 'DOMINGO DOMINGA', 'ALBERTO ALBERTA', 'ERNESTO ERNESTINA', 'AURELIO AURELIA',
  'CLAUDIO CLAUDIA', 'SILVIO SILVIA', 'OCTAVIO OCTAVIA', 'JUSTINO JUSTINA', 'FLORENTINO FLORENTINA', 'MAXIMO MAXIMA', 'PATRICIO PATRICIA',
  'LUCIO LUCIA', 'RUBEN RUBI', 'ALEJO ALEJA', 'GERMAN GERMANA', 'JULIAN JULIANA', 'SEBASTIAN SEBASTIANA', 'ELIAS ELISA', 'BENITO BENITA',
  'FELIPE FELIPA', 'GUILLERMO GUILLERMINA', 'LEONARDO LEONARDA', 'ARTURO ARTURA', 'MARCO MARCA', 'MARCELO MARCELA', 'ROGELIO ROGELIA',
  'HILARIO HILARIA', 'EVARISTO EVARISTA', 'CELESTINO CELESTINA', 'TEODORO TEODORA', 'ISIDRO ISIDRA', 'JACINTO JACINTA', 'EUSEBIO EUSEBIA',
  'IVAN IVANA', 'PAUL PAULA', 'LEON LEONA', 'ERIK ERIKA', 'DARIO DARIA', 'ELIO ELIA', 'PAOLO PAOLA', 'SIMON SIMONA', 'BRUNO BRUNA',
  'ADOLFO ADOLFA', 'ELISEO ELISEA', 'ROMAN ROMANA', 'AMADO AMADA', 'SERGIO SERGIA', 'FABIAN FABIANA', 'DAMIAN DAMIANA', 'ELENO ELENA',
  'CIRILO CIRILA', 'ELADIO ELADIA', 'FAUSTO FAUSTA', 'FIDEL FIDELA', 'GENARO GENARA', 'JOVITO JOVITA', 'LAZARO LAZARA', 'LINO LINA',
  'MAURO MAURA', 'PASCUAL PASCUALA', 'RAMIRO RAMIRA', 'RUFINO RUFINA', 'SEVERO SEVERA', 'SOTERO SOTERA', 'URBANO URBANA', 'ZENON ZENONA'];
var NAME_GENDER_SET = {};
NAME_GENDER_PAIRS.forEach(function (p) { var m = p.split(' '); NAME_GENDER_SET[m[0] + ' ' + m[1]] = NAME_GENDER_SET[m[1] + ' ' + m[0]] = true; });
function genderPair_(t, u) {
  if (t === u) return false;
  if (NAME_GENDER_SET[t + ' ' + u]) return true;
  if (t.length < 7 || u.length < 7) return false;
  if (t + 'A' === u || u + 'A' === t) return true;
  return t.length === u.length && t.slice(0, -1) === u.slice(0, -1) && /^[OA]$/.test(t.slice(-1)) && /^[OA]$/.test(u.slice(-1));
}
// Forma "como suena" para errores de captura comunes: V=B, Z=S, CE/CI=SE/SI, LL=Y, sin letras repetidas.
function phon_(w) {
  return w.replace(/V/g, 'B').replace(/Z/g, 'S').replace(/C([EI])/g, 'S$1').replace(/LL/g, 'Y').replace(/(.)\1+/g, '$1');
}
// Distancia de edición contando como 1 el cruce de dos letras vecinas (Damerau restringida).
function editDistance_(a, b) {
  var prev2 = null, prev = [], i, j;
  for (j = 0; j <= b.length; j++) prev[j] = j;
  for (i = 1; i <= a.length; i++) {
    var cur = [i];
    for (j = 1; j <= b.length; j++) {
      var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    prev2 = prev; prev = cur;
  }
  return prev[b.length];
}
// Exp único: ¿la fila de la hoja en esa cama es la persona de la fila r de Supabase? (namesCompatible_). Si además la
// hoja tiene en SU cama actual a alguien con OTRO exp, la foto admite dos historias: le corrigieron el exp (se queda, caso
// d; el caso real de la 3-189: el exp viejo quedó en la cama de otra persona) o se fue a `cama` y su cama la ocupa otro
// ingreso. Decide, en este orden: su nombre exacto en su cama → se queda; su nombre exacto en el destino → se mueve; la
// fecha de ingreso (la hoja la copia con el paciente) → donde esté la suya; y si nada lo aclara y los dos son no
// identificados, EMPATE: el bucle deja las dos camas quietas (maps.tie) y avisa, en vez de adivinar.
function uniqueExpMatch_(maps, r, cama) {
  var s = maps.rowByCama[cama];
  if (!namesCompatible_(r, s)) return false;
  var own = normalizeCama_(r && r.cama), o = maps.rowByCama[own];
  if (own === cama || !o || !s || String(o.exp || '').trim() === String(s.exp || '').trim()) return true;
  var rPh = namePlaceholder_(nameWords_(r && r.nombre || ''));
  if (!rPh) {   // un nombre real sí identifica; dos "DESCONOCIDO" iguales no dicen nada
    var exOwn = exactName_(r, o), exDest = exactName_(r, s);
    if (exOwn && !exDest) return false;
    if (exDest && !exOwn) return true;
  }
  var ing = String(r && r.ingreso || '').trim(), ingOwn = String(o.ingreso || '').trim(), ingDest = String(s.ingreso || '').trim();
  // La fecha de su cama solo vale si el nombre de esa cama puede ser él: mientras se reescribe la fila para otra persona
  // la hoja conserva la fecha del ocupante anterior (como la edad), y con ella se le archivaba en vez de moverlo.
  if (ing && ingOwn === ing && ingDest !== ing && namesCompatible_(r, o)) {
    // Un no identificado cuya cama ya tiene a alguien CON nombre y otro exp no puede "quedarse" como corrección de exp
    // (ese nombre no es el suyo) y acababa archivado: EMPATE, las dos camas esperan a que la hoja lo aclare.
    if (rPh && !namePlaceholder_(nameWords_(o.nombre || '')) && maps.tie) maps.tie[r.id] = cama;
    return false;
  }
  if (ing && ingDest === ing && ingOwn !== ing) return true;
  var ws = nameWords_(s.nombre || '');
  if (rPh && namePlaceholder_(nameWords_(o.nombre || '')) && ws.length && !namePlaceholder_(ws)) {
    if (maps.tie) maps.tie[r.id] = cama;
    return false;
  }
  return true;
}
// Casi la misma persona: nombre casi igual y la edad no lo contradice (±1 año cuando ambas se conocen).
function closePerson_(r, s) {
  if (!closeName_(r && r.nombre || '', s && s.nombre || '')) return false;
  var ea = parseInt(r && r.edad, 10), eb = parseInt(s && s.edad, 10);
  return isNaN(ea) || isNaN(eb) || Math.abs(ea - eb) <= 1;
}
// ¿Distancia de edición ≤ 1 (una letra cambiada, de más o de menos)?
function editDistance1_(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  var i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
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
 *   (e) CAMA CAMBIADA DESDE LA APP (16 oct 2026) — ver appBedDecisions_: la cama que un residente
 *       fijó en la app se RESPETA hasta que la hoja la cambie; mientras tanto la fila de la hoja con
 *       ese exp en la cama vieja no entra al upsert (si no, on_conflict=cama lo duplicaba allí).
 * GUARDAS: si la hoja parseó <10 o habría que borrar >50% del censo → NO reconcilia (solo upsert),
 * para que un error de lectura nunca borre el piso. Devuelve cuántas filas retiró.
 */
// Periodo de GRACIA antes de retirar (13 oct 2026). El trigger onEdit sincroniza en CADA tecla: al
// cortar/pegar una fila para cambiar de cama (o al reescribir un expediente) la hoja pasa por un
// estado intermedio en el que el paciente NO está; antes eso bastaba para archivarlo y borrarlo
// (CASCADE a su nota: labs, pendientes, diagrama) y 3 s después el pegado lo creaba como fila NUEVA
// y VACÍA (caso real: UCI 7 → 3-162, 3-180 → 3-161, 3-153 cortada y repegada). Ahora un paciente
// solo se retira cuando lleva >= RETIRO_GRACIA_MIN minutos seguidos sin aparecer en la hoja.
// Un egreso real sigue saliendo del tablero, solo que unos minutos después.
var RETIRO_GRACIA_MIN = 12;
var MISSING_PROP = 'PL_MISSING_SINCE';   // Script Property: {"<id>": epoch_ms} (primera corrida sin verlo)

function readMissingSince_() {
  try { var raw = PropertiesService.getScriptProperties().getProperty(MISSING_PROP); var o = raw ? JSON.parse(raw) : {}; return (o && typeof o === 'object') ? o : {}; }
  catch (_) { return {}; }
}
function writeMissingSince_(map) {
  try { var ps = PropertiesService.getScriptProperties(); if (ps && ps.setProperty) ps.setProperty(MISSING_PROP, JSON.stringify(map || {})); } catch (_) {}
}

// Mapas de la hoja (camas ya normalizadas): cama→exp, exp→todas sus camas y cama→fila.
function sheetMaps_(payload) {
  var byCama = {}, camasByExp = {}, rowByCama = {};
  payload.forEach(function (p) {
    var e = String(p.exp || '').trim();
    byCama[p.cama] = e;
    rowByCama[p.cama] = p;
    if (e) (camasByExp[e] = camasByExp[e] || []).push(p.cama);
  });
  return { byCama: byCama, camasByExp: camasByExp, rowByCama: rowByCama };
}

// Cama de la hoja para una persona (exp + nombre). Exp único en la hoja: su cama, como siempre.
// Exp que comparten 2+ personas (error de captura que ya no se pone en cuarentena): solo la cama
// cuya fila es la MISMA persona; si no hay exactamente una, undefined (no se adivina: adivinar
// movería la fila, con su nota, a la cama de la otra persona).
function sheetCamaFor_(maps, exp, r) {
  var camas = maps.camasByExp[exp];
  if (!camas || !camas.length) return undefined;
  // Exp único: su cama, salvo que el nombre sea de otra persona (uniqueExpMatch_; caso real 18 oct: a la 3-189
  // le corrigieron el exp y el viejo quedó solo en la 3-154, de OTRA persona; se movía la fila de la 3-189,
  // con su nota, a la 3-154 y se le ponía el nombre del de la 3-154).
  if (!expAmbiguous_(maps, exp)) {
    if (camas.length !== 1) return undefined;
    var c0 = camas[0], s0 = maps.rowByCama[c0];
    if (uniqueExpMatch_(maps, r, c0)) return c0;
    // Fila escrita desde la APP (ver sameOccupant_) cuyo exp la hoja tiene en OTRA cama con un nombre no compatible:
    // la hoja lo movió (cortar/pegar) antes de escribir el nombre. Si la hoja trae un no identificado, no contradice
    // a nadie → se MUEVE conservando su nombre (appMove: el PATCH no toca updated_by y la cama nueva queda fuera del
    // upsert; en la siguiente corrida espera ahí como en la misma cama). Si trae otro nombre, no se adivina: las dos
    // camas esperan (appHold). Sin esto quedaba como fantasma en la cama vieja y la hoja lo insertaba duplicado.
    // Salvo que en SU cama la hoja lo tenga a él con otro exp (le corrigieron el exp y el viejo quedó en otra cama, el
    // caso real de la 3-189): entonces manda la corrección de exp (d) y no se mueve ni espera.
    var own0 = normalizeCama_(r && r.cama), o0 = maps.rowByCama[own0];
    if (r && appWritten_(r) && c0 !== own0 && s0 && !namesCompatible_(r, s0) && !(o0 && namesCompatible_(r, o0))) {
      if (maps.appHold) maps.appHold[r.id] = c0;
      // ...y si su fecha de ingreso sigue en SU cama (y no en la nueva), la hoja está reescribiendo su fila (exp
      // corregido, nombre pendiente): se queda esperando ahí, no se mueve (misma regla de fecha que uniqueExpMatch_).
      var ingR = String(r.ingreso || '').trim();
      var dateStays = ingR && o0 && String(o0.ingreso || '').trim() === ingR && String(s0.ingreso || '').trim() !== ingR;
      if (!dateStays && namePlaceholder_(nameWords_(s0.nombre || '')) && !namePlaceholder_(nameWords_(r.nombre || ''))) {
        if (maps.appMove) maps.appMove[r.id] = c0;
        return c0;
      }
    }
    return undefined;
  }
  var nombre = (r && r.nombre) || '';
  var hits = camas.filter(function (c) { var sr = maps.rowByCama[c]; return !!sr && samePerson_(nombre, sr.nombre || ''); });
  // Varias filas encajan (p. ej. una con solo apellidos): se descartan las ambiguas de la hoja.
  if (hits.length > 1) hits = hits.filter(function (c) { return !ambiguousSheetRow_(maps, exp, c); });
  if (!hits.length) {   // nombre corregido en la hoja: casi igual, misma edad y que no sea el de otra persona
    hits = camas.filter(function (c) { var sr = maps.rowByCama[c]; return !!sr && closePerson_(r, sr) && !otherHasName_(maps, exp, r && r.id, sr.nombre); });
  }
  return hits.length === 1 ? hits[0] : undefined;
}
// ¿La fila de la hoja en esa cama encaja con dos filas de la hoja (mismo exp) que entre sí son personas
// distintas? (un nombre con solo apellidos): no se usa para decidir a quién mover.
function ambiguousSheetRow_(maps, exp, cama) {
  var sr = maps.rowByCama[cama];
  var m = (maps.camasByExp[exp] || []).filter(function (c) { var o = maps.rowByCama[c]; return c !== cama && o && sr && samePerson_(sr.nombre || '', o.nombre || ''); });
  return m.some(function (a) { return m.some(function (b) { return a !== b && !samePerson_(maps.rowByCama[a].nombre || '', maps.rowByCama[b].nombre || ''); }); });
}

// ¿Expediente AMBIGUO? 2+ personas distintas con ese exp en la hoja O en Supabase. Basta con que Supabase
// aún tenga a las dos (la hoja ya dio de alta a una, le corrigió el exp o está a medio intercambiar camas):
// sin esto el exp, otra vez único en la hoja, volvía a emparejar por expediente y una fila, con su nota,
// recibía el nombre y la cama de la otra persona.
function expAmbiguous_(maps, exp) {
  return (maps.camasByExp[exp] || []).length >= 2 || !!(maps.ambig && maps.ambig[exp]);
}
// Expedientes con 2+ personas distintas en Supabase (cur) → { exp: true }.
function ambiguousExps_(cur) {
  var byExp = {}, out = {};
  (cur || []).forEach(function (r) { var e = String(r.exp || '').trim(); if (e && String(r.nombre || '').trim()) (byExp[e] = byExp[e] || []).push(r); });
  Object.keys(byExp).forEach(function (e) { if (groupPeople_(byExp[e]).length > 1) out[e] = true; });
  return out;
}
// ¿Algún OTRO paciente de Supabase con ese exp tiene ese nombre (igual o parecido)?
function otherHasName_(maps, exp, selfId, nombre) {
  return (maps.curByExp && maps.curByExp[exp] || []).some(function (q) {
    return q.id !== selfId && (samePerson_(q.nombre || '', nombre || '') || closeName_(q.nombre || '', nombre || ''));
  });
}

// ¿La fila la escribió la app (o un import) y no este script? El upsert pone 'sheet-sync' en cada corrida; cualquier
// otro valor, vacío incluido (dispositivo sin nombre de usuario), es una escritura ajena a la hoja.
function appWritten_(r) { return String(r && r.updated_by || '') !== 'sheet-sync'; }

// ¿La fila r de Supabase sigue siendo quien la hoja tiene en esa cama? Mismo exp basta salvo que el exp
// sea ambiguo: entonces también tiene que ser la misma persona (si no, el upsert por cama le pondría a
// esta fila, con su nota, el nombre de la otra persona). Un nombre corregido en la hoja ("PERES" → "PEREZ",
// "HDZ" → "HERNANDEZ") sigue siendo la misma persona si no es el nombre de la otra.
function sameOccupant_(maps, r, cama, exp) {
  if (maps.byCama[cama] === undefined || maps.byCama[cama] !== exp) return false;
  // Exp único: misma cama + mismo exp basta salvo que el nombre sea claramente de otra persona (exp copiado
  // a un ingreso nuevo en esa cama): entonces es cama reasignada, nunca renombrar la fila con su nota.
  // Si la fila la escribió la APP hace un momento (updated_by ≠ sheet-sync; el upsert lo vuelve a poner en ≤ 5 min) y
  // la hoja trae OTRO nombre con el mismo exp, la foto admite dos historias: el residente identificó a un DESCONOCIDO
  // o corrigió el nombre y la hoja va atrasada, o la hoja puso un ingreso nuevo encima con el exp copiado. No se
  // adivina: ni se renombra (la nota quedaría bajo otro nombre) ni se archiva (perdería la corrección): la cama espera
  // (maps.appHold → fuera del upsert) y se avisa en sync_log hasta que la hoja coincida o cambie el exp.
  if (!expAmbiguous_(maps, exp)) {
    if (appWritten_(r) && !namesCompatible_(r, maps.rowByCama[cama])) {
      if (maps.appHold) maps.appHold[r.id] = cama;
      return false;
    }
    return uniqueExpMatch_(maps, r, cama);
  }
  if (!String(r.nombre || '').trim()) return true;
  var sr = maps.rowByCama[cama];
  if (!sr) return false;
  if (samePerson_(r.nombre, sr.nombre || '')) return true;
  // Si su propio nombre está en OTRA cama de la hoja con ese exp, se movió: no es una corrección de nombre.
  var ownElsewhere = (maps.camasByExp[exp] || []).some(function (c) { var o = maps.rowByCama[c]; return c !== cama && o && samePerson_(r.nombre, o.nombre || ''); });
  if (ownElsewhere) return false;
  return closePerson_(r, sr) && !otherHasName_(maps, exp, r.id, sr.nombre);
}

// Columnas de control del caso (e). cama_hoja_prev guarda o bien la cama que decía la hoja cuando se vio
// por 1ª vez el movimiento de la app (pin activo), o bien la marca 'ok@<cama_app_ts>' = "ese movimiento
// ya se resolvió" (la hoja lo alcanzó o lo cambió). La marca existe porque la app REENVÍA cama_app_ts en
// cada guardado mientras su copia local no se refresque (iPad sin Realtime tras dormir, red intermitente):
// sin ella, ese reenvío re-armaba un movimiento ya resuelto y la siguiente corrida fijaba la cama vieja de
// la app por encima de un cambio legítimo de la hoja. Un movimiento NUEVO trae un cama_app_ts posterior.
var CAMA_OK_PREFIX = 'ok@';
function camaTsMs_(v) { var t = new Date(String(v)).getTime(); return isNaN(t) ? null : t; }
function camaPrevIsMark_(r) { return r.cama_hoja_prev != null && String(r.cama_hoja_prev).indexOf(CAMA_OK_PREFIX) === 0; }
// ¿El cama_app_ts de la fila ya está cubierto por la marca de resuelto (mismo o anterior)?
function camaAppResolved_(r) {
  if (r.cama_app_ts == null || !camaPrevIsMark_(r)) return false;
  var done = String(r.cama_hoja_prev).slice(CAMA_OK_PREFIX.length), ts = String(r.cama_app_ts);
  if (done === ts) return true;
  var a = camaTsMs_(ts), b = camaTsMs_(done);
  return a !== null && b !== null && a <= b;
}
// Movimiento de la app pendiente de resolver.
function camaAppActive_(r) { return r.cama_app_ts != null && !camaAppResolved_(r); }
// Cama de la hoja anotada para el pin activo (null si no hay o si es la marca de resuelto).
function camaHojaPrev_(r) { return (r.cama_hoja_prev == null || camaPrevIsMark_(r)) ? null : normalizeCama_(r.cama_hoja_prev); }
// Columnas para dar por resuelto el movimiento de la app ({} si no hay nada que cambiar).
function camaResolvedCols_(r) {
  if (r.cama_app_ts == null) return (r.cama_hoja_prev != null && !camaPrevIsMark_(r)) ? { cama_hoja_prev: null } : {};
  if (camaAppResolved_(r)) return { cama_app_ts: null };   // reenvío de una marca ya resuelta: no se baja la marca
  return { cama_app_ts: null, cama_hoja_prev: CAMA_OK_PREFIX + String(r.cama_app_ts) };
}

/**
 * (e) CAMA CAMBIADA DESDE LA APP. Cuando un residente mueve a un paciente desde la app (Editar /
 * cambiar cama) la fila queda con cama_app_ts = now(). La hoja tarda en enterarse y sigue mostrando
 * al mismo exp en la cama VIEJA: antes el caso (c) lo devolvía ahí en ≤ 5 min y, si la fila ya no
 * estaba en esa cama, el upsert on_conflict=cama lo recreaba en la cama vieja (duplicado).
 * Regla: la cama de la app se RESPETA hasta que la HOJA la cambie. Para una fila r con cama_app_ts
 * cuyo exp aparece en la hoja en OTRA cama (sheetNow):
 *   · cama_hoja_prev null       → 1ª vez que vemos la divergencia: se anota PATCH {cama_hoja_prev: sheetNow}
 *                                 (sin tocar la cama) y la app gana.
 *   · cama_hoja_prev === sheetNow → la hoja no ha cambiado desde el movimiento → la app sigue ganando.
 *   · cama_hoja_prev !== sheetNow → alguien editó la hoja DESPUÉS → la hoja manda: el caso (c) la mueve
 *                                 y deja la marca de resuelto (movePatients_ → camaResolvedCols_).
 *   · la hoja ya coincide con la app → marca de resuelto (bucle principal, "sigue igual").
 *   · cama_app_ts ya cubierto por la marca 'ok@…' (reenvío de una copia vieja de la app) → no cuenta.
 * Mientras la app gana: (1) la fila de la hoja con ese exp (cama vieja) sale del payload y de los
 * mapas (si no, el upsert lo duplicaría en la cama vieja; un duplicado viejo del sheet-sync en esa
 * cama pasa a "fuera de la hoja" y se retira con la gracia normal); (2) si la hoja pone a OTRO exp
 * en la cama que la app fijó, esa fila de la hoja NO se upsertea (pisaría la fila fijada y su nota
 * quedaría bajo otro nombre) ni se mueve a nadie ahí (chocaría con UNIQUE(cama)). Si en la cama
 * vieja la hoja ya puso a otra persona, esa fila sí entra al upsert (reasignación normal).
 * Devuelve { pinnedIds, pinnedCamas, dropCamas (fuera de mapas y upsert), holdCamas (solo fuera del
 * upsert), toPin [{row, prev}], kept [texto para log] }.
 */
function appBedDecisions_(cur, maps) {
  var out = { pinnedIds: {}, pinnedCamas: {}, dropCamas: {}, holdCamas: {}, toPin: [], kept: [] };
  cur.forEach(function (r) {
    if (!camaAppActive_(r)) return;
    var cama = normalizeCama_(r.cama), exp = String(r.exp || '').trim();
    if (!exp) return;
    var sheetNow = sheetCamaFor_(maps, exp, r);
    if (sheetNow === undefined || sheetNow === cama) return;   // no está en la hoja / ya coincide (se resuelve en el bucle)
    var prev = camaHojaPrev_(r);
    if (prev !== null && prev !== sheetNow) return;            // la hoja cambió después del movimiento → manda la hoja (caso c)
    out.pinnedIds[r.id] = true;
    out.pinnedCamas[cama] = true;
    out.dropCamas[sheetNow] = true;                            // la fila de la hoja con este exp (cama vieja) no cuenta
    if (prev === null) out.toPin.push({ row: r, prev: sheetNow });
    else out.kept.push(cama + ' (la hoja aún dice ' + sheetNow + ')');
    // otra persona (otro exp, o el mismo exp repetido con otro nombre) en la cama fijada → no pisar
    if (maps.byCama[cama] !== undefined && !sameOccupant_(maps, r, cama, exp)) out.holdCamas[cama] = true;
  });
  return out;
}

function syncPatients_(key, payload) {
  if (!payload.length) { Logger.log('syncPatients: payload vacío → no se toca nada.'); return 0; }
  var maps = sheetMaps_(payload);
  var nSheet = Object.keys(maps.byCama).length;   // tamaño REAL de la hoja (antes de excluir nada) para la guarda

  // Estado actual en Supabase
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/patients?select=id,cama,exp,nombre,updated_by,cama_app_ts,cama_hoja_prev,edad,ingreso', {
    method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true
  });
  // Sin el estado actual NO se upsertea a ciegas: con camas fijadas desde la app (caso e) la fila de la
  // hoja en la cama vieja caería sobre OTRO paciente que la app puso ahí (intercambio, cama liberada) y su
  // nota quedaría bajo otro nombre, o duplicaría al paciente. Mejor una corrida perdida (≤ 5 min) que dato ajeno.
  if (res.getResponseCode() !== 200) { Logger.log('syncPatients: GET HTTP ' + res.getResponseCode() + ' → NO se sincroniza esta corrida (sin estado actual un upsert por cama podía pisar camas fijadas desde la app)'); return 0; }
  var cur = JSON.parse(res.getContentText() || '[]');
  // Expedientes ambiguos vistos desde Supabase (ver expAmbiguous_) y sus filas, para decidir por nombre.
  var curAmbig = ambiguousExps_(cur), curByExp = {}, ties = {}, appHold = {}, appMove = {};
  cur.forEach(function (r) { var e = String(r.exp || '').trim(); if (e) (curByExp[e] = curByExp[e] || []).push(r); });
  maps.ambig = curAmbig; maps.curByExp = curByExp; maps.tie = ties; maps.appHold = appHold; maps.appMove = appMove;

  // (e) Camas fijadas desde la app: decidir ANTES de reconciliar y quitar del payload/mapas las
  //     filas de la hoja que la app gana (así ni el caso (c) ni el upsert las devuelven a la cama vieja).
  var ab = appBedDecisions_(cur, maps);
  var dropped = Object.keys(ab.dropCamas);
  if (dropped.length) {
    payload = payload.filter(function (p) { return !ab.dropCamas[p.cama]; });
    maps = sheetMaps_(payload);
    maps.ambig = curAmbig; maps.curByExp = curByExp; maps.tie = ties; maps.appHold = appHold; maps.appMove = appMove;
    Logger.log('syncPatients: ' + dropped.length + ' fila(s) de la hoja ignoradas por cama fijada desde la app (cama vieja): ' + dropped.join(', '));
  }
  var held = Object.keys(ab.holdCamas);
  if (held.length) Logger.log('syncPatients: ' + held.length + ' cama(s) fijada(s) desde la app con OTRO exp en la hoja → no se upsertean hasta que la hoja se aclare: ' + held.join(', '));
  // Lo que puede ir al upsert sin pisar una cama fijada (se aplica también en las rutas de guarda).
  var safePayload = held.length ? payload.filter(function (p) { return !ab.holdCamas[p.cama]; }) : payload;
  var sheetByCama = maps.byCama, sheetRowByCama = maps.rowByCama;

  // Camas que se quedan tal cual (misma persona en la misma cama): nadie puede moverse ahí.
  var stayCamas = {};
  cur.forEach(function (r) {
    var cama = normalizeCama_(r.cama);
    if (sameOccupant_(maps, r, cama, String(r.exp || '').trim())) stayCamas[cama] = true;
  });

  var toDelete = [], toMove = [], toFixExp = [], toClear = [], enConflicto = [], enEmpate = [], moveTargets = {}, holdLoop = {}, appMoveHold = {};
  var missing = readMissingSince_(), missingNext = {}, now = Date.now(), enGracia = [];
  cur.forEach(function (r) {
    if (ab.pinnedIds[r.id]) return;   // (e) cama fijada desde la app: ni se mueve ni se retira
    var cama = normalizeCama_(r.cama);
    var exp = String(r.exp || '').trim();
    var sheetExp = sheetByCama[cama];
    if (sameOccupant_(maps, r, cama, exp)) {                  // sigue igual
      // (e) la hoja ya alcanzó a la app → movimiento resuelto (marca ok@ para que un reenvío viejo no lo re-arme)
      var cc = camaResolvedCols_(r);
      if (Object.keys(cc).length) toClear.push({ row: r, cols: cc });
      return;
    }
    // (c) CAMBIO DE CAMA — la MISMA persona (mismo exp) sigue en la hoja pero en OTRA cama →
    //     se MUEVE la fila (PATCH de cama), no se borra. Antes esto caía en "retiro" + fila
    //     nueva por el upsert: la nota clínica (FK ON DELETE CASCADE) se perdía en cada cambio
    //     de cama. Si la cama destino ya la ocupa una fila que se queda (duplicado) o ya la
    //     reclamó otra fila que se mueve, esta fila es un duplicado → se retira (archivada).
    var newCama = exp ? sheetCamaFor_(maps, exp, r) : undefined;
    if (newCama !== undefined && newCama !== cama && !stayCamas[newCama] && !moveTargets[newCama] && !ab.pinnedCamas[newCama]) {
      // appMove (ver sheetCamaFor_): fila escrita desde la app que la hoja movió aún como no identificado → se mueve
      // conservando su nombre: el PATCH no toca updated_by y la cama nueva no se upsertea esta corrida.
      var keepBy = !!appMove[r.id];
      toMove.push({ row: r, from: cama, to: newCama, keepBy: keepBy });
      moveTargets[newCama] = true;
      if (keepBy) appMoveHold[newCama] = true;   // se vuelca a holdLoop tras el bucle (si el movimiento sobrevive)
      return;
    }
    if (newCama !== undefined && newCama !== cama && ab.pinnedCamas[newCama]) {
      // (e) la hoja lo pone en una cama que la app fijó para OTRO paciente: no se mueve (UNIQUE) ni
      //     se retira; se deja donde está hasta que la hoja o la app se aclaren. Si en SU cama actual la hoja
      //     ya puso a otra persona, esa fila tampoco se upsertea: on_conflict=cama reescribiría ESTA fila
      //     (con su nota) con el nombre/exp del otro → fuga clínica.
      enConflicto.push(cama + '→' + newCama);
      if (sheetExp !== undefined) holdLoop[cama] = true;
      return;
    }
    // EMPATE (ver uniqueExpMatch_): no identificado cuya cama ahora tiene a OTRO no identificado con otro exp y cuyo exp
    // aparece en otra cama con nombre. Ni se mueve, ni se le corrige el exp, ni se archiva: las dos camas quedan fuera
    // del upsert hasta que la hoja lo aclare (identificar a alguno o corregir el exp) y se avisa en sync_log.
    if (ties[r.id]) {
      holdLoop[cama] = true; holdLoop[ties[r.id]] = true;
      enEmpate.push({ exp: exp, camas: cama + ', ' + ties[r.id], nombres: (r.nombre || '') + ' | ' + ((sheetRowByCama[cama] || {}).nombre || '') + ' | ' + ((sheetRowByCama[ties[r.id]] || {}).nombre || ''), motivo: 'no_identificado_ambiguo' });
      return;
    }
    // Fila escrita desde la APP con otro nombre en la hoja (ver sameOccupant_ y sheetCamaFor_): ni se renombra ni se
    // archiva; su cama (si la hoja puso a alguien ahí) y la cama donde la hoja tiene su exp quedan fuera del upsert y se
    // avisa hasta que la hoja coincida con la app o cambie el exp (cama reasignada normal). La fila se marca una vez
    // (cama_hoja_prev = ok@hold, marca ya resuelta para el caso e) como paciente del censo: así, si la hoja lo da de
    // alta mientras espera, el retiro con gracia (b) sí lo alcanza (el upsert, que ponía sheet-sync, ya no la toca).
    var sr = sheetRowByCama[cama];
    // (d) EXPEDIENTE CORREGIDO — misma cama, MISMA persona (nombre igual), otro exp en la hoja (typo corregido): PATCH
    //     del exp sobre la misma fila; la nota sigue ligada. Con el MISMO exp no aplica (ya decidió sameOccupant_: es
    //     otra persona), ni si el nombre de la hoja es de un no identificado para alguien con nombre (HIJO DE MARIA
    //     LOPEZ en la cama de MARIA LOPEZ).
    var dFix = !!(sheetExp !== undefined && sr && sheetExp && sheetExp !== exp && samePerson_(r.nombre || '', sr.nombre || '') && namesCompatible_(r, sr) && String(r.nombre || '').trim() && String(sr.nombre || '').trim());
    var holdApp = appHold[r.id] ? appHold[r.id]
      // Fila escrita desde la app con otro exp en su cama y un nombre que no prueba otro ingreso: la fila de la hoja
      // sigue como no identificado (el residente ya lo identificó en la app) o trae un nombre compatible pero no igual
      // (inicial, error de dedo, apodo: a (d) no le basta). Espera en vez de archivarse; se libera cuando la hoja
      // escribe el nombre: igual → corrección de exp (d); otro → cama reasignada.
      : (!dFix && sheetExp !== undefined && sr && appWritten_(r) && !namePlaceholder_(nameWords_(r.nombre || ''))
         && (namePlaceholder_(nameWords_(sr.nombre || '')) || namesCompatible_(r, sr))) ? cama : null;
    if (holdApp) {
      if (sheetExp !== undefined) holdLoop[cama] = true;
      holdLoop[holdApp] = true;
      if (holdApp === cama && r.cama_app_ts != null) {
        // (e) la hoja ya alcanzó la cama que fijó la app (aunque el nombre aún no coincida): el movimiento queda
        // resuelto (marca ok@…, que también sirve de marca de censo); si no, un movimiento posterior de la hoja se
        // tomaba como "primera divergencia" y la app ganaba para siempre.
        var ccH = camaResolvedCols_(r);
        if (Object.keys(ccH).length) toClear.push({ row: r, cols: ccH });
      } else if (r.cama_hoja_prev == null && r.cama_app_ts == null) {
        toClear.push({ row: r, cols: { cama_hoja_prev: CAMA_OK_PREFIX + 'hold' } });
      }
      var camasHold = holdApp === cama ? cama : cama + ', ' + holdApp;
      enEmpate.push({ exp: exp, camas: camasHold, nombres: (r.nombre || '') + ' (app) | ' + ((sheetRowByCama[holdApp] || {}).nombre || '') + ' (hoja)', motivo: 'nombre_app_vs_hoja' });
      return;
    }
    if (sheetExp !== undefined) {
      if (dFix) {
        toFixExp.push({ row: r, from: exp, to: sheetExp });
        return;
      }
      toDelete.push({ row: r, motivo: 'CAMA REASIGNADA (hoja)' });        // (a) reasignación: otra persona ocupa la cama
    } else if (r.updated_by === 'sheet-sync' || r.cama_hoja_prev != null) {
      // (b) retiro: solo si lleva >= RETIRO_GRACIA_MIN min sin aparecer en la hoja (ver arriba).
      //     cama_hoja_prev solo lo escribe este script: tras ver el exp en la hoja (caso e) o como marca ok@hold mientras
      //     la fila espera por su nombre → es paciente del censo aunque la app lo haya editado (updated_by =
      //     residente): sin esto, un paciente movido en la app y dado de
      //     alta en la hoja antes de que la hoja actualizara su cama quedaba como FANTASMA para siempre.
      var since = missing[r.id] || now;
      missingNext[r.id] = since;
      if (now - since >= RETIRO_GRACIA_MIN * 60000) toDelete.push({ row: r, motivo: 'RETIRADO DEL CENSO (hoja)' });
      else enGracia.push(cama + ' (' + Math.round((now - since) / 60000) + ' min)');
    }
  });
  // Dos filas reclaman la MISMA fila de la hoja: una se movería a esa cama (r, su exp está ahí) y la que ya ocupa esa
  // cama en Supabase con otro exp (q, no identificado) la tomaría como "exp corregido" (d). Sin esto el PATCH de cama
  // chocaba con UNIQUE(cama), q se quedaba con el exp de r y r era un fantasma sin aviso. Decide la fecha de ingreso
  // (la hoja la copia con el paciente): la de r → q es cama reasignada y r se mueve; la de q → q corrige su exp y r
  // (que ya no está en la hoja) se retira con gracia o, si su cama ya tiene a otro, como reasignada; sin fecha que lo
  // aclare, las dos camas esperan y se avisa.
  toFixExp = toFixExp.filter(function (f) {
    var c = normalizeCama_(f.row.cama);
    var mv = toMove.filter(function (m) { return m.to === c; });
    if (!mv.length) return true;
    var srC = sheetRowByCama[c] || {}, ingS = String(srC.ingreso || '').trim(), ingQ = String(f.row.ingreso || '').trim();
    var m = mv[0], ingR = String(m.row.ingreso || '').trim(), from = normalizeCama_(m.row.cama);
    if (ingS && ingS === ingR && ingS !== ingQ) {
      toDelete.push({ row: f.row, motivo: 'CAMA REASIGNADA (hoja)' });
      return false;
    }
    toMove = toMove.filter(function (x) { return x !== m; }); delete moveTargets[c];
    if (ingS && ingS === ingQ && ingS !== ingR) {
      if (sheetByCama[from] !== undefined) toDelete.push({ row: m.row, motivo: 'CAMA REASIGNADA (hoja)' });
      else {
        var sinceM = missing[m.row.id] || now;
        missingNext[m.row.id] = sinceM;
        if (now - sinceM >= RETIRO_GRACIA_MIN * 60000) toDelete.push({ row: m.row, motivo: 'RETIRADO DEL CENSO (hoja)' });
        else {
          enGracia.push(from + ' (' + Math.round((now - sinceM) / 60000) + ' min)');
          // marca de censo: en la siguiente corrida el exp ya es ambiguo y (b) solo alcanza filas marcadas
          if (m.row.cama_hoja_prev == null && m.row.cama_app_ts == null) toClear.push({ row: m.row, cols: { cama_hoja_prev: CAMA_OK_PREFIX + 'hold' } });
        }
      }
      return true;
    }
    holdLoop[c] = true; if (sheetByCama[from] !== undefined) holdLoop[from] = true;
    enEmpate.push({ exp: String(m.row.exp || '').trim(), camas: from + ', ' + c, nombres: (m.row.nombre || '') + ' | ' + (f.row.nombre || '') + ' | ' + (srC.nombre || '') + ' (hoja)', motivo: 'cama_en_disputa' });
    return false;
  });
  // Un movimiento hacia una cama que otra fila dejó en espera (p. ej. la escribió la app y la hoja ya trae otro exp ahí)
  // chocaría con UNIQUE(cama) en cada corrida y, al fallar, dejaba fuera del upsert la cama de origen para siempre, sin
  // aviso: mejor no intentarlo; las dos camas esperan y se avisa hasta que la hoja aclare la cama destino.
  toMove = toMove.filter(function (m) {
    if (!holdLoop[m.to]) return true;
    var from = normalizeCama_(m.row.cama);
    delete moveTargets[m.to];
    if (sheetByCama[from] !== undefined) holdLoop[from] = true;
    enEmpate.push({ exp: String(m.row.exp || '').trim(), camas: from + ', ' + m.to, nombres: (m.row.nombre || '') + ' | ' + ((sheetRowByCama[m.to] || {}).nombre || '') + ' (hoja)', motivo: 'cama_en_disputa' });
    return false;
  });
  toMove.forEach(function (m) { if (m.keepBy) holdLoop[m.to] = true; });
  writeMissingSince_(missingNext);   // los que volvieron a la hoja salen del mapa
  if (enGracia.length) Logger.log('syncPatients: ' + enGracia.length + ' fuera de la hoja en periodo de gracia (' + RETIRO_GRACIA_MIN + ' min): ' + enGracia.join(', '));
  if (enConflicto.length) Logger.log('syncPatients: ' + enConflicto.length + ' movimiento(s) de la hoja hacia una cama fijada desde la app, en espera: ' + enConflicto.join(', '));
  if (enEmpate.length) {
    Logger.log('syncPatients: ' + enEmpate.length + ' cama(s) en espera por nombre: ' + enEmpate.map(function (e) { return e.camas + ' [' + e.motivo + ']'; }).join(' / '));
    try { logQuarantine_(key, enEmpate); } catch (_) {}
  }
  var heldLoop = Object.keys(holdLoop);
  if (heldLoop.length) {
    safePayload = safePayload.filter(function (p) { return !holdLoop[p.cama]; });
    Logger.log('syncPatients: ' + heldLoop.length + ' cama(s) en espera (cama fijada desde la app, empate o nombre distinto en la app) → no se upsertean (pisarían su fila): ' + heldLoop.join(', '));
  }

  // GUARDAS anti-catástrofe (los movimientos no borran nada, pero tampoco se aplican con una
  // hoja sospechosa: la cama destino podría ser basura). Con hoja sospechosa tampoco se anota
  // cama_hoja_prev (podría ser basura y haría "ganar" a la hoja en la siguiente corrida buena).
  if (nSheet < 10) { Logger.log('syncPatients: solo ' + nSheet + ' en la hoja (posible error) → solo upsert, sin borrar.'); upsertPatients_(key, safePayload); return 0; }
  if (toDelete.length > Math.max(10, Math.floor(cur.length * 0.5))) {
    Logger.log('syncPatients: ' + toDelete.length + ' a borrar (>50%) → ABORTA reconciliación, solo upsert.');
    upsertPatients_(key, safePayload); return 0;
  }

  // 1) Retiros/reasignaciones: ARCHIVAR (paciente + nota → public.archive, la papelera de la app)
  //    y solo entonces borrar. Si el archivo falla, la fila NO se borra (reintenta en 5 min).
  var retired = 0;
  var skipCamas = {};   // camas cuyo ocupante anterior NO pudo archivarse: no tocar esa fila todavía
  toDelete.forEach(function (d) {
    if (archiveAndDeletePatient_(key, d.row, d.motivo)) retired++;
    else skipCamas[d.row.cama] = true;
  });
  if (toDelete.length) Logger.log('syncPatients: retirados ' + retired + '/' + toDelete.length + ' (reasignación/egreso): ' + toDelete.map(function (d) { return d.row.cama; }).join(', '));

  // 2) Cambios de cama: PATCH de la cama sobre la MISMA fila (id estable → la nota sigue ligada).
  //    Intercambios A↔B chocarían con UNIQUE(cama); esos pasan primero por una cama temporal.
  var mv = movePatients_(key, toMove);
  if (toMove.length) Logger.log('syncPatients: movidos ' + mv.ok + '/' + toMove.length + ': ' + toMove.map(function (m) { return m.from + '→' + m.to; }).join(', '));
  // Un movimiento que no llegó a su cama (PATCH fallido, choque con UNIQUE): su cama de origen y la de
  // destino quedan fuera del upsert esta corrida. Si no, la fila que no se movió recibía el nombre del
  // siguiente ocupante de su cama (con su nota) y en la de destino se creaba una copia vacía.
  mv.failed.forEach(function (m) { skipCamas[m.from] = true; skipCamas[m.to] = true; });
  // 2b) Expediente corregido (misma persona, misma cama): PATCH del exp antes del upsert.
  var fixed = 0;
  toFixExp.forEach(function (f) { if (patchPatient_(key, f.row.id, { exp: f.to, updated_by: 'sheet-sync' })) fixed++; });
  if (toFixExp.length) Logger.log('syncPatients: expedientes corregidos ' + fixed + '/' + toFixExp.length + ': ' + toFixExp.map(function (f) { return normalizeCama_(f.row.cama) + ' ' + f.from + '→' + f.to; }).join(', '));
  // 2c) (e) Camas fijadas desde la app: anotar la cama que hoy dice la hoja (1ª divergencia) y
  //     limpiar las columnas de control cuando la hoja ya coincide con la app.
  var pinnedOk = 0;
  ab.toPin.forEach(function (p) { if (patchPatient_(key, p.row.id, { cama_hoja_prev: p.prev })) pinnedOk++; });
  if (ab.toPin.length) Logger.log('syncPatients: cama fijada desde la app (1ª vez) ' + pinnedOk + '/' + ab.toPin.length + ': ' + ab.toPin.map(function (p) { return normalizeCama_(p.row.cama) + ' (la hoja dice ' + p.prev + ')'; }).join(', '));
  if (ab.kept.length) Logger.log('syncPatients: ' + ab.kept.length + ' cama(s) fijada(s) desde la app, la hoja no ha cambiado: ' + ab.kept.join(', '));
  var cleared = 0;
  toClear.forEach(function (c) { if (patchPatient_(key, c.row.id, c.cols)) cleared++; });
  if (toClear.length) Logger.log('syncPatients: la hoja ya coincide con la app en ' + cleared + '/' + toClear.length + ' cama(s), movimiento resuelto: ' + toClear.map(function (c) { return normalizeCama_(c.row.cama); }).join(', '));

  // Si el archivo del ocupante anterior falló, su fila sigue viva: el upsert por cama (on_conflict=cama)
  // la REESCRIBIRÍA con el exp/nombre del nuevo ocupante y su nota clínica quedaría pegada al paciente
  // equivocado (y nunca se archivaría). Esa cama se deja fuera y se reintenta en 5 min.
  var finalPayload = safePayload.filter(function (p) { return !skipCamas[p.cama]; });
  if (finalPayload.length !== safePayload.length) {
    Logger.log('syncPatients: ' + (safePayload.length - finalPayload.length) + ' cama(s) sin archivar aún, se reintentan en la próxima corrida: ' + Object.keys(skipCamas).join(', '));
  }
  upsertPatients_(key, finalPayload);   // ahora sin filas conflictivas → reasignados entran limpios
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
  var failed = [];
  if (!toMove.length) return { ok: 0, failed: failed };
  var fromCamas = {};
  toMove.forEach(function (m) { fromCamas[m.from] = true; });
  var ok = 0;
  var viaTemp = toMove.filter(function (m) { return fromCamas[m.to]; });
  viaTemp.forEach(function (m) { patchPatient_(key, m.row.id, { cama: '#MV-' + String(m.row.id).slice(0, 8) }); });
  toMove.forEach(function (m) {
    // keepBy (appMove): la fila la escribió la app y la hoja aún no tiene su nombre → updated_by se conserva para que
    // en la cama nueva siga esperando (sameOccupant_) en vez de que el upsert la renombre.
    var cols = m.keepBy ? { cama: m.to } : { cama: m.to, updated_by: 'sheet-sync' };
    // (e) la hoja cambió DESPUÉS de un movimiento hecho desde la app (o la app reenvió una cama vieja con una
    //     marca ya resuelta) → manda la hoja y el movimiento de la app queda resuelto (marca ok@).
    var cc = camaResolvedCols_(m.row);
    Object.keys(cc).forEach(function (k) { cols[k] = cc[k]; });
    if (patchPatient_(key, m.row.id, cols)) ok++; else failed.push(m);
  });
  return { ok: ok, failed: failed };
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

// --- INDICACIONES (Google Doc -> Supabase) ------------------------------------------------------
// Cada 5 min: si el Doc cambió desde la última vez (fecha de modificación de Drive), lee TODO su
// texto y lo sube a public.indicaciones_doc (fila única id=1). La app parsea los bloques
// ("INDICACIONES MÉDICAS DE …", cama, DIETA/SOLUCIONES/MEDICAMENTOS/ANTIBIÓTICOS/MEDIDAS) y los
// cruza por cama + nombre; Realtime avisa a las tarjetas abiertas. Nunca toca patients ni notes.
function syncIndicaciones(force) {
  var key = PropertiesService.getScriptProperties().getProperty('SUPABASE_KEY');
  if (!key) { Logger.log('FALTA Script Property SUPABASE_KEY'); return { ok: false, reason: 'no_key' }; }
  var props = PropertiesService.getScriptProperties();
  var file = DriveApp.getFileById(INDICACIONES_DOC_ID);
  var updated = file.getLastUpdated();
  var updatedIso = updated && updated.toISOString ? updated.toISOString() : String(updated);
  var last = props.getProperty('IND_LAST_UPDATED');
  if (!force && last && last === updatedIso) { Logger.log('indicaciones: sin cambios desde ' + last); return { ok: true, skipped: true, docUpdated: updatedIso }; }

  var text = DocumentApp.openById(INDICACIONES_DOC_ID).getBody().getText() || '';
  var hash = indHash_(text);
  var row = { id: 1, doc_id: INDICACIONES_DOC_ID, text: text, text_hash: hash, doc_updated: updatedIso, synced_at: new Date().toISOString() };
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/indicaciones_doc?on_conflict=id', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify(row), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) { Logger.log('indicaciones: UPSERT HTTP ' + code + ' ' + res.getContentText()); return { ok: false, reason: 'http_' + code }; }
  props.setProperty('IND_LAST_UPDATED', updatedIso);
  var bloques = (text.match(/INDICACIONES\s+(DE\s+|M[EÉ]DICAS)/gi) || []).length;
  Logger.log('indicaciones: subidas ' + text.length + ' letras, ~' + bloques + ' bloques (Doc editado ' + updatedIso + ')');
  return { ok: true, chars: text.length, bloques: bloques, docUpdated: updatedIso, hash: hash };
}
function syncIndicacionesScheduled() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { syncIndicaciones(false); } finally { lock.releaseLock(); }
}
/** Fuerza la subida aunque el Doc no haya cambiado (útil tras instalar). */
function syncIndicacionesForce() { return syncIndicaciones(true); }
/** Diagnóstico sin escribir nada: cuántos bloques y camas detecta en el Doc. */
function testIndicacionesOnly() {
  var text = DocumentApp.openById(INDICACIONES_DOC_ID).getBody().getText() || '';
  var bloques = (text.match(/INDICACIONES\s+(DE\s+|M[EÉ]DICAS)/gi) || []).length;
  var camas = (text.match(/CAMA\s*[:#\-]?\s*\d+-\d{2,4}/gi) || []).length;
  Logger.log('Doc: ' + text.length + ' letras · ~' + bloques + ' bloques de indicaciones · ' + camas + ' menciones de cama');
  return { chars: text.length, bloques: bloques, camas: camas };
}
function indHash_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < bytes.length; i++) { var b = (bytes[i] + 256) % 256; out += (b < 16 ? '0' : '') + b.toString(16); }
  return out;
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

function sectionExcludedAlways_(section) {
  var s = norm_(section);
  for (var i = 0; i < EXCLUDE_ALWAYS_RE.length; i++) { if (EXCLUDE_ALWAYS_RE[i].test(s)) return true; }
  return false;
}
function sectionOtherWard_(section) {
  var s = norm_(section);
  for (var i = 0; i < OTHER_WARD_RE.length; i++) { if (OTHER_WARD_RE[i].test(s)) return true; }
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
  ScriptApp.newTrigger('syncIndicacionesScheduled').timeBased().everyMinutes(5).create();
  Logger.log('Triggers creados: onEdit (instalable) + sync cada 5 min + watchdog de labs cada 4 h + indicaciones (Doc) cada 5 min.');
  // Primera subida del Doc de indicaciones ahora mismo (si falla, el trigger reintenta en 5 min).
  try { syncIndicaciones(true); } catch (e) { Logger.log('indicaciones: primera subida falló: ' + e); }
}

/** Diagnostico sin escribir nada: cuantos pacientes parsea y que expedientes repetidos hay. */
function testParseOnly() {
  var rows = readCensoRows_();
  var parsed = parseCenso_(rows);
  var res = dedupAndQuarantine_(parsed);
  Logger.log('Parseados: ' + parsed.length + ' | A sincronizar: ' + res.keep.length + ' | Avisos de expediente repetido: ' + res.avisos.length);
  Logger.log('Avisos: ' + JSON.stringify(res.avisos, null, 2));
  return res;
}
