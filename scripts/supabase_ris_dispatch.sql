-- 27 oct 2026 · aplicado en producción (migración ris_dispatch_cada_2h).
-- El robot del RIS (imagen) estaba programado cada 2 h en GitHub, pero GitHub lo lanzaba cada 4-6 h y los estudios
-- llegaban tarde. Igual que WinLab (supabase_pg_cron_dispatch.sql), ahora Supabase lo dispara a hora exacta cada 2 h por
-- el worker (ruta POST /api/scrape-ris, worker v5). Mientras el worker no se actualice, esa ruta responde 404 y queda
-- anotado en winlab_dispatch_log (sin efecto: el cron de GitHub sigue como respaldo).
create or replace function public.ris_dispatch_scrape(p_reason text default 'cron')
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_url text;
  v_token text;
  v_req bigint;
begin
  select value->>'url', value->>'token' into v_url, v_token
    from public.config where key = 'worker_config';
  if v_url is null or btrim(v_url) = '' then
    insert into public.winlab_dispatch_log(reason, error_msg, checked_at)
      values ('RIS ' || p_reason, 'config.worker_config sin url', now());
    return null;
  end if;
  v_url := regexp_replace(btrim(v_url), '/+$', '') || '/api/scrape-ris';
  v_req := net.http_post(
    url := v_url,
    body := jsonb_build_object('source', 'pg_cron', 'reason', p_reason),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Piso-Token', coalesce(v_token, '')),
    timeout_milliseconds := 20000
  );
  insert into public.winlab_dispatch_log(reason, request_id) values ('RIS ' || p_reason, v_req);
  return v_req;
end
$fn$;
revoke all on function public.ris_dispatch_scrape(text) from public, anon, authenticated;
-- Cada 2 h, minuto 41 (lejos del :00 y de los disparos de WinLab: 11:00, 18:30 y 02:07 UTC).
select cron.schedule('ris-scrape-cada-2h', '41 */2 * * *', $$select public.ris_dispatch_scrape('cron cada 2 h')$$);
