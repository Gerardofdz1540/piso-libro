-- ═══ R02_N1_by_monotono · reversa de N1 (notas/01_by_monotono.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N1 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. pl_sello_t(jsonb) también la usa N5: solo se borra si N5 ya no está.
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V02 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
drop trigger if exists pl_by_monotono on public.notes;
drop function if exists public.pl_by_monotono();
do $r$
begin
  -- 20 oct 2026: pl_restaurada_protegida (N5) lee los sellos con pl_sello_t; sin N5 ya nadie la usa.
  if to_regprocedure('public.pl_restaurada_protegida()') is null then
    drop function if exists public.pl_sello_t(jsonb);
  end if;
end $r$;
reset lock_timeout;

select 'R02_N1_by_monotono · N1 revertido' as reversa,
       to_regprocedure('public.pl_by_monotono()') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'pl_by_monotono') as ok;
