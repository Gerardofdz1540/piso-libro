-- ═══ Pruebas de O1 · bitácora por equipo (20 oct 2026) ═════════════════════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Pacientes ficticios ZZ-…
-- Uso: psql … -f otros/01_audit_por_equipo_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
-- Se escribe como la app: rol authenticated, request.jwt.claims con el usuario y request.headers con x-pl-device,
-- x-pl-user y user-agent (así los manda PostgREST a pl_audit).
begin;
do $$
declare
  uid uuid; pid uuid; n int := 0; c int; e text; paso int := 0;
  H_IPAD constant text := json_build_object('x-pl-device', 'ZZ-iPad', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-iPad')::text;
  H_MAC  constant text := json_build_object('x-pl-device', 'ZZ-Mac',  'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-Mac')::text;
  H_MAC2 constant text := json_build_object('x-pl-device', 'ZZ-Mac',  'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-Mac-otra')::text;
  H_PC   constant text := json_build_object('x-pl-device', 'ZZ-PC',   'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-PC')::text;
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text, true);

  -- ── O1-1…4: Mac e iPad del MISMO usuario en menos de 5 min → 2 filas, cada una con su texto ─────────────────
  insert into public.patients (cama, nombre, exp) values ('ZZ-A1', 'ZZ PRUEBA BITACORA UNO', 'ZZ-A001') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ L1') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  perform set_config('request.headers', H_IPAD, true);
  update public.notes set pendientes = E'ZZ L1\nZZ iPad agrega' where patient_id = pid;
  perform set_config('request.headers', H_MAC, true);
  update public.notes set pendientes = E'ZZ L1\nZZ iPad agrega\nZZ Mac TAC HOY 14H' where patient_id = pid;
  reset role;
  select count(*) into c from public.audit_log a where a.record_id = pid::text and a.tabla = 'notes' and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  if c <> 2 then raise exception 'FALLA O1-1 Mac e iPad del mismo usuario en 5 min: % fila(s) en la bitácora (se esperaban 2)', c; end if; n := n + 1;
  select a.diff -> 'pendientes' ->> 'a' into e from public.audit_log a
   where a.record_id = pid::text and a.op = 'UPDATE' and a.dispositivo = 'ZZ-iPad' and a.ua = 'ZZ-UA-iPad';
  if e is distinct from E'ZZ L1\nZZ iPad agrega' then raise exception 'FALLA O1-2 la fila del iPad no tiene el texto del iPad: %', e; end if; n := n + 1;
  select a.diff -> 'pendientes' ->> 'de' || ' → ' || (a.diff -> 'pendientes' ->> 'a') into e from public.audit_log a
   where a.record_id = pid::text and a.op = 'UPDATE' and a.dispositivo = 'ZZ-Mac';
  if e is distinct from E'ZZ L1\nZZ iPad agrega → ZZ L1\nZZ iPad agrega\nZZ Mac TAC HOY 14H' then
    raise exception 'FALLA O1-3 la fila de la Mac no tiene el texto de la Mac: %', e; end if; n := n + 1;
  -- El iPad, con su copia vieja, quita el renglón de la Mac: es OTRA fila y la versión de la Mac sigue en el 🕘.
  set local role authenticated;
  perform set_config('request.headers', H_IPAD, true);
  update public.notes set pendientes = E'ZZ L1\nZZ iPad agrega' where patient_id = pid;
  select count(*) into c from public.pl_historial_caja_v3(pid, 'pendientes', 30) h where h.de like '%TAC HOY 14H%';
  reset role;
  if c <> 1 then raise exception 'FALLA O1-4 el 🕘 no muestra la versión de la Mac antes de que el iPad la quitara (% filas)', c; end if; n := n + 1;

  -- ── O1-5: el MISMO equipo en 5 min → 1 sola fila (la fusión de siempre) ───────────────────────────────────────
  insert into public.patients (cama, nombre, exp) values ('ZZ-A2', 'ZZ PRUEBA BITACORA DOS', 'ZZ-A002') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ X') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  perform set_config('request.headers', H_PC, true);
  update public.notes set pendientes = E'ZZ X\nZZ Y' where patient_id = pid;
  update public.notes set pendientes = E'ZZ X\nZZ Y\nZZ Z' where patient_id = pid;
  update public.notes set pendientes = E'ZZ X\nZZ Y\nZZ Z\nZZ W' where patient_id = pid;
  reset role;
  select count(*) into c from public.audit_log a where a.record_id = pid::text and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  select (a.diff ->> '_fusiones') || '|' || (a.diff -> 'pendientes' ->> 'de') || '|' || (a.diff -> 'pendientes' ->> 'a') into e
    from public.audit_log a where a.record_id = pid::text and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  if c <> 1 or e is distinct from E'2|ZZ X|ZZ X\nZZ Y\nZZ Z\nZZ W' then
    raise exception 'FALLA O1-5 el mismo equipo debía quedar en 1 fila fusionada: % fila(s), %', c, e; end if; n := n + 1;

  -- ── O1-6: misma etiqueta de dispositivo («ZZ-Mac») pero otro navegador (user-agent) → 2 filas ────────────────
  insert into public.patients (cama, nombre, exp) values ('ZZ-A3', 'ZZ PRUEBA BITACORA TRES', 'ZZ-A003') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ X') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  perform set_config('request.headers', H_MAC, true);
  update public.notes set pendientes = E'ZZ X\nZZ Mac uno' where patient_id = pid;
  perform set_config('request.headers', H_MAC2, true);
  update public.notes set pendientes = E'ZZ X\nZZ Mac uno\nZZ Mac dos' where patient_id = pid;
  reset role;
  select count(*) into c from public.audit_log a where a.record_id = pid::text and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  if c <> 2 then raise exception 'FALLA O1-6 mismo dispositivo con otro user-agent: % fila(s) (se esperaban 2)', c; end if; n := n + 1;
  -- O1-6b mismo navegador (user-agent idéntico, misma versión de Chrome) pero otra etiqueta de dispositivo → 2 filas
  insert into public.patients (cama, nombre, exp) values ('ZZ-A3B', 'ZZ PRUEBA BITACORA TRES B', 'ZZ-A03B') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ X') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-Mac piso', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-Chrome-igual')::text, true);
  update public.notes set pendientes = E'ZZ X\nZZ Mac piso' where patient_id = pid;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-Mac consultorio', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-Chrome-igual')::text, true);
  update public.notes set pendientes = E'ZZ X\nZZ Mac piso\nZZ Mac consultorio' where patient_id = pid;
  reset role;
  select count(*) into c from public.audit_log a where a.record_id = pid::text and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  if c <> 2 then raise exception 'FALLA O1-6b mismo user-agent con otra etiqueta de dispositivo: % fila(s) (se esperaban 2)', c; end if; n := n + 1;

  -- ── O1-7: sin usuario (robot/SQL, sin sub en el JWT) nunca se fusiona, aunque mande el mismo x-pl-user ───────
  insert into public.patients (cama, nombre, exp) values ('ZZ-A4', 'ZZ PRUEBA BITACORA CUATRO', 'ZZ-A004') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ X') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.headers', json_build_object('x-pl-user', 'ZZ ROBOT', 'user-agent', 'ZZ-UA-robot')::text, true);
  update public.notes set pendientes = E'ZZ X\nZZ robot 1' where patient_id = pid;
  update public.notes set pendientes = E'ZZ X\nZZ robot 1\nZZ robot 2' where patient_id = pid;
  select count(*) into c from public.audit_log a where a.record_id = pid::text and a.op = 'UPDATE' and a.campos @> array['pendientes'];
  if c <> 2 then raise exception 'FALLA O1-7 sin usuario se fusionó: % fila(s) (se esperaban 2)', c; end if; n := n + 1;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text, true);

  -- ── O1-8: 🌙 Guardia · el renglón que la Mac escribió (misma cuenta) no lo borra el iPad atrasado ─────────────
  -- (rev_integral/auditoria_datos/prueba_fusion_equipos.sql, caso MISMO_USUARIO: antes se perdía «ZZ linea Mac»)
  insert into public.patients (cama, nombre, exp) values ('ZZ-A5', 'ZZ PRUEBA BITACORA CINCO', 'ZZ-A005') returning id into pid;
  insert into public.notes (patient_id, checklist) values (pid, jsonb_build_object('recibo', '', '__pl_note_meta', jsonb_build_object('entrega', 'ZZ base')))
    on conflict (patient_id) do update set checklist = excluded.checklist;
  set local role authenticated;
  perform set_config('request.headers', H_IPAD, true);
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(E'ZZ base\nZZ linea iPad'::text)),
    '{__pl_note_meta,by}', jsonb_build_object('entrega', jsonb_build_object('u', 'zz', 'i', 'ZZ-iPad',
      't', to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))) where patient_id = pid;
  perform set_config('request.headers', H_MAC, true);
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(E'ZZ base\nZZ linea iPad\nZZ linea Mac'::text)),
    '{__pl_note_meta,by}', jsonb_build_object('entrega', jsonb_build_object('u', 'zz', 'i', 'ZZ-Mac',
      't', to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))) where patient_id = pid;
  perform set_config('request.headers', H_IPAD, true);
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(E'ZZ base\nZZ linea iPad\nZZ linea iPad 2'::text)),
    '{__pl_note_meta,by}', jsonb_build_object('entrega', jsonb_build_object('u', 'zz', 'i', 'ZZ-iPad',
      't', to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))) where patient_id = pid;
  reset role;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position('ZZ linea Mac' in e) = 0 or position('ZZ linea iPad 2' in e) = 0 then
    raise exception 'FALLA O1-8 el iPad (misma cuenta, copia atrasada) borró el renglón que la Mac escribió hace segundos: %', replace(e, E'\n', ' | '); end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
