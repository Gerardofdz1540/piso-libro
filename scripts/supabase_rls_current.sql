-- ═══════════════════════════════════════════════════════════════════════
-- Piso Libro — Estado VIGENTE de seguridad en Supabase (oct 2026)
--
-- Este archivo es de REFERENCIA y de re-aplicación: refleja exactamente lo
-- que hay en el proyecto (verificado con pg_policies / role_table_grants).
-- Es idempotente: se puede pegar completo en Supabase → SQL Editor → Run.
--
-- Modelo:
--   • La app inicia sesión con Supabase Auth (correo + contraseña). Cada
--     petición REST lleva el JWT del usuario → rol `authenticated`.
--   • El rol `anon` NO tiene ningún permiso sobre las tablas (REVOKE). Tener
--     la anon key (que es pública por diseño) no sirve para leer ni escribir.
--   • El scraper (GitHub Actions) y el Apps Script usan la service_role key
--     desde secrets; esa llave salta RLS y nunca va en el repo ni en la hoja.
--
-- Los scripts anteriores (supabase_rls_permissive.sql / _restrictive.sql)
-- daban acceso TOTAL al rol anon y se retiraron: NO volver a aplicarlos.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'patients', 'notes', 'archive', 'no_olvidar', 'procedimientos_dia',
    'guard_info', 'config', 'lab_entries', 'imagen_entries',
    'winlab_labs', 'winlab_reports', 'sync_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- anon: sin privilegios de ningún tipo
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    -- authenticated: acceso completo (el equipo entero comparte el censo)
    EXECUTE format('GRANT ALL ON public.%I TO authenticated', t);
    IF t = 'sync_log' THEN
      -- sync_log solo se consulta desde la app; lo escriben el Apps Script y el watchdog (service_role)
      EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON public.%I', t);
      EXECUTE format('DROP POLICY IF EXISTS "sync_log_auth_read" ON public.%I', t);
      EXECUTE format('CREATE POLICY "sync_log_auth_read" ON public.%I FOR SELECT TO authenticated USING (true)', t);
    ELSE
      EXECUTE format('DROP POLICY IF EXISTS "authenticated_all" ON public.%I', t);
      EXECUTE format('CREATE POLICY "authenticated_all" ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

-- winlab_labs además tiene una policy explícita para service_role (el scraper).
DROP POLICY IF EXISTS "winlab_labs_all_service" ON public.winlab_labs;
CREATE POLICY "winlab_labs_all_service" ON public.winlab_labs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Realtime: tablas que la app escucha en vivo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'winlab_labs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.winlab_labs;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'guard_info') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.guard_info;
  END IF;
END $$;

-- El sync de la hoja reescribe el censo cada 5 min: este trigger descarta los UPDATE
-- sin cambios para que no generen eventos Realtime ni re-renders en los dispositivos.
DROP TRIGGER IF EXISTS patients_suppress_redundant_updates ON public.patients;
CREATE TRIGGER patients_suppress_redundant_updates
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

-- Verificación rápida (debe devolver: anon sin grants, authenticated_all en cada tabla).
SELECT t.tablename,
       (SELECT string_agg(p.policyname, ', ') FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies,
       (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_schema = 'public' AND g.table_name = t.tablename AND g.grantee = 'anon') AS anon_grants
FROM pg_tables t WHERE t.schemaname = 'public' ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════
-- Cuentas con administrador y registro de actividad (oct 2026). Referencia
-- de lo aplicado (migraciones app_users_admin_accounts, audit_log_actividad,
-- solo_cuentas_activas). Idempotente salvo las políticas (CREATE POLICY falla
-- si ya existe: usar DROP POLICY IF EXISTS antes si se re-aplica).
-- ═══════════════════════════════════════════════════════════════════════
create table if not exists public.app_users (
  id uuid primary key references auth.users(id),
  email text not null default '', nombre text not null default '',
  role text not null default 'usuario' check (role in ('admin','usuario')),
  status text not null default 'active' check (status in ('active','blocked')),
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), last_seen_at timestamptz, notas text not null default ''
);
alter table public.app_users enable row level security;
revoke all on public.app_users from anon;
grant select on public.app_users to authenticated;
grant update (nombre, last_seen_at) on public.app_users to authenticated;
create or replace function public.pl_is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users u where u.id = auth.uid() and u.role = 'admin' and u.status = 'active'); $$;
create or replace function public.pl_is_active() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users u where u.id = auth.uid() and u.status = 'active'); $$;
-- Políticas de app_users: cada quien ve su fila (el admin todas) y solo edita su nombre/último acceso.
--   create policy app_users_read on public.app_users for select to authenticated using (id = auth.uid() or (select public.pl_is_admin()));
--   create policy app_users_self_update on public.app_users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Semilla inicial: todas las cuentas existentes activas; el dueño del proyecto admin.
--   insert into public.app_users (id, email, role, status) select id, coalesce(email,''), case when email='gfdz1540@gmail.com' then 'admin' else 'usuario' end, 'active' from auth.users on conflict (id) do nothing;
-- Solo cuentas activas (restrictiva, se suma a authenticated_all) en: patients, notes, archive, config,
-- guard_info, imagen_entries, lab_entries, no_olvidar, procedimientos_dia, winlab_dispatch_log, winlab_labs,
-- winlab_reports, sync_log, indicaciones_doc, ris_estudios y storage.objects:
--   create policy pl_solo_cuentas_activas on public.<tabla> as restrictive for all to authenticated
--     using ((select public.pl_is_active())) with check ((select public.pl_is_active()));
-- Registro de actividad: tabla public.audit_log (solo lectura para admin: policy audit_log_admin_read con
-- pl_is_admin()), función disparadora public.pl_audit() (security definer; lee request.jwt.claims y
-- request.headers: x-pl-device, x-pl-user, cf-connecting-ip, user-agent; guarda campos cambiados y de → a)
-- y disparadores pl_audit_<tabla> AFTER INSERT OR UPDATE OR DELETE en patients, notes, no_olvidar,
-- procedimientos_dia, guard_info y config. Retención: cron 'audit-log-purge' (180 días).
-- 19 oct 2026 (scripts/supabase_audit_historial.sql): para notes guarda el texto completo (6000) y la
-- Entrega; función pl_historial_caja(paciente, caja, límite) (security definer, solo authenticated) con
-- la que la app muestra y restaura versiones anteriores de una caja (botón 🕘).
-- Tablas internas sin acceso por API (RLS sin políticas, sin grants a anon/authenticated):
-- notes_backup_20261014, indicaciones_parts, indicaciones_fetch_log.
