-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Restauración de notas: dos huecos encontrados en la revisión de integridad (11 nov 2026)
--
-- H2 (cama 3-168): la hoja puso en la columna NOMBRE un texto de diagnóstico. censo-sync lo vio como otra persona:
--   archivó al paciente y lo volvió a crear vacío. restore_note_from_archive no restauró porque el «nombre» nuevo no
--   coincide con el archivado (pl_same_person). Cuando alguien corrige el nombre en la hoja, la fila vuelve a
--   archivarse y crearse; sin la regla de abajo, la nota que se haya escrito mientras tanto (en la fila con el nombre
--   equivocado) no volvería, porque esa entrada del archivo lleva el nombre equivocado.
--   → Regla «cadena»: una entrada del archivo cuenta como la misma persona si la fila archivada (su _supa_id) había
--     recibido antes la nota de una entrada compatible (_restaurado_a = ese _supa_id), con el mismo expediente.
--
-- H3 (cama 3-175): el expediente se corrigió con UPDATE después del alta. restore_note_from_archive solo corre al
--   INSERTAR, así que la nota vieja (27 KB) no se fusionó.
--   → Trigger AFTER UPDATE OF exp: si el expediente cambia a uno con nota archivada compatible, se fusiona igual que en
--     el alta (sin pisar nada: texto solo si está vacío, checklist por llave con prioridad a lo actual, labs por unión).
--
-- restore_note_from_archive_id(p_id, p_archive): solo para uso manual (service role), cuando ya se comprobó por
--   expediente, cama y hora que el archivo es del mismo paciente aunque el nombre esté dañado. Exige el mismo exp.
--
-- Se aplica sobre la función viva (con N5, _copia_base, R4…) reemplazando solo la condición de búsqueda, para no
-- copiar a mano 150 líneas. Cada replace() se comprueba: si el texto no aparece, aborta sin cambiar nada.
-- ═══════════════════════════════════════════════════════════════════════════════════════

do $mig$
declare d text; d2 text; d3 text;
  old_where text := $w$     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;$w$;
  new_where text := $w$     and (public.pl_same_person(patient_data->>'nombre', p.nombre)
          -- 11 nov 2026 (cadena): la fila archivada había recibido la nota de una entrada compatible del mismo exp.
          or exists (select 1 from archive r
                      where r.note_data->>'_restaurado_a' = archive.patient_data->>'_supa_id'
                        and btrim(coalesce(r.patient_data->>'exp','')) = btrim(p.exp)
                        and public.pl_same_person(r.patient_data->>'nombre', p.nombre)))
   order by archived_at desc limit 1;$w$;
  id_where text := $w$  select * into a from archive
   where id = p_archive and btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp);$w$;
begin
  d := pg_get_functiondef('public.restore_note_from_archive(uuid)'::regprocedure);
  if position(old_where in d) = 0 then raise exception 'restore_note_from_archive: no se encontró la condición esperada'; end if;
  if position('or exists (select 1 from archive r' in d) > 0 then raise notice 'cadena ya aplicada'; else
    d2 := replace(d, old_where, new_where);
    execute d2;
  end if;
  -- Variante manual por id de archivo (sin la regla del nombre; mismo exp obligatorio).
  d3 := pg_get_functiondef('public.restore_note_from_archive(uuid)'::regprocedure);
  d3 := replace(d3, 'FUNCTION public.restore_note_from_archive(p_id uuid)', 'FUNCTION public.restore_note_from_archive_id(p_id uuid, p_archive uuid)');
  d3 := regexp_replace(d3, '  select \* into a from archive\n   where btrim.*?order by archived_at desc limit 1;', id_where, 's');
  if position('where id = p_archive' in d3) = 0 then raise exception 'restore_note_from_archive_id: no se pudo construir'; end if;
  execute d3;
end $mig$;

revoke all on function public.restore_note_from_archive(uuid) from public, anon, authenticated;
revoke all on function public.restore_note_from_archive_id(uuid, uuid) from public, anon, authenticated;

create or replace function public.patients_restore_note_after_exp_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := public.restore_note_from_archive(NEW.id);
    if r like 'restaurado:%' then raise notice 'nota fusionada tras cambio de exp para % (%): %', NEW.cama, NEW.exp, r; end if;
  exception when others then
    raise warning 'patients_restore_note_after_exp_update: % (se permite el update)', sqlerrm;
  end;
  return NEW;
end $$;
revoke all on function public.patients_restore_note_after_exp_update() from public, anon, authenticated;

create or replace trigger patients_restore_note_after_exp_update
  after update of exp on public.patients
  for each row
  when (nullif(btrim(coalesce(NEW.exp,'')),'') is not null and btrim(coalesce(OLD.exp,'')) is distinct from btrim(NEW.exp))
  execute function public.patients_restore_note_after_exp_update();

-- Tabla de respaldo previo a cualquier restauración manual (solo service role).
create table if not exists public.restauraciones_respaldo (
  id bigserial primary key, patient_id uuid, cama text, motivo text, note jsonb, created_at timestamptz not null default now());
alter table public.restauraciones_respaldo enable row level security;
revoke all on public.restauraciones_respaldo from anon, authenticated;

-- Aplicado 11 nov 2026:
--   3-175: respaldo id 1 → restore_note_from_archive → restaurado (APP, PA, manejo, checklist 105 llaves); los
--          pendientes archivados se agregaron abajo con el encabezado «— Recuperado de la nota anterior (10.11) —».
--   3-168: restore_note_from_archive_id con la entrada del 11-11 04:01 (mismo exp y cama, archivada 0.5 s antes del alta);
--          la copia duplicada de sheet-sync quedó marcada _restaurado_a (la cadena la reconoce cuando se corrija el nombre).
--          Falta: corregir en la hoja el NOMBRE de 3-168 (tiene un texto de diagnóstico).
--   H1 (copias viejas de una Mac/Chrome que pisaron el checklist el 8 nov a las 18:15Z y el 9 nov a las 05:03Z):
--          por cada nota que sigue viva se guardó respaldo (restauraciones_respaldo) y, desde audit_log.diff->checklist
--          (valor «de»), se repuso: pase de mañana (pm_*, solo si nadie lo tocó después) con pm_hist como UNIÓN por
--          fecha (máx. 14); y las cajas que seguían vacías (3-163: dispositivos, pendientes MIPs/R1, estas dos con el
--          prefijo «(recuperado del 08.11) »). Camas: 3-150, 3-163, 3-190 y la nota que hoy está en 3-182.
--          Las demás camas de esos eventos ya egresaron: su nota quedó en el archivo con lo que tenía al egresar.
