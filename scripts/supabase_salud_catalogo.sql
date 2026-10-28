-- 27 oct 2026 · aplicado en producción (migraciones pl_salud_catalogo, pl_salud_catalogo_v2 y, el 28 oct,
-- pl_salud_catalogo_v3 con el trigger pl_entrega_sin_auto_insert).
-- Chequeo diario, solo de lectura, de que siguen puestas las protecciones de la base: los triggers que guardan notas y
-- pacientes (archivar antes de borrar, restaurar nota, Cronología protegida, bitácora…), RLS en todas las tablas de
-- public, la política «solo cuentas activas» y los trabajos de pg_cron. Lo llama el vigilante (scripts/vigilante.py,
-- labs-watchdog.yml, con la llave de servicio) y queda en ROJO si falta algo. Ningún revisor lo detectaba antes: una
-- protección borrada por error (o una tabla nueva sin RLS) solo se notaba cuando ya había pasado algo.
-- Probado: con un trigger apagado y una tabla sin RLS (dentro de una transacción revertida) devuelve ok=false y los nombra.
-- Si se agrega o quita una protección a propósito, actualizar las listas de abajo.
create or replace function public.pl_salud_catalogo()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  triggers constant text[] := array[
    'notes.notes_archive_before_delete', 'notes.notes_preserve_lab_history', 'notes.notes_sin_cambios_labs',
    'notes.pl_audit_notes', 'notes.pl_borrado_masivo', 'notes.pl_by_monotono', 'notes.pl_checklist_sin_perdidas',
    'notes.pl_cronologia_guardar_copia', 'notes.pl_cronologia_reponer', 'notes.pl_entrega_protegida',
    'notes.pl_restaurada_protegida', 'notes.pl_zz_sin_cambios', 'notes.trg_notes_updated', 'notes.pl_entrega_sin_auto_insert',
    'patients.patients_archive_before_delete', 'patients.patients_restore_note_after_insert',
    'patients.patients_suppress_redundant_updates', 'patients.pl_audit_patients', 'patients.pl_borrado_masivo',
    'patients.trg_patients_updated', 'archive.pl_archive_eliminados', 'no_olvidar.pl_audit_no_olvidar',
    'no_olvidar.pl_borrados_otros', 'procedimientos_dia.pl_audit_procedimientos_dia',
    'procedimientos_dia.pl_borrados_otros', 'indicaciones_doc.pl_indicaciones_guard'];
  activas constant text[] := array['patients', 'notes', 'archive', 'config', 'guard_info', 'imagen_entries',
    'indicaciones_doc', 'lab_entries', 'no_olvidar', 'procedimientos_dia', 'ris_estudios', 'sync_log',
    'winlab_dispatch_log', 'winlab_labs', 'winlab_match', 'winlab_reports'];
  crons constant text[] := array['alarma-perdidas', 'audit-log-purge', 'indicaciones-collect', 'indicaciones-fetch',
    'respaldo-cada-hora', 'ris-scrape-cada-2h', 'sync-log-purge', 'tamano-base-log', 'winlab-dispatch-collect',
    'winlab-scrape-0407-leon', 'winlab-scrape-1315-leon', 'winlab-scrape-2007-leon'];
  faltan text[] := '{}';
  x text; n int := 0;
begin
  foreach x in array triggers loop
    n := n + 1;
    if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace s on s.oid = c.relnamespace
                    where s.nspname = 'public' and c.relname = split_part(x, '.', 1) and t.tgname = split_part(x, '.', 2)
                      and t.tgenabled <> 'D') then
      faltan := faltan || ('trigger ' || x);
    end if;
  end loop;
  -- Toda tabla de public con RLS encendido (una sin RLS queda abierta a cualquier sesión).
  for x in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
            where s.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity loop
    faltan := faltan || ('RLS apagado en ' || x);
  end loop;
  n := n + 1;
  foreach x in array activas loop
    n := n + 1;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = x and policyname = 'pl_solo_cuentas_activas') then
      faltan := faltan || ('política pl_solo_cuentas_activas en ' || x);
    end if;
  end loop;
  foreach x in array crons loop
    n := n + 1;
    if not exists (select 1 from cron.job where jobname = x and active) then
      faltan := faltan || ('pg_cron ' || x);
    end if;
  end loop;
  -- Canales en vivo privados (hallazgo 78) y cuentas que no pueden cambiarse el rol ni el estado (27 oct 2026).
  foreach x in array array['pl_realtime_leer', 'pl_realtime_enviar'] loop
    n := n + 1;
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = x) then
      faltan := faltan || ('política ' || x || ' en realtime.messages');
    end if;
  end loop;
  foreach x in array array['role', 'status', 'email'] loop
    n := n + 1;
    if has_column_privilege('authenticated', 'public.app_users', x, 'UPDATE') then
      faltan := faltan || ('authenticated puede cambiar app_users.' || x);
    end if;
  end loop;
  return jsonb_build_object('ok', cardinality(faltan) = 0, 'faltan', to_jsonb(faltan), 'revisados', n);
end
$fn$;
revoke all on function public.pl_salud_catalogo() from public, anon, authenticated;
grant execute on function public.pl_salud_catalogo() to service_role;
