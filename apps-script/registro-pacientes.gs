/**
 * Registro de pacientes para investigación (21 oct 2026): Supabase → Google Sheets, en la cuenta de Google del dueño.
 *
 * Una vez al día copia a una hoja de cálculo privada TODO lo que la app y los robots tienen de cada paciente: el censo
 * (patients + notes), los egresados de la Papelera (archive), el respaldo de la cronología, los reportes y cultivos de
 * WinLab (sacados de winlab_labs con la misma regla de identidad de la app), los estudios de RIS y los procedimientos
 * programados. NUNCA borra: lo que ya no está en la base se conserva (en las pestañas de la tarjeta, marcado «Vigente:
 * No»). UNA sola hoja (27 oct 2026): ya no guarda copias semanales en la carpeta; el respaldo es el historial de
 * versiones de Google Sheets (Archivo → Historial de versiones), y las copias «Respaldo — …» que hizo antes se mandan a la
 * papelera de Drive (30 días para recuperarlas).
 *
 * ANÁLISIS (27 oct 2026): además de la copia fiel, cada noche recalcula desde la hoja las pestañas «Análisis · Episodios /
 * Labs / Signos vitales / Cultivos» para estadística: sin nombres (ID seudónimo con SHA-256 y sal secreta), números como
 * números en las unidades de la app, fechas ISO, reingresos, desenlace con «desconocido» cuando no se registró, y todo lo
 * que no se pudo usar como dato vacío y explicado. Cada columna está en «Diccionario de variables».
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
// Versión de este archivo (27 oct 2026): se reporta a Supabase una vez al día (config «versiones») y el vigilante la
// compara con la del repositorio: si no coinciden, falta pegar esta versión. Cambiarla en cada cambio del archivo.
var REGISTRO_VERSION = '2026.10.28-2';
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
var REG_UTC_OFFSET_MIN = -360;     // America/Mexico_City: UTC-6 todo el año (sin horario de verano desde oct 2022)
var REG_BLOQUE = 4000;             // filas por setValues
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
    'Nota completa (JSON)', 'Checklist completo (JSON)', 'Alta en la app', 'Última modificación en la app', 'Fuente', 'Última vez en la base',
    'Peso (kg)', 'Talla', 'Dx principal', 'CIE-10 (grupo)', 'Dx principal (fuente)'] },
  { nombre: 'Cirugías', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Procedimiento'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Procedimiento', 'Hallazgos', 'Sangrado', 'Cirujano', 'Grupo', 'Fuente', 'Vigente', 'Tipo', 'Abordaje', 'Clavien-Dindo', 'Complicación'] },
  { nombre: 'Labs', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Estudio'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Estudio', 'Valor', 'Origen', 'Vigente', 'Corregido a mano'] },
  { nombre: 'Imagen', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Tipo', 'Descripción'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Tipo', 'Descripción', 'Enlace', 'Vigente'] },
  { nombre: 'Signos vitales', modo: 'acumula', clave: ['ID episodio', 'Fecha'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'FC', 'FR', 'Temp', 'SaO2', 'O2 L/min', 'TA', 'Uresis', 'DxTx', 'IU', 'Balance', 'Horas de uresis'] },
  { nombre: 'Notas de evolución', modo: 'acumula', clave: ['ID episodio', 'Fecha y hora'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha y hora', 'Autor', 'Con IA', 'Texto'] },
  { nombre: 'Guardia y cronología', modo: 'vigente', clave: ['ID episodio', 'Caja', 'Renglón'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Caja', 'Orden', 'Renglón', 'Vigente'] },
  { nombre: 'Procedimientos programados', modo: 'acumula', fuente: 'procedimientos_dia', clave: ['ID'], columnas: ['ID', 'Fecha', 'Cama', 'Expediente', 'Nombre', 'Edad', 'Diagnóstico', 'Especialidad', 'Adscrito', 'Residente', 'Agregado por'] },
  { nombre: 'Labs del robot (WinLab)', modo: 'acumula', fuente: 'winlab_labs', preferirViejo: regWlPreferirViejo, clave: ['Expediente', 'Reporte'], columnas: ['Expediente', 'Paciente', 'Nombre en WinLab', 'Atribución', 'Reporte', 'Folio', 'Toma', 'Resultado', 'Servicio', 'Estudios', 'Valores', 'Capturado'] },
  { nombre: 'Cultivos del robot (WinLab)', modo: 'acumula', fuente: 'winlab_labs', filtrarNuevas: regWlFiltrarCultivos, clave: ['Expediente', 'Reporte', 'N'], columnas: ['Expediente', 'Paciente', 'Reporte', 'N', 'Toma', 'Tipo', 'Muestra', 'Resultado', 'Germen', 'Sensibles', 'Intermedios', 'Resistentes', 'UFC', 'Detalle', 'Fuente', 'Texto del reporte', 'Atribución', 'Capturado'] },
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
        // Si la fuente iba a la mitad de su primera carga, la carga sigue en curso (y se programa otra vuelta).
        if (props.getProperty('REG_SIGUE_' + fuente)) pendiente = true;
        avisos.push('No se pudo leer ' + fuente + ' (' + regCausa_(e) + '): sus pestañas no se tocaron en esta corrida.');
        return [];
      }
    };
    var datos = {};
    datos.patients = leer('patients', 'id,cama,nombre,exp,dx,edad,esp,seccion,adscrito,residente,ingreso,estado,created_at,updated_at', 'id', '', 200);
    datos.notes = leer('notes', 'patient_id,app,pa,drenajes,qx,manejo,sangrado,sv,balance,pendientes,checklist,lab_history,imagen_history,misc,cronologia,updated_at', 'patient_id', '', 20);
    datos.archive = leerCursor('archive', 'id,patient_data,note_data,archived_at', 10);
    // Copias de la Papelera a las que alguien les registró el motivo del egreso después (pueden ser viejas: la ventana de
    // archived_at no las ve). _egreso_tipo_ts es UTC con formato fijo: se compara como texto.
    var ultima = props.getProperty('REG_ULTIMA_CORRIDA') || '';
    var desdeTipo = ultima && !isNaN(Date.parse(ultima)) ? new Date(Date.parse(ultima) - REG_MARGEN_INCREMENTAL_MS).toISOString().slice(0, 19) + 'Z' : '';
    datos.archive = regUnirPorId_(datos.archive, leer('archive', 'id,patient_data,note_data,archived_at', 'id', desdeTipo ? 'note_data->>_egreso_tipo_ts=gte.' + desdeTipo : 'note_data->>_egreso_tipo_ts=not.is.null', 10));
    // TODAS las copias de la Papelera de cada episodio que hoy está en la base (censo o Papelera leída hoy): así la unión
    // de copias no depende de cuáles cayeron en la ventana incremental (si no, lo que solo traía una copia vieja quedaba
    // en blanco o marcado «Vigente: No» al día siguiente).
    datos.archive = regUnirPorId_(datos.archive, regLeerCopias_(leer, regIdsEpisodios_(datos.patients, datos.archive)));
    datos.restauraciones = leer('archive', 'id,de:patient_data->>_supa_id,a:note_data->>_restaurado_a', 'id', 'note_data->>_restaurado_a=not.is.null', 1000);
    datos.cronologias = leer('cronologia_respaldo', 'patient_id,exp,nombre,cronologia,actualizado', 'patient_id', '', 200);
    datos.procedimientos = opcional('procedimientos_dia', function () { return leer('procedimientos_dia', 'id,cama,exp,nombre,edad,dx,esp,adscrito,residente,fecha_dia,added_by', 'id', '', 500); });
    // WinLab: cada fila trae TODOS los reportes de la búsqueda (también de homónimos) y se repite cada día; se procesa
    // página por página (sin guardar el JSON crudo) y queda un renglón por reporte del paciente. La edad y el alias del
    // censo y de la Papelera sirven para aplicar la regla del robot a las capturas que no traen su marca (__target).
    var winlab = { labs: {}, cultivos: {}, contexto: regWlContexto(datos.patients, datos.notes, datos.archive), ambiguos: 0 };
    opcional('winlab_labs', function () {
      return leerCursor('winlab_labs', 'id,exp,paciente,fecha,scraped_at,reportes:data->reportes', 100, function (filas) { regWlAcumular(winlab, filas); });
    });
    datos.winlab = winlab;
    if (winlab.ambiguos) avisos.push('WinLab: ' + winlab.ambiguos + ' reporte(s) de capturas viejas no se copiaron porque hay homónimos con el mismo nombre y no se conoce la edad del paciente.');
    datos.ris = opcional('ris_estudios', function () { return leerCursor('ris_estudios', 'id,patient_id,exp,paciente,fecha,hora,modalidad,estudios,critico,reporte_estado,reporte,reporte_url,scraped_at', 200); });
    var nuevo = regConstruir(datos, hoy);
    try { regQuitarCopiasViejas_(libro, props); } catch (e) { avisos.push('No se pudieron quitar las copias de respaldo viejas (' + regCausa_(e) + ').'); }
    var cuentas = {}, cortado = false, fusionadas = {};
    // Dentro de una pestaña, ningún setValues empieza después de 5 min 40 s (escribir a medias es seguro: cada fila va a
    // su renglón por clave y la siguiente vuelta completa lo que falte).
    var corte = function () { return transcurrido() > REG_LIMITE_MS + 25000; };
    REG_PESTANAS.forEach(function (cfg) {
      if (cortado) return;
      if (cfg.fuente && omitidas[cfg.fuente]) {
        // No se tocan hoy, pero lo que ya tienen sí cuenta para las pestañas de análisis.
        var h = libro.getSheetByName(cfg.nombre);
        fusionadas[cfg.nombre] = h ? regLeerPestana_(h, cfg).filas : [];
        return;
      }
      if (transcurrido() > REG_LIMITE_MS) { cortado = true; return; }
      var hoja = libro.getSheetByName(cfg.nombre);
      if (!hoja) { hoja = libro.insertSheet(cfg.nombre); regAjustarColumnas_(hoja, cfg.columnas.length); }
      var previo = regLeerPestana_(hoja, cfg);
      var filas = regFusionar(previo.filas, nuevo[cfg.nombre] || [], cfg, nuevo.episodiosHoy, hoy, nuevo.relacion);
      try {
        var r = regEscribirPestana_(hoja, cfg, filas, previo, corte);
        if (r.aviso) avisos.push(r.aviso);
      } catch (e) {
        if (!(e && e.regCorte)) throw e;
        cortado = true; return;
      }
      cuentas[cfg.nombre] = filas.length;
      fusionadas[cfg.nombre] = filas;
    });
    if (cortado) { pendiente = true; avisos.push('Se acabó el tiempo al escribir: lo que faltó se escribe en la siguiente vuelta.'); }
    // Pestañas de análisis (sin nombres, números como números): solo con el registro completo de esta corrida. Si fallan,
    // el registro ya quedó escrito: se avisa y se recalculan en la siguiente corrida.
    else if (transcurrido() > REG_LIMITE_MS) avisos.push('No alcanzó el tiempo para las pestañas de análisis: se actualizan en la siguiente corrida.');
    else {
      try { regEscribirAnalisis_(libro, props, fusionadas, nuevo.restauraciones, hoy, corte, cuentas).forEach(function (a) { avisos.push(a); }); }
      catch (e) {
        if (e && e.regTiempo) throw e;
        avisos.push(e && e.regCorte ? 'Se acabó el tiempo al escribir las pestañas de análisis: se completan en la siguiente corrida.'
          : 'No se pudieron actualizar las pestañas de análisis (' + regCausa_(e) + '): el registro sí quedó escrito.');
      }
    }
    var dic = regHojaDiccionario_(libro), celdas = regCeldas_(libro);
    if (celdas > REG_CELDAS_AVISO * REG_CELDAS_MAX) avisos.push('El registro usa el ' + Math.round(100 * celdas / REG_CELDAS_MAX) + '% de las celdas que admite Sheets: hay que pasar lo viejo a un libro histórico.');
    // Los cursores avanzan solo cuando todo lo leído ya quedó escrito.
    if (!cortado) {
      Object.keys(cursores).forEach(function (t) { regGuardarCursor_(props, t, cursores[t]); });
      props.setProperty('REG_ULTIMA_CORRIDA', new Date(inicio).toISOString());
    }
    if (pendiente) {
      if (!regProgramarContinuacion_(props)) avisos.push('Quedan filas por leer; ya se usaron las ' + REG_CONTINUACIONES_DIA + ' vueltas extra de las últimas 24 h: sigue en la corrida de la noche.');
    } else {
      ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarRegistro') ScriptApp.deleteTrigger(t); });
    }
    var enCurso = pendiente || Object.keys(REG_CURSORES).some(function (t) { return !!props.getProperty('REG_SIGUE_' + t); });
    regEscribirDiccionario_(dic, hoy, cuentas, celdas, enCurso, avisos);
    // Solo conteos y avisos en el registro de ejecución: nada de nombres ni expedientes.
    Logger.log('Registro actualizado ' + hoy + ': ' + JSON.stringify(cuentas) + (avisos.length ? ' · Avisos: ' + avisos.join(' | ') : ''));
    regReportarVersion_(props, key);
    return { ok: true, cuentas: cuentas, pendiente: enCurso, avisos: avisos };
  } finally {
    lock.releaseLock();
  }
}

// Reporta la versión instalada (una vez al día; si falla, se reintenta en la siguiente corrida y nunca detiene el registro).
function regReportarVersion_(props, key) {
  try {
    var marca = REGISTRO_VERSION + '|' + new Date().toISOString().slice(0, 10);
    if (props.getProperty('REG_VERSION_REPORTADA') === marca) return;
    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/pl_reportar_version', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: key, Authorization: 'Bearer ' + key },
      payload: JSON.stringify({ p_pieza: 'registro', p_version: REGISTRO_VERSION })
    });
    if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) props.setProperty('REG_VERSION_REPORTADA', marca);
  } catch (e) { Logger.log('regReportarVersion_: ' + regCausa_(e)); }
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
/** Programa una vuelta extra en 10 min: como mucho REG_CONTINUACIONES_DIA en 24 h corridas (los disparadores de una cuenta
 *  personal tienen 90 min diarios, compartidos con el script del censo, que corre cada 5 min). Nunca deja dos. */
function regProgramarContinuacion_(props) {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarRegistro') ScriptApp.deleteTrigger(t); });
  var ahora = Date.now(), lista = regJson_(props.getProperty('REG_CONTINUACIONES'));
  lista = (Array.isArray(lista) ? lista : []).filter(function (t) { return typeof t === 'number' && ahora - t < 86400000 && t <= ahora; });
  if (lista.length >= REG_CONTINUACIONES_DIA) { props.setProperty('REG_CONTINUACIONES', JSON.stringify(lista)); return false; }
  ScriptApp.newTrigger('continuarRegistro').timeBased().after(10 * 60 * 1000).create();
  lista.push(ahora);
  props.setProperty('REG_CONTINUACIONES', JSON.stringify(lista));
  return true;
}
/** Ids de episodio que hoy están en la base: los del censo y los de las copias de la Papelera leídas hoy. */
function regIdsEpisodios_(patients, archive) {
  var ids = {};
  regArr(patients).forEach(function (p) { if (p && p.id) ids[regTexto(p.id)] = true; });
  regArr(archive).forEach(function (a) { var id = regTexto(a && regObj(a.patient_data)._supa_id); if (id) ids[id] = true; });
  return Object.keys(ids);
}
/** Todas las copias de la Papelera de esos episodios, de 20 en 20 ids por petición (UrlFetchApp no acepta URLs de más
 *  de 2 KB: 20 uuid entre comillas, codificados, son ~0.9 KB). */
function regLeerCopias_(leer, ids) {
  var out = [];
  for (var i = 0; i < ids.length; i += 20) {
    var lista = ids.slice(i, i + 20).map(function (id) { return '"' + String(id).replace(/"/g, '') + '"'; }).join(',');
    out = out.concat(leer('archive', 'id,patient_data,note_data,archived_at', 'id', 'patient_data->>_supa_id=in.(' + lista + ')', 10));
  }
  return out;
}
function regUnirPorId_(a, b) {
  var ya = {}, out = [];
  regArr(a).concat(regArr(b)).forEach(function (x) { if (x && !ya[x.id]) { ya[x.id] = true; out.push(x); } });
  return out;
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
    // El error de JSON.parse de V8 cita un pedazo del texto (podría traer datos): se reemplaza por uno sin contenido.
    var filas;
    try { filas = JSON.parse(res.getContentText() || '[]'); } catch (_) { throw new Error('Supabase ' + tabla + ': la respuesta no es JSON válido (fila ' + n + ')'); }
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

// ─── WinLab: identidad con la regla del ROBOT (copia de rpa/lib.js: normNameTokens, patientHeaderMatchKind,
// findSexIdx, extractHeaderName, extractHeaderBirthDate, ageFromBirthDate, parseCensusAge, sameBirthdayOtherYear,
// possiblySameWinlabPerson, looksLikeReportLinkRow, selectTargetRows; mantener SINCRONIZADO) ───────────────────────
// Cada fila de winlab_labs trae TODOS los reportes de la búsqueda por apellido (también de homónimos) y se vuelve a
// guardar cada día. Desde el 9 oct 2026 el robot marca con __target los reportes del paciente (nombre, alias, edad,
// homónimos): esa marca manda. Las capturas anteriores no la traen: se les aplica la misma regla del robot con la edad
// y el alias del censo o de la Papelera. Encabezados en español o italiano (se leen de __cells: APELLIDOS, NOMBRE,
// SEXO, NACIMIENTO). Precisión > recall: si hay homónimos y no se conoce la edad, esos reportes no se copian.
function regWlTokens(name) {
  if (!name) return [];
  var s = String(name).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\./g, ' ').replace(/[^A-Z\s]/g, ' ')
    .replace(/\bMA\b/g, 'MARIA').replace(/\bJ\b/g, 'JOSE').replace(/\bGPE\b/g, 'GUADALUPE')
    .replace(/\bFCO\b/g, 'FRANCISCO').replace(/\bFCA\b/g, 'FRANCISCA');
  return s.split(/\s+/).filter(function (w) { return w.length >= 3 && ['DEL', 'LAS', 'LOS', 'CON', 'SIN', 'POR', 'PARA', 'Y', 'O'].indexOf(w) < 0; });
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
/** ANTONIO/ANTONIA, MARIO/MARIA: difieren solo en la vocal final A/O → personas distintas. */
function regWlVarianteGenero(t1, t2) {
  if (t1.length !== t2.length || t1.length < 4) return false;
  var a = t1[t1.length - 1], b = t2[t2.length - 1];
  return a !== b && 'AO'.indexOf(a) >= 0 && 'AO'.indexOf(b) >= 0 && t1.slice(0, -1) === t2.slice(0, -1);
}
function regWlTokenIgual(t1, t2) {
  if (t1 === t2) return true;
  if (regWlVarianteGenero(t1, t2)) return false;
  if (t1.length >= 5 && t2.length >= 5) return regWlJW(t1, t2) >= 0.88;
  return false;
}
function regWlTodosEn(needles, haystack) {
  var used = new Array(haystack.length).fill(false);
  for (var i = 0; i < needles.length; i++) {
    var hit = false;
    for (var j = 0; j < haystack.length; j++) { if (!used[j] && regWlTokenIgual(needles[i], haystack[j])) { used[j] = true; hit = true; break; } }
    if (!hit) return false;
  }
  return true;
}
/** 'full': todos los nombres del censo están en el encabezado; 'partial': el encabezado (≥ 3 tokens) está todo en el censo. */
function regWlCoincide(encabezado, nombre) {
  var t = regWlTokens(nombre), h = regWlTokens(encabezado);
  if (!t.length || !h.length) return '';
  if (regWlTodosEn(t, h)) return 'full';
  return h.length >= 3 && regWlTodosEn(h, t) ? 'partial' : '';
}
var REG_WL_SEXO = /^(FEMENIN[OA]|MASCULIN[OA]|FEMMIN[A-Z]*|MASCHI[A-Z]*|FEMALE|MALE|DONNA|UOMO|MUJER|HOMBRE|[FM])$/;
function regWlIdxSexo(cells) {
  if (!Array.isArray(cells)) return -1;
  for (var i = 0; i < cells.length; i++) { if (REG_WL_SEXO.test(String(cells[i] || '').toUpperCase().trim())) return i; }
  // Idioma desconocido: celda corta alfabética seguida de la fecha de nacimiento y precedida por dos celdas de nombre.
  for (var k = 2; k < cells.length - 1; k++) {
    var s = String(cells[k] || '').trim();
    if (!s || s.length > 12 || !/^[A-Za-zÀ-ÿ]+$/.test(s)) continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(cells[k + 1] || '').trim())) continue;
    if (!/^[A-ZÁÉÍÓÚÜÑ' .-]{2,}$/i.test(String(cells[k - 1] || '').trim()) || !/^[A-ZÁÉÍÓÚÜÑ' .-]{2,}$/i.test(String(cells[k - 2] || '').trim())) continue;
    return k;
  }
  return -1;
}
function regWlNombreEncabezado(cells) {
  var sx = regWlIdxSexo(cells);
  return sx >= 2 && cells[sx - 2] ? String(cells[sx - 2]) + ' ' + String(cells[sx - 1] || '') : '';
}
function regWlNacimiento(cells) {
  var sx = regWlIdxSexo(cells);
  if (sx < 0) return '';
  var m = String(cells[sx + 1] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[0] : '';
}
function regWlEdadDe(ddmmyyyy, hoy) {
  var m = String(ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  var d = +m[1], mo = +m[2], y = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  var age = hoy.getUTCFullYear() - y, tm = hoy.getUTCMonth() + 1, td = hoy.getUTCDate();
  if (tm < mo || (tm === mo && td < d)) age--;
  return age >= 0 && age <= 120 ? age : null;
}
/** Edad del censo en años ('52', '52a', '52 años'); meses, días u otro formato → null (desconocida). */
function regWlEdadCenso(edad) {
  var s = String(edad === null || edad === undefined ? '' : edad).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  var m = s.match(/^(\d{1,3})\s*(A|ANOS|ANO|Y)?\.?$/);
  return m ? parseInt(m[1], 10) : null;
}
function regWlMismoCumple(a, b) {
  var ma = String(a || '').match(/^(\d{2}\/\d{2})\/(\d{4})$/), mb = String(b || '').match(/^(\d{2}\/\d{2})\/(\d{4})$/);
  return !!(ma && mb && ma[1] === mb[1] && ma[2] !== mb[2] && ma[1] !== '01/01');
}
function regWlMismaPersona(a, b) {
  if (!a || !b || String(a.label || '') !== String(b.label || '')) return false;
  var fa = String(a.fnac || ''), fb = String(b.fnac || '');
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fa) || !/^\d{2}\/\d{2}\/\d{4}$/.test(fb)) return true;
  return fa === fb || regWlMismoCumple(fa, fb);
}
function regWlEsReporte(cells) {
  return Array.isArray(cells) && cells.some(function (c) { var s = String(c === null || c === undefined ? '' : c).trim(); return !!s && (/\b\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\b/.test(s) || /(^|\D)\d{8,}(\D|$)/.test(s)); });
}
/** selectTargetRows del robot. paciente = { nombre, edad, alias }; hoy = fecha de la captura (para la edad). Devuelve
 *  { idx: {i: encabezado}, parcial, multi, edadConocida }. */
function regWlObjetivo(rows, paciente, hoy) {
  var tolerancia = 2, edadCenso = regWlEdadCenso(paciente && paciente.edad);
  var alias = String((paciente && paciente.alias) || '').trim(), blocks = [], cur = null;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {}, cells = row.__cells, hdr = regWlNombreEncabezado(cells);
    if (hdr) {
      var sxi = regWlIdxSexo(cells);
      var label = sxi >= 2 ? String(cells[sxi - 2] || '').trim() + ', ' + String(cells[sxi - 1] || '').trim() : hdr;
      var kN = regWlCoincide(hdr, paciente && paciente.nombre), kA = alias ? regWlCoincide(hdr, alias) : '';
      var full = kN === 'full' || kA === 'full', nameOk = full || !!kN || !!kA;
      var fnac = regWlNacimiento(cells);
      var hdrAge = nameOk && edadCenso !== null ? regWlEdadDe(fnac, hoy) : null;
      cur = { hdr: hdr, label: label.toUpperCase(), fnac: fnac, nameOk: nameOk, partial: nameOk && !full,
        ageOk: !(nameOk && hdrAge !== null && Math.abs(hdrAge - edadCenso) > tolerancia), links: [] };
      blocks.push(cur);
    }
    if (row.__hasLink && regWlEsReporte(cells) && cur) cur.links.push(i);
  }
  if (blocks.some(function (b) { return b.nameOk && !b.partial; })) blocks.forEach(function (b) { if (b.partial) b.nameOk = false; });
  var nameBlocks = blocks.filter(function (b) { return b.nameOk; }), multi = false;
  for (var x = 0; x < nameBlocks.length && !multi; x++) for (var y = x + 1; y < nameBlocks.length; y++) if (!regWlMismaPersona(nameBlocks[x], nameBlocks[y])) { multi = true; break; }
  if (!multi) nameBlocks.forEach(function (b) { if (!b.partial) b.ageOk = true; });
  var accepted = blocks.filter(function (b) { return b.nameOk && b.ageOk; });
  blocks.forEach(function (b) {
    if (!b.nameOk || b.ageOk) return;
    if (accepted.some(function (a) { return a.label === b.label && regWlMismoCumple(a.fnac, b.fnac); })) b.ageOk = true;
  });
  var idx = {}, parcial = false, primero = true;
  blocks.forEach(function (b) {
    if (!b.nameOk || !b.ageOk) return;
    b.links.forEach(function (i) { idx[i] = b.hdr; });
    if (primero) { parcial = !!b.partial; primero = false; }
  });
  return { idx: idx, parcial: parcial, multi: multi, edadConocida: edadCenso !== null };
}
/** Edad y alias por expediente (censo y Papelera) para aplicar la regla del robot a capturas sin __target. */
function regWlContexto(patients, notes, archive) {
  var porExp = {}, aliasPorId = {};
  var poner = function (exp, edad, alias) {
    exp = regTexto(exp).trim(); if (!exp) return;
    var c = porExp[exp] || (porExp[exp] = { edad: '', alias: '' });
    if (regTexto(edad).trim()) c.edad = regTexto(edad).trim();
    if (regTexto(alias).trim()) c.alias = regTexto(alias).trim();
  };
  regArr(notes).forEach(function (n) { if (n && n.patient_id) aliasPorId[n.patient_id] = regObj(n.checklist).winlab_alias; });
  regArr(archive).slice().sort(function (a, b) { return regTexto(a && a.archived_at).localeCompare(regTexto(b && b.archived_at)); }).forEach(function (a) {
    if (!a) return;
    var pd = regObj(a.patient_data), ck = regObj(regObj(a.note_data).checklist);
    poner(pd.exp, pd.edad, ck.winlab_alias);
  });
  regArr(patients).forEach(function (p) { if (p) poner(p.exp, p.edad, aliasPorId[p.id]); });
  return porExp;
}
/** Reportes con valores del paciente de la fila: [{ rep, atribucion, encabezado }]. */
function regWlDelPaciente(fila, contexto, acc) {
  var reps = regArr(fila && fila.reportes), out = [];
  var conMarca = reps.some(function (r) { return r && r.__target === true; });
  var enc = '', idx = null, info = null;
  if (!conMarca) {
    var ctx = regObj(regObj(contexto)[regTexto(fila && fila.exp).trim()]);
    var hoy = new Date(Date.parse(regTexto(fila && fila.scraped_at)) || Date.parse(regTexto(fila && fila.fecha)) || Date.now());
    info = regWlObjetivo(reps, { nombre: fila && fila.paciente, edad: ctx.edad, alias: ctx.alias }, hoy);
    idx = info.idx;
  }
  reps.forEach(function (rep, i) {
    if (!rep || typeof rep !== 'object') return;
    var h = regWlNombreEncabezado(rep.__cells); if (h) enc = h;
    if (!Array.isArray(rep.valores) || !rep.valores.length) return;
    if (conMarca) {
      if (rep.__target === true) out.push({ rep: rep, atribucion: 'Marcado por el robot al capturar (nombre, alias y edad)', encabezado: enc });
      return;
    }
    if (!(i in idx)) return;
    if (info.multi && !info.edadConocida) { if (acc) acc.ambiguos = (acc.ambiguos || 0) + 1; return; }   // homónimos sin edad: no se puede decidir
    out.push({ rep: rep, atribucion: 'Regla del robot aplicada por el registro (captura sin marca; ' + (info.parcial ? 'encabezado con menos nombres, validado por edad' : 'nombre completo') + (info.multi ? ', homónimos separados por edad' : '') + ')', encabezado: idx[i] });
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
    clave: clave, folio: cells[2] || regTexto(rep['CODIGO PACIENTE'] || rep.CODICEPAZIENTE),
    toma: regWlFechaHora(cells[3]) || regWlFechaHora(rep['APELLIDOS COMPLETOS']),
    resultado: regWlFechaHora(cells[4]) || regWlFechaHora(rep.NOMBRE),
    servicio: cells.length ? cells[cells.length - 1] : regTexto(rep.SEXO)
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
// Cultivos: copia de extractWinlabCulture / _cultFromPdf de la app (index.html).
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
    // Antibiograma: el de cada germen (con varios germenes, con su nombre: un antibiótico puede ser S para uno y R para
    // otro); el de la sección solo si ningún germen trae el suyo (no se suman: el robot repite la lista en los dos).
    var conLista = germs.filter(function (g) { return g.sensibles.length || g.intermedios.length || g.resistentes.length; });
    var lista = function (k) {
      if (!conLista.length) return regWlAntibiograma(s.antibiograma)[k];
      if (conLista.length === 1) return conLista[0][k];
      return conLista.filter(function (g) { return g[k].length; }).map(function (g) { return g.nombre + ': ' + g[k].join(', '); });
    };
    return {
      tipo: s.tipo || c.tipo || 'Cultivo', organismo: organismo, muestra: s.muestra || '', positivo: pos, pendiente: pend, detalle: s.detalle || '',
      ufc: (germs.map(function (g) { return g.ufc; }).filter(Boolean)[0]) || '', sensibles: lista('sensibles'), intermedios: lista('intermedios'), resistentes: lista('resistentes'),
      separador: conLista.length > 1 ? ' | ' : ', ', texto: texto, fuente: 'PDF del reporte'
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
    ufc: '', sensibles: [], intermedios: [], resistentes: [], separador: ', ', texto: '', fuente: 'Tabla del reporte' }];
}
/** Acumula filas de winlab_labs (en orden de captura) en acc = { labs: {clave: renglón}, cultivos: {clave: renglón},
 *  contexto }: un renglón por reporte del paciente (la captura con más valores manda; empate: la más nueva) y uno por
 *  muestra de cultivo (la del PDF manda sobre la de la tabla). Entre corridas, lo mismo lo cuida regFusionar. */
function regWlAcumular(acc, filas) {
  acc.labs = acc.labs || {}; acc.cultivos = acc.cultivos || {}; acc.cultivosPdf = acc.cultivosPdf || {};
  regArr(filas).forEach(function (f) {
    if (!f) return;
    var exp = regTexto(f.exp).trim();
    regWlDelPaciente(f, acc.contexto, acc).forEach(function (x) {
      var rep = x.rep, r = regWlReporte(rep), k = exp + REG_SEP + r.clave;
      var nVal = regArr(rep.valores).length, prev = acc.labs[k];
      if (!prev || nVal >= prev['Estudios']) {
        acc.labs[k] = { 'Expediente': exp, 'Paciente': regTexto(f.paciente), 'Nombre en WinLab': x.encabezado, 'Atribución': x.atribucion, 'Reporte': r.clave,
          'Folio': r.folio, 'Toma': r.toma, 'Resultado': r.resultado, 'Servicio': r.servicio, 'Estudios': nVal, 'Valores': regWlValores(rep), 'Capturado': regTexto(f.scraped_at) };
      }
      var cults = regWlCultivos(rep);
      if (!cults.length) return;
      var pdf = cults[0].fuente === 'PDF del reporte';
      if (acc.cultivosPdf[k] && !pdf) return;
      if (pdf) acc.cultivosPdf[k] = true;
      Object.keys(acc.cultivos).forEach(function (ck) { if (ck.indexOf(k + REG_SEP) === 0) delete acc.cultivos[ck]; });
      cults.forEach(function (c, i) {
        var res = c.positivo ? 'POSITIVO' : (c.pendiente ? (c.organismo === 'Sin muestra' ? 'Sin muestra' : 'En proceso') : 'Negativo');
        acc.cultivos[k + REG_SEP + (i + 1)] = { 'Expediente': exp, 'Paciente': regTexto(f.paciente), 'Reporte': r.clave, 'N': i + 1, 'Toma': r.toma, 'Tipo': c.tipo, 'Muestra': c.muestra,
          'Resultado': res, 'Germen': c.positivo ? c.organismo : '', 'Sensibles': c.sensibles.join(c.separador), 'Intermedios': c.intermedios.join(c.separador), 'Resistentes': c.resistentes.join(c.separador),
          'UFC': c.ufc, 'Detalle': c.positivo ? c.detalle : (c.detalle || (c.pendiente ? '' : c.organismo)), 'Fuente': c.fuente, 'Texto del reporte': c.texto, 'Atribución': x.atribucion, 'Capturado': regTexto(f.scraped_at) };
      });
    });
  });
  return acc;
}
/** Entre corridas: una captura de WinLab con menos valores no pisa el renglón que ya tiene más (empate: la nueva). */
function regWlPreferirViejo(viejo, nuevo) {
  var a = Number(regTexto(viejo['Estudios'])), b = Number(regTexto(nuevo['Estudios']));
  return !isNaN(a) && !isNaN(b) && a > b;
}
/** Entre corridas: si un reporte ya tiene su cultivo del PDF en la hoja, las filas de hoy que solo vienen de la tabla
 *  de ese reporte no se escriben (pisarían el germen y el antibiograma con «POSITIVO»). */
function regWlFiltrarCultivos(viejas, nuevas) {
  var conPdf = {};
  regArr(viejas).forEach(function (r) { if (regTexto(r['Fuente']) === 'PDF del reporte') conPdf[regTexto(r['Expediente']).trim() + REG_SEP + regTexto(r['Reporte']).trim()] = true; });
  return regArr(nuevas).filter(function (r) { return !(r['Fuente'] === 'Tabla del reporte' && conPdf[regTexto(r['Expediente']).trim() + REG_SEP + regTexto(r['Reporte']).trim()]); });
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
      var motivo = REG_EGRESO_APP[regTexto(nd0._egreso_tipo)] ? REG_EGRESO_APP[regTexto(nd0._egreso_tipo)] + ' (registrado en la app)'
        : regTexto(nd0._egreso || (/^(ALTA|DEFUNCI[OÓ]N)$/i.test(regTexto(pd.estado)) ? pd.estado : '') || 'EGRESO');
      var egreso = regFecha(nd0._egresoFecha) || regFechaLocal(a.archived_at);
      var previo = episodios[id];
      // Una copia técnica más nueva (rescate de cambios sin subir, cama reasignada a otra persona, borrado en la base) no
      // tapa el motivo ni la fecha del egreso real que dejó una copia anterior (27 oct 2026: para estudios).
      if (previo && regEgresoPeso(motivo, pd.estado) < regEgresoPeso(previo.motivo, previo.p.estado)) { motivo = previo.motivo; egreso = previo.egreso; }
      var p = previo ? Object.assign({}, previo.p) : {};
      Object.keys(pd).forEach(function (k) { if (!regVacio(pd[k])) p[k] = pd[k]; });
      agregar(id, { id: id, p: p, n: previo ? regUnirNotas(nd, previo.n) : nd, estado: 'Egresado', motivo: motivo, egreso: egreso, fuente: 'Papelera (archive)' });
    });
  // En el censo ahora: el censo manda; lo que traiga la Papelera del mismo id rellena lo que le falte.
  regArr(datos.patients).forEach(function (p) {
    if (!p || !p.id) return;
    if (!regTexto(p.nombre).trim() && !regTexto(p.exp).trim()) return;
    var id = regTexto(p.id), previo = episodios[id];
    agregar(id, { id: id, p: p, n: previo ? regUnirNotas(regObj(notasPorId[p.id]), previo.n) : regObj(notasPorId[p.id]), estado: 'Hospitalizado', motivo: '', egreso: '', fuente: 'Censo (patients)' });
  });
  // Restaurar desde la Papelera crea otro id: «Episodio relacionado» une las dos partes de la misma hospitalización.
  var relacion = {}, restauraciones = [];
  regArr(datos.restauraciones).forEach(function (r) {
    var de = regTexto(r && r.de), a = regTexto(r && r.a);
    if (!de || !a || de === a) return;
    relacion[de] = 'Continúa en ' + a;
    relacion[a] = 'Viene de ' + de;
    restauraciones.push([de, a]);
  });
  var out = { episodiosHoy: {}, relacion: relacion, restauraciones: restauraciones };
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

    // Cirugías: la caja Cirugías manda; lo que no esté ahí se toma de donde sí está marcado (28 oct 2026, pedido del servicio):
    // fecha POP de la tarjeta, texto Qx de la caja anterior, Cronología («pasa a quirófano…»), DX («PO LAPE 25/10») y la
    // programación del día. Cada fila dice su «Fuente» y su «Grupo»; no se repite una cirugía que ya está en la caja.
    var cxs = regArr(ck.cirugias).filter(function (c) { return c && (regTexto(c.procedimiento).trim() || regTexto(c.fecha).trim() || regTexto(c.hallazgos).trim()); });
    var cronoCx = regLineas(n.cronologia).concat(regLineas(cronoPorId[id])).concat(regLineas(n.entrega || meta.entrega));
    var cxTodas = regCirugias({ caja: cxs, qx: regTexto(n.qx), sangrado: regTexto(n.sangrado), qxFecha: regTexto(ck.qx_fecha), dx: regTexto(n.dx || p.dx), crono: cronoCx,
      programadas: regProgramadasDe(datos.procedimientos, p, ingreso, ep.egreso || hoy), ingreso: ingreso, fin: ep.egreso || hoy });
    cxTodas.forEach(function (c) {
      fila('Cirugías', con({ 'Fecha': c.fecha, 'Procedimiento': c.proc, 'Hallazgos': c.hallazgos, 'Sangrado': c.sangrado, 'Cirujano': c.cirujano, 'Grupo': c.grupo, 'Fuente': c.fuente, 'Vigente': 'Sí',
        'Tipo': c.tipo || '', 'Abordaje': c.abordaje || '', 'Clavien-Dindo': c.clavien || '', 'Complicación': c.complicacion || '' }));
    });

    // Labs: una fila por fecha y estudio; sin los PDF incrustados ni las marcas internas (fecha_labs, hora_labs, _…).
    var fechasLab = [];
    labsH.forEach(function (e) {
      if (!e) return;
      var f = regFecha(e.fecha) || regTexto(e.fecha);
      var origen = typeof e.source === 'string' ? e.source : (typeof e.origen === 'string' ? e.origen : '');
      var hubo = false, manual = regObj(e.manual_by);
      // Corrección a mano desde la app (✏️ Corregir, 28 oct 2026): quién, cuándo y qué decía antes.
      var corregido = function (k) { var m = regObj(manual[k]); return Object.keys(m).length ? ['Sí', regTexto(m.u), regTexto(m.t).slice(0, 16).replace('T', ' '), regTexto(m.antes) ? 'antes: ' + regTexto(m.antes) : ''].filter(function (x) { return x.trim(); }).join(' · ') : ''; };
      Object.keys(regObj(e.labs)).forEach(function (k) {
        var v = e.labs[k];
        if (/^(fecha_labs|hora_labs)$|^_/.test(k)) return;
        if (v === null || v === undefined || regTexto(v).trim() === '' || regEsArchivo(v)) return;
        fila('Labs', con({ 'Fecha': f, 'Estudio': k, 'Valor': regTexto(v), 'Origen': origen, 'Vigente': 'Sí', 'Corregido a mano': corregido(k) })); hubo = true;
      });
      regArr(e.extra).forEach(function (x) {
        if (!x || typeof x !== 'object') return;
        var k = regTexto(x.nombre || x.name || x.label || x.k || x.estudio), v = x.valor !== undefined ? x.valor : (x.value !== undefined ? x.value : x.v);
        if (!k || v === undefined || regTexto(v).trim() === '' || regEsArchivo(v)) return;
        fila('Labs', con({ 'Fecha': f, 'Estudio': k, 'Valor': regTexto(v), 'Origen': origen, 'Vigente': 'Sí', 'Corregido a mano': '' })); hubo = true;
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
    if (regTexto(ck.pm_fecha).trim()) signos.push({ fecha: ck.pm_fecha, fc: ck.pm_fc, fr: ck.pm_fr, temp: ck.pm_temp, sao2: ck.pm_sao2, o2l: ck.pm_o2l, ta: ck.pm_ta, uresis: ck.pm_uresis, uresis_h: ck.pm_uresis_h, dxtx: ck.pm_dxtx, iu: ck.pm_iu, balance: ck.pm_balance });
    signos.forEach(function (s) {
      if (!s || !regFecha(s.fecha)) return;
      var vals = ['fc', 'fr', 'temp', 'sao2', 'o2l', 'ta', 'uresis', 'dxtx', 'iu', 'balance', 'uresis_h'].map(function (k) { return regTexto(s[k]); });
      if (!vals.some(function (v) { return v.trim(); })) return;
      fila('Signos vitales', con({ 'Fecha': regFecha(s.fecha), 'FC': vals[0], 'FR': vals[1], 'Temp': vals[2], 'SaO2': vals[3], 'O2 L/min': vals[4], 'TA': vals[5], 'Uresis': vals[6], 'DxTx': vals[7], 'IU': vals[8], 'Balance': vals[9], 'Horas de uresis': vals[10] }));
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
    var dxP = regDxPrincipal(ck.dx_cat, regTexto(p.dx) || regTexto(n.dx));

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
      'Cirugías (resumen)': cxTodas.map(function (c) { return [c.fecha, c.proc, REG_CX_DIRECTAS.indexOf(c.fuente) === -1 ? '[' + c.fuente + ']' : ''].filter(Boolean).join(' '); }).join(' | '),
      'Imagen (resumen)': resumenImg.join(' | '), 'Labs (fechas)': fechasLab.sort().join(', '),
      'Guardia vigente': entrega, 'Cronología': crono.join('\n'), 'Misceláneo': regTexto(n.misc),
      'Nota completa (JSON)': regJsonLimpio(n, ['checklist', 'labHistory', 'lab_history', 'imagenHistory', 'imagen_history', 'body_diagram_ant', 'body_diagram_post']),
      'Checklist completo (JSON)': regJsonLimpio(ck, ['__pl_note_meta', 'cirugias', 'pm_hist', 'nota_hist', '__ink']),
      'Alta en la app': regTexto(p.created_at), 'Última modificación en la app': regTexto(n.updated_at || p.updated_at), 'Fuente': ep.fuente, 'Última vez en la base': hoy,
      'Peso (kg)': regTexto(ck.pm_peso), 'Talla': regTexto(ck.pm_talla),
      'Dx principal': dxP.label, 'CIE-10 (grupo)': dxP.cie, 'Dx principal (fuente)': dxP.fuente
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
  if (cfg.filtrarNuevas) nuevas = cfg.filtrarNuevas(viejas, nuevas);
  var hoyPorClave = {}, ordenHoy = [];
  nuevas.forEach(function (r) { var k = regClaveDe(r, cfg); if (!hoyPorClave[k]) ordenHoy.push(k); hoyPorClave[k] = r; });
  var out = [], vistas = {}, nViejas = 0;
  viejas.forEach(function (r) {
    var k = regClaveDe(r, cfg);
    if (vistas[k]) return;
    vistas[k] = true; nViejas++;
    if (hoyPorClave[k] && !(cfg.preferirViejo && cfg.preferirViejo(r, hoyPorClave[k]))) { var h = Object.assign({}, hoyPorClave[k]); if (r.__fila) h.__fila = r.__fila; out.push(h); return; }
    if (hoyPorClave[k]) { out.push(Object.assign({}, r)); return; }
    var c = Object.assign({}, r);
    if (cfg.modo === 'pacientes' && c['Estado en registro'] === 'Hospitalizado') c['Estado en registro'] = 'Salió de la base sin egreso registrado';
    if (cfg.modo === 'vigente' && episodiosHoy && episodiosHoy[regTexto(c['ID episodio'])]) c['Vigente'] = 'No';
    // Pestañas de análisis: se recalculan completas; lo que hoy ya no se genera se conserva marcado.
    if (cfg.modo === 'derivada') c['Vigente'] = 'No';
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

// ─── Análisis para investigación (27 oct 2026) ───────────────────────────────────────────────────────────────────
// Las pestañas de arriba son la copia FIEL de la app (texto tal cual, con nombres). Las «Análisis · …» son su versión
// para estadística: se recalculan en cada corrida desde lo que YA está en la hoja (así incluyen a todos los egresados
// de siempre, no solo lo que trae la base hoy), sin nombres ni expedientes (ID seudónimo), con números como números en
// las unidades de la app, fechas ISO (AAAA-MM-DD), códigos fijos y una columna de observaciones con todo lo que no se
// pudo tomar como dato (muestra rechazada, unidad desconocida, valor imposible, texto). Nada se adivina: lo dudoso
// queda vacío y dicho. Una hospitalización restaurada desde la Papelera (otro id en la base) es UN episodio.
var REG_FMT_DEC = '0.0#####', REG_FMT_ENT = '0';
var REG_AN_EPISODIOS = 'Análisis · Episodios', REG_AN_LABS = 'Análisis · Labs', REG_AN_SIGNOS = 'Análisis · Signos vitales', REG_AN_CULTIVOS = 'Análisis · Cultivos';
var REG_AN_RESUMEN = 'Resumen mensual', REG_POR_COMPLETAR = 'Por completar';
var REG_RESUMEN_COLUMNAS = ['Mes', 'Ingresos (n)', 'Egresos (n)', 'Egresos con desenlace conocido (n)', 'Defunciones (n)', 'Mortalidad (%)', 'Egresos sin motivo (n)',
  'Estancia mediana (días)', 'Estancia media (días)', 'Pacientes operados (n)', 'Cirugías (n)', 'Cirugías de urgencia (%)', 'Abordaje laparoscópico (%)', 'Conversiones (n)',
  'Complicación mayor (Clavien ≥ IIIa) (n)', 'Reintervenciones (n)', 'Reingresos a 30 días (n)', 'Reingreso a 30 días (%)', 'Cultivos positivos (n)',
  'Dx principales (más frecuentes)', 'Cirugías por grupo (más frecuentes)', 'Gérmenes (más frecuentes)', 'Ingresos con datos incompletos (n)', 'Vigente'];
var REG_CLAVE = { nombre: 'Clave de seudónimos', modo: 'acumula', clave: ['ID episodio'],
  columnas: ['ID episodio', 'Expediente', 'Nombre', 'ID paciente (análisis)', 'ID episodio (análisis)', 'Identidad del paciente por'] };

// Laboratorio: COPIA de LAB_FIELDS de la app (index.html; la prueba compara clave, unidad, rangos y críticos) con el
// nombre completo para el encabezado. t: 'texto' = cualitativo (la app no le pone rango). extra: claves que la app
// guarda pero no están en su tabla (sin rango; la unidad es la del reporte de WinLab).
var REG_LAB_META = [
  { k: 'hb', n: 'Hemoglobina', u: 'g/dL', lo: 12, hi: 17, cl: 7, ch: 20 },
  { k: 'hct', n: 'Hematocrito', u: '%', lo: 36, hi: 48, cl: 20 },
  { k: 'leucos', n: 'Leucocitos', u: 'k/µL', lo: 4, hi: 10, cl: 2, ch: 30 },
  { k: 'neu_abs', n: 'Neutrófilos absolutos', u: 'k/µL', lo: 1.5, hi: 6.6, cl: 0.5 },
  { k: 'neu_pct', n: 'Neutrófilos', u: '%', lo: 40, hi: 75 },
  { k: 'lin_abs', n: 'Linfocitos absolutos', u: 'k/µL', lo: 1.0, hi: 3.5 },
  { k: 'lin_pct', n: 'Linfocitos', u: '%', lo: 20, hi: 45 },
  { k: 'mon_abs', n: 'Monocitos absolutos', u: 'k/µL', lo: 0.1, hi: 1.0 },
  { k: 'mon_pct', n: 'Monocitos', u: '%', lo: 2, hi: 12 },
  { k: 'eos_abs', n: 'Eosinófilos absolutos', u: 'k/µL', lo: 0, hi: 0.7 },
  { k: 'eos_pct', n: 'Eosinófilos', u: '%', lo: 0, hi: 6 },
  { k: 'bas_abs', n: 'Basófilos absolutos', u: 'k/µL', lo: 0, hi: 0.2 },
  { k: 'bas_pct', n: 'Basófilos', u: '%', lo: 0, hi: 2 },
  { k: 'plaq', n: 'Plaquetas', u: 'k/µL', lo: 100, hi: 400, cl: 50, ch: 1000 },
  { k: 'mcv', n: 'VCM', u: 'fL', lo: 80, hi: 95 },
  { k: 'mch', n: 'HCM', u: 'pg', lo: 27, hi: 31 },
  { k: 'mchc', n: 'CHCM', u: 'g/dL', lo: 32, hi: 36 },
  { k: 'rdw', n: 'RDW', u: '%', lo: 12, hi: 16 },
  { k: 'mpv', n: 'VPM', u: 'fL', lo: 9, hi: 13 },
  { k: 'erit', n: 'Eritrocitos', u: '', extra: true },
  { k: 'glu', n: 'Glucosa', u: 'mg/dL', lo: 70, hi: 110, cl: 50, ch: 400 },
  { k: 'hba1c', n: 'Hemoglobina glucosilada', u: '%', extra: true },
  { k: 'urea', n: 'Urea', u: 'mg/dL', lo: 0, hi: 43 },
  { k: 'bun', n: 'BUN', u: 'mg/dL', lo: 7, hi: 20 },
  { k: 'cr', n: 'Creatinina', u: 'mg/dL', lo: 0, hi: 1.25 },
  { k: 'urico', n: 'Ácido úrico', u: 'mg/dL', lo: 2.5, hi: 7 },
  { k: 'na', n: 'Sodio', u: 'mmol/L', lo: 135, hi: 145, cl: 120, ch: 160 },
  { k: 'k', n: 'Potasio', u: 'mmol/L', lo: 3.5, hi: 5.1, cl: 2.8, ch: 6.0 },
  { k: 'cl', n: 'Cloro', u: 'mmol/L', lo: 98, hi: 107 },
  { k: 'ca', n: 'Calcio', u: 'mg/dL', lo: 8.5, hi: 10.5, cl: 6.5, ch: 13.0 },
  { k: 'mg', n: 'Magnesio', u: 'mg/dL', lo: 1.7, hi: 2.4, cl: 1.0, ch: 4.9 },
  { k: 'p', n: 'Fósforo', u: 'mg/dL', lo: 2.5, hi: 4.5, cl: 1.0 },
  { k: 'alb', n: 'Albúmina', u: 'g/dL', lo: 3.5, hi: 5.0 },
  { k: 'ptot', n: 'Proteínas totales', u: 'g/dL', lo: 6.0, hi: 8.3 },
  { k: 'glob', n: 'Globulinas', u: 'g/dL', lo: 2.0, hi: 3.5 },
  { k: 'pcr', n: 'Proteína C reactiva', u: 'mg/L', lo: 0, hi: 10 },
  { k: 'pct', n: 'Procalcitonina', u: 'ng/mL', lo: 0, hi: 0.5 },
  { k: 'vsg', n: 'VSG', u: 'mm/h', lo: 0, hi: 20 },
  { k: 'lac', n: 'Lactato', u: 'mmol/L', lo: 0, hi: 2, ch: 4 },
  { k: 'tp', n: 'TP', u: 'seg', lo: 11, hi: 14 },
  { k: 'tp_testigo', n: 'TP testigo', u: 'seg', extra: true },
  { k: 'inr', n: 'INR', u: '', lo: 0, hi: 1.2, ch: 3 },
  { k: 'ttp', n: 'TTP', u: 'seg', lo: 25, hi: 35, ch: 100 },
  { k: 'fibrinogeno', n: 'Fibrinógeno', u: 'mg/dL', lo: 200, hi: 400, cl: 100 },
  { k: 'dimero_d', n: 'Dímero D', u: 'ng/mL', lo: 0, hi: 500 },
  { k: 'ast', n: 'AST', u: 'U/L', lo: 0, hi: 40 },
  { k: 'alt', n: 'ALT', u: 'U/L', lo: 0, hi: 40 },
  { k: 'bt', n: 'Bilirrubina total', u: 'mg/dL', lo: 0, hi: 1.2 },
  { k: 'bd', n: 'Bilirrubina directa', u: 'mg/dL', lo: 0, hi: 0.3 },
  { k: 'bi', n: 'Bilirrubina indirecta', u: 'mg/dL', lo: 0, hi: 0.8 },
  { k: 'ggt', n: 'GGT', u: 'U/L', lo: 0, hi: 61 },
  { k: 'fa', n: 'Fosfatasa alcalina', u: 'U/L', lo: 44, hi: 147 },
  { k: 'amilasa', n: 'Amilasa', u: 'U/L', lo: 0, hi: 100 },
  { k: 'lipasa', n: 'Lipasa', u: 'U/L', lo: 0, hi: 60 },
  { k: 'ph', n: 'pH', u: '', lo: 7.35, hi: 7.45, cl: 7.2, ch: 7.6 },
  { k: 'pco2', n: 'pCO2', u: 'mmHg', lo: 35, hi: 45, cl: 20, ch: 70 },
  { k: 'po2', n: 'pO2', u: 'mmHg', lo: 80, hi: 100, cl: 40 },
  { k: 'hco3', n: 'HCO3', u: 'mEq/L', lo: 22, hi: 26, cl: 10, ch: 40 },
  { k: 'be', n: 'Exceso de base', u: 'mEq/L', lo: -2, hi: 2 },
  { k: 'sato2', n: 'SatO2 (gasometría)', u: '%', lo: 95, hi: 100, cl: 85 },
  { k: 'tropI', n: 'Troponina I', u: 'pg/mL', lo: 0, hi: 40, ch: 100 },
  { k: 'tropT', n: 'Troponina T', u: 'ng/mL', lo: 0, hi: 0.014, ch: 0.05 },
  { k: 'ck', n: 'CK', u: 'U/L', lo: 0, hi: 170, ch: 5000 },
  { k: 'ck_mb', n: 'CK-MB', u: 'U/L', lo: 0, hi: 25 },
  { k: 'ldh', n: 'LDH', u: 'U/L', lo: 140, hi: 280 },
  { k: 'bnp', n: 'BNP', u: 'pg/mL', lo: 0, hi: 100 },
  { k: 'nt_probnp', n: 'NT-proBNP', u: 'pg/mL', lo: 0, hi: 125 },
  { k: 'mioglobina', n: 'Mioglobina', u: 'ng/mL', lo: 0, hi: 90 },
  { k: 'ferritina', n: 'Ferritina', u: 'ng/mL', lo: 30, hi: 300 },
  { k: 'colest', n: 'Colesterol total', u: 'mg/dL', lo: 0, hi: 200 },
  { k: 'hdl', n: 'HDL', u: 'mg/dL', lo: 40, hi: 100 },
  { k: 'ldl', n: 'LDL', u: 'mg/dL', lo: 0, hi: 130 },
  { k: 'vldl', n: 'VLDL', u: 'mg/dL', lo: 0, hi: 30 },
  { k: 'trig', n: 'Triglicéridos', u: 'mg/dL', lo: 0, hi: 150, ch: 1000 },
  { k: 'tsh', n: 'TSH', u: 'µUI/mL', lo: 0.4, hi: 4.0 },
  { k: 'ego_color', n: 'Orina: color', u: '', t: 'texto' },
  { k: 'ego_asp', n: 'Orina: aspecto', u: '', t: 'texto' },
  { k: 'ego_dens', n: 'Orina: densidad', u: '', lo: 1.005, hi: 1.030 },
  { k: 'ego_ph', n: 'Orina: pH', u: '', lo: 5, hi: 8 },
  { k: 'ego_leuco', n: 'Orina: leucocitos', u: 'u/µL', lo: 0, hi: 10 },
  { k: 'ego_hem', n: 'Orina: hematíes', u: 'u/µL', lo: 0, hi: 5 },
  { k: 'ego_nitri', n: 'Orina: nitritos', u: '', t: 'texto' },
  { k: 'ego_bact', n: 'Orina: bacterias', u: '', t: 'texto' },
  { k: 'ego_prot', n: 'Orina: proteínas', u: '', t: 'texto' },
  { k: 'ego_glu', n: 'Orina: glucosa', u: '', t: 'texto' }
];
// Claves viejas de la app (antes de la tabla actual) → la de hoy.
var REG_LAB_ALIAS = { neutro_abs: 'neu_abs', neutro_pct: 'neu_pct', linfo_abs: 'lin_abs', linfo_pct: 'lin_pct', mono_abs: 'mon_abs', hcm: 'mch', hto: 'hct', vcm: 'mcv' };
// Claves que no son estudios (identificadores o marcas de la entrada): nunca pasan al análisis.
var REG_LAB_NO_ESTUDIO = /^(paciente|nombre|exp|expediente|cama|fecha_labs|hora_labs|winlab_paciente|edad|sexo)$|^_/i;
// COPIA de LAB_IMPOSIBLE de la app (valores fisiológicamente imposibles en las unidades de la tabla).
var REG_LAB_IMPOSIBLE = { hb: [1, 25], hct: [3, 75], leucos: [0.05, 500], plaq: [1, 3000], na: [90, 200], k: [0.8, 12], cl: [50, 160], cr: [0.05, 40],
  glu: [5, 2500], ca: [2, 25], mg: [0.2, 12], p: [0.2, 25], alb: [0.3, 8], bt: [0, 80], tp: [5, 200], ttp: [10, 300], inr: [0.5, 25], ph: [6.5, 8],
  pco2: [5, 200], hco3: [1, 70], lac: [0, 40], fibrinogeno: [10, 2000] };
var REG_LAB_POR_CLAVE = {};
REG_LAB_META.forEach(function (m) { REG_LAB_POR_CLAVE[m.k] = m; });
function regLabColumna(m) { return m.n + (m.u ? ' (' + m.u + ')' : ''); }
// Resúmenes de laboratorio por episodio: [clave, 'min' | 'max' | 'primero', encabezado].
var REG_LAB_RESUMEN = [
  ['hb', 'min', 'Hb mínima (g/dL)'], ['leucos', 'max', 'Leucocitos máximos (k/µL)'], ['plaq', 'min', 'Plaquetas mínimas (k/µL)'],
  ['cr', 'primero', 'Creatinina inicial (mg/dL)'], ['cr', 'max', 'Creatinina máxima (mg/dL)'], ['na', 'min', 'Sodio mínimo (mmol/L)'],
  ['na', 'max', 'Sodio máximo (mmol/L)'], ['k', 'max', 'Potasio máximo (mmol/L)'], ['glu', 'max', 'Glucosa máxima (mg/dL)'],
  ['alb', 'primero', 'Albúmina inicial (g/dL)'], ['pcr', 'max', 'PCR máxima (mg/L)'], ['pct', 'max', 'Procalcitonina máxima (ng/mL)'],
  ['lac', 'max', 'Lactato máximo (mmol/L)'], ['bt', 'max', 'Bilirrubina total máxima (mg/dL)'], ['inr', 'max', 'INR máximo']
];
// Signos vitales: [clave de la pestaña «Signos vitales», encabezado, mínimo posible, máximo posible, unidades que se
// aceptan escritas después del número, ¿coma de miles?]. Fuera del rango posible → vacío y observación.
var REG_SV = [
  ['FC', 'FC (lpm)', 20, 250, /^(LPM|X'?|POR MIN(UTO)?)$/],
  ['FR', 'FR (rpm)', 4, 80, /^(RPM|X'?|POR MIN(UTO)?)$/],
  ['Temp', 'Temperatura (°C)', 30, 45, /^[°º]?\s*C$|^[°º]$/],
  ['SaO2', 'SaO2 (%)', 30, 100, /^%$/],
  ['O2 L/min', 'O2 (L/min)', 0, 80, /^(L|LT|LTS|LPM|L\/MIN|LITROS?)$/],
  ['Uresis', 'Uresis (mL)', 0, 15000, /^(ML|CC)$/, true],
  ['DxTx', 'Glucemia capilar (mg/dL)', 10, 1500, /^MG(\/DL)?$/],
  ['IU', 'Insulina (UI)', 0, 300, /^(UI|U|UNIDADES)$/],
  ['Balance', 'Balance (mL)', -20000, 20000, /^(ML|CC)$/, true]
];

// ─── Diagnóstico principal de una lista corta y cirugía estructurada (28 oct 2026) ─────────────────────────────────
// La misma tabla que la app (DX_CATS en index.html): clave, nombre, grupo CIE-10 y patrón sobre el DX sin acentos.
var REG_DX_CATS = [
  ['apendicitis', 'Apendicitis aguda', 'K35', /APENDIC/],
  ['colecistitis', 'Colecistitis / colelitiasis', 'K80–K81', /COLECIST|COLELIT|LITIASIS VESICULAR|PIOCOLECIST|HIDROCOLECIST/],
  ['coledoco', 'Coledocolitiasis / colangitis', 'K80.3–K80.5, K83.0', /COLEDOCOLIT|COLANGITIS|ICTERICIA OBSTRUCTIVA/],
  ['pancreatitis', 'Pancreatitis aguda', 'K85', /PANCREATITIS/],
  ['oclusion', 'Oclusión intestinal', 'K56', /OCLUSION|OBSTRUCCION INTESTINAL|VOLVULO|\bBRIDAS\b/],
  ['hernia', 'Hernia de pared', 'K40–K46', /HERNIA|EVENTRACION/],
  ['perforacion', 'Perforación de víscera hueca', 'K25–K28, K63.1', /PERFORAD|PERFORACION|NEUMOPERITONEO/],
  ['diverticulitis', 'Diverticulitis', 'K57', /DIVERTICUL/],
  ['isquemia', 'Isquemia mesentérica', 'K55', /ISQUEMIA (MESENTERICA|INTESTINAL)|TROMBOSIS MESENTERICA/],
  ['hemorragia', 'Hemorragia digestiva', 'K92.2', /\bSTD[AB]\b|SANGRADO DE TUBO|HEMORRAGIA DIGESTIVA|MELENA|HEMATEMESIS|HEMATOQUECIA/],
  ['trauma_abd', 'Trauma abdominal', 'S36', /TRAUMA (CERRADO |PENETRANTE )?(ABDOMINAL|DE ABDOMEN)|\bHPAF\b|\bHPPC\b|HERIDA POR (ARMA|PROYECTIL)|PUNZOCORTANTE/],
  ['trauma_otro', 'Trauma (otro)', 'T14', /TRAUMA|POLICONTUNDID|FRACTURA|\bTCE\b/],
  ['ca_colorrectal', 'Cáncer colorrectal', 'C18–C20', /(\bCA\b|CANCER|ADENOCARCINOMA|TUMOR|NEOPLASIA) (MALIGNA )?(DE |DEL )?(COLON|RECTO|SIGMOIDES|CIEGO|COLORRECTAL|UNION RECTOSIGMOIDEA)/],
  ['ca_gastrico', 'Cáncer gástrico', 'C16', /(\bCA\b|CANCER|ADENOCARCINOMA|TUMOR|NEOPLASIA) (MALIGNA )?(DE |DEL )?(ESTOMAGO|GASTRIC)/],
  ['ca_hbp', 'Cáncer de hígado, vía biliar o páncreas', 'C22–C25', /COLANGIOCARCINOMA|HEPATOCARCINOMA|KLATSKIN|(\bCA\b|CANCER|ADENOCARCINOMA|TUMOR|NEOPLASIA) (MALIGNA )?(DE |DEL )?(LA )?(CABEZA DE )?(PANCREAS|HIGADO|VESICULA|VIA BILIAR|AMPULA)/],
  ['ca_mama', 'Cáncer de mama', 'C50', /(\bCA\b|CANCER|TUMOR|NEOPLASIA) (MALIGNA )?(DE |DEL )?(LA )?MAMA/],
  ['ca_otro', 'Otro cáncer', 'C00–C97', /\bCA\b|CANCER|CARCINOMA|NEOPLASIA|LINFOMA|SARCOMA|MELANOMA|METASTA/],
  ['pie_diabetico', 'Pie diabético', 'E11.5, L97', /PIE DIABETICO/],
  ['anorrectal', 'Anorrectal / pilonidal', 'K60–K64, L05', /HEMORROID|FISTULA (PERIANAL|ANAL)|FISURA ANAL|ABSCESO (PERIANAL|ISQUIORRECTAL|ANORRECTAL)|PILONIDAL/],
  ['absceso_abd', 'Absceso intraabdominal / peritonitis', 'K65, K75.0', /ABSCESO (HEPATICO|INTRAABDOMINAL|RESIDUAL|PELVICO|SUBFRENICO|ESPLENICO)|PERITONITIS|SEPSIS ABDOMINAL/],
  ['tejidos_blandos', 'Infección de piel y tejidos blandos', 'L02–L03, M72.6', /ABSCESO|CELULITIS|FASCITIS|FOURNIER|PIOMIOSITIS|ERISIPELA|INFECCION DE TEJIDOS/],
  ['complicacion_qx', 'Complicación de una cirugía previa', 'T81', /\bFUGA\b|DEHISCENCIA|EVISCERACION|INFECCION DE (SITIO|HERIDA) QUIRURGICA|\bISQ\b|FISTULA (ENTEROCUTANEA|POSTQUIRURGICA)/],
  ['vascular', 'Vascular periférico', 'I70–I74', /ISQUEMIA (ARTERIAL|CRITICA|AGUDA) (DE |DEL )?(MIEMBRO|EXTREMIDAD|PIERNA)|INSUFICIENCIA ARTERIAL|OCLUSION ARTERIAL|ANEURISMA|TROMBOSIS ARTERIAL/],
  ['tiroides', 'Tiroides / paratiroides', 'E04–E05, E21', /TIROID|BOCIO|PARATIROID/],
  ['abdomen_agudo', 'Abdomen agudo en estudio', 'R10.0', /ABDOMEN AGUDO|DOLOR ABDOMINAL/],
  ['otro', 'Otro', '', null]
];
var REG_DX_POR_CLAVE = {}; REG_DX_CATS.forEach(function (c) { REG_DX_POR_CLAVE[c[0]] = c; });
/** Categoría del DX: la que aparece primero en el texto; en empate, la de la lista (lo específico antes que lo genérico). */
function regDxCategoria(dx) {
  var s = regNorm_(dx), mejor = '', pos = Infinity;
  REG_DX_CATS.forEach(function (c) { if (!c[3]) return; var m = c[3].exec(s); if (m && m.index < pos) { pos = m.index; mejor = c[0]; } });
  return mejor;
}
/** Dx principal: el elegido en la app (checklist.dx_cat) o, si no hay, el inferido del DX (marcado). */
function regDxPrincipal(clave, dx) {
  var c = REG_DX_POR_CLAVE[regTexto(clave)];
  if (c) return { label: c[1], cie: c[2], fuente: 'Elegido en la app' };
  c = REG_DX_POR_CLAVE[regDxCategoria(dx)];
  return c ? { label: c[1], cie: c[2], fuente: 'Inferido del DX' } : { label: '', cie: '', fuente: '' };
}
var REG_CX_TIPO_TXT = { urgencia: 'Urgencia', electiva: 'Electiva' };
var REG_CX_ABORDAJE_TXT = { abierta: 'Abierta', laparoscopica: 'Laparoscópica', convertida: 'Convertida (laparoscópica → abierta)', endoscopica: 'Endoscópica / percutánea', otro: 'Otro' };
var REG_CLAVIEN_TXT = { '0': 'Sin complicación', 'I': 'I', 'II': 'II', 'IIIa': 'IIIa', 'IIIb': 'IIIb', 'IVa': 'IVa', 'IVb': 'IVb', 'V': 'V' };
var REG_CLAVIEN_ORDEN = ['Sin complicación', 'I', 'II', 'IIIa', 'IIIb', 'IVa', 'IVb', 'V'];
// Comorbilidades desde APP + DX (28 oct 2026). [columna, patrón sobre el texto sin acentos y en mayúsculas].
var REG_COMORB = [
  ['Diabetes', /\bDIABET|\bDM ?(T ?)?(1|2|I|II)?\b|\bDT ?2\b|\bDMT?2\b|\bDMII\b/],
  ['Hipertensión', /\bHAS\b|\bHTA\b|\bHAS ?SISTEMICA|HIPERTENSION ARTERIAL|\bHIPERTENS[OA]\b/],
  ['Enfermedad renal crónica', /\bERC\b|\bIRC\b|ENFERMEDAD RENAL CRONICA|INSUFICIENCIA RENAL CRONICA|HEMODIALISIS|DIALISIS PERITONEAL|\bTSFR\b|TERAPIA SUSTITUTIVA/],
  ['Cirrosis / hepatopatía crónica', /CIRROSIS|HEPATOPATIA CRONICA|CHILD[- ]PUGH|\bCHILD [ABC]\b/],
  ['Cardiopatía', /CARDIOPATIA|INSUFICIENCIA CARDIACA|\bICC\b|INFARTO (AGUDO )?(DEL |AL )?MIOCARDIO|\bIAM\b|FIBRILACION AURICULAR|\bFANV\b|VALVULOPATIA|\bANGINA\b|STENT CORONARIO|REVASCULARIZACION CORONARIA|MARCAPASOS/],
  ['EPOC / asma', /\bEPOC\b|ENFISEMA|BRONQUITIS CRONICA|\bASMA\b/],
  ['Obesidad', /OBESIDAD|\bOBES[OA]\b/],
  ['Cáncer', /CANCER|\bCA (DE |DEL )?(MAMA|COLON|RECTO|GASTRICO|ESTOMAGO|PANCREAS|CERVICO|CU\b|PROSTATA|PULMON|OVARIO|ENDOMETRIO|TIROIDES|HIGADO|VESICULA|VIAS? BILIAR|ESOFAGO|RINON|VEJIGA|TESTICULO|PIEL)|CARCINOMA|LINFOMA|LEUCEMIA|MIELOMA|SARCOMA|MELANOMA|NEOPLASIA MALIGNA|METASTA|QUIMIOTERAPIA|RADIOTERAPIA/],
  ['Inmunosupresión', /\bVIH\b|\bSIDA\b|TRASPLANT|INMUNOSUPRES|TACROLIMUS|MICOFENOLATO|AZATIOPRINA|CICLOSPORINA|ESTEROIDE[S]? CRONIC|PREDNISONA CRONIC/],
  ['Tabaquismo', /TABAQUISMO|FUMADOR|INDICE TABAQUICO|\bIT ?[:=]? ?\d/]
];
// Negación: «NIEGA…», «… NEGADA», «SIN…», «NO REFIERE…». Un renglón que empieza con negación niega la lista que sigue
// («NIEGA DM, HAS») hasta un dato que la contradice («… EN TRATAMIENTO», «DX HACE 5 AÑOS»).
var REG_NEG = /\bNIEGA|\bNEGAD[OA]S?\b|\bNEGATIV[OA]S?\b|\bNO (REFIERE|PADECE|TIENE|CONOCID)|\bDESCONOCE|^\s*SIN\b|\bINTERROGAD[OA]S? Y NEGAD/;
var REG_AFIRMA = /TRATAMIENTO|\bTX\b|\bDX\b|DIAGNOSTIC|\bHACE\b|\bDESDE\b|CONTROL|\bCON\b|\bEN MANEJO|\d/;
/** Banderas de comorbilidad desde APP y DX: 1 = mencionada; 0 = hay APP y no la menciona (o la niega); '' = sin APP
 *  (el DX solo puede poner 1: casi nunca enlista las comorbilidades). */
function regComorbilidades(app, dx) {
  var texto = [regTexto(app), regTexto(dx)].filter(function (t) { return t.trim(); });
  var out = {}, hayApp = !!regTexto(app).trim();
  REG_COMORB.forEach(function (c) { out[c[0]] = hayApp ? 0 : ''; });
  if (!texto.length) return out;
  texto.join('\n').split(/[.\n;]+/).forEach(function (oracion) {
    var o = regNorm_(oracion);
    if (!o.trim()) return;
    var negando = REG_NEG.test(o.replace(/,.*$/, '')) && /^\s*(NIEGA|NEGAD|NEGATIV|SIN\b|NO\b|INTERROGAD|DESCONOCE|ANTECEDENTES? (PERSONALES )?(PATOLOGICOS )?NEGAD|CRONICO ?DEGENERATIVOS NEGAD|APP:? ?(NIEGA|NEGAD))/.test(o);
    o.split(/,|\bY\b|\bE\b|\//).forEach(function (cl, i) {
      if (!cl.trim()) return;
      var neg = REG_NEG.test(cl), afirma = REG_AFIRMA.test(cl.replace(/\b(DM|DT|DMT|ERC|KDIGO|IT)\s*:?\s*\d+/g, ''));
      if (i > 0 && afirma && !neg) negando = false;
      REG_COMORB.forEach(function (c) {
        if (!c[1].test(cl)) return;
        if (neg || (negando && !afirma)) return;
        out[c[0]] = 1;
      });
    });
  });
  return out;
}
/** Peso (kg, 0.4–400) y talla (m; «165» cm o «1.65» m) de la fila de Pacientes; si las columnas están vacías (filas de
 *  antes del 28 oct 2026) se toman del «Checklist completo (JSON)». */
function regPesoTalla(row) {
  var ck = {};
  try { ck = JSON.parse(regTexto(row && row['Checklist completo (JSON)']) || '{}') || {}; } catch (e) { ck = {}; }
  var p = regNumero(regTexto(row && row['Peso (kg)']).trim() || regTexto(ck.pm_peso), { unidad: /^(KG|KGS|KILOS?)\.?$/ });
  var t = regNumero(regTexto(row && row['Talla']).trim() || regTexto(ck.pm_talla), { unidad: /^(M|MTS?|CM|CMS)\.?$/ });
  var peso = p && !p.comp && p.n >= 0.4 && p.n <= 400 ? p.n : '';
  var talla = '';
  if (t && !t.comp) talla = t.n >= 0.3 && t.n <= 2.5 ? t.n : (t.n >= 30 && t.n <= 250 ? regRedondear(t.n / 100, 2) : '');
  return { peso: peso, talla: talla, imc: peso !== '' && talla !== '' ? regRedondear(peso / (talla * talla), 1) : '' };
}
function regEpisodiosColumnas_() {
  return ['ID episodio', 'ID paciente', 'Partes del registro', 'N.º de episodio del paciente', 'Días desde el egreso previo', 'Es reingreso (≤30 días)', 'Reingreso a 30 días',
    'Edad (años)', 'Sexo', 'Especialidad', 'Sección', 'Fecha de ingreso', 'Fecha de egreso', 'Días de estancia', 'Estado', 'Egreso observado', 'Tipo de egreso',
    'Defunción', 'Motivo de egreso (app)', 'Excluir (duplicado)', 'Diagnóstico', 'Dx principal', 'CIE-10 (grupo)', 'Dx principal (fuente)', 'Peso (kg)', 'Talla (m)', 'IMC (kg/m²)']
    .concat(REG_COMORB.map(function (c) { return c[0]; })).concat(['Comorbilidades (n)', 'Cirugías (n)', 'Primera cirugía', 'Días ingreso a 1.ª cirugía', 'Sangrado total (mL)',
    'Procedimientos', 'Grupo de la 1.ª cirugía', 'Reintervención', 'Cirugías inferidas (n)', 'Programadas sin confirmar (n)',
    'Urgencia (1.ª cirugía)', 'Abordaje (1.ª cirugía)', 'Conversión', 'Clavien-Dindo máximo', 'Complicación mayor (Clavien ≥ IIIa)', 'Cirugías sin clasificar (n)', 'Antibiótico (registrado)', 'NPT (registrada)', 'Ventilación mecánica (registrada)', 'Vasopresor (registrado)', 'Tromboprofilaxis (registrada)',
    'Fechas con labs (n)', 'Valores críticos (n)', 'Índice urinario mínimo (mL/kg/h)', 'Días con oliguria (IU < 0.5)'])
    .concat(REG_LAB_RESUMEN.map(function (r) { return r[2]; }))
    .concat(['Cultivos (n)', 'Cultivos positivos (n)', 'Gérmenes aislados', 'Calidad de datos', 'Vigente']);
}
var REG_EP_ENTEROS = ['Partes del registro', 'N.º de episodio del paciente', 'Días desde el egreso previo', 'Es reingreso (≤30 días)', 'Reingreso a 30 días', 'Días de estancia',
  'Egreso observado', 'Defunción', 'Excluir (duplicado)', 'Cirugías (n)', 'Días ingreso a 1.ª cirugía', 'Reintervención', 'Cirugías inferidas (n)', 'Programadas sin confirmar (n)', 'Antibiótico (registrado)', 'NPT (registrada)',
  'Ventilación mecánica (registrada)', 'Vasopresor (registrado)', 'Tromboprofilaxis (registrada)', 'Fechas con labs (n)', 'Valores críticos (n)', 'Cultivos (n)', 'Cultivos positivos (n)',
  'Comorbilidades (n)', 'Días con oliguria (IU < 0.5)', 'Urgencia (1.ª cirugía)', 'Conversión', 'Complicación mayor (Clavien ≥ IIIa)', 'Cirugías sin clasificar (n)'].concat(REG_COMORB.map(function (c) { return c[0]; }));
function regFormatos_(enteros, decimales) {
  var f = {};
  enteros.forEach(function (c) { f[c] = REG_FMT_ENT; });
  decimales.forEach(function (c) { f[c] = REG_FMT_DEC; });
  return f;
}
var REG_ANALISIS = [
  { nombre: REG_AN_EPISODIOS, modo: 'derivada', clave: ['ID episodio'], columnas: regEpisodiosColumnas_(),
    formatos: regFormatos_(REG_EP_ENTEROS, ['Edad (años)', 'Sangrado total (mL)', 'Peso (kg)', 'Talla (m)', 'IMC (kg/m²)', 'Índice urinario mínimo (mL/kg/h)'].concat(REG_LAB_RESUMEN.map(function (r) { return r[2]; }))) },
  { nombre: REG_AN_LABS, modo: 'derivada', clave: ['ID episodio', 'Fecha'],
    columnas: ['ID episodio', 'ID paciente', 'Fecha', 'Día de estancia', 'Fuente'].concat(REG_LAB_META.map(regLabColumna)).concat(['Otros estudios', 'Valores críticos', 'Observaciones', 'Vigente']),
    formatos: regFormatos_(['Día de estancia'], REG_LAB_META.filter(function (m) { return m.t !== 'texto'; }).map(regLabColumna)) },
  { nombre: REG_AN_SIGNOS, modo: 'derivada', clave: ['ID episodio', 'Fecha'],
    columnas: ['ID episodio', 'ID paciente', 'Fecha', 'Día de estancia'].concat(REG_SV.slice(0, 5).map(function (s) { return s[1]; }))
      .concat(['TA sistólica (mmHg)', 'TA diastólica (mmHg)', 'PAM (mmHg)']).concat(REG_SV.slice(5).map(function (s) { return s[1]; })).concat(['Horas de uresis (h)', 'Índice urinario (mL/kg/h)', 'Observaciones', 'Vigente']),
    formatos: regFormatos_(['Día de estancia'], REG_SV.map(function (s) { return s[1]; }).concat(['TA sistólica (mmHg)', 'TA diastólica (mmHg)', 'PAM (mmHg)', 'Horas de uresis (h)', 'Índice urinario (mL/kg/h)'])) },
  { nombre: REG_AN_CULTIVOS, modo: 'derivada', clave: ['ID cultivo'],
    columnas: ['ID cultivo', 'ID episodio', 'ID paciente', 'Fecha de toma', 'Hora de toma', 'Día de estancia', 'Tipo', 'Muestra', 'Resultado', 'Positivo', 'Germen',
      'Sensibles', 'Intermedios', 'Resistentes', 'UFC', 'Fuente', 'Vigente'],
    formatos: regFormatos_(['Día de estancia', 'Positivo'], []) },
  // Resumen mensual: solo cuentas (sin nombres ni seudónimos).
  { nombre: REG_AN_RESUMEN, modo: 'derivada', clave: ['Mes'], columnas: REG_RESUMEN_COLUMNAS,
    formatos: regFormatos_(REG_RESUMEN_COLUMNAS.filter(function (c) { return / \(n\)$/.test(c); }), REG_RESUMEN_COLUMNAS.filter(function (c) { return /\(%\)$|\(días\)$/.test(c); })) },
  // Por completar: CON NOMBRES (para que el equipo complete la tarjeta). No se comparte.
  { nombre: REG_POR_COMPLETAR, modo: 'derivada', clave: ['ID episodio'],
    columnas: ['ID episodio', 'Estado', 'Cama', 'Nombre', 'Expediente', 'Fecha de ingreso', 'Fecha de egreso', 'Falta', 'Faltantes (n)', 'Vigente'],
    formatos: regFormatos_(['Faltantes (n)'], []) }
];

/** Número de un texto: '7.4', '7,4', '<0.05', '+500', '1,200' (con miles: true), con una unidad permitida al final.
 *  → { n, comp } o null si no es un número limpio (nunca toma el primer número de un texto cualquiera). */
function regNumero(v, op) {
  op = op || {};
  if (typeof v === 'number') return isFinite(v) ? { n: v, comp: '' } : null;
  var s = regTexto(v).trim().toUpperCase();
  if (op.prefijo) s = s.replace(op.prefijo, '').trim();
  var m = /^([<>≤≥])?\s*([+-])?\s*(\d[\d.,]*|[.,]\d+)\s*(.*)$/.exec(s);
  if (!m) return null;
  var resto = m[4].trim();
  if (resto && !(op.unidad && op.unidad.test(resto))) return null;
  var c = m[3];
  if (op.miles && /^\d{1,3}(,\d{3})+$/.test(c)) c = c.replace(/,/g, '');
  else if (/^[1-9]\d{0,2},\d{3}$/.test(c)) return null;   // «1,250»: ¿miles o decimales? No se adivina.
  else if (/^\d+,\d+$/.test(c)) c = c.replace(',', '.');
  else if (/^[.,]\d+$/.test(c)) c = '0.' + c.slice(1);
  if (!/^\d+(\.\d+)?$/.test(c)) return null;
  var n = parseFloat(c);
  if (m[2] === '-') n = -n;
  return isFinite(n) ? { n: n === 0 ? 0 : n, comp: m[1] || '' } : null;
}
/** Días de `desde` a `hasta` (fechas ISO), con signo; '' si falta alguna. */
function regDiasSigno(desde, hasta) {
  var a = regFecha(desde), b = regFecha(hasta);
  if (!a || !b) return '';
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
}
/** Edad en años desde el texto del censo: '34', '34 años', '8 meses' (0.67), '15 días' (0.041); '' si no se entiende. */
function regEdadAnios(v) {
  var s = regTexto(v).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!s) return '';
  var m = /^(\d{1,3}(?:[.,]\d+)?)\s*(A|ANOS?|ANIOS?|Y)?\.?$/.exec(s), n = '';
  if (m) n = parseFloat(m[1].replace(',', '.'));
  else if ((m = /^(\d{1,2})\s*(M|MES|MESES)\.?$/.exec(s))) n = Math.round(parseInt(m[1], 10) / 12 * 100) / 100;
  else if ((m = /^(\d{1,3})\s*(D|DIAS?)\.?$/.exec(s))) n = Math.round(parseInt(m[1], 10) / 365.25 * 1000) / 1000;
  return n !== '' && isFinite(n) && n >= 0 && n <= 120 ? n : '';
}
/** Sexo con la regla de la app (PLCDS.getSex): 'M', 'F' o ''. */
function regSexo(v) {
  var s = regTexto(v).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (['M', 'MASC', 'MASCULINO', 'H', 'HOMBRE', 'VARON'].indexOf(s) >= 0) return 'M';
  if (['F', 'FEM', 'FEMENINO', 'MUJER'].indexOf(s) >= 0) return 'F';
  return '';
}
/** Expediente normalizado como la app (_plExpNorm); '' si no parece un expediente (sin 4 dígitos, o solo ceros). */
function regExpValido(v) {
  var e = regTexto(v).replace(/[\s\-]/g, '').toUpperCase();
  return /\d{4,}/.test(e) && !/^0+$/.test(e) ? e : '';
}
var REG_PARTICULAS = { DE: 1, DEL: 1, LA: 1, LAS: 1, LOS: 1, Y: 1 };
var REG_SIN_NOMBRE = /^(DESCON[A-Z]*|NN|RN|RECIEN|NACID[OA]|IDENTIF[A-Z]*|IGNORAD[OA]|ANONIM[OA]|PACIENTE|MASCULIN[OA]|FEMENIN[OA]|XX+)$/;
function regPalabrasNombre(n) {
  return regTexto(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length >= 2 && !REG_PARTICULAS[w]; });
}
function regUnaLetra(x, y) {
  if (Math.abs(x.length - y.length) > 1) return false;
  var i = 0, j = 0, d = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return d + (x.length - i) + (y.length - j) <= 1;
}
/** ¿Dos nombres con el MISMO expediente pueden ser la misma persona? Todas las palabras del más corto están en el otro
 *  (una sola puede diferir en una letra, si las dos tienen 5 o más). Sin nombre o no identificado (DESCONOCIDO…): sí.
 *  Si no, son dos personas que comparten expediente (error de captura) y tienen ID paciente distinto. */
function regMismaPersona(a, b) {
  var x = regPalabrasNombre(a), y = regPalabrasNombre(b);
  if (!x.length || !y.length) return true;
  var sinNombre = function (w) { return REG_SIN_NOMBRE.test(w); };
  if (x.some(sinNombre) || y.some(sinNombre)) return true;
  var corto = x.length <= y.length ? x : y, largo = (x.length <= y.length ? y : x).slice(), dif = 0;
  return corto.every(function (w) {
    var i = largo.indexOf(w);
    if (i >= 0) { largo.splice(i, 1); return true; }
    if (dif || w.length < 5) return false;
    for (var j = 0; j < largo.length; j++) if (largo[j].length >= 5 && regUnaLetra(w, largo[j])) { largo.splice(j, 1); dif++; return true; }
    return false;
  });
}
/** Tipo de egreso desde la etiqueta de la app y el estado clínico. La mayoría de los egresos salen del censo de la hoja
 *  («RETIRADO DEL CENSO (hoja)», «CAMA REASIGNADA (hoja)») sin decir si fue alta o defunción: «Motivo no registrado». */
// Motivo que una persona registra en la app (Papelera o al dar de alta; función archive_set_egreso de la base).
// 28 oct 2026: + cambio de servicio, contrarreferencia, fuga, otro y «no fue egreso» (aviso discreto de la app).
var REG_EGRESO_APP = { alta: 'Alta a domicilio', defuncion: 'Defunción', cambio_servicio: 'Cambio de servicio', contrarreferencia: 'Contrarreferencia',
  traslado: 'Traslado a otro hospital', alta_voluntaria: 'Alta voluntaria', fuga: 'Fuga / abandono', otro: 'Otro motivo', no_egreso: 'No fue egreso (error del censo)' };
// Tipos con los que el paciente salió VIVO del servicio (Defunción = 0). En «Cambio de servicio» el desenlace posterior en
// el hospital no se conoce: cuenta para la mortalidad del servicio, no para la hospitalaria.
var REG_EGRESO_VIVO = ['Alta', 'Alta voluntaria', 'Traslado', 'Contrarreferencia', 'Cambio de servicio', 'Fuga'];
function regEgresoTipo(motivo, estado) {
  var m = regTexto(motivo).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  var s = m + ' ' + regTexto(estado).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/DUPLICADO/.test(m)) return 'Duplicado (no es otro episodio)';
  if (/BORRADO EN BD/.test(m)) return 'Borrado en la base (revisar)';
  // Copias de rescate («CAMBIOS DE ESTE iPad SIN SUBIR (alta en otro dispositivo)», cama dada a otra persona): no dicen
  // el motivo, aunque la etiqueta traiga la palabra «alta».
  if (/CAMBIOS DE ESTE IPAD|CAMA REASIGNADA \(OTRA PERSONA/.test(m)) return 'Motivo no registrado';
  if (/DEFUNCI|FALLEC/.test(s)) return 'Defunción';
  if (/NO FUE EGRESO/.test(m)) return 'No fue egreso';
  if (/CAMBIO DE SERVICIO/.test(m)) return 'Cambio de servicio';
  if (/CONTRARREFERENCIA/.test(m)) return 'Contrarreferencia';
  if (/FUGA|ABANDONO/.test(m)) return 'Fuga';
  if (/^OTRO MOTIVO/.test(m)) return 'Otro';
  if (/ALTA VOLUNTARIA/.test(s)) return 'Alta voluntaria';
  if (/TRASLADO/.test(s)) return 'Traslado';
  if (/(^|[^A-Z])ALTA([^A-Z]|$)/.test(s)) return 'Alta';
  return 'Motivo no registrado';
}
/** Peso de una etiqueta de egreso entre copias del mismo episodio: una copia técnica (rescate de cambios sin subir,
 *  cama reasignada a otra persona, borrado en la base) nunca tapa el motivo real que dejó otra copia. */
function regEgresoPeso(motivo, estado) {
  var m = regTexto(motivo).toUpperCase();
  if (!m.trim()) return 0;
  if (/\(REGISTRADO EN LA APP\)$/.test(m)) return 4;   // lo eligió una persona (Papelera o al dar de alta): manda
  if (/CAMBIOS DE ESTE IPAD|CAMA REASIGNADA \(OTRA PERSONA|BORRADO EN BD/.test(m)) return 1;
  var t = regEgresoTipo(motivo, estado);
  return (t === 'Motivo no registrado' || t === 'Duplicado (no es otro episodio)') ? 2 : 3;
}
// ─── Cirugías desde donde estén marcadas (28 oct 2026) ───────────────────────────────────────────────────────────────
// Grupo del procedimiento (el orden importa: relaparotomía antes que laparotomía).
var REG_CX_GRUPOS = [
  ['Relaparotomía', /\bRE ?LAPE\b|RELAPAROTOM/],
  ['Laparotomía exploradora', /\bLAPE\b|LAPAROTOMIA/],
  ['Colecistectomía', /COLECISTECTOM|\bCOLE ?LAP\b/],
  ['Apendicectomía', /APENDICECTOM|APENDICETOM/],
  ['Vía biliar (exploración / derivación)', /EXPLORACION DE (LA )?VIAS? BILIAR|COLEDOCOTOM|DERIVACION BILIODIGESTIVA|HEPATICOYEYUNO|COLEDOCOYEYUNO|COLEDOCODUODENO/],
  ['Plastia de pared / hernia', /HERNIOPLAST|HERNIORRAF|EVENTROPLAST|PLASTIA (INGUINAL|UMBILICAL|DE PARED|VENTRAL|INCISIONAL|FEMORAL|EPIGASTRICA)|LICHTENSTEIN|\bRIVES\b|SEPARACION DE COMPONENTES/],
  ['Funduplicatura / hiatoplastia', /FUNDUPLICA|FUNDOPLICA|NISSEN|TOUPET|HIATOPLAST/],
  ['Cirugía gástrica', /GASTRECTOM|GASTROYEYUNO|GASTROSTOM|GASTRORRAF|PILOROPLAST|PARCHE DE GRAHAM|MANGA GASTRICA|BYPASS GASTRICO/],
  ['Resección intestinal', /RESECCION INTESTINAL|ENTERECTOM|RESECCION (DE )?(ILEON|YEYUNO|INTESTINO)|ENTEROENTERO|ENTERORRAF|ADHERENCIOLISIS|LISIS DE ADHERENCIAS/],
  ['Colectomía', /COLECTOM|SIGMOIDECTOM|HARTMANN|PROCTOCOLECTOM|RESECCION ANTERIOR/],
  ['Estoma (formación o cierre)', /ILEOSTOM|COLOSTOM|YEYUNOSTOM|CIERRE DE (ESTOMA|ILEOSTOMIA|COLOSTOMIA)|RESTITUCION (DEL )?TRANSITO/],
  ['Lavado / desbridamiento', /LAVADO (DE CAVIDAD|PERITONEAL|QUIRURGICO)|ASEO QUIRURGICO|DESBRIDAM|DEBRIDA|NECROSECTOM/],
  ['Drenaje de absceso / colección', /DRENAJE (DE |DEL )?(ABSCESO|COLECCION|HEMATOMA|PSEUDOQUISTE)/],
  ['Amputación', /AMPUTACION/],
  ['Cirugía de tórax', /TORACOTOM|TORACOSCOP|DECORTICACION|PLEUROSTOM|LOBECTOM|SONDA ENDOPLEURAL/],
  ['Tiroides / paratiroides', /TIROIDECTOM|PARATIROIDECTOM/],
  ['Esplenectomía', /ESPLENECTOM/],
  ['Páncreas', /PANCREATECTOM|PANCREATODUODENECTOM|WHIPPLE|CISTOYEYUNO|CISTOGASTRO/],
  ['Hígado', /HEPATECTOM|SEGMENTECTOMIA HEPATICA|DESTECHAMIENTO/],
  ['Anorrectal', /HEMORROIDECTOM|FISTULECTOM|FISTULOTOM|ESFINTEROTOM/],
  ['Mama', /MASTECTOM/],
  ['Vascular', /TROMBECTOM|EMBOLECTOM|FASCIOTOM|ANGIOPLAST|BYPASS (FEMORO|AORTO)/],
  ['Traqueostomía', /TRAQUEOSTOM/],
  ['Endoscopia / CPRE', /\bCPRE\b|PANENDOSCOP|COLONOSCOP/],
  ['Laparoscopia', /LAPAROSCOP/]
];
var REG_CX_NO_ESPECIFICADA = 'Cirugía (procedimiento no especificado)';
// Fuentes que son cajas de la app (no inferidas): en el resumen no llevan marca.
var REG_CX_DIRECTAS = ['Caja Cirugías', 'Texto Qx (caja anterior)'];
function regNorm_(t) { return regTexto(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(); }
function regCxGrupo(t) {
  var s = regNorm_(t);
  for (var i = 0; i < REG_CX_GRUPOS.length; i++) if (REG_CX_GRUPOS[i][1].test(s)) return REG_CX_GRUPOS[i][0];
  return '';
}
/** Fecha dd/mm(/aa) de un texto, en el año que la deja dentro del episodio (ingreso − 2 días … fin). */
function regCxFechaTexto(t, ingreso, fin) {
  var m = /(?:^|[^\d])(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2}|\d{4}))?(?!\d)/.exec(regTexto(t));
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31) return '';
  var dd = ('0' + m[1]).slice(-2), mm = ('0' + m[2]).slice(-2);
  var anios = m[3] ? [m[3].length === 2 ? '20' + m[3] : m[3]] : [regTexto(fin || ingreso).slice(0, 4), regTexto(ingreso).slice(0, 4)];
  for (var i = 0; i < anios.length; i++) {
    if (!/^\d{4}$/.test(anios[i])) continue;
    var f = anios[i] + '-' + mm + '-' + dd;
    var antes = ingreso ? regDiasSigno(f, ingreso) : '', despues = fin ? regDiasSigno(fin, f) : '';
    if ((antes === '' || antes <= 2) && (despues === '' || despues <= 0)) return f;
  }
  return '';
}
var REG_CX_PLAN = /PROGRAMAD|SE PROGRAMA|PENDIENTE|\bPLAN\b|PLANEA|PROBABLE|CANDIDAT|PROPUEST|DIFERID|SE SOLICITA|SE COMENTA|VALORAR|DESCARTAR|\bMANANA\b/;
// Antecedente quirúrgico (no es de este episodio): «ANTECEDENTE DE…», «HACE 3 AÑOS», «PREVIA», «APP».
var REG_CX_ANTES = /ANTECEDENTE|\bHACE\b|\bANOS\b|\bPREVI[AO]S?\b|\bAPP\b|\bAPQX\b/;   // «AÑO» sin tilde = «ANO»: solo el plural
/** Del DX: segmentos con marca de postoperatorio («PO», «POP», «POSTOPERADO DE», «S/P») o con fecha del episodio. */
function regCxDeDx(dx, ingreso, fin) {
  var out = [];
  regTexto(dx).split(/\s*(?:\+|;|\n|\/\/)\s*/).forEach(function (seg) {
    var s = regNorm_(seg);
    if (!s.trim() || REG_CX_PLAN.test(s) || REG_CX_ANTES.test(s)) return;
    var grupo = regCxGrupo(s); if (!grupo) return;
    var marca = /\b(PO|POP|P\.\s?O\.?|POSTOPERAD[OA]|POSTQUIRURGIC[OA]|POST ?QX|PQX|S\/P|OPERAD[OA])\b/.test(s);
    var fecha = regCxFechaTexto(seg, ingreso, fin);
    // Con una fecha que cae fuera del episodio (o un año distinto) es una cirugía de antes: no se cuenta.
    var conFecha = /(?:^|[^\d])\d{1,2}[\/.-]\d{1,2}(?!\d)/.test(seg), anio = /\b(19|20)\d{2}\b/.exec(s);
    if ((conFecha && !fecha) || (anio && anio[0] !== regTexto(fin || ingreso).slice(0, 4) && anio[0] !== regTexto(ingreso).slice(0, 4))) return;
    if (!marca && !fecha) return;
    out.push({ fecha: fecha, grupo: grupo, texto: seg.trim() });
  });
  return out;
}
/** De la Cronología / Guardia: renglones que dicen que pasó a quirófano o que se realizó un procedimiento. */
function regCxDeCronologia(lineas, ingreso, fin) {
  var out = [];
  regArr(lineas).forEach(function (l) {
    var s = regNorm_(l);
    if (REG_CX_PLAN.test(s)) return;
    var hecho = /PASA A (QUIROFANO|QX|SALA)|INGRESA A (QUIROFANO|QX|SALA)|SE (LE )?REALIZ[AO]|SE INTERVIENE|SE INTERVINO|EN QUIROFANO|CIRUGIA REALIZADA|\bQX:|POSTQX INMEDIATO|POSTQUIRURGICO INMEDIATO/.test(s);
    if (!hecho) return;
    var grupo = regCxGrupo(s);
    if (!grupo && !/QUIROFANO|\bQX\b|CIRUGIA|INTERVIENE|INTERVINO/.test(s)) return;   // «se realiza curación» no es cirugía
    out.push({ fecha: regCxFechaTexto(l, ingreso, fin), grupo: grupo || REG_CX_NO_ESPECIFICADA, texto: regTexto(l).trim() });
  });
  return out;
}
/** Programación del día (procedimientos_dia) del paciente dentro del episodio: mismo expediente y nombre compatible. */
function regProgramadasDe(procs, p, ingreso, fin) {
  var exp = regTexto(p && p.exp).trim(), nom = regNorm_(p && p.nombre).split(/\s+/).filter(function (w) { return w.length > 2; });
  if (!exp) return [];
  return regArr(procs).filter(function (x) {
    if (!x || regTexto(x.exp).trim() !== exp) return false;
    var f = regFecha(x.fecha_dia); if (!f) return false;
    if (ingreso && regDiasSigno(ingreso, f) !== '' && regDiasSigno(ingreso, f) < -1) return false;
    if (fin && regDiasSigno(f, fin) !== '' && regDiasSigno(f, fin) < 0) return false;
    var otros = regNorm_(x.nombre).split(/\s+/).filter(function (w) { return w.length > 2; });
    return !otros.length || !nom.length || otros.filter(function (w) { return nom.indexOf(w) !== -1; }).length >= Math.min(2, otros.length, nom.length);
  }).map(function (x) { return { fecha: regFecha(x.fecha_dia), texto: regTexto(x.dx).trim() }; });
}
/** Todas las cirugías del episodio sin repetir: caja → fecha POP → texto Qx → Cronología → DX → programación del día. */
function regCirugias(o) {
  var out = [];
  var cerca = function (a, b) { if (!a || !b) return true; var d = regDiasSigno(a, b); return d === '' || Math.abs(d) <= 2; };
  // Un procedimiento sin grupo reconocido («CIRUGÍA DE URGENCIA» = «Otro») o solo el abordaje («PO LAPE + RESECCIÓN
  // INTESTINAL»: la LAPE es la vía de esa resección) empata con cualquier cirugía de esos días.
  var comodin = function (g) { return !g || g === REG_CX_NO_ESPECIFICADA || g === 'Otro' || g === 'Laparotomía exploradora' || g === 'Laparoscopia'; };
  var misma = function (c, x) { return cerca(c.fecha, x.fecha) && (c.grupo === x.grupo || comodin(c.grupo) || comodin(x.grupo)); };
  var agregar = function (x) {
    var ya = out.filter(function (c) { return misma(c, x); })[0];
    if (ya) { if (!ya.fecha && x.fecha && ya.fuente !== 'Caja Cirugías') ya.fecha = x.fecha; return; }
    out.push(x);
  };
  regArr(o.caja).forEach(function (c) {
    out.push({ fecha: regFecha(c.fecha) || regTexto(c.fecha), proc: regTexto(c.procedimiento), hallazgos: regTexto(c.hallazgos), sangrado: regTexto(c.sangrado), cirujano: regTexto(c.cirujano),
      tipo: REG_CX_TIPO_TXT[c.tipo] || '', abordaje: REG_CX_ABORDAJE_TXT[c.abordaje] || '', clavien: REG_CLAVIEN_TXT[c.clavien] || '', complicacion: REG_CLAVIEN_TXT[c.clavien] && c.clavien !== '0' ? regTexto(c.complicacion) : '',
      grupo: regCxGrupo(c.procedimiento) || (regTexto(c.procedimiento).trim() ? 'Otro' : ''), fuente: 'Caja Cirugías' });
  });
  var qx = regTexto(o.qx).trim();
  if (regFecha(o.qxFecha)) agregar({ fecha: regFecha(o.qxFecha), proc: qx || (regCxDeDx(o.dx, o.ingreso, o.fin)[0] || {}).texto || REG_CX_NO_ESPECIFICADA, hallazgos: '', sangrado: qx ? regTexto(o.sangrado) : '', cirujano: '',
    grupo: regCxGrupo(qx) || regCxGrupo((regCxDeDx(o.dx, o.ingreso, o.fin)[0] || {}).texto) || REG_CX_NO_ESPECIFICADA, fuente: 'Fecha POP de la tarjeta' });
  if (qx) agregar({ fecha: '', proc: qx, hallazgos: '', sangrado: regTexto(o.sangrado), cirujano: '', grupo: regCxGrupo(qx) || 'Otro', fuente: 'Texto Qx (caja anterior)' });
  regCxDeCronologia(o.crono, o.ingreso, o.fin).forEach(function (x) { agregar({ fecha: x.fecha, proc: x.texto, hallazgos: '', sangrado: '', cirujano: '', grupo: x.grupo, fuente: 'Cronología (inferida)' }); });
  regCxDeDx(o.dx, o.ingreso, o.fin).forEach(function (x) { agregar({ fecha: x.fecha, proc: x.texto, hallazgos: '', sangrado: '', cirujano: '', grupo: x.grupo, fuente: 'DX (inferida)' }); });
  // La programación del día solo cuenta si no hay otra cirugía en esos días (casi siempre es la misma).
  regArr(o.programadas).forEach(function (x) {
    if (out.some(function (c) { return c.fecha && cerca(c.fecha, x.fecha); })) return;
    out.push({ fecha: x.fecha, proc: 'Programada' + (x.texto ? ' — dx: ' + x.texto : ''), hallazgos: '', sangrado: '', cirujano: '', grupo: regCxGrupo(x.texto) || REG_CX_NO_ESPECIFICADA, fuente: 'Programación del día (sin confirmar)' });
  });
  return out;
}
function regNumCelda(n) { return typeof n === 'number' && isFinite(n) ? n : ''; }
function regRedondear(n, d) { var f = Math.pow(10, d); return Math.round(n * f) / f; }

/** Todas las pestañas de análisis desde las filas del registro (`fus`: pestaña → filas, como quedaron en la hoja),
 *  la clave de seudónimos que ya existe (`clave`: sus filas), las restauraciones ([de, a]) y una función
 *  codigo(prefijo, identidad) que da el seudónimo. Función pura (sin Google): se prueba en registro-pacientes.test.js. */
function regAnalisis(fus, clave, restauraciones, hoy, codigo) {
  var out = {}, avisos = [];
  out[REG_CLAVE.nombre] = [];
  REG_ANALISIS.forEach(function (cfg) { out[cfg.nombre] = []; });
  var porId = function (filas) { var m = {}; regArr(filas).forEach(function (r) { var id = regTexto(r && r['ID episodio']).trim(); if (id) (m[id] = m[id] || []).push(r); }); return m; };
  var P = {}, ids = [];
  regArr(fus['Pacientes']).forEach(function (r) { var id = regTexto(r && r['ID episodio']).trim(); if (id && !P[id]) { P[id] = r; ids.push(id); } });
  var labsDe = porId(fus['Labs']), signosDe = porId(fus['Signos vitales']), cxDe = porId(fus['Cirugías']);
  var resumenEps = [], resumenCxs = [];
  var claveDe = {};
  regArr(clave).forEach(function (r) { var id = regTexto(r && r['ID episodio']).trim(); if (id) claveDe[id] = r; });

  // 1) Partes de una misma hospitalización: restaurar desde la Papelera crea otro id («Continúa en» / «Viene de»).
  var padre = {}, sig = {}, conAnterior = {};
  ids.forEach(function (id) { padre[id] = id; });
  var raiz = function (x) { var r = x; while (padre[r] !== r) r = padre[r]; while (padre[x] !== r) { var n = padre[x]; padre[x] = r; x = n; } return r; };
  var unir = function (de, a) {
    de = regTexto(de).trim(); a = regTexto(a).trim();
    if (!P[de] || !P[a] || de === a) return;
    sig[de] = sig[de] || [];
    if (sig[de].indexOf(a) === -1) sig[de].push(a);
    conAnterior[a] = true;
    var x = raiz(de), y = raiz(a);
    if (x !== y) padre[y] = x;
  };
  regArr(restauraciones).forEach(function (par) { if (par) unir(par[0], par[1]); });
  ids.forEach(function (id) {
    var rel = regTexto(P[id]['Episodio relacionado']).trim(), m;
    if ((m = /^Continúa en (.+)$/.exec(rel))) unir(id, m[1]);
    else if ((m = /^Viene de (.+)$/.exec(rel))) unir(m[1], id);
  });
  var ingresoDe = function (id) { return regFecha(P[id]['Fecha de ingreso']); };
  var porIngreso = function (a, b) { return (ingresoDe(a) || '9999').localeCompare(ingresoDe(b) || '9999') || a.localeCompare(b); };
  var miembros = {};
  ids.forEach(function (id) { var r = raiz(id); (miembros[r] = miembros[r] || []).push(id); });
  var grupos = Object.keys(miembros).map(function (r) {
    var ms = miembros[r].slice().sort(porIngreso), orden = [], visto = {};
    var cola = ms.filter(function (id) { return !conAnterior[id]; });
    if (!cola.length) cola = [ms[0]];
    while (cola.length) {
      var x = cola.shift();
      if (visto[x]) continue;
      visto[x] = true; orden.push(x);
      (sig[x] || []).slice().sort(porIngreso).forEach(function (y) { if (!visto[y] && miembros[r].indexOf(y) !== -1) cola.push(y); });
      if (!cola.length) ms.forEach(function (id) { if (!visto[id] && !cola.length) cola.push(id); });
    }
    // La parte que manda para el desenlace: la que sigue en el censo; si no, la del egreso más reciente.
    var ultima = orden[orden.length - 1];
    var enCenso = orden.filter(function (id) { return P[id]['Estado en registro'] === 'Hospitalizado'; });
    if (enCenso.length) ultima = enCenso[enCenso.length - 1];
    else orden.forEach(function (id) {
      var f = regFecha(P[id]['Fecha de egreso']) || regFecha(P[id]['Última vez en la base']), fu = regFecha(P[ultima]['Fecha de egreso']) || regFecha(P[ultima]['Última vez en la base']);
      if (f && (!fu || f > fu)) ultima = id;
    });
    var ingresos = orden.map(ingresoDe).filter(Boolean).sort();
    var exp = regExpValido(P[ultima]['Expediente']);
    if (!exp) orden.some(function (id) { exp = regExpValido(P[id]['Expediente']); return !!exp; });
    return { raiz: orden[0], partes: orden, ultima: ultima, ingreso: ingresos[0] || '', exp: exp, nombre: regTexto(P[ultima]['Nombre']) || regTexto(P[orden[0]]['Nombre']) };
  }).sort(function (a, b) { return (a.ingreso || '9999').localeCompare(b.ingreso || '9999') || a.raiz.localeCompare(b.raiz); });

  // 2) Personas: mismo expediente y nombre compatible = la misma persona (dos personas con el mismo expediente por error
  //    de captura quedan separadas). El seudónimo de la clave ya guardada se conserva (aunque cambie la sal).
  var personas = {}, listaPersonas = [];
  grupos.forEach(function (g) {
    var llave, por;
    if (g.exp) { llave = 'EXP|' + g.exp; por = 'Expediente'; }
    else if (regPalabrasNombre(g.nombre).length) { llave = 'NOMBRE|' + regPalabrasNombre(g.nombre).join(' '); por = 'Nombre (sin expediente válido)'; }
    else { llave = 'EPISODIO|' + g.raiz; por = 'Episodio (sin expediente ni nombre)'; }
    var lista = personas[llave] || (personas[llave] = []);
    var p = null;
    for (var i = 0; i < lista.length && !p; i++) if (lista[i].nombres.some(function (n) { return regMismaPersona(n, g.nombre); })) p = lista[i];
    if (!p) {
      p = { ident: lista.length ? llave + '|' + regPalabrasNombre(g.nombre).join(' ') : llave, por: por, nombres: [], grupos: [] };
      lista.push(p); listaPersonas.push(p);
    }
    if (lista.length > 1) lista.forEach(function (q) { if (q.por === 'Expediente') q.por = 'Expediente + nombre (expediente compartido)'; });
    p.nombres.push(g.nombre); p.grupos.push(g); g.persona = p;
  });
  // Un seudónimo nunca lo tienen dos: primero se respetan los ya guardados en la clave (el del episodio más antiguo, si
  // dos lo traen), después los nuevos; uno nuevo que choca con uno ocupado se vuelve a sacar con «#1», «#2»…
  // (27 oct 2026: una persona que llega después con un ingreso anterior ya no se queda con el código de otra).
  var usados = {};
  var asignar = function (items, previoDe, pre, identDe) {
    items.forEach(function (x) {
      var c = previoDe(x).filter(function (c) { return !usados[c]; })[0];
      if (c) { usados[c] = true; x.codigo = c; }
    });
    items.forEach(function (x) {
      if (x.codigo) return;
      var c, k = 0;
      do { c = codigo(pre, identDe(x) + (k ? '#' + k : '')); k++; } while (usados[c]);
      usados[c] = true; x.codigo = c;
    });
  };
  asignar(listaPersonas, function (p) {
    var cs = [];
    p.grupos.forEach(function (g) { g.partes.forEach(function (id) { var c = regTexto(claveDe[id] && claveDe[id]['ID paciente (análisis)']).trim(); if (c && cs.indexOf(c) === -1) cs.push(c); }); });
    return cs;
  }, 'P', function (p) { return p.ident; });
  asignar(grupos, function (g) {
    var cs = [];
    g.partes.forEach(function (id) { var c = regTexto(claveDe[id] && claveDe[id]['ID episodio (análisis)']).trim(); if (c && cs.indexOf(c) === -1) cs.push(c); });
    return cs;
  }, 'E', function (g) { return 'EP|' + g.raiz; });
  grupos.forEach(function (g) {
    g.partes.forEach(function (id) {
      out[REG_CLAVE.nombre].push({ 'ID episodio': id, 'Expediente': regTexto(P[id]['Expediente']), 'Nombre': regTexto(P[id]['Nombre']),
        'ID paciente (análisis)': g.persona.codigo, 'ID episodio (análisis)': g.codigo, 'Identidad del paciente por': g.persona.por });
    });
  });

  // 3) Fechas del episodio y desenlace.
  grupos.forEach(function (g) {
    var u = P[g.ultima], estado = regTexto(u['Estado en registro']);
    g.estado = estado === 'Hospitalizado' ? 'Hospitalizado' : (estado === 'Egresado' ? 'Egresado' : 'Sin egreso registrado');
    g.egreso = g.estado === 'Egresado' ? regFecha(u['Fecha de egreso']) : '';
    g.fin = g.egreso || (g.estado === 'Hospitalizado' ? hoy : (regFecha(u['Última vez en la base']) || hoy));
    g.motivo = g.estado === 'Egresado' ? regTexto(u['Motivo de egreso']) : '';
    g.tipo = g.estado === 'Egresado' ? regEgresoTipo(g.motivo, u['Estado clínico']) : (g.estado === 'Hospitalizado' ? '' : 'Motivo no registrado');
    g.excluir = g.tipo === 'Duplicado (no es otro episodio)' ? 1 : (g.tipo === 'Borrado en la base (revisar)' ? '' : 0);
    g.calidad = [];
    if (g.partes.length > 1) g.calidad.push(g.partes.length + ' partes en el registro (restaurado desde la Papelera): se cuentan como un episodio');
    // La base restaura la nota si el mismo paciente vuelve al censo hasta 10 días después: casi siempre es un cambio de
    // cama o un hueco del censo (horas), pero si la parte siguiente entró 2 días o más después puede ser un reingreso.
    g.partes.forEach(function (id, i) {
      if (!i) return;
      var d = regDiasSigno(P[g.partes[i - 1]]['Fecha de egreso'], regFechaLocal(P[id]['Alta en la app']));
      if (d !== '' && d >= 2) g.calidad.push('la parte ' + (i + 1) + ' entró ' + d + ' días después del egreso de la anterior: confirmar que no fue reingreso');
    });
    if (!g.ingreso) g.calidad.push('sin fecha de ingreso');
    if (g.persona.por !== 'Expediente') g.calidad.push('paciente identificado por: ' + g.persona.por);
  });

  // 4) Laboratorio: una fila por episodio y fecha; una columna por estudio (en la unidad de la app).
  var LABS_COLS = REG_LAB_META.map(regLabColumna);
  grupos.forEach(function (g) {
    var dias = {}, fechas = [];
    // Por fecha y estudio manda la parte MÁS RECIENTE del episodio: si en la tarjeta restaurada se corrigió o borró un
    // valor (Vigente: No), el de la copia vieja de la Papelera no vuelve. Un valor distinto en una parte anterior se dice.
    var ultimoDe = {}, ordenK = [];
    g.partes.forEach(function (id) {
      regArr(labsDe[id]).forEach(function (r) {
        var k0 = regTexto(r['Estudio']).trim(), f = regFecha(r['Fecha']) || ('?' + regTexto(r['Fecha']));
        if (!k0 || REG_LAB_NO_ESTUDIO.test(k0) || !regTexto(r['Valor']).trim()) return;
        var kk = f + REG_SEP + k0, prev = ultimoDe[kk];
        if (!prev) ordenK.push(kk);
        ultimoDe[kk] = { r: r, antes: prev ? (prev.antes || []).concat([prev.r]) : [] };
      });
    });
    ordenK.forEach(function (kk) {
      var u = ultimoDe[kk];
      (function (r, antes) {
        var vig = regTexto(r['Vigente']) !== 'No', f = regFecha(r['Fecha']);
        var k0 = regTexto(r['Estudio']).trim(), v = regTexto(r['Valor']).trim();
        if (!f) { g.calidad.push('labs con fecha no reconocida («' + regTexto(r['Fecha']).slice(0, 20) + '»): no se usaron'); return; }
        var d = dias[f];
        if (!d) { d = dias[f] = { valores: {}, textos: {}, otros: [], obs: [], criticos: [], fuentes: [], excluidos: [] }; fechas.push(f); }
        if (!vig) { d.excluidos.push(k0); return; }
        var distinto = antes.filter(function (a) { return regTexto(a['Vigente']) !== 'No' && regTexto(a['Valor']).trim() !== v; }).map(function (a) { return regTexto(a['Valor']).trim(); });
        if (distinto.length) d.obs.push(((REG_LAB_POR_CLAVE[REG_LAB_ALIAS[k0] || k0] || {}).n || k0) + ': otra parte del episodio decía ' + distinto.join(', ') + ' (se tomó ' + v + ', la más reciente)');
        var o = regTexto(r['Origen']).trim() || 'sin registro';
        if (d.fuentes.indexOf(o) === -1) d.fuentes.push(o);
        var k = REG_LAB_ALIAS[k0] || k0, m = REG_LAB_POR_CLAVE[k];
        if (!m) { d.otros.push(k0 + ': ' + v); return; }
        if (m.t === 'texto') { d.textos[k] = v; return; }
        if (/^RECHAZADA$/i.test(v)) { d.obs.push(m.n + ': muestra rechazada'); return; }
        if (/^REVISAR UNIDAD/i.test(v)) { d.obs.push(m.n + ': unidad no reconocida (' + v.replace(/^REVISAR UNIDAD\s*/i, '').replace(/[()]/g, '') + ')'); return; }
        if (/^[<>≤≥]?\s*[1-9]\d{0,2},\d{3}$/.test(v)) { d.obs.push(m.n + ': «' + v + '» es ambiguo (¿miles o decimales?): se dejó vacío'); return; }
        var x = regNumero(v);
        if (!x) { d.obs.push(m.n + ': «' + v.slice(0, 30) + '» no es un número'); return; }
        var imp = REG_LAB_IMPOSIBLE[k];
        if (imp && (x.n < imp[0] || x.n > imp[1])) { d.obs.push(m.n + ': ' + v + ' fuera de lo posible (se dejó vacío)'); return; }
        // Dos claves para el mismo estudio el mismo día (la vieja y la de hoy, p. ej. hto y hct) con valores distintos.
        if (d.valores[k] !== undefined && d.valores[k] !== x.n) d.obs.push(m.n + ': dos valores el mismo día (' + d.valores[k] + ' y ' + x.n + '; se tomó ' + x.n + ')');
        d.valores[k] = x.n;
        if (x.comp) d.obs.push(m.n + ': ' + x.comp + x.n + ' (se anotó ' + x.n + ')');
      })(u.r, u.antes);
    });
    fechas.sort();
    g.labs = { fechas: 0, criticos: 0, resumen: {} };
    fechas.forEach(function (f) {
      var d = dias[f], fila = { 'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Fecha': f, 'Día de estancia': regNumCelda(regDiasSigno(g.ingreso, f)), 'Fuente': d.fuentes.join(', ') };
      var hay = false;
      REG_LAB_META.forEach(function (m, i) {
        var c = LABS_COLS[i];
        if (m.t === 'texto') { fila[c] = d.textos[m.k] || ''; if (fila[c]) hay = true; return; }
        var n = d.valores[m.k];
        fila[c] = regNumCelda(n);
        if (n === undefined) return;
        hay = true;
        if ((m.cl !== undefined && n <= m.cl) || (m.ch !== undefined && n >= m.ch)) d.criticos.push(m.n + ' ' + n);
      });
      if (!hay && !d.otros.length && !d.obs.length) return;
      if (d.excluidos.length) d.obs.push('ya no están en la tarjeta (corregidos o borrados), no se usaron: ' + d.excluidos.join(', '));
      fila['Otros estudios'] = d.otros.join('; ');
      fila['Valores críticos'] = d.criticos.join('; ');
      fila['Observaciones'] = d.obs.join('; ');
      fila['Vigente'] = 'Sí';
      out[REG_AN_LABS].push(fila);
      g.labs.fechas++;
      g.labs.criticos += d.criticos.length;
      REG_LAB_RESUMEN.forEach(function (r, i) {
        var n = d.valores[r[0]];
        if (n === undefined) return;
        var prev = g.labs.resumen[i];
        if (prev === undefined || (r[1] === 'min' && n < prev) || (r[1] === 'max' && n > prev)) g.labs.resumen[i] = n;
      });
    });
  });

  // 5) Signos vitales: números limpios; TA en sistólica, diastólica y PAM; índice urinario = uresis ÷ peso ÷ horas
  //    (como la app: sin horas se toman las que diga la uresis, «900/12 H», o 24 h y se avisa).
  var pesoDe = function (g) {
    if (g.pt) return g.pt;
    var r = { peso: '', talla: '', imc: '' };
    g.partes.slice().reverse().some(function (id) { var x = regPesoTalla(P[id]); if (x.peso !== '' && r.peso === '') { r.peso = x.peso; r.talla = x.talla; r.imc = x.imc; } return r.peso !== ''; });
    if (r.talla === '') g.partes.slice().reverse().some(function (id) { var x = regPesoTalla(P[id]); if (x.talla !== '') { r.talla = x.talla; r.imc = r.peso !== '' ? regRedondear(r.peso / (x.talla * x.talla), 1) : ''; } return r.talla !== ''; });
    return (g.pt = r);
  };
  grupos.forEach(function (g) {
    var porFecha = {}, fechas = [];
    g.iu = { min: '', oliguria: 0 };
    g.partes.forEach(function (id) {
      regArr(signosDe[id]).forEach(function (r) {
        var f = regFecha(r['Fecha']);
        if (!f) return;
        if (!porFecha[f]) fechas.push(f);
        porFecha[f] = r;   // la parte más reciente manda
      });
    });
    fechas.sort().forEach(function (f) {
      var r = porFecha[f], obs = [], fila = { 'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Fecha': f, 'Día de estancia': regNumCelda(regDiasSigno(g.ingreso, f)) };
      var horasUresis = '';
      REG_SV.forEach(function (s) {
        var v = regTexto(r[s[0]]).trim(), x = null;
        fila[s[1]] = '';
        if (s[0] === 'Uresis') {
          var mh = /\s*(?:\/|\bEN\s*)(\d{1,2}(?:[.,]5)?)\s*(?:H|HR|HRS|HORAS?)\b\.?\s*$/i.exec(v);
          if (mh) { horasUresis = parseFloat(mh[1].replace(',', '.')); v = v.slice(0, mh.index).trim(); }
        }
        if (!v) return;
        if (s[0] === 'O2 L/min' && /^(AA|AIRE( AMBIENTE)?)$/i.test(v)) x = { n: 0, comp: '' };
        else x = regNumero(v, { unidad: s[4], miles: !!s[5] });
        if (!x || x.comp) { obs.push(s[0] + ' «' + v.slice(0, 30) + '» no es un número'); return; }
        if (x.n < s[2] || x.n > s[3]) { obs.push(s[0] + ' ' + v + ' fuera de lo posible (se dejó vacío)'); return; }
        fila[s[1]] = x.n;
      });
      var ta = regTexto(r['TA']).trim(), m = /^(\d{2,3})\s*[\/\\-]\s*(\d{2,3})\s*(MMHG)?$/i.exec(ta);
      fila['TA sistólica (mmHg)'] = ''; fila['TA diastólica (mmHg)'] = ''; fila['PAM (mmHg)'] = '';
      if (ta && (!m || +m[1] < +m[2] || +m[1] < 40 || +m[1] > 300 || +m[2] < 10 || +m[2] > 200)) obs.push('TA «' + ta.slice(0, 30) + '» no interpretable');
      else if (m) { fila['TA sistólica (mmHg)'] = +m[1]; fila['TA diastólica (mmHg)'] = +m[2]; fila['PAM (mmHg)'] = regRedondear((+m[1] + 2 * +m[2]) / 3, 1); }
      // Índice urinario.
      var hTxt = regTexto(r['Horas de uresis']).trim(), hx = hTxt ? regNumero(hTxt, { unidad: /^(H|HR|HRS|HORAS?)$/ }) : null;
      var horas = hx && !hx.comp && hx.n > 0 && hx.n <= 72 ? hx.n : horasUresis;
      if (hTxt && !(hx && !hx.comp && hx.n > 0 && hx.n <= 72)) obs.push('Horas de uresis «' + hTxt.slice(0, 20) + '» no interpretables');
      fila['Horas de uresis (h)'] = ''; fila['Índice urinario (mL/kg/h)'] = '';
      if (fila['Uresis (mL)'] !== '') {
        var pt = pesoDe(g);
        if (horas === '') { horas = 24; obs.push('uresis sin horas: índice urinario con 24 h'); }
        fila['Horas de uresis (h)'] = horas;
        if (pt.peso === '') obs.push('sin peso: sin índice urinario');
        else {
          var iu = regRedondear(fila['Uresis (mL)'] / pt.peso / horas, 2);
          fila['Índice urinario (mL/kg/h)'] = iu;
          if (g.iu.min === '' || iu < g.iu.min) g.iu.min = iu;
          if (iu < 0.5) g.iu.oliguria++;
        }
      }
      fila['Observaciones'] = obs.join('; ');
      fila['Vigente'] = 'Sí';
      out[REG_AN_SIGNOS].push(fila);
    });
  });

  // 6) Cultivos del robot: por expediente y nombre, al episodio cuya estancia (desde 2 días antes del ingreso: muestras
  //    de urgencias) contiene la toma. Sin el texto del PDF (trae el nombre del paciente).
  var gruposPorExp = {}, sinEpisodio = {};
  grupos.forEach(function (g) { if (g.exp) (gruposPorExp[g.exp] = gruposPorExp[g.exp] || []).push(g); g.cultivos = { n: 0, pos: 0, germenes: [] }; });
  regArr(fus['Cultivos del robot (WinLab)']).forEach(function (r) {
    var exp = regExpValido(r['Expediente']), toma = regTexto(r['Toma']).trim(), f = regFecha(toma), hora = (/\d{1,2}:\d{2}$/.exec(toma) || [''])[0];
    if (!exp) return;
    var candidatos = regArr(gruposPorExp[exp]).filter(function (g) { return g.excluir !== 1 && regMismaPersona(g.nombre, r['Paciente']); });
    var g = null;
    if (f) candidatos.forEach(function (c) { var d1 = regDiasSigno(c.ingreso, f), d2 = regDiasSigno(f, c.fin); if (d1 !== '' && d1 >= -2 && d2 !== '' && d2 >= 0 && (!g || c.ingreso > g.ingreso)) g = c; });
    // Sin episodio: la persona del registro con ese expediente y nombre; si no la hay (o el expediente es de OTRA persona,
    // con nombre incompatible), un seudónimo propio que se guarda en la clave (fila «sin episodio|…») para que no cambie.
    var persona = g ? g.persona.codigo : (candidatos.length ? candidatos[candidatos.length - 1].persona.codigo : '');
    if (!persona) {
      var idSin = 'sin episodio|' + exp + '|' + regPalabrasNombre(r['Paciente']).join(' ');
      if (!sinEpisodio[idSin]) {
        var prev = regTexto(claveDe[idSin] && claveDe[idSin]['ID paciente (análisis)']).trim(), c, k = 0;
        if (prev && !usados[prev]) c = prev;
        else do { c = codigo('P', (gruposPorExp[exp] ? 'EXP|' + exp + '|' + regPalabrasNombre(r['Paciente']).join(' ') : 'EXP|' + exp) + (k ? '#' + k : '')); k++; } while (usados[c]);
        usados[c] = true; sinEpisodio[idSin] = c;
        out[REG_CLAVE.nombre].push({ 'ID episodio': idSin, 'Expediente': regTexto(r['Expediente']), 'Nombre': regTexto(r['Paciente']), 'ID paciente (análisis)': c,
          'ID episodio (análisis)': '', 'Identidad del paciente por': 'Cultivo sin episodio en el registro' });
      }
      persona = sinEpisodio[idSin];
    }
    var res = regTexto(r['Resultado']).trim(), pos = res === 'POSITIVO' ? 1 : (res === 'Negativo' ? 0 : '');
    // ID del cultivo: del seudónimo (no del expediente) y del reporte, sin la sal: así no cambia si la sal se pierde (los
    // seudónimos se conservan por la clave) y no lleva al expediente.
    var idCult = codigo('C', (g ? g.codigo : persona) + '|' + regTexto(r['Reporte']).trim() + '|' + regTexto(r['N']).trim(), true);
    out[REG_AN_CULTIVOS].push({ 'ID cultivo': idCult, 'ID episodio': g ? g.codigo : '', 'ID paciente': persona,
      'Fecha de toma': f, 'Hora de toma': hora, 'Día de estancia': g ? regNumCelda(regDiasSigno(g.ingreso, f)) : '', 'Tipo': regTexto(r['Tipo']), 'Muestra': regTexto(r['Muestra']),
      'Resultado': res, 'Positivo': pos, 'Germen': regTexto(r['Germen']), 'Sensibles': regTexto(r['Sensibles']), 'Intermedios': regTexto(r['Intermedios']),
      'Resistentes': regTexto(r['Resistentes']), 'UFC': regTexto(r['UFC']), 'Fuente': regTexto(r['Fuente']), 'Vigente': 'Sí' });
    if (!g) return;
    g.cultivos.n++;
    if (pos === 1) {
      g.cultivos.pos++;
      regTexto(r['Germen']).split(/\s*\+\s*/).forEach(function (x) {
        x = x.replace(/\s*\(.*\)\s*$/, '').trim();
        if (x && !/^POSITIVO/i.test(x) && g.cultivos.germenes.indexOf(x) === -1) g.cultivos.germenes.push(x);
      });
    }
  });

  // 7) Reingresos por persona (sin los duplicados): hacia atrás (¿este es un reingreso?) y hacia adelante (¿reingresó
  //    en 30 días? vacío si murió, sigue hospitalizado o aún no pasan 30 días desde el egreso).
  listaPersonas.forEach(function (p) {
    var serie = p.grupos.filter(function (g) { return g.excluir !== 1 && g.ingreso; }).sort(function (a, b) { return a.ingreso.localeCompare(b.ingreso) || a.raiz.localeCompare(b.raiz); });
    serie.forEach(function (g, i) {
      g.numero = i + 1;
      var prev = serie[i - 1], next = serie[i + 1];
      g.diasPrevio = ''; g.esReingreso = ''; g.reingreso30 = '';
      if (prev && prev.egreso) {
        g.diasPrevio = regDiasSigno(prev.egreso, g.ingreso);
        g.esReingreso = g.diasPrevio === '' ? '' : (g.diasPrevio >= 0 && g.diasPrevio <= 30 ? 1 : (g.diasPrevio > 30 ? 0 : ''));
        if (g.diasPrevio !== '' && g.diasPrevio < 0) g.calidad.push('el ingreso es anterior al egreso del episodio previo (se traslapan)');
      }
      if (g.egreso && g.tipo !== 'Defunción') {
        var dn = next ? regDiasSigno(g.egreso, next.ingreso) : '';
        if (dn !== '' && dn < 0) g.calidad.push('el episodio siguiente empieza antes de este egreso (se traslapan): reingreso sin calcular');
        else if (dn !== '' && dn <= 30) g.reingreso30 = 1;
        else if ((dn !== '' && dn > 30) || (dn === '' && regDiasSigno(g.egreso, hoy) >= 30)) g.reingreso30 = 0;
      }
    });
  });

  // 8) Una fila por episodio.
  grupos.forEach(function (g) {
    var u = P[g.ultima], primero = P[g.partes[0]];
    var edadTxt = regTexto(primero['Edad']) || regTexto(u['Edad']), edad = regEdadAnios(edadTxt);
    if (edad === '') g.calidad.push(edadTxt.trim() ? 'edad no interpretable' : 'sin edad registrada');
    var sexo = '';
    g.partes.some(function (id) { sexo = regSexo(P[id]['Sexo']); return !!sexo; });
    if (!sexo) g.calidad.push('sin sexo registrado');
    var estancia = regDiasSigno(g.ingreso, g.fin);
    if (estancia !== '' && estancia < 0) { g.calidad.push('el egreso es anterior al ingreso'); estancia = ''; }
    // Cirugías vigentes de todas las partes, sin repetir (la parte restaurada trae las mismas).
    // Cirugías de todas las partes, sin repetir: por fecha y procedimiento manda la parte más reciente (una cirugía
    // borrada en la tarjeta restaurada no vuelve desde la copia vieja).
    var cxs = [], cxUltima = {}, cxOrden = [], cxInferidas = 0, cxProgramadas = 0;
    g.partes.forEach(function (id) {
      regArr(cxDe[id]).forEach(function (c) {
        var proc = regTexto(c['Procedimiento']).trim(), f = regFecha(c['Fecha']);
        if (!proc && !f) return;
        var k = f + '|' + proc.toUpperCase();
        if (!cxUltima[k]) cxOrden.push(k);
        cxUltima[k] = c;
      });
    });
    cxOrden.forEach(function (k) {
      var c = cxUltima[k];
      if (regTexto(c['Vigente']) === 'No') return;
      var fuente = regTexto(c['Fuente']);
      // La programación del día sin confirmar no cuenta como cirugía hecha (va en su propia columna).
      if (/^Programaci/.test(fuente)) { cxProgramadas++; return; }
      if (/inferida|Fecha POP|Texto Qx/.test(fuente)) cxInferidas++;
      cxs.push({ f: regFecha(c['Fecha']), proc: regTexto(c['Procedimiento']).trim(), sangrado: regTexto(c['Sangrado']).trim(), grupo: regTexto(c['Grupo']).trim(),
        tipo: regTexto(c['Tipo']).trim(), abordaje: regTexto(c['Abordaje']).trim(), clavien: regTexto(c['Clavien-Dindo']).trim(), caja: fuente === 'Caja Cirugías' });
    });
    if (cxInferidas) g.calidad.push(cxInferidas + ' cirugía' + (cxInferidas === 1 ? '' : 's') + ' tomada' + (cxInferidas === 1 ? '' : 's') + ' de otra caja (DX, Cronología, fecha POP o texto Qx): conviene pasarla' + (cxInferidas === 1 ? '' : 's') + ' a la caja Cirugías');
    if (cxProgramadas) g.calidad.push(cxProgramadas + ' cirugía' + (cxProgramadas === 1 ? '' : 's') + ' solo en la programación del día (sin confirmar)');
    var fechasCx = cxs.map(function (c) { return c.f; }).filter(Boolean).sort();
    var sangrado = 0, conSangrado = 0, sinNumero = 0;
    cxs.forEach(function (c) {
      if (!c.sangrado) return;
      var x = regNumero(c.sangrado, { unidad: /^(ML|CC)$/, prefijo: /^(APROX(IMADAMENTE|\.)?|CA\.)\s*/, miles: true });
      if (x && !x.comp && x.n >= 0 && x.n <= 50000) { sangrado += x.n; conSangrado++; } else sinNumero++;
    });
    if (sinNumero) g.calidad.push('sangrado sin número en ' + sinNumero + ' cirugía(s): el total queda vacío');
    // Peso, talla, IMC y comorbilidades (APP y DX de todas las partes; obesidad también por IMC ≥ 30 en adultos).
    var pt = pesoDe(g);
    if (pt.peso === '') g.calidad.push('sin peso registrado');
    var appTxt = g.partes.map(function (id) { return regTexto(P[id]['Antecedentes (APP)']); }).filter(function (t, i, a) { return t.trim() && a.indexOf(t) === i; }).join('\n');
    var dxTxt = g.partes.map(function (id) { return regTexto(P[id]['Diagnóstico']); }).filter(function (t, i, a) { return t.trim() && a.indexOf(t) === i; }).join('\n');
    var com = regComorbilidades(appTxt, dxTxt);
    if (pt.imc !== '' && pt.imc >= 30 && (edad === '' || edad >= 18)) com['Obesidad'] = 1;
    if (!appTxt.trim()) g.calidad.push('sin antecedentes (APP) registrados: comorbilidades ' + (dxTxt.trim() ? 'solo desde el DX' : 'desconocidas'));
    // Cirugía estructurada (urgencia, abordaje, Clavien-Dindo): solo lo que se eligió en la caja; lo inferido no la trae.
    var cxOrd = cxs.slice().sort(function (a, b) { return (a.f || '9999').localeCompare(b.f || '9999'); }), cx1 = cxOrd[0] || {};
    var conLap = cxs.filter(function (c) { return /^Laparosc|^Convertida/.test(c.abordaje); });
    var grados = cxs.map(function (c) { return REG_CLAVIEN_ORDEN.indexOf(c.clavien); }).filter(function (i) { return i >= 0; });
    var gradoMax = grados.length ? Math.max.apply(null, grados) : -1;
    var sinClas = cxs.filter(function (c) { return c.caja && (!c.tipo || !c.abordaje || !c.clavien); }).length;
    // Dx principal: el de la tarjeta (elegido o inferido al construir Pacientes); filas viejas sin la columna → del DX.
    var dxP = { label: regTexto(u['Dx principal']).trim(), cie: regTexto(u['CIE-10 (grupo)']).trim(), fuente: regTexto(u['Dx principal (fuente)']).trim() };
    if (!dxP.label) dxP = regDxPrincipal('', regTexto(u['Diagnóstico']));
    var si = function (col) { return regTexto(u[col]).trim() ? 1 : 0; };
    var siMarca = function (col) { return /^Sí/.test(regTexto(u[col]).trim()) ? 1 : 0; };
    var fila = {
      'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Partes del registro': g.partes.length, 'N.º de episodio del paciente': g.numero || '',
      'Días desde el egreso previo': regNumCelda(g.diasPrevio), 'Es reingreso (≤30 días)': regNumCelda(g.esReingreso), 'Reingreso a 30 días': regNumCelda(g.reingreso30),
      'Edad (años)': edad, 'Sexo': sexo, 'Especialidad': regTexto(u['Especialidad']), 'Sección': regTexto(u['Sección']),
      'Fecha de ingreso': g.ingreso, 'Fecha de egreso': g.egreso, 'Días de estancia': regNumCelda(estancia), 'Estado': g.estado,
      'Egreso observado': g.estado === 'Egresado' && g.excluir !== 1 && g.egreso && g.tipo !== 'No fue egreso' ? 1 : 0, 'Tipo de egreso': g.tipo,
      'Defunción': g.tipo === 'Defunción' ? 1 : (REG_EGRESO_VIVO.indexOf(g.tipo) >= 0 ? 0 : ''),
      'Motivo de egreso (app)': g.motivo, 'Excluir (duplicado)': g.excluir, 'Diagnóstico': regTexto(u['Diagnóstico']),
      'Dx principal': dxP.label, 'CIE-10 (grupo)': dxP.cie, 'Dx principal (fuente)': dxP.fuente,
      'Peso (kg)': pt.peso, 'Talla (m)': pt.talla, 'IMC (kg/m²)': pt.imc,
      'Cirugías (n)': cxs.length, 'Primera cirugía': fechasCx[0] || '', 'Días ingreso a 1.ª cirugía': fechasCx[0] ? regNumCelda(regDiasSigno(g.ingreso, fechasCx[0])) : '',
      'Sangrado total (mL)': conSangrado && !sinNumero ? sangrado : '', 'Procedimientos': cxs.map(function (c) { return (c.f ? c.f + ' ' : '') + c.proc; }).join(' | '),
      'Grupo de la 1.ª cirugía': (cxs.slice().sort(function (a, b) { return (a.f || '9999').localeCompare(b.f || '9999'); })[0] || {}).grupo || '',
      'Reintervención': cxs.length ? ((cxs.length >= 2 || cxs.some(function (c) { return c.grupo === 'Relaparotomía'; })) ? 1 : 0) : '',
      'Cirugías inferidas (n)': cxInferidas, 'Programadas sin confirmar (n)': cxProgramadas,
      'Urgencia (1.ª cirugía)': cx1.tipo === 'Urgencia' ? 1 : (cx1.tipo === 'Electiva' ? 0 : ''), 'Abordaje (1.ª cirugía)': cx1.abordaje || '',
      'Conversión': conLap.length ? (conLap.some(function (c) { return /^Convertida/.test(c.abordaje); }) ? 1 : 0) : '',
      'Clavien-Dindo máximo': gradoMax >= 0 ? REG_CLAVIEN_ORDEN[gradoMax] : '', 'Complicación mayor (Clavien ≥ IIIa)': gradoMax >= 0 ? (gradoMax >= 3 ? 1 : 0) : '',
      'Cirugías sin clasificar (n)': sinClas,
      'Antibiótico (registrado)': si('Antibiótico'), 'NPT (registrada)': siMarca('NPT'), 'Ventilación mecánica (registrada)': siMarca('Ventilación'),
      'Vasopresor (registrado)': si('Vasopresores'), 'Tromboprofilaxis (registrada)': siMarca('TVP'),
      'Fechas con labs (n)': g.labs.fechas, 'Valores críticos (n)': g.labs.criticos,
      'Índice urinario mínimo (mL/kg/h)': g.iu ? g.iu.min : '', 'Días con oliguria (IU < 0.5)': g.iu && g.iu.min !== '' ? g.iu.oliguria : '',
      'Cultivos (n)': g.cultivos.n, 'Cultivos positivos (n)': g.cultivos.pos, 'Gérmenes aislados': g.cultivos.germenes.join('; '),
      'Calidad de datos': g.calidad.filter(function (x, i, a) { return a.indexOf(x) === i; }).join('; '), 'Vigente': 'Sí'
    };
    REG_LAB_RESUMEN.forEach(function (r, i) { fila[r[2]] = regNumCelda(g.labs.resumen[i]); });
    var nCom = 0;
    REG_COMORB.forEach(function (c) { fila[c[0]] = com[c[0]]; if (com[c[0]] === 1 && c[0] !== 'Tabaquismo') nCom++; });
    fila['Comorbilidades (n)'] = appTxt.trim() ? nCom : '';   // sin APP el conteo no es confiable (el DX no las enlista)
    out[REG_AN_EPISODIOS].push(fila);

    // Por completar (con nombres, para el equipo): hospitalizados y egresados de los últimos 30 días.
    var falta = [];
    if (g.estado === 'Egresado' && fila['Defunción'] === '' && g.tipo !== 'No fue egreso') falta.push('motivo del egreso');
    if (!sexo) falta.push('sexo');
    if (edad === '') falta.push('edad');
    if (!appTxt.trim()) falta.push('APP');
    if (pt.peso === '') falta.push('peso');
    if (pt.talla === '') falta.push('talla');
    if (dxP.fuente !== 'Elegido en la app') falta.push('dx principal');
    if (cxInferidas) falta.push(cxInferidas + (cxInferidas === 1 ? ' cirugía por pasar a la caja Cirugías' : ' cirugías por pasar a la caja Cirugías'));
    if (sinClas) falta.push(sinClas + (sinClas === 1 ? ' cirugía sin urgencia/abordaje/Clavien' : ' cirugías sin urgencia/abordaje/Clavien'));
    var dEgreso = g.egreso ? regDiasSigno(g.egreso, hoy) : '';
    if (falta.length && g.excluir !== 1 && (g.estado === 'Hospitalizado' || (dEgreso !== '' && dEgreso >= 0 && dEgreso <= 30))) {
      out[REG_POR_COMPLETAR].push({ 'ID episodio': g.ultima, 'Estado': g.estado, 'Cama': regTexto(u['Cama']), 'Nombre': regTexto(u['Nombre']), 'Expediente': regTexto(u['Expediente']),
        'Fecha de ingreso': g.ingreso, 'Fecha de egreso': g.egreso, 'Falta': falta.join(' · '), 'Faltantes (n)': falta.length, 'Vigente': 'Sí' });
    }
    // Para el resumen mensual.
    resumenEps.push({ ingreso: g.ingreso, egreso: fila['Egreso observado'] === 1 ? g.egreso : '', defuncion: fila['Defunción'], estancia: fila['Días de estancia'],
      reint: fila['Reintervención'], re30: fila['Reingreso a 30 días'], dx: dxP.label, incompleto: falta.length > 0, excluir: g.excluir });
    if (g.excluir !== 1) cxs.forEach(function (c) { resumenCxs.push({ f: c.f, grupo: c.grupo, tipo: c.tipo, abordaje: c.abordaje, clavien: c.clavien, ep: g.codigo }); });
  });
  out[REG_AN_RESUMEN] = regResumenMensual(resumenEps, resumenCxs, out[REG_AN_CULTIVOS]);
  out.avisos = avisos;
  return out;
}

/** Resumen mensual del servicio: ingresos por mes de ingreso; egresos, mortalidad, estancia y reingresos por mes de
 *  egreso; cirugías por mes de la cirugía; cultivos por mes de toma. Sin duplicados (Excluir = 1). Solo cuentas. */
function regResumenMensual(eps, cxs, cultivos) {
  var meses = {}, mes = function (f) { f = regFecha(f); return f ? f.slice(0, 7) : ''; };
  var M = function (m) { return meses[m] || (meses[m] = { ing: 0, egr: [], cx: [], cult: [], dx: {}, incompletos: 0 }); };
  regArr(eps).forEach(function (e) {
    if (e.excluir === 1) return;
    var mi = mes(e.ingreso), me = mes(e.egreso);
    if (mi) { var a = M(mi); a.ing++; if (e.dx) a.dx[e.dx] = (a.dx[e.dx] || 0) + 1; if (e.incompleto) a.incompletos++; }
    if (me) M(me).egr.push(e);
  });
  regArr(cxs).forEach(function (c) { var m = mes(c.f); if (m) M(m).cx.push(c); });
  regArr(cultivos).forEach(function (c) { var m = mes(c['Fecha de toma']); if (m && regTexto(c['ID episodio']).trim()) M(m).cult.push(c); });
  var pct = function (n, d) { return d ? regRedondear(100 * n / d, 1) : ''; };
  var top = function (mapa) { return Object.keys(mapa).sort(function (a, b) { return mapa[b] - mapa[a] || a.localeCompare(b); }).slice(0, 5).map(function (k) { return k + ' (' + mapa[k] + ')'; }).join('; '); };
  var cuenta = function (lista, f) { var m = {}; lista.forEach(function (x) { f(x).forEach(function (k) { if (k) m[k] = (m[k] || 0) + 1; }); }); return m; };
  return Object.keys(meses).sort().map(function (m) {
    var a = meses[m];
    var conDes = a.egr.filter(function (e) { return e.defuncion === 0 || e.defuncion === 1; }), def = a.egr.filter(function (e) { return e.defuncion === 1; }).length;
    var est = a.egr.map(function (e) { return e.estancia; }).filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (x, y) { return x - y; });
    var med = est.length ? (est.length % 2 ? est[(est.length - 1) / 2] : (est[est.length / 2 - 1] + est[est.length / 2]) / 2) : '';
    var conTipo = a.cx.filter(function (c) { return c.tipo; }), conAb = a.cx.filter(function (c) { return c.abordaje; });
    var re = a.egr.filter(function (e) { return e.re30 === 0 || e.re30 === 1; });
    var pos = a.cult.filter(function (c) { return c['Positivo'] === 1; });
    return {
      'Mes': m, 'Ingresos (n)': a.ing, 'Egresos (n)': a.egr.length, 'Egresos con desenlace conocido (n)': conDes.length, 'Defunciones (n)': def,
      'Mortalidad (%)': pct(def, conDes.length), 'Egresos sin motivo (n)': a.egr.length - conDes.length,
      'Estancia mediana (días)': med, 'Estancia media (días)': est.length ? regRedondear(est.reduce(function (x, y) { return x + y; }, 0) / est.length, 1) : '',
      'Pacientes operados (n)': Object.keys(cuenta(a.cx, function (c) { return [c.ep]; })).length, 'Cirugías (n)': a.cx.length,
      'Cirugías de urgencia (%)': pct(conTipo.filter(function (c) { return c.tipo === 'Urgencia'; }).length, conTipo.length),
      'Abordaje laparoscópico (%)': pct(conAb.filter(function (c) { return /^Laparosc|^Convertida/.test(c.abordaje); }).length, conAb.length),
      'Conversiones (n)': a.cx.filter(function (c) { return /^Convertida/.test(c.abordaje); }).length,
      'Complicación mayor (Clavien ≥ IIIa) (n)': a.cx.filter(function (c) { return REG_CLAVIEN_ORDEN.indexOf(c.clavien) >= 3; }).length,
      'Reintervenciones (n)': a.egr.filter(function (e) { return e.reint === 1; }).length,
      'Reingresos a 30 días (n)': re.filter(function (e) { return e.re30 === 1; }).length, 'Reingreso a 30 días (%)': pct(re.filter(function (e) { return e.re30 === 1; }).length, re.length),
      'Cultivos positivos (n)': pos.length,
      'Dx principales (más frecuentes)': top(a.dx), 'Cirugías por grupo (más frecuentes)': top(cuenta(a.cx, function (c) { return [c.grupo]; })),
      'Gérmenes (más frecuentes)': top(cuenta(pos, function (c) { return regTexto(c['Germen']).split(/\s*\+\s*/).map(function (x) { return x.replace(/\s*\(.*\)\s*$/, '').trim(); }).filter(function (x) { return x && !/^POSITIVO/i.test(x); }); })),
      'Ingresos con datos incompletos (n)': a.incompletos, 'Vigente': 'Sí'
    };
  });
}

/** Seudónimo: SHA-256 de (sal secreta + identidad), 12 caracteres hexadecimales. La sal vive en las propiedades del
 *  script (REG_SAL, se crea sola): sin ella no se puede volver del seudónimo al expediente. */
function regSal_(props) {
  var s = regTexto(props.getProperty('REG_SAL')).trim();
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('REG_SAL', s); }
  return s;
}
function regHash_(sal, texto) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, sal + '|' + texto, Utilities.Charset.UTF_8), s = '';
  for (var i = 0; i < 6; i++) s += ('0' + (b[i] & 255).toString(16)).slice(-2);
  return s.toUpperCase();
}
/** Calcula y escribe la clave de seudónimos y las pestañas de análisis (solo lo que cambió). `fus`: filas de cada pestaña
 *  del registro tal como quedaron escritas en esta corrida. Devuelve los avisos. */
function regEscribirAnalisis_(libro, props, fus, restauraciones, hoy, corte, cuentas) {
  var sal = regSal_(props), cache = {};
  var codigo = function (pre, ident, sinSal) { var k = pre + '|' + (sinSal ? '1' : '0') + '|' + ident; return cache[k] || (cache[k] = pre + '-' + regHash_(sinSal ? 'registro' : sal, ident)); };
  var hojaDe = function (cfg) {
    var h = libro.getSheetByName(cfg.nombre);
    if (!h) { h = libro.insertSheet(cfg.nombre); regAjustarColumnas_(h, cfg.columnas.length); }
    return h;
  };
  var hClave = hojaDe(REG_CLAVE), pClave = regLeerPestana_(hClave, REG_CLAVE);
  var an = regAnalisis(fus, pClave.filas, restauraciones, hoy, codigo), avisos = an.avisos || [];
  [REG_CLAVE].concat(REG_ANALISIS).forEach(function (cfg) {
    var hoja = cfg === REG_CLAVE ? hClave : hojaDe(cfg);
    var previo = cfg === REG_CLAVE ? pClave : regLeerPestana_(hoja, cfg);
    var filas = regFusionar(previo.filas, an[cfg.nombre] || [], cfg, null, hoy, null);
    var r = regEscribirPestana_(hoja, cfg, filas, previo, corte);
    if (r.aviso) avisos.push(r.aviso);
    cuentas[cfg.nombre] = filas.length;
  });
  regEscribirVariables_(libro);
  return avisos;
}

// ─── Diccionario de variables (codebook) de las pestañas de análisis ─────────────────────────────────────────────
function regVariables_() {
  var v = [['Pestaña', 'Variable', 'Tipo', 'Unidad', 'Definición']];
  var add = function (p, n, t, u, d) { v.push([p, n, t, u, d]); };
  var E = REG_AN_EPISODIOS, L = REG_AN_LABS, S = REG_AN_SIGNOS, C = REG_AN_CULTIVOS;
  add('Todas', 'Privacidad', '', '', 'Las pestañas «Análisis · …» no tienen nombres ni expedientes: son SEUDONIMIZADAS (no anónimas: fechas, diagnóstico y procedimientos pueden ayudar a reconocer a alguien). Compartir solo esas pestañas (Archivo → Descargar → CSV, una por una) y solo dentro de un protocolo aprobado por el Comité de Ética en Investigación. NUNCA compartir «Clave de seudónimos» ni las pestañas con nombres.');
  add('Todas', 'Vigente', 'texto', '', 'Sí: la fila sale de los datos actuales del registro. No: la generó una corrida anterior y ya no se genera (se corrigió un dato o cambió una regla); se conserva para trazabilidad. Para analizar, filtrar Vigente = Sí.');
  add('Todas', 'ID paciente', 'texto', '', 'Seudónimo de la persona (P-…): SHA-256 del expediente con una sal secreta. Mismo expediente con nombres incompatibles = dos personas (error de captura); sin expediente válido se usa el nombre. La correspondencia está en «Clave de seudónimos».');
  add('Todas', 'ID episodio', 'texto', '', 'Seudónimo de la hospitalización (E-…). Si una tarjeta se restauró desde la Papelera (otro id en la base), las partes son UN episodio.');
  add('Todas', 'Fecha', 'texto AAAA-MM-DD', '', 'Todas las fechas son ISO (AAAA-MM-DD, hora de Ciudad de México).');
  add('Todas', 'Día de estancia', 'entero', 'días', 'Días desde la fecha de ingreso del episodio (0 = día del ingreso; negativo = antes del ingreso, p. ej. urgencias).');
  add(E, 'Partes del registro', 'entero', '', 'Cuántos ids de la base forman el episodio (más de 1 = restaurado desde la Papelera).');
  add(E, 'N.º de episodio del paciente', 'entero', '', 'Orden del episodio entre los del mismo paciente (por fecha de ingreso; sin duplicados ni episodios sin fecha de ingreso).');
  add(E, 'Días desde el egreso previo', 'entero', 'días', 'Del egreso del episodio anterior del paciente a este ingreso. Vacío en el primero o si el anterior no tiene egreso.');
  add(E, 'Es reingreso (≤30 días)', '0/1', '', '1 si este ingreso ocurrió 0–30 días después del egreso anterior; 0 si después; vacío si no hay episodio anterior registrado (el registro empezó en 2026: los primeros pueden ser reingresos de antes).');
  add(E, 'Reingreso a 30 días', '0/1', '', '1 si el paciente volvió a ingresar a este servicio 0–30 días después de este egreso; 0 si no y ya pasaron 30 días; vacío si sigue hospitalizado, murió o aún no pasan 30 días. Solo ve reingresos a los servicios que usan la app.');
  add(E, 'Edad (años)', 'número', 'años', 'Edad del censo al ingreso (meses y días convertidos a fracción de año). Vacío si no se entiende.');
  add(E, 'Sexo', 'texto', '', 'F, M o vacío (sin registrar), con la misma regla que la app.');
  add(E, 'Especialidad · Sección', 'texto', '', 'Del censo, en la última parte del episodio.');
  add(E, 'Fecha de ingreso', 'texto AAAA-MM-DD', '', 'Fecha de ingreso del censo (la más antigua de las partes).');
  add(E, 'Fecha de egreso', 'texto AAAA-MM-DD', '', 'Fecha del egreso en la app o, si no la hay, la fecha en que se archivó. Vacío si sigue hospitalizado o salió sin registro.');
  add(E, 'Días de estancia', 'entero', 'días', 'Egreso − ingreso. Si no hay egreso: hasta hoy (hospitalizado) o hasta el último día que estuvo en la base. Usar con «Egreso observado» (0 = dato censurado).');
  add(E, 'Estado', 'texto', '', 'Hospitalizado, Egresado o Sin egreso registrado (salió de la base sin pasar por la Papelera).');
  add(E, 'Egreso observado', '0/1', '', '1 si se registró el egreso con fecha (y no es duplicado). Para análisis de supervivencia: 0 = censurado.');
  add(E, 'Tipo de egreso', 'texto', '', 'Alta, Defunción, Cambio de servicio, Contrarreferencia, Traslado, Alta voluntaria, Fuga, Otro, No fue egreso, Motivo no registrado, Duplicado (no es otro episodio) o Borrado en la base (revisar). Casi todos los egresos salen del censo de la hoja sin decir si fue alta o defunción: hasta que se registre el motivo, «Defunción» NO permite calcular mortalidad.');
  add(E, 'Defunción', '0/1', '', '1 = registrada como defunción; 0 = salió vivo del servicio (alta, alta voluntaria, traslado, contrarreferencia, fuga o cambio de servicio; en cambio de servicio el desenlace posterior en el hospital no se conoce); vacío = desconocido (motivo no registrado, «otro motivo», «no fue egreso», hospitalizado). NUNCA tratar vacío como 0.');
  add(E, 'Motivo de egreso (app)', 'texto', '', 'Etiqueta original del egreso en la app (p. ej. «RETIRADO DEL CENSO (hoja)»).');
  add(E, 'Excluir (duplicado)', '0/1', '', '1 = tarjeta duplicada (no es otro episodio): excluir. Vacío = borrado en la base por mantenimiento: revisar. 0 = episodio real.');
  add(E, 'Diagnóstico', 'texto', '', 'Diagnóstico del censo en la última parte del episodio (texto libre, sin codificar).');
  add(E, 'Dx principal · CIE-10 (grupo) · Dx principal (fuente)', 'texto', '', 'Diagnóstico principal de una lista corta del servicio (apendicitis, colecistitis, pancreatitis, oclusión, hernia, cáncer colorrectal…) con su grupo CIE-10. Fuente: «Elegido en la app» (🩺 Dx principal, bajo la caja DX) o «Inferido del DX» (la misma tabla sobre el texto del DX: el término que aparece primero). Para publicar, preferir los elegidos o revisar los inferidos.');
  add(E, 'Urgencia (1.ª cirugía) · Abordaje (1.ª cirugía)', '0/1 · texto', '', 'De la primera cirugía por fecha, como se eligió en la caja Cirugías: 1 = urgencia, 0 = electiva, vacío = no se registró. Abordaje: Abierta, Laparoscópica, Convertida (laparoscópica → abierta), Endoscópica / percutánea u Otro.');
  add(E, 'Conversión', '0/1', '', '1 = alguna cirugía laparoscópica se convirtió a abierta; 0 = hubo laparoscopía sin conversión; vacío = sin abordaje laparoscópico registrado.');
  add(E, 'Clavien-Dindo máximo · Complicación mayor (Clavien ≥ IIIa)', 'texto · 0/1', '', 'El grado más alto de complicación postoperatoria registrado en las cirugías del episodio (Sin complicación, I, II, IIIa, IIIb, IVa, IVb, V; Dindo, Ann Surg 2004). Complicación mayor: 1 si ≥ IIIa; vacío si ninguna cirugía tiene grado.');
  add(E, 'Cirugías sin clasificar (n)', 'entero', '', 'Cirugías de la caja sin urgencia/electiva, abordaje o Clavien-Dindo: conviene completarlas (ver «Por completar»).');
  add(E, 'Peso (kg) · Talla (m) · IMC (kg/m²)', 'número', 'kg / m / kg/m²', 'Peso y talla del Pase Matutino (fila Clínico). Talla en cm se pasa a metros. IMC = peso ÷ talla². Vacío si no se registró o no es posible (peso 0.4–400 kg, talla 0.3–2.5 m).');
  add(E, REG_COMORB.map(function (c) { return c[0]; }).join(' · '), '0/1', '', 'Desde los Antecedentes (APP) y el diagnóstico de todas las partes del episodio, con negación («NIEGA DM, HAS», «HAS NEGADA» = 0). 1 = mencionada (en APP o DX); 0 = hay APP y no la menciona (o la niega); vacío = sin APP (desconocida). Obesidad también = 1 con IMC ≥ 30 en adultos. Es texto libre: revisar una muestra antes de publicar.');
  add(E, 'Comorbilidades (n)', 'entero', '', 'Cuántas comorbilidades hay en 1 (sin contar tabaquismo). Vacío si no hay APP (el conteo no sería confiable).');
  add(E, 'Índice urinario mínimo (mL/kg/h) · Días con oliguria (IU < 0.5)', 'número / entero', 'mL/kg/h / días', 'De «' + S + '»: el índice urinario más bajo del episodio y cuántos días quedó < 0.5 mL/kg/h (KDIGO). Vacío si no hubo uresis con peso.');
  add(E, 'Cirugías (n) · Primera cirugía · Días ingreso a 1.ª cirugía', 'entero / fecha / entero', '', 'Cirugías del episodio (sin repetir entre partes): las de la caja Cirugías y, si no estaban ahí, las tomadas de la fecha POP, el texto Qx, la Cronología o el DX (ver «Fuente» en la pestaña Cirugías). No cuenta la programación del día sin confirmar. Fecha de la primera y días desde el ingreso.');
  add(E, 'Grupo de la 1.ª cirugía', 'texto', '', 'Grupo del procedimiento (Laparotomía exploradora, Colecistectomía, Apendicectomía, Plastia de pared / hernia, Resección intestinal, Colectomía, Estoma, Lavado / desbridamiento…) de la primera cirugía por fecha.');
  add(E, 'Reintervención', '0/1', '', '1 = dos o más cirugías en el episodio o una relaparotomía; 0 = una sola cirugía; vacío = sin cirugía.');
  add(E, 'Cirugías inferidas (n)', 'entero', '', 'Cuántas de las cirugías se tomaron de otra caja (DX, Cronología, fecha POP o texto Qx) porque no estaban en la caja Cirugías: conviene pasarlas a la caja.');
  add(E, 'Programadas sin confirmar (n)', 'entero', '', 'Cirugías que solo aparecen en la programación del día (sin otra cirugía en esos días): no se cuentan como hechas.');
  add(E, 'Sangrado total (mL)', 'número', 'mL', 'Suma del sangrado de las cirugías. Vacío si alguna tiene un sangrado que no es número (p. ej. «MÍNIMO»).');
  add(E, 'Procedimientos', 'texto', '', 'Fecha y procedimiento de cada cirugía, separados por « | » (texto libre, sin codificar).');
  add(E, 'Antibiótico (registrado) · NPT (registrada) · Ventilación mecánica (registrada) · Vasopresor (registrado) · Tromboprofilaxis (registrada)', '0/1', '', '1 = marcado en la última copia de la tarjeta; 0 = no marcado (NO prueba que no lo recibió; la app no guarda fechas de inicio y fin).');
  add(E, 'Fechas con labs (n) · Valores críticos (n)', 'entero', '', 'Días con laboratorio y número de valores críticos (tabla única de la app: ≤ crítico bajo o ≥ crítico alto).');
  REG_LAB_RESUMEN.forEach(function (r) { add(E, r[2], 'número', (REG_LAB_POR_CLAVE[r[0]] || {}).u || '', (r[1] === 'min' ? 'Mínimo' : r[1] === 'max' ? 'Máximo' : 'Primer valor (fecha más antigua)') + ' del episodio, de «' + L + '». Un «<x» / «>x» cuenta como x.'); });
  add(E, 'Cultivos (n) · Cultivos positivos (n) · Gérmenes aislados', 'entero / texto', '', 'Cultivos de WinLab del paciente tomados desde 2 días antes del ingreso hasta el egreso.');
  add(E, 'Calidad de datos', 'texto', '', 'Todo lo que falta o no se pudo usar en el episodio.');
  var R = REG_AN_RESUMEN, PC = REG_POR_COMPLETAR;
  add(R, 'Privacidad', '', '', 'Solo cuentas por mes: no tiene nombres ni seudónimos. Se puede compartir dentro del servicio.');
  add(R, 'Mes', 'texto AAAA-MM', '', 'Mes calendario. Ingresos por mes de ingreso; egresos, mortalidad, estancia, reintervenciones y reingresos por mes de egreso; cirugías por mes de la cirugía; cultivos por mes de toma. Sin duplicados (Excluir = 1).');
  add(R, 'Ingresos (n) · Egresos (n) · Egresos con desenlace conocido (n) · Defunciones (n) · Egresos sin motivo (n)', 'entero', '', 'Egresos = egresos observados (con fecha). Con desenlace conocido = Defunción 0 o 1 (motivo registrado). Sin motivo = egresos que nadie clasificó.');
  add(R, 'Mortalidad (%)', 'número', '%', 'Defunciones ÷ egresos con desenlace conocido × 100. Vacío si ningún egreso del mes tiene motivo. Mientras haya muchos «Egresos sin motivo», la cifra no representa al servicio.');
  add(R, 'Estancia mediana (días) · Estancia media (días)', 'número', 'días', 'De los egresos del mes.');
  add(R, 'Pacientes operados (n) · Cirugías (n)', 'entero', '', 'Cirugías con fecha en el mes (de la caja y las inferidas; no la programación sin confirmar) y cuántos episodios distintos.');
  add(R, 'Cirugías de urgencia (%) · Abordaje laparoscópico (%)', 'número', '%', 'Sobre las cirugías del mes que tienen el dato (urgencia/electiva; abordaje). Laparoscópico incluye las convertidas.');
  add(R, 'Conversiones (n) · Complicación mayor (Clavien ≥ IIIa) (n)', 'entero', '', 'Cirugías del mes convertidas de laparoscópica a abierta y con Clavien-Dindo ≥ IIIa.');
  add(R, 'Reintervenciones (n)', 'entero', '', 'Egresos del mes con «Reintervención» = 1.');
  add(R, 'Reingresos a 30 días (n) · Reingreso a 30 días (%)', 'entero · número', '%', 'Egresos del mes que reingresaron en 30 días, sobre los que ya tienen el dato (0/1).');
  add(R, 'Cultivos positivos (n) · Gérmenes (más frecuentes)', 'entero · texto', '', 'Cultivos de WinLab de pacientes del servicio tomados en el mes; los 5 gérmenes más frecuentes con su número.');
  add(R, 'Dx principales (más frecuentes) · Cirugías por grupo (más frecuentes)', 'texto', '', 'Los 5 más frecuentes del mes con su número (dx principal de los ingresos; grupo de las cirugías).');
  add(R, 'Ingresos con datos incompletos (n)', 'entero', '', 'Ingresos del mes a los que les falta algo de «Por completar» (motivo, sexo, edad, APP, peso, talla, dx principal o cirugías).');
  add(PC, 'Privacidad', '', '', 'TIENE NOMBRES: es la lista de trabajo del equipo para completar las tarjetas. No se comparte ni se descarga para estudios.');
  add(PC, 'ID episodio', 'texto', '', 'Id del paciente en la base (no es seudónimo): el de la tarjeta en la app.');
  add(PC, 'Estado · Cama · Nombre · Expediente · Fecha de ingreso · Fecha de egreso', 'texto', '', 'Del censo y de la Papelera (la última parte del episodio). Entran los hospitalizados y los egresados de los últimos 30 días.');
  add(PC, 'Falta · Faltantes (n)', 'texto · entero', '', 'Lo que le falta a la tarjeta para el registro: motivo del egreso, sexo, edad, APP, peso, talla, dx principal, cirugías por pasar a la caja y cirugías sin urgencia/abordaje/Clavien. Cuando se completa, la fila queda «Vigente: No» (resuelta).');
  add(L, 'Fila', '', '', 'Una fila por episodio y fecha; una columna por estudio en la unidad de la app (WinLab ya convertido). Vacío = no se midió o no se pudo usar (ver Observaciones). Ojo con lo anterior al 27 oct 2026: la app no revisaba la unidad de WinLab (troponina I en ng/mL, glucosa en mmol/L, fibrinógeno en g/L) y antes de oct 2026 el examen de orina pudo caer en la biometría: revisar valores atípicos antes de analizar.');
  add(L, 'Fuente', 'texto', '', 'Origen de los valores del día: winlab (robot), manual, sin registro (capturas viejas).');
  REG_LAB_META.forEach(function (m) {
    var rango = m.t === 'texto' ? 'Cualitativo (texto tal cual).' : (m.extra ? 'Sin rango en la app; unidad del reporte de WinLab.' : ('Referencia ' + m.lo + '–' + m.hi + (m.cl !== undefined ? '; crítico ≤ ' + m.cl : '') + (m.ch !== undefined ? '; crítico ≥ ' + m.ch : '') + '.'));
    var imp = REG_LAB_IMPOSIBLE[m.k];
    add(L, regLabColumna(m), m.t === 'texto' ? 'texto' : 'número', m.u, 'Clave en la app: ' + m.k + '. ' + rango + (imp ? ' Valores < ' + imp[0] + ' o > ' + imp[1] + ' se consideran imposibles y se dejan vacíos.' : ''));
  });
  add(L, 'Otros estudios', 'texto', '', 'Estudios que no están en la tabla de la app («clave: valor»), sin unidad normalizada.');
  add(L, 'Valores críticos', 'texto', '', 'Estudios del día en rango crítico.');
  add(L, 'Observaciones', 'texto', '', 'Muestra rechazada, unidad no reconocida, valor que no es número o imposible, «<x»/«>x» (se anota x), dos valores el mismo día, valores ya corregidos en la tarjeta.');
  REG_SV.forEach(function (s) { add(S, s[1], 'número', '', 'Del pase de visita («' + s[0] + '»). Posible: ' + s[2] + ' a ' + s[3] + '; fuera de eso o con texto → vacío y Observaciones.' + (s[0] === 'O2 L/min' ? ' «AA» (aire ambiente) = 0.' : '')); });
  add(S, 'TA sistólica (mmHg) · TA diastólica (mmHg) · PAM (mmHg)', 'número', 'mmHg', 'De «TA» (sistólica/diastólica). PAM = (sistólica + 2 × diastólica) / 3, a un decimal.');
  add(S, 'Horas de uresis (h) · Índice urinario (mL/kg/h)', 'número', 'h / mL/kg/h', 'Horas de la uresis (columna «Horas» del Pase Matutino desde el 28 oct 2026, o las que diga la uresis, «900/12 H»; sin horas se toman 24 h y se avisa). Índice urinario = uresis ÷ peso del episodio ÷ horas, como en la app.');
  add(S, 'Observaciones', 'texto', '', 'Signos que no se pudieron usar (texto, fuera de lo posible, TA no interpretable) y avisos del índice urinario.');
  add(C, 'ID cultivo', 'texto', '', 'Seudónimo de la muestra (C-…): una fila por muestra de cultivo de WinLab (robot), sin el texto del reporte (trae el nombre).');
  add(C, 'Fecha de toma · Hora de toma', 'texto', '', 'Fecha (AAAA-MM-DD) y hora (HH:MM) de la toma según WinLab.');
  add(C, 'Tipo · Muestra', 'texto', '', 'Tipo de cultivo y muestra como los lee el robot (p. ej. Hemocultivo, Urocultivo; ORINA).');
  add(C, 'Resultado · Positivo', 'texto / 0/1', '', 'POSITIVO (1), Negativo (0), En proceso o Sin muestra (vacío).');
  add(C, 'Germen', 'texto', '', 'Germen(es) aislado(s) con sus marcas (p. ej. BLEE); vacío si no es positivo.');
  add(C, 'Sensibles · Intermedios · Resistentes', 'texto', '', 'Antibiograma del PDF (S/I/R), como en «Cultivos del robot (WinLab)».');
  add(C, 'UFC · Fuente', 'texto', '', 'Cuenta de colonias si la hay; de dónde salió el resultado (PDF del reporte o tabla del reporte).');
  add(C, 'ID episodio', 'texto', '', 'Vacío si la toma no cae en ningún episodio del registro (desde 2 días antes del ingreso hasta el egreso).');
  return v;
}
function regEscribirVariables_(libro) {
  var hoja = libro.getSheetByName('Diccionario de variables');
  if (!hoja) { hoja = libro.insertSheet('Diccionario de variables'); regAjustarColumnas_(hoja, 5); }
  var filas = regVariables_().map(function (r) { return r.map(regCelda); });
  if (hoja.getMaxColumns() < 5) hoja.insertColumnsAfter(hoja.getMaxColumns(), 5 - hoja.getMaxColumns());
  // Solo si cambió (una versión nueva del script): igual que las demás pestañas, una corrida sin cambios no reescribe.
  var n = hoja.getLastRow();
  if (n === filas.length && JSON.stringify(hoja.getRange(1, 1, n, 5).getValues().map(function (r) { return r.map(regTexto); })) === JSON.stringify(filas)) return;
  regAsegurarFilas_(hoja, filas.length);
  hoja.getRange(1, 1, filas.length, 5).setNumberFormat('@').setValues(filas);
  var sobra = hoja.getLastRow() - filas.length;
  if (sobra > 0) hoja.getRange(filas.length + 1, 1, sobra, 5).clearContent();
  hoja.setFrozenRows(1);
}

// ─── Hoja ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Filas de la pestaña como objetos por nombre de columna, cada una con su renglón (__fila), y dónde está cada columna
 *  (por nombre: el orden de la hoja no importa). Si tiene datos pero le falta una columna de la clave (se renombró el
 *  encabezado), se detiene: escribir sin leerla bien borraría su historia. */
function regLeerPestana_(hoja, cfg) {
  var n = hoja.getLastRow(), m = hoja.getLastColumn();
  var vacio = { filas: [], porFila: {}, mapa: {}, conDatos: false };
  if (n < 1 || m < 1) return vacio;
  var vals = hoja.getRange(1, 1, n, m).getValues();
  var enc = vals[0].map(function (h) { return regTexto(h).trim(); });
  var conDatos = vals.slice(1).some(function (f) { return f.some(function (v) { return regTexto(v).trim(); }); });
  if (conDatos && cfg.clave.some(function (c) { return enc.indexOf(c) === -1; })) {
    throw new Error('La pestaña «' + cfg.nombre + '» no tiene la columna «' + cfg.clave.filter(function (c) { return enc.indexOf(c) === -1; })[0] + '» en la fila 1: no se actualizó nada para no perder datos (regrese el encabezado).');
  }
  var mapa = {};
  enc.forEach(function (h, j) { if (h && !mapa[h]) mapa[h] = j + 1; });
  var filas = [], porFila = {};
  vals.slice(1).forEach(function (fila, i) {
    var o = {};
    enc.forEach(function (h, j) { if (h && o[h] === undefined) o[h] = fila[j]; });
    if (!regClaveDe(o, cfg).replace(new RegExp(REG_SEP, 'g'), '').trim()) return;
    o.__fila = i + 2; porFila[i + 2] = o; filas.push(o);
  });
  return { filas: filas, porFila: porFila, mapa: mapa, conDatos: conDatos };
}
/** Texto para una celda (la columna es de texto plano: no se interpreta como fórmula ni fecha), recortado al límite. */
function regCelda(v) {
  if (typeof v === 'number') return v;
  var s = regTexto(v);
  if (s.length > REG_MAX_CELDA) s = s.slice(0, REG_MAX_CELDA) + ' …[recortado]';
  return s;
}
function regAsegurarFilas_(hoja, n) { if (hoja.getMaxRows() < n) hoja.insertRowsAfter(hoja.getMaxRows(), n - hoja.getMaxRows()); }
/** Pestaña nueva: sin las columnas vacías de sobra (Sheets crea 26 y cuentan para el límite de celdas). */
function regAjustarColumnas_(hoja, nc) { if (hoja.getMaxColumns() > nc) hoja.deleteColumns(nc + 1, hoja.getMaxColumns() - nc); }
/** Escribe solo lo que cambió, cada fila en SU renglón (__fila) y cada valor en la columna con SU nombre; las filas nuevas
 *  van al final. Nunca reescribe ni recorre otras filas, y no toca las columnas que no son del registro (las que agregue
 *  un investigador, en cualquier lugar). Si a la hoja le falta una columna del registro (versión nueva, o se renombró
 *  una), se agrega al final con su encabezado y se avisa. `corte()` → se detiene (lanza regCorte) antes de otro setValues.
 *  Devuelve { escritas, aviso }. */
function regEscribirPestana_(hoja, cfg, filas, previo, corte) {
  var columnas = cfg.columnas, mapa = Object.assign({}, previo.mapa), aviso = '';
  var faltan = columnas.filter(function (c) { return !mapa[c]; });
  if (faltan.length) {
    var desde = hoja.getLastColumn() + 1;
    if (hoja.getMaxColumns() < desde - 1 + faltan.length) hoja.insertColumnsAfter(hoja.getMaxColumns(), desde - 1 + faltan.length - hoja.getMaxColumns());
    regAsegurarFilas_(hoja, 1);
    hoja.getRange(1, desde, 1, faltan.length).setNumberFormat('@').setValues([faltan]);
    faltan.forEach(function (c, i) { mapa[c] = desde + i; });
    if (desde === 1) hoja.setFrozenRows(1);
    if (previo.conDatos) aviso = 'La pestaña «' + cfg.nombre + '» no tenía la(s) columna(s) «' + faltan.join('», «') + '»: se agregaron al final (si se renombró una, sus datos siguen en la columna renombrada).';
  }
  // Columnas del registro agrupadas en tramos contiguos de la hoja (normalmente uno solo).
  var orden = columnas.map(function (c) { return { c: c, col: mapa[c] }; }).sort(function (a, b) { return a.col - b.col; });
  var tramos = [];
  orden.forEach(function (x) { var t = tramos[tramos.length - 1]; if (t && x.col === t.col + t.cols.length) t.cols.push(x.c); else tramos.push({ col: x.col, cols: [x.c] }); });
  var celdasDe = function (r) { return orden.map(function (x) { return regCelda(r[x.c]); }); };
  // Formato por columna: texto plano ('@') salvo las numéricas de las pestañas de análisis (cfg.formatos), que se
  // guardan como número para que Sheets y el CSV las tomen como tales.
  var formatosDe = function (t) { return t.cols.map(function (c) { return (cfg.formatos && cfg.formatos[c]) || '@'; }); };
  var igual = function (a, b) { for (var i = 0; i < a.length; i++) { if (String(a[i]) !== String(b[i])) return false; } return true; };
  var cambios = [], nuevas = [];
  filas.forEach(function (r) {
    var c = celdasDe(r);
    if (r.__fila) { var v = previo.porFila[r.__fila]; if (!v || !igual(c, celdasDe(v))) cambios.push({ fila: r.__fila, celdas: c }); }
    else nuevas.push(c);
  });
  cambios.sort(function (a, b) { return a.fila - b.fila; });
  var primeraNueva = Math.max(hoja.getLastRow(), 1) + 1;
  nuevas.forEach(function (c, i) { cambios.push({ fila: primeraNueva + i, celdas: c }); });
  if (nuevas.length) regAsegurarFilas_(hoja, primeraNueva - 1 + nuevas.length);
  // Bloques de renglones contiguos; cada bloque se escribe por tramo de columnas.
  var escritas = 0;
  for (var i = 0; i < cambios.length;) {
    var j = i;
    while (j + 1 < cambios.length && cambios[j + 1].fila === cambios[j].fila + 1 && j + 1 - i < REG_BLOQUE) j++;
    var bloque = cambios.slice(i, j + 1), base = 0;
    tramos.forEach(function (t) {
      if (corte && corte()) { var e = new Error('corte'); e.regCorte = true; throw e; }
      var datos = bloque.map(function (x) { return x.celdas.slice(base, base + t.cols.length); });
      var rango = hoja.getRange(bloque[0].fila, t.col, bloque.length, t.cols.length);
      if (cfg.formatos) { var f = formatosDe(t); rango.setNumberFormats(bloque.map(function () { return f; })); } else rango.setNumberFormat('@');
      rango.setValues(datos);
      base += t.cols.length;
    });
    escritas += bloque.length;
    i = j + 1;
  }
  return { escritas: escritas, aviso: aviso };
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
    ['Privacidad', 'Contiene nombres y expedientes. Mantener en la carpeta privada; compartir solo como lector y solo con personas autorizadas por el protocolo aprobado por el Comité de Ética en Investigación. Para un análisis, compartir solo las pestañas «Análisis · …» (Archivo → Descargar → CSV, una por una) y el Diccionario de variables.'],
    ['ID episodio', 'Id del paciente en la base (una hospitalización). Un reingreso es otro episodio.'],
    ['Estado en registro', 'Hospitalizado (en el censo), Egresado (en la Papelera) o «Salió de la base sin egreso registrado».'],
    ['Motivo de egreso', 'Etiqueta del egreso en la app (ALTA, DEFUNCIÓN, alta médica, EGRESO, CAMA REASIGNADA…).'],
    ['Episodio relacionado', 'Restaurar desde la Papelera crea otro id: «Continúa en …» / «Viene de …» une las dos partes de la misma hospitalización.'],
    ['Fecha de egreso', 'Fecha del egreso en la app o, si no la hay, la fecha (hora de Ciudad de México) en que se archivó.'],
    ['Días de estancia', 'Desde la fecha de ingreso hasta el egreso (o hasta hoy si sigue hospitalizado).'],
    ['Vigente', 'Sí: está en la tarjeta en la última copia. No: estuvo y ya no (corregido, borrado o movido); se conserva.'],
    ['Signos vitales y Notas de evolución', 'La app guarda 14 días de signos y 10 notas; aquí se acumulan todos.'],
    ['Labs del robot (WinLab)', 'Un renglón por reporte de WinLab del paciente, con la regla de identidad del robot: lo que el robot marcó (nombre, alias, edad, homónimos) o, en capturas anteriores al 9 oct 2026, esa misma regla aplicada aquí; nunca de homónimos (si no se puede decidir, no se copia). Valores: un renglón por estudio «ESTUDIO: valor unidad (ref. …)». Toma y Resultado: fecha y hora del reporte.'],
    ['Cultivos del robot (WinLab)', 'Un renglón por muestra de cultivo de esos reportes: del PDF del reporte cuando el robot lo leyó (germen y antibiograma S/I/R) o de la tabla del reporte.'],
    ['Imagen del robot (RIS)', 'Lo que capturó el robot de RIS, por expediente y episodio.'],
    ['Nota / Checklist completo (JSON)', 'Todo lo demás de la tarjeta, sin archivos incrustados.'],
    ['Pestañas «Análisis · …»', 'Versión para estadística de todo lo anterior, recalculada cada noche: sin nombres ni expedientes (ID seudónimo), números como números, fechas AAAA-MM-DD, una fila por episodio / por día de labs / por día de signos / por cultivo. Cada columna está definida en «Diccionario de variables». Lo que no se pudo tomar como dato queda vacío y explicado. Una hospitalización restaurada desde la Papelera es UN episodio.'],
    ['Clave de seudónimos', 'ID episodio de la base → ID paciente / ID episodio de análisis. Es la llave para volver a los datos con nombre: NO compartirla. La sal del seudónimo está en las propiedades del script (REG_SAL).'],
    ['Respaldo', 'Una sola hoja: el respaldo es su historial de versiones (Archivo → Historial de versiones). El registro nunca borra renglones.'],
    ['Cuidado', 'Se pueden agregar columnas propias y usar filtros: el registro no las toca. No renombrar los encabezados del registro (si falta uno, se agrega al final; si falta una columna clave, el registro se detiene y avisa).']
  ];
  if (hoja.getMaxColumns() < 2) hoja.insertColumnsAfter(hoja.getMaxColumns(), 2 - hoja.getMaxColumns());
  regAsegurarFilas_(hoja, filas.length);
  hoja.getRange(1, 1, filas.length, 2).setNumberFormat('@').setValues(filas.map(function (r) { return [regCelda(r[0]), regCelda(r[1])]; }));
  var sobra = hoja.getLastRow() - filas.length;
  if (sobra > 0) hoja.getRange(filas.length + 1, 1, sobra, 2).clearContent();
}
/** UNA sola hoja (27 oct 2026): antes, cada 7 días se guardaba una copia completa en la carpeta («Respaldo — <hoja> — fecha»)
 *  y la carpeta tenía dos o más «bases». Ya no se copia: el respaldo es el historial de versiones de Sheets. Las copias que
 *  hizo este script (solo las que llevan ese prefijo exacto, en la carpeta de la hoja) van UNA vez a la papelera de Drive. */
function regQuitarCopiasViejas_(libro, props) {
  if (props.getProperty('REG_COPIAS_QUITADAS')) return;
  var archivo = DriveApp.getFileById(libro.getId());
  var padres = archivo.getParents();
  if (padres.hasNext()) {
    var carpeta = padres.next(), prefijo = 'Respaldo — ' + archivo.getName() + ' — ', it = carpeta.getFiles();
    while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(prefijo) === 0) f.setTrashed(true); }
  }
  props.setProperty('REG_COPIAS_QUITADAS', new Date().toISOString());
  props.deleteProperty('REG_ULTIMO_RESPALDO');
}
