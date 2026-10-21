-- ═══ R09_O4_borrado_masivo · reversa de O4 (otros/04_borrado_masivo.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás O4 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. Cualquier cuenta vuelve a poder borrar muchas filas de un jalón.
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V09 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
drop trigger if exists pl_borrado_masivo on public.patients;
drop trigger if exists pl_borrado_masivo on public.notes;
drop trigger if exists pl_borrado_masivo on public.no_olvidar;
drop trigger if exists pl_borrado_masivo on public.procedimientos_dia;
drop function if exists public.pl_borrado_masivo();
reset lock_timeout;

select 'R09_O4_borrado_masivo · O4 revertido' as reversa,
       to_regprocedure('public.pl_borrado_masivo()') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.patients'::regclass and tgname = 'pl_borrado_masivo')
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'pl_borrado_masivo')
   and not exists (select 1 from pg_trigger where tgrelid = 'public.no_olvidar'::regclass and tgname = 'pl_borrado_masivo')
   and not exists (select 1 from pg_trigger where tgrelid = 'public.procedimientos_dia'::regclass and tgname = 'pl_borrado_masivo') as ok;
