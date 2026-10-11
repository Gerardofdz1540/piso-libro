-- ─────────────────────────────────────────────────────────────────────────────
-- Disparo del scraper WinLab A HORA EXACTA desde Supabase (pg_cron + pg_net)
-- Aplicado en el proyecto vkxplmrzyqlamxpbtmes el 11-oct-2026.
--
-- POR QUÉ: GitHub Actions retrasa los crons de este repo entre 3 y 9 horas (el de
-- 13:15 León llegaba a las 16:30–17:15). Supabase sí corre a la hora exacta y el
-- worker de Cloudflare ya sabe lanzar el workflow (POST /api/scrape, con dedupe).
-- El cron de GitHub se conserva como respaldo: si ambos coinciden, el worker no
-- duplica (ve la corrida en cola) o la segunda se encola y reutiliza lo ya parseado.
--
-- CÓMO FUNCIONA
--   cron.job (3 horarios UTC = León + 6 h)
--     └─ public.winlab_dispatch_scrape(motivo)
--          ├─ lee config.worker_config (url + token, los mismos que usa la app)
--          ├─ net.http_post(<url>/api/scrape, X-Piso-Token) — asíncrono
--          └─ inserta fila en public.winlab_dispatch_log (request_id)
--   cron 'winlab-dispatch-collect' cada 15 min
--     └─ public.winlab_dispatch_collect(): copia status_code/respuesta del worker
--        desde net._http_response al log (pg_net borra respuestas a las 6 h).
--
-- VERIFICAR:  select * from public.winlab_dispatch_log order by id desc limit 10;
--             select jobid, jobname, schedule, active from cron.job;
--             select * from cron.job_run_details order by start_time desc limit 10;
-- DISPARO MANUAL (SQL Editor):  select public.winlab_dispatch_scrape('manual');
-- CAMBIAR HORA:  select cron.alter_job(<jobid>, schedule := '15 19 * * *');
-- PAUSAR:        select cron.alter_job(<jobid>, active := false);
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;
create extension if not exists pg_net with schema extensions;

create table if not exists public.winlab_dispatch_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  reason text,
  request_id bigint,
  status_code integer,
  response text,
  error_msg text,
  checked_at timestamptz
);
alter table public.winlab_dispatch_log enable row level security;
create policy authenticated_all on public.winlab_dispatch_log for all to authenticated using (true) with check (true);

create or replace function public.winlab_dispatch_scrape(p_reason text default 'cron')
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
      values (p_reason, 'config.worker_config sin url', now());
    return null;
  end if;
  v_url := regexp_replace(btrim(v_url), '/+$', '') || '/api/scrape';
  v_req := net.http_post(
    url := v_url,
    body := jsonb_build_object('source', 'pg_cron', 'reason', p_reason),
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Piso-Token', coalesce(v_token, '')),
    timeout_milliseconds := 20000
  );
  insert into public.winlab_dispatch_log(reason, request_id) values (p_reason, v_req);
  return v_req;
end
$fn$;

create or replace function public.winlab_dispatch_collect()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  update public.winlab_dispatch_log l
     set status_code = r.status_code,
         response = left(coalesce(r.content, ''), 400),
         error_msg = coalesce(r.error_msg, case when r.timed_out then 'timeout' else null end),
         checked_at = now()
    from net._http_response r
   where r.id = l.request_id and l.checked_at is null;
  get diagnostics n = row_count;
  update public.winlab_dispatch_log
     set error_msg = 'sin respuesta registrada por pg_net', checked_at = now()
   where checked_at is null and request_id is not null and ts < now() - interval '1 hour';
  return n;
end
$fn$;

revoke all on function public.winlab_dispatch_scrape(text) from public, anon;
revoke all on function public.winlab_dispatch_collect() from public, anon;
grant execute on function public.winlab_dispatch_scrape(text) to authenticated;

-- Horarios: mismos que .github/workflows/winlab-scraper.yml (UTC). León = UTC-6 todo el año.
select cron.schedule('winlab-scrape-0407-leon', '7 10 * * *',  $$select public.winlab_dispatch_scrape('cron 04:07 León')$$);
select cron.schedule('winlab-scrape-1315-leon', '15 19 * * *', $$select public.winlab_dispatch_scrape('cron 13:15 León')$$);
select cron.schedule('winlab-scrape-2007-leon', '7 2 * * *',   $$select public.winlab_dispatch_scrape('cron 20:07 León')$$);
select cron.schedule('winlab-dispatch-collect', '*/15 * * * *', $$select public.winlab_dispatch_collect()$$);
select cron.schedule('cron-history-purge', '23 4 * * *', $$delete from cron.job_run_details where end_time < now() - interval '14 days'$$);
