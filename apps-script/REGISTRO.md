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
| Pacientes | hospitalización (episodio) | **Censo:** nombre, expediente, edad, sexo, especialidad, adscrito, residente, cama.<br>**Estancia:** ingreso, egreso y motivo, días de estancia, dx, estado.<br>**Cajas:** APP, PA, manejo, pendientes, drenajes y dispositivos, antibiótico, cultivos, interconsultas, dieta y NPO, TVP, NPT, ventilación, vasopresores.<br>**Resúmenes:** cirugías, imagen, labs, Guardia vigente, Cronología.<br>**Respaldo:** nota y checklist completos en JSON, sin archivos.<br>**Peso y talla**; **Dx principal**, su grupo CIE-10 y su fuente (28 oct 2026).<br>**Sexo (fuente)**: «Tarjeta» o «de WinLab» (29 oct 2026) o «Inferido del nombre» (25 nov 2026). |
| Cirugías | cirugía | fecha, procedimiento, hallazgos, sangrado, cirujano, **Grupo**, **Fuente** · **Vigente** · **Tipo** (urgencia/electiva), **Abordaje**, **Clavien-Dindo**, **Complicación**. Desde el 28 oct 2026 también las que no están en la caja: fecha POP, texto Qx anterior, Cronología, DX y programación del día (ver abajo). Desde el 24 nov 2026, al final: **ID cirugía** (el de la caja; vacío en las inferidas), **Fotos (n)**, **Foto subida por** y **Foto subida el** (la última; nunca la imagen ni su ruta) |
| Labs | fecha y estudio | valor como está en la tarjeta · **Vigente** · **Corregido a mano** (quién, cuándo y qué decía antes) |
| Imagen | estudio | fecha, tipo, descripción, enlace (solo http) · **Vigente** |
| Signos vitales | día | FC, FR, temp, SaO2, O2, TA, uresis, DxTx, IU (insulina), balance, horas de uresis. La app guarda 14 días; aquí se acumulan todos. |
| Notas de evolución | nota | fecha y hora, autor, con IA o no, texto. La app guarda 10; aquí se acumulan. |
| Guardia y cronología | renglón | Cronología (de la nota y del respaldo de la base) y Guardia vigente · **Vigente** |
| Procedimientos programados | procedimiento | la lista del día de la app |
| Procedimientos del censo | fecha + expediente + nombre | **con nombres** (25 nov 2026, registro 2026.11.26-2): la sección PROCEDIMIENTOS de la hoja del censo (tabla `censo_procedimientos`): cama («EXT» = ambulatorio, «QX», «UCIP»), expediente, nombre, edad, diagnóstico, especialidad, adscrito, residente, visto primero / por última vez, **ID episodio** (el del registro que cubre la fecha), **Ambulatorio**, **Grupo** (del diagnóstico) · **Vigente**. Solo desde el 25 nov 2026. |
| Labs del robot (WinLab) | reporte de WinLab del paciente | folio, toma, resultado, servicio y **valores** (un renglón por estudio: «ESTUDIO: valor unidad (ref. …)»), aunque no hayan llegado a la tarjeta · **Atribución** · **Sexo en WinLab** (F/M del encabezado) · **Nacimiento en WinLab** (24 nov 2026, al final; solo en reportes capturados desde esa fecha) |
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
| Análisis · Episodios | hospitalización | sin nombres: edad, sexo (y su fuente), peso, talla, IMC, comorbilidades, fechas, estancia, desenlace, reingresos, cirugías (grupo, reintervención), índice urinario mínimo, resúmenes de labs, cultivos, calidad de datos. Desde el 24 nov 2026, al final: **Unión (fuente)**, cirugías sin fecha, reintervención planeada / no planeada (probable), estancia posoperatoria, cirugía en ≤1 día del ingreso y defunción posoperatoria; después, las variables derivadas (ver «Variables derivadas» abajo): días observados de antibiótico, ayuno, NPT, ventilación, vasopresor, tromboprofilaxis y drenaje, cobertura del diario, lesión renal aguda (KDIGO), hemoglobina, albúmina, PCR y glucosa, ISQ probable, bacteriemia, germen multirresistente, comorbilidades de Charlson, Charlson y riesgo preoperatorio simple; y al final de todo, las columnas de apoyo (tipo de egreso probable y su fuente, desenlace conocido, reingreso planeado / no planeado, seguimiento posalta, edad calculada con la fecha de nacimiento de WinLab, periodo de captura) y las de eventos adversos (Clavien-Dindo mínimo inferido, complicación mayor inferida, número de eventos) |
| Análisis · Cirugías | cirugía | **sin nombre ni expediente** (24 nov 2026): ID cirugía (Q-…), ID episodio, ID paciente, fecha, n.º de cirugía en el episodio, día de estancia, días desde la previa, grupo, procedimiento (texto libre), tipo, urgencia inferida (día 0-1), abordaje elegido y abordaje inferido del texto, Clavien-Dindo, sangrado, fuente, es índice, reintervención planeada / no planeada (probable), días cirugía→egreso, defunción en el episodio, dx principal, edad, fecha estimada, revisar |
| Eventos adversos | evento de un episodio | **sin nombre ni expediente** (24 nov 2026): evento de un catálogo cerrado (defunción, reintervención no planeada, reingreso 30 d, lesión renal, ISQ, bacteriemia, fuga, fístula, neumonía, TEV, sepsis, transfusión, vasopresor, ventilación, UCI, hemorragia, drenaje percutáneo…), ocurrencia («única» o la fecha: con el episodio y el evento es la clave), fecha, día posoperatorio, detalle, fuente, certeza (Objetivo / Probable (por fechas) / Mención en texto), grado de Clavien mínimo que implica y **Revisado** (la llena quien valida; el registro no la pisa) |
| Análisis · Antibióticos | curso de antibiótico | **sin nombre ni expediente** (24 nov 2026): antibiótico, clase, AWaRe, inicio, inicio estimado, fin, días de tratamiento, sigue al egreso, cultivo previo, germen, concordancia con el antibiograma, días desde la última cirugía y fuente |
| Completitud | mes de ingreso y variable | solo cuentas (24 nov 2026): cuántos episodios (o cirugías) tienen cada dato, de cuántos a los que aplica, y el porcentaje; con fila «Acumulado» |
| Flujo de la cohorte | paso | solo cuentas (24 nov 2026): de todos los episodios a los analizables, restando en orden duplicados, borrados, sin ingreso, no egresados y sin desenlace; operados, con labs seriados y lo que el robot vio sin episodio |
| Indicadores de calidad | periodo, indicador y estrato | solo cuentas (24 nov 2026): numerador, denominador, tasa, **IC 95 % de Wilson**, excluidos por dato faltante y definición, por mes, trimestre y acumulado |
| Análisis · Labs | episodio y día | una columna por estudio, en número y en la unidad de la app; críticos y observaciones |
| Análisis · Signos vitales | episodio y día | números limpios; TA en sistólica, diastólica y PAM; horas de uresis e índice urinario (mL/kg/h) |
| Análisis · Cultivos | muestra | toma, tipo, resultado (0/1), germen, antibiograma. Desde el 24 nov 2026, al final: **Sitio (grupo)**, días desde la última cirugía, posoperatorio (1-30 d), multirresistente (probable) y contaminante probable |
| Diccionario de variables | variable | definición, tipo y unidad de cada columna de análisis (codebook) |
| Resumen mensual | mes | solo cuentas: ingresos, egresos, mortalidad sobre desenlace conocido, estancia, cirugías, urgencias, laparoscopía, conversiones, Clavien ≥ IIIa, reintervenciones, reingresos, cultivos y lo más frecuente. Desde el 24 nov 2026: cirugías sin fecha exacta, reintervenciones no planeadas, ingresos sin talla (vacía desde el 25 nov 2026: ya no se mide), **egresos con motivo (%)**, **con sexo (%)** y episodios sin labs. Desde el 25 nov 2026, al final: **procedimientos en el censo (n)**, **… de CG (n)** y **ambulatorios (n)** por mes de la fecha (vacías antes de noviembre de 2026) |
| Por completar | episodio | **con nombres** (no se comparte): hospitalizados, egresados de los últimos 30 días y (24 nov 2026) todo egresado sin motivo del egreso, con lo que le falta a cada tarjeta (ya no pide la talla ni el sexo inferido del nombre) |
| Seguimiento de operados | persona (expediente + nombre compatible) | **con nombres** (no se comparte; lista de trabajo, 25 nov 2026): quien aparece en «Procedimientos del censo» o tiene cirugías en el registro: edad, sexo y su fuente, primer y último procedimiento, procedimientos en el censo (n), cirugías registradas (n), especialidades, diagnóstico más reciente, ID episodios, ¿hospitalizado ahora?, último egreso y su motivo, días desde el último procedimiento, reingresos posteriores (n). El más reciente arriba. |

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
  - Desde el 25 nov 2026 el script del censo también registra el motivo cuando el paciente aparece en la sección
    **ALTAS** o **DEFUNCIONES** de la hoja del censo (`_egreso_tipo_por` = «Censo (hoja · ALTAS)» / «Censo (hoja ·
    DEFUNCIONES)»). Aparece como «… (censo: sección ALTAS)» o «… (censo: sección DEFUNCIONES)», manda igual que el de la
    app (es un motivo registrado, no inferido: cuenta para la mortalidad) y «Fuente del tipo» de «Análisis · Episodios»
    lo dice («Censo (hoja): sección ALTAS / DEFUNCIONES»). La sección no cambia el tipo: una contrarreferencia anotada
    en DEFUNCIONES sigue siendo contrarreferencia.
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
- **Sexo inferido del nombre** (25 nov 2026, registro 2026.11.26). Tercera fuente, la de menor prioridad: solo si ni la
  tarjeta ni WinLab traen el sexo. Se marca **«Inferido del nombre»** en «Sexo (fuente)» (`regSexoDeNombre`):
  - Diccionario de cientos de nombres de pila frecuentes en México (hombres y mujeres). «MA.», «MA», «Ma.» = María.
    Inicial suelta («J.»), nombre fuera de la lista o sin nombre (DESCONOCIDO, RN…): vacío. **Nunca se adivina por la
    terminación.**
  - El primer nombre de pila manda (JOSÉ MARÍA = M, MARÍA JOSÉ = F, MA. GUADALUPE = F). Si es ambiguo (GUADALUPE,
    ROSARIO, TRINIDAD, REFUGIO, CRUZ…) decide el segundo; si sigue ambiguo, vacío.
  - Si el nombre viene con APELLIDOS primero (el formato del censo), se saltan los apellidos frecuentes (lista corta)
    que no son nombre de pila y los apellidos con partícula (DE LEÓN, DE LA ROSA, DE LOS SANTOS, DE JESÚS), salvo justo
    después de MARÍA, JOSÉ o JUAN («MARÍA DE JESÚS», «JUAN DE LA CRUZ»), donde son parte del nombre.
  - Si después del nombre elegido aparece un nombre de pila del **otro sexo**, el orden no es claro (SANTIAGO, LEÓN,
    SANTOS, MARTÍN, SALVADOR… también son apellidos): vacío, con los apellidos primero o con el nombre primero. Única
    excepción: el compuesto MARÍA JOSÉ / JOSÉ MARÍA, donde manda el primero.
  - Una inicial después de los apellidos solo se salta con UN apellido antes («PÉREZ N JUAN») y si lo que sigue no es
    MARÍA, JOSÉ ni un ambiguo; con dos apellidos antes («PÉREZ HERNÁNDEZ M. JOSÉ») es el primer nombre: vacío.
  - ALEXIS y SALOMÉ son ambiguos (se usan para los dos sexos).
  - Si la tarjeta o WinLab no coinciden con el nombre, mandan ellas y se anota en «Calidad de datos» (solo las letras).
  - «Por completar» ya no pide el sexo inferido. «Completitud» lo cuenta aparte («Sexo (inferido del nombre)»), sin
    mezclarlo con «Sexo (escrito en la tarjeta)». «Con sexo (%)» del Resumen mensual incluye las tres fuentes.
  - Error esperado: bajo en los nombres que sí se clasifican (no se ha medido contra una muestra real; los casos dudosos
    se dejan vacíos, así que habrá más vacíos que errores); sobre todo nombres poco usuales del otro sexo. Para un estudio
    que dependa del sexo, reportar cuántos son inferidos.
- **Procedimientos del censo y seguimiento de operados** (25 nov 2026, registro 2026.11.26-2). «En procedimientos se centra
  el total de cirugías que se realizan, al menos de cirugía general; que lo registre, nos servirá para conservar a esos
  pacientes como seguimiento.»
  - El script del censo (`censo-sync.gs`, versión 2026.11.25-2) guarda la sección PROCEDIMIENTOS de la hoja en
    `censo_procedimientos` (una fila por fecha + expediente + nombre normalizado; fecha = celda A2 del censo). El
    registro la lee **por cursor** (`visto_ultimo`, `id`) con 2 días de margen, dentro de `opcional()`: si falla, solo
    esa pestaña se queda sin tocar y se avisa.
  - **Solo hay datos desde el 25 nov 2026**: Google no guarda los censos viejos (la hoja se reescribe cada día). En el
    Resumen mensual las tres columnas nuevas van vacías antes de noviembre de 2026 (no hay dato, no es cero) y noviembre
    de 2026 es un mes incompleto.
  - «ID episodio»: el episodio de «Pacientes» con el mismo expediente y nombre compatible (la regla de identidad del
    registro, `regMismaPersona`) cuya estancia cubre la fecha (ingreso → egreso; hasta hoy si sigue hospitalizado; hasta
    la última vez visto si salió de la base sin egreso); nunca una tarjeta duplicada. Se recalcula **cada noche para
    todas las filas**, así un episodio que aparece después también se liga. «Ambulatorio» = Sí si la cama es EXT o no
    hay episodio. «Grupo» = el grupo quirúrgico que se reconoce en el diagnóstico (la sección no trae el procedimiento).
  - Revisión (25 nov 2026): **Vigente = No** para las filas cuyo «Visto por última vez» es anterior (más de 1 min) al
    más reciente de su misma fecha: el script del censo reescribe juntas las que siguen en la hoja, así que las demás
    salieron ese día (nombre o expediente corregido, cancelada). No cuentan en el Resumen ni en Seguimiento; la tabla no
    se borra. Con cama que no es EXT, una cirugía la víspera del ingreso se liga al episodio que ingresó al día
    siguiente si ninguno cubre la fecha. Con expediente no válido para el registro (menos de 4 dígitos), «Ambulatorio»
    queda vacío (salvo EXT).
  - «Seguimiento de operados»: una fila por persona (expediente + nombre compatible; las personas del registro son las
    de la «Clave de seudónimos») con procedimientos en el censo o cirugías en el registro (sin la programación sin
    confirmar ni las tarjetas duplicadas). «Reingresos posteriores (n)» = episodios que ingresaron después del primer
    procedimiento, sin el que lo contiene. Lista de trabajo con nombres, como «Por completar»: **no se comparte**.
    Revisión (25 nov 2026): «Nombre» (clave) es el primero que se vio, sin acentos ni espacios dobles, y el nombre tal
    cual va en «Nombre más reciente» (al final); «Días desde el último procedimiento» solo los primeros 30 días (después
    vacío, para no reescribir cada noche toda la lista); los expedientes no válidos para el registro entran tal cual.
  - «Análisis · Episodios» y las definiciones del Resumen mensual no cambian; las columnas nuevas van al final.
- **Talla: ya no se mide** (25 nov 2026). La talla no se registra en este servicio: «Completitud» ya no tiene la fila
  «Talla» (las de corridas anteriores quedan «Vigente = No») y «Ingresos sin talla (n)» del Resumen mensual se queda
  vacía en su lugar (quitarla movería las columnas). El IMC se sigue calculando si alguna vez hay talla.
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
- **Variables derivadas (24 nov 2026).** Todo sale de lo que ya está en la hoja: no hay ninguna lectura nueva a la base.
  Las columnas van al final de «Análisis · Episodios» y de «Análisis · Cultivos»; cada una tiene su definición y su
  sesgo conocido en «Diccionario de variables». En todas, **vacío no es 0**: vacío = no se pudo saber.
  - *Días observados:* «Días con antibiótico (observados)» con primer y último día, «Antibióticos distintos (n)»,
    «Carbapenémico», «Días en ayuno», «Ayuno posoperatorio (días)», «Día posoperatorio de inicio de dieta», «Días con
    NPT», «NPT % máximo», «Ayuno >5 días sin NPT», «Días con ventilación», «Días con vasopresor» y «Días con
    tromboprofilaxis». Se cuentan las noches fotografiadas en «Estado diario» con la casilla prendida; solo en las
    noches sin foto se usa el historial de la casilla (del prendido a la víspera del apagado). Subestiman en todo
    episodio anterior al 24 nov 2026 (foto) o al 14 oct 2026 (auditoría). Las banderas «(registrado)» se conservan.
  - *Cobertura del diario (%):* noches fotografiadas ÷ días de estancia. Dice cuánto de la estancia sustenta los días
    observados; con cobertura baja no se deben comparar episodios.
  - *Dispositivos y drenajes:* «Dispositivos (n)», «Sonda endopleural», «Estoma», «Terapia de presión negativa», «Días
    con drenaje» (de la primera a la última vez visto, más las fechas con gasto) y «Gasto máximo (mL)». Los días en UCI
    ya estaban en «Días en UCI» (movimientos).
  - *Lesión renal aguda (KDIGO 2012, solo creatinina):* «Creatinina basal (mg/dL)» es la **mínima del episodio**, no la
    previa al ingreso: subestima en quien llega lesionado. Estadio 1 = ≥1.5 veces la basal o +0.3 mg/dL frente a un valor
    de hasta 2 días antes (las 48 h se aproximan con fechas sin hora); 2 = ≥2 veces; 3 = ≥3 veces o ≥4.0 mg/dL. Con menos
    de 2 creatininas todo queda vacío. «LRA posoperatoria» = criterio en los días 1 a 7 de la primera cirugía sin lesión
    previa. No usa uresis ni diálisis; en enfermedad renal crónica hay que estratificar.
  - *Laboratorio:* «Hb inicial», «Hb preoperatoria», «Caída máxima de Hb», «Anemia al ingreso (OMS)», «Hipoalbuminemia
    (<3.5)», «Albúmina <3.0», leucocitos, plaquetas y sodio iniciales, «PCR día 3-4 posoperatorio» y «Glucosa >180
    (días)». Los «iniciales» son columnas nuevas al final (no se tocó el orden de los resúmenes de labs que ya había) y
    son el primer laboratorio que llegó al registro, que puede ser posterior al ingreso o a la cirugía.
  - *Cultivos:* el sitio sale de palabras en «Tipo» + «Muestra». «ISQ probable (cultivo)» = cultivo positivo, no
    contaminante, de herida o abdominal, tomado 1 a 30 días después de una cirugía del episodio (el del mismo día de la
    cirugía no cuenta). Subestima: la infección superficial casi nunca se cultiva. «ISQ mencionada (texto)» busca la
    mención afirmada en la tarjeta («SIN DATOS DE ISQ» o «VIGILAR ISQ» no cuentan). «Bacteriemia» excluye el hemocultivo
    con solo flora de piel. «Multirresistente (probable)» sale de las marcas del germen y de «Resistentes»; no es la
    definición internacional completa (no cuenta los intermedios, no descuenta la resistencia natural del germen y
    depende de los antibióticos que el laboratorio probó).
  - *Charlson simplificado:* 14 comorbilidades nuevas con la misma regla de negación (EVC, vascular periférica,
    demencia, úlcera péptica, tejido conectivo, hemiplejía, diabetes con daño a órgano blanco, hepatopatía grave,
    metástasis, leucemia / linfoma, VIH / SIDA, alcoholismo, anticoagulante / antiagregante, cirugía abdominal previa).
    «Charlson (puntos)» usa los pesos de 1987; «Charlson (calculable)» = 1 solo si hay APP, y sin APP los puntos quedan
    vacíos. **No es el Charlson de expediente**: depende de lo escrito en el APP; decirlo así en métodos y validar una
    muestra. «Riesgo preoperatorio simple (0-6)» es un puntaje **interno, no validado**, solo para estratificar.
- **«Análisis · Cirugías» (24 nov 2026).** Una fila por cirugía de cada episodio (las de la caja y las inferidas de DX,
  Cronología, fecha POP o texto Qx; no la programación sin confirmar ni las tarjetas duplicadas). Son las mismas que
  cuenta «Cirugías (n)» de Episodios.
  - Numeradas por fecha dentro del episodio; las que no tienen fecha van al final.
  - El «ID cirugía» sale del seudónimo del episodio y del id de la cirugía en la caja; en las inferidas, de su fecha y
    procedimiento. Una inferida a la que le corrigen el texto cambia de ID y la fila anterior queda «Vigente: No»:
    analizar solo «Vigente: Sí».
  - «Abordaje (inferido del texto)» va aparte del elegido en la caja y queda vacío si el texto no lo dice (no se asume
    abierta). «Urgencia inferida (día 0-1)» es un sustituto por fechas, no el tipo elegido.
  - «Procedimiento» es texto libre: revisarlo antes de compartir la pestaña.
  - Crecimiento estimado: ~4 000 cirugías al año × 26 columnas ≈ 0.1 millones de celdas.
- **Eventos adversos, apoyo, completitud, flujo, indicadores y antibióticos (24 nov 2026).** Cinco pestañas nuevas y 15
  columnas al final de «Análisis · Episodios». Todo sale de lo que ya está en la hoja: **ninguna lectura nueva a la
  base** (egress 0). Sin nombres ni expedientes. Cada columna, con su sesgo, está en «Diccionario de variables», que
  además gana dos secciones: «Sesgos y limitaciones» y «No disponible en esta fuente» (lo que habría que capturar en la
  app: ASA, clase de herida, profilaxis, seguimiento a 30 días…).
  - **«Eventos adversos».** Una fila por evento detectado en cada episodio, de un catálogo cerrado.
    - *Objetivo* (dato estructurado o laboratorio): defunción (motivo de egreso), reintervención no planeada (cirugías),
      reingreso no planeado a 30 días, lesión renal KDIGO, ISQ probable y bacteriemia (cultivos), vasopresor y
      ventilación (foto nocturna o historial), UCI (movimientos) y drenaje percutáneo (estudio de RIS de modalidad XA
      cuyo nombre dice drenaje o punción).
    - *Mención en texto* (Manejo, Pendientes, Cronología, guardia y la «Complicación» de la cirugía): fuga /
      dehiscencia, fístula, evisceración, hemorragia posoperatoria, íleo, neumonía, TEV, sepsis / choque, transfusión y
      drenaje percutáneo. No cuenta lo negado, lo planeado, el riesgo ni el antecedente («SIN DATOS DE FUGA», «VIGILAR
      SANGRADO», «PROBABLE NEUMONÍA», «CRUZAR 2 PG»). Neumonía, sepsis, TEV, íleo y transfusión no se buscan en el
      Diagnóstico: ahí suelen ser el motivo de ingreso.
    - Cada evento lleva el grado de Clavien-Dindo **mínimo** que implica. En operados, Episodios gana «Clavien-Dindo
      mínimo inferido», «Complicación mayor inferida (≥ IIIa)», «Eventos adversos (n)» y «Clavien (fuente)». Es un
      **piso**: lo objetivo solo cuenta desde el día posoperatorio que le toca (vasopresor y ventilación, desde el día
      1) y lo no registrado no se ve. «Clavien-Dindo máximo» y «Complicación mayor (Clavien ≥ IIIa)», los elegidos en la
      caja, **no se tocan**.
    - **«Revisado»** es para quien valida contra el expediente: lo que se escriba ahí se conserva en cada corrida.
      Antes de publicar hay que validar una muestra, sobre todo de las menciones en texto.
  - **Columnas de apoyo en Episodios.**
    - «Tipo de egreso (probable)» y «Fuente del tipo», solo en el egresado sin motivo: Alta, Alta voluntaria o Traslado
      si lo dice un renglón de guardia, cronología o pendientes (también los renglones retirados por la guardia);
      «Volvió al censo» si la persona tiene un episodio posterior; «Sigue en el hospital» si WinLab o el RIS traen
      estudios de 1 a 30 días después del egreso. **Nunca alimenta «Defunción» ni «Tipo de egreso»**; si un renglón
      habla de una defunción, queda vacío. Es una pista para completar el motivo en la app, no un desenlace.
    - «Desenlace conocido» (1 / 0), «Días al reingreso», «Dx principal del reingreso», «Reingreso planeado (probable)»
      (el episodio siguiente dice cierre de ileostomía, segundo tiempo, cirugía programada… o su primera cirugía es
      electiva), «Reingreso no planeado a 30 días», «Reingreso con cirugía» y «Seguimiento posalta observable (días)»
      (tope de 30, para que las filas viejas no cambien cada noche).
    - «Edad al ingreso (calculada)»: con la fecha de nacimiento del encabezado de WinLab, que se guarda en la columna
      nueva «Nacimiento en WinLab» de «Labs del robot (WinLab)» (pestaña con nombres). **Decisión de privacidad:** la
      fecha de nacimiento NO pasa a las pestañas de análisis, solo la edad. Solo se llena con los reportes que el registro
      lee desde esta versión (los nuevos y los que se vuelven a capturar). El encabezado sí está en la base para los
      anteriores, pero no se vuelve a leer WinLab completo: costaría ~57 MB.
    - «Periodo de captura»: «Anterior a la captura estructurada» si el episodio terminó antes del 28 oct 2026.
  - **«Completitud» y «Flujo de la cohorte».** Por mes de ingreso y acumulado, cuántos episodios no duplicados tienen
    cada dato (edad, sexo por fuente, ingreso, tipo de egreso, dx principal, APP, peso, laboratorio, creatininas,
    albúmina, signos del día 0-1, tromboprofilaxis, cobertura del diario, expediente válido) y, por cirugía, fecha, tipo,
    abordaje, Clavien-Dindo y sangrado. El flujo resta en orden y cada episodio sale en el primer paso que le toca. El
    Resumen mensual gana «Egresos con motivo (%)», «Con sexo (%)» y «Episodios sin labs (n)».
    - Sin hacer: completitud del cirujano (el análisis no lleva nombres de personal).
  - **«Indicadores de calidad».** Universo: egresos observados que no son tarjetas duplicadas ni borrados en la base; por mes de egreso (los
    de cirugía, por mes de la cirugía).
    - Mortalidad hospitalaria y posoperatoria en dos versiones (**desenlace conocido** y **desconocidos como vivos**: la
      real está entre las dos), reintervención no planeada, reingreso a 30 días y no planeado, complicación mayor
      capturada e inferida, ISQ probable, lesión renal posoperatoria, bacteriemia, estancia y estancia posoperatoria
      (medianas), cirugía en ≤1 día, laparoscopía y conversión, días de antibiótico por 100 días-paciente, % de días
      Watch o Reserve, tromboprofilaxis en operados, NPT y ayuno.
    - Intervalo de 95 % de **Wilson** en las proporciones. **Con menos de 10 en el denominador no hay tasa**: quedan
      el numerador y el denominador. «Excluidos por dato faltante» dice cuántos casos no entraron al denominador.
    - Para no gastar celdas: el mes solo lleva el estrato «Todos»; el trimestre agrega Urgencia y Electiva;
      «Acumulado» agrega «Dx: …» y «Cirugía: …» cuando tienen 10 o más. Dos columnas más que en el plan, «Valor» y
      «Unidad», para lo que no es una proporción (medianas y razones).
  - **«Análisis · Antibióticos».** Un curso = noches seguidas con el mismo antimicrobiano de la lista cerrada (casilla
    prendida con su nombre, detectado en Manejo, o el historial en las noches sin foto). Un hueco de hasta 3 días solo
    parte el curso si alguna noche del hueco tiene foto sin el antibiótico. «MEROPENEM D5» visto por primera vez
    retrocede el inicio estimado 4 días. AWaRe sale de una tabla fija del script. Solo sirve hacia adelante (fotos
    desde el 24 nov 2026, historial desde el 14 oct 2026) y no mide dosis, vía ni la profilaxis de quirófano.
  - **Costo.** Lecturas a Supabase: ninguna nueva. Celdas estimadas al año: Eventos ~15 000-30 000, Antibióticos
    <10 000 (16 columnas por curso), Completitud <5 000, Flujo ~50, Indicadores ~20 000, las 15 columnas de Episodios
    ~45 000 y «Nacimiento en WinLab» una celda por reporte nuevo. El tiempo del análisis queda en «Análisis (s)» de
    «Integridad»: revisarlo las primeras noches.
  - **Sin verificar contra la hoja real:** el tiempo de las reglas de texto con todos los episodios, y cuántos
    estudios XA del RIS son drenajes (el nombre del estudio es texto del hospital).
- **Correcciones de la revisión (24 nov 2026, misma versión 2026.11.24).** Tres revisores reprodujeron 23 problemas
  en lo anterior; esto es lo que cambió (cada punto tiene su prueba «V…» en `registro-pacientes.test.js`).
  - **Privacidad.**
    - «Análisis · Episodios» ya no copia *Sección* ni *Especialidad* tal cual: pasan por la misma regla de «Estado
      diario» (salas y códigos conocidos; lo demás, «valor no válido»). Las filas ya escritas se corrigen solas.
    - La *cama* debe tener forma de cama («3-151», «UCI 4», «12A») y la *especialidad* estar en el catálogo del script
      (`REG_ESP_CODIGOS`; si el servicio usa un código nuevo hay que agregarlo). «Antibiótico (texto)» y «Dieta» (texto
      libre del checklist) solo pasan a «Estado diario» y a «Soporte y exposiciones» si están hechos de vocabulario
      conocido; si traen otra palabra queda lo conocido y la marca «[…]» («MEROPENEM D3 · […]»).
    - Sin cambiar: «TVP» en «Estado diario» sigue llevando el texto de «otro» de la tromboprofilaxis.
  - **Eventos adversos.**
    - La mención en texto ya no cuenta si va negada con verbo («NO PRESENTA DATOS DE…», «NO CURSA CON…»), negada
      después («… DESCARTADA», «… NO REQUERIDA»), si es preventiva o condicional («PARA EVITAR…», «TRANSFUNDIR SI HB
      <7», «SOLICITAR 2 PG») o habla de un familiar. Lo mismo en «ISQ mencionada (texto)». «… RESUELTA» sí cuenta.
    - «Dehiscencia de herida» (grado I) va aparte de «Fuga / dehiscencia» (anastomosis, grado II). El drenaje
      percutáneo que solo está en el texto no lleva grado (el IIIa sale del RIS, después de la cirugía).
    - Reintervención no planeada: no cuentan los procedimientos menores (CPRE, endoscopia, traqueostomía, catéteres,
      punciones), ni otro renglón del mismo día que la índice; la 2.ª cirugía elegida «Electiva» es planeada. Solo la
      relaparotomía o la que el texto llama reintervención / complicación es un evento *Objetivo* de grado IIIb; la que
      solo lo parece por fechas sale con certeza «Probable (por fechas)», sin grado, para revisar.
    - Vasopresor y ventilación: solo cuenta el que **empieza** después de operarse; el que ya traía el día de la
      cirugía o antes y sigue se lista con «Ya lo tenía…» en «Detalle» y no sube el Clavien inferido.
    - Lesión renal posoperatoria: exige una creatinina de hasta el día de la cirugía (sin ella queda vacía: con la basal
      mínima, el que llega lesionado y mejora salía como lesión nueva).
    - La clave de la pestaña ya no lleva la fecha: «ID episodio» + «Evento» + **«Ocurrencia»** («única», o la fecha
      en reintervención y drenaje percutáneo). Si a un evento se le corrige la fecha conserva su renglón y su
      «Revisado». El estadio de la lesión renal va en la columna nueva **«Detalle»** (el evento se llama «LRA (KDIGO)»).
  - **Indicadores.**
    - *Reingreso a 30 días*: el egreso entra (numerador y denominador) cuando ya tiene 30 días observados; antes, el
      que reingresaba entraba de inmediato y el mes reciente salía inflado (hasta 100 %).
    - *Reingreso planeado*: se evalúa por cláusula; nombrar la cirugía previa («PO CIERRE DE ILEOSTOMIA + FUGA») o
      negarla no es planeado, y con una complicación en el diagnóstico del reingreso nunca lo es.
    - *Flujo de la cohorte* e *Indicadores* usan el mismo universo: «Episodios analizables» es el denominador de
      «Mortalidad hospitalaria (desenlace conocido)». El episodio sin fecha de ingreso ya no se resta (se cuenta
      aparte) y la tarjeta borrada en la base no entra a ningún denominador.
    - *Cirugía en ≤1 día* y *Estancia posoperatoria* quedan vacías si la cirugía tiene fecha anterior al ingreso.
    - *Ayuno >5 días sin NPT*: solo egresos con cobertura del diario ≥ 80 %.
    - *Antibióticos*: el inicio estimado se topa en el ingreso, se descarta si retrocede 60 días o más, «D10 DE
      ESTANCIA» no es el día del antibiótico, y un tramo cuyo inicio estimado alcanza al anterior es el mismo curso
      (antes se contaban dos veces los días).
    - *Tipo de egreso (probable)*: no cuentan el traslado dentro del hospital, el alta de un interconsultante, el alta
      condicionada («SI TOLERA», «PROBABLE… MAÑANA») ni el laboratorio de consulta externa posterior al egreso.
    - *Comorbilidades / Charlson*: «DM2 E HAS NEGADAS», «NO DIABETICO» y los antecedentes de un familiar ya no cuentan.
  - **Operación.**
    - *Carga inicial del historial por partes*: mientras `audit_log` (notas) se sigue leyendo, «Análisis ·
      Antibióticos» no se escribe (se avisa) y se escribe completa al terminar; así no quedan cursos con el inicio
      equivocado marcados «Vigente: No».
    - *Avisos por tiempo*: «más de 36 h sin corrida completa» y «N días sin copiar la guardia» también salen si la marca
      nunca se guardó (se cuenta desde la primera corrida de esta versión, propiedad `REG_CUENTA_DESDE`).
    - *«Integridad»*: si su fila no se puede escribir, la corrida termina bien y lo avisa (antes fallaba al final).
    - *Auditoría de notas*: la lectura ya no baja las filas que solo tocan `lab_history` / `imagen_history` (las
      reescribe la sincronización de la app; eran 60-87 % de las filas) ni las cuenta como ediciones. **Revisar
      `audit_log` en «Bytes leídos por tabla» la primera noche.**
    - *Cuadre de episodios*: la lectura ligera de `archive` se hace una vez al día (no en cada vuelta extra).
  - **Sin hacer, y por qué.**
    - Releer WinLab para llenar «Nacimiento en WinLab» de los reportes viejos: el dato sí está en la base, pero la
      relectura completa cuesta ~57 MB. El Diccionario ahora lo dice así.
    - Aviso por correo propio (`MailApp`): pide un permiso nuevo al dueño. En su lugar, con el libro casi lleno la
      corrida termina con error a propósito y Google manda su correo de fallo (ver «Capacidad»).
    - Partir pestañas por año / libro histórico automático (punto 32 del plan): se decide con los números de
      «Integridad»; queda el procedimiento manual de «Capacidad».
- **Índices en la base** (`scripts/supabase_registro_indices.sql`): (fecha de captura, id) en `winlab_labs`,
  `ris_estudios` y `archive`. Sin ellos, cada página de WinLab tardaba 3.9 s (PostgREST corta a los 8 s); con ellos,
  26 ms.
- **Capacidad:** Sheets admite 10 millones de celdas por libro.
  - Las pestañas nuevas se crean sin las columnas vacías de sobra.
  - El Diccionario cuenta las celdas de todas las hojas y avisa al pasar del **50 %** (antes 70 %, que dejaba unos 4
    meses). Entonces hay que pasar lo viejo a un libro histórico.
  - **Pausa parcial desde el 95 %** (24 nov 2026, revisión). Para que las celdas que quedan sean de lo que no se puede
    volver a tomar, el registro deja de leer y escribir WinLab y RIS (la base los conserva; su cursor no avanza) y las
    pestañas de análisis (se recalculan). Sí escribe pacientes, «Estado diario», guardia, drenajes y auditoría.
    - Esa corrida **termina con error a propósito**, después de escribir y anotar todo: Google le manda al dueño del
      disparador su correo de fallo. Es el aviso fuera de la hoja; no cuesta nada ni pide permisos.
    - Si Sheets rechaza agregar renglones a una pestaña (ya en el límite), solo esa pestaña se queda sin escribir; su
      cursor no avanza y se vuelve a leer cuando haya espacio. «Integridad» dice cuál.
  - **Para liberar espacio (a mano):** hacer una copia del libro («Registro histórico AAAA»), y en el libro vivo borrar
    los renglones viejos de las pestañas grandes de robots («Labs del robot (WinLab)», «Cultivos del robot»,
    «Imagen del robot (RIS)») que ya están en la copia. El script nunca borra renglones; las pestañas de análisis se
    recalculan con lo que quede en el libro vivo, así que los estudios históricos se hacen sobre la copia.
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
   - **Al pasar a la versión 2026.11.24** no hay que crear nada a mano ni cambiar la base:
     - La primera corrida crea las pestañas nuevas («Eventos adversos», «Análisis · Antibióticos», «Completitud»,
       «Flujo de la cohorte», «Indicadores de calidad») y agrega al final las columnas nuevas de «Análisis ·
       Episodios», «Resumen mensual» y «Labs del robot (WinLab)».
     - Esa noche el Diccionario avisa «no tenía la(s) columna(s)… se agregaron al final»: es lo esperado, una sola vez.
     - Esa corrida reescribe «Análisis · Episodios» completa (cada fila gana columnas). Si no alcanza el tiempo,
       avisa y se completa en la siguiente corrida; revisar «Resultado» y «Análisis (s)» en «Integridad» al día siguiente.
     - No mover ni renombrar las columnas nuevas. En «Eventos adversos» solo se escribe en «Revisado».
     - Las pestañas nuevas no llevan nombres, pero siguen siendo seudonimizadas: se comparten con las mismas reglas.

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
