# Notas de seguridad — Piso Libro (estado al 19 de octubre de 2026)

Estado actual: **acceso a datos solo con sesión**. La app inicia sesión con
Supabase Auth (correo + contraseña); el rol público `anon` no puede leer ni
escribir ninguna tabla. Este documento dice qué llaves existen, dónde vive cada
una, cuál caduca y qué hacer si alguna se filtra. La versión "para residentes"
(tabla de vencimientos, cuentas de los robots, altas y bajas) está en
`MANUAL-OPERACION.md`.

Los nombres de abajo son los que usan `cloudflare-worker/index.js`, los
workflows de `.github/workflows/` y `apps-script/censo-sync.gs`. Si alguna vez
no coinciden, manda este archivo, no el código.

## 1. Llaves: dónde vive cada una, quién la crea, dónde se usa y cómo cambiarla

Hay cinco "cajones" de llaves. Cada llave vive en uno solo (salvo las copias
que se indican):

- **Worker** `piso-libro-ai`: Cloudflare → Workers & Pages → `piso-libro-ai` →
  Settings → Variables and Secrets (cifradas). Después de editar hay que
  pulsar **Deploy**.
- **GitHub**: repo `piso-libro` → Settings → Secrets and variables → Actions.
- **Supabase**: Project Settings → API (llaves del proyecto), Table Editor →
  `rpa_config` y `config` (ajustes que leen los robots y la base), Project
  Settings → Authentication → SMTP Settings (correo).
- **Apps Script** de la hoja del censo: Extensiones → Apps Script → ⚙
  Configuración del proyecto → Propiedades del script.
- **Google** (cuenta del administrador): AI Studio y contraseñas de aplicación.

| Llave | Quién la crea / dónde vive | Dónde se usa | ¿Caduca? | Cómo cambiarla (todo el mismo día) |
|---|---|---|---|---|
| `ACCESS_TOKEN` | Texto que elige el admin. Vive en el **worker**. Copias: en la app (⚙️ Config → desplegar «🔧 Worker proxy (legacy / avanzado)» → 🔑 Token de Acceso; el campo está oculto hasta desplegar esa sección) y en la tabla `config` de Supabase, fila `worker_config` (la app la sube ahí para compartirla a todos los dispositivos). | Toda llamada al worker: IA (nota, labs de PDF/foto, lápiz → texto) y disparar el robot (🔎 Buscar ahora, clic derecho en Labs). `winlab_dispatch_scrape()` (pg_cron) la lee de `config.worker_config` y la manda como `X-Piso-Token`. | No. | 1) Cloudflare → editar `ACCESS_TOKEN` → Deploy. 2) En la app, ⚙️ Config → desplegar «🔧 Worker proxy (legacy / avanzado)» → 🔑 Token de Acceso → Guardar (eso actualiza `config.worker_config`; pg_cron la toma en el siguiente disparo). 3) Probar: 🤖 Nota IA en una tarjeta y, en el SQL Editor, `select public.winlab_dispatch_scrape('manual');` → en `winlab_dispatch_log` debe aparecer `status_code = 200` a los 15 min. |
| `GEMINI_API_KEY` | Google AI Studio (cuenta de Google del admin) → API keys. Vive en el **worker**. | Solo el worker (`/api/ai`, `/api/labs/extract`). | No por fecha. Lo que sí puede caducar es el **modelo** fijado en el código (`GEMINI_MODEL`): si Google lo retira, la IA deja de responder aunque la llave sirva. | 1) AI Studio → crear llave nueva. 2) Cloudflare → `GEMINI_API_KEY` → Deploy. 3) Probar 🤖 Nota IA. 4) Borrar la llave vieja en AI Studio. |
| `GITHUB_TOKEN` (del worker) | Token personal de GitHub del admin: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained** → repo `piso-libro`, permiso **Actions: Read and write**, nada más. Vive en el **worker**. No confundir con el `github.token` automático de los workflows (ese no se administra). | `/api/scrape`: lanza `winlab-scraper.yml` cuando la app o pg_cron lo piden (3 corridas al día a la hora exacta, 🔎 Buscar ahora, clic derecho en Labs). | **Sí**: en la fecha elegida al crearlo (GitHub propone 30 días). Vencido, el worker responde 502 `dispatch_failed`, queda anotado en `winlab_dispatch_log` y el robot solo corre con el respaldo de GitHub (10:37 León + retraso de 3-9 h). | 1) Generar token nuevo con el mismo alcance y **anotar la fecha de vencimiento** en la tabla del manual. 2) Cloudflare → `GITHUB_TOKEN` → Deploy. 3) Probar con 🔎 Buscar ahora o `select public.winlab_dispatch_scrape('manual');`. 4) Revocar el viejo. |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → permiso "Cloudflare Pages: Edit". Vive en **GitHub**. | `deploy-pages.yml`: publicar la app tras pasar las pruebas. | Solo si al crearlo se le puso fecha (TTL). Si no, no. | 1) Crear token nuevo. 2) GitHub → secret `CLOUDFLARE_API_TOKEN`. 3) Actions → "Deploy a Cloudflare Pages" → Run workflow. 4) Revocar el viejo. |
| `CLOUDFLARE_ACCOUNT_ID` | Identificador de la cuenta (Cloudflare → Workers & Pages, columna derecha). Vive en **GitHub**. | `deploy-pages.yml`. | No; no es secreto, solo un identificador. No se rota. | — |
| **service_role key** de Supabase | Supabase → Project Settings → API. Copias: secret `SUPABASE_SERVICE_KEY` en **GitHub** y propiedad `SUPABASE_KEY` en **Apps Script**. La Edge Function `admin-users` la recibe inyectada por Supabase (`SUPABASE_SERVICE_ROLE_KEY`): no hay copia que mantener. | Robots (`winlab-scraper.yml`, `winlab-dryrun.yml`, `ris-scraper.yml`), vigilante (`labs-watchdog.yml`), hoja del censo (`doSync`, `syncIndicaciones`), 👥 Usuarios. **Salta RLS**: nunca en el repo, la hoja ni la app. | No. | 1) Supabase → API → **Reset** `service_role`. 2) GitHub → `SUPABASE_SERVICE_KEY`. 3) Apps Script → propiedad `SUPABASE_KEY`. 4) Probar: Actions → "WinLab corrida en seco" → Run workflow; "Vigilante de laboratorios" → Run workflow; en Apps Script ejecutar `doSync`. |
| **anon key** de Supabase | Supabase → Project Settings → API. Vive en `index.html` (`SUPA_KEY`). | Iniciar sesión. El rol `anon` tiene `REVOKE ALL`: sin sesión no lee nada. | No (es pública por diseño). | Reset en Supabase → reemplazar `SUPA_KEY` en `index.html` → PR a `main` → la publicación es automática (corre las pruebas antes). |
| `WINLAB_USER` / `WINLAB_PASS` | Cuenta de WinLab de **una persona** (el manual tiene el campo para anotar de quién). Viven en **GitHub**. Los demás secrets `WINLAB_*` y `WL_*` (URL, selectores, perfil, días) son configuración, no contraseñas. | `winlab-scraper.yml` (robot de labs) y `winlab-dryrun.yml` (corrida en seco del domingo). | Según la política del hospital (anotar la fecha en el manual). | 1) Cambiar la contraseña en WinLab. 2) GitHub → `WINLAB_PASS`. 3) Actions → "WinLab corrida en seco" → Run workflow (no escribe nada; si entra, listo). |
| `RIS_USER` / `RIS_PASS` (+ `RIS_URL`) | Cuenta del visor radiológico de **una persona**. Viven en **Supabase**, tabla `rpa_config` (filas `key` / `value`). | `ris-scraper.yml` → `rpa/ris-scraper.js`, cada 2 h. | Según la política del hospital. | 1) Cambiar la contraseña en el RIS. 2) Supabase → Table Editor → `rpa_config` → fila `RIS_PASS` → `value`. 3) Actions → "RIS Imagen" → Run workflow con `dry_run` marcado. |
| `SUPABASE_DB_URL` | URI del **Session pooler** con la contraseña de la base (Supabase → Connect → Session pooler; Project Settings → Database → Database password). Vive en **GitHub**. | `db-backup.yml`: `pg_dump` nocturno. Da acceso TOTAL a la base: nunca en el repo ni en la app. | No por fecha; se invalida al hacer *Reset database password*. | 1) Supabase → Reset database password. 2) GitHub → `SUPABASE_DB_URL` con la URI nueva. 3) Actions → "Respaldo de la base" → Run workflow. |
| `BACKUP_AGE_PUBLIC_KEY` (+ llave privada) | Par generado con `age-keygen` en la Mac del admin. La **pública** (`age1…`) vive en **GitHub**; la **privada** (`AGE-SECRET-KEY-…`) solo con el admin, fuera de GitHub (USB + nota segura). | `db-backup.yml`: cifra el respaldo. Solo la privada lo abre (`scripts/db-restore.md`). | No. Si se pierde la privada, los respaldos existentes quedan ilegibles. | 1) `age-keygen` nuevo. 2) GitHub → `BACKUP_AGE_PUBLIC_KEY`. 3) Run workflow y comprobar que la privada nueva abre el artifact. Guardar la privada vieja hasta que caduquen los artifacts (30 días). |
| `RCLONE_CONFIG` / `BACKUP_GDRIVE_DIR` (opcionales) | `rclone config` en la Mac (remoto `gdrive`, scope `drive.file`); el contenido de `rclone.conf` vive en **GitHub**. | `db-backup.yml`: copia del respaldo a Drive. Si falta, el paso se omite. | El token de Google se renueva solo; se invalida si se revoca el acceso de rclone en la cuenta. | Repetir `rclone config` y pegar el `rclone.conf` nuevo en el secret. |
| Contraseña de aplicación de Gmail | Google (cuenta del admin) → Seguridad → Verificación en 2 pasos → Contraseñas de aplicaciones → "Piso Libro". Vive en **Supabase** → Project Settings → Authentication → SMTP Settings (Password). | Correo de "¿Olvidaste tu contraseña?" y 📧 Correo de 👥 Usuarios. | **Google la anula** al cambiar la contraseña de la cuenta de Google o al apagar la verificación en 2 pasos. | 1) Google → revocar la vieja y crear una nueva. 2) Supabase → SMTP Settings → Password → Save. 3) Probar "¿Olvidaste tu contraseña?" con tu propio correo. Los caminos 🔗 Enlace y 🔑 Contraseña temporal no dependen de esto. |

Otros secrets de GitHub que **no son llaves** (configuración, sin riesgo si se
ven): `SUPABASE_URL`, `SUPABASE_TABLE`, `SUPABASE_ON_CONFLICT`, `WINLAB_URL`,
`WINLAB_RESULTS_URL`, `WINLAB_*_SELECTOR`, `WL_TEMPORALIDAD_TAB_SEL`,
`WL_PROFILO_SEL`, `WL_PROFILO_VALUE`, `WL_LOOKBACK_DAYS`.

Cosas que se apagan solas aunque ninguna llave caduque:

- GitHub desactiva los cron tras **60 días sin actividad** en el repo
  (`disabled_inactivity`). Los robots (`winlab-scraper.yml`,
  `winlab-dryrun.yml`, `ris-scraper.yml`), el vigilante (`labs-watchdog.yml`),
  el respaldo (`db-backup.yml`) y `keepalive.yml` llaman en cada corrida al endpoint "enable" de su propio
  workflow: eso cuenta como actividad y reinicia el contador. Si aun así uno
  aparece como "This scheduled workflow is disabled", pulsar **Enable
  workflow** (ver manual, "Si los laboratorios no llegan").
- Supabase (plan gratuito) pausa el proyecto tras **7 días sin tráfico**. Lo
  que de verdad lo evita es el tráfico diario de los robots (labs 3 veces al
  día, RIS cada 2 h, vigilante cada 6 h); `keepalive.yml` (ping a
  `/auth/v1/health` cada 3 días) es solo el respaldo por si todos se detienen.
- El Doc de indicaciones se baja por su **enlace público** ("cualquiera con el
  enlace"): si alguien lo restringe, la base deja de recibirlo y hay que usar
  `syncIndicaciones` del Apps Script (ver manual).

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

## 3. Usuarios (modelo de octubre de 2026)

- Tabla `public.app_users` (id = auth.users.id, nombre, `role` admin/usuario,
  `status` active/blocked, `last_seen_at`). Funciones `pl_is_admin()` /
  `pl_is_active()` (security definer). Política **restrictiva**
  `pl_solo_cuentas_activas` en todas las tablas de datos y en
  `storage.objects`: una cuenta bloqueada o sin registro no lee ni escribe nada
  aunque tenga sesión. `service_role` no pasa por RLS (robot, hoja del censo,
  Edge Function).
- Altas, bloqueos, roles y contraseñas: **👥 Usuarios** en la app → Edge
  Function `admin-users` (verifica el JWT, exige role=admin activo, usa la
  service_role key que Supabase inyecta en la función). Bloquear también pone
  `ban_duration` en Auth; borrar quita la cuenta pero conserva su actividad.
- Registro de actividad: `public.audit_log` (solo lo lee el admin) con
  disparador `pl_audit()` en patients, notes, no_olvidar, procedimientos_dia,
  guard_info y config: uid/correo del JWT, cabeceras `X-PL-Device` /
  `X-PL-User` que manda la app, IP (`cf-connecting-ip`) y user-agent, campos
  cambiados y "de → a". Retención 180 días (cron `audit-log-purge`).
- Contraseñas: mínimo 12 caracteres (política del proyecto). Recuperación por
  correo (`resetPasswordForEmail`, requiere SMTP propio), enlace generado por
  el admin (`generateLink` recovery, 1 h) o contraseña temporal.
- Si el administrador se queda fuera: `update public.app_users set role='admin',
  status='active' where email='…';` en el SQL Editor.
- Accesos que **no** dependen de `app_users` y hay que quitar aparte cuando
  alguien se va: edición de la hoja del censo y del Doc de indicaciones
  (Compartir en Google), el `ACCESS_TOKEN` (lo tiene guardado cualquier
  dispositivo que haya abierto la app: `localStorage` y `config.worker_config`;
  en pantalla el campo va enmascarado, pero ahí está en claro) y la copia local
  de pacientes en sus equipos (sección 6). La lista completa está en el manual
  ("Cuando alguien se va del servicio").

## 4. Qué hacer si se filtra algo

Regla general: primero **anular** la llave en el lugar donde nació, luego poner
la nueva en todas sus copias (tabla de la sección 1) y por último probar. No
esperes a "ver si pasa algo".

### `GITHUB_TOKEN` del worker
Quien lo tenga puede lanzar y cancelar corridas del robot y bajar los
artefactos de las corridas fallidas (capturas de pantalla de WinLab).
1. GitHub → Settings → Developer settings → Personal access tokens →
   **Delete** el token (anula al instante).
2. Actions → "WinLab Scraper": cancela cualquier corrida que nadie pidió y
   borra los artefactos `failure-screenshot` que queden.
3. Generar uno nuevo (mismo alcance: solo `piso-libro`, solo Actions) →
   Cloudflare → `GITHUB_TOKEN` → Deploy → probar con 🔎 Buscar ahora.
4. Si el token salió del worker (y no de tu equipo), rota también
   `ACCESS_TOKEN` y `GEMINI_API_KEY`: estaban en el mismo lugar.

### `ACCESS_TOKEN`
Quien lo tenga puede gastar IA y disparar el robot (no puede leer pacientes).
1. Cloudflare → nuevo valor → Deploy. 2) App → ⚙️ Config → desplegar
   «🔧 Worker proxy (legacy / avanzado)» → 🔑 Token de Acceso → Guardar el
   nuevo (actualiza `config.worker_config`). 3) Probar 🤖 Nota IA y un disparo
   manual (`select public.winlab_dispatch_scrape('manual');`).

### `GEMINI_API_KEY`
1. AI Studio → borrar la llave (anula al instante) → crear otra.
2. Cloudflare → `GEMINI_API_KEY` → Deploy → probar 🤖 Nota IA.
3. Revisar el uso/costo del proyecto en AI Studio por si hubo consumo ajeno.

### service_role key
1. Supabase → Project Settings → API → **Reset** `service_role` (anula al
   instante; hasta que repongas las copias, robots y hoja fallan).
2. GitHub → `SUPABASE_SERVICE_KEY`. 3) Apps Script → `SUPABASE_KEY`.
4. Probar: "WinLab corrida en seco", "Vigilante de laboratorios" y `doSync`.
5. Revisar `audit_log` (pestaña Actividad) y Supabase → Logs por accesos que
   no sean el robot ni la hoja.

### anon key
1. Supabase → API → Reset `anon`.
2. Reemplazar `SUPA_KEY` en `index.html` → PR → publicación automática.
   Riesgo bajo: sin sesión no abre nada.

### WinLab (`WINLAB_PASS`) o RIS (`RIS_PASS`)
1. Cambiar la contraseña en el sistema del hospital y avisar a Informática
   (es la cuenta de una persona; ver "Cuentas que usan los robots" en el
   manual).
2. WinLab: GitHub → `WINLAB_PASS`. RIS: Supabase → `rpa_config` → `RIS_PASS`.
3. Probar: "WinLab corrida en seco" / "RIS Imagen" con `dry_run`.

### `CLOUDFLARE_API_TOKEN`
Quien lo tenga puede publicar otra app en la dirección de todos.
1. Cloudflare → API Tokens → **Roll** o borrar el token.
2. Cloudflare → Workers & Pages → `pisolibro` → Deployments: si hay una
   publicación que nadie hizo, **Rollback** a la anterior (pasos en el manual).
3. Token nuevo → GitHub → `CLOUDFLARE_API_TOKEN` → Run workflow de
   "Deploy a Cloudflare Pages".

### Contraseña de aplicación de Gmail
Quien la tenga puede mandar correo como la cuenta del admin.
1. Google → Contraseñas de aplicaciones → revocar → crear otra.
2. Supabase → SMTP Settings → Password → Save → probar "¿Olvidaste tu
   contraseña?".

## 5. Marcador de WinLab (respaldo manual del robot)

Los archivos `scripts/winlab-bookmarklet.js` y
`scripts/winlab-tampermonkey.user.js` **se borraron**: leían el censo de
Supabase con la anon key (ya sin permisos) y llevaban el ID del proyecto y la
llave dentro del código. El trabajo diario lo hace el robot (`rpa/`, 3 corridas
al día) y el botón 🔎 Buscar ahora.

Como **respaldo manual** (el día que el robot no pueda entrar a WinLab), la app
genera el marcador desde ⚙️ Config **con el censo embebido**: no lleva ninguna
llave ni consulta Supabase; solo marca en la lista de reportes de WinLab a los
pacientes del censo de ese momento para imprimir el PDF y subirlo con
📦 Labs Masivo. Dos cuidados, porque el marcador contiene nombres de
pacientes:

- Generarlo cada día que se use (el censo cambia) desde una sesión propia.
- Usarlo en una PC del hospital y **borrarlo de la barra de marcadores al
  terminar**; nunca dejarlo en una PC compartida ni mandarlo por WhatsApp.

Pasos del día completos en el manual ("Si el robot no puede entrar").

## 6. Datos de pacientes

Los datos clínicos están en Supabase (región del proyecto) y en el
`localStorage` de cada dispositivo que usa la app (copia para trabajar sin
red). **🚪 Salir** cierra la sesión pero **no borra esa copia**. Para dar de
baja un dispositivo (o cuando alguien deja el servicio): cerrar sesión y
borrar los datos del sitio en el navegador (iPad/iPhone: Ajustes → Safari →
Avanzado → Datos de sitios web → `pisolibro.pages.dev` → Eliminar; Android:
Chrome → ⋮ → Configuración → Configuración de sitios → Datos del sitio) y, si
la app está instalada en la pantalla de inicio, quitar el icono. Las fotos y
los PDF de labs viven en buckets privados de Storage (`pl-fotos`,
`lab-sources`) y solo se sirven con enlace firmado a cuentas activas.
