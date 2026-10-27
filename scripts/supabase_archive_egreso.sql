-- 27 oct 2026 · aplicado en producción (migración archive_egreso_tipo).
-- Motivo del egreso para investigación. Casi todos los egresos salen del censo de la hoja («RETIRADO DEL CENSO
-- (hoja)») sin decir si fue alta o defunción: el registro de pacientes no podía calcular mortalidad. Desde la Papelera
-- (o al dar de alta en la app) se registra el tipo: alta, defuncion, traslado o alta_voluntaria ('' lo borra).
-- Se guarda DENTRO de note_data (se une con ||: no pisa la nota ni la _copia_base que agregó la base) con quién y
-- cuándo. _egreso_tipo_ts (UTC, formato fijo) le dice al registro qué copias releer aunque sean viejas.
-- SECURITY INVOKER: corre con la sesión del usuario, así que aplican las políticas de archive (solo cuentas activas).
create or replace function public.archive_set_egreso(p_id uuid, p_tipo text, p_por text default '')
 returns text
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare n int; ts text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if p_tipo is null or p_tipo not in ('', 'alta', 'defuncion', 'traslado', 'alta_voluntaria') then
    raise exception 'tipo de egreso no válido';
  end if;
  update public.archive set note_data = case
      when p_tipo = '' then (coalesce(note_data, '{}'::jsonb) - '_egreso_tipo' - '_egreso_tipo_por') || jsonb_build_object('_egreso_tipo_ts', ts)
      else coalesce(note_data, '{}'::jsonb) || jsonb_build_object('_egreso_tipo', p_tipo, '_egreso_tipo_por', left(coalesce(p_por, ''), 80), '_egreso_tipo_ts', ts)
    end
  where id = p_id;
  get diagnostics n = row_count;
  return case when n = 1 then 'ok' else 'no-encontrado' end;
end $function$;
revoke all on function public.archive_set_egreso(uuid, text, text) from public, anon;
grant execute on function public.archive_set_egreso(uuid, text, text) to authenticated;
