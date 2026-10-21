-- ═══ Pruebas de N2 · Guardia: otro usuario en el mismo equipo (20 oct 2026) ═══════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Paciente ficticio ZZ-N2 y un segundo
-- usuario ficticio activo (zz.n2.d@ejemplo.invalid) que solo existe dentro de esta transacción.
-- Caso G4 de la revisión: dos residentes en «Mac Chrome» con el mismo user-agent. Se prueba como «authenticated»
-- (como guarda la app) y, para los claims vacíos/corruptos, como service_role y postgres (crons y SQL).
-- Además debe seguir en verde toda la batería valsql/pruebas.sql (28 pruebas).
begin;
do $$
declare
  uid_c uuid; uid_d uuid := '00000000-0000-4000-8000-0000000000d2'; pid uuid; n int := 0; e text;
  base text := '19/10 GF: estable, afebril';
  lc text := '20/10 08:10 CO: se transfunde 1 PG';
  ld text := '20/10 08:12 DR: dieta líquida';
  l3 text := '20/10 08:20 SQL: renglón con claims corruptos';
  l4 text := '20/10 08:25 SR: renglón con claims vacíos';
  mac jsonb := jsonb_build_object('x-pl-device', 'Mac Chrome', 'user-agent', 'UA-mac');
begin
  select id into uid_c from public.app_users where status = 'active' limit 1;
  if uid_c is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into auth.users (id, email) values (uid_d, 'zz.n2.d@ejemplo.invalid');
  insert into public.app_users (id, email, nombre, role, status, notas)
  values (uid_d, 'zz.n2.d@ejemplo.invalid', 'ZZ Ficticio D', 'usuario', 'active', 'prueba N2 (se deshace)');
  insert into public.patients (cama, nombre, exp) values ('ZZ-N2', 'PRUEBA FICTICIA OTRO USUARIO', 'ZZ-N002') returning id into pid;
  insert into public.notes (patient_id, checklist) values (pid, jsonb_build_object('__pl_note_meta', jsonb_build_object('entrega', base,
    'by', jsonb_build_object('entrega', jsonb_build_object('u', 'Prueba', 'i', 'PR', 't',
      to_char((now() - interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))))
    on conflict (patient_id) do update set checklist = excluded.checklist;
  perform set_config('request.headers', mac::text, true);

  -- C (usuario 1, «Mac Chrome») escribe su renglón (deliberado)
  perform set_config('request.jwt.claims', json_build_object('sub', uid_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || lc)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'C', 'i', 'CO', 't',
      to_char((now() - interval '40 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  -- D (usuario 2, MISMO «Mac Chrome» y user-agent) no ha recibido el renglón de C y escribe el suyo (deliberado)
  perform set_config('request.jwt.claims', json_build_object('sub', uid_d, 'role', 'authenticated')::text, true);
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || ld)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'D', 'i', 'DR', 't',
      to_char((now() - interval '30 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  -- N2-1 el renglón de C (otro usuario, mismo equipo, < 15 min) se queda
  if position(lc in e) = 0 or position(ld in e) = 0 then raise exception 'FALLA N2-1 otro usuario en el mismo equipo borró lo reciente: %', e; end if; n := n + 1;

  -- N2-2 control: el MISMO usuario C, en su equipo, sí puede quitar SU renglón (último cambio gana)
  perform set_config('request.jwt.claims', json_build_object('sub', uid_c, 'role', 'authenticated')::text, true);
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || ld)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'C', 'i', 'CO', 't',
      to_char((now() - interval '20 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(lc in e) > 0 or position(ld in e) = 0 then raise exception 'FALLA N2-2 el mismo usuario no pudo quitar su renglón: %', e; end if; n := n + 1;
  reset role;

  -- N2-3 claims corruptos (SQL a mano, como postgres): el guardado deliberado no se rompe
  perform set_config('request.jwt.claims', 'esto no es json', true);
  begin
    update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || ld || E'\n' || l3)),
      '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'SQL', 'i', 'SQ', 't',
        to_char((now() - interval '10 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  exception when others then
    raise exception 'FALLA N2-3 un claims corrupto rompió el guardado: %', sqlerrm;
  end;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(l3 in e) = 0 then raise exception 'FALLA N2-3 el renglón con claims corruptos no entró: %', e; end if; n := n + 1;

  -- N2-4 claims vacíos (robot/cron como service_role, mismo equipo): sin usuario conocido, lo reciente de D se protege
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || l3 || E'\n' || l4)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'SR', 'i', 'SR', 't',
      to_char((now() - interval '5 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(ld in e) = 0 or position(l4 in e) = 0 then raise exception 'FALLA N2-4 con claims vacíos se borró lo reciente de otro usuario: %', e; end if; n := n + 1;
  reset role;

  -- N2-5 lo de otro usuario de hace MÁS de 15 min sí se puede quitar (último cambio gana, igual que antes)
  update public.audit_log set ts = ts - interval '16 minutes' where record_id = pid::text and tabla = 'notes';
  perform set_config('request.jwt.claims', json_build_object('sub', uid_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || l3 || E'\n' || l4)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'C', 'i', 'CO', 't',
      to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(ld in e) > 0 then raise exception 'FALLA N2-5 un renglón de otro usuario de hace 16 min no se pudo quitar: %', e; end if; n := n + 1;
  reset role;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
