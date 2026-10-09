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
