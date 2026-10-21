-- ═══ N4 · Reescrituras sin cambios: ni UPDATE, ni Realtime, ni bitácora (20 oct 2026, P1-03 de la revisión) ═══════
-- Por qué: en la bitácora de 72 h el 77 % de todo lo que se escribe son reescrituras de labs que no traen nada nuevo
-- (una PC con Windows: 327 en 5 min). Cada una es un UPDATE completo: evento Realtime con la nota entera a cada iPad
-- (y su toast), fila en audit_log (pl_audit compara lab_history entero y synced_at cambia), copia en respaldo_hora
-- (el ~70 % de su volumen) y, con REPLICA IDENTITY FULL (N6), el doble de WAL. Lo mismo, en menor escala, con
-- cualquier guardado idéntico a lo que ya está.
-- (a) notes_sin_cambios_labs (BEFORE UPDATE OF lab_history; corre DESPUÉS de notes_preserve_lab_history, N3, por
--     orden alfabético): si la lista nueva, normalizada, es igual a la guardada → NEW.lab_history := OLD.lab_history.
--     Normalizar = ordenar por fecha (y por el texto de la entrada si se repite la fecha), quitar synced_at, scraped_at
--     y client_updated_at de cada entrada (las pone el propio sync o el reloj del equipo: no son datos clínicos) y
--     las llaves en cualquier orden (jsonb ya las compara así). _tomaTs NO se quita: es la hora de la toma del
--     reporte (dato), no la del sync. Así la base conserva el orden y las marcas de hora que ya tenía.
-- (b) pl_zz_sin_cambios (BEFORE UPDATE; el último pl_*, antes de trg_notes_updated): si NEW es igual a OLD en todas
--     las columnas salvo updated_at y updated_by → return NULL: la fila no se toca, no hay evento Realtime, ni
--     pl_audit (AFTER), ni pl_cronologia_guardar_copia, ni cambia updated_at (respaldo_hora no la vuelve a copiar).
--     PERO si un trigger de protección cambió NEW respecto a lo que mandó el cliente (pl_by_monotono N1,
--     pl_checklist_sin_perdidas, pl_entrega_protegida N2, notes_preserve_lab_history N3, pl_restaurada_protegida
--     N5), esos marcan set_config('pl.modificado','on',true) y aquí NO se suprime: el equipo que mandó la copia vieja
--     recibe la fila buena (respuesta y Realtime) en vez de quedarse con la suya. La marca se limpia en cada fila
--     (es local a la transacción; sin limpiarla, la siguiente reescritura idéntica ya no se suprimiría).
--     notes_sin_cambios_labs NO marca: es normalización, no protección.
--     Con set_config('pl.entrega_libre','on',true) (mantenimiento por SQL) tampoco se suprime: el «touch»
--     update notes set updated_at = now() where … vuelve a dar UPDATE 1 (20 oct 2026, M1 de la revisión de operación).
-- (c) pl_checklist_sin_perdidas: igual a producción (md5(prosrc) deed7c8c437a4e13404444993ef0eb50) + la marca cuando
--     repone llaves o el checklist completo. (Las marcas de N1, N2 y N3 ya vienen en sus archivos.)
-- La app y la respuesta vacía (verificado en main 1ba7520 = scratchpad/main-ro/index.html, y en los worktrees
-- guardia y guardia-carga): la app guarda notes SIEMPRE con _sUpsert (POST /rest/v1/notes?on_conflict=patient_id,
-- Prefer resolution=merge-duplicates,return=representation; index.html:10595-10604) y nunca con PATCH. Un upsert
-- cuyo UPDATE se suprime devuelve 201 con [] (probado en Postgres: «INSERT 0 0», RETURNING sin filas).
-- supaUpsertNote (11823-11831): «if (Array.isArray(data)) return data.length > 0 ? data[0] : true;» → [] es éxito;
-- los rescates FK (11860-11862, 11879-11882) igual. Los que llaman (12404-12408 guardado, 12668-12669 lote,
-- 13844-13853 cola) solo piden «res !== null && res !== undefined»: no reintentan ni encolan. _sPatch (10605-10614)
-- devolvería undefined con [], pero solo se usa para app_users, patients, no_olvidar y procedimientos_dia, no para
-- notes. En patients ya existe patients_suppress_redundant_updates con el mismo efecto.
-- Requisito: N1, N2 y N3 aplicados (sus funciones ya marcan pl.modificado); el bloque de abajo lo verifica.
-- Se puede volver a correr (create or replace / drop trigger if exists).
-- Reversa: drop trigger if exists pl_zz_sin_cambios on public.notes; drop trigger if exists notes_sin_cambios_labs on public.notes;
--          drop function if exists public.pl_zz_sin_cambios(); drop function if exists public.notes_sin_cambios_labs();
--          drop function if exists public.pl_labs_normalizados(jsonb);
--          (la marca en pl_checklist_sin_perdidas no hace nada sin pl_zz_sin_cambios; se puede dejar.)

do $$
declare falta text;
begin
  select string_agg(f, ', ') into falta
    from unnest(array['pl_by_monotono()', 'pl_entrega_protegida()', 'notes_preserve_lab_history()']) f
   where not exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.' || f) and p.prosrc like '%pl.modificado%');
  if falta is not null then
    raise exception 'N4 requiere N1, N2 y N3 aplicados: falta la marca pl.modificado en %', falta;
  end if;
end $$;

-- (c) Ningún guardado puede desaparecer una caja del checklist (igual que producción) + marca para pl_zz_sin_cambios.
create or replace function public.pl_checklist_sin_perdidas() returns trigger
language plpgsql as $fn$
declare k text; faltan jsonb := '{}'::jsonb;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if jsonb_typeof(old.checklist) <> 'object' then return new; end if;
  if new.checklist is null or jsonb_typeof(new.checklist) <> 'object' then
    if new.checklist is distinct from old.checklist then perform set_config('pl.modificado', 'on', true); end if;   -- N4
    new.checklist := old.checklist;
    return new;
  end if;
  for k in select jsonb_object_keys(old.checklist) loop
    if not (new.checklist ? k) then faltan := faltan || jsonb_build_object(k, old.checklist -> k); end if;
  end loop;
  if faltan <> '{}'::jsonb then
    new.checklist := new.checklist || faltan;
    perform set_config('pl.modificado', 'on', true);   -- N4
  end if;
  return new;
end $fn$;

-- (a) Labs: la misma lista (otro orden, otras marcas de hora del sync) no es un cambio.
create or replace function public.pl_labs_normalizados(h jsonb) returns jsonb
language sql immutable set search_path = public as $fn$
  select case when jsonb_typeof(h) is distinct from 'array' then h else
    coalesce((select jsonb_agg(x order by x ->> 'fecha', x::text)
                from (select case when jsonb_typeof(e) = 'object'
                                  then e - 'synced_at'::text - 'scraped_at'::text - 'client_updated_at'::text
                                  else e end as x
                        from jsonb_array_elements(h) e) s), '[]'::jsonb) end
$fn$;

create or replace function public.notes_sin_cambios_labs() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if new.lab_history is not distinct from old.lab_history then return new; end if;
  if public.pl_labs_normalizados(new.lab_history) is not distinct from public.pl_labs_normalizados(old.lab_history) then
    new.lab_history := old.lab_history;   -- solo cambiaron el orden o las marcas de hora del sync: queda lo guardado
  end if;
  return new;
end $fn$;
revoke all on function public.notes_sin_cambios_labs() from public, anon, authenticated;

drop trigger if exists notes_sin_cambios_labs on public.notes;
create trigger notes_sin_cambios_labs before update of lab_history on public.notes
  for each row execute function public.notes_sin_cambios_labs();

-- (b) El último BEFORE UPDATE de los pl_*: si no cambia nada (salvo updated_at/updated_by), no hay UPDATE.
create or replace function public.pl_zz_sin_cambios() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if coalesce(current_setting('pl.modificado', true), '') = 'on' then
    perform set_config('pl.modificado', '', true);   -- una protección cambió NEW: este UPDATE va; la marca se limpia
    return new;
  end if;
  -- 20 oct 2026 (M1 de la revisión de operación): con el permiso de mantenimiento no se suprime nada, como en los demás
  -- triggers de notes. Un «touch» por SQL (update … set updated_at = now()) sirve para que respaldo_hora vuelva a copiar
  -- la nota o Realtime la reenvíe; sin esto daba UPDATE 0 sin aviso. Va DESPUÉS de limpiar la marca, para que nunca se
  -- quede encendida. Los procesos de la base que usan el permiso (restore_note_from_archive, pl_guardia_a_cronologia)
  -- siempre cambian algo, así que para ellos no cambia nada.
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return new; end if;
  if (to_jsonb(new) - 'updated_at'::text - 'updated_by'::text) = (to_jsonb(old) - 'updated_at'::text - 'updated_by'::text) then
    return null;   -- nada nuevo: sin UPDATE, sin Realtime, sin bitácora, sin updated_at nuevo
  end if;
  return new;
end $fn$;
revoke all on function public.pl_zz_sin_cambios() from public, anon, authenticated;

drop trigger if exists pl_zz_sin_cambios on public.notes;
create trigger pl_zz_sin_cambios before update on public.notes
  for each row execute function public.pl_zz_sin_cambios();
