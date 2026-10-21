-- ═══ Pruebas de N3 · labs que no se pierden (20 oct 2026) ══════════════════════════════════════════════════════
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Paciente ficticio ZZ-N3.
-- Se prueba como «authenticated» (como guarda la app: upsert POST on_conflict=patient_id y UPDATE) y el permiso de
-- mantenimiento como postgres.
begin;
do $$
declare
  uid uuid; pid uuid; n int := 0; h jsonb; antes text; despues text;
  d18 jsonb := '{"fecha":"2026-10-18","labs":{"hb":"10"}}';
  d19 jsonb := '{"fecha":"2026-10-19","labs":{"hb":"9.5"}}';
  d20 jsonb := '{"fecha":"2026-10-20","labs":{"hb":"9"}}';
  d21 jsonb := '{"fecha":"2026-10-21","labs":{"hb":"8.7"}}';
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  insert into public.patients (cama, nombre, exp) values ('ZZ-N3', 'PRUEBA FICTICIA LABS', 'ZZ-N003') returning id into pid;
  insert into public.notes (patient_id, checklist, lab_history) values (pid, '{"npo": false}'::jsonb, jsonb_build_array(d18, d19))
    on conflict (patient_id) do update set checklist = excluded.checklist, lab_history = excluded.lab_history;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-PC', 'user-agent', 'UA-pc')::text, true);
  set local role authenticated;

  -- N3-1 dos fechas → la copia vieja sube una (upsert de la app) → quedan las dos
  insert into public.notes (patient_id, lab_history, updated_by) values (pid, jsonb_build_array(d19), 'ZZ Prueba')
    on conflict (patient_id) do update set lab_history = excluded.lab_history, updated_by = excluded.updated_by;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 2 or not (h @> jsonb_build_array(d18)) then raise exception 'FALLA N3-1 una copia vieja quitó una fecha: %', h; end if; n := n + 1;

  -- N3-2 «Eliminar labs»: la fecha va en checklist.__lab_deleted del mismo guardado → queda una
  update public.notes set lab_history = jsonb_build_array(d19), checklist = checklist || '{"__lab_deleted":["2026-10-18"]}'::jsonb
   where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 1 or h @> jsonb_build_array(d18) then raise exception 'FALLA N3-2 «Eliminar labs» no quitó la fecha: %', h; end if; n := n + 1;

  -- N3-3 la misma fecha con el valor corregido → queda el valor NUEVO (una sola entrada de esa fecha)
  update public.notes set lab_history = jsonb_build_array('{"fecha":"2026-10-19","labs":{"hb":"8.8"}}'::jsonb, d20) where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if (select count(*) from jsonb_array_elements(h) e where e ->> 'fecha' = '2026-10-19') <> 1
     or (select e #>> '{labs,hb}' from jsonb_array_elements(h) e where e ->> 'fecha' = '2026-10-19' limit 1) is distinct from '8.8' then
    raise exception 'FALLA N3-3 el valor corregido no quedó: %', h; end if; n := n + 1;

  -- N3-4 con el permiso de mantenimiento (pl.entrega_libre) sí se puede quitar una fecha
  reset role;
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set lab_history = jsonb_build_array(d20) where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 1 then raise exception 'FALLA N3-4 el mantenimiento no pudo quitar una fecha: %', h; end if; n := n + 1;

  -- N3-5 un UPDATE que no manda lab_history no lo cambia (ni el orden): la lista la deja el mantenimiento en un orden
  --      cualquiera y luego la app guarda otra caja
  perform set_config('pl.entrega_libre', 'on', true);
  update public.notes set lab_history = jsonb_build_array(d20, d21) where patient_id = pid;
  perform set_config('pl.entrega_libre', 'off', true);
  set local role authenticated;
  select lab_history::text into antes from public.notes where patient_id = pid;
  update public.notes set pendientes = 'ZZ pendiente de prueba' where patient_id = pid;
  select lab_history::text into despues from public.notes where patient_id = pid;
  if despues is distinct from antes then raise exception 'FALLA N3-5 un UPDATE sin lab_history lo cambió: % → %', antes, despues; end if; n := n + 1;

  -- N3-6 un null dentro de __lab_deleted no hace que se pierdan las fechas que faltan
  update public.notes set lab_history = jsonb_build_array(d21), checklist = checklist || '{"__lab_deleted":[null,"2026-10-05"]}'::jsonb
   where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 2 or not (h @> jsonb_build_array(d20)) then raise exception 'FALLA N3-6 un null en __lab_deleted quitó fechas: %', h; end if; n := n + 1;

  -- N3-7 lab_history en null o que no es arreglo → queda el guardado
  update public.notes set lab_history = null where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_typeof(h) is distinct from 'array' or jsonb_array_length(h) <> 2 then raise exception 'FALLA N3-7 lab_history null borró los labs: %', h; end if;
  update public.notes set lab_history = '{}'::jsonb where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_typeof(h) is distinct from 'array' or jsonb_array_length(h) <> 2 then raise exception 'FALLA N3-7 lab_history no-arreglo borró los labs: %', h; end if; n := n + 1;
  -- N3-8 (20 oct 2026, R3 de la revisión de datos) lápida VIEJA heredada: «Eliminar labs» del 20/10 (eran de otro
  --      paciente) → llegan los resultados buenos del 20/10 (solo labHistory; la lápida se queda en el checklist) → un
  --      equipo con copia vieja sube labs sin el 20/10. La fecha buena se queda (antes la borraba la lápida vieja).
  update public.notes set lab_history = jsonb_build_array(d21),
         checklist = checklist || '{"__lab_deleted":["2026-10-20"],"__lab_deleted_labs":{"2026-10-20":{"hb":"9"}}}'::jsonb
   where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 1 then raise exception 'FALLA N3-8 (preparación) «Eliminar labs» del 20/10 no la quitó: %', h; end if;
  update public.notes set lab_history = jsonb_build_array(d21, '{"fecha":"2026-10-20","labs":{"hb":"12.4","plt":"210"}}'::jsonb) where patient_id = pid;
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-iPad', 'user-agent', 'UA-ipad')::text, true);
  update public.notes set lab_history = jsonb_build_array(d21) where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if (select e #>> '{labs,hb}' from jsonb_array_elements(h) e where e ->> 'fecha' = '2026-10-20') is distinct from '12.4' then
    raise exception 'FALLA N3-8 una lápida vieja dejó que una copia vieja borrara los resultados nuevos del 20/10: %', h; end if; n := n + 1;

  -- N3-9 el equipo al día vuelve a «Eliminar labs» del 20/10 a propósito: la lápida ya estaba, pero __lab_deleted_labs
  --      trae lo que la persona veía (los resultados de hoy) → sí se quita
  perform set_config('request.headers', json_build_object('x-pl-device', 'ZZ-PC', 'user-agent', 'UA-pc')::text, true);
  update public.notes set lab_history = jsonb_build_array(d21),
         checklist = checklist || '{"__lab_deleted":["2026-10-20"],"__lab_deleted_labs":{"2026-10-20":{"hb":"12.4","plt":"210"}}}'::jsonb
   where patient_id = pid;
  select lab_history into h from public.notes where patient_id = pid;
  if jsonb_array_length(h) <> 1 or exists (select 1 from jsonb_array_elements(h) e where e ->> 'fecha' = '2026-10-20') then
    raise exception 'FALLA N3-9 el borrado deliberado de una fecha con lápida previa no se hizo: %', h; end if; n := n + 1;
  reset role;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
