-- ═══ Todas las pruebas de la base integrada, juntas (20 oct 2026) ════════════════════════════════════════════════
-- Por qué: después de aplicar las 11 migraciones en el orden de APLICAR_EN_ORDEN.md (O1, N1…N5, O2…O6) hay que
-- poder confirmar de un jalón que siguen en verde las pruebas de los dos paquetes, la batería de la 🌙 Guardia y la
-- 🕓 Cronología (valsql/pruebas.sql, 28) y las de integración entre paquetes. Cada archivo corre en SU transacción y
-- la deshace (begin … rollback): no deja rastro. Al final, una tabla con OK / FALLA por archivo.
-- SOLO EN LA RÉPLICA LOCAL (p. ej. b_integrada): varias pruebas crean usuarios ficticios en auth.users, bloquean
-- tablas enteras dentro de su transacción (respaldo_hora, respaldo_hora_otros) y disparan indicaciones_fetch (pg_net).
-- No correrlo en producción.
-- Uso (desde cualquier carpeta; las rutas son relativas a este archivo):
--   psql -h 127.0.0.1 -p 55432 -U postgres -d b_final -X -f db_blindaje/todo_pruebas.sql
-- Cada archivo imprime su «RESULTADO OK: n pruebas» (o «EQUIVALENCIA OK», o la primera FALLA). Esperado con las 11
-- aplicadas: 28 + 28 + 10 + 5 + 9 + 11 + 14 + 9 + 16 + 13 + 12 + 16 + 9 + 9 = 189 pruebas y la equivalencia de O5
-- (4 ráfagas). correr_integrado.sh suma los números y además corre la prueba de la app (node) y los mutantes.
-- (20 oct 2026, revisión de datos y operación: +9 pruebas: N3-8/9, N4-10/11, N5-13/14, P2-13, P2-14, P2-14b.)
-- N6 (REPLICA IDENTITY FULL) es solo de producción: su prueba corre únicamente si notes ya está en FULL.
\set QUIET on
\pset pager off
\set ON_ERROR_STOP off
drop table if exists pg_temp.zz_todo;
create temp table zz_todo (orden int, archivo text, ok boolean, error text);

\echo '── 1 · valsql/pruebas.sql (🌙 Guardia y 🕓 Cronología, la batería original)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir ../valsql/pruebas.sql
insert into zz_todo values (1, 'valsql/pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 2 · notas/bateria_adaptada.sql (la misma batería; G11b prepara su sello con el permiso de mantenimiento)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/bateria_adaptada.sql
insert into zz_todo values (2, 'notas/bateria_adaptada.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 3 · notas/01_by_monotono_pruebas.sql (N1)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/01_by_monotono_pruebas.sql
insert into zz_todo values (3, 'notas/01_by_monotono_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 4 · notas/02_guardia_otro_usuario_pruebas.sql (N2)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/02_guardia_otro_usuario_pruebas.sql
insert into zz_todo values (4, 'notas/02_guardia_otro_usuario_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 5 · notas/03_labs_sin_perdidas_pruebas.sql (N3)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/03_labs_sin_perdidas_pruebas.sql
insert into zz_todo values (5, 'notas/03_labs_sin_perdidas_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 6 · notas/04_sin_cambios_pruebas.sql (N4)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/04_sin_cambios_pruebas.sql
insert into zz_todo values (6, 'notas/04_sin_cambios_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 7 · notas/05_restaurada_protegida_pruebas.sql (N5)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/05_restaurada_protegida_pruebas.sql
insert into zz_todo values (7, 'notas/05_restaurada_protegida_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 8 · otros/01_audit_por_equipo_pruebas.sql (O1)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/01_audit_por_equipo_pruebas.sql
insert into zz_todo values (8, 'otros/01_audit_por_equipo_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 9 · otros/02_papelera_copia_base_pruebas.sql (O2)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/02_papelera_copia_base_pruebas.sql
insert into zz_todo values (9, 'otros/02_papelera_copia_base_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 10 · otros/03_listas_compartidas_pruebas.sql (O3)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/03_listas_compartidas_pruebas.sql
insert into zz_todo values (10, 'otros/03_listas_compartidas_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 11 · otros/04_borrado_masivo_pruebas.sql (O4)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/04_borrado_masivo_pruebas.sql
insert into zz_todo values (11, 'otros/04_borrado_masivo_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 12 · otros/05_alarma_perdidas_pruebas.sql (O5)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/05_alarma_perdidas_pruebas.sql
insert into zz_todo values (12, 'otros/05_alarma_perdidas_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 13 · otros/06_permisos_pruebas.sql (O6)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir otros/06_permisos_pruebas.sql
insert into zz_todo values (13, 'otros/06_permisos_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 14 · integrada/integracion_pruebas.sql (cruces entre paquetes: O2+N5+N3+N4, N4+O1+O3, O1+N2)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir integrada/integracion_pruebas.sql
insert into zz_todo values (14, 'integrada/integracion_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

\echo '── 15 · integrada/equivalencia_05_generada.sql (O5: consulta de la reproducción del 19/10 = pl_detectar_perdidas)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir integrada/equivalencia_05_generada.sql
insert into zz_todo values (15, 'integrada/equivalencia_05_generada.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));

-- N6: solo si ya se aplicó (producción); en la réplica local notes sigue en REPLICA IDENTITY DEFAULT.
select relreplident = 'f' as zz_n6 from pg_class where oid = 'public.notes'::regclass \gset
\if :zz_n6
\echo '── 16 · notas/06_replica_full_pruebas.sql (N6)'
\set LAST_ERROR_SQLSTATE 00000
\set LAST_ERROR_MESSAGE ''
\ir notas/06_replica_full_pruebas.sql
insert into zz_todo values (16, 'notas/06_replica_full_pruebas.sql', :'LAST_ERROR_SQLSTATE' = '00000', nullif(:'LAST_ERROR_MESSAGE', ''));
\else
\echo '── 16 · notas/06_replica_full_pruebas.sql: se omite (N6 no está aplicado; es solo de producción)'
\endif

\echo '══ RESUMEN ══'
\pset footer off
select orden as "#", archivo, case when ok then 'OK' else 'FALLA' end as resultado, coalesce(left(error, 160), '') as "primera falla"
  from zz_todo order by orden;
select format('%s de %s archivos en verde', count(*) filter (where ok), count(*)) as resumen,
       case when bool_and(ok) then 'TODO EN VERDE' else 'HAY FALLAS' end as estado
  from zz_todo;
