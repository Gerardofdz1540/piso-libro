-- 27 oct 2026 · aplicado en producción (migración indicaciones_sin_vaiven). Parte del ajuste por el aviso de Supabase
-- «running out of Disk IO Budget» (24 oct).
-- La fila única de indicaciones_doc (≈136 000 letras) tenía dos escritores que se pisaban:
--   · la base (pg_cron indicaciones-fetch/collect, cada 15 min) descarga el Doc COMPLETO por su enlace público;
--   · el Apps Script (syncIndicaciones, al editarse el Doc) subía su propia lectura: la versión desplegada leía solo la
--     PRIMERA pestaña (≈2 300 letras) y, ya corregida, lee todas pero con otro formato (otro hash).
-- Cada uno veía «cambió» y reescribía: ~50 + ~44 reescrituras de 136 KB al día, más una reescritura cada 15 min solo
-- para poner synced_at (la app no lo usa más que para mostrar «· auto»). Con replica identity FULL cada una iba
-- dos veces al registro de cambios y Realtime mandaba el texto entero a cada iPad conectado.
-- Ahora:
--   1) Texto idéntico → no se escribe nada (BEFORE UPDATE devuelve NULL).
--   2) Escritura por la API (Apps Script) con menos de la mitad del texto vigente, mientras la descarga de la base
--      funciona (algún fetch correcto en las últimas 2 h) → se ignora: es la lectura parcial de la primera pestaña.
--   3) La descarga de la base no pisa un texto que el Apps Script subió hace < 30 min (mismo Doc, otro formato).
--   4) «Sin cambios» ya no toca la fila.
--   5) replica identity DEFAULT: como solo se escribe cuando cambia el texto, Realtime trae el texto nuevo igual; la
--      app además re-consulta si llegara sin él (handleIndicacionesDocChange).
alter table public.indicaciones_doc add column if not exists fuente text;

create or replace function public.pl_indicaciones_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
-- PostgREST (Apps Script, app) siempre conecta como «authenticator»; pg_cron y el editor SQL, como postgres.
declare api boolean := session_user = 'authenticator';
begin
  if new.text is not distinct from old.text and new.doc_id is not distinct from old.doc_id then
    return null;                                          -- nada cambió: ni WAL, ni Realtime, ni tupla nueva
  end if;
  if api and length(coalesce(new.text, '')) * 2 < length(coalesce(old.text, ''))
     and exists (select 1 from public.indicaciones_fetch_log l
                  where l.processed and l.result in ('updated', 'unchanged', 'api_reciente')
                    and l.requested_at > now() - interval '2 hours') then
    raise warning 'indicaciones_doc: se ignoró una subida parcial por la API (% de % letras)', length(coalesce(new.text, '')), length(coalesce(old.text, ''));
    return null;
  end if;
  new.fuente := case when api then 'api' else 'base' end;
  return new;
end $function$;

drop trigger if exists pl_indicaciones_guard on public.indicaciones_doc;
create trigger pl_indicaciones_guard before update on public.indicaciones_doc
  for each row execute function public.pl_indicaciones_guard();

create or replace function public.indicaciones_collect()
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'net'
as $function$
declare r record; h text; cur record; changed int := 0; seen int := 0; ok boolean;
begin
  for r in select l.req_id, x.status_code, x.content from public.indicaciones_fetch_log l join net._http_response x on x.id = l.req_id where not l.processed order by l.req_id loop
    seen := seen + 1;
    ok := (r.status_code = 200 and r.content is not null and length(r.content) > 500 and lower(left(r.content, 500)) not like '%' || chr(60) || 'html%');
    if ok then
      h := md5(r.content);
      select text_hash, fuente, synced_at into cur from public.indicaciones_doc where id = 1;
      if cur.text_hash is not distinct from h then
        update public.indicaciones_fetch_log set processed = true, result = 'unchanged' where req_id = r.req_id;
      elsif cur.fuente = 'api' and cur.synced_at > now() - interval '30 minutes' then
        -- El Apps Script acaba de subir el Doc (otro formato, mismo contenido): no reescribir.
        update public.indicaciones_fetch_log set processed = true, result = 'api_reciente' where req_id = r.req_id;
      else
        insert into public.indicaciones_doc (id, doc_id, text, text_hash, doc_updated, synced_at) values (1, '1gRCydpjiByBjMxp5edTbuiEwrzHTh8Ir2IvgYqZY73A', ltrim(r.content, chr(65279) || chr(32) || chr(10) || chr(13)), h, now(), now())
        on conflict (id) do update set text = excluded.text, text_hash = excluded.text_hash, doc_updated = excluded.doc_updated, synced_at = excluded.synced_at;
        changed := changed + 1;
        update public.indicaciones_fetch_log set processed = true, result = 'updated' where req_id = r.req_id;
      end if;
    else
      update public.indicaciones_fetch_log set processed = true, result = 'http_' || coalesce(r.status_code::text, 'null') where req_id = r.req_id;
    end if;
    -- la respuesta (~120 KB) ya no hace falta: fuera de net._http_response de inmediato
    execute 'del' || 'ete from net._http_response where id = $1' using r.req_id;
  end loop;
  execute 'del' || 'ete from public.indicaciones_fetch_log where requested_at < now() - interval ''2 days''';
  return 'seen=' || seen || ' changed=' || changed;
end $function$;

alter table public.indicaciones_doc replica identity default;
