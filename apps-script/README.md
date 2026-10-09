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
residente, ingreso, dias, estado, seccion, es_mio`. **Jamás** toca la tabla `notes` ni columnas
clínicas. El UPSERT es `ON CONFLICT (cama) DO UPDATE` de solo esas columnas → el `id` de la fila
no cambia, así que las notas clínicas siguen ligadas e intactas (verificado contra la BD real).

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

Listo: queda un trigger `onEdit` (instalable) + un respaldo cada 5 min.

## Probar sin escribir nada

En el selector de función elige **`testParseOnly`** → **▶ Ejecutar** → menú **Ver → Registros**:
verás cuántos pacientes parseó y cuántos quedaron en cuarentena, sin tocar Supabase.

## Notas

- La **service_role key** vive solo en Script Properties (nunca en la hoja ni en el repo). El
  script bypassa RLS para escribir; la app pública sigue protegida por RLS (anon ciego).
- El sync es **update-only**: si quitas un paciente de la hoja, no se borra en la app (eso se hace
  con el alta/egreso dentro de la app). Nunca hace DELETE ni REPLACE.
