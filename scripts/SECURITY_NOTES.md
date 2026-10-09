# Notas de seguridad — Piso Libro (estado al 9 de octubre de 2026)

Estado actual: **acceso a datos solo con sesión**. La app inicia sesión con
Supabase Auth (correo + contraseña); el rol público `anon` no puede leer ni
escribir ninguna tabla. Este documento dice qué llaves existen, dónde viven y
qué hacer si alguna se filtra.

## 1. Llaves y dónde viven

| Llave | Dónde está | Riesgo si se filtra |
|---|---|---|
| **anon key** de Supabase | `index.html` (`SUPA_KEY`), `scripts/winlab-*.js` (legado) | Bajo: es pública por diseño y el rol `anon` tiene `REVOKE ALL` en todas las tablas. Sirve solo para iniciar sesión. |
| **service_role key** de Supabase | Secret `SUPABASE_SERVICE_KEY` en GitHub Actions; propiedad `SUPABASE_KEY` del Apps Script | **Alto**: salta RLS. Nunca en el repo, la hoja ni la app. |
| Credenciales de WinLab | Secrets `WINLAB_USER` / `WINLAB_PASS` en GitHub Actions | Alto: acceso al sistema del laboratorio. |
| `WORKER_TOKEN` del Cloudflare Worker | Variable en Cloudflare + "Worker token" en Config de la app | Medio: permite usar el worker (IA, disparar el scraper). |
| `ANTHROPIC_API_KEY` | Secret en Cloudflare | Medio: costo de API. |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Secrets en GitHub Actions | Medio: permite publicar la app. |

## 2. Modelo de acceso en Supabase

- RLS habilitado en todas las tablas; policy `authenticated_all` (lectura y
  escritura) para el rol `authenticated`; `sync_log` solo lectura.
- `anon`: sin privilegios (`REVOKE ALL`). Una petición REST con solo la anon
  key responde 401.
- `winlab_labs` tiene además policy para `service_role` (el scraper).
- Referencia y re-aplicación idempotente: `scripts/supabase_rls_current.sql`.
- Los scripts anteriores (`supabase_rls_permissive.sql`,
  `supabase_rls_restrictive.sql`) daban acceso total a `anon` y se retiraron.
  **No volver a aplicarlos.**

## 3. Usuarios

- Se administran desde la app (Config → Usuarios) o en Supabase →
  Authentication → Users. Para dar de baja a alguien: borrar su usuario ahí;
  su sesión deja de funcionar en cuanto expira el token (≤ 1 h) y al recargar.
- Cambio de contraseña: la app cierra sesión solo en el dispositivo actual
  (`signOut({ scope: "local" })`); las demás sesiones siguen hasta que expiren.

## 4. Qué hacer si se filtra algo

### service_role key
1. Supabase → Project Settings → API → **Reset** `service_role`.
2. GitHub → Settings → Secrets → Actions → actualizar `SUPABASE_SERVICE_KEY`.
3. Hoja del censo → Extensiones → Apps Script → ⚙ Configuración →
   Propiedades → actualizar `SUPABASE_KEY`.
4. Lanzar una corrida del scraper y un `doSync` del Apps Script para comprobar.

### anon key
1. Supabase → Project Settings → API → Reset `anon`.
2. Reemplazar `SUPA_KEY` en `index.html` (y en `scripts/winlab-*.js` si se
   siguen usando) → commit → el deploy es automático.

### WinLab
1. Cambiar la contraseña en WinLab.
2. GitHub → Secrets → actualizar `WINLAB_PASS`.

### Cloudflare Worker
1. Cloudflare → Workers → `piso-libro-ai` → Settings → Variables → rotar
   `WORKER_TOKEN`; actualizar en la app (Config → Worker token).

## 5. Scripts de navegador (legado)

`scripts/winlab-bookmarklet.js` y `scripts/winlab-tampermonkey.user.js`
leían el censo de Supabase con la anon key. Desde que `anon` no tiene
permisos, **ya no pueden cargar el censo** y están marcados como obsoletos.
El robot de laboratorios (`rpa/`, 3 corridas al día) y el botón "Labs" de la
app (clic derecho = disparar corrida) cubren ese flujo. Si se quisiera
revivirlos, la app tendría que generar el bookmarklet con el censo embebido.

## 6. Datos de pacientes

Los datos clínicos están en Supabase (región del proyecto) y en el
`localStorage` de cada dispositivo que usa la app. Al dar de baja un
dispositivo, cerrar sesión en la app borra la sesión; el `localStorage` se
limpia desde Config → "Borrar datos locales" o borrando los datos del sitio en
el navegador.
