-- ═══ R08_O3_listas_compartidas · reversa de O3 (otros/03_listas_compartidas.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás O3 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. pl_respaldo_hora vuelve a la de producción (solo notas y pacientes); se quitan las copias al borrar. Las tablas
-- borrados_otros y respaldo_hora_otros, con lo que tengan, se quedan (borrarlas es R99).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V08 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.pl_respaldo_hora()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
drop trigger if exists pl_borrados_otros on public.no_olvidar;
drop trigger if exists pl_borrados_otros on public.procedimientos_dia;
drop function if exists public.pl_borrados_otros();
drop function if exists public.pl_respaldo_hora_otros();
do $r$
begin
  if to_regprocedure('public.pl_archive_eliminados()') is null then drop function if exists public.pl_quien(); end if;
end $r$;
reset lock_timeout;

select 'R08_O3_listas_compartidas · O3 revertido' as reversa,
       (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pl_respaldo_hora()')) = '44e66b43269ce1f9befa4006cfd058f2'
   and to_regprocedure('public.pl_borrados_otros()') is null
   and to_regprocedure('public.pl_respaldo_hora_otros()') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.no_olvidar'::regclass and tgname = 'pl_borrados_otros')
   and not exists (select 1 from pg_trigger where tgrelid = 'public.procedimientos_dia'::regclass and tgname = 'pl_borrados_otros') as ok;
