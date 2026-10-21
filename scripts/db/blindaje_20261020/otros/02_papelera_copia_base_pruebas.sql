-- ═══ Pruebas de O2 · Papelera con copia de la base (20 oct 2026) ═══════════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Pacientes ficticios ZZ-…
-- Uso: psql … -f otros/02_papelera_copia_base_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
-- Reproduce rev_integral/respaldos/prueba_papelera.sql: la app archiva SU copia (vieja) y luego borra al paciente.
begin;
do $$
declare
  uid uuid; adm uuid := '00000000-0000-4000-8000-0000000ad001';
  pid uuid; pid2 uuid; aid uuid; aid4 uuid; aid6 uuid; c int; n int := 0; x jsonb; tx text; nt public.notes%rowtype; cuerpo jsonb;
  H_IPAD constant text := json_build_object('x-pl-device', 'ZZ-iPad', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-iPad')::text;
begin
  select id into uid from public.app_users where status = 'active' and role = 'usuario' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text, true);
  perform set_config('request.headers', H_IPAD, true);

  -- La base tiene la versión buena (otro equipo la escribió); el iPad tiene una copia vieja.
  insert into public.patients (cama, nombre, exp) values ('ZZ-P1', 'ZZ PRUEBA PAPELERA UNO', 'ZZ-P001') returning id into pid;
  insert into public.notes (patient_id, pendientes, app, checklist, lab_history)
  values (pid, 'ZZ PENDIENTES BUENOS', 'ZZ APP BUENA',
          jsonb_build_object('recibo', 'ZZ RECIBO BUENO', 'pendientes_r1', 'ZZ R1 BUENO', 'npt', true,
                             'cirugias', jsonb_build_array(jsonb_build_object('id', 'czz1', 'procedimiento', 'ZZ LAPE'))),
          '[{"fecha":"2026-10-19","labs":{"hb":"9.1"}},{"fecha":"2026-10-20","labs":{"hb":"10.2"}}]'::jsonb)
  on conflict (patient_id) do update set pendientes = excluded.pendientes, app = excluded.app, checklist = excluded.checklist, lab_history = excluded.lab_history;
  set local role authenticated;
  insert into public.archive (patient_data, note_data, archived_by)
  values (jsonb_build_object('cama', 'ZZ-P1', 'nombre', 'ZZ PRUEBA PAPELERA UNO', 'exp', 'ZZ-P001', '_supa_id', pid),
          jsonb_build_object('pendientes', 'ZZ copia vieja del iPad', 'app', '',
                             'checklist', jsonb_build_object('recibo', '', 'pendientes_r1', 'ZZ R1 VIEJO', 'npt', false, 'cirugias', '[]'::jsonb),
                             'labHistory', '[{"fecha":"2026-10-19","labs":{"hb":"9.1"}}]'::jsonb,
                             '_egreso', 'ALTA', '_egresoFecha', '20/10/2026'),
          'ZZ-app')
  returning id into aid;
  delete from public.patients where id = pid;
  reset role;

  -- P2-1 una sola fila en la Papelera (la de la app): la base no la duplica
  select count(*) into c from public.archive a where a.patient_data->>'_supa_id' = pid::text;
  if c <> 1 then raise exception 'FALLA P2-1 filas en la Papelera para el paciente: % (se esperaba 1)', c; end if; n := n + 1;
  -- P2-2 esa fila guarda además la copia de la base (_copia_base) y la del equipo queda intacta
  select a.note_data into x from public.archive a where a.id = aid;
  if x->'_copia_base'->>'pendientes' is distinct from 'ZZ PENDIENTES BUENOS' or x->'_copia_base'->>'app' is distinct from 'ZZ APP BUENA'
     or jsonb_array_length(x->'_copia_base'->'labHistory') <> 2 or x->>'_copia_base_en' is null then
    raise exception 'FALLA P2-2 la Papelera no guardó la versión de la base: %', left((x->'_copia_base')::text, 300); end if; n := n + 1;
  if x->>'pendientes' is distinct from 'ZZ copia vieja del iPad' or x->>'_egreso' is distinct from 'ALTA' then
    raise exception 'FALLA P2-3 se alteró la copia del equipo: %', left(x::text, 300); end if; n := n + 1;

  -- Reingreso (misma persona, mismo expediente): patients_restore_note_after_insert restaura desde la Papelera.
  insert into public.patients (cama, nombre, exp) values ('ZZ-P2', 'ZZ PRUEBA PAPELERA UNO', 'ZZ-P001') returning id into pid2;
  select * into nt from public.notes where patient_id = pid2;
  -- P2-4 caja vacía en la copia del equipo → la de la base
  if nt.app is distinct from 'ZZ APP BUENA' or nt.checklist->>'recibo' is distinct from 'ZZ RECIBO BUENO'
     or jsonb_array_length(nt.checklist->'cirugias') <> 1 then
    raise exception 'FALLA P2-4 no tomó lo bueno de la base: app=% recibo=% cirugias=%', nt.app, nt.checklist->>'recibo', nt.checklist->'cirugias'; end if; n := n + 1;
  -- P2-5 caja con texto en la copia del equipo → se respeta (y las casillas: false no es «vacío»)
  if nt.pendientes is distinct from 'ZZ copia vieja del iPad' or nt.checklist->>'pendientes_r1' is distinct from 'ZZ R1 VIEJO'
     or nt.checklist->'npt' is distinct from 'false'::jsonb then
    raise exception 'FALLA P2-5 no respetó la copia del equipo: pendientes=% r1=% npt=%', nt.pendientes, nt.checklist->>'pendientes_r1', nt.checklist->'npt'; end if; n := n + 1;
  -- P2-6 labs: unión por fecha (la del 20/10 solo estaba en la base)
  if jsonb_array_length(nt.lab_history) <> 2 or not exists (select 1 from jsonb_array_elements(nt.lab_history) e where e->>'fecha' = '2026-10-20') then
    raise exception 'FALLA P2-6 labs sin la fecha de la base: %', nt.lab_history; end if; n := n + 1;
  select a.note_data->>'_restaurado_a' into tx from public.archive a where a.id = aid;
  if tx is distinct from pid2::text then raise exception 'FALLA P2-7 la fila no quedó marcada como restaurada'; end if; n := n + 1;

  -- P2-8 sin copia reciente de la app: la base guarda su copia como siempre (fila db-trigger, sin _copia_base)
  insert into public.patients (cama, nombre, exp) values ('ZZ-P3', 'ZZ PRUEBA PAPELERA TRES', 'ZZ-P003') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ P3 BASE') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  delete from public.patients where id = pid;
  reset role;
  select jsonb_build_object('n', count(*), 'por', max(a.archived_by), 'p', max(a.note_data->>'pendientes'), 'cb', bool_or(a.note_data ? '_copia_base')) into x
    from public.archive a where a.patient_data->>'_supa_id' = pid::text;
  if x <> jsonb_build_object('n', 1, 'por', 'db-trigger:authenticated', 'p', 'ZZ P3 BASE', 'cb', false) then
    raise exception 'FALLA P2-8 borrado sin copia de la app: %', x; end if; n := n + 1;
  -- P2-8b la nota se borró (fila de la base), se volvió a escribir y a los 2 min se borra el paciente: la fila reciente
  -- recibe la nota NUEVA como _copia_base (antes se perdía: el trigger veía la fila de < 5 min y no guardaba nada)
  insert into public.patients (cama, nombre, exp) values ('ZZ-P3B', 'ZZ PRUEBA PAPELERA TRES B', 'ZZ-P03B') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ P3B PRIMERA') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  delete from public.notes where patient_id = pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ P3B SEGUNDA');
  delete from public.patients where id = pid;
  reset role;
  select jsonb_build_object('n', count(*), 'p', max(a.note_data->>'pendientes'), 'cb', max(a.note_data->'_copia_base'->>'pendientes')) into x
    from public.archive a where a.patient_data->>'_supa_id' = pid::text;
  if x <> jsonb_build_object('n', 1, 'p', 'ZZ P3B PRIMERA', 'cb', 'ZZ P3B SEGUNDA') then
    raise exception 'FALLA P2-8b la nota reescrita no quedó en la Papelera: %', x; end if; n := n + 1;

  -- P2-9 la app archivó una copia VACÍA: antes la restauración decía «archivo-vacio»; ahora usa la de la base
  insert into public.patients (cama, nombre, exp) values ('ZZ-P4', 'ZZ PRUEBA PAPELERA CUATRO', 'ZZ-P004') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ P4 BUENO') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  insert into public.archive (patient_data, note_data, archived_by)
  values (jsonb_build_object('cama', 'ZZ-P4', 'nombre', 'ZZ PRUEBA PAPELERA CUATRO', 'exp', 'ZZ-P004', '_supa_id', pid), '{}'::jsonb, 'ZZ-app')
  returning id into aid4;
  delete from public.patients where id = pid;
  reset role;
  insert into public.patients (cama, nombre, exp) values ('ZZ-P5', 'ZZ PRUEBA PAPELERA CUATRO', 'ZZ-P004') returning id into pid2;
  select * into nt from public.notes where patient_id = pid2;
  if nt.pendientes is distinct from 'ZZ P4 BUENO' then raise exception 'FALLA P2-9 copia vacía de la app: no se restauró lo de la base (%)', nt.pendientes; end if; n := n + 1;

  -- P2-10 borrar una fila de la Papelera (como la app: authenticated) → queda la fila completa en archive_eliminados
  set local role authenticated;
  delete from public.archive where id = aid;
  reset role;
  select to_jsonb(e) into x from public.archive_eliminados e where e.archive_id = aid;
  if x is null or x->'fila'->>'id' is distinct from aid::text or x->'fila'->'note_data'->'_copia_base'->>'pendientes' is distinct from 'ZZ PENDIENTES BUENOS'
     or x->>'quien_user_id' is distinct from uid::text or x->>'dispositivo' is distinct from 'ZZ-iPad' or x->>'rol' is distinct from 'authenticated'
     or x->>'eliminado_en' is null then
    raise exception 'FALLA P2-10 borrado de la Papelera sin rastro completo: %', left(coalesce(x::text, 'sin fila'), 400); end if; n := n + 1;
  -- P2-11 se repone tal cual desde archive_eliminados
  insert into public.archive select (jsonb_populate_record(null::public.archive, e.fila)).* from public.archive_eliminados e where e.archive_id = aid;
  select count(*) into c from public.archive a where a.id = aid and a.note_data->'_copia_base'->>'pendientes' = 'ZZ PENDIENTES BUENOS';
  if c <> 1 then raise exception 'FALLA P2-11 no se pudo reponer la fila desde archive_eliminados'; end if; n := n + 1;
  -- P2-12 la app (cuenta normal) no lee archive_eliminados; el administrador sí; anon ni la toca
  insert into auth.users (id, email) values (adm, 'zz-admin@prueba.invalid');
  insert into public.app_users (id, email, nombre, role, status) values (adm, 'zz-admin@prueba.invalid', 'ZZ ADMIN', 'admin', 'active');
  set local role authenticated;
  select count(*) into c from public.archive_eliminados;
  if c <> 0 then reset role; raise exception 'FALLA P2-12 una cuenta normal ve archive_eliminados (% filas)', c; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  select count(*) into c from public.archive_eliminados;
  reset role;
  if c < 1 then raise exception 'FALLA P2-12 el administrador no ve archive_eliminados'; end if;
  if has_table_privilege('anon', 'public.archive_eliminados', 'select') or has_table_privilege('authenticated', 'public.archive_eliminados', 'insert')
     or has_table_privilege('authenticated', 'public.archive_eliminados', 'delete') then
    raise exception 'FALLA P2-12 permisos de archive_eliminados demasiado abiertos'; end if; n := n + 1;

  -- P2-13 (20 oct 2026, R4 de la revisión de datos) justo antes del egreso la persona vació «pendientes», «recibo» y la
  --       🌙 Guardia y borró los labs del 19/10 (eran de otro paciente); su guardado no llegó a la base. La app archiva SU copia
  --       (con los sellos nuevos que pone _touchBy y la lápida de deleteLabDate) y borra al paciente; el censo lo
  --       reingresa. Lo que la persona vació no revive. Lo que su copia tenía vacío por estar atrasada (app con un sello
  --       más viejo que el de la base, pa e interconsultas sin sello) se llena de la base. El 15/10 tiene una lápida
  --       VIEJA (ya estaba en la base) y la base tiene resultados nuevos de ese día: se repone (regla de N3).
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text, true);
  perform set_config('request.headers', H_IPAD, true);
  insert into public.patients (cama, nombre, exp) values ('ZZ-P6', 'ZZ PRUEBA PAPELERA SEIS', 'ZZ-P006') returning id into pid;
  insert into public.notes (patient_id, app, pa, pendientes, checklist, lab_history)
  values (pid, 'ZZ APP BASE SEIS', 'ZZ PA BASE SEIS', 'ZZ PEND: ya se hizo la TAC',
          jsonb_build_object('npo', false, 'recibo', 'ZZ RECIBO BASE SEIS', 'interconsultas', 'ZZ IC BASE SEIS',
            '__lab_deleted', '["2026-10-15"]'::jsonb, '__lab_deleted_labs', '{"2026-10-15": {"hb": "7.0"}}'::jsonb,
            '__pl_note_meta', jsonb_build_object('entrega', '20/10 ZZ: guardia de la base seis', 'by', jsonb_build_object(
              'entrega', jsonb_build_object('u', 'ZZ Mac', 'i', 'ZM', 't', '2026-10-20T08:00:00.000Z'),
              'app', jsonb_build_object('u', 'ZZ Mac', 'i', 'ZM', 't', '2026-10-20T08:00:00.000Z'),
              'pendientes', jsonb_build_object('u', 'ZZ Mac', 'i', 'ZM', 't', '2026-10-20T08:00:00.000Z'),
              'recibo', jsonb_build_object('u', 'ZZ Mac', 'i', 'ZM', 't', '2026-10-20T08:00:00.000Z')))),
          '[{"fecha":"2026-10-15","labs":{"hb":"11.8"}},{"fecha":"2026-10-19","labs":{"hb":"6.1"}},{"fecha":"2026-10-20","labs":{"hb":"10.5"}}]'::jsonb)
  on conflict (patient_id) do update set app = excluded.app, pa = excluded.pa, pendientes = excluded.pendientes,
    checklist = excluded.checklist, lab_history = excluded.lab_history;
  set local role authenticated;
  insert into public.archive (patient_data, note_data, archived_by)
  values (jsonb_build_object('cama', 'ZZ-P6', 'nombre', 'ZZ PRUEBA PAPELERA SEIS', 'exp', 'ZZ-P006', '_supa_id', pid),
          jsonb_build_object('app', '', 'pa', '', 'pendientes', '',
            'checklist', jsonb_build_object('npo', false, 'recibo', '', 'interconsultas', '',
              '__lab_deleted', '["2026-10-15", "2026-10-19"]'::jsonb,
              '__lab_deleted_labs', '{"2026-10-15": {"hb": "7.0"}, "2026-10-19": {"hb": "6.1"}}'::jsonb,
              '__pl_note_meta', jsonb_build_object('entrega', '', 'by', jsonb_build_object(
                'entrega', jsonb_build_object('u', 'ZZ iPad', 'i', 'ZI', 't', '2026-10-20T09:00:00.000Z'),
                'app', jsonb_build_object('u', 'ZZ iPad', 'i', 'ZI', 't', '2026-10-19T08:00:00.000Z'),
                'pendientes', jsonb_build_object('u', 'ZZ iPad', 'i', 'ZI', 't', '2026-10-20T09:00:00.000Z'),
                'recibo', jsonb_build_object('u', 'ZZ iPad', 'i', 'ZI', 't', '2026-10-20T09:00:00.000Z')))),
            'labHistory', '[{"fecha":"2026-10-20","labs":{"hb":"10.5"}}]'::jsonb, 'imagenHistory', '[]'::jsonb,
            '_egreso', 'ALTA', '_egresoFecha', '20/10/2026'),
          'ZZ-app');
  delete from public.patients where id = pid;
  reset role;
  insert into public.patients (cama, nombre, exp) values ('ZZ-P6B', 'ZZ PRUEBA PAPELERA SEIS', 'ZZ-P006') returning id into pid2;
  select * into nt from public.notes where patient_id = pid2;
  if nt.pendientes <> '' or nt.checklist ->> 'recibo' <> '' or nt.checklist #>> '{__pl_note_meta,entrega}' <> ''
     or nt.app is distinct from 'ZZ APP BASE SEIS' or nt.pa is distinct from 'ZZ PA BASE SEIS'
     or nt.checklist ->> 'interconsultas' is distinct from 'ZZ IC BASE SEIS'
     or exists (select 1 from jsonb_array_elements(nt.lab_history) e where e ->> 'fecha' = '2026-10-19')
     or (select e #>> '{labs,hb}' from jsonb_array_elements(nt.lab_history) e where e ->> 'fecha' = '2026-10-15') is distinct from '11.8'
     or jsonb_array_length(nt.lab_history) <> 2 then
    raise exception 'FALLA P2-13 el reingreso revivió lo vaciado a propósito (o no llenó lo atrasado): pend=«%» recibo=«%» guardia=«%» app=«%» pa=«%» ic=«%» labs=%',
      nt.pendientes, nt.checklist ->> 'recibo', nt.checklist #>> '{__pl_note_meta,entrega}', nt.app, nt.pa, nt.checklist ->> 'interconsultas', nt.lab_history; end if; n := n + 1;

  -- P2-14 (20 oct 2026, M2 de la revisión de operación) alta por el robot del censo: archiva SU copia recién leída de la
  --       base (noteForArchive_ de censo-sync.gs: no trae «cronologia») y luego borra nota y paciente. Con la
  --       Cronología vacía no hay nada que la copia no tenga: una sola nota en la Papelera, sin _copia_base.
  insert into public.patients (cama, nombre, exp) values ('ZZ-P7', 'ZZ PRUEBA PAPELERA SIETE', 'ZZ-P007') returning id into pid;
  insert into public.notes (patient_id, pendientes, lab_history) values (pid, 'ZZ P7 PEND', '[{"fecha":"2026-10-20","labs":{"hb":"9"}}]')
    on conflict (patient_id) do update set pendientes = excluded.pendientes, lab_history = excluded.lab_history;
  select jsonb_build_object('app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
           'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
           'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
           'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
           '_egreso', 'RETIRADO DEL CENSO (hoja)', '_egresoFecha', '20/10/2026')
    into cuerpo from public.notes n where n.patient_id = pid;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.headers', '', true);
  set local role service_role;
  insert into public.archive (patient_data, note_data, archived_by)
  values (jsonb_build_object('cama', 'ZZ-P7', 'nombre', 'ZZ PRUEBA PAPELERA SIETE', 'exp', 'ZZ-P007', '_supa_id', pid), cuerpo, 'sheet-sync')
  returning id into aid6;
  delete from public.notes where patient_id = pid;
  delete from public.patients where id = pid;
  reset role;
  select count(*) into c from public.archive a where a.patient_data ->> '_supa_id' = pid::text;
  select a.note_data into x from public.archive a where a.id = aid6;
  if c <> 1 or x ? '_copia_base' then
    raise exception 'FALLA P2-14 el alta del robot (copia recién leída) se guardó dos veces: filas=% _copia_base=%', c, x ? '_copia_base'; end if; n := n + 1;

  -- P2-14b el mismo robot con Cronología en la base: su copia no la trae, así que _copia_base sí se agrega (con la
  --        Cronología) y el reingreso la repone
  insert into public.patients (cama, nombre, exp) values ('ZZ-P8', 'ZZ PRUEBA PAPELERA OCHO', 'ZZ-P008') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ P8 PEND') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  perform set_config('pl.entrega_libre', 'on', true);   -- la Cronología solo la escribe la base
  update public.notes set cronologia = 'ZZ CRONOLOGIA P8' where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  select jsonb_build_object('app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
           'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
           'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
           'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
           '_egreso', 'RETIRADO DEL CENSO (hoja)', '_egresoFecha', '20/10/2026')
    into cuerpo from public.notes n where n.patient_id = pid;
  set local role service_role;
  insert into public.archive (patient_data, note_data, archived_by)
  values (jsonb_build_object('cama', 'ZZ-P8', 'nombre', 'ZZ PRUEBA PAPELERA OCHO', 'exp', 'ZZ-P008', '_supa_id', pid), cuerpo, 'sheet-sync')
  returning id into aid6;
  delete from public.notes where patient_id = pid;
  delete from public.patients where id = pid;
  insert into public.patients (cama, nombre, exp) values ('ZZ-P8B', 'ZZ PRUEBA PAPELERA OCHO', 'ZZ-P008') returning id into pid2;
  reset role;
  select a.note_data into x from public.archive a where a.id = aid6;
  select * into nt from public.notes where patient_id = pid2;
  if x -> '_copia_base' ->> 'cronologia' is distinct from 'ZZ CRONOLOGIA P8' or nt.cronologia is distinct from 'ZZ CRONOLOGIA P8'
     or nt.pendientes is distinct from 'ZZ P8 PEND' then
    raise exception 'FALLA P2-14b con Cronología, la Papelera no guardó la copia de la base (o el reingreso no la repuso): copia=% crono=«%»',
      x -> '_copia_base' ->> 'cronologia', nt.cronologia; end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
