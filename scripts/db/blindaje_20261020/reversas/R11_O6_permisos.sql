-- ═══ R11_O6_permisos · reversa de O6 (otros/06_permisos.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás O6 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. Devuelve los permisos de producción EN EL MISMO ORDEN (se quitan todos y se dan de nuevo en orden; así el ACL
-- queda letra por letra como estaba).
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V11 pasa a dar ok = false.

revoke all on function public.pl_historial_caja(uuid, text, integer) from public, postgres, anon, authenticated, service_role;
grant execute on function public.pl_historial_caja(uuid, text, integer) to postgres, authenticated, service_role;
revoke all on function public.pl_historial_caja_v2(uuid, text, integer) from public, postgres, anon, authenticated, service_role;
grant execute on function public.pl_historial_caja_v2(uuid, text, integer) to postgres, authenticated, service_role;
revoke all on function public.indicaciones_fetch() from public, postgres, anon, authenticated, service_role;
grant execute on function public.indicaciones_fetch() to public, postgres, authenticated, service_role;
revoke all on function public.indicaciones_collect() from public, postgres, anon, authenticated, service_role;
grant execute on function public.indicaciones_collect() to public, postgres, authenticated, service_role;

select 'R11_O6_permisos · O6 revertido' as reversa,
       (select proacl::text from pg_proc where oid = 'public.pl_historial_caja(uuid,text,integer)'::regprocedure) = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
   and (select proacl::text from pg_proc where oid = 'public.pl_historial_caja_v2(uuid,text,integer)'::regprocedure) = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
   and (select proacl::text from pg_proc where oid = 'public.indicaciones_fetch()'::regprocedure) = '{=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
   and (select proacl::text from pg_proc where oid = 'public.indicaciones_collect()'::regprocedure) = '{=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' as ok;
