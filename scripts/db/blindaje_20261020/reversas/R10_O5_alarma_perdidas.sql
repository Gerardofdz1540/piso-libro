-- ═══ R10_O5_alarma_perdidas · reversa de O5 (otros/05_alarma_perdidas.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás O5 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. pl_detectar_perdidas vuelve a la de producción. perdidas_alerta.user_id/ua se quedan (la anterior no las usa; R99).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V10 pasa a dar ok = false.

CREATE OR REPLACE FUNCTION public.pl_detectar_perdidas()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
drop function if exists public.pl_ck_perdidos(text, text, text, text);

select 'R10_O5_alarma_perdidas · O5 revertido' as reversa,
       (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pl_detectar_perdidas()')) = '0d3711209f5c7baacca6bea7eab200cf'
   and to_regprocedure('public.pl_ck_perdidos(text,text,text,text)') is null as ok;
