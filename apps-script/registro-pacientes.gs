/**
 * Registro de pacientes para investigación (21 oct 2026): Supabase → Google Sheets, en la cuenta de Google del dueño.
 *
 * Una vez al día copia a una hoja de cálculo privada TODO lo que la app y los robots tienen de cada paciente: el censo
 * (patients + notes), los egresados de la Papelera (archive), el respaldo de la cronología, los reportes y cultivos de
 * WinLab (sacados de winlab_labs con la misma regla de identidad de la app), los estudios de RIS y los procedimientos
 * programados. NUNCA borra: lo que ya no está en la base se conserva (en las pestañas de la tarjeta, marcado «Vigente:
 * No»), y cada semana guarda una copia de la hoja en la misma carpeta.
 *
 * PRIVACIDAD: la hoja tiene nombres y expedientes (datos de salud identificables). Debe quedarse en la carpeta privada.
 * El script solo LEE Supabase (GET) y en el registro de ejecuciones solo escribe conteos y avisos sin datos de pacientes.
 *
 * INSTALACIÓN (ver apps-script/REGISTRO.md). Recomendado: PROYECTO APARTE (script.google.com → Nuevo proyecto), así quien
 * edite la hoja no puede ver la llave de Supabase:
 *   1) Pegar este archivo y guardar.
 *   2) Propiedades del script: SUPABASE_KEY = <service_role key>; REGISTRO_SHEET_ID = <id de la hoja del registro>.
 *   3) Ejecutar instalarRegistroDiario (autorizar): crea la actualización diaria y hace la primera corrida.
 * (Ligado a la hoja también funciona sin REGISTRO_SHEET_ID y agrega el menú «Registro → Actualizar ahora».)
 *
 * Primera corrida real (21 oct 2026) y revisión: UrlFetchApp rechaza una URL con «>» sin codificar (regUrl_ codifica
 * todo); la vista winlab_cultivos tarda más que los 8 s que PostgREST permite (ya no se lee: los cultivos salen de
 * winlab_labs); winlab_labs.data es {reportes:[…]} y no {estudio: valor}; offset salta filas si alguien borra entre dos
 * páginas (ahora se pagina por llave); la escritura no tenía presupuesto de tiempo (ahora sí, y solo escribe lo que
 * cambió); los disparadores de una cuenta personal tienen 90 min al día compartidos con el script del censo (la carga
 * inicial se reparte en pocas vueltas cortas, con tope diario).
 */
var SUPABASE_URL = 'https://vkxplmrzyqlamxpbtmes.supabase.co';
var REG_HORA = 23;                 // la actualización diaria corre entre las 23:00 y las 24:00 (zona del proyecto)
var REG_MAX_CELDA = 45000;         // Sheets admite 50 000 caracteres por celda
var REG_MAX_PAGINA = 1000;         // PostgREST de Supabase devuelve como máximo 1000 filas por petición (max_rows)
// Tiempo (la ejecución tiene 6 min): las lecturas por cursor se detienen a los 2.5 min y siguen en otra vuelta; las
// demás lecturas fallan sin escribir si pasan de 4 min; después de 5 min 15 s no se empieza otra pestaña.
var REG_LECTURA_MS = 150000, REG_LECTURA_DURA_MS = 240000, REG_LIMITE_MS = 315000;
var REG_MARGEN_INCREMENTAL_MS = 2 * 86400000;   // lo incremental se vuelve a leer desde 2 días antes de lo último leído
// Lecturas por cursor (fecha de la fila + id): cuántas filas como máximo por corrida. Si quedan, la corrida escribe lo
// leído, guarda la posición exacta y programa una continuación en 10 min (como mucho REG_CONTINUACIONES_DIA al día).
var REG_CURSORES = {
  archive: { col: 'archived_at', tope: 400 },
  winlab_labs: { col: 'scraped_at', tope: 1500 },
  ris_estudios: { col: 'scraped_at', tope: 3000 }
};
var REG_CONTINUACIONES_DIA = 8;
var REG_CELDAS_MAX = 10000000, REG_CELDAS_AVISO = 0.7;
var REG_RESPALDO_DIAS = 7, REG_RESPALDOS = 5;
var REG_UTC_OFFSET_MIN = -360;     // America/Mexico_City: UTC-6 todo el año (sin horario de verano desde oct 2022)
var REG_BLOQUE = 4000;             // filas por setValues
var REG_MAX_BLOQUES = 200;         // más bloques sueltos que esto: se reescribe la pestaña entera
var REG_SEP = '␟';

// Pestañas: columnas (orden de la hoja), clave de cada fila, modo de fusión y, si sale de una sola tabla, su fuente:
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
  { nombre: 'Procedimientos programados', modo: 'acumula', fuente: 'procedimientos_dia', clave: ['ID'], columnas: ['ID', 'Fecha', 'Cama', 'Expediente', 'Nombre', 'Edad', 'Diagnóstico', 'Especialidad', 'Adscrito', 'Residente', 'Agregado por'] },
  { nombre: 'Labs del robot (WinLab)', modo: 'acumula', fuente: 'winlab_labs', clave: ['Expediente', 'Reporte'], columnas: ['Expediente', 'Paciente', 'Nombre en WinLab', 'Atribución', 'Reporte', 'Folio', 'Toma', 'Resultado', 'Servicio', 'Estudios', 'Valores', 'Capturado'] },
  { nombre: 'Cultivos del robot (WinLab)', modo: 'acumula', fuente: 'winlab_labs', clave: ['Expediente', 'Reporte', 'N'], columnas: ['Expediente', 'Paciente', 'Reporte', 'N', 'Toma', 'Tipo', 'Muestra', 'Resultado', 'Germen', 'Sensibles', 'Intermedios', 'Resistentes', 'UFC', 'Detalle', 'Fuente', 'Texto del reporte', 'Atribución', 'Capturado'] },
  { nombre: 'Imagen del robot (RIS)', modo: 'acumula', fuente: 'ris_estudios', clave: ['ID'], columnas: ['ID', 'ID episodio', 'Expediente', 'Paciente', 'Fecha', 'Hora', 'Modalidad', 'Estudios', 'Crítico', 'Estado del reporte', 'Reporte', 'Enlace del reporte', 'Capturado'] }
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
  var inicio = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Registro: otra actualización en curso; se omite esta.'); return { ok: false, motivo: 'ocupado' }; }
  try {
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('SUPABASE_KEY');
    if (!key) throw new Error('Falta SUPABASE_KEY en Propiedades del script');
    // La hoja se abre ANTES de leer: un REGISTRO_SHEET_ID que falta o está mal se dice de inmediato.
    var libro = regLibro_(props);
    var hoy = regHoy_(), avisos = [], omitidas = {};
    var transcurrido = function () { return Date.now() - inicio; };
    var reloj = function () {
      if (transcurrido() <= REG_LECTURA_DURA_MS) return;
      var e = new Error('La lectura de Supabase pasó de 4 min: no se escribió nada (se reintenta en la siguiente corrida).'); e.regTiempo = true; throw e;
    };
    var leer = function (tabla, select, orden, filtro, pagina) { return regLeerTabla_(key, tabla, select, orden, filtro, pagina, { reloj: reloj }).filas; };
    // Por cursor: desde la posición exacta de la vuelta anterior (si quedó a medias) o desde lo último leído menos 2 días.
    var cursores = {}, pendiente = false;
    var leerCursor = function (tabla, select, pagina, alPagina) {
      var c = REG_CURSORES[tabla], previo = props.getProperty('REG_CURSOR_' + tabla) || '';
      var sigue = regJson_(props.getProperty('REG_SIGUE_' + tabla));
      var filtro = c.col + '=not.is.null';
      if (!sigue && previo && !isNaN(Date.parse(previo))) filtro += '&' + c.col + '=gte.' + new Date(Date.parse(previo) - REG_MARGEN_INCREMENTAL_MS).toISOString();
      var r = regLeerTabla_(key, tabla, select, c.col + ',id', filtro, pagina, {
        reloj: reloj, tope: c.tope, despuesDe: sigue ? [sigue.v, sigue.id] : null, alPagina: alPagina,
        parar: function () { return transcurrido() > REG_LECTURA_MS; }
      });
      cursores[tabla] = { r: r, previo: previo, sigue: sigue };
      if (!r.completa) pendiente = true;
      return r.filas;
    };
    // Fuentes que solo alimentan sus propias pestañas: si fallan, esas pestañas no se tocan hoy y lo demás sí se escribe.
    var opcional = function (fuente, fn) {
      try { return fn(); } catch (e) {
        if (e && e.regTiempo) throw e;
        omitidas[fuente] = true; delete cursores[fuente];
        avisos.push('No se pudo leer ' + fuente + ' (' + regCausa_(e) + '): sus pestañas no se tocaron en esta corrida.');
        return [];
      }
    };
    var winlab = { labs: {}, cultivos: {} };
    var datos = {
      patients: leer('patients', 'id,cama,nombre,exp,dx,edad,esp,seccion,adscrito,residente,ingreso,estado,created_at,updated_at', 'id', '', 200),
      notes: leer('notes', 'patient_id,app,pa,drenajes,qx,manejo,sangrado,sv,balance,pendientes,checklist,lab_history,imagen_history,misc,cronologia,updated_at', 'patient_id', '', 20),
      archive: leerCursor('archive', 'id,patient_data,note_data,archived_at', 10),
      restauraciones: leer('archive', 'id,de:patient_data->>_supa_id,a:note_data->>_restaurado_a', 'id', 'note_data->>_restaurado_a=not.is.null', 1000),
      cronologias: leer('cronologia_respaldo', 'patient_id,exp,nombre,cronologia,actualizado', 'patient_id', '', 200),
      procedimientos: opcional('procedimientos_dia', function () { return leer('procedimientos_dia', 'id,cama,exp,nombre,edad,dx,esp,adscrito,residente,fecha_dia,added_by', 'id', '', 500); }),
      // WinLab: cada fila trae TODOS los reportes de la búsqueda (también de homónimos) y se repite cada día; se procesa
      // página por página (sin guardar el JSON crudo) y queda un renglón por reporte del paciente.
      winlab: (opcional('winlab_labs', function () {
        return leerCursor('winlab_labs', 'id,exp,paciente,fecha,scraped_at,reportes:data->reportes', 100, function (filas) { regWlAcumular(winlab, filas); });
      }), winlab),
      ris: opcional('ris_estudios', function () { return leerCursor('ris_estudios', 'id,patient_id,exp,paciente,fecha,hora,modalidad,estudios,critico,reporte_estado,reporte,reporte_url,scraped_at', 200); })
    };
    var nuevo = regConstruir(datos, hoy);
    try { regRespaldoSemanal_(libro, props, hoy); } catch (e) { avisos.push('No se pudo guardar el respaldo semanal (' + regCausa_(e) + ').'); }
    var cuentas = {}, cortado = false;
    REG_PESTANAS.forEach(function (cfg) {
      if (cortado || (cfg.fuente && omitidas[cfg.fuente])) return;
      if (transcurrido() > REG_LIMITE_MS) { cortado = true; return; }
      var hoja = libro.getSheetByName(cfg.nombre);
      if (!hoja) { hoja = libro.insertSheet(cfg.nombre); regAjustarColumnas_(hoja, cfg.columnas.length); }
      var previo = regLeerPestana_(hoja, cfg);
      var filas = regFusionar(previo.filas, nuevo[cfg.nombre] || [], cfg, nuevo.episodiosHoy, hoy, nuevo.relacion);
      regEscribirPestana_(hoja, cfg.columnas, filas, previo);
      cuentas[cfg.nombre] = filas.length;
    });
    if (cortado) { pendiente = true; avisos.push('Se acabó el tiempo al escribir: lo que faltó se escribe en la siguiente vuelta.'); }
    var dic = regHojaDiccionario_(libro), celdas = regCeldas_(libro);
    if (celdas > REG_CELDAS_AVISO * REG_CELDAS_MAX) avisos.push('El registro usa el ' + Math.round(100 * celdas / REG_CELDAS_MAX) + '% de las celdas que admite Sheets: hay que pasar lo viejo a un libro histórico.');
    // Los cursores avanzan solo cuando todo lo leído ya quedó escrito.
    if (!cortado) {
      Object.keys(cursores).forEach(function (t) { regGuardarCursor_(props, t, cursores[t]); });
      props.setProperty('REG_ULTIMA_CORRIDA', new Date(inicio).toISOString());
    }
    if (pendiente && !regProgramarContinuacion_(props, hoy)) avisos.push('Quedan filas por leer; hoy ya se usaron las ' + REG_CONTINUACIONES_DIA + ' vueltas extra: sigue en la corrida de la noche.');
    regEscribirDiccionario_(dic, hoy, cuentas, celdas, pendiente, avisos);
    // Solo conteos y avisos en el registro de ejecución: nada de nombres ni expedientes.
    Logger.log('Registro actualizado ' + hoy + ': ' + JSON.stringify(cuentas) + (avisos.length ? ' · Avisos: ' + avisos.join(' | ') : ''));
    return { ok: true, cuentas: cuentas, pendiente: pendiente, avisos: avisos };
  } finally {
    lock.releaseLock();
  }
}

function regLibro_(props) {
  var id = regTexto(props.getProperty('REGISTRO_SHEET_ID')).trim();
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { throw new Error('REGISTRO_SHEET_ID no abre una hoja (' + regCausa_(e) + '): revise el id en Propiedades del script. No se leyó nada.'); }
  }
  var activo = SpreadsheetApp.getActiveSpreadsheet();
  if (!activo) throw new Error('Falta REGISTRO_SHEET_ID en Propiedades del script (proyecto aparte). No se leyó nada.');
  return activo;
}
function regHoy_() {
  var tz = (typeof Session !== 'undefined' && Session.getScriptTimeZone) ? Session.getScriptTimeZone() : 'America/Mexico_City';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
function regJson_(s) { if (!s) return null; try { var o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (_) { return null; } }
/** La más reciente de varias marcas de tiempo ('' si ninguna se entiende). */
function regMasReciente_() {
  var mejor = '';
  for (var i = 0; i < arguments.length; i++) { var v = regTexto(arguments[i]); if (v && !isNaN(Date.parse(v)) && (!mejor || Date.parse(v) > Date.parse(mejor))) mejor = v; }
  return mejor;
}
/** Lectura completa: el cursor pasa a lo más reciente leído y se olvida la posición. A medias: se guarda la posición
 *  exacta (fecha + id de la última fila) y lo más reciente visto, sin tocar el cursor; la siguiente vuelta sigue de ahí. */
function regGuardarCursor_(props, tabla, c) {
  var r = c.r, max = regMasReciente_(c.sigue && c.sigue.max, r.max);
  if (r.completa) {
    props.deleteProperty('REG_SIGUE_' + tabla);
    var nuevo = regMasReciente_(c.previo, max);
    if (nuevo) props.setProperty('REG_CURSOR_' + tabla, nuevo);
  } else if (r.ultima) {
    props.setProperty('REG_SIGUE_' + tabla, JSON.stringify({ v: r.ultima[0], id: r.ultima[1], max: max }));
  }
}
/** Programa una vuelta extra en 10 min (como mucho REG_CONTINUACIONES_DIA al día: los disparadores de una cuenta personal
 *  tienen 90 min diarios, compartidos con el script del censo). */
function regProgramarContinuacion_(props, hoy) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarRegistro') ScriptApp.deleteTrigger(t); });
  var c = regJson_(props.getProperty('REG_CONTINUACIONES')) || {};
  var n = c.dia === hoy ? (+c.n || 0) : 0;
  if (n >= REG_CONTINUACIONES_DIA) return false;
  ScriptApp.newTrigger('continuarRegistro').timeBased().after(10 * 60 * 1000).create();
  props.setProperty('REG_CONTINUACIONES', JSON.stringify({ dia: hoy, n: n + 1 }));
  return true;
}

// ─── Lectura de Supabase (solo GET; paginada por llave; la página se achica si una respuesta es demasiado grande) ──
/** URL de PostgREST con cada nombre y valor codificado. UrlFetchApp rechaza («Argumento no válido») una URL con
 *  caracteres como > (21 oct 2026: el filtro note_data->>_restaurado_a sin codificar tumbó la primera corrida real).
 *  `filtro`: 'campo=operador.valor' SIN codificar (varios separados por &). */
function regUrl_(tabla, select, orden, filtro, lim) {
  var q = [['select', select]];
  regTexto(filtro).split('&').forEach(function (p) { var i = p.indexOf('='); if (i > 0) q.push([p.slice(0, i), p.slice(i + 1)]); });
  q.push(['order', orden.split(',').map(function (c) { return c + '.asc'; }).join(',')], ['limit', lim]);
  return SUPABASE_URL + '/rest/v1/' + tabla + '?' + q.map(function (kv) { return encodeURIComponent(kv[0]) + '=' + encodeURIComponent(kv[1]); }).join('&');
}
/** Filtro «después de esta fila» para paginar por llave (sin offset: si alguien borra una fila entre dos páginas, offset
 *  se salta la siguiente). Una columna: col=gt.v. Dos (fecha, id): f=gte.v & or=(f.gt."v",and(f.eq."v",id.gt."i")); el
 *  gte deja que la base recorra el índice (fecha, id) desde ahí (sin él, cada página de winlab_labs tardaba 3.9 s). */
function regKeyset_(cols, vals) {
  var q = function (v) { return '"' + regTexto(v).replace(/"/g, '') + '"'; };
  if (cols.length === 1) return cols[0] + '=gt.' + regTexto(vals[0]);
  return cols[0] + '=gte.' + regTexto(vals[0]) + '&or=(' + cols[0] + '.gt.' + q(vals[0]) + ',and(' + cols[0] + '.eq.' + q(vals[0]) + ',' + cols[1] + '.gt.' + q(vals[1]) + '))';
}
/** Causa de un error para el registro, sin URLs (no trae datos de pacientes ni la llave). */
function regCausa_(e) {
  return regTexto(e && e.message !== undefined ? e.message : e).replace(/https?:\/\/\S+/g, '[url]').replace(/\s+/g, ' ').trim().slice(0, 160);
}
/** Lee `tabla` en orden por las columnas de `orden` (la última es única). op: reloj (lanza si se acabó el tiempo),
 *  tope (filas máximas), parar() (detenerse sin error: completa=false), despuesDe (valores de la llave desde donde
 *  seguir), alPagina(filas) (procesa cada página y no las acumula). Devuelve { filas, completa, ultima, max }. */
function regLeerTabla_(key, tabla, select, orden, filtro, pagina, op) {
  op = op || {};
  var cols = orden.split(','), tope = op.tope || 0;
  pagina = Math.max(1, Math.min(pagina, REG_MAX_PAGINA));
  var paginaMax = pagina, out = [], n = 0, ultima = op.despuesDe || null, max = '', seguidas = 0;
  var fin = function (completa) { return { filas: out, completa: completa, ultima: ultima, max: max, n: n }; };
  for (var vuelta = 0; vuelta < 20000; vuelta++) {
    if ((tope && n >= tope) || (op.parar && op.parar())) return fin(false);
    var lim = tope ? Math.min(pagina, tope - n) : pagina;
    var f = [filtro, ultima ? regKeyset_(cols, ultima) : ''].filter(Boolean).join('&');
    var url = regUrl_(tabla, select, orden, f, lim);
    var res = null, code = 0, error = null;
    try {
      res = UrlFetchApp.fetch(url, { method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true });
      code = res.getResponseCode();
    } catch (e) { error = e; }
    if (op.reloj) op.reloj();
    var causa = error ? regCausa_(error) : '';
    var urlRechazada = /invalid argument|argumento no v[aá]lido|argumento inv[aá]lido/i.test(causa);
    // El cuerpo de un error puede traer datos: solo se toma su código de PostgREST (p. ej. 42703, 57014).
    var codPg = '';
    if (!error && code !== 200) { try { var cuerpo = JSON.parse(res.getContentText() || '{}'); if (/^[A-Z0-9]{5,8}$/.test(regTexto(cuerpo && cuerpo.code))) codPg = cuerpo.code; } catch (_) {} }
    // Respuesta demasiado grande (filas con archivos incrustados) o corte de red: se reintenta con la mitad de filas. Una
    // URL rechazada o una consulta que se pasa del tiempo de la base (57014) no mejoran con menos filas: fallan ya.
    var achicar = (error && !urlRechazada) || code === 413 || (code >= 500 && codPg !== '57014');
    if (achicar && pagina > 1) { pagina = Math.max(1, Math.floor(pagina / 2)); seguidas = 0; continue; }
    if (error) throw new Error('Supabase ' + tabla + ': no se pudo leer (fila ' + n + '): ' + causa);
    if (code !== 200) throw new Error('Supabase ' + tabla + ' HTTP ' + code + (codPg ? ' (' + codPg + ')' : ''));
    var filas = JSON.parse(res.getContentText() || '[]');
    if (!Array.isArray(filas)) throw new Error('Supabase ' + tabla + ': respuesta inesperada');
    n += filas.length;
    if (cols.length > 1) filas.forEach(function (r) { max = regMasReciente_(max, r[cols[0]]); });
    if (filas.length) { var u = filas[filas.length - 1]; ultima = cols.map(function (c) { return u[c]; }); }
    if (op.alPagina) op.alPagina(filas); else out = out.concat(filas);
    if (filas.length < lim) return fin(true);
    // Tras 4 páginas buenas seguidas vuelve a crecer (un corte de red pasajero no deja la página chica toda la tabla).
    if (++seguidas >= 4 && pagina < paginaMax) { pagina = Math.min(paginaMax, pagina * 2); seguidas = 0; }
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
/** Fecha LOCAL (Ciudad de México) de una marca de tiempo de la base ('2026-10-12T02:00:00+00:00' → '2026-10-11'); las
 *  fechas sin hora se toman tal cual. */
function regFechaLocal(v) {
  var s = regTexto(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && /(Z|[+-]\d{2}(:?\d{2})?)$/.test(s)) {
    var t = Date.parse(s.replace(' ', 'T'));
    if (!isNaN(t)) return new Date(t + REG_UTC_OFFSET_MIN * 60000).toISOString().slice(0, 10);
  }
  return regFecha(s);
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

// ─── WinLab (copia de la lógica de la app, index.html: buildWinlabLabSnapshots / buildWinlabCultures) ───────────
// Cada fila de winlab_labs trae TODOS los reportes de la búsqueda por apellido (también de homónimos) y se vuelve a
// guardar cada día. Un reporte es del paciente si su encabezado trae el nombre completo del censo («full»), o si el
// encabezado trae menos nombres de pila pero el robot ya lo validó por nombre y edad (__target, «partial»). Blobs viejos
// sin encabezados son de un solo paciente. Mantener SINCRONIZADO con index.html (_winlabNormalizeName y vecinas).
function regWlNorm(name) {
  if (!name) return [];
  var s = String(name).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, ' ').replace(/[^A-Z\s]/g, ' ')
    .replace(/\bMA\b/g, 'MARIA').replace(/\bJ\b/g, 'JOSE').replace(/\bGPE\b/g, 'GUADALUPE');
  return s.split(/\s+/).filter(function (w) {
    if (w.length < 3) return false;
    return ['DEL', 'LAS', 'LOS', 'CON', 'SIN', 'POR', 'PARA', 'Y', 'O'].indexOf(w) < 0;
  });
}
function regWlJaro(a, b) {
  if (a === b) return 1;
  var la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  var dist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  var ma = new Array(la).fill(false), mb = new Array(lb).fill(false), matches = 0;
  for (var i = 0; i < la; i++) {
    var lo = Math.max(0, i - dist), hi = Math.min(i + dist + 1, lb);
    for (var j = lo; j < hi; j++) { if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; matches++; break; } }
  }
  if (!matches) return 0;
  var t = 0, k = 0;
  for (var x = 0; x < la; x++) { if (!ma[x]) continue; while (!mb[k]) k++; if (a[x] !== b[k]) t++; k++; }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}
function regWlJW(a, b) {
  var j = regWlJaro(a, b); if (j < 0.7) return j;
  var p = 0, l = Math.min(4, a.length, b.length);
  while (p < l && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}
function regWlTokenIgual(t1, t2) {
  if (t1 === t2) return true;
  if (t1.length >= 5 && t2.length >= 5) return regWlJW(t1, t2) >= 0.88;
  return false;
}
function regWlCoinciden(n1, n2) {
  var w1 = regWlNorm(n1), w2 = regWlNorm(n2);
  if (!w1.length || !w2.length) return 0;
  var used = new Array(w2.length).fill(false), common = 0;
  for (var i = 0; i < w1.length; i++) {
    for (var j = 0; j < w2.length; j++) { if (!used[j] && regWlTokenIgual(w1[i], w2[j])) { used[j] = true; common++; break; } }
  }
  return common;
}
function regWlEncabezado(paciente, rep, tokens) {
  if (!tokens || !tokens.length) return 'full';
  var h = ((rep['APELLIDOS COMPLETOS'] || '') + ' ' + (rep.NOMBRE || '')).trim();
  if (regWlCoinciden(paciente, h) >= tokens.length) return 'full';
  var hTok = regWlNorm(h);
  if (hTok.length >= 3 && regWlCoinciden(h, paciente) >= hTok.length) return 'partial';
  return false;
}
function regWlEsFecha(s) { return /^\s*\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/.test(String(s || '')); }
function regWlEsEncabezado(rep) {
  return !!(rep && rep.__hasLink === false && rep.NOMBRE && !regWlEsFecha(rep.NOMBRE) && rep['APELLIDOS COMPLETOS'] && !regWlEsFecha(rep['APELLIDOS COMPLETOS']));
}
/** Reportes con valores que son del paciente de la fila: [{ rep, atribucion, encabezado }]. */
function regWlDelPaciente(fila) {
  var reps = regArr(fila && fila.reportes), out = [];
  var tokens = regWlNorm(fila && fila.paciente);
  var hayEnc = reps.some(regWlEsEncabezado);
  var cur = (!hayEnc || !tokens.length) ? 'full' : false, enc = '';
  reps.forEach(function (rep) {
    if (!rep || typeof rep !== 'object') return;
    if (hayEnc && regWlEsEncabezado(rep)) { cur = regWlEncabezado(fila.paciente, rep, tokens); enc = ((rep['APELLIDOS COMPLETOS'] || '') + ' ' + (rep.NOMBRE || '')).trim(); return; }
    if (!Array.isArray(rep.valores) || !rep.valores.length) return;
    if (!cur) return;                                       // reporte de OTRO paciente del mismo apellido
    if (cur === 'partial' && rep.__target !== true) return; // encabezado con menos nombres: solo si el robot lo validó
    var atribucion = !hayEnc ? 'Sin encabezado (búsqueda de un solo paciente)' : !tokens.length ? 'Sin nombre de búsqueda'
      : cur === 'partial' ? 'Encabezado parcial validado por el robot (nombre y edad)'
      : (rep.__target === true ? 'Encabezado con el nombre completo; validado por el robot' : 'Encabezado con el nombre completo');
    out.push({ rep: rep, atribucion: atribucion, encabezado: hayEnc ? enc : '' });
  });
  return out;
}
/** 'DD/MM/YYYY HH:MM' → 'YYYY-MM-DD HH:MM' (o 'YYYY-MM-DD'); '' si no es fecha. */
function regWlFechaHora(s) {
  var m = /^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return '';
  return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + (m[4] ? ' ' + ('0' + m[4]).slice(-2) + ':' + m[5] : '');
}
/** Identidad y datos de un reporte: __cells = [.., .., folio, toma, resultado, servicio]. */
function regWlReporte(rep) {
  var cells = Array.isArray(rep.__cells) ? rep.__cells.map(function (c) { return regTexto(c).trim(); }) : [];
  var clave = cells.length ? cells.filter(Boolean).join(' | ') : JSON.stringify([rep.NOMBRE, rep['APELLIDOS COMPLETOS'], rep['CODIGO PACIENTE'], rep.SEXO]);
  return {
    clave: clave, folio: cells[2] || regTexto(rep['CODIGO PACIENTE']),
    toma: regWlFechaHora(cells[3]) || regWlFechaHora(rep['APELLIDOS COMPLETOS']),
    resultado: regWlFechaHora(cells[4]) || regWlFechaHora(rep.NOMBRE),
    servicio: regTexto(rep.SEXO) || (cells.length ? cells[cells.length - 1] : '')
  };
}
/** Un renglón por valor: «[sección] ESTUDIO: valor unidad (ref. …)». */
function regWlValores(rep) {
  return regArr(rep.valores).map(function (v) {
    if (!v || typeof v !== 'object') return '';
    var est = regTexto(v.estudio || v.nombre).trim(), val = regTexto(v.valor).trim();
    if (!est && !val) return '';
    if (regEsArchivo(val)) val = '[archivo]';
    var sec = regTexto(v.seccion).trim(), uni = regTexto(v.unidad).trim(), ref = regTexto(v.referencia).trim();
    return (sec ? '[' + sec + '] ' : '') + est + ': ' + val + (uni ? ' ' + uni : '') + (ref ? ' (ref. ' + ref + ')' : '');
  }).filter(Boolean).join('\n');
}
// Cultivos: copia de extractWinlabCulture / _cultFromPdf de la app.
var REG_WL_ORG = /\b(escherichia|klebsiella|candida|staphylococ\w*|streptococ\w*|pseudomonas|enterococ\w*|acinetobacter|proteus|enterobacter|serratia|morganella|citrobacter|stenotrophomonas|salmonella|shigella|haemophilus|providencia)\b/i;
var REG_WL_NEG = /sin\s+desarrollo|no\s+desarrollo|sin\s+crecimiento|desarrollo\s+negativo/i;
var REG_WL_POS = /\bPOSITIV[OA]\b|\bDESARROLLO\s+DE\b|\bSE\s+AISL/i;
function regWlAntibiograma(ab) {
  var list = regArr(ab).filter(function (a) { return a && a.antibiotico; });
  var fmt = function (a) { return a.antibiotico + (a.cim ? ' ' + a.cim : ''); };
  return {
    sensibles: list.filter(function (a) { return a.interp === 'S' || a.interp === 'SDD'; }).map(fmt),
    intermedios: list.filter(function (a) { return a.interp === 'I'; }).map(fmt),
    resistentes: list.filter(function (a) { return a.interp === 'R'; }).map(fmt)
  };
}
function regWlCultivosPdf(rep) {
  var c = rep && rep.cultivo; if (!c || typeof c !== 'object') return null;
  var texto = regTexto(rep.cultivo_texto);
  var secs = Array.isArray(c.secciones) && c.secciones.length ? c.secciones : [{
    tipo: c.tipo, muestra: c.muestra, resultado: c.resultado, detalle: '',
    germenes: regArr(c.germenes).map(function (g) { return { nombre: String(g), flags: [], ufc: c.ufc || '', antibiograma: [] }; }),
    antibiograma: c.antibiograma || []
  }];
  return secs.map(function (s) {
    var germs = regArr(s.germenes).filter(function (g) { return g && g.nombre; }).map(function (g) {
      var l = regWlAntibiograma(g.antibiograma);
      return { nombre: g.nombre, flags: Array.isArray(g.flags) ? g.flags : [], ufc: g.ufc || '', sensibles: l.sensibles, intermedios: l.intermedios, resistentes: l.resistentes };
    });
    var pos = s.resultado === 'POSITIVO';
    var pend = s.resultado === 'PENDIENTE' || s.resultado === 'SIN MUESTRA';
    var organismo = pos ? (germs.map(function (g) { return g.nombre + (g.flags.length ? ' (' + g.flags.join(', ') + ')' : ''); }).join(' + ') || 'POSITIVO (germen en el reporte)')
      : (s.resultado === 'SIN MUESTRA' ? 'Sin muestra' : (pend ? 'En proceso' : ('Sin desarrollo' + (s.detalle && /\d/.test(s.detalle) ? ' (' + s.detalle + ')' : ''))));
    var l2 = regWlAntibiograma(s.antibiograma);
    var unir = function (k) { return l2[k].concat.apply(l2[k], germs.map(function (g) { return g[k]; })); };
    return {
      tipo: s.tipo || c.tipo || 'Cultivo', organismo: organismo, muestra: s.muestra || '', positivo: pos, pendiente: pend, detalle: s.detalle || '',
      ufc: (germs.map(function (g) { return g.ufc; }).filter(Boolean)[0]) || '', sensibles: unir('sensibles'), intermedios: unir('intermedios'), resistentes: unir('resistentes'),
      texto: texto, fuente: 'PDF del reporte'
    };
  });
}
function regWlCultivos(rep) {
  if (!rep) return [];
  var pdf = regWlCultivosPdf(rep); if (pdf) return pdf;
  if (!Array.isArray(rep.valores)) return [];
  var isCult = false, organismo = '', muestra = '', neg = false, pos = false, negDias = '';
  rep.valores.forEach(function (v) {
    if (!v) return;
    var est = String(v.estudio || v.nombre || ''), ref = String(v.referencia || ''), val = String(v.valor || ''), uni = String(v.unidad || ''), sec = String(v.seccion || '');
    var cultRow = /cultivo/i.test(est) || /cultivo/i.test(sec);
    var orgHit = REG_WL_ORG.test(val) ? val : (REG_WL_ORG.test(ref) ? ref : (REG_WL_ORG.test(est) ? est : ''));
    if (cultRow || orgHit) {
      isCult = true;
      if (!muestra) muestra = sec.trim();
      if (!organismo && orgHit) organismo = orgHit.trim();
      if (REG_WL_NEG.test(val) || REG_WL_NEG.test(ref) && !/POSITIV/i.test(val)) neg = true;
      if (REG_WL_POS.test(val)) pos = true;
    }
    if (/^NEGATIVO\s+A\b/i.test(est) || (/NEGATIV/i.test(est) && /DIAS?/i.test(uni))) { isCult = true; neg = true; if (/^\d+$/.test(val.trim())) negDias = val.trim(); }
  });
  if (!isCult) return [];
  if (organismo) pos = true;
  if (pos) neg = false;
  if (!organismo && !neg && !pos) return [];
  if (pos && !organismo) organismo = 'POSITIVO (germen/antibiograma en el reporte)';
  if (neg && negDias) negDias = ' a ' + negDias + ' días';
  var hay = rep.valores.map(function (v) { return ((v && v.estudio) || '') + ' ' + ((v && v.seccion) || ''); }).join(' ').toUpperCase();
  var muUp = String(muestra || '').toUpperCase();
  var tipo = /PLEURAL/.test(muUp) ? 'Cultivo líquido pleural'
    : /PERITONEAL/.test(muUp) ? 'Cultivo líquido peritoneal'
    : /HEMOCULTIVO/.test(hay) ? 'Hemocultivo'
    : /UROCULTIVO/.test(hay) ? 'Urocultivo'
    : /PLEURAL/.test(hay) ? 'Cultivo líquido pleural'
    : /PERITONEAL/.test(hay) ? 'Cultivo líquido peritoneal'
    : /HERIDA|SECRECION/.test(hay) ? 'Cultivo de herida/secreción'
    : 'Cultivo';
  return [{ tipo: tipo, organismo: organismo || ('Sin desarrollo' + (negDias || '')), muestra: muestra || '', positivo: !!pos, pendiente: false, detalle: '',
    ufc: '', sensibles: [], intermedios: [], resistentes: [], texto: '', fuente: 'Tabla del reporte' }];
}
/** Acumula filas de winlab_labs (en orden de captura) en { labs: {clave: renglón}, cultivos: {clave: renglón} }: un
 *  renglón por reporte del paciente (la captura más nueva con más valores manda) y uno por muestra de cultivo (la del
 *  PDF manda sobre la de la tabla). */
function regWlAcumular(acc, filas) {
  regArr(filas).forEach(function (f) {
    if (!f) return;
    var exp = regTexto(f.exp).trim();
    regWlDelPaciente(f).forEach(function (x) {
      var rep = x.rep, r = regWlReporte(rep), k = exp + REG_SEP + r.clave;
      var nVal = regArr(rep.valores).length, prev = acc.labs[k];
      if (!prev || nVal >= prev.__n) {
        acc.labs[k] = { 'Expediente': exp, 'Paciente': regTexto(f.paciente), 'Nombre en WinLab': x.encabezado, 'Atribución': x.atribucion, 'Reporte': r.clave,
          'Folio': r.folio, 'Toma': r.toma, 'Resultado': r.resultado, 'Servicio': r.servicio, 'Estudios': nVal, 'Valores': regWlValores(rep), 'Capturado': regTexto(f.scraped_at), __n: nVal };
      }
      var cults = regWlCultivos(rep);
      if (!cults.length) return;
      var pdf = cults[0].fuente === 'PDF del reporte', yaPdf = acc.cultivosPdf && acc.cultivosPdf[k];
      if (yaPdf && !pdf) return;
      acc.cultivosPdf = acc.cultivosPdf || {};
      if (pdf) acc.cultivosPdf[k] = true;
      Object.keys(acc.cultivos).forEach(function (ck) { if (ck.indexOf(k + REG_SEP) === 0) delete acc.cultivos[ck]; });
      cults.forEach(function (c, i) {
        var res = c.positivo ? 'POSITIVO' : (c.pendiente ? (c.organismo === 'Sin muestra' ? 'Sin muestra' : 'En proceso') : 'Negativo');
        acc.cultivos[k + REG_SEP + (i + 1)] = { 'Expediente': exp, 'Paciente': regTexto(f.paciente), 'Reporte': r.clave, 'N': i + 1, 'Toma': r.toma, 'Tipo': c.tipo, 'Muestra': c.muestra,
          'Resultado': res, 'Germen': c.positivo ? c.organismo : '', 'Sensibles': c.sensibles.join(', '), 'Intermedios': c.intermedios.join(', '), 'Resistentes': c.resistentes.join(', '),
          'UFC': c.ufc, 'Detalle': c.positivo ? c.detalle : (c.detalle || (c.pendiente ? '' : c.organismo)), 'Fuente': c.fuente, 'Texto del reporte': c.texto, 'Atribución': x.atribucion, 'Capturado': regTexto(f.scraped_at) };
      });
    });
  });
  return acc;
}

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
      agregar(id, { id: id, p: p, n: previo ? regUnirNotas(nd, previo.n) : nd, estado: 'Egresado', motivo: motivo, egreso: regFecha(nd0._egresoFecha) || regFechaLocal(a.archived_at), fuente: 'Papelera (archive)' });
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

    // Labs: una fila por fecha y estudio; sin los PDF incrustados ni las marcas internas (fecha_labs, hora_labs, _…).
    var fechasLab = [];
    labsH.forEach(function (e) {
      if (!e) return;
      var f = regFecha(e.fecha) || regTexto(e.fecha);
      var origen = typeof e.source === 'string' ? e.source : (typeof e.origen === 'string' ? e.origen : '');
      var hubo = false;
      Object.keys(regObj(e.labs)).forEach(function (k) {
        var v = e.labs[k];
        if (/^(fecha_labs|hora_labs)$|^_/.test(k)) return;
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
  // WinLab: ya acumulado por regWlAcumular (un renglón por reporte del paciente y uno por muestra de cultivo).
  var wl = datos.winlab || {};
  Object.keys(regObj(wl.labs)).forEach(function (k) { fila('Labs del robot (WinLab)', wl.labs[k]); });
  Object.keys(regObj(wl.cultivos)).forEach(function (k) { fila('Cultivos del robot (WinLab)', wl.cultivos[k]); });
  regArr(datos.ris).forEach(function (r) {
    if (!r || r.id === undefined || r.id === null) return;
    fila('Imagen del robot (RIS)', { 'ID': regTexto(r.id), 'ID episodio': regTexto(r.patient_id), 'Expediente': regTexto(r.exp), 'Paciente': regTexto(r.paciente), 'Fecha': regTexto(r.fecha), 'Hora': regTexto(r.hora), 'Modalidad': regTexto(r.modalidad), 'Estudios': regTexto(r.estudios), 'Crítico': regSiNo(r.critico), 'Estado del reporte': regTexto(r.reporte_estado), 'Reporte': regTexto(r.reporte), 'Enlace del reporte': /^https?:\/\//i.test(regTexto(r.reporte_url)) ? regTexto(r.reporte_url) : '', 'Capturado': regTexto(r.scraped_at) });
  });
  return out;
}

// ─── Fusión con lo que ya está en la hoja (nunca se borra) ───────────────────────────────────────────────────────
function regClaveDe(fila, cfg) { return cfg.clave.map(function (c) { return regTexto(fila[c]).trim(); }).join(REG_SEP); }

/** Junta lo de la hoja (`viejas`, objetos por columna, en su orden, con su renglón __fila) con lo de hoy (`nuevas`): la
 *  fila con la misma clave se reemplaza por la de hoy (en el mismo renglón); las que hoy no vienen se conservan (en modo
 *  'vigente', marcadas «No» si su episodio sí está hoy en la base; en 'pacientes', «Salió de la base…» si seguían
 *  hospitalizadas). Nunca devuelve menos filas (claves distintas) de las que había. */
function regFusionar(viejas, nuevas, cfg, episodiosHoy, hoy, relacion) {
  var hoyPorClave = {}, ordenHoy = [];
  nuevas.forEach(function (r) { var k = regClaveDe(r, cfg); if (!hoyPorClave[k]) ordenHoy.push(k); hoyPorClave[k] = r; });
  var out = [], vistas = {}, nViejas = 0;
  viejas.forEach(function (r) {
    var k = regClaveDe(r, cfg);
    if (vistas[k]) return;
    vistas[k] = true; nViejas++;
    if (hoyPorClave[k]) { var h = Object.assign({}, hoyPorClave[k]); if (r.__fila) h.__fila = r.__fila; out.push(h); return; }
    var c = Object.assign({}, r);
    if (cfg.modo === 'pacientes' && c['Estado en registro'] === 'Hospitalizado') c['Estado en registro'] = 'Salió de la base sin egreso registrado';
    if (cfg.modo === 'vigente' && episodiosHoy && episodiosHoy[regTexto(c['ID episodio'])]) c['Vigente'] = 'No';
    out.push(c);
  });
  ordenHoy.forEach(function (k) { if (!vistas[k]) { vistas[k] = true; var h = Object.assign({}, hoyPorClave[k]); delete h.__fila; out.push(h); } });
  if (out.length < nViejas) throw new Error('Registro: la pestaña ' + cfg.nombre + ' quedaría con menos filas; no se escribe.');
  if (cfg.modo === 'pacientes' && relacion) out = out.map(function (r) {
    var rel = relacion[regTexto(r['ID episodio'])];
    if (!rel || r['Episodio relacionado'] === rel) return r;
    var c = Object.assign({}, r); c['Episodio relacionado'] = rel; return c;
  });
  return out;
}

// ─── Hoja ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Filas de la pestaña como objetos por nombre de columna, cada una con su renglón (__fila), y si el encabezado es
 *  exactamente el de esta versión (si no, se reescribe la pestaña entera para alinearla). Si tiene datos pero le falta
 *  una columna de la clave (se renombró el encabezado), se detiene: escribir sin leerla bien borraría su historia. */
function regLeerPestana_(hoja, cfg) {
  var n = hoja.getLastRow(), m = hoja.getLastColumn();
  if (n < 1 || m < 1) return { filas: [], porFila: {}, encabezadoOk: false };
  var vals = hoja.getRange(1, 1, n, m).getValues();
  var enc = vals[0].map(function (h) { return regTexto(h).trim(); });
  var conDatos = vals.slice(1).some(function (f) { return f.some(function (v) { return regTexto(v).trim(); }); });
  if (conDatos && cfg.clave.some(function (c) { return enc.indexOf(c) === -1; })) {
    throw new Error('La pestaña «' + cfg.nombre + '» no tiene la columna «' + cfg.clave.filter(function (c) { return enc.indexOf(c) === -1; })[0] + '» en la fila 1: no se actualizó nada para no perder datos (regrese el encabezado).');
  }
  var filas = [], porFila = {};
  vals.slice(1).forEach(function (fila, i) {
    var o = {};
    enc.forEach(function (h, j) { if (h && o[h] === undefined) o[h] = fila[j]; });
    if (!regClaveDe(o, cfg).replace(new RegExp(REG_SEP, 'g'), '').trim()) return;
    o.__fila = i + 2; porFila[i + 2] = o; filas.push(o);
  });
  return { filas: filas, porFila: porFila, encabezadoOk: cfg.columnas.every(function (c, i) { return enc[i] === c; }) };
}
/** Texto para una celda (la columna es de texto plano: no se interpreta como fórmula ni fecha), recortado al límite. */
function regCelda(v) {
  if (typeof v === 'number') return v;
  var s = regTexto(v);
  if (s.length > REG_MAX_CELDA) s = s.slice(0, REG_MAX_CELDA) + ' …[recortado]';
  return s;
}
function regAsegurarFilas_(hoja, n) { if (hoja.getMaxRows() < n) hoja.insertRowsAfter(hoja.getMaxRows(), n - hoja.getMaxRows()); }
function regEscribirBloques_(hoja, fila, datos, nc) {
  for (var i = 0; i < datos.length; i += REG_BLOQUE) {
    var b = datos.slice(i, i + REG_BLOQUE);
    hoja.getRange(fila + i, 1, b.length, nc).setNumberFormat('@').setValues(b);
  }
}
/** Pestaña nueva: sin las columnas vacías de sobra (Sheets crea 26 y cuentan para el límite de celdas). */
function regAjustarColumnas_(hoja, nc) { if (hoja.getMaxColumns() > nc) hoja.deleteColumns(nc + 1, hoja.getMaxColumns() - nc); }
/** Escribe solo lo que cambió: las filas cuya clave ya estaba se actualizan en su renglón si algo cambió y las nuevas
 *  se agregan al final. Si el encabezado no es el de esta versión (o hay demasiados cambios sueltos) reescribe toda la
 *  pestaña encima (sin vaciar antes) y limpia solo lo que sobre abajo. Las columnas agregadas a la derecha se respetan. */
function regEscribirPestana_(hoja, columnas, filas, previo) {
  var nc = columnas.length;
  var celdasDe = function (r) { return columnas.map(function (c) { return regCelda(r[c]); }); };
  var igual = function (a, b) { for (var i = 0; i < a.length; i++) { if (String(a[i]) !== String(b[i])) return false; } return true; };
  if (hoja.getMaxColumns() < nc) hoja.insertColumnsAfter(hoja.getMaxColumns(), nc - hoja.getMaxColumns());
  var completo = !previo || !previo.encabezadoOk, cambios = [], nuevas = [];
  if (!completo) {
    filas.forEach(function (r) {
      var c = celdasDe(r);
      if (r.__fila) { var v = previo.porFila[r.__fila]; if (!v || !igual(c, celdasDe(v))) cambios.push([r.__fila, c]); }
      else nuevas.push(c);
    });
    cambios.sort(function (a, b) { return a[0] - b[0]; });
    var bloques = cambios.filter(function (x, i) { return !i || x[0] !== cambios[i - 1][0] + 1; }).length;
    if (bloques > REG_MAX_BLOQUES) completo = true;
  }
  if (completo) {
    var datos = [columnas].concat(filas.map(celdasDe));
    regAsegurarFilas_(hoja, datos.length);
    regEscribirBloques_(hoja, 1, datos, nc);
    var sobra = hoja.getLastRow() - datos.length;
    if (sobra > 0) hoja.getRange(datos.length + 1, 1, sobra, nc).clearContent();
    hoja.setFrozenRows(1);
    return { modo: 'completo', escritas: filas.length };
  }
  for (var i = 0; i < cambios.length;) {
    var j = i;
    while (j + 1 < cambios.length && cambios[j + 1][0] === cambios[j][0] + 1) j++;
    regEscribirBloques_(hoja, cambios[i][0], cambios.slice(i, j + 1).map(function (x) { return x[1]; }), nc);
    i = j + 1;
  }
  if (nuevas.length) {
    var desde = hoja.getLastRow() + 1;
    regAsegurarFilas_(hoja, desde - 1 + nuevas.length);
    regEscribirBloques_(hoja, desde, nuevas, nc);
  }
  return { modo: 'incremental', escritas: cambios.length + nuevas.length };
}
/** Celdas de la cuadrícula de TODAS las hojas del libro (lo que cuenta para el límite de Sheets). */
function regCeldas_(libro) {
  return libro.getSheets().reduce(function (s, h) { return s + h.getMaxRows() * h.getMaxColumns(); }, 0);
}
function regHojaDiccionario_(libro) {
  var hoja = libro.getSheetByName('Diccionario');
  if (!hoja) { hoja = libro.insertSheet('Diccionario'); regAjustarColumnas_(hoja, 2); }
  return hoja;
}
function regEscribirDiccionario_(hoja, hoy, cuentas, celdas, pendiente, avisos) {
  var filas = [
    ['Registro de pacientes', 'Copia diaria de la app y de los robots (Supabase) para estudios. Nunca se borran filas: lo que sale de la base se conserva.'],
    ['Última actualización', hoy],
    ['Conteos', JSON.stringify(cuentas)],
    ['Celdas usadas', String(celdas || 0) + ' de ' + REG_CELDAS_MAX + ' que admite Sheets (' + Math.round(100 * (celdas || 0) / REG_CELDAS_MAX) + '%)' + ((celdas || 0) > REG_CELDAS_AVISO * REG_CELDAS_MAX ? ' — AVISO: hay que pasar lo viejo a un libro histórico.' : '')],
    ['Carga en curso', pendiente ? 'Sí: quedan filas por leer o escribir; sigue en otra vuelta.' : 'No'],
    ['Avisos de la última corrida', (avisos && avisos.length) ? avisos.join('\n') : 'Ninguno'],
    ['Privacidad', 'Contiene nombres y expedientes. Mantener en la carpeta privada; compartir solo como lector y solo con personas autorizadas por el protocolo aprobado por el Comité de Ética en Investigación.'],
    ['ID episodio', 'Id del paciente en la base (una hospitalización). Un reingreso es otro episodio.'],
    ['Estado en registro', 'Hospitalizado (en el censo), Egresado (en la Papelera) o «Salió de la base sin egreso registrado».'],
    ['Motivo de egreso', 'Etiqueta del egreso en la app (ALTA, DEFUNCIÓN, alta médica, EGRESO, CAMA REASIGNADA…).'],
    ['Episodio relacionado', 'Restaurar desde la Papelera crea otro id: «Continúa en …» / «Viene de …» une las dos partes de la misma hospitalización.'],
    ['Fecha de egreso', 'Fecha del egreso en la app o, si no la hay, la fecha (hora de Ciudad de México) en que se archivó.'],
    ['Días de estancia', 'Desde la fecha de ingreso hasta el egreso (o hasta hoy si sigue hospitalizado).'],
    ['Vigente', 'Sí: está en la tarjeta en la última copia. No: estuvo y ya no (corregido, borrado o movido); se conserva.'],
    ['Signos vitales y Notas de evolución', 'La app guarda 14 días de signos y 10 notas; aquí se acumulan todos.'],
    ['Labs del robot (WinLab)', 'Un renglón por reporte de WinLab del paciente (con la misma regla de identidad de la app: encabezado con su nombre o validado por el robot por nombre y edad; nunca de homónimos). Valores: un renglón por estudio «ESTUDIO: valor unidad (ref. …)». Toma y Resultado: fecha y hora del reporte.'],
    ['Cultivos del robot (WinLab)', 'Un renglón por muestra de cultivo de esos reportes: del PDF del reporte cuando el robot lo leyó (germen y antibiograma S/I/R) o de la tabla del reporte.'],
    ['Imagen del robot (RIS)', 'Lo que capturó el robot de RIS, por expediente y episodio.'],
    ['Nota / Checklist completo (JSON)', 'Todo lo demás de la tarjeta, sin archivos incrustados.'],
    ['Respaldo', 'Cada 7 días se guarda una copia de esta hoja en la misma carpeta (las últimas ' + REG_RESPALDOS + ').'],
    ['Cuidado', 'Se pueden agregar columnas a la DERECHA y usar filtros; no insertar columnas en medio ni renombrar la fila 1.']
  ];
  if (hoja.getMaxColumns() < 2) hoja.insertColumnsAfter(hoja.getMaxColumns(), 2 - hoja.getMaxColumns());
  regAsegurarFilas_(hoja, filas.length);
  hoja.getRange(1, 1, filas.length, 2).setNumberFormat('@').setValues(filas.map(function (r) { return [regCelda(r[0]), regCelda(r[1])]; }));
  var sobra = hoja.getLastRow() - filas.length;
  if (sobra > 0) hoja.getRange(filas.length + 1, 1, sobra, 2).clearContent();
}
/** Copia de toda la hoja en su carpeta cada 7 días de calendario, ANTES de escribir (guarda el estado anterior); quedan
 *  las últimas 5. */
function regRespaldoSemanal_(libro, props, hoy) {
  var ultima = regFecha(props.getProperty('REG_ULTIMO_RESPALDO') || '');
  var dias = ultima ? regDias(ultima, hoy) : '';
  if (dias !== '' && dias < REG_RESPALDO_DIAS) return;
  var archivo = DriveApp.getFileById(libro.getId());
  var padres = archivo.getParents();
  if (!padres.hasNext()) return;
  var carpeta = padres.next(), prefijo = 'Respaldo — ' + archivo.getName() + ' — ';
  archivo.makeCopy(prefijo + hoy, carpeta);
  var copias = [], it = carpeta.getFiles();
  while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(prefijo) === 0) copias.push(f); }
  copias.sort(function (a, b) { return b.getName().localeCompare(a.getName()); });
  copias.slice(REG_RESPALDOS).forEach(function (f) { f.setTrashed(true); });
  props.setProperty('REG_ULTIMO_RESPALDO', hoy);
}
