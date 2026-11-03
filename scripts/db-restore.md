# Restaurar la base desde el respaldo nocturno

El workflow `.github/workflows/db-backup.yml` deja cada noche (02:20 León) un archivo
`pisolibro-db-<tipo>-AAAAMMDD-HHMM.dump.age` como artifact del repo (30 días) y, si está configurado,
en una carpeta privada de Google Drive. Desde el 2 de noviembre de 2026 hay **dos tipos** (para no
pasar la transferencia del plan gratuito de Supabase, 5 GB al mes):

- **`base`** (lunes a sábado): todo el esquema y todos los datos, **menos las filas** de
  `winlab_labs` (copias del robot de WinLab), `audit_log` (bitácora de actividad) y `respaldo_hora`
  (copias de cada hora de las notas). Las tablas sí van, vacías. Pesa ~15 MB en claro.
- **`completo`** (domingos, o a mano: Actions → Respaldo de la base → *Run workflow* → marcar
  «completo»): también las filas de esas tres tablas. Pesa ~210 MB en claro.

Para restaurar se usan **los dos**: el `base` más reciente (pacientes, notas, archivo… al día) y,
encima, las filas de las tres tablas grandes del `completo` más reciente (paso 4b). Lo que el robot
de WinLab haya traído entre ese domingo y el desastre no se pierde en la práctica: los labs ya están
copiados en la nota de cada paciente (`notes.lab_history`), que va en el `base` de cada noche. Es un `pg_dump` del esquema `public` en formato custom,
cifrado con [age](https://age-encryption.org) para la llave pública del administrador. Solo
quien tenga la **llave privada** (`AGE-SECRET-KEY-…`, generada con `age-keygen`, guardada fuera
de GitHub) puede abrirlo. Dónde vive esa llave y qué secrets usa el workflow: `MANUAL-OPERACION.md`,
sección "Respaldo nocturno de la base".

**Regla de oro: el respaldo se restaura en un proyecto NUEVO de Supabase, nunca sobre producción
(`vkxplmrzyqlamxpbtmes`).** Restaurar encima de producción pisaría lo que se capturó después del
respaldo (notas de hoy, labs de la mañana). Si lo que se busca es recuperar UNA nota o UNA caja,
primero revisa `scripts/supabase_restore_note.sql` (la bitácora `audit_log` guarda cada versión).

## Qué contiene y qué NO contiene

Contiene (esquema `public`): todas las tablas con sus datos (`patients`, `notes`, `archive`,
`app_users`, `config`, `rpa_config`, …; en el `completo` también `winlab_labs`, `audit_log` y
`respaldo_hora`), funciones, triggers, índices y políticas RLS.

No contiene (hay que rehacerlo en el proyecto nuevo):

- **Las filas de `sync_log`** (bitácora del censo y registro diario de tamaño): el workflow las
  excluye (`--exclude-table-data=public.sync_log`) para ahorrar egreso; la tabla se crea vacía y
  la hoja del censo y el cron `tamano-base-log` la vuelven a llenar solos. No se pierde nada
  clínico.
- **Cuentas** (`auth.users`): las personas se vuelven a dar de alta con 👥 Usuarios (la tabla
  `app_users` sí viene en el respaldo, pero apunta a ids de usuarios que no existen en el proyecto
  nuevo; ver paso 6).
- **Fotos y trazos** de Storage (buckets): el respaldo solo trae las referencias.
- **Extensiones** y **tareas programadas** (`pg_cron`, `pg_net`): se activan y se vuelven a crear
  con los scripts de `scripts/` (paso 5).
- **Publicación Realtime** (`supabase_realtime`): la re-crea `scripts/supabase_rls_current.sql`.
- **Permisos de los roles** (`--no-privileges`): también los re-aplica `supabase_rls_current.sql`.

## Requisitos en la Mac (una vez)

```bash
brew install age libpq
# libpq trae pg_restore y psql pero no los pone en el PATH:
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
pg_restore --version   # debe decir 17.x o más nuevo (la base está en Postgres 17)
```

## 1. Bajar el respaldo

GitHub → repo `piso-libro` → **Actions** → **Respaldo de la base** → la corrida verde del día que
quieras → al final de la página, **Artifacts** → `respaldo-db-AAAAMMDD-HHMM` (se baja un zip; dentro
va el `.dump.age`). Baja el `respaldo-db-base-…` más reciente **y** el `respaldo-db-completo-…`
más reciente (el del último domingo). El resumen de cada corrida dice cuántas filas tenían
`patients`, `notes`, `winlab_labs` y `audit_log`: sirve para comparar al final. Si hay copia en
Drive, son los mismos archivos.

## 2. Descifrar

Trabaja en una carpeta nueva y nombra el archivo exacto: si en Descargas se acumulan los zips de
simulacros anteriores, un comodín (`respaldo-db-*.zip`) agarra varios y `unzip`/`age` fallan.

```bash
mkdir -p ~/Downloads/restaurar && cd ~/Downloads/restaurar
unzip ~/Downloads/respaldo-db-base-AAAAMMDD-HHMM.zip       # los dos zips del paso 1
unzip ~/Downloads/respaldo-db-completo-AAAAMMDD-HHMM.zip
age -d -i ~/Documents/piso-libro-llave.txt -o pisolibro.dump pisolibro-db-base-AAAAMMDD-HHMM.dump.age
age -d -i ~/Documents/piso-libro-llave.txt -o completo.dump pisolibro-db-completo-AAAAMMDD-HHMM.dump.age
pg_restore --list pisolibro.dump | grep "TABLE DATA"   # lista de tablas con datos
```

`llave.txt` es el archivo que escribió `age-keygen` (contiene la línea `AGE-SECRET-KEY-…`). Si age
dice "no identity matched any of the recipients", esa llave no es la pareja de la pública que está en
el secret `BACKUP_AGE_PUBLIC_KEY`. **Borra `pisolibro.dump` y `completo.dump` al terminar**: ya no
están cifrados y traen nombres de pacientes. (Respaldos de antes del 2 nov 2026 se llaman
`pisolibro-db-AAAAMMDD-HHMM` y son completos: con uno de esos basta el paso 4, sin el 4b.)

## 3. Crear el proyecto nuevo en Supabase

1. https://supabase.com/dashboard → **New project** (misma organización; el plan gratuito permite 2
   proyectos activos). Nombre `piso-libro-restaurado-AAAAMMDD`, región la misma que producción
   (US West), **Postgres 17**. Anota la contraseña de la base: la vas a necesitar en el paso 4.
2. **Database → Extensions**: activa `pg_net` y `pg_cron` (las funciones restauradas las usan).
3. Copia la URL del **Session pooler**: botón **Connect** (arriba) → pestaña *Session pooler* →
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@…pooler.supabase.com:5432/postgres`. Cambia
   `[YOUR-PASSWORD]` por la contraseña del paso 1.

## 4. Restaurar

```bash
export NUEVA_DB_URL='postgresql://postgres.<ref-nuevo>:CONTRASEÑA@aws-0-us-west-2.pooler.supabase.com:5432/postgres'

# Seguro contra accidentes: si la URL es la de producción, se detiene.
case "$NUEVA_DB_URL" in *vkxplmrzyqlamxpbtmes*) echo "¡Esa es PRODUCCIÓN! Detenido."; exit 1;; esac

# Índice de lo que se restaura, sin dos cosas que el proyecto nuevo ya tiene o no puede aceptar:
#  - el esquema public (ya existe en todo proyecto Supabase; "schema public already exists")
#  - los DATOS de app_users (apuntan a cuentas de auth.users que aquí no existen; la tabla sí se crea)
pg_restore --list pisolibro.dump | grep -v -e ' SCHEMA - public ' -e ' TABLE DATA public app_users ' > lista.txt

PGSSLMODE=require pg_restore --use-list lista.txt --no-owner --no-privileges --exit-on-error \
  --dbname "$NUEVA_DB_URL" pisolibro.dump
```

Con `--exit-on-error` el primer problema detiene la restauración y lo deja escrito en pantalla: no
sigas sin entenderlo. Si en vez de un proyecto recién creado estás repitiendo el simulacro en el
mismo proyecto (ya tiene una copia vieja), añade `--clean --if-exists` para que primero quite lo
anterior (mismo `lista.txt`; los avisos por objetos que ya no existen son normales).

### 4b. Filas de las tablas grandes (del `completo`)

El `base` deja `winlab_labs`, `audit_log` y `respaldo_hora` creadas pero vacías. Sus filas salen del
`completo` (solo datos; las tablas, triggers e índices ya los puso el paso 4):

```bash
pg_restore --list completo.dump | grep -E 'TABLE DATA public (winlab_labs|audit_log|respaldo_hora) ' > lista_grandes.txt
cat lista_grandes.txt   # deben salir las 3 líneas
PGSSLMODE=require pg_restore --use-list lista_grandes.txt --data-only --no-owner --no-privileges --exit-on-error \
  --dbname "$NUEVA_DB_URL" completo.dump
```

Y en el SQL Editor, para que los ids nuevos sigan después de los restaurados:

```sql
select setval(pg_get_serial_sequence('public.winlab_labs', 'id'),   coalesce((select max(id) from public.winlab_labs), 1));
select setval(pg_get_serial_sequence('public.audit_log', 'id'),     coalesce((select max(id) from public.audit_log), 1));
select setval(pg_get_serial_sequence('public.respaldo_hora', 'id'), coalesce((select max(id) from public.respaldo_hora), 1));
```

(`winlab_labs.updated_at` toma la hora de la restauración: es solo la versión que usa la app para
saber qué filas bajar, no un dato clínico.)

Comprueba con el SQL Editor del proyecto nuevo (compara `patients` y `notes` con el resumen de la
corrida `base`, y `winlab_labs` y `audit_log` con el de la `completo`):

```sql
select (select count(*) from public.patients)    as patients,
       (select count(*) from public.notes)       as notes,
       (select count(*) from public.winlab_labs) as winlab_labs,
       (select count(*) from public.audit_log)   as audit_log;
```

## 5. Volver a montar lo que el respaldo no trae

En el SQL Editor del proyecto nuevo, en este orden (cada archivo explica en su cabecera qué hace
y si se puede volver a ejecutar):

1. `scripts/supabase_rls_current.sql` — permisos, `REVOKE` al rol `anon`, políticas, publicación
   Realtime.
2. `scripts/supabase_pg_cron_dispatch.sql` — disparo del robot de labs a la hora exacta.
3. `scripts/supabase_indicaciones_doc.sql` — descarga del Doc de indicaciones cada 15 min.
4. `scripts/supabase_audit_acotado.sql` — bitácora de actividad acotada (fusión de ráfagas, purga
   por tipo, índices, medidor de tamaño) y sus tareas `pg_cron` (`audit-log-purge`,
   `audit-log-vacuum`, `tamano-base-log`). El respaldo ya trae el trigger `pl_audit` y las
   funciones de historial (`pl_historial_caja_v3`, `pl_json_texto`) porque son objetos del esquema
   `public`; lo que falta son las tareas programadas, y este script las crea. **No** vuelvas a
   correr `scripts/supabase_audit_historial.sql`: es la versión anterior (sin fusión de ráfagas ni
   purga) y volvería a dejar el trigger como estaba antes de octubre de 2026.

Edge Function `admin-users` (👥 Usuarios): se despliega desde `supabase/functions/admin-users`
(`supabase functions deploy admin-users --project-ref <ref-nuevo>`).

## 6. Si el proyecto nuevo va a ser el de producción (desastre real)

Solo si producción se perdió de verdad. Todo esto lo hace el administrador el mismo día:

1. **Cuentas**: Supabase → Authentication → Users → *Add user* con tu correo y una contraseña; luego
   en el SQL Editor da de alta tu fila de administrador (sin ella la base no deja leer nada):
   `insert into public.app_users (id, email, role, status) select id, email, 'admin', 'active'
   from auth.users where email = 'tu@correo' on conflict (id) do nothing;`. Ya con la app
   apuntando al proyecto nuevo (paso 2), da de alta a los demás con 👥 Usuarios (contraseña
   temporal).
2. **La app**: en `index.html` cambia `SUPA_URL` y `SUPA_KEY` (anon key del proyecto nuevo:
   Project Settings → API) → PR a `main`.
3. **Llaves** (todas las copias que lista `scripts/SECURITY_NOTES.md`): secrets de GitHub
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_DB_URL`; propiedad `SUPABASE_KEY`/URL del Apps
   Script; `config.worker_config` si el worker apunta a Supabase; SMTP de Authentication.
4. **Fotos**: se perdieron con el proyecto viejo (los buckets no van en el respaldo). Las cajas
   siguen con su texto.
5. Avisa al servicio que vuelvan a entrar (contraseña temporal) y que las fotos anteriores a la fecha
   del respaldo no están.

## 7. Simulacro mensual (30 minutos, el primer lunes de cada mes)

Un respaldo que nunca se ha probado no es un respaldo. Cada mes:

1. Baja el `base` más reciente y el `completo` más reciente (paso 1) y descífralos (paso 2). Si no se puede descifrar, la llave
   privada guardada no es la buena: genera un par nuevo HOY y cambia el secret (manual).
2. Restáuralo en el proyecto `piso-libro-simulacro` (créalo la primera vez como en el paso 3; las
   siguientes veces usa `--clean --if-exists`, paso 4). Si está pausado por inactividad, pulsa
   **Restore project** en el dashboard y espera a que esté verde.
3. Restaura también las tablas grandes del `completo` (paso 4b) y compara los cuatro conteos con
   los resúmenes de las dos corridas: deben coincidir.
4. Anota la fecha y el resultado en la tabla del manual ("Respaldo nocturno de la base") y borra
   `pisolibro.dump` de la Mac.
5. Pausa el proyecto de simulacro (Project Settings → General → **Pause project**) para que no cuente
   como tráfico ni ocupe cupo.

Si cualquier paso falla, ese mismo día: abre un issue en el repo con el paso y el mensaje (sin
nombres de pacientes) y no esperes al siguiente mes.
