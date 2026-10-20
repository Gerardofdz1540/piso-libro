-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Bitácora acotada: audit_log que no crece sin freno, sin perder el valor de rescate del
-- 🕘 Historial por caja (pl_historial_caja_v3 lee audit_log).   Lote M · octubre 2026.
--
-- POR QUÉ
--   El proyecto está en el plan Free de Supabase (base de 500 MB). El 19-oct la base medía 162 MB:
--   85 MB eran respuestas de pg_net que ya se limpiaron (scripts/supabase_indicaciones_doc.sql) y
--   14 MB era public.audit_log con 21 000 filas en solo 5 días: entre el 60 % y el 87 % son
--   reescrituras de notes.lab_history que hace el bucle de sincronización de labs de la app (el
--   diff solo guarda conteos: {de: N, a: N, tipo: 'elementos'}, no tienen valor de rescate) y el
--   resto son versiones de texto de las cajas (desde la migración del 19-oct cada fila guarda el
--   texto completo, hasta 6000 letras por campo, en diff.<campo>.{de, a}). Una racha de tecleo en
--   una caja (la app guarda a cada pausa) dejaba una fila completa por cada guardado.
--   La purga anterior era una sola: todo a los 180 días.
--
-- QUÉ HACE (todo idempotente: CREATE OR REPLACE / IF NOT EXISTS; se puede volver a correr)
--   1. pl_audit_purga(): purga por tipo de fila, llamada por el cron 'audit-log-purge' (jobid 8) en
--      lugar del borrado único de 180 días:
--        · 30 días  → filas de notes cuyos campos son SOLO listas sincronizadas (lab_history e
--                     imagen_history): el diff solo trae conteos de elementos.
--        · 365 días → filas UPDATE con texto de cajas de notes (app, pa, manejo, pendientes,
--                     drenajes, qx, sangrado, sv, balance, entrega, checklist) y el DX de patients
--                     (la caja DX vive en patients y el historial también lo lee de ahí).
--        · 180 días → todo lo demás (altas/bajas de registros, config, guard_info, cuentas…).
--      Devuelve jsonb con lo borrado por tipo. VACUUM no puede correr dentro de una función, así que
--      la compactación va en un cron aparte 'audit-log-vacuum' (domingos 04:55 UTC, vacuum analyze).
--   2. pl_audit(): fusiona las rachas de tecleo. Si un UPDATE de notes cambia SOLO campos de texto y
--      la fila anterior de la bitácora del mismo paciente, del mismo usuario (user_id, o nombre si no
--      hay cuenta) y con el mismo conjunto de campos tiene menos de 5 minutos, y en cada campo el
--      texto nuevo NO es más corto en 40 o más letras que el 'a' de esa fila (es tecleo, no un
--      borrado), entonces se ACTUALIZA esa fila: diff.<campo>.a = texto nuevo, se conserva su 'de',
--      ts = now(). Además se exige continuidad (el 'a' anterior debe ser el 'de' del cambio nuevo) y
--      la racha se cierra a los 30 min de su primera fila (diff._desde; diff._fusiones cuenta los
--      guardados fusionados). Cualquier borrado (encoge 40+ letras), cambio de otro usuario, otro
--      conjunto de campos, sub-llaves del checklist distintas o valores que no sean texto → fila
--      nueva, como hoy: el texto previo a un borrado nunca se pierde.
--      Se conservan tal cual: tope v_max (6000 letras en notes), el pseudo-campo 'entrega' y las
--      sub-llaves del checklist (scripts/supabase_audit_historial.sql).
--      CORRECCIÓN de paso (reproducida en PostgreSQL 16 local con la definición actual): la línea
--      «v_campos := v_campos || 'entrega'» se resuelve como concatenación de arreglos y Postgres
--      intenta leer 'entrega' como arreglo → «malformed array literal» → el UPDATE de notes que
--      cambia la Entrega de guardia fallaba (el disparador aborta la escritura). Ahora 'entrega'::text.
--   3. Búsqueda de cama/paciente amigable con el índice: 'p.id = v_rec::uuid' con conversión segura
--      (si record_id no es uuid → sin cama, sin error) en lugar de 'p.id::text = v_rec', que no podía
--      usar la llave primaria. Índices audit_log_record_ts_idx (record_id, ts desc), que también
--      acelera pl_historial_caja_v3 y la búsqueda de la fila previa, y audit_log_ts_idx (ts) para la
--      purga y la pestaña Actividad.
--   4. Monitor de tamaño: pl_tamano_base() → jsonb {db_mb, tablas: [{tabla, mb}… las 8 más
--      grandes], audit_filas, limite_mb: 500, nivel: 'ok' | 'aviso' (≥ 350 MB) | 'alto' (≥ 450 MB),
--      ts}. Lo puede llamar cualquier cuenta activa (pl_is_active()); si no, devuelve null.
--      pl_tamano_base_log() (solo cron) escribe una fila diaria en public.sync_log con motivo
--      'tamano_base' y un resumen en 'nombres' (cron 'tamano-base-log', 05:05 UTC).
--   5. Crons: alta o ajuste por nombre (si 'audit-log-purge' ya existe solo se le cambia el comando y
--      conserva su horario; si no existe se crea a las 04:17 UTC).
--
-- VERIFICAR (SQL Editor)
--   select jobname, schedule, command, active from cron.job order by jobid;
--   select public.pl_audit_purga();                 -- corre la purga ahora y dice cuánto borró
--   select public.pl_tamano_base();                 -- con sesión de una cuenta activa
--   select * from public.sync_log where motivo = 'tamano_base' order by id desc limit 7;
--   select count(*) filter (where diff ? '_fusiones') as fusionadas, count(*) from public.audit_log
--     where tabla = 'notes' and ts > now() - interval '1 day';
-- (El archivo evita a propósito las palabras que el conector de Supabase clasifica como
--  destructivas; el borrado se arma con 'del' || 'ete' dentro de la función, como en
--  indicaciones_collect.)
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- ── 3. Índices ─────────────────────────────────────────────────────────────────────────
create index if not exists audit_log_record_ts_idx on public.audit_log (record_id, ts desc);
create index if not exists audit_log_ts_idx on public.audit_log (ts);

-- ── 2 y 3. Disparador pl_audit() (cuerpo de supabase_audit_historial.sql + fusión + búsqueda por uuid)
CREATE OR REPLACE FUNCTION public.pl_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hdr jsonb; claims jsonb;
  v_uid uuid; v_email text; v_nombre text; v_dev text; v_ip text; v_ua text;
  v_campos text[] := '{}'; v_diff jsonb := '{}'::jsonb; v_rec text; v_rec_uuid uuid; v_cama text; v_pac text;
  k text; oldj jsonb; newj jsonb; ov jsonb; nv jsonb; sub jsonb; v_max int;
  is_del boolean := (TG_OP = 'DEL' || 'ETE');
  -- Fusión de rachas de tecleo (solo notes / UPDATE con puros campos de texto)
  v_texto constant text[] := array['app', 'pa', 'manejo', 'pendientes', 'drenajes', 'qx', 'sangrado', 'sv', 'balance', 'entrega', 'checklist'];
  v_prev_id bigint; v_prev_ts timestamptz; v_prev_diff jsonb; v_nuevo jsonb; v_ok boolean; pa text; na text; pv jsonb; nv2 jsonb; v_sk text;
begin
  begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
  begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
  begin v_uid := nullif(claims->>'sub', '')::uuid; exception when others then v_uid := null; end;
  v_email := claims->>'email';
  if v_email is null then
    v_email := case when claims->>'role' = 'service_role' then 'robot (service_role)' when claims is null then 'sql/cron' else coalesce(claims->>'role', '?') end;
  end if;
  v_dev := left(hdr->>'x-pl-device', 80);
  v_nombre := left(hdr->>'x-pl-user', 80);
  v_ip := left(coalesce(nullif(hdr->>'cf-connecting-ip', ''), nullif(hdr->>'x-real-ip', ''), nullif(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1), '')), 60);
  v_ua := left(hdr->>'user-agent', 200);
  v_max := case when TG_TABLE_NAME = 'notes' then 6000 else 800 end;
  oldj := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  newj := case when is_del then null else to_jsonb(NEW) end;
  if TG_OP = 'UPDATE' then
    for k in select jsonb_object_keys(newj) loop
      ov := oldj -> k; nv := newj -> k;
      if ov is distinct from nv and k not in ('updated_at', 'client_updated_at', 'updated_by', 'synced_at', 'last_seen_at') then
        v_campos := v_campos || k;
        if k = 'checklist' and jsonb_typeof(ov) = 'object' and jsonb_typeof(nv) = 'object' then
          select coalesce(jsonb_object_agg(kk, jsonb_build_object('de', left(coalesce((ov -> kk)::text, ''), v_max), 'a', left(coalesce((nv -> kk)::text, ''), v_max))), '{}'::jsonb) into sub
          from (select jsonb_object_keys(ov) as kk union select jsonb_object_keys(nv)) s
          where (ov -> kk) is distinct from (nv -> kk) and kk not like '\_\_%';
          v_diff := v_diff || jsonb_build_object(k, sub);
          -- Entrega de guardia: vive en checklist.__pl_note_meta.entrega; se registra como campo propio.
          if (ov -> '__pl_note_meta' ->> 'entrega') is distinct from (nv -> '__pl_note_meta' ->> 'entrega') then
            -- ::text obligatorio: text[] || 'literal' sin tipo se resuelve como concatenación de arreglos y
            -- Postgres intenta leer 'entrega' como arreglo («malformed array literal») → el UPDATE de notes fallaba.
            v_campos := v_campos || 'entrega'::text;
            v_diff := v_diff || jsonb_build_object('entrega', jsonb_build_object('de', left(coalesce(ov -> '__pl_note_meta' ->> 'entrega', ''), v_max), 'a', left(coalesce(nv -> '__pl_note_meta' ->> 'entrega', ''), v_max)));
          end if;
        elsif jsonb_typeof(ov) = 'array' or jsonb_typeof(nv) = 'array' then
          v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('de', case when jsonb_typeof(ov) = 'array' then jsonb_array_length(ov) else 0 end, 'a', case when jsonb_typeof(nv) = 'array' then jsonb_array_length(nv) else 0 end, 'tipo', 'elementos'));
        else
          v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('de', left(coalesce(ov #>> '{}', ''), v_max), 'a', left(coalesce(nv #>> '{}', ''), v_max)));
        end if;
      end if;
    end loop;
    if coalesce(array_length(v_campos, 1), 0) = 0 then return null; end if;
  elsif TG_OP = 'INSERT' then
    select coalesce(array_agg(key order by key), '{}') into v_campos from jsonb_each(newj)
    where value is not null and value::text not in ('""', '[]', '{}', 'false', 'null') and key not in ('id', 'created_at', 'updated_at', 'created_by', 'updated_by');
  end if;
  if TG_TABLE_NAME = 'patients' then
    v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
  elsif TG_TABLE_NAME = 'notes' then
    v_rec := coalesce(newj->>'patient_id', oldj->>'patient_id');
    -- Conversión segura a uuid: así la búsqueda usa la llave primaria de patients (antes p.id::text = v_rec, sin índice).
    begin v_rec_uuid := v_rec::uuid; exception when others then v_rec_uuid := null; end;
    if v_rec_uuid is not null then
      select p.cama, p.nombre into v_cama, v_pac from public.patients p where p.id = v_rec_uuid;
    end if;
  elsif TG_TABLE_NAME = 'procedimientos_dia' then
    v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
  else
    v_rec := coalesce(newj->>'id', oldj->>'id', newj->>'key', oldj->>'key');
  end if;

  -- ── Fusión de rachas de tecleo ───────────────────────────────────────────────────────
  -- Solo notes/UPDATE que cambie únicamente campos de texto (cajas, 'entrega', sub-llaves del checklist).
  if TG_TABLE_NAME = 'notes' and TG_OP = 'UPDATE' and v_rec is not null and v_campos <@ v_texto then
    -- Fila previa del mismo paciente, mismo usuario (cuenta, o nombre del dispositivo si no hay cuenta),
    -- mismo conjunto de campos, de hace menos de 5 min, cuya racha empezó hace menos de 30 min.
    select a.id, a.ts, a.diff into v_prev_id, v_prev_ts, v_prev_diff
    from public.audit_log a
    where a.record_id = v_rec and a.tabla = 'notes' and a.op = 'UPDATE'
      and a.ts > now() - interval '5 minutes'
      and a.campos <@ v_campos and v_campos <@ a.campos
      and (case when v_uid is not null then a.user_id = v_uid else a.user_id is null and a.nombre is not distinct from v_nombre end)
      and coalesce((a.diff ->> '_desde')::timestamptz, a.ts) > now() - interval '30 minutes'
    order by a.ts desc, a.id desc limit 1;
    if v_prev_id is not null then
      v_ok := true; v_nuevo := v_prev_diff;
      foreach k in array v_campos loop
        if k = 'checklist' then
          pv := v_prev_diff -> 'checklist'; nv2 := v_diff -> 'checklist';
          if pv is null or jsonb_typeof(pv) <> 'object' or jsonb_typeof(nv2) <> 'object'
             or (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(pv) x) <> (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(nv2) x) then
            v_ok := false;   -- otras sub-llaves → fila nueva
          else
            for v_sk in select jsonb_object_keys(nv2) loop
              pa := pv -> v_sk ->> 'a'; na := nv2 -> v_sk ->> 'a';
              -- Las sub-llaves se guardan como texto JSON: solo se fusionan cadenas ("…"), nunca booleanos u objetos.
              -- Continuidad: el 'a' previo debe ser el 'de' de este cambio. Borrado (encoge 40+ letras) → fila nueva.
              if pa is null or na is null or left(pa, 1) <> '"' or left(na, 1) <> '"'
                 or pa is distinct from (nv2 -> v_sk ->> 'de') or length(pa) - length(na) >= 40 then
                v_ok := false; exit;
              end if;
              v_nuevo := jsonb_set(v_nuevo, array['checklist', v_sk, 'a'], nv2 -> v_sk -> 'a');
            end loop;
          end if;
        else
          pa := v_prev_diff -> k ->> 'a'; na := v_diff -> k ->> 'a';
          if pa is null or na is null or pa is distinct from (v_diff -> k ->> 'de') or length(pa) - length(na) >= 40 then
            v_ok := false;
          else
            v_nuevo := jsonb_set(v_nuevo, array[k, 'a'], v_diff -> k -> 'a');
          end if;
        end if;
        exit when not v_ok;
      end loop;
      if v_ok then
        -- Es tecleo: se extiende la fila previa (conserva su 'de'), se marca desde cuándo y cuántos guardados lleva.
        v_nuevo := v_nuevo || jsonb_build_object('_desde', coalesce(v_prev_diff -> '_desde', to_jsonb(v_prev_ts)), '_fusiones', coalesce((v_prev_diff ->> '_fusiones')::int, 0) + 1);
        update public.audit_log set diff = v_nuevo, ts = now() where id = v_prev_id;
        return null;
      end if;
    end if;
  end if;

  insert into public.audit_log (user_id, email, nombre, dispositivo, ip, ua, tabla, op, record_id, cama, paciente, campos, diff)
  values (v_uid, v_email, v_nombre, v_dev, v_ip, v_ua, TG_TABLE_NAME, TG_OP, v_rec, v_cama, v_pac,
    case when TG_OP = 'UPDATE' or TG_OP = 'INSERT' then v_campos else null end,
    case when TG_OP = 'UPDATE' then v_diff when is_del then jsonb_build_object('registro', left(oldj::text, 600)) else jsonb_build_object('registro', left(newj::text, 400)) end);
  return null;
end $function$;

-- ── 1. Purga por tipo ──────────────────────────────────────────────────────────────────
create or replace function public.pl_audit_purga()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_sync constant text[] := array['lab_history', 'imagen_history'];
  v_texto constant text[] := array['app', 'pa', 'manejo', 'pendientes', 'drenajes', 'qx', 'sangrado', 'sv', 'balance', 'entrega', 'checklist'];
  n_listas int; n_texto int; n_resto int;
begin
  -- 30 días: filas de notes cuyos campos son solo listas sincronizadas (el diff trae conteos, no texto).
  execute 'del' || 'ete from public.audit_log a where a.ts < now() - interval ''30 days'''
       || ' and a.tabla = ''notes'' and a.campos <@ $1 and a.campos && $1' using v_sync;
  get diagnostics n_listas = row_count;
  -- 365 días: versiones de texto de las cajas (notes) y del DX (patients): lo que lee el 🕘 Historial por caja.
  execute 'del' || 'ete from public.audit_log a where a.ts < now() - interval ''365 days'''
       || ' and ((a.tabla = ''notes'' and a.op = ''UPDATE'' and a.campos && $1)'
       || '   or (a.tabla = ''patients'' and a.op = ''UPDATE'' and a.campos @> array[''dx'']))' using v_texto;
  get diagnostics n_texto = row_count;
  -- 180 días: todo lo demás (altas y bajas de registros, config, guard_info, cuentas, procedimientos…).
  execute 'del' || 'ete from public.audit_log a where a.ts < now() - interval ''180 days'''
       || ' and not ((a.tabla = ''notes'' and a.op = ''UPDATE'' and coalesce(a.campos && $1, false))'
       || '       or (a.tabla = ''patients'' and a.op = ''UPDATE'' and coalesce(a.campos @> array[''dx''], false)))' using v_texto;
  get diagnostics n_resto = row_count;
  return jsonb_build_object('listas_30d', n_listas, 'texto_365d', n_texto, 'resto_180d', n_resto, 'ts', now());
end $fn$;

-- ── 4. Monitor de tamaño ───────────────────────────────────────────────────────────────
-- Medición (solo postgres / cron): tamaño de la base, las 8 relaciones más grandes de cualquier esquema
-- (incluye net._http_response, cron.job_run_details, storage.objects…), filas de audit_log y nivel.
create or replace function public.pl_tamano_base_calc()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_db numeric; v_tablas jsonb; v_filas bigint; v_nivel text;
begin
  v_db := round(pg_database_size(current_database()) / 1048576.0, 1);
  select coalesce(jsonb_agg(jsonb_build_object('tabla', t.tabla, 'mb', t.mb) order by t.bytes desc), '[]'::jsonb) into v_tablas
  from (
    select n.nspname || '.' || c.relname as tabla,
           pg_total_relation_size(c.oid) as bytes,
           round(pg_total_relation_size(c.oid) / 1048576.0, 1) as mb
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'm') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\_%'
    order by pg_total_relation_size(c.oid) desc
    limit 8
  ) t;
  select count(*) into v_filas from public.audit_log;
  v_nivel := case when v_db >= 450 then 'alto' when v_db >= 350 then 'aviso' else 'ok' end;
  return jsonb_build_object('db_mb', v_db, 'tablas', v_tablas, 'audit_filas', v_filas, 'limite_mb', 500, 'nivel', v_nivel, 'ts', now());
end $fn$;

-- Para la app: cualquier cuenta activa con sesión; si no, null (mismo criterio que pl_historial_caja_v3).
create or replace function public.pl_tamano_base()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if coalesce(auth.role(), '') <> 'authenticated' or not coalesce(public.pl_is_active(), false) then
    return null;
  end if;
  return public.pl_tamano_base_calc();
end $fn$;

-- Registro diario (cron): una fila en public.sync_log con las mismas columnas que usa el Apps Script
-- (exp, camas, nombres, motivo); motivo = 'tamano_base' y el resumen compacto en 'nombres'.
create or replace function public.pl_tamano_base_log()
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  j jsonb; resumen text;
begin
  j := public.pl_tamano_base_calc();
  resumen := (j ->> 'nivel') || ' · ' || (j ->> 'db_mb') || ' MB de ' || (j ->> 'limite_mb') || ' · audit_log ' || (j ->> 'audit_filas') || ' filas · '
          || coalesce((select string_agg((x.t ->> 'tabla') || ' ' || (x.t ->> 'mb') || ' MB', ', ' order by x.i)
                       from jsonb_array_elements(j -> 'tablas') with ordinality as x(t, i)), '');
  insert into public.sync_log (exp, camas, nombres, motivo) values ('', '', left(resumen, 400), 'tamano_base');
  return resumen;
end $fn$;

-- Permisos: solo pl_tamano_base() es para la app; purga, medición y registro quedan para postgres/cron.
revoke all on function public.pl_audit_purga() from public, anon, authenticated;
revoke all on function public.pl_tamano_base_calc() from public, anon, authenticated;
revoke all on function public.pl_tamano_base_log() from public, anon, authenticated;
revoke all on function public.pl_tamano_base() from public, anon;
grant execute on function public.pl_tamano_base() to authenticated;

-- ── 5. Crons (por nombre, idempotente) ─────────────────────────────────────────────────
--   audit-log-purge  (jobid 8, ya existe): solo cambia el comando; conserva su horario.
--   audit-log-vacuum (nuevo): domingos 04:55 UTC, vacuum (analyze) public.audit_log.
--   tamano-base-log  (nuevo): diario 05:05 UTC, una fila en sync_log.
do $cron$
declare
  r record; jid bigint;
begin
  for r in
    select * from (values
      ('audit-log-purge',  null::text,   'select public.pl_audit_purga()'),
      ('audit-log-vacuum', '55 4 * * 0', 'vacuum (analyze) public.audit_log'),
      ('tamano-base-log',  '5 5 * * *',  'select public.pl_tamano_base_log()')
    ) as v(nombre, horario, comando)
  loop
    select j.jobid into jid from cron.job j where j.jobname = r.nombre;
    if jid is null then
      perform cron.schedule(r.nombre, coalesce(r.horario, '17 4 * * *'), r.comando);
    elsif r.horario is null then
      perform cron.alter_job(job_id := jid, command := r.comando);
    else
      perform cron.alter_job(job_id := jid, schedule := r.horario, command := r.comando);
    end if;
  end loop;
end $cron$;
