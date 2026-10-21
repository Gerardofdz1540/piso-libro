-- ═══ O5 · Alarma de pérdidas que ve todas las cajas (20 oct 2026, revisión integral P1-08 / hallazgo D7) ═══════════
-- Por qué: el 19/10 a las 08:43 (León) una Mac con una copia vieja regresó en 1 s las cajas de 43 camas, entre ellas
-- Cirugías (3-164: de 2 cirugías a ninguna), los signos del pase (3-172: el historial pm_hist vacío) y la NPT (3-163:
-- de sí a no). pl_detectar_perdidas (cron «alarma-perdidas», cada 10 min) no avisó porque:
--   (a) solo miraba 6 textos (pendientes, manejo, app, pa, misc, 🌙 Guardia) y 5 cajas de texto del checklist más nota_*:
--       no veía Cirugías, Dispositivos, signos del pase, vasopresores, NPT, ATB ni las casillas;
--   (b) agrupaba por dispositivo solamente («Mac Chrome» lo usan varias personas) y
--   (c) contaba camas en cubetas fijas de 2 min (date_bin): una ráfaga de 70 s que cruza el minuto par quedaba partida
--       en dos cubetas con menos de 3 camas cada una.
-- Ahora:
--   · Textos de la nota (app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, misc) y la 🌙 Guardia
--     (entrega): renglones escritos por personas que desaparecen (igual que antes).
--   · TODAS las llaves del checklist (menos las internas «__…»):
--       - listas (cirugias, dispositivos, pm_hist, nota_hist…): elementos que desaparecen, por id cuando lo traen
--         (cirugías y dispositivos) y si no por cuántos menos;
--       - cajas de texto (interconsultas, cultivos, pendientes_mips, pendientes_r1, recibo, nota_*): renglones quitados;
--       - escalares (pm_*, vp_*, npt*, atb*, dieta, tvp*…): pasar de un valor a vacío; casillas: de sí a no.
--   · Exclusión de mudanzas (se mantiene): un renglón o valor que en el MISMO guardado aparece en otra caja no cuenta
--     (p. ej. el cambio de día del pase, que pasa los signos de ayer a pm_hist, o el paso de las 06:15 de la Guardia a la
--     🕓 Cronología, que hace pl_guardia_a_cronologia en todas las camas a la vez cuando se programe).
--   · Mismo equipo = mismo usuario + dispositivo + navegador (user_id, x-pl-device, user-agent).
--   · Ventana móvil de 2 min: hay alerta si desde cualquier pérdida, en los 2 min siguientes, el mismo equipo quitó
--     algo en ≥ 3 camas; las ventanas que se enciman son UNA alerta (desde la primera hasta la última pérdida).
--   · perdidas_alerta se mantiene (dos columnas nuevas: user_id y ua); una ráfaga ya avisada no se vuelve a avisar
--     (tampoco si la avisó la versión anterior, que no guardaba user_id ni ua).
-- Se puede volver a correr (create or replace / add column if not exists). Reversa al final del archivo.

alter table public.perdidas_alerta add column if not exists user_id uuid;
alter table public.perdidas_alerta add column if not exists ua text;

-- Cuánto se perdió en UNA llave del checklist (de/a como los guarda pl_audit: el JSON de la llave, recortado a 6000).
create or replace function public.pl_ck_perdidos(k text, de text, a text, otros text) returns integer
language plpgsql immutable set search_path = public as $fn$
declare dj jsonb; aj jsonb; ids_de text[]; ids_a text[]; t text; ta text; n int;
begin
  -- 20 oct 2026 · «otros» = todo lo nuevo de ese mismo guardado (para no contar mudanzas).
  if coalesce(de, '') = '' then return 0; end if;            -- la llave no existía: no se perdió nada
  begin dj := de::jsonb; exception when others then dj := null; end;   -- null si venía recortada
  begin aj := nullif(a, '')::jsonb; exception when others then aj := null; end;
  -- Listas: por id si los elementos lo traen (también en un JSON recortado), si no por cuántos menos.
  if left(ltrim(de), 1) = '[' then
    select coalesce(array_agg(distinct m[1]), '{}') into ids_de from regexp_matches(de, '"id"\s*:\s*"?([^",}\s]+)', 'g') m;
    if cardinality(ids_de) > 0 then
      select coalesce(array_agg(distinct m[1]), '{}') into ids_a from regexp_matches(coalesce(a, ''), '"id"\s*:\s*"?([^",}\s]+)', 'g') m;
      select count(*)::int into n from unnest(ids_de) x where not (x = any (ids_a));
      return n;
    end if;
    if jsonb_typeof(dj) = 'array' then
      return greatest(jsonb_array_length(dj) - case when jsonb_typeof(aj) = 'array' then jsonb_array_length(aj) else 0 end, 0);
    end if;
    return 0;
  end if;
  if left(de, 1) = '"' then
    t := public.pl_json_texto(de);
    -- Cajas de texto: renglones de personas quitados que no se mudaron a otra caja.
    if k in ('interconsultas', 'cultivos', 'pendientes_mips', 'pendientes_r1', 'recibo') or k like 'nota\_%' then
      select count(*)::int into n from unnest(string_to_array(coalesce(t, ''), E'\n')) l
       where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
         and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(coalesce(otros, ''), E'\n')) z));
      return n;
    end if;
    -- Escalares: de un valor a vacío, salvo que el valor esté en lo nuevo del guardado (como renglón o como valor JSON).
    ta := case when left(coalesce(a, ''), 1) = '"' then public.pl_json_texto(a) else coalesce(a, '') end;
    if btrim(coalesce(t, '')) <> '' and btrim(coalesce(ta, '')) in ('', 'null')
       and position(to_jsonb(btrim(t))::text in coalesce(otros, '')) = 0
       and not (btrim(t) = any (select btrim(z) from unnest(string_to_array(coalesce(otros, ''), E'\n')) z)) then
      return 1;
    end if;
    return 0;
  end if;
  -- Casillas (sí → no o vacía) y números (→ vacío).
  if dj = 'true'::jsonb and (aj is null or aj in ('false'::jsonb, 'null'::jsonb, '""'::jsonb)) then return 1; end if;
  if jsonb_typeof(dj) = 'number' and (aj is null or aj in ('null'::jsonb, '""'::jsonb)) then return 1; end if;
  return 0;
end $fn$;
revoke all on function public.pl_ck_perdidos(text, text, text, text) from public, anon, authenticated;
grant execute on function public.pl_ck_perdidos(text, text, text, text) to service_role;

create or replace function public.pl_detectar_perdidas() returns integer
language plpgsql security definer set search_path = public as $fn$
declare n int := 0; r record;
begin
  for r in
    with base as (
      select a.id, a.ts, a.user_id, a.dispositivo, a.ua, a.nombre, a.cama, a.record_id, a.diff
        from public.audit_log a
       where a.tabla = 'notes' and a.op = 'UPDATE' and a.ts > now() - interval '25 minutes'
    ), cambios as (
      -- textos de la nota, la 🌙 Guardia y la 🕓 Cronología (pl_audit los guarda como texto plano). La Cronología solo
      -- la escribe la base y solo crece: está para que el paso de las 06:15 (Guardia → Cronología) cuente como mudanza.
      select b.id, x.k as campo, false as es_ck, b.diff -> x.k ->> 'de' as de, b.diff -> x.k ->> 'a' as a, b.diff -> x.k ->> 'a' as a_txt
        from base b, (values ('app'), ('pa'), ('drenajes'), ('qx'), ('manejo'), ('sangrado'), ('sv'), ('balance'), ('pendientes'), ('misc'), ('entrega'),
                             ('cronologia')) x(k)
       where jsonb_typeof(b.diff -> x.k) = 'object' and not ((b.diff -> x.k) ? 'tipo')
      union all
      -- todas las llaves del checklist (pl_audit guarda el JSON de cada llave)
      select b.id, 'ck:' || c.k, true, b.diff -> 'checklist' -> c.k ->> 'de', b.diff -> 'checklist' -> c.k ->> 'a',
             case when left(coalesce(b.diff -> 'checklist' -> c.k ->> 'a', ''), 1) = '"'
                  then public.pl_json_texto(b.diff -> 'checklist' -> c.k ->> 'a') else b.diff -> 'checklist' -> c.k ->> 'a' end
        from base b, jsonb_object_keys(case when jsonb_typeof(b.diff -> 'checklist') = 'object' then b.diff -> 'checklist' else '{}'::jsonb end) c(k)
       where c.k not like '\_\_%'
    ), todo_lo_nuevo as (
      select id, string_agg(coalesce(a_txt, ''), E'\n') as a_todo from cambios group by id
    ), perdidas as (
      select c.id, c.campo,
             case when c.es_ck then public.pl_ck_perdidos(substr(c.campo, 4), c.de, c.a, t.a_todo)
                  else (select count(*)::int from unnest(string_to_array(coalesce(c.de, ''), E'\n')) l
                         where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
                           and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(t.a_todo, E'\n')) z))) end as quitados
        from cambios c join todo_lo_nuevo t on t.id = c.id
    ), ev as (
      -- un evento por guardado con pérdida
      select b.id, b.ts, b.user_id, b.dispositivo, b.ua, b.nombre, b.cama, b.record_id,
             sum(p.quitados)::int as quitados, array_agg(p.campo order by p.campo) as campos
        from perdidas p join base b on b.id = p.id
       where p.quitados > 0
       group by b.id, b.ts, b.user_id, b.dispositivo, b.ua, b.nombre, b.cama, b.record_id
    ), ventanas as (
      -- ventana móvil: desde cada pérdida, los 2 min siguientes del MISMO equipo, con ≥ 3 camas
      select e.user_id, e.dispositivo, e.ua, e.ts as w_ini, max(x.ts) as w_fin
        from ev e join ev x
          on x.user_id is not distinct from e.user_id and x.dispositivo is not distinct from e.dispositivo
         and x.ua is not distinct from e.ua and x.ts >= e.ts and x.ts <= e.ts + interval '2 minutes'
       group by e.id, e.user_id, e.dispositivo, e.ua, e.ts
      having count(distinct x.record_id) >= 3
    ), marcadas as (
      -- las ventanas que se enciman forman una sola ráfaga
      select v.*, case when max(v.w_fin) over w_prev is null or v.w_ini > max(v.w_fin) over w_prev then 1 else 0 end as nueva
        from ventanas v
      window w_prev as (partition by v.user_id, v.dispositivo, v.ua order by v.w_ini, v.w_fin rows between unbounded preceding and 1 preceding)
    ), islas as (
      select m.*, sum(m.nueva) over (partition by m.user_id, m.dispositivo, m.ua order by m.w_ini, m.w_fin) as isla from marcadas m
    ), grupos as (
      select i.user_id, i.dispositivo, i.ua, min(i.w_ini) as desde, max(i.w_fin) as hasta
        from islas i group by i.user_id, i.dispositivo, i.ua, i.isla
    )
    select g.user_id, g.dispositivo, g.ua, g.desde, g.hasta, max(e.nombre) as nombre,
           count(distinct e.record_id)::int as camas, sum(e.quitados)::int as renglones,
           (select jsonb_agg(distinct jsonb_build_object('cama', e2.cama, 'campo', c2.campo))
              from ev e2 cross join lateral unnest(e2.campos) c2(campo)
             where e2.user_id is not distinct from g.user_id and e2.dispositivo is not distinct from g.dispositivo
               and e2.ua is not distinct from g.ua and e2.ts between g.desde and g.hasta) as detalle
      from grupos g
      join ev e on e.user_id is not distinct from g.user_id and e.dispositivo is not distinct from g.dispositivo
               and e.ua is not distinct from g.ua and e.ts between g.desde and g.hasta
     group by g.user_id, g.dispositivo, g.ua, g.desde, g.hasta
  loop
    if not exists (select 1 from public.perdidas_alerta p
                    where p.dispositivo is not distinct from r.dispositivo
                      and ((p.user_id is not distinct from r.user_id and p.ua is not distinct from r.ua)
                           or (p.user_id is null and p.ua is null))     -- alertas de la versión anterior (sin user_id/ua)
                      and p.desde <= r.hasta and p.hasta >= r.desde) then
      insert into public.perdidas_alerta (dispositivo, nombre, desde, hasta, camas, renglones, detalle, user_id, ua)
      values (r.dispositivo, r.nombre, r.desde, r.hasta, r.camas, r.renglones, r.detalle, r.user_id, r.ua);
      n := n + 1;
    end if;
  end loop;
  return n;
end $fn$;
-- Permisos sin cambio (create or replace los conserva): solo postgres y service_role. Cron sin cambio:
--   alarma-perdidas · '3,13,23,33,43,53 * * * *' · select public.pl_detectar_perdidas()

-- REVERSA (objetos nuevos): drop function if exists public.pl_ck_perdidos(text, text, text, text);  (después de reponer la anterior)
--   Las columnas perdidas_alerta.user_id/ua pueden quedarse (la versión anterior no las usa).

-- ▼▼▼ REVERSA AUTOMÁTICA (armar_reversas.py) ▼▼▼
-- Para volver atrás: quitar los «-- » de abajo y correrlo (create or replace con la definición de producción).
-- Las tablas, triggers y permisos nuevos de este archivo se quitan con las líneas «REVERSA (objetos nuevos)» de arriba.
-- -- pl_detectar_perdidas() · cuerpo de valsql/script.sql · md5(prosrc) 0d3711209f5c7baacca6bea7eab200cf
-- CREATE OR REPLACE FUNCTION public.pl_detectar_perdidas()
--  RETURNS integer
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare n int := 0; r record;
-- begin
--   for r in
--     with cambios as (
--       select a.id, a.ts, a.dispositivo, a.nombre, a.cama, a.record_id, f.campo, f.de, f.a
--         from public.audit_log a,
--         lateral (
--           select x.k as campo, a.diff -> x.k ->> 'de' as de, a.diff -> x.k ->> 'a' as a
--             from (values ('pendientes'), ('manejo'), ('app'), ('pa'), ('misc'), ('entrega')) x(k) where a.diff ? x.k
--           union all
--           select 'ck:' || c.k, public.pl_json_texto(a.diff -> 'checklist' -> c.k ->> 'de'), public.pl_json_texto(a.diff -> 'checklist' -> c.k ->> 'a')
--             from jsonb_object_keys(case when jsonb_typeof(a.diff -> 'checklist') = 'object' then a.diff -> 'checklist' else '{}'::jsonb end) c(k)
--            where c.k in ('interconsultas', 'cultivos', 'pendientes_mips', 'pendientes_r1', 'recibo') or c.k like 'nota\_%'
--         ) f
--        where a.tabla = 'notes' and a.op = 'UPDATE' and a.ts > now() - interval '25 minutes'
--     ), todo_lo_nuevo as (
--       select id, string_agg(coalesce(a, ''), E'\n') as a_todo from cambios group by id
--     ), perdidas as (
--       select c.*, (select count(*) from unnest(string_to_array(coalesce(c.de, ''), E'\n')) l
--                     where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
--                       and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(t.a_todo, E'\n')) z))) as quitados
--         from cambios c join todo_lo_nuevo t on t.id = c.id
--     ), grupos as (
--       select dispositivo, max(nombre) as nombre, date_bin('2 minutes', ts, timestamptz '2026-01-01') as ventana,
--              min(ts) as desde, max(ts) as hasta, count(distinct record_id) as camas, sum(quitados) as renglones,
--              jsonb_agg(distinct jsonb_build_object('cama', cama, 'campo', campo)) as detalle
--         from perdidas where quitados > 0
--        group by dispositivo, date_bin('2 minutes', ts, timestamptz '2026-01-01')
--     )
--     select * from grupos where camas >= 3
--   loop
--     if not exists (select 1 from public.perdidas_alerta p where p.dispositivo is not distinct from r.dispositivo and p.desde <= r.hasta and p.hasta >= r.desde) then
--       insert into public.perdidas_alerta (dispositivo, nombre, desde, hasta, camas, renglones, detalle)
--       values (r.dispositivo, r.nombre, r.desde, r.hasta, r.camas, r.renglones, r.detalle);
--       n := n + 1;
--     end if;
--   end loop;
--   return n;
-- end $function$
-- ;
-- ▲▲▲ FIN DE LA REVERSA ▲▲▲
