-- ═══ O6 · Permisos de las funciones de historial e indicaciones (20 oct 2026, revisión integral P1-14 / hallazgo D12) ═══
-- Qué hay hoy en producción (leído el 20 oct por MCP, solo SELECT a pg_proc / has_function_privilege):
--   pl_historial_caja (v1), pl_historial_caja_v2, pl_historial_caja_v3: SECURITY DEFINER; EXECUTE para postgres,
--     authenticated y service_role (sin PUBLIC ni anon). v1 y v2 solo envuelven a la v3, que exige
--     auth.role() = 'authenticated' y pl_is_active(): no exponen nada que la v3 no exponga, pero son superficie de más.
--   indicaciones_fetch(), indicaciones_collect(): SECURITY DEFINER, con EXECUTE para PUBLIC (=X/postgres), o sea
--     también anon: cualquiera con la llave pública de la app podía, por /rest/v1/rpc, disparar la descarga del Google
--     Doc por pg_net (cada llamada ~120 KB en net._http_response) o procesar la cola. Es la fuga de pg_net del lote M.
-- Quién las llama de verdad:
--   · La app (main 1ba7520, openFieldHistory): llama SIEMPRE primero a pl_historial_caja_v3 y solo cae a la v2 y luego a
--     la v1 si la v3 «no existe» (404 / PGRST202 / «not found» / «does not exist»). Todas las versiones publicadas que
--     tienen el 🕘 (desde el PR #197, faad81d, 19 oct) llaman a la v3 primero; antes no había 🕘. La v3 existe en
--     producción, así que la app nunca llega a la v2 ni a la v1.
--   · indicaciones_*: solo los crons «indicaciones-fetch» (*/15) e «indicaciones-collect» (2-59/15), como postgres
--     (cron.job.username = postgres). La única Edge Function (admin-users) no las usa; el Apps Script sube el Doc directo
--     a la tabla indicaciones_doc (service_role) y la app solo lee esa tabla. Nada en el repo las llama por /rpc.
-- Cambio:
--   1) revoke EXECUTE de pl_historial_caja (v1) y pl_historial_caja_v2 a authenticated (y PUBLIC/anon, que ya no lo
--      tenían). Quedan para postgres y service_role (mantenimiento). La v3 no cambia.
--      Efecto si un día la v3 faltara: la app caería a la v2 y recibiría «permission denied for function
--      pl_historial_caja_v2» (código 42501, HTTP 403), que NO es «no existe»: el 🕘 mostraría «No se pudo cargar el
--      historial: …» en vez de seguir a la v1 (si PostgREST la respondiera como 404, iría a la v1 y terminaría en el
--      mismo aviso). Nada se escribe ni se pierde; hoy no ocurre porque la v3 está, y sin la v3 la v2 y la v1 tampoco
--      funcionarían (son envolturas de la v3).
--   2) revoke EXECUTE de indicaciones_fetch e indicaciones_collect a PUBLIC (con eso anon ya no puede). Siguen postgres
--      (los crons), service_role y authenticated (tenía el permiso explícito; la app no las llama: se puede quitar
--      también con las líneas comentadas al final si se quiere cerrar del todo).
-- Se puede volver a correr (revoke/grant son idempotentes).

revoke execute on function public.pl_historial_caja(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.pl_historial_caja_v2(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.pl_historial_caja(uuid, text, integer) to service_role;
grant execute on function public.pl_historial_caja_v2(uuid, text, integer) to service_role;

revoke execute on function public.indicaciones_fetch() from public, anon;
revoke execute on function public.indicaciones_collect() from public, anon;
grant execute on function public.indicaciones_fetch() to service_role;
grant execute on function public.indicaciones_collect() to service_role;
-- Opcional (cerrar del todo; la app no las usa):
--   revoke execute on function public.indicaciones_fetch() from authenticated;
--   revoke execute on function public.indicaciones_collect() from authenticated;

-- REVERSA:
--   grant execute on function public.pl_historial_caja(uuid, text, integer) to authenticated;
--   grant execute on function public.pl_historial_caja_v2(uuid, text, integer) to authenticated;
--   grant execute on function public.indicaciones_fetch() to public;
--   grant execute on function public.indicaciones_collect() to public;
