-- ═══ R03_N2_guardia_otro_usuario · reversa de N2 (notas/02_guardia_otro_usuario.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N2 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. Vuelve pl_entrega_protegida() a la de producción (otro equipo = dispositivo|navegador; sin marcas pl.modificado:
-- con N4 instalado, una Guardia revertida por la protección deja de reenviarse al equipo, sin perder nada).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V03 pasa a dar ok = false.

CREATE OR REPLACE FUNCTION public.pl_entrega_protegida()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  old_e text := coalesce(old.checklist #>> '{__pl_note_meta,entrega}', '');
  new_e text := coalesce(new.checklist #>> '{__pl_note_meta,entrega}', '');
  modo text := coalesce(new.checklist #>> '{__pl_note_meta,by,entrega,m}', '');
  old_t timestamptz; new_t timestamptz;
  deliberado boolean := false;
  hdr jsonb; mi_equipo text;
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
  if new.cronologia is distinct from old.cronologia then new.cronologia := old.cronologia; end if;
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
    -- Renglones que otro equipo agregó en los últimos 15 min (puede que este equipo aún no los haya recibido).
    begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
    mi_equipo := coalesce(left(hdr->>'x-pl-device', 80), '') || '|' || coalesce(left(hdr->>'user-agent', 200), '');
    select coalesce(array_agg(distinct btrim(x)), '{}') into ajenos_recientes
      from public.audit_log a, unnest(string_to_array(a.diff->'entrega'->>'a', E'\n')) x
     where a.record_id = new.patient_id::text and a.tabla = 'notes' and a.ts > now() - interval '15 minutes'
       and a.diff ? 'entrega'
       and coalesce(a.dispositivo, '') || '|' || coalesce(a.ua, '') <> mi_equipo
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
  new.checklist := jsonb_set(ck, '{__pl_note_meta,entrega}', to_jsonb(resultado), true);
  return new;
end
$function$
;

select 'R03_N2_guardia_otro_usuario · N2 revertido' as reversa,
       (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.pl_entrega_protegida()')) = '0e4ee94af6b63a630f0efdac969cdc14' as ok;
