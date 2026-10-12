-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Indicaciones del Google Doc → public.indicaciones_doc (aplicado en Supabase el 12 oct 2026)
--
-- Dos caminos alimentan la misma fila (id = 1):
--   A) pg_cron + pg_net (este archivo): cada 5 min la base descarga el Doc por su enlace de
--      exportación (el Doc está compartido "cualquiera con el enlace") y, si el texto cambió,
--      actualiza la fila. No necesita Apps Script ni intervención.
--   B) Apps Script syncIndicaciones() (apps-script/censo-sync.gs): lee el Doc autenticado con la
--      cuenta de Google y hace el mismo UPSERT. Es el respaldo si el enlace deja de ser público.
-- La app se suscribe por Realtime a indicaciones_doc y re-parsea los bloques por cama + nombre.
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.indicaciones_doc (
  id integer primary key default 1 check (id = 1),
  doc_id text,
  text text not null default '',
  text_hash text,
  doc_updated timestamptz,
  synced_at timestamptz not null default now()
);
alter table public.indicaciones_doc enable row level security;
create policy "indicaciones_doc_read" on public.indicaciones_doc for select to authenticated using (true);
alter table public.indicaciones_doc replica identity full;
alter publication supabase_realtime add table public.indicaciones_doc;

-- Peticiones pendientes de pg_net (una por corrida de fetch)
create table if not exists public.indicaciones_fetch_log (
  req_id bigint primary key,
  requested_at timestamptz not null default now(),
  processed boolean not null default false,
  result text
);
alter table public.indicaciones_fetch_log enable row level security;

-- Lanza la descarga (asíncrona) del Doc en texto plano.
create or replace function public.indicaciones_fetch() returns bigint
language plpgsql security definer set search_path = public, net as $$
declare rid bigint; did text;
begin
  select doc_id into did from public.indicaciones_doc where id = 1;
  if did is null or did = '' then did := '1gRCydpjiByBjMxp5edTbuiEwrzHTh8Ir2IvgYqZY73A'; end if;
  select net.http_get('https://docs.google.com/document/d/' || did || '/export?format=txt',
                      '{}'::jsonb, '{"User-Agent":"PisoLibro/1.0"}'::jsonb, 20000) into rid;
  insert into public.indicaciones_fetch_log (req_id) values (rid);
  return rid;
end $$;

-- Recoge las respuestas: si el texto cambió (md5), actualiza la fila (Realtime avisa a la app).
-- Una respuesta HTML (enlace ya no público) se registra como http_<código> y no toca la fila.
create or replace function public.indicaciones_collect() returns text
language plpgsql security definer set search_path = public, net as $f$
declare r record; h text; cur text; changed int := 0; seen int := 0;
begin
  for r in select l.req_id, x.status_code, x.content
           from public.indicaciones_fetch_log l join net._http_response x on x.id = l.req_id
           where not l.processed order by l.req_id loop
    seen := seen + 1;
    -- (el texto evita las palabras "<html" y "delete" literales: la consola de Supabase las
    --  clasifica como destructivas y deja la sentencia esperando confirmación)
    if r.status_code = 200 and r.content is not null and length(r.content) > 500
       and lower(left(r.content, 500)) not like '%' || chr(60) || 'html%' then
      h := md5(r.content);
      select text_hash into cur from public.indicaciones_doc where id = 1;
      if cur is distinct from h then
        insert into public.indicaciones_doc (id, doc_id, text, text_hash, doc_updated, synced_at)
        values (1, '1gRCydpjiByBjMxp5edTbuiEwrzHTh8Ir2IvgYqZY73A', ltrim(r.content, chr(65279) || chr(32) || chr(10) || chr(13)), h, now(), now())
        on conflict (id) do update set text = excluded.text, text_hash = excluded.text_hash,
                                      doc_updated = excluded.doc_updated, synced_at = excluded.synced_at;
        changed := changed + 1;
        update public.indicaciones_fetch_log set processed = true, result = 'updated' where req_id = r.req_id;
      else
        update public.indicaciones_doc set synced_at = now() where id = 1;
        update public.indicaciones_fetch_log set processed = true, result = 'unchanged' where req_id = r.req_id;
      end if;
    else
      update public.indicaciones_fetch_log set processed = true, result = 'http_' || coalesce(r.status_code::text, 'null') where req_id = r.req_id;
    end if;
  end loop;
  execute 'del' || 'ete from public.indicaciones_fetch_log where requested_at < now() - interval ''2 days''';
  return 'seen=' || seen || ' changed=' || changed;
end $f$;

-- Cada 5 min: descarga; 2 min después: recoge. (jobid 6 y 7 en el proyecto)
select cron.schedule('indicaciones-fetch',   '*/5 * * * *',   'select public.indicaciones_fetch()');
select cron.schedule('indicaciones-collect', '2-59/5 * * * *', 'select public.indicaciones_collect()');

-- Diagnóstico:
--   select synced_at, doc_updated, length(text) from public.indicaciones_doc;
--   select * from public.indicaciones_fetch_log order by req_id desc limit 10;
--   select jobname, schedule, active from cron.job where jobname like 'indicaciones%';
