-- ═══ R04_N3_labs_sin_perdidas · reversa de N3 (notas/03_labs_sin_perdidas.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N3 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. Quita el trigger de labs (como hoy en producción).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V04 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
drop trigger if exists notes_preserve_lab_history on public.notes;
drop function if exists public.notes_preserve_lab_history();
reset lock_timeout;

select 'R04_N3_labs_sin_perdidas · N3 revertido' as reversa,
       to_regprocedure('public.notes_preserve_lab_history()') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'notes_preserve_lab_history') as ok;
