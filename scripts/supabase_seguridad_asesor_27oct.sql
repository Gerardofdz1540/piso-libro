-- 27 oct 2026 · aplicado en producción (migraciones respaldo_recuperacion_rls y seguridad_asesor_27oct).
-- Avisos del asesor de seguridad de Supabase (Advisors → Security).

-- 1) La tabla de respaldo del 20 oct (7 notas) tenía RLS apagado y todos los permisos para authenticated: cualquier
--    sesión iniciada, aun de una cuenta bloqueada o pendiente, podía leerla, cambiarla o vaciarla. Se cierra: RLS sin
--    políticas (solo el dueño y service_role) y sin permisos para las cuentas de la app.
alter table public.respaldo_recuperacion_20261020 enable row level security;
revoke all on table public.respaldo_recuperacion_20261020 from anon, authenticated;

-- 2) Funciones de trigger y de pg_cron: nadie las llama por /rest/v1/rpc (los triggers no revisan EXECUTE al dispararse
--    y pg_cron corre como postgres), así que se quita el permiso a anon y authenticated. Probado después con una cuenta
--    activa (rol authenticated): guardar una nota sigue pasando por todos los triggers de notes.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'archive_before_delete', 'patients_restore_note_after_insert', 'pl_cronologia_guardar_copia',
              'pl_cronologia_reponer', 'pl_audit', 'indicaciones_collect', 'indicaciones_fetch',
              'winlab_dispatch_collect', 'winlab_dispatch_scrape') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- 3) search_path fijo en las funciones que no lo tenían (ninguna usa extensiones): sin él, una función puede resolver
--    nombres en un esquema que no es el esperado.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'pl_name_norm', 'pl_same_person', 'pl_apply_resumen', 'pl_name_placeholder', 'pl_json_texto',
              'pl_es_auto_entrega', 'pl_entrega_renglones', 'pl_entrega_sin_auto', 'pl_entrega_restaurada',
              'pl_renglones_quitados', 'pl_checklist_sin_perdidas') loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
  end loop;
end $$;

-- Quedan como están, a propósito:
--   · pl_is_active, pl_is_admin: las usan las políticas RLS con el rol de quien consulta (necesitan EXECUTE).
--   · pl_historial_caja_v3, pl_tamano_base: las llama la app.
--   · Tablas con RLS y sin políticas (respaldos, bitácoras internas, rpa_config): es lo correcto; solo las lee la base.
--   · «Leaked password protection»: es un ajuste del panel (Authentication → Sign In / Providers → Email →
--     Prevent use of leaked passwords) y Supabase solo lo ofrece en el plan Pro. Ver el manual.
