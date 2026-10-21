/**
 * Registro de pacientes para investigación (21 oct 2026): Supabase → Google Sheets, en la cuenta de Google del dueño.
 *
 * Una vez al día copia a una hoja de cálculo privada TODO lo que la app y los robots tienen de cada paciente: el censo
 * (patients + notes), los egresados de la Papelera (archive), el respaldo de la cronología, los labs y cultivos de
 * WinLab, los estudios de RIS y los procedimientos programados. NUNCA borra: lo que ya no está en la base se conserva
 * (en las pestañas de la tarjeta, marcado «Vigente: No»), y cada semana guarda una copia de la hoja en la misma carpeta.
 *
 * PRIVACIDAD: la hoja tiene nombres y expedientes (datos de salud identificables). Debe quedarse en la carpeta privada.
 * El script solo LEE Supabase (GET) y en el registro de ejecuciones solo escribe conteos.
 *
 * INSTALACIÓN (ver apps-script/REGISTRO.md). Recomendado: PROYECTO APARTE (script.google.com → Nuevo proyecto), así quien
 * edite la hoja no puede ver la llave de Supabase:
 *   1) Pegar este archivo y guardar.
 *   2) Propiedades del script: SUPABASE_KEY = <service_role key>; REGISTRO_SHEET_ID = <id de la hoja del registro>.
 *   3) Ejecutar instalarRegistroDiario (autorizar): crea la actualización diaria y hace la primera corrida.
 * (Ligado a la hoja también funciona sin REGISTRO_SHEET_ID y agrega el menú «Registro → Actualizar ahora».)
 */
var SUPABASE_URL = 'https://vkxplmrzyqlamxpbtmes.supabase.co';
var REG_HORA = 23;                 // la actualización diaria corre entre las 23:00 y las 24:00 (zona del proyecto)
var REG_MAX_CELDA = 45000;         // Sheets admite 50 000 caracteres por celda
var REG_MAX_LECTURA_MS = 270000;   // 4.5 min leyendo como máximo (la ejecución tiene 6): si no, no se escribe nada
var REG_MARGEN_INCREMENTAL_MS = 2 * 86400000;   // lo incremental se vuelve a leer desde 2 días antes de lo último leído
// Lecturas por cursor (fecha de la fila): cuántas filas como máximo por corrida. Si quedan, la corrida escribe lo leído y
// programa una continuación en 10 min (la primera carga de una Papelera grande termina en varias vueltas).
var REG_CURSORES = {
  archive: { col: 'archived_at', tope: 400 },
  winlab_labs: { col: 'scraped_at', tope: 5000 },
  ris_estudios: { col: 'scraped_at', tope: 3000 }
};
var REG_CELDAS_MAX = 10000000, REG_CELDAS_AVISO = 0.7;
var REG_RESPALDO_CADA_MS = 7 * 86400000, REG_RESPALDOS = 5;
var REG_SEP = '␟';

// Pestañas: columnas (orden de la hoja), clave de cada fila, grupo (episodio/id) y modo de fusión:
//   'pacientes' una fila por episodio; si deja de estar en la base se conserva («Salió de la base…» si seguía hospitalizado)
//   'vigente'   lo que la tarjeta trae hoy (Vigente: Sí); lo que ya no trae se conserva con Vigente: No
//   'acumula'   historial que la app recorta (signos 14 días, notas de evolución 10) o lecturas incrementales: se agrega y
//               se actualiza por clave, nunca se marca ni se quita
var REG_PESTANAS = [
  { nombre: 'Pacientes', modo: 'pacientes', clave: ['ID episodio'], columnas: ['ID episodio', 'Estado en registro', 'Motivo de egreso', 'Episodio relacionado',
    'Nombre', 'Expediente', 'Edad', 'Sexo', 'Especialidad', 'Sección', 'Adscrito', 'Residente', 'Cama', 'Fecha de ingreso', 'Fecha de egreso',
    'Días de estancia', 'Diagnóstico', 'Estado clínico', 'Antecedentes (APP)', 'Padecimiento (PA)', 'Manejo', 'Pendientes',
    'Drenajes y dispositivos', 'Antibiótico', 'Cultivos', 'Interconsultas', 'Dieta y NPO', 'TVP', 'NPT', 'Ventilación',
    'Vasopresores', 'Cirugías (resumen)', 'Imagen (resumen)', 'Labs (fechas)', 'Guardia vigente', 'Cronología', 'Misceláneo',
    'Nota completa (JSON)', 'Checklist completo (JSON)', 'Alta en la app', 'Última modificación en la app', 'Fuente', 'Última vez en la base'] },
  { nombre: 'Cirugías', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Procedimiento'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Procedimiento', 'Hallazgos', 'Sangrado', 'Cirujano', 'Vigente'] },
  { nombre: 'Labs', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Estudio'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Estudio', 'Valor', 'Origen', 'Vigente'] },
  { nombre: 'Imagen', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Tipo', 'Descripción'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Tipo', 'Descripción', 'Enlace', 'Vigente'] },
  { nombre: 'Signos vitales', modo: 'acumula', clave: ['ID episodio', 'Fecha'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'FC', 'FR', 'Temp', 'SaO2', 'O2 L/min', 'TA', 'Uresis', 'DxTx', 'IU', 'Balance'] },
  { nombre: 'Notas de evolución', modo: 'acumula', clave: ['ID episodio', 'Fecha y hora'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha y hora', 'Autor', 'Con IA', 'Texto'] },
  { nombre: 'Guardia y cronología', modo: 'vigente', clave: ['ID episodio', 'Caja', 'Renglón'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Caja', 'Orden', 'Renglón', 'Vigente'] },
  { nombre: 'Procedimientos programados', modo: 'acumula', clave: ['ID'], columnas: ['ID', 'Fecha', 'Cama', 'Expediente', 'Nombre', 'Edad', 'Diagnóstico', 'Especialidad', 'Adscrito', 'Residente', 'Agregado por'] },
  { nombre: 'Labs del robot (WinLab)', modo: 'acumula', clave: ['Expediente', 'Paciente', 'Fecha', 'Estudio'], columnas: ['Expediente', 'Paciente', 'Fecha', 'Estudio', 'Valor', 'Capturado'] },
  { nombre: 'Cultivos del robot (WinLab)', modo: 'acumula', clave: ['Expediente', 'Fecha', 'Tipo', 'Germen', 'Resultado'], columnas: ['Expediente', 'Nombre', 'Cama', 'Fecha', 'Tipo', 'Germen', 'Resultado', 'Texto'] },
  { nombre: 'Imagen del robot (RIS)', modo: 'acumula', clave: ['ID'], columnas: ['ID', 'ID episodio', 'Expediente', 'Paciente', 'Fecha', 'Hora', 'Modalidad', 'Estudios', 'Crítico', 'Estado del reporte', 'Reporte', 'Enlace del reporte', 'Capturado'] }
];

// ─── Menú, instalación y corrida diaria ──────────────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Registro')
    .addItem('Actualizar ahora', 'actualizarRegistro')
    .addItem('Instalar actualización diaria', 'instalarRegistroDiario')
    .addToUi();
}

/** Crea (una sola vez) la actualización diaria y hace la primera corrida. */
function instalarRegistroDiario() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'actualizarRegistro') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('actualizarRegistro').timeBased().everyDays(1).atHour(REG_HORA).create();
  return actualizarRegistro();
}

/** Continuación programada (primera carga en varias vueltas): se borra a sí misma y corre otra vez. */
function continuarRegistro() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarRegistro') ScriptApp.deleteTrigger(t); });
  return actualizarRegistro();
}

/** Lee Supabase y actualiza todas las pestañas sin borrar nada. Si algo falla al leer, la hoja no se toca. */
function actualizarRegistro() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Registro: otra actualización en curso; se omite esta.'); return { ok: false, motivo: 'ocupado' }; }
  try {
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('SUPABASE_KEY');
    if (!key) throw new Error('Falta SUPABASE_KEY en Propiedades del script');
    var inicio = Date.now(), hoy = regHoy_();
    var reloj = function () { if (Date.now() - inicio > REG_MAX_LECTURA_MS) throw new Error('La lectura de Supabase pasó de 4.5 min: no se escribió nada (se reintenta en la siguiente corrida).'); };
    var leer = function (tabla, select, orden, filtro, pagina) { return regLeerTabla_(key, tabla, select, orden, filtro, pagina, reloj).filas; };
    // Por cursor: desde lo último leído (menos 2 días), hasta el tope de filas de la corrida.
    var cursores = {}, pendiente = false;
    var leerCursor = function (tabla, select, pagina) {
      var c = REG_CURSORES[tabla], previo = props.getProperty('REG_CURSOR_' + tabla) || '';
      var desde = previo ? new Date(Date.parse(previo) - REG_MARGEN_INCREMENTAL_MS).toISOString() : '';
      var r = regLeerTabla_(key, tabla, select, c.col + ',id', desde ? c.col + '=gte.' + desde : '', pagina, reloj, c.tope);
      var max = previo;
      r.filas.forEach(function (f) { var v = regTexto(f[c.col]); if (v && (!max || Date.parse(v) > Date.parse(max))) max = v; });
      // Con tope alcanzado, la siguiente vuelta sigue desde la última fila leída (sin margen, para avanzar).
      cursores[tabla] = r.completa ? max : (max ? new Date(Date.parse(max) + REG_MARGEN_INCREMENTAL_MS).toISOString() : previo);
      if (!r.completa) pendiente = true;
      return r.filas;
    };
    var datos = {
      patients: leer('patients', 'id,cama,nombre,exp,dx,edad,esp,seccion,adscrito,residente,ingreso,estado,created_at,updated_at', 'id', '', 200),
      notes: leer('notes', 'patient_id,app,pa,drenajes,qx,manejo,sangrado,sv,balance,pendientes,checklist,lab_history,imagen_history,misc,cronologia,updated_at', 'patient_id', '', 20),
      archive: leerCursor('archive', 'id,patient_data,note_data,archived_at', 10),
      restauraciones: leer('archive', 'id,de:patient_data->>_supa_id,a:note_data->>_restaurado_a', 'id', 'note_data->>_restaurado_a=not.is.null', 1000),
      cronologias: leer('cronologia_respaldo', 'patient_id,exp,nombre,cronologia,actualizado', 'patient_id', '', 200),
      procedimientos: leer('procedimientos_dia', 'id,cama,exp,nombre,edad,dx,esp,adscrito,residente,fecha_dia,added_by', 'id', '', 500),
      winlab: leerCursor('winlab_labs', 'id,exp,paciente,fecha,data,scraped_at', 200),
      cultivos: leer('winlab_cultivos', 'exp,cama,nombre,fecha,tipo,germen,resultado,texto_origen', 'exp,fecha,tipo,germen,resultado', '', 500),
      ris: leerCursor('ris_estudios', 'id,patient_id,exp,paciente,fecha,hora,modalidad,estudios,critico,reporte_estado,reporte,reporte_url,scraped_at', 200)
    };
    var nuevo = regConstruir(datos, hoy);
    var libro = regLibro_(props);
    regRespaldoSemanal_(libro, props, hoy);
    var cuentas = {}, celdas = 0;
    REG_PESTANAS.forEach(function (cfg) {
      var hoja = libro.getSheetByName(cfg.nombre) || libro.insertSheet(cfg.nombre);
      var viejas = regLeerPestana_(hoja, cfg);
      var filas = regFusionar(viejas, nuevo[cfg.nombre] || [], cfg, nuevo.episodiosHoy, hoy, nuevo.relacion);
      regEscribirPestana_(hoja, cfg.columnas, filas);
      cuentas[cfg.nombre] = filas.length;
      celdas += hoja.getMaxRows() * hoja.getMaxColumns();
    });
    var uso = celdas / REG_CELDAS_MAX;
    if (uso > REG_CELDAS_AVISO) Logger.log('AVISO: el registro usa el ' + Math.round(uso * 100) + '% de las celdas que admite Sheets; hay que pasar lo viejo a un libro histórico.');
    regEscribirDiccionario_(libro, hoy, cuentas, celdas, pendiente);
    // Los cursores avanzan solo cuando lo leído ya quedó escrito.
    Object.keys(cursores).forEach(function (t) { if (cursores[t]) props.setProperty('REG_CURSOR_' + t, cursores[t]); });
    props.setProperty('REG_ULTIMA_CORRIDA', new Date(inicio).toISOString());
    if (pendiente) ScriptApp.newTrigger('continuarRegistro').timeBased().after(10 * 60 * 1000).create();
    // Solo conteos en el registro de ejecución: nada de nombres ni expedientes.
    Logger.log('Registro actualizado ' + hoy + ': ' + JSON.stringify(cuentas));
    return { ok: true, cuentas: cuentas, pendiente: pendiente };
  } finally {
    lock.releaseLock();
  }
}

function regLibro_(props) {
  var id = props.getProperty('REGISTRO_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function regHoy_() {
  var tz = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'America/Mexico_City';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

// ─── Lectura de Supabase (solo GET, paginado; la página se achica si una respuesta es demasiado grande) ───────────
/** URL de PostgREST con cada nombre y valor codificado. UrlFetchApp rechaza («Argumento no válido») una URL con
 *  caracteres como > (21 oct 2026: el filtro note_data->>_restaurado_a sin codificar tumbó la primera corrida real).
 *  `filtro`: 'campo=operador.valor' SIN codificar (varios separados por &). */
function regUrl_(tabla, select, orden, filtro, lim, desde) {
  var q = [['select', select]];
  regTexto(filtro).split('&').forEach(function (p) { var i = p.indexOf('='); if (i > 0) q.push([p.slice(0, i), p.slice(i + 1)]); });
  q.push(['order', orden.split(',').map(function (c) { return c + '.asc'; }).join(',')], ['limit', lim], ['offset', desde]);
  return SUPABASE_URL + '/rest/v1/' + tabla + '?' + q.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]); }).join('&');
}
/** Causa de un error de UrlFetchApp para el registro, sin la URL (no trae datos de pacientes ni la llave). */
function regCausa_(e) {
  return regTexto(e && e.message !== undefined ? e.message : e).replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, 160);
}
function regLeerTabla_(key, tabla, select, orden, filtro, pagina, reloj, tope) {
  var out = [], desde = 0;
  for (var vuelta = 0; vuelta < 20000; vuelta++) {
    if (tope && out.length >= tope) return { filas: out, completa: false };
    var lim = tope ? Math.min(pagina, tope - out.length) : pagina;
    var url = regUrl_(tabla, select, orden, filtro, lim, desde);
    var res = null, code = 0, error = null;
    try {
      res = UrlFetchApp.fetch(url, { method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true });
      code = res.getResponseCode();
    } catch (e) { error = e; }
    if (reloj) reloj();
    // Respuesta demasiado grande (filas con archivos incrustados) o corte de red: se reintenta con la mitad de filas.
    // Una URL rechazada no mejora con menos filas: falla de inmediato.
    var causa = error ? regCausa_(error) : '';
    var urlRechazada = /invalid argument|argumento no v[aá]lido|argumento inv[aá]lido/i.test(causa);
    if (((error && !urlRechazada) || code === 413 || code >= 500) && pagina > 1) { pagina = Math.max(1, Math.floor(pagina / 2)); continue; }
    // El cuerpo de un error puede traer datos: al registro y al error solo van la tabla, la posición, la causa sin URL
    // y el código de error de PostgREST (p. ej. 42703), nunca su mensaje.
    if (error) throw new Error('Supabase ' + tabla + ': no se pudo leer (fila ' + desde + '): ' + causa);
    if (code !== 200) {
      var cod = '';
      try { var cuerpo = JSON.parse(res.getContentText() || '{}'); cod = /^[A-Z0-9]{5,8}$/.test(regTexto(cuerpo && cuerpo.code)) ? ' (' + cuerpo.code + ')' : ''; } catch (_) {}
      throw new Error('Supabase ' + tabla + ' HTTP ' + code + cod);
    }
    var filas = JSON.parse(res.getContentText() || '[]');
    if (!Array.isArray(filas)) throw new Error('Supabase ' + tabla + ': respuesta inesperada');
    out = out.concat(filas);
    if (filas.length < lim) return { filas: out, completa: true };
    desde += filas.length;
  }
  throw new Error('Supabase ' + tabla + ': demasiadas páginas');
}

// ─── Construcción (funciones puras: se prueban en apps-script/registro-pacientes.test.js) ─────────────────────────
function regTexto(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Una celda que Sheets volvió fecha (una edición a mano) vuelve a texto 'YYYY-MM-DD'.
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}
function regObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function regArr(v) { return Array.isArray(v) ? v : []; }

/** Fecha a 'YYYY-MM-DD' desde 'YYYY-MM-DD…', 'dd/mm/yyyy' o 'd/m/yy'; '' si no se reconoce. */
function regFecha(v) {
  var s = regTexto(v).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) {
    var y = m[3].length === 2 ? '20' + m[3] : m[3];
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  return '';
}
function regDias(desde, hasta) {
  var a = regFecha(desde), b = regFecha(hasta);
  if (!a || !b) return '';
  var d = Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
  return d >= 0 ? d : '';
}
/** Archivos incrustados (base64, data:): no son texto clínico y no caben en una celda. */
function regEsArchivo(v) {
  var s = regTexto(v);
  return /^data:/i.test(s) || (s.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(s));
}
function regLineas(t) {
  return regTexto(t).split('\n').map(function (x) { return x.replace(/\s+$/, ''); }).filter(function (x) { return x.trim(); });
}
/** Copia JSON sin archivos incrustados ni las listas que ya tienen su pestaña (para las columnas «… completo»). */
function regJsonLimpio(o, quitar) {
  try {
    return JSON.stringify(o, function (k, v) {
      if (quitar && quitar.indexOf(k) !== -1) return undefined;
      if (typeof v === 'string' && regEsArchivo(v)) return '[archivo]';
      return v;
    }) || '';
  } catch (_) { return ''; }
}
function regVacio(v) { return v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length); }
/** Une listas sin repetir: primero las de `a`, luego las de `b` que no estén (por la clave del elemento). */
function regUnirLista(a, b, claveDe) {
  var out = regArr(a).slice(), ya = {};
  out.forEach(function (x) { ya[claveDe(x)] = true; });
  regArr(b).forEach(function (x) { var k = claveDe(x); if (!ya[k]) { ya[k] = true; out.push(x); } });
  return out;
}
var REG_TEXTOS_NOTA = ['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'misc', 'cronologia', 'entrega'];
var REG_LISTAS_CK = {
  cirugias: function (x) { return regTexto(x && x.id) || regTexto(x); },
  dispositivos: function (x) { return regTexto(x && x.id) || regTexto(x); },
  pm_hist: function (x) { return regTexto(x && x.fecha) || regTexto(x); },
  nota_hist: function (x) { return regTexto(x && x.ts) || regTexto(x); }
};
/** Une dos copias de la nota de un mismo episodio: `principal` gana en lo que tiene escrito; `otra` rellena lo vacío;
 *  labs e imagen se unen por fecha (sin revivir las fechas de labs que la principal borró a propósito: __lab_deleted) y
 *  las listas del checklist (cirugías, dispositivos, signos, notas de evolución) por su id/fecha/hora. Se usa con la
 *  copia de la base que guarda la Papelera al egresar (_copia_base, por si el equipo tenía una copia vieja), entre varias
 *  copias de la Papelera del mismo episodio y entre el censo y la Papelera. */
function regUnirNotas(principal, otra) {
  var p = regObj(principal), r = regObj(otra);
  if (!Object.keys(r).length) return p;
  var out = Object.assign({}, r, p);
  REG_TEXTOS_NOTA.forEach(function (f) { if (!regTexto(p[f]).trim() && regTexto(r[f]).trim()) out[f] = r[f]; });
  var ckP = regObj(p.checklist), ckR = regObj(r.checklist), ck = Object.assign({}, ckR);
  Object.keys(ckP).forEach(function (k) { if (!regVacio(ckP[k]) || ck[k] === undefined) ck[k] = ckP[k]; });
  Object.keys(REG_LISTAS_CK).forEach(function (k) { if (Array.isArray(ckP[k]) || Array.isArray(ckR[k])) ck[k] = regUnirLista(ckP[k], ckR[k], REG_LISTAS_CK[k]); });
  var mP = regObj(ckP.__pl_note_meta), mR = regObj(ckR.__pl_note_meta);
  if (Object.keys(mP).length || Object.keys(mR).length) {
    var m = Object.assign({}, mR, mP);
    if (!regTexto(mP.entrega).trim() && regTexto(mR.entrega).trim()) m.entrega = mR.entrega;
    ck.__pl_note_meta = m;
  }
  out.checklist = ck;
  var borradas = regArr(ckP.__lab_deleted).map(regTexto);
  var porFecha = function (x) { return regTexto(x && x.fecha) || regTexto(x); };
  out.labHistory = regUnirLista(p.labHistory || p.lab_history, regArr(r.labHistory || r.lab_history).filter(function (e) { return borradas.indexOf(regTexto(e && e.fecha)) === -1; }), porFecha);
  out.imagenHistory = regUnirLista(p.imagenHistory || p.imagen_history, r.imagenHistory || r.imagen_history, porFecha);
  delete out.lab_history; delete out.imagen_history; delete out._copia_base;
  return out;
}
function regSiNo(v) { return v === true ? 'Sí' : (v === false ? '' : regTexto(v)); }

/** Episodios (una hospitalización por id de paciente de la base) y filas de cada pestaña (objetos por columna). */
function regConstruir(datos, hoy) {
  var notasPorId = {}, cronoPorId = {};
  regArr(datos.notes).forEach(function (n) { if (n && n.patient_id) notasPorId[n.patient_id] = n; });
  regArr(datos.cronologias).forEach(function (c) { if (c && c.patient_id) cronoPorId[c.patient_id] = regTexto(c.cronologia); });
  var episodios = {}, orden = [];
  function agregar(id, ep) { if (!episodios[id]) orden.push(id); episodios[id] = ep; }

  // Egresados y archivados (la Papelera), del más viejo al más nuevo: la copia más reciente de cada episodio manda y las
  // anteriores rellenan lo que le falte. Cada fila se une antes con la copia de la base que guardó (_copia_base).
  regArr(datos.archive).slice().sort(function (a, b) { return regTexto(a && a.archived_at).localeCompare(regTexto(b && b.archived_at)); })
    .forEach(function (a) {
      if (!a) return;
      var pd = regObj(a.patient_data), nd0 = regObj(a.note_data);
      if (!regTexto(pd.nombre).trim() && !regTexto(pd.exp).trim()) return;
      var id = regTexto(pd._supa_id || pd.id || ('archivo-' + a.id));
      var nd = regUnirNotas(nd0, nd0._copia_base);
      var motivo = regTexto(nd0._egreso || (/^(ALTA|DEFUNCI[OÓ]N)$/i.test(regTexto(pd.estado)) ? pd.estado : '') || 'EGRESO');
      var previo = episodios[id];
      var p = previo ? Object.assign({}, previo.p) : {};
      Object.keys(pd).forEach(function (k) { if (!regVacio(pd[k])) p[k] = pd[k]; });
      agregar(id, { id: id, p: p, n: previo ? regUnirNotas(nd, previo.n) : nd, estado: 'Egresado', motivo: motivo, egreso: regFecha(nd0._egresoFecha) || regFecha(a.archived_at), fuente: 'Papelera (archive)' });
    });
  // En el censo ahora: el censo manda; lo que traiga la Papelera del mismo id rellena lo que le falte.
  regArr(datos.patients).forEach(function (p) {
    if (!p || !p.id) return;
    if (!regTexto(p.nombre).trim() && !regTexto(p.exp).trim()) return;
    var id = regTexto(p.id), previo = episodios[id];
    agregar(id, { id: id, p: p, n: previo ? regUnirNotas(regObj(notasPorId[p.id]), previo.n) : regObj(notasPorId[p.id]), estado: 'Hospitalizado', motivo: '', egreso: '', fuente: 'Censo (patients)' });
  });
  // Restaurar desde la Papelera crea otro id: «Episodio relacionado» une las dos partes de la misma hospitalización.
  var relacion = {};
  regArr(datos.restauraciones).forEach(function (r) {
    var de = regTexto(r && r.de), a = regTexto(r && r.a);
    if (!de || !a || de === a) return;
    relacion[de] = 'Continúa en ' + a;
    relacion[a] = 'Viene de ' + de;
  });
  var out = { episodiosHoy: {}, relacion: relacion };
  REG_PESTANAS.forEach(function (cfg) { out[cfg.nombre] = []; });
  function fila(pestana, o) { out[pestana].push(o); }

  orden.forEach(function (id) {
    out.episodiosHoy[id] = true;
    var ep = episodios[id], p = ep.p, n = ep.n;
    var ck = regObj(n.checklist), meta = regObj(ck.__pl_note_meta);
    var labsH = regArr(n.labHistory || n.lab_history), imgH = regArr(n.imagenHistory || n.imagen_history);
    var nombre = regTexto(p.nombre), exp = regTexto(p.exp);
    var base = { 'ID episodio': id, 'Expediente': exp, 'Nombre': nombre };
    function con(o) { var r = Object.assign({}, base); Object.keys(o).forEach(function (k) { r[k] = o[k]; }); return r; }
    var ingreso = regFecha(p.ingreso);

    // Cirugías (caja nueva) o el texto Qx de antes.
    var cxs = regArr(ck.cirugias).filter(function (c) { return c && (regTexto(c.procedimiento).trim() || regTexto(c.fecha).trim() || regTexto(c.hallazgos).trim()); });
    cxs.forEach(function (c) {
      fila('Cirugías', con({ 'Fecha': regFecha(c.fecha) || regTexto(c.fecha), 'Procedimiento': regTexto(c.procedimiento), 'Hallazgos': regTexto(c.hallazgos), 'Sangrado': regTexto(c.sangrado), 'Cirujano': regTexto(c.cirujano), 'Vigente': 'Sí' }));
    });
    if (!cxs.length && regTexto(n.qx).trim()) fila('Cirugías', con({ 'Fecha': '', 'Procedimiento': regTexto(n.qx), 'Hallazgos': '', 'Sangrado': regTexto(n.sangrado), 'Cirujano': '', 'Vigente': 'Sí' }));

    // Labs: una fila por fecha y estudio; sin los PDF incrustados.
    var fechasLab = [];
    labsH.forEach(function (e) {
      if (!e) return;
      var f = regFecha(e.fecha) || regTexto(e.fecha);
      var origen = typeof e.source === 'string' ? e.source : (typeof e.origen === 'string' ? e.origen : '');
      var hubo = false;
      Object.keys(regObj(e.labs)).forEach(function (k) {
        var v = e.labs[k];
        if (v === null || v === undefined || regTexto(v).trim() === '' || regEsArchivo(v)) return;
        fila('Labs', con({ 'Fecha': f, 'Estudio': k, 'Valor': regTexto(v), 'Origen': origen, 'Vigente': 'Sí' })); hubo = true;
      });
      regArr(e.extra).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var k = regTexto(x.nombre || x.name || x.label || x.k || x.estudio), v = x.valor !== undefined ? x.valor : (x.value !== undefined ? x.value : x.v);
        if (!k || v === undefined || regTexto(v).trim() === '' || regEsArchivo(v)) return;
        fila('Labs', con({ 'Fecha': f, 'Estudio': k, 'Valor': regTexto(v), 'Origen': origen, 'Vigente': 'Sí' })); hubo = true;
      });
      if (hubo && fechasLab.indexOf(f) === -1) fechasLab.push(f);
    });

    // Imagen.
    var resumenImg = [];
    imgH.forEach(function (e) {
      if (!e) return;
      var f = regFecha(e.fecha) || regTexto(e.fecha);
      var ests = Array.isArray(e.estudios) ? e.estudios : [e];
      ests.forEach(function (s) {
        if (!s || typeof s !== 'object') return;
        var tipo = regTexto(s.tipo || s.estudio || s.modalidad), desc = regTexto(s.descripcion || s.interpretacion || s.texto || s.resultado);
        var link = regTexto(s.link || s.url);
        if (!/^https?:\/\//i.test(link)) link = '';
        if (!tipo.trim() && !desc.trim() && !link) return;
        fila('Imagen', con({ 'Fecha': f, 'Tipo': tipo, 'Descripción': desc, 'Enlace': link, 'Vigente': 'Sí' }));
        resumenImg.push((f ? f + ' ' : '') + (tipo || 'estudio'));
      });
    });

    // Signos vitales: los días que guarda la app (pm_hist, 14) y el pase de hoy (pm_*): se acumulan en el registro.
    var signos = regArr(ck.pm_hist).slice();
    if (regTexto(ck.pm_fecha).trim()) signos.push({ fecha: ck.pm_fecha, fc: ck.pm_fc, fr: ck.pm_fr, temp: ck.pm_temp, sao2: ck.pm_sao2, o2l: ck.pm_o2l, ta: ck.pm_ta, uresis: ck.pm_uresis, dxtx: ck.pm_dxtx, iu: ck.pm_iu, balance: ck.pm_balance });
    signos.forEach(function (s) {
      if (!s || !regFecha(s.fecha)) return;
      var vals = ['fc', 'fr', 'temp', 'sao2', 'o2l', 'ta', 'uresis', 'dxtx', 'iu', 'balance'].map(function (k) { return regTexto(s[k]); });
      if (!vals.some(function (v) { return v.trim(); })) return;
      fila('Signos vitales', con({ 'Fecha': regFecha(s.fecha), 'FC': vals[0], 'FR': vals[1], 'Temp': vals[2], 'SaO2': vals[3], 'O2 L/min': vals[4], 'TA': vals[5], 'Uresis': vals[6], 'DxTx': vals[7], 'IU': vals[8], 'Balance': vals[9] }));
    });

    // Notas de evolución (la app guarda las últimas 10).
    regArr(ck.nota_hist).forEach(function (h) {
      if (!h || typeof h.txt !== 'string' || !h.txt.trim()) return;
      fila('Notas de evolución', con({ 'Fecha y hora': regTexto(h.ts), 'Autor': regTexto(h.by), 'Con IA': h.ia ? 'Sí' : 'No', 'Texto': h.txt }));
    });

    // Guardia y cronología (la cronología también del respaldo de la base).
    var entrega = regTexto(n.entrega || meta.entrega);
    var crono = regLineas(n.cronologia);
    regLineas(cronoPorId[id]).forEach(function (l) { if (crono.indexOf(l) === -1) crono.push(l); });
    crono.forEach(function (l, i) { fila('Guardia y cronología', con({ 'Caja': 'Cronología', 'Orden': i + 1, 'Renglón': l, 'Vigente': 'Sí' })); });
    regLineas(entrega).forEach(function (l, i) { fila('Guardia y cronología', con({ 'Caja': 'Guardia vigente', 'Orden': i + 1, 'Renglón': l, 'Vigente': 'Sí' })); });

    var disp = regArr(ck.dispositivos).map(function (d) {
      if (!d || typeof d !== 'object') return regTexto(d);
      return Object.keys(d).filter(function (k) { return !/^(id|foto|fotos|file|img|ink|_)/i.test(k) && !regEsArchivo(d[k]) && regTexto(d[k]).trim() && d[k] !== false; })
        .map(function (k) { return d[k] === true ? k : regTexto(d[k]); }).join(' ');
    }).filter(function (x) { return x.trim(); });
    var drenajes = [regTexto(n.drenajes)].concat(disp).filter(function (x) { return x.trim(); }).join(' | ');
    var atb = ck.atb ? [regTexto(ck.atb_nombre), ck.atb_dias ? regTexto(ck.atb_dias) + ' días' : ''].filter(Boolean).join(', ') || 'Sí' : '';
    var une = function (partes) { return partes.filter(function (x) { return regTexto(x).trim(); }).join(' · '); };

    fila('Pacientes', {
      'ID episodio': id, 'Estado en registro': ep.estado, 'Motivo de egreso': ep.motivo, 'Nombre': nombre, 'Expediente': exp,
      'Edad': regTexto(p.edad), 'Sexo': regTexto(ck.sexo || p.sexo), 'Especialidad': regTexto(p.esp), 'Sección': regTexto(p.seccion), 'Adscrito': regTexto(p.adscrito),
      'Residente': regTexto(p.residente), 'Cama': regTexto(p.cama), 'Fecha de ingreso': ingreso, 'Fecha de egreso': ep.egreso,
      'Días de estancia': regDias(ingreso, ep.egreso || hoy), 'Diagnóstico': regTexto(p.dx), 'Estado clínico': regTexto(p.estado),
      'Antecedentes (APP)': regTexto(n.app), 'Padecimiento (PA)': regTexto(n.pa), 'Manejo': regTexto(n.manejo),
      'Pendientes': regTexto(n.pendientes), 'Drenajes y dispositivos': drenajes, 'Antibiótico': atb, 'Cultivos': regTexto(ck.cultivos),
      'Interconsultas': regTexto(ck.interconsultas),
      'Dieta y NPO': une([regTexto(ck.dieta), ck.npo ? 'NPO' + (ck.npo_dias ? ' ' + regTexto(ck.npo_dias) + ' días' : '') : '']),
      'TVP': ck.tvp ? une(['Sí', regTexto(ck.tvp_tipo), regTexto(ck.tvp_dosis), regTexto(ck.tvp_otro)]) : '',
      'NPT': ck.npt ? une(['Sí', ck.npt_pct ? regTexto(ck.npt_pct) + '%' : '', regTexto(ck.npt_fecha)]) : '',
      'Ventilación': ck.pm_vent ? une(['Sí', regTexto(ck.pm_vent_modo), ck.pm_vent_fio2 ? 'FiO2 ' + regTexto(ck.pm_vent_fio2) : '', ck.pm_vent_peep ? 'PEEP ' + regTexto(ck.pm_vent_peep) : '']) : '',
      'Vasopresores': une([ck.vp_nore_on ? 'Norepinefrina' + (ck.vp_nore_mlh ? ' ' + regTexto(ck.vp_nore_mlh) + ' mL/h' : '') : '', ck.vp_vaso_on ? 'Vasopresina' + (ck.vp_vaso_mlh ? ' ' + regTexto(ck.vp_vaso_mlh) + ' mL/h' : '') : '']),
      'Cirugías (resumen)': cxs.map(function (c) { return [regFecha(c.fecha) || regTexto(c.fecha), regTexto(c.procedimiento)].filter(Boolean).join(' '); }).join(' | ') || regTexto(n.qx),
      'Imagen (resumen)': resumenImg.join(' | '), 'Labs (fechas)': fechasLab.sort().join(', '),
      'Guardia vigente': entrega, 'Cronología': crono.join('\n'), 'Misceláneo': regTexto(n.misc),
      'Nota completa (JSON)': regJsonLimpio(n, ['checklist', 'labHistory', 'lab_history', 'imagenHistory', 'imagen_history', 'body_diagram_ant', 'body_diagram_post']),
      'Checklist completo (JSON)': regJsonLimpio(ck, ['__pl_note_meta', 'cirugias', 'pm_hist', 'nota_hist', '__ink']),
      'Alta en la app': regTexto(p.created_at), 'Última modificación en la app': regTexto(n.updated_at || p.updated_at), 'Fuente': ep.fuente, 'Última vez en la base': hoy
    });
  });

  regArr(datos.procedimientos).forEach(function (x) {
    if (!x || !x.id) return;
    fila('Procedimientos programados', { 'ID': regTexto(x.id), 'Fecha': regFecha(x.fecha_dia), 'Cama': regTexto(x.cama), 'Expediente': regTexto(x.exp), 'Nombre': regTexto(x.nombre), 'Edad': regTexto(x.edad), 'Diagnóstico': regTexto(x.dx), 'Especialidad': regTexto(x.esp), 'Adscrito': regTexto(x.adscrito), 'Residente': regTexto(x.residente), 'Agregado por': regTexto(x.added_by) });
  });
  // Labs del robot: data es { estudio: valor } (los objetos anidados, como texto).
  regArr(datos.winlab).forEach(function (w) {
    if (!w) return;
    Object.keys(regObj(w.data)).forEach(function (k) {
      var v = w.data[k];
      if (v === null || v === undefined || regTexto(v).trim() === '' || regEsArchivo(v)) return;
      fila('Labs del robot (WinLab)', { 'Expediente': regTexto(w.exp), 'Paciente': regTexto(w.paciente), 'Fecha': regFecha(w.fecha), 'Estudio': k, 'Valor': regTexto(v), 'Capturado': regTexto(w.scraped_at) });
    });
  });
  regArr(datos.cultivos).forEach(function (c) {
    if (!c) return;
    fila('Cultivos del robot (WinLab)', { 'Expediente': regTexto(c.exp), 'Nombre': regTexto(c.nombre), 'Cama': regTexto(c.cama), 'Fecha': regFecha(c.fecha), 'Tipo': regTexto(c.tipo), 'Germen': regTexto(c.germen), 'Resultado': regTexto(c.resultado), 'Texto': regTexto(c.texto_origen) });
  });
  regArr(datos.ris).forEach(function (r) {
    if (!r || r.id === undefined || r.id === null) return;
    fila('Imagen del robot (RIS)', { 'ID': regTexto(r.id), 'ID episodio': regTexto(r.patient_id), 'Expediente': regTexto(r.exp), 'Paciente': regTexto(r.paciente), 'Fecha': regTexto(r.fecha), 'Hora': regTexto(r.hora), 'Modalidad': regTexto(r.modalidad), 'Estudios': regTexto(r.estudios), 'Crítico': regSiNo(r.critico), 'Estado del reporte': regTexto(r.reporte_estado), 'Reporte': regTexto(r.reporte), 'Enlace del reporte': /^https?:\/\//i.test(regTexto(r.reporte_url)) ? regTexto(r.reporte_url) : '', 'Capturado': regTexto(r.scraped_at) });
  });
  return out;
}

// ─── Fusión con lo que ya está en la hoja (nunca se borra) ───────────────────────────────────────────────────────
function regClaveDe(fila, cfg) { return cfg.clave.map(function (c) { return regTexto(fila[c]).trim(); }).join(REG_SEP); }

/** Junta lo de la hoja (`viejas`, objetos por columna, en su orden) con lo de hoy (`nuevas`): la fila con la misma clave
 *  se reemplaza por la de hoy; las que hoy no vienen se conservan (en modo 'vigente', marcadas «No» si su episodio sí
 *  está hoy en la base; en 'pacientes', «Salió de la base…» si seguían hospitalizadas). Nunca devuelve menos filas
 *  (claves distintas) de las que había. */
function regFusionar(viejas, nuevas, cfg, episodiosHoy, hoy, relacion) {
  var hoyPorClave = {}, ordenHoy = [];
  nuevas.forEach(function (r) { var k = regClaveDe(r, cfg); if (!hoyPorClave[k]) ordenHoy.push(k); hoyPorClave[k] = r; });
  var out = [], vistas = {}, nViejas = 0;
  viejas.forEach(function (r) {
    var k = regClaveDe(r, cfg);
    if (vistas[k]) return;
    vistas[k] = true; nViejas++;
    if (hoyPorClave[k]) { out.push(hoyPorClave[k]); return; }
    var c = Object.assign({}, r);
    if (cfg.modo === 'pacientes' && c['Estado en registro'] === 'Hospitalizado') c['Estado en registro'] = 'Salió de la base sin egreso registrado';
    if (cfg.modo === 'vigente' && episodiosHoy && episodiosHoy[regTexto(c['ID episodio'])]) c['Vigente'] = 'No';
    out.push(c);
  });
  ordenHoy.forEach(function (k) { if (!vistas[k]) { vistas[k] = true; out.push(hoyPorClave[k]); } });
  if (out.length < nViejas) throw new Error('Registro: la pestaña ' + cfg.nombre + ' quedaría con menos filas; no se escribe.');
  if (cfg.modo === 'pacientes' && relacion) out = out.map(function (r) {
    var rel = relacion[regTexto(r['ID episodio'])];
    if (!rel || r['Episodio relacionado'] === rel) return r;
    var c = Object.assign({}, r); c['Episodio relacionado'] = rel; return c;
  });
  return out;
}

// ─── Hoja ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Filas de la pestaña como objetos por nombre de columna. Si tiene datos pero le falta una columna de la clave (se
 *  renombró el encabezado), se detiene: escribir sin leerla bien borraría su historia. */
function regLeerPestana_(hoja, cfg) {
  var n = hoja.getLastRow(), m = hoja.getLastColumn();
  if (n < 1 || m < 1) return [];
  var vals = hoja.getRange(1, 1, n, m).getValues();
  var enc = vals[0].map(function (h) { return regTexto(h).trim(); });
  var conDatos = vals.slice(1).some(function (f) { return f.some(function (v) { return regTexto(v).trim(); }); });
  if (conDatos && cfg.clave.some(function (c) { return enc.indexOf(c) === -1; })) {
    throw new Error('La pestaña «' + cfg.nombre + '» no tiene la columna «' + cfg.clave.filter(function (c) { return enc.indexOf(c) === -1; })[0] + '» en la fila 1: no se actualizó nada para no perder datos (regrese el encabezado).');
  }
  return vals.slice(1).map(function (fila) {
    var o = {};
    enc.forEach(function (h, i) { if (h && o[h] === undefined) o[h] = fila[i]; });
    return o;
  }).filter(function (o) { return regClaveDe(o, cfg).replace(new RegExp(REG_SEP, 'g'), '').trim(); });
}
/** Texto para una celda (la columna es de texto plano: no se interpreta como fórmula ni fecha), recortado al límite. */
function regCelda(v) {
  if (typeof v === 'number') return v;
  var s = regTexto(v);
  if (s.length > REG_MAX_CELDA) s = s.slice(0, REG_MAX_CELDA) + ' …[recortado]';
  return s;
}
/** Escribe encima (sin vaciar antes) y luego limpia solo lo que sobre abajo; la cuadrícula se agranda si hace falta.
 *  Las columnas que alguien agregue a la derecha se respetan. */
function regEscribirPestana_(hoja, columnas, filas) {
  var datos = [columnas].concat(filas.map(function (r) { return columnas.map(function (c) { return regCelda(r[c]); }); }));
  var nf = datos.length, nc = columnas.length;
  if (hoja.getMaxRows() < nf) hoja.insertRowsAfter(hoja.getMaxRows(), nf - hoja.getMaxRows());
  if (hoja.getMaxColumns() < nc) hoja.insertColumnsAfter(hoja.getMaxColumns(), nc - hoja.getMaxColumns());
  hoja.getRange(1, 1, nf, nc).setNumberFormat('@').setValues(datos);
  var sobra = hoja.getLastRow() - nf;
  if (sobra > 0) hoja.getRange(nf + 1, 1, sobra, nc).clearContent();
  hoja.setFrozenRows(1);
}
function regEscribirDiccionario_(libro, hoy, cuentas, celdas, pendiente) {
  var hoja = libro.getSheetByName('Diccionario') || libro.insertSheet('Diccionario');
  var filas = [
    ['Registro de pacientes', 'Copia diaria de la app y de los robots (Supabase) para estudios. Nunca se borran filas: lo que sale de la base se conserva.'],
    ['Última actualización', hoy],
    ['Conteos', JSON.stringify(cuentas)],
    ['Celdas usadas', String(celdas || 0) + ' de ' + REG_CELDAS_MAX + ' que admite Sheets (' + Math.round(100 * (celdas || 0) / REG_CELDAS_MAX) + '%)' + ((celdas || 0) > REG_CELDAS_AVISO * REG_CELDAS_MAX ? ' — AVISO: hay que pasar lo viejo a un libro histórico.' : '')],
    ['Carga en curso', pendiente ? 'Sí: quedan filas por leer; la siguiente vuelta corre en 10 min.' : 'No'],
    ['Privacidad', 'Contiene nombres y expedientes. Mantener en la carpeta privada; compartir solo como lector y solo con personas autorizadas por el protocolo aprobado por el Comité de Ética en Investigación.'],
    ['ID episodio', 'Id del paciente en la base (una hospitalización). Un reingreso es otro episodio.'],
    ['Estado en registro', 'Hospitalizado (en el censo), Egresado (en la Papelera) o «Salió de la base sin egreso registrado».'],
    ['Motivo de egreso', 'Etiqueta del egreso en la app (ALTA, DEFUNCIÓN, alta médica, EGRESO, CAMA REASIGNADA…).'],
    ['Episodio relacionado', 'Restaurar desde la Papelera crea otro id: «Continúa en …» / «Viene de …» une las dos partes de la misma hospitalización.'],
    ['Fecha de egreso', 'Fecha del egreso en la app o, si no la hay, la fecha en que se archivó.'],
    ['Días de estancia', 'Desde la fecha de ingreso hasta el egreso (o hasta hoy si sigue hospitalizado).'],
    ['Vigente', 'Sí: está en la tarjeta en la última copia. No: estuvo y ya no (corregido, borrado o movido); se conserva.'],
    ['Signos vitales y Notas de evolución', 'La app guarda 14 días de signos y 10 notas; aquí se acumulan todos.'],
    ['Labs / Cultivos / Imagen del robot', 'Lo que capturaron WinLab y RIS, por expediente (y por episodio en RIS), aunque no haya llegado a la tarjeta.'],
    ['Nota / Checklist completo (JSON)', 'Todo lo demás de la tarjeta, sin archivos incrustados.'],
    ['Respaldo', 'Cada semana se guarda una copia de esta hoja en la misma carpeta (las últimas ' + REG_RESPALDOS + ').'],
    ['Cuidado', 'Se pueden agregar columnas a la DERECHA y usar filtros; no insertar columnas en medio ni renombrar la fila 1.']
  ];
  if (hoja.getMaxColumns() < 2) hoja.insertColumnsAfter(hoja.getMaxColumns(), 2 - hoja.getMaxColumns());
  if (hoja.getMaxRows() < filas.length) hoja.insertRowsAfter(hoja.getMaxRows(), filas.length - hoja.getMaxRows());
  hoja.getRange(1, 1, filas.length, 2).setNumberFormat('@').setValues(filas.map(function (r) { return [regCelda(r[0]), regCelda(r[1])]; }));
}
/** Copia semanal de toda la hoja en su carpeta, ANTES de escribir (guarda el estado anterior); quedan las últimas 5. */
function regRespaldoSemanal_(libro, props, hoy) {
  var ultima = Date.parse(props.getProperty('REG_ULTIMO_RESPALDO') || '');
  if (!isNaN(ultima) && Date.now() - ultima < REG_RESPALDO_CADA_MS) return;
  var archivo = DriveApp.getFileById(libro.getId());
  var padres = archivo.getParents();
  if (!padres.hasNext()) return;
  var carpeta = padres.next(), prefijo = 'Respaldo — ' + archivo.getName() + ' — ';
  archivo.makeCopy(prefijo + hoy, carpeta);
  var copias = [], it = carpeta.getFiles();
  while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(prefijo) === 0) copias.push(f); }
  copias.sort(function (a, b) { return b.getName().localeCompare(a.getName()); });
  copias.slice(REG_RESPALDOS).forEach(function (f) { f.setTrashed(true); });
  props.setProperty('REG_ULTIMO_RESPALDO', new Date().toISOString());
}
