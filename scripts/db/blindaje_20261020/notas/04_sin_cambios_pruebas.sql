-- ═══ Pruebas de N4 · reescrituras sin cambios (20 oct 2026) ═══════════════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Paciente ficticio ZZ-N4.
-- Se prueba como «authenticated» (UPDATE y el upsert de la app: INSERT … ON CONFLICT DO UPDATE … RETURNING, que es lo
-- que arma PostgREST con on_conflict=patient_id y return=representation). La bitácora se lee como postgres (la app no
-- la puede leer: audit_log solo es visible para administradores).
-- «hay UPDATE» se mide con ROW_COUNT (0 = suprimido; en PostgREST la respuesta sería []).
begin;
do $$
declare
  uid uuid; pid uuid; n int := 0; rc int; h jsonb; e text; ts_upd timestamptz; p text;
  bit_antes text; bit_despues text;
  lh0 jsonb := '[{"fecha":"2026-10-19","labs":{"hb":"10","leu":"8"},"synced_at":"2026-10-20T10:00:00Z","client_updated_at":1000},
                 {"fecha":"2026-10-20","labs":{"hb":"9"},"scraped_at":"2026-10-20T11:00:00Z"}]';
  -- La misma lista: otro orden de fechas, llaves en otro orden y otras marcas de hora del sync
  lh_igual jsonb := '[{"scraped_at":"2026-10-20T12:30:00Z","labs":{"hb":"9"},"fecha":"2026-10-20","synced_at":"2026-10-20T12:30:00Z"},
                      {"client_updated_at":2000,"labs":{"leu":"8","hb":"10"},"synced_at":"2026-10-20T12:30:00Z","fecha":"2026-10-19"}]';
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into public.patients (cama, nombre, exp) values ('ZZ-N4', 'PRUEBA FICTICIA SIN CAMBIOS', 'ZZ-N004') returning id into pid;
  insert into public.notes (patient_id, pendientes, lab_history, checklist, updated_at, updated_by)
  values (pid, 'ZZ pendiente inicial', lh0,
          jsonb_build_object('npo', false, 'recibo', 'ZZ recibe estable',
            '__pl_note_meta', jsonb_build_object('entrega', E'19/10 ZZ: renglón uno\n19/10 ZZ: renglón dos',
              'by', jsonb_build_object('entrega', jsonb_build_object('u', 'Prueba', 'i', 'PR', 't',
                to_char((now() - interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))))),
          '2026-01-01T00:00:00Z', 'ZZ Prueba')
    on conflict (patient_id) do nothing;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', json_build_object('x-pl-device', 'Windows Chrome', 'user-agent', 'UA-pc')::text, true);
  select count(*) || ':' || coalesce(string_agg(a.ts::text || a.diff::text, '|' order by a.id), '') into bit_antes
    from public.audit_log a where a.record_id = pid::text;

  -- N4-1 la misma lista de labs (otro orden, synced_at/scraped_at/client_updated_at distintos) → no hay UPDATE
  set local role authenticated;
  update public.notes set lab_history = lh_igual where patient_id = pid;
  get diagnostics rc = row_count;
  select updated_at, lab_history into ts_upd, h from public.notes where patient_id = pid;
  reset role;
  select count(*) || ':' || coalesce(string_agg(a.ts::text || a.diff::text, '|' order by a.id), '') into bit_despues
    from public.audit_log a where a.record_id = pid::text;
  if rc <> 0 or ts_upd <> '2026-01-01T00:00:00Z'::timestamptz or h is distinct from lh0 or bit_despues is distinct from bit_antes then
    raise exception 'FALLA N4-1 una reescritura idéntica de labs sí escribió: filas=% updated_at=% bitácora % → %', rc, ts_upd, bit_antes, bit_despues;
  end if; n := n + 1;

  -- N4-2 un valor nuevo sí se guarda
  set local role authenticated;
  update public.notes set lab_history = jsonb_set(lh_igual, '{0,labs,hb}', '"8.5"') where patient_id = pid;
  get diagnostics rc = row_count;
  select lab_history, updated_at into h, ts_upd from public.notes where patient_id = pid;
  if rc <> 1 or (select x #>> '{labs,hb}' from jsonb_array_elements(h) x where x ->> 'fecha' = '2026-10-20') is distinct from '8.5'
     or ts_upd = '2026-01-01T00:00:00Z'::timestamptz then
    raise exception 'FALLA N4-2 un valor nuevo de labs no se guardó: filas=% %', rc, h;
  end if; n := n + 1;

  -- N4-3 Guardia revertida por la protección (copia vieja sin un renglón, sin sello nuevo) → SÍ hay UPDATE
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb('19/10 ZZ: renglón uno'::text)) where patient_id = pid;
  get diagnostics rc = row_count;
  select checklist #>> '{__pl_note_meta,entrega}' into e from public.notes where patient_id = pid;
  if rc <> 1 or e is distinct from E'19/10 ZZ: renglón uno\n19/10 ZZ: renglón dos' then
    raise exception 'FALLA N4-3 la Guardia revertida por la protección no produjo UPDATE: filas=% «%»', rc, e;
  end if; n := n + 1;

  -- N4-4 la marca se limpia: la siguiente reescritura idéntica sí se suprime
  update public.notes set pendientes = 'ZZ pendiente inicial' where patient_id = pid;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'FALLA N4-4 la marca pl.modificado no se limpió: una reescritura idéntica escribió (filas=%)', rc; end if; n := n + 1;

  -- N4-5 el upsert de la app (POST on_conflict) idéntico salvo updated_by → no devuelve filas (PostgREST: [])
  select lab_history into h from public.notes where patient_id = pid;
  insert into public.notes (patient_id, pendientes, lab_history, updated_by) values (pid, 'ZZ pendiente inicial', h, 'Otro Nombre')
    on conflict (patient_id) do update set pendientes = excluded.pendientes, lab_history = excluded.lab_history, updated_by = excluded.updated_by
    returning patient_id into p;
  get diagnostics rc = row_count;
  if rc <> 0 then raise exception 'FALLA N4-5 un upsert idéntico (solo cambia updated_by) sí escribió: filas=%', rc; end if; n := n + 1;

  -- N4-6 cambia otra caja y los labs llegan iguales con synced_at nuevo → se guarda la caja; los labs quedan como estaban
  select lab_history into h from public.notes where patient_id = pid;
  update public.notes set pendientes = 'ZZ pendiente nuevo',
         lab_history = jsonb_set(h, array[(select (o - 1)::text from jsonb_array_elements(h) with ordinality s(x, o) where x ->> 'fecha' = '2026-10-19'), 'synced_at'], '"2026-10-20T13:00:00Z"')
   where patient_id = pid;
  get diagnostics rc = row_count;
  select pendientes, lab_history into p, h from public.notes where patient_id = pid;
  if rc <> 1 or p is distinct from 'ZZ pendiente nuevo'
     or (select x ->> 'synced_at' from jsonb_array_elements(h) x where x ->> 'fecha' = '2026-10-19') is distinct from '2026-10-20T12:30:00Z' then
    raise exception 'FALLA N4-6 con otra caja nueva, los labs iguales se reescribieron (o la caja no entró): filas=% % %', rc, p, h;
  end if; n := n + 1;

  -- N4-7 copia de labs sin una fecha y lo demás igual → N3 la repone y SÍ hay UPDATE (el equipo recibe la lista completa)
  update public.notes set lab_history = (select jsonb_agg(x) from jsonb_array_elements(h) x where x ->> 'fecha' = '2026-10-19') where patient_id = pid;
  get diagnostics rc = row_count;
  select lab_history into h from public.notes where patient_id = pid;
  if rc <> 1 or jsonb_array_length(h) <> 2 then raise exception 'FALLA N4-7 la fecha repuesta por N3 no produjo UPDATE: filas=% %', rc, h; end if; n := n + 1;

  -- N4-8 copia idéntica con un sello «by» viejo → N1 lo corrige y SÍ hay UPDATE
  update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,by,entrega,t}',
    to_jsonb(to_char((now() - interval '2 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) where patient_id = pid;
  get diagnostics rc = row_count;
  if rc <> 1 then raise exception 'FALLA N4-8 el sello corregido por N1 no produjo UPDATE: filas=%', rc; end if; n := n + 1;

  -- N4-9 checklist sin una llave → pl_checklist_sin_perdidas la repone y SÍ hay UPDATE
  update public.notes set checklist = checklist - 'recibo'::text where patient_id = pid;
  get diagnostics rc = row_count;
  select checklist ->> 'recibo' into e from public.notes where patient_id = pid;
  if rc <> 1 or e is distinct from 'ZZ recibe estable' then raise exception 'FALLA N4-9 la llave repuesta no produjo UPDATE: filas=% «%»', rc, e; end if; n := n + 1;
  reset role;

  -- N4-10 (20 oct 2026, M1 de la revisión de operación) «touch» de mantenimiento por SQL con pl.entrega_libre: sí hay
  --       UPDATE (respaldo_hora la vuelve a copiar y Realtime la reenvía); antes daba UPDATE 0 sin aviso
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set updated_at = now() - interval '3 hours' where patient_id = pid;
  get diagnostics rc = row_count;
  perform set_config('pl.entrega_libre', 'off', true);
  if rc <> 1 then raise exception 'FALLA N4-10 el touch de mantenimiento con pl.entrega_libre no escribió: filas=%', rc; end if; n := n + 1;

  -- N4-11 con el permiso, una marca pl.modificado pendiente igual se limpia: la siguiente reescritura idéntica de la app
  --       se sigue suprimiendo
  perform set_config('pl.modificado', 'on', true);
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set updated_at = now() where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  e := coalesce(current_setting('pl.modificado', true), '');
  set local role authenticated;
  update public.notes set pendientes = pendientes where patient_id = pid;
  get diagnostics rc = row_count;
  reset role;
  if e <> '' or rc <> 0 then raise exception 'FALLA N4-11 con pl.entrega_libre la marca quedó encendida («%») o la reescritura idéntica escribió (filas=%)', e, rc; end if; n := n + 1;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
