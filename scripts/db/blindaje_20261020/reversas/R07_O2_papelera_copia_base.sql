-- ═══ R07_O2_papelera_copia_base · reversa de O2 (otros/02_papelera_copia_base.sql) (20 oct 2026) ═══════════════════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py (las definiciones de producción salen de fuentes/funciones_prod.sql,
-- md5 idéntico a producción). Por qué: volver atrás O2 en un minuto, sin borrar datos, aunque los otros pasos
-- sigan instalados. archive_before_delete vuelve a la de producción y se quita el registro de lo que se borra de la Papelera
-- (la tabla archive_eliminados y lo que tenga se quedan: borrarla es R99). restore_note_from_archive: con N5
-- instalado se queda la unida (su parte de _copia_base no hace nada sin el archive_before_delete de O2); sin N5,
-- la de producción. pl_quien() se borra solo si O3 ya no la usa.
-- Se puede volver a correr. Al final, un SELECT dice si la reversa quedó (ok = true) y V07 pasa a dar ok = false.

-- 20 oct 2026 (revisión de operación): drop trigger / alter table toman ACCESS EXCLUSIVE sobre la tabla. Sin
-- lock_timeout, un guardado largo haría esperar la reversa y los guardados de la app harían fila detrás de ella.
-- Si se agota (5 s), se vuelve a correr.
set lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.archive_before_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  pid uuid; p patients%rowtype; n notes%rowtype; who text; nd jsonb; pd jsonb;
begin
  if TG_TABLE_NAME = 'patients' then
    pid := OLD.id; p := OLD;
    select * into n from notes where patient_id = pid;
  else
    pid := OLD.patient_id; n := OLD;
    select * into p from patients where id = pid;
  end if;
  if pid is null then return OLD; end if;
  if exists (select 1 from archive a where a.patient_data->>'_supa_id' = pid::text and a.archived_at > now() - interval '5 minutes') then
    return OLD;
  end if;
  begin
    who := coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb->>'role', 'db');
  exception when others then who := 'db'; end;
  pd := jsonb_build_object(
    'cama', coalesce(p.cama, ''), 'nombre', coalesce(p.nombre, ''), 'exp', coalesce(p.exp, ''), 'dx', coalesce(p.dx, ''),
    'edad', coalesce(p.edad, ''), 'esp', coalesce(p.esp, ''), 'adscrito', coalesce(p.adscrito, ''), 'residente', coalesce(p.residente, ''),
    'ingreso', coalesce(p.ingreso::text, ''), 'estado', coalesce(p.estado, ''), 'seccion', coalesce(p.seccion, ''),
    'es_mio', coalesce(p.es_mio, true), '_supa_id', pid);
  nd := case when n.patient_id is null then '{}'::jsonb else jsonb_build_object(
    'app', coalesce(n.app, ''), 'pa', coalesce(n.pa, ''), 'drenajes', coalesce(n.drenajes, ''), 'qx', coalesce(n.qx, ''),
    'manejo', coalesce(n.manejo, ''), 'sangrado', coalesce(n.sangrado, ''), 'sv', coalesce(n.sv, ''), 'balance', coalesce(n.balance, ''),
    'pendientes', coalesce(n.pendientes, ''), 'checklist', coalesce(n.checklist, '{}'::jsonb), 'misc', coalesce(n.misc, ''),
    'labHistory', coalesce(n.lab_history, '[]'::jsonb), 'imagenHistory', coalesce(n.imagen_history, '[]'::jsonb),
    'cronologia', coalesce(n.cronologia, '')) end;
  nd := nd || jsonb_build_object('_egreso', 'BORRADO EN BD (' || who || ')',
                                 '_egresoFecha', to_char(now() at time zone 'America/Mexico_City', 'DD/MM/YYYY'));
  insert into archive (patient_data, note_data, archived_by) values (pd, nd, 'db-trigger:' || who);
  return OLD;
exception when others then
  raise warning 'archive_before_delete: % (se permite el borrado)', sqlerrm;
  return OLD;
end $function$
;
drop trigger if exists pl_archive_eliminados on public.archive;
drop function if exists public.pl_archive_eliminados();
do $r$
begin
  if to_regprocedure('public.pl_restaurada_protegida()') is null then   -- N5 ya no está: la de producción
    execute $q$CREATE OR REPLACE FUNCTION public.restore_note_from_archive(p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
              or coalesce(nd->>'cronologia','') <> ''
              or (jsonb_typeof(nd->'checklist') = 'object' and nd->'checklist' <> '{}'::jsonb);
  if not has_content then return 'archivo-vacio'; end if;
  select * into n from notes where patient_id = p_id;
  if not found then
    perform set_config('pl.entrega_libre', 'on', true);
    insert into notes (patient_id, app, pa, drenajes, qx, manejo, sangrado, sv, balance, pendientes, checklist, misc, lab_history, imagen_history, cronologia, updated_by)
    values (p_id, coalesce(nd->>'app',''), coalesce(nd->>'pa',''), coalesce(nd->>'drenajes',''), coalesce(nd->>'qx',''), coalesce(nd->>'manejo',''),
            coalesce(nd->>'sangrado',''), coalesce(nd->>'sv',''), coalesce(nd->>'balance',''), coalesce(nd->>'pendientes',''),
            case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end, coalesce(nd->>'misc',''),
            coalesce(nd->'labHistory','[]'::jsonb), coalesce(nd->'imagenHistory','[]'::jsonb), coalesce(nd->>'cronologia',''), 'db-restore');
    perform set_config('pl.entrega_libre', 'off', true);
  else
    select coalesce(jsonb_agg(e order by e->>'fecha' desc), '[]'::jsonb) into merged_lh from (
      select e from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) e
      union all
      select e from jsonb_array_elements(coalesce(nd->'labHistory','[]'::jsonb)) e
       where not exists (select 1 from jsonb_array_elements(coalesce(n.lab_history,'[]'::jsonb)) x where x->>'fecha' = e->>'fecha')
    ) s;
    -- La Cronología solo la escribe la base (20 oct 2026): para reponerla desde la Papelera hace falta el permiso
    -- de esta transacción; se apaga justo después. La Guardia actual gana (checklist actual || archivo).
    if coalesce(n.cronologia,'') = '' and coalesce(nd->>'cronologia','') <> '' then
      perform set_config('pl.entrega_libre', 'on', true);
    end if;
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
      cronologia = case when coalesce(n.cronologia,'') = '' then coalesce(nd->>'cronologia','') else n.cronologia end,
      checklist = (case when jsonb_typeof(nd->'checklist') = 'object' then nd->'checklist' else '{}'::jsonb end) || coalesce(n.checklist,'{}'::jsonb),
      lab_history = merged_lh,
      imagen_history = case when jsonb_array_length(coalesce(n.imagen_history,'[]'::jsonb)) = 0 then coalesce(nd->'imagenHistory','[]'::jsonb) else n.imagen_history end,
      updated_by = 'db-restore'
    where patient_id = p_id;
    perform set_config('pl.entrega_libre', 'off', true);
  end if;
  update archive set note_data = note_data || jsonb_build_object('_restaurado_a', p_id::text, '_restaurado_en', now()::text) where id = a.id;
  return 'restaurado:' || a.id::text;
end $function$$q$;
  end if;
  if to_regprocedure('public.pl_borrados_otros()') is null then drop function if exists public.pl_quien(); end if;
end $r$;
reset lock_timeout;

select 'R07_O2_papelera_copia_base · O2 revertido' as reversa,
       (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.archive_before_delete()')) = 'ddc902b91132962833a8ccac9776784f'
   and to_regprocedure('public.pl_archive_eliminados()') is null
   and not exists (select 1 from pg_trigger where tgrelid = 'public.archive'::regclass and tgname = 'pl_archive_eliminados')
   and (select md5(prosrc) from pg_proc where oid = 'public.restore_note_from_archive(uuid)'::regprocedure)
       = case when to_regprocedure('public.pl_restaurada_protegida()') is null then 'e43e448119a3e499e77e05092040359e' else '2be077c3c0effa5a572eb9601702b61f' end as ok;
