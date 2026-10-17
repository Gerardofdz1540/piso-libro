# Sync Censo: Google Sheet → Supabase → PisoLibro

Al editar tu censo en Google Sheets, la app se actualiza sola:

```
Editas la hoja → Apps Script (onEdit + cada 5 min) → UPSERT a Supabase (solo censales)
              → Realtime (canal patients-changes) → la app re-renderiza sola
```

- **Código:** `apps-script/censo-sync.gs`
- **Hoja:** `1ChvdR-DZ8K5Bhl0MYmwW7mLbWioNlc-T`, pestaña gid `14179734`
- **Tabla destino:** `public.patients` (UPSERT por `cama`)

## Regla de oro (lo que NUNCA toca)

El script **solo** escribe columnas censales: `cama, nombre, exp, edad, dx, esp, adscrito,
residente, ingreso, dias, estado, seccion, es_mio`. **Jamás** edita la tabla `notes` ni columnas
clínicas. El UPSERT es `ON CONFLICT (cama) DO UPDATE` de solo esas columnas → el `id` de la fila
no cambia, así que las notas clínicas siguen ligadas e intactas (verificado contra la BD real).

## Reconciliación (Supabase refleja la hoja) — sin perder notas

En cada corrida el script compara la hoja con `patients` y:

- **Cambio de cama (mismo expediente, otra cama):** hace **PATCH** de la cama sobre la misma fila
  (el `id` no cambia → la nota clínica viaja con el paciente). Los intercambios A↔B pasan por una
  cama temporal `#MV-…` durante un segundo para no chocar con `UNIQUE(cama)`.
- **Expediente corregido (misma cama, misma persona, otro número):** hace **PATCH** del
  expediente sobre la misma fila; la nota no se toca.
- **Cama cambiada desde la app (16 oct 2026): la cama que fijó el residente se respeta hasta que
  la hoja la cambie.** Al mover a un paciente desde la app (Editar / cambiar cama) la fila queda con
  `cama_app_ts`. Si la hoja sigue mostrando al mismo expediente en la cama vieja, el script **no lo
  regresa**: la primera vez anota en `cama_hoja_prev` la cama que dice la hoja y, mientras la hoja no
  cambie, deja fuera del upsert esa fila (si no, `ON CONFLICT (cama)` lo duplicaba en la cama vieja).
  Si la hoja ya coincide con la app, limpia las dos columnas; si alguien cambia la cama **en la hoja
  después** del movimiento (`cama_hoja_prev` ≠ cama de la hoja), vuelve a mandar la hoja (PATCH de
  cama + limpieza). Si la hoja pone a **otra persona** en la cama que la app fijó, esa fila no se
  upsertea ni se mueve a nadie ahí (quedaría la nota bajo otro nombre); se loguea y se espera.
  Requiere las columnas `patients.cama_app_ts timestamptz` y `patients.cama_hoja_prev text`
  **antes** de desplegar este script (sin ellas el GET falla y el script cae a "solo upsert").
- **Retiro (ya no está en la hoja): periodo de gracia de 12 minutos.** El trigger `onEdit`
  sincroniza en cada tecla; al cortar y pegar una fila (cambio de cama) o reescribir un expediente
  la hoja pasa por un instante en el que el paciente "no está". Antes eso bastaba para archivarlo y
  borrarlo (con su nota) y el pegado lo recreaba vacío. Ahora solo se retira cuando lleva ≥ 12 min
  seguidos fuera de la hoja (Script Property `PL_MISSING_SINCE`). Un egreso real sale del tablero
  unos minutos más tarde; un corte/pegado se resuelve como **cambio de cama** (PATCH).
- Además, en Supabase hay una red de seguridad: si un paciente con el mismo expediente y nombre
  vuelve a insertarse en ≤ 10 días de haber sido archivado, el trigger
  `patients_restore_note_after_insert` restaura su nota (labs, pendientes, checklist) desde
  `public.archive` sin pisar lo que ya tenga (ver `scripts/supabase_restore_note.sql`).
- **Reasignación (misma cama, otra persona)** y **retiro (ya no está en la hoja)**: primero
  **archiva** paciente + nota en `public.archive` (la Papelera de la app, restaurable desde
  "Cargar desde nube") con `archived_by = sheet-sync` y la etiqueta de egreso en la nota; **solo
  si el archivo tuvo éxito** borra la nota y la fila. Si falla, la fila se queda y se reintenta en
  la siguiente corrida.
- **Guardas:** si la hoja parsea < 10 pacientes o habría que borrar > 50 % del censo, no borra ni
  mueve nada (solo upsert). Solo retira filas que el propio sync creó (`updated_by = sheet-sync`);
  los pacientes agregados a mano en la app no se tocan.

## Watchdog de laboratorios

`checkLabsFreshness()` corre cada 4 h (trigger). Si el último `winlab_labs.scraped_at` tiene más de
26 h, manda un correo (máximo uno cada 6 h) al dueño del script, o a la propiedad `ALERT_EMAIL` si
la defines, con el enlace al workflow de GitHub y los pasos para reactivarlo. También deja una fila
`labs_stale_…` en `sync_log`.

## Indicaciones automáticas (Google Doc → cada tarjeta)

> Desde el 12 oct 2026 el camino principal es **pg_cron + pg_net en Supabase**
> (`scripts/supabase_indicaciones_doc.sql`): la base descarga el Doc cada 5 min por su enlace de
> exportación. Lo de abajo es el **respaldo** por si el Doc deja de estar compartido por enlace.

`syncIndicaciones()` corre cada 5 min (trigger `syncIndicacionesScheduled`). Mira la fecha de
modificación del Doc `INDICACIONES_DOC_ID` en Drive; si cambió desde la última subida, lee **todo**
el texto del Doc y lo guarda en `public.indicaciones_doc` (una sola fila, `id = 1`, con `text`,
`text_hash`, `doc_updated`). La app:

- baja esa fila al arrancar, la recibe por Realtime cuando cambia y la vuelve a pedir cada 10 min;
- parsea los bloques (`INDICACIONES MÉDICAS DE …`, línea `NOMBRE · AÑOS | CAMA 3-150`, fecha,
  secciones DIETA / SOLUCIONES / MEDICAMENTOS / ANTIBIÓTICOS / MEDIDAS GENERALES);
- cruza cada paciente por **cama + nombre** (si cambió de cama, por nombre); con varias fechas del
  mismo paciente gana la más reciente;
- si en el Doc la cama tiene indicaciones a **otro nombre** (paciente anterior), muestra un aviso
  rojo y no las presenta como propias.

Funciones útiles en el editor: `syncIndicacionesForce` (sube ahora aunque no haya cambios) y
`testIndicacionesOnly` (solo cuenta bloques, sin escribir). Al ejecutar `createTriggers` Google
pedirá permisos nuevos (Drive y Documentos) porque el script ahora lee el Doc.

## Expedientes repetidos

- **Mismo exp en 2+ camas, misma persona:** conserva solo la cama de **UCI/UTI**, descarta piso.
- **Mismo exp con nombres distintos** (error de captura): **se sincronizan todos** (17 oct 2026) y
  queda un aviso `exp_repetido_sincronizado` en `public.sync_log` para corregir la hoja. Antes se
  ponían en cuarentena: no entraba ninguno y el que ya estaba en la app se retiraba a los 12 min.
  Mientras el exp sea **ambiguo** (2+ personas con ese número en la hoja **o en Supabase**: basta con
  que Supabase aún tenga a las dos aunque la hoja ya muestre una sola, p. ej. tras dar de alta a una o
  corregirle el exp), la reconciliación distingue a esas personas por **nombre**: solo mueve a alguien
  a la cama donde la hoja tiene su nombre, y si en su cama ahora está la otra persona con el mismo exp
  lo trata como cama reasignada (archivo + fila nueva) en vez de ponerle a su fila, con su nota, el
  nombre del otro. Un nombre **corregido** en la hoja (una letra, `HDZ` → `HERNANDEZ`) sigue siendo la
  misma persona si no es el nombre de la otra. Un nombre incompleto (solo apellidos) que encaja con
  dos personas distintas entra como paciente aparte en vez de juntarlas.
- **Movimiento de cama que falla** (PATCH rechazado): la cama de origen y la de destino quedan fuera
  del upsert de esa corrida, para que la fila que no se movió no reciba el nombre del siguiente
  ocupante.
- **Secciones administrativas que ignora por completo:** ALTAS, DEFUNCIONES, PROCEDIMIENTOS,
  INGRESOS, MOVIMIENTOS DE CAMAS, TPN.
- **Salas de otros servicios (GINECOLOGÍA, ONCOLOGÍA, HEMATOLOGÍA):** se ignoran *sus* pacientes,
  pero un paciente **nuestro** (especialidad quirúrgica: CG y demás cirugías, NCX, URO…) hospedado
  ahí **sí** se capta, con su sección. Así una embarazada de cirugía general en cama de gine (p. ej.
  2-092) aparece en el tablero. Un paciente del propio servicio (GO/GINE, ONC, HEM) o sin
  especialidad no entra. (`isSurgicalService_`; antes la sección entera se descartaba.)

## Instalación (1 sola vez, ~2 min)

1. Abre tu Google Sheet del censo.
2. Menú **Extensiones → Apps Script**.
3. Borra lo que haya en `Código.gs` y pega **todo** el contenido de `censo-sync.gs`. Guarda (💾).
4. Engrane **⚙ Configuración del proyecto** (barra izquierda) → baja a **Propiedades de la secuencia
   de comandos** → **Agregar propiedad de la secuencia de comandos**:
   - Propiedad: `SUPABASE_KEY`
   - Valor: tu **service_role key** de Supabase (Dashboard → Project Settings → API → `service_role`).
   - **Guardar propiedades de la secuencia de comandos.**
5. Vuelve al editor (**< >**). En el selector de función (arriba) elige **`createTriggers`** y pica
   **▶ Ejecutar**.
6. Sale una ventana de permisos de Google → **Revisar permisos** → elige tu cuenta → **Permitir**.

Listo: quedan 4 triggers: `onEdit` (instalable), sync cada 5 min, watchdog de labs cada 4 h e
indicaciones (Doc) cada 5 min. `createTriggers` también hace la primera subida del Doc.

## Actualizar el script (cada vez que cambie `censo-sync.gs` en el repo)

1. **Extensiones → Apps Script**, reemplaza TODO el contenido de `Código.gs` por el nuevo
   `censo-sync.gs` y guarda.
2. Vuelve a ejecutar **`createTriggers`** (borra y recrea los triggers; sin esto el watchdog de
   labs no existe).
3. Opcional: ejecuta **`checkLabsFreshness`** a mano y revisa **Ver → Registros** para confirmar la
   fecha del último scrape.

## Probar sin escribir nada

En el selector de función elige **`testParseOnly`** → **▶ Ejecutar** → menú **Ver → Registros**:
verás cuántos pacientes parseó y qué expedientes repetidos hay, sin tocar Supabase.

Pruebas offline de la reconciliación (sin Google ni Supabase, con stubs):

```
node apps-script/censo-sync.test.js
```

## Notas

- La **service_role key** vive solo en Script Properties (nunca en la hoja ni en el repo). El
  script bypassa RLS para escribir; la app pública sigue protegida por RLS (anon ciego).
- `sync_log` recibe cada aviso de expediente repetido/duplicado **una vez cada 6 h** (antes se repetía en cada corrida
  de 5 min y la tabla pasó de 29 000 filas).
