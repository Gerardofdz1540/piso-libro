-- 27 oct 2026 · aplicado en producción (migración indicaciones_sin_reenvio). Sigue a supabase_indicaciones_sin_vaiven.sql.
-- Con el Apps Script nuevo (lee TODAS las pestañas del Doc) el texto que sube y el que descarga la base traen el mismo
-- contenido (112 bloques, 75 camas) pero con otro formato (CRLF, viñetas), así que su hash nunca coincide. La regla
-- «la base no pisa lo que el Apps Script subió hace < 30 min» dejaba que, 30 min después de CADA edición del Doc, la
-- base reescribiera la fila (≈130 KB, Realtime a cada iPad) con su versión: dos escrituras por edición en vez de una.
-- Ahora la base recuerda el hash de cada descarga (indicaciones_fetch_log.export_hash) y sabe desde cuándo el Doc está
-- en esta versión (primera descarga con ese hash). Si el Apps Script subió el Doc DESPUÉS de ese momento (con 15 min de
-- margen, el intervalo de la descarga), su texto ya es esa versión: «api_vigente», no se escribe. Si el Doc cambió y
-- el Apps Script no lo subió en 30 min (se cayó, perdió permisos), la base lo sube como respaldo («updated»).
alter table public.indicaciones_fetch_log add column if not exists export_hash text;

create or replace function public.indicaciones_collect()
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'net'
as $function$
declare r record; h text; cur record; changed int := 0; seen int := 0; ok boolean; prev_diff timestamptz; desde timestamptz;
begin
  for r in select l.req_id, l.requested_at, x.status_code, x.content from public.indicaciones_fetch_log l join net._http_response x on x.id = l.req_id where not l.processed order by l.req_id loop
    seen := seen + 1;
    ok := (r.status_code = 200 and r.content is not null and length(r.content) > 500 and lower(left(r.content, 500)) not like '%' || chr(60) || 'html%');
    if ok then
      h := md5(r.content);
      update public.indicaciones_fetch_log set export_hash = h where req_id = r.req_id;
      select text_hash, fuente, synced_at into cur from public.indicaciones_doc where id = 1;
      if cur.text_hash is not distinct from h then
        update public.indicaciones_fetch_log set processed = true, result = 'unchanged' where req_id = r.req_id;
      else
        -- Desde cuándo el Doc está en esta versión: la primera descarga con este hash después de la última con otro.
        select max(requested_at) into prev_diff from public.indicaciones_fetch_log
         where export_hash is not null and export_hash <> h and requested_at < r.requested_at;
        select min(requested_at) into desde from public.indicaciones_fetch_log
         where export_hash = h and requested_at <= r.requested_at and (prev_diff is null or requested_at > prev_diff);
        desde := coalesce(desde, r.requested_at);
        if cur.fuente = 'api' and cur.synced_at >= desde - interval '15 minutes' then
          update public.indicaciones_fetch_log set processed = true, result = 'api_vigente' where req_id = r.req_id;
        elsif cur.fuente = 'api' and now() - desde < interval '30 minutes' then
          update public.indicaciones_fetch_log set processed = true, result = 'api_reciente' where req_id = r.req_id;
        else
          insert into public.indicaciones_doc (id, doc_id, text, text_hash, doc_updated, synced_at) values (1, '1gRCydpjiByBjMxp5edTbuiEwrzHTh8Ir2IvgYqZY73A', ltrim(r.content, chr(65279) || chr(32) || chr(10) || chr(13)), h, now(), now())
          on conflict (id) do update set text = excluded.text, text_hash = excluded.text_hash, doc_updated = excluded.doc_updated, synced_at = excluded.synced_at;
          changed := changed + 1;
          update public.indicaciones_fetch_log set processed = true, result = 'updated' where req_id = r.req_id;
        end if;
      end if;
    else
      update public.indicaciones_fetch_log set processed = true, result = 'http_' || coalesce(r.status_code::text, 'null') where req_id = r.req_id;
    end if;
    execute 'del' || 'ete from net._http_response where id = $1' using r.req_id;
  end loop;
  execute 'del' || 'ete from public.indicaciones_fetch_log where requested_at < now() - interval ''2 days''';
  return 'seen=' || seen || ' changed=' || changed;
end $function$;
