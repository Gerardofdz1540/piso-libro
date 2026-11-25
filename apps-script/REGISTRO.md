# Registro de pacientes para investigación (Google Sheets)

Copia diaria de **todo lo que la app y los robots tienen de cada paciente** a una hoja de cálculo privada en Google
Drive, para estudios y ensayos clínicos futuros. Entran los pacientes del censo, los egresados que guarda la Papelera, la
cronología, los reportes y cultivos de WinLab, los estudios de RIS y los procedimientos programados.

```
Supabase ──GET, 1 vez al día──► Apps Script (proyecto aparte) ──► hoja «Registro de pacientes» en la carpeta privada
```

- **Código:** `apps-script/registro-pacientes.gs`.
- **Pruebas:** `node apps-script/registro-pacientes.test.js`. Usan datos ficticios y una hoja simulada tan estricta como
  Google; corren en CI.
- **Hoja:** «Registro de pacientes (se actualiza cada día)», en la carpeta «Registro de pacientes — Piso (investigación,
  PRIVADO)» del Drive del dueño. La carpeta no tiene permisos heredados.
- **Base:** el script solo **lee** (GET paginado). En el registro de ejecuciones escribe solo conteos, nunca nombres ni
  expedientes.

## Pestañas

| Pestaña | Una fila por… | Contenido |
|---|---|---|
| Pacientes | hospitalización (episodio) | **Censo:** nombre, expediente, edad, sexo, especialidad, adscrito, residente, cama.<br>**Estancia:** ingreso, egreso y motivo, días de estancia, dx, estado.<br>**Cajas:** APP, PA, manejo, pendientes, drenajes y dispositivos, antibiótico, cultivos, interconsultas, dieta y NPO, TVP, NPT, ventilación, vasopresores.<br>**Resúmenes:** cirugías, imagen, labs, Guardia vigente, Cronología.<br>**Respaldo:** nota y checklist completos en JSON, sin archivos.<br>**Peso y talla**; **Dx principal**, su grupo CIE-10 y su fuente (28 oct 2026).<br>**Sexo (fuente)**: «Tarjeta» o «de WinLab» (29 oct 2026). |
| Cirugías | cirugía | fecha, procedimiento, hallazgos, sangrado, cirujano, **Grupo**, **Fuente** · **Vigente** · **Tipo** (urgencia/electiva), **Abordaje**, **Clavien-Dindo**, **Complicación**. Desde el 28 oct 2026 también las que no están en la caja: fecha POP, texto Qx anterior, Cronología, DX y programación del día (ver abajo). Desde el 24 nov 2026, al final: **ID cirugía** (el de la caja; vacío en las inferidas), **Fotos (n)**, **Foto subida por** y **Foto subida el** (la última; nunca la imagen ni su ruta) |
| Labs | fecha y estudio | valor como está en la tarjeta · **Vigente** · **Corregido a mano** (quién, cuándo y qué decía antes) |
| Imagen | estudio | fecha, tipo, descripción, enlace (solo http) · **Vigente** |
| Signos vitales | día | FC, FR, temp, SaO2, O2, TA, uresis, DxTx, IU (insulina), balance, horas de uresis. La app guarda 14 días; aquí se acumulan todos. |
| Notas de evolución | nota | fecha y hora, autor, con IA o no, texto. La app guarda 10; aquí se acumulan. |
| Guardia y cronología | renglón | Cronología (de la nota y del respaldo de la base) y Guardia vigente · **Vigente** |
| Procedimientos programados | procedimiento | la lista del día de la app |
| Labs del robot (WinLab) | reporte de WinLab del paciente | folio, toma, resultado, servicio y **valores** (un renglón por estudio: «ESTUDIO: valor unidad (ref. …)»), aunque no hayan llegado a la tarjeta · **Atribución** · **Sexo en WinLab** (F/M del encabezado) |
| Cultivos del robot (WinLab) | muestra de cultivo de esos reportes | tipo, muestra, resultado, germen, antibiograma S/I/R, UFC, texto del reporte (del PDF cuando el robot lo leyó; si no, de la tabla) |
| Imagen del robot (RIS) | estudio | modalidad, estudios, crítico, reporte, enlace (con su episodio) |
| Guardia · renglones retirados | renglón de un corte de la guardia | id del corte, **ID episodio** (sin nombre ni expediente: se cruza con Pacientes), fecha y hora, motivo (`corte` de las 06:15 o `borrado`), orden y texto. La base los purga a los 7 días; aquí se acumulan (desde el 24 nov 2026). |
| Estado diario | hospitalizado y noche | **sin nombre ni expediente** (se cruza por «ID episodio»): cama, sección y estado (validados), casillas de antibiótico / ayuno / NPT / ventilación, antibiótico escrito y los detectados en Manejo, dieta, TVP, ventilador, vasopresores, peso, curación y n.º de dispositivos. Solo hacia adelante (desde el 24 nov 2026). |
| Dispositivos | drenaje, sonda o estoma de la tarjeta | **sin nombre**: tipo y su grupo, lado, sitio, características, fecha de colocación, último gasto, **Primera vez visto**, **Última vez visto** · **Vigente** (No = retirado; la fecha es aproximada) |
| Drenajes · diario | dispositivo con gasto y noche | **sin nombre**: gasto como está escrito y en mL (número). Solo hospitalizados. |
| Movimientos y estado | cambio del censo (auditoría de la base) | **sin nombre ni quién**: alta y baja del censo, y cambios de cama, sección, estado y especialidad (De → A), origen app u hoja. Un valor raro se escribe «valor no válido». |
| Soporte y exposiciones (historial) | cambio de una casilla de soporte (auditoría de las notas) | **sin nombre**: cuándo se prendió o apagó antibiótico, ayuno, NPT, tromboprofilaxis, norepinefrina, vasopresina y ventilación, o cambió el antibiótico, la dieta o el % de NPT; «Quién» es un seudónimo de la cuenta |
| Actividad por episodio y día | episodio y día | **sin nombre**: ediciones de la nota, usuarios distintos (seudónimos), primera y última hora, ediciones de noche y cajas tocadas |
| Integridad | corrida del registro | **sin nombres**: resultado (Completa / Parcial: faltó… / Falló…), duración total y por etapa, vueltas extra, bytes leídos por tabla, cuadre base ↔ hoja, celdas recortadas, celdas usadas y avisos. Nunca se pisa. |
| Diccionario | — | qué es cada columna, última actualización, conteos y avisos |
| Clave de seudónimos | parte de un episodio | ID episodio de la base → ID paciente / ID episodio de análisis (la llave: **no se comparte**) |
| Análisis · Episodios | hospitalización | sin nombres: edad, sexo (y su fuente), peso, talla, IMC, comorbilidades, fechas, estancia, desenlace, reingresos, cirugías (grupo, reintervención), índice urinario mínimo, resúmenes de labs, cultivos, calidad de datos. Desde el 24 nov 2026, al final: **Unión (fuente)**, cirugías sin fecha, reintervención planeada / no planeada (probable), estancia posoperatoria, cirugía en ≤1 día del ingreso y defunción posoperatoria |
| Análisis · Labs | episodio y día | una columna por estudio, en número y en la unidad de la app; críticos y observaciones |
| Análisis · Signos vitales | episodio y día | números limpios; TA en sistólica, diastólica y PAM; horas de uresis e índice urinario (mL/kg/h) |
| Análisis · Cultivos | muestra | toma, tipo, resultado (0/1), germen, antibiograma |
| Diccionario de variables | variable | definición, tipo y unidad de cada columna de análisis (codebook) |
| Resumen mensual | mes | solo cuentas: ingresos, egresos, mortalidad sobre desenlace conocido, estancia, cirugías, urgencias, laparoscopía, conversiones, Clavien ≥ IIIa, reintervenciones, reingresos, cultivos y lo más frecuente. Desde el 24 nov 2026: cirugías sin fecha exacta, reintervenciones no planeadas e ingresos sin talla |
| Por completar | episodio | **con nombres** (no se comparte): hospitalizados, egresados de los últimos 30 días y (24 nov 2026) todo egresado sin motivo del egreso, con lo que le falta a cada tarjeta (ya no pide la talla) |

- **Episodio:** el id del paciente en la base. Un reingreso crea otro id y por lo tanto otro episodio.
- **WinLab:** cada fila de `winlab_labs` trae todos los reportes de la búsqueda por apellido (también de homónimos) y se
  vuelve a guardar cada día. Entra un reporte solo si es del paciente, con **la regla del robot** (`rpa/lib.js`):
  - Desde el 9 oct 2026 el robot marca los reportes del paciente (`__target`) por nombre, alias, edad y homónimos; esa
    marca manda.
  - Las capturas anteriores no traen la marca: el registro les aplica la misma regla del robot. Usa la edad y el alias
    («nombre en WinLab») del censo o de la Papelera; lee encabezados en español o italiano; acepta una letra cambiada
    por el OCR, FCO = FRANCISCO y similares. Las variantes A/O (MARIO/MARIA) son otra persona. Con homónimos del mismo
    nombre decide la edad; si no se conoce, esos reportes no se copian y queda un aviso.
  - **Alias sin coma (15 nov 2026, versión 2026.11.15):** el «nombre en WinLab» identifica solo con `APELLIDOS, NOMBRE`
    o si es exactamente el nombre del encabezado (mismas palabras). Con solo los apellidos ya no entran los reportes de
    un hermano. Pega el `registro-pacientes.gs` actualizado en el proyecto de Apps Script para que aplique.
  - El mismo reporte capturado varios días es un solo renglón: manda la captura con más valores, y el cultivo leído del
    PDF manda sobre el de la tabla, también entre corridas.
  - La columna «Atribución» dice por qué entró.
- **Papelera:** cada noche se juntan **todas** las copias de la Papelera de cada episodio que está en la base, no solo
  las de los últimos días. Así lo que solo traía una copia vieja no se pierde ni se marca «Vigente: No».
- **Restaurar desde la Papelera** crea otro id. La columna «Episodio relacionado» une las dos partes («Continúa en …» /
  «Viene de …»).
- **Censo y Papelera:** si el mismo episodio está en los dos, manda el censo y la Papelera rellena lo que le falte.
  Entre varias copias de la Papelera manda la más reciente y las anteriores rellenan.
- **Copia de la base:** cada copia de la Papelera se une con la que guardó la base al egresar (`_copia_base`), por si el
  equipo que dio el egreso tenía una copia vieja.
  - Una caja vacía toma la de la base.
  - Labs, imagen, cirugías, signos y notas se unen.
  - No reviven los labs borrados a propósito.

## Pestañas de análisis (27 oct 2026)

Las pestañas de arriba son la copia **fiel** de la app: texto tal cual, con nombres. Las «Análisis · …» son su versión
para estadística. Cada noche se recalculan desde lo que ya está en la hoja, así que incluyen a todos los egresados de
siempre. Cada columna está definida en «Diccionario de variables».

- **Sin nombres ni expedientes.**
  - ID paciente (`P-…`) e ID episodio (`E-…`) son seudónimos: SHA-256 del expediente con una sal secreta, que vive en
    las propiedades del script (`REG_SAL`, se crea sola).
  - La correspondencia está en «Clave de seudónimos», que no se comparte.
  - Si se pierde la sal (otro proyecto de Apps Script), los seudónimos ya escritos se conservan por la clave guardada.
- **Una persona, aunque el expediente se repita.** Mismo expediente con nombres incompatibles son dos personas (error de
  captura). Un error de una letra en el nombre sigue siendo la misma persona.
- **Un episodio, aunque se haya restaurado.** Restaurar desde la Papelera crea otro id en la base: las dos partes son
  UN episodio, con el ingreso más antiguo y el desenlace de la última parte. Antes eran un egreso y un reingreso falsos
  (49 de 291 copias de la Papelera son restauraciones).
- **Números como números.**
  - Van en la unidad de la app (WinLab ya convertido), con formato numérico; las fechas van como AAAA-MM-DD.
  - Nunca se toma «el primer número» de un texto. Una muestra rechazada, una unidad que no se reconoce, un texto
    («ABUNDANTES») o un valor imposible quedan **vacíos** y se explican en «Observaciones».
  - «<0.05» se anota 0.05 y se dice. Las claves viejas de la app (hto, vcm…) van a su columna de hoy.
  - Lo que vino dentro de los labs y no es un estudio (un nombre, la fecha) nunca pasa.
- **Desenlace honesto.**
  - Casi todos los egresos salen del censo de la hoja («RETIRADO DEL CENSO (hoja)») sin decir si fue alta o defunción:
    quedan como «Motivo no registrado».
  - En esos casos, «Defunción» queda **vacío**, no 0.
  - Una copia técnica más nueva (rescate de cambios sin subir, cama reasignada a otra persona) ya no tapa el alta real.
  - Un duplicado se marca «Excluir = 1».
  - **Mientras el motivo de egreso no se registre, el registro no permite calcular mortalidad.**
  - Desde el 27 oct 2026 la app pide el motivo al dar de alta y lo deja poner o corregir en la Papelera (alta a
    domicilio, defunción, traslado, alta voluntaria). Lo guarda la función `archive_set_egreso` dentro de la copia
    (`_egreso_tipo`, con quién y cuándo).
  - El registro lo toma aunque la copia sea vieja: relee cada noche las copias clasificadas desde la corrida anterior.
    Ese motivo manda sobre cualquier etiqueta y aparece como «… (registrado en la app)».
- **Reingresos.**
  - «Es reingreso (≤30 días)» mira hacia atrás.
  - «Reingreso a 30 días» mira hacia adelante: queda vacío si sigue hospitalizado, si murió o si aún no pasan 30 días.
  - Solo ve reingresos a los servicios que usan la app.
- **Datos censurados.** Sin egreso, la estancia llega hasta hoy (hospitalizado) o hasta el último día en la base, con
  «Egreso observado = 0».
- **Vigente.** Lo que una corrida anterior generó y hoy ya no (un lab corregido) se conserva con «Vigente = No». Para
  analizar, filtra «Vigente = Sí».
- **Valores anteriores al 27 oct 2026.**
  - La app no revisaba la unidad de WinLab: troponina I en ng/mL, glucosa en mmol/L, fibrinógeno en g/L.
  - Antes de oct 2026, el examen de orina pudo caer en la biometría.
  - Revisa los valores atípicos antes de analizar.
- **Cirugías desde donde estén marcadas** (28 oct 2026). La caja Cirugías manda. Lo que no esté ahí se toma, en este
  orden, de la fecha POP de la tarjeta, del texto Qx anterior, de la Cronología («pasa a quirófano para…», «se realiza
  LAPE») y del DX («PO LAPE 25/10», «S/P colecistectomía»):
  - No cuenta lo planeado («programado», «pendiente», «mañana»), los antecedentes («antecedente de…», «hace 3 años») ni
    una fecha de antes del ingreso.
  - No se repite: misma fecha ±2 días y mismo grupo (o un procedimiento sin grupo reconocido) es la misma cirugía.
  - La programación del día entra «sin confirmar» solo si no hay otra cirugía esos días, y no se cuenta como hecha.
  - Si alguien la pasa después a la caja, la inferida queda «Vigente = No».
  - La app avisa en la caja Cirugías («🔎 ¿Cirugía sin registrar?») para que el residente la registre con un toque.
- **Dx principal** (28 oct 2026): el que se eligió en la app (🩺, lista corta con CIE-10) o, si no, el inferido del DX con
  la misma tabla (el término que aparece primero), marcado «Inferido del DX». La tabla es idéntica en la app y aquí (una
  prueba lo verifica). Desde el 30 oct 2026 la app muestra el inferido ya seleccionado («auto · del DX»), así que
  «Por completar» (registro 2026.10.30-1) solo pide el dx principal cuando el DX no coincide con ninguno.
- **Cirugía estructurada** (28 oct 2026): urgencia/electiva, abordaje y Clavien-Dindo solo si se eligieron en la caja;
  lo inferido no los trae. Complicación mayor = Clavien ≥ IIIa.
- **Sexo desde WinLab** (29 oct 2026). Si la tarjeta no tiene el sexo, se toma del encabezado de WinLab del paciente
  («MASCULINO/FEMENINO», también en italiano o inglés) y se marca **«de WinLab»** en «Sexo (fuente)»:
  - Solo cuentan los reportes ya atribuidos al paciente con la regla del robot, con su mismo expediente y un nombre
    compatible. Si dos personas comparten expediente, cada una toma solo el suyo.
  - Si WinLab trae los dos sexos para la persona, no se usa y se anota en «Calidad de datos».
  - Lo que escribe la app manda. Si la tarjeta y WinLab no coinciden, queda el de la tarjeta y se anota para revisar.
  - «Por completar» deja de pedir el sexo que llegó de WinLab.
  - Para llenar a los pacientes de antes, la primera corrida de esta versión vuelve a leer WinLab completo **una sola
    vez** (marca `REG_WL_RELECTURA`; unas 4 vueltas de 10 min) y avisa en el Diccionario.
- **Comorbilidades** (28 oct 2026) desde APP y DX, con negación. Sin APP quedan vacías (desconocidas); el DX solo puede
  marcar 1. Es texto libre: revisar una muestra antes de publicar.
- **Antibiótico, NPO y NPT** (30 oct 2026): si en la app se puso la fecha de inicio, se anota «desde AAAA-MM-DD» en lugar
  de los días escritos a mano (los días dependen del corte del estudio).
- **Correcciones de cálculo (24 nov 2026).** Cambian cifras ya vistas; las columnas nuevas van al final de cada pestaña:
  - *Cirugías sin fecha:* el Resumen mensual las descartaba todas (casi todas las inferidas). Ahora cuentan en el mes
    del ingreso del episodio (o del egreso) y se dicen aparte en «Cirugías sin fecha exacta (n)»; el episodio tiene
    «Cirugías sin fecha (n)». Suben «Cirugías (n)» y «Pacientes operados (n)» de los meses anteriores.
  - *DX con marca de postoperado y sin grupo* («PO PROCEDIMIENTO X»): se conserva como cirugía del grupo «Otro» (antes
    se perdía). Sin marca sigue haciendo falta un procedimiento reconocido. Grupos nuevos: Neurocirugía (cráneo y
    columna), Urología, Cirugía cardiovascular, Cirugía plástica y reconstructiva, Cirugía maxilofacial, y más
    procedimientos de tórax. Ningún texto que ya tenía grupo cambia (salvo el genérico «Laparoscopia»).
  - *Motivo de egreso en una copia de rescate sin id:* si alguien eligió el motivo en la Papelera sobre una copia de
    iPad sin id de la base, ahora llega a su episodio (no tapa otro motivo ya elegido por una persona). Sin episodio en
    la base, esa copia deja de ser «Duplicado» y cuenta como el egreso que se registró.
  - *Reintervención:* la columna de siempre es «2.ª cirugía de cualquier tipo» (sobrecuenta). Las nuevas separan
    **planeada (probable)** (SEGUNDO TIEMPO, SECOND LOOK, CIERRE DE PARED / DIFERIDO, RECAMBIO, LAVADO PROGRAMADO, VAC en
    la 2.ª cirugía o después) y **no planeada (probable)** (el resto, ≤30 días de la primera; o una relaparotomía como
    única cirugía). Una 2.ª cirugía sin fecha en un episodio de más de 30 días queda vacía. Es texto libre: validar una
    muestra antes de publicar.
  - *Episodios partidos:* dos id de la misma persona (mismo expediente válido y nombre compatible) son UN episodio si
    tienen la misma fecha de ingreso, o si el siguiente ingresó 0–1 día después de un egreso que no dice el motivo.
    «Unión (fuente)» dice por qué (Restauración / Mismo ingreso / Contiguo) y se anota en «Calidad de datos». No se une
    tras una defunción ni tras un motivo registrado por una persona (salvo «no fue egreso»), ni con duplicados.
    **Baja «Egresos (n)» y alarga la estancia** de los meses anteriores; «Contiguo» puede esconder un reingreso real al
    día siguiente de un egreso sin motivo: revisar una muestra. Más estricto que el plan original: un egreso que dice
    «alta» (aunque no lo haya elegido una persona) tampoco se une por contigüidad.
  - *Por completar:* ya no pide la talla (casi nadie la tiene; se cuenta en «Ingresos sin talla (n)» del Resumen
    mensual) y el egresado sin motivo entra sin límite de días, primero en las filas nuevas. «Ingresos con datos
    incompletos (n)» baja porque ya no cuenta la talla.
  - *Fechas de inicio:* además de `atb_inicio` / `npo_inicio` / `npt_inicio` (lo que escribe la app) se acepta
    `…_fecha_inicio` como respaldo. «Lactato máximo» está vacío porque ninguna captura trae esa clave (dicho en el
    Diccionario de variables).
  - *Cirugías con id:* con «ID cirugía» el análisis no cuenta dos veces una cirugía a la que le corrigieron el texto
    (tarjeta restaurada con el texto nuevo, o fila vieja sin id + fila nueva con id).
- **Pacientes: quién y cuándo (24 nov 2026).** Seis columnas al final: «Egresado por» (`archive.archived_by` de la copia
  que da el egreso), «Motivo de egreso registrado por» y «Motivo registrado el» (solo si el motivo lo eligió una
  persona), «Última modificación por» (`notes.updated_by` o `patients.updated_by`), «Nota restaurada el»
  (`notes.restaurada_en`) y «Alias WinLab». Identifican a personal: no se comparten ni entran a las pestañas de
  análisis. El script pide ahora `updated_by` (patients y notes), `restaurada_en` (notes) y `archived_by` (archive):
  esas tres tablas no son opcionales, así que **si alguna de esas columnas se quitara de la base la corrida se detiene
  con 42703** (queda dicho en «Integridad»). Existen en la base al 24 nov 2026.
- **Índice urinario** = uresis ÷ peso del episodio ÷ horas (columna «Horas» del Pase, o «900/12 H»; sin horas, 24 h
  con aviso), igual que la app.
- **Tamaño.** Con unos 240 egresos al mes:
  - las pestañas de análisis suman unas 0.9 millones de celdas al año;
  - todo el libro suma unos 4.6 millones al año, de 10 millones posibles.

## Nunca borra

- Cada día se actualizan, por clave, las filas que hoy están en la base; lo demás se conserva.
  - **Vigente: No.** Lo que ya no está en la tarjeta (una cirugía corregida, un renglón quitado) se queda marcado así.
  - **Egresado depurado de la Papelera:** se queda con sus datos y con la fecha de la «Última vez en la base».
  - **Salió del censo sin pasar por la Papelera:** queda como «Salió de la base sin egreso registrado».
  - **Copias de rescate de un iPad sin id de la base (30 oct 2026, versión 2026.10.30-2):** «CAMBIOS DE ESTE iPad SIN
    SUBIR (el paciente ya no estaba en el censo)» no es otra hospitalización. Se une, solo para rellenar (la tarjeta
    manda), al episodio de la misma persona (mismo expediente y nombre compatible; si hay varios, el que sigue en el censo
    o el último egreso hasta el día del rescate). Sin pareja, las copias de una persona son **un** episodio con el tipo
    «Duplicado (no es otro episodio)» (Excluir = 1). Las filas que corridas anteriores ya escribieron con el id de cada
    copia («archivo-…») quedan «Vigente: No» y su tipo también es «Duplicado»: ya no inflan egresos ni mortalidad.
- **Escritura segura:**
  - Escribe encima sin vaciar antes; si Sheets falla a la mitad, la pestaña no queda vacía.
  - Agranda la cuadrícula si hace falta.
  - Si alguien renombró la columna clave de la fila 1, se detiene sin tocar nada y avisa.
- **Una sola hoja (27 oct 2026):** ya no guarda copias semanales en la carpeta (antes quedaban dos o más «bases»). El
  respaldo es el historial de versiones de la hoja (Archivo → Historial de versiones). La primera corrida de esta versión
  manda a la papelera de Drive, una sola vez, las copias «Respaldo — <hoja> — fecha» que hizo la versión anterior (Drive
  las guarda 30 días). No toca otros archivos de la carpeta.
- **Escribe solo lo que cambió, cada cosa en su lugar:**
  - Cada fila se actualiza en **su** renglón si algo cambió, y cada valor va a la columna con **su** nombre; las filas
    nuevas van al final.
  - Nunca recorre filas ni reescribe la pestaña entera, y no toca las columnas que no son del registro.
  - Si a la hoja le falta una columna del registro (una versión nueva, o se renombró o borró una), la agrega al final
    con su encabezado y lo avisa en el Diccionario. La columna renombrada conserva lo que tenía.
  - Si se corta a la mitad (6 min), la siguiente vuelta completa lo que faltó.
- **Lecturas incrementales y reanudables:**
  - La Papelera, WinLab y RIS se leen por cursor (fecha de captura + id), desde 2 días antes de lo último leído. Hay un
    tope por corrida (400, 1500 y 3000 filas). Si quedan filas, escribe lo leído, guarda la posición exacta y programa
    una continuación en 10 min, así la primera carga termina en varias vueltas.
  - Se pagina por llave, no por posición: si alguien borra una fila mientras se lee, no se salta la siguiente.
  - Los cursores avanzan solo cuando lo leído ya quedó escrito.
  - El censo, las notas, la cronología y los procedimientos se leen completos.
  - WinLab se procesa página por página, sin guardar el JSON crudo en memoria.
  - Si una respuesta es demasiado grande (archivos incrustados), pide menos filas por página.
- **Tiempo** (Apps Script corta cada ejecución a los 6 min):
  - Las lecturas por cursor se detienen a los 2.5 min y siguen en otra vuelta.
  - Las demás lecturas, si pasan de 4 min, fallan sin escribir nada y se reintentan en la siguiente corrida.
  - Después de 5 min 15 s no empieza otra pestaña, y dentro de una pestaña no empieza otra escritura después de
    5 min 40 s. Lo que faltó se escribe en la siguiente vuelta, y los cursores no avanzan.
  - Como mucho 8 vueltas extra en 24 h corridas. Los disparadores de una cuenta personal de Google tienen 90 min al día,
    compartidos con el script del censo, que corre cada 5 min. Al terminar la carga se borra cualquier vuelta pendiente.
  - Las URL miden menos de 2 KB (límite de UrlFetchApp): las copias de la Papelera se piden de 20 en 20 episodios.
- **Si una fuente falla:** si WinLab, RIS, los procedimientos, `guardia_cortes`, `archive_eliminados` o la auditoría (`audit_log`) no se pueden leer, sus pestañas no se tocan ese día y lo
  demás sí se escribe. El aviso queda en el Diccionario («Avisos de la última corrida»). Si fallan el censo, las notas,
  la Papelera o la cronología, no se escribe nada.
- **Integridad (24 nov 2026, versión 2026.11.24):** cada corrida deja una fila en «Integridad», también la que falla
  (con la causa, sin datos de pacientes; las demás pestañas no se tocan).
  - *Resultado:* «Completa» solo si se leyó y escribió todo, análisis incluido. Solo entonces avanza la propiedad
    `REG_ULTIMA_COMPLETA`; si pasan más de 36 h sin una corrida completa, se avisa en el Diccionario y en «Integridad».
    Una noche sin fila = el disparador no corrió.
  - *Cuadre:* «Episodios en base» sale del censo y de una lectura ligera de la Papelera (`id` y los dos ids de
    `patient_data`, sin nombres); «Diferencia» = ids de la base que no están en Pacientes (debe ser 0). Las filas de
    `winlab_labs` y `ris_estudios` se cuentan sin bajar nada (`limit=0` con `Prefer: count=exact`; el total viene en
    `Content-Range`). Si un conteo falla o no alcanza el tiempo, el número queda vacío y la corrida sigue.
  - *Bytes leídos por tabla:* caracteres de cada respuesta de Supabase (aproxima el egress de la noche).
- **Margen de relectura por tabla (24 nov 2026):** la Papelera y RIS se releen desde 2 días antes de lo último leído;
  WinLab, que era ~80 % de lo que se baja cada noche, desde 6 h antes (ahorra ~2 MB por noche). «WinLab actualizadas en
  sitio (n)» en «Integridad» cuenta las filas que el robot cambió después de leídas y quedaron fuera de esa ventana:
  debe ser 0; si no, se avisa (habría que ampliar `REG_MARGEN_WINLAB_MS`).
- **Celdas largas (24 nov 2026):** la «Nota completa (JSON)» ya no lleva la bóveda de documentos, DICOM, capturas ni
  diagramas, y si aun así pasa de 45 000 caracteres sigue en «Nota completa (JSON) · 2» (las dos pegadas son el JSON
  completo). Cualquier otra celda que se recorte se cuenta en «Celdas recortadas (n)» y se avisa.
- **Lo borrado de la Papelera (24 nov 2026):** se lee `archive_eliminados` (solo `id`, `eliminado_en`, `archive_id` y
  `fila`; nada de quién borró). Una copia archivada y borrada antes de la corrida entra a Pacientes con Fuente
  «Papelera (borrado)».
- **Renglones retirados de la guardia (24 nov 2026):** `guardia_cortes` se lee cada noche por cursor (1 h de margen).
  La base la purga a los 7 días: si pasan más de 6 días sin copiarla (propiedad `REG_GUARDIA_LEIDA`), se avisa.
- **Foto diaria, dispositivos y drenajes (24 nov 2026).** Tres pestañas compactas (solo «ID episodio»), sin costo de
  lectura (salen del censo y las notas que ya se leen cada noche):
  - *Estado diario:* una fila por hospitalizado y noche, desde la nota viva del censo (no de la unión con copias viejas
    de la Papelera). Una corrida después de medianoche crea la fila del día nuevo y la de las 23 h la reemplaza. No se
    puede reconstruir hacia atrás: una noche sin corrida es un día sin foto.
  - *Antibióticos en Manejo:* lista cerrada (`REG_ATB`, con clase y categoría AWaRe de la OMS) sobre la caja Manejo;
    «SIN MEROPENEM» o «SE SUSPENDE VANCO» no cuentan. Detecta menciones, no dosis.
  - *Dispositivos:* `regFusionar` conserva «Primera vez visto» (opción `conservarViejo`). El que desaparece de la
    tarjeta queda «Vigente: No» y su «Última vez visto» aproxima el retiro. En un egresado es la fecha de egreso.
  - *Drenajes · diario:* el último gasto escrito a la hora de la corrida (no es el de 24 h de enfermería).
  - Cama, sección, estado y especialidad pasan por un catálogo: lo que no tiene la forma esperada se escribe «valor no
    válido» (la sección del censo de la hoja a veces trae texto corrido, incluso nombres).
- **Historial de auditoría (24 nov 2026).** Se lee `audit_log` de la base con dos cursores propios (`ts` + `id`, 1 h de
  margen, propiedades `REG_CURSOR_audit_pacientes` y `REG_CURSOR_audit_notas`), al final de la lectura y como fuente
  opcional: si falla, sus tres pestañas no se tocan y lo demás se escribe.
  - **Privacidad:** nunca se pide `email`, `nombre`, `paciente`, `ip`, `ua` ni el `diff` entero; solo sub-rutas con
    alias (`cama:diff->cama`, `a:diff->checklist->atb`…). `user_id` solo sirve para «Origen» (app / hoja) y para el
    seudónimo de «Quién» (SHA-256 con la sal del registro); no se escribe.
  - *Movimientos y estado:* filas de `patients` (alta, baja y cambios de cama, estado, sección o especialidad). De ahí
    salen, en «Análisis · Episodios»: «Cambios de cama (n)», «Pasó por UCI», «Días en UCI», «Peor estado clínico»,
    «Fecha del primer GRAVE», «Fecha de ingreso (estimada)» con su fuente y «Hora de egreso del censo». Vacío = sin
    movimientos copiados (no es 0).
  - *Soporte y exposiciones (historial):* filas de `notes` con cambio en 12 sub-llaves del checklist. La base guarda cada
    valor como texto JSON: se escribe «Sí» / «No» o el texto. Marca cuándo se capturó el cambio, no cuándo se indicó.
  - *Actividad por episodio y día:* se suma en la misma pasada. Como la lectura es por partes, la fila de la hoja se
    acumula y «Último ID» evita contar dos veces lo releído (no borrar esa columna).
  - La auditoría existe desde el 14 oct 2026 y la base la purga a los 180 días; lo copiado se queda. La primera carga
    baja todo lo que haya (tope de 6 000 y 12 000 filas por vuelta; el límite real es el tiempo de lectura).
  - **Sin verificar contra la base real:** que PostgREST acepte dos `or=` en la misma consulta (el del filtro y el de la
    paginación) y el volumen por noche. Si la consulta falla, el aviso dice «No se pudo leer audit_pacientes…» y nada
    más se detiene.
- **Índices en la base** (`scripts/supabase_registro_indices.sql`): (fecha de captura, id) en `winlab_labs`,
  `ris_estudios` y `archive`. Sin ellos, cada página de WinLab tardaba 3.9 s (PostgREST corta a los 8 s); con ellos,
  26 ms.
- **Capacidad:** Sheets admite 10 millones de celdas por libro.
  - Las pestañas nuevas se crean sin las columnas vacías de sobra.
  - El Diccionario cuenta las celdas de todas las hojas y avisa al pasar del 70%. Entonces habrá que pasar lo viejo a un
    libro histórico.
- **Al usar la hoja:**
  - Se pueden agregar columnas propias (grupo del estudio, inclusión…) y usar filtros; el registro no las toca.
  - No renombres los encabezados del registro. Si cambia el de una columna clave («ID episodio», «Expediente»,
    «Reporte»…), el registro se detiene sin escribir y avisa.
  - Para analizar, mejor trabaja en una copia.

## Instalación (una vez, ~5 min)

Se recomienda un **proyecto aparte**, no ligado a la hoja. Así, aunque compartas la hoja, nadie más ve la llave de
Supabase.

1. Entra a <https://script.google.com> con la misma cuenta de Drive → **Nuevo proyecto**.
   Ponle nombre, por ejemplo «Registro de pacientes».
2. Borra lo que haya en `Código.gs`, pega **todo** `apps-script/registro-pacientes.gs` y guarda.
3. **Configuración del proyecto** (engrane):
   - Zona horaria: `America/Mexico_City`.
   - **Propiedades del script:**
     - `SUPABASE_KEY` = la *service_role key* (la misma que usa el script del censo).
     - `REGISTRO_SHEET_ID` = el id de la hoja del registro: lo que va entre `/d/` y `/edit` en su dirección.
4. En el editor elige `instalarRegistroDiario` → **Ejecutar** → autoriza (Sheets, Drive y conexión externa). Si sale
   «Google no ha verificado esta app»: Configuración avanzada → Ir a «Registro de pacientes» (no seguro) → Permitir.
   - Crea la actualización diaria (entre 23:00 y 24:00) y hace la primera copia.
   - La primera carga de WinLab (todos los reportes desde abril) se completa sola en algunas vueltas de 10 min. El
     Diccionario dice «Carga en curso: Sí» mientras falte.
   - Si el script falla antes de leer, revisa `REGISTRO_SHEET_ID`: el error lo dice.
5. Para copiar en cualquier momento, ejecuta `actualizarRegistro` desde el editor.
6. **Para actualizar el script** a una versión nueva: abre el proyecto, borra todo `Código.gs`, pega el archivo nuevo y
   guarda. Las Propiedades del script y la actualización diaria se conservan; no hace falta volver a instalar.

Opcionalmente, el script se puede ligar a la hoja (Extensiones → Apps Script, sin `REGISTRO_SHEET_ID`). Eso agrega el
menú **Registro → Actualizar ahora**, pero cualquiera con permiso de **editor** en la hoja podría ver la llave. En ese
caso, comparte la hoja solo como **lector**.

Si una corrida falla, el registro de ejecuciones muestra solo el error y la hoja queda como estaba.

## Privacidad y uso en investigación

- La hoja tiene **datos de salud identificables** (nombre y expediente).
  - Mantenla en la carpeta privada y no descargues copias a equipos compartidos.
  - Compártela solo como lector y solo con quien autorice el protocolo.
- Usar estos datos en un estudio o ensayo requiere un **protocolo aprobado por el Comité de Investigación y el Comité de
  Ética en Investigación** del hospital.
  - Marco: Reglamento de la Ley General de Salud en Materia de Investigación para la Salud; NOM-012-SSA3-2012.
  - El protocolo cubre el consentimiento informado, o su dispensa en estudios retrospectivos, y el resguardo de los
    datos personales sensibles (ley de protección de datos personales aplicable a la institución).
  - Para un análisis, comparte solo las pestañas «Análisis · …» y el «Diccionario de variables» (Archivo → Descargar →
    CSV, una por una). Están seudonimizadas, no son anónimas: fechas, diagnóstico y procedimientos pueden ayudar a
    reconocer a alguien. La llave («Clave de seudónimos» y la sal `REG_SAL`) se queda con el responsable.
- La *service_role key* da acceso total a la base: solo va en Propiedades del script, nunca en la hoja ni en el código.
