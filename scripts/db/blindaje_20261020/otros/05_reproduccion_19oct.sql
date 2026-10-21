-- ═══ O5 · ¿Qué habrían dicho la alarma vieja y la nueva sobre la ráfaga REAL del 19/10 08:43? (20 oct 2026) ═══════
-- Por qué: la alarma se instaló el 20/10 a las 09:22 UTC, después de la ráfaga, así que nunca la vio. Estas dos
-- consultas son SOLO LECTURA (SELECT, sin escribir nada): recorren la bitácora de producción en la ventana que habría
-- visto la corrida de las 14:53 UTC del 19/10 (08:53 León: los 25 min anteriores) con la lógica VIEJA (copia de
-- pl_detectar_perdidas de producción, md5 0d3711209f5c7baacca6bea7eab200cf) y con la NUEVA (05_alarma_perdidas.sql con
-- pl_ck_perdidos escrito en línea, porque esa función todavía no existe en producción). Solo devuelven camas, nombres de
-- caja, equipo y conteos: ni nombres de pacientes ni el contenido de las cajas.
-- La misma consulta NUEVA se compara en local contra pl_detectar_perdidas() sobre los escenarios de
-- 05_alarma_perdidas_pruebas.sql (correr_todo.sh, paso «equivalencia») para asegurar que es la misma lógica.
-- Marcas: __DESDE__ y __HASTA__ (las reemplaza quien la corre).

-- ── A) lógica VIEJA (date_bin de 2 min por dispositivo, 6 textos + 5 cajas de texto) ──────────────────────────
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
   where a.tabla = 'notes' and a.op = 'UPDATE' and a.ts > __DESDE__ and a.ts <= __HASTA__
), todo_lo_nuevo as (
  select id, string_agg(coalesce(a, ''), E'\n') as a_todo from cambios group by id
), perdidas as (
  select c.*, (select count(*) from unnest(string_to_array(coalesce(c.de, ''), E'\n')) l
                where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
                  and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(t.a_todo, E'\n')) z))) as quitados
    from cambios c join todo_lo_nuevo t on t.id = c.id
), grupos as (
  select dispositivo, date_bin('2 minutes', ts, timestamptz '2026-01-01') as ventana,
         min(ts) as desde, max(ts) as hasta, count(distinct record_id) as camas, sum(quitados) as renglones,
         (select string_agg(distinct x, ' ') from unnest(array_agg(campo)) x) as campos
    from perdidas where quitados > 0
   group by dispositivo, date_bin('2 minutes', ts, timestamptz '2026-01-01')
)
select 'VIEJA' as logica, dispositivo, null::text as equipo, desde, hasta, camas, renglones, campos, (camas >= 3) as alerta
  from grupos order by desde;

-- ── B) lógica NUEVA (05_alarma_perdidas.sql) ──────────────────────────────────────────────────────────────────
with base as (
  select a.id, a.ts, a.user_id, a.dispositivo, a.ua, a.nombre, a.cama, a.record_id, a.diff
    from public.audit_log a
   where a.tabla = 'notes' and a.op = 'UPDATE' and a.ts > __DESDE__ and a.ts <= __HASTA__
), cambios as (
  select b.id, x.k as campo, false as es_ck, b.diff -> x.k ->> 'de' as de, b.diff -> x.k ->> 'a' as a, b.diff -> x.k ->> 'a' as a_txt
    from base b, (values ('app'), ('pa'), ('drenajes'), ('qx'), ('manejo'), ('sangrado'), ('sv'), ('balance'), ('pendientes'), ('misc'), ('entrega'),
                         ('cronologia')) x(k)
   where jsonb_typeof(b.diff -> x.k) = 'object' and not ((b.diff -> x.k) ? 'tipo')
  union all
  select b.id, 'ck:' || c.k, true, b.diff -> 'checklist' -> c.k ->> 'de', b.diff -> 'checklist' -> c.k ->> 'a',
         case when left(coalesce(b.diff -> 'checklist' -> c.k ->> 'a', ''), 1) = '"'
              then public.pl_json_texto(b.diff -> 'checklist' -> c.k ->> 'a') else b.diff -> 'checklist' -> c.k ->> 'a' end
    from base b, jsonb_object_keys(case when jsonb_typeof(b.diff -> 'checklist') = 'object' then b.diff -> 'checklist' else '{}'::jsonb end) c(k)
   where c.k not like '\_\_%'
), todo_lo_nuevo as (
  select id, string_agg(coalesce(a_txt, ''), E'\n') as a_todo from cambios group by id
), perdidas as (
  select c.id, c.campo,
    case when not c.es_ck then
           (select count(*)::int from unnest(string_to_array(coalesce(c.de, ''), E'\n')) l
             where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
               and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(t.a_todo, E'\n')) z)))
         -- pl_ck_perdidos(k, de, a, otros) en línea
         when coalesce(c.de, '') = '' then 0
         when left(ltrim(c.de), 1) = '[' then
           case when exists (select 1 from regexp_matches(c.de, '"id"\s*:\s*"?([^",}\s]+)', 'g'))
                then (select count(*)::int from (select distinct m[1] as x from regexp_matches(c.de, '"id"\s*:\s*"?([^",}\s]+)', 'g') m) d
                       where not (d.x = any (array(select m2[1] from regexp_matches(coalesce(c.a, ''), '"id"\s*:\s*"?([^",}\s]+)', 'g') m2))))
                when c.de is json array
                then greatest(jsonb_array_length(c.de::jsonb) - case when coalesce(c.a, '') is json array then jsonb_array_length(c.a::jsonb) else 0 end, 0)
                else 0 end
         when left(c.de, 1) = '"' then
           case when substr(c.campo, 4) in ('interconsultas', 'cultivos', 'pendientes_mips', 'pendientes_r1', 'recibo') or substr(c.campo, 4) like 'nota\_%'
                then (select count(*)::int from unnest(string_to_array(coalesce(public.pl_json_texto(c.de), ''), E'\n')) l
                       where btrim(l) <> '' and not public.pl_es_auto_entrega(l)
                         and not (btrim(l) = any (select btrim(z) from unnest(string_to_array(coalesce(t.a_todo, ''), E'\n')) z)))
                when btrim(coalesce(public.pl_json_texto(c.de), '')) <> ''
                     and btrim(coalesce(case when left(coalesce(c.a, ''), 1) = '"' then public.pl_json_texto(c.a) else coalesce(c.a, '') end, '')) in ('', 'null')
                     and position(to_jsonb(btrim(public.pl_json_texto(c.de)))::text in coalesce(t.a_todo, '')) = 0
                     and not (btrim(public.pl_json_texto(c.de)) = any (select btrim(z) from unnest(string_to_array(coalesce(t.a_todo, ''), E'\n')) z))
                then 1 else 0 end
         when c.de = 'true' and coalesce(c.a, '') in ('', 'false', 'null', '""') then 1
         when c.de ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' and coalesce(c.a, '') in ('', 'null', '""') then 1
         else 0 end as quitados
    from cambios c join todo_lo_nuevo t on t.id = c.id
), ev as (
  select b.id, b.ts, b.user_id, b.dispositivo, b.ua, b.nombre, b.cama, b.record_id,
         sum(p.quitados)::int as quitados, array_agg(p.campo order by p.campo) as campos
    from perdidas p join base b on b.id = p.id
   where p.quitados > 0
   group by b.id, b.ts, b.user_id, b.dispositivo, b.ua, b.nombre, b.cama, b.record_id
), ventanas as (
  select e.user_id, e.dispositivo, e.ua, e.ts as w_ini, max(x.ts) as w_fin
    from ev e join ev x
      on x.user_id is not distinct from e.user_id and x.dispositivo is not distinct from e.dispositivo
     and x.ua is not distinct from e.ua and x.ts >= e.ts and x.ts <= e.ts + interval '2 minutes'
   group by e.id, e.user_id, e.dispositivo, e.ua, e.ts
  having count(distinct x.record_id) >= 3
), marcadas as (
  select v.*, case when max(v.w_fin) over w_prev is null or v.w_ini > max(v.w_fin) over w_prev then 1 else 0 end as nueva
    from ventanas v
  window w_prev as (partition by v.user_id, v.dispositivo, v.ua order by v.w_ini, v.w_fin rows between unbounded preceding and 1 preceding)
), islas as (
  select m.*, sum(m.nueva) over (partition by m.user_id, m.dispositivo, m.ua order by m.w_ini, m.w_fin) as isla from marcadas m
), grupos as (
  select i.user_id, i.dispositivo, i.ua, min(i.w_ini) as desde, max(i.w_fin) as hasta
    from islas i group by i.user_id, i.dispositivo, i.ua, i.isla
)
select 'NUEVA' as logica, g.dispositivo,
       case when g.user_id is null then 'sin usuario' else 'usuario ' || left(md5(g.user_id::text), 6) end || ' · ' || left(coalesce(g.ua, '∅'), 40) as equipo,
       g.desde, g.hasta, count(distinct e.record_id)::int as camas, sum(e.quitados)::int as renglones,
       (select string_agg(distinct c2, ' ') from ev e2, unnest(e2.campos) c2
         where e2.user_id is not distinct from g.user_id and e2.dispositivo is not distinct from g.dispositivo
           and e2.ua is not distinct from g.ua and e2.ts between g.desde and g.hasta) as campos,
       true as alerta
  from grupos g
  join ev e on e.user_id is not distinct from g.user_id and e.dispositivo is not distinct from g.dispositivo
           and e.ua is not distinct from g.ua and e.ts between g.desde and g.hasta
 group by g.user_id, g.dispositivo, g.ua, g.desde, g.hasta
 order by g.desde;
