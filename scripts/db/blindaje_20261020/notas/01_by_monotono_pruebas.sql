-- ═══ Pruebas de N1 · sellos «by» que solo avanzan (20 oct 2026) ═══════════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Paciente ficticio ZZ-N1.
-- Se prueba como rol «authenticated» (como guarda la app) con request.jwt.claims y request.headers.
-- Reproduce rev_integral/critico_riesgo/do_by_regresion.sql: A borra un renglón a propósito, B (copia de hace 2 días)
-- regresaba el sello y C (sello de hace 10 min, entre los dos) resucitaba el renglón.
-- Uso: psql … -f 01_by_monotono_pruebas.sql   → «RESULTADO OK: n pruebas» o la primera «FALLA …».
begin;
do $$
declare
  uid uuid; pid uuid; n int := 0; e text; x2 text; b jsonb; b_tras_b jsonb;
  f text := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
  t_viejo text := to_char((now() - interval '20 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  t_a text := to_char((now() - interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  t_b text := to_char((now() - interval '2 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  t_c text := to_char((now() - interval '10 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  base text := '19/10 ZZ: renglón base de la prueba de sellos';
  x text := '19/10 ZZ: renglón que A borra a propósito';
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into public.patients (cama, nombre, exp) values ('ZZ-N1', 'PRUEBA FICTICIA SELLOS', 'ZZ-N001') returning id into pid;
  insert into public.notes (patient_id, checklist) values (pid, jsonb_build_object('npo', false,
    '__pl_note_meta', jsonb_build_object('entrega', base || E'\n' || x, 'resumen_pdf', '2026-10-14',
      'by', jsonb_build_object('entrega', jsonb_build_object('u', 'Prueba Vieja', 'i', 'PV', 't', t_viejo),
                               'cirugias', jsonb_build_object('u', 'Prueba Cx', 'i', 'PC', 't', t_viejo)))))
    on conflict (patient_id) do update set checklist = excluded.checklist;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- N1-1 un sello nuevo sí entra: A (deliberado, hace 1 min) borra X
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-A', 'user-agent', 'UA-A')::text, true);
  set local role authenticated;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'Equipo A', 'i', 'EA', 't', t_a)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}', checklist #> '{__pl_note_meta,by,entrega}' into e, b from public.notes where patient_id = pid;
  if e is distinct from base or b ->> 't' is distinct from t_a then raise exception 'FALLA N1-1 el sello nuevo no entró: % / %', e, b; end if; n := n + 1;

  -- B: copia vieja (de hace 2 días) que todavía trae X y su sello viejo
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-B', 'user-agent', 'UA-B')::text, true);
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || x)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'Equipo B', 'i', 'EB', 't', t_b)) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by,entrega}' into b_tras_b from public.notes where patient_id = pid;
  -- C: su sello (hace 10 min) queda entre el de B y el de A; su copia también trae X
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-C', 'user-agent', 'UA-C')::text, true);
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(base || E'\n' || x)),
    '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'Equipo C', 'i', 'EC', 't', t_c)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}', checklist #> '{__pl_note_meta,by,entrega}' into e, b from public.notes where patient_id = pid;
  -- N1-3 (se revisa primero: es el efecto clínico) la copia con sello intermedio ya no cuenta como deliberada
  if position(x in e) > 0 then raise exception 'FALLA N1-3 la copia de C (sello intermedio) resucitó lo que A borró: %', e; end if; n := n + 1;
  -- N1-2 la copia vieja de B no regresó el sello: quedó el de A COMPLETO (u, i, t), no el de B
  if b_tras_b is distinct from jsonb_build_object('u', 'Equipo A', 'i', 'EA', 't', t_a) then
    raise exception 'FALLA N1-2 la copia vieja regresó el sello: %', b_tras_b; end if; n := n + 1;

  -- N1-4 un sello con la MISMA hora no es más viejo: entra el de NEW (aquí con m = 'agregar')
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Equipo D', 'i', 'ED', 'm', 'agregar', 't', t_a)) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by,entrega}' into b from public.notes where patient_id = pid;
  if b ->> 'm' is distinct from 'agregar' or b ->> 'u' is distinct from 'Equipo D' then raise exception 'FALLA N1-4 un sello con la misma hora no entró: %', b; end if; n := n + 1;

  -- N1-5 el sello de OTRA caja que NEW no trae (by.cirugias) se conserva
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by}', (checklist #> '{__pl_note_meta,by}') - 'cirugias'::text) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by,cirugias}' into b from public.notes where patient_id = pid;
  if b ->> 't' is distinct from t_viejo then raise exception 'FALLA N1-5 se perdió el sello de cirugías: %', b; end if; n := n + 1;

  -- N1-6 un sello ilegible en NEW no reemplaza al guardado
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Equipo E', 'i', 'EE', 't', 'ayer en la tarde')) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by,entrega}' into b from public.notes where patient_id = pid;
  if b ->> 't' is distinct from t_a then raise exception 'FALLA N1-6 un sello ilegible reemplazó al bueno: %', b; end if; n := n + 1;

  -- N1-7 un checklist SIN __pl_note_meta no crea una meta a medias: vuelve completa (Guardia, sellos y las demás llaves)
  update public.notes set checklist = jsonb_build_object('npo', true) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}', checklist #> '{__pl_note_meta,by,entrega}', checklist #>> '{__pl_note_meta,resumen_pdf}'
    into e, b, x2 from public.notes where patient_id = pid;
  if e is distinct from base or b ->> 't' is distinct from t_a or x2 is distinct from '2026-10-14' then
    raise exception 'FALLA N1-7 la meta no volvió completa: % / % / resumen_pdf=%', e, b, x2; end if; n := n + 1;

  -- N1-10 un «by» que no es objeto: vuelven todos los sellos guardados
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by}', to_jsonb('x'::text)) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by}' into b from public.notes where patient_id = pid;
  if jsonb_typeof(b) is distinct from 'object' or b #>> '{entrega,t}' is distinct from t_a or b #>> '{cirugias,t}' is distinct from t_viejo then
    raise exception 'FALLA N1-10 un by que no es objeto borró los sellos: %', b; end if; n := n + 1;

  -- N1-8 con el permiso de mantenimiento (pl.entrega_libre) el sello sí puede regresar
  reset role;
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Mantenimiento', 'i', 'MT', 't', t_b)) where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  select checklist #> '{__pl_note_meta,by,entrega}' into b from public.notes where patient_id = pid;
  if b ->> 't' is distinct from t_b then raise exception 'FALLA N1-8 el mantenimiento no pudo regresar el sello: %', b; end if; n := n + 1;

  -- N1-9 un sello guardado DEL FUTURO (reloj adelantado, +2 h) no bloquea un guardado con la hora real
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Reloj Adelantado', 'i', 'RA', 't', to_char((now() + interval '2 hours') at time zone 'UTC', f))) where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  set local role authenticated;
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Equipo F', 'i', 'EF', 't', t_a)) where patient_id = pid;
  select checklist #> '{__pl_note_meta,by,entrega}' into b from public.notes where patient_id = pid;
  if b ->> 'u' is distinct from 'Equipo F' then raise exception 'FALLA N1-9 un sello del futuro bloqueó el guardado: %', b; end if; n := n + 1;
  reset role;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
