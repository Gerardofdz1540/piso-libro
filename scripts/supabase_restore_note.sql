-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Red de seguridad contra pérdida de notas (aplicado 13 oct 2026 en vkxplmrzyqlamxpbtmes)
--
-- Caso real: el sync de la hoja (Apps Script) corre en cada tecla; al cortar/pegar una fila para
-- cambiar de cama la hoja pasa por un instante sin el paciente → se archivaba y borraba (CASCADE a
-- notes: labs, pendientes, checklist, diagrama) y 3 s después el pegado lo creaba como fila NUEVA y
-- VACÍA (UCI 7 → 3-162, 3-180 → 3-161, 3-153 cortada y repegada). Cualquier cliente que haga
-- "borrar + crear" (import de la app, borrado manual) producía lo mismo.
--
-- Solución en BD (independiente del cliente): al INSERTAR un paciente, si en public.archive hay una
-- entrada de la misma persona (mismo exp y nombre compatible) archivada hace <= 10 días y aún no
-- restaurada, su nota se vuelca sobre la fila nueva SIN pisar contenido existente (texto solo si
-- está vacío, checklist por llave con prioridad a lo existente, lab_history unión por fecha).
-- La entrada del archivo queda marcada con _restaurado_a / _restaurado_en.
--
-- Uso manual (backfill): select cama, public.restore_note_from_archive(id) from patients;
--   → 'restaurado:<archive id>' | 'sin-archivo' | 'archivo-vacio' | 'sin-exp'
-- ═══════════════════════════════════════════════════════════════════════════════════════

create or replace function public.pl_name_norm(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(upper(translate(coalesce(t,''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNAEIOUUN')), '[^A-Z0-9 ]+', ' ', 'g'))
$$;

-- Misma persona: nombres iguales normalizados, o todos los tokens del nombre más corto (>= 2)
-- presentes en el otro. Sin nombre en alguno de los dos → true (ya coincide el expediente).
create or replace function public.pl_same_person(a text, b text) returns boolean
language plpgsql immutable as $$
declare na text := public.pl_name_norm(a); nb text := public.pl_name_norm(b); ta text[]; tb text[]; sh text[]; lo text[]; t text;
begin
  if na = '' or nb = '' then return true; end if;
  if na = nb then return true; end if;
  ta := regexp_split_to_array(na, '\s+'); tb := regexp_split_to_array(nb, '\s+');
  if array_length(ta,1) <= array_length(tb,1) then sh := ta; lo := tb; else sh := tb; lo := ta; end if;
  if array_length(sh,1) < 2 then return false; end if;
  foreach t in array sh loop
    if not (t = any(lo)) then return false; end if;
  end loop;
  return true;
end $$;

create or replace function public.restore_note_from_archive(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare p patients%rowtype; a archive%rowtype; nd jsonb; n notes%rowtype; has_content boolean; merged_lh jsonb;
begin
  select * into p from patients where id = p_id;
  if not found or nullif(btrim(coalesce(p.exp,'')),'') is null then return 'sin-exp'; end if;
  select * into a from archive
   where btrim(coalesce(patient_data->>'exp','')) = btrim(p.exp)
     and archived_at > now() - interval '10 days'
     and (note_data->>'_restaurado_a') is null
     and (patient_data->>'_supa_id') is distinct from p_id::text
     and public.pl_same_person(patient_data->>'nombre', p.nombre)
   order by archived_at desc limit 1;
  if not found then return 'sin-archivo'; end if;
  nd := coalesce(a.note_data, '{}'::jsonb);
  has_content := jsonb_array_length(coalesce(nd->'labHistory','[]'::jsonb)) > 0
              or jsonb_array_length(coalesce(nd->'imagenHistory','[]'::jsonb)) > 0
              or coalesce(nd->>'pendientes','') <> '' or coalesce(nd->>'app','') <> '' or coalesce(nd->>'pa','') <> ''
              or coalesce(nd->>'qx','') <> '' or coalesce(nd->>'manejo','') <> '' or coalesce(nd->>'drenajes','') <> ''
              or coalesce(nd->>'balance','') <> '' or coalesce(nd->>'sv','') <> '' or coalesce(nd->>'sangrado','') <> ''
              or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
  if not has_content then return 'archivo-vacio'; end if;
  select * into n from notes where patient_id = p_id;
  if not found then
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, updated_by)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), 'db-restore');
  else
    select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
      select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
      union all
      select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
       where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
    ) s;
    update notes set
      app = case when coalesce(n.app,'') = '' then coalesce(nd->>'app','') else n.app end,
      pa = case when coalesce(n.pa,'') = '' then coalesce(nd->>'pa','') else n.pa end,
      drenajes = case when coalesce(n.drenajes,'') = '' then coalesce(nd->>'drenajes','') else n.drenajes end,
      qx = case when coalesce(n.qx,'') = '' then coalesce(nd->>'qx','') else n.qx end,
      manejo = case when coalesce(n.manejo,'') = '' then coalesce(nd->>'manejo','') else n.manejo end,
      sangrado = case when coalesce(n.sangrado,'') = '' then coalesce(nd->>'sangrado','') else n.sangrado end,
      sv = case when coalesce(n.sv,'') = '' then coalesce(nd->>'sv','') else n.sv end,
      balance = case when coalesce(n.balance,'') = '' then coalesce(nd->>'balance','') else n.balance end,
      pendientes = case when coalesce(n.pendientes,'') = '' then coalesce(nd->>'pendientes','') else n.pendientes end,
      misc = case when coalesce(n.misc,'') = '' then coalesce(nd->>'misc','') else n.misc end,
      checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
      lab_history = merged_lh,
      imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
      updated_by = 'db-restore'
    where patient_id = p_id;
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $$;

create or replace function public.patients_restore_note_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  begin
    r := public.restore_note_from_archive(NEW.id);
    if r like 'restaurado:%' then raise notice 'nota restaurada para % (%): %', NEW.cama, NEW.exp, r; end if;
  exception when others then
    raise warning 'patients_restore_note_after_insert: % (se permite el insert)', sqlerrm;
  end;
  return NEW;
end $$;

create or replace trigger patients_restore_note_after_insert
  after insert on public.patients
  for each row execute function public.patients_restore_note_after_insert();

revoke all on function public.restore_note_from_archive(uuid) from public, anon, authenticated;

-- Backfill del 13 oct 2026 (select cama, restore_note_from_archive(id) from patients):
--   restauradas 3-151, 3-153, 3-162 (desde UCI 7), 3-177, 3-181, UCI 8; el resto sin archivo reciente.
