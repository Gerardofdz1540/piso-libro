-- ═══ N3 · Labs que no se pierden: notes_preserve_lab_history (20 oct 2026, P0-03 de la revisión integral) ═══════
-- Por qué: scripts/supabase_preserve_lab_history.sql (oct 2026) existe en el repo y la documentación lo da por
-- instalado, pero en producción NO está (verificado el 20 oct en pg_trigger). Un equipo con copia vieja de la nota
-- sube su lista corta de labs y borra fechas en la nube (bitácora: 15 → 11, 5 → 0…; prueba en producción con raise
-- exception: rev_integral/convergencia/sql_guardia_15min_y_labs.sql, «p3_fechas_labs_tras_copia_vieja=1»). La app
-- une con la nube antes de subir (_labHistoryUnionRemote), pero si esa lectura falla sube la lista local tal cual
-- (falla abierta, index.html:11694): esta es la red de la base.
-- Regla (la misma del script del repo, con dos ajustes):
--   · Al actualizar notes.lab_history, toda fecha que ya estaba y no viene en la lista nueva SE CONSERVA (se agrega
--     al final con su valor guardado).
--   · Solo se quita una fecha si está en checklist.__lab_deleted del MISMO guardado (botón «Eliminar labs»:
--     deleteLabDate manda lab_history sin la fecha + __lab_deleted con la fecha; index.html:21470-21488).
--     «Del mismo guardado» (20 oct 2026, R3 de la revisión de datos): la lápida no estaba en OLD.__lab_deleted, o
--     NEW.__lab_deleted_labs[fecha] es igual a los labs que la base tiene en esa fecha (deleteLabDate guarda ahí lo que
--     la persona veía al borrar). Una lápida vieja heredada (la lista vive para siempre en el checklist y la app no la
--     quita cuando la fecha vuelve a llenarse) ya no deja que una copia vieja borre los resultados nuevos.
--   · Una fecha que sí viene con otro valor (valor corregido) queda con el valor NUEVO: aquí solo se cuidan fechas.
--   · Si lab_history llega en null o no es arreglo, queda el guardado.
--   · Ajuste 1: con set_config('pl.entrega_libre','on',true) no hace nada: es el permiso de los procesos de la base y
--     del mantenimiento por SQL (p. ej. quitar labs que se cargaron a otro paciente). La otra forma de purgar es
--     agregar la fecha a checklist.__lab_deleted en el mismo UPDATE.
--   · Ajuste 2: un null dentro de __lab_deleted se ignora (con «= any» un null volvía nula la comparación y TODAS las
--     fechas faltantes se perdían).
--   · Cuando repone fechas marca set_config('pl.modificado','on',true): pl_zz_sin_cambios (N4) no suprime ese
--     UPDATE y el equipo con la copia corta recibe la lista completa. Sin N4 la marca no hace nada.
-- Es «before update OF lab_history»: un UPDATE que no manda lab_history no lo toca. Corre antes que los pl_* (orden
-- alfabético) y no depende de ellos: lee __lab_deleted tal como lo mandó el cliente.
-- Los robots no escriben notes.lab_history (el de labs escribe winlab_labs; el del censo solo borra notas), así que
-- no les cambia nada.
-- Se puede volver a correr (create or replace / drop trigger if exists).
-- Reversa: drop trigger if exists notes_preserve_lab_history on public.notes;
--          drop function if exists public.notes_preserve_lab_history();
create or replace function public.notes_preserve_lab_history() returns trigger
language plpgsql set search_path = public as $fn$
declare deleted text[]; old_deleted text[]; del_labs jsonb; faltan jsonb;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if old.lab_history is null or jsonb_typeof(old.lab_history) <> 'array' or jsonb_array_length(old.lab_history) = 0 then return new; end if;
  if new.lab_history is null or jsonb_typeof(new.lab_history) <> 'array' then
    new.lab_history := old.lab_history;
    perform set_config('pl.modificado', 'on', true);
    return new;
  end if;
  select coalesce(array_agg(x), '{}') into deleted
    from jsonb_array_elements_text(case when jsonb_typeof(new.checklist -> '__lab_deleted') = 'array'
                                        then new.checklist -> '__lab_deleted' else '[]'::jsonb end) x
   where x is not null;
  -- 20 oct 2026 (R3 de la revisión de datos): __lab_deleted guarda hasta 100 fechas para siempre y NEW la trae en
  -- CUALQUIER guardado (sin checklist en el cuerpo, NEW.checklist = OLD.checklist; con checklist, la app la copia de la
  -- nube). Y la app no quita la lápida cuando la fecha vuelve a llenarse (resultados nuevos del robot, «+ fecha»): una
  -- copia vieja sin esa fecha la borraba de la base. Por eso una lápida solo vale si es de ESTE guardado (no estaba en
  -- OLD) o si __lab_deleted_labs[fecha] (lo que la persona veía al borrar, deleteLabDate) es lo que la base tiene hoy en
  -- esa fecha: entonces borró ESTOS resultados. Si no, la lápida es de otros resultados, viejos, y la fecha se queda.
  select coalesce(array_agg(x), '{}') into old_deleted
    from jsonb_array_elements_text(case when jsonb_typeof(old.checklist -> '__lab_deleted') = 'array'
                                        then old.checklist -> '__lab_deleted' else '[]'::jsonb end) x
   where x is not null;
  del_labs := case when jsonb_typeof(new.checklist -> '__lab_deleted_labs') = 'object' then new.checklist -> '__lab_deleted_labs' else '{}'::jsonb end;
  select jsonb_agg(o order by ord) into faltan
    from jsonb_array_elements(old.lab_history) with ordinality s(o, ord)
   where coalesce(o ->> 'fecha', '') <> ''
     and not exists (select 1 from jsonb_array_elements(new.lab_history) n where n ->> 'fecha' = o ->> 'fecha')
     and not ((o ->> 'fecha') = any (deleted)
              and (not ((o ->> 'fecha') = any (old_deleted))
                   or (del_labs -> (o ->> 'fecha')) is not distinct from coalesce(o -> 'labs', '{}'::jsonb)));
  if faltan is not null then
    new.lab_history := new.lab_history || faltan;
    perform set_config('pl.modificado', 'on', true);
  end if;
  return new;
end $fn$;
revoke all on function public.notes_preserve_lab_history() from public, anon, authenticated;

drop trigger if exists notes_preserve_lab_history on public.notes;
create trigger notes_preserve_lab_history before update of lab_history on public.notes
  for each row execute function public.notes_preserve_lab_history();
