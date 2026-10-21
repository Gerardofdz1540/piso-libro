-- ═══ R05_N4_sin_cambios · reversa de N4 (notas/04_sin_cambios.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N4 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. N6 (REPLICA IDENTITY FULL) va encima de N4: si está, revertir antes N6 (R12, un minuto) o esta reversa se detiene.
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V05 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
do $r$
begin
  -- 20 oct 2026: FULL sin pl_zz_sin_cambios duplica el WAL de cada reescritura de labs (ver notas/06_replica_full.sql).
  if (select relreplident from pg_class where oid = 'public.notes'::regclass) = 'f' then
    raise exception 'notes está en REPLICA IDENTITY FULL (N6): correr antes reversas/R12_N6_replica_full.sql';
  end if;
end $r$;
drop trigger if exists pl_zz_sin_cambios on public.notes;
drop trigger if exists notes_sin_cambios_labs on public.notes;
drop function if exists public.pl_zz_sin_cambios();
drop function if exists public.notes_sin_cambios_labs();
drop function if exists public.pl_labs_normalizados(jsonb);
CREATE OR REPLACE FUNCTION public.pl_checklist_sin_perdidas()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
end $function$
;
reset lock_timeout;

select 'R05_N4_sin_cambios · N4 revertido' as reversa,
       to_regprocedure('public.pl_zz_sin_cambios()') is null
   and to_regprocedure('public.notes_sin_cambios_labs()') is null
   and to_regprocedure('public.pl_labs_normalizados(jsonb)') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'pl_zz_sin_cambios')
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'notes_sin_cambios_labs')
   and (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pl_checklist_sin_perdidas()')) = 'deed7c8c437a4e13404444993ef0eb50' as ok;
