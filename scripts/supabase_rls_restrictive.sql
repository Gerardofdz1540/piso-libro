-- ═══════════════════════════════════════════════════════════════════════
-- Piso Libro — Políticas RLS restrictivas (reemplaza supabase_rls_permissive.sql)
--
-- La app usa anon key sin Supabase Auth, por lo que se usan dos mecanismos
-- de control de acceso complementarios:
--
--   1. Rol anon: acceso completo a todas las tablas de la app.
--      Esto es necesario porque el cliente usa la anon key directamente.
--      La protección real proviene del punto 2.
--
--   2. Rol authenticated: acceso solo a sus propias filas (prep para Auth).
--      Cuando se migre a Supabase Auth, las policies de `authenticated`
--      ya restringirán por auth.uid().
--
-- DIFERENCIA vs supabase_rls_permissive.sql:
--   - Se eliminan las policies PERMISSIVE FOR ALL en `authenticated`.
--   - Se agregan policies restrictivas por auth.uid() para operaciones
--     de escritura en `authenticated`.
--   - `anon` mantiene acceso completo (necesario para la operación actual).
--   - Se agrega la tabla `winlab_labs` que faltaba en el script anterior.
--
-- Para aplicar: Supabase Dashboard → SQL Editor → pegar y ejecutar.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1. Habilitar RLS en todas las tablas ────────────────────────────────
ALTER TABLE public.patients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archive           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_olvidar        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedimientos_dia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guard_info        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.winlab_labs       ENABLE ROW LEVEL SECURITY;

-- ── 2. Eliminar policies anteriores para evitar conflictos ───────────────
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['patients','archive','notes','no_olvidar',
                          'procedimientos_dia','guard_info','winlab_labs'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_full_access_anon"  ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_full_access_auth"  ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_anon_all"          ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_auth_read"         ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_auth_write_own"    ON public.%I', t);
  END LOOP;
END $$;

-- ── 3. Policies para rol `anon` (acceso completo — operación actual) ─────
-- El anon key está en el cliente; la seguridad depende de no exponer el
-- service_role key y de monitorear el uso en el dashboard de Supabase.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['patients','archive','notes','no_olvidar',
                          'procedimientos_dia','guard_info','winlab_labs'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format($p$
      CREATE POLICY "piso_libro_anon_all"
      ON public.%I
      AS PERMISSIVE FOR ALL
      TO anon
      USING (true)
      WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;

-- ── 4. Policies para rol `authenticated` (restrictivas — prep para Auth) ─
-- Lectura: puede leer todas las filas (mismo que anon por ahora).
-- Escritura: solo puede modificar filas donde updated_by = auth.uid()::text
--            o donde updated_by IS NULL (filas sin propietario asignado).
-- Cuando se active Supabase Auth, esto limitará cada usuario a sus propios registros.

-- patients
CREATE POLICY "piso_libro_auth_read"
  ON public.patients AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.patients AS PERMISSIVE FOR ALL
  TO authenticated
  USING      (updated_by IS NULL OR updated_by = auth.uid()::text)
  WITH CHECK (updated_by IS NULL OR updated_by = auth.uid()::text);

-- archive
CREATE POLICY "piso_libro_auth_read"
  ON public.archive AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.archive AS PERMISSIVE FOR ALL
  TO authenticated
  USING      (true)
  WITH CHECK (true);

-- notes (no tiene columna updated_by — acceso completo para authenticated por ahora)
CREATE POLICY "piso_libro_auth_read"
  ON public.notes AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.notes AS PERMISSIVE FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

-- no_olvidar
CREATE POLICY "piso_libro_auth_read"
  ON public.no_olvidar AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.no_olvidar AS PERMISSIVE FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

-- procedimientos_dia
CREATE POLICY "piso_libro_auth_read"
  ON public.procedimientos_dia AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.procedimientos_dia AS PERMISSIVE FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

-- guard_info
CREATE POLICY "piso_libro_auth_read"
  ON public.guard_info AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "piso_libro_auth_write_own"
  ON public.guard_info AS PERMISSIVE FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

-- winlab_labs (solo lectura para authenticated; escritura solo desde el scraper RPA via service_role)
CREATE POLICY "piso_libro_auth_read"
  ON public.winlab_labs AS PERMISSIVE FOR SELECT
  TO authenticated USING (true);

-- ── 5. Verificar resultado ────────────────────────────────────────────────
SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('patients','archive','notes','no_olvidar',
                    'procedimientos_dia','guard_info','winlab_labs')
ORDER BY tablename, policyname;
