-- ═══ 🌙 GUARDIA y 🕓 CRONOLOGÍA (20 oct 2026, pedido de Gera) ═══════════════════════════════════════════
-- Incidente del 19-20 oct: varios equipos con copias viejas subieron la caja de guardia (checklist.__pl_note_meta
-- .entrega, que viaja dentro del checklist completo) encima de lo escrito por otros, y las «novedades automáticas»
-- (labs/imagen/cultivos) y el ✨ Resumen la llenaban solos. Este script (ya aplicado en producción el 20 oct
-- como migraciones entrega_protegida_solo_crece, entrega_funciones_restauracion, entrega_sin_auto_fix_array,
-- entrega_restaurada_funcion, guardia_cronologia_base, notas_sin_perdidas_capa2, alarma_perdidas_ignora_mudanzas,
-- cronologia_respaldo_y_recibo, restore_note_from_archive_cronologia, cronologia_insert_solo_base,
-- pg_trgm_para_guardia, guardia_correcciones_y_repetidos y guardia_ultimo_cambio_gana) deja:
--   1) La caja 🌙 GUARDIA no la borra una copia vieja: una escritura que quita renglones conserva lo guardado y
--      agrega al final solo lo nuevo; los renglones automáticos y los bloques «— Resumen dd/mm» que lleguen nuevos
--      se descartan. Quien edita la caja en ese momento sí la deja como quiere (último cambio gana), salvo lo que
--      otro equipo escribió en los últimos 15 min.
--   2) La columna notes.cronologia (🕓 CRONOLOGÍA) que solo escribe la base.
--   3) El paso de las 06:15 (León): pl_guardia_a_cronologia() pasa la Guardia a la Cronología con encabezado y
--      deja la Guardia vacía; guardia_cortes recuerda lo archivado 7 días para que una copia vieja no lo regrese.
--   4) Herramientas de restauración (pl_entrega_sin_auto, pl_entrega_renglones, pl_entrega_restaurada) y el
--      respaldo notes_entrega_respaldo_20261020 (cómo estaba cada caja antes de restaurar).
-- Solo un proceso de la base con `set local pl.entrega_libre = 'on'` puede reescribir la Guardia o la Cronología.
-- OJO: después se aplicó el paquete blindaje_20261020/ (mismo día, por la tarde), que REEMPLAZA en producción
-- pl_entrega_protegida, pl_checklist_sin_perdidas, archive_before_delete, restore_note_from_archive, pl_respaldo_hora
-- y pl_detectar_perdidas, y agrega más triggers. Para reconstruir la base: este archivo primero y luego
-- blindaje_20261020/ en el orden de su APLICAR_EN_ORDEN.md.
-- Se puede volver a correr completo (create or replace / if not exists).

create or replace function public.pl_es_auto_entrega(l text) returns boolean
language sql immutable as $fn$
  select btrim(coalesce(l, '')) ~ '^\d{2}-\d{2}-\d{4}: (Labs: |.*\(RIS\): |.*(POSITIVO a |sin desarrollo|negativo a ))'
$fn$;

alter table public.notes add column if not exists cronologia text not null default '';

create table if not exists public.guardia_cortes (
  id bigserial primary key,
  patient_id uuid not null,
  ts timestamptz not null default now(),
  lineas text[] not null default '{}'
);
create index if not exists guardia_cortes_pid_ts on public.guardia_cortes (patient_id, ts desc);
alter table public.guardia_cortes enable row level security;

create extension if not exists pg_trgm with schema extensions;
alter table public.guardia_cortes add column if not exists motivo text not null default 'corte';  -- 'corte' (06:15) | 'borrado'

-- Gemelo: r es otra versión de k (la misma frase corregida, ≥ 0.8 de parecido por trigramas) o k es r que creció.
create or replace function public.pl_guardia_gemelo(r text, k text) returns boolean
language sql immutable set search_path = public, extensions as $fn$
  select case
    when r is null or k is null then false
    when r = k then true
    when length(regexp_replace(r, '[[:space:].,;:-]+$', '')) >= 8
         and position(regexp_replace(r, '[[:space:].,;:-]+$', '') in k) = 1 then true
    else extensions.similarity(r, k) >= 0.8
  end
$fn$;

-- SECURITY DEFINER: la app guarda como «authenticated» y guardia_cortes tiene RLS sin políticas (antes el trigger no
-- veía lo archivado y una copia vieja podía regresarlo).
-- Último cambio gana (20 oct 2026, Gera: «que se respete el último cambio hecho»): una escritura DELIBERADA (la persona
-- tocó la caja: sello by.entrega.t nuevo, de los últimos 30 min, no ➕ Agregar) deja la caja como la manda, también al
-- borrar renglones completos, salvo renglones que OTRO equipo escribió en los últimos 15 min (según la bitácora) y que
-- este equipo aún no recibía. Lo borrado se recuerda 7 días ('borrado') para que una copia vieja no lo regrese.
-- Cualquier otra escritura (copia vieja, casilla de otra caja, cola sin red) no quita nada; lo nuevo entra al final.
create or replace function public.pl_entrega_protegida() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  old_e text := coalesce(old.checklist #>> '{__pl_note_meta,entrega}', '');
  new_e text := coalesce(new.checklist #>> '{__pl_note_meta,entrega}', '');
  modo text := coalesce(new.checklist #>> '{__pl_note_meta,by,entrega,m}', '');
  old_t timestamptz; new_t timestamptz;
  deliberado boolean := false;
  hdr jsonb; mi_equipo text;
  old_set text[]; new_set text[]; archivados text[]; borrados text[]; ajenos_recientes text[] := '{}';
  l text; t text; r text;
  en_resumen boolean := false;
  hubo_descartes boolean := false;
  agregar text[] := '{}';
  quedan text[] := '{}';
  quitar_ok text[] := '{}';
  protegidos int := 0;
  salida text[] := '{}';
  resultado text;
  ck jsonb;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  -- 🕓 Cronología: solo la base la escribe.
  if new.cronologia is distinct from old.cronologia then new.cronologia := old.cronologia; end if;
  if new_e = old_e then return new; end if;
  begin old_t := (old.checklist #>> '{__pl_note_meta,by,entrega,t}')::timestamptz; exception when others then old_t := null; end;
  begin new_t := (new.checklist #>> '{__pl_note_meta,by,entrega,t}')::timestamptz; exception when others then new_t := null; end;
  deliberado := new_t is not null and (old_t is null or new_t > old_t)
                and new_t > now() - interval '30 minutes' and new_t < now() + interval '10 minutes'
                and modo <> 'agregar';
  select coalesce(array_agg(btrim(x)), '{}') into old_set from unnest(string_to_array(old_e, E'\n')) x where btrim(x) <> '';
  select coalesce(array_agg(btrim(x)), '{}') into new_set from unnest(string_to_array(new_e, E'\n')) x where btrim(x) <> '';
  select coalesce(array_agg(distinct btrim(x)) filter (where c.motivo = 'corte'), '{}'),
         coalesce(array_agg(distinct btrim(x)) filter (where c.motivo = 'borrado'), '{}')
    into archivados, borrados
    from public.guardia_cortes c, unnest(c.lineas) x
   where c.patient_id = new.patient_id and c.ts > now() - interval '7 days';
  if deliberado then
    -- Renglones que otro equipo agregó en los últimos 15 min (puede que este equipo aún no los haya recibido).
    begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
    mi_equipo := coalesce(left(hdr->>'x-pl-device', 80), '') || '|' || coalesce(left(hdr->>'user-agent', 200), '');
    select coalesce(array_agg(distinct btrim(x)), '{}') into ajenos_recientes
      from public.audit_log a, unnest(string_to_array(a.diff->'entrega'->>'a', E'\n')) x
     where a.record_id = new.patient_id::text and a.tabla = 'notes' and a.ts > now() - interval '15 minutes'
       and a.diff ? 'entrega'
       and coalesce(a.dispositivo, '') || '|' || coalesce(a.ua, '') <> mi_equipo
       and btrim(x) <> ''
       and not (btrim(x) = any (select btrim(y) from unnest(string_to_array(coalesce(a.diff->'entrega'->>'de', ''), E'\n')) y));
  end if;
  -- 1) Lo que trae el texto nuevo.
  foreach l in array string_to_array(new_e, E'\n') loop
    t := btrim(l);
    if t = '' then en_resumen := false; continue; end if;
    if t ~ '^— Resumen \d{2}/\d{2}' then
      en_resumen := true;
      if t = any(old_set) then quedan := quedan || t; else hubo_descartes := true; end if;
      continue;
    end if;
    if t = any(old_set) then quedan := quedan || t; continue; end if;
    if en_resumen or public.pl_es_auto_entrega(t) then hubo_descartes := true; continue; end if;
    if t = any(archivados) and (not deliberado or (t ~ '^\d{1,2}[/-]\d{1,2}' and length(t) >= 16)) then
      hubo_descartes := true; continue;
    end if;
    if t = any(borrados) and (not deliberado or exists (
         select 1 from unnest(new_set) x
          where x <> t and x = any(old_set) and (public.pl_guardia_gemelo(t, x) or public.pl_guardia_gemelo(x, t)))) then
      hubo_descartes := true; continue;
    end if;
    if t = any(agregar) then continue; end if;
    agregar := agregar || t;
    quedan := quedan || t;
  end loop;
  -- 2) Lo que falta del texto guardado: lo quita solo quien está editando la caja (último cambio gana), salvo lo que
  --    otro equipo acaba de escribir.
  foreach r in array old_set loop
    if r = any(new_set) or r = any(quitar_ok) then continue; end if;
    if deliberado and not (r = any(ajenos_recientes)) then
      quitar_ok := quitar_ok || r;
    else
      protegidos := protegidos + 1;
    end if;
  end loop;
  if cardinality(quitar_ok) > 0 then
    insert into public.guardia_cortes (patient_id, lineas, motivo)
      select new.patient_id, array_agg(x), 'borrado' from unnest(quitar_ok) x where x ~ '[[:alnum:]]' having count(*) > 0;
  end if;
  if protegidos = 0 and not hubo_descartes then return new; end if;
  if protegidos = 0 then
    -- Se respeta el orden de la persona; solo salen los renglones descartados.
    foreach l in array string_to_array(new_e, E'\n') loop
      if btrim(l) = '' or btrim(l) = any(quedan) then salida := salida || l; end if;
    end loop;
    resultado := rtrim(array_to_string(salida, E'\n'), E' \n');
  else
    -- Se conserva lo guardado (menos lo que la persona quitó) y lo nuevo va al final.
    foreach l in array string_to_array(old_e, E'\n') loop
      if not (btrim(l) <> '' and btrim(l) = any(quitar_ok)) then salida := salida || l; end if;
    end loop;
    resultado := rtrim(array_to_string(salida, E'\n'), E' \n');
    if cardinality(agregar) > 0 then
      resultado := case when resultado = '' then '' else resultado || E'\n' end || array_to_string(agregar, E'\n');
    end if;
  end if;
  ck := coalesce(new.checklist, '{}'::jsonb);
  if jsonb_typeof(ck -> '__pl_note_meta') is distinct from 'object' then ck := jsonb_set(ck, '{__pl_note_meta}', '{}'::jsonb, true); end if;
  new.checklist := jsonb_set(ck, '{__pl_note_meta,entrega}', to_jsonb(resultado), true);
  return new;
end
$fn$;
revoke all on function public.pl_entrega_protegida() from public, anon, authenticated;

drop trigger if exists pl_entrega_protegida on public.notes;
create trigger pl_entrega_protegida before update on public.notes
  for each row execute function public.pl_entrega_protegida();

-- Paso de las 06:15: Guardia → Cronología, con encabezado de la guardia; la Guardia queda vacía.
create or replace function public.pl_guardia_a_cronologia() returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  r record; n int := 0;
  hoy date := (now() at time zone 'America/Mexico_City')::date;
  encabezado text;
  txt text;
begin
  perform set_config('pl.entrega_libre', 'on', true);
  encabezado := '— Guardia del ' || to_char(hoy - 1, 'DD/MM') || ' al ' || to_char(hoy, 'DD/MM') || ' —';
  -- FOR UPDATE: cada fila se lee ya con candado, así un renglón agregado justo a las 06:15 no se pierde.
  for r in select patient_id, checklist, cronologia from public.notes
           where btrim(coalesce(checklist #>> '{__pl_note_meta,entrega}', '')) <> ''
           for update loop
    txt := rtrim(r.checklist #>> '{__pl_note_meta,entrega}', E' \n');
    insert into public.guardia_cortes (patient_id, lineas, motivo)
      select r.patient_id, coalesce(array_agg(btrim(x)), '{}'), 'corte' from unnest(string_to_array(txt, E'\n')) x where btrim(x) <> '';
    update public.notes
       set cronologia = case when btrim(coalesce(cronologia, '')) = '' then '' else rtrim(cronologia, E' \n') || E'\n\n' end || encabezado || E'\n' || txt,
           checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', '""'::jsonb, true)
     where patient_id = r.patient_id;
    n := n + 1;
  end loop;
  delete from public.guardia_cortes where ts < now() - interval '7 days';
  perform set_config('pl.entrega_libre', 'off', true);
  return n;
end
$fn$;
revoke all on function public.pl_guardia_a_cronologia() from public, anon, authenticated;

-- Activación (SOLO cuando la app con las dos cajas ya esté publicada; 12:15 UTC = 06:15 León, sin horario de verano):
--   select cron.schedule('guardia-a-cronologia', '15 12 * * *', $$select public.pl_guardia_a_cronologia()$$);

-- ── Restauración (20 oct 2026) ────────────────────────────────────────────────────────────────────────────
create or replace function public.pl_entrega_sin_auto(txt text) returns text
language plpgsql immutable as $fn$
declare l text; t text; en_resumen boolean := false; out_lines text[] := '{}'; prev_blank boolean := true;
begin
  foreach l in array string_to_array(coalesce(txt, ''), E'\n') loop
    t := btrim(l);
    if t = '' then en_resumen := false; if not prev_blank then out_lines := array_append(out_lines, ''::text); prev_blank := true; end if; continue; end if;
    if t ~ '^— Resumen \d{2}/\d{2}' then en_resumen := true; continue; end if;
    if en_resumen or public.pl_es_auto_entrega(t) then continue; end if;
    out_lines := array_append(out_lines, rtrim(l)); prev_blank := false;
  end loop;
  return rtrim(array_to_string(out_lines, E'\n'), E' \n');
end $fn$;

create or replace function public.pl_entrega_renglones(txt text) returns table(ord int, linea text)
language sql immutable as $fn$
  select u.ord::int, btrim(u.l) from unnest(string_to_array(public.pl_entrega_sin_auto(txt), E'\n')) with ordinality u(l, ord) where btrim(u.l) <> ''
$fn$;

-- (Respaldo de un solo uso; se borró el 29 oct con scripts/supabase_limpieza_29oct.sql.)
create table if not exists public.notes_entrega_respaldo_20261020 (
  patient_id uuid primary key, entrega_antes text, respaldado_en timestamptz default now()
);
alter table public.notes_entrega_respaldo_20261020 enable row level security;

-- Caja restaurada de un paciente: lo de hoy (sin automáticos ni Resumen) + los renglones de personas vistos en la
-- bitácora desde p_desde que hoy faltan (sin borradores repetidos, sin sellos vacíos). Se aplicó el 20 oct con
-- p_desde = '2026-10-19 06:00+00' a 38 camas (210 renglones automáticos fuera, 0 renglones de personas fuera).
create or replace function public.pl_entrega_restaurada(p_pid uuid, p_desde timestamptz) returns text
language plpgsql stable as $fn$
declare
  actual text; base text; l text; t text; mejor text;
  base_lines text[] := '{}';
  recuperados text[];
  extra text[] := '{}';
  universo text[];
begin
  select coalesce(n.checklist #>> '{__pl_note_meta,entrega}', '') into actual from public.notes n where n.patient_id = p_pid;
  if actual is null then return null; end if;
  base := public.pl_entrega_sin_auto(actual);
  select coalesce(array_agg(linea order by primera, ord), '{}') into recuperados from (
    select r.linea, min(a.ts) as primera, min(r.ord) as ord
    from public.audit_log a, lateral (values (a.diff->'entrega'->>'de'), (a.diff->'entrega'->>'a')) x(txt), lateral public.pl_entrega_renglones(x.txt) r
    where a.tabla = 'notes' and a.record_id = p_pid::text and a.ts >= p_desde and a.diff ? 'entrega'
    group by r.linea) s;
  universo := recuperados || array(select btrim(z) from unnest(string_to_array(base, E'\n')) z where btrim(z) <> '');
  foreach l in array string_to_array(base, E'\n') loop
    t := btrim(l);
    if t <> '' then
      select u into mejor from unnest(recuperados) u where u <> t and u like replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%' order by length(u) desc limit 1;
      if mejor is not null then l := mejor; end if;
    end if;
    base_lines := array_append(base_lines, l);
  end loop;
  foreach t in array recuperados loop
    if t ~ '^\d{1,2}/\d{1,2}( \d{1,2}:\d{2})?( [A-Za-zÁÉÍÓÚÑáéíóúñ]{1,5})?:?$' then continue; end if;
    if length(t) <= 2 then continue; end if;
    if t = any(base_lines) or exists (select 1 from unnest(base_lines) b where btrim(b) = t) then continue; end if;
    if exists (select 1 from unnest(universo || base_lines) u where btrim(u) <> t and btrim(u) like replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_') || '%') then continue; end if;
    if t = any(extra) then continue; end if;
    extra := array_append(extra, t);
  end loop;
  return rtrim(array_to_string(base_lines, E'\n'), E' \n')
    || case when cardinality(extra) > 0 then (case when rtrim(array_to_string(base_lines, E'\n'), E' \n') = '' then '' else E'\n' end) || array_to_string(extra, E'\n') else '' end;
end $fn$;

-- ═══ Capa 2 contra pérdidas (20 oct 2026, aplicada como notas_sin_perdidas_capa2 y alarma_perdidas_ignora_mudanzas) ═══
-- (a) Ningún guardado puede desaparecer una caja que viaja dentro del checklist (si falta la llave, se conserva).
create or replace function public.pl_checklist_sin_perdidas() returns trigger
language plpgsql as $fn$
declare k text; faltan jsonb := '{}'::jsonb;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if jsonb_typeof(old.checklist) <> 'object' then return new; end if;
  if new.checklist is null or jsonb_typeof(new.checklist) <> 'object' then new.checklist := old.checklist; return new; end if;
  for k in select jsonb_object_keys(old.checklist) loop
    if not (new.checklist ? k) then faltan := faltan || jsonb_build_object(k, old.checklist -> k); end if;
  end loop;
  if faltan <> '{}'::jsonb then new.checklist := new.checklist || faltan; end if;
  return new;
end $fn$;
drop trigger if exists pl_checklist_sin_perdidas on public.notes;
create trigger pl_checklist_sin_perdidas before update on public.notes
  for each row execute function public.pl_checklist_sin_perdidas();

-- (b) Alarma de pérdida masiva: un equipo que quita renglones escritos por personas en ≥ 3 camas en 2 minutos
--     queda en perdidas_alerta (cada 10 min, cron «alarma-perdidas»). Un renglón que solo cambia de caja en el
--     mismo guardado no cuenta.
create table if not exists public.perdidas_alerta (
  id bigserial primary key,
  detectada timestamptz not null default now(),
  dispositivo text, nombre text,
  desde timestamptz, hasta timestamptz,
  camas int, renglones int,
  detalle jsonb,
  revisada boolean not null default false
);
alter table public.perdidas_alerta enable row level security;

create or replace function public.pl_renglones_quitados(de text, a text) returns int
language sql immutable as $fn$
  select count(*)::int from unnest(string_to_array(coalesce(de, ''), E'\n')) l
   where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
     and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(coalesce(a, ''), E'\n')) z))
$fn$;

create or replace function public.pl_detectar_perdidas() returns integer
language plpgsql security definer set search_path = public as $fn$
declare n int := 0; r record;
begin
  for r in
    with cambios as (
      select a.id, a.ts, a.dispositivo, a.nombre, a.cama, a.record_id, f.campo, f.de, f.a
        from public.audit_log a,
        lateral (
          select x.k as campo, a.diff -> x.k ->> 'de' as de, a.diff -> x.k ->> 'a' as a
            from (values ('pendientes'), ('manejo'), ('app'), ('pa'), ('misc'), ('entrega')) x(k) where a.diff ? x.k
          union all
          select 'ck:' || c.k, public.pl_json_texto(a.diff -> 'checklist' -> c.k ->> 'de'), public.pl_json_texto(a.diff -> 'checklist' -> c.k ->> 'a')
            from jsonb_object_keys(case when jsonb_typeof(a.diff -> 'checklist') = 'object' then a.diff -> 'checklist' else '{}'::jsonb end) c(k)
           where c.k in ('interconsultas', 'cultivos', 'pendientes_mips', 'pendientes_r1', 'recibo') or c.k like 'nota\_%'
        ) f
       where a.tabla = 'notes' and a.op = 'UPDATE' and a.ts > now() - interval '25 minutes'
    ), todo_lo_nuevo as (
      select id, string_agg(coalesce(a, ''), E'\n') as a_todo from cambios group by id
    ), perdidas as (
      select c.*, (select count(*) from unnest(string_to_array(coalesce(c.de, ''), E'\n')) l
                    where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
                      and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(t.a_todo, E'\n')) z))) as quitados
        from cambios c join todo_lo_nuevo t on t.id = c.id
    ), grupos as (
      select dispositivo, max(nombre) as nombre, date_bin('2 minutes', ts, timestamptz '2026-01-01') as ventana,
             min(ts) as desde, max(ts) as hasta, count(distinct record_id) as camas, sum(quitados) as renglones,
             jsonb_agg(distinct jsonb_build_object('cama', cama, 'campo', campo)) as detalle
        from perdidas where quitados > 0
       group by dispositivo, date_bin('2 minutes', ts, timestamptz '2026-01-01')
    )
    select * from grupos where camas >= 3
  loop
    if not exists (select 1 from public.perdidas_alerta p where p.dispositivo is not distinct from r.dispositivo and p.desde <= r.hasta and p.hasta >= r.desde) then
      insert into public.perdidas_alerta (dispositivo, nombre, desde, hasta, camas, renglones, detalle)
      values (r.dispositivo, r.nombre, r.desde, r.hasta, r.camas, r.renglones, r.detalle);
      n := n + 1;
    end if;
  end loop;
  return n;
end $fn$;
revoke all on function public.pl_detectar_perdidas() from public, anon, authenticated;
-- select cron.schedule('alarma-perdidas', '3,13,23,33,43,53 * * * *', $$select public.pl_detectar_perdidas()$$);

-- ═══ Respaldo de la Cronología (20 oct 2026, migraciones cronologia_respaldo_y_recibo,
--     restore_note_from_archive_cronologia y cronologia_insert_solo_base) ═══════════════════════════════════
-- (a) Copia por paciente de la última Cronología: si la nota se borra y se vuelve a crear (alta y reingreso, cambio
--     de cama que recrea la fila), la Cronología se repone sola: por patient_id o, en 10 días, por expediente +
--     misma persona (pl_same_person). Un paciente distinto con el mismo expediente no la hereda.
create table if not exists public.cronologia_respaldo (
  patient_id uuid primary key,
  exp text,
  nombre text,
  cronologia text default '',
  actualizado timestamptz default now()
);
alter table public.cronologia_respaldo enable row level security;

create or replace function public.pl_cronologia_guardar_copia() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
begin
  if btrim(coalesce(new.cronologia, '')) = '' then return new; end if;
  if tg_op = 'UPDATE' and new.cronologia is not distinct from old.cronologia then return new; end if;
  insert into public.cronologia_respaldo (patient_id, exp, nombre, cronologia, actualizado)
  select new.patient_id, p.exp, p.nombre, new.cronologia, now() from public.patients p where p.id = new.patient_id
  on conflict (patient_id) do update set cronologia = excluded.cronologia, exp = excluded.exp, nombre = excluded.nombre, actualizado = now();
  return new;
end $fn$;
drop trigger if exists pl_cronologia_guardar_copia on public.notes;
create trigger pl_cronologia_guardar_copia after insert or update of cronologia on public.notes
  for each row execute function public.pl_cronologia_guardar_copia();

-- (b) Al crear una nota, la Cronología tampoco la pone un cliente: solo la base (pl.entrega_libre) o el respaldo.
create or replace function public.pl_cronologia_reponer() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare c text; p record;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' and btrim(coalesce(new.cronologia, '')) <> '' then
    return new;
  end if;
  new.cronologia := '';
  select r.cronologia into c from public.cronologia_respaldo r where r.patient_id = new.patient_id;
  if c is null then
    select * into p from public.patients where id = new.patient_id;
    if found and nullif(btrim(coalesce(p.exp, '')), '') is not null then
      select r.cronologia into c from public.cronologia_respaldo r
       where btrim(coalesce(r.exp, '')) = btrim(p.exp) and r.actualizado > now() - interval '10 days'
         and public.pl_same_person(r.nombre, p.nombre)
       order by r.actualizado desc limit 1;
    end if;
  end if;
  if c is not null then new.cronologia := c; end if;
  return new;
end $fn$;
drop trigger if exists pl_cronologia_reponer on public.notes;
create trigger pl_cronologia_reponer before insert on public.notes
  for each row execute function public.pl_cronologia_reponer();

-- (c) La Papelera (archive_before_delete) guarda 'cronologia' en note_data, y restore_note_from_archive la repone
--     (INSERT y UPDATE con el permiso pl.entrega_libre solo para esa sentencia; la Guardia actual gana).
create or replace function public.archive_before_delete() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare
  pid uuid; p patients%rowtype; n notes%rowtype; who text; nd jsonb; pd jsonb;
begin
  if TG_TABLE_NAME = 'patients' then
    pid := OLD.id; p := OLD;
    select * into n from notes where patient_id = pid;
  else
    pid := OLD.patient_id; n := OLD;
    select * into p from patients where id = pid;
  end if;
  if pid is null then return OLD; end if;
  if exists (select 1 from archive a where a.patient_data->>'_supa_id' = pid::text and a.archived_at > now() - interval '5 minutes') then
    return OLD;
  end if;
  begin
    who := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb->>'role', 'db');
  exception when others then who := 'db'; end;
  pd := jsonb_build_object(
    'cama', coalesce(p.cama, ''), 'nombre', coalesce(p.nombre, ''), 'exp', coalesce(p.exp, ''), 'dx', coalesce(p.dx, ''),
    'edad', coalesce(p.edad, ''), 'esp', coalesce(p.esp, ''), 'adscrito', coalesce(p.adscrito, ''), 'residente', coalesce(p.residente, ''),
    'ingreso', coalesce(p.ingreso::text, ''), 'estado', coalesce(p.estado, ''), 'seccion', coalesce(p.seccion, ''),
    'es_mio', coalesce(p.es_mio, true), '_supa_id', pid);
  nd := case when n.patient_id is null then '{}'::jsonb else jsonb_build_object(
    'app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
    'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
    'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
    'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
    'cronologia', coalesce(n.cronologia, '')) end;
  nd := nd || jsonb_build_object('_egreso', 'BORRADO EN BD (' || who || ')',
                                 '_egresoFecha', to_char(now() at time zone 'America/Mexico_City', 'DD/MM/YYYY'));
  insert into archive (patient_data, note_data, archived_by) values (pd, nd, 'db-trigger:' || who);
  return OLD;
exception when others then
  raise warning 'archive_before_delete: % (se permite el borrado)', sqlerrm;
  return OLD;
end $fn$;

create or replace function public.restore_note_from_archive(p_id uuid) returns text
language plpgsql security definer set search_path to 'public' as $fn$
declare p patients%rowtype; a archive%rowtype; nd jsonb; n notes%rowtype; has_content boolean; merged_lh jsonb;
begin
  select * into p from patients where id = p_id;
  if not found or nullif(btrim(coalesce(p.exp,'')),'') is null then return 'sin-exp'; end if;
  select * into a from archive
   where btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp)
     and archived_at > now() - interval '10 days'
     and (note_data->>'_restaurado_a') is null
     and (patient_data->>'_supa_id') is distinct from p_id::text
     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;
  if not found then return 'sin-archivo'; end if;
  nd := coalesce(a.note_data, '{}'::jsonb);
  has_content := jsonb_array_length(coalesce(nd->'labHistory','[]'::jsonb)) > 0
              or jsonb_array_length(coalesce(nd->'imagenHistory','[]'::jsonb)) > 0
              or coalesce(nd->>'pendientes','') <> '' or coalesce(nd->>'app','') <> '' or coalesce(nd->>'pa','') <> ''
              or coalesce(nd->>'qx','') <> '' or coalesce(nd->>'manejo','') <> '' or coalesce(nd->>'drenajes','') <> ''
              or coalesce(nd->>'balance','') <> '' or coalesce(nd->>'sv','') <> '' or coalesce(nd->>'sangrado','') <> ''
              or coalesce(nd->>'cronologia','') <> ''
              or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
  if not has_content then return 'archivo-vacio'; end if;
  select * into n from notes where patient_id = p_id;
  if not found then
    perform set_config('pl.entrega_libre', 'on', true);
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore');
    perform set_config('pl.entrega_libre', 'off', true);
  else
    select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
      select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
      union all
      select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
       where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
    ) s;
    if coalesce(n.cronologia,'') = '' and coalesce(nd->>'cronologia','') <> '' then
      perform set_config('pl.entrega_libre', 'on', true);
    end if;
    update notes set
      app = case when coalesce(n.app,'') = '' then coalesce(nd->>'app','') else n.app end,
      pa = case when coalesce(n.pa,'') = '' then coalesce(nd->>'pa','') else n.pa end,
      drenajes = case when coalesce(n.drenajes,'') = '' then coalesce(nd->>'drenajes','') else n.drenajes end,
      qx = case when coalesce(n.qx,'') = '' then coalesce(nd->>'qx','') else n.qx end,
      manejo = case when coalesce(n.manejo,'') = '' then coalesce(nd->>'manejo','') else n.manejo end,
      sangrado = case when coalesce(n.sangrado,'') = '' then coalesce(nd->>'sangrado','') else n.sangrado end,
      sv = case when coalesce(n.sv,'') = '' then coalesce(nd->>'sv','') else n.sv end,
      balance = case when coalesce(n.balance,'') = '' then coalesce(nd->>'balance','') else n.balance end,
      pendientes = case when coalesce(n.pendientes,'') = '' then coalesce(nd->>'pendientes','') else n.pendientes end,
      misc = case when coalesce(n.misc,'') = '' then coalesce(nd->>'misc','') else n.misc end,
      cronologia = case when coalesce(n.cronologia,'') = '' then coalesce(nd->>'cronologia','') else n.cronologia end,
      checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
      lab_history = merged_lh,
      imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
      updated_by = 'db-restore'
    where patient_id = p_id;
    perform set_config('pl.entrega_libre', 'off', true);
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $fn$;
-- Probado el 20 oct en una transacción que se deshizo (paciente ficticio ZZ-0001): cliente no escribe (INSERT ni
-- UPDATE), respaldo, reposición por id, por expediente + misma persona, desde la Papelera, otro nombre no hereda,
-- y el permiso queda apagado al terminar.

-- ═══ Correcciones y repetidos en la Guardia (20 oct 2026, migraciones pg_trgm_para_guardia,
--     guardia_correcciones_y_repetidos y guardia_ultimo_cambio_gana) ═══════════════════════════════════════════════════════════════════════
-- Gera: «van varias veces que borro lo repetido y sigue apareciendo» y, en la 3-175, «borré algo y sigue apareciendo…
-- que se respete el último cambio hecho». Con «solo crece», cada corrección guardaba la versión vieja y agregaba la
-- nueva, y borrar no servía. Ahora pl_entrega_protegida (SECURITY DEFINER: antes no veía guardia_cortes por RLS
-- cuando guardaba la app) distingue:
--   · Escritura deliberada (la app sella __pl_note_meta.by.entrega.t al tocar la caja; sello más nuevo que el
--     guardado, de los últimos 30 min y no de ➕ Agregar, que manda m = 'agregar'): ÚLTIMO CAMBIO GANA, también al
--     borrar renglones completos, salvo los renglones que otro equipo (x-pl-device + user-agent distintos) escribió
--     en los últimos 15 min según la bitácora. Lo quitado va a guardia_cortes con motivo 'borrado' (7 días).
--   · Cualquier otra escritura: no quita nada; lo nuevo entra al final; lo borrado o ya pasado a la Cronología
--     que regresa con una copia vieja se descarta.
--   · En una escritura deliberada, lo ya pasado a la Cronología solo se descarta si es un renglón con fecha
--     (dd/mm…, ≥ 16 letras), para no tirar un «Afebril» escrito hoy; un renglón borrado que regresa junto a su
--     versión corregida (pl_guardia_gemelo) también se descarta.
-- pl_guardia_a_cronologia ahora toma cada fila con FOR UPDATE (un renglón agregado a las 06:15 no se pierde).
-- Pruebas: scripts/supabase_guardia_cronologia_pruebas.sql (transacción que se deshace; ver ese archivo).
-- Limpieza única del 20 oct (respaldo en notes_entrega_respaldo_20261020b): 11 camas, 22 renglones que eran
-- borradores contenidos en otro renglón, sellos vacíos o el mismo texto con otra fecha (verificado uno por uno).
-- (Las definiciones de pl_guardia_gemelo, pl_entrega_protegida y pl_guardia_a_cronologia están arriba.)

-- ═══ Respaldo cada hora (20 oct 2026, migración respaldo_cada_hora) ═══════════════════════════════════════════════
-- Gera: «que tengamos copia de seguridad por cualquier cosa». Cada hora (minuto 7) se copia la fila COMPLETA de cada
-- nota y paciente que cambió desde la copia anterior; se guardan 7 días. Además quedaron copias únicas
-- respaldo_notes_20261020_0530 / respaldo_patients_20261020_0530 (estado completo antes de la revisión integral).
-- Recuperar una caja: select respaldado_en, nota->>'pendientes' from public.respaldo_hora
--                     where patient_id = '…' order by respaldado_en desc;
create table if not exists public.respaldo_hora (
  id bigserial primary key,
  respaldado_en timestamptz not null default now(),
  patient_id uuid not null,
  cama text,
  nota jsonb,
  paciente jsonb
);
create index if not exists respaldo_hora_pid_ts on public.respaldo_hora (patient_id, respaldado_en desc);
create index if not exists respaldo_hora_ts on public.respaldo_hora (respaldado_en);
alter table public.respaldo_hora enable row level security;

create or replace function public.pl_respaldo_hora() returns integer
language plpgsql security definer set search_path = public as $fn$
declare n int := 0; ultimo timestamptz;
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
  return n;
end $fn$;
revoke all on function public.pl_respaldo_hora() from public, anon, authenticated;
-- Activado el 20 oct:  select cron.schedule('respaldo-cada-hora', '7 * * * *', $$select public.pl_respaldo_hora()$$);
