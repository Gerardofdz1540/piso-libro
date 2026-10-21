-- ═══ Pruebas de O4 · borrado masivo solo para el administrador (20 oct 2026) ═════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Datos ficticios ZZ-…
-- Uso: psql … -f otros/04_borrado_masivo_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
begin;
do $$
declare
  uid uuid; adm uuid := '00000000-0000-4000-8000-0000000ad002'; c int; c2 int; n int := 0; err text; est text; pid uuid;
  C_USR text; C_ADM text; C_SVC constant text := json_build_object('role', 'service_role')::text;
  H constant text := json_build_object('x-pl-device', 'ZZ-iPad', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-iPad')::text;
begin
  select id into uid from public.app_users where status = 'active' and role = 'usuario' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into auth.users (id, email) values (adm, 'zz-admin2@prueba.invalid');
  insert into public.app_users (id, email, nombre, role, status) values (adm, 'zz-admin2@prueba.invalid', 'ZZ ADMIN', 'admin', 'active');
  C_USR := json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text;
  C_ADM := json_build_object('sub', adm, 'role', 'authenticated', 'email', 'zz-admin2@prueba.invalid')::text;
  perform set_config('request.headers', H, true);
  perform set_config('request.jwt.claims', C_USR, true);
  insert into public.no_olvidar (texto, author) select 'ZZ masivo ' || g, 'ZZ R2' from generate_series(1, 8) g;
  insert into public.procedimientos_dia (cama, exp, nombre) select 'ZZ-M' || g, 'ZZ-M00' || g, 'ZZ MASIVO ' || g from generate_series(1, 8) g;
  insert into public.patients (cama, nombre, exp, esp) select 'ZZ-M' || g, 'ZZ PRUEBA MASIVO ' || g, 'ZZ-M00' || g, 'ZZESP' from generate_series(1, 8) g;
  insert into public.notes (patient_id, pendientes) select id, 'ZZ nota ' || cama from public.patients where esp = 'ZZESP' on conflict (patient_id) do nothing;

  -- B1 cuenta normal borra 6 de No olvidar de un jalón → error claro y no se borra nada
  set local role authenticated;
  begin
    delete from public.no_olvidar where id in (select id from public.no_olvidar where texto like 'ZZ masivo %' order by id limit 6);
    err := null;
  exception when others then err := sqlerrm; get stacked diagnostics est = returned_sqlstate;
  end;
  reset role;
  if err is null or position('Borrado masivo bloqueado' in err) = 0 or position('6 renglones de No olvidar' in err) = 0 or position('administrador' in err) = 0 then
    raise exception 'FALLA B1 la cuenta normal borró 6 filas de No olvidar (o el mensaje no es claro): %', coalesce(err, 'sin error'); end if;
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 8 then raise exception 'FALLA B1 quedaron % de 8', c; end if;
  if to_regclass('public.borrados_otros') is not null then
    execute 'select count(*) from public.borrados_otros where fila->>''texto'' like ''ZZ masivo %''' into c;
    if c <> 0 then raise exception 'FALLA B1 quedaron % copias de un borrado que se deshizo', c; end if;
  end if;
  n := n + 1;
  if est is distinct from 'P0001' then raise exception 'FALLA B1b código % (se esperaba P0001 → HTTP 400, que la app no reintenta)', est; end if; n := n + 1;
  -- B2 borra 1 → pasa
  set local role authenticated;
  delete from public.no_olvidar where id = (select min(id) from public.no_olvidar where texto like 'ZZ masivo %');
  -- B3 borra exactamente 5 → pasa (el límite es «más de 5»)
  delete from public.no_olvidar where id in (select id from public.no_olvidar where texto like 'ZZ masivo %' order by id limit 5);
  reset role;
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 2 then raise exception 'FALLA B2/B3 borrar 1 y luego 5 dejó % de 2', c; end if; n := n + 1;

  -- B4 el administrador borra 6 → pasa
  insert into public.no_olvidar (texto, author) select 'ZZ masivo ' || g, 'ZZ R2' from generate_series(11, 16) g;
  perform set_config('request.jwt.claims', C_ADM, true);
  set local role authenticated;
  delete from public.no_olvidar where texto like 'ZZ masivo %';
  reset role;
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 0 then raise exception 'FALLA B4 el administrador no pudo borrar 8 (quedan %)', c; end if; n := n + 1;
  -- B5 service_role (robots) borra 6 → pasa
  insert into public.no_olvidar (texto, author) select 'ZZ masivo ' || g, 'ZZ R2' from generate_series(21, 26) g;
  perform set_config('request.jwt.claims', C_SVC, true);
  set local role service_role;
  delete from public.no_olvidar where texto like 'ZZ masivo %';
  reset role;
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 0 then raise exception 'FALLA B5 service_role no pudo borrar 6 (quedan %)', c; end if; n := n + 1;
  -- B6 postgres sin JWT (crons, SQL) borra 6 → pasa
  insert into public.no_olvidar (texto, author) select 'ZZ masivo ' || g, 'ZZ R2' from generate_series(31, 36) g;
  perform set_config('request.jwt.claims', '', true);
  delete from public.no_olvidar where texto like 'ZZ masivo %';
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 0 then raise exception 'FALLA B6 postgres no pudo borrar 6 (quedan %)', c; end if; n := n + 1;
  -- B7 mantenimiento con pl.entrega_libre aunque la sesión diga authenticated → pasa
  insert into public.no_olvidar (texto, author) select 'ZZ masivo ' || g, 'ZZ R2' from generate_series(41, 46) g;
  perform set_config('request.jwt.claims', C_USR, true);
  perform set_config('pl.entrega_libre', 'on', true);
  set local role authenticated;
  delete from public.no_olvidar where texto like 'ZZ masivo %';
  reset role;
  perform set_config('pl.entrega_libre', 'off', true);
  select count(*) into c from public.no_olvidar where texto like 'ZZ masivo %';
  if c <> 0 then raise exception 'FALLA B7 con pl.entrega_libre no se pudo borrar (quedan %)', c; end if; n := n + 1;

  -- B8 pacientes: «Eliminar especialidad» de 8 por una cuenta normal → error; pacientes, notas y Papelera intactos
  set local role authenticated;
  begin
    delete from public.patients where esp = 'ZZESP';
    err := null;
  exception when others then err := sqlerrm;
  end;
  reset role;
  select count(*) into c from public.patients where esp = 'ZZESP';
  select count(*) into c2 from public.archive a where a.patient_data->>'exp' like 'ZZ-M00%';
  if err is null or position('8 pacientes' in err) = 0 or c <> 8 or c2 <> 0 then
    raise exception 'FALLA B8 borrado masivo de pacientes: error=% quedan=% papelera=%', coalesce(err, 'sin error'), c, c2; end if; n := n + 1;
  -- B9 notas: 6 de un jalón → error
  set local role authenticated;
  begin
    delete from public.notes where patient_id in (select id from public.patients where esp = 'ZZESP' order by cama limit 6);
    err := null;
  exception when others then err := sqlerrm;
  end;
  reset role;
  select count(*) into c from public.notes nt join public.patients p on p.id = nt.patient_id where p.esp = 'ZZESP';
  if err is null or position('6 notas' in err) = 0 or c <> 8 then raise exception 'FALLA B9 notas: error=% quedan=%', coalesce(err, 'sin error'), c; end if; n := n + 1;
  -- B10 procedimientos del día: 6 de un jalón → error; 1 → pasa
  set local role authenticated;
  begin
    delete from public.procedimientos_dia where nombre like 'ZZ MASIVO %' and cama in ('ZZ-M1', 'ZZ-M2', 'ZZ-M3', 'ZZ-M4', 'ZZ-M5', 'ZZ-M6');
    err := null;
  exception when others then err := sqlerrm;
  end;
  delete from public.procedimientos_dia where nombre = 'ZZ MASIVO 8';
  reset role;
  select count(*) into c from public.procedimientos_dia where nombre like 'ZZ MASIVO %';
  if err is null or position('6 procedimientos del día' in err) = 0 or c <> 7 then
    raise exception 'FALLA B10 procedimientos: error=% quedan=%', coalesce(err, 'sin error'), c; end if; n := n + 1;
  -- B11 alta normal de UN paciente (con su nota en cascada) → pasa y va a la Papelera
  select id into pid from public.patients where esp = 'ZZESP' and cama = 'ZZ-M1';
  set local role authenticated;
  delete from public.patients where id = pid;
  reset role;
  select count(*) into c from public.archive a where a.patient_data->>'_supa_id' = pid::text;
  if c <> 1 or exists (select 1 from public.notes where patient_id = pid) then raise exception 'FALLA B11 alta de un paciente: papelera=%', c; end if; n := n + 1;
  -- B12 el administrador borra 7 pacientes (y sus 7 notas en cascada) → pasa
  perform set_config('request.jwt.claims', C_ADM, true);
  set local role authenticated;
  delete from public.patients where esp = 'ZZESP';
  reset role;
  select count(*) into c from public.patients where esp = 'ZZESP';
  select count(*) into c2 from public.archive a where a.patient_data->>'exp' like 'ZZ-M00%';
  if c <> 0 or c2 <> 8 then raise exception 'FALLA B12 el administrador no pudo borrar 7 pacientes: quedan % · papelera %', c, c2; end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
