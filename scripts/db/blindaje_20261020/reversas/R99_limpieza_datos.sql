-- ═══ R99 · limpieza OPCIONAL de las tablas y columnas nuevas (20 oct 2026) ════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py. Por qué: R01…R12 quitan el COMPORTAMIENTO sin borrar datos; lo que esas
-- tablas guardaron (filas borradas de la Papelera y de las listas, copias horarias, quién avisó cada alerta) puede
-- servir después de revertir. Esto BORRA esos datos: correrlo solo cuando ya no hagan falta. Si se quieren
-- conservar, antes: create table public.archive_eliminados_2026_10_20 as table public.archive_eliminados; (ídem las demás).
-- Se detiene si todavía hay una función que escribe en ellas (correr antes R07, R08 y R10).
-- 20 oct 2026 (revisión de operación): notes.restaurada_en ya no la borra R06 (las reversas no borran datos); se borra
-- aquí cuando ni N5 ni la restauración la usan. drop table / alter table toman ACCESS EXCLUSIVE: lock_timeout de 5 s.

set lock_timeout = '5s';
do $r$
begin
  if to_regprocedure('public.pl_archive_eliminados()') is not null or to_regprocedure('public.pl_borrados_otros()') is not null
     or to_regprocedure('public.pl_respaldo_hora_otros()') is not null or to_regprocedure('public.pl_ck_perdidos(text,text,text,text)') is not null then
    raise exception 'R99: todavía hay funciones de O2/O3/O5 que usan estas tablas: correr antes R07, R08 y R10';
  end if;
end $r$;
drop table if exists public.archive_eliminados;
drop table if exists public.borrados_otros;
drop table if exists public.respaldo_hora_otros;
alter table public.perdidas_alerta drop column if exists user_id, drop column if exists ua;
do $r$
begin
  -- notes.restaurada_en (la crean N5 y O2): solo si ya no está N5 y restore_note_from_archive no la escribe.
  if to_regprocedure('public.pl_restaurada_protegida()') is null
     and (select prosrc from pg_proc where oid = 'public.restore_note_from_archive(uuid)'::regprocedure) not like '%restaurada_en%' then
    alter table public.notes drop column if exists restaurada_en;
  end if;
end $r$;
reset lock_timeout;

select 'R99 · limpieza' as reversa,
       to_regclass('public.archive_eliminados') is null and to_regclass('public.borrados_otros') is null and to_regclass('public.respaldo_hora_otros') is null
   and not exists (select 1 from pg_attribute where attrelid = 'public.perdidas_alerta'::regclass and attname in ('user_id', 'ua') and not attisdropped)
   and (to_regprocedure('public.pl_restaurada_protegida()') is not null
        or not exists (select 1 from pg_attribute where attrelid = 'public.notes'::regclass and attname = 'restaurada_en' and not attisdropped)) as ok;
