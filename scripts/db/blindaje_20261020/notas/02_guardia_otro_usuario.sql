-- ═══ N2 · 🌙 Guardia: «otro equipo» también es OTRO USUARIO (20 oct 2026, P0-05 de la revisión integral) ═══════════
-- Por qué: pl_entrega_protegida respeta, en una escritura deliberada (último cambio gana), los renglones que OTRO
-- equipo escribió en los últimos 15 min según la bitácora, porque ese equipo quizá aún no los recibe. «Equipo» era
-- x-pl-device|user-agent: dos residentes en «Mac Chrome» con el mismo navegador contaban como uno solo y el segundo
-- borraba sin saberlo el renglón recién escrito por el primero (en producción hay 2 usuarios con esa misma huella;
-- prueba local en rev_integral/regla_todas_cajas/13_prueba_equipo.sql, caso G4). Ahora un renglón de la bitácora es
-- ajeno si el equipo es distinto O si a.user_id es distinto del usuario actual.
--   · El usuario actual es auth.uid() dentro de un bloque EXCEPTION: con request.jwt.claims vacío (crons, SQL) da null
--     y con un claims corrupto no rompe el guardado (también null).
--   · «is distinct from»: con usuario desconocido (null) los renglones de cualquier usuario identificado cuentan como
--     ajenos (se protegen, no se pierden); los de filas sin usuario (robots, SQL) siguen la regla de equipo de siempre.
-- Todo lo demás es IDÉNTICO a la función de producción (md5(prosrc) 0e4ee94af6b63a630f0efdac969cdc14, la de
-- supabase_guardia_cronologia.sql), salvo dos líneas que marcan set_config('pl.modificado','on',true) cuando la
-- función cambia NEW (revierte la Cronología o reescribe la Guardia): las lee pl_zz_sin_cambios (N4) para no
-- suprimir ese UPDATE; sin N4 no hacen nada. Van aquí y no en N4 para que volver a correr este archivo después de N4
-- no las quite.
-- Se puede volver a correr (create or replace; el trigger pl_entrega_protegida ya existe y no cambia).
-- Reversa: volver a correr la definición de producción (supabase_guardia_cronologia.sql, líneas 59-167), guardada
-- antes con pg_get_functiondef('public.pl_entrega_protegida()'::regprocedure).
create or replace function public.pl_entrega_protegida() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  old_e text := coalesce(old.checklist #>> '{__pl_note_meta,entrega}', '');
  new_e text := coalesce(new.checklist #>> '{__pl_note_meta,entrega}', '');
  modo text := coalesce(new.checklist #>> '{__pl_note_meta,by,entrega,m}', '');
  old_t timestamptz; new_t timestamptz;
  deliberado boolean := false;
  hdr jsonb; mi_equipo text; mi_uid uuid;
  old_set text[]; new_set text[]; archivados text[]; borrados text[]; ajenos_recientes text[] := '{}';
  l text; t text; r text;
  en_resumen boolean := false;
  hubo_descartes boolean := false;
  agregar text[] := '{}';
  quedan text[] := '{}';
  quitar_ok text[] := '{}';
  protegidos int := 0;
  salida text[] := '{}';
  resultado text;
  ck jsonb;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  -- 🕓 Cronología: solo la base la escribe.
  if new.cronologia is distinct from old.cronologia then
    new.cronologia := old.cronologia;
    perform set_config('pl.modificado', 'on', true);   -- N4: este UPDATE no se suprime
  end if;
  if new_e = old_e then return new; end if;
  begin old_t := (old.checklist #>> '{__pl_note_meta,by,entrega,t}')::timestamptz; exception when others then old_t := null; end;
  begin new_t := (new.checklist #>> '{__pl_note_meta,by,entrega,t}')::timestamptz; exception when others then new_t := null; end;
  deliberado := new_t is not null and (old_t is null or new_t > old_t)
                and new_t > now() - interval '30 minutes' and new_t < now() + interval '10 minutes'
                and modo <> 'agregar';
  select coalesce(array_agg(btrim(x)), '{}') into old_set from unnest(string_to_array(old_e, E'\n')) x where btrim(x) <> '';
  select coalesce(array_agg(btrim(x)), '{}') into new_set from unnest(string_to_array(new_e, E'\n')) x where btrim(x) <> '';
  select coalesce(array_agg(distinct btrim(x)) filter (where c.motivo = 'corte'), '{}'),
         coalesce(array_agg(distinct btrim(x)) filter (where c.motivo = 'borrado'), '{}')
    into archivados, borrados
    from public.guardia_cortes c, unnest(c.lineas) x
   where c.patient_id = new.patient_id and c.ts > now() - interval '7 days';
  if deliberado then
    -- Renglones que otro equipo U OTRO USUARIO agregó en los últimos 15 min (puede que aún no los haya recibido).
    begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
    mi_equipo := coalesce(left(hdr->>'x-pl-device', 80), '') || '|' || coalesce(left(hdr->>'user-agent', 200), '');
    begin mi_uid := auth.uid(); exception when others then mi_uid := null; end;   -- claims vacío o corrupto → null
    select coalesce(array_agg(distinct btrim(x)), '{}') into ajenos_recientes
      from public.audit_log a, unnest(string_to_array(a.diff->'entrega'->>'a', E'\n')) x
     where a.record_id = new.patient_id::text and a.tabla = 'notes' and a.ts > now() - interval '15 minutes'
       and a.diff ? 'entrega'
       and (coalesce(a.dispositivo, '') || '|' || coalesce(a.ua, '') <> mi_equipo
            or a.user_id is distinct from mi_uid)
       and btrim(x) <> ''
       and not (btrim(x) = any (select btrim(y) from unnest(string_to_array(coalesce(a.diff->'entrega'->>'de', ''), E'\n')) y));
  end if;
  -- 1) Lo que trae el texto nuevo.
  foreach l in array string_to_array(new_e, E'\n') loop
    t := btrim(l);
    if t = '' then en_resumen := false; continue; end if;
    if t ~ '^— Resumen \d{2}/\d{2}' then
      en_resumen := true;
      if t = any(old_set) then quedan := quedan || t; else hubo_descartes := true; end if;
      continue;
    end if;
    if t = any(old_set) then quedan := quedan || t; continue; end if;
    if en_resumen or public.pl_es_auto_entrega(t) then hubo_descartes := true; continue; end if;
    if t = any(archivados) and (not deliberado or (t ~ '^\d{1,2}[/-]\d{1,2}' and length(t) >= 16)) then
      hubo_descartes := true; continue;
    end if;
    if t = any(borrados) and (not deliberado or exists (
         select 1 from unnest(new_set) x
          where x <> t and x = any(old_set) and (public.pl_guardia_gemelo(t, x) or public.pl_guardia_gemelo(x, t)))) then
      hubo_descartes := true; continue;
    end if;
    if t = any(agregar) then continue; end if;
    agregar := agregar || t;
    quedan := quedan || t;
  end loop;
  -- 2) Lo que falta del texto guardado: lo quita solo quien está editando la caja (último cambio gana), salvo lo que
  --    otro equipo acaba de escribir.
  foreach r in array old_set loop
    if r = any(new_set) or r = any(quitar_ok) then continue; end if;
    if deliberado and not (r = any(ajenos_recientes)) then
      quitar_ok := quitar_ok || r;
    else
      protegidos := protegidos + 1;
    end if;
  end loop;
  if cardinality(quitar_ok) > 0 then
    insert into public.guardia_cortes (patient_id, lineas, motivo)
      select new.patient_id, array_agg(x), 'borrado' from unnest(quitar_ok) x where x ~ '[[:alnum:]]' having count(*) > 0;
  end if;
  if protegidos = 0 and not hubo_descartes then return new; end if;
  if protegidos = 0 then
    -- Se respeta el orden de la persona; solo salen los renglones descartados.
    foreach l in array string_to_array(new_e, E'\n') loop
      if btrim(l) = '' or btrim(l) = any(quedan) then salida := salida || l; end if;
    end loop;
    resultado := rtrim(array_to_string(salida, E'\n'), E' \n');
  else
    -- Se conserva lo guardado (menos lo que la persona quitó) y lo nuevo va al final.
    foreach l in array string_to_array(old_e, E'\n') loop
      if not (btrim(l) <> '' and btrim(l) = any(quitar_ok)) then salida := salida || l; end if;
    end loop;
    resultado := rtrim(array_to_string(salida, E'\n'), E' \n');
    if cardinality(agregar) > 0 then
      resultado := case when resultado = '' then '' else resultado || E'\n' end || array_to_string(agregar, E'\n');
    end if;
  end if;
  ck := coalesce(new.checklist, '{}'::jsonb);
  if jsonb_typeof(ck -> '__pl_note_meta') is distinct from 'object' then ck := jsonb_set(ck, '{__pl_note_meta}', '{}'::jsonb, true); end if;
  ck := jsonb_set(ck, '{__pl_note_meta,entrega}', to_jsonb(resultado), true);
  if ck is distinct from new.checklist then perform set_config('pl.modificado', 'on', true); end if;   -- N4
  new.checklist := ck;
  return new;
end
$fn$;
revoke all on function public.pl_entrega_protegida() from public, anon, authenticated;
