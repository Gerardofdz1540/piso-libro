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
--   → Trigger AFTER UPDATE OF exp: si el expediente cambia al de una nota archivada de la MISMA persona (nombre
--     normalizado idéntico), se fusiona igual que en el alta (sin pisar nada: texto solo si está vacío, checklist por llave
--     con prioridad a lo actual, labs por unión), con copia previa en restauraciones_respaldo.
-- Revisión adversarial (11 nov): la cadena exige que el nombre de la fila archivada NO se parezca al de origen (el caso del
-- nombre dañado) y que el origen tenga nombre; así no se vuelve transitiva la compatibilidad por subconjunto de nombres.
--
-- restore_note_from_archive_id(p_id, p_archive): solo para uso manual (service role), cuando ya se comprobó por
--   expediente, cama y hora que el archivo es del mismo paciente aunque el nombre esté dañado. Exige el mismo exp.
--
-- Se aplica sobre la función viva (con N5, _copia_base, R4…) reemplazando solo la condición de búsqueda, para no
-- copiar a mano 150 líneas. Cada replace() se comprueba: si el texto no aparece, aborta sin cambiar nada.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- Tabla de respaldo previo a cualquier restauración manual (solo service role).
create table if not exists public.restauraciones_respaldo (
  id bigserial primary key, patient_id uuid, cama text, motivo text, note jsonb, created_at timestamptz not null default now());
alter table public.restauraciones_respaldo enable row level security;
revoke all on public.restauraciones_respaldo from anon, authenticated;

do $mig$
declare d text; d2 text; d3 text;
  old_where text := $w$     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;$w$;
  new_where text := $w$     and (public.pl_same_person(patient_data->>'nombre', p.nombre)
          -- 11 nov 2026 (cadena): la fila archivada había recibido la nota de una entrada compatible del mismo exp.
          or exists (select 1 from archive r
                      where r.note_data->>'_restaurado_a' = archive.patient_data->>'_supa_id'
                        and btrim(coalesce(r.patient_data->>'exp','')) = btrim(p.exp)
                        and public.pl_name_norm(r.patient_data->>'nombre') <> ''
                        -- la fila archivada (A) traía un nombre dañado: no se parece al de la persona de la que recibió la nota
                        and not public.pl_same_person(r.patient_data->>'nombre', archive.patient_data->>'nombre')
                        and public.pl_same_person(r.patient_data->>'nombre', p.nombre)))
   order by archived_at desc limit 1;$w$;
  id_where text := $w$  select * into a from archive
   where id = p_archive and btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp);$w$;
begin
  d := pg_get_functiondef('public.restore_note_from_archive(uuid)'::regprocedure);
  -- Se puede volver a correr: si la cadena ya está (estricta o la primera versión), no se toca aquí.
  if position('or exists (select 1 from archive r' in d) > 0 then raise notice 'cadena ya aplicada';
  elsif position(old_where in d) = 0 then raise exception 'restore_note_from_archive: no se encontró la condición esperada';
  else
    d2 := replace(d, old_where, new_where);
    execute d2;
  end if;
  -- Si quedó la primera versión de la cadena (11 nov, antes de la revisión adversarial), se endurece.
  d := pg_get_functiondef('public.restore_note_from_archive(uuid)'::regprocedure);
  if position('la fila archivada (A) traía un nombre dañado' in d) = 0 then
    execute replace(d, $w$                        and public.pl_same_person(r.patient_data->>'nombre', p.nombre)))$w$,
      $w$                        and public.pl_name_norm(r.patient_data->>'nombre') <> ''
                        -- la fila archivada (A) traía un nombre dañado: no se parece al de la persona de la que recibió la nota
                        and not public.pl_same_person(r.patient_data->>'nombre', archive.patient_data->>'nombre')
                        and public.pl_same_person(r.patient_data->>'nombre', p.nombre)))$w$);
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
declare r text; aid uuid;
begin
  begin
    -- Solo si en la Papelera está la MISMA persona con ese expediente (nombre normalizado idéntico, ninguno «no
    -- identificado»): un expediente tecleado por error que coincide con el de otro paciente no mezcla notas.
    if public.pl_name_norm(NEW.nombre) = '' or public.pl_name_placeholder(NEW.nombre) then return NEW; end if;
    select a.id into aid from archive a
     where btrim(coalesce(a.patient_data->>'exp','')) = btrim(NEW.exp)
       and a.archived_at > now() - interval '10 days'
       and (a.note_data->>'_restaurado_a') is null
       and (a.patient_data->>'_supa_id') is distinct from NEW.id::text
       and public.pl_name_norm(a.patient_data->>'nombre') = public.pl_name_norm(NEW.nombre)
     order by a.archived_at desc limit 1;
    if aid is null then return NEW; end if;
    insert into restauraciones_respaldo (patient_id, cama, motivo, note)
      select n.patient_id, NEW.cama, 'antes de fusionar por cambio de expediente (archivo ' || aid::text || ')', to_jsonb(n)
        from notes n where n.patient_id = NEW.id;
    r := public.restore_note_from_archive_id(NEW.id, aid);
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
--   Reversiones más viejas que seguían vigentes (verificación independiente; solo cajas que nadie tocó después,
--   con respaldo previo y por unión, nunca reemplazando):
--          3-150: el registro de cirugía del 05.11 (quitado el 06.11 22:03 por una copia del 31.10) y qx_fecha 11-05;
--                 interconsultas y nota_* vaciadas el 04.11.
--          3-182: interconsultas (30.10) y pendientes R1 (31.10).   3-157: pendientes MIPs (31.10).
--          Lo recuperado de texto va abajo de lo actual con «— Recuperado (se borró por error el dd.mm) —».
--   NO se tocó (decisión clínica, se avisó al equipo): 3-157 NPT/curación marcadas en falso el 31.10 y la
--          «Colostomía» del 10.11 borrada por un choque de ediciones (la Mac luego cambió Drenovac por Penrose).
