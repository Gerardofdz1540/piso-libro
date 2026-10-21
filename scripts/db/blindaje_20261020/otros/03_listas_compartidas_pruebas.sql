-- ═══ Pruebas de O3 · No olvidar, Procedimientos y guard_info: copia al borrar y respaldo horario (20 oct 2026) ═══
-- Corre TODO dentro de una transacción que se deshace al final (no deja rastro). Datos ficticios ZZ-…
-- Uso: psql … -f otros/03_listas_compartidas_pruebas.sql   → «RESULTADO OK: n pruebas» (o la primera FALLA)
begin;
do $$
declare
  uid uuid; c int; c2 int; n int := 0; x jsonb; r int; id1 bigint; id2 bigint; pr uuid; pid uuid;
  H_IPAD constant text := json_build_object('x-pl-device', 'ZZ-iPad', 'x-pl-user', 'ZZ R2', 'user-agent', 'ZZ-UA-iPad')::text;
begin
  select id into uid from public.app_users where status = 'active' and role = 'usuario' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', 'zz@prueba.invalid')::text, true);
  perform set_config('request.headers', H_IPAD, true);

  -- ── Copia al borrar ─────────────────────────────────────────────────────────────────────────────────────────
  set local role authenticated;
  insert into public.no_olvidar (texto, author) values ('ZZ recordar TAC de control', 'ZZ R2') returning id into id1;
  insert into public.no_olvidar (texto, author, done) values ('ZZ pedir interconsulta', 'ZZ R2', true) returning id into id2;
  insert into public.procedimientos_dia (cama, exp, nombre, dx, added_by) values ('ZZ-Q1', 'ZZ-Q001', 'ZZ PROCEDIMIENTO FICTICIO', 'ZZ DX', 'ZZ R2') returning id into pr;
  delete from public.no_olvidar where id = id2;          -- 🗑 de un No olvidar desde el iPad
  delete from public.procedimientos_dia where id = pr;   -- 🗑 de un procedimiento
  reset role;
  -- O3-1 No olvidar: la fila completa, quién, desde qué equipo y cuándo
  select to_jsonb(b) into x from public.borrados_otros b where b.tabla = 'no_olvidar' and b.llave = id2::text;
  if x is null or x->'fila'->>'texto' is distinct from 'ZZ pedir interconsulta' or x->'fila'->>'done' is distinct from 'true'
     or not (x->'fila' ?& array['id', 'texto', 'author', 'fecha', 'done', 'created_at'])
     or x->>'quien_user_id' is distinct from uid::text or x->>'dispositivo' is distinct from 'ZZ-iPad' or x->>'borrado_en' is null then
    raise exception 'FALLA O3-1 borrado de No olvidar sin copia completa: %', left(coalesce(x::text, 'sin fila'), 300); end if; n := n + 1;
  -- O3-2 Procedimientos del día: la fila completa (las 12 columnas)
  select to_jsonb(b) into x from public.borrados_otros b where b.tabla = 'procedimientos_dia' and b.llave = pr::text;
  if x is null or x->'fila'->>'nombre' is distinct from 'ZZ PROCEDIMIENTO FICTICIO'
     or (select count(*) from jsonb_object_keys(x->'fila')) <> 12 or x->>'rol' is distinct from 'authenticated' then
    raise exception 'FALLA O3-2 borrado de procedimiento sin copia completa: %', left(coalesce(x::text, 'sin fila'), 300); end if; n := n + 1;
  -- O3-3 se repone tal cual (No olvidar tiene id «generated always»)
  insert into public.no_olvidar overriding system value
  select (jsonb_populate_record(null::public.no_olvidar, b.fila)).* from public.borrados_otros b where b.tabla = 'no_olvidar' and b.llave = id2::text;
  insert into public.procedimientos_dia
  select (jsonb_populate_record(null::public.procedimientos_dia, b.fila)).* from public.borrados_otros b where b.tabla = 'procedimientos_dia' and b.llave = pr::text;
  select count(*) into c from public.no_olvidar where id = id2 and texto = 'ZZ pedir interconsulta' and done;
  select count(*) into c2 from public.procedimientos_dia where id = pr and nombre = 'ZZ PROCEDIMIENTO FICTICIO';
  if c <> 1 or c2 <> 1 then raise exception 'FALLA O3-3 no se pudo reponer desde borrados_otros (%/%)', c, c2; end if; n := n + 1;
  -- O3-4 «Borrar hechos» (varios a la vez) deja una copia por fila
  insert into public.no_olvidar (texto, author, done) select 'ZZ hecho ' || g, 'ZZ R2', true from generate_series(1, 3) g;
  select count(*) into c from public.no_olvidar where done;
  set local role authenticated;
  delete from public.no_olvidar where done = true;
  reset role;
  select count(*) into c2 from public.borrados_otros b where b.tabla = 'no_olvidar' and (b.fila->>'done')::boolean and b.borrado_en = now();
  if c2 <> c + 1 then raise exception 'FALLA O3-4 «Borrar hechos»: % copias para % filas borradas', c2 - 1, c; end if; n := n + 1;

  -- ── Respaldo horario ────────────────────────────────────────────────────────────────────────────────────────
  insert into public.guard_info (id, fecha, entrega, recibe) values ('current', '2026-10-20', 'ZZ ENTREGA', 'ZZ RECIBE')
    on conflict (id) do update set fecha = excluded.fecha, entrega = excluded.entrega, recibe = excluded.recibe;
  insert into public.patients (cama, nombre, exp) values ('ZZ-Q2', 'ZZ PRUEBA RESPALDO LISTAS', 'ZZ-Q002') returning id into pid;
  delete from public.respaldo_hora_otros;
  r := public.pl_respaldo_hora();
  -- O3-5 primera corrida: una copia de cada fila de las tres tablas
  select count(*) into c from public.respaldo_hora_otros where not borrada;
  select (select count(*) from public.no_olvidar) + (select count(*) from public.procedimientos_dia) + (select count(*) from public.guard_info) into c2;
  if c <> c2 or c2 < 3 or not exists (select 1 from public.respaldo_hora_otros where tabla = 'guard_info' and fila->>'entrega' = 'ZZ ENTREGA') then
    raise exception 'FALLA O3-5 primera corrida: % copias para % filas', c, c2; end if; n := n + 1;
  -- O3-6 notas y pacientes siguen respaldándose igual
  if not exists (select 1 from public.respaldo_hora where patient_id = pid) then raise exception 'FALLA O3-6 el respaldo de pacientes dejó de funcionar'; end if; n := n + 1;
  -- O3-7 sin cambios: ninguna copia nueva
  select count(*) into c from public.respaldo_hora_otros;
  r := public.pl_respaldo_hora();
  select count(*) into c2 from public.respaldo_hora_otros;
  if c2 <> c then raise exception 'FALLA O3-7 sin cambios copió % filas', c2 - c; end if; n := n + 1;
  -- O3-8 solo lo que cambió: marcar un No olvidar como hecho y cambiar quién recibe la guardia → 2 copias nuevas
  update public.no_olvidar set done = true where id = id1;
  update public.guard_info set recibe = 'ZZ RECIBE OTRO' where id = 'current';
  r := public.pl_respaldo_hora();
  select count(*) into c2 from public.respaldo_hora_otros;
  if c2 - c <> 2 or not exists (select 1 from public.respaldo_hora_otros where tabla = 'no_olvidar' and llave = id1::text and (fila->>'done')::boolean)
     or not exists (select 1 from public.respaldo_hora_otros where tabla = 'guard_info' and fila->>'recibe' = 'ZZ RECIBE OTRO') then
    raise exception 'FALLA O3-8 cambios: % copias nuevas (se esperaban 2)', c2 - c; end if; n := n + 1;
  -- O3-9 lo que se borró queda marcado (y la última copia completa sigue)
  delete from public.no_olvidar where id = id1;
  r := public.pl_respaldo_hora();
  select count(*) into c from public.respaldo_hora_otros where tabla = 'no_olvidar' and llave = id1::text and borrada;
  select count(*) into c2 from public.respaldo_hora_otros where tabla = 'no_olvidar' and llave = id1::text and fila->>'texto' = 'ZZ recordar TAC de control';
  if c <> 1 or c2 < 1 then raise exception 'FALLA O3-9 fila borrada: % marcas, % copias completas', c, c2; end if; n := n + 1;
  r := public.pl_respaldo_hora();
  select count(*) into c from public.respaldo_hora_otros where tabla = 'no_olvidar' and llave = id1::text and borrada;
  if c <> 1 then raise exception 'FALLA O3-9b la marca de borrada se repitió (%)', c; end if; n := n + 1;
  -- O3-10 7 días: lo viejo se purga y lo que no cambió vuelve a tener copia en la misma corrida
  update public.respaldo_hora_otros set respaldado_en = now() - interval '8 days' where tabla = 'guard_info';
  r := public.pl_respaldo_hora();
  select count(*) into c from public.respaldo_hora_otros where tabla = 'guard_info';
  select count(*) into c2 from public.respaldo_hora_otros where respaldado_en < now() - interval '7 days';
  if c <> 1 or c2 <> 0 then raise exception 'FALLA O3-10 purga de 7 días: % copias de guard_info, % viejas', c, c2; end if; n := n + 1;
  -- O3-11 si el respaldo de listas falla, el de notas y pacientes de esa hora sí queda
  alter table public.respaldo_hora_otros add constraint zz_falla_a_proposito check (false) not valid;
  update public.guard_info set fecha = '2026-10-21' where id = 'current';
  update public.patients set dx = 'ZZ DX NUEVO' where id = pid;
  update public.respaldo_hora set respaldado_en = now() - interval '1 minute';
  r := public.pl_respaldo_hora();
  alter table public.respaldo_hora_otros drop constraint zz_falla_a_proposito;
  select count(*) into c from public.respaldo_hora where patient_id = pid and paciente->>'dx' = 'ZZ DX NUEVO';
  if c <> 1 then raise exception 'FALLA O3-11 un error en las listas tumbó el respaldo de pacientes'; end if; n := n + 1;
  -- O3-12 la app no lee ni escribe estas tablas (las ve solo el administrador: borrados_otros)
  set local role authenticated;
  select count(*) into c from public.borrados_otros;
  reset role;
  if c <> 0 or has_table_privilege('authenticated', 'public.respaldo_hora_otros', 'select') or has_table_privilege('anon', 'public.borrados_otros', 'select')
     or has_table_privilege('authenticated', 'public.borrados_otros', 'insert') or has_table_privilege('authenticated', 'public.borrados_otros', 'delete')
     or has_function_privilege('authenticated', 'public.pl_respaldo_hora_otros()', 'execute') then
    raise exception 'FALLA O3-12 permisos demasiado abiertos (la cuenta normal ve % filas de borrados_otros)', c; end if; n := n + 1;

  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
