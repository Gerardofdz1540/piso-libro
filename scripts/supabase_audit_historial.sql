-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Historial por caja (aplicado 19 oct 2026 en vkxplmrzyqlamxpbtmes, migración
-- audit_texto_completo_entrega_y_historial_caja)
--
-- Caso real: en una entrega de guardia, desde un iPad, bloques enteros de texto se movieron o
-- borraron entre cajas (Misceláneo → Pendientes, Pendientes → APP → PA) y el residente no pudo
-- recuperarlos. El registro de actividad (public.audit_log, disparador pl_audit) guardaba el texto
-- anterior, pero recortado a 800 letras, sin la Entrega de guardia (vive en checklist.__pl_note_meta,
-- que el disparador omitía por el prefijo __) y solo legible por el administrador.
--
-- Cambios:
--   1. pl_audit(): para notes guarda el texto completo (hasta 6000 letras) de cada campo y registra
--      la Entrega como campo propio 'entrega' (de → a) cuando cambia.
--   2. pl_historial_caja(p_patient, p_campo, p_limit): devuelve las versiones anteriores de UNA caja
--      de UN paciente (quién, cuándo, desde qué dispositivo, texto anterior y nuevo) a cualquier
--      usuario con sesión. Campos: columna de texto de notes ('pendientes', 'manejo', 'app', 'pa',
--      'dx', 'drenajes', 'sv', 'balance', 'sangrado', 'qx'), 'entrega', o 'ck:<llave>' para una
--      sub-llave del checklist ('ck:recibo', 'ck:interconsultas', 'ck:cultivos', 'ck:pendientes_mips',
--      'ck:pendientes_r1'). La app la llama desde el botón 🕘 de cada caja (openFieldHistory) y
--      restaura con updateField/updateCkText (queda en ↩ Regresar y otra vez en el historial).
--   La política audit_log_admin_read (solo admin lee la tabla completa) no cambia.
--   3. (v2, mismo día) pl_json_texto(): las sub-llaves del checklist se guardan como texto JSON; la primera versión
--      del RPC solo quitaba las comillas y un Recibo de varias líneas se restauraba con "\n" literales. Ahora el RPC
--      devuelve texto plano y una columna fmt = 2 (la app, si no recibe fmt, decodifica ella misma).
--   Nota: el texto se guarda hasta v_max (6000) letras por campo; la app marca esas versiones como «recortada».
-- ═══════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pl_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  hdr jsonb; claims jsonb;
  v_uid uuid; v_email text; v_nombre text; v_dev text; v_ip text; v_ua text;
  v_campos text[] := '{}'; v_diff jsonb := '{}'::jsonb; v_rec text; v_cama text; v_pac text;
  k text; oldj jsonb; newj jsonb; ov jsonb; nv jsonb; sub jsonb; v_max int;
  is_del boolean := (TG_OP = 'DEL' || 'ETE');
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
          -- Entrega de guardia: vive en checklist.__pl_note_meta.entrega; se registra como campo propio.
          if (ov -> '__pl_note_meta' ->> 'entrega') is distinct from (nv -> '__pl_note_meta' ->> 'entrega') then
            -- array_append y no `|| 'entrega'`: el literal se tomaba como arreglo ("malformed array literal") y ABORTABA el
            -- UPDATE de notes cuando cambiaba la Entrega/Cronología (hotfix pl_audit_hotfix_entrega_array_literal, 19 oct).
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
    select p.cama, p.nombre into v_cama, v_pac from public.patients p where p.id::text = v_rec;
  elsif TG_TABLE_NAME = 'procedimientos_dia' then
    v_rec := coalesce(newj->>'id', oldj->>'id'); v_cama := coalesce(newj->>'cama', oldj->>'cama'); v_pac := coalesce(newj->>'nombre', oldj->>'nombre');
  else
    v_rec := coalesce(newj->>'id', oldj->>'id', newj->>'key', oldj->>'key');
  end if;
  insert into public.audit_log (user_id, email, nombre, dispositivo, ip, ua, tabla, op, record_id, cama, paciente, campos, diff)
  values (v_uid, v_email, v_nombre, v_dev, v_ip, v_ua, TG_TABLE_NAME, TG_OP, v_rec, v_cama, v_pac,
    case when TG_OP = 'UPDATE' or TG_OP = 'INSERT' then v_campos else null end,
    case when TG_OP = 'UPDATE' then v_diff when is_del then jsonb_build_object('registro', left(oldj::text, 600)) else jsonb_build_object('registro', left(newj::text, 400)) end);
  return null;
end $function$;

-- Las sub-llaves del checklist se guardan en diff como texto JSON ((ov -> kk)::text): un texto de varias líneas queda
-- como "línea 1\nlínea 2" (con comillas y \n literales). Esta función lo decodifica a texto plano; si el valor quedó
-- recortado a v_max letras (JSON incompleto) intenta cerrarlo y, si no se puede, devuelve lo que hay sin comillas.
CREATE OR REPLACE FUNCTION public.pl_json_texto(x text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $$
begin
  if x is null or left(x, 1) <> '"' then return x; end if;
  begin return x::jsonb #>> '{}'; exception when others then null; end;
  begin return (x || '"')::jsonb #>> '{}'; exception when others then null; end;
  begin return (rtrim(x, '\') || '"')::jsonb #>> '{}'; exception when others then null; end;
  return trim(both '"' from x);
end $$;

-- Versiones: v2 (migración historial_caja_texto_plano_v2) añadió fmt = 2 y texto plano; se crearon con otro nombre
-- porque cambiar las columnas que devuelve una función exige DROP (sentencia destructiva que el conector no corre).
-- v3 (migración historial_caja_v3_recortada_dx_cuentas_activas, tras la revisión adversarial del PR #197). La app llama a
-- la v3 y cae a v2 y luego a v1 si la base no las tiene (404).
--  · de_cortada / a_cortada: el disparador guarda hasta v_max letras del texto TAL COMO SE ALMACENA (las sub-llaves del
--    checklist van como texto JSON, con \n y \" escapados), así que el texto decodificado puede ser más corto que 6000
--    aunque esté recortado. La marca se calcula aquí sobre lo almacenado.
--  · DX: la caja DX vive en patients (notes no tiene dx): se leen también las filas con tabla = 'patients' para 'dx'
--    (ahí v_max es 800).
--  · Solo cuentas activas: las funciones SECURITY DEFINER no pasaban por la política pl_solo_cuentas_activas; ahora
--    exigen public.pl_is_active() (una cuenta bloqueada con sesión aún válida no lee nada).
CREATE OR REPLACE FUNCTION public.pl_historial_caja_v3(p_patient uuid, p_campo text, p_limit int default 30)
 RETURNS TABLE (id bigint, ts timestamptz, nombre text, dispositivo text, de text, a text, fmt int, de_cortada boolean, a_cortada boolean)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public'
AS $$
  with f as (
    select a.id, a.ts, a.nombre, a.dispositivo, a.tabla,
      case when p_campo like 'ck:%' then a.diff -> 'checklist' -> substr(p_campo, 4) ->> 'de' else a.diff -> p_campo ->> 'de' end as rde,
      case when p_campo like 'ck:%' then a.diff -> 'checklist' -> substr(p_campo, 4) ->> 'a' else a.diff -> p_campo ->> 'a' end as ra
    from public.audit_log a
    where auth.role() = 'authenticated' and public.pl_is_active()
      and a.op = 'UPDATE' and a.record_id = p_patient::text
      and ((a.tabla = 'notes' and (case when p_campo like 'ck:%' then (a.campos @> array['checklist'] and (a.diff -> 'checklist') ? substr(p_campo, 4)) else a.campos @> array[p_campo] end))
        or (a.tabla = 'patients' and p_campo = 'dx' and a.campos @> array['dx']))
    order by a.ts desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  )
  select f.id, f.ts, f.nombre, f.dispositivo,
    case when p_campo like 'ck:%' then public.pl_json_texto(f.rde) else f.rde end as de,
    case when p_campo like 'ck:%' then public.pl_json_texto(f.ra) else f.ra end as a,
    3 as fmt,
    length(coalesce(f.rde, '')) >= (case when f.tabla = 'notes' then 6000 else 800 end) as de_cortada,
    length(coalesce(f.ra, '')) >= (case when f.tabla = 'notes' then 6000 else 800 end) as a_cortada
  from f
  order by f.ts desc;
$$;

-- v2 (misma firma): delega en la v3 (mismas reglas de acceso y DX), sin las marcas.
CREATE OR REPLACE FUNCTION public.pl_historial_caja_v2(p_patient uuid, p_campo text, p_limit int default 30)
 RETURNS TABLE (id bigint, ts timestamptz, nombre text, dispositivo text, de text, a text, fmt int)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public'
AS $$
  select v.id, v.ts, v.nombre, v.dispositivo, v.de, v.a, 2 as fmt from public.pl_historial_caja_v3(p_patient, p_campo, p_limit) v;
$$;

-- La v1 (misma firma de siempre) delega en la v2: también devuelve texto plano, sin la columna fmt.
CREATE OR REPLACE FUNCTION public.pl_historial_caja(p_patient uuid, p_campo text, p_limit int default 30)
 RETURNS TABLE (id bigint, ts timestamptz, nombre text, dispositivo text, de text, a text)
 LANGUAGE sql
 SECURITY DEFINER
 STABLE
 SET search_path TO 'public'
AS $$
  select v.id, v.ts, v.nombre, v.dispositivo, v.de, v.a from public.pl_historial_caja_v2(p_patient, p_campo, p_limit) v;
$$;

REVOKE ALL ON FUNCTION public.pl_historial_caja_v3(uuid, text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pl_historial_caja_v3(uuid, text, int) TO authenticated;
REVOKE ALL ON FUNCTION public.pl_historial_caja_v2(uuid, text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pl_historial_caja_v2(uuid, text, int) TO authenticated;
REVOKE ALL ON FUNCTION public.pl_historial_caja(uuid, text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pl_historial_caja(uuid, text, int) TO authenticated;
REVOKE ALL ON FUNCTION public.pl_json_texto(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.pl_json_texto(text) TO authenticated;
