-- ═══ Pruebas de O5 · alarma de pérdidas con todas las cajas y ventana móvil (20 oct 2026) ═══════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Pacientes ficticios ZZ-…
-- Uso: psql … -f otros/05_alarma_perdidas_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
-- Cada escenario guarda de verdad (los triggers de producción escriben la bitácora con su formato) y luego se fecha la
-- fila de audit_log en el minuto que toca. Cada escenario usa su propia etiqueta de dispositivo para no mezclarse.
begin;
create function pg_temp.zz_cama(p_cama text, p_ck jsonb, p_pend text default '') returns uuid language plpgsql as $f$
declare v uuid;
begin
  insert into public.patients (cama, nombre, exp) values (p_cama, 'ZZ PRUEBA ALARMA ' || p_cama, 'ZZ-' || p_cama) returning id into v;
  insert into public.notes (patient_id, checklist, pendientes) values (v, p_ck, p_pend)
    on conflict (patient_id) do update set checklist = excluded.checklist, pendientes = excluded.pendientes;
  return v;
end $f$;
-- Guarda como un equipo (usuario del JWT + cabeceras de la app) y pone la hora a la fila que dejó pl_audit.
create function pg_temp.zz_guardar(p_pid uuid, p_uid uuid, p_dev text, p_ua text, p_ts timestamptz, p_ck jsonb, p_pend text default null)
returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', json_build_object('x-pl-device', p_dev, 'x-pl-user', 'ZZ', 'user-agent', p_ua)::text, true);
  update public.notes set checklist = checklist || coalesce(p_ck, '{}'::jsonb), pendientes = coalesce(p_pend, pendientes) where patient_id = p_pid;
  update public.audit_log set ts = p_ts
   where id = (select max(id) from public.audit_log where record_id = p_pid::text and tabla = 'notes' and op = 'UPDATE');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
end $f$;
do $$
declare
  uid uuid; u2 uuid := '00000000-0000-4000-8000-0000000ad0b2';
  b1 timestamptz; b2 timestamptz; t timestamptz; c int; n int := 0; r int; x jsonb; p1 uuid; p2 uuid; p3 uuid; g int;
  meta jsonb;
begin
  select id into uid from public.app_users where status = 'active' and role = 'usuario' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into auth.users (id, email) values (u2, 'zz-otra@prueba.invalid');
  insert into public.app_users (id, email, nombre, role, status) values (u2, 'zz-otra@prueba.invalid', 'ZZ OTRA PERSONA', 'usuario', 'active');
  -- b1 y b2: minutos pares (bordes de las cubetas de 2 min de la versión anterior), entre hace 20 y hace 14 min.
  b1 := date_bin('2 minutes', now() - interval '20 minutes', timestamptz '2026-01-01') + interval '2 minutes';
  b2 := b1 + interval '4 minutes';

  -- S1 · la ráfaga del 19/10 08:43: Cirugías + signos del pase + NPT en 3 camas en 70 s, cruzando un minuto par
  p1 := pg_temp.zz_cama('ZZ-S1A', jsonb_build_object('recibo', 'ZZ recibí paciente estable',
          'cirugias', jsonb_build_array(jsonb_build_object('id', 'czzA1', 'procedimiento', 'ZZ LAPE'), jsonb_build_object('id', 'czzA2', 'procedimiento', 'ZZ RAFA'))));
  p2 := pg_temp.zz_cama('ZZ-S1B', jsonb_build_object('pm_fc', '88', 'pm_ta', '120/80', 'pm_temp', '36.5', 'pm_fecha', '2026-10-19'));
  p3 := pg_temp.zz_cama('ZZ-S1C', jsonb_build_object('npt', true, 'npt_pct', '80',
          'pm_hist', '[{"fecha":"2026-10-17","fc":"90"},{"fecha":"2026-10-18","fc":"85"},{"fecha":"2026-10-19","fc":"82"}]'::jsonb));
  perform pg_temp.zz_guardar(p1, uid, 'ZZ-S1 Mac Chrome', 'ZZ-UA-S1', b1 - interval '35 seconds', jsonb_build_object('recibo', '', 'cirugias', '[]'::jsonb));
  perform pg_temp.zz_guardar(p2, uid, 'ZZ-S1 Mac Chrome', 'ZZ-UA-S1', b1 + interval '5 seconds', jsonb_build_object('pm_fc', '', 'pm_ta', '', 'pm_temp', ''));
  perform pg_temp.zz_guardar(p3, uid, 'ZZ-S1 Mac Chrome', 'ZZ-UA-S1', b1 + interval '35 seconds', jsonb_build_object('pm_hist', '[]'::jsonb, 'npt', false, 'npt_pct', ''));

  -- S2 · solo textos (Pendientes), 3 camas en 70 s cruzando un minuto par: lo que la cubeta fija partía en 1 + 2
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S2' || g, '{}'::jsonb, E'ZZ renglón que se queda\nZZ renglón que se pierde ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S2 Mac Chrome', 'ZZ-UA-S2', b2 + make_interval(secs => (array[-35, 5, 35])[g]), null, 'ZZ renglón que se queda');
  end loop;

  -- S3 · 3 ediciones deliberadas espaciadas (cada 3 min) → no es ráfaga
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S3' || g, '{}'::jsonb, E'ZZ queda\nZZ ya se hizo ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S3 Mac Chrome', 'ZZ-UA-S3', now() - interval '18 minutes' + make_interval(mins => 3 * (g - 1)), null, 'ZZ queda');
  end loop;
  -- S3b · borde de la ventana: 0 s, 110 s y 150 s (ninguna ventana de 2 min tiene 3 camas)
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S3B' || g, '{}'::jsonb, E'ZZ queda\nZZ se quita ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S3b Mac Chrome', 'ZZ-UA-S3b', now() - interval '9 minutes' + make_interval(secs => (array[0, 110, 150])[g]), null, 'ZZ queda');
  end loop;

  -- S4 · dos personas con la misma etiqueta «Mac Chrome» y el mismo navegador: 2 camas una y 1 la otra → no es UN equipo
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S4' || g, '{}'::jsonb, E'ZZ queda\nZZ se quita ' || g);
    perform pg_temp.zz_guardar(p1, case when g = 3 then u2 else uid end, 'ZZ-S4 Mac Chrome', 'ZZ-UA-S4', now() - interval '8 minutes' + make_interval(secs => 20 * g), null, 'ZZ queda');
  end loop;
  -- S4b · la misma persona, misma etiqueta, otro navegador en la tercera cama → tampoco
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S4B' || g, '{}'::jsonb, E'ZZ queda\nZZ se quita ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S4b Mac Chrome', case when g = 3 then 'ZZ-UA-S4b-otro' else 'ZZ-UA-S4b' end,
                               now() - interval '7 minutes' + make_interval(secs => 20 * g), null, 'ZZ queda');
  end loop;

  -- S5 · mudanzas (no son pérdidas), cada tipo en 3 camas en 60 s con su propio equipo:
  --   S5a un renglón que pasa de Pendientes a Recibido; S5b el cambio de día del pase (pm_fc → pm_hist);
  --   S5c un renglón que pasa de Pendientes R1 a Pendientes MIP
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S5A' || g, jsonb_build_object('recibo', ''), 'ZZ pasa a recibido ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S5a Mac Chrome', 'ZZ-UA-S5a', now() - interval '6 minutes' + make_interval(secs => 20 * g),
            jsonb_build_object('recibo', 'ZZ pasa a recibido ' || g), '');
    p2 := pg_temp.zz_cama('ZZ-S5B' || g, jsonb_build_object('pm_fc', (80 + g)::text, 'pm_fecha', '2026-10-19', 'pm_hist', '[]'::jsonb));
    perform pg_temp.zz_guardar(p2, uid, 'ZZ-S5b Mac Chrome', 'ZZ-UA-S5b', now() - interval '6 minutes' + make_interval(secs => 20 * g),
            jsonb_build_object('pm_fc', '', 'pm_fecha', '2026-10-20', 'pm_hist', jsonb_build_array(jsonb_build_object('fecha', '2026-10-19', 'fc', (80 + g)::text))));
    p3 := pg_temp.zz_cama('ZZ-S5C' || g, jsonb_build_object('pendientes_r1', 'ZZ pasa a MIP ' || g, 'pendientes_mips', ''));
    perform pg_temp.zz_guardar(p3, uid, 'ZZ-S5c Mac Chrome', 'ZZ-UA-S5c', now() - interval '6 minutes' + make_interval(secs => 20 * g),
            jsonb_build_object('pendientes_r1', '', 'pendientes_mips', 'ZZ pasa a MIP ' || g));
  end loop;

  -- S9 · Cirugías con el mismo número de elementos pero otra lista (una cirugía quitada, otra agregada) en 3 camas → pérdida por id
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S9' || g, jsonb_build_object('cirugias', jsonb_build_array(jsonb_build_object('id', 'czz9a' || g, 'procedimiento', 'ZZ LAPE'),
            jsonb_build_object('id', 'czz9b' || g, 'procedimiento', 'ZZ RAFA'))));
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S9 Mac Chrome', 'ZZ-UA-S9', now() - interval '3 minutes' + make_interval(secs => 20 * g),
            jsonb_build_object('cirugias', jsonb_build_array(jsonb_build_object('id', 'czz9a' || g, 'procedimiento', 'ZZ LAPE'),
            jsonb_build_object('id', 'czz9x' || g, 'procedimiento', 'ZZ OTRA'))));
  end loop;

  -- S6 · 🌙 Guardia: 3 camas en 60 s quitan un renglón (edición deliberada, la regla de la Guardia la deja pasar)
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S6' || g, jsonb_build_object('__pl_note_meta', jsonb_build_object('entrega', E'ZZ G queda\nZZ G se quita ' || g)));
    meta := jsonb_build_object('__pl_note_meta', jsonb_build_object('entrega', 'ZZ G queda',
              'by', jsonb_build_object('entrega', jsonb_build_object('u', 'ZZ', 'i', 'ZZ', 't', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))));
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S6 Mac Chrome', 'ZZ-UA-S6', now() - interval '5 minutes' + make_interval(secs => 20 * g), meta);
  end loop;

  -- S7 · ráfaga ya avisada por la versión anterior (fila sin user_id ni ua) → no se repite
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S7' || g, '{}'::jsonb, E'ZZ queda\nZZ se quita ' || g);
    perform pg_temp.zz_guardar(p1, uid, 'ZZ-S7 Mac Chrome', 'ZZ-UA-S7', now() - interval '4 minutes' + make_interval(secs => 20 * g), null, 'ZZ queda');
  end loop;
  insert into public.perdidas_alerta (dispositivo, nombre, desde, hasta, camas, renglones, detalle)
  values ('ZZ-S7 Mac Chrome', 'ZZ', now() - interval '4 minutes' + interval '20 seconds', now() - interval '4 minutes' + interval '40 seconds', 2, 2, '[]'::jsonb);

  -- S10 · el paso de las 06:15 (pl_guardia_a_cronologia, como cron: sin JWT ni cabeceras) pasa la Guardia de todas las
  --       camas a la Cronología en el mismo instante: es una mudanza, no una pérdida
  for g in 1..3 loop
    p1 := pg_temp.zz_cama('ZZ-S10' || g, jsonb_build_object('__pl_note_meta', jsonb_build_object('entrega', E'ZZ G10 renglón de la noche ' || g)));
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.headers', '', true);
  perform public.pl_guardia_a_cronologia();
  select count(*) into c from public.notes nt join public.patients pt on pt.id = nt.patient_id
   where pt.cama like 'ZZ-S10%' and nt.cronologia like '%ZZ G10 renglón de la noche%' and coalesce(nt.checklist #>> '{__pl_note_meta,entrega}', '') = '';
  if c <> 3 then raise exception 'FALLA S10 (preparación) pl_guardia_a_cronologia no pasó las 3 camas (%)', c; end if;

  r := public.pl_detectar_perdidas();

  -- S1
  select jsonb_build_object('n', count(*), 'camas', max(camas), 'renglones', max(renglones), 'uid', bool_and(user_id = uid), 'ua', max(ua),
                            'desde', min(desde) = b1 - interval '35 seconds', 'hasta', max(hasta) = b1 + interval '35 seconds',
                            'campos', (select jsonb_agg(distinct d->>'campo' order by d->>'campo') from public.perdidas_alerta pa, jsonb_array_elements(pa.detalle) d
                                        where pa.dispositivo = 'ZZ-S1 Mac Chrome'))
    into x from public.perdidas_alerta where dispositivo = 'ZZ-S1 Mac Chrome';
  if (x->>'n')::int <> 1 then raise exception 'FALLA S1 ráfaga del 19/10 (cirugías + pase + NPT, 70 s, cruza minuto par): % alertas (se esperaba 1) · %', x->>'n', x; end if; n := n + 1;
  if x->>'camas' <> '3' or x->>'renglones' <> '11' or x->>'uid' <> 'true' or x->>'ua' <> 'ZZ-UA-S1' or x->>'desde' <> 'true' or x->>'hasta' <> 'true' then
    raise exception 'FALLA S1b datos de la alerta: %', x; end if; n := n + 1;
  if not (x->'campos' ?& array['ck:cirugias', 'ck:recibo', 'ck:pm_fc', 'ck:pm_ta', 'ck:pm_temp', 'ck:pm_hist', 'ck:npt', 'ck:npt_pct']) then
    raise exception 'FALLA S1c la alerta no nombra todas las cajas: %', x->'campos'; end if; n := n + 1;
  -- S2
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S2 Mac Chrome' and camas = 3;
  if c <> 1 then raise exception 'FALLA S2 textos en 3 camas en 70 s cruzando minuto par: % alertas (se esperaba 1)', c; end if; n := n + 1;
  -- S3 / S3b
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S3 Mac Chrome';
  if c <> 0 then raise exception 'FALLA S3 3 ediciones deliberadas espaciadas dieron % alertas', c; end if; n := n + 1;
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S3b Mac Chrome';
  if c <> 0 then raise exception 'FALLA S3b 0 s / 110 s / 150 s no caben en 2 min y dieron % alertas', c; end if; n := n + 1;
  -- S4 / S4b
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S4 Mac Chrome';
  if c <> 0 then raise exception 'FALLA S4 dos personas con «Mac Chrome» contaron como un equipo (% alertas)', c; end if; n := n + 1;
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S4b Mac Chrome';
  if c <> 0 then raise exception 'FALLA S4b otro navegador contó como el mismo equipo (% alertas)', c; end if; n := n + 1;
  -- S5a / S5b / S5c
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S5a Mac Chrome';
  if c <> 0 then raise exception 'FALLA S5a un renglón que pasó de Pendientes a Recibido se tomó como pérdida (% alertas)', c; end if; n := n + 1;
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S5b Mac Chrome';
  if c <> 0 then raise exception 'FALLA S5b el cambio de día del pase (pm_fc → pm_hist) se tomó como pérdida (% alertas)', c; end if; n := n + 1;
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S5c Mac Chrome';
  if c <> 0 then raise exception 'FALLA S5c un renglón que pasó de R1 a MIP se tomó como pérdida (% alertas)', c; end if; n := n + 1;
  -- S9
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S9 Mac Chrome' and camas = 3 and renglones = 3;
  if c <> 1 then raise exception 'FALLA S9 Cirugías cambiadas por otra (mismo número, otro id) en 3 camas no avisó (% alertas)', c; end if; n := n + 1;
  -- S6
  select count(*) into c from public.perdidas_alerta pa where pa.dispositivo = 'ZZ-S6 Mac Chrome' and pa.camas = 3
     and exists (select 1 from jsonb_array_elements(pa.detalle) d where d->>'campo' = 'entrega');
  if c <> 1 then raise exception 'FALLA S6 la 🌙 Guardia en 3 camas no avisó (% alertas)', c; end if; n := n + 1;
  -- S7
  select count(*) into c from public.perdidas_alerta where dispositivo = 'ZZ-S7 Mac Chrome';
  if c <> 1 then raise exception 'FALLA S7 la ráfaga ya avisada por la versión anterior se volvió a avisar (% filas)', c; end if; n := n + 1;
  -- S10
  select count(*) into c from public.perdidas_alerta where dispositivo is null and user_id is null;
  if c <> 0 then raise exception 'FALLA S10 el paso de las 06:15 (Guardia → Cronología) se tomó como pérdida (% alertas)', c; end if; n := n + 1;
  -- S8 correr otra vez no repite nada
  r := public.pl_detectar_perdidas();
  if r <> 0 then raise exception 'FALLA S8 la segunda corrida agregó % alertas', r; end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
