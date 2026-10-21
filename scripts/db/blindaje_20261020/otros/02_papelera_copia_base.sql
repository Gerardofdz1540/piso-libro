-- ═══ O2 · Papelera con la copia de la base y registro de lo que se borra de la Papelera (20 oct 2026, P1-06) ══════
-- Por qué (rev_integral/respaldos/prueba_papelera.sql): al dar de alta, la app (o el robot del censo) primero archiva en
-- public.archive SU copia de la nota y luego borra al paciente. archive_before_delete veía esa fila de hace < 5 min y NO
-- guardaba la versión de la base. Si el equipo tenía una copia vieja (iPad que no se había puesto al día), la Papelera
-- se quedaba solo con lo viejo y lo bueno de la base se perdía (la bitácora solo guarda 600 letras del borrado).
--   1) archive_before_delete: si ya hay una fila de la Papelera de hace < 5 min para ese paciente, le AGREGA la copia de
--      la base (note_data || {'_copia_base': nota de la base, '_copia_base_en': ahora}) en vez de omitirla. La copia del
--      equipo se queda tal cual (puede traer lo que el equipo no alcanzó a subir).
--   2) restore_note_from_archive (reingreso): toma la copia del equipo y, para cada caja vacía en ella (textos, cajas de
--      texto o lista del checklist, labs e imagen), usa la de _copia_base. Una caja con texto en la copia del equipo se
--      respeta (la regla pedida); la versión de la base sigue en la fila de la Papelera para recuperarla a mano.
--      Salvo (20 oct 2026, R4 de la revisión de datos) una caja que el equipo vació DESPUÉS de la versión de la base
--      (su sello by[caja].t es más nuevo) o una fecha de labs que borró con «Eliminar labs»: esas no se reviven.
--   3) archive_eliminados + trigger BEFORE DELETE en archive: cualquier borrado de la Papelera («Restaurar», «Borrar para
--      siempre», SQL) deja antes una copia de la fila completa con quién, desde qué equipo y cuándo. Hoy cualquier cuenta
--      la borra sin rastro (RS3). La copia es obligatoria: si no se puede guardar, el borrado no se hace.
-- Se puede volver a correr (create or replace / if not exists). Reversa al final del archivo.

-- Quién hace el cambio (mismas fuentes que pl_audit): JWT de PostgREST y cabeceras de la app.
create or replace function public.pl_quien() returns jsonb
language plpgsql stable set search_path = public as $fn$
declare hdr jsonb; claims jsonb; v_uid uuid;
begin
  -- 20 oct 2026 · usada por los registros de borrado (archive_eliminados, borrados_otros).
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
  begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
  begin v_uid := nullif(claims->>'sub', '')::uuid; exception when others then v_uid := null; end;
  return jsonb_build_object(
    'user_id', v_uid,
    'email', coalesce(claims->>'email', case when claims->>'role' = 'service_role' then 'robot (service_role)' when claims is null then 'sql/cron' else claims->>'role' end),
    'nombre', left(hdr->>'x-pl-user', 80),
    'dispositivo', left(hdr->>'x-pl-device', 80),
    'ua', left(hdr->>'user-agent', 200),
    'ip', left(coalesce(nullif(hdr->>'cf-connecting-ip', ''), nullif(hdr->>'x-real-ip', ''), nullif(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1), '')), 60),
    'rol', coalesce(claims->>'role', 'sql:' || session_user));
end $fn$;
revoke all on function public.pl_quien() from public, anon, authenticated;
grant execute on function public.pl_quien() to service_role;

-- ── 1) archive_before_delete ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.archive_before_delete() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  pid uuid; p patients%rowtype; n notes%rowtype; who text; nd jsonb; pd jsonb; v_reciente uuid;
begin
  if TG_TABLE_NAME = 'patients' then
    pid := OLD.id; p := OLD;
    select * into n from notes where patient_id = pid;
  else
    pid := OLD.patient_id; n := OLD;
    select * into p from patients where id = pid;
  end if;
  if pid is null then return OLD; end if;
  begin
    who := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb->>'role', 'db');
  exception when others then who := 'db'; end;
  nd := case when n.patient_id is null then '{}'::jsonb else jsonb_build_object(
    'app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
    'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
    'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
    'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
    'cronologia', coalesce(n.cronologia, '')) end;
  -- 20 oct 2026 (P1-06): la app o el robot acaban de archivar SU copia (puede ser vieja). Antes se omitía la de la base;
  -- ahora se agrega a ESA fila. No se agrega si no hay nota en la base, si la fila ya ES esa misma nota (la fila que la
  -- base acaba de crear al borrar el paciente: en la cascada patients → notes el segundo disparo la vería) o si ya tiene
  -- esa misma _copia_base: así una baja normal no duplica la nota en la Papelera.
  -- 20 oct 2026 (revisión de operación, M2): la copia que archiva el robot del censo (noteForArchive_ de censo-sync.gs,
  -- releída de la base segundos antes) no trae la llave «cronologia», así que SIEMPRE salía distinta y cada alta del
  -- robot guardaba la nota dos veces. Ahora una llave que la copia del equipo no trae no cuenta si en la base está
  -- vacía ("", [], {}, null): no hay nada que guardar. Si en la base tiene algo (p. ej. la Cronología), la copia sí se
  -- agrega: es justo lo que esa copia no tiene.
  select a.id into v_reciente from archive a
   where a.patient_data->>'_supa_id' = pid::text and a.archived_at > now() - interval '5 minutes'
   order by a.archived_at desc limit 1;
  if v_reciente is not null then
    if n.patient_id is not null then
      update archive set note_data = coalesce(note_data, '{}'::jsonb)
             || jsonb_build_object('_copia_base', nd, '_copia_base_en', now(), '_copia_base_por', 'db-trigger:' || who)
       where id = v_reciente
         and (note_data -> '_copia_base') is distinct from nd
         and (coalesce(note_data, '{}'::jsonb) - '_egreso' - '_egresoFecha' - '_copia_base' - '_copia_base_en' - '_copia_base_por'
              - '_restaurado_a' - '_restaurado_en')
             is distinct from nd - coalesce((select array_agg(e.key) from jsonb_each(nd) e
                                              where not (coalesce(note_data, '{}'::jsonb) ? e.key)
                                                and e.value in ('""'::jsonb, '[]'::jsonb, '{}'::jsonb, 'null'::jsonb)), '{}'::text[]);
    end if;
    return OLD;
  end if;
  pd := jsonb_build_object(
    'cama', coalesce(p.cama, ''), 'nombre', coalesce(p.nombre, ''), 'exp', coalesce(p.exp, ''), 'dx', coalesce(p.dx, ''),
    'edad', coalesce(p.edad, ''), 'esp', coalesce(p.esp, ''), 'adscrito', coalesce(p.adscrito, ''), 'residente', coalesce(p.residente, ''),
    'ingreso', coalesce(p.ingreso::text, ''), 'estado', coalesce(p.estado, ''), 'seccion', coalesce(p.seccion, ''),
    'es_mio', coalesce(p.es_mio, true), '_supa_id', pid);
  nd := nd || jsonb_build_object('_egreso', 'BORRADO EN BD (' || who || ')',
                                 '_egresoFecha', to_char(now() at time zone 'America/Mexico_City', 'DD/MM/YYYY'));
  insert into archive (patient_data, note_data, archived_by) values (pd, nd, 'db-trigger:' || who);
  return OLD;
exception when others then
  raise warning 'archive_before_delete: % (se permite el borrado)', sqlerrm;
  return OLD;
end $fn$;

-- ── 2) restore_note_from_archive ────────────────────────────────────────────────────────────────────────────────
-- 20 oct 2026 (integración con el paquete «notas», N5 = notas/05_restaurada_protegida.sql): N5 también redefine esta
-- función (llena notes.restaurada_en para que pl_restaurada_protegida cuide 10 min la nota restaurada). Como O2 va
-- DESPUÉS de N5 en producción, la versión de O2 sin restaurada_en apagaba en silencio esa protección (en la base
-- integrada fallaba N5-1). Por eso la función de abajo es la UNIÓN de las dos (_copia_base de O2 + restaurada_en de N5)
-- y está escrita IDÉNTICA, letra por letra, en los dos archivos: el orden en que se apliquen y volver a correr
-- cualquiera de los dos dan la misma función (mismo md5(prosrc); APLICAR_EN_ORDEN.md lo verifica).
-- La columna la crea N5; aquí solo se asegura que exista, para que este archivo siga funcionando solo (sin N5 la
-- columna se llena pero nadie la lee).
alter table public.notes add column if not exists restaurada_en timestamptz;

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
-- Permisos sin cambio (create or replace los conserva): archive_before_delete con PUBLIC, authenticated y service_role
-- (es función de trigger: llamarla por /rpc falla); restore_note_from_archive solo postgres y service_role.

-- ── 3) Lo que se borra de la Papelera ───────────────────────────────────────────────────────────────────────────
create table if not exists public.archive_eliminados (
  id bigserial primary key,
  eliminado_en timestamptz not null default now(),
  archive_id uuid,
  fila jsonb not null,            -- la fila completa de archive (to_jsonb): se repone con jsonb_populate_record
  quien_user_id uuid,
  quien_email text,
  quien_nombre text,
  dispositivo text,
  ua text,
  ip text,
  rol text
);
create index if not exists archive_eliminados_ts on public.archive_eliminados (eliminado_en desc);
create index if not exists archive_eliminados_archive_id on public.archive_eliminados (archive_id);
alter table public.archive_eliminados enable row level security;
-- Cerrada para la app salvo lectura del administrador (igual que audit_log); escribe solo el trigger (SECURITY DEFINER).
revoke all on table public.archive_eliminados from anon, authenticated;
grant select on table public.archive_eliminados to authenticated;
revoke all on sequence public.archive_eliminados_id_seq from anon, authenticated;
drop policy if exists archive_eliminados_admin_read on public.archive_eliminados;
create policy archive_eliminados_admin_read on public.archive_eliminados as permissive for select to authenticated
  using ((select public.pl_is_admin()));

create or replace function public.pl_archive_eliminados() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare q jsonb := public.pl_quien();
begin
  -- 20 oct 2026 (P1-06): copia obligatoria; si falla, falla el borrado (no hay borrado sin rastro).
  insert into public.archive_eliminados (archive_id, fila, quien_user_id, quien_email, quien_nombre, dispositivo, ua, ip, rol)
  values (OLD.id, to_jsonb(OLD), (q->>'user_id')::uuid, q->>'email', q->>'nombre', q->>'dispositivo', q->>'ua', q->>'ip', q->>'rol');
  return OLD;
end $fn$;
revoke all on function public.pl_archive_eliminados() from public, anon, authenticated;
grant execute on function public.pl_archive_eliminados() to service_role;
drop trigger if exists pl_archive_eliminados on public.archive;
create trigger pl_archive_eliminados before delete on public.archive
  for each row execute function public.pl_archive_eliminados();
-- Reponer una fila borrada de la Papelera:
--   insert into public.archive select (jsonb_populate_record(null::public.archive, e.fila)).* from public.archive_eliminados e where e.id = …;

-- REVERSA (objetos nuevos):
--   drop trigger if exists pl_archive_eliminados on public.archive; drop function if exists public.pl_archive_eliminados();
--   drop table if exists public.archive_eliminados;   (antes copiar lo que tenga si hace falta)
--   pl_quien() la usan también 03 y 04: quitarla solo si se revierten todos.
--   restore_note_from_archive (20 oct 2026, integración): si N5 está instalado NO se revierte aquí. La misma función
--   vive en notas/05_restaurada_protegida.sql; su parte de _copia_base no hace nada sin el archive_before_delete de
--   este archivo (ninguna fila nueva de la Papelera trae _copia_base). Si se usara la de producción de abajo con N5
--   instalado, restaurada_en dejaría de llenarse y la protección de N5 se apagaría en silencio. La de producción solo
--   va cuando N5 tampoco está (o al revertir N5: ../reversas/R06_N5_restaurada_protegida.sql).
--   notes.restaurada_en es de N5: esta reversa no la quita.

-- ▼▼▼ REVERSA AUTOMÁTICA (armar_reversas.py) ▼▼▼
-- Para volver atrás: quitar los «-- » de abajo y correrlo (create or replace con la definición de producción).
-- Las tablas, triggers y permisos nuevos de este archivo se quitan con las líneas «REVERSA (objetos nuevos)» de arriba.
-- -- archive_before_delete() · cuerpo de valsql/script.sql · md5(prosrc) ddc902b91132962833a8ccac9776784f
-- CREATE OR REPLACE FUNCTION public.archive_before_delete()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   pid uuid; p patients%rowtype; n notes%rowtype; who text; nd jsonb; pd jsonb;
-- begin
--   if TG_TABLE_NAME = 'patients' then
--     pid := OLD.id; p := OLD;
--     select * into n from notes where patient_id = pid;
--   else
--     pid := OLD.patient_id; n := OLD;
--     select * into p from patients where id = pid;
--   end if;
--   if pid is null then return OLD; end if;
--   if exists (select 1 from archive a where a.patient_data->>'_supa_id' = pid::text and a.archived_at > now() - interval '5 minutes') then
--     return OLD;
--   end if;
--   begin
--     who := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb->>'role', 'db');
--   exception when others then who := 'db'; end;
--   pd := jsonb_build_object(
--     'cama', coalesce(p.cama, ''), 'nombre', coalesce(p.nombre, ''), 'exp', coalesce(p.exp, ''), 'dx', coalesce(p.dx, ''),
--     'edad', coalesce(p.edad, ''), 'esp', coalesce(p.esp, ''), 'adscrito', coalesce(p.adscrito, ''), 'residente', coalesce(p.residente, ''),
--     'ingreso', coalesce(p.ingreso::text, ''), 'estado', coalesce(p.estado, ''), 'seccion', coalesce(p.seccion, ''),
--     'es_mio', coalesce(p.es_mio, true), '_supa_id', pid);
--   nd := case when n.patient_id is null then '{}'::jsonb else jsonb_build_object(
--     'app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
--     'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
--     'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
--     'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
--     'cronologia', coalesce(n.cronologia, '')) end;
--   nd := nd || jsonb_build_object('_egreso', 'BORRADO EN BD (' || who || ')',
--                                  '_egresoFecha', to_char(now() at time zone 'America/Mexico_City', 'DD/MM/YYYY'));
--   insert into archive (patient_data, note_data, archived_by) values (pd, nd, 'db-trigger:' || who);
--   return OLD;
-- exception when others then
--   raise warning 'archive_before_delete: % (se permite el borrado)', sqlerrm;
--   return OLD;
-- end $function$
-- ;
-- -- restore_note_from_archive(uuid) · cuerpo de supabase_guardia_cronologia.sql + parche · md5(prosrc) e43e448119a3e499e77e05092040359e
-- CREATE OR REPLACE FUNCTION public.restore_note_from_archive(p_id uuid)
--  RETURNS text
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare p patients%rowtype; a archive%rowtype; nd jsonb; n notes%rowtype; has_content boolean; merged_lh jsonb;
-- begin
--   select * into p from patients where id = p_id;
--   if not found or nullif(btrim(coalesce(p.exp,'')),'') is null then return 'sin-exp'; end if;
--   select * into a from archive
--    where btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp)
--      and archived_at > now() - interval '10 days'
--      and (note_data->>'_restaurado_a') is null
--      and (patient_data->>'_supa_id') is distinct from p_id::text
--      and public.pl_same_person(patient_data->>'nombre', p.nombre)
--    order by archived_at desc limit 1;
--   if not found then return 'sin-archivo'; end if;
--   nd := coalesce(a.note_data, '{}'::jsonb);
--   has_content := jsonb_array_length(coalesce(nd->'labHistory','[]'::jsonb)) > 0
--               or jsonb_array_length(coalesce(nd->'imagenHistory','[]'::jsonb)) > 0
--               or coalesce(nd->>'pendientes','') <> '' or coalesce(nd->>'app','') <> '' or coalesce(nd->>'pa','') <> ''
--               or coalesce(nd->>'qx','') <> '' or coalesce(nd->>'manejo','') <> '' or coalesce(nd->>'drenajes','') <> ''
--               or coalesce(nd->>'balance','') <> '' or coalesce(nd->>'sv','') <> '' or coalesce(nd->>'sangrado','') <> ''
--               or coalesce(nd->>'cronologia','') <> ''
--               or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
--   if not has_content then return 'archivo-vacio'; end if;
--   select * into n from notes where patient_id = p_id;
--   if not found then
--     perform set_config('pl.entrega_libre', 'on', true);
--     insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by)
--     values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
--             coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
--             case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
--             coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore');
--     perform set_config('pl.entrega_libre', 'off', true);
--   else
--     select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
--       select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
--       union all
--       select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
--        where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
--     ) s;
--     -- La Cronología solo la escribe la base (20 oct 2026): para reponerla desde la Papelera hace falta el permiso
--     -- de esta transacción; se apaga justo después. La Guardia actual gana (checklist actual || archivo).
--     if coalesce(n.cronologia,'') = '' and coalesce(nd->>'cronologia','') <> '' then
--       perform set_config('pl.entrega_libre', 'on', true);
--     end if;
--     update notes set
--       app = case when coalesce(n.app,'') = '' then coalesce(nd->>'app','') else n.app end,
--       pa = case when coalesce(n.pa,'') = '' then coalesce(nd->>'pa','') else n.pa end,
--       drenajes = case when coalesce(n.drenajes,'') = '' then coalesce(nd->>'drenajes','') else n.drenajes end,
--       qx = case when coalesce(n.qx,'') = '' then coalesce(nd->>'qx','') else n.qx end,
--       manejo = case when coalesce(n.manejo,'') = '' then coalesce(nd->>'manejo','') else n.manejo end,
--       sangrado = case when coalesce(n.sangrado,'') = '' then coalesce(nd->>'sangrado','') else n.sangrado end,
--       sv = case when coalesce(n.sv,'') = '' then coalesce(nd->>'sv','') else n.sv end,
--       balance = case when coalesce(n.balance,'') = '' then coalesce(nd->>'balance','') else n.balance end,
--       pendientes = case when coalesce(n.pendientes,'') = '' then coalesce(nd->>'pendientes','') else n.pendientes end,
--       misc = case when coalesce(n.misc,'') = '' then coalesce(nd->>'misc','') else n.misc end,
--       cronologia = case when coalesce(n.cronologia,'') = '' then coalesce(nd->>'cronologia','') else n.cronologia end,
--       checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
--       lab_history = merged_lh,
--       imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
--       updated_by = 'db-restore'
--     where patient_id = p_id;
--     perform set_config('pl.entrega_libre', 'off', true);
--   end if;
--   update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
--   return 'restaurado:' || a.id::text;
-- end $function$
-- ;
-- ▲▲▲ FIN DE LA REVERSA ▲▲▲
