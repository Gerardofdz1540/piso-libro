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
 * INTEGRIDAD (24 nov 2026): cada corrida deja UNA fila en la pestaña «Integridad» (también si falla): resultado, tiempos,
 * bytes leídos por tabla y el cuadre de la base contra la hoja. Además copia los renglones de guardia retirados
 * (guardia_cortes, que la base purga a los 7 días) y lo que se borra de la Papelera (archive_eliminados).
 *
 * FOTO DIARIA E HISTORIAL (24 nov 2026): «Estado diario» (el tratamiento de cada hospitalizado, cada noche), «Dispositivos»
 * y «Drenajes · diario» salen de lo que ya se lee. «Movimientos y estado», «Soporte y exposiciones (historial)» y
 * «Actividad por episodio y día» salen de audit_log por cursor: solo sub-rutas del diff, nunca nombres, correos ni IP.
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
var REGISTRO_VERSION = '2026.11.26-2';
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
// 24 nov 2026: cada fuente puede traer su propio margen de relectura (margenMs; si no, los 2 días de siempre) y leer una
// tabla con otro nombre (tabla). WinLab era ~80 % de lo que se baja cada noche y su margen de 2 días releía ~2.2 MB: con
// 6 h basta (el robot escribe scraped_at al guardar) y lo que cambie en sitio se vigila en «Integridad». guardia_cortes
// se purga en la base a los 7 días: se lee cada noche con 1 h de margen. archive_eliminados: lo borrado de la Papelera.
var REG_MARGEN_WINLAB_MS = 6 * 3600000, REG_MARGEN_GUARDIA_MS = 3600000, REG_MARGEN_AUDIT_MS = 3600000;
var REG_CURSORES = {
  archive: { col: 'archived_at', tope: 400 },
  winlab_labs: { col: 'scraped_at', tope: 1500, margenMs: REG_MARGEN_WINLAB_MS },
  ris_estudios: { col: 'scraped_at', tope: 3000 },
  archive_eliminados: { col: 'eliminado_en', tope: 200 },
  guardia_cortes: { col: 'ts', tope: 2000, margenMs: REG_MARGEN_GUARDIA_MS },
  // 24 nov 2026: historial de auditoría (audit_log), dos lecturas de la misma tabla con su propio cursor (ts + id) y su
  // filtro. Filas chicas (solo sub-rutas del diff): el tope es alto para que la carga inicial (desde el 14 oct) tome
  // pocas vueltas; el límite real es el tiempo de lectura (REG_LECTURA_MS). Margen de 1 h: el disparador de la base
  // junta el tecleo seguido en la misma fila y le mueve el ts (hasta 30 min).
  // 24 nov 2026 (revisión): audit_notas NO baja las filas cuyos campos son solo lab_history / imagen_history (not.cd =
  // «no contenido en»): las reescribe la sincronización de la app, llevan usuario y eran 60-87 % de las filas de notes
  // (~0.3 KB cada una, todo sub-rutas nulas). Las de campos nulo sí se leen (no se pierde nada por el filtro).
  audit_pacientes: { tabla: 'audit_log', col: 'ts', tope: 6000, margenMs: REG_MARGEN_AUDIT_MS, filtro: 'tabla=eq.patients&or=(op.in.(INSERT,DELETE),campos.ov.{cama,estado,seccion,esp})' },
  audit_notas: { tabla: 'audit_log', col: 'ts', tope: 12000, margenMs: REG_MARGEN_AUDIT_MS, filtro: 'tabla=eq.notes&op=eq.UPDATE&or=(campos.is.null,campos.not.cd.{lab_history,imagen_history})' },
  // 25 nov 2026 (registro 2026.11.26-2): la sección PROCEDIMIENTOS de la hoja del censo (censo-sync.gs la guarda en
  // censo_procedimientos y le pone visto_ultimo al día cada hora mientras siga en la hoja). Margen de 2 días.
  censo_procedimientos: { col: 'visto_ultimo', tope: 3000 }
};
// Avisos por tiempo (24 nov 2026): sin corrida completa en 36 h; sin leer guardia_cortes en 6 días (la base purga a los 7).
var REG_SIN_COMPLETA_MS = 36 * 3600000, REG_GUARDIA_AVISO_MS = 6 * 86400000;
var REG_CONTINUACIONES_DIA = 8;
// 24 nov 2026 (revisión): aviso al 50 % (antes 70 %: dejaba ~4 meses). Desde el 95 % el registro entra en PAUSA
// PARCIAL: no lee ni escribe las pestañas grandes de los robots (la base las conserva) ni las de análisis (se recalculan),
// para que las celdas que quedan sean de lo que no se puede volver a tomar (estado diario, guardia, drenajes, pacientes).
var REG_CELDAS_MAX = 10000000, REG_CELDAS_AVISO = 0.5, REG_CELDAS_CRITICO = 0.95;
var REG_PAUSA_LLENO = ['winlab_labs', 'ris_estudios'];
/** ¿El error es el de Sheets por pasar del límite de celdas del libro? (el texto cambia con el idioma de la cuenta). */
function regEsLimiteCeldas_(e) {
  return /above the limit of \d+ cells|limit of 10,?000,?000|10,?000,?000 (cells|celdas|de celdas)|l[ií]mite de \d[\d,. ]* ?celdas|n[uú]mero de celdas/i.test(regTexto(e && e.message !== undefined ? e.message : e));
}
var REG_UTC_OFFSET_MIN = -360;     // America/Mexico_City: UTC-6 todo el año (sin horario de verano desde oct 2022)
var REG_BLOQUE = 4000;             // filas por setValues
var REG_SEP = '␟';
var REG_WL_LABS = 'Labs del robot (WinLab)';
// Pestañas nuevas del 24 nov 2026: compactas (solo «ID episodio»: sin Expediente ni Nombre; se cruzan con Pacientes).
var REG_ESTADO_DIARIO = 'Estado diario', REG_DISPOSITIVOS = 'Dispositivos', REG_DRENAJES_DIARIO = 'Drenajes · diario';
var REG_MOVIMIENTOS = 'Movimientos y estado', REG_SOPORTE = 'Soporte y exposiciones (historial)', REG_ACTIVIDAD = 'Actividad por episodio y día';
var REG_NO_VALIDO = 'valor no válido';
// 25 nov 2026 (registro 2026.11.26-2): seguimiento de operados. «Procedimientos del censo» es cruda (con nombres, junto a
// las demás crudas); «Seguimiento de operados» es lista de trabajo con nombres, como «Por completar».
var REG_PROC_CENSO = 'Procedimientos del censo', REG_SEGUIMIENTO = 'Seguimiento de operados';
var REG_GUARDIA_CORTES = 'Guardia · renglones retirados', REG_RIS = 'Imagen del robot (RIS)', REG_NOTA_JSON = 'Nota completa (JSON)', REG_NOTA_JSON_2 = 'Nota completa (JSON) · 2';
// Celdas que pasaron de REG_MAX_CELDA y se recortaron en esta corrida (24 nov 2026): antes se cortaban sin avisar.
var REG_RECORTE = ' …[recortado]', REG_CORRIDA = { recortes: 0 };
// Sexo: el de la tarjeta; si no lo tiene, el del encabezado de WinLab del paciente (29 oct 2026), con esta marca.
var REG_SEXO_TARJETA = 'Tarjeta', REG_SEXO_WL = 'de WinLab';
// 25 nov 2026: tercera fuente, la de menor prioridad: el sexo inferido del nombre de pila (regSexoDeNombre), solo si ni la
// tarjeta ni WinLab lo traen. Si alguna de las dos lo trae y no coincide con el nombre, mandan ellas.
var REG_SEXO_NOMBRE = 'Inferido del nombre';
// WinLab se vuelve a leer completo UNA vez cuando cambia esta marca (29 oct 2026: para tomar el sexo de los encabezados).
var REG_WL_RELECTURA = 'sexo-2026-10-29';

// Pestañas: columnas (orden de la hoja), clave de cada fila, modo de fusión y, si sale de una sola tabla, su fuente:
//   'pacientes' una fila por episodio; si deja de estar en la base se conserva («Salió de la base…» si seguía hospitalizado)
//   'vigente'   lo que la tarjeta trae hoy (Vigente: Sí); lo que ya no trae se conserva con Vigente: No
//   'acumula'   historial que la app recorta (signos 14 días, notas de evolución 10) o lecturas incrementales: se agrega y
//               se actualiza por clave, nunca se marca ni se quita
// Opciones de fusión (24 nov 2026): conservarViejo = columnas que, si la hoja ya las tiene escritas, no se pisan con lo de
// hoy («Primera vez visto»); combinar(vieja, nueva) = cómo se suma lo de hoy a la fila que ya está (lecturas por partes).
// formatos = columnas que se guardan como número (las demás son texto plano).
var REG_PESTANAS = [
  { nombre: 'Pacientes', modo: 'pacientes', clave: ['ID episodio'], columnas: ['ID episodio', 'Estado en registro', 'Motivo de egreso', 'Episodio relacionado',
    'Nombre', 'Expediente', 'Edad', 'Sexo', 'Especialidad', 'Sección', 'Adscrito', 'Residente', 'Cama', 'Fecha de ingreso', 'Fecha de egreso',
    'Días de estancia', 'Diagnóstico', 'Estado clínico', 'Antecedentes (APP)', 'Padecimiento (PA)', 'Manejo', 'Pendientes',
    'Drenajes y dispositivos', 'Antibiótico', 'Cultivos', 'Interconsultas', 'Dieta y NPO', 'TVP', 'NPT', 'Ventilación',
    'Vasopresores', 'Cirugías (resumen)', 'Imagen (resumen)', 'Labs (fechas)', 'Guardia vigente', 'Cronología', 'Misceláneo',
    'Nota completa (JSON)', 'Checklist completo (JSON)', 'Alta en la app', 'Última modificación en la app', 'Fuente', 'Última vez en la base',
    'Peso (kg)', 'Talla', 'Dx principal', 'CIE-10 (grupo)', 'Dx principal (fuente)', 'Sexo (fuente)', REG_NOTA_JSON_2,
    // 24 nov 2026: quién egresó, quién registró el motivo, quién modificó y el alias de WinLab (al final: la hoja ya tiene datos).
    'Egresado por', 'Motivo de egreso registrado por', 'Motivo registrado el', 'Última modificación por', 'Nota restaurada el', 'Alias WinLab'],
    completar: regCompletarSexoWl },
  { nombre: 'Cirugías', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Procedimiento'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Procedimiento', 'Hallazgos', 'Sangrado', 'Cirujano', 'Grupo', 'Fuente', 'Vigente', 'Tipo', 'Abordaje', 'Clavien-Dindo', 'Complicación',
    // 24 nov 2026: id de la cirugía en la caja y sus fotos (solo cuántas, quién y cuándo: ni la imagen ni su ruta). La clave NO cambia.
    'ID cirugía', 'Fotos (n)', 'Foto subida por', 'Foto subida el'] },
  { nombre: 'Labs', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Estudio'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Estudio', 'Valor', 'Origen', 'Vigente', 'Corregido a mano'] },
  { nombre: 'Imagen', modo: 'vigente', clave: ['ID episodio', 'Fecha', 'Tipo', 'Descripción'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'Tipo', 'Descripción', 'Enlace', 'Vigente'] },
  { nombre: 'Signos vitales', modo: 'acumula', clave: ['ID episodio', 'Fecha'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha', 'FC', 'FR', 'Temp', 'SaO2', 'O2 L/min', 'TA', 'Uresis', 'DxTx', 'IU', 'Balance', 'Horas de uresis'] },
  { nombre: 'Notas de evolución', modo: 'acumula', clave: ['ID episodio', 'Fecha y hora'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Fecha y hora', 'Autor', 'Con IA', 'Texto'] },
  { nombre: 'Guardia y cronología', modo: 'vigente', clave: ['ID episodio', 'Caja', 'Renglón'], columnas: ['ID episodio', 'Expediente', 'Nombre', 'Caja', 'Orden', 'Renglón', 'Vigente'] },
  { nombre: 'Procedimientos programados', modo: 'acumula', fuente: 'procedimientos_dia', clave: ['ID'], columnas: ['ID', 'Fecha', 'Cama', 'Expediente', 'Nombre', 'Edad', 'Diagnóstico', 'Especialidad', 'Adscrito', 'Residente', 'Agregado por'] },
  // 25 nov 2026 (registro 2026.11.26-2): la sección PROCEDIMIENTOS de la hoja del censo (tabla censo_procedimientos), una
  // fila por fecha + expediente + nombre. «ID episodio», «Ambulatorio» y «Grupo» se recalculan en cada corrida contra
  // «Pacientes» (regCompletarProcCenso_): un episodio que aparece después también se liga. Solo hay datos desde el 25 nov
  // 2026 (Google no guarda los censos viejos).
  { nombre: REG_PROC_CENSO, modo: 'acumula', fuente: 'censo_procedimientos', clave: ['ID'], completar: regCompletarProcCenso_,
    columnas: ['ID', 'Fecha', 'Cama', 'Expediente', 'Nombre', 'Edad', 'Diagnóstico', 'Especialidad', 'Adscrito', 'Residente', 'Visto primero', 'Visto por última vez',
      'ID episodio', 'Ambulatorio', 'Grupo', 'Vigente'] },
  // 24 nov 2026: foto nocturna del tratamiento de cada HOSPITALIZADO (una fila por episodio y día; solo hacia adelante: la
  // tarjeta no guarda el historial). Va antes de las pestañas de los robots: la foto de hoy no se puede volver a tomar.
  { nombre: REG_ESTADO_DIARIO, modo: 'acumula', clave: ['ID episodio', 'Fecha'], columnas: ['ID episodio', 'Fecha', 'Cama', 'Sección', 'Estado clínico', 'ATB (casilla)', 'Antibiótico (texto)',
    'Días ATB (escritos)', 'ATB inicio', 'Antibióticos en Manejo (detectados)', 'NPO', 'Dieta', 'NPT', 'NPT %', 'TVP', 'VM', 'Modo', 'FiO2', 'PEEP', 'O2 L/min', 'Norepinefrina mL/h',
    'Norepinefrina mg/mL', 'Vasopresina mL/h', 'Peso', 'Curación (necesaria/hecha)', 'Dispositivos (n)'], formatos: { 'Dispositivos (n)': '0', 'Norepinefrina mg/mL': '0.0#####' } },
  // Dispositivos de la tarjeta (drenajes, sondas, estomas): una fila por dispositivo. «Primera vez visto» se conserva de
  // la hoja (conservarViejo); el que ya no está queda «Vigente: No» y su «Última vez visto» aproxima el retiro.
  { nombre: REG_DISPOSITIVOS, modo: 'vigente', clave: ['ID episodio', 'ID dispositivo'], conservarViejo: ['Primera vez visto'], columnas: ['ID episodio', 'ID dispositivo', 'Tipo', 'Tipo (grupo)', 'Lado', 'Sitio',
    'Características', 'Fecha de colocación', 'Gasto (último)', 'Primera vez visto', 'Última vez visto', 'Vigente'] },
  // Gasto de cada drenaje por día (solo hospitalizados con gasto escrito; la tarjeta solo guarda el último).
  { nombre: REG_DRENAJES_DIARIO, modo: 'acumula', clave: ['ID episodio', 'ID dispositivo', 'Fecha'], columnas: ['ID episodio', 'ID dispositivo', 'Fecha', 'Tipo', 'Gasto (texto)', 'Gasto (mL)', 'Características'],
    formatos: { 'Gasto (mL)': '0.0#####' } },
  // 24 nov 2026: renglones que la guardia retiró (corte de las 06:15 o borrado). Compacta: sin Expediente ni Nombre (se
  // cruza con Pacientes por «ID episodio»). Una fila por renglón de cada corte.
  // Va ANTES de las pestañas grandes de los robots: la base purga estos renglones a los 7 días y no deben quedarse sin
  // escribir si se acaba el tiempo.
  { nombre: REG_GUARDIA_CORTES, modo: 'acumula', fuente: 'guardia_cortes', clave: ['ID', 'Orden'], columnas: ['ID', 'ID episodio', 'Fecha y hora', 'Motivo', 'Orden', 'Renglón'] },
  { nombre: REG_WL_LABS, modo: 'acumula', fuente: 'winlab_labs', preferirViejo: regWlPreferirViejo, completarVacias: ['Sexo en WinLab', 'Nacimiento en WinLab'], clave: ['Expediente', 'Reporte'], columnas: ['Expediente', 'Paciente', 'Nombre en WinLab', 'Atribución', 'Reporte', 'Folio', 'Toma', 'Resultado', 'Servicio', 'Estudios', 'Valores', 'Capturado', 'Sexo en WinLab',
    // 24 nov 2026: fecha de nacimiento del encabezado (al final). Es una pestaña CON nombres; a las de análisis solo pasa la edad.
    'Nacimiento en WinLab'] },
  { nombre: 'Cultivos del robot (WinLab)', modo: 'acumula', fuente: 'winlab_labs', filtrarNuevas: regWlFiltrarCultivos, clave: ['Expediente', 'Reporte', 'N'], columnas: ['Expediente', 'Paciente', 'Reporte', 'N', 'Toma', 'Tipo', 'Muestra', 'Resultado', 'Germen', 'Sensibles', 'Intermedios', 'Resistentes', 'UFC', 'Detalle', 'Fuente', 'Texto del reporte', 'Atribución', 'Capturado'] },
  { nombre: 'Imagen del robot (RIS)', modo: 'acumula', fuente: 'ris_estudios', clave: ['ID'], columnas: ['ID', 'ID episodio', 'Expediente', 'Paciente', 'Fecha', 'Hora', 'Modalidad', 'Estudios', 'Crítico', 'Estado del reporte', 'Reporte', 'Enlace del reporte', 'Capturado'] },
  // 24 nov 2026: historial de auditoría de la base (audit_log), al final (la base lo guarda 180 días: no urge como la
  // guardia). Sin nombres ni expedientes; del diff solo se piden las sub-rutas necesarias.
  { nombre: REG_MOVIMIENTOS, modo: 'acumula', fuente: 'audit_pacientes', clave: ['ID', 'Campo'], columnas: ['ID', 'ID episodio', 'Fecha y hora', 'Operación', 'Campo', 'De', 'A', 'Origen'] },
  { nombre: REG_SOPORTE, modo: 'acumula', fuente: 'audit_notas', clave: ['ID', 'Variable'], columnas: ['ID', 'ID episodio', 'Fecha y hora', 'Variable', 'De', 'A', 'Quién'] },
  { nombre: REG_ACTIVIDAD, modo: 'acumula', fuente: 'audit_notas', clave: ['ID episodio', 'Fecha'], combinar: regActividadCombinar, columnas: ['ID episodio', 'Fecha', 'Ediciones (n)', 'Usuarios (n)', 'Primera hora',
    'Última hora', 'Ediciones de noche (n)', 'Cajas tocadas', 'Usuarios', 'Último ID'], formatos: { 'Ediciones (n)': '0', 'Usuarios (n)': '0', 'Ediciones de noche (n)': '0', 'Último ID': '0' } }
];
// «Integridad» (24 nov 2026): una fila por corrida, nunca se pisa. No lleva nombres ni expedientes: solo conteos y avisos.
var REG_INT_ENTEROS = ['Vueltas extra usadas (24 h)', 'Episodios en base (n)', 'Episodios en Pacientes (n)', 'Diferencia (en base y no en Pacientes)', 'WinLab: filas en base (n)',
  'WinLab: reportes en hoja (n)', 'RIS: filas en base (n)', 'RIS: filas en hoja (n)', 'WinLab actualizadas en sitio (n)', 'Celdas recortadas (n)', 'Hospitalizados que salieron sin egreso (n)', 'Celdas usadas'];
var REG_INT_DECIMALES = ['Duración total (s)', 'Lectura (s)', 'Fusión y escritura (s)', 'Análisis (s)'];
var REG_INTEGRIDAD = { nombre: 'Integridad', modo: 'acumula', clave: ['Corrida'],
  columnas: ['Corrida', 'Versión', 'Resultado', 'Duración total (s)', 'Lectura (s)', 'Fusión y escritura (s)', 'Análisis (s)', 'Vueltas extra usadas (24 h)', 'Bytes leídos por tabla',
    'Episodios en base (n)', 'Episodios en Pacientes (n)', 'Diferencia (en base y no en Pacientes)', 'WinLab: filas en base (n)', 'WinLab: reportes en hoja (n)', 'RIS: filas en base (n)', 'RIS: filas en hoja (n)',
    'WinLab actualizadas en sitio (n)', 'Celdas recortadas (n)', 'Hospitalizados que salieron sin egreso (n)', 'Celdas usadas', 'Avisos'],
  formatos: (function () { var f = {}; REG_INT_ENTEROS.forEach(function (c) { f[c] = '0'; }); REG_INT_DECIMALES.forEach(function (c) { f[c] = '0.0#####'; }); return f; })() };

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

/** Lee Supabase y actualiza todas las pestañas sin borrar nada. Si algo falla al leer, las pestañas del registro no se
 *  tocan: solo queda la fila «Falló» de la corrida en «Integridad» (24 nov 2026). */
function actualizarRegistro() {
  var inicio = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { Logger.log('Registro: otra actualización en curso; se omite esta.'); return { ok: false, motivo: 'ocupado' }; }
  // Lo que «Integridad» anota de la corrida (24 nov 2026): marcas de tiempo y bytes leídos por tabla.
  var libro = null, props = null, bytes = {}, marcas = {};
  REG_CORRIDA.recortes = 0;
  try {
    props = PropertiesService.getScriptProperties();
    var key = props.getProperty('SUPABASE_KEY');
    if (!key) throw new Error('Falta SUPABASE_KEY en Propiedades del script');
    // La hoja se abre ANTES de leer: un REGISTRO_SHEET_ID que falta o está mal se dice de inmediato.
    libro = regLibro_(props);
    var hoy = regHoy_(), avisos = [], omitidas = {};
    // Celdas ANTES de leer (24 nov 2026, revisión): cerca del límite se pausa lo recuperable (ver REG_CELDAS_CRITICO).
    var lleno = regCeldas_(libro) >= REG_CELDAS_CRITICO * REG_CELDAS_MAX, sinEspacio = [];
    if (lleno) avisos.push('El libro está a más del ' + Math.round(100 * REG_CELDAS_CRITICO) + ' % de las celdas que admite Sheets: EN PAUSA las pestañas de los robots (WinLab, RIS) y las de análisis; lo que no se puede volver a tomar (pacientes, estado diario, guardia, drenajes, auditoría) sí se escribe. Hay que pasar lo viejo a un libro histórico (ver REGISTRO.md).');
    // Sin corrida completa en 36 h (24 nov 2026): se dice en el Diccionario y en «Integridad» (la versión se reporta aunque
    // la corrida quede cortada, así que el vigilante no lo ve). Sin leer guardia_cortes en 6 días: la base ya purgó renglones.
    // 24 nov 2026 (revisión): si la propiedad NUNCA se guardó (hoja recién actualizada con guardia_cortes caída, o todas
    // las corridas parciales desde el primer día) se cuenta desde la primera corrida de esta versión (REG_CUENTA_DESDE):
    // antes el aviso no salía nunca justo en ese caso.
    if (!props.getProperty('REG_CUENTA_DESDE')) props.setProperty('REG_CUENTA_DESDE', new Date(inicio).toISOString());
    var hace = function (prop) {
      var t = Date.parse(props.getProperty(prop) || '');
      if (isNaN(t)) t = Date.parse(props.getProperty('REG_CUENTA_DESDE') || '');
      return isNaN(t) ? 0 : inicio - t;
    };
    var nunca = function (prop) { return isNaN(Date.parse(props.getProperty(prop) || '')); };
    if (hace('REG_ULTIMA_COMPLETA') > REG_SIN_COMPLETA_MS) avisos.push('Pasaron ' + Math.round(hace('REG_ULTIMA_COMPLETA') / 3600000) + ' h ' + (nunca('REG_ULTIMA_COMPLETA') ? 'sin ninguna corrida completa desde que se instaló esta versión' : 'desde la última corrida completa') + ' (más de 36 h): revisar «Integridad».');
    if (hace('REG_GUARDIA_LEIDA') > REG_GUARDIA_AVISO_MS) avisos.push('Pasaron ' + Math.round(hace('REG_GUARDIA_LEIDA') / 86400000) + ' días sin copiar los renglones retirados de la guardia' + (nunca('REG_GUARDIA_LEIDA') ? ' (nunca se han podido leer)' : '') + ': la base los purga a los 7 días, pudo perderse una parte.');
    // Relectura única de WinLab si ya se había leído algo (la marca se guarda de inmediato: si esta corrida falla, la
    // siguiente también empieza desde el principio porque el cursor ya no está). En una instalación nueva no hace falta.
    if (props.getProperty('REG_WL_RELECTURA') !== REG_WL_RELECTURA) {
      if (props.getProperty('REG_CURSOR_winlab_labs') || props.getProperty('REG_SIGUE_winlab_labs')) {
        props.deleteProperty('REG_CURSOR_winlab_labs'); props.deleteProperty('REG_SIGUE_winlab_labs');
        avisos.push('WinLab se vuelve a leer completo una sola vez para tomar el sexo de sus encabezados (puede tardar varias vueltas).');
      }
      props.setProperty('REG_WL_RELECTURA', REG_WL_RELECTURA);
    }
    var transcurrido = function () { return Date.now() - inicio; };
    var reloj = function () {
      if (transcurrido() <= REG_LECTURA_DURA_MS) return;
      var e = new Error('La lectura de Supabase pasó de 4 min: no se escribió nada (se reintenta en la siguiente corrida).'); e.regTiempo = true; throw e;
    };
    var leer = function (tabla, select, orden, filtro, pagina) { return regLeerTabla_(key, tabla, select, orden, filtro, pagina, { reloj: reloj, bytes: bytes }).filas; };
    // Por cursor: desde la posición exacta de la vuelta anterior (si quedó a medias) o desde lo último leído menos el
    // margen de la fuente (2 días; WinLab 6 h; guardia_cortes y auditoría 1 h). `tabla` es el nombre de la fuente en
    // REG_CURSORES (puede leer otra tabla, c.tabla, con un filtro propio, c.filtro).
    var cursores = {}, pendiente = false;
    var leerCursor = function (tabla, select, pagina, alPagina) {
      var c = REG_CURSORES[tabla], previo = props.getProperty('REG_CURSOR_' + tabla) || '';
      var sigue = regJson_(props.getProperty('REG_SIGUE_' + tabla));
      var filtro = (c.filtro ? c.filtro + '&' : '') + c.col + '=not.is.null';
      if (!sigue && previo && !isNaN(Date.parse(previo))) filtro += '&' + c.col + '=gte.' + new Date(Date.parse(previo) - (c.margenMs || REG_MARGEN_INCREMENTAL_MS)).toISOString();
      var r = regLeerTabla_(key, c.tabla || tabla, select, c.col + ',id', filtro, pagina, {
        reloj: reloj, tope: c.tope, despuesDe: sigue ? [sigue.v, sigue.id] : null, alPagina: alPagina, bytes: bytes,
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
    // 24 nov 2026: + updated_by (patients y notes), restaurada_en (notes) y archived_by (archive). Estas tres tablas NO van
    // en opcional(): solo se piden columnas que existen en la base (confirmadas ese día).
    datos.patients = leer('patients', 'id,cama,nombre,exp,dx,edad,esp,seccion,adscrito,residente,ingreso,estado,created_at,updated_at,updated_by', 'id', '', 200);
    datos.notes = leer('notes', 'patient_id,app,pa,drenajes,qx,manejo,sangrado,sv,balance,pendientes,checklist,lab_history,imagen_history,misc,cronologia,updated_at,updated_by,restaurada_en', 'patient_id', '', 20);
    datos.archive = leerCursor('archive', 'id,patient_data,note_data,archived_at,archived_by', 10);
    // Copias de la Papelera a las que alguien les registró el motivo del egreso después (pueden ser viejas: la ventana de
    // archived_at no las ve). _egreso_tipo_ts es UTC con formato fijo: se compara como texto.
    var ultima = props.getProperty('REG_ULTIMA_CORRIDA') || '';
    var desdeTipo = ultima && !isNaN(Date.parse(ultima)) ? new Date(Date.parse(ultima) - REG_MARGEN_INCREMENTAL_MS).toISOString().slice(0, 19) + 'Z' : '';
    datos.archive = regUnirPorId_(datos.archive, leer('archive', 'id,patient_data,note_data,archived_at,archived_by', 'id', desdeTipo ? 'note_data->>_egreso_tipo_ts=gte.' + desdeTipo : 'note_data->>_egreso_tipo_ts=not.is.null', 10));
    // Lo que alguien borró de la Papelera (24 nov 2026): la base guarda la fila completa en archive_eliminados. Una copia
    // archivada y borrada el mismo día nunca llegaba al registro. Solo se piden id, fecha, archive_id y fila (nada de
    // quién la borró). Si la copia sigue en archive, manda la de archive.
    datos.archive = regUnirPorId_(datos.archive, regFilasEliminadas_(opcional('archive_eliminados', function () { return leerCursor('archive_eliminados', 'id,eliminado_en,archive_id,fila', 10); })));
    // TODAS las copias de la Papelera de cada episodio que hoy está en la base (censo o Papelera leída hoy): así la unión
    // de copias no depende de cuáles cayeron en la ventana incremental (si no, lo que solo traía una copia vieja quedaba
    // en blanco o marcado «Vigente: No» al día siguiente).
    datos.archive = regUnirPorId_(datos.archive, regLeerCopias_(leer, regIdsEpisodios_(datos.patients, datos.archive)));
    datos.restauraciones = leer('archive', 'id,de:patient_data->>_supa_id,a:note_data->>_restaurado_a', 'id', 'note_data->>_restaurado_a=not.is.null', 1000);
    datos.cronologias = leer('cronologia_respaldo', 'patient_id,exp,nombre,cronologia,actualizado', 'patient_id', '', 200);
    datos.procedimientos = opcional('procedimientos_dia', function () { return leer('procedimientos_dia', 'id,cama,exp,nombre,edad,dx,esp,adscrito,residente,fecha_dia,added_by', 'id', '', 500); });
    // 25 nov 2026 (registro 2026.11.26-2): procedimientos del censo (sección PROCEDIMIENTOS de la hoja), por cursor
    // (visto_ultimo, id) con 2 días de margen. Si falla, solo su pestaña se queda sin tocar.
    datos.censoProcs = opcional('censo_procedimientos', function () {
      return leerCursor('censo_procedimientos', 'id,fecha,cama,exp,nombre,edad,dx,esp,adscrito,residente,visto_primero,visto_ultimo', 1000);
    });
    // WinLab: cada fila trae TODOS los reportes de la búsqueda (también de homónimos) y se repite cada día; se procesa
    // página por página (sin guardar el JSON crudo) y queda un renglón por reporte del paciente. La edad y el alias del
    // censo y de la Papelera sirven para aplicar la regla del robot a las capturas que no traen su marca (__target).
    var winlab = { labs: {}, cultivos: {}, contexto: regWlContexto(datos.patients, datos.notes, datos.archive), ambiguos: 0 };
    if (lleno) REG_PAUSA_LLENO.forEach(function (f) { omitidas[f] = true; });   // ni se leen: su cursor no avanza y la base las conserva
    if (!lleno) opcional('winlab_labs', function () {
      return leerCursor('winlab_labs', 'id,exp,paciente,fecha,scraped_at,reportes:data->reportes', 100, function (filas) { regWlAcumular(winlab, filas); });
    });
    datos.winlab = winlab;
    if (winlab.ambiguos) avisos.push('WinLab: ' + winlab.ambiguos + ' reporte(s) de capturas viejas no se copiaron porque hay homónimos con el mismo nombre y no se conoce la edad del paciente.');
    datos.ris = lleno ? [] : opcional('ris_estudios', function () { return leerCursor('ris_estudios', 'id,patient_id,exp,paciente,fecha,hora,modalidad,estudios,critico,reporte_estado,reporte,reporte_url,scraped_at', 200); });
    // Renglones que la guardia retiró (24 nov 2026): la base los purga a los 7 días; aquí se acumulan.
    datos.guardia = opcional('guardia_cortes', function () { return leerCursor('guardia_cortes', 'id,patient_id,ts,lineas,motivo', 500); });
    // Historial de auditoría (24 nov 2026), al final de la lectura y dentro de opcional(): si falla, lo demás se escribe.
    // PRIVACIDAD: de audit_log NUNCA se pide email, nombre, paciente, ip, ua ni el diff entero: solo las sub-rutas con
    // alias. user_id se usa para «Origen» (app / hoja) y para el seudónimo de «Quién»; no se escribe en la hoja.
    datos.auditPacientes = opcional('audit_pacientes', function () { return leerCursor('audit_pacientes', REG_AUD_PAC_SELECT, 1000); });
    var audNotas = { soporte: [], actividad: {} }, seudonimos = {};
    var quien = function (uid) { return seudonimos[uid] || (seudonimos[uid] = 'U-' + regHash_(regSal_(props), 'USUARIO|' + uid)); };
    opcional('audit_notas', function () { return leerCursor('audit_notas', regAudNotasSelect_(), 1000, function (filas) { regAudNotasAcumular(audNotas, filas, quien); }); });
    datos.auditNotas = audNotas;
    marcas.lectura = Date.now();
    var nuevo = regConstruir(datos, hoy);
    try { regQuitarCopiasViejas_(libro, props); } catch (e) { avisos.push('No se pudieron quitar las copias de respaldo viejas (' + regCausa_(e) + ').'); }
    var cuentas = {}, cortado = false, fusionadas = {};
    // Lo de WinLab (hoja + hoy) se lee ANTES de Pacientes para tomar de ahí el sexo que la tarjeta no trae; esa lectura
    // sirve también al escribir su pestaña (nada la toca en medio).
    var previos = {}, hojaWl = libro.getSheetByName(REG_WL_LABS), cfgWl = REG_PESTANAS.filter(function (c) { return c.nombre === REG_WL_LABS; })[0];
    // Si su encabezado está dañado, aquí no se detiene nada: la pestaña falla en su turno, como siempre.
    try { if (hojaWl) previos[REG_WL_LABS] = regLeerPestana_(hojaWl, cfgWl); } catch (e) { delete previos[REG_WL_LABS]; }
    var ctx = { sexosWl: regWlSexosMapa((previos[REG_WL_LABS] ? previos[REG_WL_LABS].filas : []).concat(nuevo[REG_WL_LABS] || [])) };
    // 25 nov 2026: las pestañas que se completan contra otras ya escritas en esta corrida («Procedimientos del censo» contra
    // «Pacientes», que va primero) las leen de aquí.
    ctx.fusionadas = fusionadas; ctx.hoy = hoy;
    // Dentro de una pestaña, ningún setValues empieza después de 5 min 40 s (escribir a medias es seguro: cada fila va a
    // su renglón por clave y la siguiente vuelta completa lo que falte).
    var corte = function () { return transcurrido() > REG_LIMITE_MS + 25000; };
    REG_PESTANAS.forEach(function (cfg) {
      if (cortado) return;
      if (cfg.fuente && omitidas[cfg.fuente]) {
        // No se tocan hoy, pero lo que ya tienen sí cuenta para las pestañas de análisis.
        var h = libro.getSheetByName(cfg.nombre);
        fusionadas[cfg.nombre] = previos[cfg.nombre] ? previos[cfg.nombre].filas : (h ? regLeerPestana_(h, cfg).filas : []);
        return;
      }
      if (transcurrido() > REG_LIMITE_MS) { cortado = true; return; }
      var filas = null;
      try {
        var hoja = libro.getSheetByName(cfg.nombre);
        if (!hoja) { hoja = libro.insertSheet(cfg.nombre); regAjustarColumnas_(hoja, cfg.columnas.length); }
        var previo = previos[cfg.nombre] || regLeerPestana_(hoja, cfg);
        filas = regFusionar(previo.filas, nuevo[cfg.nombre] || [], cfg, nuevo.episodiosHoy, hoy, nuevo.relacion);
        if (cfg.completar) filas = cfg.completar(filas, ctx);
        var r = regEscribirPestana_(hoja, cfg, filas, previo, corte);
        if (r.aviso) avisos.push(r.aviso);
      } catch (e) {
        if (e && e.regCorte) { cortado = true; return; }
        // 24 nov 2026 (revisión): sin espacio en el libro (límite de celdas) para ESTA pestaña: las demás se siguen
        // escribiendo (antes la corrida entera fallaba cada noche y se perdían las fotos de «Estado diario» y los renglones
        // de guardia). El cursor de lo que no se escribió no avanza: se vuelve a leer cuando haya espacio.
        if (!regEsLimiteCeldas_(e)) throw e;
        sinEspacio.push(cfg.nombre);
        if (cfg.fuente) delete cursores[cfg.fuente]; else { delete cursores.archive; delete cursores.archive_eliminados; }
        if (filas) fusionadas[cfg.nombre] = filas;
        return;
      }
      cuentas[cfg.nombre] = filas.length;
      fusionadas[cfg.nombre] = filas;
    });
    marcas.escritura = Date.now();
    var analisisListo = false;
    var limiteAnalisis = false;
    if (sinEspacio.length) avisos.push('Sin espacio en el libro (límite de celdas de Sheets) para escribir «' + sinEspacio.join('», «') + '»: lo demás sí se escribió. Hay que pasar lo viejo a un libro histórico (ver REGISTRO.md).');
    // El historial de las notas a medias (carga inicial por partes): «Análisis · Antibióticos» espera a que termine. Su
    // clave lleva el «Inicio» del curso y con medio historial ese inicio es la noche de hoy: quedaría una fila basura
    // («Vigente: No») por cada antibiótico de cada hospitalizado (24 nov 2026, revisión).
    var historialAMedias = cursores.audit_notas ? !cursores.audit_notas.r.completa : !!props.getProperty('REG_SIGUE_audit_notas');
    if (cortado) { pendiente = true; avisos.push('Se acabó el tiempo al escribir: lo que faltó se escribe en la siguiente vuelta.'); }
    else if (lleno) { /* en pausa: ya se avisó */ }
    // Pestañas de análisis (sin nombres, números como números): solo con el registro completo de esta corrida. Si fallan,
    // el registro ya quedó escrito: se avisa y se recalculan en la siguiente corrida.
    else if (transcurrido() > REG_LIMITE_MS) avisos.push('No alcanzó el tiempo para las pestañas de análisis: se actualizan en la siguiente corrida.');
    else {
      var enEspera = {};
      if (historialAMedias) { enEspera[REG_AN_ATB] = true; avisos.push('El historial de auditoría de las notas se sigue leyendo por partes: «' + REG_AN_ATB + '» se escribe cuando termine (así no quedan cursos con el inicio equivocado).'); }
      try { regEscribirAnalisis_(libro, props, fusionadas, nuevo.restauraciones, hoy, corte, cuentas, enEspera).forEach(function (a) { avisos.push(a); }); analisisListo = true; }
      catch (e) {
        if (e && e.regTiempo) throw e;
        if (regEsLimiteCeldas_(e)) limiteAnalisis = true;
        avisos.push(e && e.regCorte ? 'Se acabó el tiempo al escribir las pestañas de análisis: se completan en la siguiente corrida.'
          : 'No se pudieron actualizar las pestañas de análisis (' + regCausa_(e) + '): el registro sí quedó escrito.');
      }
    }
    marcas.analisis = Date.now();
    // Cuadre de la base contra la hoja (24 nov 2026): lecturas ligeras y conteos sin cuerpo; si fallan, la corrida sigue.
    var cuadre = regCuadre_(key, props, { hoy: hoy, datos: datos, fusionadas: fusionadas, omitidas: omitidas, cursores: cursores, bytes: bytes,
      conTiempo: function () { return transcurrido() <= REG_LIMITE_MS; } });
    cuadre.avisos.forEach(function (a) { avisos.push(a); });
    if (REG_CORRIDA.recortes) avisos.push(REG_CORRIDA.recortes + ' celda(s) pasaron de ' + REG_MAX_CELDA + ' caracteres y se guardaron recortadas (terminan en «' + REG_RECORTE.trim() + '»): ver «Celdas recortadas (n)» en «Integridad».');
    var hInt = null;
    try { hInt = regHojaIntegridad_(libro); } catch (e) { avisos.push('No se pudo abrir la pestaña «Integridad» (' + regCausa_(e) + ').'); }
    var dic = regHojaDiccionario_(libro), celdas = regCeldas_(libro);
    if (celdas > REG_CELDAS_AVISO * REG_CELDAS_MAX) avisos.push('El registro usa el ' + Math.round(100 * celdas / REG_CELDAS_MAX) + '% de las celdas que admite Sheets: hay que pasar lo viejo a un libro histórico.');
    // Los cursores avanzan solo cuando todo lo leído ya quedó escrito.
    if (!cortado) {
      Object.keys(cursores).forEach(function (t) { regGuardarCursor_(props, t, cursores[t]); });
      if (!sinEspacio.length) props.setProperty('REG_ULTIMA_CORRIDA', new Date(inicio).toISOString());
      if (cursores.guardia_cortes && cursores.guardia_cortes.r.completa) props.setProperty('REG_GUARDIA_LEIDA', new Date(inicio).toISOString());
    }
    if (pendiente) {
      if (!regProgramarContinuacion_(props)) avisos.push('Quedan filas por leer; ya se usaron las ' + REG_CONTINUACIONES_DIA + ' vueltas extra de las últimas 24 h: sigue en la corrida de la noche.');
    } else {
      ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'continuarRegistro') ScriptApp.deleteTrigger(t); });
    }
    var enCurso = pendiente || Object.keys(REG_CURSORES).some(function (t) { return !!props.getProperty('REG_SIGUE_' + t); });
    // Resultado de la corrida (24 nov 2026). Completa = se leyó y se escribió todo, análisis incluido; solo entonces
    // avanza REG_ULTIMA_COMPLETA (una corrida cortada o con una fuente caída no cuenta).
    var falto = [];
    if (cortado) falto.push('escribir todas las pestañas');
    else if (!analisisListo) falto.push(lleno ? 'las pestañas de análisis (en pausa: libro casi lleno)' : 'las pestañas de análisis');
    if (sinEspacio.length) falto.push('espacio en el libro para ' + sinEspacio.length + ' pestaña(s)');
    Object.keys(omitidas).forEach(function (f) { falto.push((lleno && REG_PAUSA_LLENO.indexOf(f) !== -1 ? 'leer (en pausa) ' : 'leer ') + f); });
    if (enCurso && !cortado) falto.push('terminar la lectura por partes');
    if (!falto.length) props.setProperty('REG_ULTIMA_COMPLETA', new Date(inicio).toISOString());
    // 24 nov 2026 (revisión): la fila de «Integridad» va ANTES del Diccionario y dentro de try: si no se puede escribir
    // (Sheets agota el tiempo, o el libro ya tenía una pestaña «Integridad» con otros encabezados) la corrida, que ya
    // escribió todo, termina bien y lo dice en los avisos (antes lanzaba y no reportaba la versión).
    if (hInt) {
      try { regAnotarCorrida_(hInt, props, inicio, marcas, bytes, { resultado: falto.length ? 'Parcial: faltó ' + falto.join('; ') : 'Completa', cuadre: cuadre, celdas: celdas, avisos: avisos.concat(cuadre.notas) }); }
      catch (e) { avisos.push('No se pudo anotar la corrida en «Integridad» (' + regCausa_(e) + '): lo demás sí quedó escrito.'); }
    }
    regEscribirDiccionario_(dic, hoy, cuentas, celdas, enCurso, avisos);
    // Solo conteos y avisos en el registro de ejecución: nada de nombres ni expedientes.
    Logger.log('Registro actualizado ' + hoy + ': ' + JSON.stringify(cuentas) + (avisos.length ? ' · Avisos: ' + avisos.join(' | ') : ''));
    regReportarVersion_(props, key);
    // Libro lleno o casi lleno: todo lo que se pudo ya quedó escrito y anotado; la corrida TERMINA CON ERROR a propósito,
    // para que Google le avise por correo al dueño del disparador (el único aviso fuera de la hoja que no cuesta nada ni
    // pide permisos nuevos). No se anota como «Falló»: su fila de «Integridad» ya dice «Parcial».
    if (lleno || sinEspacio.length || limiteAnalisis) {
      var eLleno = new Error('Registro: el libro está en el límite de celdas de Sheets (' + Math.round(100 * celdas / REG_CELDAS_MAX) + ' %). Se escribió lo que no se puede volver a tomar; lo demás está en pausa. Hay que pasar lo viejo a un libro histórico (ver REGISTRO.md).');
      eLleno.regLleno = true; throw eLleno;
    }
    return { ok: true, cuentas: cuentas, pendiente: enCurso, avisos: avisos };
  } catch (e) {
    // La corrida que falla también deja su fila (24 nov 2026): la causa va sin URLs y sin el cuerpo de ninguna respuesta.
    if (libro && !(e && e.regLleno)) { try { regAnotarCorrida_(regHojaIntegridad_(libro), props, inicio, marcas, bytes, { resultado: 'Falló: ' + regCausa_(e) }); } catch (_) {} }
    // Y su renglón en el registro de ejecución (solo la causa, sin URLs): si ni «Integridad» se pudo escribir, queda esto.
    try { Logger.log('Registro: la corrida terminó con error: ' + regCausa_(e)); } catch (_) {}
    throw e;
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
    out = out.concat(leer('archive', 'id,patient_data,note_data,archived_at,archived_by', 'id', 'patient_data->>_supa_id=in.(' + lista + ')', 10));
  }
  return out;
}
function regUnirPorId_(a, b) {
  var ya = {}, out = [];
  regArr(a).concat(regArr(b)).forEach(function (x) { if (x && !ya[x.id]) { ya[x.id] = true; out.push(x); } });
  return out;
}

/** Filas de archive_eliminados como copias de la Papelera (24 nov 2026): `fila` es la fila completa de archive que se
 *  borró (to_jsonb). Quedan con el id que tenían en archive y la marca __borrado (Fuente «Papelera (borrado)»). */
function regFilasEliminadas_(filas) {
  var out = [];
  regArr(filas).forEach(function (x) {
    var f = regObj(x && x.fila), id = regTexto(x && x.archive_id) || regTexto(f.id);
    if (!id || !Object.keys(f).length) return;
    out.push({ id: id, patient_data: f.patient_data, note_data: f.note_data, archived_at: f.archived_at || x.eliminado_en, archived_by: f.archived_by, __borrado: true });
  });
  return out;
}

// ─── Integridad (24 nov 2026): una fila por corrida y cuadre de la base contra la hoja ───────────────────────────
/** Cuántas filas de `tabla` cumplen `filtro`, sin bajar ninguna: GET con limit=0 y «Prefer: count=exact»; el total viene
 *  en la cabecera Content-Range (termina en «/123»; UrlFetchApp no tiene HEAD y el cuerpo es «[]»). Lanza si no se pudo. */
function regContar_(key, tabla, filtro, col) {
  var res = UrlFetchApp.fetch(regUrl_(tabla, col || 'id', col || 'id', filtro, 0), { method: 'get', headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact' }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 206) {
    var codPg = '';
    try { var cuerpo = JSON.parse(res.getContentText() || '{}'); if (/^[A-Z0-9]{5,8}$/.test(regTexto(cuerpo && cuerpo.code))) codPg = cuerpo.code; } catch (_) {}
    throw new Error('Supabase ' + tabla + ' HTTP ' + code + (codPg ? ' (' + codPg + ')' : ''));
  }
  var h = regObj(res.getHeaders()), rango = '';
  Object.keys(h).forEach(function (k) { if (k.toLowerCase() === 'content-range') rango = regTexto(h[k]); });
  var m = /\/(\d+)\s*$/.exec(rango);
  if (!m) throw new Error('Supabase ' + tabla + ': la respuesta no trae el total (Content-Range)');
  return parseInt(m[1], 10);
}
/** Cuadre de la corrida. Episodios en base = ids distintos del censo (con nombre o expediente) y de las copias de la
 *  Papelera que traen id de la base (una lectura ligera: id y los dos ids de patient_data, sin nombres). Lo demás son
 *  conteos sin cuerpo. Cada número que no se pudo obtener queda vacío y se dice en `notas` (solo van a «Integridad»);
 *  `avisos` son los hallazgos que también van al Diccionario. No lanza. o: datos, fusionadas, omitidas, cursores, bytes, conTiempo(). */
function regCuadre_(key, props, o) {
  var c = { avisos: [], notas: [] }, fus = o.fusionadas || {};
  var intento = function (nombre, fn) {
    if (!o.conTiempo()) { c.notas.push('Sin tiempo para ' + nombre + '.'); return ''; }
    try { return fn(); } catch (e) { c.notas.push('No se pudo ' + nombre + ' (' + regCausa_(e) + ').'); return ''; }
  };
  var P = fus['Pacientes'];
  if (P) {
    c.enHoja = P.length;
    c.sinEgreso = P.filter(function (r) { return r['Estado en registro'] === 'Salió de la base sin egreso registrado'; }).length;
    // 24 nov 2026 (revisión): la lectura ligera de archive es completa (crece con la Papelera): UNA vez al día, no en
    // cada vuelta extra ni en cada «Actualizar ahora».
    var yaHoy = !!o.hoy && props.getProperty('REG_CUADRE_EPISODIOS') === o.hoy;
    if (yaHoy) c.notas.push('El cuadre de episodios ya se hizo hoy (se hace una vez al día).');
    var r = yaHoy ? '' : intento('contar los episodios de la base', function () {
      var ids = {};
      regArr(o.datos.patients).forEach(function (p) { if (p && p.id && (regTexto(p.nombre).trim() || regTexto(p.exp).trim())) ids[regTexto(p.id)] = true; });
      var copias = regLeerTabla_(key, 'archive', 'id,s:patient_data->>_supa_id,i:patient_data->>id', 'id', '', REG_MAX_PAGINA, { bytes: o.bytes, parar: function () { return !o.conTiempo(); } });
      if (!copias.completa) throw new Error('no alcanzó el tiempo');
      copias.filas.forEach(function (a) { var id = regTexto(a && (a.s || a.i)).trim(); if (id) ids[id] = true; });
      var enHoja = {};
      P.forEach(function (f) { enHoja[regTexto(f['ID episodio']).trim()] = true; });
      return { n: Object.keys(ids).length, faltan: Object.keys(ids).filter(function (id) { return !enHoja[id]; }).length };
    });
    if (r) {
      props.setProperty('REG_CUADRE_EPISODIOS', o.hoy || '');
      c.enBase = r.n; c.diferencia = r.faltan;
      if (r.faltan > 0) c.avisos.push('Integridad: ' + r.faltan + ' episodio(s) de la base no están en «Pacientes» (una copia de la Papelera que la lectura por fecha no alcanzó, o sin nombre ni expediente): ver «Integridad».');
    }
  }
  var contarFuente = function (fuente, pestana, baseK, hojaK) {
    if (fus[pestana]) c[hojaK] = fus[pestana].length;
    if (o.omitidas[fuente]) { c.notas.push('No se contó ' + fuente + ' (no se pudo leer en esta corrida).'); return; }
    c[baseK] = intento('contar ' + fuente, function () { return regContar_(key, fuente, REG_CURSORES[fuente].col + '=not.is.null'); });
  };
  contarFuente('winlab_labs', REG_WL_LABS, 'wlBase', 'wlHoja');
  contarFuente('ris_estudios', REG_RIS, 'risBase', 'risHoja');
  if (typeof c.risBase === 'number' && typeof c.risHoja === 'number' && c.risBase > c.risHoja) c.avisos.push('Integridad: la base tiene ' + (c.risBase - c.risHoja) + ' estudio(s) de RIS más que la pestaña «' + REG_RIS + '».');
  // WinLab con margen de 6 h: una fila que el robot corrija en sitio (updated_at nuevo, scraped_at viejo) ya no se relee.
  // Se cuentan las que cambiaron desde la corrida anterior y quedaron antes de la ventana que sí se leyó hoy.
  var wl = o.cursores.winlab_labs, ultima = props.getProperty('REG_ULTIMA_CORRIDA') || '';
  if (wl && !wl.sigue && wl.previo && !isNaN(Date.parse(wl.previo)) && ultima && !isNaN(Date.parse(ultima))) {
    c.wlEnSitio = intento('contar las filas de WinLab actualizadas en sitio', function () {
      return regContar_(key, 'winlab_labs', 'updated_at=gte.' + new Date(Date.parse(ultima)).toISOString() + '&scraped_at=lt.' + new Date(Date.parse(wl.previo) - REG_MARGEN_WINLAB_MS).toISOString());
    });
    if (c.wlEnSitio > 0) c.avisos.push('Integridad: ' + c.wlEnSitio + ' fila(s) de WinLab cambiaron en la base después de leídas y no se releyeron (el margen de WinLab es de 6 h): si se repite, hay que ampliarlo.');
  }
  c.recortes = REG_CORRIDA.recortes;
  return c;
}
function regHojaIntegridad_(libro) {
  var hoja = libro.getSheetByName(REG_INTEGRIDAD.nombre);
  if (!hoja) { hoja = libro.insertSheet(REG_INTEGRIDAD.nombre); regAjustarColumnas_(hoja, REG_INTEGRIDAD.columnas.length); }
  return hoja;
}
/** Agrega la fila de la corrida a «Integridad» (nunca pisa otra: si la clave ya existe se le añade «(2)», «(3)»…).
 *  «Corrida» es la hora de inicio en Ciudad de México. Sin nombres ni expedientes: conteos, tiempos y avisos.
 *  x: resultado, cuadre (de regCuadre_), celdas, avisos. */
function regAnotarCorrida_(hoja, props, inicio, marcas, bytes, x) {
  var ahora = Date.now(), c = x.cuadre || {}, seg = function (a, b) { return a && b && b >= a ? regRedondear((b - a) / 1000, 1) : ''; };
  var n = function (v) { return typeof v === 'number' && isFinite(v) ? v : ''; };
  var previo = regLeerPestana_(hoja, REG_INTEGRIDAD), ya = {};
  previo.filas.forEach(function (f) { ya[regTexto(f['Corrida']).trim()] = true; });
  var base = new Date(inicio + REG_UTC_OFFSET_MIN * 60000).toISOString().slice(0, 19).replace('T', ' '), corrida = base;
  for (var k = 2; ya[corrida]; k++) corrida = base + ' (' + k + ')';
  var vueltas = regJson_(props.getProperty('REG_CONTINUACIONES'));
  vueltas = (Array.isArray(vueltas) ? vueltas : []).filter(function (t) { return typeof t === 'number' && ahora - t < 86400000 && t <= ahora; }).length;
  var fila = { 'Corrida': corrida, 'Versión': REGISTRO_VERSION, 'Resultado': x.resultado, 'Duración total (s)': seg(inicio, ahora), 'Lectura (s)': seg(inicio, marcas.lectura),
    'Fusión y escritura (s)': seg(marcas.lectura, marcas.escritura), 'Análisis (s)': seg(marcas.escritura, marcas.analisis), 'Vueltas extra usadas (24 h)': vueltas,
    'Bytes leídos por tabla': JSON.stringify(bytes || {}), 'Episodios en base (n)': n(c.enBase), 'Episodios en Pacientes (n)': n(c.enHoja), 'Diferencia (en base y no en Pacientes)': n(c.diferencia),
    'WinLab: filas en base (n)': n(c.wlBase), 'WinLab: reportes en hoja (n)': n(c.wlHoja), 'RIS: filas en base (n)': n(c.risBase), 'RIS: filas en hoja (n)': n(c.risHoja),
    'WinLab actualizadas en sitio (n)': n(c.wlEnSitio), 'Celdas recortadas (n)': REG_CORRIDA.recortes, 'Hospitalizados que salieron sin egreso (n)': n(c.sinEgreso),
    'Celdas usadas': n(x.celdas), 'Avisos': regArr(x.avisos).join(' | ').slice(0, 4000) };
  regEscribirPestana_(hoja, REG_INTEGRIDAD, previo.filas.concat([fila]), previo, null);
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
 *  seguir), alPagina(filas) (procesa cada página y no las acumula), bytes (objeto donde se suma, por tabla, el tamaño
 *  de cada respuesta buena: lo que «Integridad» anota como bajado). Devuelve { filas, completa, ultima, max }. */
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
    var texto = res.getContentText() || '[]';
    if (op.bytes) op.bytes[tabla] = (op.bytes[tabla] || 0) + texto.length;
    try { filas = JSON.parse(texto); } catch (_) { throw new Error('Supabase ' + tabla + ': la respuesta no es JSON válido (fila ' + n + ')'); }
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
/** Parte un texto largo en dos celdas (24 nov 2026): [primera, continuación]. No corta un carácter de dos unidades. */
function regPartir_(s) {
  s = regTexto(s);
  if (s.length <= REG_MAX_CELDA) return [s, ''];
  var corte = REG_MAX_CELDA, u = s.charCodeAt(corte - 1);
  if (u >= 0xD800 && u <= 0xDBFF) corte--;
  return [s.slice(0, corte), s.slice(corte)];
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
/** ¿El «nombre en WinLab» identifica a una persona por sí solo? Solo «APELLIDOS, NOMBRE» con nombre tras la coma (copia de
 *  aliasIdentifica del robot, rpa/lib.js). Sin coma («ROJAS PRUEBA», apellidos compuestos) solo sirve para buscar. */
function regWlAliasIdentifica(alias) {
  var a = String(alias || '').trim();
  if (!a || a.indexOf(',') < 0) return false;
  return regWlTokens(a.split(',').slice(1).join(' ')).length > 0;
}
/** Palabras «tal cual» (sin tirar partículas ni palabras cortas: DE, LA…). */
function regWlPalabras(name) {
  if (!name) return [];
  return String(name).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, ' ').replace(/[^A-Z\s]/g, ' ')
    .replace(/\bMA\b/g, 'MARIA').replace(/\bJ\b/g, 'JOSE').replace(/\bGPE\b/g, 'GUADALUPE')
    .replace(/\bFCO\b/g, 'FRANCISCO').replace(/\bFCA\b/g, 'FRANCISCA')
    .split(/\s+/).filter(function (w) { return w.length >= 2; });
}
/** ¿El alias sin coma es exactamente este nombre? Mismas palabras en cualquier orden, una a una (aliasMismoNombre del robot). */
function regWlAliasMismoNombre(alias, nombre) {
  var a = regWlPalabras(alias), b = regWlPalabras(nombre);
  if (!a.length || a.length !== b.length) return false;
  var used = b.map(function () { return false; }), pend = [];
  a.forEach(function (x) { var j = b.indexOf(x); while (j >= 0 && used[j]) j = b.indexOf(x, j + 1); if (j >= 0) used[j] = true; else pend.push(x); });
  for (var i = 0; i < pend.length; i++) {
    var hit = -1;
    for (var k = 0; k < b.length; k++) { if (!used[k] && regWlTokenIgual(pend[i], b[k])) { hit = k; break; } }
    if (hit < 0) return false;
    used[hit] = true;
  }
  return true;
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
/** Sexo del encabezado de WinLab: 'F', 'M' o '' (sin celda de sexo o en un idioma que no se reconoce). */
function regWlSexoDe(cells) {
  var sx = regWlIdxSexo(cells);
  if (sx < 0) return '';
  var s = String(cells[sx] || '').toUpperCase().trim();
  if (/^(FEM|DONNA|MUJER)/.test(s) || s === 'F') return 'F';
  if (/^(MASC|MALE|UOMO|HOMBRE)/.test(s) || s === 'M') return 'M';
  return '';
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
      // El alias solo identifica con «APELLIDOS, NOMBRE» o si es exactamente el nombre del encabezado (15 nov 2026: con solo
      // los apellidos los reportes de un hermano entraban a la pestaña del paciente).
      var kN = regWlCoincide(hdr, paciente && paciente.nombre);
      var kA = regWlAliasIdentifica(alias) ? regWlCoincide(hdr, alias) : (regWlAliasMismoNombre(alias, hdr) ? 'full' : '');
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
/** Reportes con valores del paciente de la fila: [{ rep, atribucion, encabezado, sexo }] (sexo: el del encabezado del
 *  bloque del reporte). */
function regWlDelPaciente(fila, contexto, acc) {
  var reps = regArr(fila && fila.reportes), out = [];
  var conMarca = reps.some(function (r) { return r && r.__target === true; });
  var enc = '', sexo = '', nac = '', idx = null, info = null;
  if (!conMarca) {
    var ctx = regObj(regObj(contexto)[regTexto(fila && fila.exp).trim()]);
    var hoy = new Date(Date.parse(regTexto(fila && fila.scraped_at)) || Date.parse(regTexto(fila && fila.fecha)) || Date.now());
    info = regWlObjetivo(reps, { nombre: fila && fila.paciente, edad: ctx.edad, alias: ctx.alias }, hoy);
    idx = info.idx;
  }
  reps.forEach(function (rep, i) {
    if (!rep || typeof rep !== 'object') return;
    var h = regWlNombreEncabezado(rep.__cells); if (h) { enc = h; sexo = regWlSexoDe(rep.__cells); nac = regWlNacimiento(rep.__cells); }
    if (!Array.isArray(rep.valores) || !rep.valores.length) return;
    if (conMarca) {
      if (rep.__target === true) out.push({ rep: rep, atribucion: 'Marcado por el robot al capturar (nombre, alias y edad)', encabezado: enc, sexo: sexo, nac: nac });
      return;
    }
    if (!(i in idx)) return;
    if (info.multi && !info.edadConocida) { if (acc) acc.ambiguos = (acc.ambiguos || 0) + 1; return; }   // homónimos sin edad: no se puede decidir
    out.push({ rep: rep, atribucion: 'Regla del robot aplicada por el registro (captura sin marca; ' + (info.parcial ? 'encabezado con menos nombres, validado por edad' : 'nombre completo') + (info.multi ? ', homónimos separados por edad' : '') + ')', encabezado: idx[i], sexo: sexo, nac: nac });
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
          'Folio': r.folio, 'Toma': r.toma, 'Resultado': r.resultado, 'Servicio': r.servicio, 'Estudios': nVal, 'Valores': regWlValores(rep), 'Capturado': regTexto(f.scraped_at),
          'Sexo en WinLab': x.sexo || '', 'Nacimiento en WinLab': x.nac || '' };
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
/** Sexo de WinLab por expediente: { exp: [{ paciente, nombreWl, sexo }] } desde los renglones de «Labs del robot» (los
 *  de la hoja y los de hoy). Solo reportes ya atribuidos al paciente con la regla del robot. */
function regWlSexosMapa(filas) {
  var mapa = {}, visto = {};
  regArr(filas).forEach(function (r) {
    var exp = regExpValido(r && r['Expediente']), sexo = regSexo(r && r['Sexo en WinLab']);
    if (!exp || !sexo) return;
    var x = { paciente: regTexto(r['Paciente']).trim(), nombreWl: regTexto(r['Nombre en WinLab']).trim(), sexo: sexo };
    var k = exp + REG_SEP + x.paciente + REG_SEP + x.nombreWl + REG_SEP + sexo;
    if (visto[k]) return;
    visto[k] = true; (mapa[exp] = mapa[exp] || []).push(x);
  });
  return mapa;
}
/** Sexo de WinLab de UNA persona: los renglones de su expediente cuyo paciente (o nombre en WinLab) es compatible con su
 *  nombre (dos personas pueden compartir expediente). 'F', 'M', '?' (WinLab trae los dos: no se usa) o ''. */
function regWlSexoPaciente(mapa, exp, nombre) {
  var e = regExpValido(exp), vistos = {};
  if (!e) return '';
  regArr(regObj(mapa)[e]).forEach(function (x) {
    if (regMismaPersona(x.paciente, nombre) || (regPalabrasNombre(x.nombreWl).length && regMismaPersona(x.nombreWl, nombre))) vistos[x.sexo] = true;
  });
  var s = Object.keys(vistos);
  return s.length === 1 ? s[0] : (s.length > 1 ? '?' : '');
}
/** Pacientes: «Sexo (fuente)» = Tarjeta si la tarjeta trae el sexo; si no, el de WinLab marcado «de WinLab»; si tampoco,
 *  el inferido del nombre de pila marcado «Inferido del nombre» (25 nov 2026). Un sexo que ya se tomó de WinLab o del
 *  nombre se vuelve a revisar (si WinLab ahora trae los dos, se quita); lo que escribió la app no se toca. */
function regCompletarSexoWl(filas, ctx) {
  var mapa = regObj(ctx && ctx.sexosWl);
  return regArr(filas).map(function (r) {
    var f0 = regTexto(r['Sexo (fuente)']).trim(), deWl = f0 === REG_SEXO_WL, deNombre = f0 === REG_SEXO_NOMBRE, sexo = regTexto(r['Sexo']), fuente;
    if (!deWl && !deNombre && sexo.trim()) fuente = REG_SEXO_TARJETA;
    else {
      var w = regWlSexoPaciente(mapa, r['Expediente'], r['Nombre']);
      if (w === 'F' || w === 'M') { sexo = w; fuente = REG_SEXO_WL; }
      else if (deWl && w !== '?') fuente = REG_SEXO_WL;   // tomado de WinLab en otra corrida y hoy sin renglones que lo contradigan: se conserva
      else {
        sexo = regSexoDeNombre(r['Nombre']); fuente = sexo ? REG_SEXO_NOMBRE : '';
      }
    }
    if (regTexto(r['Sexo']) === sexo && regTexto(r['Sexo (fuente)']) === fuente) return r;
    var c = Object.assign({}, r); c['Sexo'] = sexo; c['Sexo (fuente)'] = fuente; return c;
  });
}

// ─── Procedimientos del censo (25 nov 2026, registro 2026.11.26-2) ───────────────────────────────────────────────
/** Filas de «Pacientes» por expediente válido (regExpValido). */
function regPacientesPorExp_(pacientes) {
  var m = {};
  regArr(pacientes).forEach(function (r) { var e = regExpValido(r && r['Expediente']); if (e) (m[e] = m[e] || []).push(r); });
  return m;
}
/** Episodio («ID episodio» de Pacientes) de un procedimiento del censo: mismo expediente válido, nombre compatible
 *  (regMismaPersona, la regla de identidad del registro) y estancia que cubre la fecha: desde la fecha de ingreso (o el
 *  día en que se dio de alta en la app) hasta el egreso; si sigue hospitalizado, hasta hoy; si salió de la base sin egreso,
 *  hasta la última vez que se vio. Sin las tarjetas duplicadas. Si varios cubren la fecha, el de ingreso más reciente.
 *  25 nov 2026 (revisión): con `cama` que no es EXT (QX, UCIP, una cama de piso) y sin episodio que cubra la fecha, vale
 *  el que ingresó AL DÍA SIGUIENTE (cirugía de urgencias la víspera del ingreso al servicio). Sin cama: solo la estancia.
 *  '' si no hay. */
function regEpisodioDeProc_(porExp, exp, nombre, fecha, hoy, cama) {
  var e = regExpValido(exp), f = regFecha(fecha), mejor = null, mejorIni = '', manana = null;
  if (!e || !f) return '';
  var c = regNorm_(cama).trim(), vispera = !!c && !/^EXT\b/.test(c) ? regFechaMas_(f, 1) : '';
  regArr(porExp[e]).forEach(function (p) {
    if (!regMismaPersona(p['Nombre'], nombre)) return;
    var estado = regTexto(p['Estado en registro']);
    if (estado === 'Egresado' && /^Duplicado/.test(regEgresoTipo(p['Motivo de egreso'], p['Estado clínico']))) return;
    var ini = regFecha(p['Fecha de ingreso']) || regFechaLocal(p['Alta en la app']);
    var fin = estado === 'Egresado' ? regFecha(p['Fecha de egreso']) : (estado === 'Hospitalizado' ? (hoy || '') : regFecha(p['Última vez en la base']));
    if (ini && vispera && ini === vispera && !manana) manana = p;
    if (!ini || ini > f || (fin && fin < f)) return;
    if (!mejor || ini > mejorIni) { mejor = p; mejorIni = ini; }
  });
  if (!mejor) mejor = manana;
  return mejor ? regTexto(mejor['ID episodio']).trim() : '';
}
/** «Procedimientos del censo»: ID episodio, Ambulatorio (Sí si la cama es EXT o no hay episodio) y Grupo (regCxGrupo del
 *  diagnóstico) de TODAS las filas, contra «Pacientes» de esta corrida. Sin «Pacientes» (no se pudo escribir) no cambia nada.
 *  25 nov 2026 (revisión):
 *   · Vigente: el script del censo reescribe juntas (mismo «Visto por última vez») todas las filas que siguen en la hoja
 *     ese día; la tabla no borra. Una fila cuya última vez es anterior (más de REG_PROC_CENSO_TOLERANCIA_MS) a la más
 *     reciente de su misma fecha salió de la hoja ese día (se corrigió el nombre o el expediente, o se canceló): «No».
 *   · Ambulatorio vacío (no se sabe) si el expediente no es válido para el registro (regExpValido) y la cama no es EXT. */
var REG_PROC_CENSO_TOLERANCIA_MS = 60000;
function regMsVisto_(v) {
  var t = Date.parse(regTexto(v).trim().replace(/(\.\d{3})\d+/, '$1'));
  return isFinite(t) ? t : null;
}
function regCompletarProcCenso_(filas, ctx) {
  var pac = ctx && ctx.fusionadas && ctx.fusionadas['Pacientes'];
  if (!pac) return filas;
  var porExp = regPacientesPorExp_(pac), hoy = ctx.hoy || '', maxVisto = {};
  regArr(filas).forEach(function (r) {
    var f = regFecha(r && r['Fecha']), t = regMsVisto_(r && r['Visto por última vez']);
    if (f && t !== null && !(maxVisto[f] >= t)) maxVisto[f] = t;
  });
  return regArr(filas).map(function (r) {
    var ep = regEpisodioDeProc_(porExp, r['Expediente'], r['Nombre'], r['Fecha'], hoy, r['Cama']);
    var ext = /^EXT\b/.test(regNorm_(r['Cama']).trim());
    var amb = ext ? 'Sí' : !regExpValido(r['Expediente']) ? '' : ep ? 'No' : 'Sí', grupo = regCxGrupo(r['Diagnóstico']);
    var f = regFecha(r['Fecha']), t = regMsVisto_(r['Visto por última vez']);
    var vig = f && t !== null && maxVisto[f] - t > REG_PROC_CENSO_TOLERANCIA_MS ? 'No' : 'Sí';
    if (regTexto(r['ID episodio']) === ep && regTexto(r['Ambulatorio']) === amb && regTexto(r['Grupo']) === grupo && regTexto(r['Vigente']) === vig) return r;
    var c = Object.assign({}, r); c['ID episodio'] = ep; c['Ambulatorio'] = amb; c['Grupo'] = grupo; c['Vigente'] = vig; return c;
  });
}

/** Copias de rescate de un iPad sin id de la base (ver regConstruir, 30 oct 2026). Cada una se une, solo para rellenar (la
 *  tarjeta manda), al episodio de la misma persona: mismo expediente y nombre compatible (regMismaPersona); si hay varios,
 *  el que sigue en el censo o, si no, el último egreso hasta el día del rescate. Sin pareja, las copias de una misma persona
 *  son UN episodio con el tipo «Duplicado (no es otro episodio)»: se ve en el registro pero no cuenta en egresos ni en
 *  mortalidad. Devuelve los ids «archivo-…» que ya no son episodio propio (sus filas de corridas anteriores: «Vigente: No»). */
var REG_RESCATE = /CAMBIOS DE ESTE IPAD SIN SUBIR/i, REG_RESCATE_SIN_EPISODIO = /YA NO ESTABA EN EL CENSO|COPIA DE RESCATE SIN EPISODIO/i;
function regUnirRescates(rescates, episodios, orden, agregar) {
  var absorbidos = [], sinPareja = {};
  rescates.forEach(function (r) {
    var pd = r.pd, exp = regTexto(pd.exp).trim(), dia = regFechaLocal(r.a.archived_at), idCopia = 'archivo-' + r.a.id;
    var cands = exp ? orden.filter(function (id) { var ep = episodios[id]; return regTexto(ep.p.exp).trim() === exp && regMismaPersona(ep.p.nombre, pd.nombre); }) : [];
    var destino = cands.filter(function (id) { return episodios[id].estado === 'Hospitalizado'; })[0];
    if (!destino && cands.length) {
      var hasta = cands.filter(function (id) { return !dia || !episodios[id].egreso || episodios[id].egreso <= dia; });
      destino = (hasta.length ? hasta : cands).slice().sort(function (x, y) { return regTexto(episodios[x].egreso).localeCompare(regTexto(episodios[y].egreso)); }).pop();
    }
    // 24 nov 2026: el motivo que una persona eligió en la Papelera sobre ESTA copia (sin id) sí llega a su episodio: antes
    // solo se unía la nota y el motivo elegido se perdía. No tapa otro motivo ya registrado por una persona (peso 4).
    var nd0 = regObj(r.a.note_data), elegido = regEgresoElegido_(nd0);
    var ponerElegido = function (ep) {
      if (!elegido || ep.estado !== 'Egresado' || regEgresoPeso(ep.motivo, ep.p.estado) >= 4) return;
      ep.motivo = elegido; ep.tipoPor = regTexto(nd0._egreso_tipo_por); ep.tipoTs = regTexto(nd0._egreso_tipo_ts);
    };
    if (destino) { episodios[destino].n = regUnirNotas(episodios[destino].n, r.nd); ponerElegido(episodios[destino]); absorbidos.push(idCopia); return; }
    var clave = exp || regPalabrasNombre(pd.nombre).sort().join(' '), g = sinPareja[clave];
    var motivo = regTexto(r.nd._egreso) + (REG_RESCATE_SIN_EPISODIO.test(regTexto(r.nd._egreso)) ? '' : ' · copia de rescate sin episodio en la base');
    var egreso = regFecha(r.nd._egresoFecha) || dia;
    if (!g) {
      sinPareja[clave] = idCopia;
      agregar(idCopia, { id: idCopia, p: Object.assign({}, pd), n: r.nd, estado: 'Egresado', motivo: motivo, egreso: egreso, fuente: 'Papelera (archive)', egresadoPor: regTexto(r.a.archived_by) });
      ponerElegido(episodios[idCopia]);
      return;
    }
    var ep = episodios[g];
    Object.keys(pd).forEach(function (k) { if (!regVacio(pd[k])) ep.p[k] = pd[k]; });
    ep.n = regUnirNotas(r.nd, ep.n); ep.egreso = egreso;
    ponerElegido(ep);
    absorbidos.push(idCopia);
  });
  return absorbidos;
}

// ─── Estado diario, dispositivos y auditoría (24 nov 2026) ───────────────────────────────────────────────────────
// Antibióticos que se buscan en la caja Manejo: [nombre, patrón sobre el texto sin acentos y en mayúsculas, clase,
// AWaRe (OMS 2023)]. Lista CERRADA: lo que no está aquí no se detecta. Las combinaciones van antes que sus partes (lo
// encontrado se quita del texto para no contarlo dos veces). Los antifúngicos no tienen categoría AWaRe.
var REG_ATB = [
  ['CEFTAZIDIMA/AVIBACTAM', /\bCEFTAZIDIMA?\s*[\/-]?\s*AVIBACTAM\b|\bZAVICEFTA\b/, 'Cefalosporina + inhibidor', 'Reserve'],
  ['CEFTOLOZANO/TAZOBACTAM', /\bCEFTOLOZANO\s*[\/-]?\s*TAZO(BACTAM)?\b|\bZERBAXA\b/, 'Cefalosporina + inhibidor', 'Reserve'],
  ['PIPERACILINA/TAZOBACTAM', /\bPIP(ERA(CILINA)?)?\s*[\/-]?\s*TAZO(BACTAM)?\b|\bTAZOCIN\b/, 'Penicilina + inhibidor', 'Watch'],
  ['AMPICILINA/SULBACTAM', /\bAMPI(CILINA)?\s*[\/-]?\s*SULBACTAM\b|\bUNASYNA?\b/, 'Penicilina + inhibidor', 'Access'],
  ['AMOXICILINA/CLAVULANATO', /\bAMOXI(CILINA)?\s*[\/-]?\s*(AC(IDO)?\.?\s*)?CLAV(ULANATO|ULANICO)?\b/, 'Penicilina + inhibidor', 'Access'],
  ['TRIMETOPRIMA/SULFAMETOXAZOL', /\bTMP\s*[\/-]?\s*SMX\b|\bTRIMETOPRIMA?\b(\s*[\/-]?\s*(CON\s+)?SULFAMETOXAZOL\b)?|\bBACTRIM\b/, 'Sulfonamida', 'Access'],
  ['MEROPENEM', /\bMERO(PENEM)?\b/, 'Carbapenémico', 'Watch'],
  ['IMIPENEM', /\bIMI(PENEM)?\b/, 'Carbapenémico', 'Watch'],
  ['ERTAPENEM', /\bERTA(PENEM)?\b/, 'Carbapenémico', 'Watch'],
  ['CEFTRIAXONA', /\bCEFTRIA(XONA)?\b/, 'Cefalosporina 3.ª', 'Watch'],
  ['CEFOTAXIMA', /\bCEFOTAXIMA?\b/, 'Cefalosporina 3.ª', 'Watch'],
  ['CEFTAZIDIMA', /\bCEFTAZIDIMA?\b/, 'Cefalosporina 3.ª', 'Watch'],
  ['CEFEPIME', /\bCEFEPIMA?E?\b/, 'Cefalosporina 4.ª', 'Watch'],
  ['CEFUROXIMA', /\bCEFUROXIMA?\b/, 'Cefalosporina 2.ª', 'Watch'],
  ['CEFALOTINA', /\bCEFALOTINA\b/, 'Cefalosporina 1.ª', 'Access'],
  ['CEFAZOLINA', /\bCEFAZOLINA\b/, 'Cefalosporina 1.ª', 'Access'],
  ['CEFALEXINA', /\bCEFALEXINA\b/, 'Cefalosporina 1.ª', 'Access'],
  ['CIPROFLOXACINO', /\bCIPRO(FLOXACIN[OA]?)?\b/, 'Fluoroquinolona', 'Watch'],
  ['LEVOFLOXACINO', /\bLEVOFLOXACIN[OA]?\b/, 'Fluoroquinolona', 'Watch'],
  ['MOXIFLOXACINO', /\bMOXI(FLOXACIN[OA]?)?\b/, 'Fluoroquinolona', 'Watch'],
  ['VANCOMICINA', /\bVANCO(MICINA)?\b/, 'Glucopéptido', 'Watch'],
  ['LINEZOLID', /\bLINEZOLID[EA]?\b/, 'Oxazolidinona', 'Reserve'],
  ['TIGECICLINA', /\bTIGE(CICLINA)?\b/, 'Glicilciclina', 'Reserve'],
  ['COLISTINA', /\bCOLISTINA?\b|\bCOLISTIMETATO\b|\bPOLIMIXINA\b/, 'Polimixina', 'Reserve'],
  ['DAPTOMICINA', /\bDAPTO(MICINA)?\b/, 'Lipopéptido', 'Reserve'],
  ['AMIKACINA', /\bAMIKA(CINA)?\b/, 'Aminoglucósido', 'Access'],
  ['GENTAMICINA', /\bGENTA(MICINA)?\b/, 'Aminoglucósido', 'Access'],
  ['METRONIDAZOL', /\bMETRO(NIDAZOL)?\b/, 'Nitroimidazol', 'Access'],
  ['CLINDAMICINA', /\bCLINDA(MICINA)?\b/, 'Lincosamida', 'Access'],
  ['AMPICILINA', /\bAMPI(CILINA)?\b/, 'Penicilina', 'Access'],
  ['AMOXICILINA', /\bAMOXI(CILINA)?\b/, 'Penicilina', 'Access'],
  ['DICLOXACILINA', /\bDICLOXA(CILINA)?\b/, 'Penicilina', 'Access'],
  ['PENICILINA', /\bPENICILINA\b|\bPGSC\b/, 'Penicilina', 'Access'],
  ['DOXICICLINA', /\bDOXI(CICLINA)?\b/, 'Tetraciclina', 'Access'],
  ['AZITROMICINA', /\bAZITRO(MICINA)?\b/, 'Macrólido', 'Watch'],
  ['CLARITROMICINA', /\bCLARITRO(MICINA)?\b/, 'Macrólido', 'Watch'],
  ['FOSFOMICINA', /\bFOSFOMICINA\b/, 'Fosfónico', 'Watch (oral) / Reserve (IV)'],
  ['NITROFURANTOINA', /\bNITROFURANTOINA\b/, 'Nitrofurano', 'Access'],
  ['FLUCONAZOL', /\bFLUCO(NAZOL)?\b/, 'Antifúngico', ''],
  ['CASPOFUNGINA', /\bCASPO(FUNGINA)?\b/, 'Antifúngico', ''],
  ['ANIDULAFUNGINA', /\bANIDULA(FUNGINA)?\b/, 'Antifúngico', ''],
  ['VORICONAZOL', /\bVORICONAZOL\b/, 'Antifúngico', ''],
  ['ANFOTERICINA B', /\bANFO(TERICINA)?(\s+B)?\b/, 'Antifúngico', '']
];
// Lo que, escrito justo antes del fármaco, dice que NO lo recibe: la negación y, entre ella y el fármaco, solo palabras
// de relleno u otros fármacos ya encontrados (§), p. ej. «SIN MEROPENEM», «SE SUSPENDE TRATAMIENTO CON VANCO»,
// «SUSPENDER MEROPENEM Y VANCO», «ALERGIA A PENICILINA». «SIN FIEBRE, CONTINÚA MEROPENEM» no lo niega.
var REG_ATB_NEG = /(\bSIN|\bNO|\bSUSPEND\w*|\bSUSPENSION|\bRETIR\w*|\bTERMIN\w*|\bCOMPLET\w*|\bFINALIZ\w*|\bALERGI\w*|\bRESISTEN\w*|\bVALORAR|\bPENDIENTE|\bNIEGA|\bNEGAD[OA])(\s+(DE|DEL|EL|LA|LOS|A|AL|CON|USO|INICIO|INICIAR|TX|TRATAMIENTO|ESQUEMA|ANTIBIOTICOS?|ATB|Y|NI|E|O)\b|[\s§\/+-])*$/;
/** Antibióticos de REG_ATB que el texto (caja Manejo) menciona sin negarlos, en el orden de la lista, sin repetir.
 *  Es texto libre: detecta menciones, no dosis ni vía. */
function regAtbDetectar(texto) {
  var hallados = {};
  regTexto(texto).split(/\n/).forEach(function (linea) {
    var t = regNorm_(linea), menciones = [];
    if (!t.trim()) return;
    // 1) Todas las menciones; lo encontrado se tapa (§) para que «PIP/TAZO» no cuente además como otra cosa.
    REG_ATB.forEach(function (a) {
      var re = new RegExp(a[1].source, 'g'), m;
      while ((m = re.exec(t))) {
        if (!m[0]) { re.lastIndex++; continue; }
        menciones.push({ nombre: a[0], i: m.index });
        t = t.slice(0, m.index) + new Array(m[0].length + 1).join('§') + t.slice(m.index + m[0].length);
      }
    });
    // 2) Cuenta la que no va negada.
    menciones.forEach(function (x) { if (!REG_ATB_NEG.test(t.slice(0, x.i))) hallados[x.nombre] = true; });
  });
  return REG_ATB.map(function (a) { return a[0]; }).filter(function (n) { return hallados[n]; });
}

// Valores del censo que llegan a pestañas SIN nombres (Estado diario, Movimientos y estado). La sección del censo trae
// texto corrido de la hoja (encabezados, a veces nombres): solo pasa lo que está hecho de palabras de salas conocidas.
var REG_SECCIONES = ['PISO', 'RECUPERACION', 'PEDIATRIA', 'MEDICINA', 'INTERNA', 'ONCOLOGIA', 'GINECOLOGIA', 'HEMATOLOGIA', 'OBSTETRICIA', 'CIRUGIA', 'GENERAL', 'URGENCIAS', 'TERAPIA',
  'INTENSIVA', 'INTERMEDIA', 'INTERMEDIOS', 'CUIDADOS', 'INTENSIVOS', 'OTRAS', 'CAMAS', 'UCIA', 'UCI', 'UTI', 'UCIN', 'UCIP', 'UCIPE', 'ADULTOS', 'QUIROFANO', 'TRAUMATOLOGIA', 'ORTOPEDIA',
  'TRAUMA', 'CHOQUE', 'CORTA', 'ESTANCIA', 'HOSPITALIZACION', 'AISLADOS', 'AISLAMIENTO', 'QUEMADOS', 'NEONATOS', 'CARDIOLOGIA', 'NEUROCIRUGIA', 'UROLOGIA', 'TRASPLANTES', 'DE', 'Y'];
var REG_ESTADOS = ['ESTABLE', 'DELICADO', 'GRAVE', 'MUY GRAVE', 'ALTA', 'DEFUNCION'];
var REG_ESTADO_PESO = { 'ESTABLE': 1, 'DELICADO': 2, 'GRAVE': 3, 'MUY GRAVE': 4 };
// Especialidad: códigos cortos (CG, CCR, URO…) separados por / , + &, o una de estas palabras completas.
var REG_ESP_LARGAS = ['CIRUGIA GENERAL', 'NEUROCX', 'NEUROCIRUGIA', 'UROLOGIA', 'COLUMNA', 'TRASPLANTE', 'TRASPLANTES', 'ONCOLOGIA', 'ONCO', 'GINECOLOGIA', 'GINE', 'HEMATOLOGIA', 'HEMATO',
  'MEDICINA INTERNA', 'PEDIATRIA', 'TRAUMA', 'TRAUMATOLOGIA', 'ORTOPEDIA', 'ANGIO', 'ANGIOLOGIA', 'VASCULAR', 'TORAX', 'CARDIO', 'CARDIOLOGIA', 'MAXILO', 'MAXILOFACIAL', 'PLASTICA', 'COLO',
  'COLOPROCTO', 'COLOPROCTOLOGIA', 'ENDOSCOPIA', 'GASTRO', 'NEFRO', 'NEFROLOGIA', 'CPED'];
// Códigos de especialidad del censo (si el servicio usa uno nuevo, agregarlo aquí: mientras tanto sale «valor no válido»).
var REG_ESP_CODIGOS = ['CG', 'ENDOSCO', 'ENDOSCOPIA', 'CCR', 'URO', 'NCX', 'CPR', 'CMF', 'CT', 'CV', 'CTV', 'CCV', 'TYO', 'ONC', 'ONCOCX', 'GO', 'GYO', 'HEM', 'MI', 'PED', 'CPED', 'CP', 'UCI', 'ANG', 'ACV', 'ORL', 'OFT', 'TX', 'END', 'GE',
  'NEF', 'CAR', 'NEU', 'NEUMO', 'QX', 'CX', 'TR', 'OR', 'CE', 'INF', 'DER', 'PSQ', 'GER', 'REU', 'ALG', 'URG'];
var REG_CAMA_FORMA = /^(([A-Z]{1,4}[- ]?)?\d{1,3}([-. ]\d{1,3})?[A-Z]?|(UCI|UCIA|UTI|UCIN|EXT|RECU|RECUP|RECUPERACION|URG|URGENCIAS|OBS|QX|QUIROFANO|CHOQUE|PISO|CAMA|AISLADO|AISLADOS|SALA|TERAPIA|PASILLO|CORTA ESTANCIA)([- ]?\d{1,3}([-. ]\d{1,3})?[A-Z]?)?)$/;
// Antibiótico (texto) y Dieta del checklist son texto libre (24 nov 2026, revisión): a las pestañas SIN nombres solo pasa
// lo que está hecho de vocabulario conocido (nombres de REG_ATB, dosis, vía, «D5»; palabras de dieta); si trae cualquier
// otra palabra (podría ser un nombre: «INDICA DR. …», «FAM. … TRAE») se guarda solo lo conocido y la marca «[…]».
var REG_TEXTO_OMITIDO = '[…]';
var REG_ATB_VOCAB = /^(G|GR|GRS|GRAMOS?|MG|MCG|UI|U|ML|KG|IV|VO|IM|SC|EV|C|H|HR|HRS|HORAS?|D|DIA|DIAS|DE|DEL|X|POR|CADA|Y|E|O|MAS|DOSIS|UNICA|IMPREGNACION|CARGA|MANTENIMIENTO|INFUSION|CONTINUA|EXTENDIDA|PROFILAXIS|PROFILACTICO|ESQUEMA|INICIA|INICIO|INICIAR|FIN|TERMINA|TERMINO|SUSPENDER?|SUSPENDIDO|COMPLETAR?|AJUSTADO|AJUSTE|AJUSTAR|RENAL|BID|TID|QD|QID|AL|EL|LA|A|EN|CON|HASTA|HOY|AYER|MANANA|SEMANAS?|EMPIRICO|DIRIGIDO|ESCALA|DESESCALA|CAMBIO|CAMBIA|SE|ATB|ANTIBIOTICOS?|TX|TRATAMIENTO|DOBLE|TRIPLE)$/;
var REG_DIETA_VOCAB = /^(DIETA|LIQUIDOS?|LIQUIDA|CLAROS|GENERALES|BLANDA|NORMAL|AYUNO|NPO|NVO|ABSOLUTO|ASTRINGENTE|DIABETIC[OA]|HIPOSODICA|HIPERPROTEICA|HIPOGRASA|HIPOCALORICA|HIPERCALORICA|HIPOPROTEICA|RENAL|HEPATICA|PAPILLAS?|LICUADA|PICADA|SUAVE|SEMISOLIDA|SOLIDA|COMPLETA|ENTERAL|POLIMERICA|ELEMENTAL|SEMIELEMENTAL|OLIGOMERICA|FORMULA|SONDA|SNG|SNY|SNE|SOG|GASTROSTOMIA|YEYUNOSTOMIA|NPT|PARENTERAL|VO|VIA|ORAL|TOLERANCIA|TOLERA|TOLERADA|PROGRESAR?|PROGRESION|INICIA|INICIAR|INICIO|A|DE|DEL|EN|CON|SIN|POR|Y|E|O|LA|EL|AL|PARA|KCAL|CAL|ML|H|HR|HRS|HORAS?|DIA|DIAS|G|GR|KG|BAJA|ALTA|RESIDUO|FIBRA|SAL|GRASAS?|AZUCAR|LACTOSA|COLECISTOQUINETICOS?|IRRITANTES?|LACTEOS?|FRACCIONADA|QUINTOS|TERCIOS|LIBRE|HIDRICA|RESTRICCION|GELATINA|TE|AGUA|JUGO|CALDO|BOLOS?|INFUSION|CONTINUA|NUTRICION|APOYO|SUPLEMENTO|D|X|C|MAS|HOY|MANANA|CENA|DESAYUNO|COMIDA|PRUEBA)$/;
function regAtbTextoSeguro_(v) {
  var t = regNorm_(v).replace(/\s+/g, ' ').trim(), resto = t;
  if (!t) return '';
  REG_ATB.forEach(function (a) { resto = resto.replace(new RegExp(a[1].source, 'g'), ' '); });
  if ((resto.match(/[A-Z]+/g) || []).every(function (w) { return REG_ATB_VOCAB.test(w); })) return t.slice(0, 300);
  var dn = regAtbDiaN_(t);
  return regAtbDetectar(t).map(function (n) { return n + (dn[n] ? ' D' + dn[n] : ''); }).concat([REG_TEXTO_OMITIDO]).join(' · ');
}
function regDietaTextoSeguro_(v) {
  var t = regNorm_(v).replace(/\s+/g, ' ').trim(), palabras = t.match(/[A-Z]+/g) || [];
  if (!t) return '';
  if (palabras.every(function (w) { return REG_DIETA_VOCAB.test(w); })) return t.slice(0, 300);
  return palabras.filter(function (w) { return REG_DIETA_VOCAB.test(w); }).concat([REG_TEXTO_OMITIDO]).join(' ');
}
/** Valor de cama / estado / seccion / esp del censo para una pestaña sin nombres: en mayúsculas y sin acentos si tiene
 *  la forma esperada; «valor no válido» si no (nunca se copia el texto: podría ser un nombre); '' si viene vacío. */
function regValorCenso_(campo, v) {
  var t = regNorm_(v).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  var ok = false;
  // 24 nov 2026 (revisión): forma de cama («3-151», «UCI 4», «12A», «URG»), no «cualquier texto corto con un dígito»
  // («GARCIA LOPEZ 12» pasaba); y la especialidad contra un catálogo de códigos (cualquier palabra de 3 letras pasaba).
  if (campo === 'cama') ok = REG_CAMA_FORMA.test(t);
  else if (campo === 'estado') { t = t.replace(/\./g, ''); ok = REG_ESTADOS.indexOf(t) !== -1; }
  else if (campo === 'seccion') ok = t.length <= 60 && t.split(/[\s\/,.-]+/).filter(Boolean).every(function (w) { return REG_SECCIONES.indexOf(w) !== -1 || /^\d{1,2}$/.test(w); });
  else if (campo === 'esp') ok = t.length <= 40 && t.split(/[\/,+&]+/).map(function (x) { return x.replace(/\./g, '').trim(); }).filter(Boolean).every(function (x) { return REG_ESP_CODIGOS.indexOf(x) !== -1 || REG_ESP_LARGAS.indexOf(x) !== -1; });
  return ok ? t : REG_NO_VALIDO;
}
function regEsUci_(cama, seccion) { return /^(UCI|UTI)/.test(regNorm_(cama).trim()) || /\b(UCI[A-Z]{0,3}|UTI|TERAPIA INTENSIVA|CUIDADOS INTENSIVOS)\b/.test(regNorm_(seccion)); }

// Grupo del dispositivo por su tipo (texto libre de la tarjeta, sin acentos): el primero que coincide; si no, «Otro».
var REG_DISP_GRUPOS = [
  ['Sonda pleural', /PLEURAL|ENDOPLEURAL|\bSEP\b|PLEUROSTOM|PLEUROVAC|SELLO DE AGUA/],
  ['Sonda nasogástrica / enteral', /\bSNG\b|\bSOG\b|\bSNY\b|\bSNE\b|NASOGASTR|OROGASTR|NASOYEYUN|NASOENTER|LEVIN/],
  ['Sonda urinaria', /FOLEY|VESICAL|CISTOSTOM|NEFROSTOM|URINARI|\bSTU\b/],
  ['Presión negativa', /\bVAC\b|PRESION NEGATIVA|\bTPN\b|ABTHERA/],
  ['Estoma', /ESTOMA|ILEOSTOM|COLOSTOM|FISTULA MUCOSA|YEYUNOSTOM|GASTROSTOM/],
  ['Drenaje biliar', /BILIAR|KEHR|SONDA (EN )?T\b|COLECISTOSTOM/],
  ['Penrose', /PENROSE|\bPRS\b/],
  ['Drenovac / Hemovac', /DRENOVAC|DRENOBAC|HEMOVAC/],
  ['Blake / Jackson-Pratt', /BLAKE|\bJP\b|JACKSON/],
  ['Saratoga', /SARATOGA/],
  ['Catéter vascular', /\bCVC\b|CATETER|MAHURKAR|\bPICC\b|PUERTO|LINEA ARTERIAL/],
  ['Herida', /HERIDA|\bHQX\b|DEHISCENCIA|ABDOMEN ABIERTO|BOGOTA/]
];
function regDispGrupo(tipo) {
  var t = regNorm_(tipo);
  if (!t.trim()) return '';
  for (var i = 0; i < REG_DISP_GRUPOS.length; i++) if (REG_DISP_GRUPOS[i][1].test(t)) return REG_DISP_GRUPOS[i][0];
  return 'Otro';
}
/** Gasto del drenaje como número de mL: solo un número limpio, con «ML» / «CC» (y «/24 H») si acaso; '' si es otra cosa. */
function regGastoMl(v) {
  var g = regNumero(v, { unidad: /^(ML|CC|CM3)\.?(\s*(\/|EN|X)?\s*24\s*(H|HRS?|HORAS)\.?)?$/, miles: true });
  return g && !g.comp && g.n >= 0 && g.n <= 20000 ? g.n : '';
}

// Auditoría de pacientes (audit_log, tabla patients): del diff solo las cuatro rutas; `c` es la cama del registro.
var REG_AUD_PAC = [['cama', 'Cama'], ['estado', 'Estado clínico'], ['seccion', 'Sección'], ['esp', 'Especialidad']];
var REG_AUD_PAC_SELECT = 'id,ts,op,record_id,user_id,campos,c:cama,' + REG_AUD_PAC.map(function (x) { return x[0] + ':diff->' + x[0]; }).join(',');
/** Filas de «Movimientos y estado» desde las de audit_log (patients): alta y baja del censo (con la cama) y un renglón
 *  por campo cambiado. Todo valor pasa por regValorCenso_ (nada de texto libre). No lleva quién: solo app / hoja. */
function regMovimientos_(filas) {
  var out = [];
  regArr(filas).forEach(function (a) {
    if (!a || a.id === undefined || a.id === null || !regTexto(a.record_id).trim()) return;
    var op = regTexto(a.op).toUpperCase();
    var poner = function (operacion, campo, de, hacia) {
      out.push({ 'ID': regTexto(a.id), 'ID episodio': regTexto(a.record_id), 'Fecha y hora': regTexto(a.ts), 'Operación': operacion, 'Campo': campo, 'De': de, 'A': hacia, 'Origen': a.user_id ? 'app' : 'hoja o proceso automático' });
    };
    if (op === 'INSERT') poner('Alta en censo', 'Cama', '', regValorCenso_('cama', a.c));
    else if (op === 'DELETE') poner('Baja del censo', 'Cama', regValorCenso_('cama', a.c), '');
    else if (op === 'UPDATE') REG_AUD_PAC.forEach(function (x) {
      var d = a[x[0]];
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      var de = regValorCenso_(x[0], d.de), hacia = regValorCenso_(x[0], d.a);
      if (!de && !hacia) return;
      poner('Cambio', x[1], de, hacia);
    });
  });
  return out;
}

// Auditoría de notas (audit_log, tabla notes, UPDATE): sub-rutas del checklist que se copian, con alias de una letra
// (cada fila trae las 12, casi siempre nulas: el alias corto ahorra ~30 % de lo que se baja). [clave, variable].
var REG_AUD_NOTAS = [['atb', 'Antibiótico (casilla)'], ['atb_nombre', 'Antibiótico (texto)'], ['atb_dias', 'Días de antibiótico (escritos)'], ['npo', 'Ayuno (NPO)'], ['npt', 'NPT'],
  ['npt_pct', 'NPT %'], ['dieta', 'Dieta'], ['tvp', 'Tromboprofilaxis'], ['vp_nore_on', 'Norepinefrina'], ['vp_nore_mlh', 'Norepinefrina mL/h'], ['vp_vaso_on', 'Vasopresina'], ['pm_vent', 'Ventilación mecánica']];
var REG_AUD_SYNC = ['lab_history', 'imagen_history'];   // lo que escriben los robots: no es una edición de una persona
var REG_NOCHE = [22, 6];                                 // «de noche»: de las 22:00 a las 05:59, hora de Ciudad de México
function regAudAlias_(i) { return String.fromCharCode(97 + i); }
function regAudNotasSelect_() { return 'id,ts,record_id,user_id,campos,' + REG_AUD_NOTAS.map(function (x, i) { return regAudAlias_(i) + ':diff->checklist->' + x[0]; }).join(','); }
/** Valor de un sub-diff del checklist: la base lo guarda como texto JSON («true», «"CEFTRIAXONA"», «» si no existía). */
function regAudValor_(t) {
  var s = regTexto(t).trim(), v = s;
  if (!s) return '';
  try { v = JSON.parse(s); } catch (_) { v = s.replace(/^"/, ''); }
  if (v === true) return 'Sí';
  if (v === false) return 'No';
  if (v === null || typeof v === 'object') return '';
  return regTexto(v).replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** Procesa una página de audit_log (notes). acc.soporte: una fila por sub-diff copiado (solo las filas que traen alguno).
 *  acc.actividad: por episodio y día (hora de Ciudad de México), las ediciones leídas, para «Actividad por episodio y
 *  día». `quien(user_id)` da el seudónimo de la cuenta. Nada de la fila cruda se guarda. */
function regAudNotasAcumular(acc, filas, quien) {
  regArr(filas).forEach(function (a) {
    if (!a || a.id === undefined || a.id === null || !regTexto(a.record_id).trim()) return;
    var t = Date.parse(regTexto(a.ts).replace(' ', 'T'));
    if (isNaN(t)) return;
    var ep = regTexto(a.record_id), local = new Date(t + REG_UTC_OFFSET_MIN * 60000).toISOString(), usuario = a.user_id ? quien(regTexto(a.user_id)) : '';
    REG_AUD_NOTAS.forEach(function (x, i) {
      var d = a[regAudAlias_(i)];
      if (!d || typeof d !== 'object' || Array.isArray(d)) return;
      var de = regAudValor_(d.de), hacia = regAudValor_(d.a);
      // Texto libre del checklist: solo vocabulario conocido (regAtbTextoSeguro_ / regDietaTextoSeguro_).
      if (x[0] === 'atb_nombre') { de = regAtbTextoSeguro_(de); hacia = regAtbTextoSeguro_(hacia); }
      else if (x[0] === 'dieta') { de = regDietaTextoSeguro_(de); hacia = regDietaTextoSeguro_(hacia); }
      if (de === hacia) return;
      acc.soporte.push({ 'ID': regTexto(a.id), 'ID episodio': ep, 'Fecha y hora': regTexto(a.ts), 'Variable': x[1], 'De': de, 'A': hacia, 'Quién': usuario || 'sin cuenta' });
    });
    var campos = regArr(a.campos).map(regTexto).filter(function (c) { return /^[a-z_]{1,40}$/.test(c); });
    // Solo sincronización (lab_history / imagen_history): no es una edición de una persona, lleve o no usuario (la
    // sincronización de la app lo lleva). El filtro de la lectura ya no las trae; esto cubre lo que llegue de todos modos.
    if (campos.length && campos.every(function (c) { return REG_AUD_SYNC.indexOf(c) !== -1; })) return;
    var hora = +local.slice(11, 13), k = ep + REG_SEP + local.slice(0, 10);
    (acc.actividad[k] = acc.actividad[k] || { ep: ep, fecha: local.slice(0, 10), eds: [] }).eds.push({ id: Number(a.id), hora: local.slice(11, 16),
      noche: hora >= REG_NOCHE[0] || hora < REG_NOCHE[1], usuario: usuario, cajas: campos });
  });
}
/** Fila de «Actividad por episodio y día» con las ediciones `eds` sumadas a lo que ya decía `vieja` (o desde cero). */
function regActividadFila_(ep, fecha, eds, vieja) {
  var v = vieja || {}, lista = function (s) { return regTexto(s).split(' · ').map(function (x) { return x.trim(); }).filter(Boolean); };
  var usuarios = lista(v['Usuarios']), cajas = lista(v['Cajas tocadas']), n = +v['Ediciones (n)'] || 0, noche = +v['Ediciones de noche (n)'] || 0;
  var primera = regTexto(v['Primera hora']).trim(), ultima = regTexto(v['Última hora']).trim(), maxId = +v['Último ID'] || 0;
  eds.forEach(function (e) {
    n++; if (e.noche) noche++;
    if (e.usuario && usuarios.indexOf(e.usuario) === -1) usuarios.push(e.usuario);
    e.cajas.forEach(function (c) { if (cajas.indexOf(c) === -1) cajas.push(c); });
    if (!primera || e.hora < primera) primera = e.hora;
    if (!ultima || e.hora > ultima) ultima = e.hora;
    if (e.id > maxId) maxId = e.id;
  });
  return { 'ID episodio': ep, 'Fecha': fecha, 'Ediciones (n)': n, 'Usuarios (n)': usuarios.length, 'Primera hora': primera, 'Última hora': ultima, 'Ediciones de noche (n)': noche,
    'Cajas tocadas': cajas.sort().join(' · '), 'Usuarios': usuarios.sort().join(' · '), 'Último ID': maxId };
}
/** Fusión de «Actividad por episodio y día»: la lectura es por partes (cursor con 1 h de margen y vueltas con tope), así
 *  que lo de hoy se SUMA a la fila de la hoja. Solo cuentan las ediciones con id mayor que el «Último ID» ya contado:
 *  lo releído por el margen no se cuenta dos veces. Sin ediciones nuevas la fila queda igual. */
function regActividadCombinar(vieja, nueva) {
  var visto = +vieja['Último ID'] || 0, eds = regArr(nueva.__ediciones).filter(function (e) { return e.id > visto; });
  if (!eds.length) return vieja;
  return regActividadFila_(regTexto(nueva['ID episodio']), regTexto(nueva['Fecha']), eds, vieja);
}

/** Episodios (una hospitalización por id de paciente de la base) y filas de cada pestaña (objetos por columna). */
function regConstruir(datos, hoy) {
  var notasPorId = {}, cronoPorId = {};
  regArr(datos.notes).forEach(function (n) { if (n && n.patient_id) notasPorId[n.patient_id] = n; });
  regArr(datos.cronologias).forEach(function (c) { if (c && c.patient_id) cronoPorId[c.patient_id] = regTexto(c.cronologia); });
  var episodios = {}, orden = [], rescates = [];
  function agregar(id, ep) { if (!episodios[id]) orden.push(id); episodios[id] = ep; }

  // Egresados y archivados (la Papelera), del más viejo al más nuevo: la copia más reciente de cada episodio manda y las
  // anteriores rellenan lo que le falte. Cada fila se une antes con la copia de la base que guardó (_copia_base).
  regArr(datos.archive).slice().sort(function (a, b) { return regTexto(a && a.archived_at).localeCompare(regTexto(b && b.archived_at)); })
    .forEach(function (a) {
      if (!a) return;
      var pd = regObj(a.patient_data), nd0 = regObj(a.note_data);
      if (!regTexto(pd.nombre).trim() && !regTexto(pd.exp).trim()) return;
      var nd = regUnirNotas(nd0, nd0._copia_base);
      // Copia de rescate de un iPad SIN id de la base (30 oct 2026: «…el paciente ya no estaba en el censo»): no es otra
      // hospitalización. Se une al final con el episodio de la misma persona (regUnirRescates); antes cada copia era un
      // egreso nuevo («archivo-…») y un iPad viejo que repitió 30 copias inflaba egresos y mortalidad.
      if (!regTexto(pd._supa_id || pd.id).trim() && REG_RESCATE.test(regTexto(nd0._egreso))) { rescates.push({ a: a, pd: pd, nd: nd }); return; }
      var id = regTexto(pd._supa_id || pd.id || ('archivo-' + a.id));
      var elegido = !!REG_EGRESO_APP[regTexto(nd0._egreso_tipo)];
      var motivo = elegido ? regEgresoElegido_(nd0)
        : regTexto(nd0._egreso || (/^(ALTA|DEFUNCI[OÓ]N)$/i.test(regTexto(pd.estado)) ? pd.estado : '') || 'EGRESO');
      var egreso = regFecha(nd0._egresoFecha) || regFechaLocal(a.archived_at);
      var previo = episodios[id];
      // 24 nov 2026: quién archivó la copia que da el egreso y quién registró el motivo (van con el motivo que queda).
      var egresadoPor = regTexto(a.archived_by), tipoPor = elegido ? regTexto(nd0._egreso_tipo_por) : '', tipoTs = elegido ? regTexto(nd0._egreso_tipo_ts) : '';
      // Una copia técnica más nueva (rescate de cambios sin subir, cama reasignada a otra persona, borrado en la base) no
      // tapa el motivo ni la fecha del egreso real que dejó una copia anterior (27 oct 2026: para estudios).
      if (previo && regEgresoPeso(motivo, pd.estado) < regEgresoPeso(previo.motivo, previo.p.estado)) { motivo = previo.motivo; egreso = previo.egreso; egresadoPor = previo.egresadoPor || egresadoPor; tipoPor = previo.tipoPor || ''; tipoTs = previo.tipoTs || ''; }
      var p = previo ? Object.assign({}, previo.p) : {};
      Object.keys(pd).forEach(function (k) { if (!regVacio(pd[k])) p[k] = pd[k]; });
      // 24 nov 2026: los dispositivos de la copia MÁS RECIENTE que traiga la lista (la unión de copias revive los retirados).
      var dispCopia = Array.isArray(regObj(nd.checklist).dispositivos) ? nd.checklist.dispositivos : (previo ? previo.disp : undefined);
      agregar(id, { id: id, p: p, n: previo ? regUnirNotas(nd, previo.n) : nd, estado: 'Egresado', motivo: motivo, egreso: egreso, fuente: a.__borrado ? 'Papelera (borrado)' : 'Papelera (archive)',
        egresadoPor: egresadoPor, tipoPor: tipoPor, tipoTs: tipoTs, disp: dispCopia });
    });
  // En el censo ahora: el censo manda; lo que traiga la Papelera del mismo id rellena lo que le falte.
  regArr(datos.patients).forEach(function (p) {
    if (!p || !p.id) return;
    if (!regTexto(p.nombre).trim() && !regTexto(p.exp).trim()) return;
    var id = regTexto(p.id), previo = episodios[id];
    // `vivo`: la nota del censo tal cual (24 nov 2026). La foto diaria y los dispositivos de un hospitalizado salen de ella,
    // no de la unión con copias viejas de la Papelera (que rellena lo que hoy está vacío a propósito).
    var vivo = regObj(notasPorId[p.id]);
    agregar(id, { id: id, p: p, n: previo ? regUnirNotas(vivo, previo.n) : vivo, estado: 'Hospitalizado', motivo: '', egreso: '', fuente: 'Censo (patients)',
      vivo: vivo, disp: regArr(regObj(vivo.checklist).dispositivos) });
  });
  var absorbidos = regUnirRescates(rescates, episodios, orden, agregar);
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
  // Las filas que dejaron corridas anteriores con el id de una copia de rescate ya unida quedan «Vigente: No».
  absorbidos.forEach(function (id) { out.episodiosHoy[id] = true; });
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
        'Tipo': c.tipo || '', 'Abordaje': c.abordaje || '', 'Clavien-Dindo': c.clavien || '', 'Complicación': c.complicacion || '',
        'ID cirugía': c.id || '', 'Fotos (n)': c.fuente === 'Caja Cirugías' ? c.fotos : '', 'Foto subida por': c.fotoPor || '', 'Foto subida el': c.fotoTs || '' }));
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
    var une = function (partes) { return partes.filter(function (x) { return regTexto(x).trim(); }).join(' · '); };
    // Dispositivos (24 nov 2026): una fila por dispositivo de la copia más reciente. En un hospitalizado «visto» = hoy; en
    // un egresado, el día del egreso (seguía en la tarjeta al salir) y «Primera vez visto» solo si el registro lo vio
    // hospitalizado. El gasto de cada día (solo hospitalizados con gasto escrito) va a «Drenajes · diario».
    var hosp = ep.estado === 'Hospitalizado', dispVistos = {}, nDisp = 0;
    regArr(ep.disp !== undefined ? ep.disp : ck.dispositivos).forEach(function (d) {
      var o = d && typeof d === 'object' ? d : { tipo: regTexto(d) };
      var tx = function (k) { return regEsArchivo(o[k]) ? '' : regTexto(o[k]).replace(/\s+/g, ' ').trim(); };
      var tipo = tx('tipo'), lado = tx('lado'), sitio = tx('sitio'), gasto = tx('gasto'), carac = tx('carac');
      if (!tipo && !sitio && !gasto && !carac) return;
      var idD = tx('id') || ('sin id · ' + [tipo, lado, sitio].filter(Boolean).join(' '));
      if (dispVistos[idD]) return;
      dispVistos[idD] = true; nDisp++;
      fila(REG_DISPOSITIVOS, { 'ID episodio': id, 'ID dispositivo': idD, 'Tipo': tipo, 'Tipo (grupo)': regDispGrupo(tipo), 'Lado': lado, 'Sitio': sitio, 'Características': carac,
        'Fecha de colocación': regFecha(o.fi) || regFecha(o.fecha), 'Gasto (último)': gasto, 'Primera vez visto': hosp ? hoy : '', 'Última vez visto': hosp ? hoy : regTexto(ep.egreso), 'Vigente': 'Sí' });
      if (hosp && gasto) fila(REG_DRENAJES_DIARIO, { 'ID episodio': id, 'ID dispositivo': idD, 'Fecha': hoy, 'Tipo': tipo, 'Gasto (texto)': gasto, 'Gasto (mL)': regGastoMl(gasto), 'Características': carac });
    });
    // Estado diario (24 nov 2026): la foto de HOY del tratamiento de cada hospitalizado, desde la nota viva del censo. Sin
    // nombre ni expediente; cama, sección y estado pasan por regValorCenso_ (la sección del censo puede traer texto libre).
    if (hosp) {
      var cv = regObj(regObj(ep.vivo).checklist), sn = function (v) { return v ? 'Sí' : 'No'; }, t = function (v) { return regTexto(v).replace(/\s+/g, ' ').trim(); };
      var mg = regNumero(cv.vp_nore_mg), ml = regNumero(cv.vp_nore_ml);
      fila(REG_ESTADO_DIARIO, { 'ID episodio': id, 'Fecha': hoy, 'Cama': regValorCenso_('cama', p.cama), 'Sección': regValorCenso_('seccion', p.seccion), 'Estado clínico': regValorCenso_('estado', p.estado),
        'ATB (casilla)': sn(cv.atb), 'Antibiótico (texto)': regAtbTextoSeguro_(cv.atb_nombre), 'Días ATB (escritos)': t(cv.atb_dias), 'ATB inicio': regFecha(cv.atb_inicio) || regFecha(cv.atb_fecha_inicio),
        'Antibióticos en Manejo (detectados)': regAtbDetectar(regObj(ep.vivo).manejo).join(' · '), 'NPO': sn(cv.npo), 'Dieta': regDietaTextoSeguro_(cv.dieta), 'NPT': sn(cv.npt), 'NPT %': cv.npt ? t(cv.npt_pct) : '',
        'TVP': cv.tvp ? une(['Sí', t(cv.tvp_tipo), t(cv.tvp_dosis), t(cv.tvp_otro)]) : 'No', 'VM': sn(cv.pm_vent), 'Modo': cv.pm_vent ? t(cv.pm_vent_modo) : '', 'FiO2': cv.pm_vent ? t(cv.pm_vent_fio2) : '',
        'PEEP': cv.pm_vent ? t(cv.pm_vent_peep) : '', 'O2 L/min': t(cv.pm_o2l), 'Norepinefrina mL/h': cv.vp_nore_on ? (t(cv.vp_nore_mlh) || 'Sí (sin mL/h)') : '',
        'Norepinefrina mg/mL': cv.vp_nore_on && mg && ml && !mg.comp && !ml.comp && ml.n > 0 ? regRedondear(mg.n / ml.n, 4) : '', 'Vasopresina mL/h': cv.vp_vaso_on ? (t(cv.vp_vaso_mlh) || 'Sí (sin mL/h)') : '',
        'Peso': t(cv.pm_peso), 'Curación (necesaria/hecha)': cv.cur_realizada ? (cv.cur_necesita ? 'Necesaria · hecha' : 'Hecha') : (cv.cur_necesita ? 'Necesaria · pendiente' : ''), 'Dispositivos (n)': nDisp });
    }
    // Días que la app cuenta sola (30 oct 2026): con fecha de inicio se anota «desde AAAA-MM-DD» (los días dependen del corte).
    // 24 nov 2026: la app escribe atb_inicio / npo_inicio / npt_inicio; «…_fecha_inicio» es solo respaldo (algunas notas de la base lo traen).
    var desde = function (x) { var f = regFecha(ck[x + '_inicio']) || regFecha(ck[x + '_fecha_inicio']); return f ? 'desde ' + f : ''; };
    var atb = ck.atb ? [regTexto(ck.atb_nombre), ck.atb_dias && !desde('atb') ? regTexto(ck.atb_dias) + ' días' : '', desde('atb')].filter(Boolean).join(', ') || 'Sí' : '';
    var dxP = regDxPrincipal(ck.dx_cat, regTexto(p.dx) || regTexto(n.dx));
    // Nota completa (24 nov 2026): sin los archivos de la tarjeta (bóveda, DICOM, capturas, diagramas); si aun así no
    // cabe en una celda sigue en «Nota completa (JSON) · 2» (las dos, pegadas, son el JSON completo) en vez de cortarse.
    var notaJson = regPartir_(regJsonLimpio(n, ['checklist', 'labHistory', 'lab_history', 'imagenHistory', 'imagen_history', 'body_diagram_ant', 'body_diagram_post',
      'documentVault', 'dicomFiles', 'drainageScreenshots', 'cvc_image', 'imagen_file', 'body_diagram_lat_l', 'body_diagram_lat_r']));

    fila('Pacientes', {
      'ID episodio': id, 'Estado en registro': ep.estado, 'Motivo de egreso': ep.motivo, 'Nombre': nombre, 'Expediente': exp,
      'Edad': regTexto(p.edad), 'Sexo': regTexto(ck.sexo || p.sexo), 'Sexo (fuente)': regTexto(ck.sexo || p.sexo).trim() ? REG_SEXO_TARJETA : '',
      'Especialidad': regTexto(p.esp), 'Sección': regTexto(p.seccion), 'Adscrito': regTexto(p.adscrito),
      'Residente': regTexto(p.residente), 'Cama': regTexto(p.cama), 'Fecha de ingreso': ingreso, 'Fecha de egreso': ep.egreso,
      'Días de estancia': regDias(ingreso, ep.egreso || hoy), 'Diagnóstico': regTexto(p.dx), 'Estado clínico': regTexto(p.estado),
      'Antecedentes (APP)': regTexto(n.app), 'Padecimiento (PA)': regTexto(n.pa), 'Manejo': regTexto(n.manejo),
      'Pendientes': regTexto(n.pendientes), 'Drenajes y dispositivos': drenajes, 'Antibiótico': atb, 'Cultivos': regTexto(ck.cultivos),
      'Interconsultas': regTexto(ck.interconsultas),
      'Dieta y NPO': une([regTexto(ck.dieta), ck.npo ? 'NPO' + (desde('npo') ? ' ' + desde('npo') : (ck.npo_dias ? ' ' + regTexto(ck.npo_dias) + ' días' : '')) : '']),
      'TVP': ck.tvp ? une(['Sí', regTexto(ck.tvp_tipo), regTexto(ck.tvp_dosis), regTexto(ck.tvp_otro)]) : '',
      'NPT': ck.npt ? une(['Sí', ck.npt_pct ? regTexto(ck.npt_pct) + '%' : '', desde('npt') || regTexto(ck.npt_fecha)]) : '',
      'Ventilación': ck.pm_vent ? une(['Sí', regTexto(ck.pm_vent_modo), ck.pm_vent_fio2 ? 'FiO2 ' + regTexto(ck.pm_vent_fio2) : '', ck.pm_vent_peep ? 'PEEP ' + regTexto(ck.pm_vent_peep) : '']) : '',
      'Vasopresores': une([ck.vp_nore_on ? 'Norepinefrina' + (ck.vp_nore_mlh ? ' ' + regTexto(ck.vp_nore_mlh) + ' mL/h' : '') : '', ck.vp_vaso_on ? 'Vasopresina' + (ck.vp_vaso_mlh ? ' ' + regTexto(ck.vp_vaso_mlh) + ' mL/h' : '') : '']),
      'Cirugías (resumen)': cxTodas.map(function (c) { return [c.fecha, c.proc, REG_CX_DIRECTAS.indexOf(c.fuente) === -1 ? '[' + c.fuente + ']' : ''].filter(Boolean).join(' '); }).join(' | '),
      'Imagen (resumen)': resumenImg.join(' | '), 'Labs (fechas)': fechasLab.sort().join(', '),
      'Guardia vigente': entrega, 'Cronología': crono.join('\n'), 'Misceláneo': regTexto(n.misc),
      'Nota completa (JSON)': notaJson[0], 'Nota completa (JSON) · 2': notaJson[1],
      'Checklist completo (JSON)': regJsonLimpio(ck, ['__pl_note_meta', 'cirugias', 'pm_hist', 'nota_hist', '__ink']),
      'Alta en la app': regTexto(p.created_at), 'Última modificación en la app': regTexto(n.updated_at || p.updated_at), 'Fuente': ep.fuente, 'Última vez en la base': hoy,
      'Peso (kg)': regTexto(ck.pm_peso), 'Talla': regTexto(ck.pm_talla),
      'Dx principal': dxP.label, 'CIE-10 (grupo)': dxP.cie, 'Dx principal (fuente)': dxP.fuente,
      // 24 nov 2026. El motivo «registrado por» solo va si el motivo que quedó es el que eligió una persona.
      'Egresado por': ep.estado === 'Egresado' ? regTexto(ep.egresadoPor) : '',
      'Motivo de egreso registrado por': ep.estado === 'Egresado' ? regTexto(ep.tipoPor) : '', 'Motivo registrado el': ep.estado === 'Egresado' ? regTexto(ep.tipoTs) : '',
      'Última modificación por': regTexto(n.updated_by || p.updated_by), 'Nota restaurada el': regTexto(n.restaurada_en), 'Alias WinLab': regTexto(ck.winlab_alias)
    });
  });

  regArr(datos.procedimientos).forEach(function (x) {
    if (!x || !x.id) return;
    fila('Procedimientos programados', { 'ID': regTexto(x.id), 'Fecha': regFecha(x.fecha_dia), 'Cama': regTexto(x.cama), 'Expediente': regTexto(x.exp), 'Nombre': regTexto(x.nombre), 'Edad': regTexto(x.edad), 'Diagnóstico': regTexto(x.dx), 'Especialidad': regTexto(x.esp), 'Adscrito': regTexto(x.adscrito), 'Residente': regTexto(x.residente), 'Agregado por': regTexto(x.added_by) });
  });
  // 25 nov 2026 (registro 2026.11.26-2): procedimientos del censo. ID episodio / Ambulatorio se completan al escribir
  // (regCompletarProcCenso_, contra todo «Pacientes»).
  regArr(datos.censoProcs).forEach(function (x) {
    if (!x || x.id === undefined || x.id === null) return;
    fila(REG_PROC_CENSO, { 'ID': regTexto(x.id), 'Fecha': regFecha(x.fecha), 'Cama': regTexto(x.cama), 'Expediente': regTexto(x.exp), 'Nombre': regTexto(x.nombre), 'Edad': regTexto(x.edad),
      'Diagnóstico': regTexto(x.dx), 'Especialidad': regTexto(x.esp), 'Adscrito': regTexto(x.adscrito), 'Residente': regTexto(x.residente),
      'Visto primero': regTexto(x.visto_primero), 'Visto por última vez': regTexto(x.visto_ultimo), 'ID episodio': '', 'Ambulatorio': '', 'Grupo': regCxGrupo(x.dx), 'Vigente': 'Sí' });
  });
  // WinLab: ya acumulado por regWlAcumular (un renglón por reporte del paciente y uno por muestra de cultivo).
  var wl = datos.winlab || {};
  Object.keys(regObj(wl.labs)).forEach(function (k) { fila(REG_WL_LABS, wl.labs[k]); });
  Object.keys(regObj(wl.cultivos)).forEach(function (k) { fila('Cultivos del robot (WinLab)', wl.cultivos[k]); });
  regArr(datos.ris).forEach(function (r) {
    if (!r || r.id === undefined || r.id === null) return;
    fila('Imagen del robot (RIS)', { 'ID': regTexto(r.id), 'ID episodio': regTexto(r.patient_id), 'Expediente': regTexto(r.exp), 'Paciente': regTexto(r.paciente), 'Fecha': regTexto(r.fecha), 'Hora': regTexto(r.hora), 'Modalidad': regTexto(r.modalidad), 'Estudios': regTexto(r.estudios), 'Crítico': regSiNo(r.critico), 'Estado del reporte': regTexto(r.reporte_estado), 'Reporte': regTexto(r.reporte), 'Enlace del reporte': /^https?:\/\//i.test(regTexto(r.reporte_url)) ? regTexto(r.reporte_url) : '', 'Capturado': regTexto(r.scraped_at) });
  });
  // Historial de auditoría (24 nov 2026): movimientos del censo, cambios de soporte y actividad por episodio y día.
  regMovimientos_(datos.auditPacientes).forEach(function (r) { fila(REG_MOVIMIENTOS, r); });
  var audN = regObj(datos.auditNotas);
  regArr(audN.soporte).forEach(function (r) { fila(REG_SOPORTE, r); });
  Object.keys(regObj(audN.actividad)).forEach(function (k) {
    var a = audN.actividad[k], f = regActividadFila_(a.ep, a.fecha, a.eds, null);
    f.__ediciones = a.eds;   // regActividadCombinar las suma a la fila que ya esté en la hoja
    fila(REG_ACTIVIDAD, f);
  });
  // Renglones retirados de la guardia (24 nov 2026): una fila por renglón de cada corte, con su lugar en el corte.
  regArr(datos.guardia).forEach(function (g) {
    if (!g || g.id === undefined || g.id === null) return;
    regArr(g.lineas).forEach(function (l, i) {
      if (!regTexto(l).trim()) return;
      fila(REG_GUARDIA_CORTES, { 'ID': regTexto(g.id), 'ID episodio': regTexto(g.patient_id), 'Fecha y hora': regTexto(g.ts), 'Motivo': regTexto(g.motivo), 'Orden': i + 1, 'Renglón': regTexto(l) });
    });
  });
  return out;
}

// ─── Fusión con lo que ya está en la hoja (nunca se borra) ───────────────────────────────────────────────────────
function regClaveDe(fila, cfg) { return cfg.clave.map(function (c) { return regTexto(fila[c]).trim(); }).join(REG_SEP); }

/** Junta lo de la hoja (`viejas`, objetos por columna, en su orden, con su renglón __fila) con lo de hoy (`nuevas`): la
 *  fila con la misma clave se reemplaza por la de hoy (en el mismo renglón; cfg.conservarViejo y cfg.combinar dicen qué
 *  se queda de la vieja); las que hoy no vienen se conservan (en modo
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
    if (hoyPorClave[k] && !(cfg.preferirViejo && cfg.preferirViejo(r, hoyPorClave[k]))) {
      // 24 nov 2026: `combinar` suma lo de hoy a la fila de la hoja; `conservarViejo` deja lo que la hoja ya tenía escrito
      // en esas columnas (antes la fila de hoy reemplazaba completa a la vieja y «Primera vez visto» se perdía).
      var h = cfg.combinar ? Object.assign({}, cfg.combinar(r, hoyPorClave[k])) : Object.assign({}, hoyPorClave[k]);
      regArr(cfg.conservarViejo).forEach(function (col) { if (regTexto(r[col]).trim()) h[col] = r[col]; });
      delete h.__fila; if (r.__fila) h.__fila = r.__fila;
      out.push(h); return;
    }
    if (hoyPorClave[k]) {
      // Se queda la fila de la hoja, pero las columnas nuevas que ella aún no tiene se llenan con lo de hoy.
      var v = Object.assign({}, r), nueva = hoyPorClave[k];
      regArr(cfg.completarVacias).forEach(function (col) { if (!regTexto(v[col]).trim() && regTexto(nueva[col]).trim()) v[col] = nueva[col]; });
      out.push(v); return;
    }
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
var REG_AN_RESUMEN = 'Resumen mensual', REG_POR_COMPLETAR = 'Por completar', REG_AN_CIRUGIAS = 'Análisis · Cirugías';
var REG_CX_AN_COLUMNAS = ['ID cirugía', 'ID episodio', 'ID paciente', 'Fecha', 'N.º de cirugía en el episodio', 'Día de estancia', 'Días desde la cirugía previa', 'Grupo', 'Procedimiento', 'Tipo',
  'Urgencia inferida (día 0-1)', 'Abordaje', 'Abordaje (inferido del texto)', 'Clavien-Dindo', 'Sangrado (mL)', 'Fuente', 'Es índice', 'Reintervención planeada (probable)',
  'Reintervención no planeada (probable)', 'Días cirugía→egreso', 'Defunción en el episodio', 'Dx principal', 'Edad (años)', 'Fecha estimada', 'Revisar', 'Vigente'];
// Columnas nuevas de «Análisis · Cultivos» (24 nov 2026), al final.
var REG_CULT_NUEVAS = ['Sitio (grupo)', 'Días desde la última cirugía', 'Posoperatorio (1-30 d)', 'Multirresistente (probable)', 'Contaminante probable'];
var REG_RESUMEN_COLUMNAS = ['Mes', 'Ingresos (n)', 'Egresos (n)', 'Egresos con desenlace conocido (n)', 'Defunciones (n)', 'Mortalidad (%)', 'Egresos sin motivo (n)',
  'Estancia mediana (días)', 'Estancia media (días)', 'Pacientes operados (n)', 'Cirugías (n)', 'Cirugías de urgencia (%)', 'Abordaje laparoscópico (%)', 'Conversiones (n)',
  'Complicación mayor (Clavien ≥ IIIa) (n)', 'Reintervenciones (n)', 'Reingresos a 30 días (n)', 'Reingreso a 30 días (%)', 'Cultivos positivos (n)',
  'Dx principales (más frecuentes)', 'Cirugías por grupo (más frecuentes)', 'Gérmenes (más frecuentes)', 'Ingresos con datos incompletos (n)', 'Vigente',
  // 24 nov 2026 (al final).
  'Cirugías sin fecha exacta (n)', 'Reintervenciones no planeadas (n)', 'Ingresos sin talla (n)', 'Egresos con motivo (%)', 'Con sexo (%)', 'Episodios sin labs (n)',
  // 25 nov 2026 (registro 2026.11.26-2, al final): la sección PROCEDIMIENTOS del censo, por mes de la fecha.
  'Procedimientos en el censo (n)', 'Procedimientos en el censo de CG (n)', 'Ambulatorios (n)'];
// Desde cuándo hay procedimientos del censo (25 nov 2026): Google no guarda los censos viejos. Antes de ese mes las
// columnas del Resumen mensual van vacías (no hay dato), no en 0.
var REG_PROC_CENSO_DESDE = '2026-11-25';
// «Seguimiento de operados» (25 nov 2026): una fila por persona (expediente + nombre compatible). CON NOMBRES.
var REG_SEGUIMIENTO_COLUMNAS = ['Expediente', 'Nombre', 'Edad', 'Sexo', 'Sexo (fuente)', 'Primer procedimiento', 'Último procedimiento', 'Procedimientos en el censo (n)',
  'Cirugías registradas (n)', 'Especialidades', 'Diagnóstico más reciente', 'ID episodios', '¿Hospitalizado ahora?', 'Último egreso', 'Motivo del último egreso',
  'Días desde el último procedimiento', 'Reingresos posteriores (n)', 'Vigente',
  // 25 nov 2026 (revisión, al final): «Nombre» es estable (el primero que se vio, sin acentos); aquí el más reciente.
  'Nombre más reciente'];
// «Días desde el último procedimiento» solo durante el seguimiento a 30 días: después queda vacío y la fila deja de
// cambiar cada noche (antes se reescribían todas las filas, una lista que crece sin tope). 25 nov 2026 (revisión).
var REG_SEGUIMIENTO_DIAS_MAX = 30;
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
// 24 nov 2026: comorbilidades para el índice de Charlson y variables preoperatorias. Lista APARTE de REG_COMORB para que
// las columnas que ya existen (y «Comorbilidades (n)») no cambien: estas se agregan al final de «Análisis · Episodios».
// [columna, patrón, ¿solo en APP?]: lo marcado `true` no se busca en el DX (ahí describe ESTE episodio, no un antecedente).
var REG_COMORB_1124 = [
  ['EVC', /\bEVC[IH]?\b|\bACV\b|\bAIT\b|(ENFERMEDAD|EVENTO|ACCIDENTE) (VASCULAR CEREBRAL|CEREBRO ?VASCULAR)|INFARTO CEREBRAL|ISQUEMIA CEREBRAL|HEMORRAGIA (CEREBRAL|INTRAPARENQUIMATOSA|SUBARACNOIDEA)/],
  ['Enfermedad vascular periférica', /ENFERMEDAD (VASCULAR|ARTERIAL) PERIFERICA|\bEVP\b|INSUFICIENCIA ARTERIAL|CLAUDICACION|ANEURISMA (DE )?(LA )?AORT|BYPASS (FEMORO|AORTO)|ISQUEMIA (ARTERIAL|CRITICA) (DE |DEL )?(MIEMBRO|EXTREMIDAD)/],
  ['Demencia', /DEMENCIA|ALZHEIMER|DETERIORO (NEURO)?COGNITIVO/],
  ['Úlcera péptica', /ULCERA (PEPTICA|GASTRICA|DUODENAL)|ENFERMEDAD (ACIDO ?PEPTICA|ULCEROSA PEPTICA)/],
  ['Enfermedad del tejido conectivo', /LUPUS|\bLES\b|ARTRITIS REUMATOIDE|ESCLERODERMIA|ESCLEROSIS SISTEMICA|POLIMIOSITIS|DERMATOMIOSITIS|POLIMIALGIA|ENFERMEDAD MIXTA DEL TEJIDO|VASCULITIS|SJOGREN/],
  ['Hemiplejía', /HEMIPLEJ|HEMIPLEG|PARAPLEJ|PARAPLEG|CUADRIPLEJ|CUADRIPLEG|TETRAPLEJ|HEMIPARESIA/],
  ['Diabetes con daño a órgano blanco', /(NEFROPATIA|RETINOPATIA|NEUROPATIA) DIABETICA|ENFERMEDAD RENAL DIABETICA|PIE DIABETICO|DIABET\w* (CON |Y )?COMPLICACION/],
  ['Hepatopatía grave', /HIPERTENSION PORTAL|VARICES (ESOFAGICAS|GASTRICAS)|ENCEFALOPATIA HEPATICA|SINDROME HEPATORRENAL|INSUFICIENCIA HEPATICA|CHILD([- ]PUGH)? ?[BC]\b/],
  ['Metástasis', /METASTA|\bMETS\b|CARCINOMATOSIS|(ESTADIO|ETAPA)( CLINIC[AO])? IV\b|\bEC ?IV\b/],
  ['Leucemia / linfoma', /LEUCEMIA|LINFOMA|MIELOMA/],
  ['VIH / SIDA', /\bVIH\b|\bSIDA\b|\bHIV\b/],
  ['Alcoholismo', /(ALCOHOLISMO|ETILISMO)(?! (SOCIAL|OCASIONAL|ESPORADIC))|ALCOHOLICO CRONICO|DEPENDENCIA (AL|DE) ALCOHOL/],
  ['Anticoagulante / antiagregante', /ANTICOAGUL|WARFARINA|ACENOCUMAROL|RIVAROXABAN|APIXABAN|DABIGATRAN|ENOXAPARINA|CLOPIDOGREL|TICAGRELOR|PRASUGREL|ANTIAGREGA|ASPIRINA|ACIDO ACETILSALICILICO|\bAAS\b/, true],
  ['Cirugía abdominal previa', /LAPAROTOM|\bLAPE\b|COLECISTECTOM|\bCOLE ?LAP\b|APENDICECTOM|CESAREA|HISTERECTOM|\bOTB\b|SALPINGO|HERNIOPLAST|PLASTIA (INGUINAL|UMBILICAL|DE PARED|VENTRAL)|COLECTOM|GASTRECTOM|RESECCION INTESTINAL|COLOSTOM|ILEOSTOM|FUNDUPLICA|NEFRECTOM|BYPASS GASTRICO|MANGA GASTRICA|CIRUGIA ABDOMINAL/, true]
];
// Negación: «NIEGA…», «… NEGADA», «SIN…», «NO REFIERE…». Un renglón que empieza con negación niega la lista que sigue
// («NIEGA DM, HAS») hasta un dato que la contradice («… EN TRATAMIENTO», «DX HACE 5 AÑOS»).
var REG_NEG = /\bNIEGA|\bNEGAD[OA]S?\b|\bNEGATIV[OA]S?\b|\bNO (REFIERE|PADECE|TIENE|CONOCID)|\bDESCONOCE|^\s*SIN\b|\bINTERROGAD[OA]S? Y NEGAD/;
var REG_FAMILIAR = /\b(PADRE|MADRE|PAPA|MAMA|HERMAN[OA]S?|ABUEL[OA]S?|TI[OA]S?|HIJ[OA]S?|FAMILIAR(ES)?|AHF|HEREDO ?FAMILIAR(ES)?)\b/;
var REG_AFIRMA = /TRATAMIENTO|\bTX\b|\bDX\b|DIAGNOSTIC|\bHACE\b|\bDESDE\b|CONTROL|\bCON\b|\bEN MANEJO|\d/;
/** Banderas de comorbilidad desde APP y DX: 1 = mencionada; 0 = hay APP y no la menciona (o la niega); '' = sin APP
 *  (el DX solo puede poner 1: casi nunca enlista las comorbilidades). */
function regComorbilidades(app, dx, lista) {
  // 24 nov 2026: `lista` (por omisión REG_COMORB) deja usar la misma regla de negación con REG_COMORB_1124; lo que la
  // lista marca «solo en APP» (c[2]) no se busca en el DX.
  lista = lista || REG_COMORB;
  var textos = [{ t: regTexto(app), dx: false }, { t: regTexto(dx), dx: true }].filter(function (x) { return x.t.trim(); });
  var out = {}, hayApp = !!regTexto(app).trim();
  lista.forEach(function (c) { out[c[0]] = hayApp ? 0 : ''; });
  textos.forEach(function (x) {
    x.t.split(/[.\n;]+/).forEach(function (oracion) {
      var o = regNorm_(oracion);
      if (!o.trim()) return;
      var negando = REG_NEG.test(o.replace(/,.*$/, '')) && /^\s*(NIEGA|NEGAD|NEGATIV|SIN\b|NO\b|INTERROGAD|DESCONOCE|ANTECEDENTES? (PERSONALES )?(PATOLOGICOS )?NEGAD|CRONICO ?DEGENERATIVOS NEGAD|APP:? ?(NIEGA|NEGAD))/.test(o);
      // 24 nov 2026 (revisión): (1) la negación pospuesta en plural niega hacia ATRÁS la lista que cierra («DM2 E HAS
      // NEGADAS»), hasta una cláusula que afirma; (2) «NO DIABETICO, HIPERTENSO»: la cláusula que empieza con NO va negada;
      // (3) lo de un familiar («PADRE CON DIABETES Y CANCER DE COLON», AHF) no es del paciente: desde la palabra de
      // parentesco hasta el fin de la oración (o hasta «APP» / «PACIENTE»).
      var cls = o.split(/,|\bY\b|\bE\b|\//), afirmaDe = function (cl) { return REG_AFIRMA.test(cl.replace(/\b(DM|DT|DMT|ERC|KDIGO|IT)\s*:?\s*\d+/g, '')); };
      var negPost = {}, familia = false;
      if (/\bNEGAD[OA]S\s*$/.test(o)) for (var j = cls.length - 1; j >= 0; j--) { if (j < cls.length - 1 && afirmaDe(cls[j])) break; negPost[j] = true; }
      cls.forEach(function (cl, i) {
        if (!cl.trim()) return;
        var neg = REG_NEG.test(cl) || /^\s*NO\b/.test(cl), afirma = afirmaDe(cl);
        if (/\bAPP\b|PERSONALES|\bPACIENTE\b/.test(cl)) familia = false;
        if (REG_FAMILIAR.test(cl) && !neg) familia = true;
        if (i > 0 && afirma && !neg) negando = false;
        lista.forEach(function (c) {
          if (!c[1].test(cl) || (x.dx && c[2])) return;
          if (neg || negPost[i] || familia || (negando && !afirma)) return;
          out[c[0]] = 1;
        });
      });
    });
  });
  return out;
}
/** Índice de Charlson SIMPLIFICADO (24 nov 2026) desde las banderas de texto (`com`: REG_COMORB; `ext`: REG_COMORB_1124).
 *  Pesos de Charlson 1987; lo que el texto no separa se simplifica: «Cardiopatía» vale 1 (no distingue infarto de
 *  insuficiencia cardiaca: máximo 1 de los 2 posibles), ERC vale 2 (no se sabe si es moderada o grave), VIH / SIDA vale 6
 *  (no distingue VIH sin SIDA). Sin APP no es calculable (vacío, no 0). Ajustado por edad: +1 por década desde los 50
 *  (máximo +4). Función pura. */
function regCharlson_(com, ext, edad, hayApp) {
  if (!hayApp) return { puntos: '', conEdad: '', calculable: 0 };
  var s = function (o, k) { return o && o[k] === 1; };
  var p = (s(com, 'Cardiopatía') ? 1 : 0) + (s(ext, 'Enfermedad vascular periférica') ? 1 : 0) + (s(ext, 'EVC') ? 1 : 0) + (s(ext, 'Demencia') ? 1 : 0) + (s(com, 'EPOC / asma') ? 1 : 0)
    + (s(ext, 'Enfermedad del tejido conectivo') ? 1 : 0) + (s(ext, 'Úlcera péptica') ? 1 : 0) + (s(ext, 'Hepatopatía grave') ? 3 : (s(com, 'Cirrosis / hepatopatía crónica') ? 1 : 0))
    + (s(ext, 'Diabetes con daño a órgano blanco') ? 2 : (s(com, 'Diabetes') ? 1 : 0)) + (s(ext, 'Hemiplejía') ? 2 : 0) + (s(com, 'Enfermedad renal crónica') ? 2 : 0)
    + (s(ext, 'Metástasis') ? 6 : (s(com, 'Cáncer') || s(ext, 'Leucemia / linfoma') ? 2 : 0)) + (s(ext, 'VIH / SIDA') ? 6 : 0);
  var e = typeof edad === 'number' ? (edad >= 80 ? 4 : edad >= 70 ? 3 : edad >= 60 ? 2 : edad >= 50 ? 1 : 0) : '';
  return { puntos: p, conEdad: e === '' ? '' : p + e, calculable: 1 };
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
var REG_EP_NUEVAS_1124 = ['Unión (fuente)', 'Cirugías sin fecha (n)', 'Reintervención planeada (probable)', 'Reintervención no planeada (probable)', 'Estancia posoperatoria (días)',
  'Cirugía en ≤1 día del ingreso', 'Defunción posoperatoria (hospitalaria)'];
// 24 nov 2026: desde «Movimientos y estado» (auditoría del censo). Al final, después de las anteriores.
var REG_EP_MOV = ['Cambios de cama (n)', 'Pasó por UCI', 'Días en UCI', 'Peor estado clínico', 'Fecha del primer GRAVE', 'Fecha de ingreso (estimada)', 'Fecha de ingreso (fuente)', 'Hora de egreso del censo'];
// 24 nov 2026 (lote C): variables derivadas, al final. Días OBSERVADOS desde «Estado diario», «Dispositivos», «Drenajes ·
// diario» y el historial de auditoría; lesión renal y laboratorio; cultivos; Charlson simplificado y riesgo preoperatorio.
var REG_EP_DIARIO = ['Días con antibiótico (observados)', 'Primer día ATB', 'Último día ATB', 'Antibióticos distintos (n)', 'Carbapenémico', 'Días en ayuno', 'Ayuno posoperatorio (días)',
  'Día posoperatorio de inicio de dieta', 'Días con NPT', 'NPT % máximo', 'Ayuno >5 días sin NPT', 'Días con ventilación', 'Días con vasopresor', 'Días con tromboprofilaxis', 'Dispositivos (n)',
  'Días con drenaje', 'Gasto máximo (mL)', 'Sonda endopleural', 'Estoma', 'Terapia de presión negativa', 'Cobertura del diario (%)'];
var REG_EP_LAB = ['Creatinina basal (mg/dL)', 'LRA KDIGO (estadio máx.)', 'LRA posoperatoria', 'Fecha de LRA', 'Hb inicial (g/dL)', 'Hb preoperatoria (g/dL)', 'Caída máxima de Hb (g/dL)',
  'Anemia al ingreso (OMS)', 'Hipoalbuminemia (<3.5)', 'Albúmina <3.0', 'Leucocitos iniciales (k/µL)', 'Plaquetas iniciales (k/µL)', 'Sodio inicial (mmol/L)', 'PCR día 3-4 posoperatorio (mg/L)', 'Glucosa >180 (días)'];
var REG_EP_CULT = ['ISQ probable (cultivo)', 'ISQ mencionada (texto)', 'Bacteriemia', 'Urocultivo positivo ≥ día 3', 'Germen multirresistente'];
var REG_EP_RIESGO = REG_COMORB_1124.map(function (c) { return c[0]; }).concat(['Charlson (puntos)', 'Charlson ajustado por edad', 'Charlson (calculable)', 'Riesgo preoperatorio simple (0-6)']);
var REG_EP_LOTE_C = REG_EP_DIARIO.concat(REG_EP_LAB).concat(REG_EP_CULT).concat(REG_EP_RIESGO);
var REG_EP_LOTE_C_TEXTO = ['Primer día ATB', 'Último día ATB', 'Fecha de LRA'];
var REG_EP_LOTE_C_DECIMALES = ['NPT % máximo', 'Gasto máximo (mL)', 'Cobertura del diario (%)', 'Creatinina basal (mg/dL)', 'Hb inicial (g/dL)', 'Hb preoperatoria (g/dL)', 'Caída máxima de Hb (g/dL)',
  'Leucocitos iniciales (k/µL)', 'Plaquetas iniciales (k/µL)', 'Sodio inicial (mmol/L)', 'PCR día 3-4 posoperatorio (mg/L)'];
// 24 nov 2026 (lote C, 2.ª parte): columnas de apoyo (tipo de egreso probable, reingreso, edad calculada, periodo de
// captura) y eventos adversos (Clavien-Dindo mínimo inferido). Al final de «Análisis · Episodios».
var REG_EP_APOYO = ['Tipo de egreso (probable)', 'Fuente del tipo', 'Desenlace conocido', 'Días al reingreso', 'Dx principal del reingreso', 'Reingreso planeado (probable)',
  'Reingreso no planeado a 30 días', 'Reingreso con cirugía', 'Seguimiento posalta observable (días)', 'Edad al ingreso (calculada)', 'Periodo de captura'];
var REG_EP_EVENTOS = ['Clavien-Dindo mínimo inferido', 'Complicación mayor inferida (≥ IIIa)', 'Eventos adversos (n)', 'Clavien (fuente)'];
var REG_EP_LOTE_C2 = REG_EP_APOYO.concat(REG_EP_EVENTOS);
var REG_EP_LOTE_C2_TEXTO = ['Tipo de egreso (probable)', 'Fuente del tipo', 'Dx principal del reingreso', 'Periodo de captura', 'Clavien-Dindo mínimo inferido', 'Clavien (fuente)'];
// La captura estructurada (motivo de egreso obligatorio, caja Cirugías con urgencia / abordaje / Clavien-Dindo, dx
// principal) entró a la app el 27 y 28 oct 2026: lo que egresó antes no pudo tener esos datos.
var REG_CAPTURA_ESTRUCTURADA = '2026-10-28';
var REG_SEGUIMIENTO_MAX = 30;      // «Seguimiento posalta observable» se topa aquí (así las filas viejas no cambian cada noche)
var REG_AN_EVENTOS = 'Eventos adversos', REG_AN_ATB = 'Análisis · Antibióticos', REG_AN_COMPLETITUD = 'Completitud', REG_AN_FLUJO = 'Flujo de la cohorte', REG_AN_INDICADORES = 'Indicadores de calidad';
var REG_CERTEZA_OBJ = 'Objetivo', REG_CERTEZA_TXT = 'Mención en texto', REG_CERTEZA_PROB = 'Probable (por fechas)', REG_SIN_EVENTO = 'Sin evento detectado';
// Eventos que pueden repetirse en un episodio: su «Ocurrencia» es la fecha; los demás son únicos por episodio.
var REG_EVENTOS_MULTIPLES = ['Reintervención no planeada', 'Drenaje percutáneo'], REG_EVENTO_UNICO = 'única', REG_EVENTO_SIN_FECHA = 'sin fecha';
var REG_EVENTOS_COLUMNAS = ['ID episodio', 'ID paciente', 'Evento', 'Ocurrencia', 'Fecha', 'Día posoperatorio', 'Detalle', 'Fuente', 'Certeza', 'Grado Clavien mínimo implícito', 'Revisado', 'Vigente'];
var REG_ATB_AN_COLUMNAS = ['ID episodio', 'ID paciente', 'Antibiótico', 'Clase', 'AWaRe', 'Inicio', 'Inicio estimado', 'Fin', 'Días de tratamiento', 'Sigue al egreso', 'Cultivo previo o ≤24 h',
  'Germen aislado', 'Concordante con antibiograma', 'Días desde la última cirugía', 'Fuente', 'Vigente'];
var REG_COMPLETITUD_COLUMNAS = ['Mes de ingreso', 'Variable', 'Con dato (n)', 'Aplicables (n)', 'Completitud (%)', 'Vigente'];
var REG_FLUJO_COLUMNAS = ['Orden', 'Paso', 'Episodios (n)', 'Vigente'];
var REG_INDICADORES_COLUMNAS = ['Periodo', 'Indicador', 'Estrato', 'Numerador', 'Denominador', 'Tasa (%)', 'IC95 inferior', 'IC95 superior', 'Valor', 'Unidad', 'Excluidos por dato faltante (n)',
  'Definición', 'Vigente'];
var REG_INDICADOR_MIN = 10;        // sin tasa (ni mediana ni razón) con menos de 10 en el denominador: solo n / N
function regEpisodiosColumnas_() {
  return ['ID episodio', 'ID paciente', 'Partes del registro', 'N.º de episodio del paciente', 'Días desde el egreso previo', 'Es reingreso (≤30 días)', 'Reingreso a 30 días',
    'Edad (años)', 'Sexo', 'Sexo (fuente)', 'Especialidad', 'Sección', 'Fecha de ingreso', 'Fecha de egreso', 'Días de estancia', 'Estado', 'Egreso observado', 'Tipo de egreso',
    'Defunción', 'Motivo de egreso (app)', 'Excluir (duplicado)', 'Diagnóstico', 'Dx principal', 'CIE-10 (grupo)', 'Dx principal (fuente)', 'Peso (kg)', 'Talla (m)', 'IMC (kg/m²)']
    .concat(REG_COMORB.map(function (c) { return c[0]; })).concat(['Comorbilidades (n)', 'Cirugías (n)', 'Primera cirugía', 'Días ingreso a 1.ª cirugía', 'Sangrado total (mL)',
    'Procedimientos', 'Grupo de la 1.ª cirugía', 'Reintervención', 'Cirugías inferidas (n)', 'Programadas sin confirmar (n)',
    'Urgencia (1.ª cirugía)', 'Abordaje (1.ª cirugía)', 'Conversión', 'Clavien-Dindo máximo', 'Complicación mayor (Clavien ≥ IIIa)', 'Cirugías sin clasificar (n)', 'Antibiótico (registrado)', 'NPT (registrada)', 'Ventilación mecánica (registrada)', 'Vasopresor (registrado)', 'Tromboprofilaxis (registrada)',
    'Fechas con labs (n)', 'Valores críticos (n)', 'Índice urinario mínimo (mL/kg/h)', 'Días con oliguria (IU < 0.5)'])
    .concat(REG_LAB_RESUMEN.map(function (r) { return r[2]; }))
    .concat(['Cultivos (n)', 'Cultivos positivos (n)', 'Gérmenes aislados', 'Calidad de datos', 'Vigente'])
    // 24 nov 2026 (al final: la hoja ya tiene datos y el orden existente no cambia).
    .concat(REG_EP_NUEVAS_1124).concat(REG_EP_MOV).concat(REG_EP_LOTE_C).concat(REG_EP_LOTE_C2);
}
var REG_EP_ENTEROS = ['Partes del registro', 'N.º de episodio del paciente', 'Días desde el egreso previo', 'Es reingreso (≤30 días)', 'Reingreso a 30 días', 'Días de estancia',
  'Egreso observado', 'Defunción', 'Excluir (duplicado)', 'Cirugías (n)', 'Días ingreso a 1.ª cirugía', 'Reintervención', 'Cirugías inferidas (n)', 'Programadas sin confirmar (n)', 'Antibiótico (registrado)', 'NPT (registrada)',
  'Ventilación mecánica (registrada)', 'Vasopresor (registrado)', 'Tromboprofilaxis (registrada)', 'Fechas con labs (n)', 'Valores críticos (n)', 'Cultivos (n)', 'Cultivos positivos (n)',
  'Comorbilidades (n)', 'Días con oliguria (IU < 0.5)', 'Urgencia (1.ª cirugía)', 'Conversión', 'Complicación mayor (Clavien ≥ IIIa)', 'Cirugías sin clasificar (n)'].concat(REG_COMORB.map(function (c) { return c[0]; })).concat(REG_EP_NUEVAS_1124.slice(1)).concat(REG_EP_MOV.slice(0, 3))
  .concat(REG_EP_LOTE_C.filter(function (c) { return REG_EP_LOTE_C_TEXTO.indexOf(c) === -1 && REG_EP_LOTE_C_DECIMALES.indexOf(c) === -1; }))
  .concat(REG_EP_LOTE_C2.filter(function (c) { return REG_EP_LOTE_C2_TEXTO.indexOf(c) === -1; }));
function regFormatos_(enteros, decimales) {
  var f = {};
  enteros.forEach(function (c) { f[c] = REG_FMT_ENT; });
  decimales.forEach(function (c) { f[c] = REG_FMT_DEC; });
  return f;
}
var REG_ANALISIS = [
  { nombre: REG_AN_EPISODIOS, modo: 'derivada', clave: ['ID episodio'], columnas: regEpisodiosColumnas_(),
    formatos: regFormatos_(REG_EP_ENTEROS, ['Edad (años)', 'Sangrado total (mL)', 'Peso (kg)', 'Talla (m)', 'IMC (kg/m²)', 'Índice urinario mínimo (mL/kg/h)'].concat(REG_LAB_RESUMEN.map(function (r) { return r[2]; })).concat(REG_EP_LOTE_C_DECIMALES)) },
  { nombre: REG_AN_LABS, modo: 'derivada', clave: ['ID episodio', 'Fecha'],
    columnas: ['ID episodio', 'ID paciente', 'Fecha', 'Día de estancia', 'Fuente'].concat(REG_LAB_META.map(regLabColumna)).concat(['Otros estudios', 'Valores críticos', 'Observaciones', 'Vigente']),
    formatos: regFormatos_(['Día de estancia'], REG_LAB_META.filter(function (m) { return m.t !== 'texto'; }).map(regLabColumna)) },
  { nombre: REG_AN_SIGNOS, modo: 'derivada', clave: ['ID episodio', 'Fecha'],
    columnas: ['ID episodio', 'ID paciente', 'Fecha', 'Día de estancia'].concat(REG_SV.slice(0, 5).map(function (s) { return s[1]; }))
      .concat(['TA sistólica (mmHg)', 'TA diastólica (mmHg)', 'PAM (mmHg)']).concat(REG_SV.slice(5).map(function (s) { return s[1]; })).concat(['Horas de uresis (h)', 'Índice urinario (mL/kg/h)', 'Observaciones', 'Vigente']),
    formatos: regFormatos_(['Día de estancia'], REG_SV.map(function (s) { return s[1]; }).concat(['TA sistólica (mmHg)', 'TA diastólica (mmHg)', 'PAM (mmHg)', 'Horas de uresis (h)', 'Índice urinario (mL/kg/h)'])) },
  { nombre: REG_AN_CULTIVOS, modo: 'derivada', clave: ['ID cultivo'],
    columnas: ['ID cultivo', 'ID episodio', 'ID paciente', 'Fecha de toma', 'Hora de toma', 'Día de estancia', 'Tipo', 'Muestra', 'Resultado', 'Positivo', 'Germen',
      'Sensibles', 'Intermedios', 'Resistentes', 'UFC', 'Fuente', 'Vigente'].concat(REG_CULT_NUEVAS),
    formatos: regFormatos_(['Día de estancia', 'Positivo'].concat(REG_CULT_NUEVAS.slice(1)), []) },
  // Resumen mensual: solo cuentas (sin nombres ni seudónimos).
  { nombre: REG_AN_RESUMEN, modo: 'derivada', clave: ['Mes'], columnas: REG_RESUMEN_COLUMNAS,
    formatos: regFormatos_(REG_RESUMEN_COLUMNAS.filter(function (c) { return / \(n\)$/.test(c); }), REG_RESUMEN_COLUMNAS.filter(function (c) { return /\(%\)$|\(días\)$/.test(c); })) },
  // Por completar: CON NOMBRES (para que el equipo complete la tarjeta). No se comparte.
  { nombre: REG_POR_COMPLETAR, modo: 'derivada', clave: ['ID episodio'],
    columnas: ['ID episodio', 'Estado', 'Cama', 'Nombre', 'Expediente', 'Fecha de ingreso', 'Fecha de egreso', 'Falta', 'Faltantes (n)', 'Vigente'],
    formatos: regFormatos_(['Faltantes (n)'], []) },
  // 24 nov 2026: una fila por cirugía (de la caja o inferida; no la programación sin confirmar ni las tarjetas duplicadas).
  // Sin nombre ni expediente. Va al final: si el tiempo se acaba, las pestañas que ya existían se escriben primero.
  { nombre: REG_AN_CIRUGIAS, modo: 'derivada', clave: ['ID cirugía'], columnas: REG_CX_AN_COLUMNAS,
    formatos: regFormatos_(['N.º de cirugía en el episodio', 'Día de estancia', 'Días desde la cirugía previa', 'Urgencia inferida (día 0-1)', 'Es índice', 'Reintervención planeada (probable)',
      'Reintervención no planeada (probable)', 'Días cirugía→egreso', 'Defunción en el episodio'], ['Sangrado (mL)', 'Edad (años)']) },
  // 24 nov 2026 (lote C, 2.ª parte). Sin nombres ni expedientes. «Revisado» lo llena quien valida contra el expediente:
  // el registro nunca lo pisa (conservarViejo).
  // La clave NO lleva la fecha (24 nov 2026, revisión): un evento único por episodio (vasopresor, LRA, defunción…) al que
  // se le corrige la fecha conserva su renglón y su «Revisado». «Ocurrencia» = «única», o la fecha en los que se repiten.
  { nombre: REG_AN_EVENTOS, modo: 'derivada', clave: ['ID episodio', 'Evento', 'Ocurrencia'], conservarViejo: ['Revisado'], columnas: REG_EVENTOS_COLUMNAS, formatos: regFormatos_(['Día posoperatorio'], []) },
  { nombre: REG_AN_ATB, modo: 'derivada', clave: ['ID episodio', 'Antibiótico', 'Inicio'], columnas: REG_ATB_AN_COLUMNAS,
    formatos: regFormatos_(['Días de tratamiento', 'Sigue al egreso', 'Cultivo previo o ≤24 h', 'Concordante con antibiograma', 'Días desde la última cirugía'], []) },
  // Solo cuentas (sin seudónimos): completitud por mes, flujo de la cohorte e indicadores con IC 95 %.
  { nombre: REG_AN_COMPLETITUD, modo: 'derivada', clave: ['Mes de ingreso', 'Variable'], columnas: REG_COMPLETITUD_COLUMNAS, formatos: regFormatos_(['Con dato (n)', 'Aplicables (n)'], ['Completitud (%)']) },
  { nombre: REG_AN_FLUJO, modo: 'derivada', clave: ['Paso'], columnas: REG_FLUJO_COLUMNAS, formatos: regFormatos_(['Orden', 'Episodios (n)'], []) },
  { nombre: REG_AN_INDICADORES, modo: 'derivada', clave: ['Periodo', 'Indicador', 'Estrato'], columnas: REG_INDICADORES_COLUMNAS,
    formatos: regFormatos_(['Numerador', 'Denominador', 'Excluidos por dato faltante (n)'], ['Tasa (%)', 'IC95 inferior', 'IC95 superior', 'Valor']) },
  // 25 nov 2026 (registro 2026.11.26-2): seguimiento de operados. CON NOMBRES (lista de trabajo, como «Por completar»):
  // una fila por persona que aparece en «Procedimientos del censo» o tiene cirugías en el registro. Va al final: las
  // pestañas que ya existían se escriben primero si se acaba el tiempo.
  { nombre: REG_SEGUIMIENTO, modo: 'derivada', clave: ['Expediente', 'Nombre'], columnas: REG_SEGUIMIENTO_COLUMNAS,
    formatos: regFormatos_(['Procedimientos en el censo (n)', 'Cirugías registradas (n)', 'Días desde el último procedimiento', 'Reingresos posteriores (n)'], []) }
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
// ─── Sexo inferido del nombre de pila (25 nov 2026) ─────────────────────────────────────────────────────────────────
// Pedido del dueño: «el sexo se puede inferir con el nombre». Es la TERCERA fuente, la de menor prioridad: solo cuando ni
// la tarjeta ni WinLab lo traen. Diccionario de nombres de pila frecuentes en México; NUNCA se adivina por la terminación
// (un nombre que no está en la lista da vacío). Error esperado: bajo en los que se clasifican (ante la duda, vacío); los ambiguos
// (GUADALUPE, ROSARIO…) solo se resuelven con el otro nombre de pila.
var REG_NOMBRES_M = ('AARON ABDIEL ABEL ABELARDO ABRAHAM ABUNDIO ADALBERTO ADAN ADOLFO ADRIAN AGAPITO AGUSTIN ALAN ALBERTO ALDO ALEJANDRO ALEJO ' +
  'ALFONSO ALFREDO ALONSO ALVARO AMADO AMADOR AMBROSIO ANASTACIO ANDRES ANGEL ANICETO ANSELMO ANTONIO APOLINAR ARCADIO ARIEL ' +
  'ARMANDO ARNOLDO ARNULFO ARTURO AUDENCIO AURELIO AUSENCIO AXEL BALDOMERO BALTAZAR BARTOLO BARTOLOME BENIGNO BENITO BENJAMIN BERNABE ' +
  'BERNARDINO BERNARDO BONIFACIO BRAULIO BRAYAN BRIAN BRUNO CAMILO CANDIDO CARLOS CATARINO CAYETANO CELEDONIO CELESTINO CELSO CESAR ' +
  'CHRISTIAN CIPRIANO CIRILO CLAUDIO CLEMENTE CONSTANTINO CRESCENCIO CRISOFORO CRISPIN CRISTIAN CRISTOBAL DAGOBERTO DAMIAN DANIEL DARIO ' +
  'DAVID DEMETRIO DIDIER DIEGO DIMAS DIONISIO DOMINGO EDGAR EDGARDO EDMUNDO EDUARDO EDWIN EFRAIN EFREN ELADIO ELEAZAR ELIAS ELIGIO ELISEO ' +
  'ELIUD ELPIDIO EMANUEL EMILIANO EMILIO EMMANUEL ENOC ENRIQUE EPIFANIO ERASMO ERICK ERIK ERNESTO ESTANISLAO ESTEBAN EUGENIO EULALIO ' +
  'EUSEBIO EUSTAQUIO EVARISTO EVERARDO EZEQUIEL FABIAN FACUNDO FAUSTINO FAUSTO FEDERICO FELICIANO FELIPE FELIX FERMIN FERNANDO FIDEL ' +
  'FILEMON FILIBERTO FLAVIO FLORENCIO FLORENTINO FORTINO FRANCISCO FROYLAN FRUMENCIO GABINO GABRIEL GAEL GASPAR GENARO GERARDO GERMAN ' +
  'GILBERTO GONZALO GREGORIO GUILLERMO GUSTAVO HECTOR HERIBERTO HERMENEGILDO HERMILO HERNAN HILARIO HIPOLITO HOMERO HORACIO HUGO HUMBERTO ' +
  'IGNACIO ISAAC ISAIAS ISIDRO ISMAEL ISRAEL IVAN JACINTO JACOBO JAIME JAVIER JERONIMO JESUS JOAQUIN JOEL JONATHAN JONATAN JORGE JOSE ' +
  'JOSUE JUAN JULIAN JULIO JUSTINO JUSTO JUVENAL JUVENTINO KEVIN LADISLAO LAURO LAZARO LEANDRO LEOBARDO LEON LEONARDO LEONCIO LEONEL ' +
  'LEOPOLDO LIBORIO LINO LORENZO LUCAS LUCIANO LUCIO LUIS MACARIO MAGDALENO MANUEL MARCELINO MARCELO MARCIAL MARCO MARCOS MARGARITO ' +
  'MARIANO MARIO MARTIN MATEO MATIAS MAURICIO MAURO MAXIMILIANO MAXIMINO MAXIMO MELCHOR MELQUIADES MIGUEL MISAEL MODESTO MOISES NAHUM ' +
  'NARCISO NATALIO NAZARIO NEFTALI NESTOR NICANOR NICOLAS NOE NORBERTO OCTAVIO ODILON OLEGARIO OMAR ONESIMO ORLANDO OSCAR OSVALDO ' +
  'OSWALDO PABLO PANFILO PASCUAL PATRICIO PEDRO PLACIDO PORFIRIO PRIMITIVO PRISCILIANO PRUDENCIO RAFAEL RAMIRO RAMON RAUL RAYMUNDO ' +
  'REINALDO REMIGIO RENE REYMUNDO REYNALDO RICARDO RIGOBERTO ROBERTO RODOLFO RODRIGO ROGELIO ROLANDO ROMAN ROMEO ROMUALDO RUBEN RUFINO ' +
  'SABINO SALOMON SALVADOR SAMUEL SANTIAGO SANTOS SAUL SEBASTIAN SERAFIN SERGIO SEVERIANO SEVERO SILVESTRE SIMON TEODORO TEOFILO ' +
  'TIBURCIO TIMOTEO TOMAS TRANQUILINO UBALDO ULISES URIEL VALENTIN VENANCIO VICENTE VICTOR VIRGILIO WENCESLAO WILFRIDO WILLIAM ' +
  'ZACARIAS ZEFERINO ZENON').split(' ');
var REG_NOMBRES_F = ('ABIGAIL ADELA ADELAIDA ADELINA ADRIANA AGUSTINA ALBA ALEIDA ALEJANDRA ALICIA ALMA AMALIA AMELIA AMPARO ANA ANABEL ' +
  'ANAHI ANDREA ANGELA ANGELES ANGELICA ANGELINA ANTONIA ARACELI ARCELIA ARELI ARMIDA ASUNCION AURORA AZUCENA BEATRIZ BENITA BERENICE ' +
  'BERTA BERTHA BLANCA BRENDA BRISA CANDELARIA CARMEN CAROLINA CATALINA CECILIA CELIA CELINA CINTHIA CITLALI CLARA CLAUDIA CONCEPCION ' +
  'CONSTANZA CONSUELO CORINA CRISTINA DALIA DAMARIS DANIELA DELFINA DELIA DIANA DOLORES DOMINGA DORA DULCE EDITH ELBA ELENA ELIA ELISA ' +
  'ELIZABETH ELODIA ELOISA ELSA ELVA ELVIRA EMILIA EMMA ENRIQUETA EPIFANIA ERIKA ESMERALDA ESPERANZA ESTEFANIA ESTELA ESTHER EUGENIA ' +
  'EVA EVANGELINA EVELYN FABIOLA FATIMA FAUSTINA FELIPA FERNANDA FLOR FLORENCIA FRANCISCA FRIDA GABRIELA GENOVEVA GEORGINA GLADYS GLORIA ' +
  'GRACIELA GRISELDA GUILLERMINA HERLINDA HERMELINDA HERMINIA HILDA HORTENSIA IGNACIA IMELDA INES IRENE IRIS IRMA ISABEL ISELA ITZEL ' +
  'IVETTE IVONNE JACINTA JACQUELINE JANET JANETH JAZMIN JESSICA JOSEFA JOSEFINA JOVITA JUANA JUDITH JULIA JULIETA KAREN KARINA KARLA ' +
  'KENIA LAURA LEONOR LETICIA LIBRADA LIDIA LILIA LILIANA LIZBETH LIZETH LORENA LORENZA LOURDES LUCERO LUCIA LUCINA LUISA LUZ MACRINA ' +
  'MAGALI MAGALY MAGDALENA MANUELA MARCELA MARGARITA MARIA MARIANA MARIBEL MARICELA MARINA MARISELA MARISOL MARLEN MARLENE MARTA MARTHA ' +
  'MATILDE MAYRA MELISSA MERCEDES MICAELA MINERVA MIREYA MIRIAM MIRNA MODESTA MONICA NANCY NATALIA NAYELI NELLY NICOLASA NOEMI NOHEMI ' +
  'NORA NORMA OBDULIA ODILIA OFELIA OLGA OLIVA OLIVIA OTILIA PALOMA PAOLA PASCUALA PATRICIA PAULA PAULINA PERLA PETRA PIEDAD PILAR ' +
  'PRISCILA RAFAELA RAMONA RAQUEL REBECA REFUGIA REGINA REINA REMEDIOS REYNA RITA ROBERTA ROCIO ROSA ROSALBA ROSALIA ROSALINDA ROSAURA ' +
  'ROXANA RUTH SABINA SAMANTHA SANDRA SARA SELENE SERAFINA SILVIA SIMONA SOCORRO SOFIA SOLEDAD SONIA SUSANA TANIA TEODORA TERESA ' +
  'TERESITA TOMASA VALERIA VANESSA VERONICA VICTORIA VIOLETA VIRGINIA VIVIANA XIMENA XOCHITL YADIRA YAZMIN YESENIA YESICA YOLANDA ZAIRA ' +
  'ZOILA ZULEMA').split(' ');
// Ambiguos o de nombre compuesto: deciden el otro nombre de pila (el primero manda: «MA. GUADALUPE» = F, «J. GUADALUPE» = vacío).
// ALEXIS y SALOME (25 nov 2026, revisión): en México se usan para los dos sexos.
var REG_NOMBRES_AMBIGUOS = ('GUADALUPE ROSARIO TRINIDAD REFUGIO CRUZ NATIVIDAD MERCED PAZ ASCENCION SACRAMENTO VENTURA ALEXIS SALOME').split(' ');
// Abreviaturas de nombre de pila que se escriben en el censo.
var REG_NOMBRES_ABREV = { MA: 'MARIA', GPE: 'GUADALUPE', FCO: 'FRANCISCO', FCA: 'FRANCISCA', JSE: 'JOSE', ANT: 'ANTONIO' };
// Apellidos frecuentes (lista corta): si el nombre empieza con uno que NO es nombre de pila, viene APELLIDOS primero.
var REG_APELLIDOS = ('GARCIA HERNANDEZ MARTINEZ LOPEZ GONZALEZ PEREZ RODRIGUEZ SANCHEZ RAMIREZ FLORES GOMEZ DIAZ TORRES VAZQUEZ ' +
  'VASQUEZ MORALES JIMENEZ REYES GUTIERREZ RUIZ MENDOZA AGUILAR ORTIZ CASTILLO MORENO ROMERO ALVAREZ CHAVEZ RIVERA JUAREZ RAMOS ' +
  'DOMINGUEZ HERRERA MEDINA CASTRO VARGAS GUZMAN VELAZQUEZ MUNOZ ROJAS CONTRERAS SALAZAR LUNA ORTEGA GUERRERO ESTRADA BAUTISTA CORTES ' +
  'SOTO ALVARADO ESPINOZA ESPINOSA LARA AVILA RIOS CERVANTES SILVA DELGADO VEGA MARQUEZ SANDOVAL CARRILLO MEJIA SOLIS ROSAS IBARRA ' +
  'VALDEZ NUNEZ CAMACHO NAVARRO PENA MALDONADO ROSALES ACOSTA MIRANDA TREJO VALENCIA NAVA PACHECO HUERTA PADILLA FUENTES CABRERA ' +
  'MOLINA AYALA ZAMORA CAMPOS MENDEZ BECERRA FIGUEROA OROZCO SERRANO VELASCO CARDENAS OLVERA ROBLES').split(' ');
var REG_NOMBRES_SEXO = (function () {
  var d = {};
  REG_NOMBRES_M.forEach(function (n) { d[n] = 'M'; });
  REG_NOMBRES_F.forEach(function (n) { d[n] = 'F'; });
  REG_NOMBRES_AMBIGUOS.forEach(function (n) { d[n] = '?'; });
  return d;
})();
var REG_APELLIDO = (function () { var d = {}; REG_APELLIDOS.forEach(function (n) { d[n] = true; }); return d; })();
/** Sexo inferido del nombre de pila: 'M', 'F' o '' (no concluyente). Regla: el primer nombre de pila manda; si es ambiguo
 *  (GUADALUPE, ROSARIO…) decide el siguiente nombre de pila; inicial suelta («J.»), nombre fuera de la lista, sin nombre
 *  (DESCONOCIDO, RN…) o el orden no es claro: vacío. NO adivina por la terminación.
 *  Revisión del 25 nov 2026 (el censo escribe los APELLIDOS primero):
 *  · Se saltan los apellidos frecuentes que no son nombre de pila y los apellidos con partícula («DE LEON», «DE LA CRUZ»,
 *    «DE LOS SANTOS», «DEL ANGEL»), salvo justo después de MARIA, JOSE o JUAN («MARIA DE JESUS», «JUAN DE LA CRUZ»), donde
 *    son parte del nombre de pila y no deciden nada.
 *  · Una inicial después de los apellidos solo se salta si le precede UN solo apellido («PEREZ N JUAN») y lo que sigue
 *    no es MARIA, JOSE ni un ambiguo («GARCIA J. MARIA» puede ser José María). Con dos apellidos antes («PEREZ
 *    HERNANDEZ M. JOSE») la inicial es el primer nombre: vacío.
 *  · Si después del nombre elegido aparece un nombre de pila del OTRO sexo, el orden no es claro («LOPEZ SANTIAGO
 *    MARIA»: SANTIAGO puede ser apellido) → vacío. Única excepción: el compuesto MARIA/JOSE + nombre del otro sexo
 *    inmediato («MARIA JOSE», «JOSE MARIA»), donde manda el primero. */
var REG_NOMBRE_CON_PARTICULA = { MARIA: 1, JOSE: 1, JUAN: 1 };
function regSexoDeNombre(nombre) {
  var raw = regTexto(nombre).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z.\s]/g, ' ').replace(/\./g, ' ').split(/\s+/)
    .filter(function (w) { return w && w !== 'Y'; })
    .map(function (w) { return REG_NOMBRES_ABREV[w] || w; });
  if (!raw.length || raw.some(function (w) { return REG_SIN_NOMBRE.test(w); })) return '';
  // Unidades: palabra suelta {w, t:'w'} o bloque con partícula («DE LA CRUZ»): {t:'ap'} apellido / {t:'nb'} parte del nombre.
  var u = [];
  for (var k = 0; k < raw.length; k++) {
    if (!REG_PARTICULAS[raw[k]]) { u.push({ w: raw[k], t: 'w' }); continue; }
    while (k + 1 < raw.length && REG_PARTICULAS[raw[k + 1]]) k++;
    if (k + 1 < raw.length) k++;                                  // la palabra que sigue a la partícula va en el bloque
    var prev = u[u.length - 1];
    u.push({ w: '', t: prev && prev.t === 'w' && REG_NOMBRE_CON_PARTICULA[prev.w] ? 'nb' : 'ap' });
  }
  var sexoDe = function (x) { return x && x.t === 'w' ? REG_NOMBRES_SEXO[x.w] : undefined; };
  var i = 0, nAp = 0;
  // APELLIDOS primero: se saltan los apellidos frecuentes, los de partícula y, con un solo apellido antes, su inicial.
  while (i < u.length) {
    var x = u[i];
    if (x.t === 'ap' || (REG_APELLIDO[x.w] && !REG_NOMBRES_SEXO[x.w])) { nAp++; i++; continue; }
    if (i > 0 && x.t === 'w' && x.w.length === 1) {
      if (nAp !== 1) return '';
      var sig = u[i + 1];
      if (!sig || sig.w === 'MARIA' || sig.w === 'JOSE' || sexoDe(sig) === '?') return '';
      i++; continue;
    }
    break;
  }
  if (i >= u.length || u[i].t !== 'w' || u[i].w.length === 1) return '';
  var s = sexoDe(u[i]), desde = i + 1;
  if (!s) return '';
  if (s === '?') {
    s = sexoDe(u[i + 1]);
    if (s !== 'M' && s !== 'F') return '';
    desde = i + 2;
  } else if ((u[i].w === 'MARIA' || u[i].w === 'JOSE') && (sexoDe(u[i + 1]) === 'M' || sexoDe(u[i + 1]) === 'F')) {
    desde = i + 2;                                                // compuesto MARIA JOSE / JOSE MARIA: manda el primero
  }
  // Orden dudoso: un nombre de pila del otro sexo más adelante → vacío.
  for (var j = desde; j < u.length; j++) {
    var o = sexoDe(u[j]);
    if ((o === 'M' || o === 'F') && o !== s) return '';
  }
  return s;
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
/** Etiqueta del motivo REGISTRADO en la copia (note_data._egreso_tipo), con su fuente: «… (registrado en la app)» si lo
 *  eligió una persona; 25 nov 2026: «… (censo: sección ALTAS)» o «… (censo: sección DEFUNCIONES)» si lo tomó el script
 *  del censo de esa sección de la hoja (_egreso_tipo_por = 'Censo (hoja · ALTAS)' / 'Censo (hoja · DEFUNCIONES)').
 *  Las dos son motivo registrado (no inferido): cuentan igual para la mortalidad. '' si no hay motivo válido. */
function regEgresoElegido_(nd0) {
  nd0 = regObj(nd0);
  var t = REG_EGRESO_APP[regTexto(nd0._egreso_tipo)];
  if (!t) return '';
  var por = regTexto(nd0._egreso_tipo_por);
  if (/^Censo \(hoja/.test(por)) {
    var sec = por.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t + (/DEFUNCI/.test(sec) ? ' (censo: sección DEFUNCIONES)' : (/ALTA/.test(sec) ? ' (censo: sección ALTAS)' : ' (censo)'));
  }
  return t + ' (registrado en la app)';
}
// Sufijo de la fuente de un motivo registrado (se quita antes de clasificar: «(censo: sección DEFUNCIONES)» no debe volver
// defunción a una contrarreferencia).
var REG_EGRESO_SUFIJO = /\s*\((REGISTRADO EN LA APP|CENSO(: SECCI[OÓ]N [A-Z]+)?)\)\s*$/i;
/** Fuente del motivo registrado según su etiqueta: 'censo-altas', 'censo-defunciones', 'censo', 'app' o ''. */
function regEgresoFuente_(motivo) {
  var m = REG_EGRESO_SUFIJO.exec(regTexto(motivo));
  if (!m) return '';
  var x = m[1].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return x === 'REGISTRADO EN LA APP' ? 'app' : (/DEFUNCIONES/.test(x) ? 'censo-defunciones' : (/ALTAS/.test(x) ? 'censo-altas' : 'censo'));
}
function regEgresoTipo(motivo, estado) {
  var m = regTexto(motivo).replace(REG_EGRESO_SUFIJO, '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  var s = m + ' ' + regTexto(estado).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/DUPLICADO/.test(m)) return 'Duplicado (no es otro episodio)';
  if (/BORRADO EN BD/.test(m)) return 'Borrado en la base (revisar)';
  // Copia de un iPad de alguien que ya no estaba en el censo (30 oct 2026): su episodio real es otro. También las filas que
  // corridas anteriores ya escribieron con el id de cada copia («archivo-…»).
  if (/CAMBIOS DE ESTE IPAD/.test(m) && REG_RESCATE_SIN_EPISODIO.test(m)) return 'Duplicado (no es otro episodio)';
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
  if (regEgresoFuente_(motivo)) return 4;   // lo eligió una persona (Papelera o al dar de alta) o la sección ALTAS/DEFUNCIONES del censo: manda
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
  // 24 nov 2026: procedimientos de las otras especialidades del piso (NCX, URO, CT, CV, CPR, CMF). Van DESPUÉS de los
  // anteriores para que ningún texto que ya tenía grupo cambie; solo «Laparoscopia» (genérico) queda detrás.
  ['Neurocirugía (cráneo)', /CRANEOTOM|CRANIOTOM|CRANIECTOM|CRANEOPLAST|CRANIOPLAST|TREPANO|TREPANACION|VENTRICULOSTOM|DERIVACION VENTRICULO|\bDVP\b|\bDVE\b|CLIPAJE|EVACUACION DE HEMATOMA/],
  ['Neurocirugía (columna)', /LAMINECTOM|LAMINOTOM|DISCECTOM|DISCOIDECTOM|ARTRODESIS|INSTRUMENTACION (DE COLUMNA|VERTEBRAL|LUMBAR|CERVICAL|TORACICA|TORACOLUMBAR)|FIJACION (DE COLUMNA|VERTEBRAL|TRANSPEDICULAR)/],
  ['Urología', /NEFRECTOM|NEFROSTOM|NEFROLITOTOM|URETEROSCOP|URETEROLITOTOM|LITOTRIPSIA|CISTOSCOP|CISTOSTOM|\bCISTECTOM|PROSTATECTOM|\bRTUP\b|\bRTUV\b|RESECCION TRANSURETRAL|ORQUIECTOM|ORQUIDOPEX|PIELOPLAST|CATETER (DOBLE J|JJ)|URETROPLAST|URETROTOM|VARICOCELECTOM|HIDROCELECTOM|CIRCUNCISION/],
  ['Cirugía de tórax', /TIMECTOM|NEUMONECTOM|BULECTOM|PLEURODESIS|PLEURECTOM|VENTANA TORACICA|\bVATS\b|RESECCION PULMONAR|SEGMENTECTOMIA PULMONAR/],
  ['Cirugía cardiovascular', /ESTERNOTOM|REVASCULARIZACION (CORONARIA|MIOCARDICA)|\bCABG\b|(CAMBIO|RECAMBIO|REEMPLAZO|PLASTIA|PROTESIS) VALVULAR|VALVULOPLAST|MARCAPASO|VENTANA PERICARDICA|PERICARDIECTOM|PERICARDIOCENTESIS|CIERRE DE (CIA|CIV|PCA)\b|ENDARTERECTOM|ANEURISMECTOM|EXCLUSION DE ANEURISMA|\bEVAR\b|FISTULA ARTERIOVENOSA|\bFAVI\b|SAFENECTOM/],
  ['Cirugía plástica y reconstructiva', /INJERTO (DE PIEL|CUTANEO)|APLICACION DE INJERTO|COLGAJO|ESCARECTOM|ESCAROTOM|MAMOPLAST|RECONSTRUCCION MAMARIA|RINOPLAST|BLEFAROPLAST|ABDOMINOPLAST|DERMOLIPECTOM|ZETAPLAST|Z-?PLASTIA|TENORRAF|NEURORRAF/],
  ['Cirugía maxilofacial', /MAXILOFACIAL|FRACTURA (DE )?(LA )?(MANDIBULA|MANDIBULAR|MAXILAR|MALAR|CIGOMATIC[OA]|ORBITA|ORBITARIA|NASAL)|(FIJACION|BLOQUEO) INTERMAXILAR|OSTEOSINTESIS (DE )?(LA )?(MANDIBULA|MANDIBULAR|MAXILAR|FACIAL|MALAR|CIGOMATIC[OA])|MANDIBULECTOM|MAXILECTOM|TEMPOROMANDIBULAR|ORTOGNATIC/],
  ['Laparoscopia', /LAPAROSCOP/]
];
var REG_CX_NO_ESPECIFICADA = 'Cirugía (procedimiento no especificado)';
// 24 nov 2026 (revisión): procedimientos menores que no son la cirugía índice ni una reintervención, y el texto que SÍ
// dice reintervención (con él, o con el grupo «Relaparotomía», el evento lleva grado IIIb; sin él queda para revisar).
var REG_CX_MENOR_GRUPOS = ['Endoscopia / CPRE', 'Traqueostomía'];
var REG_CX_MENOR_TXT = /\bCPRE\b|ENDOSCOP|COLONOSCOP|BRONCOSCOP|CISTOSCOP|TRAQUEOSTOM|GASTROSTOMIA (ENDOSCOPICA|PERCUTANEA)|\bPEG\b|(COLOCACION|RETIRO|RECAMBIO|CAMBIO) DE (CATETER|SONDA|PUERTO|MAHURKAR|DOBLE J|JJ)|\bCVC\b|CATETER (VENOSO|CENTRAL|DOBLE J|JJ|MAHURKAR|TENCKHOFF)|PUNCION|PARACENTESIS|TORACOCENTESIS|PERCUTANE|\bBIOPSIA (HEPATICA|RENAL|PERCUTANEA|POR ASPIRACION)/;
var REG_CX_REINT_TEXTO = /REINTERVEN|REEXPLORA|RE-?OPERA|RELAPAROTOM|\bRE ?LAPE\b|COMPLICACION|DEHISCENCIA|EVISCERA|\bFUGA\b|HEMOSTASIA|HEMOPERITONEO|SANGRADO|EMPAQUETAMIENTO|DESEMPAQUETAMIENTO|ABSCESO|PERITONITIS|NECROSIS/;
function regCxMenor_(c) {
  var t = regNorm_(c && c.proc);
  if (REG_CX_MENOR_GRUPOS.indexOf(c && c.grupo) !== -1 || (/\bCPRE\b/.test(t) && c.grupo === 'Anorrectal')) return true;   // «CPRE + ESFINTEROTOMIA» es endoscópica
  // Una cirugía mayor acompañada de un procedimiento menor («COLECISTECTOMIA + CPRE») no es menor.
  return REG_CX_MENOR_TXT.test(t) && !(c.grupo && c.grupo !== 'Otro' && c.grupo !== REG_CX_NO_ESPECIFICADA);
}
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
    var grupo = regCxGrupo(s);
    var marca = /\b(PO|POP|P\.\s?O\.?|POSTOPERAD[OA]|POSTQUIRURGIC[OA]|POST ?QX|PQX|S\/P|OPERAD[OA])\b/.test(s);
    // 24 nov 2026: con marca de postoperado y un procedimiento que no está en la tabla se conserva como «Otro» (antes se
    // perdía la cirugía). Sin marca sigue haciendo falta un grupo reconocido (una fecha sola no dice que se operó).
    if (!grupo) { if (!marca) return; grupo = 'Otro'; }
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
    // 24 nov 2026: id de la cirugía y de sus fotos solo cuántas hay y quién y cuándo subió la última (ni imagen ni ruta).
    var fotos = regArr(c.fotos).filter(function (f) { return f && typeof f === 'object'; });
    var ultimaFoto = fotos.slice().sort(function (x, y) { return regTexto(x.ts).localeCompare(regTexto(y.ts)); }).pop() || {};
    out.push({ id: regTexto(c.id).trim(), fotos: fotos.length, fotoPor: regTexto(ultimaFoto.by), fotoTs: regTexto(ultimaFoto.ts),
      fecha: regFecha(c.fecha) || regTexto(c.fecha), proc: regTexto(c.procedimiento), hallazgos: regTexto(c.hallazgos), sangrado: regTexto(c.sangrado), cirujano: regTexto(c.cirujano),
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
// Reintervención PLANEADA (24 nov 2026), por el texto del procedimiento de la 2.ª cirugía en adelante: segundo tiempo,
// second look, cierre de pared o diferido, recambio, lavado programado, VAC. Es texto libre: «probable».
var REG_CX_REINT_PLANEADA = /SEGUNDO TIEMPO|2DO\.? TIEMPO|SECOND LOOK|SEGUNDA MIRADA|CIERRE (DE PARED|DIFERIDO)|RECAMBIO|LAVADO PROGRAMADO|\bVAC\b/;
function regNumCelda(n) { return typeof n === 'number' && isFinite(n) ? n : ''; }
function regRedondear(n, d) { var f = Math.pow(10, d); return Math.round(n * f) / f; }

/** Columnas REG_EP_MOV de un episodio desde «Movimientos y estado» (24 nov 2026). `partes`: [{ movs, fila }] de cada id del
 *  episodio (movs = sus filas de la pestaña; fila = la de Pacientes), en orden. Todo queda VACÍO si el episodio no tiene
 *  ningún movimiento copiado (la auditoría empieza el 14 oct 2026 y la base la purga a los 180 días): vacío no es 0.
 *  Días en UCI = suma, por tramo en cama o sección de UCI, de (fecha de salida − fecha de entrada); el tramo abierto
 *  termina en `fin` (egreso, hoy o último día visto). Función pura. */
function regMovEpisodio_(partes, ingreso, fin) {
  var out = {}, evs = [], n = 0;
  REG_EP_MOV.forEach(function (c) { out[c] = ''; });
  out['Fecha de ingreso (estimada)'] = ingreso || ''; out['Fecha de ingreso (fuente)'] = ingreso ? 'Tarjeta' : '';
  partes.forEach(function (p, i) {
    regArr(p.movs).forEach(function (r) {
      var t = Date.parse(regTexto(r['Fecha y hora']).replace(' ', 'T'));
      if (isNaN(t)) return;
      evs.push({ t: t, id: +r['ID'] || 0, parte: i, op: regTexto(r['Operación']), campo: regTexto(r['Campo']), de: regTexto(r['De']).trim(), a: regTexto(r['A']).trim(), local: new Date(t + REG_UTC_OFFSET_MIN * 60000).toISOString() });
    });
  });
  var enUciHoy = partes.some(function (p) { var f = p.fila || {}; return regEsUci_(regValorCenso_('cama', f['Cama']), regValorCenso_('seccion', f['Sección'])); });
  // Sin movimientos copiados todo queda vacío, salvo la evidencia positiva de la tarjeta: hoy está en UCI.
  if (!evs.length) { if (enUciHoy) out['Pasó por UCI'] = 1; return out; }
  evs.sort(function (x, y) { return x.t - y.t || x.id - y.id; });
  var valido = function (v) { return v && v !== REG_NO_VALIDO; };
  // Alta en el censo de la PRIMERA parte: fecha de ingreso estimada solo si la tarjeta no la trae.
  var alta = evs.filter(function (e) { return e.op === 'Alta en censo' && e.parte === 0; })[0];
  if (!ingreso && alta) { out['Fecha de ingreso (estimada)'] = alta.local.slice(0, 10); out['Fecha de ingreso (fuente)'] = 'Alta en el censo (auditoría)'; }
  // Baja del censo de la ÚLTIMA parte (la más reciente si hay varias).
  var bajas = evs.filter(function (e) { return e.op === 'Baja del censo' && e.parte === partes.length - 1; });
  if (bajas.length) out['Hora de egreso del censo'] = bajas[bajas.length - 1].local.slice(0, 16).replace('T', ' ');
  // Cama y sección en el tiempo. El estado inicial es el «De» del primer cambio (o la cama del alta en el censo).
  var cama = '', seccion = '', desdeUci = '', dias = 0, uci = false, peor = 0, grave = '';
  var primero = function (campo) { var e = evs.filter(function (x) { return x.campo === campo && x.op !== 'Baja del censo'; })[0]; return e ? (e.op === 'Cambio' ? e.de : e.a) : ''; };
  cama = valido(primero('Cama')) ? primero('Cama') : ''; seccion = valido(primero('Sección')) ? primero('Sección') : '';
  var marcar = function (fecha) {
    var en = regEsUci_(cama, seccion);
    if (en && !desdeUci) { desdeUci = fecha; uci = true; }
    else if (!en && desdeUci) { var d = regDiasSigno(desdeUci, fecha); if (d !== '' && d > 0) dias += d; desdeUci = ''; }
  };
  var estado = function (v, fecha) {
    var w = REG_ESTADO_PESO[v] || 0;
    if (w > peor) peor = w;
    if (w >= 3 && fecha && (!grave || fecha < grave)) grave = fecha;
  };
  marcar(evs[0].local.slice(0, 10));
  evs.forEach(function (e) {
    var fecha = e.local.slice(0, 10);
    if (e.campo === 'Cama' && e.op === 'Cambio') { if (valido(e.de) && valido(e.a) && e.de !== e.a) n++; if (valido(e.a)) cama = e.a; }
    else if (e.campo === 'Cama' && e.op === 'Alta en censo') { if (valido(e.a)) cama = e.a; }
    else if (e.op === 'Baja del censo') { cama = ''; seccion = ''; }   // salió del censo: se cierra el tramo de UCI
    else if (e.campo === 'Sección' && e.op === 'Cambio') seccion = valido(e.a) ? e.a : '';
    else if (e.campo === 'Estado clínico' && e.op === 'Cambio') { estado(e.de, ''); estado(e.a, fecha); }
    marcar(fecha);
  });
  if (desdeUci) { var d = regDiasSigno(desdeUci, fin); if (d !== '' && d > 0) dias += d; }
  // Lo que la tarjeta dice hoy también cuenta (un episodio que entró GRAVE o a UCI y nunca cambió no tiene «Cambio»).
  if (enUciHoy) uci = true;
  partes.forEach(function (p) { estado(regValorCenso_('estado', (p.fila || {})['Estado clínico']), ''); });
  out['Cambios de cama (n)'] = n; out['Pasó por UCI'] = uci ? 1 : 0; out['Días en UCI'] = uci ? dias : 0;
  out['Peor estado clínico'] = Object.keys(REG_ESTADO_PESO).filter(function (k) { return REG_ESTADO_PESO[k] === peor; })[0] || '';
  out['Fecha del primer GRAVE'] = grave;
  return out;
}

// ─── Variables derivadas del lote C (24 nov 2026): días observados, laboratorio, cultivos ─────────────────────────
/** Fecha ISO más `n` días (n puede ser negativo); '' si la fecha no es válida. */
function regFechaMas_(f, n) {
  f = regFecha(f);
  if (!f) return '';
  return new Date(Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
}
/** Fechas en que una exposición (antibiótico, ayuno, NPT…) estuvo prendida. `foto`: { fecha: true | false } de las noches
 *  fotografiadas en «Estado diario» (mandan: es lo que la tarjeta decía esa noche). `eventos`: cambios de la casilla en
 *  el historial de auditoría, en orden ([{ fecha, a: 'Sí' | 'No' }]); SOLO llenan las noches sin foto: de la fecha en
 *  que se prendió a la víspera de la fecha en que se apagó (la noche del apagado ya no estaba prendida); lo que sigue
 *  prendido termina en `hasta` (última noche del episodio). Un apagado sin su prendido (anterior a la auditoría) no
 *  agrega nada. Nunca antes de `desde`. Devuelve las fechas ordenadas. Función pura. */
function regDiasExpuesto_(foto, eventos, desde, hasta) {
  var set = {}, abierto = '';
  Object.keys(foto || {}).forEach(function (f) { if (foto[f]) set[f] = true; });
  var rango = function (a, b) {
    if (desde && a < desde) a = desde;
    for (var f = a, k = 0; f && b && f <= b && k < 400; f = regFechaMas_(f, 1), k++) if (!foto || foto[f] === undefined) set[f] = true;
  };
  regArr(eventos).forEach(function (e) {
    if (e.a === 'Sí') { if (!abierto) abierto = e.fecha; }
    else if (e.a === 'No' && abierto) { rango(abierto, regFechaMas_(e.fecha, -1)); abierto = ''; }
  });
  if (abierto && hasta) rango(abierto, hasta);
  return Object.keys(set).sort();
}
// Dispositivos que cuentan como DRENAJE (para «Días con drenaje» y «Gasto máximo»): por grupo, o el tipo dice «DREN…».
var REG_DISP_DRENAJE = ['Sonda pleural', 'Drenaje biliar', 'Penrose', 'Drenovac / Hemovac', 'Blake / Jackson-Pratt', 'Saratoga'];
function regEsDrenaje_(tipo, grupo) { return REG_DISP_DRENAJE.indexOf(regTexto(grupo) || regDispGrupo(tipo)) !== -1 || /\bDREN/.test(regNorm_(tipo)); }
/** Columnas REG_EP_DIARIO de un episodio. o = { noches (filas de «Estado diario» de sus partes), soporte (filas de
 *  «Soporte y exposiciones (historial)»), disp («Dispositivos»), dren («Drenajes · diario»), ingreso, ultimaNoche (última
 *  noche en que estuvo hospitalizado), estancia (días), cx1 (fecha de la primera cirugía con fecha) }.
 *  VACÍO = sin dato (el episodio no tiene noches fotografiadas ni cambios de esa casilla en la auditoría): vacío no es 0.
 *  Función pura. */
function regDiarioEpisodio_(o) {
  var out = {}, noches = {}, fechas = [], evs = {};
  REG_EP_DIARIO.forEach(function (c) { out[c] = ''; });
  regArr(o.noches).forEach(function (r) { var f = regFecha(r && r['Fecha']); if (!f) return; if (!noches[f]) fechas.push(f); noches[f] = r; });
  fechas.sort();
  regArr(o.soporte).forEach(function (r) {
    var t = Date.parse(regTexto(r && r['Fecha y hora']).replace(' ', 'T'));
    if (isNaN(t)) return;
    var v = regTexto(r['Variable']);
    (evs[v] = evs[v] || []).push({ t: t, id: +r['ID'] || 0, fecha: new Date(t + REG_UTC_OFFSET_MIN * 60000).toISOString().slice(0, 10), a: regTexto(r['A']).trim() });
  });
  Object.keys(evs).forEach(function (k) { evs[k].sort(function (x, y) { return x.t - y.t || x.id - y.id; }); });
  var si = function (v) { return /^S[ií]/i.test(regTexto(v).trim()); };
  // Días con la exposición: noches con foto prendida + lo que el historial llena en las noches sin foto. null = sin dato.
  var dias = function (prendida, variables) {
    var foto = {}, set = {}, hay = fechas.length > 0;
    fechas.forEach(function (d) { foto[d] = !!prendida(noches[d]); });
    variables.forEach(function (v) {
      if (evs[v]) hay = true;
      regDiasExpuesto_(foto, evs[v], o.ingreso, o.ultimaNoche).forEach(function (d) { set[d] = true; });
    });
    return hay ? Object.keys(set).sort() : null;
  };
  // Antibiótico: casilla prendida o algún antimicrobiano de la lista cerrada detectado en Manejo esa noche.
  var atb = dias(function (r) { return si(r['ATB (casilla)']) || regTexto(r['Antibióticos en Manejo (detectados)']).trim(); }, ['Antibiótico (casilla)']);
  if (atb) { out['Días con antibiótico (observados)'] = atb.length; out['Primer día ATB'] = atb[0] || ''; out['Último día ATB'] = atb[atb.length - 1] || ''; }
  var nombres = {}, clase = {};
  REG_ATB.forEach(function (a) { clase[a[0]] = a[2]; });
  var anotar = function (x) { x = regTexto(x).trim(); if (clase[x] !== undefined) nombres[x] = true; };   // solo nombres de la lista cerrada
  fechas.forEach(function (d) {
    regTexto(noches[d]['Antibióticos en Manejo (detectados)']).split(/\s*·\s*/).forEach(anotar);
    regAtbDetectar(noches[d]['Antibiótico (texto)']).forEach(anotar);
  });
  regArr(evs['Antibiótico (texto)']).forEach(function (e) { regAtbDetectar(e.a).forEach(anotar); });
  if (atb || evs['Antibiótico (texto)']) {
    out['Antibióticos distintos (n)'] = Object.keys(nombres).length;
    out['Carbapenémico'] = Object.keys(nombres).some(function (x) { return clase[x] === 'Carbapenémico'; }) ? 1 : 0;
  }
  // Ayuno y NPT.
  var npo = dias(function (r) { return si(r['NPO']); }, ['Ayuno (NPO)']), npt = dias(function (r) { return si(r['NPT']); }, ['NPT']);
  if (npo) {
    out['Días en ayuno'] = npo.length;
    var sinNpt = npo.filter(function (d) { return !npt || npt.indexOf(d) === -1; }), racha = 0, max = 0, prev = '';
    sinNpt.forEach(function (d) { racha = prev && regDiasSigno(prev, d) === 1 ? racha + 1 : 1; if (racha > max) max = racha; prev = d; });
    out['Ayuno >5 días sin NPT'] = max > 5 ? 1 : 0;
    if (o.cx1) {
      var pos = npo.filter(function (d) { return d >= o.cx1; });
      out['Ayuno posoperatorio (días)'] = pos.length;
      // Inicio de dieta: la primera noche SIN ayuno (foto en «No», o la casilla se apagó) después de un ayuno posoperatorio.
      if (pos.length) {
        var fin = fechas.filter(function (d) { return d > pos[0] && !si(noches[d]['NPO']) && npo.indexOf(d) === -1; });
        regArr(evs['Ayuno (NPO)']).forEach(function (e) { if (e.a === 'No' && e.fecha > pos[0] && npo.indexOf(e.fecha) === -1) fin.push(e.fecha); });
        fin.sort();
        if (fin.length) out['Día posoperatorio de inicio de dieta'] = regDiasSigno(o.cx1, fin[0]);
      }
    }
  }
  if (npt) {
    out['Días con NPT'] = npt.length;
    var pcts = fechas.map(function (d) { return noches[d]['NPT %']; }).concat(regArr(evs['NPT %']).map(function (e) { return e.a; }))
      .map(function (v) { var x = regNumero(v, { unidad: /^%$/ }); return x && !x.comp && x.n > 0 && x.n <= 200 ? x.n : ''; }).filter(function (n) { return n !== ''; });
    if (pcts.length) out['NPT % máximo'] = Math.max.apply(null, pcts);
  }
  var vm = dias(function (r) { return si(r['VM']); }, ['Ventilación mecánica']);
  if (vm) out['Días con ventilación'] = vm.length;
  var vp = dias(function (r) { return regTexto(r['Norepinefrina mL/h']).trim() || regTexto(r['Vasopresina mL/h']).trim(); }, ['Norepinefrina', 'Vasopresina']);
  if (vp) out['Días con vasopresor'] = vp.length;
  var tvp = dias(function (r) { return si(r['TVP']); }, ['Tromboprofilaxis']);
  if (tvp) out['Días con tromboprofilaxis'] = tvp.length;
  // Dispositivos y drenajes. Sin filas de dispositivos ni noches fotografiadas no se sabe nada (vacío).
  var disp = {}, ids = [];
  regArr(o.disp).forEach(function (r) { var id = regTexto(r && r['ID dispositivo']).trim(); if (!id) return; if (!disp[id]) ids.push(id); disp[id] = r; });
  if (ids.length || fechas.length) {
    var grupoDe = function (id) { return regTexto(disp[id]['Tipo (grupo)']).trim() || regDispGrupo(disp[id]['Tipo']); };
    var hayGrupo = function (g) { return ids.some(function (id) { return grupoDe(id) === g; }) ? 1 : 0; };
    out['Dispositivos (n)'] = ids.length;
    out['Sonda endopleural'] = hayGrupo('Sonda pleural'); out['Estoma'] = hayGrupo('Estoma'); out['Terapia de presión negativa'] = hayGrupo('Presión negativa');
    var dd = {}, drenajes = 0, gmax = '';
    ids.forEach(function (id) {
      if (!regEsDrenaje_(disp[id]['Tipo'], grupoDe(id))) return;
      drenajes++;
      var a = regFecha(disp[id]['Primera vez visto']), b = regFecha(disp[id]['Última vez visto']);
      for (var f = a, k = 0; f && b && f <= b && k < 400; f = regFechaMas_(f, 1), k++) dd[f] = true;
    });
    regArr(o.dren).forEach(function (r) {
      if (!r || !regEsDrenaje_(r['Tipo'], (disp[regTexto(r['ID dispositivo']).trim()] || {})['Tipo (grupo)'])) return;
      var f = regFecha(r['Fecha']), x = regNumero(r['Gasto (mL)']);
      if (f) dd[f] = true;
      if (x && !x.comp && (gmax === '' || x.n > gmax)) gmax = x.n;
    });
    // Un drenaje que el registro nunca vio hospitalizado (sin «Primera vez visto») no tiene días observados: vacío, no 0.
    out['Días con drenaje'] = drenajes && !Object.keys(dd).length ? '' : Object.keys(dd).length;
    out['Gasto máximo (mL)'] = gmax;
  }
  var fotos = {}; fechas.forEach(function (d) { fotos[d] = true; });
  out.__dias = { vm: vm || [], vp: vp || [], fotos: fotos };   // 24 nov 2026: fechas, para «Eventos adversos» (no es una columna)
  if (fechas.length && typeof o.estancia === 'number' && o.estancia > 0) out['Cobertura del diario (%)'] = Math.min(100, regRedondear(100 * fechas.length / o.estancia, 1));
  return out;
}
/** Lesión renal aguda por creatinina (KDIGO 2012, sin el criterio de uresis ni el de diálisis). `crs`: [{ f, n }] por
 *  fecha. Basal = la MÍNIMA del episodio. Estadio de cada día: 1 = ≥1.5× la basal o sube ≥0.3 mg/dL respecto a un valor
 *  de hasta 2 días antes (las 48 h se aproximan con fechas); 2 = ≥2×; 3 = ≥3× o ≥4.0 mg/dL habiendo cumplido algún
 *  criterio. Con menos de 2 creatininas todo queda vacío. → { basal, estadio (0–3), fecha (primer día con criterio),
 *  dias: [{ f, e }] }. Función pura. */
function regKdigo_(crs) {
  crs = regArr(crs);
  if (crs.length < 2) return { basal: '', estadio: '', fecha: '', dias: [] };
  var basal = Math.min.apply(null, crs.map(function (x) { return x.n; })), max = 0, fecha = '', dias = [];
  crs.forEach(function (x, i) {
    var r = basal > 0 ? x.n / basal : 0, e = r >= 3 - 1e-9 ? 3 : (r >= 2 - 1e-9 ? 2 : (r >= 1.5 - 1e-9 ? 1 : 0));
    var sube = crs.slice(0, i).some(function (p) { var d = regDiasSigno(p.f, x.f); return d !== '' && d >= 0 && d <= 2 && x.n - p.n >= 0.3 - 1e-9; });
    if (!e && sube) e = 1;
    if (e && x.n >= 4) e = 3;
    dias.push({ f: x.f, e: e });
    if (e > max) max = e;
    if (e && !fecha) fecha = x.f;
  });
  return { basal: basal, estadio: max, fecha: fecha, dias: dias };
}
/** Columnas REG_EP_LAB de un episodio desde su laboratorio por fecha. `serie`: { clave: [{ f, n }] en orden de fecha }
 *  (cr, hb, alb, leucos, plaq, na, pcr, glu); `cx1`: fecha de la primera cirugía con fecha; sexo 'F' | 'M' | ''; edad en
 *  años o ''. Vacío = no se midió. Función pura. */
function regLabsEpisodio_(serie, cx1, sexo, edad) {
  var out = {}, de = function (k) { return regArr(serie && serie[k]); }, primero = function (k) { return de(k).length ? de(k)[0].n : ''; };
  REG_EP_LAB.forEach(function (c) { out[c] = ''; });
  var k = regKdigo_(de('cr'));
  out['Creatinina basal (mg/dL)'] = k.basal; out['LRA KDIGO (estadio máx.)'] = k.estadio; out['Fecha de LRA'] = k.fecha;
  if (cx1 && k.dias.length) {
    // Posoperatoria: cumple criterio en los días 1–7 después de la primera cirugía y no lo cumplía hasta el día de la cirugía.
    var despues = k.dias.filter(function (x) { var d = regDiasSigno(cx1, x.f); return d !== '' && d >= 1 && d <= 7; });
    var previas = k.dias.filter(function (x) { return x.f <= cx1; }), antes = previas.some(function (x) { return x.e > 0; });
    // 24 nov 2026 (revisión): sin ninguna creatinina hasta el día de la cirugía no se puede saber que la lesión es NUEVA
    // (con la basal = mínima, el que llega lesionado y mejora daría 1): queda vacío y va a «Excluidos».
    if (despues.length && previas.length) out['LRA posoperatoria'] = !antes && despues.some(function (x) { return x.e > 0; }) ? 1 : 0;
  }
  var hb = de('hb'), hb0 = primero('hb');
  out['Hb inicial (g/dL)'] = hb0;
  if (cx1) { var pre = hb.filter(function (x) { return x.f <= cx1; }); if (pre.length) out['Hb preoperatoria (g/dL)'] = pre[pre.length - 1].n; }
  if (hb.length >= 2) {
    var pico = hb[0].n, caida = 0;
    hb.forEach(function (x) { if (x.n > pico) pico = x.n; if (pico - x.n > caida) caida = pico - x.n; });
    out['Caída máxima de Hb (g/dL)'] = regRedondear(caida, 2);
  }
  // Anemia (OMS, adultos y ≥15 años): Hb < 13 g/dL en hombres, < 12 en mujeres. Sin sexo solo se decide lo que no depende de él.
  if (hb0 !== '' && !(typeof edad === 'number' && edad < 15)) out['Anemia al ingreso (OMS)'] = sexo === 'M' ? (hb0 < 13 ? 1 : 0) : (sexo === 'F' ? (hb0 < 12 ? 1 : 0) : (hb0 < 12 ? 1 : (hb0 >= 13 ? 0 : '')));
  var alb = primero('alb');
  if (alb !== '') { out['Hipoalbuminemia (<3.5)'] = alb < 3.5 ? 1 : 0; out['Albúmina <3.0'] = alb < 3 ? 1 : 0; }
  out['Leucocitos iniciales (k/µL)'] = primero('leucos'); out['Plaquetas iniciales (k/µL)'] = primero('plaq'); out['Sodio inicial (mmol/L)'] = primero('na');
  if (cx1) [3, 4].some(function (dia) { var x = de('pcr').filter(function (p) { return regDiasSigno(cx1, p.f) === dia; })[0]; if (x) out['PCR día 3-4 posoperatorio (mg/L)'] = x.n; return !!x; });
  if (de('glu').length) out['Glucosa >180 (días)'] = de('glu').filter(function (x) { return x.n > 180; }).length;
  return out;
}
var REG_LAB_SERIE = ['cr', 'hb', 'alb', 'leucos', 'plaq', 'na', 'pcr', 'glu'];
// Sitio del cultivo por «Tipo» + «Muestra» (texto del robot, sin acentos): el primero que coincide; si no, «Otro».
var REG_CULT_SITIOS = [
  ['Sangre', /HEMOCULT|\bSANGRE\b|SANGUINE/],
  ['Orina', /UROCULT|\bORINA\b|URINARI/],
  ['Punta de catéter', /CATETER/],
  ['Respiratorio / pleural', /EXPECTORACION|ESPUTO|BRONQUI|BRONCO|TRAQUEAL|ASPIRADO|FARING|PLEURAL/],
  ['Líquido cefalorraquídeo', /\bLCR\b|CEFALORRAQUIDEO/],
  ['Heces', /COPROCULT|\bHECES\b|MATERIA FECAL/],
  ['Abdominal (líquido, bilis o colección)', /PERITONE|ASCITIS|\bBILIS\b|BILIAR|ABDOMINAL|COLECCION|\bDRENAJE\b|PENROSE|SARATOGA|DRENOVAC|LIQUIDO DE CAVIDAD/],
  ['Herida / tejidos blandos', /HERIDA|SECRECION|ABSCESO|TEJIDO|BIOPSIA|\bPUS\b|PURULENT|\bPIEL\b|ULCERA|HUESO|ESCARA/]
];
var REG_CULT_SITIOS_ISQ = ['Abdominal (líquido, bilis o colección)', 'Herida / tejidos blandos'];
function regCultivoSitio(tipo, muestra) {
  var t = regNorm_(regTexto(tipo) + ' ' + regTexto(muestra));
  if (!t.trim()) return '';
  for (var i = 0; i < REG_CULT_SITIOS.length; i++) if (REG_CULT_SITIOS[i][1].test(t)) return REG_CULT_SITIOS[i][0];
  return 'Otro';
}
// Multirresistencia PROBABLE: marca en el germen (BLEE, MRSA, KPC…), resistencia a un carbapenémico, S. aureus resistente
// a oxacilina / cefoxitina, enterococo resistente a vancomicina, o resistencia a 3 o más de estas clases.
var REG_MDR_MARCA = /\bBLEE\b|\bESBL\b|\bMRSA\b|\bSARM\b|\bKPC\b|\bNDM\b|\bOXA-?48\b|CARBAPENEMASA|METICILINO ?RESISTENTE|RESISTENTE A (LA )?METICILINA|\bVRE\b|\bEVR\b|\bXDR\b|\bMDR\b|MULTIRRESISTENTE|MULTIDROGORRESISTENTE/;
var REG_MDR_CLASES = [/MEROPENEM|IMIPENEM|ERTAPENEM|DORIPENEM/, /CEFTRIAXON|CEFOTAXIM|CEFTAZIDIM|CEFEPIM/, /CIPROFLOXA|LEVOFLOXA|MOXIFLOXA|NORFLOXA/, /AMIKACIN|GENTAMICIN|TOBRAMICIN/,
  /PIPERACILIN/, /TRIMETOPRIM|SULFAMETOXAZOL|\bTMP\b/, /TIGECICLIN|DOXICICLIN|MINOCICLIN|TETRACICLIN/, /AZTREONAM/, /COLISTIN|POLIMIXIN/];
/** 1 / 0 / '' (cultivo sin resultado, o positivo sin antibiograma ni marca: no se sabe). Un cultivo negativo es 0. */
function regCultivoMdr(pos, germen, sensibles, intermedios, resistentes) {
  if (pos !== 1) return pos === 0 ? 0 : '';
  var g = regNorm_(germen), r = regNorm_(resistentes);
  if (REG_MDR_MARCA.test(g)) return 1;
  if (!r.trim() && !regTexto(sensibles).trim() && !regTexto(intermedios).trim()) return '';
  if (REG_MDR_CLASES[0].test(r)) return 1;
  if (/STAPHYLOCOCCUS AUREUS|\bS\. ?AUREUS/.test(g) && /OXACILIN|CEFOXITIN|METICILIN/.test(r)) return 1;
  if (/ENTEROCOC/.test(g) && /VANCOMICIN/.test(r)) return 1;
  return REG_MDR_CLASES.filter(function (c) { return c.test(r); }).length >= 3 ? 1 : 0;
}
// Contaminante PROBABLE: hemocultivo en el que TODOS los gérmenes son flora de piel.
var REG_CULT_CONTAMINANTE = /COAGULASA NEGATIV|\bSCN\b|STAPHYLOCOCCUS (EPIDERMIDIS|HOMINIS|HAEMOLYTICUS|CAPITIS|WARNERI|SAPROPHYTICUS|COHNII|SIMULANS)|CORYNEBACTERIUM|DIFTEROIDES|MICROCOCCUS|BACILLUS(?! ANTHRACIS)|CUTIBACTERIUM|PROPIONIBACTERIUM/;
function regCultivoContaminante(pos, sitio, germen) {
  if (pos !== 1) return pos === 0 ? 0 : '';
  var gs = regNorm_(germen).split(/\s*\+\s*/).filter(function (x) { return x.trim(); });
  return sitio === 'Sangre' && gs.length && gs.every(function (x) { return REG_CULT_CONTAMINANTE.test(x); }) ? 1 : 0;
}
// Infección de sitio quirúrgico MENCIONADA en texto libre; no cuenta si en la misma oración va negada o es solo un riesgo
// («SIN DATOS DE ISQ», «VIGILAR ISQ»), salvo que después de la negación venga algo que afirma («SIN FIEBRE, CON ISQ»).
var REG_ISQ = /\bISQ\b|\bISO\b|INFECCION (DE |DEL |EN )?(EL |LA )?(SITIO|HERIDA) (QUIRURGIC[OA]|QX|OPERATORI[OA])|INFECCION DE (LA )?HERIDA|HERIDA (QUIRURGICA |QX )?INFECTADA/g;
var REG_ISQ_NEG = /\b(SIN|NO|NIEGA|NEGATIV\w*|DESCART\w*|VIGILAR|VIGILANCIA|RIESGO|PROFILAXIS|PREVENCION|PREVENIR|PROBABLE|SOSPECHA)\b/g;
// 24 nov 2026 (revisión): lo que en la MISMA cláusula (entre comas) vuelve la mención preventiva, condicional o ajena al
// paciente; y la negación que va DESPUÉS de la mención («NEUMONIA DESCARTADA», «TRANSFUSION NO REQUERIDA», «ILEO NO»).
var REG_MENCION_NO = /\b(PREVENCION|EN CASO DE|FAMILIAR(ES)?|ESPOS[OA]|VACUNA\w*|CONSENTIMIENTO)\b|\bSI (HB|HAY|PRESENTA|PERSISTE|REQUIERE|AMERITA|SANGRA\w*|CONTINUA|DISMINUYE|BAJA|CAE)\b/;
// Verbos que niegan SOLO lo que les sigue de inmediato («SE SUSPENDE TRANSFUSION», «SOLICITAR 2 PG», «PARA EVITAR LA
// BRONCOASPIRACION»); con más palabras en medio ya hablan de otra cosa («SE SUSPENDE ENOXAPARINA POR SANGRADO DE HERIDA»).
var REG_MENCION_PEGADA = /\b(EVITAR|PREVENIR|SOLICIT\w+|SUSPEND\w+)\s+(\w+\s+)?$/;
var REG_MENCION_POS_NEG = /\b(DESCARTAD[OA]S?|SE DESCARTA\w*|NEGATIV[OA]S?|NO REQUERID[OA]S?|NO AMERIT\w*|NO SE REALIZ\w*|NO NECESARI[OA]S?|SUSPENDID[OA]S?)\b|\bNO\s*$|^\s*\?/;
/** ¿La mención que está en o[i, i + largo) (una oración ya normalizada) queda AFIRMADA? No si su cláusula es preventiva,
 *  condicional o de un familiar; ni si va negada después («… DESCARTADA», hasta la siguiente conjunción); ni si antes, en
 *  la oración, hay una negación o un «vigilar / riesgo / probable» sin algo que afirme después. El verbo que sigue a la
 *  negación es parte de ella («NO PRESENTA DATOS DE…», «NO CURSA CON…»): no afirma. «SIN FIEBRE, CON FUGA» sí cuenta. */
function regMencionAfirmada_(o, i, largo) {
  var antes = o.slice(0, i), ic = antes.lastIndexOf(','), fc = o.indexOf(',', i + largo);
  if (REG_MENCION_NO.test(o.slice(ic + 1, fc < 0 ? o.length : fc))) return false;
  var cola = o.slice(i + largo, fc < 0 ? o.length : fc).split(/\b(?:Y|E|PERO|AUNQUE|CON)\b/)[0];
  if (REG_MENCION_POS_NEG.test(cola) || REG_MENCION_PEGADA.test(antes)) return false;
  var rn = new RegExp(REG_ISQ_NEG.source, 'g'), n, fin = -1;
  while ((n = rn.exec(antes))) fin = n.index + n[0].length;
  if (fin < 0) return true;
  var resto = antes.slice(fin).replace(/^\s*((SE|LE|HA|HAN|HAY)\s+)*((PRESENT|CURS|DESARROLL|DIAGNOSTIC|REQUIER|REQUERID|AMERIT|TIENE|TENID)\w*)?(\s+CON\b)?/, '');
  return /\b(CON|PRESENTA|CURSA|DESARROLL\w*|DIAGNOSTIC\w*|PERO|AUNQUE)\b/.test(resto);
}
function regIsqTexto(texto) {
  return regNorm_(texto).split(/[.\n;]+/).some(function (o) {
    var re = new RegExp(REG_ISQ.source, 'g'), m, hay = false;
    while (!hay && (m = re.exec(o))) hay = regMencionAfirmada_(o, m.index, m[0].length);
    return hay;
  });
}
/** Abordaje inferido del TEXTO del procedimiento (no de la casilla): '' si el texto no lo dice. */
function regCxAbordajeTexto(proc) {
  var t = regNorm_(proc);
  if (/CONVERSION|CONVERTID/.test(t)) return REG_CX_ABORDAJE_TXT.convertida;
  if (/LAPAROSCOP|\bLAP\b|\bCOLE ?LAP\b/.test(t)) return REG_CX_ABORDAJE_TXT.laparoscopica;
  if (/\bCPRE\b|ENDOSCOP|COLONOSCOP|CISTOSCOP|URETEROSCOP|PERCUTANE|TRANSURETRAL|\bRTU[PV]\b/.test(t)) return REG_CX_ABORDAJE_TXT.endoscopica;
  if (/ABIERT|LAPAROTOM|\bLAPE\b|TORACOTOM|ESTERNOTOM|CRANEOTOM|CRANIOTOM/.test(t)) return REG_CX_ABORDAJE_TXT.abierta;
  return '';
}

// ─── 24 nov 2026 (lote C, 2.ª parte): eventos adversos, columnas de apoyo, antibióticos por curso, completitud, flujo de
//     la cohorte e indicadores de calidad. Egress 0: todo sale de lo ya fusionado en la hoja. Funciones puras. ───────────
/** ¿El texto MENCIONA lo que busca `re` sin negarlo? Por oración (. ; salto de línea). No cuenta si la cláusula (entre
 *  comas) es un plan o un antecedente (REG_CX_PLAN, REG_CX_ANTES), va negada (REG_NEG) o coincide con `excl`; ni si antes,
 *  en la misma oración, hay una negación o un «vigilar / riesgo / probable» sin algo que afirme después («SIN DATOS DE
 *  FUGA…» no cuenta; «SIN FIEBRE, CON FUGA…» sí). Tampoco lo preventivo o condicional («PARA EVITAR…», «TRANSFUNDIR SI HB
 *  <7», «SOLICITAR 2 PG»), lo de un familiar ni la negación pospuesta («… DESCARTADA»): regMencionAfirmada_. «… RESUELTA»
 *  sí cuenta (el evento ocurrió). Es texto libre: detecta menciones, no confirma el evento. */
function regMencion_(texto, re, excl) {
  return regNorm_(texto).split(/[.\n;]+/).some(function (o) {
    var r = new RegExp(re.source, 'g'), m, hay = false;
    while (!hay && (m = r.exec(o))) {
      if (!m[0]) { r.lastIndex++; continue; }
      var antes = o.slice(0, m.index), ic = antes.lastIndexOf(','), fc = o.indexOf(',', m.index + m[0].length);
      var clausula = o.slice(ic + 1, fc < 0 ? o.length : fc);
      if (REG_CX_PLAN.test(clausula) || REG_CX_ANTES.test(clausula) || REG_NEG.test(clausula) || (excl && excl.test(clausula))) continue;
      hay = regMencionAfirmada_(o, m.index, m[0].length);   // 24 nov 2026 (revisión): la misma regla que la ISQ en texto
    }
    return hay;
  });
}
// Eventos adversos que solo se pueden saber por MENCIÓN en texto libre: [evento, patrón, grado de Clavien-Dindo mínimo
// que implica, ¿se busca también en el Diagnóstico?, lo que en la misma cláusula lo descarta]. Los generales (neumonía,
// sepsis, trombosis, íleo, transfusión) NO se buscan en el Diagnóstico: ahí suelen ser el motivo de ingreso.
var REG_EVENTOS_TEXTO = [
  // 24 nov 2026 (revisión): la dehiscencia de ANASTOMOSIS (o muñón, sutura intestinal, línea de grapas) va con la fuga
  // (II); la de herida, o la que no dice de qué, va aparte con grado I: el Clavien inferido es un PISO.
  ['Fuga / dehiscencia', /FUGA (DE |DEL )?(LA )?(ANASTOMO\w+|MUNON|BILIAR|INTESTINAL|PANCREATICA|GASTRICA|DUODENAL|URINARIA|RECTAL)|FUGA ANASTOMOTICA|DEHISCENCIA (DE |DEL )?(LA )?(ANASTOMO\w+|MUNON|SUTURA INTESTINAL|LINEA DE GRAPAS)|BILIOMA|BILIRRAGIA/, 'II', true],
  ['Dehiscencia de herida', /DEHISCENCIA(?! (DE |DEL )?(LA )?(ANASTOMO|MUNON|SUTURA INTESTINAL|LINEA DE GRAPAS))/, 'I', true],
  ['Fístula', /FISTULA (ENTEROCUTANEA|ENTEROATMOSFERICA|PANCREATICA|BILIAR|INTESTINAL|COLOCUTANEA|GASTROCUTANEA|ESTERCORACEA|POSOPERATORIA|POSTOPERATORIA|POSTQUIRURGICA|POSQUIRURGICA|DE (ALTO|BAJO) GASTO)/, 'II', true],
  ['Evisceración', /EVISCERA\w+/, 'I', true],
  ['Hemorragia posoperatoria', /(HEMORRAGIA|SANGRADO|HEMOPERITONEO) (POSOPERATORI[OA]|POSTOPERATORI[OA]|POSTQUIRURGIC[OA]|POSQUIRURGIC[OA])|SANGRADO (DE (LA )?HERIDA|ACTIVO POR (EL )?DREN\w*)|HEMATOMA DE (LA )?(HERIDA|PARED)/, 'I', true],
  ['Íleo', /\bILEO (POSOPERATORIO|POSTOPERATORIO|POSTQUIRURGICO|POSQUIRURGICO|PARALITICO|ADINAMICO|PROLONGADO)/, 'I', false],
  ['Neumonía', /NEUMONIA|\bNIH\b|\bNAVM?\b|BRONCOASPIRACION/, 'II', false],
  ['TEV', /\bTEP\b|TROMBOEMBOLIA|EMBOLIA PULMONAR|TROMBOSIS VENOSA PROFUNDA|\bTVP (DE |EN )?(MI|MP|MIEMBRO|PIERNA|ILIO|FEMORO|POPLITE)/, 'II', false, /PROFILAXIS|TROMBOPROFILAXIS|ENOXAPARINA \d+ ?MG (SC )?C\/24/],
  ['Sepsis / choque', /CHOQUE (SEPTICO|HIPOVOLEMICO|HEMORRAGICO|CARDIOGENICO|MIXTO|DISTRIBUTIVO)|\bSEPSIS\b|\bSHOCK\b/, 'II', false],
  ['Transfusión', /TRANSFU[SN]\w+|HEMOTRANSFU\w+|PAQUETES? GLOBULAR(ES)?|CONCENTRADOS? ERITROCITARIOS?|\b\d+ ?(PG|CE)\b/, 'II', false, /CRUZAR|CRUCE|DISPONIB|RESERVA|TIPAR|DONADOR|DONACION|CONSENTIMIENTO/],
  // Por texto NO lleva grado (24 nov 2026, revisión): la mención no dice si fue antes de la cirugía (el tratamiento del
  // padecimiento) o después; el IIIa solo sale del estudio del RIS con fecha posterior a la cirugía. Queda para revisar.
  ['Drenaje percutáneo', /DRENAJE PERCUTANEO|PUNCION (GUIADA|PERCUTANEA)|\bPIGTAIL\b/, '', false]
];
// Estudio del RIS en sala de intervencionismo (modalidad XA) que es un drenaje o una punción, no un estudio diagnóstico.
var REG_XA_DRENAJE = /DRENAJE|PUNCION|PERCUTAN|PIGTAIL|NEFROSTOMIA|COLECISTOSTOMIA|DERIVACION BILIAR/;
// Tipo de egreso PROBABLE desde el texto de guardia y pendientes (solo cuando nadie registró el motivo).
// 24 nov 2026 (revisión): el traslado es a OTRO hospital (no «TRASLADO A UNIDAD DE CUIDADOS INTENSIVOS» ni «DOLOR QUE SE
// REFIERE A HOMBRO»); el alta de un interconsultante («ALTA POR MEJORIA DE NEFROLOGIA») o condicionada («ALTA SI TOLERA»,
// «PROBABLE ALTA MAÑANA») no es el egreso.
var REG_ALTA_TXT = /\bPRE ?-?ALTA\b|\bALTA (A |AL |A SU )?(DOMICILIO|CASA)\b|\bALTA (HOY|MEDICA|HOSPITALARIA|POR MEJORIA|DEL SERVICIO)\b|\bEGRES[AO] (A |POR )?(DOMICILIO|MEJORIA)\b|\bSE (VA|EGRESA) (DE ALTA|A (SU )?(DOMICILIO|CASA))\b|^\s*[-•*]?\s*ALTA\s*$/g;
var REG_ALTA_VOL_TXT = /\bALTA VOLUNTARIA\b/g;
var REG_DESTINO_TXT = '(OTR[OA] |SU )?(HOSPITAL|HG[RZ]?\\b|IMSS|ISSSTE|INSTITUTO|CLINICA|TERCER NIVEL|SEGUNDO NIVEL|CMN\\b|UNIDAD (DE ADSCRIPCION|MEDICA( FAMILIAR)?|DE (ORIGEN|REFERENCIA))|UMF\\b)|(OTRA|SU) UNIDAD\\b';
var REG_TRASLADO_TXT = new RegExp('\\bTRASLAD\\w+ (A|AL) (' + REG_DESTINO_TXT + ')|\\bCONTRAR+EFER\\w+|\\bSE REFIERE (A|AL) (' + REG_DESTINO_TXT + ')', 'g');
var REG_ALTA_OTRO_SERVICIO = /^\s*(POR PARTE )?(DE|POR) (INFECTO|NEFRO|CARDIO|MEDICINA|NEUMO|ENDOCRIN|PSIQUIATR|PSICOLOG|HEMATO|ONCO|GASTRO|NEURO|URO|GINECO|TRAUMA|GERIATR|ANESTESI|NUTRI|DERMATO|REUMATO|ALGOLOG|REHABILIT|TERAPIA|CLINICA DE|INHALOTERAPIA|ANGIO)/;
var REG_ALTA_CONDICION = /\b(SI|MANANA|CUANDO|AL TOLERAR|EN CUANTO|UNA VEZ QUE)\b/;
var REG_DEFUNCION_TXT = /DEFUNCION|FALLEC|\bFINAD[OA]\b|\bOBITO\b|\bMUERTE\b/;
var REG_ALTA_NEG = /\b(NO|SIN|AUN|DIFIERE|DIFERIR|DIFERIDA|SUSPENDE|CANCELA|VALORAR|PENDIENTE|PROBABLE|POSIBLE|CUANDO|SI|INTERCONSULTA\w*|IC)\b/;
/** 'Alta', 'Alta voluntaria', 'Traslado' o '' desde renglones de guardia / pendientes. Si algún renglón habla de una
 *  defunción no se infiere nada ('' : el desenlace sigue desconocido). NUNCA da «Defunción». */
function regEgresoTexto_(texto) {
  var hay = {}, muerte = false;
  var busca = function (o, re) {
    var r = new RegExp(re.source, 'g'), m;
    while ((m = r.exec(o))) {
      if (!m[0]) { r.lastIndex++; continue; }
      var cola = o.slice(m.index + m[0].length);
      if (!REG_ALTA_NEG.test(o.slice(0, m.index)) && !REG_ALTA_OTRO_SERVICIO.test(cola) && !REG_ALTA_CONDICION.test(cola)) return true;
    }
    return false;
  };
  regNorm_(texto).split(/[.\n;]+/).forEach(function (o) {
    if (REG_DEFUNCION_TXT.test(o)) { muerte = true; return; }
    if (busca(o, REG_ALTA_VOL_TXT)) hay.vol = true;
    else if (busca(o, REG_TRASLADO_TXT)) hay.tras = true;
    else if (busca(o, REG_ALTA_TXT)) hay.alta = true;
  });
  return muerte ? '' : (hay.vol ? 'Alta voluntaria' : (hay.tras ? 'Traslado' : (hay.alta ? 'Alta' : '')));
}
// Reingreso PLANEADO (probable): el episodio siguiente dice a qué venía.
// 24 nov 2026 (revisión): se evalúa por cláusula; la que NOMBRA la cirugía previa («PO CIERRE DE ILEOSTOMIA + FUGA»,
// «POSTERIOR A QUIMIOTERAPIA») o la niega («NO PROGRAMADO PARA CIRUGIA») no dice que el reingreso fuera planeado; y si el
// diagnóstico del reingreso trae una complicación, no lo es.
var REG_REINGRESO_ANTES = /\b(PO|POP|P\.\s?O\.?|POSTOPERAD\w*|POSOPERAD\w*|POSTQUIRURGIC\w*|POSQUIRURGIC\w*|POST ?QX|PQX|S\/P|OPERAD[OA]|POSTERIOR(ES)? A|SECUNDARI[OA]S? A|DESPUES DE|TRAS|ANTECEDENTE\w*|PREVI[OA]S?|HACE|NO|SIN|NIEGA)\b/;
var REG_REINGRESO_COMPLICACION = /\bFUGA\b|SEPSIS|SEPTIC|ABSCESO|DEHISCENCIA|OCLUSION|SANGRADO|HEMORRAGIA|INFECCION|\bISQ\b|EVISCERA|PERITONITIS|COLECCION|\bCHOQUE\b|NEUTROPENIA|TROMBOSIS|\bTEP\b|NEUMONIA|\bILEO\b|HEMATOMA|NECROSIS/;
/** ¿El reingreso era PLANEADO (probable)? 1 si alguna cláusula del diagnóstico, el padecimiento o los procedimientos del
 *  episodio siguiente dice a qué venía (REG_REINGRESO_PLANEADO) sin marca de posoperatorio, antecedente ni negación, o si
 *  su primera cirugía se eligió «Electiva»; siempre 0 si su DIAGNÓSTICO trae una complicación. Función pura. */
function regReingresoPlaneado_(dx, otros, electiva) {
  if (REG_REINGRESO_COMPLICACION.test(regNorm_(dx))) return 0;
  var dice = regNorm_(regTexto(dx) + '\n' + regTexto(otros)).split(/[.\n;,+]+|\/\//).some(function (cl) { return REG_REINGRESO_PLANEADO.test(cl) && !REG_REINGRESO_ANTES.test(cl); });
  return dice || electiva ? 1 : 0;
}
var REG_REINGRESO_PLANEADO = /CIERRE DE (ILEOSTOMIA|COLOSTOMIA|ESTOMA|FISTULA)|RESTITUCION (DEL |DE )?(EL )?TRANSITO|\bRECONEXION\b|SEGUNDO TIEMPO|2DO\.? TIEMPO|CIRUGIA (PROGRAMADA|ELECTIVA)|INGRESO PROGRAMADO|PROGRAMAD[OA] PARA|QUIMIOTERAPIA|RETIRO DE (CATETER|DOBLE J|JJ|MATERIAL|SONDA)|PROTOCOLO (DE ESTUDIO|QUIRURGICO)/;
/** Personas de «Labs del robot (WinLab)» por expediente: [{ paciente, nombreWl, nacs: { 'DD/MM/AAAA': true }, fechas:
 *  { 'AAAA-MM-DD': true } (días con toma), fechasHosp (las mismas, sin las de consulta externa o urgencias) }]. Una pasada por la pestaña; sirve para la edad calculada, para «Sigue en el
 *  hospital» y para contar los expedientes que WinLab vio y no tienen episodio. */
var REG_WL_AMBULATORIO = /CONSULTA|EXTERNA|\bCE\b|URGENCIAS|AMBULATORI|PREANEST|PREOPERATORI|MEDICINA PREVENTIVA|CHECK ?UP/;
function regWlPersonas_(filas) {
  var mapa = {}, idx = {};
  regArr(filas).forEach(function (r) {
    var exp = regExpValido(r && r['Expediente']);
    if (!exp) return;
    var pac = regTexto(r['Paciente']).trim(), nwl = regTexto(r['Nombre en WinLab']).trim(), k = exp + REG_SEP + pac + REG_SEP + nwl, x = idx[k];
    if (!x) { x = idx[k] = { paciente: pac, nombreWl: nwl, nacs: {}, fechas: {}, fechasHosp: {} }; (mapa[exp] = mapa[exp] || []).push(x); }
    var nac = regTexto(r['Nacimiento en WinLab']).trim(), f = regFecha(r['Toma']);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(nac)) x.nacs[nac] = true;
    if (f) x.fechas[f] = true;
    // 24 nov 2026 (revisión): el laboratorio de control en consulta externa o urgencias no dice que siga hospitalizado.
    if (f && !REG_WL_AMBULATORIO.test(regNorm_(r['Servicio']))) x.fechasHosp[f] = true;
  });
  return mapa;
}
function regWlDeLaPersona_(mapa, exp, nombre) {
  var e = regExpValido(exp);
  return e ? regArr(regObj(mapa)[e]).filter(function (x) { return regMismaPersona(x.paciente, nombre) || (regPalabrasNombre(x.nombreWl).length && regMismaPersona(x.nombreWl, nombre)); }) : [];
}
/** Años cumplidos en `fecha` (AAAA-MM-DD) de quien nació el 'DD/MM/AAAA'; '' si falta algo o no es posible (0–120). */
function regEdadEnFecha_(nac, fecha) {
  var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(regTexto(nac)), f = regFecha(fecha);
  if (!m || !f || +m[2] < 1 || +m[2] > 12 || +m[1] < 1 || +m[1] > 31 || +m[3] < 1900) return '';
  var edad = +f.slice(0, 4) - +m[3];
  if (f.slice(5) < m[2] + '-' + m[1]) edad--;
  return edad >= 0 && edad <= 120 ? edad : '';
}
/** «Día N» anotado junto a cada antibiótico del texto («MEROPENEM D5», «VANCO DIA 3/10») → { NOMBRE: N } (1–60). */
function regAtbDiaN_(texto) {
  var out = {};
  regTexto(texto).split(/\n/).forEach(function (linea) {
    var t = regNorm_(linea), ms = [];
    REG_ATB.forEach(function (a) {
      var re = new RegExp(a[1].source, 'g'), m;
      while ((m = re.exec(t))) {
        if (!m[0]) { re.lastIndex++; continue; }
        ms.push({ n: a[0], i: m.index, fin: m.index + m[0].length });
        t = t.slice(0, m.index) + new Array(m[0].length + 1).join('§') + t.slice(m.index + m[0].length);
      }
    });
    ms.sort(function (x, y) { return x.i - y.i; });
    ms.forEach(function (x, k) {
      var cola = t.slice(x.fin, Math.min(ms[k + 1] ? ms[k + 1].i : t.length, x.fin + 40));
      // «D10 DE ESTANCIA», «DIA 3 PO»: no es el día del antibiótico (24 nov 2026, revisión).
      var m = /(?:^|[\s(,;:])(?:D|DIA)\s*[-#]?\s*(\d{1,2})\b(?!\s*(?:DE\s+)?(?:ESTANCIA|EIH|HOSPITALIZACION|INTERNAMIENTO|PO\b|POP\b|POSTOPERATORIO|POSOPERATORIO|POSTQX|POSTQUIRURGICO|DE\s+VIDA))/.exec(cola);
      if (m && +m[1] >= 1 && +m[1] <= 60) out[x.n] = +m[1];
    });
  });
  return out;
}
/** Cursos de antibiótico de un episodio (filas de «Análisis · Antibióticos» sin los ids). o = { noches (filas de «Estado
 *  diario»), soporte (filas del historial de auditoría), ingreso, ultimaNoche (última noche hospitalizado), egresado,
 *  cxFechas (fechas de sus cirugías), cultivos ([{ f, real, germen, sens, res }]), conExp (¿tiene expediente válido?) }.
 *  Un antibiótico de la lista cerrada REG_ATB cuenta una noche si esa noche la casilla estaba prendida y el texto lo
 *  nombra («Casilla»), o si se detectó en Manejo («Texto de manejo»); las noches SIN foto se llenan con el texto del
 *  historial («Historial»: de la fecha en que se escribió a la víspera del siguiente cambio o del apagado). Un curso =
 *  noches seguidas; un hueco de hasta 3 días solo lo parte si alguna noche del hueco tiene foto sin el antibiótico.
 *  «Inicio estimado»: si la primera noche trae «D5» junto al nombre (o, con un solo antibiótico en el texto, la fecha de
 *  inicio de la tarjeta o los días escritos), fecha − 4; nunca antes del ingreso ni más de 60 días atrás, y si alcanza al
 *  curso anterior del mismo antibiótico los dos son uno solo. No mide la profilaxis de quirófano (no se anota). */
var REG_ATB_DIAS_MAX = 60;
function regAtbCursos_(o) {
  var meta = {}, foto = {}, dias = {}, est = {}, evTxt = [], evCas = [], out = [];
  REG_ATB.forEach(function (a) { meta[a[0]] = a; });
  var poner = function (nombre, fecha, fuente, inicioEst) {
    if (!meta[nombre] || !fecha) return;
    var d = dias[nombre] || (dias[nombre] = {});
    (d[fecha] = d[fecha] || {})[fuente] = true;
    // 24 nov 2026 (revisión): el inicio estimado no retrocede 60 días o más (una fecha de inicio con el año mal escrito:
    // se descarta) ni queda antes del ingreso (el antibiótico que ya traía: se topa en el ingreso, porque los días de
    // antes no son de esta estancia).
    if (inicioEst && regDiasSigno(inicioEst, fecha) >= REG_ATB_DIAS_MAX) inicioEst = '';
    if (inicioEst && o.ingreso && inicioEst < o.ingreso) inicioEst = o.ingreso;
    if (inicioEst && inicioEst < fecha) (est[nombre] = est[nombre] || {})[fecha] = inicioEst;
  };
  regArr(o.noches).forEach(function (r) {
    var f = regFecha(r && r['Fecha']);
    if (!f) return;
    foto[f] = true;
    regTexto(r['Antibióticos en Manejo (detectados)']).split(/\s*·\s*/).forEach(function (x) { poner(x.trim(), f, 'Texto de manejo'); });
    if (!/^S[ií]/i.test(regTexto(r['ATB (casilla)']).trim())) return;
    var txt = r['Antibiótico (texto)'], ns = regAtbDetectar(txt), dn = regAtbDiaN_(txt), ini = regFecha(r['ATB inicio']), esc = regNumero(r['Días ATB (escritos)']);
    ns.forEach(function (n) {
      var e = dn[n] ? regFechaMas_(f, -(dn[n] - 1)) : '';
      if (!e && ns.length === 1) e = ini && ini <= f ? ini : (esc && !esc.comp && esc.n >= 1 && esc.n <= REG_ATB_DIAS_MAX && esc.n === Math.floor(esc.n) ? regFechaMas_(f, -(esc.n - 1)) : '');
      poner(n, f, 'Casilla', e);
    });
  });
  regArr(o.soporte).forEach(function (r) {
    var t = Date.parse(regTexto(r && r['Fecha y hora']).replace(' ', 'T')), v = regTexto(r && r['Variable']);
    if (isNaN(t) || (v !== 'Antibiótico (texto)' && v !== 'Antibiótico (casilla)')) return;
    (v === 'Antibiótico (texto)' ? evTxt : evCas).push({ t: t, id: +r['ID'] || 0, fecha: new Date(t + REG_UTC_OFFSET_MIN * 60000).toISOString().slice(0, 10), a: regTexto(r['A']).trim() });
  });
  var porT = function (x, y) { return x.t - y.t || x.id - y.id; };
  evTxt.sort(porT); evCas.sort(porT);
  evTxt.forEach(function (e, i) {
    var ns = regAtbDetectar(e.a), fin = o.ultimaNoche || '', dn = regAtbDiaN_(e.a);
    if (!ns.length || !fin) return;
    if (evTxt[i + 1]) { var fs = regFechaMas_(evTxt[i + 1].fecha, -1); if (fs < fin) fin = fs; }
    var apagado = evCas.filter(function (c) { return c.a === 'No' && c.t >= e.t; })[0];
    if (apagado) { var fa = regFechaMas_(apagado.fecha, -1); if (fa < fin) fin = fa; }
    for (var f = e.fecha, k = 0; f && f <= fin && k < 120; f = regFechaMas_(f, 1), k++) {
      if ((o.ingreso && f < o.ingreso) || foto[f]) continue;
      ns.forEach(function (n) { poner(n, f, 'Historial', f === e.fecha && dn[n] ? regFechaMas_(f, -(dn[n] - 1)) : ''); });
    }
  });
  var cxs = regArr(o.cxFechas).filter(Boolean).sort(), cultivos = regArr(o.cultivos);
  Object.keys(dias).forEach(function (n) {
    var fs = Object.keys(dias[n]).sort(), i0 = 0, tramos = [];
    for (var i = 1; i <= fs.length; i++) {
      var corta = i === fs.length;
      if (!corta) {
        var hueco = regDiasSigno(fs[i - 1], fs[i]);
        if (hueco > 1) {
          corta = hueco > 3;
          for (var f = regFechaMas_(fs[i - 1], 1); !corta && f < fs[i]; f = regFechaMas_(f, 1)) if (foto[f]) corta = true;
        }
      }
      if (!corta) continue;
      // 24 nov 2026 (revisión): si el inicio estimado de este tramo alcanza al tramo anterior del mismo antibiótico
      // («D4» después de una noche con la casilla apagada), es el MISMO curso: se une en vez de contar dos veces sus días.
      var estTramo = (est[n] || {})[fs[i0]] || '', ant = tramos[tramos.length - 1];
      if (ant && estTramo && estTramo <= fs[ant.b - 1]) ant.b = i; else tramos.push({ a: i0, b: i });
      i0 = i;
    }
    tramos.forEach(function (tr) {
      var i0 = tr.a, i = tr.b;
      var inicio = fs[i0], fin = fs[i - 1], estimado = (est[n] || {})[inicio] || '', desde = estimado || inicio, fuentes = {}, germenes = [], sens = false, res = false, previo = 0, dCx = '';
      fs.slice(i0, i).forEach(function (d) { Object.keys(dias[n][d]).forEach(function (x) { fuentes[x] = true; }); });
      cultivos.forEach(function (c) {
        if (!c.f) return;
        if (c.f <= regFechaMas_(desde, 1)) previo = 1;
        if (!c.real || c.f > fin) return;
        regTexto(c.germen).split(/\s*\+\s*/).forEach(function (x) { x = x.replace(/\s*\(.*\)\s*$/, '').trim(); if (x && !/^POSITIVO/i.test(x) && germenes.indexOf(x) === -1) germenes.push(x); });
        if (meta[n][1].test(regNorm_(c.res))) res = true;
        if (meta[n][1].test(regNorm_(c.sens))) sens = true;
      });
      cxs.forEach(function (c) { if (c <= desde) dCx = regDiasSigno(c, desde); });
      out.push({ 'Antibiótico': n, 'Clase': meta[n][2], 'AWaRe': meta[n][3], 'Inicio': inicio, 'Inicio estimado': estimado, 'Fin': fin, 'Días de tratamiento': regDiasSigno(desde, fin) + 1,
        'Sigue al egreso': o.egresado ? (o.ultimaNoche && fin >= o.ultimaNoche ? 1 : 0) : '', 'Cultivo previo o ≤24 h': o.conExp ? previo : '', 'Germen aislado': germenes.join('; '),
        'Concordante con antibiograma': res ? 0 : (sens ? 1 : ''), 'Días desde la última cirugía': regNumCelda(dCx),
        'Fuente': ['Casilla', 'Texto de manejo', 'Historial'].filter(function (x) { return fuentes[x]; }).join(' + '), 'Vigente': 'Sí' });
    });
  });
  return out.sort(function (a, b) { return a['Inicio'].localeCompare(b['Inicio']) || a['Antibiótico'].localeCompare(b['Antibiótico']); });
}
/** Intervalo de confianza de 95 % de Wilson para x de n, en porcentaje con un decimal: [inferior, superior]. */
function regWilson_(x, n) {
  if (!(n > 0) || !(x >= 0) || x > n) return ['', ''];
  var z = 1.959964, z2 = z * z, p = x / n, c = (p + z2 / (2 * n)) / (1 + z2 / n), h = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return [regRedondear(100 * Math.max(0, c - h), 1), regRedondear(100 * Math.min(1, c + h), 1)];
}
function regMediana_(l) {
  l = l.slice().sort(function (x, y) { return x - y; });
  return l.length ? (l.length % 2 ? l[(l.length - 1) / 2] : (l[l.length / 2 - 1] + l[l.length / 2]) / 2) : '';
}
// Completitud: [variable, a quién aplica (null = a todo episodio que no es duplicado), ¿tiene el dato?]. x = { e: fila de
// «Análisis · Episodios», exp: ¿expediente válido?, sv01: ¿signos vitales el día 0 o 1? }.
var REG_COMPLETITUD = [
  ['Edad', null, function (x) { return x.e['Edad (años)'] !== ''; }],
  ['Edad calculada con la fecha de nacimiento (WinLab)', null, function (x) { return x.e['Edad al ingreso (calculada)'] !== ''; }],
  ['Sexo (cualquier fuente)', null, function (x) { return x.e['Sexo'] !== ''; }],
  ['Sexo (escrito en la tarjeta)', null, function (x) { return x.e['Sexo (fuente)'] === REG_SEXO_TARJETA; }],
  // 25 nov 2026: el inferido del nombre se cuenta aparte (no se mezcla con lo escrito en la tarjeta).
  ['Sexo (inferido del nombre)', null, function (x) { return x.e['Sexo (fuente)'] === REG_SEXO_NOMBRE; }],
  ['Fecha de ingreso', null, function (x) { return x.e['Fecha de ingreso'] !== ''; }],
  ['Tipo de egreso (motivo registrado)', function (x) { return x.e['Egreso observado'] === 1; }, function (x) { return x.e['Defunción'] !== ''; }],
  ['Dx principal (elegido o inferido)', null, function (x) { return x.e['Dx principal'] !== ''; }],
  ['Dx principal elegido en la app', null, function (x) { return x.e['Dx principal (fuente)'] === 'Elegido en la app'; }],
  ['Antecedentes (APP)', null, function (x) { return x.e['Charlson (calculable)'] === 1; }],
  ['Peso', null, function (x) { return x.e['Peso (kg)'] !== ''; }],
  // 25 nov 2026: «Talla» ya no se mide (la talla no se registra en este servicio). IMC se sigue calculando si la hay.
  ['Al menos un laboratorio', null, function (x) { return x.e['Fechas con labs (n)'] > 0; }],
  ['Dos o más creatininas', null, function (x) { return x.e['Creatinina basal (mg/dL)'] !== ''; }],
  ['Albúmina', null, function (x) { return x.e['Hipoalbuminemia (<3.5)'] !== ''; }],
  ['Signos vitales el día 0 o 1', null, function (x) { return !!x.sv01; }],
  ['Tromboprofilaxis registrada (operados)', function (x) { return x.e['Cirugías (n)'] > 0; }, function (x) { return x.e['Tromboprofilaxis (registrada)'] === 1 || x.e['Días con tromboprofilaxis'] > 0; }],
  ['Diario con cobertura ≥ 80 %', null, function (x) { return x.e['Cobertura del diario (%)'] !== '' && x.e['Cobertura del diario (%)'] >= 80; }],
  ['Expediente válido', null, function (x) { return !!x.exp; }]
];
// Lo mismo por cirugía (c = fila de «Análisis · Cirugías»); va al mes de ingreso de su episodio.
var REG_COMPLETITUD_CX = [
  ['Cirugía con fecha', function (c) { return c['Fecha'] !== ''; }],
  ['Cirugía con tipo (urgencia / electiva)', function (c) { return c['Tipo'] !== ''; }],
  ['Cirugía con abordaje', function (c) { return c['Abordaje'] !== ''; }],
  ['Cirugía con Clavien-Dindo', function (c) { return c['Clavien-Dindo'] !== ''; }],
  ['Cirugía con sangrado en número', function (c) { return c['Sangrado (mL)'] !== ''; }]
];
/** «Completitud»: por mes de ingreso y «Acumulado», cuántos episodios (no duplicados) tienen cada dato. `items`: [{ e,
 *  exp, sv01 }]; `cxs`: filas de «Análisis · Cirugías». El episodio sin fecha de ingreso solo entra en «Acumulado». */
function regCompletitud_(items, cxs) {
  var acc = {}, meses = {}, mesDe = {};
  var suma = function (mes, variable, tiene) {
    [mes, 'Acumulado'].forEach(function (m) {
      if (!m) return;
      if (m !== 'Acumulado') meses[m] = true;
      var a = acc[m + REG_SEP + variable] || (acc[m + REG_SEP + variable] = { con: 0, n: 0 });
      a.n++; if (tiene) a.con++;
    });
  };
  regArr(items).forEach(function (x) {
    if (!x || !x.e || x.e['Excluir (duplicado)'] === 1) return;
    var mes = regFecha(x.e['Fecha de ingreso']).slice(0, 7);
    mesDe[x.e['ID episodio']] = mes;
    REG_COMPLETITUD.forEach(function (v) { if (!v[1] || v[1](x)) suma(mes, v[0], !!v[2](x)); });
  });
  regArr(cxs).forEach(function (c) {
    if (!c || mesDe[c['ID episodio']] === undefined) return;
    REG_COMPLETITUD_CX.forEach(function (v) { suma(mesDe[c['ID episodio']], v[0], !!v[1](c)); });
  });
  var out = [], variables = REG_COMPLETITUD.map(function (v) { return v[0]; }).concat(REG_COMPLETITUD_CX.map(function (v) { return v[0]; }));
  Object.keys(meses).sort().concat(['Acumulado']).forEach(function (m) {
    variables.forEach(function (v) {
      var a = acc[m + REG_SEP + v];
      if (a) out.push({ 'Mes de ingreso': m, 'Variable': v, 'Con dato (n)': a.con, 'Aplicables (n)': a.n, 'Completitud (%)': regRedondear(100 * a.con / a.n, 1), 'Vigente': 'Sí' });
    });
  });
  return out;
}
/** «Flujo de la cohorte»: de todos los episodios del registro a los analizables, restando en orden (cada episodio sale
 *  en el PRIMER paso que le toca). 24 nov 2026 (revisión): termina en el MISMO conjunto que usa regIndicadores_ («=
 *  Episodios analizables» = denominador de «Mortalidad hospitalaria (desenlace conocido)» en «Acumulado»); el episodio
 *  sin fecha de ingreso sí es analizable (tiene egreso y desenlace) y se cuenta aparte, al final. `eps`: filas de «Análisis · Episodios»; extra = { cultivosSinEpisodio, expedientesWinLabSinEpisodio }. */
function regFlujo_(eps, extra) {
  eps = regArr(eps); extra = extra || {};
  var pasos = [
    ['− Tarjetas duplicadas (no son otro episodio)', function (e) { return e['Excluir (duplicado)'] === 1; }],
    ['− Borrados en la base o «no fue egreso» (por revisar)', function (e) { return e['Excluir (duplicado)'] === '' || e['Tipo de egreso'] === 'No fue egreso'; }],
    ['− Siguen hospitalizados o sin egreso registrado', function (e) { return e['Egreso observado'] !== 1; }],
    ['− Egresados sin desenlace conocido (falta el motivo del egreso)', function (e) { return e['Defunción'] === ''; }]
  ];
  var quedan = eps.slice(), filas = [['Episodios en el registro', eps.length]];
  pasos.forEach(function (p) { var n = quedan.length; quedan = quedan.filter(function (e) { return !p[1](e); }); filas.push([p[0], n - quedan.length]); });
  filas.push(['Episodios analizables (egreso con desenlace conocido)', quedan.length]);
  filas.push(['Analizables operados', quedan.filter(function (e) { return e['Cirugías (n)'] > 0; }).length]);
  filas.push(['Analizables con laboratorio seriado (2 o más fechas)', quedan.filter(function (e) { return e['Fechas con labs (n)'] >= 2; }).length]);
  filas.push(['Analizables sin fecha de ingreso (cuentan para mortalidad; no tienen estancia)', quedan.filter(function (e) { return e['Fecha de ingreso'] === ''; }).length]);
  filas.push(['Cultivos del robot sin episodio en el registro', extra.cultivosSinEpisodio || 0]);
  filas.push(['Expedientes vistos por WinLab sin episodio en el registro', extra.expedientesWinLabSinEpisodio || 0]);
  return filas.map(function (f, i) { return { 'Orden': i + 1, 'Paso': f[0], 'Episodios (n)': f[1], 'Vigente': 'Sí' }; });
}
// Indicadores de calidad. nivel: 'ep' (fila de «Análisis · Episodios» con egreso observado, por mes de EGRESO), 'cx' (fila
// de «Análisis · Cirugías», por mes de la cirugía) o 'atb' (curso de antibiótico, por mes de egreso de su episodio).
// tipo 'prop': v → 1 / 0, '' (falta el dato: se cuenta en «Excluidos») o null (no aplica). 'mediana': v → número, '' o
// null. 'razon': v → [numerador, denominador], '' o null.
var REG_INDICADORES = (function () {
  var op = function (e) { return e['Cirugías (n)'] > 0; }, col = function (c) { return function (e) { return e[c]; }; };
  var enOp = function (f) { return function (e) { return op(e) ? f(e) : null; }; };
  var lap = function (c) { return /^Laparosc|^Convertida/.test(regTexto(c['Abordaje'])); };
  // 24 nov 2026 (revisión): el reingreso entra al indicador solo cuando el egreso ya tiene sus 30 días observados, en el
  // numerador y en el denominador (antes el que reingresaba entraba de inmediato y el que no, a los 30 días).
  var r30 = function (c) { return function (e) { return e['Defunción'] === 1 ? null : (e['Seguimiento posalta observable (días)'] === REG_SEGUIMIENTO_MAX ? e[c] : ''); }; };
  return [
    { n: 'Mortalidad hospitalaria (desenlace conocido)', nivel: 'ep', tipo: 'prop', v: col('Defunción'), def: 'Defunciones ÷ egresos con motivo registrado. Los egresos sin motivo van en «Excluidos»: si los que mueren se registran más que los que se van de alta, sobreestima.' },
    { n: 'Mortalidad hospitalaria (desconocidos como vivos)', nivel: 'ep', tipo: 'prop', v: function (e) { return e['Defunción'] === 1 ? 1 : 0; }, def: 'Análisis de sensibilidad: defunciones ÷ TODOS los egresos (el egreso sin motivo cuenta como vivo). Es el piso; la real está entre esta y la de desenlace conocido.' },
    { n: 'Mortalidad posoperatoria (desenlace conocido)', nivel: 'ep', tipo: 'prop', v: enOp(col('Defunción')), def: 'Defunciones ÷ egresos operados con motivo registrado. Hospitalaria (en este servicio), no a 30 días.' },
    { n: 'Mortalidad posoperatoria (desconocidos como vivos)', nivel: 'ep', tipo: 'prop', v: enOp(function (e) { return e['Defunción'] === 1 ? 1 : 0; }), def: 'Análisis de sensibilidad: defunciones ÷ todos los egresos operados.' },
    { n: 'Reintervención no planeada', nivel: 'ep', tipo: 'prop', v: enOp(col('Reintervención no planeada (probable)')), def: 'Egresos operados con «Reintervención no planeada (probable)» = 1 ÷ operados con el dato. Inferida de fechas y texto: no cuenta procedimientos menores (CPRE, traqueostomía, catéteres), lo del mismo día que la índice ni la 2.ª cirugía elegida «Electiva». Validar contra «Eventos adversos».' },
    { n: 'Reingreso a 30 días', nivel: 'ep', tipo: 'prop', v: r30('Reingreso a 30 días'), def: 'Egresos vivos (o sin motivo) que volvieron a ESTE servicio en ≤30 días ÷ egresos con 30 días ya observados. El egreso con menos de 30 días de seguimiento va en «Excluidos» AUNQUE ya haya reingresado (si no, el mes reciente saldría inflado). No ve reingresos a otro hospital.' },
    { n: 'Reingreso no planeado a 30 días', nivel: 'ep', tipo: 'prop', v: r30('Reingreso no planeado a 30 días'), def: 'Como el anterior, sin los reingresos que el texto del episodio siguiente marca como programados.' },
    { n: 'Complicación mayor capturada (Clavien ≥ IIIa)', nivel: 'ep', tipo: 'prop', v: enOp(col('Complicación mayor (Clavien ≥ IIIa)')), def: 'Operados con Clavien-Dindo ≥ IIIa ELEGIDO en la caja ÷ operados con algún grado elegido. Casi nadie lo llena: ver «Excluidos».' },
    { n: 'Complicación mayor inferida (≥ IIIa)', nivel: 'ep', tipo: 'prop', v: enOp(col('Complicación mayor inferida (≥ IIIa)')), def: 'Operados con algún evento adverso detectado de grado ≥ IIIa (defunción; vasopresor o ventilación que empieza después de operarse; relaparotomía o reintervención dicha en el texto; drenaje percutáneo del RIS) ÷ operados. Es un piso (lo no registrado no se ve).' },
    { n: 'ISQ probable (cultivo)', nivel: 'ep', tipo: 'prop', v: enOp(col('ISQ probable (cultivo)')), def: 'Operados con cultivo positivo de herida o abdominal 1-30 días después de la cirugía ÷ operados con fecha de cirugía. Subestima: la infección superficial casi nunca se cultiva.' },
    { n: 'LRA posoperatoria (KDIGO)', nivel: 'ep', tipo: 'prop', v: enOp(col('LRA posoperatoria')), def: 'Operados con criterio KDIGO por creatinina en los días 1-7 (y sin criterio hasta el día de la cirugía) ÷ operados con creatinina antes de operarse y en los días 1-7. Sin creatinina preoperatoria van en «Excluidos»: subestima en la urgencia sin laboratorio previo.' },
    { n: 'Bacteriemia', nivel: 'ep', tipo: 'prop', v: function (e) { return e['Bacteriemia'] === 1 ? 1 : 0; }, def: 'Egresos con hemocultivo positivo no contaminante ÷ todos los egresos (sin hemocultivo = sin bacteriemia detectada).' },
    { n: 'Estancia (días)', nivel: 'ep', tipo: 'mediana', unidad: 'días (mediana)', v: col('Días de estancia'), def: 'Mediana de los días de estancia de los egresos. Denominador = egresos con estancia.' },
    { n: 'Estancia posoperatoria (días)', nivel: 'ep', tipo: 'mediana', unidad: 'días (mediana)', v: enOp(col('Estancia posoperatoria (días)')), def: 'Mediana de los días de la primera cirugía con fecha al egreso.' },
    { n: 'Cirugía en ≤1 día del ingreso', nivel: 'ep', tipo: 'prop', v: enOp(col('Cirugía en ≤1 día del ingreso')), def: 'Operados cuya primera cirugía fue el día del ingreso o el siguiente ÷ operados con las dos fechas. Leerlo por «Dx: …» (apendicitis, colecistitis).' },
    { n: 'Abordaje laparoscópico', nivel: 'cx', tipo: 'prop', v: function (c) { return regTexto(c['Abordaje']) ? (lap(c) ? 1 : 0) : ''; }, def: 'Cirugías laparoscópicas (incluye las convertidas) ÷ cirugías con abordaje elegido en la caja.' },
    { n: 'Conversión a cirugía abierta', nivel: 'cx', tipo: 'prop', v: function (c) { return lap(c) ? (/^Convertida/.test(c['Abordaje']) ? 1 : 0) : null; }, def: 'Convertidas ÷ cirugías que empezaron por laparoscopía (abordaje elegido en la caja).' },
    { n: 'Días de antibiótico por 100 días-paciente', nivel: 'ep', tipo: 'razon', unidad: 'días de antibiótico por 100 días-paciente', v: function (e) {
      var est = e['Días de estancia'], d = e['Días con antibiótico (observados)'], cob = e['Cobertura del diario (%)'];
      if (typeof est !== 'number' || est <= 0) return null;
      return typeof d !== 'number' || typeof cob !== 'number' || cob < 80 ? '' : [d, est];
    }, def: 'Suma de «Días con antibiótico (observados)» ÷ suma de días de estancia × 100, solo en episodios con cobertura del diario ≥ 80 % (los demás van en «Excluidos»). Sin IC.' },
    { n: 'Días de antibiótico Watch o Reserve (AWaRe)', nivel: 'atb', tipo: 'razon', unidad: '% de los días de antibiótico', v: function (a) {
      var d = a['Días de tratamiento'], w = regTexto(a['AWaRe']);
      return typeof d !== 'number' ? null : (!w ? '' : [/Watch|Reserve/.test(w) ? d : 0, d]);
    }, def: 'Días de tratamiento con antibióticos Watch o Reserve (OMS AWaRe) ÷ días de tratamiento con clasificación (los antifúngicos no tienen: «Excluidos»). Suma días de cada curso: dos antibióticos el mismo día cuentan 2. Sin IC.' },
    { n: 'Tromboprofilaxis en operados', nivel: 'ep', tipo: 'prop', v: enOp(function (e) { return e['Tromboprofilaxis (registrada)'] === 1 || e['Días con tromboprofilaxis'] > 0 ? 1 : 0; }), def: 'Operados con la casilla de tromboprofilaxis prendida al egreso o alguna noche ÷ operados. La casilla casi no se llena: subestima.' },
    { n: 'Nutrición parenteral (NPT)', nivel: 'ep', tipo: 'prop', v: function (e) { return e['NPT (registrada)'] === 1 || e['Días con NPT'] > 0 ? 1 : 0; }, def: 'Egresos con NPT registrada (casilla al egreso o alguna noche) ÷ todos los egresos.' },
    { n: 'Ayuno >5 días sin NPT', nivel: 'ep', tipo: 'prop', v: function (e) {
      var cob = e['Cobertura del diario (%)'];
      return e['Ayuno >5 días sin NPT'] === '' || typeof cob !== 'number' || cob < 80 ? '' : e['Ayuno >5 días sin NPT'];
    }, def: 'Egresos con más de 5 noches seguidas en ayuno sin NPT ÷ egresos con el ayuno OBSERVADO: diario con cobertura ≥ 80 % (los demás van en «Excluidos»: con pocas noches fotografiadas no se puede ver una racha de 6).' },
    { n: 'Ayuno posoperatorio (días)', nivel: 'ep', tipo: 'mediana', unidad: 'días (mediana)', v: enOp(col('Ayuno posoperatorio (días)')), def: 'Mediana de las noches en ayuno desde la primera cirugía, en operados con ayuno observado.' }
  ];
})();
/** «Indicadores de calidad»: numerador, denominador, tasa e IC 95 % de Wilson por periodo (mes, trimestre, Acumulado) y
 *  estrato. `eps`, `cxs`, `atbs`: filas de «Análisis · Episodios», «Análisis · Cirugías» y «Análisis · Antibióticos» de
 *  la misma corrida. Universo de episodios: egreso observado, no duplicado ni borrado en la base. Para no gastar celdas: el mes solo lleva
 *  «Todos»; el trimestre, además, Urgencia y Electiva; «Acumulado», también «Dx: …» y «Cirugía: …» con 10 o más. Con
 *  menos de 10 en el denominador no hay tasa (solo n / N). Función pura. */
function regIndicadores_(eps, cxs, atbs) {
  var acc = {}, orden = [], epDe = {};
  var periodos = function (f) { f = regFecha(f); return f ? [f.slice(0, 7), f.slice(0, 4) + '-T' + (Math.floor((+f.slice(5, 7) - 1) / 3) + 1), 'Acumulado'] : []; };
  var estratos = function (urg, dx, grupo) {
    var l = ['Todos'];
    if (urg === 1 || urg === 'Urgencia') l.push('Urgencia'); else if (urg === 0 || urg === 'Electiva') l.push('Electiva');
    if (regTexto(dx)) l.push('Dx: ' + dx);
    if (regTexto(grupo)) l.push('Cirugía: ' + grupo);
    return l;
  };
  var anotar = function (ind, i, fila, pers, ests) {
    var v = ind.v(fila);
    if (v === null || v === undefined) return;
    pers.forEach(function (p, ip) {
      ests.forEach(function (s, is) {
        if (is > 0 && ip === 0) return;                 // el mes solo lleva «Todos»
        if (is > 0 && ip === 1 && /: /.test(s)) return; // el trimestre no lleva Dx ni grupo de cirugía
        var k = p + REG_SEP + i + REG_SEP + s, a = acc[k];
        if (!a) { a = acc[k] = { p: p, i: i, s: s, num: 0, den: 0, excl: 0, vals: [], base: 0 }; orden.push(k); }
        if (v === '' || (ind.tipo !== 'razon' && typeof v !== 'number')) { a.excl++; return; }
        a.base++;
        if (ind.tipo === 'prop') { a.den++; if (v === 1) a.num++; }
        else if (ind.tipo === 'mediana') { a.den++; a.vals.push(v); }
        else { a.num += v[0]; a.den += v[1]; }
      });
    });
  };
  // Ni duplicados (1) ni borrados en la base por revisar (''): los mismos que resta «Flujo de la cohorte».
  var universo = regArr(eps).filter(function (e) { return e && e['Egreso observado'] === 1 && e['Excluir (duplicado)'] === 0; });
  universo.forEach(function (e) {
    var pers = periodos(e['Fecha de egreso']), ests = estratos(e['Urgencia (1.ª cirugía)'], e['Dx principal'], e['Grupo de la 1.ª cirugía']);
    epDe[e['ID episodio']] = { pers: pers, ests: ests };
    REG_INDICADORES.forEach(function (ind, i) { if (ind.nivel === 'ep') anotar(ind, i, e, pers, ests); });
  });
  regArr(cxs).forEach(function (c) {
    if (!c) return;
    var pers = periodos(c['Fecha'] || c['Fecha estimada']), ests = estratos(c['Tipo'], c['Dx principal'], c['Grupo']);
    REG_INDICADORES.forEach(function (ind, i) { if (ind.nivel === 'cx') anotar(ind, i, c, pers, ests); });
  });
  regArr(atbs).forEach(function (a) {
    var x = a && epDe[a['ID episodio']];
    if (x) REG_INDICADORES.forEach(function (ind, i) { if (ind.nivel === 'atb') anotar(ind, i, a, x.pers, x.ests); });
  });
  var rango = function (p) { return p === 'Acumulado' ? 2 : (/-T\d$/.test(p) ? 1 : 0); };
  return orden.map(function (k) { return acc[k]; }).filter(function (a) { return !(/: /.test(a.s) && a.base < REG_INDICADOR_MIN); }).sort(function (a, b) {
    return rango(a.p) - rango(b.p) || a.p.localeCompare(b.p) || a.i - b.i || (a.s === 'Todos' ? 0 : 1) - (b.s === 'Todos' ? 0 : 1) || a.s.localeCompare(b.s);
  }).map(function (a) {
    var ind = REG_INDICADORES[a.i], hay = a.base >= REG_INDICADOR_MIN && a.den > 0, ic = ind.tipo === 'prop' && hay ? regWilson_(a.num, a.den) : ['', ''];
    return { 'Periodo': a.p, 'Indicador': ind.n, 'Estrato': a.s, 'Numerador': ind.tipo === 'mediana' ? '' : a.num, 'Denominador': a.den,
      'Tasa (%)': ind.tipo === 'prop' && hay ? regRedondear(100 * a.num / a.den, 1) : '', 'IC95 inferior': ic[0], 'IC95 superior': ic[1],
      'Valor': !hay || ind.tipo === 'prop' ? '' : (ind.tipo === 'mediana' ? regMediana_(a.vals) : regRedondear(100 * a.num / a.den, 1)), 'Unidad': ind.tipo === 'prop' ? '%' : ind.unidad,
      'Excluidos por dato faltante (n)': a.excl, 'Definición': ind.def, 'Vigente': 'Sí' };
  });
}

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
  var labsDe = porId(fus['Labs']), signosDe = porId(fus['Signos vitales']), cxDe = porId(fus['Cirugías']), movDe = porId(fus[REG_MOVIMIENTOS]);
  var diarioDe = porId(fus[REG_ESTADO_DIARIO]), soporteDe = porId(fus[REG_SOPORTE]), dispDe = porId(fus[REG_DISPOSITIVOS]), drenDe = porId(fus[REG_DRENAJES_DIARIO]);
  var sexosWl = regWlSexosMapa(fus[REG_WL_LABS]);
  var resumenEps = [], resumenCxs = [], porCompletar = [];
  var claveDe = {};
  regArr(clave).forEach(function (r) { var id = regTexto(r && r['ID episodio']).trim(); if (id) claveDe[id] = r; });

  // 1) Partes de una misma hospitalización: restaurar desde la Papelera crea otro id («Continúa en» / «Viene de»).
  var padre = {}, sig = {}, conAnterior = {};
  ids.forEach(function (id) { padre[id] = id; });
  var raiz = function (x) { var r = x; while (padre[r] !== r) r = padre[r]; while (padre[x] !== r) { var n = padre[x]; padre[x] = r; x = n; } return r; };
  var fuentesUnion = {};   // id → { 'Restauración' | 'Mismo ingreso' | 'Contiguo': true } (24 nov 2026)
  var unir = function (de, a, fuente) {
    de = regTexto(de).trim(); a = regTexto(a).trim();
    if (!P[de] || !P[a] || de === a) return;
    (fuentesUnion[de] = fuentesUnion[de] || {})[fuente || 'Restauración'] = true;
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
  // 1b) Episodios partidos (24 nov 2026): la misma hospitalización con varios id SIN restauración de por medio (la tarjeta
  //     se volvió a dar de alta a mano, o el censo de la hoja la retiró y regresó) inflaba egresos. Se unen dos episodios
  //     de la misma persona (mismo expediente válido y nombre compatible) cuando tienen la MISMA fecha de ingreso, o
  //     cuando el siguiente ingresa 0–1 día después del egreso del anterior y ese egreso no dice el motivo. Nunca se une
  //     tras una defunción ni tras un motivo que registró una persona (salvo «no fue egreso»), ni con las tarjetas
  //     duplicadas o borradas en la base (ya van aparte con Excluir).
  var porExp = {}, sinUnir = {};
  ids.forEach(function (id) {
    var r = P[id], exp = regExpValido(r['Expediente']), ing = ingresoDe(id);
    if (!exp || !ing) return;
    var egresado = regTexto(r['Estado en registro']) === 'Egresado';
    var tipo = egresado ? regEgresoTipo(r['Motivo de egreso'], r['Estado clínico']) : '';
    if (/^Duplicado|^Borrado/.test(tipo)) return;
    (porExp[exp] = porExp[exp] || []).push({ id: id, nombre: regTexto(r['Nombre']), ingreso: ing, egreso: egresado ? regFecha(r['Fecha de egreso']) : '', tipo: tipo,
      peso: egresado ? regEgresoPeso(r['Motivo de egreso'], r['Estado clínico']) : 0 });
  });
  Object.keys(porExp).forEach(function (exp) {
    var l = porExp[exp].sort(function (a, b) { return a.ingreso.localeCompare(b.ingreso) || (a.egreso || '9999').localeCompare(b.egreso || '9999') || a.id.localeCompare(b.id); });
    for (var i = 0; i < l.length; i++) for (var j = i + 1; j < l.length; j++) {
      var a = l[i], b = l[j], fuente = '';
      if (raiz(a.id) === raiz(b.id) || !regMismaPersona(a.nombre, b.nombre)) continue;
      var noFue = a.tipo === 'No fue egreso';
      if (a.ingreso === b.ingreso) fuente = 'Mismo ingreso';
      else if (a.egreso) { var d = regDiasSigno(a.egreso, b.ingreso); if (d !== '' && d >= 0 && d <= 1 && (a.peso < 3 || noFue)) fuente = 'Contiguo'; }
      if (!fuente) continue;
      if (a.egreso && !noFue && (a.tipo === 'Defunción' || a.peso >= 4)) { sinUnir[a.id] = sinUnir[b.id] = true; continue; }
      unir(a.id, b.id, fuente);
    }
  });
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
    var fu = {};
    orden.forEach(function (id) { Object.keys(fuentesUnion[id] || {}).forEach(function (f) { fu[f] = true; }); });
    return { raiz: orden[0], partes: orden, ultima: ultima, ingreso: ingresos[0] || '', exp: exp, nombre: regTexto(P[ultima]['Nombre']) || regTexto(P[orden[0]]['Nombre']),
      union: orden.length > 1 ? ['Restauración', 'Mismo ingreso', 'Contiguo'].filter(function (f) { return fu[f]; }) : [] };
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
    if (g.partes.length > 1) g.calidad.push(g.union.some(function (f) { return f !== 'Restauración'; })
      ? g.partes.length + ' partes en el registro unidas por ' + g.union.join(' + ').toLowerCase() + ' (mismo expediente y nombre compatible): se cuentan como un episodio; confirmar que no fue un reingreso'
      : g.partes.length + ' partes en el registro (restaurado desde la Papelera): se cuentan como un episodio');
    if (g.partes.some(function (id) { return sinUnir[id]; })) g.calidad.push('hay otro episodio del mismo expediente con el mismo ingreso que cerró con defunción o con motivo registrado por una persona: no se unieron (revisar)');
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
    g.labs = { fechas: 0, criticos: 0, resumen: {}, serie: {} };
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
      // 24 nov 2026: la serie por fecha de lo que usan KDIGO, la caída de Hb y los valores iniciales (paso 8).
      REG_LAB_SERIE.forEach(function (k) { if (d.valores[k] !== undefined) (g.labs.serie[k] = g.labs.serie[k] || []).push({ f: f, n: d.valores[k] }); });
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
      if (fila['Día de estancia'] === 0 || fila['Día de estancia'] === 1) g.sv01 = true;   // 24 nov 2026: para «Completitud»
    });
  });

  // 5b) Cirugías de cada episodio (24 nov 2026: antes se armaban en el paso 8; los cultivos necesitan sus fechas).
  grupos.forEach(function (g) {
    // Cirugías de todas las partes, sin repetir: por fecha y procedimiento manda la parte más reciente (una cirugía
    // borrada en la tarjeta restaurada no vuelve desde la copia vieja).
    var cxs = [], cxUltima = {}, cxOrden = [], cxAlias = {}, cxInferidas = 0, cxProgramadas = 0;
    g.partes.forEach(function (id) {
      regArr(cxDe[id]).forEach(function (c) {
        var proc = regTexto(c['Procedimiento']).trim(), f = regFecha(c['Fecha']);
        if (!proc && !f) return;
        // 24 nov 2026: con «ID cirugía» la misma cirugía no se cuenta dos veces aunque le hayan corregido el texto o la
        // fecha. Las filas viejas no traen id: la fila con id toma la clave de la que tenga su misma fecha y texto.
        var idCx = regTexto(c['ID cirugía']).trim(), kTxt = 't|' + f + '|' + proc.toUpperCase();
        var kId = idCx ? cxAlias['i|' + idCx] : '', kT = cxAlias[kTxt];
        var k = kId || kT || (idCx ? 'i|' + idCx : kTxt);
        // El id ya tenía clave y este texto era de una fila SIN id (la copia vieja): son la misma cirugía; queda la del id.
        if (kId && kT && kId !== kT && kT.indexOf('t|') === 0) {
          delete cxUltima[kT]; cxOrden.splice(cxOrden.indexOf(kT), 1);
          Object.keys(cxAlias).forEach(function (x) { if (cxAlias[x] === kT) cxAlias[x] = kId; });
        }
        if (idCx) cxAlias['i|' + idCx] = k;
        if (!kT || kT.indexOf('t|') === 0 || !kId) cxAlias[kTxt] = k;
        var prev = cxUltima[k];
        if (!prev) cxOrden.push(k);
        // Manda la parte más reciente; dentro de la misma parte, la fila vigente (la del texto corregido) sobre la que ya no lo es.
        else if (prev.parte === id && regTexto(prev.c['Vigente']) !== 'No' && regTexto(c['Vigente']) === 'No') return;
        cxUltima[k] = { c: c, parte: id };
      });
    });
    cxOrden.forEach(function (k) {
      var c = cxUltima[k].c;
      if (regTexto(c['Vigente']) === 'No') return;
      var fuente = regTexto(c['Fuente']);
      // La programación del día sin confirmar no cuenta como cirugía hecha (va en su propia columna).
      if (/^Programaci/.test(fuente)) { cxProgramadas++; return; }
      if (/inferida|Fecha POP|Texto Qx/.test(fuente)) cxInferidas++;
      cxs.push({ f: regFecha(c['Fecha']), proc: regTexto(c['Procedimiento']).trim(), sangrado: regTexto(c['Sangrado']).trim(), grupo: regTexto(c['Grupo']).trim(),
        tipo: regTexto(c['Tipo']).trim(), abordaje: regTexto(c['Abordaje']).trim(), clavien: regTexto(c['Clavien-Dindo']).trim(), caja: fuente === 'Caja Cirugías',
        id: regTexto(c['ID cirugía']).trim(), fuente: fuente, complicacion: regTexto(c['Complicación']).trim() });
    });
    g.cxs = cxs; g.cxInferidas = cxInferidas; g.cxProgramadas = cxProgramadas;
  });

  // 6) Cultivos del robot: por expediente y nombre, al episodio cuya estancia (desde 2 días antes del ingreso: muestras
  //    de urgencias) contiene la toma. Sin el texto del PDF (trae el nombre del paciente).
  var gruposPorExp = {}, sinEpisodio = {};
  grupos.forEach(function (g) { if (g.exp) (gruposPorExp[g.exp] = gruposPorExp[g.exp] || []).push(g); g.cultivos = { n: 0, pos: 0, germenes: [], conResultado: 0, isq: 0, mdr: 0, sangre: 0, sangrePos: 0, orina: 0, orinaPos3: 0, lista: [] }; });
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
    // 24 nov 2026: sitio, relación con la cirugía más reciente del episodio (anterior o del mismo día de la toma),
    // multirresistencia y contaminante probables.
    var sitio = regCultivoSitio(r['Tipo'], r['Muestra']), mdr = regCultivoMdr(pos, r['Germen'], r['Sensibles'], r['Intermedios'], r['Resistentes']);
    var contaminante = regCultivoContaminante(pos, sitio, r['Germen']), dCx = '';
    if (g && f) g.cxs.forEach(function (c) { var d = c.f ? regDiasSigno(c.f, f) : ''; if (d !== '' && d >= 0 && (dCx === '' || d < dCx)) dCx = d; });
    var posop = g && f ? (dCx !== '' && dCx >= 1 && dCx <= 30 ? 1 : 0) : '';
    out[REG_AN_CULTIVOS].push({ 'ID cultivo': idCult, 'ID episodio': g ? g.codigo : '', 'ID paciente': persona,
      'Fecha de toma': f, 'Hora de toma': hora, 'Día de estancia': g ? regNumCelda(regDiasSigno(g.ingreso, f)) : '', 'Tipo': regTexto(r['Tipo']), 'Muestra': regTexto(r['Muestra']),
      'Resultado': res, 'Positivo': pos, 'Germen': regTexto(r['Germen']), 'Sensibles': regTexto(r['Sensibles']), 'Intermedios': regTexto(r['Intermedios']),
      'Resistentes': regTexto(r['Resistentes']), 'UFC': regTexto(r['UFC']), 'Fuente': regTexto(r['Fuente']), 'Vigente': 'Sí',
      'Sitio (grupo)': sitio, 'Días desde la última cirugía': regNumCelda(dCx), 'Posoperatorio (1-30 d)': posop, 'Multirresistente (probable)': mdr, 'Contaminante probable': contaminante });
    if (!g) return;
    g.cultivos.n++;
    // 24 nov 2026: cada cultivo del episodio, para fechar eventos adversos y para «Análisis · Antibióticos».
    g.cultivos.lista.push({ f: f, real: pos === 1 && contaminante !== 1, sitio: sitio, posop: posop, germen: regTexto(r['Germen']), sens: regTexto(r['Sensibles']), res: regTexto(r['Resistentes']) });
    if (pos !== '') {
      var real = pos === 1 && contaminante !== 1, diaEst = regDiasSigno(g.ingreso, f);
      g.cultivos.conResultado++;
      if (mdr === 1) g.cultivos.mdr = 1;
      if (sitio === 'Sangre') { g.cultivos.sangre++; if (real) g.cultivos.sangrePos++; }
      if (sitio === 'Orina') { g.cultivos.orina++; if (real && diaEst !== '' && diaEst >= 2) g.cultivos.orinaPos3++; }
      if (real && posop === 1 && REG_CULT_SITIOS_ISQ.indexOf(sitio) !== -1) g.cultivos.isq = 1;
    }
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
      g.sig = next || null;   // 24 nov 2026: el episodio siguiente de la persona (paso 8b)
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
    // Sexo: el de la tarjeta (cualquier parte); si no, el de WinLab, y se dice. WinLab con los dos sexos no se usa.
    // 25 nov 2026: si tampoco, el inferido del nombre de pila («Inferido del nombre»); si la tarjeta o WinLab no coinciden
    // con el nombre, mandan ellas y se anota en «Calidad de datos» (solo las letras: nada del nombre).
    var sexo = '', sexoFuente = '', wlSexo = regWlSexoPaciente(sexosWl, g.exp, g.nombre);
    var deWl = function (id) { var f = regTexto(P[id]['Sexo (fuente)']).trim(); return f === REG_SEXO_WL || f === REG_SEXO_NOMBRE; };
    var sexoNombre = regSexoDeNombre(g.nombre || u['Nombre']);
    g.partes.some(function (id) { sexo = deWl(id) ? '' : regSexo(P[id]['Sexo']); return !!sexo; });
    if (sexo) {
      sexoFuente = REG_SEXO_TARJETA;
      if ((wlSexo === 'F' || wlSexo === 'M') && wlSexo !== sexo) g.calidad.push('el sexo de la tarjeta (' + sexo + ') no coincide con el de WinLab (' + wlSexo + '): revisar');
    } else if (wlSexo !== '?') {
      sexo = wlSexo;
      if (!sexo) g.partes.some(function (id) { sexo = regTexto(P[id]['Sexo (fuente)']).trim() === REG_SEXO_WL ? regSexo(P[id]['Sexo']) : ''; return !!sexo; });
      if (sexo) sexoFuente = REG_SEXO_WL;
    }
    if (!sexo && sexoNombre) { sexo = sexoNombre; sexoFuente = REG_SEXO_NOMBRE; }
    else if (sexo && sexoNombre && sexoNombre !== sexo) g.calidad.push('el sexo inferido del nombre (' + sexoNombre + ') no coincide con el de ' + (sexoFuente === REG_SEXO_TARJETA ? 'la tarjeta' : 'WinLab') + ' (' + sexo + '): manda ' + (sexoFuente === REG_SEXO_TARJETA ? 'la tarjeta' : 'WinLab'));
    if (wlSexo === '?') g.calidad.push('WinLab trae los dos sexos para este expediente y nombre: no se usó');
    if (!sexo) g.calidad.push('sin sexo registrado');
    g.sexo = sexo; g.sexoFuente = sexoFuente;   // 25 nov 2026: para «Seguimiento de operados»
    var estancia = regDiasSigno(g.ingreso, g.fin);
    if (estancia !== '' && estancia < 0) { g.calidad.push('el egreso es anterior al ingreso'); estancia = ''; }
    // 24 nov 2026: las cirugías del episodio se arman en el paso 5b (los cultivos necesitan sus fechas).
    var cxs = g.cxs, cxInferidas = g.cxInferidas, cxProgramadas = g.cxProgramadas;
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
    // Reintervención planeada / no planeada (24 nov 2026). La índice es la primera por fecha (las sin fecha, al final).
    // De la 2.ª en adelante: planeada si el texto lo dice; el resto cuenta como NO planeada si fue ≤30 días de la índice.
    // Sin fecha solo se sabe que fue ≤30 días cuando todo lo que siguió a la índice duró ≤30 días; si no, queda vacío.
    // Una relaparotomía como única cirugía registrada también es no planeada (la índice no se capturó).
    // 24 nov 2026 (revisión): no toda 2.ª cirugía es una reintervención. No cuentan los procedimientos menores
    // (endoscopia / CPRE, traqueostomía, catéteres, punciones: REG_CX_MENOR), ni como índice ni como reintervención (la
    // índice es la primera cirugía que NO es menor: «CPRE y dos días después colecistectomía» es la secuencia normal); ni
    // lo del MISMO día que la índice (otro renglón de la misma cirugía); y la que se eligió «Electiva» en la caja cuenta
    // como planeada. c.rFuerte: el texto o el grupo dicen que fue una reintervención (para el grado del evento).
    var reintPlan = '', reintNoPlan = '', dudosas = 0;
    if (cxs.length) {
      reintPlan = 0; reintNoPlan = 0;
      var indice = null;
      cxOrd.forEach(function (c) {
        var txt = regNorm_(c.proc), planeada = REG_CX_REINT_PLANEADA.test(txt);
        c.rPlan = 0; c.rNoPlan = 0;   // por cirugía, para «Análisis · Cirugías»
        c.rFuerte = c.grupo === 'Relaparotomía' || REG_CX_REINT_TEXTO.test(txt);
        if (c.grupo !== 'Relaparotomía' && regCxMenor_(c)) return;
        if (!indice) { indice = c; if (c.grupo === 'Relaparotomía' && !planeada) { reintNoPlan = 1; c.rNoPlan = 1; } return; }
        if (planeada || (c.tipo === 'Electiva' && !c.rFuerte)) { reintPlan = 1; c.rPlan = 1; return; }
        var d = indice.f && c.f ? regDiasSigno(indice.f, c.f) : '';
        if (d === 0 && !c.rFuerte) return;
        if (d === '') { var hasta = indice.f ? regDiasSigno(indice.f, g.fin) : estancia; d = hasta !== '' && hasta >= 0 && hasta <= 30 ? hasta : ''; }
        if (d === '') { dudosas++; c.rNoPlan = ''; } else if (d <= 30) { reintNoPlan = 1; c.rNoPlan = 1; }
      });
      if (!reintNoPlan && dudosas) { reintNoPlan = ''; g.calidad.push('reintervención sin fecha: no se sabe si fue en los 30 días de la primera cirugía (no planeada queda vacía)'); }
    }
    var sinFechaCx = cxs.filter(function (c) { return !c.f; }).length;
    if (sinFechaCx) g.calidad.push(sinFechaCx + ' cirugía' + (sinFechaCx === 1 ? '' : 's') + ' sin fecha: en el Resumen mensual se cuenta' + (sinFechaCx === 1 ? '' : 'n') + ' en el mes del ingreso');
    var diasACx = fechasCx[0] ? regDiasSigno(g.ingreso, fechasCx[0]) : '', postop = fechasCx[0] ? regDiasSigno(fechasCx[0], g.fin) : '';
    // 24 nov 2026 (revisión): la cirugía con fecha ANTERIOR al ingreso (operado antes de llegar, o una fecha POP previa)
    // no mide oportunidad quirúrgica ni estancia posoperatoria de este episodio: quedan vacías y se dice.
    var cxAntes = diasACx !== '' && diasACx < 0;
    if (cxAntes) { g.calidad.push('la primera cirugía tiene fecha anterior al ingreso: sin «Cirugía en ≤1 día del ingreso» ni estancia posoperatoria'); postop = ''; }
    // Dx principal: el de la tarjeta (elegido o inferido al construir Pacientes); filas viejas sin la columna → del DX.
    var dxP = { label: regTexto(u['Dx principal']).trim(), cie: regTexto(u['CIE-10 (grupo)']).trim(), fuente: regTexto(u['Dx principal (fuente)']).trim() };
    if (!dxP.label) dxP = regDxPrincipal('', regTexto(u['Diagnóstico']));
    var si = function (col) { return regTexto(u[col]).trim() ? 1 : 0; };
    var siMarca = function (col) { return /^Sí/.test(regTexto(u[col]).trim()) ? 1 : 0; };
    // 24 nov 2026 (revisión): Especialidad y Sección pasan por regValorCenso_ (como en «Estado diario»): la sección del
    // censo trae texto corrido de la hoja, a veces un nombre, y esta pestaña es la seudonimizada que se comparte.
    var fila = {
      'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Partes del registro': g.partes.length, 'N.º de episodio del paciente': g.numero || '',
      'Días desde el egreso previo': regNumCelda(g.diasPrevio), 'Es reingreso (≤30 días)': regNumCelda(g.esReingreso), 'Reingreso a 30 días': regNumCelda(g.reingreso30),
      'Edad (años)': edad, 'Sexo': sexo, 'Sexo (fuente)': sexoFuente, 'Especialidad': regValorCenso_('esp', u['Especialidad']), 'Sección': regValorCenso_('seccion', u['Sección']),
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
      'Calidad de datos': g.calidad.filter(function (x, i, a) { return a.indexOf(x) === i; }).join('; '), 'Vigente': 'Sí',
      'Unión (fuente)': g.union.join(' + '), 'Cirugías sin fecha (n)': sinFechaCx,
      'Reintervención planeada (probable)': reintPlan, 'Reintervención no planeada (probable)': reintNoPlan,
      'Estancia posoperatoria (días)': postop !== '' && postop >= 0 ? postop : '', 'Cirugía en ≤1 día del ingreso': diasACx === '' || cxAntes ? '' : (diasACx <= 1 ? 1 : 0)
    };
    fila['Defunción posoperatoria (hospitalaria)'] = cxs.length ? fila['Defunción'] : '';
    var mov = regMovEpisodio_(g.partes.map(function (id) { return { movs: movDe[id], fila: P[id] }; }), g.ingreso, g.fin);
    REG_EP_MOV.forEach(function (c) { fila[c] = mov[c]; });
    // ── 24 nov 2026 (lote C): días observados, laboratorio, cultivos y ajuste de riesgo. Todo sale de lo ya fusionado.
    var cx1F = fechasCx[0] || '', todas = function (m) { var l = []; g.partes.forEach(function (id) { regArr(m[id]).forEach(function (r) { l.push(r); }); }); return l; };
    var diario = regDiarioEpisodio_({ noches: todas(diarioDe), soporte: todas(soporteDe), disp: todas(dispDe), dren: todas(drenDe), ingreso: g.ingreso,
      ultimaNoche: g.estado === 'Egresado' ? regFechaMas_(g.fin, -1) : g.fin, estancia: estancia, cx1: cx1F });
    REG_EP_DIARIO.forEach(function (c) { fila[c] = diario[c]; });
    var lab = regLabsEpisodio_(g.labs.serie, cx1F, sexo, edad);
    REG_EP_LAB.forEach(function (c) { fila[c] = lab[c]; });
    // Cultivos: 0 solo si hubo con qué saberlo (cirugía con fecha; hemocultivo o urocultivo con resultado; algún cultivo con resultado).
    var textoIsq = g.partes.map(function (id) { return ['Diagnóstico', 'Manejo', 'Pendientes', 'Cronología'].map(function (c) { return regTexto(P[id][c]); }).join('\n'); })
      .concat(cxs.map(function (c) { return c.complicacion; })).join('\n');
    fila['ISQ probable (cultivo)'] = cx1F ? g.cultivos.isq : '';
    fila['ISQ mencionada (texto)'] = regIsqTexto(textoIsq) ? 1 : (cxs.length ? 0 : '');
    fila['Bacteriemia'] = g.cultivos.sangre ? (g.cultivos.sangrePos ? 1 : 0) : '';
    fila['Urocultivo positivo ≥ día 3'] = g.cultivos.orina ? (g.cultivos.orinaPos3 ? 1 : 0) : '';
    fila['Germen multirresistente'] = g.cultivos.conResultado ? g.cultivos.mdr : '';
    // Charlson simplificado y riesgo preoperatorio (puntaje INTERNO, no validado): 1 punto por edad ≥70, Charlson ≥3,
    // cirugía de urgencia (elegida en la caja o, si no se eligió, en ≤1 día del ingreso), albúmina inicial <3.5, anemia
    // al ingreso y creatinina inicial ≥1.5. Solo con cirugía, edad y APP; el laboratorio que falta cuenta 0.
    var ext = regComorbilidades(appTxt, dxTxt, REG_COMORB_1124), ch = regCharlson_(com, ext, edad, !!appTxt.trim());
    REG_COMORB_1124.forEach(function (c) { fila[c[0]] = ext[c[0]]; });
    fila['Charlson (puntos)'] = ch.puntos; fila['Charlson ajustado por edad'] = ch.conEdad; fila['Charlson (calculable)'] = ch.calculable;
    var crInicial = regArr(g.labs.serie.cr).length ? g.labs.serie.cr[0].n : '';
    var urgente = cx1.tipo === 'Urgencia' || (!cx1.tipo && diasACx !== '' && diasACx >= 0 && diasACx <= 1);
    fila['Riesgo preoperatorio simple (0-6)'] = cxs.length && ch.calculable && edad !== '' ? (edad >= 70 ? 1 : 0) + (ch.puntos >= 3 ? 1 : 0) + (urgente ? 1 : 0)
      + (lab['Hipoalbuminemia (<3.5)'] === 1 ? 1 : 0) + (lab['Anemia al ingreso (OMS)'] === 1 ? 1 : 0) + (crInicial !== '' && crInicial >= 1.5 ? 1 : 0) : '';
    // Una fila por cirugía («Análisis · Cirugías»): en orden de fecha (las sin fecha al final). Sin las tarjetas duplicadas.
    if (g.excluir !== 1) {
      var previaF = '', idsCx = {};
      cxOrd.forEach(function (c, i) {
        var base = g.codigo + '|' + (c.id ? 'i|' + c.id : 't|' + c.f + '|' + c.proc.toUpperCase()), idQ, k = 0;
        do { idQ = codigo('Q', base + (k ? '#' + k : ''), true); k++; } while (idsCx[idQ]);
        idsCx[idQ] = true;
        var sx = c.sangrado ? regNumero(c.sangrado, { unidad: /^(ML|CC)$/, prefijo: /^(APROX(IMADAMENTE|\.)?|CA\.)\s*/, miles: true }) : null;
        var sangradoMl = sx && !sx.comp && sx.n >= 0 && sx.n <= 50000 ? sx.n : '', dIng = c.f ? regDiasSigno(g.ingreso, c.f) : '';
        var revisar = [];
        if (!c.f) revisar.push('sin fecha');
        if (!c.caja) revisar.push('tomada de otra caja (' + c.fuente + '): pasarla a la caja Cirugías');
        if (c.sangrado && sangradoMl === '') revisar.push('sangrado sin número');
        if (c.caja && (!c.tipo || !c.abordaje || !c.clavien)) revisar.push('sin urgencia / abordaje / Clavien-Dindo');
        if (c.rNoPlan === '') revisar.push('reintervención sin fecha: no se sabe si fue en los 30 días de la índice');
        out[REG_AN_CIRUGIAS].push({ 'ID cirugía': idQ, 'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Fecha': c.f, 'N.º de cirugía en el episodio': i + 1,
          'Día de estancia': regNumCelda(dIng), 'Días desde la cirugía previa': c.f && previaF ? regNumCelda(regDiasSigno(previaF, c.f)) : '', 'Grupo': c.grupo, 'Procedimiento': c.proc, 'Tipo': c.tipo,
          'Urgencia inferida (día 0-1)': dIng === '' || dIng < 0 ? '' : (dIng <= 1 ? 1 : 0), 'Abordaje': c.abordaje, 'Abordaje (inferido del texto)': regCxAbordajeTexto(c.proc), 'Clavien-Dindo': c.clavien,
          'Sangrado (mL)': sangradoMl, 'Fuente': c.fuente, 'Es índice': i ? 0 : 1, 'Reintervención planeada (probable)': c.rPlan, 'Reintervención no planeada (probable)': c.rNoPlan,
          'Días cirugía→egreso': c.f && g.egreso ? regNumCelda(regDiasSigno(c.f, g.egreso)) : '', 'Defunción en el episodio': fila['Defunción'], 'Dx principal': dxP.label, 'Edad (años)': edad,
          'Fecha estimada': c.f ? '' : (g.ingreso || g.egreso), 'Revisar': revisar.join('; '), 'Vigente': 'Sí' });
        if (c.f) previaF = c.f;
      });
    }
    REG_LAB_RESUMEN.forEach(function (r, i) { fila[r[2]] = regNumCelda(g.labs.resumen[i]); });
    var nCom = 0;
    REG_COMORB.forEach(function (c) { fila[c[0]] = com[c[0]]; if (com[c[0]] === 1 && c[0] !== 'Tabaquismo') nCom++; });
    fila['Comorbilidades (n)'] = appTxt.trim() ? nCom : '';   // sin APP el conteo no es confiable (el DX no las enlista)
    // 24 nov 2026: las columnas de apoyo y de eventos adversos se llenan en el paso 8b (necesitan el episodio siguiente).
    REG_EP_LOTE_C2.forEach(function (c) { fila[c] = ''; });
    g.fila = fila; g.aux = { cxOrd: cxOrd, cx1F: cx1F, diario: diario, lab: lab, mov: mov, dxP: dxP.label };
    out[REG_AN_EPISODIOS].push(fila);

    // Por completar (con nombres, para el equipo): hospitalizados y egresados de los últimos 30 días. 24 nov 2026: el
    // egresado SIN MOTIVO entra sin límite de días (el motivo registrado después sí llega al registro) y va primero; la
    // talla no se pide (25 nov 2026: ya no se mide en ningún lado). El sexo inferido del nombre ya no se pide.
    var falta = [];
    if (g.estado === 'Egresado' && fila['Defunción'] === '' && g.tipo !== 'No fue egreso') falta.push('motivo del egreso');
    if (!sexo) falta.push('sexo');
    if (edad === '') falta.push('edad');
    if (!appTxt.trim()) falta.push('APP');
    if (pt.peso === '') falta.push('peso');
    // 30 oct 2026: el que la app pone sola con el DX («Inferido del DX») ya cuenta; solo falta si el DX no coincide con ninguno.
    if (!dxP.label) falta.push('dx principal');
    if (cxInferidas) falta.push(cxInferidas + (cxInferidas === 1 ? ' cirugía por pasar a la caja Cirugías' : ' cirugías por pasar a la caja Cirugías'));
    if (sinClas) falta.push(sinClas + (sinClas === 1 ? ' cirugía sin urgencia/abordaje/Clavien' : ' cirugías sin urgencia/abordaje/Clavien'));
    var dEgreso = g.egreso ? regDiasSigno(g.egreso, hoy) : '', sinMotivo = falta[0] === 'motivo del egreso';
    if (falta.length && g.excluir !== 1 && (g.estado === 'Hospitalizado' || sinMotivo || (dEgreso !== '' && dEgreso >= 0 && dEgreso <= 30))) {
      porCompletar.push({ sinMotivo: sinMotivo, egreso: g.egreso, n: porCompletar.length, fila: { 'ID episodio': g.ultima, 'Estado': g.estado, 'Cama': regTexto(u['Cama']), 'Nombre': regTexto(u['Nombre']), 'Expediente': regTexto(u['Expediente']),
        'Fecha de ingreso': g.ingreso, 'Fecha de egreso': g.egreso, 'Falta': falta.join(' · '), 'Faltantes (n)': falta.length, 'Vigente': 'Sí' } });
    }
    // Para el resumen mensual.
    resumenEps.push({ ingreso: g.ingreso, egreso: fila['Egreso observado'] === 1 ? g.egreso : '', defuncion: fila['Defunción'], estancia: fila['Días de estancia'],
      reint: fila['Reintervención'], reintNoPlan: reintNoPlan, re30: fila['Reingreso a 30 días'], dx: dxP.label, incompleto: falta.length > 0, excluir: g.excluir, sexo: sexo ? 1 : 0, sinLabs: g.labs.fechas ? 0 : 1 });
    // 24 nov 2026: la cirugía sin fecha (casi todas las inferidas) ya no se pierde del Resumen mensual: va al mes del
    // ingreso del episodio (o del egreso) y se cuenta aparte como «sin fecha exacta».
    if (g.excluir !== 1) cxs.forEach(function (c) { resumenCxs.push({ f: c.f, fEstimada: c.f ? '' : (g.ingreso || g.egreso), grupo: c.grupo, tipo: c.tipo, abordaje: c.abordaje, clavien: c.clavien, ep: g.codigo }); });
  });
  // 8b) 24 nov 2026 (lote C, 2.ª parte): columnas de apoyo, eventos adversos y antibióticos por curso. Va después del
  //     paso 8 porque el reingreso necesita ya calculado el episodio SIGUIENTE de la persona. Todo sale de lo fusionado.
  var wlPers = regWlPersonas_(fus[REG_WL_LABS]), risDe = porId(fus[REG_RIS]), guardiaDe = porId(fus['Guardia y cronología']), cortesDe = porId(fus[REG_GUARDIA_CORTES]);
  grupos.forEach(function (g) {
    var fila = g.fila, a = g.aux, u = P[g.ultima], nx = g.sig, wl = regWlDeLaPersona_(wlPers, g.exp, g.nombre);
    // Edad calculada: solo si WinLab trae UNA fecha de nacimiento para la persona (la fecha no pasa al análisis).
    var nacs = {};
    wl.forEach(function (x) { Object.keys(x.nacs).forEach(function (n) { nacs[n] = true; }); });
    nacs = Object.keys(nacs);
    fila['Edad al ingreso (calculada)'] = nacs.length === 1 ? regEdadEnFecha_(nacs[0], g.ingreso) : '';
    fila['Periodo de captura'] = g.fin < REG_CAPTURA_ESTRUCTURADA ? 'Anterior a la captura estructurada' : 'Estructurada';
    var egresado = fila['Egreso observado'] === 1, def = fila['Defunción'];
    fila['Desenlace conocido'] = egresado ? (def === '' ? 0 : 1) : '';
    // Tipo de egreso PROBABLE: solo en el egresado sin motivo. Nunca toca «Defunción» ni «Tipo de egreso».
    var dn = egresado && nx && def !== 1 ? regDiasSigno(g.egreso, nx.ingreso) : '';
    if (dn !== '' && dn < 0) dn = '';
    // 25 nov 2026: el motivo registrado que tomó el script del censo de su sección ALTAS o DEFUNCIONES lo dice aquí.
    var fuenteReg = egresado ? regEgresoFuente_(g.motivo) : '';
    if (fuenteReg === 'censo-altas') fila['Fuente del tipo'] = 'Censo (hoja): sección ALTAS';
    else if (fuenteReg === 'censo-defunciones') fila['Fuente del tipo'] = 'Censo (hoja): sección DEFUNCIONES';
    else if (fuenteReg === 'censo') fila['Fuente del tipo'] = 'Censo (hoja)';
    if (egresado && def === '') {
      var renglones = [regTexto(u['Pendientes']), regTexto(u['Guardia vigente'])];
      regArr(guardiaDe[g.ultima]).forEach(function (r) { if (regTexto(r['Vigente']) !== 'No') renglones.push(regTexto(r['Renglón'])); });
      regArr(cortesDe[g.ultima]).forEach(function (r) { renglones.push(regTexto(r['Renglón'])); });
      var tTxt = regEgresoTexto_(renglones.join('\n'));
      var despues = function (f) { var d = regDiasSigno(g.egreso, f); return d !== '' && d >= 1 && d <= 30; };
      if (tTxt) { fila['Tipo de egreso (probable)'] = tTxt; fila['Fuente del tipo'] = 'Texto de guardia, cronología o pendientes'; }
      else if (dn !== '') { fila['Tipo de egreso (probable)'] = 'Volvió al censo'; fila['Fuente del tipo'] = 'Episodio posterior de la misma persona'; }
      else if (wl.some(function (x) { return Object.keys(x.fechasHosp).some(despues); }) || g.partes.some(function (id) { return regArr(risDe[id]).some(function (r) { return despues(r['Fecha']); }); })) {
        fila['Tipo de egreso (probable)'] = 'Sigue en el hospital'; fila['Fuente del tipo'] = 'Labs de WinLab o imagen del RIS posteriores al egreso';
      }
    }
    // Reingreso: el episodio siguiente de la persona (cualquier plazo) y si era planeado.
    var planeado = '';
    if (dn !== '') {
      var dxNx = nx.partes.map(function (id) { return regTexto(P[id]['Diagnóstico']); }).join('\n');
      var txtNx = nx.partes.map(function (id) { return regTexto(P[id]['Padecimiento (PA)']); }).concat(nx.cxs.map(function (c) { return c.proc; })).join('\n');
      planeado = regReingresoPlaneado_(dxNx, txtNx, (nx.aux.cxOrd[0] || {}).tipo === 'Electiva');
      fila['Días al reingreso'] = dn; fila['Dx principal del reingreso'] = nx.aux.dxP; fila['Reingreso planeado (probable)'] = planeado;
    }
    var r30 = fila['Reingreso a 30 días'];
    fila['Reingreso no planeado a 30 días'] = r30 === 1 ? (planeado === 1 ? 0 : 1) : (r30 === 0 ? 0 : '');
    fila['Reingreso con cirugía'] = r30 === 1 ? (nx && nx.cxs.length ? 1 : 0) : (r30 === 0 ? 0 : '');
    var seg = egresado && def !== 1 ? regDiasSigno(g.egreso, hoy) : '';
    fila['Seguimiento posalta observable (días)'] = seg === '' ? '' : Math.max(0, Math.min(REG_SEGUIMIENTO_MAX, seg));
    if (g.excluir === 1) return;   // la tarjeta duplicada no tiene eventos ni cursos propios

    // Eventos adversos (catálogo cerrado). Objetivo = de un dato estructurado o de laboratorio; el resto, mención en texto.
    var evs = [], cx1 = a.cx1F, O = REG_CERTEZA_OBJ, T = REG_CERTEZA_TXT;
    var ev = function (evento, fecha, fuente, certeza, grado, minDia, x) {
      fecha = regFecha(fecha); x = x || {};
      var multiple = REG_EVENTOS_MULTIPLES.indexOf(evento) !== -1;
      // Uno por evento (los que se repiten: uno por fecha; la mención en texto no se suma a uno que ya está).
      if (evs.some(function (y) { return y.e === evento && (!multiple || certeza === T || y.f === fecha); })) return;
      var dia = cx1 && fecha ? regDiasSigno(cx1, fecha) : '';
      // ¿Cuenta para el Clavien inferido? La mención siempre; lo objetivo con día mínimo, solo desde ese día posoperatorio
      // (x.noCuenta: ya existía antes de la cirugía, o no se puede saber que es nuevo).
      evs.push({ e: evento, f: fecha, dia: dia, fuente: fuente, c: certeza, g: grado, detalle: x.detalle || '', oc: multiple ? (fecha || REG_EVENTO_SIN_FECHA) : REG_EVENTO_UNICO,
        cuenta: !x.noCuenta && (certeza === T || minDia === undefined || (dia !== '' && dia >= minDia)) });
    };
    // Soporte (vasopresor, ventilación) NUEVO después de la cirugía (24 nov 2026, revisión): las noches seguidas forman un
    // tramo (un hueco de hasta 3 días sin foto no lo corta); el tramo que ya venía del día de la cirugía o de antes es el
    // choque que llevó a operar, no una complicación. → { f: primera noche del primer tramo posoperatorio nuevo, o la
    // primera noche con soporte si no hay ninguno; nuevo: ¿lo hay? }. Sin cirugía con fecha: la primera noche.
    var soporteNuevo = function (l) {
      l = regArr(l).slice().sort();
      if (!cx1 || !l.length) return { f: l[0] || '', nuevo: true };
      var fotos = (a.diario.__dias || {}).fotos || {}, ini = l[0], previo = l[0], hallado = '';
      var cierra = function (fin) { if (!hallado && regDiasSigno(cx1, ini) >= 1 && fin) hallado = ini; };
      l.slice(1).forEach(function (d) {
        var hueco = regDiasSigno(previo, d), corta = hueco > 3;
        for (var f = regFechaMas_(previo, 1); !corta && f < d; f = regFechaMas_(f, 1)) if (fotos[f]) corta = true;
        if (corta) { cierra(previo); ini = d; }
        previo = d;
      });
      cierra(previo);
      return { f: hallado || l[0], nuevo: !!hallado };
    };
    var cultivoDe = function (f) { return g.cultivos.lista.filter(f).map(function (c) { return c.f; }).filter(Boolean).sort()[0] || ''; };
    if (g.tipo === 'Defunción') ev('Defunción', g.egreso, 'Motivo de egreso', O, 'V');
    // 24 nov 2026 (revisión): solo la relaparotomía o la cirugía cuyo texto dice reintervención / complicación es un
    // evento objetivo de grado IIIb; la 2.ª cirugía que solo lo parece por fechas queda «Probable», sin grado, a revisar.
    a.cxOrd.forEach(function (c) { if (c.rNoPlan === 1) ev('Reintervención no planeada', c.f, 'Cirugías', c.rFuerte ? O : REG_CERTEZA_PROB, c.rFuerte ? 'IIIb' : ''); });
    if (fila['Reingreso no planeado a 30 días'] === 1) ev('Reingreso 30 d', nx.ingreso, 'Episodio siguiente de la persona', O, '');
    // LRA: el estadio va en «Detalle» (si sube de estadio el renglón es el mismo). Solo cuenta para el Clavien la que se
    // puede saber POSOPERATORIA (creatinina hasta el día de la cirugía sin criterio y criterio en los días 1-7).
    if (a.lab['LRA KDIGO (estadio máx.)'] >= 1) ev('LRA (KDIGO)', a.lab['Fecha de LRA'], 'Laboratorio (creatinina)', O, 'I', 1, { detalle: 'Estadio ' + a.lab['LRA KDIGO (estadio máx.)'], noCuenta: a.lab['LRA posoperatoria'] !== 1 });
    if (fila['ISQ probable (cultivo)'] === 1) ev('ISQ probable', cultivoDe(function (c) { return c.real && c.posop === 1 && REG_CULT_SITIOS_ISQ.indexOf(c.sitio) !== -1; }), 'Cultivo', O, 'I');
    else if (fila['ISQ mencionada (texto)'] === 1) ev('ISQ probable', '', 'Texto de la tarjeta', T, 'I');
    if (fila['Bacteriemia'] === 1) ev('Bacteriemia', cultivoDe(function (c) { return c.real && c.sitio === 'Sangre'; }), 'Hemocultivo', O, 'II', 1);
    var dd = a.diario.__dias || {};
    [['Vasopresor', dd.vp], ['Ventilación', dd.vm]].forEach(function (s) {
      if (!regArr(s[1]).length) return;
      var n = soporteNuevo(s[1]);
      ev(s[0], n.f, 'Estado diario o historial', O, 'IVa', 1, { noCuenta: !n.nuevo, detalle: n.nuevo || !cx1 ? '' : 'Ya lo tenía el día de la cirugía o antes' });
    });
    if (a.mov['Pasó por UCI'] === 1) ev('UCI', '', 'Movimientos del censo', O, '');
    g.partes.forEach(function (id) {
      regArr(risDe[id]).forEach(function (r) { if (regNorm_(r['Modalidad']).trim() === 'XA' && REG_XA_DRENAJE.test(regNorm_(r['Estudios']))) ev('Drenaje percutáneo', r['Fecha'], 'RIS (intervencionismo)', O, 'IIIa', 1); });
    });
    var txtGen = regNorm_(g.partes.map(function (id) { return ['Manejo', 'Pendientes', 'Cronología', 'Guardia vigente'].map(function (c) { return regTexto(P[id][c]); }).join('\n'); })
      .concat(g.cxs.map(function (c) { return c.complicacion; })).join('\n'));
    var txtDx = regNorm_(g.partes.map(function (id) { return regTexto(P[id]['Diagnóstico']); }).join('\n'));
    REG_EVENTOS_TEXTO.forEach(function (t) {
      // Primero una prueba barata sobre todo el texto; la regla de negación (por oración) solo si hay coincidencia.
      if (t[1].test(txtGen) && regMencion_(txtGen, t[1], t[4])) ev(t[0], '', 'Texto de la tarjeta (manejo, pendientes, cronología o guardia)', T, t[2]);
      else if (t[3] && t[1].test(txtDx) && regMencion_(txtDx, t[1], t[4])) ev(t[0], '', 'Texto del diagnóstico', T, t[2]);
    });
    evs.forEach(function (x) {
      out[REG_AN_EVENTOS].push({ 'ID episodio': g.codigo, 'ID paciente': g.persona.codigo, 'Evento': x.e, 'Ocurrencia': x.oc, 'Fecha': x.f, 'Día posoperatorio': regNumCelda(x.dia), 'Detalle': x.detalle, 'Fuente': x.fuente, 'Certeza': x.c,
        'Grado Clavien mínimo implícito': x.g, 'Revisado': '', 'Vigente': 'Sí' });
    });
    fila['Eventos adversos (n)'] = evs.length;
    // Clavien-Dindo mínimo inferido: solo en operados; es un PISO. El elegido en la caja («Clavien-Dindo máximo») no se toca.
    if (g.cxs.length) {
      var mejor = -1, mejorObj = -1;
      evs.forEach(function (x) {
        var i = REG_CLAVIEN_ORDEN.indexOf(x.g);
        if (i < 0 || !x.cuenta) return;
        if (i > mejor) mejor = i;
        if (x.c === O && i > mejorObj) mejorObj = i;
      });
      fila['Clavien-Dindo mínimo inferido'] = mejor >= 0 ? REG_CLAVIEN_ORDEN[mejor] : REG_SIN_EVENTO;
      fila['Complicación mayor inferida (≥ IIIa)'] = mejor >= 3 ? 1 : 0;
      fila['Clavien (fuente)'] = mejor < 0 ? '' : (mejorObj >= mejor ? O : T);
    }
    // Antibióticos por curso («Análisis · Antibióticos»).
    var todas = function (m) { var l = []; g.partes.forEach(function (id) { regArr(m[id]).forEach(function (r) { l.push(r); }); }); return l; };
    regAtbCursos_({ noches: todas(diarioDe), soporte: todas(soporteDe), ingreso: g.ingreso, ultimaNoche: g.estado === 'Egresado' ? regFechaMas_(g.fin, -1) : g.fin, egresado: g.estado === 'Egresado',
      cxFechas: g.cxs.map(function (c) { return c.f; }), cultivos: g.cultivos.lista, conExp: !!g.exp }).forEach(function (r) {
      r['ID episodio'] = g.codigo; r['ID paciente'] = g.persona.codigo;
      out[REG_AN_ATB].push(r);
    });
  });
  // Primero los egresados sin motivo (el egreso más reciente arriba); después los demás, en su orden. Las filas que ya
  // estaban en la hoja conservan su renglón: el orden solo se nota en las filas nuevas.
  porCompletar.sort(function (a, b) { return (a.sinMotivo ? 0 : 1) - (b.sinMotivo ? 0 : 1) || (a.sinMotivo ? regTexto(b.egreso).localeCompare(regTexto(a.egreso)) : 0) || a.n - b.n; });
  out[REG_POR_COMPLETAR] = porCompletar.map(function (x) { return x.fila; });
  out[REG_AN_RESUMEN] = regResumenMensual(resumenEps, resumenCxs, out[REG_AN_CULTIVOS], fus[REG_PROC_CENSO]);
  // 25 nov 2026 (registro 2026.11.26-2): seguimiento de operados (con nombres).
  out[REG_SEGUIMIENTO] = regSeguimientoOperados_({ procs: fus[REG_PROC_CENSO], personas: listaPersonas, P: P, sexosWl: sexosWl, hoy: hoy });
  // 24 nov 2026: completitud por mes, flujo de la cohorte e indicadores de calidad (solo cuentas), de las filas de esta corrida.
  out[REG_AN_COMPLETITUD] = regCompletitud_(grupos.map(function (g) { return { e: g.fila, exp: !!g.exp, sv01: !!g.sv01 }; }), out[REG_AN_CIRUGIAS]);
  out[REG_AN_FLUJO] = regFlujo_(out[REG_AN_EPISODIOS], { cultivosSinEpisodio: out[REG_AN_CULTIVOS].filter(function (c) { return !c['ID episodio']; }).length,
    expedientesWinLabSinEpisodio: Object.keys(wlPers).filter(function (e) { return !gruposPorExp[e]; }).length });
  out[REG_AN_INDICADORES] = regIndicadores_(out[REG_AN_EPISODIOS], out[REG_AN_CIRUGIAS], out[REG_AN_ATB]);
  out.avisos = avisos;
  return out;
}

/** Resumen mensual del servicio: ingresos por mes de ingreso; egresos, mortalidad, estancia y reingresos por mes de
 *  egreso; cirugías por mes de la cirugía; cultivos por mes de toma. Sin duplicados (Excluir = 1). Solo cuentas. */
function regResumenMensual(eps, cxs, cultivos, procs) {
  var meses = {}, mes = function (f) { f = regFecha(f); return f ? f.slice(0, 7) : ''; };
  var M = function (m) { return meses[m] || (meses[m] = { ing: 0, egr: [], cx: [], cult: [], dx: {}, incompletos: 0, conSexo: 0, sinLabs: 0, proc: 0, procCg: 0, procAmb: 0 }); };
  // 25 nov 2026: procedimientos del censo por mes de su fecha (filas vigentes de «Procedimientos del censo»).
  regArr(procs).forEach(function (r) {
    var m = mes(r && r['Fecha']);
    if (!m || regTexto(r['Vigente']) === 'No') return;
    var a = M(m); a.proc++;
    if (regEsCg_(r['Especialidad'])) a.procCg++;
    if (regTexto(r['Ambulatorio']) === 'Sí') a.procAmb++;
  });
  var desdeProc = REG_PROC_CENSO_DESDE.slice(0, 7);
  regArr(eps).forEach(function (e) {
    if (e.excluir === 1) return;
    var mi = mes(e.ingreso), me = mes(e.egreso);
    if (mi) { var a = M(mi); a.ing++; if (e.dx) a.dx[e.dx] = (a.dx[e.dx] || 0) + 1; if (e.incompleto) a.incompletos++; if (e.sexo) a.conSexo++; if (e.sinLabs) a.sinLabs++; }
    if (me) M(me).egr.push(e);
  });
  regArr(cxs).forEach(function (c) { var m = mes(c.f) || mes(c.fEstimada); if (m) M(m).cx.push(c); });
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
      'Ingresos con datos incompletos (n)': a.incompletos, 'Vigente': 'Sí',
      'Cirugías sin fecha exacta (n)': a.cx.filter(function (c) { return !mes(c.f); }).length,
      'Reintervenciones no planeadas (n)': a.egr.filter(function (e) { return e.reintNoPlan === 1; }).length, 'Ingresos sin talla (n)': '',
      // 24 nov 2026: porcentajes de llenado.
      'Egresos con motivo (%)': pct(conDes.length, a.egr.length), 'Con sexo (%)': pct(a.conSexo, a.ing), 'Episodios sin labs (n)': a.sinLabs,
      // 25 nov 2026: vacías antes del mes en que empezó la captura (no hay dato, no es cero).
      'Procedimientos en el censo (n)': m < desdeProc ? '' : a.proc, 'Procedimientos en el censo de CG (n)': m < desdeProc ? '' : a.procCg, 'Ambulatorios (n)': m < desdeProc ? '' : a.procAmb
    };
  });
}

/** ¿La especialidad es Cirugía General? «CG», «CIRUGIA GENERAL» o una combinación que la incluye («CG/URO»). */
function regEsCg_(esp) {
  var s = regNorm_(esp).trim();
  return /\bCIRUGIA GENERAL\b/.test(s) || s.split(/[\/,+&\s]+/).indexOf('CG') !== -1;
}

/** «Seguimiento de operados» (25 nov 2026, registro 2026.11.26-2). Una fila por persona (expediente válido + nombre
 *  compatible, regMismaPersona; las personas del registro son las de «Clave de seudónimos») que aparece en «Procedimientos
 *  del censo» o tiene cirugías en el registro (las de cada episodio sin la programación sin confirmar ni las tarjetas
 *  duplicadas). Un procedimiento del censo ligado a un episodio va con la persona de ese episodio; si no, con la del mismo
 *  expediente y nombre compatible; si no hay, es una persona nueva (operado ambulatorio, sin episodio en el registro).
 *  o: { procs, personas (listaPersonas de regAnalisis), P (Pacientes por id), sexosWl, hoy }. Ordenada por último
 *  procedimiento, el más reciente arriba. CON NOMBRES. */
function regSeguimientoOperados_(o) {
  var hoy = o.hoy || '', P = o.P || {}, ents = [], porExp = {};
  var agregar = function (e) { ents.push(e); if (e.exp) (porExp[e.exp] = porExp[e.exp] || []).push(e); };
  regArr(o.personas).forEach(function (p) {
    var gs = regArr(p && p.grupos).filter(function (g) { return g.excluir !== 1; });
    if (!gs.length) return;
    var exp = '';
    gs.some(function (g) { exp = g.exp || ''; return !!exp; });
    agregar({ exp: exp, nombres: gs.map(function (g) { return regTexto(g.nombre).trim(); }).filter(Boolean), grupos: gs, procs: [] });
  });
  var nombreClave = function (n) { return regNorm_(n).replace(/\s+/g, ' ').trim(); }, sinExp = {};
  regArr(o.procs).forEach(function (r) {
    if (!r || regTexto(r['Vigente']) === 'No') return;
    var exp = regExpValido(r['Expediente']), nombre = regTexto(r['Nombre']).trim(), idEp = regTexto(r['ID episodio']).trim(), e = null;
    if (!exp) {
      // 25 nov 2026 (revisión): expediente que el censo aceptó y el registro no («123»): entra por el expediente tal cual
      // y el nombre (sin acentos) en vez de perderse.
      var crudo = regTexto(r['Expediente']).trim(), nn = nombreClave(nombre);
      if (!crudo && !nn) return;
      e = sinExp[crudo + '|' + nn];
      if (!e) { e = sinExp[crudo + '|' + nn] = { exp: '', expCrudo: crudo, nombres: [], grupos: [], procs: [] }; ents.push(e); }
      if (nombre && e.nombres.indexOf(nombre) === -1) e.nombres.push(nombre);
      e.procs.push(r);
      return;
    }
    if (idEp) regArr(porExp[exp]).some(function (x) { if (x.grupos.some(function (g) { return g.partes.indexOf(idEp) !== -1; })) e = x; return !!e; });
    if (!e) regArr(porExp[exp]).some(function (x) { if (x.nombres.some(function (n) { return regMismaPersona(n, nombre); })) e = x; return !!e; });
    if (!e) { e = { exp: exp, nombres: [], grupos: [], procs: [] }; agregar(e); }
    if (nombre && e.nombres.indexOf(nombre) === -1) e.nombres.push(nombre);
    e.procs.push(r);
  });
  var filas = [];
  ents.forEach(function (e) {
    var cxs = [];
    e.grupos.forEach(function (g) { regArr(g.cxs).forEach(function (c) { cxs.push(c); }); });
    if (!e.procs.length && !cxs.length) return;
    var fProcs = {};
    e.procs.forEach(function (r) { var f = regFecha(r['Fecha']); if (f) fProcs[f] = true; });
    var fechas = Object.keys(fProcs).concat(cxs.map(function (c) { return c.f; }).filter(Boolean)).sort();
    var primer = fechas[0] || '', ultimo = fechas.length ? fechas[fechas.length - 1] : '';
    // Lo más reciente (nombre, edad, diagnóstico): del procedimiento del censo o del episodio, por fecha; en empate, el
    // censo. Si al más reciente le falta un dato, se toma del siguiente.
    var fuentes = [];
    e.grupos.forEach(function (g) { var u = P[g.ultima] || {}; fuentes.push({ f: g.fin || g.ingreso || '', o: 1, nombre: regTexto(u['Nombre']) || regTexto(g.nombre), edad: regTexto(u['Edad']), dx: regTexto(u['Diagnóstico']) }); });
    e.procs.forEach(function (r) { fuentes.push({ f: regFecha(r['Fecha']), o: 0, nombre: regTexto(r['Nombre']), edad: regTexto(r['Edad']), dx: regTexto(r['Diagnóstico']) }); });
    fuentes.sort(function (a, b) { return b.f.localeCompare(a.f) || a.o - b.o; });
    var primero = function (k) { for (var i = 0; i < fuentes.length; i++) if (regTexto(fuentes[i][k]).trim()) return regTexto(fuentes[i][k]).trim(); return ''; };
    var nombre = primero('nombre');
    // Nombre de la fila (parte de la clave): el PRIMERO que se vio (episodio por ingreso o procedimiento por fecha), sin
    // acentos ni espacios dobles; así no cambia cuando la fuente más reciente lo escribe distinto. 25 nov 2026 (revisión).
    var antiguas = [];
    e.grupos.forEach(function (g) { antiguas.push({ f: g.ingreso || g.fin || '', o: 0, nombre: regTexto(g.nombre) }); });
    e.procs.forEach(function (r) { antiguas.push({ f: regFecha(r['Fecha']), o: 1, nombre: regTexto(r['Nombre']) }); });
    antiguas.sort(function (a, b) { return (a.f || '9999').localeCompare(b.f || '9999') || a.o - b.o; });
    var nombreFila = '';
    antiguas.some(function (x) { nombreFila = nombreClave(x.nombre); return !!nombreFila; });
    // Sexo: el del episodio más reciente que lo tenga (con su fuente); si no, WinLab; si no, inferido del nombre.
    var gsRec = e.grupos.slice().sort(function (a, b) { return (b.ingreso || '').localeCompare(a.ingreso || ''); });
    var sexo = '', sexoF = '';
    gsRec.some(function (g) { if (g.sexo) { sexo = g.sexo; sexoF = g.sexoFuente || ''; } return !!sexo; });
    if (!sexo) {
      var w = regWlSexoPaciente(o.sexosWl, e.exp, nombre);
      if (w === 'F' || w === 'M') { sexo = w; sexoF = REG_SEXO_WL; }
      else { sexo = regSexoDeNombre(nombre); sexoF = sexo ? REG_SEXO_NOMBRE : ''; }
    }
    var esps = [];
    var esp = function (x) { var t = regNorm_(x).replace(/\s+/g, ' ').trim(); if (t && esps.indexOf(t) === -1) esps.push(t); };
    e.procs.forEach(function (r) { esp(r['Especialidad']); });
    var ids = [];
    e.grupos.slice().sort(function (a, b) { return (a.ingreso || '9999').localeCompare(b.ingreso || '9999'); }).forEach(function (g) {
      g.partes.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); esp((P[id] || {})['Especialidad']); });
    });
    var ultEg = null;
    e.grupos.forEach(function (g) { if (g.egreso && (!ultEg || g.egreso > ultEg.egreso)) ultEg = g; });
    var dias = ultimo ? regDiasSigno(ultimo, hoy) : '';
    if (dias !== '' && dias > REG_SEGUIMIENTO_DIAS_MAX) dias = '';
    // Reingresos: episodios que ingresaron después del primer procedimiento, sin el que CONTIENE ese procedimiento (cirugía
    // de urgencias la víspera del ingreso al servicio: el episodio en que se operó no es reingreso). 25 nov 2026 (revisión).
    var conPrimer = function (g) {
      return regArr(g.cxs).some(function (c) { return c.f === primer; })
        || e.procs.some(function (r) { return regFecha(r['Fecha']) === primer && g.partes.indexOf(regTexto(r['ID episodio']).trim()) !== -1; });
    };
    filas.push({ 'Expediente': e.exp || e.expCrudo || '', 'Nombre': nombreFila, 'Nombre más reciente': nombre, 'Edad': primero('edad'), 'Sexo': sexo, 'Sexo (fuente)': sexoF,
      'Primer procedimiento': primer, 'Último procedimiento': ultimo, 'Procedimientos en el censo (n)': Object.keys(fProcs).length, 'Cirugías registradas (n)': cxs.length,
      'Especialidades': esps.join(' · '), 'Diagnóstico más reciente': primero('dx'), 'ID episodios': ids.join(', '),
      '¿Hospitalizado ahora?': e.grupos.some(function (g) { return g.estado === 'Hospitalizado'; }) ? 'Sí' : 'No',
      'Último egreso': ultEg ? ultEg.egreso : '', 'Motivo del último egreso': ultEg ? regTexto(ultEg.tipo) : '',
      'Días desde el último procedimiento': dias === '' ? '' : dias,
      'Reingresos posteriores (n)': primer ? e.grupos.filter(function (g) { return g.ingreso && g.ingreso > primer && !conPrimer(g); }).length : '', 'Vigente': 'Sí' });
  });
  return filas.sort(function (a, b) { return regTexto(b['Último procedimiento']).localeCompare(regTexto(a['Último procedimiento'])) || regTexto(a['Expediente']).localeCompare(regTexto(b['Expediente'])); });
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
 *  del registro tal como quedaron escritas en esta corrida. `enEspera`: { pestaña: true } de las que esta corrida no debe
 *  tocar. Devuelve los avisos. */
function regEscribirAnalisis_(libro, props, fus, restauraciones, hoy, corte, cuentas, enEspera) {
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
    if (enEspera && enEspera[cfg.nombre]) return;   // esta corrida no la toca (ver actualizarRegistro)
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
  add(E, 'Partes del registro', 'entero', '', 'Cuántos ids de la base forman el episodio (más de 1 = restaurado desde la Papelera o, desde el 24 nov 2026, unido por mismo ingreso o por ser contiguo: ver «Unión (fuente)»).');
  add(E, 'N.º de episodio del paciente', 'entero', '', 'Orden del episodio entre los del mismo paciente (por fecha de ingreso; sin duplicados ni episodios sin fecha de ingreso).');
  add(E, 'Días desde el egreso previo', 'entero', 'días', 'Del egreso del episodio anterior del paciente a este ingreso. Vacío en el primero o si el anterior no tiene egreso.');
  add(E, 'Es reingreso (≤30 días)', '0/1', '', '1 si este ingreso ocurrió 0–30 días después del egreso anterior; 0 si después; vacío si no hay episodio anterior registrado (el registro empezó en 2026: los primeros pueden ser reingresos de antes).');
  add(E, 'Reingreso a 30 días', '0/1', '', '1 si el paciente volvió a ingresar a este servicio 0–30 días después de este egreso; 0 si no y ya pasaron 30 días; vacío si sigue hospitalizado, murió o aún no pasan 30 días. Solo ve reingresos a los servicios que usan la app.');
  add(E, 'Edad (años)', 'número', 'años', 'Edad del censo al ingreso (meses y días convertidos a fracción de año). Vacío si no se entiende.');
  add(E, 'Sexo · Sexo (fuente)', 'texto', '', 'F, M o vacío (sin registrar), con la misma regla que la app. Fuente: «Tarjeta» (lo escrito en la app) o «de WinLab» (la tarjeta no lo tiene: se tomó del encabezado de laboratorio de los reportes del paciente, con la regla de identidad del robot y su mismo expediente y nombre). Si WinLab trae los dos sexos para la persona no se usa; si la tarjeta y WinLab no coinciden manda la tarjeta y se anota en «Calidad de datos». Desde el 25 nov 2026, tercera fuente (la de menor prioridad, solo si la tarjeta y WinLab no lo traen): «Inferido del nombre», del primer nombre de pila con un diccionario de nombres frecuentes en México (MA. = María; el primero manda: JOSÉ MARÍA = M, MARÍA JOSÉ = F; GUADALUPE, ROSARIO, TRINIDAD, REFUGIO, CRUZ… los decide el otro nombre; ALEXIS y SALOMÉ también; si el nombre viene con APELLIDOS primero se saltan los apellidos frecuentes y los de partícula, como DE LEÓN o DE LA CRUZ). Nombre fuera de la lista, inicial suelta, inicial tras dos apellidos o no concluyente (un nombre de pila del otro sexo más adelante, p. ej. un apellido que también es nombre, como SANTIAGO o LEÓN): vacío (nunca se adivina por la terminación). Error esperado: bajo en los que sí se clasifican (no medido contra una muestra real; ante la duda queda vacío); sobre todo nombres poco usuales del otro sexo). Si la tarjeta o WinLab no coinciden con el nombre, mandan ellas y se anota en «Calidad de datos». Aquí no va el nombre: solo la letra y la fuente.');
  add(E, 'Especialidad · Sección', 'texto', '', 'Del censo, en la última parte del episodio, en mayúsculas y sin acentos. Solo pasa lo que tiene la forma esperada (códigos de especialidad del catálogo; palabras de salas conocidas): cualquier otro texto se escribe «' + REG_NO_VALIDO + '» (el censo de la hoja a veces trae texto corrido, incluso nombres, y esta pestaña se comparte). Sesgo: una especialidad o sala nueva sale «' + REG_NO_VALIDO + '» hasta que se agregue al catálogo del script.');
  add(E, 'Fecha de ingreso', 'texto AAAA-MM-DD', '', 'Fecha de ingreso del censo (la más antigua de las partes).');
  add(E, 'Fecha de egreso', 'texto AAAA-MM-DD', '', 'Fecha del egreso en la app o, si no la hay, la fecha en que se archivó. Vacío si sigue hospitalizado o salió sin registro.');
  add(E, 'Días de estancia', 'entero', 'días', 'Egreso − ingreso. Si no hay egreso: hasta hoy (hospitalizado) o hasta el último día que estuvo en la base. Usar con «Egreso observado» (0 = dato censurado).');
  add(E, 'Estado', 'texto', '', 'Hospitalizado, Egresado o Sin egreso registrado (salió de la base sin pasar por la Papelera).');
  add(E, 'Egreso observado', '0/1', '', '1 si se registró el egreso con fecha (y no es duplicado). Para análisis de supervivencia: 0 = censurado.');
  add(E, 'Tipo de egreso', 'texto', '', 'Alta, Defunción, Cambio de servicio, Contrarreferencia, Traslado, Alta voluntaria, Fuga, Otro, No fue egreso, Motivo no registrado, Duplicado (no es otro episodio) o Borrado en la base (revisar). Casi todos los egresos salen del censo de la hoja sin decir si fue alta o defunción: hasta que se registre el motivo, «Defunción» NO permite calcular mortalidad.');
  add(E, 'Defunción', '0/1', '', '1 = registrada como defunción; 0 = salió vivo del servicio (alta, alta voluntaria, traslado, contrarreferencia, fuga o cambio de servicio; en cambio de servicio el desenlace posterior en el hospital no se conoce); vacío = desconocido (motivo no registrado, «otro motivo», «no fue egreso», hospitalizado). NUNCA tratar vacío como 0.');
  add(E, 'Motivo de egreso (app)', 'texto', '', 'Etiqueta original del egreso en la app (p. ej. «RETIRADO DEL CENSO (hoja)»). Un motivo REGISTRADO dice su fuente: «… (registrado en la app)» si lo eligió una persona; desde el 25 nov 2026 «… (censo: sección ALTAS)» o «… (censo: sección DEFUNCIONES)» si el script del censo lo tomó de esa sección de la hoja. Los dos cuentan igual para la mortalidad (son motivo registrado, no inferido).');
  add(E, 'Excluir (duplicado)', '0/1', '', '1 = tarjeta duplicada (no es otro episodio): excluir. Vacío = borrado en la base por mantenimiento: revisar. 0 = episodio real.');
  add(E, 'Diagnóstico', 'texto', '', 'Diagnóstico del censo en la última parte del episodio (texto libre, sin codificar).');
  add(E, 'Dx principal · CIE-10 (grupo) · Dx principal (fuente)', 'texto', '', 'Diagnóstico principal de una lista corta del servicio (apendicitis, colecistitis, pancreatitis, oclusión, hernia, cáncer colorrectal…) con su grupo CIE-10. Fuente: «Elegido en la app» (alguien eligió otro en 🩺 Dx principal, bajo la caja DX) o «Inferido del DX» (el que la app muestra sola desde el 30 oct 2026: la misma tabla sobre el texto del DX del censo, el término que aparece primero). Para publicar, revisar una muestra de los inferidos.');
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
  add(E, 'Reintervención', '0/1', '', '«2.ª cirugía de cualquier tipo»: 1 = dos o más cirugías en el episodio o una relaparotomía; 0 = una sola cirugía; vacío = sin cirugía. Sesgo: SOBRECUENTA (un segundo tiempo, un cierre de pared diferido o un recambio de VAC también dan 1). Para la tasa de reintervención usar «Reintervención no planeada (probable)».');
  add(E, 'Cirugías inferidas (n)', 'entero', '', 'Cuántas de las cirugías se tomaron de otra caja (DX, Cronología, fecha POP o texto Qx) porque no estaban en la caja Cirugías: conviene pasarlas a la caja.');
  add(E, 'Programadas sin confirmar (n)', 'entero', '', 'Cirugías que solo aparecen en la programación del día (sin otra cirugía en esos días): no se cuentan como hechas.');
  add(E, 'Sangrado total (mL)', 'número', 'mL', 'Suma del sangrado de las cirugías. Vacío si alguna tiene un sangrado que no es número (p. ej. «MÍNIMO»).');
  add(E, 'Procedimientos', 'texto', '', 'Fecha y procedimiento de cada cirugía, separados por « | » (texto libre, sin codificar).');
  add(E, 'Antibiótico (registrado) · NPT (registrada) · Ventilación mecánica (registrada) · Vasopresor (registrado) · Tromboprofilaxis (registrada)', '0/1', '', '1 = marcado en la última copia de la tarjeta; 0 = no marcado (NO prueba que no lo recibió; la app no guarda fechas de inicio y fin).');
  add(E, 'Fechas con labs (n) · Valores críticos (n)', 'entero', '', 'Días con laboratorio y número de valores críticos (tabla única de la app: ≤ crítico bajo o ≥ crítico alto).');
  REG_LAB_RESUMEN.forEach(function (r) { add(E, r[2], 'número', (REG_LAB_POR_CLAVE[r[0]] || {}).u || '', (r[1] === 'min' ? 'Mínimo' : r[1] === 'max' ? 'Máximo' : 'Primer valor (fecha más antigua)') + ' del episodio, de «' + L + '». Un «<x» / «>x» cuenta como x.'
    + (r[0] === 'lac' ? ' Sesgo (24 nov 2026): hoy está VACÍA en todos los episodios porque ninguna captura (ni de WinLab ni manual) trae la clave «lac»; el lactato de gasometría, cuando existe, queda en «Otros estudios». Vacío NO significa lactato normal.' : '')); });
  // 24 nov 2026: columnas nuevas de «Análisis · Episodios».
  add(E, 'Unión (fuente)', 'texto', '', 'Por qué varios ids de la base son UN episodio: «Restauración» (la tarjeta se restauró desde la Papelera), «Mismo ingreso» (mismo expediente válido, nombre compatible y la misma fecha de ingreso) o «Contiguo» (mismo expediente y nombre, y el siguiente ingresó 0–1 día después de un egreso que no dice el motivo); varias, unidas con « + ». Vacío = un solo id. No se une tras una defunción ni tras un motivo registrado por una persona (salvo «no fue egreso»), ni con duplicados. Sesgo: «Contiguo» puede esconder un reingreso real al día siguiente de un egreso sin motivo, y «Mismo ingreso» depende de que la fecha de ingreso del censo esté bien; ambas BAJAN «Egresos (n)» y alargan la estancia respecto a lo publicado antes del 24 nov 2026. Sin expediente válido o sin fecha de ingreso no se une nada. Revisar una muestra (también se anota en «Calidad de datos»).');
  add(E, 'Cirugías sin fecha (n)', 'entero', '', 'Cuántas de las «Cirugías (n)» no tienen fecha (casi siempre inferidas del DX o del texto Qx). No entran en «Primera cirugía» ni en los días a la cirugía; en el Resumen mensual se cuentan en el mes del ingreso. Sesgo: la fecha real puede ser de otro mes.');
  add(E, 'Reintervención planeada (probable)', '0/1', '', '1 = alguna cirugía de la 2.ª en adelante (por fecha) dice en su texto SEGUNDO TIEMPO, SECOND LOOK, CIERRE DE PARED, CIERRE DIFERIDO, RECAMBIO, LAVADO PROGRAMADO o VAC; 0 = hay cirugías y ninguna lo dice; vacío = sin cirugía. Sesgo: es texto libre (un lavado no programado escrito como «RECAMBIO DE VAC» cuenta como planeado, y uno planeado que no lo dice cuenta como no planeado). Validar una muestra contra expediente antes de publicar.');
  add(E, 'Reintervención no planeada (probable)', '0/1', '', '1 = alguna cirugía posterior a la índice que NO dice ser planeada ocurrió 1–30 días después, o la única cirugía registrada es una relaparotomía; 0 = una sola cirugía, o las demás fueron planeadas, del mismo día que la índice o después de 30 días. NO cuentan (ni como índice ni como reintervención) los procedimientos menores: endoscopia / CPRE, traqueostomía, catéteres, punciones y drenajes percutáneos (la índice es la primera cirugía que no es menor: «CPRE y después colecistectomía» no es reintervención); la 2.ª cirugía elegida «Electiva» en la caja cuenta como PLANEADA; otro renglón del mismo día que la índice es la misma cirugía (salvo que el texto diga reintervención). En «' + REG_AN_EVENTOS + '» solo lleva grado IIIb la relaparotomía o la que el texto llama reintervención / reexploración / complicación; la que solo lo parece por fechas sale «' + REG_CERTEZA_PROB + '», sin grado, para revisar. vacío = sin cirugía, o la 2.ª no tiene fecha y el episodio duró más de 30 días desde la índice (no se adivina; se anota en «Calidad de datos»). No cuenta la programación sin confirmar. Sesgo: solo ve cirugías de este episodio (no una reintervención en un reingreso o en otro hospital); dos renglones de la MISMA cirugía escritos distinto y con más de 2 días de diferencia contarían como dos; depende del texto libre.');
  add(E, 'Estancia posoperatoria (días)', 'entero', 'días', 'Del día de la primera cirugía con fecha al egreso (o a hoy / último día visto si no hay egreso: usar con «Egreso observado», 0 = censurado). Vacío sin cirugía con fecha, o si esa fecha es ANTERIOR al ingreso (operado antes de llegar: no es la estancia posoperatoria de este episodio; se anota en «Calidad de datos»). Sesgo: si la primera cirugía no tiene fecha se mide desde la siguiente que sí la tenga.');
  add(E, 'Cirugía en ≤1 día del ingreso', '0/1', '', '1 = la primera cirugía con fecha fue el día del ingreso o el siguiente; 0 = después; vacío = sin cirugía con fecha, o con fecha ANTERIOR al ingreso (operado antes de llegar, o una fecha POP previa: no mide la oportunidad quirúrgica de este episodio). Sesgo: usa fechas sin hora (no son 24 h exactas) y la fecha de ingreso del censo, que puede ser la de llegada al piso y no al hospital.');
  add(E, 'Defunción posoperatoria (hospitalaria)', '0/1', '', '«Defunción» de los episodios con al menos una cirugía (1 = murió en el servicio; 0 = salió vivo; vacío = sin cirugía o desenlace desconocido). Sesgo: solo mortalidad en ESTE servicio y hospitalización (no a 30 días ni después de un traslado o cambio de servicio) y mientras falte el motivo en muchos egresos el denominador válido es chico. NUNCA tratar vacío como 0.');
  // 24 nov 2026: columnas desde «Movimientos y estado» (auditoría del censo).
  var obs = ' Vacío = el episodio no tiene ningún movimiento copiado (la auditoría de la base empieza el 14 oct 2026 y se purga a los 180 días; el registro la copia desde el 24 nov 2026): vacío NO es 0 (sin movimientos solo se anota «Pasó por UCI» = 1 si la tarjeta está hoy en una cama de UCI).';
  add(E, 'Cambios de cama (n)', 'entero', '', 'Cuántas veces cambió la cama del episodio en el censo (de una cama válida a otra distinta), según «' + REG_MOVIMIENTOS + '».' + obs + ' Sesgo: una cama corregida por error de captura cuenta como cambio; restaurar la tarjeta desde la Papelera (otro id) no cuenta; los cambios anteriores al 14 oct 2026 no existen.');
  add(E, 'Pasó por UCI · Días en UCI', '0/1 · entero', 'días', '1 si en algún momento la cama empezó con UCI / UTI o la sección del censo era de terapia intensiva (por el historial de movimientos o por lo que dice hoy la tarjeta). Días en UCI = suma, por cada tramo en UCI, de fecha de salida − fecha de entrada (el tramo abierto termina en el egreso, hoy o el último día visto; un paso de horas el mismo día = 0).' + obs + ' Sesgo: depende de cómo se escribe la cama en el censo (un paciente de cirugía en UCI con cama de piso no se ve); antes del 14 oct 2026 solo se sabe lo que dice la tarjeta; no distingue terapia intermedia.');
  add(E, 'Peor estado clínico · Fecha del primer GRAVE', 'texto · texto AAAA-MM-DD', '', 'El estado más grave que tuvo la tarjeta en el episodio (ESTABLE < DELICADO < GRAVE < MUY GRAVE), por los cambios de estado del historial y el estado actual; y la fecha (Ciudad de México) del primer cambio A «GRAVE» o «MUY GRAVE».' + obs + ' Sesgo: el estado es una apreciación que el equipo actualiza a mano (no es una escala); si ingresó GRAVE y nunca cambió, la fecha queda vacía; el estado «ALTA» / «DEFUNCIÓN» no cuenta.');
  add(E, 'Fecha de ingreso (estimada) · Fecha de ingreso (fuente)', 'texto AAAA-MM-DD · texto', '', 'La fecha de ingreso de la tarjeta («Tarjeta») o, si la tarjeta no la trae, el día en que el paciente se dio de alta en el censo de la app («Alta en el censo (auditoría)»). Vacío si no hay ninguna. NO cambia «Fecha de ingreso» ni «Días de estancia» (siguen saliendo solo de la tarjeta). Sesgo: el alta en el censo puede ser posterior al ingreso real (el paciente llegó antes de capturarse) o corresponder a una tarjeta vuelta a crear.');
  add(E, 'Hora de egreso del censo', 'texto AAAA-MM-DD HH:MM', '', 'Momento (hora de Ciudad de México) en que la tarjeta salió del censo de la app, según la auditoría (la baja más reciente de la última parte del episodio). Vacío si sigue en el censo o la baja no está en el historial. Sesgo: es cuando alguien (o el censo de la hoja) retiró la tarjeta, no la hora del alta médica; puede ser horas después. La hora exacta ayuda a reconocer a una persona: valorar quitarla antes de compartir.');
  // 24 nov 2026 (lote C): días observados, laboratorio, cultivos, Charlson. Todo se calcula de lo que ya está en la hoja.
  var obsD = ' «Observados»: noches en que la foto de «' + REG_ESTADO_DIARIO + '» (la tarjeta a la hora de la corrida, ~23 h; existe desde el 24 nov 2026) lo tenía prendido, más, SOLO en las noches sin foto, los días entre que la casilla se prendió y la víspera de que se apagó según «' + REG_SOPORTE + '» (auditoría desde el 14 oct 2026; si sigue prendida, hasta la última noche del episodio). Vacío = el episodio no tiene ni noches fotografiadas ni cambios de esa casilla en la auditoría: vacío NO es 0. Sesgo: SUBESTIMA en todo episodio anterior a esas fechas o con «Cobertura del diario (%)» baja; cuenta noches con la casilla prendida, no dosis ni días reales de tratamiento; un apagado sin su prendido (anterior a la auditoría) no suma nada.';
  add(E, 'Días con antibiótico (observados) · Primer día ATB · Último día ATB', 'entero · texto AAAA-MM-DD', 'días', 'Noches con antibiótico: casilla de antibiótico prendida o algún antimicrobiano de la lista cerrada detectado en Manejo esa noche; y la primera y la última de esas fechas.' + obsD + ' Además: la profilaxis de quirófano no se anota en la tarjeta; el historial solo conoce la casilla (no lo escrito en Manejo); no son días de tratamiento continuo (puede haber huecos entre el primero y el último).');
  add(E, 'Antibióticos distintos (n) · Carbapenémico', 'entero · 0/1', '', 'Cuántos antimicrobianos distintos de la lista cerrada de ' + REG_ATB.length + ' se vieron en el episodio (en «Antibióticos en Manejo (detectados)» y en el texto junto a la casilla, de las noches fotografiadas y del historial) y si alguno fue carbapenémico (meropenem, imipenem, ertapenem). Vacío = sin noches fotografiadas ni historial de antibiótico. Sesgo: incluye antifúngicos; un fármaco fuera de la lista o mal escrito no cuenta; solo desde que existen la foto y la auditoría (0 no prueba que no lo recibió antes).');
  add(E, 'Días en ayuno · Ayuno posoperatorio (días) · Día posoperatorio de inicio de dieta · Ayuno >5 días sin NPT', 'entero · entero · entero · 0/1', 'días', 'Noches con la casilla de ayuno (NPO) prendida; cuántas de ellas desde el día de la primera cirugía con fecha (vacío sin cirugía con fecha); días de la primera cirugía a la primera noche SIN ayuno después de un ayuno posoperatorio (vacío si no se vio ayuno posoperatorio o no se ha visto el final); y 1 si hubo más de 5 noches SEGUIDAS en ayuno sin NPT.' + obsD + ' Además: «sin ayuno» = casilla sin marcar (no prueba que ya comía ni cuánto); una noche sin foto rompe la racha de días seguidos.');
  add(E, 'Días con NPT · NPT % máximo', 'entero · número', 'días · %', 'Noches con la casilla de NPT prendida y el porcentaje más alto escrito (de las noches fotografiadas y del historial).' + obsD);
  add(E, 'Días con ventilación · Días con vasopresor · Días con tromboprofilaxis', 'entero', 'días', 'Noches con ventilación mecánica; con norepinefrina o vasopresina prendida en la calculadora de la tarjeta; y con la casilla de tromboprofilaxis.' + obsD + ' Además: la calculadora de vasopresores y la casilla de tromboprofilaxis se usan poco (0 no prueba que no los tuvo); la ventilación y el vasopresor de quien está en UCI casi nunca se capturan en esta app.');
  add(E, 'Dispositivos (n) · Sonda endopleural · Estoma · Terapia de presión negativa', 'entero · 0/1', '', 'Dispositivos distintos del episodio en «' + REG_DISPOSITIVOS + '» (vigentes o ya retirados) y si alguno es del grupo sonda pleural, estoma o presión negativa. Vacío = el episodio no tiene filas en «' + REG_DISPOSITIVOS + '» ni noches fotografiadas (no se sabe); 0 = se vio y no tenía. Sesgo: solo lo que estaba en la tarjeta desde el 24 nov 2026 (o al egreso, si la copia sigue en la base); el tipo es texto libre; borrar y volver a crear un dispositivo en la app lo cuenta dos veces; un estoma previo al ingreso también cuenta.');
  add(E, 'Días con drenaje · Gasto máximo (mL)', 'entero · número', 'días · mL', 'Días distintos con algún drenaje (sonda pleural, biliar, Penrose, Drenovac / Hemovac, Blake / Jackson-Pratt, Saratoga o un tipo que diga «DREN…»): de «Primera vez visto» a «Última vez visto» de cada uno, más las fechas con gasto en «' + REG_DRENAJES_DIARIO + '»; y el gasto más alto escrito en mL. Días vacío = sin dato, o hay drenaje pero el registro nunca lo vio hospitalizado. Sesgo: solo desde el 24 nov 2026; «Última vez visto» aproxima el retiro; el gasto es el último escrito a la hora de la corrida (no el de 24 h de enfermería) y solo cuenta si es un número limpio.');
  add(E, 'Cobertura del diario (%)', 'número', '%', 'Noches fotografiadas en «' + REG_ESTADO_DIARIO + '» ÷ días de estancia × 100 (máximo 100). Vacío = sin ninguna noche fotografiada o estancia de 0 días. Dice cuánto de la estancia sustenta las columnas de días observados: con cobertura baja esas columnas subestiman. Sesgo: los episodios anteriores al 24 nov 2026 no tienen foto; en un hospitalizado el denominador no incluye la noche de hoy.');
  add(E, 'Creatinina basal (mg/dL) · LRA KDIGO (estadio máx.) · Fecha de LRA', 'número · entero 0–3 · texto AAAA-MM-DD', 'mg/dL', 'Lesión renal aguda por creatinina (KDIGO 2012), de «' + L + '». Basal = la creatinina MÍNIMA del episodio. Estadio de cada día: 1 = ≥1.5 veces la basal o sube ≥0.3 mg/dL respecto a un valor de hasta 2 días antes; 2 = ≥2 veces; 3 = ≥3 veces o ≥4.0 mg/dL habiendo cumplido algún criterio. Se anota el estadio más alto (0 = ningún día cumple) y la fecha del PRIMER día con criterio. Vacío = menos de 2 creatininas en fechas distintas. Sesgo: la basal es la mínima del episodio, no la previa al ingreso (SUBESTIMA en quien llega lesionado y no se recupera; en quien llega lesionado y MEJORA marca lesión desde su primer laboratorio aunque la creatinina solo baje: no es una lesión nueva, y por eso «LRA posoperatoria» exige una creatinina de antes de operarse); las 48 h se aproximan con fechas sin hora; no usa uresis ni inicio de diálisis; en enfermedad renal crónica o diálisis los cambios de creatinina no son lesión aguda (estratificar por «Enfermedad renal crónica»); solo ve los días con laboratorio.');
  add(E, 'LRA posoperatoria', '0/1', '', '1 = algún día de los 7 siguientes a la primera cirugía con fecha (días 1 a 7) cumple criterio KDIGO y NO lo cumplía ningún laboratorio hasta el día de la cirugía; 0 = hay creatinina en esos días y no cumple, o ya había lesión antes; vacío = sin cirugía con fecha, sin creatinina en los días 1 a 7, menos de 2 creatininas o NINGUNA creatinina hasta el día de la cirugía (sin ella no se puede saber que la lesión es nueva: con la basal mínima, el que llega lesionado y mejora saldría como lesión posoperatoria). Mismo sesgo que la columna anterior; SUBESTIMA en el operado de urgencia sin laboratorio previo en el registro; el laboratorio del mismo día de la cirugía se toma como preoperatorio (no hay hora).');
  add(E, 'Hb inicial (g/dL) · Hb preoperatoria (g/dL) · Caída máxima de Hb (g/dL)', 'número', 'g/dL', 'Primera hemoglobina del episodio; la última con fecha igual o anterior a la primera cirugía con fecha (vacío sin cirugía con fecha o sin Hb hasta ese día); y la mayor caída desde un valor a cualquiera posterior (vacío con menos de 2 valores; 0 si nunca bajó). Sesgo: la Hb del mismo día de la cirugía puede ser ya posoperatoria (no hay hora); la caída no descuenta transfusiones ni hemodilución.');
  add(E, 'Anemia al ingreso (OMS)', '0/1', '', 'Con la Hb inicial: 1 si < 13 g/dL en hombres o < 12 g/dL en mujeres (OMS, de 15 años en adelante). Sin sexo registrado: 1 si < 12, 0 si ≥ 13 y vacío entre 12 y 13. Vacío sin Hb o en menores de 15 años. Sesgo: no ajusta por embarazo ni altitud; la Hb «inicial» puede ser de varios días después del ingreso.');
  add(E, 'Hipoalbuminemia (<3.5) · Albúmina <3.0', '0/1', '', 'Con la albúmina INICIAL del episodio (la misma de «Albúmina inicial (g/dL)»). Vacío si no se midió. Sesgo: la albúmina se pide a pocos pacientes (los más graves): no es una muestra del servicio.');
  add(E, 'Leucocitos iniciales (k/µL) · Plaquetas iniciales (k/µL) · Sodio inicial (mmol/L)', 'número', 'k/µL · k/µL · mmol/L', 'Primer valor del episodio (fecha más antigua con ese estudio), de «' + L + '». Vacío si no se midió. Sesgo: «inicial» es el primer laboratorio que llegó al registro, que puede ser de días después del ingreso o posterior a la cirugía; un «<x» / «>x» cuenta como x.');
  add(E, 'PCR día 3-4 posoperatorio (mg/L)', 'número', 'mg/L', 'Proteína C reactiva del día 3 después de la primera cirugía con fecha; si no hay, la del día 4. Vacío sin cirugía con fecha o sin PCR en esos días. Sesgo: la PCR se pide por sospecha clínica (no a todos).');
  add(E, 'Glucosa >180 (días)', 'entero', 'días', 'Fechas con glucosa de laboratorio > 180 mg/dL. Vacío si no hay ninguna glucosa de laboratorio. Sesgo: una glucosa por fecha (la del laboratorio central; no la glucemia capilar, que está en «' + S + '»); depende de cuántos días se pidió.');
  add(E, 'ISQ probable (cultivo)', '0/1', '', '1 = algún cultivo POSITIVO (no contaminante) de herida / tejidos blandos o abdominal (líquido, bilis, colección) tomado 1 a 30 días después de una cirugía del episodio; 0 = hay cirugía con fecha y ningún cultivo así; vacío = sin cirugía con fecha. Sesgo: SUBESTIMA (la infección superficial casi nunca se cultiva; 0 incluye a quien no se le tomó cultivo) y también puede sobrecontar (un cultivo de bilis o de una colección que ya estaba infectada antes de operar); solo cultivos de WinLab tomados durante ESTE episodio (no en la consulta ni en un reingreso). No es el criterio de los CDC: validar contra expediente antes de publicar una tasa.');
  add(E, 'ISQ mencionada (texto)', '0/1', '', '1 = el Diagnóstico, Manejo, Pendientes o Cronología de la tarjeta, o la «Complicación» de una cirugía, dicen ISQ / ISO, «infección de sitio (o herida) quirúrgico» o «herida infectada» sin negarlo en la misma oración («SIN DATOS DE ISQ», «VIGILAR ISQ», «PROBABLE ISQ» no cuentan); 0 = hay cirugía y no se menciona; vacío = sin cirugía y sin mención. Sesgo: texto libre de la ÚLTIMA copia de la tarjeta (lo que se borró no se ve); puede ser la infección de una cirugía ANTERIOR que motivó el ingreso; no distingue superficial, profunda u órgano-espacio.');
  add(E, 'Bacteriemia', '0/1', '', '1 = algún hemocultivo positivo del episodio que no es contaminante probable; 0 = hay hemocultivos con resultado y ninguno así; vacío = sin hemocultivo con resultado. Sesgo: un estafilococo coagulasa negativo verdadero (catéter, prótesis) cuenta como contaminante; no distingue adquirida en el hospital de la que traía al ingreso (cruzar con «Día de estancia» en «' + C + '»).');
  add(E, 'Urocultivo positivo ≥ día 3', '0/1', '', '1 = algún urocultivo positivo tomado del día calendario 3 de la estancia en adelante (contando el ingreso como día 1: «Día de estancia» ≥ 2); 0 = hay urocultivos con resultado y ninguno así; vacío = sin urocultivo con resultado. Sesgo: es un cultivo positivo, no una infección urinaria (no hay síntomas ni cuenta de colonias exigida ni se sabe si tenía sonda): incluye bacteriuria asintomática.');
  add(E, 'Germen multirresistente', '0/1', '', '1 = algún cultivo del episodio con «Multirresistente (probable)» = 1 en «' + C + '»; 0 = hay cultivos con resultado y ninguno; vacío = sin cultivos con resultado. Mismo sesgo que esa columna.');
  add(E, REG_COMORB_1124.map(function (c) { return c[0]; }).join(' · '), '0/1', '', 'Comorbilidades para el índice de Charlson y variables preoperatorias, desde los Antecedentes (APP) y el diagnóstico con la misma regla de negación que las anteriores: 1 = mencionada; 0 = hay APP y no la menciona (o la niega); vacío = sin APP. «Anticoagulante / antiagregante» y «Cirugía abdominal previa» solo se buscan en el APP (en el diagnóstico describirían este episodio). NO entran en «Comorbilidades (n)» (esa columna sigue contando las mismas de antes). Sesgo: texto libre (revisar una muestra); el diagnóstico del episodio también cuenta (una úlcera perforada da «Úlcera péptica»); «VIH / SIDA» no distingue VIH sin SIDA; «Alcoholismo» no cuenta el «social» u «ocasional»; «Cirugía abdominal previa» es una lista corta de procedimientos.');
  add(E, 'Charlson (puntos) · Charlson ajustado por edad · Charlson (calculable)', 'entero · entero · 0/1', 'puntos', 'Índice de comorbilidad de Charlson SIMPLIFICADO (pesos de Charlson, J Chronic Dis 1987) desde las banderas de texto: 1 punto por cardiopatía, enfermedad vascular periférica, EVC, demencia, EPOC / asma, tejido conectivo, úlcera péptica, hepatopatía (3 si es grave) y diabetes (2 con daño a órgano blanco); 2 por hemiplejía, enfermedad renal crónica y cáncer, leucemia o linfoma (6 si hay metástasis); 6 por VIH / SIDA. Ajustado por edad: +1 por cada década desde los 50 años (máximo +4); vacío sin edad. Calculable = 1 solo si hay APP; sin APP los puntos quedan VACÍOS (no 0). Sesgo: NO es el Charlson de expediente: «Cardiopatía» vale 1 aunque tenga infarto e insuficiencia cardiaca (el original da 2), la ERC vale 2 sin saber su grado, VIH sin SIDA suma 6 de más, y todo depende de lo que se escribió en el APP (subestima). Decirlo así en métodos y validar una muestra.');
  add(E, 'Riesgo preoperatorio simple (0-6)', 'entero 0–6', 'puntos', 'Puntaje INTERNO, NO VALIDADO, para estratificar (no predice): 1 punto por cada uno de edad ≥ 70 años, Charlson (puntos) ≥ 3, cirugía de urgencia (la elegida en la caja para la primera cirugía o, si no se eligió, cirugía en ≤1 día del ingreso), albúmina inicial < 3.5 g/dL, anemia al ingreso (OMS) y creatinina inicial ≥ 1.5 mg/dL. Vacío = sin cirugía, sin edad o sin APP. Sesgo: el laboratorio que no se midió cuenta 0 (SUBESTIMA); los laboratorios «iniciales» pueden ser posteriores a la cirugía; no sustituye ASA, clase de herida ni escalas validadas (no se capturan en la app).');
  add(E, 'Cultivos (n) · Cultivos positivos (n) · Gérmenes aislados', 'entero / texto', '', 'Cultivos de WinLab del paciente tomados desde 2 días antes del ingreso hasta el egreso.');
  add(E, 'Calidad de datos', 'texto', '', 'Todo lo que falta o no se pudo usar en el episodio.');
  var R = REG_AN_RESUMEN, PC = REG_POR_COMPLETAR;
  add(R, 'Privacidad', '', '', 'Solo cuentas por mes: no tiene nombres ni seudónimos. Se puede compartir dentro del servicio.');
  add(R, 'Mes', 'texto AAAA-MM', '', 'Mes calendario. Ingresos por mes de ingreso; egresos, mortalidad, estancia, reintervenciones y reingresos por mes de egreso; cirugías por mes de la cirugía; cultivos por mes de toma. Sin duplicados (Excluir = 1).');
  add(R, 'Ingresos (n) · Egresos (n) · Egresos con desenlace conocido (n) · Defunciones (n) · Egresos sin motivo (n)', 'entero', '', 'Egresos = egresos observados (con fecha). Con desenlace conocido = Defunción 0 o 1 (motivo registrado). Sin motivo = egresos que nadie clasificó.');
  add(R, 'Mortalidad (%)', 'número', '%', 'Defunciones ÷ egresos con desenlace conocido × 100. Vacío si ningún egreso del mes tiene motivo. Mientras haya muchos «Egresos sin motivo», la cifra no representa al servicio.');
  add(R, 'Estancia mediana (días) · Estancia media (días)', 'número', 'días', 'De los egresos del mes.');
  add(R, 'Pacientes operados (n) · Cirugías (n)', 'entero', '', 'Cirugías del mes (de la caja y las inferidas; no la programación sin confirmar) y cuántos episodios distintos. Desde el 24 nov 2026 incluye las cirugías sin fecha, contadas en el mes del ingreso del episodio (ver «Cirugías sin fecha exacta (n)»); antes se perdían.');
  add(R, 'Cirugías sin fecha exacta (n)', 'entero', '', 'Cuántas de las «Cirugías (n)» del mes no tienen fecha y se pusieron en el mes del ingreso de su episodio (o del egreso si no hay ingreso). Sesgo: una estancia que cruza de mes puede dejarlas en el mes equivocado; sin ingreso ni egreso no se cuentan.');
  add(R, 'Reintervenciones no planeadas (n)', 'entero', '', 'Egresos del mes con «Reintervención no planeada (probable)» = 1. Mismo sesgo que esa columna (texto libre, solo este episodio).');
  add(R, 'Ingresos sin talla (n)', 'entero', '', 'Ya no se mide (25 nov 2026): la talla no se registra en este servicio. La columna se queda vacía en su lugar (quitarla movería las demás). El IMC se sigue calculando si alguna vez hay talla.');
  add(R, 'Cirugías de urgencia (%) · Abordaje laparoscópico (%)', 'número', '%', 'Sobre las cirugías del mes que tienen el dato (urgencia/electiva; abordaje). Laparoscópico incluye las convertidas.');
  add(R, 'Conversiones (n) · Complicación mayor (Clavien ≥ IIIa) (n)', 'entero', '', 'Cirugías del mes convertidas de laparoscópica a abierta y con Clavien-Dindo ≥ IIIa.');
  add(R, 'Reintervenciones (n)', 'entero', '', 'Egresos del mes con «Reintervención» = 1.');
  add(R, 'Reingresos a 30 días (n) · Reingreso a 30 días (%)', 'entero · número', '%', 'Egresos del mes que reingresaron en 30 días, sobre los que ya tienen el dato (0/1).');
  add(R, 'Cultivos positivos (n) · Gérmenes (más frecuentes)', 'entero · texto', '', 'Cultivos de WinLab de pacientes del servicio tomados en el mes; los 5 gérmenes más frecuentes con su número.');
  add(R, 'Dx principales (más frecuentes) · Cirugías por grupo (más frecuentes)', 'texto', '', 'Los 5 más frecuentes del mes con su número (dx principal de los ingresos; grupo de las cirugías).');
  add(R, 'Ingresos con datos incompletos (n)', 'entero', '', 'Ingresos del mes a los que les falta algo de «Por completar» (motivo, sexo, edad, APP, peso, dx principal o cirugías). Desde el 24 nov 2026 ya no cuenta la talla y desde el 25 nov 2026 el sexo inferido del nombre cuenta como sexo: la cifra baja respecto a las corridas anteriores.');
  add(PC, 'Privacidad', '', '', 'TIENE NOMBRES: es la lista de trabajo del equipo para completar las tarjetas. No se comparte ni se descarga para estudios.');
  add(PC, 'ID episodio', 'texto', '', 'Id del paciente en la base (no es seudónimo): el de la tarjeta en la app.');
  add(PC, 'Estado · Cama · Nombre · Expediente · Fecha de ingreso · Fecha de egreso', 'texto', '', 'Del censo y de la Papelera (la última parte del episodio). Entran los hospitalizados, los egresados de los últimos 30 días y, desde el 24 nov 2026, TODO egresado sin motivo del egreso sin importar la fecha (van primero entre las filas nuevas, el egreso más reciente arriba).');
  add(PC, 'Falta · Faltantes (n)', 'texto · entero', '', 'Lo que le falta a la tarjeta para el registro: motivo del egreso, sexo, edad, APP, peso, dx principal (solo si el DX no coincide con ninguno de la lista), cirugías por pasar a la caja y cirugías sin urgencia/abordaje/Clavien. Cuando se completa, la fila queda «Vigente: No» (resuelta).');
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
  // 24 nov 2026: sitio, relación con la cirugía, multirresistencia y contaminante.
  add(C, 'Sitio (grupo)', 'texto', '', 'Sitio por palabras de «Tipo» + «Muestra» (el primero que coincide): ' + REG_CULT_SITIOS.map(function (x) { return x[0]; }).join(', ') + ' u Otro; vacío si no hay texto. Sesgo: depende de cómo nombra la muestra el laboratorio («SECRECIÓN» sin más va a herida / tejidos blandos; un líquido de drenaje va a abdominal).');
  add(C, 'Días desde la última cirugía · Posoperatorio (1-30 d)', 'entero · 0/1', 'días', 'Días de la cirugía más reciente del episodio (con fecha igual o anterior a la toma) a la toma; vacío si no hay episodio o no hay cirugía con fecha antes de la toma. Posoperatorio: 1 si son de 1 a 30 días; 0 si no (incluye el mismo día de la cirugía, que suele ser la muestra tomada EN la cirugía, y a quien no se operó); vacío sin episodio o sin fecha de toma. Sesgo: solo cirugías de ESTE episodio; fechas sin hora.');
  add(C, 'Multirresistente (probable)', '0/1', '', '1 = cultivo positivo con marca en el germen (BLEE, MRSA / SARM, KPC, NDM, carbapenemasa, VRE…), resistencia a un carbapenémico, S. aureus resistente a oxacilina o cefoxitina, enterococo resistente a vancomicina, o «Resistentes» con 3 o más de estas clases: carbapenémicos, cefalosporinas de 3.ª/4.ª, fluoroquinolonas, aminoglucósidos, piperacilina, trimetoprima/sulfametoxazol, tetraciclinas / tigeciclina, aztreonam, polimixinas. 0 = positivo con antibiograma que no cumple, o cultivo negativo. Vacío = sin resultado, o positivo sin antibiograma ni marca (no se sabe). Sesgo: NO es la definición internacional completa (Magiorakos 2012): solo cuenta «Resistentes» (no los intermedios), no descuenta la resistencia natural del germen (p. ej. Pseudomonas a ceftriaxona) y depende de los antibióticos que el laboratorio probó.');
  add(C, 'Contaminante probable', '0/1', '', '1 = hemocultivo positivo en el que TODOS los gérmenes son flora de piel (estafilococo coagulasa negativo, Corynebacterium, Micrococcus, Bacillus, Cutibacterium); 0 = otro positivo, o negativo; vacío = sin resultado. Sesgo: no se sabe cuántos frascos de la misma toma salieron positivos (un coagulasa negativo en 2 de 2 frascos o en un paciente con catéter puede ser una bacteriemia real).');
  // 24 nov 2026: «Análisis · Cirugías», una fila por cirugía.
  var Q = REG_AN_CIRUGIAS;
  add(Q, 'Fila', '', '', 'Una fila por cirugía de cada episodio: las de la caja Cirugías y las tomadas de otra caja (DX, Cronología, fecha POP, texto Qx), sin repetir entre las partes del episodio. NO entran la programación del día sin confirmar ni las tarjetas duplicadas (Excluir = 1). Sin nombre ni expediente; «Procedimiento» es texto libre (revisar antes de compartir). Son las mismas cirugías que cuenta «Cirugías (n)» de «' + E + '».');
  add(Q, 'ID cirugía', 'texto', '', 'Seudónimo de la cirugía (Q-…): del seudónimo del episodio y del id de la cirugía en la caja de la app o, si no lo tiene (inferidas y filas viejas), de su fecha y procedimiento. Sesgo: una cirugía inferida a la que le corrigen el texto o la fecha, o que se pasa a la caja, cambia de ID (la fila anterior queda «Vigente: No»): analizar solo Vigente = Sí.');
  add(Q, 'N.º de cirugía en el episodio · Es índice · Días desde la cirugía previa', 'entero · 0/1 · entero', '', 'Orden por fecha dentro del episodio (las cirugías sin fecha van al final, en el orden del registro); índice = la primera (1) o no (0); días desde la cirugía anterior con fecha (vacío en la primera o sin fecha). Sesgo: si la primera cirugía real no tiene fecha, la índice es otra.');
  add(Q, 'Grupo · Procedimiento · Fuente', 'texto', '', 'Grupo del procedimiento (la misma tabla de «Grupo de la 1.ª cirugía»), el texto del procedimiento tal cual y de dónde salió la cirugía (Caja Cirugías, Fecha POP de la tarjeta, Texto Qx (caja anterior), Cronología (inferida), DX (inferida)).');
  add(Q, 'Tipo · Urgencia inferida (día 0-1)', 'texto · 0/1', '', 'Tipo = Urgencia o Electiva como se eligió en la caja (vacío si no se eligió o la cirugía es inferida). Urgencia inferida: 1 si la cirugía fue el día del ingreso o el siguiente; 0 si después; vacío sin fecha de cirugía o de ingreso, o si la cirugía es anterior al ingreso. Sesgo: es un sustituto por fechas (un electivo que ingresa el mismo día de su cirugía da 1; una urgencia que esperó 2 días da 0): usar «Tipo» cuando exista.');
  add(Q, 'Abordaje · Abordaje (inferido del texto)', 'texto', '', 'Abordaje elegido en la caja (Abierta, Laparoscópica, Convertida, Endoscópica / percutánea, Otro) y, aparte, el que dice el TEXTO del procedimiento: Convertida (CONVERSIÓN / CONVERTIDA), Laparoscópica (LAPAROSCÓPICA, LAP, COLELAP), Endoscópica / percutánea (CPRE, endoscopía, percutánea, transuretral) o Abierta (ABIERTA, LAPAROTOMÍA, LAPE, toracotomía, esternotomía, craneotomía); vacío si el texto no lo dice. Sesgo: el inferido es texto libre y no implica abierta cuando falta la palabra; no se mezclan: decidir en el análisis cuál usar.');
  add(Q, 'Clavien-Dindo · Sangrado (mL)', 'texto · número', 'mL', 'Grado de complicación elegido en la caja para esa cirugía (vacío si no se eligió) y sangrado en mL si es un número limpio (vacío con «MÍNIMO», rangos o sin dato).');
  add(Q, 'Reintervención planeada (probable) · Reintervención no planeada (probable)', '0/1', '', 'La misma regla de «' + E + '», por cirugía: de la 2.ª en adelante, planeada = 1 si el texto dice segundo tiempo, second look, cierre de pared o diferido, recambio, lavado programado o VAC, o si se eligió «Electiva» en la caja; si no, no planeada = 1 cuando fue 1–30 días después de la índice (vacío si no tiene fecha y no se puede saber). En la índice ambas son 0, salvo una relaparotomía como primera cirugía registrada (no planeada = 1). Los procedimientos menores (endoscopia / CPRE, traqueostomía, catéteres, punciones) y otro renglón del mismo día que la índice llevan 0 en las dos. Sesgo: texto libre; solo cirugías de este episodio.');
  add(Q, 'Días cirugía→egreso · Defunción en el episodio', 'entero · 0/1', 'días', 'Días de la cirugía al egreso registrado (vacío si sigue hospitalizado, no hay egreso con fecha o la cirugía no tiene fecha) y la «Defunción» del episodio (1, 0 o vacío = desconocido: NUNCA tratar vacío como 0). Sesgo: es mortalidad hospitalaria en este servicio, no a 30 días; se repite en cada cirugía del episodio (no sumar por fila para contar muertes).');
  add(Q, 'Dx principal · Edad (años)', 'texto · número', '', 'Del episodio (las mismas de «' + E + '»), repetidos en cada cirugía para poder analizar la pestaña sola.');
  add(Q, 'Fecha estimada', 'texto AAAA-MM-DD', '', 'Solo en las cirugías SIN fecha: la fecha de ingreso del episodio (o la de egreso si no hay ingreso), la misma que usa el Resumen mensual para ponerlas en un mes. Vacío cuando la cirugía tiene fecha. Sesgo: no es la fecha de la cirugía.');
  add(Q, 'Revisar', 'texto', '', 'Lo que le falta a la fila: sin fecha, tomada de otra caja, sangrado sin número, sin urgencia / abordaje / Clavien-Dindo, reintervención sin fecha.');
  // 24 nov 2026: pestañas nuevas del registro (no son de análisis, pero sus columnas quedan definidas aquí).
  var I = REG_INTEGRIDAD.nombre, G = REG_GUARDIA_CORTES;
  add(I, 'Privacidad', '', '', 'Una fila por corrida del registro (nunca se pisa ni se borra). No tiene nombres, expedientes ni seudónimos: solo conteos, tiempos y avisos. Sirve para saber si el registro está completo antes de analizar un periodo.');
  add(I, 'Corrida · Versión', 'texto', '', 'Fecha y hora de inicio de la corrida (hora de Ciudad de México; si dos empiezan en el mismo segundo la segunda lleva «(2)») y versión del script. Sesgo: solo existe desde el 24 nov 2026; de las corridas anteriores no hay historial.');
  add(I, 'Resultado', 'texto', '', '«Completa» (se leyó y se escribió todo, análisis incluido), «Parcial: faltó …» (qué no se alcanzó o qué fuente no se pudo leer; lo demás sí se escribió) o «Falló: …» (causa sin datos de pacientes; las pestañas del registro no se tocaron). «en pausa: libro casi lleno» = el libro pasó del ' + Math.round(100 * REG_CELDAS_CRITICO) + ' % de las celdas de Sheets: no se leen ni escriben WinLab, RIS ni las pestañas de análisis hasta pasar lo viejo a un libro histórico (lo demás sí se escribe y Google manda un correo de error cada noche, a propósito). Una noche sin fila = el disparador no corrió (o el libro ya no admite ni un renglón).');
  add(I, 'Duración total (s) · Lectura (s) · Fusión y escritura (s) · Análisis (s)', 'número', 's', 'Segundos de reloj de la corrida y de cada etapa (leer Supabase; armar y escribir las pestañas del registro; pestañas de análisis). El límite de Google es 360 s. Vacío en la etapa a la que no se llegó. La duración total no incluye escribir esta misma fila.');
  add(I, 'Vueltas extra usadas (24 h)', 'entero', '', 'Continuaciones programadas en las últimas 24 h (máximo ' + REG_CONTINUACIONES_DIA + ').');
  add(I, 'Bytes leídos por tabla', 'texto JSON', 'caracteres', 'Tamaño de las respuestas de Supabase por tabla en la corrida ({"tabla": caracteres}). Aproxima lo bajado: cuenta caracteres del texto recibido (no bytes comprimidos en la red) y no incluye cabeceras ni los conteos sin cuerpo.');
  add(I, 'Episodios en base (n) · Episodios en Pacientes (n) · Diferencia (en base y no en Pacientes)', 'entero', '', 'En base: ids distintos del censo (con nombre o expediente) y de las copias de la Papelera que traen id de la base. En Pacientes: filas de la pestaña (incluye a quienes ya no están en la base, por eso suele ser mayor). Diferencia: ids de la base que NO están en Pacientes; debe ser 0. Sesgo: no cuenta las copias sin id de la base (rescates de iPad y copias en blanco); una copia con id pero sin nombre ni expediente sale como diferencia aunque no sea un episodio. Se hace UNA vez al día (la primera corrida del día): vacío en las vueltas extra y en las demás corridas de ese día, o si no alcanzó el tiempo o falló la lectura.');
  add(I, 'WinLab: filas en base (n) · WinLab: reportes en hoja (n)', 'entero', '', 'Filas de winlab_labs en la base (una por búsqueda del robot) y renglones de «' + REG_WL_LABS + '» (uno por reporte del paciente). NO son comparables una a una (una fila de la base trae varios reportes y se repite cada día): sirven para ver la tendencia. Vacío si la fuente falló en la corrida.');
  add(I, 'RIS: filas en base (n) · RIS: filas en hoja (n)', 'entero', '', 'Filas de ris_estudios en la base y en «' + REG_RIS + '». La hoja debe tener las mismas o más (nunca borra); si la base tiene más, se avisa. Durante la primera carga por partes la hoja va atrás.');
  add(I, 'WinLab actualizadas en sitio (n)', 'entero', '', 'Filas de winlab_labs que cambiaron en la base desde la corrida anterior (updated_at) y cuya captura es anterior a la ventana que se releyó (6 h antes de lo último leído): esas no se releen. Debe ser 0. Vacío en la primera corrida, durante una carga por partes o si no se pudo contar (ver Avisos).');
  add(I, 'Celdas recortadas (n)', 'entero', '', 'Celdas que en esta corrida pasaron de ' + REG_MAX_CELDA + ' caracteres y se guardaron cortadas (terminan en «' + REG_RECORTE.trim() + '»). Debe ser 0. Se vuelve a contar cada noche mientras el texto siga así de largo en la tarjeta; no cuenta lo recortado antes del 24 nov 2026.');
  add(I, 'Hospitalizados que salieron sin egreso (n)', 'entero', '', 'Filas de Pacientes con «Salió de la base sin egreso registrado» (acumulado en la hoja, no solo de hoy): episodios sin fecha ni motivo de egreso.');
  add(I, 'Celdas usadas · Avisos', 'entero · texto', '', 'Celdas de la cuadrícula de todo el libro (límite de Sheets: ' + REG_CELDAS_MAX + ') y los avisos de la corrida (los mismos del Diccionario más lo que no se pudo contar).');
  add(G, 'Privacidad', '', '', 'Copia fiel de texto libre de la guardia: puede traer nombres. No lleva columnas de nombre ni expediente (se cruza con Pacientes por «ID episodio»), pero NO es una pestaña de análisis: no compartir.');
  add(G, 'ID · Orden', 'texto · entero', '', 'Id del corte en la base (guardia_cortes) y lugar del renglón dentro de ese corte (1 = primero). Una fila por renglón.');
  add(G, 'ID episodio', 'texto', '', 'Id del paciente en la base (el de la tarjeta; no es seudónimo).');
  add(G, 'Fecha y hora', 'texto', '', 'Momento en que la base retiró los renglones (UTC, como lo guarda la base).');
  add(G, 'Motivo', 'texto', '', '«corte» (el de las 06:15, automático) o «borrado» (alguien quitó el renglón).');
  add(G, 'Renglón', 'texto', '', 'Texto del renglón retirado de la guardia, tal cual. Sesgo: la base purga esta tabla a los 7 días y el registro la copia desde el 24 nov 2026: lo anterior (menos los 7 días previos) no existe; si el registro deja de correr más de 6 días se pierden renglones (se avisa). No se sabe si un renglón lo escribió una persona o un proceso automático.');
  // 24 nov 2026: foto diaria, dispositivos, drenajes e historial de auditoría. Compactas (sin Expediente ni Nombre): se
  // cruzan con Pacientes por «ID episodio», que es el id de la base (NO un seudónimo): no son pestañas para compartir.
  var ED = REG_ESTADO_DIARIO, DI = REG_DISPOSITIVOS, DD = REG_DRENAJES_DIARIO, MV = REG_MOVIMIENTOS, SO = REG_SOPORTE, AC = REG_ACTIVIDAD;
  var idBase = 'Id del paciente en la base (el de la tarjeta; NO es seudónimo: con «Clave de seudónimos» se pasa al ID de análisis).';
  add(ED, 'Privacidad', '', '', 'Una fila por hospitalizado y noche: la foto de su tratamiento a la hora de la corrida. No lleva nombre ni expediente, pero el «ID episodio» es el de la base y «Antibiótico (texto)» y «Dieta» son texto libre: no compartir sin pasar por la clave de seudónimos.');
  add(ED, 'ID episodio · Fecha', 'texto · texto AAAA-MM-DD', '', idBase + ' Fecha = día de la corrida (Ciudad de México). Sesgo: SOLO existe desde el 24 nov 2026 (no se puede reconstruir hacia atrás: la tarjeta no guarda historial); refleja lo que la tarjeta decía a la hora de la corrida (~23 h), no lo que pasó en el día; una noche sin corrida = día sin fila; solo quien estaba en el censo esa noche (quien ingresó y egresó el mismo día no aparece). Una corrida después de medianoche crea la fila del día nuevo y la de las 23 h la reemplaza.');
  add(ED, 'Cama · Sección · Estado clínico', 'texto', '', 'Del censo esa noche, en mayúsculas y sin acentos. Si el valor no tiene la forma esperada (la sección y el estado deben ser de la lista conocida; la cama debe tener forma de cama: «3-151», «UCI 4», «12A») se escribe «' + REG_NO_VALIDO + '» en vez del texto (el censo de la hoja a veces trae texto corrido, incluso nombres).');
  add(ED, 'ATB (casilla) · NPO · NPT · VM', 'texto Sí/No', '', 'Casillas de la tarjeta esa noche: antibiótico, ayuno, nutrición parenteral y ventilación mecánica. Sesgo: «No» = casilla sin marcar, NO prueba que no lo recibía (el antibiótico puede estar solo en Manejo: ver «Antibióticos en Manejo (detectados)»).');
  add(ED, 'Antibiótico (texto) · Días ATB (escritos) · ATB inicio', 'texto', '', 'Lo escrito junto a la casilla de antibiótico: nombre(s), días anotados a mano y fecha de inicio (AAAA-MM-DD) si se capturó. El texto va en mayúsculas y sin acentos y SOLO si está hecho de vocabulario conocido (antibióticos de la lista, dosis, vía, «D5»); si trae cualquier otra palabra (podría ser un nombre) se guardan solo los antibióticos detectados con su día y la marca «' + REG_TEXTO_OMITIDO + '». Sesgo: un antimicrobiano que no está en la lista del script queda como «' + REG_TEXTO_OMITIDO + '» (el texto completo de HOY está en «Pacientes», pestaña con nombres); los días escritos a mano suelen quedarse atrasados; la fecha de inicio casi nadie la llena.');
  add(ED, 'Antibióticos en Manejo (detectados)', 'texto', '', 'Antimicrobianos de una lista cerrada de ' + REG_ATB.length + ' (con sus abreviaturas: MERO, PIP/TAZO, VANCO…) mencionados esa noche en la caja Manejo, separados por « · » y con nombre normalizado. No cuenta el que va negado en la misma frase («SIN MEROPENEM», «SE SUSPENDE VANCO», «ALERGIA A PENICILINA»). Sesgo: es texto libre (detecta menciones, no dosis ni vía); un fármaco fuera de la lista o mal escrito no se detecta; «COMPLETÓ», «VALORAR» y «PENDIENTE» antes del nombre lo descartan; la profilaxis de quirófano no se anota ahí.');
  add(ED, 'Dieta · NPT % · TVP', 'texto', '', 'Dieta escrita en la tarjeta (en mayúsculas y sin acentos; solo palabras de dieta conocidas: cualquier otra se omite y se marca «' + REG_TEXTO_OMITIDO + '»); porcentaje de NPT (si la casilla está marcada); TVP: «No» o «Sí» con el tipo y la dosis de la tromboprofilaxis. Sesgo: la casilla de TVP casi no se usa (un «No» no significa que no tenía profilaxis).');
  add(ED, 'Modo · FiO2 · PEEP · O2 L/min', 'texto', '', 'Parámetros del ventilador (solo si VM = Sí) y oxígeno suplementario del Pase Matutino, como se escribieron (texto: pueden traer unidad o «AA»).');
  add(ED, 'Norepinefrina mL/h · Norepinefrina mg/mL · Vasopresina mL/h', 'texto · número · texto', 'mL/h · mg/mL', 'Solo si el vasopresor está prendido en la tarjeta: velocidad escrita («Sí (sin mL/h)» si está prendido sin velocidad) y concentración de la norepinefrina (mg ÷ mL de la dilución). Vacío = apagado. Sesgo: la calculadora de vasopresores se usa poco; apagado en la tarjeta no prueba que no tenía vasopresor.');
  add(ED, 'Peso · Curación (necesaria/hecha) · Dispositivos (n)', 'texto · texto · entero', '', 'Peso del Pase Matutino (texto); casillas de curación («Necesaria · pendiente», «Necesaria · hecha», «Hecha» o vacío); cuántos dispositivos tenía la tarjeta esa noche (ver «' + DI + '»).');
  add(DI, 'Privacidad', '', '', 'Una fila por dispositivo (drenaje, sonda, estoma, catéter) de cada tarjeta. Sin nombre ni expediente; «ID episodio» es el de la base y sitio / características son texto libre: no compartir sin la clave de seudónimos.');
  add(DI, 'ID episodio · ID dispositivo', 'texto', '', idBase + ' ID dispositivo = el id que la app le dio en la lista de la tarjeta («sin id · tipo lado sitio» en los dispositivos viejos que no lo traen).');
  add(DI, 'Tipo · Tipo (grupo) · Lado · Sitio · Características', 'texto', '', 'Como están en la tarjeta. Tipo (grupo): ' + REG_DISP_GRUPOS.map(function (g) { return g[0]; }).join(', ') + ' u Otro, por palabras del tipo (el primero que coincide). Sesgo: el tipo es texto libre; «Otro» incluye lo que no se reconoce.');
  add(DI, 'Fecha de colocación · Gasto (último)', 'texto', '', 'Fecha de colocación que guarda la app (al agregar el dispositivo pone la de ese día: puede no ser la real si se capturó después) y el último gasto escrito (texto). El gasto de cada día está en «' + DD + '».');
  add(DI, 'Primera vez visto · Última vez visto · Vigente', 'texto AAAA-MM-DD · texto', '', 'Primera y última noche en que el registro vio el dispositivo en la tarjeta de un hospitalizado. Vigente: Sí = sigue en la tarjeta; No = ya no está, y «Última vez visto» APROXIMA el retiro (pudo retirarse cualquier día entre esa noche y la siguiente corrida). En un egresado, «Última vez visto» = fecha de egreso (seguía en la tarjeta al salir) y «Primera vez visto» queda vacía si el registro nunca lo vio hospitalizado. Sesgo: solo desde el 24 nov 2026; un dispositivo puesto y retirado entre dos corridas no aparece; borrar y volver a crear el dispositivo en la app da otro id (dos filas).');
  add(DD, 'Privacidad', '', '', 'Gasto de cada drenaje por noche. Sin nombre ni expediente; «ID episodio» es el de la base: no compartir sin la clave de seudónimos.');
  add(DD, 'ID episodio · ID dispositivo · Fecha · Tipo', 'texto', '', 'Una fila por dispositivo CON gasto escrito de cada hospitalizado y noche (Fecha = día de la corrida). Se cruza con «' + DI + '» por los dos ids.');
  add(DD, 'Gasto (texto) · Gasto (mL) · Características', 'texto · número · texto', 'mL', 'El gasto como está escrito y, si es un número limpio (con «mL» / «cc» si acaso), en mililitros; vacío si es otra cosa («ESCASO», «50-100»). Sesgo: es el ÚLTIMO gasto escrito a la hora de la corrida, no necesariamente el de 24 h de enfermería; si nadie lo actualizó, se repite el del día anterior; solo desde el 24 nov 2026.');
  add(MV, 'Privacidad', '', '', 'Movimientos del censo tomados de la auditoría de la base (tabla patients). No lleva nombre, expediente ni quién hizo el cambio; del registro de auditoría solo se piden cama, estado, sección y especialidad, y todo valor que no tenga la forma esperada se escribe «' + REG_NO_VALIDO + '». «ID episodio» es el de la base.');
  add(MV, 'ID · Campo', 'texto', '', 'Id de la fila de auditoría y campo que cambió (Cama, Estado clínico, Sección, Especialidad): una fila por campo cambiado; el alta y la baja del censo llevan Campo = Cama.');
  add(MV, 'ID episodio · Fecha y hora', 'texto', '', idBase + ' Fecha y hora del cambio en UTC, como la guarda la base. Sesgo: la auditoría empieza el 14 oct 2026 y la base la purga a los 180 días; lo copiado se conserva aquí.');
  add(MV, 'Operación · De · A', 'texto', '', '«Alta en censo» (A = cama al crearse la tarjeta), «Baja del censo» (De = cama al quitarse) o «Cambio» (valor anterior y nuevo). Sesgo: restaurar una tarjeta desde la Papelera se ve como una alta nueva (otro id); una corrección de captura se ve igual que un movimiento real.');
  add(MV, 'Origen', 'texto', '', '«app» = lo hizo una cuenta de la app; «hoja o proceso automático» = el censo de la hoja u otro proceso sin cuenta. No se guarda qué cuenta.');
  add(SO, 'Privacidad', '', '', 'Cambios de soporte y exposiciones tomados de la auditoría de las notas. Sin nombre ni expediente; «Quién» es un seudónimo de la cuenta. De / A de «Antibiótico (texto)» y «Dieta» son texto libre. «ID episodio» es el de la base: no compartir sin la clave de seudónimos.');
  add(SO, 'ID · Variable', 'texto', '', 'Id de la fila de auditoría y variable que cambió: ' + REG_AUD_NOTAS.map(function (x) { return x[1]; }).join(', ') + '. Una fila por variable cambiada. No se copian las listas (dispositivos, cirugías, cultivos): tienen su pestaña.');
  add(SO, 'ID episodio · Fecha y hora', 'texto', '', idBase + ' Fecha y hora en UTC. Si alguien teclea seguido, la base junta los guardados de hasta 30 min en una sola fila (la hora es la del último).');
  add(SO, 'De · A', 'texto', '', 'Valor anterior y nuevo: «Sí» / «No» en las casillas (vacío = la casilla aún no existía en la tarjeta), o el texto escrito (máximo 300 caracteres; en «Antibiótico (texto)» y «Dieta», solo vocabulario conocido, como en «' + REG_ESTADO_DIARIO + '»: lo demás se omite con «' + REG_TEXTO_OMITIDO + '»). Prender = De «No» o vacío, A «Sí». Sesgo: marca cuándo se CAPTURÓ el cambio en la tarjeta, no cuándo se inició o suspendió el tratamiento; solo desde el 14 oct 2026.');
  add(SO, 'Quién', 'texto', '', 'Seudónimo de la cuenta que hizo el cambio (U-…: SHA-256 del id de la cuenta con la sal secreta del registro) o «sin cuenta». Permite contar personas distintas sin saber quiénes son.');
  add(AC, 'Privacidad', '', '', 'Actividad de edición de las notas por episodio y día. Solo cuentas, horas y seudónimos de cuentas; sin nombre ni expediente. «ID episodio» es el de la base.');
  add(AC, 'ID episodio · Fecha', 'texto · texto AAAA-MM-DD', '', idBase + ' Fecha = día (Ciudad de México) de las ediciones.');
  add(AC, 'Ediciones (n) · Ediciones de noche (n)', 'entero', '', 'Filas de auditoría de la nota ese día (un tecleo seguido de hasta 30 min cuenta como UNA) y cuántas fueron de ' + REG_NOCHE[0] + ':00 a 0' + (REG_NOCHE[1] - 1) + ':59. No cuentan las escrituras que solo tocan labs o imagen (los robots y la sincronización de la app, lleven o no cuenta: ni se leen). Sesgo: mide guardados, no trabajo clínico; la lectura es por partes y se suma (si dos ediciones del mismo paciente quedan en vueltas distintas con sus ids en desorden puede faltar alguna); solo desde el 14 oct 2026.');
  add(AC, 'Usuarios (n) · Usuarios', 'entero · texto', '', 'Cuentas distintas que editaron la nota ese día y sus seudónimos (U-…, separados por « · »). Las ediciones sin cuenta no suman usuario.');
  add(AC, 'Primera hora · Última hora', 'texto HH:MM', '', 'Hora (Ciudad de México) de la primera y la última edición del día.');
  add(AC, 'Cajas tocadas', 'texto', '', 'Campos de la nota que cambiaron ese día (app, pa, manejo, pendientes, checklist, entrega…), separados por « · ».');
  add(AC, 'Último ID', 'entero', '', 'Id de auditoría más alto ya contado en la fila: es lo que evita contar dos veces lo que se relee (uso interno; no borrar).');
  add('Pacientes', REG_NOTA_JSON + ' · ' + REG_NOTA_JSON_2, 'texto JSON', '', 'Todo lo demás de la nota, sin archivos incrustados (bóveda de documentos, DICOM, capturas de drenajes, fotos, diagramas). Si no cabe en una celda (' + REG_MAX_CELDA + ' caracteres) sigue en la columna «· 2»: las dos pegadas son el JSON completo. Las filas escritas antes del 24 nov 2026 de episodios que ya no están en la base pueden seguir recortadas.');
  add('Pacientes', 'Fuente', 'texto', '', '«Censo (patients)», «Papelera (archive)» o «Papelera (borrado)»: la copia más reciente del episodio se había borrado de la Papelera y se tomó de archive_eliminados (desde el 24 nov 2026; lo borrado antes de esa fecha y no copiado no se recupera).');
  // 24 nov 2026: columnas nuevas de Pacientes y Cirugías (copia fiel, con nombres: no son de análisis).
  add('Pacientes', 'Egresado por', 'texto', '', 'Quién archivó la copia de la Papelera que da el egreso (archive.archived_by). Vacío en hospitalizados y en copias sin el dato. Sesgo: si el egreso lo hizo el censo de la hoja o un proceso automático es esa cuenta, no quien decidió el alta. Identifica a personal: no compartir.');
  add('Pacientes', 'Motivo de egreso registrado por · Motivo registrado el', 'texto', '', 'Quién eligió el motivo del egreso en la app y cuándo (UTC), solo cuando el «Motivo de egreso» que quedó es el elegido por una persona («… (registrado en la app)»). Sesgo: el nombre es el que el usuario escribió en su dispositivo (no es una cuenta verificada).');
  add('Pacientes', 'Última modificación por', 'texto', '', 'Quién guardó por última vez la nota (notes.updated_by) o, si no hay, la ficha del censo (patients.updated_by). Sesgo: los cambios que hace el censo de la hoja o un robot también quedan aquí; en egresados es lo que traía la copia de la Papelera.');
  add('Pacientes', 'Nota restaurada el', 'texto', '', 'Fecha y hora (UTC) en que la base restauró la nota desde la Papelera al volver el paciente al censo (notes.restaurada_en). Vacío si nunca se restauró.');
  add('Pacientes', 'Alias WinLab', 'texto', '', '«Nombre en WinLab» que alguien escribió en la tarjeta para que el robot encuentre sus laboratorios (checklist.winlab_alias). Es un nombre: no compartir.');
  add('Cirugías', 'ID cirugía', 'texto', '', 'Id de la cirugía en la caja Cirugías de la app. Vacío en las inferidas (DX, Cronología, fecha POP, texto Qx, programación) y en filas escritas antes del 24 nov 2026 de episodios que ya no están en la base. El análisis lo usa para no contar dos veces una cirugía a la que le corrigieron el texto.');
  add('Cirugías', 'Fotos (n) · Foto subida por · Foto subida el', 'entero · texto', '', 'Cuántas fotos tiene la cirugía en la app, y quién y cuándo subió la más reciente. No se copian las imágenes ni sus rutas. Vacío en las inferidas. Sesgo: una foto borrada en la app deja de contarse.');
  // 24 nov 2026 (lote C, 2.ª parte): columnas de apoyo, eventos adversos, antibióticos por curso, completitud, flujo e indicadores.
  var EV = REG_AN_EVENTOS, AB = REG_AN_ATB, CO = REG_AN_COMPLETITUD, FL = REG_AN_FLUJO, IN = REG_AN_INDICADORES;
  add(E, 'Tipo de egreso (probable) · Fuente del tipo', 'texto', '', 'SOLO en el egresado sin motivo registrado (Defunción vacía): «Alta», «Alta voluntaria» o «Traslado» si un renglón de guardia, cronología o pendientes lo dice (ALTA A DOMICILIO, PREALTA, TRASLADO A OTRO HOSPITAL…) sin negación ni condición: no cuentan «ALTA SI TOLERA…», «PROBABLE ALTA MAÑANA», el alta de un interconsultante («ALTA POR MEJORIA DE NEFROLOGIA»), el traslado dentro del hospital («TRASLADO A UNIDAD DE CUIDADOS INTENSIVOS») ni «DOLOR QUE SE REFIERE A…»; si no, «Volvió al censo» cuando la misma persona tiene un episodio posterior (egresó viva), o «Sigue en el hospital» si WinLab (sin los reportes de consulta externa o urgencias: un laboratorio de control posalta no es hospitalización) o el RIS traen estudios de 1 a 30 días después del egreso (el RIS no dice la procedencia: un estudio ambulatorio también da este valor). «Fuente del tipo» dice de dónde salió. NUNCA alimenta «Defunción» ni «Tipo de egreso»: si algún renglón habla de una defunción queda vacío. Sesgo: una PREALTA escrita días antes no prueba que el paciente se fue de alta; es una pista para completar el motivo en la app, no un desenlace. Desde el 25 nov 2026 «Fuente del tipo» también dice «Censo (hoja): sección ALTAS» o «Censo (hoja): sección DEFUNCIONES» cuando el motivo REGISTRADO («Tipo de egreso») lo tomó el script del censo de esa sección (ahí «Tipo de egreso (probable)» queda vacío: el motivo ya está registrado).');
  add(E, 'Desenlace conocido', '0/1', '', '1 = egreso con motivo registrado (Defunción = 0 o 1); 0 = egreso sin motivo; vacío = sigue hospitalizado, sin egreso registrado o tarjeta duplicada. Sesgo: si las defunciones se registran más que las altas, la mortalidad sobre «desenlace conocido» sobreestima (ver los dos indicadores de mortalidad en «' + IN + '»).');
  add(E, 'Días al reingreso · Dx principal del reingreso', 'entero · texto', 'días', 'Días del egreso al ingreso del episodio SIGUIENTE de la misma persona (cualquier plazo, no solo 30 días) y el dx principal de ese episodio. Vacío si no hay episodio siguiente, si falleció o si las fechas se traslapan. Sesgo: solo ve reingresos a ESTE servicio; depende de que el expediente esté bien capturado.');
  add(E, 'Reingreso planeado (probable) · Reingreso no planeado a 30 días · Reingreso con cirugía', '0/1', '', 'Planeado = 1 si alguna cláusula del diagnóstico, el padecimiento o los procedimientos del episodio siguiente dice a qué venía (cierre de ileostomía / colostomía, restitución del tránsito, segundo tiempo, cirugía programada, quimioterapia, retiro de catéter…) o su primera cirugía se eligió «Electiva»; vacío sin episodio siguiente. NO cuenta la cláusula que solo NOMBRA lo previo («PO CIERRE DE ILEOSTOMIA», «POSTERIOR A QUIMIOTERAPIA») o lo niega («NO PROGRAMADO PARA…»), y si el DIAGNÓSTICO del reingreso trae una complicación (fuga, sepsis, absceso, dehiscencia, oclusión, sangrado, infección, neutropenia…) es 0 aunque nombre la cirugía: los reingresos por complicación siempre citan la cirugía previa. No planeado a 30 días = «Reingreso a 30 días» = 1 y no planeado (0 si no reingresó o fue planeado; vacío si «Reingreso a 30 días» está vacío). Con cirugía = el reingreso de ≤30 días tuvo alguna cirugía. Sesgo: «planeado» sale de palabras del texto libre: un reingreso programado que no lo dice cuenta como no planeado.');
  add(E, 'Seguimiento posalta observable (días)', 'entero', 'días', 'Días del egreso a la fecha de la corrida, con tope de ' + REG_SEGUIMIENTO_MAX + ' (vacío en defunciones y en quien no ha egresado). Menos de 30 = aún no se puede saber si reingresó. Sesgo: es el tiempo que el REGISTRO ha podido observar, no un seguimiento clínico (no hay consulta ni llamada posalta).');
  add(E, 'Edad al ingreso (calculada)', 'entero', 'años', 'Años cumplidos a la fecha de ingreso con la fecha de nacimiento del encabezado de WinLab del paciente (mismo expediente y nombre compatible). Vacío si WinLab no la trae, trae más de una o no hay fecha de ingreso. La fecha de nacimiento NO se copia a las pestañas de análisis. Sesgo: solo se llena con los reportes que el registro LEYÓ desde el 24 nov 2026 (los nuevos y los que se vuelven a capturar). El dato SÍ existe en la base para los reportes anteriores, pero WinLab no se releyó completo para tomarlo (costo de transferencia): en los egresados de antes casi siempre queda vacío, y su renglón de «Completitud» será bajo por eso, no porque el laboratorio no lo tenga. Si el estudio la necesita, pedir una relectura única de WinLab. En pediatría da años enteros (un lactante = 0). Compararla con «Edad (años)» de la tarjeta sirve para encontrar edades mal capturadas.');
  add(E, 'Periodo de captura', 'texto', '', '«Anterior a la captura estructurada» si el episodio terminó antes del ' + REG_CAPTURA_ESTRUCTURADA + ' (la app aún no pedía el motivo del egreso ni tenía urgencia / abordaje / Clavien-Dindo ni dx principal); «Estructurada» después. Sesgo: en el periodo anterior casi todo es inferido de texto: analizar los dos periodos por separado o restringir a «Estructurada».');
  add(E, 'Clavien-Dindo mínimo inferido · Clavien (fuente)', 'texto', '', 'SOLO en operados: el grado más alto que implican los eventos de «' + EV + '» (defunción V; vasopresor o ventilación que EMPIEZA desde el día posoperatorio 1, IVa; relaparotomía o reintervención dicha en el texto IIIb; drenaje percutáneo en el RIS después de la cirugía IIIa; bacteriemia, fuga o dehiscencia de anastomosis, fístula, neumonía, TEV, sepsis o transfusión II; lesión renal posoperatoria, ISQ, dehiscencia de herida, íleo, evisceración o hemorragia I), o «' + REG_SIN_EVENTO + '». Fuente: «' + REG_CERTEZA_OBJ + '» si el grado lo sostiene un evento objetivo; «' + REG_CERTEZA_TXT + '» si solo una mención en texto libre. NO cuentan: los eventos objetivos anteriores a la cirugía; el vasopresor o la ventilación que ya tenía el día de la cirugía o antes y sigue sin interrupción (el choque que llevó a operar); la lesión renal que no se puede saber posoperatoria; y lo que no lleva grado (2.ª cirugía solo por fechas, drenaje percutáneo solo mencionado en texto, reingreso, UCI). La mención en texto no distingue lo ocurrido antes de la cirugía de lo de después. Sesgo: es un PISO (lo que no se registró no se ve; el grado real puede ser mayor) y las menciones en texto no están validadas contra el expediente; no sustituye a «Clavien-Dindo máximo», el elegido en la caja, que no se toca.');
  add(E, 'Complicación mayor inferida (≥ IIIa)', '0/1', '', '1 si «Clavien-Dindo mínimo inferido» es IIIa o más; 0 si el operado no tiene evento de ese grado; vacío sin cirugía o en tarjeta duplicada. Sesgo: 0 significa «no se detectó», no «no hubo»; depende de la cobertura del diario, del laboratorio y de lo escrito en la tarjeta.');
  add(E, 'Eventos adversos (n)', 'entero', '', 'Filas del episodio en «' + EV + '» (vacío en tarjetas duplicadas). Sesgo: cuenta tipos de evento detectados, no gravedad; un mismo problema puede dar varios eventos (sepsis + vasopresor + UCI).');
  add(EV, 'Fila', '', '', 'Una fila por evento adverso detectado en cada episodio (no en tarjetas duplicadas), de un catálogo cerrado. Sin nombre ni expediente. Sirve para revisar caso por caso: validar una muestra contra el expediente antes de publicar.');
  add(EV, 'Evento', 'texto', '', 'Catálogo: Defunción, Reintervención no planeada, Reingreso 30 d (no planeado), LRA (KDIGO), ISQ probable, Bacteriemia, Vasopresor, Ventilación, UCI, Drenaje percutáneo, y por mención en texto: ' + REG_EVENTOS_TEXTO.map(function (t) { return t[0]; }).join(', ') + '. Una fila por evento y episodio; solo «' + REG_EVENTOS_MULTIPLES.join('» y «') + '» pueden repetirse (una por fecha).');
  add(EV, 'Ocurrencia', 'texto', '', 'Parte de la clave de la fila (episodio + evento + ocurrencia). «' + REG_EVENTO_UNICO + '» en los eventos que son uno por episodio: si después se corrige su fecha (se captura la cirugía, cambia el egreso, llega más historial) la fila es la MISMA y conserva «Revisado». En los que se repiten (' + REG_EVENTOS_MULTIPLES.join(', ') + ') es la fecha, o «' + REG_EVENTO_SIN_FECHA + '». Sesgo: en los que se repiten, corregir la fecha sí deja la fila anterior en «Vigente: No» (su «Revisado» se queda en ella).');
  add(EV, 'Detalle', 'texto', '', 'Lo que precisa al evento sin cambiar su fila: el estadio en «LRA (KDIGO)» («Estadio 1 / 2 / 3»: si sube, es la misma fila) y «Ya lo tenía el día de la cirugía o antes» en el vasopresor o la ventilación que no empezaron después de operarse (se listan, pero no cuentan para el Clavien inferido). Vacío en los demás.');
  add(EV, 'Fecha · Día posoperatorio', 'texto AAAA-MM-DD · entero', 'días', 'Fecha del evento cuando se sabe (egreso en la defunción, fecha de la reintervención, ingreso del reingreso, primer día con criterio de LRA, toma del cultivo, fecha del estudio del RIS; en vasopresor y ventilación, la primera noche del primer tramo que EMPIEZA después de la cirugía o, si no lo hay, la primera noche con soporte); vacía en las menciones en texto y en UCI. Día posoperatorio = días desde la primera cirugía con fecha (negativo = antes de operarse; vacío sin alguna de las dos fechas).');
  add(EV, 'Fuente · Certeza', 'texto', '', 'De dónde salió (motivo de egreso, cirugías, laboratorio, cultivo, Estado diario o historial, movimientos del censo, RIS, texto de la tarjeta o del diagnóstico). Certeza: «' + REG_CERTEZA_OBJ + '» = sale de un dato estructurado o de laboratorio; «' + REG_CERTEZA_PROB + '» = una 2.ª cirugía que parece reintervención solo por las fechas (sin grado: revisar); «' + REG_CERTEZA_TXT + '» = solo una mención afirmada en texto libre. La mención NO cuenta si va negada antes o después («SIN DATOS DE FUGA», «NO PRESENTA DATOS DE SEPSIS», «NO CURSA CON NEUMONIA», «NEUMONIA DESCARTADA», «TRANSFUSION NO REQUERIDA»), es un plan, un riesgo o un antecedente («VIGILAR SANGRADO», «PROBABLE NEUMONÍA»), es preventiva o condicional («PARA EVITAR BRONCOASPIRACION», «TRANSFUNDIR SI HB <7», «SOLICITAR 2 PG», «EN CASO DE SANGRADO») o habla de un familiar; «… RESUELTA» sí cuenta. Sesgo: la mención no confirma el evento ni dice cuándo fue (antes o después de la cirugía); «Fuga / dehiscencia» es de anastomosis, muñón o vía biliar; la dehiscencia de herida, o la que no dice de qué, va en «Dehiscencia de herida» (grado I); neumonía, sepsis, trombosis, íleo y transfusión no se buscan en el Diagnóstico (ahí suelen ser el motivo de ingreso).');
  add(EV, 'Grado Clavien mínimo implícito', 'texto', '', 'Grado de Clavien-Dindo más bajo compatible con el evento (un piso; vacío en Reingreso y UCI, que por sí solos no dan grado, en la reintervención «' + REG_CERTEZA_PROB + '» y en el drenaje percutáneo solo mencionado en texto). En un episodio sin cirugía no aplica.');
  add(EV, 'Revisado', 'texto', '', 'Columna para quien valida contra el expediente (p. ej. «Confirmado», «Descartado», iniciales y fecha): el registro NUNCA la pisa. Vacía al crearse la fila.');
  add(AB, 'Fila', '', '', 'Una fila por CURSO de antibiótico de cada episodio: noches seguidas en que el registro vio el mismo antimicrobiano de la lista cerrada. Sin nombre ni expediente. Sesgo general: solo desde el 24 nov 2026 (fotos nocturnas) o el 14 oct 2026 (historial); refleja lo ESCRITO en la tarjeta a las 23 h, no lo administrado; no mide dosis, vía ni la profilaxis de quirófano (no se anota).');
  add(AB, 'Antibiótico · Clase · AWaRe', 'texto', '', 'Nombre normalizado (lista cerrada del registro), su clase y su grupo AWaRe de la OMS (Access, Watch, Reserve; vacío en antifúngicos). Sesgo: un fármaco fuera de la lista o mal escrito no aparece.');
  add(AB, 'Inicio · Inicio estimado · Fin · Días de tratamiento', 'texto AAAA-MM-DD · entero', 'días', 'Inicio = primera noche en que se vio; Fin = última noche seguida. Inicio estimado: si esa primera noche el texto trae el día junto al nombre («MEROPENEM D5») se retrocede (fecha − 4); con un solo antibiótico en la casilla también vale la fecha de inicio de la tarjeta o los días escritos; vacío si no hay con qué. Nunca queda antes del INGRESO (se topa ahí: los días de antes no son de esta estancia), se descarta si retrocede ' + REG_ATB_DIAS_MAX + ' días o más (año mal escrito), «D10 DE ESTANCIA» o «DIA 3 PO» no son el día del antibiótico, y si alcanza al curso anterior del MISMO antibiótico los dos son un solo curso (no se cuentan dos veces sus días). Días = de Inicio estimado (o Inicio) a Fin, ambos incluidos. Un hueco de hasta 3 días sin foto no parte el curso. Sesgo: Fin es la última noche VISTA (el curso pudo terminar al día siguiente o seguir tras el egreso); subestima lo anterior a las fotos.');
  add(AB, 'Sigue al egreso', '0/1', '', '1 = el curso llega a la última noche hospitalizado (probablemente siguió al egreso); 0 = terminó antes; vacío = aún hospitalizado.');
  add(AB, 'Cultivo previo o ≤24 h · Germen aislado · Concordante con antibiograma', '0/1 · texto · 0/1', '', 'Cultivo previo: 1 si el episodio tiene algún cultivo del robot tomado antes del inicio o hasta el día siguiente; 0 si no; vacío sin expediente válido. Germen: los de cultivos positivos no contaminantes tomados hasta el fin del curso. Concordante: 0 si algún antibiograma de esos cultivos lo reporta resistente; 1 si alguno lo reporta sensible; vacío si no se probó. Sesgo: compara por nombre del fármaco (no por clase) y no distingue de qué sitio es el cultivo.');
  add(AB, 'Días desde la última cirugía', 'entero', 'días', 'Días de la cirugía más reciente del episodio (anterior o del mismo día) al inicio del curso; vacío si no hay.');
  add(AB, 'Fuente', 'texto', '', '«Casilla» (casilla de antibiótico prendida y el texto lo nombra), «Texto de manejo» (detectado en la caja Manejo) y / o «Historial» (del historial de auditoría, solo en noches sin foto).');
  add(CO, 'Mes de ingreso · Variable', 'texto', '', 'Mes de ingreso del episodio (AAAA-MM) o «Acumulado» (todos, también los que no tienen fecha de ingreso). Variable: el dato que se mide. Las de «Cirugía con …» cuentan cirugías, no episodios, y van al mes de ingreso de su episodio.');
  add(CO, 'Con dato (n) · Aplicables (n) · Completitud (%)', 'entero · entero · número', '%', 'Episodios (o cirugías) no duplicados que tienen el dato ÷ aquellos a los que aplica (p. ej. el tipo de egreso solo aplica a egresados; la tromboprofilaxis, a operados). Sesgo: mide si el dato ESTÁ, no si es correcto. Desde el 25 nov 2026: «Sexo (inferido del nombre)» se cuenta aparte (no se mezcla con «Sexo (escrito en la tarjeta)»; «Sexo (cualquier fuente)» incluye las tres) y «Talla» ya no se mide (la talla no se registra en este servicio; las filas de «Talla» de corridas anteriores quedan con Vigente: No).');
  add(FL, 'Orden · Paso · Episodios (n)', 'entero · texto · entero', '', 'Diagrama de flujo de la cohorte (tipo STROBE): de todos los episodios del registro se restan, en orden, duplicados, borrados o «no fue egreso», no egresados y egresados sin desenlace conocido; cada episodio sale en el PRIMER paso que le toca. «= Episodios analizables» es el MISMO conjunto de «' + IN + '»: es el denominador de «Mortalidad hospitalaria (desenlace conocido)» en «Acumulado». Después, cuántos de los analizables están operados, tienen laboratorio seriado o no tienen fecha de ingreso (cuentan para mortalidad, no tienen estancia), y lo que el robot vio sin episodio (cultivos y expedientes de WinLab).');
  add(IN, 'Periodo · Estrato', 'texto', '', 'Periodo: mes (AAAA-MM), trimestre (AAAA-T1…T4) o «Acumulado»; los indicadores por episodio van al mes de EGRESO, los de cirugía al de la cirugía. Estrato: Todos, Urgencia o Electiva (tipo elegido en la caja), «Dx: …» (dx principal) o «Cirugía: …» (grupo). Para no gastar celdas, el mes solo lleva «Todos»; el trimestre agrega Urgencia y Electiva; «Acumulado» agrega Dx y grupo cuando tienen ' + REG_INDICADOR_MIN + ' o más.');
  add(IN, 'Indicador · Definición', 'texto', '', 'Nombre y definición operativa (numerador ÷ denominador y su sesgo). Universo: egresos observados que no son tarjetas duplicadas ni borrados en la base (el mismo de «' + FL + '»). Indicadores: ' + REG_INDICADORES.map(function (x) { return x.n; }).join('; ') + '.');
  add(IN, 'Numerador · Denominador · Excluidos por dato faltante (n)', 'entero', '', 'Casos con el evento y casos con el dato. «Excluidos» = casos del universo a los que les falta el dato (no entran al denominador): si son muchos, la tasa no representa al servicio. En las medianas el numerador va vacío; en las razones son sumas de días.');
  add(IN, 'Tasa (%) · IC95 inferior · IC95 superior', 'número', '%', 'Numerador ÷ denominador × 100 e intervalo de confianza de 95 % de Wilson (sin corrección de continuidad). VACÍOS si el denominador es menor de ' + REG_INDICADOR_MIN + ' (se dejan n y N). Solo en proporciones.');
  add(IN, 'Valor · Unidad', 'número · texto', '', 'Para lo que no es una proporción: la mediana (días) o la razón (días de antibiótico por 100 días-paciente; % de días Watch o Reserve). Vacío con menos de ' + REG_INDICADOR_MIN + ' casos. Unidad dice cómo leerlo («%» en las proporciones).');
  add(REG_AN_RESUMEN, 'Egresos con motivo (%) · Con sexo (%) · Episodios sin labs (n)', 'número · número · entero', '', 'Desde el 24 nov 2026: egresos del mes con motivo registrado ÷ egresos; ingresos del mes con sexo (de la tarjeta, de WinLab o, desde el 25 nov 2026, inferido del nombre) ÷ ingresos; ingresos del mes sin ninguna fecha de laboratorio. Sesgo: miden llenado, no calidad del dato.');
  // 25 nov 2026 (registro 2026.11.26-2): procedimientos del censo y seguimiento de operados.
  var PCZ = REG_PROC_CENSO, SG = REG_SEGUIMIENTO, desdeProc = 'Solo hay datos desde el 25 nov 2026: Google no guarda los censos viejos (la hoja del censo se reescribe cada día y la sección PROCEDIMIENTOS de días anteriores no se puede recuperar).';
  add(REG_AN_RESUMEN, 'Procedimientos en el censo (n) · Procedimientos en el censo de CG (n) · Ambulatorios (n)', 'entero', '', 'Filas de «' + PCZ + '» con fecha en el mes (una por fecha + expediente + nombre: el mismo paciente listado dos días cuenta dos veces); las de especialidad CG (Cirugía General, también en combinación «CG/URO»); las ambulatorias (cama EXT o sin episodio del registro que cubra la fecha). VACÍAS antes de noviembre de 2026 (no hay dato, no es cero). Sesgo: ' + desdeProc + ' Noviembre de 2026 es un mes incompleto. Lo que el equipo no anotó en la sección no se cuenta.');
  add(PCZ, 'Privacidad', '', '', 'TIENE NOMBRES Y EXPEDIENTES: copia fiel de la sección PROCEDIMIENTOS de la hoja del censo (tabla censo_procedimientos, la escribe el script del censo). No es una pestaña de análisis: no compartir.');
  add(PCZ, 'ID · Fecha · Cama · Expediente · Nombre · Edad · Diagnóstico · Especialidad · Adscrito · Residente', 'texto', '', 'Una fila por fecha del censo + expediente + nombre (el mismo expediente con dos nombres son dos filas). Fecha = la del censo (celda A2 de la hoja; si no se entiende, el día en que se leyó). Cama tal cual: «3-152», «EXT» (ambulatorio), «QX», «UCIP». ' + desdeProc);
  add(PCZ, 'Visto primero · Visto por última vez', 'texto (fecha y hora UTC)', '', 'Primera y última vez que el script del censo vio la fila en la hoja (cada 5 min; «última vez» se actualiza como mucho cada hora mientras siga igual). El script del censo reescribe juntas todas las filas que siguen en la hoja ese día (misma «última vez»); si la hoja se corrige o se quita una fila, la vieja se queda con su «última vez» y sale «Vigente: No».');
  add(PCZ, 'ID episodio · Ambulatorio · Grupo · Vigente', 'texto', '', 'ID episodio: el de «Pacientes» con el mismo expediente y nombre compatible cuya estancia (ingreso → egreso, o hasta hoy si sigue hospitalizado) cubre la fecha; vacío si no hay (se recalcula cada noche: un episodio que aparece después también se liga). Desde el 25 nov 2026 (revisión), con cama que no es EXT (QX, UCIP, piso) y sin estancia que cubra la fecha, también el episodio que ingresó al día siguiente (cirugía de urgencias la víspera del ingreso al servicio). Ambulatorio: «Sí» si la cama es EXT o no hay episodio; VACÍO (no se sabe) si el expediente no es válido para el registro (menos de 4 dígitos) y la cama no es EXT: no cuenta en «Ambulatorios (n)». Grupo: grupo quirúrgico que se reconoce en el DIAGNÓSTICO (la sección no trae el procedimiento: muchas filas quedan sin grupo). Vigente: «No» si su «Visto por última vez» es anterior (más de 1 min) al más reciente de las filas de su misma fecha: salió de la hoja ese día (se corrigió el nombre o el expediente, o se canceló). La tabla no borra filas; las «No» no cuentan en el Resumen mensual ni en «' + SG + '». Sesgo: si el equipo quita de la sección a un operado real antes de que cambie la fecha del censo, también queda «No».');
  add(SG, 'Privacidad', '', '', 'TIENE NOMBRES Y EXPEDIENTES: lista de trabajo para dar seguimiento a los operados, como «Por completar». No se comparte ni se descarga para estudios. ' + desdeProc);
  add(SG, 'Expediente · Nombre · Edad', 'texto', '', 'Una fila por persona (expediente válido + nombre compatible, la misma regla de identidad que el resto del registro) que aparece en «' + PCZ + '» o tiene cirugías en el registro (de la caja y las inferidas; no la programación sin confirmar ni las tarjetas duplicadas). Nombre: el PRIMERO que se vio de la persona (episodio por fecha de ingreso o procedimiento por fecha), en mayúsculas, sin acentos ni espacios dobles: es parte de la clave de la fila y no cambia porque la tarjeta y el censo lo escriban distinto. Edad: la del registro más reciente (procedimiento del censo o episodio). Expediente: si el del censo no es válido para el registro (menos de 4 dígitos), va tal cual y la persona se identifica por ese texto y el nombre.');
  add(SG, 'Nombre más reciente', 'texto', '', 'El nombre tal como lo escribe el registro más reciente de la persona (procedimiento del censo o episodio), con acentos. Desde el 25 nov 2026 (revisión).');
  add(SG, 'Sexo · Sexo (fuente)', 'texto', '', 'El del episodio más reciente que lo tenga, con su fuente («Tarjeta», «de WinLab», «Inferido del nombre»); sin episodio: el de WinLab o, si no, el inferido del nombre.');
  add(SG, 'Primer procedimiento · Último procedimiento', 'texto AAAA-MM-DD', '', 'Fechas de los procedimientos del censo y de las cirugías con fecha del registro de la persona. Las cirugías sin fecha no cuentan aquí (sí en «Cirugías registradas (n)»).');
  add(SG, 'Procedimientos en el censo (n) · Cirugías registradas (n)', 'entero', '', 'Días distintos en que la persona aparece en la sección PROCEDIMIENTOS del censo; cirugías de sus episodios en el registro (caja Cirugías y las inferidas de otras cajas). Sesgo: un mismo procedimiento puede estar en las dos cuentas.');
  add(SG, 'Especialidades · Diagnóstico más reciente', 'texto', '', 'Especialidades del censo y de sus episodios (mayúsculas, sin acentos, sin repetir); el diagnóstico del registro más reciente.');
  add(SG, 'ID episodios · ¿Hospitalizado ahora? · Último egreso · Motivo del último egreso', 'texto', '', 'Ids de base de sus episodios en «Pacientes» (de la más vieja a la más nueva); «Sí» si alguno sigue en el censo; fecha y tipo del egreso más reciente (como «Tipo de egreso» de «' + E + '»: «Motivo no registrado» si nadie lo clasificó).');
  add(SG, 'Días desde el último procedimiento · Reingresos posteriores (n)', 'entero', 'días', 'Días del último procedimiento a la fecha de la corrida, solo durante los primeros ' + REG_SEGUIMIENTO_DIAS_MAX + ' días (después queda vacío: la fecha sigue en «Último procedimiento»); episodios de la persona que ingresaron DESPUÉS del primer procedimiento, sin el episodio que contiene ese procedimiento (cirugía o procedimiento del censo ligado a él, también la cirugía de urgencias la víspera del ingreso). Sesgo: solo se ven los reingresos a este servicio.');
  add(SG, 'Vigente', 'texto', '', 'Sí: la persona sigue saliendo así hoy. Se ordena por último procedimiento (el más reciente arriba); las filas que ya estaban conservan su renglón.');
  add(REG_WL_LABS, 'Nacimiento en WinLab', 'texto DD/MM/AAAA', '', 'Fecha de nacimiento del encabezado del reporte (24 nov 2026). Es un dato identificable de una pestaña con nombres: no compartir. Solo se llena en los reportes que el registro leyó desde esa fecha (los nuevos y los que se vuelven a capturar): el encabezado SÍ está en la base para los anteriores, pero WinLab no se releyó completo para tomarlo. De aquí sale «Edad al ingreso (calculada)».');
  // Lo que toda lectura de estas pestañas debe tener presente, y lo que esta fuente NO tiene (hay que capturarlo en la app).
  var SL = 'Sesgos y limitaciones', ND = 'No disponible en esta fuente';
  add(SL, 'Registro, no expediente', '', '', 'Todo sale de lo que el equipo escribe en la app para pasar visita y de los robots de laboratorio e imagen. Lo que no se escribió no existe aquí: vacío = no se sabe, nunca «no».');
  add(SL, 'Motivo de egreso', '', '', 'Muchos egresos no tienen motivo: la mortalidad se calcula sobre una fracción. Reportar siempre las dos mortalidades de «' + IN + '» (desenlace conocido y desconocidos como vivos) y la completitud del mes.');
  add(SL, 'Variables inferidas de texto', '', '', 'Comorbilidades, Charlson, cirugías inferidas, reintervención no planeada, eventos adversos por mención, tipo de egreso probable y reingreso planeado salen de palabras en texto libre con reglas de negación. Antes de publicar, validar una muestra contra el expediente y reportar su valor predictivo.');
  add(SL, 'Solo hacia adelante', '', '', 'Las fotos nocturnas («Estado diario», dispositivos, drenajes) empiezan el 24 nov 2026 y el historial de auditoría el 14 oct 2026: días de antibiótico, ayuno, NPT, ventilación, vasopresor y los cursos de antibiótico SUBESTIMAN en todo episodio anterior. Usar «Cobertura del diario (%)» y «Periodo de captura» para restringir.');
  add(SL, 'Un solo servicio', '', '', 'Reingresos, reintervenciones y defunciones fuera de este servicio (otro hospital, otro servicio, domicilio) no se ven. La mortalidad es hospitalaria, no a 30 días.');
  add(SL, 'Laboratorio e imagen', '', '', 'Los robots buscan a los pacientes del censo de ciertas especialidades: sin laboratorio no significa que no se tomó. La creatinina basal es la mínima del episodio (subestima la lesión renal de quien llega lesionado y no se recupera); la lesión POSOPERATORIA solo se decide con una creatinina de antes de operarse.');
  add(SL, 'Seudónimos, no anonimato', '', '', 'Fechas, diagnóstico y procedimientos pueden identificar a alguien. Compartir solo con protocolo aprobado por el Comité de Ética y con una copia congelada a la fecha de corte.');
  [['ASA y clase de herida', 'Riesgo anestésico (ASA) y clase de herida (limpia, limpia-contaminada, contaminada, sucia): indispensables para ajustar ISQ y mortalidad.'],
    ['Horas de la cirugía', 'Hora de ingreso a urgencias, de incisión y de cierre; tipo de anestesia; lista de verificación de cirugía segura.'],
    ['Profilaxis antibiótica', 'Antibiótico ≤60 min antes de la incisión y su suspensión ≤24 h; indicación del antibiótico (profilaxis o tratamiento), dosis y vía.'],
    ['Retiro de dispositivos y gasto de 24 h', 'Fecha de retiro de cada dispositivo (hoy se aproxima con la última noche en que se vio) y gasto de 24 h de enfermería.'],
    ['Transfusión, UCI y diálisis', 'Unidades y fecha de transfusión, fechas de ingreso y egreso de UCI, terapia de reemplazo renal.'],
    ['Complicaciones codificadas', 'Tipo de complicación y grado por complicación (para el Comprehensive Complication Index), reintervención planeada sí / no, causa de la defunción.'],
    ['Seguimiento a 30 días posalta', 'Infección de herida ambulatoria, reingreso en otro hospital y mortalidad a 30 días.'],
    ['Estado funcional y oncológico', 'Glasgow o estado mental (qSOFA completo), estado funcional, estadio oncológico y patología.']
  ].forEach(function (x) { add(ND, x[0], '', '', x[1] + ' No se captura en la app: no se puede derivar; si el estudio lo necesita hay que agregarlo a la captura.'); });
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
  // 24 nov 2026: cada recorte se cuenta (va a «Integridad» y a los avisos). Lo que ya venía recortado de la hoja no cuenta.
  if (s.length > REG_MAX_CELDA) {
    if (!(s.length === REG_MAX_CELDA + REG_RECORTE.length && s.slice(REG_MAX_CELDA) === REG_RECORTE)) REG_CORRIDA.recortes++;
    s = s.slice(0, REG_MAX_CELDA) + REG_RECORTE;
  }
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
    ['Celdas usadas', String(celdas || 0) + ' de ' + REG_CELDAS_MAX + ' que admite Sheets (' + Math.round(100 * (celdas || 0) / REG_CELDAS_MAX) + '%)' + ((celdas || 0) > REG_CELDAS_AVISO * REG_CELDAS_MAX ? ' — AVISO: hay que pasar lo viejo a un libro histórico (desde el ' + Math.round(100 * REG_CELDAS_CRITICO) + ' % se pausan WinLab, RIS y las pestañas de análisis).' : '')],
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
    ['Labs del robot (WinLab)', 'Un renglón por reporte de WinLab del paciente, con la regla de identidad del robot: lo que el robot marcó (nombre, alias, edad, homónimos) o, en capturas anteriores al 9 oct 2026, esa misma regla aplicada aquí; nunca de homónimos (si no se puede decidir, no se copia). Valores: un renglón por estudio «ESTUDIO: valor unidad (ref. …)». Toma y Resultado: fecha y hora del reporte. Sexo en WinLab: F o M del encabezado del paciente.'],
    ['Sexo (fuente)', 'En Pacientes: «Tarjeta» si el sexo lo escribió la app; «de WinLab» si la tarjeta no lo tenía y se tomó del encabezado de WinLab del paciente (mismo expediente y nombre compatible). Si WinLab trae los dos sexos para la persona, no se usa. «Inferido del nombre» (25 nov 2026): ni la tarjeta ni WinLab lo traen y se tomó del primer nombre de pila (diccionario de nombres frecuentes; si no es concluyente queda vacío).'],
    ['Cultivos del robot (WinLab)', 'Un renglón por muestra de cultivo de esos reportes: del PDF del reporte cuando el robot lo leyó (germen y antibiograma S/I/R) o de la tabla del reporte.'],
    ['Imagen del robot (RIS)', 'Lo que capturó el robot de RIS, por expediente y episodio.'],
    ['Nota / Checklist completo (JSON)', 'Todo lo demás de la tarjeta, sin archivos incrustados. Si la nota no cabe en una celda sigue en «Nota completa (JSON) · 2».'],
    ['Integridad', 'Una fila por corrida (también las que fallan): resultado, duración, bytes leídos por tabla y cuadre de la base contra la hoja. Sin nombres ni expedientes. Sus columnas están en «Diccionario de variables».'],
    ['Guardia · renglones retirados', 'Renglones que la guardia retiró (corte de las 06:15 o borrado), uno por fila; la base los purga a los 7 días y aquí se acumulan. Se cruza con Pacientes por «ID episodio».'],
    ['Estado diario', 'Foto de cada noche del tratamiento de cada hospitalizado (antibiótico, ayuno, NPT, ventilación, vasopresores…), una fila por episodio y día. Solo hacia adelante. Sin nombre ni expediente: se cruza por «ID episodio».'],
    ['Dispositivos y Drenajes · diario', 'Un renglón por drenaje, sonda o estoma de la tarjeta, con la primera y la última noche en que se vio (Vigente: No = retirado, fecha aproximada); y el gasto de cada drenaje por noche.'],
    ['Movimientos y estado', 'Del historial de auditoría de la base: alta y baja del censo y cambios de cama, sección, estado y especialidad. Sin nombres; un valor raro se escribe «valor no válido».'],
    ['Soporte y exposiciones (historial) y Actividad por episodio y día', 'Del historial de auditoría de las notas: cuándo se prendió o apagó antibiótico, ayuno, NPT, ventilación, vasopresor y tromboprofilaxis (quién = seudónimo), y cuántas ediciones tuvo cada nota por día. Sus columnas están en «Diccionario de variables».'],
    ['Procedimientos del censo', 'La sección PROCEDIMIENTOS de la hoja del censo (cirugías y procedimientos del día, también los ambulatorios: cama EXT), una fila por fecha + expediente + nombre, con el episodio del registro que cubre la fecha si lo hay. Solo hay datos desde el 25 nov 2026: Google no guarda los censos viejos.'],
    ['Seguimiento de operados', 'Lista de trabajo CON NOMBRES (como «Por completar»): una fila por persona con procedimientos en el censo o cirugías en el registro, con sus fechas, sus episodios, si sigue hospitalizada, su último egreso y sus reingresos posteriores. El más reciente arriba. Sus columnas están en «Diccionario de variables».'],
    ['Fuente (Pacientes)', '«Papelera (borrado)»: la copia se borró de la Papelera y se recuperó de lo que la base guarda de los borrados.'],
    ['Pestañas «Análisis · …»', 'Versión para estadística de todo lo anterior, recalculada cada noche: sin nombres ni expedientes (ID seudónimo), números como números, fechas AAAA-MM-DD, una fila por episodio / por día de labs / por día de signos / por cultivo. Cada columna está definida en «Diccionario de variables». Lo que no se pudo tomar como dato queda vacío y explicado. Una hospitalización restaurada desde la Papelera es UN episodio.'],
    ['Eventos adversos, Análisis · Antibióticos, Completitud, Flujo de la cohorte e Indicadores de calidad', 'Pestañas de análisis sin nombres ni expedientes (24 nov 2026): un renglón por evento adverso detectado (con la columna «Revisado» para quien valida: el registro no la pisa), un renglón por curso de antibiótico, el llenado de cada dato por mes, el diagrama de flujo de la cohorte y los indicadores con numerador, denominador e intervalo de confianza de 95 %. Cada columna está en «Diccionario de variables», que también tiene «Sesgos y limitaciones» y «No disponible en esta fuente».'],
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
