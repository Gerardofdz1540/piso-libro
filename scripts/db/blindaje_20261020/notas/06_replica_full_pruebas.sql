-- ═══ Pruebas de N6 · REPLICA IDENTITY FULL en notes (20 oct 2026) ═══════════════════════════════════════════════
-- Solo catálogo: aquí no hay Realtime ni wal_level=logical, así que NO se prueba el evento (eso queda para
-- producción, con un cambio de una caja grande y el evento visto en otro equipo). Se revisa que quedó FULL, que la
-- condición de orden (N4 activo antes) se cumple y que notes sigue en la publicación de Realtime.
-- Transacción que se deshace; como «authenticated» (los catálogos los puede leer cualquier rol).
begin;
do $$
declare uid uuid; n int := 0; ri "char";
begin
  select id into uid from public.app_users where status = 'active' limit 1;
  if uid is null then raise exception 'FALLA: no hay usuario activo en app_users para probar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- N6-1 notes quedó con REPLICA IDENTITY FULL
  select relreplident into ri from pg_class where oid = 'public.notes'::regclass;
  if ri is distinct from 'f' then raise exception 'FALLA N6-1 notes no está en REPLICA IDENTITY FULL (relreplident=%)', ri; end if; n := n + 1;
  -- N6-2 lo que justifica el orden: pl_zz_sin_cambios (N4) está activo en notes y notes sigue publicada para Realtime
  if not exists (select 1 from pg_trigger where tgrelid = 'public.notes'::regclass and tgname = 'pl_zz_sin_cambios' and tgenabled <> 'D')
     or not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notes') then
    raise exception 'FALLA N6-2 FULL sin pl_zz_sin_cambios activo (o notes fuera de supabase_realtime)'; end if; n := n + 1;
  reset role;
  raise notice 'RESULTADO OK: % pruebas', n;
end $$;
rollback;
