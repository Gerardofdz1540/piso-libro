-- 27 oct 2026 · aplicado en producción (migraciones app_users_columnas_propias, app_users_pwd_y_rotacion,
-- realtime_canales_privados y sync_log_90_dias). Todo lo de abajo se probó con el rol authenticated dentro de una
-- transacción revertida.

-- 1) Nadie puede cambiarse el rol (hallazgo de la repasada): la política app_users_self_update deja editar SU fila, pero
--    el permiso UPDATE era de tabla completa y una cuenta activa podía ponerse role='admin' (o status) con un PATCH
--    directo a /rest/v1/app_users. No hubo abuso: hay un solo administrador, el original del 14 oct.
--    Ahora authenticated solo cambia nombre y última conexión (y la marca de contraseña temporal, abajo); rol, estado y
--    correo solo los cambia el panel 👥 Usuarios (Edge Function admin-users, con la llave de servicio).
revoke insert, update on table public.app_users from authenticated, anon;
grant update (nombre, last_seen_at) on table public.app_users to authenticated;

-- 2) Contraseña temporal obligatoria (hallazgo 77) y fin de rotación (hallazgo 62).
--    debe_cambiar_pwd: la pone admin-users al crear la cuenta o dar «🔑 Contraseña temporal»; la app pide una nueva al
--                      entrar (sin poder cerrar la ventana) y la apaga al cambiarla.
--    acceso_hasta:     fecha de fin de rotación; el panel avisa al administrador cuando ya pasó.
alter table public.app_users add column if not exists debe_cambiar_pwd boolean not null default false;
alter table public.app_users add column if not exists acceso_hasta date;
grant update (debe_cambiar_pwd) on table public.app_users to authenticated;

-- 3) Canales en vivo privados (hallazgo 78): quién edita (pl-presence), la guardia (pl-guard-info) y el aviso de No
--    olvidar (pl-no-olvidar) eran públicos. La app los abre con private:true desde la versión 2026.10.27-6 y solo entran
--    cuentas activas. Cuando todos los iPads tengan esa versión: Supabase → Realtime → Settings → apagar «Allow public
--    access» (ver el manual).
create policy pl_realtime_leer on realtime.messages for select to authenticated
  using (realtime.topic() in ('pl-guard-info', 'pl-presence', 'pl-no-olvidar') and (select public.pl_is_active()));
create policy pl_realtime_enviar on realtime.messages for insert to authenticated
  with check (realtime.topic() in ('pl-guard-info', 'pl-presence', 'pl-no-olvidar') and (select public.pl_is_active()));

-- 4) Plazo de borrado (hallazgo 38): sync_log (avisos del script del censo: exp, camas y nombres, sin datos clínicos)
--    se guarda 90 días. La Papelera (archive) y los archivos de Storage se conservan a propósito: la Papelera alimenta el
--    registro de pacientes para investigación y lo que alguien borra ahí queda en archive_eliminados; los archivos son
--    el respaldo de labs y notas.
create or replace function public.pl_sync_log_purga()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with b as (delete from public.sync_log where ts < now() - interval '90 days' returning 1)
  select count(*)::int from b;
$$;
revoke all on function public.pl_sync_log_purga() from public, anon, authenticated;
select cron.schedule('sync-log-purge', '47 4 * * *', $$select public.pl_sync_log_purga()$$);
