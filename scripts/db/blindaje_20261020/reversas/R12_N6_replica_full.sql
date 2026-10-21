-- ═══ R12_N6_replica_full · reversa de N6 (notas/06_replica_full.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás N6 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. Solo producción (N6 no se aplica en la réplica local). Vuelve notes a REPLICA IDENTITY DEFAULT: solo catálogo, sin
-- pérdida de datos; toma ACCESS EXCLUSIVE milisegundos (lock_timeout de 5 s para no hacer fila).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V12 pasa a dar ok = false.

set lock_timeout = '5s';
alter table public.notes replica identity default;
reset lock_timeout;

select 'R12_N6_replica_full · N6 revertido' as reversa,
       (select relreplident from pg_class where oid = 'public.notes'::regclass) = 'd' as ok;
