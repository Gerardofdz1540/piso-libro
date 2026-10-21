-- ═══ O1 · La bitácora no fusiona ediciones de equipos distintos (20 oct 2026, revisión integral P0-04) ═══════════
-- Por qué: pl_audit junta en UNA fila de audit_log las ediciones seguidas (5 min) de la misma caja para no inflar la
-- bitácora, pero buscaba la fila a fusionar solo por usuario (user_id). Gera escribe con la misma cuenta desde el iPad,
-- la Mac, la PC y el iPhone: si la Mac agregaba un renglón y a los 2 min el iPad (con su copia vieja) lo quitaba, las
-- dos ediciones quedaban en la fila del iPad: la versión de la Mac desaparecía del 🕘 y de la bitácora (prueba
-- rev_integral/respaldos/prueba_audit.sql) y la regla de la 🌙 Guardia (pl_entrega_protegida, «lo que OTRO equipo
-- escribió en los últimos 15 min se respeta») no protegía lo de la Mac porque la bitácora decía «iPad»
-- (rev_integral/auditoria_datos/prueba_fusion_equipos.sql).
-- Ahora solo se fusiona con una fila del MISMO usuario, MISMO dispositivo (cabecera x-pl-device) y MISMO navegador
-- (user-agent). Sin usuario (robots con service_role, crons, SQL) no se fusiona nunca: antes se fusionaba por el nombre
-- de la cabecera x-pl-user, que no identifica a nadie.
-- Límite conocido: dos equipos con la misma cuenta, la misma etiqueta («Mac Chrome») y el MISMO user-agent siguen
-- contando como uno; eso lo resuelve el id de equipo en cada guardado (P1-02).
-- Solo cambia la búsqueda de la fila a fusionar; todo lo demás de pl_audit (qué se registra, recortes, reglas de la
-- fusión de texto) es idéntico a producción (md5 5604b95110fee8c8d3a63deca43d2840). Reversa al final del archivo.
-- Se puede volver a correr (create or replace).

create or replace function public.pl_audit() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  hdr jsonb; claims jsonb;
  v_uid uuid; v_email text; v_nombre text; v_dev text; v_ip text; v_ua text;
  v_campos text[] := '{}'; v_diff jsonb := '{}'::jsonb; v_rec text; v_rec_uuid uuid; v_cama text; v_pac text;
  k text; oldj jsonb; newj jsonb; ov jsonb; nv jsonb; sub jsonb; v_max int;
  is_del boolean := (TG_OP = 'DEL' || 'ETE');
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
        v_campos := array_append(v_campos, k);
        if k = 'checklist' and jsonb_typeof(ov) = 'object' and jsonb_typeof(nv) = 'object' then
          select coalesce(jsonb_object_agg(kk, jsonb_build_object('de', left(coalesce((ov -> kk)::text, ''), v_max), 'a', left(coalesce((nv -> kk)::text, ''), v_max))), '{}'::jsonb) into sub
          from (select jsonb_object_keys(ov) as kk union select jsonb_object_keys(nv)) s
          where (ov -> kk) is distinct from (nv -> kk) and kk not like '\_\_%';
          v_diff := v_diff || jsonb_build_object(k, sub);
          if (ov -> '__pl_note_meta' ->> 'entrega') is distinct from (nv -> '__pl_note_meta' ->> 'entrega') then
            v_campos := array_append(v_campos, 'entrega'::text);
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
    begin v_rec_uuid := v_rec::uuid; exception when others then v_rec_uuid := null; end;
    if v_rec_uuid is not null then
      select p.cama, p.nombre into v_cama, v_pac from public.patients p where p.id = v_rec_uuid;
    end if;
  elsif TG_TABLE_NAME = 'procedimientos_dia' then
    v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
  else
    v_rec := coalesce(newj->>'id', oldj->>'id', newj->>'key', oldj->>'key');
  end if;

  -- 20 oct 2026 (P0-04): solo se fusiona con la fila del MISMO equipo (usuario + dispositivo + navegador) y nunca sin
  -- usuario. Antes: «a.user_id = v_uid» (o, sin usuario, el mismo nombre de x-pl-user), y el iPad se tragaba lo de la Mac.
  if TG_TABLE_NAME = 'notes' and TG_OP = 'UPDATE' and v_rec is not null and v_campos <@ v_texto and v_uid is not null then
    select a.id, a.ts, a.diff into v_prev_id, v_prev_ts, v_prev_diff
    from public.audit_log a
    where a.record_id = v_rec and a.tabla = 'notes' and a.op = 'UPDATE'
      and a.ts > now() - interval '5 minutes'
      and a.campos <@ v_campos and v_campos <@ a.campos
      and a.user_id = v_uid
      and a.dispositivo is not distinct from v_dev
      and a.ua is not distinct from v_ua
      and coalesce((a.diff ->> '_desde')::timestamptz, a.ts) > now() - interval '30 minutes'
    order by a.ts desc, a.id desc limit 1;
    if v_prev_id is not null then
      v_ok := true; v_nuevo := v_prev_diff;
      foreach k in array v_campos loop
        if k = 'checklist' then
          pv := v_prev_diff -> 'checklist'; nv2 := v_diff -> 'checklist';
          if pv is null or jsonb_typeof(pv) <> 'object' or jsonb_typeof(nv2) <> 'object'
             or (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(pv) x) <> (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(nv2) x) then
            v_ok := false;
          else
            for v_sk in select jsonb_object_keys(nv2) loop
              pa := pv -> v_sk ->> 'a'; na := nv2 -> v_sk ->> 'a';
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
end $fn$;
-- Permisos sin cambio (create or replace los conserva): postgres, authenticated y service_role, sin PUBLIC.

-- ▼▼▼ REVERSA AUTOMÁTICA (armar_reversas.py) ▼▼▼
-- Para volver atrás: quitar los «-- » de abajo y correrlo (create or replace con la definición de producción).
-- Las tablas, triggers y permisos nuevos de este archivo se quitan con las líneas «REVERSA (objetos nuevos)» de arriba.
-- -- pl_audit() · cuerpo de rev_integral/regla_todas_cajas/02_audit_prod.sql + parche · md5(prosrc) 5604b95110fee8c8d3a63deca43d2840
-- CREATE OR REPLACE FUNCTION public.pl_audit()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- declare
--   hdr jsonb; claims jsonb;
--   v_uid uuid; v_email text; v_nombre text; v_dev text; v_ip text; v_ua text;
--   v_campos text[] := '{}'; v_diff jsonb := '{}'::jsonb; v_rec text; v_rec_uuid uuid; v_cama text; v_pac text;
--   k text; oldj jsonb; newj jsonb; ov jsonb; nv jsonb; sub jsonb; v_max int;
--   is_del boolean := (TG_OP = 'DEL' || 'ETE');
--   v_texto constant text[] := array['app', 'pa', 'manejo', 'pendientes', 'drenajes', 'qx', 'sangrado', 'sv', 'balance', 'entrega', 'checklist'];
--   v_prev_id bigint; v_prev_ts timestamptz; v_prev_diff jsonb; v_nuevo jsonb; v_ok boolean; pa text; na text; pv jsonb; nv2 jsonb; v_sk text;
-- begin
--   begin hdr := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then hdr := null; end;
--   begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
--   begin v_uid := nullif(claims->>'sub', '')::uuid; exception when others then v_uid := null; end;
--   v_email := claims->>'email';
--   if v_email is null then
--     v_email := case when claims->>'role' = 'service_role' then 'robot (service_role)' when claims is null then 'sql/cron' else coalesce(claims->>'role', '?') end;
--   end if;
--   v_dev := left(hdr->>'x-pl-device', 80);
--   v_nombre := left(hdr->>'x-pl-user', 80);
--   v_ip := left(coalesce(nullif(hdr->>'cf-connecting-ip', ''), nullif(hdr->>'x-real-ip', ''), nullif(split_part(coalesce(hdr->>'x-forwarded-for', ''), ',', 1), '')), 60);
--   v_ua := left(hdr->>'user-agent', 200);
--   v_max := case when TG_TABLE_NAME = 'notes' then 6000 else 800 end;
--   oldj := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
--   newj := case when is_del then null else to_jsonb(NEW) end;
--   if TG_OP = 'UPDATE' then
--     for k in select jsonb_object_keys(newj) loop
--       ov := oldj -> k; nv := newj -> k;
--       if ov is distinct from nv and k not in ('updated_at', 'client_updated_at', 'updated_by', 'synced_at', 'last_seen_at') then
--         v_campos := array_append(v_campos, k);
--         if k = 'checklist' and jsonb_typeof(ov) = 'object' and jsonb_typeof(nv) = 'object' then
--           select coalesce(jsonb_object_agg(kk, jsonb_build_object('de', left(coalesce((ov -> kk)::text, ''), v_max), 'a', left(coalesce((nv -> kk)::text, ''), v_max))), '{}'::jsonb) into sub
--           from (select jsonb_object_keys(ov) as kk union select jsonb_object_keys(nv)) s
--           where (ov -> kk) is distinct from (nv -> kk) and kk not like '\_\_%';
--           v_diff := v_diff || jsonb_build_object(k, sub);
--           if (ov -> '__pl_note_meta' ->> 'entrega') is distinct from (nv -> '__pl_note_meta' ->> 'entrega') then
--             v_campos := array_append(v_campos, 'entrega'::text);
--             v_diff := v_diff || jsonb_build_object('entrega', jsonb_build_object('de', left(coalesce(ov -> '__pl_note_meta' ->> 'entrega', ''), v_max), 'a', left(coalesce(nv -> '__pl_note_meta' ->> 'entrega', ''), v_max)));
--           end if;
--         elsif jsonb_typeof(ov) = 'array' or jsonb_typeof(nv) = 'array' then
--           v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('de', case when jsonb_typeof(ov) = 'array' then jsonb_array_length(ov) else 0 end, 'a', case when jsonb_typeof(nv) = 'array' then jsonb_array_length(nv) else 0 end, 'tipo', 'elementos'));
--         else
--           v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('de', left(coalesce(ov #>> '{}', ''), v_max), 'a', left(coalesce(nv #>> '{}', ''), v_max)));
--         end if;
--       end if;
--     end loop;
--     if coalesce(array_length(v_campos, 1), 0) = 0 then return null; end if;
--   elsif TG_OP = 'INSERT' then
--     select coalesce(array_agg(key order by key), '{}') into v_campos from jsonb_each(newj)
--     where value is not null and value::text not in ('""', '[]', '{}', 'false', 'null') and key not in ('id', 'created_at', 'updated_at', 'created_by', 'updated_by');
--   end if;
--   if TG_TABLE_NAME = 'patients' then
--     v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
--   elsif TG_TABLE_NAME = 'notes' then
--     v_rec := coalesce(newj->>'patient_id', oldj->>'patient_id');
--     begin v_rec_uuid := v_rec::uuid; exception when others then v_rec_uuid := null; end;
--     if v_rec_uuid is not null then
--       select p.cama, p.nombre into v_cama, v_pac from public.patients p where p.id = v_rec_uuid;
--     end if;
--   elsif TG_TABLE_NAME = 'procedimientos_dia' then
--     v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
--   else
--     v_rec := coalesce(newj->>'id', oldj->>'id', newj->>'key', oldj->>'key');
--   end if;
--
--   if TG_TABLE_NAME = 'notes' and TG_OP = 'UPDATE' and v_rec is not null and v_campos <@ v_texto then
--     select a.id, a.ts, a.diff into v_prev_id, v_prev_ts, v_prev_diff
--     from public.audit_log a
--     where a.record_id = v_rec and a.tabla = 'notes' and a.op = 'UPDATE'
--       and a.ts > now() - interval '5 minutes'
--       and a.campos <@ v_campos and v_campos <@ a.campos
--       and (case when v_uid is not null then a.user_id = v_uid else a.user_id is null and a.nombre is not distinct from v_nombre end)
--       and coalesce((a.diff ->> '_desde')::timestamptz, a.ts) > now() - interval '30 minutes'
--     order by a.ts desc, a.id desc limit 1;
--     if v_prev_id is not null then
--       v_ok := true; v_nuevo := v_prev_diff;
--       foreach k in array v_campos loop
--         if k = 'checklist' then
--           pv := v_prev_diff -> 'checklist'; nv2 := v_diff -> 'checklist';
--           if pv is null or jsonb_typeof(pv) <> 'object' or jsonb_typeof(nv2) <> 'object'
--              or (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(pv) x) <> (select coalesce(array_agg(x order by x), '{}') from jsonb_object_keys(nv2) x) then
--             v_ok := false;
--           else
--             for v_sk in select jsonb_object_keys(nv2) loop
--               pa := pv -> v_sk ->> 'a'; na := nv2 -> v_sk ->> 'a';
--               if pa is null or na is null or left(pa, 1) <> '"' or left(na, 1) <> '"'
--                  or pa is distinct from (nv2 -> v_sk ->> 'de') or length(pa) - length(na) >= 40 then
--                 v_ok := false; exit;
--               end if;
--               v_nuevo := jsonb_set(v_nuevo, array['checklist', v_sk, 'a'], nv2 -> v_sk -> 'a');
--             end loop;
--           end if;
--         else
--           pa := v_prev_diff -> k ->> 'a'; na := v_diff -> k ->> 'a';
--           if pa is null or na is null or pa is distinct from (v_diff -> k ->> 'de') or length(pa) - length(na) >= 40 then
--             v_ok := false;
--           else
--             v_nuevo := jsonb_set(v_nuevo, array[k, 'a'], v_diff -> k -> 'a');
--           end if;
--         end if;
--         exit when not v_ok;
--       end loop;
--       if v_ok then
--         v_nuevo := v_nuevo || jsonb_build_object('_desde', coalesce(v_prev_diff -> '_desde', to_jsonb(v_prev_ts)), '_fusiones', coalesce((v_prev_diff ->> '_fusiones')::int, 0) + 1);
--         update public.audit_log set diff = v_nuevo, ts = now() where id = v_prev_id;
--         return null;
--       end if;
--     end if;
--   end if;
--
--   insert into public.audit_log (user_id, email, nombre, dispositivo, ip, ua, tabla, op, record_id, cama, paciente, campos, diff)
--   values (v_uid, v_email, v_nombre, v_dev, v_ip, v_ua, TG_TABLE_NAME, TG_OP, v_rec, v_cama, v_pac,
--     case when TG_OP = 'UPDATE' or TG_OP = 'INSERT' then v_campos else null end,
--     case when TG_OP = 'UPDATE' then v_diff when is_del then jsonb_build_object('registro', left(oldj::text, 600)) else jsonb_build_object('registro', left(newj::text, 400)) end);
--   return null;
-- end $function$
-- ;
-- ▲▲▲ FIN DE LA REVERSA ▲▲▲
