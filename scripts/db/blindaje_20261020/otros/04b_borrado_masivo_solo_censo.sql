-- 20 oct 2026 · ajuste aplicado en producción después de 04_borrado_masivo.sql (migración blindaje_09b_borrado_masivo_solo_censo).
-- Gera pidió que «Borrar hechos» de No olvidar siga funcionando (con confirmación en la app). Lo borrado de No olvidar y
-- Procedimientos ya queda copiado en borrados_otros (03_listas_compartidas.sql), así que el freno de borrado masivo se
-- queda solo en patients y notes. Por eso V09 de verificacion_por_paso.sql da false en producción: se verifica con
--   select tgrelid::regclass, tgname from pg_trigger where tgname = 'pl_borrado_masivo';  -- solo patients y notes
set local lock_timeout = '5s';
drop trigger if exists pl_borrado_masivo on public.no_olvidar;
drop trigger if exists pl_borrado_masivo on public.procedimientos_dia;
