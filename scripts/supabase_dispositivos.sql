-- 28 oct 2026 · aplicado en producción (migración pl_dispositivos_version).
-- Versión de la app en cada dispositivo. Antes de apagar el acceso público de Realtime hay que saber que TODOS los
-- iPads ya tienen la versión nueva. Cada dispositivo (id al azar guardado en su navegador, «pl_dispositivo_id») reporta
-- su versión (PL_BUILD) al abrir la app y cada hora con pl_reportar_dispositivo; solo el administrador lee la tabla
-- (👥 Usuarios → 📱 Versiones). No guarda nada de pacientes: dispositivo, cuenta, equipo («iPad · Safari 17.6») y hora.
create table if not exists public.pl_dispositivos (
  dispositivo text primary key check (dispositivo ~ '^[a-z0-9-]{8,64}$'),
  user_id uuid references auth.users(id) on delete set null,
  nombre text not null default '',
  equipo text not null default '',
  build text not null default '',
  visto timestamptz not null default now(),
  primer_visto timestamptz not null default now()
);
create index if not exists pl_dispositivos_user_id_idx on public.pl_dispositivos (user_id);
alter table public.pl_dispositivos enable row level security;
revoke all on public.pl_dispositivos from anon, authenticated;
grant select on public.pl_dispositivos to authenticated;
drop policy if exists pl_dispositivos_admin_read on public.pl_dispositivos;
create policy pl_dispositivos_admin_read on public.pl_dispositivos for select to authenticated using ((select public.pl_is_admin()));

-- SECURITY DEFINER: escribe la fila del dispositivo con la cuenta de la sesión (auth.uid()); solo cuentas activas.
create or replace function public.pl_reportar_dispositivo(p_dispositivo text, p_build text, p_equipo text default '')
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare uid uuid := auth.uid(); nom text;
begin
  if uid is null or not public.pl_is_active() then
    raise exception 'sin acceso';
  end if;
  if p_dispositivo is null or p_dispositivo !~ '^[a-z0-9-]{8,64}$' or p_build is null or length(p_build) > 40 then
    raise exception 'dispositivo o versión no válida';
  end if;
  select coalesce(nullif(u.nombre, ''), u.email) into nom from public.app_users u where u.id = uid;
  insert into public.pl_dispositivos (dispositivo, user_id, nombre, equipo, build, visto)
  values (p_dispositivo, uid, coalesce(nom, ''), left(coalesce(p_equipo, ''), 60), p_build, now())
  on conflict (dispositivo) do update
    set user_id = excluded.user_id, nombre = excluded.nombre, equipo = excluded.equipo, build = excluded.build, visto = now();
  return 'ok';
end
$function$;
revoke execute on function public.pl_reportar_dispositivo(text, text, text) from public, anon;
grant execute on function public.pl_reportar_dispositivo(text, text, text) to authenticated;
