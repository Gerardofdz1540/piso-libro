-- Labs que nunca se pierden (oct 2026)
-- Un dispositivo con copia vieja de la nota subía su lista corta de labs y borraba fechas en la nube
-- (bitácora: 15 → 11, 5 → 0…). Este trigger garantiza en la base lo mismo que la app:
--   • al actualizar notes.lab_history, toda fecha que ya existía y no viene en la lista nueva SE CONSERVA;
--   • solo se quita una fecha si está en checklist.__lab_deleted (botón «Eliminar labs» de la app).
-- Para una purga manual por SQL (p. ej. labs de otro paciente), agregar la fecha a checklist.__lab_deleted en el
-- mismo UPDATE, o deshabilitar el trigger durante la purga.
-- Ejecutar una vez en Supabase → SQL Editor. Es idempotente.

create or replace function public.notes_preserve_lab_history() returns trigger language plpgsql as $$
declare deleted text[];
begin
  if OLD.lab_history is null or jsonb_typeof(OLD.lab_history) <> 'array' or jsonb_array_length(OLD.lab_history) = 0 then return NEW; end if;
  if NEW.lab_history is null or jsonb_typeof(NEW.lab_history) <> 'array' then NEW.lab_history := OLD.lab_history; return NEW; end if;
  select coalesce(array_agg(x), '{}') into deleted
    from jsonb_array_elements_text(case when jsonb_typeof(NEW.checklist->'__lab_deleted') = 'array' then NEW.checklist->'__lab_deleted' else '[]'::jsonb end) x;
  NEW.lab_history := NEW.lab_history || coalesce((
    select jsonb_agg(o) from jsonb_array_elements(OLD.lab_history) o
    where coalesce(o->>'fecha', '') <> ''
      and not exists (select 1 from jsonb_array_elements(NEW.lab_history) n where n->>'fecha' = o->>'fecha')
      and not ((o->>'fecha') = any(deleted))
  ), '[]'::jsonb);
  return NEW;
end $$;

drop trigger if exists notes_preserve_lab_history on public.notes;
create trigger notes_preserve_lab_history before update of lab_history on public.notes
  for each row execute function public.notes_preserve_lab_history();

-- Verificación (debe listar notes_preserve_lab_history):
-- select tgname from pg_trigger where tgrelid = 'public.notes'::regclass and not tgisinternal;
