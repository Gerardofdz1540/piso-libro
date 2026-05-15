-- ═══════════════════════════════════════════════════════════════════════
-- Piso Libro — Drop de columnas legacy (post-consolidación)
--
-- EJECUTAR SOLO DESPUÉS DE:
--   1) Desplegar el index.html con la migración misc→pendientes activa
--   2) Esperar 1-2 días para que TODOS los residentes hayan abierto la app
--      al menos una vez (la migración se aplica al cargar notas).
--   3) Verificar con: SELECT COUNT(*) FROM notes WHERE misc IS NOT NULL AND misc != '';
--      Si el conteo es bajo, los datos ya están migrados a pendientes.
--
-- Pega en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════

-- Safety check: ver pacientes que aún tienen misc con contenido
SELECT
  COUNT(*) FILTER (WHERE misc IS NOT NULL AND misc != '') AS notas_con_misc_pendiente,
  COUNT(*) AS total_notas
FROM public.notes;

-- Si notas_con_misc_pendiente == 0, ya puedes ejecutar el DROP:
-- (Descomenta la siguiente línea)
-- ALTER TABLE public.notes DROP COLUMN IF EXISTS misc;

-- Si quedan notas con misc no vacío, primero ejecuta este BACKFILL
-- que fusiona misc → pendientes a nivel SQL (útil si algunos residentes
-- no abren la app en días):
--
-- UPDATE public.notes
-- SET pendientes = CASE
--   WHEN pendientes IS NULL OR pendientes = '' THEN misc
--   ELSE pendientes || E'\n\n' || misc
-- END
-- WHERE misc IS NOT NULL AND misc != '';
--
-- Y luego sí ejecuta el DROP:
-- ALTER TABLE public.notes DROP COLUMN IF EXISTS misc;
