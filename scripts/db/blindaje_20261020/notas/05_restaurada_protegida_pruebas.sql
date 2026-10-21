-- ═══ Pruebas de N5 · nota restaurada protegida 10 min (20 oct 2026) ═══════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Personas ficticias «PRUEBA FICTICIA
-- REINGRESO» (ZZ-N005) y «PRUEBA FICTICIA REINGRESO DOS» (ZZ-N015).
-- Reingreso completo como en producción: nota con contenido → el censo borra al paciente (Papelera) → el censo lo
-- vuelve a insertar (patients_restore_note_after_insert repone la nota) → la app sube la nota VACÍA de su cola
-- (upsert POST on_conflict=patient_id, como rol authenticated).
-- Los casos que no deben dejar huella para los siguientes corren en un sub-bloque que se deshace (EXCEPTION).
begin;
do $$
declare
  uid uuid; pid1 uuid; pid2 uuid; pid3 uuid; pid4 uuid; pid5 uuid; pid6 uuid; n int := 0; rc int; r record; ck jsonb; lh jsonb; x text; ts timestamptz;
  ahora1 text := to_char((now() + interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  sello_a text := to_char((now() + interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  sello_b text := to_char((now() + interval '2 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ck_vacio jsonb := '{"atb": false, "npo": false, "npt": false, "tvp": false, "dren": false, "dieta": "", "recibo": "",
                      "interconsultas": "", "cirugias": [], "dispositivos": []}';
  ok_permiso boolean; ok_nunca boolean;
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  -- Ingreso con su nota
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5', 'PRUEBA FICTICIA REINGRESO', 'ZZ-N005') returning id into pid1;
  insert into public.notes (patient_id, app, pa, manejo, pendientes, drenajes, checklist, lab_history)
  values (pid1, 'ZZ APP: HAS', 'ZZ PA: colecistitis', 'ZZ manejo: ATB', 'ZZ pendiente: USG', 'ZZ drenaje: Penrose',
          jsonb_build_object('npo', true, 'atb', false, 'recibo', 'ZZ recibe estable', 'interconsultas', 'ZZ IC cardiología',
            'cirugias', jsonb_build_array(jsonb_build_object('id', 'zz1', 'fecha', '2026-10-18', 'procedimiento', 'ZZ colecistectomía')),
            'dispositivos', jsonb_build_array(jsonb_build_object('id', 'zzd1', 'tipo', 'ZZ sonda')),
            '__pl_note_meta', jsonb_build_object('entrega', '19/10 ZZ: guardia de prueba', 'by', '{}'::jsonb)),
          '[{"fecha":"2026-10-19","labs":{"hb":"10"}}]'::jsonb)
    on conflict (patient_id) do update set app = excluded.app;
  -- Alta: el censo borra al paciente (la Papelera guarda paciente y nota)
  delete from public.patients where id = pid1;
  -- Reingreso: el censo lo vuelve a insertar en otra cama → patients_restore_note_after_insert repone la nota
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5B', 'PRUEBA FICTICIA REINGRESO', 'ZZ-N005') returning id into pid2;
  select * into r from public.notes where patient_id = pid2;
  -- N5-1 la restauración llenó restaurada_en (rama INSERT)
  if r.app is distinct from 'ZZ APP: HAS' or r.restaurada_en is null or r.restaurada_en < now() - interval '1 minute' then
    raise exception 'FALLA N5-1 la nota no se restauró con restaurada_en: app=% restaurada_en=%', r.app, r.restaurada_en; end if; n := n + 1;

  -- La app (equipo con la nota vacía en su cola) sube la fila completa en blanco
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', json_build_object('x-pl-device', 'iPad Safari', 'user-agent', 'UA-ipad')::text, true);
  set local role authenticated;
  insert into public.notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, lab_history, imagen_history, updated_by)
  values (pid2, '', '', '', '', '', '', '', '', '', ck_vacio, '[]', '[]', 'ZZ Equipo Atrasado')
  on conflict (patient_id) do update set app = excluded.app, pa = excluded.pa, drenajes = excluded.drenajes, qx = excluded.qx,
    manejo = excluded.manejo, sangrado = excluded.sangrado, sv = excluded.sv, balance = excluded.balance, pendientes = excluded.pendientes,
    checklist = excluded.checklist, lab_history = excluded.lab_history, imagen_history = excluded.imagen_history, updated_by = excluded.updated_by;
  select * into r from public.notes where patient_id = pid2;
  -- N5-2 textos, cirugías, dispositivos y llaves de texto del checklist se conservan
  if r.app is distinct from 'ZZ APP: HAS' or r.pa is distinct from 'ZZ PA: colecistitis' or r.manejo is distinct from 'ZZ manejo: ATB'
     or r.pendientes is distinct from 'ZZ pendiente: USG' or r.drenajes is distinct from 'ZZ drenaje: Penrose'
     or r.checklist ->> 'recibo' is distinct from 'ZZ recibe estable' or r.checklist ->> 'interconsultas' is distinct from 'ZZ IC cardiología'
     or jsonb_array_length(r.checklist -> 'cirugias') <> 1 or jsonb_array_length(r.checklist -> 'dispositivos') <> 1 then
    raise exception 'FALLA N5-2 la nota vacía de la cola borró la nota restaurada: %', row_to_json(r); end if; n := n + 1;
  -- N5-3 las casillas (booleanos) nunca se reponen: NPO true → false sí entró
  if (r.checklist ->> 'npo') is distinct from 'false' then raise exception 'FALLA N5-3 se repuso una casilla: npo=%', r.checklist ->> 'npo'; end if; n := n + 1;

  -- N5-4 la misma nota vacía otra vez (todo lo demás igual a lo guardado): la protección la repone y SÍ hay UPDATE
  select checklist, lab_history into ck, lh from public.notes where patient_id = pid2;
  update public.notes set app = '', pa = '', manejo = '',
         checklist = ck || '{"recibo": "", "interconsultas": "", "cirugias": [], "dispositivos": []}'::jsonb, lab_history = lh
   where patient_id = pid2;
  get diagnostics rc = row_count;
  select * into r from public.notes where patient_id = pid2;
  if rc <> 1 or r.app is distinct from 'ZZ APP: HAS' or r.checklist ->> 'recibo' is distinct from 'ZZ recibe estable' then
    raise exception 'FALLA N5-4 la nota repuesta no produjo UPDATE (el equipo no la recibiría): filas=% app=%', rc, r.app; end if; n := n + 1;

  -- N5-5 con el permiso de mantenimiento (pl.entrega_libre) sí se puede vaciar (sub-bloque que se deshace)
  begin
    reset role;
    perform set_config('pl.entrega_libre', 'on', true);
    update public.notes set app = '', pa = '', manejo = '' where patient_id = pid2;
    select app = '' and pa = '' and manejo = '' into ok_permiso from public.notes where patient_id = pid2;
    raise exception 'deshacer N5-5';
  exception when raise_exception then null;
  end;
  if not coalesce(ok_permiso, false) then raise exception 'FALLA N5-5 el mantenimiento no pudo vaciar la nota restaurada'; end if; n := n + 1;

  -- N5-6 una nota que NUNCA se restauró (restaurada_en null) se puede vaciar como siempre (sub-bloque que se deshace)
  begin
    reset role;
    update public.notes set restaurada_en = null where patient_id = pid2;   -- como postgres (la base)
    set local role authenticated;
    update public.notes set app = '', pa = '', manejo = '', pendientes = '' where patient_id = pid2;
    select app = '' and pa = '' and manejo = '' and pendientes = '' into ok_nunca from public.notes where patient_id = pid2;
    raise exception 'deshacer N5-6';
  exception when raise_exception then null;
  end;
  if not coalesce(ok_nunca, false) then raise exception 'FALLA N5-6 una nota nunca restaurada no se pudo vaciar'; end if; n := n + 1;

  -- N5-7 vaciar DOS cajas a la vez (menos de 3) sí se permite: nunca caja por caja
  set local role authenticated;
  update public.notes set pendientes = '', drenajes = '' where patient_id = pid2;
  select * into r from public.notes where patient_id = pid2;
  if r.pendientes <> '' or r.drenajes <> '' then raise exception 'FALLA N5-7 no se pudieron vaciar 2 cajas: «%» «%»', r.pendientes, r.drenajes; end if; n := n + 1;

  -- N5-8 vaciar 3 cajas CON sello posterior a la restauración (la persona las borró a propósito) sí se permite
  update public.notes set app = '', pa = '', manejo = '',
         checklist = jsonb_set(checklist, '{__pl_note_meta,by}', jsonb_build_object(
           'app', jsonb_build_object('u', 'ZZ', 'i', 'ZZ', 't', ahora1),
           'pa', jsonb_build_object('u', 'ZZ', 'i', 'ZZ', 't', ahora1),
           'manejo', jsonb_build_object('u', 'ZZ', 'i', 'ZZ', 't', ahora1)))
   where patient_id = pid2;
  select * into r from public.notes where patient_id = pid2;
  if r.app <> '' or r.pa <> '' or r.manejo <> '' then raise exception 'FALLA N5-8 no se respetó el borrado con sello: % / % / %', r.app, r.pa, r.manejo; end if; n := n + 1;

  -- N5-9 se vacían 4 llaves del checklist y solo «recibo» trae sello nuevo: las 3 sin sello se conservan, recibo se vacía
  update public.notes set checklist = jsonb_set(checklist || '{"recibo": "", "interconsultas": "", "cirugias": [], "dispositivos": []}'::jsonb,
           '{__pl_note_meta,by,recibo}', jsonb_build_object('u', 'ZZ', 'i', 'ZZ', 't', ahora1))
   where patient_id = pid2;
  select checklist into ck from public.notes where patient_id = pid2;
  if ck ->> 'recibo' <> '' or ck ->> 'interconsultas' is distinct from 'ZZ IC cardiología'
     or jsonb_array_length(ck -> 'cirugias') <> 1 or jsonb_array_length(ck -> 'dispositivos') <> 1 then
    raise exception 'FALLA N5-9 sello por caja: recibo=«%» ic=«%» cx=% disp=%', ck ->> 'recibo', ck ->> 'interconsultas', ck -> 'cirugias', ck -> 'dispositivos'; end if; n := n + 1;

  -- N5-10 pasados 10 min ya no protege
  reset role;
  update public.notes set restaurada_en = now() - interval '11 minutes' where patient_id = pid2;
  set local role authenticated;
  update public.notes set checklist = checklist || '{"interconsultas": "", "cirugias": [], "dispositivos": []}'::jsonb where patient_id = pid2;
  select checklist into ck from public.notes where patient_id = pid2;
  if ck ->> 'interconsultas' <> '' or jsonb_array_length(ck -> 'cirugias') <> 0 or jsonb_array_length(ck -> 'dispositivos') <> 0 then
    raise exception 'FALLA N5-10 a los 11 min seguía protegida: %', ck; end if; n := n + 1;

  -- N5-11 un cliente no puede mover restaurada_en
  update public.notes set restaurada_en = null where patient_id = pid2;
  select restaurada_en into ts from public.notes where patient_id = pid2;
  if ts is null then raise exception 'FALLA N5-11 un cliente borró restaurada_en'; end if; n := n + 1;
  reset role;

  -- N5-12 rama UPDATE de restore_note_from_archive (la nota ya existía vacía): también llena restaurada_en
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5C', 'PRUEBA FICTICIA REINGRESO DOS', 'ZZ-N015') returning id into pid3;
  insert into public.notes (patient_id, app, checklist) values (pid3, 'ZZ APP DOS', '{}'::jsonb) on conflict (patient_id) do update set app = excluded.app;
  delete from public.patients where id = pid3;
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5D', 'PRUEBA FICTICIA REINGRESO DOS', '') returning id into pid4;   -- sin exp: no restaura
  insert into public.notes (patient_id, checklist) values (pid4, '{}'::jsonb);
  update public.patients set exp = 'ZZ-N015' where id = pid4;
  x := public.restore_note_from_archive(pid4);
  select * into r from public.notes where patient_id = pid4;
  if x not like 'restaurado:%' or r.app is distinct from 'ZZ APP DOS' or r.restaurada_en is null then
    raise exception 'FALLA N5-12 la rama UPDATE no llenó restaurada_en: % app=% restaurada_en=%', x, r.app, r.restaurada_en; end if; n := n + 1;
  -- N5-13 (20 oct 2026, R1 de la revisión de datos) en los 10 min alguien corrige «pa» y «recibo» de la nota restaurada
  --       (upsert parcial como updateField: la caja + el checklist con su sello by nuevo) y DESPUÉS el equipo atrasado
  --       sube la nota VACÍA de su cola (fila completa, sin __pl_note_meta). Las 4 cajas se conservan, también lo recién
  --       corregido. Antes, pl_by_monotono y pl_checklist_sin_perdidas le pasaban a la nota vacía el sello de OLD y esas
  --       cajas contaban como «borradas a propósito»: se perdía la corrección y, con < 3 cajas, se vaciaba todo.
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5E', 'PRUEBA FICTICIA REINGRESO TRES', 'ZZ-N025') returning id into pid5;
  insert into public.notes (patient_id, app, pa, manejo, checklist)
  values (pid5, 'ZZ APP TRES', 'ZZ PA TRES', 'ZZ MANEJO TRES',
          jsonb_build_object('npo', true, 'recibo', 'ZZ RECIBO TRES', '__pl_note_meta', jsonb_build_object('by', jsonb_build_object(
            'pa', jsonb_build_object('u', 'ZZ Ayer', 'i', 'ZA', 't', '2026-10-19T10:00:00.000Z')))))
    on conflict (patient_id) do update set app = excluded.app;
  delete from public.patients where id = pid5;
  insert into public.patients (cama, nombre, exp) values ('ZZ-N5F', 'PRUEBA FICTICIA REINGRESO TRES', 'ZZ-N025') returning id into pid6;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ iPad A', 'user-agent', 'UA-A')::text, true);
  set local role authenticated;
  select checklist into ck from public.notes where patient_id = pid6;
  ck := jsonb_set(jsonb_set(ck || '{"recibo": "ZZ RECIBO CORREGIDO POR A"}'::jsonb,
          '{__pl_note_meta,by,pa}', jsonb_build_object('u', 'ZZ A', 'i', 'RA', 't', sello_a), true),
          '{__pl_note_meta,by,recibo}', jsonb_build_object('u', 'ZZ A', 'i', 'RA', 't', sello_a), true);
  insert into public.notes (patient_id, pa, checklist, updated_by) values (pid6, 'ZZ PA CORREGIDO POR A', ck, 'ZZ A')
    on conflict (patient_id) do update set pa = excluded.pa, checklist = excluded.checklist, updated_by = excluded.updated_by;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ Mac B', 'user-agent', 'UA-B')::text, true);
  insert into public.notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, lab_history, imagen_history, updated_by)
  values (pid6, '', '', '', '', '', '', '', '', '', ck_vacio, '[]', '[]', 'ZZ Equipo B')
  on conflict (patient_id) do update set app = excluded.app, pa = excluded.pa, drenajes = excluded.drenajes, qx = excluded.qx,
    manejo = excluded.manejo, sangrado = excluded.sangrado, sv = excluded.sv, balance = excluded.balance, pendientes = excluded.pendientes,
    checklist = excluded.checklist, lab_history = excluded.lab_history, imagen_history = excluded.imagen_history, updated_by = excluded.updated_by;
  select * into r from public.notes where patient_id = pid6;
  if r.app is distinct from 'ZZ APP TRES' or r.pa is distinct from 'ZZ PA CORREGIDO POR A' or r.manejo is distinct from 'ZZ MANEJO TRES'
     or r.checklist ->> 'recibo' is distinct from 'ZZ RECIBO CORREGIDO POR A' then
    raise exception 'FALLA N5-13 la nota vacía de la cola borró lo corregido tras el reingreso (sello heredado de OLD): app=«%» pa=«%» manejo=«%» recibo=«%»',
      r.app, r.pa, r.manejo, r.checklist ->> 'recibo'; end if; n := n + 1;

  -- N5-14 un sello NUEVO sigue valiendo aunque la caja ya tuviera un sello posterior a la restauración: el guardado que
  --       vacía app, manejo y recibo sin sello y «pa» con sello nuevo conserva las 3 primeras y deja «pa» vacía
  set local role authenticated;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ iPad A', 'user-agent', 'UA-A')::text, true);
  update public.notes set app = '', pa = '', manejo = '',
         checklist = jsonb_set(checklist || '{"recibo": ""}'::jsonb, '{__pl_note_meta,by,pa}', jsonb_build_object('u', 'ZZ A', 'i', 'RA', 't', sello_b), true)
   where patient_id = pid6;
  select * into r from public.notes where patient_id = pid6;
  reset role;
  if r.pa <> '' or r.app is distinct from 'ZZ APP TRES' or r.manejo is distinct from 'ZZ MANEJO TRES'
     or r.checklist ->> 'recibo' is distinct from 'ZZ RECIBO CORREGIDO POR A' then
    raise exception 'FALLA N5-14 sello nuevo sobre una caja ya editada tras el reingreso: pa=«%» app=«%» manejo=«%» recibo=«%»',
      r.pa, r.app, r.manejo, r.checklist ->> 'recibo'; end if; n := n + 1;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
