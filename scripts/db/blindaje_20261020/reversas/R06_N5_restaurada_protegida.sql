-- ═══ R06_N5_restaurada_protegida · reversa de N5 (notas/05_restaurada_protegida.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N5 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. restore_note_from_archive: si O2 sigue instalado queda la de O2 sin restaurada_en; si no, la de producción.
-- notes.restaurada_en SE QUEDA (20 oct 2026, revisión de operación: «las reversas no borran datos»); ya nadie la
-- escribe ni la lee. Borrarla es R99, con lo demás que se limpia.
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V06 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
drop trigger if exists pl_restaurada_protegida on public.notes;
drop function if exists public.pl_restaurada_protegida();
drop function if exists public.pl_caja_con_contenido(jsonb);
do $r$
begin
  -- 20 oct 2026: antes de borrar la columna, la función ya no debe escribirla.
  if to_regprocedure('public.pl_archive_eliminados()') is not null then   -- O2 sigue: su versión, sin restaurada_en
    execute $q$create or replace function public.restore_note_from_archive(p_id uuid) returns text
language plpgsql security definer set search_path = public as $fn$
declare p patients%rowtype; a archive%rowtype; nd jsonb; n notes%rowtype; has_content boolean; merged_lh jsonb;
        b jsonb; f text; ck jsonb; bck jsonb; k text;
        sd jsonb; sb jsonb; propias text[] := '{}'; ldel text[]; bdel text[]; ldl jsonb;
begin
  select * into p from patients where id = p_id;
  if not found or nullif(btrim(coalesce(p.exp,'')),'') is null then return 'sin-exp'; end if;
  select * into a from archive
   where btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp)
     and archived_at > now() - interval '10 days'
     and (note_data->>'_restaurado_a') is null
     and (patient_data->>'_supa_id') is distinct from p_id::text
     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;
  if not found then return 'sin-archivo'; end if;
  nd := coalesce(a.note_data, '{}'::jsonb);
  -- 20 oct 2026 (P1-06): caja vacía en la copia del equipo → la de la base (_copia_base), si la hay.
  b := case when jsonb_typeof(nd->'_copia_base') = 'object' then nd->'_copia_base' end;
  if b is not null then
    -- 20 oct 2026 (R4 de la revisión de datos): salvo las cajas que el equipo cambió DESPUÉS de la versión de la base
    -- (su sello by[caja].t es más nuevo que el de la base, o la base no tiene sello de esa caja). Esas las vació la
    -- persona a propósito y su guardado aún no llegaba (egreso inmediato, o sin red: el outbox sube en lotes paralelos y
    -- el DELETE puede ir antes que la nota): no se reviven. Una copia atrasada trae un sello más viejo, igual o ninguno
    -- y se sigue rellenando (P1-06). La hora se lee aquí mismo, sin pl_sello_t (es de N1 y O2 debe funcionar solo).
    sd := case when jsonb_typeof(nd #> '{checklist,__pl_note_meta,by}') = 'object' then nd #> '{checklist,__pl_note_meta,by}' else '{}'::jsonb end;
    sb := case when jsonb_typeof(b #> '{checklist,__pl_note_meta,by}') = 'object' then b #> '{checklist,__pl_note_meta,by}' else '{}'::jsonb end;
    select coalesce(array_agg(e.key), '{}') into propias
      from jsonb_each(sd) e
     where (case when jsonb_typeof(e.value) = 'object' and pg_input_is_valid(e.value ->> 't', 'timestamptz') then (e.value ->> 't')::timestamptz end)
           > coalesce(case when jsonb_typeof(sb -> e.key) = 'object' and pg_input_is_valid(sb -> e.key ->> 't', 'timestamptz')
                           then (sb -> e.key ->> 't')::timestamptz end, '-infinity'::timestamptz);
    foreach f in array array['app', 'pa', 'drenajes', 'qx', 'manejo', 'sangrado', 'sv', 'balance', 'pendientes', 'misc', 'cronologia'] loop
      if btrim(coalesce(nd->>f, '')) = '' and not (f = any (propias)) and btrim(coalesce(b->>f, '')) <> '' then nd := nd || jsonb_build_object(f, b->f); end if;
    end loop;
    -- labs: la unión por fecha (lo del equipo primero, de la base las fechas que el equipo no tiene), salvo las que el
    -- equipo borró a propósito con «Eliminar labs» (20 oct 2026, R4): en su __lab_deleted y, si la base ya tenía esa
    -- lápida, con los mismos labs que la base tiene hoy en esa fecha (la regla de N3: una lápida vieja de otros
    -- resultados no cuenta). Labs de otro paciente borrados a propósito no vuelven con el reingreso.
    if jsonb_typeof(b->'labHistory') = 'array' then
      select coalesce(array_agg(x), '{}') into ldel
        from jsonb_array_elements_text(case when jsonb_typeof(nd #> '{checklist,__lab_deleted}') = 'array' then nd #> '{checklist,__lab_deleted}' else '[]'::jsonb end) x
       where x is not null;
      select coalesce(array_agg(x), '{}') into bdel
        from jsonb_array_elements_text(case when jsonb_typeof(b #> '{checklist,__lab_deleted}') = 'array' then b #> '{checklist,__lab_deleted}' else '[]'::jsonb end) x
       where x is not null;
      ldl := case when jsonb_typeof(nd #> '{checklist,__lab_deleted_labs}') = 'object' then nd #> '{checklist,__lab_deleted_labs}' else '{}'::jsonb end;
      select coalesce(jsonb_agg(e), '[]'::jsonb) into merged_lh from (
        select e from jsonb_array_elements(case when jsonb_typeof(nd->'labHistory') = 'array' then nd->'labHistory' else '[]'::jsonb end) e
        union all
        select e from jsonb_array_elements(b->'labHistory') e
         where not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(nd->'labHistory') = 'array' then nd->'labHistory' else '[]'::jsonb end) x
                            where x->>'fecha' = e->>'fecha')
           and not (coalesce((e->>'fecha') = any (ldel), false)
                    and (not coalesce((e->>'fecha') = any (bdel), false)
                         or (ldl -> (e->>'fecha')) is not distinct from coalesce(e->'labs', '{}'::jsonb)))) s;
      nd := nd || jsonb_build_object('labHistory', merged_lh);
    end if;
    if jsonb_array_length(case when jsonb_typeof(nd->'imagenHistory') = 'array' then nd->'imagenHistory' else '[]'::jsonb end) = 0
       and jsonb_typeof(b->'imagenHistory') = 'array' then
      nd := nd || jsonb_build_object('imagenHistory', b->'imagenHistory');
    end if;
    -- checklist: cada caja que falta o está vacía ("", [], {}, null) en la del equipo. Las casillas (true/false) y los
    -- números del equipo se respetan: false no es «vacío».
    ck := case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end;
    bck := case when jsonb_typeof(b->'checklist') = 'object' then b->'checklist' else '{}'::jsonb end;
    for k in select jsonb_object_keys(bck) loop
      if (not (ck ? k) or ck->k in ('""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'null'::jsonb))
         and bck->k not in ('""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
         and not (k = any (propias)) then   -- R4: la persona la vació después de la versión de la base
        ck := ck || jsonb_build_object(k, bck->k);
      end if;
    end loop;
    if jsonb_typeof(ck->'__pl_note_meta') = 'object' and jsonb_typeof(bck->'__pl_note_meta') = 'object'
       and btrim(coalesce(ck #>> '{__pl_note_meta,entrega}', '')) = '' and btrim(coalesce(bck #>> '{__pl_note_meta,entrega}', '')) <> ''
       and not ('entrega' = any (propias)) then
      ck := jsonb_set(ck, '{__pl_note_meta,entrega}', bck #> '{__pl_note_meta,entrega}');
    end if;
    nd := nd || jsonb_build_object('checklist', ck);
  end if;
  has_content := jsonb_array_length(coalesce(nd->'labHistory','[]'::jsonb)) > 0
              or jsonb_array_length(coalesce(nd->'imagenHistory','[]'::jsonb)) > 0
              or coalesce(nd->>'pendientes','') <> '' or coalesce(nd->>'app','') <> '' or coalesce(nd->>'pa','') <> ''
              or coalesce(nd->>'qx','') <> '' or coalesce(nd->>'manejo','') <> '' or coalesce(nd->>'drenajes','') <> ''
              or coalesce(nd->>'balance','') <> '' or coalesce(nd->>'sv','') <> '' or coalesce(nd->>'sangrado','') <> ''
              or coalesce(nd->>'cronologia','') <> ''
              or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
  if not has_content then return 'archivo-vacio'; end if;
  select * into n from notes where patient_id = p_id;
  if not found then
    perform set_config('pl.entrega_libre', 'on', true);
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore');
    perform set_config('pl.entrega_libre', 'off', true);
  else
    select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
      select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
      union all
      select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
       where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
    ) s;
    -- La Cronología solo la escribe la base (20 oct 2026): para reponerla desde la Papelera hace falta el permiso
    -- de esta transacción; se apaga justo después. La Guardia actual gana (checklist actual || archivo).
    if coalesce(n.cronologia,'') = '' and coalesce(nd->>'cronologia','') <> '' then
      perform set_config('pl.entrega_libre', 'on', true);
    end if;
    update notes set
      app = case when coalesce(n.app,'') = '' then coalesce(nd->>'app','') else n.app end,
      pa = case when coalesce(n.pa,'') = '' then coalesce(nd->>'pa','') else n.pa end,
      drenajes = case when coalesce(n.drenajes,'') = '' then coalesce(nd->>'drenajes','') else n.drenajes end,
      qx = case when coalesce(n.qx,'') = '' then coalesce(nd->>'qx','') else n.qx end,
      manejo = case when coalesce(n.manejo,'') = '' then coalesce(nd->>'manejo','') else n.manejo end,
      sangrado = case when coalesce(n.sangrado,'') = '' then coalesce(nd->>'sangrado','') else n.sangrado end,
      sv = case when coalesce(n.sv,'') = '' then coalesce(nd->>'sv','') else n.sv end,
      balance = case when coalesce(n.balance,'') = '' then coalesce(nd->>'balance','') else n.balance end,
      pendientes = case when coalesce(n.pendientes,'') = '' then coalesce(nd->>'pendientes','') else n.pendientes end,
      misc = case when coalesce(n.misc,'') = '' then coalesce(nd->>'misc','') else n.misc end,
      cronologia = case when coalesce(n.cronologia,'') = '' then coalesce(nd->>'cronologia','') else n.cronologia end,
      checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
      lab_history = merged_lh,
      imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
      updated_by = 'db-restore'
    where patient_id = p_id;
    perform set_config('pl.entrega_libre', 'off', true);
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $fn$$q$;
  else
    execute $q$CREATE OR REPLACE FUNCTION public.restore_note_from_archive(p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p patients%rowtype; a archive%rowtype; nd jsonb; n notes%rowtype; has_content boolean; merged_lh jsonb;
begin
  select * into p from patients where id = p_id;
  if not found or nullif(btrim(coalesce(p.exp,'')),'') is null then return 'sin-exp'; end if;
  select * into a from archive
   where btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp)
     and archived_at > now() - interval '10 days'
     and (note_data->>'_restaurado_a') is null
     and (patient_data->>'_supa_id') is distinct from p_id::text
     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;
  if not found then return 'sin-archivo'; end if;
  nd := coalesce(a.note_data, '{}'::jsonb);
  has_content := jsonb_array_length(coalesce(nd->'labHistory','[]'::jsonb)) > 0
              or jsonb_array_length(coalesce(nd->'imagenHistory','[]'::jsonb)) > 0
              or coalesce(nd->>'pendientes','') <> '' or coalesce(nd->>'app','') <> '' or coalesce(nd->>'pa','') <> ''
              or coalesce(nd->>'qx','') <> '' or coalesce(nd->>'manejo','') <> '' or coalesce(nd->>'drenajes','') <> ''
              or coalesce(nd->>'balance','') <> '' or coalesce(nd->>'sv','') <> '' or coalesce(nd->>'sangrado','') <> ''
              or coalesce(nd->>'cronologia','') <> ''
              or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
  if not has_content then return 'archivo-vacio'; end if;
  select * into n from notes where patient_id = p_id;
  if not found then
    perform set_config('pl.entrega_libre', 'on', true);
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore');
    perform set_config('pl.entrega_libre', 'off', true);
  else
    select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
      select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
      union all
      select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
       where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
    ) s;
    -- La Cronología solo la escribe la base (20 oct 2026): para reponerla desde la Papelera hace falta el permiso
    -- de esta transacción; se apaga justo después. La Guardia actual gana (checklist actual || archivo).
    if coalesce(n.cronologia,'') = '' and coalesce(nd->>'cronologia','') <> '' then
      perform set_config('pl.entrega_libre', 'on', true);
    end if;
    update notes set
      app = case when coalesce(n.app,'') = '' then coalesce(nd->>'app','') else n.app end,
      pa = case when coalesce(n.pa,'') = '' then coalesce(nd->>'pa','') else n.pa end,
      drenajes = case when coalesce(n.drenajes,'') = '' then coalesce(nd->>'drenajes','') else n.drenajes end,
      qx = case when coalesce(n.qx,'') = '' then coalesce(nd->>'qx','') else n.qx end,
      manejo = case when coalesce(n.manejo,'') = '' then coalesce(nd->>'manejo','') else n.manejo end,
      sangrado = case when coalesce(n.sangrado,'') = '' then coalesce(nd->>'sangrado','') else n.sangrado end,
      sv = case when coalesce(n.sv,'') = '' then coalesce(nd->>'sv','') else n.sv end,
      balance = case when coalesce(n.balance,'') = '' then coalesce(nd->>'balance','') else n.balance end,
      pendientes = case when coalesce(n.pendientes,'') = '' then coalesce(nd->>'pendientes','') else n.pendientes end,
      misc = case when coalesce(n.misc,'') = '' then coalesce(nd->>'misc','') else n.misc end,
      cronologia = case when coalesce(n.cronologia,'') = '' then coalesce(nd->>'cronologia','') else n.cronologia end,
      checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
      lab_history = merged_lh,
      imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
      updated_by = 'db-restore'
    where patient_id = p_id;
    perform set_config('pl.entrega_libre', 'off', true);
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $function$$q$;
  end if;
end $r$;
reset lock_timeout;

select 'R06_N5_restaurada_protegida · N5 revertido' as reversa,
       to_regprocedure('public.pl_restaurada_protegida()') is null
   and to_regprocedure('public.pl_caja_con_contenido(jsonb)') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'pl_restaurada_protegida')
   and (select md5(prosrc) from pg_proc where oid = 'public.restore_note_from_archive(uuid)'::regprocedure)
       = case when to_regprocedure('public.pl_archive_eliminados()') is null then 'e43e448119a3e499e77e05092040359e' else '1ccfd92db56cbab72b478fd7311cbe34' end as ok;
