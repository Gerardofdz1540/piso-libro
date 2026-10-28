-- 28 oct 2026 · aplicado en producción (migración entrega_sin_auto_al_insertar).
-- La Cronología no recibe nada automático. pl_entrega_protegida (BEFORE UPDATE) ya rechazaba las líneas automáticas
-- al EDITAR una nota, pero la PRIMERA nota de un paciente nuevo entra con INSERT y no pasaba por ahí: el 27 oct una
-- pestaña que seguía con la versión vieja de la app (Mac, Chrome) creó así la nota de un paciente recién ingresado con
-- una línea «dd-mm-aaaa: … (RIS): …». Este trigger limpia esas líneas (y un bloque «— Resumen …») también al insertar,
-- con la misma regla que pl_entrega_protegida y la restauración (pl_entrega_sin_auto). La línea que entró se quitó
-- (guardia_cortes, motivo «borrado»). Probado en una transacción revertida: al crear y al editar quedan solo los
-- renglones escritos por la gente.
create or replace function public.pl_entrega_sin_auto_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare e text; limpio text;
begin
  e := new.checklist #>> '{__pl_note_meta,entrega}';
  if e is null or btrim(e) = '' then return new; end if;
  limpio := public.pl_entrega_sin_auto(e);
  if limpio is distinct from rtrim(e, E' \n') then
    new.checklist := jsonb_set(new.checklist, '{__pl_note_meta,entrega}', to_jsonb(coalesce(limpio, '')), true);
  end if;
  return new;
end
$fn$;
revoke all on function public.pl_entrega_sin_auto_insert() from public, anon, authenticated;
create trigger pl_entrega_sin_auto_insert before insert on public.notes
  for each row execute function public.pl_entrega_sin_auto_insert();
