-- ═══ Pruebas de O6 · permisos de historial e indicaciones (20 oct 2026) ═══════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Paciente ficticio ZZ-…
-- Uso: psql … -f otros/06_permisos_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
-- La parte de la app (que el 🕘 usa la v3 y no cae a la v2/v1) se prueba aparte con node: otros/06_app_historial.js
begin;
do $$
declare
  uid uuid; pid uuid; c int; n int := 0; err text; est text; t text; rid bigint;
  H constant text := json_build_object('x-pl-device', 'ZZ-iPad', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-iPad')::text;
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', H, true);
  insert into public.patients (cama, nombre, exp) values ('ZZ-H1', 'ZZ PRUEBA PERMISOS', 'ZZ-H001') returning id into pid;
  insert into public.notes (patient_id, pendientes) values (pid, 'ZZ versión A') on conflict (patient_id) do update set pendientes = excluded.pendientes;
  set local role authenticated;
  update public.notes set pendientes = 'ZZ versión B' where patient_id = pid;
  -- H1 la app (authenticated, cuenta activa) sigue viendo el 🕘 con la v3
  select count(*) into c from public.pl_historial_caja_v3(pid, 'pendientes', 30) h where h.de = 'ZZ versión A' and h.a = 'ZZ versión B';
  reset role;
  if c <> 1 then raise exception 'FALLA H1 la v3 dejó de funcionar para la app (% filas)', c; end if; n := n + 1;
  -- H2 v2 y v1: ya no para authenticated (42501 → HTTP 403 en PostgREST)
  set local role authenticated;
  begin perform * from public.pl_historial_caja_v2(pid, 'pendientes', 30); est := null;
  exception when others then get stacked diagnostics est = returned_sqlstate; end;
  reset role;
  if est is distinct from '42501' then raise exception 'FALLA H2 authenticated todavía ejecuta pl_historial_caja_v2 (sqlstate %)', coalesce(est, 'sin error'); end if; n := n + 1;
  set local role authenticated;
  begin perform * from public.pl_historial_caja(pid, 'pendientes', 30); est := null;
  exception when others then get stacked diagnostics est = returned_sqlstate; end;
  reset role;
  if est is distinct from '42501' then raise exception 'FALLA H3 authenticated todavía ejecuta pl_historial_caja (v1) (sqlstate %)', coalesce(est, 'sin error'); end if; n := n + 1;
  -- H4 mantenimiento: postgres y service_role sí pueden llamar v1 y v2 (y siguen dando lo mismo que la v3)
  select count(*) into c from public.pl_historial_caja_v2(pid, 'pendientes', 30) h where h.de = 'ZZ versión A';
  if c <> 1 then raise exception 'FALLA H4 postgres ya no ve la v2 igual que la v3 (% filas)', c; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  perform * from public.pl_historial_caja(pid, 'pendientes', 30);
  perform * from public.pl_historial_caja_v2(pid, 'pendientes', 30);
  reset role;
  n := n + 1;

  -- H5 anon (la llave pública) ya no dispara la descarga del Doc ni procesa la cola
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  select count(*) into c from net.http_request_queue;
  set local role anon;
  begin perform public.indicaciones_fetch(); est := null;
  exception when others then get stacked diagnostics est = returned_sqlstate; end;
  reset role;
  if est is distinct from '42501' or (select count(*) from net.http_request_queue) <> c then
    raise exception 'FALLA H5 anon todavía ejecuta indicaciones_fetch (sqlstate %)', coalesce(est, 'sin error'); end if; n := n + 1;
  set local role anon;
  begin perform public.indicaciones_collect(); est := null;
  exception when others then get stacked diagnostics est = returned_sqlstate; end;
  reset role;
  if est is distinct from '42501' then raise exception 'FALLA H6 anon todavía ejecuta indicaciones_collect (sqlstate %)', coalesce(est, 'sin error'); end if; n := n + 1;
  -- H7 los crons (postgres, sin JWT) siguen funcionando, igual que service_role
  perform set_config('request.jwt.claims', '', true);
  rid := public.indicaciones_fetch();
  t := public.indicaciones_collect();
  if rid is null or t is null or t not like 'seen=%' then raise exception 'FALLA H7 los crons de indicaciones fallan como postgres (% / %)', rid, t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  rid := public.indicaciones_fetch();
  t := public.indicaciones_collect();
  reset role;
  if rid is null or t not like 'seen=%' then raise exception 'FALLA H7b service_role ya no ejecuta indicaciones_*'; end if; n := n + 1;
  -- H8 la matriz completa de permisos queda como se propuso
  select string_agg(format('%s:%s/%s/%s', u.f, has_function_privilege('anon', u.f, 'execute'), has_function_privilege('authenticated', u.f, 'execute'),
                           has_function_privilege('service_role', u.f, 'execute')), ' ' order by u.i) into t
    from unnest(array['public.pl_historial_caja(uuid,text,integer)', 'public.pl_historial_caja_v2(uuid,text,integer)', 'public.pl_historial_caja_v3(uuid,text,integer)',
                      'public.indicaciones_fetch()', 'public.indicaciones_collect()']) with ordinality u(f, i);
  if t <> 'public.pl_historial_caja(uuid,text,integer):f/f/t public.pl_historial_caja_v2(uuid,text,integer):f/f/t '
        || 'public.pl_historial_caja_v3(uuid,text,integer):f/t/t public.indicaciones_fetch():f/t/t public.indicaciones_collect():f/t/t' then
    raise exception 'FALLA H8 permisos (anon/authenticated/service_role): %', t; end if; n := n + 1;
  -- H9 en la réplica (copia de cron.job de producción) los crons de indicaciones corren como postgres, no como anon
  select count(*) into c from cron.job where command like '%indicaciones_%' and username = 'postgres';
  if c <> 2 or exists (select 1 from cron.job where command like '%indicaciones_%' and username <> 'postgres') then
    raise exception 'FALLA H9 cron.job: % trabajos de indicaciones como postgres', c; end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
