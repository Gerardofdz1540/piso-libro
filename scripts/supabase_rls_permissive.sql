-- ═══════════════════════════════════════════════════════════════════════
-- Piso Libro — Policies RLS permisivas (opción C)
-- Pega todo este bloque en Supabase Dashboard → SQL Editor → Run
-- Deja RLS "enabled" pero permite acceso total al rol anon (la app usa
-- anon key sin Supabase Auth).
-- ═══════════════════════════════════════════════════════════════════════

-- Lista de tablas usadas por la app
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['patients', 'archive', 'notes', 'no_olvidar',
                         'procedimientos_dia', 'guard_info'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Asegurar RLS enabled (no romper lo actual)
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Borrar cualquier policy previa llamada igual para evitar duplicados
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_full_access_anon" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "piso_libro_full_access_auth" ON public.%I', t);

    -- Policy completamente permisiva para ambos roles (anon y authenticated)
    EXECUTE format($p$
      CREATE POLICY "piso_libro_full_access_anon"
      ON public.%I
      AS PERMISSIVE
      FOR ALL
      TO anon
      USING (true)
      WITH CHECK (true)
    $p$, t);

    EXECUTE format($p$
      CREATE POLICY "piso_libro_full_access_auth"
      ON public.%I
      AS PERMISSIVE
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true)
    $p$, t);
  END LOOP;
END $$;

-- Verificar (opcional) — muestra las policies creadas
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('patients','archive','notes','no_olvidar','procedimientos_dia','guard_info')
ORDER BY tablename, policyname;
