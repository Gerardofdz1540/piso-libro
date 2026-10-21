-- ═══ N5 · Nota restaurada en un reingreso: nadie la vacía de golpe en 10 min (20 oct 2026, P0-06 de la revisión) ═══
-- Por qué: al reingresar un paciente (alta y vuelta, o cambio de cama que recrea la fila) el robot del censo inserta
-- al paciente y patients_restore_note_after_insert repone su nota desde la Papelera (restore_note_from_archive). En
-- segundos, un equipo que tenía en su cola la nota VACÍA de ese paciente (ítem del outbox con dirty = null que sube
-- flushOutbox, index.html:13844; hallazgo H4 de la revisión) la manda completa con todo en blanco y la nota
-- recuperada se pierde: en la revisión se vaciaron textos, cirugías y NPO; solo se salvaron la Guardia
-- (pl_entrega_protegida) y los labs. La firma de ese «alta» es un solo guardado que vacía A LA VEZ 3 o más cajas que
-- tenían contenido.
-- Regla:
--   · notes.restaurada_en (timestamptz): la llena restore_note_from_archive, al insertar la nota y al completarla.
--   · pl_restaurada_protegida (BEFORE UPDATE): si OLD.restaurada_en es de los últimos 10 min y el UPDATE vacía a la vez
--     3 o más de: app, pa, manejo, pendientes, drenajes, qx, sangrado, sv, balance, misc, checklist.cirugias,
--     checklist.dispositivos y las llaves de texto del checklist, que tenían contenido y para las que ESTE guardado no
--     trae un sello by[caja] nuevo (posterior a restaurada_en y distinto del de OLD: quien de verdad borró esa caja
--     después de la restauración sí puede), se conserva OLD en ESAS cajas; lo demás del guardado entra.
--     (20 oct 2026, R1 de la revisión de datos: un sello igual al de OLD es heredado, no una edición. N1 y
--     pl_checklist_sin_perdidas copian a NEW los sellos de OLD antes de que corra este trigger, así que «posterior a la
--     restauración» solo no bastaba: una caja editada en esos 10 min se perdía con la nota vacía de la cola.)
--   · Nunca caja por caja: 1 o 2 cajas vaciadas pasan (borrar una caja es normal). Nunca casillas: los booleanos
--     (NPO, ATB, TVP…) son decisiones clínicas que sí cambian; reponerlas solas sería un riesgo.
--   · Las llaves «__…» del checklist (Guardia, diagramas, sellos, __lab_deleted) no cuentan: tienen su propia regla.
--   · restaurada_en solo la escribe la base: si un cliente (authenticated/anon) la manda distinta, queda la de OLD.
--     La app no la conoce: NOTES_SELECT_COLS enumera columnas en main, guardia y guardia-carga (ninguno usa
--     select=*; index.html:11898 en main) y supaUpsertNote no la manda; en Realtime llega como una columna más y la
--     app la ignora (_noteFromRemoteRow solo lee las que conoce).
--   · Con pl.entrega_libre no hace nada (mantenimiento por SQL). Cuando repone, marca pl.modificado (N4): ese UPDATE no
--     se suprime y el equipo que mandó la nota vacía recibe la nota buena. Queda un «raise log» con la cama y las
--     cajas conservadas (se ve en los logs de Postgres de Supabase).
--   · imagen_history no está en la lista (no la pide la revisión); la nota vacía puede dejarla en [] (ver riesgos).
-- Orden de los BEFORE UPDATE: … pl_entrega_protegida → pl_restaurada_protegida → pl_zz_sin_cambios → trg_notes_updated.
-- Corre después de pl_by_monotono (los sellos ya vienen corregidos) y de pl_checklist_sin_perdidas (una llave que
-- faltaba ya está repuesta y no cuenta como «vaciada»).
-- Se puede volver a correr (add column if not exists / create or replace / drop trigger if exists).
-- Reversa: drop trigger if exists pl_restaurada_protegida on public.notes;
--          drop function if exists public.pl_restaurada_protegida(); drop function if exists public.pl_caja_con_contenido(jsonb);
--          restore_note_from_archive: volver a la de producción (md5(prosrc) e43e448119a3e499e77e05092040359e,
--          supabase_guardia_cronologia.sql). La columna restaurada_en se queda (20 oct 2026: las reversas no borran
--          datos; borrarla es ../reversas/R99_limpieza_datos.sql).
--          (20 oct 2026: con O2 instalado, revertir O2 primero; la reversa lista para correr, con la función de
--          producción, es ../reversas/R06_N5_restaurada_protegida.sql.)

alter table public.notes add column if not exists restaurada_en timestamptz;
comment on column public.notes.restaurada_en is
  'Hora en que restore_note_from_archive repuso esta nota desde la Papelera (reingreso). Durante 10 min pl_restaurada_protegida no deja vaciarla de golpe. Solo la escribe la base; la app no la lee ni la manda (20 oct 2026).';

-- restore_note_from_archive (20 oct 2026, integración con O2 = otros/02_papelera_copia_base.sql): la de producción +
-- restaurada_en = now() en el INSERT y en el UPDATE (N5) + el relleno de cajas vacías desde _copia_base (O2). O2 también
-- redefine esta función y va DESPUÉS en producción: con una versión distinta en cada archivo, la última en aplicarse
-- borraba lo de la otra (en la base integrada, O2 apagaba restaurada_en y fallaba N5-1). Por eso está escrita IDÉNTICA,
-- letra por letra, en los dos archivos (mismo md5(prosrc)): el orden y volver a correr cualquiera dan la misma función.
-- Sin O2 la parte de _copia_base no hace nada: solo el archive_before_delete de O2 escribe _copia_base en la Papelera.
create or replace function public.restore_note_from_archive(p_id uuid) returns text
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
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by, restaurada_en)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore',
            now());   -- N5: nota restaurada (pl_restaurada_protegida la cuida 10 min)
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
      restaurada_en = now(),   -- N5: nota restaurada (pl_restaurada_protegida la cuida 10 min)
      updated_by = 'db-restore'
    where patient_id = p_id;
    perform set_config('pl.entrega_libre', 'off', true);
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $fn$;

-- ¿La caja tiene algo? (texto no vacío, lista o objeto no vacíos, número). null, ausente o booleano: no.
create or replace function public.pl_caja_con_contenido(v jsonb) returns boolean
language sql immutable set search_path = public as $fn$
  select case jsonb_typeof(v)
           when 'string' then btrim(v #>> '{}') <> ''
           when 'array' then jsonb_array_length(v) > 0
           when 'object' then v <> '{}'::jsonb
           when 'number' then true
           else false end
$fn$;

create or replace function public.pl_restaurada_protegida() returns trigger
language plpgsql set search_path = public as $fn$
declare
  cajas constant text[] := array['app', 'pa', 'manejo', 'pendientes', 'drenajes', 'qx', 'sangrado', 'sv', 'balance', 'misc'];
  oj jsonb; nj jsonb; sellos jsonb; sellos_old jsonb; ock jsonb; nck jsonb; ck jsonb;
  c text; k text; ov jsonb;
  vacias text[] := '{}'; ck_vacias text[] := '{}';
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  -- restaurada_en la escribe solo la base (restore_note_from_archive corre como su dueño): un cliente no la mueve.
  if new.restaurada_en is distinct from old.restaurada_en and current_user in ('authenticated', 'anon') then
    new.restaurada_en := old.restaurada_en;
    perform set_config('pl.modificado', 'on', true);
  end if;
  if old.restaurada_en is null or old.restaurada_en <= now() - interval '10 minutes' then return new; end if;
  oj := to_jsonb(old); nj := to_jsonb(new);
  sellos := case when jsonb_typeof(new.checklist #> '{__pl_note_meta,by}') = 'object' then new.checklist #> '{__pl_note_meta,by}' else '{}'::jsonb end;
  -- 20 oct 2026 (R1 de la revisión de datos): los sellos de OLD. Cuando este trigger lee NEW, pl_by_monotono (N1) ya
  -- copió a NEW el sello de OLD caja por caja y pl_checklist_sin_perdidas repuso __pl_note_meta ENTERO si el cuerpo no
  -- lo traía (la nota vacía de la cola no lo trae). Si alguien editó una caja después del reingreso, la nota vacía del
  -- equipo atrasado «heredaba» ese sello y la caja contaba como borrada a propósito: se perdía lo recién escrito y, con
  -- menos de 3 cajas, se vaciaba todo. Ahora solo es deliberado un sello que ESTE guardado trae nuevo: posterior a la
  -- restauración y distinto del de OLD (la app pone uno nuevo, _touchBy, cada vez que la persona cambia o vacía la caja).
  sellos_old := case when jsonb_typeof(old.checklist #> '{__pl_note_meta,by}') = 'object' then old.checklist #> '{__pl_note_meta,by}' else '{}'::jsonb end;
  -- Columnas de texto que este guardado deja vacías (tenían algo y no trae un sello nuevo posterior a la restauración).
  foreach c in array cajas loop
    if public.pl_caja_con_contenido(oj -> c) and not public.pl_caja_con_contenido(nj -> c)
       and not (coalesce(public.pl_sello_t(sellos -> c) > old.restaurada_en, false) and (sellos -> c) is distinct from (sellos_old -> c)) then
      vacias := vacias || c;
    end if;
  end loop;
  -- Llaves del checklist: cirugías, dispositivos y las de texto; nunca casillas ni llaves «__…».
  ock := case when jsonb_typeof(old.checklist) = 'object' then old.checklist else '{}'::jsonb end;
  nck := case when jsonb_typeof(new.checklist) = 'object' then new.checklist else '{}'::jsonb end;
  for k, ov in select e.key, e.value from jsonb_each(ock) e loop
    continue when left(k, 2) = '__';
    continue when not (k in ('cirugias', 'dispositivos') or jsonb_typeof(ov) = 'string');
    continue when not public.pl_caja_con_contenido(ov) or public.pl_caja_con_contenido(nck -> k);
    continue when coalesce(public.pl_sello_t(sellos -> k) > old.restaurada_en, false) and (sellos -> k) is distinct from (sellos_old -> k);
    ck_vacias := ck_vacias || k;
  end loop;
  if cardinality(vacias) + cardinality(ck_vacias) < 3 then return new; end if;   -- nunca caja por caja
  if cardinality(vacias) > 0 then
    new := jsonb_populate_record(new, (select jsonb_object_agg(x, oj -> x) from unnest(vacias) x));
  end if;
  if cardinality(ck_vacias) > 0 then
    ck := nck;
    foreach k in array ck_vacias loop ck := jsonb_set(ck, array[k], ock -> k, true); end loop;
    new.checklist := ck;
  end if;
  perform set_config('pl.modificado', 'on', true);   -- N4: este UPDATE no se suprime
  raise log 'pl_restaurada_protegida: nota % (restaurada %) — se conservaron %', new.patient_id, old.restaurada_en,
    array_to_string(vacias || ck_vacias, ', ');
  return new;
end $fn$;
revoke all on function public.pl_restaurada_protegida() from public, anon, authenticated;

drop trigger if exists pl_restaurada_protegida on public.notes;
create trigger pl_restaurada_protegida before update on public.notes
  for each row execute function public.pl_restaurada_protegida();
