-- ═══ Pruebas de 🌙 Guardia y 🕓 Cronología en la base (20 oct 2026) ═══════════════════════════════════════════
-- COPIA ADAPTADA para el paquete «notas» (20 oct 2026; el original valsql/pruebas.sql NO se tocó y también sigue en
-- verde con N1…N6). Único cambio: en G11b, el paso que PREPARA un sello guardado de hace 3 h (como postgres) ahora usa
-- el permiso de mantenimiento pl.entrega_libre. Por qué: con N1 (pl_by_monotono) un sello ya no puede regresar en la
-- nube salvo con ese permiso; sin él, el paso de preparación quedaba sin efecto (se conservaba el sello más nuevo) y
-- G11b pasaba por la razón equivocada (sello más viejo que el guardado) en vez de probar lo que dice: un sello MÁS
-- NUEVO que el guardado pero de hace 1 h (cola que se envía tarde) no es deliberado y no borra.
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Pacientes ficticios ZZ-…
-- Uso (Postgres de prueba con scripts/supabase_guardia_cronologia.sql ya aplicado, o el SQL editor de Supabase):
--   \i scripts/supabase_guardia_cronologia_pruebas.sql      → termina con «RESULTADO OK: n pruebas» (o la primera FALLA)
-- Se prueba como rol «authenticated» (como guarda la app), con un usuario activo de app_users.
begin;
do $$
declare
  uid uuid; pid uuid; pid2 uuid; pid3 uuid; e text; c text; x text; n int := 0; paso int := 0;
  A  text := '19/10 PR: Se realizó curación de seroma, se suspendió tramadol, continua on ayuno';
  A1 text := '19/10 PR: Se realizó curación de seroma, se suspendió tramadol, continua on ayuno 3/3';
  A2 text := '19/10 PR: Se realizó curación de seroma, se suspendió tramadol, continua en ayuno';
  B  text := '19/10 PR: Pendiente TAC de abdomen';
  C2 text := '20/10 XY: Se retiró sonda nasogástrica sin incidentes';
  S  text := '19/10 PR: Se realizó curación y drenaje del seroma.';
  L  text := '19/10 PR: Se realizó curación y drenaje del seroma, canaliza, pendiente que evacúe';
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;

  -- ── Cronología ─────────────────────────────────────────────────────────────────────────────────────────
  insert into public.patients (cama, nombre, exp) values ('ZZ-1', 'PRUEBA FICTICIA CRONOLOGIA', 'ZZ-0001') returning id into pid;
  insert into public.notes (patient_id, checklist, cronologia) values (pid, '{}'::jsonb, 'inyectado por cliente')
    on conflict (patient_id) do nothing;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select cronologia into c from public.notes where patient_id = pid;
  if coalesce(c, '') <> '' then raise exception 'FALLA crono-1: un cliente puso Cronología al crear la nota'; end if; n := n + 1;
  update public.notes set cronologia = 'intento del cliente' where patient_id = pid;
  select cronologia into c from public.notes where patient_id = pid;
  if coalesce(c, '') <> '' then raise exception 'FALLA crono-2: un cliente cambió la Cronología'; end if; n := n + 1;
  reset role;
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set cronologia = E'— Guardia del 19/10 al 20/10 —\nrenglon ficticio' where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  select cronologia into c from public.cronologia_respaldo where patient_id = pid;
  if coalesce(c, '') not like '%renglon ficticio%' then raise exception 'FALLA crono-3: sin respaldo'; end if; n := n + 1;
  delete from public.notes where patient_id = pid;
  insert into public.notes (patient_id, checklist) values (pid, '{}'::jsonb);
  select cronologia into c from public.notes where patient_id = pid;
  if coalesce(c, '') not like '%renglon ficticio%' then raise exception 'FALLA crono-4: no se repuso por paciente'; end if; n := n + 1;
  delete from public.patients where id = pid;
  select a.note_data->>'cronologia' into x from public.archive a where a.patient_data->>'exp' = 'ZZ-0001' order by archived_at desc limit 1;
  if coalesce(x, '') not like '%renglon ficticio%' then raise exception 'FALLA crono-5: la Papelera no guardó la Cronología'; end if; n := n + 1;
  delete from public.cronologia_respaldo where exp = 'ZZ-0001';
  insert into public.patients (cama, nombre, exp) values ('ZZ-2', 'PRUEBA FICTICIA CRONOLOGIA', 'ZZ-0001') returning id into pid2;
  perform public.restore_note_from_archive(pid2);  -- en producción lo hace patients_restore_note_after_insert
  select cronologia into c from public.notes where patient_id = pid2;
  if coalesce(c, '') not like '%renglon ficticio%' then raise exception 'FALLA crono-6: no volvió desde la Papelera'; end if; n := n + 1;
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then raise exception 'FALLA crono-7: el permiso quedó encendido'; end if; n := n + 1;
  insert into public.patients (cama, nombre, exp) values ('ZZ-3', 'OTRA PERSONA DISTINTA', 'ZZ-0001') returning id into pid3;
  insert into public.notes (patient_id, checklist) values (pid3, '{}'::jsonb) on conflict (patient_id) do nothing;
  select cronologia into c from public.notes where patient_id = pid3;
  if coalesce(c, '') <> '' then raise exception 'FALLA crono-8: otra persona con el mismo expediente heredó la Cronología'; end if; n := n + 1;

  -- ── Guardia ────────────────────────────────────────────────────────────────────────────────────────────
  insert into public.patients (cama, nombre, exp) values ('ZZ-4', 'PRUEBA FICTICIA GUARDIA', 'ZZ-0002') returning id into pid;
  insert into public.notes (patient_id, checklist) values (pid, jsonb_build_object('__pl_note_meta', jsonb_build_object('entrega', A,
    'by', jsonb_build_object('entrega', jsonb_build_object('u', 'Prueba', 'i', 'PR', 't', '2026-01-01T00:00:00Z')))))
    on conflict (patient_id) do update set checklist = excluded.checklist;
  -- Este equipo (como lo manda la app en las cabeceras; la bitácora lo guarda en dispositivo/ua)
  perform set_config('request.headers', json_build_object('x-pl-device', 'MiEquipo', 'user-agent', 'UA-mio')::text, true);
  set local role authenticated;
  -- G1 corrección deliberada (sello nuevo): se respeta
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2)), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 then raise exception 'FALLA G1 corrección: %', e; end if; n := n + 1;
  -- G2 la misma corrección sin sello nuevo (copia de otro equipo): no se quita nada
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A1)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 || E'\n' || A1 then raise exception 'FALLA G2 no deliberada: %', e; end if; n := n + 1;
  -- G3 borrar el repetido (deliberado)
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2 || E'\n' || B)), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 || E'\n' || B then raise exception 'FALLA G3 repetido: %', e; end if; n := n + 1;
  -- G4 copia vieja que trae los borrados de regreso: no regresan
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A || E'\n' || A1 || E'\n' || A2 || E'\n' || B)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 || E'\n' || B then raise exception 'FALLA G4 resucitó: %', e; end if; n := n + 1;
  -- G5 copia vieja con solo lo de ayer: no borra lo de hoy
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 || E'\n' || B then raise exception 'FALLA G5 borró: %', e; end if; n := n + 1;
  -- G6 lo que OTRO equipo acaba de escribir (bitácora, < 15 min) se queda aunque mi equipo (deliberado) no lo tenga
  reset role;
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2 || E'\n' || B || E'\n' || C2)) where patient_id = pid;
  insert into public.audit_log (dispositivo, ua, tabla, op, record_id, campos, diff) values ('OtroEquipo', 'UA-otro', 'notes', 'UPDATE', pid::text,
    '{checklist,entrega}', jsonb_build_object('entrega', jsonb_build_object('de', A2 || E'\n' || B, 'a', A2 || E'\n' || B || E'\n' || C2)));
  set local role authenticated;
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2 || E'\n' || B || E'\n20/10 PR: Renglón nuevo')), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> A2 || E'\n' || B || E'\n' || C2 || E'\n20/10 PR: Renglón nuevo' then raise exception 'FALLA G6 ajeno reciente: %', e; end if; n := n + 1;
  -- G6b último cambio gana: borrar un renglón completo (distinto, sin gemelo) desde la caja se respeta (caso 3-175)
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(replace(e, B || E'\n', ''))), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(B in e) > 0 or position(C2 in e) = 0 then raise exception 'FALLA G6b borrar renglón completo: %', e; end if; n := n + 1;
  -- G6c una copia vieja (no deliberada) no regresa el renglón borrado
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(e || E'\n' || B)) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(B in e) > 0 then raise exception 'FALLA G6c regresó lo borrado: %', e; end if; n := n + 1;
  -- G7 renglón que creció (deliberado): queda el largo
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(e || E'\n' || S)), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(replace(e, S, L))), '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(L in e) = 0 or position(S in e) > 0 then raise exception 'FALLA G7 creció: %', e; end if; n := n + 1;
  -- G8 una copia vieja (no deliberada) con el borrador corto no pisa al renglón largo
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(replace(e, L, S))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(L in e) = 0 then raise exception 'FALLA G8 se perdió el largo: %', e; end if; n := n + 1;
  -- G9 ➕ Agregar de la app nueva (m = 'agregar') con copia sin un renglón: no borra
  paso := paso + 1;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2 || E'\n20/10 10:00 PR: agregado nuevo')), '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Prueba', 'i', 'PR', 'm', 'agregar', 't', to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(C2 in e) = 0 or position(L in e) = 0 or position('agregado nuevo' in e) = 0 then raise exception 'FALLA G9 agregar: %', e; end if; n := n + 1;
  -- G10 renglón automático (labs) y bloque de Resumen: fuera
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(e || E'\n20-10-2026: Labs: Hb 7.1\n\n— Resumen 20/10\nalgo automático')) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position('Labs: Hb' in e) > 0 or position('Resumen 20/10' in e) > 0 then raise exception 'FALLA G10 automático: %', e; end if; n := n + 1;
  -- G11 sello de hace 2 h (cola sin red): no deliberada
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2::text)), '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Prueba', 'i', 'PR', 't', to_char((now() - interval '2 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(C2 in e) = 0 then raise exception 'FALLA G11 sello viejo borró: %', e; end if; n := n + 1;
  -- G11b sello más nuevo que el guardado pero de hace 1 h (cola que se envía tarde): no deliberada, no borra
  reset role;
  perform set_config('pl.entrega_libre', 'on', true);   -- N1: preparar un sello más viejo es mantenimiento
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega}', jsonb_build_object('u', 'Prueba', 'i', 'PR',
    't', to_char((now() - interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  select checklist #>> '{__pl_note_meta,by,entrega,t}' into x from public.notes where patient_id = pid;
  if x::timestamptz > now() - interval '2 hours' then raise exception 'FALLA G11b-prep el sello de hace 3 h no quedó guardado: %', x; end if;
  set local role authenticated;
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(A2::text)), '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Prueba', 'i', 'PR', 't', to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(L in e) = 0 then raise exception 'FALLA G11b sello de hace 1 h borró: %', e; end if; n := n + 1;
  -- G12 cliente no quita llaves del checklist
  update public.notes set checklist = jsonb_build_object('x', 1) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if position(A2 in coalesce(e, '')) = 0 then raise exception 'FALLA G12 se perdió la Guardia al mandar un checklist sin ella'; end if; n := n + 1;
  reset role;

  -- ── 06:15 ──────────────────────────────────────────────────────────────────────────────────────────────
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(C2 || E'\nAfebril')) where patient_id = pid;  -- como dueño: el trigger conserva y agrega
  select checklist #>> '{__pl_note_meta,entrega}' into x from public.notes where patient_id = pid;
  perform public.pl_guardia_a_cronologia();
  select checklist #>> '{__pl_note_meta,entrega}', cronologia into e, c from public.notes where patient_id = pid;
  if e <> '' then raise exception 'FALLA H1 la Guardia no quedó vacía: %', e; end if; n := n + 1;
  if position(C2 in c) = 0 or position('— Guardia del ' in c) = 0 then raise exception 'FALLA H2 la Cronología no recibió la Guardia'; end if; n := n + 1;
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then raise exception 'FALLA H3 el permiso quedó encendido'; end if; n := n + 1;
  set local role authenticated;
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(x)) where patient_id = pid;  -- copia vieja de antes de las 06:15
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> '' then raise exception 'FALLA H4 una copia vieja regresó lo ya pasado a la Cronología: %', e; end if; n := n + 1;
  paso := paso + 1;
  -- La app vieja reemplaza el objeto by.entrega completo al tocar la caja (sin la marca m de ➕ Agregar).
  update public.notes set checklist = jsonb_set(jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(E'Afebril\nTolera VO'::text)), '{__pl_note_meta,by,entrega}',
    jsonb_build_object('u', 'Prueba', 'i', 'PR', 't', to_char((now() + make_interval(secs => paso)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if e <> E'Afebril\nTolera VO' then raise exception 'FALLA H5 «Afebril» escrito hoy no entró: %', e; end if; n := n + 1;
  reset role;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
