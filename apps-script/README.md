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

## Dedup y cuarentena

- **Mismo exp en 2+ camas, misma persona:** conserva solo la cama de **UCI/UTI**, descarta piso.
- **Mismo exp con nombres distintos** (error de captura): **no sincroniza ninguna** y lo registra
  en la tabla `public.sync_log` (exp, camas, nombres, motivo).
- **Secciones que ignora:** ALTAS, DEFUNCIONES, PROCEDIMIENTOS, INGRESOS, MOVIMIENTOS DE CAMAS,
  TPN, ONCOLOGÍA/HEMATOLOGÍA/GINECOLOGÍA.

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
verás cuántos pacientes parseó y cuántos quedaron en cuarentena, sin tocar Supabase.

Pruebas offline de la reconciliación (sin Google ni Supabase, con stubs):

```
node apps-script/censo-sync.test.js
```

## Notas

- La **service_role key** vive solo en Script Properties (nunca en la hoja ni en el repo). El
  script bypassa RLS para escribir; la app pública sigue protegida por RLS (anon ciego).
- `sync_log` recibe cada cuarentena/duplicado **una vez cada 6 h** (antes se repetía en cada corrida
  de 5 min y la tabla pasó de 29 000 filas).
