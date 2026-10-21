-- ═══ O3 · No olvidar, Procedimientos del día y Guardia del encabezado: copia al borrar y respaldo horario (20 oct 2026, P1-06) ═══
-- Por qué: «No olvidar» (public.no_olvidar) y «Procedimientos del día» (public.procedimientos_dia) son listas que
-- comparten todos los equipos y NO tienen Papelera: «Borrar hechos» borra los hechos de todos y el 🗑 de un
-- procedimiento lo borra para todos; lo único que queda es la bitácora (pl_audit), que de un DELETE guarda solo 600
-- letras. Tampoco entraban en el respaldo de cada hora (respaldo_hora solo copia notas y pacientes), igual que
-- guard_info (quién entrega y quién recibe la guardia, fila única 'current').
-- Columnas reales (leídas en producción el 20 oct por MCP, information_schema):
--   no_olvidar:          id bigint identity, texto, author, fecha date, done boolean, created_at           (sin updated_at)
--   procedimientos_dia:  id uuid, cama, exp, nombre, edad, dx, esp, adscrito, residente, fecha_dia, added_at, added_by (sin updated_at)
--   guard_info:          id text ('current'), fecha, entrega, recibe, updated_at
-- Como dos de las tres no tienen updated_at, «si cambió» se decide por la huella md5 de la fila completa.
--   1) borrados_otros + trigger BEFORE DELETE en no_olvidar y procedimientos_dia: la fila completa, quién y desde dónde.
--      La copia es obligatoria: si no se puede guardar, el borrado no se hace.
--   2) pl_respaldo_hora (cron «respaldo-cada-hora», minuto 7) además copia a respaldo_hora_otros cada fila de las tres
--      tablas que cambió desde su última copia (o que aún no tiene copia) y marca las que desaparecieron; 7 días.
--      Si esa parte falla, el respaldo de notas y pacientes de esa hora sí queda (se avisa con WARNING en el log del cron).
-- Se puede volver a correr (create or replace / if not exists). Requiere pl_quien() de 02_papelera_copia_base.sql.

-- ── 1) Copia al borrar ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.borrados_otros (
  id bigserial primary key,
  borrado_en timestamptz not null default now(),
  tabla text not null,            -- 'no_olvidar' | 'procedimientos_dia'
  llave text not null,            -- id de la fila borrada
  fila jsonb not null,            -- la fila completa (to_jsonb): se repone con jsonb_populate_record
  quien_user_id uuid,
  quien_email text,
  quien_nombre text,
  dispositivo text,
  ua text,
  ip text,
  rol text
);
create index if not exists borrados_otros_tabla_ts on public.borrados_otros (tabla, borrado_en desc);
alter table public.borrados_otros enable row level security;
revoke all on table public.borrados_otros from anon, authenticated;
grant select on table public.borrados_otros to authenticated;
revoke all on sequence public.borrados_otros_id_seq from anon, authenticated;
drop policy if exists borrados_otros_admin_read on public.borrados_otros;
create policy borrados_otros_admin_read on public.borrados_otros as permissive for select to authenticated
  using ((select public.pl_is_admin()));

create or replace function public.pl_borrados_otros() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare q jsonb := public.pl_quien();
begin
  -- 20 oct 2026 (P1-06): copia obligatoria de lo que se borra de las listas compartidas.
  insert into public.borrados_otros (tabla, llave, fila, quien_user_id, quien_email, quien_nombre, dispositivo, ua, ip, rol)
  values (TG_TABLE_NAME, (to_jsonb(OLD)->>'id'), to_jsonb(OLD), (q->>'user_id')::uuid, q->>'email', q->>'nombre', q->>'dispositivo', q->>'ua', q->>'ip', q->>'rol');
  return OLD;
end $fn$;
revoke all on function public.pl_borrados_otros() from public, anon, authenticated;
grant execute on function public.pl_borrados_otros() to service_role;
drop trigger if exists pl_borrados_otros on public.no_olvidar;
create trigger pl_borrados_otros before delete on public.no_olvidar for each row execute function public.pl_borrados_otros();
drop trigger if exists pl_borrados_otros on public.procedimientos_dia;
create trigger pl_borrados_otros before delete on public.procedimientos_dia for each row execute function public.pl_borrados_otros();
-- Reponer lo borrado de No olvidar (overriding: id es «generated always»):
--   insert into public.no_olvidar overriding system value
--   select (jsonb_populate_record(null::public.no_olvidar, b.fila)).* from public.borrados_otros b where b.tabla = 'no_olvidar' and b.id = …;
--   insert into public.procedimientos_dia
--   select (jsonb_populate_record(null::public.procedimientos_dia, b.fila)).* from public.borrados_otros b where b.tabla = 'procedimientos_dia' and b.id = …;

-- ── 2) Respaldo horario de las listas ──────────────────────────────────────────────────────────────────────────
create table if not exists public.respaldo_hora_otros (
  id bigserial primary key,
  respaldado_en timestamptz not null default now(),
  tabla text not null,            -- 'no_olvidar' | 'procedimientos_dia' | 'guard_info'
  llave text not null,
  fila jsonb,                     -- null cuando la fila ya no existe (borrada = true)
  huella text,                    -- md5(fila::text): «si cambió»
  borrada boolean not null default false
);
create index if not exists respaldo_hora_otros_llave_ts on public.respaldo_hora_otros (tabla, llave, respaldado_en desc, id desc);
create index if not exists respaldo_hora_otros_ts on public.respaldo_hora_otros (respaldado_en);
alter table public.respaldo_hora_otros enable row level security;
revoke all on table public.respaldo_hora_otros from anon, authenticated;
revoke all on sequence public.respaldo_hora_otros_id_seq from anon, authenticated;

create or replace function public.pl_respaldo_hora_otros() returns integer
language plpgsql security definer set search_path = public as $fn$
declare n_nuevas int := 0; n_quitadas int := 0;
begin
  -- 20 oct 2026: primero se purga (7 días) y luego se copia, así una fila que no ha cambiado en 7 días vuelve a tener
  -- copia en la misma corrida (no queda una hora sin ninguna).
  delete from public.respaldo_hora_otros where respaldado_en < now() - interval '7 days';
  with actual as (
    select 'no_olvidar'::text as tabla, x.id::text as llave, to_jsonb(x) as fila from public.no_olvidar x
    union all
    select 'procedimientos_dia', x.id::text, to_jsonb(x) from public.procedimientos_dia x
    union all
    select 'guard_info', x.id::text, to_jsonb(x) from public.guard_info x
  ), ultima as (
    select distinct on (r.tabla, r.llave) r.tabla, r.llave, r.huella, r.borrada
      from public.respaldo_hora_otros r
     order by r.tabla, r.llave, r.respaldado_en desc, r.id desc
  )
  insert into public.respaldo_hora_otros (tabla, llave, fila, huella)
  select c.tabla, c.llave, c.fila, md5(c.fila::text)
    from actual c left join ultima u on u.tabla = c.tabla and u.llave = c.llave
   where u.llave is null or u.borrada or u.huella is distinct from md5(c.fila::text);
  get diagnostics n_nuevas = row_count;
  -- Filas que ya no existen: una marca (la última copia completa sigue ahí 7 días; el detalle del borrado, en borrados_otros).
  with ultima as (
    select distinct on (r.tabla, r.llave) r.tabla, r.llave, r.borrada, r.respaldado_en
      from public.respaldo_hora_otros r
     order by r.tabla, r.llave, r.respaldado_en desc, r.id desc
  )
  insert into public.respaldo_hora_otros (tabla, llave, fila, huella, borrada)
  select u.tabla, u.llave, null, null, true
    from ultima u
   where not u.borrada
     and not exists (select 1 from public.no_olvidar x where u.tabla = 'no_olvidar' and x.id::text = u.llave)
     and not exists (select 1 from public.procedimientos_dia x where u.tabla = 'procedimientos_dia' and x.id::text = u.llave)
     and not exists (select 1 from public.guard_info x where u.tabla = 'guard_info' and x.id::text = u.llave);
  get diagnostics n_quitadas = row_count;
  return n_nuevas + n_quitadas;
end $fn$;
revoke all on function public.pl_respaldo_hora_otros() from public, anon, authenticated;
grant execute on function public.pl_respaldo_hora_otros() to service_role;

-- pl_respaldo_hora: lo de siempre (notas y pacientes, idéntico a producción) + las listas. Devuelve el total de filas
-- copiadas (antes solo notas y pacientes).
create or replace function public.pl_respaldo_hora() returns integer
language plpgsql security definer set search_path = public as $fn$
declare n int := 0; n_otros int := 0; ultimo timestamptz;
begin
  select max(respaldado_en) into ultimo from public.respaldo_hora;
  insert into public.respaldo_hora (patient_id, cama, nota, paciente)
  select p.id, p.cama, to_jsonb(nt), to_jsonb(p)
    from public.patients p
    left join public.notes nt on nt.patient_id = p.id
   where ultimo is null
      or coalesce(nt.updated_at, '-infinity') > ultimo
      or coalesce(p.updated_at, '-infinity') > ultimo
      or not exists (select 1 from public.respaldo_hora r where r.patient_id = p.id);
  get diagnostics n = row_count;
  delete from public.respaldo_hora where respaldado_en < now() - interval '7 days';
  -- 20 oct 2026 (P1-06): No olvidar, Procedimientos del día y guard_info. Un error aquí no tumba el respaldo de notas.
  begin
    n_otros := public.pl_respaldo_hora_otros();
  exception when others then
    raise warning 'pl_respaldo_hora: el respaldo de listas falló (%); el de notas y pacientes sí quedó', sqlerrm;
  end;
  return n + n_otros;
end $fn$;
-- Permisos sin cambio (create or replace los conserva): solo postgres y service_role.
-- Ver una lista como estaba a una hora:
--   select distinct on (llave) llave, borrada, fila from public.respaldo_hora_otros
--    where tabla = 'no_olvidar' and respaldado_en <= '2026-10-20 12:07+00' order by llave, respaldado_en desc, id desc;

-- REVERSA (objetos nuevos):
--   drop trigger if exists pl_borrados_otros on public.no_olvidar; drop trigger if exists pl_borrados_otros on public.procedimientos_dia;
--   drop function if exists public.pl_borrados_otros(); drop function if exists public.pl_respaldo_hora_otros();  (después de reponer pl_respaldo_hora)
--   drop table if exists public.borrados_otros; drop table if exists public.respaldo_hora_otros;

-- ▼▼▼ REVERSA AUTOMÁTICA (armar_reversas.py) ▼▼▼
-- Para volver atrás: quitar los «-- » de abajo y correrlo (create or replace con la definición de producción).
-- Las tablas, triggers y permisos nuevos de este archivo se quitan con las líneas «REVERSA (objetos nuevos)» de arriba.
-- -- pl_respaldo_hora() · cuerpo de supabase_guardia_cronologia.sql · md5(prosrc) 44e66b43269ce1f9befa4006cfd058f2
-- CREATE OR REPLACE FUNCTION public.pl_respaldo_hora()
--  RETURNS integer
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare n int := 0; ultimo timestamptz;
-- begin
--   select max(respaldado_en) into ultimo from public.respaldo_hora;
--   insert into public.respaldo_hora (patient_id, cama, nota, paciente)
--   select p.id, p.cama, to_jsonb(nt), to_jsonb(p)
--     from public.patients p
--     left join public.notes nt on nt.patient_id = p.id
--    where ultimo is null
--       or coalesce(nt.updated_at, '-infinity') > ultimo
--       or coalesce(p.updated_at, '-infinity') > ultimo
--       or not exists (select 1 from public.respaldo_hora r where r.patient_id = p.id);
--   get diagnostics n = row_count;
--   delete from public.respaldo_hora where respaldado_en < now() - interval '7 days';
--   return n;
-- end $function$
-- ;
-- ▲▲▲ FIN DE LA REVERSA ▲▲▲
