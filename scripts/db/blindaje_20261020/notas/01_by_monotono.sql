-- ═══ N1 · Los sellos «by» de las cajas solo avanzan (20 oct 2026, paquete «notas» de la revisión integral) ═══════
-- Por qué: cada caja guarda quién y cuándo la tocó en checklist.__pl_note_meta.by.<caja> = {u, i, t[, m]}. Una copia
-- vieja (iPad dormido, cola sin red, pestaña que no se puso al día) sube su checklist con los sellos VIEJOS y los
-- regresaba en la nube. Caso real: en la 3-177 by.entrega.t pasó de 2026-10-20T10:34Z (GE) a 2026-10-18T16:29Z (PL)
-- entre las 12:07 y las 12:34 UTC. Con el sello regresado, pl_entrega_protegida toma como «deliberada» (sello más
-- nuevo que el guardado y de los últimos 30 min) la escritura atrasada de cualquier equipo cuyo sello quede entre los
-- dos, y esa escritura RESUCITA lo que alguien borró a propósito (probado en producción con un bloque DO que terminó
-- en raise exception: rev_integral/critico_riesgo/do_by_regresion.sql).
-- Regla: por cada caja de OLD.by, si NEW no la trae (o la trae en null), o su t es más vieja que la de OLD o no se
-- puede leer, queda la de OLD COMPLETA (con su u/i/m). Un sello más nuevo o con la misma hora entra tal cual.
-- Detalles (y su porqué):
--   · Si NEW no trae __pl_note_meta (o no es objeto) este trigger no lo toca: pl_checklist_sin_perdidas lo repone
--     ENTERO; si aquí se creara uno con solo «by», esa llave ya «estaría» y la Guardia (entrega) se perdería.
--   · Un sello de OLD con t ilegible o del futuro (> 10 min: reloj del equipo adelantado) no se defiende; si no, un
--     equipo con la hora mal bloquearía los guardados deliberados de esa caja hasta que el reloj real lo alcanzara.
--     Es la misma tolerancia de 10 min que usa pl_entrega_protegida.
--   · La hora se lee con pg_input_is_valid (Postgres 16+; producción es 17.6): sin bloques EXCEPTION por cada caja.
--   · Con set_config('pl.entrega_libre','on',true) (procesos de la base, mantenimiento por SQL) no hace nada.
--   · Cuando cambia NEW marca set_config('pl.modificado','on',true): pl_zz_sin_cambios (N4) no suprime ese UPDATE,
--     así el equipo atrasado recibe la fila buena (respuesta del upsert y Realtime). Sin N4 la marca no hace nada.
-- Orden: los BEFORE UPDATE de notes corren por nombre. pl_by_monotono va ANTES de pl_checklist_sin_perdidas y de
-- pl_entrega_protegida, así la Guardia decide «deliberado» con el sello ya corregido. Es «update of checklist»: un
-- UPDATE que no manda checklist no puede regresar ningún sello.
-- Se puede volver a correr (create or replace / drop trigger if exists).
-- Reversa: drop trigger if exists pl_by_monotono on public.notes;
--          drop function if exists public.pl_by_monotono(); drop function if exists public.pl_sello_t(jsonb);
--          (pl_sello_t también la usa N5: quitarla solo si N5 no está instalado.)

-- Hora de un sello {u, i, t, m} o null si no se puede leer.
create or replace function public.pl_sello_t(s jsonb) returns timestamptz
language sql stable set search_path = public as $fn$
  select case when jsonb_typeof(s) = 'object' and pg_input_is_valid(s ->> 't', 'timestamptz') then (s ->> 't')::timestamptz end
$fn$;

create or replace function public.pl_by_monotono() returns trigger
language plpgsql set search_path = public as $fn$
declare
  old_by jsonb; new_by jsonb; k text; ov jsonb; nv jsonb;
  old_t timestamptz; new_t timestamptz;
  cambio boolean := false;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if jsonb_typeof(old.checklist #> '{__pl_note_meta,by}') is distinct from 'object' then return new; end if;
  -- Sin __pl_note_meta en NEW: lo repone entero pl_checklist_sin_perdidas (aquí no se crea uno a medias).
  if jsonb_typeof(new.checklist) is distinct from 'object'
     or jsonb_typeof(new.checklist -> '__pl_note_meta') is distinct from 'object' then
    return new;
  end if;
  old_by := old.checklist #> '{__pl_note_meta,by}';
  new_by := case when jsonb_typeof(new.checklist #> '{__pl_note_meta,by}') = 'object'
                 then new.checklist #> '{__pl_note_meta,by}' else '{}'::jsonb end;
  for k, ov in select e.key, e.value from jsonb_each(old_by) e loop
    nv := new_by -> k;
    if nv is null or jsonb_typeof(nv) = 'null' then
      new_by := new_by || jsonb_build_object(k, ov); cambio := true;   -- NEW no trae el sello de esta caja
      continue;
    end if;
    old_t := public.pl_sello_t(ov);
    if old_t is null or old_t > now() + interval '10 minutes' then continue; end if;   -- ilegible o del futuro
    new_t := public.pl_sello_t(nv);
    if new_t is null or new_t < old_t then
      new_by := new_by || jsonb_build_object(k, ov); cambio := true;   -- sello más viejo o ilegible: queda el de OLD
    end if;
  end loop;
  if cambio then
    new.checklist := jsonb_set(new.checklist, '{__pl_note_meta,by}', new_by, true);
    perform set_config('pl.modificado', 'on', true);
  end if;
  return new;
end $fn$;
revoke all on function public.pl_by_monotono() from public, anon, authenticated;

drop trigger if exists pl_by_monotono on public.notes;
create trigger pl_by_monotono before update of checklist on public.notes
  for each row execute function public.pl_by_monotono();
