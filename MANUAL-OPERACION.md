# Piso Libro — Manual de operación (explicado fácil)

Este documento explica, paso a paso y sin tecnicismos, cómo está armada la app
y qué hacer cuando algo falla. Si solo tienes 1 minuto: lee "¿Qué hace cada
pieza?" y "Si los laboratorios no llegan".

## ¿Qué hace cada pieza?

Imagina una fábrica con cuatro máquinas que trabajan solas:

1. **La app** (lo que abres en el navegador): https://pisolibro.pages.dev
   Cada vez que alguien fusiona un cambio en la rama `main` de GitHub, la app
   se vuelve a publicar sola en menos de un minuto.
2. **La hoja del censo** (Google Sheets). Un pequeño programa (Apps Script)
   la lee cada 5 minutos y copia los pacientes a la base de datos. Si cambias
   una cama en la hoja, en 5 minutos la app lo refleja, con su nota intacta.
3. **El robot de laboratorios** (GitHub Actions, carpeta `rpa/`). Tres veces al
   día entra a WinLab, busca a cada paciente del censo, descarga sus
   laboratorios y los guarda en la base de datos. Horarios (hora de León):
   04:07, 13:15 y 20:07. Quien lo despierta a la hora exacta es la base de
   datos (Supabase, tarea programada `winlab-scrape-*`), porque el reloj de
   GitHub llega con 3 a 9 horas de retraso; el de GitHub queda como respaldo.
   Para ver si despertó: tabla `winlab_dispatch_log` en Supabase (una fila por
   intento, con la respuesta del worker). Detalle en
   `scripts/supabase_pg_cron_dispatch.sql`.
4. **La base de datos** (Supabase). Guarda pacientes, notas, laboratorios y la
   papelera. Solo se puede entrar con usuario y contraseña de la app.

## Una sola dirección para todos

Todo el equipo debe usar **https://pisolibro.pages.dev**. Las direcciones
viejas (GitHub Pages, Netlify) sirven versiones antiguas que borran datos de
los laboratorios. Si alguien tiene la app "instalada" en el teléfono desde
otra dirección, que la borre y la vuelva a instalar desde esta.

## Paso a paso: actualizar el programa de la hoja (Apps Script)

Hay que hacerlo **cada vez** que cambie el archivo `apps-script/censo-sync.gs`
en GitHub (el aviso lo da el PR). Son 2 minutos:

1. Abre en GitHub el archivo
   `https://github.com/Gerardofdz1540/piso-libro/blob/main/apps-script/censo-sync.gs`.
2. Pulsa el botón **Raw** (arriba a la derecha del archivo). Se abre texto
   plano. Selecciona todo (`Ctrl+A`) y copia (`Ctrl+C`).
3. Abre la hoja del censo en Google Sheets.
4. Menú **Extensiones → Apps Script**. Se abre el editor.
5. En la lista de la izquierda pulsa `Código.gs`. En el cuadro grande
   selecciona todo (`Ctrl+A`), borra, y pega (`Ctrl+V`) lo que copiaste.
6. Pulsa el icono de **guardar** (disquete) o `Ctrl+S`.
7. Arriba, en el selector de función (dice `doSync` o similar), elige
   **`createTriggers`** y pulsa **▶ Ejecutar**. Si Google pide permisos:
   **Revisar permisos → tu cuenta → Permitir**.
8. Para comprobar: elige **`checkLabsFreshness`**, pulsa **▶ Ejecutar** y
   abre **Ver → Registros**. Debe decir la hora del último laboratorio
   descargado.

Listo. A partir de ahora, si el robot de laboratorios se detiene más de un
día, recibes un correo con las instrucciones para reactivarlo.

## Paso a paso: borrar ramas viejas en GitHub

Las ramas son "copias de trabajo" que ya se fusionaron y solo estorban.

1. Entra a https://github.com/Gerardofdz1540/piso-libro/branches
2. En cada rama de la lista de abajo, pulsa el icono de **bote de basura**
   que está a la derecha:
   - `claude/unify-trunk`
   - `claude/app-p0-quickwins`
   - `claude/scraper-p0-incremental`
   - `claude/apps-script-archive-move`
   - `claude/app-winlab-labs`
   - `claude/scraper-age-guard`
   - `feature/winlab-auto-sync` (solo después del paso de Cloudflare de abajo)
3. No borres `main`.

## Cloudflare Pages: `main` es la rama de producción (hecho el 14-oct-2026)

Cloudflare publica como **producción** solo los deploys cuya etiqueta de rama
coincide con la "Production branch" del proyecto. Desde el 14 de octubre de 2026
esa rama es `main` en ambos lados:

- En Cloudflare: **Workers & Pages → pisolibro → Settings → Builds & deployments
  → Production branch = `main`**.
- En el repo: `.github/workflows/deploy-pages.yml` publica con `--branch=main`.

Si alguna vez cambias la Production branch en Cloudflare, cambia también esa
línea del workflow: si no coinciden, cada push a `main` se publica como
*preview* y la app en producción se queda congelada sin ningún aviso. La rama
vieja `feature/winlab-auto-sync` ya no hace falta para publicar; puedes borrarla
cuando quieras.

## Cómo moverse por la ficha del paciente (iPad)

- La barra oscura de arriba de la ficha queda pegada al desplazar. Tiene las
  flechas ← → para cambiar de paciente, el botón **Pase / Completo** y una fila
  de saltos: **Dx · Labs · Manejo · Plan · Pase · Entrega · Historia · IC·Cult ·
  Sug. · Indic. · Estudios · Diagrama · No olvidar**. Un toque lleva a ese bloque
  (y lo abre si estaba plegado). Los numeritos indican pendientes abiertos,
  sugerencias críticas, estudios y recordatorios; en Labs sale "hoy" o los días
  sin laboratorios.
- Al bajar por la ficha, el lema y la barra de botones de arriba se esconden
  para ganar pantalla; vuelven al subir al principio.
- Los bloques secundarios (Historia APP/Qx/PA, MIPs/R1, Interconsultas·Cultivos,
  Sugerencias, Indicaciones, Estudios, No olvidar) son chips plegables. Lo que
  abras o cierres se recuerda por separado en modo Pase y en modo Completo.
- En iPad horizontal la ficha va en dos columnas (clínica a la izquierda,
  exploración y checklist a la derecha). Las tablas de labs se parten en dos
  mitades lado a lado; las fechas anteriores siguen en 📈 Gráficas.
- Dieta, Ayuno, ATB y TVP se cambian con un toque en la primera fila del
  checklist (antes solo desde el modal de editar).

## Indicaciones del Google Doc en cada tarjeta

Las indicaciones se escriben donde siempre, en el Doc "INDICACIONES HOSPITALIZACION". La base de
datos (Supabase) descarga el Doc cada 5 minutos por su enlace de "compartir" y, si cambió, lo
guarda; la app lo recibe al instante y cada tarjeta muestra su bloque en **Indicaciones** (Dieta,
Soluciones, Medicamentos, Antibióticos, Medidas generales). No hay que hacer nada: solo mantener
el Doc compartido como "cualquiera con el enlace puede ver". Si algún día se restringe, el
programa de la hoja (Apps Script, `syncIndicaciones`) hace el mismo trabajo con tu cuenta de Google.

- El cruce es por **cama + nombre**. Si un paciente cambió de cama, lo encuentra por nombre. Si en
  el Doc hay varias fechas del mismo paciente, muestra la más reciente.
- Si en el Doc la cama tiene indicaciones a nombre de **otra persona** (el paciente anterior),
  la tarjeta avisa en rojo y no las muestra como propias hasta que toques "Ver de todos modos".
- En la cabecera del bloque: 📄 abre el Doc; 🔄 lo trae ahora mismo sin esperar los 5 minutos.
  "Doc editado hace X" dice cuándo se modificó el Doc por última vez.
- Opcional (respaldo): pegar el `censo-sync.gs` nuevo en Apps Script y ejecutar `createTriggers`
  hace que también tu cuenta de Google suba el Doc; solo hace falta si el enlace deja de ser
  público.

## Drenajes, sondas y estomas por paciente

En el checklist de la tarjeta, la fila **Drenajes y sondas** es una lista libre: botones rápidos
(+ SNG, + Saratoga D, + Saratoga I, + SEP, + CMP, + Estoma, + Fístula mucosa) y un selector
"+ más…" con el catálogo (Penrose, JP, Blake, Hemovac, Drenovac, Foley, cistostomía, CVC, catéter
de HD, ileostomía, colostomía, yeyunostomía, gastrostomía, TPN, Otro = nombre libre). Cada
dispositivo tiene su renglón: tocar el nombre cambia el lado (D / I / sin lado), y lleva sitio,
gasto en mL/24 h, características (seroso, fecal, fuga…), día de colocación (📅) y ✕ para
retirarlo. Lo que registres aparece resumido en la línea de pase de la cabecera y en la hoja de
entrega. Los chips antiguos (SNG, PRS 1-3, Estoma, SEP) se convirtieron solos a esta lista.

## Estudios de imagen (tomografías, ultrasonidos, rayos X) en cada tarjeta

Un robot (`.github/workflows/ris-scraper.yml`) entra cada 2 horas al visor radiológico
(consultas-pisos), pide los estudios de los últimos 14 días y cruza cada uno por nombre (y edad)
con el censo. En la tarjeta, dentro de **Estudios de imagen**, aparece el bloque "Estudios del
visor (RIS)": fecha y hora, modalidad (CT, US, RX…), nombre del estudio, sede, marca de caso
crítico, enlace 🖼 al visor y, cuando ya existe el reporte, el **reporte transcrito** (plegable).
Si todavía no hay reporte, dice "Sin reporte todavía · estudio realizado" y se completa solo en la
siguiente pasada. Al llegar un estudio o reporte nuevo, la tarjeta se actualiza al instante con un
aviso. Las credenciales del visor viven en la tabla `rpa_config` de Supabase (no en el código);
si cambian, se actualizan ahí. Para lanzarlo a mano: Actions → "RIS Imagen" → Run workflow.

## Alertas y laboratorios en el tablero

La hoja de labs críticos, labs nuevos y "sin laboratorios de hoy" ya no ocupa la parte de arriba:
está en el botón **🔔** de la barra del paciente (muestra los contadores: rojo = críticos,
🧪 = labs nuevos, 📭 = sin labs de hoy). Se abre como panel lateral; tocar un renglón cierra el
panel y abre la tarjeta de ese paciente, resaltada. En el carril de camas, un punto rojo marca
labs críticos sin reconocer y uno ámbar labs atrasados.

## Si los laboratorios no llegan

1. Abre https://github.com/Gerardofdz1540/piso-libro/actions/workflows/winlab-scraper.yml
2. Mira la lista de corridas. Cada día debe haber tres (04:07, 13:15 y 20:07
   hora de León). Un círculo verde es éxito; rojo es error.
3. Si arriba aparece un aviso amarillo que dice **"This scheduled workflow is
   disabled"**: pulsa **Enable workflow**. (GitHub apaga el robot si el
   repositorio pasa 60 días sin cambios; el robot ya se "mantiene despierto"
   solo, pero por si acaso.)
4. Para lanzarlo a mano: botón **Run workflow** (a la derecha) → **Run
   workflow**. Tarda 30–60 minutos. En la app, el botón "Labs" también lo
   dispara con clic derecho.
5. Si la corrida está en rojo, abre la corrida, pulsa el paso rojo y copia las
   últimas líneas del registro; mándamelas y lo reviso. Nunca pegues ahí
   nombres de pacientes en mensajes públicos.

## Abrir la app desde el celular, con datos móviles o sin conexión

Desde octubre de 2026 la app ya no depende de internet para abrir:

- Todas las librerías que necesita vienen dentro de la app (carpeta `vendor/`). Antes se bajaban
  de servidores externos (unpkg, cdnjs, jsdelivr) y en redes móviles que los bloquean la página se
  quedaba en blanco o pedía login con el aviso "CDN bloqueado".
- La primera vez que abras la app **con internet** (Wi-Fi del hospital), el navegador guarda una
  copia completa en el dispositivo. A partir de ahí abre siempre, aunque no haya red o la red
  corte la dirección: si el servidor no responde en 4 segundos, se usa la copia guardada.
- La sesión también se guarda: sin red no vuelve a pedir contraseña.
- Para instalarla como app: en iPhone/iPad, Safari → **Compartir → Agregar a inicio**; en
  Android, Chrome → menú ⋮ → **Instalar aplicación**.
- Hay una segunda dirección por si la principal no abre desde tu operador:
  https://pisocirugiahgl.netlify.app (misma app, mismos datos). En Netlify, comprueba que la
  "Production branch" del sitio sea `main`.

**Sin conexión** se puede leer y escribir todo. Lo que escribas se guarda en el dispositivo y en
una cola de envío; el estado abajo dice "Sin conexión". En cuanto vuelve una red que llega a
Supabase, la app sube la cola y descarga lo nuevo de los demás. Si cierras la app sin red, al
reabrirla sigue ahí lo que escribiste y se sube cuando haya red. Los laboratorios automáticos,
el Doc de indicaciones y las imágenes solo llegan con red.

Si tu operador bloquea también a Supabase (la app abre, pero el estado se queda en "Sin conexión"
aunque tengas datos), prueba desde el celular abrir
https://vkxplmrzyqlamxpbtmes.supabase.co/auth/v1/health : si no carga, esa red no sirve para
sincronizar y hay que esperar al Wi-Fi del hospital; lo escrito no se pierde.

## Botones ↩ Regresar y ↪ Rehacer

En la cabecera de cada tarjeta aparece **↩ Regresar** cuando hay algo que deshacer. Cada cambio
que puede doler guarda antes una copia de la tarjeta: texto de una caja al terminar de escribir,
quitar una cirugía, un drenaje, unos labs o un estudio, "Tomar guardia", auto-llenar, órdenes
rápidas y las novedades automáticas. Regresar vuelve un paso; tocarlo otra vez vuelve otro paso
más (hasta 20 por paciente) y cada regreso se sube como cualquier edición.

Si el regreso fue el error, aparece **↪ Rehacer**: vuelve a dejar la tarjeta como estaba antes
de regresar. Si en vez de rehacer escribes algo nuevo, lo que habías dejado atrás no se pierde:
queda como un paso más de Regresar ("como estaba antes de regresar…").

Los pasos se guardan en el dispositivo y sobreviven a cerrar la app (también sin red). Un
paciente dado de alta por error se recupera desde la **Papelera** (☁️ Cargar desde nube →
↩ Restaurar).

## Modo Hoja de visita (octubre 2026)

Es la ficha vista como la hoja de GoodNotes: una cuadrícula fija con **todas las cajas abiertas
a la vez**, sin plegables. En la barra de arriba de la ficha, el botón **🗂 Tarjeta / 📑 Hoja**
cambia entre los dos modos y se recuerda en cada dispositivo.

Orden de la hoja: DX · Labs · APP/PA | Cirugías · IC/Cultivos | Imagen | Pendientes · Entrega |
Recibo · Pase matutino (dieta, ATB, vitales, drenajes) · Manejo | MIPs/R1 · Sugerencias |
Indicaciones | Diagrama | No olvidar. En iPad vertical se acomoda en dos columnas; en celular en
una. Son las mismas cajas con los mismos botones: solo cambia dónde se pintan.

- **⚙ Cajas** (aparece en modo Hoja): quita de la hoja lo que no uses (Labs, Manejo, MIPs/R1,
  Imagen, Sugerencias, Indicaciones, Diagrama, No olvidar). Es por dispositivo y no borra nada.
- **🖨 Imprimir hoja** (dentro de ⚙ Cajas) o imprimir desde el navegador: en modo Hoja sale
  **una hoja por cama**, sin barras ni botones.
- **➕ Hoy** en Interconsultas, Cultivos, Entrega y Recibo anota la fecha de hoy (`dd/mm: `) al
  final de la caja, como la fecha que se escribe a mano antes de cada renglón. Pendientes ya lo
  tenía (ahí va al inicio).
- **Pase matutino con fecha**: los vitales llevan el día en que se tomaron. Si son de ayer, el
  chip dice "de 13 Oct" en ámbar. Al escribir el primer dato de hoy, los de ayer pasan al
  historial (renglón gris debajo, últimos 3 días a la vista, 14 guardados) y la fila queda limpia
  para el pase de hoy. Si te arrepientes, ↩ Regresar lo deshace.

## Fotos, trazos a mano y autor por caja (octubre 2026)

Tres cosas que la hoja de GoodNotes hacía y la app no:

- **📷 Fotos en Cirugías y Cultivos**: cada cirugía y la caja de Cultivos tienen un botón 📷
  (cámara o galería, varias a la vez). La foto se reduce (JPEG, máximo 1600 px) y se guarda en
  Supabase Storage (bucket privado `pl-fotos`, se muestra con enlace firmado); en la tarjeta
  queda una miniatura, tocarla la abre en grande, ✕ la quita (con confirmación y ↩ Regresar).
  **Sin red** la foto se guarda en el dispositivo marcada con borde punteado y se sube sola al
  volver la red (o al abrir la app con red). Los PDFs de labs usan el bucket `lab-sources`, que
  también se creó hoy: antes no existía y todo quedaba inline en la nota.
- **✍️ → 📌 A la caja**: el lápiz de cada caja (incluye ahora Interconsultas, Cultivos y Recibo)
  tiene un botón nuevo para dejar el trazo como imagen dentro de la caja, recortado al dibujo.
  Se ve en la hoja, en la impresión y en los demás dispositivos. 🤖 Transcribir sigue igual.
- **Autor por caja**: cada caja de texto muestra un chip con las iniciales de quien hizo el último
  cambio, la fecha y la hora, con un color fijo por persona (el nombre que pusiste al entrar).
  ➕ Hoy anota `dd/mm GF: ` y Tomar guardia sella `— Recibido dd/mm hh:mm GF —`.

## Las cajas de la ficha (octubre 2026)

Cada caja tiene un color propio para ubicarla de un vistazo. Columna principal, de arriba abajo:

- **🔴 DX / Motivo de ingreso** (rojo).
- **🧪 Laboratorios**.
- **🔪 Cirugías / Procedimientos** (morado). Una fila por intervención con su **fecha** (calendario),
  **PO día N** calculado solo, procedimiento, hallazgos, **sangrado** y cirujano. Botón
  **+ Agregar cirugía** para pacientes con varias intervenciones; la más reciente arriba. Esta caja
  sustituye a las antiguas "Qx / Procedimiento", "Drenajes" y "Sangrado": el texto que ya existía se
  convirtió solo a la lista (una fila por línea con fecha; el sangrado quedó en la cirugía más
  reciente). La fecha POP del menú "⋯ Más" ahora es la de la última cirugía.
- **💉 Manejo médico actual** (verde azulado).
- **⚠️ Pendientes / Plan** (ámbar).
- **📤 Entrega de guardia** (naranja): lo que **yo dejo** para la siguiente guardia, eventualidades
  y cosas por hacer. Las novedades de labs, imagen y cultivos se anotan solas con su fecha.
- **📥 Recibo de guardia** (verde): lo que **me entregan** al llegar. El botón **⇄ Tomar guardia**
  pasa el texto de Entrega a Recibo con fecha y hora y deja Entrega vacía para mi guardia.
- Plegables: **Historia · APP / PA** y **Pendientes MIPs / R1**.

Columna lateral: el **Pase** (dieta, ATB, TVP, herida, NPT, vitales, **drenajes y sondas** con su
gasto y **Balance**, clínico), IC · Cultivos, Sugerencias, Indicaciones del Doc, Estudios de imagen,
Diagrama y No olvidar. El balance ya solo se captura en el pase; bajo la lista de drenajes queda un
renglón de nota libre por si hace falta.

## Cambios de cama: los labs viajan con el paciente

Un paciente que cambia de cama en la hoja (cortar y pegar la fila, o reescribir el número de cama)
conserva su tarjeta completa: labs, pendientes, checklist, diagrama. Tres capas lo garantizan:

1. **La hoja** (`censo-sync.gs`): si la fila desaparece un instante mientras la mueves, el programa
   espera 12 minutos antes de darla de baja; si en ese lapso aparece en otra cama, solo cambia la
   cama. Corregir un número de expediente de la misma persona tampoco borra nada.
   **Hay que volver a pegar el programa en Apps Script** (ver "Paso a paso" arriba).
2. **La base de datos**: si un paciente con el mismo expediente y nombre vuelve a crearse en los
   10 días siguientes a haber sido archivado, su nota se restaura sola desde la Papelera (trigger
   `patients_restore_note_after_insert`, `scripts/supabase_restore_note.sql`).
3. **La app**: al aparecer un paciente, primero lee su nota de la nube y después lo muestra; y
   trae sus labs de WinLab aunque el último escaneo tenga más de 4 días.

El 13 de octubre de 2026 se recuperaron así las notas de 3-151, 3-153, 3-162, 3-177, 3-181 y UCI 8.

## Entrega de guardia: novedades automáticas

Todo lo que llega solo se anota en la caja **Entrega de guardia** de la tarjeta, una línea por
novedad con su fecha (`13-10-2026: …`): laboratorios nuevos con alteraciones (por ejemplo
"Anemia severa (Hb 6.2), Hiperkalemia severa (K 6.3)"), estudios del visor (con la conclusión del
reporte, o "reporte pendiente") y cultivos (positivo con germen, o sin desarrollo). Cada novedad se
escribe una sola vez aunque la app esté abierta en varios iPads; lo escrito a mano no se toca.

## Cultivos

Los cultivos de WinLab aparecen en **IC · Cultivos** aunque el resultado venga como "POSITIVO",
"NO DESARROLLO" o "NEGATIVO A 5 DÍAS" (antes solo se leía el germen y casi nunca salían).

La tabla de WinLab solo dice "POSITIVO": el germen y el antibiograma están en el PDF del reporte.
Desde el 13 de octubre de 2026 el robot abre ese PDF, guarda su texto completo y extrae germen
(género y especie, con BLEE / carbapenemasa / MRSA si lo dice), UFC y antibiograma. La tarjeta
muestra **S:** sensibles, **I:** intermedios y **R:** resistentes, con el reporte completo
plegable ("📄 Reporte completo"). La entrega de guardia y la nota de evolución dicen a qué es
sensible y resistente. Los cultivos ya capturados antes de esa fecha se vuelven a abrir una vez
en la siguiente pasada del robot. Si un antibiograma no se reconoce, el texto completo sigue
visible en la tarjeta: mándame ese caso (sin nombre) para afinar el lector.

## Nota de evolución

En la tarjeta, **📝 Nota de evolución** genera la nota completa en el formato del servicio (todo en
mayúsculas): encabezado con edad, FN, expediente y cama; década de la vida y diagnósticos unidos con
"+"; subjetivo; signos vitales en texto (oxígeno por puntas nasales o mascarilla, ventilador);
exploración; drenajes y sondas con gasto y características; Foley con uresis; laboratorios del día
con nombres completos y los del control previo (lo que hoy no se tomó más la tendencia de
leucocitos, hemoglobina, creatinina, PCR y procalcitonina); análisis por aparatos y sistemas;
ayuno o dieta, antibiótico y día, NPT, tromboprofilaxis, cultivos, tomografía con conclusión,
interconsultas, plan y pendientes; estado de salud y pronóstico; firma. Lo que la tarjeta no sabe
queda entre corchetes `[…]` para llenarlo antes de pegar.

### 🤖 Nota con IA en un clic (octubre 2026)

En el menú **⋯ Más** de la tarjeta, **🤖 Nota IA (1 clic)** abre la nota y la redacta sola: toma
todo lo de la tarjeta (diagnósticos, pase matutino, drenajes y sondas, cirugías, laboratorios por
fecha, cultivos, estudios, antibiótico, APP/PA, manejo, pendientes, entrega y recibo de guardia), lo
manda al ayudante de IA (el worker de Cloudflare, la misma configuración que "Leer documento con
IA") con el formato exacto del servicio y la instrucción de redactar el análisis y plan con medicina
basada en evidencia: metas numéricas y guías por nombre y año solo cuando aplican (Surviving Sepsis
2021, WSES/SIS, ESPEN 2023, KDIGO, AABB, ADA, ERAS, ARDSNet, Tokyo 2018). Reglas duras: no inventa
datos (lo que falta queda entre corchetes), conserva cifras y fechas tal cual, sin markdown, todo en
mayúsculas; el encabezado y la firma siempre son los de la tarjeta. Mientras la IA responde ya ves
el borrador estructurado; si la IA falla o no hay red, te quedas con ese borrador (aviso amarillo) y
puedes reintentar.

- **✏️ Editar** permite corregir el texto antes de copiarlo.
- **Copiar** copia la nota. **↗ Pasar a la página de notas** la copia y abre la página de notas de
  evolución del hospital para pegarla ahí (Ctrl/Cmd + V). La primera vez pide la dirección de esa
  página; queda en **⚙️ Configuración → Página de notas de evolución** y se comparte a todos los
  dispositivos.
- **🕘 Notas previas**: cada nota generada o copiada se guarda en la tarjeta (las últimas 10) para
  volver a verla.
- **📝 Borrador sin IA** sigue generando la nota estructurada de siempre.

### 💉 Vasopresores y 🫁 ventilador (octubre 2026)

En el checklist de la tarjeta, la fila **⚕️ Clínico** tiene ahora **Peso (kg)** y **Talla (cm)**. El
peso se usa en la calculadora y se precarga en la corrección de electrolitos.

La fila **💉 Vasopresor** calcula la dosis con solo el peso, la dilución y la velocidad:

- **Norepinefrina**: al encenderla propone 4 mg en 250 mL (editable). Con la velocidad en mL/h
  muestra la dosis en mcg/kg/min: `(mg × 1000 ÷ mL) × mL/h ÷ 60 ÷ kg`. En **meta** escribes la
  dosis deseada y te dice a cuántos mL/h ponerla. Más de 0.5 mcg/kg/min se marca en rojo; a partir
  de 0.25 mcg/kg/min sugiere agregar vasopresina (Surviving Sepsis Campaign 2021).
- **Vasopresina**: propone 20 U en 100 mL. Muestra U/min (y U/h): `(U ÷ mL) × mL/h ÷ 60`; la meta
  funciona igual. Más de 0.04 U/min se marca en rojo.

Con **🫁 VM** encendido, además de modo, FiO₂, PEEP, VT, FR y PIP puedes anotar **Pplat**,
**Pmedia** e **I:E**. Con la talla (y el sexo en ✏️ Editar) calcula el peso predicho (Devine) y
muestra **VT en mL/kg** (rojo si > 8) y la **presión de distensión** Pplat − PEEP (rojo si > 15;
Pplat > 30 también se marca).

La nota de evolución escribe todo esto en texto: "TA 110/70 MMHG (PAM 83 MMHG) BAJO APOYO
VASOPRESOR CON NOREPINEFRINA A 0.076 MCG/KG/MIN (4 MG EN 250 ML A 20 ML/H) Y VASOPRESINA A 0.03
U/MIN (20 U EN 100 ML A 9 ML/H)" y "BAJO VENTILACIÓN MECÁNICA INVASIVA (MODO AC, FIO2 40 %, PEEP 8
CMH2O, VOLUMEN TIDAL 420 ML (6.4 ML/KG DE PESO PREDICHO), FR 16 RPM, PIP 24 CMH2O, PRESIÓN MESETA
20 CMH2O, PRESIÓN DE DISTENSIÓN 12 CMH2O, RELACIÓN I:E 1:2)".

## Si un paciente desapareció del censo

1. En la app, abre la pestaña **Papelera**.
2. Pulsa **☁️ Cargar desde nube**. Aparecen los pacientes que salieron del
   censo (por egreso, por el Excel o por la hoja), cada uno con su nota.
3. Pulsa **↩ Restaurar** en el paciente. Vuelve al censo con su nota.

## Si algo sale muy mal con las notas de laboratorio

El 9 de octubre de 2026 se hizo una limpieza de valores erróneos (pH y
hemoglobina de orina guardados como sangre). Antes de tocar nada se guardó una
copia completa en la tabla `notes_lab_history_backup_20261009` de Supabase.
Para volver a como estaba, en Supabase → SQL Editor:

```sql
update notes n set lab_history = b.lab_history
from notes_lab_history_backup_20261009 b where b.patient_id = n.patient_id;
```

## ¿Dónde vive cada cosa en el repositorio?

| Carpeta / archivo | Qué es |
|---|---|
| `index.html` | Toda la app (un solo archivo) |
| `apps-script/censo-sync.gs` | El programa de la hoja del censo (se pega a mano en Google) |
| `rpa/` | El robot de laboratorios (WinLab → Supabase) |
| `.github/workflows/winlab-scraper.yml` | Los horarios y la configuración del robot |
| `.github/workflows/deploy-pages.yml` | Cómo se publica la app en Cloudflare |
| `cloudflare-worker/` | El ayudante de IA (extraer labs de PDF, disparar el robot) |
| `scripts/supabase_rls_current.sql` | La configuración de seguridad vigente de la base de datos |
| `scripts/SECURITY_NOTES.md` | Qué llaves existen y qué hacer si se filtra alguna |
