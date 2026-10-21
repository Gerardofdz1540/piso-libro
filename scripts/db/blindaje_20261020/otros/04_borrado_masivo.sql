-- ═══ O4 · Borrado masivo solo para el administrador (20 oct 2026, P1-06) ═════════════════════════════════════════
-- Por qué: cualquier cuenta de la app puede, en UNA sola petición, borrar muchas filas de los pacientes, las notas o las
-- listas compartidas: «🔥 BORRAR TODO» (resetCensoTotal: patients/notes/no_olvidar/procedimientos_dia «id=not.is.null»),
-- «Eliminar todos los de la especialidad» (deleteByEsp: patients «esp=eq.…»), «Borrar hechos» de No olvidar
-- («done=eq.true», borra los de todos) y «Borrar todos los procedimientos del día» («fecha_dia=eq.hoy»). Un clic
-- equivocado, una cuenta comprometida o un equipo con una cola vieja se llevaba el censo entero.
-- Ahora un trigger POR SENTENCIA (AFTER DELETE … REFERENCING OLD TABLE) cuenta cuántas filas borró la sentencia: si es
-- la app (rol authenticated), la cuenta no es administrador (public.pl_is_admin()) y son MÁS DE 5, la sentencia completa
-- se deshace con un mensaje claro (HTTP 400 en PostgREST, que la app no reintenta). Borrar de una en una (alta de un
-- paciente, 🗑 de un renglón) sigue igual. Exentos: service_role (robot del censo, robot de labs, Edge Functions),
-- postgres sin JWT (crons, SQL de mantenimiento) y cualquier sesión con set_config('pl.entrega_libre','on',true).
-- Notas de diseño:
--   · El rol se toma del JWT (request.jwt.claims.role, lo que pone PostgREST) y, sin JWT, de current_user: así cuenta
--     también una sesión que hizo «set role authenticated».
--   · En la cascada patients → notes (llave foránea on delete cascade) Postgres 16 dispara el trigger de notes UNA vez
--     con todas las notas de la sentencia: borrar ≤ 5 pacientes borra ≤ 5 notas y pasa; borrar 6 pacientes ya se frena
--     en patients.
--   · Todo lo que hicieron los triggers de fila de esa sentencia (Papelera, bitácora, borrados_otros) se deshace con ella.
-- Se puede volver a correr (create or replace / drop trigger if exists).

create or replace function public.pl_borrado_masivo() returns trigger
language plpgsql set search_path = public as $fn$
declare
  v_rol text; v_n bigint; v_que text;
begin
  if coalesce(current_setting('pl.entrega_libre', true), '') = 'on' then return null; end if;
  begin v_rol := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'; exception when others then v_rol := null; end;
  v_rol := coalesce(v_rol, current_user::text);
  if v_rol <> 'authenticated' then return null; end if;      -- service_role, postgres (crons/SQL): exentos
  select count(*) into v_n from viejas;
  if v_n <= 5 then return null; end if;
  if coalesce(public.pl_is_admin(), false) then return null; end if;
  v_que := case TG_TABLE_NAME when 'patients' then 'pacientes' when 'notes' then 'notas' when 'no_olvidar' then 'renglones de No olvidar'
                              when 'procedimientos_dia' then 'procedimientos del día' else TG_TABLE_NAME end;
  raise exception 'Borrado masivo bloqueado: esta acción iba a borrar % % de una sola vez. Solo un administrador puede borrar más de 5 a la vez. No se borró nada.', v_n, v_que
    using hint = 'Pídeselo a un administrador de Piso Libro o borra solo lo que necesitas.',
          detail = format('tabla %s · %s filas · límite 5 para cuentas que no son administrador', TG_TABLE_NAME, v_n);
end $fn$;
-- SECURITY INVOKER a propósito: lee la tabla de transición de la propia sentencia; pl_is_admin() es SECURITY DEFINER.
revoke all on function public.pl_borrado_masivo() from public, anon;

drop trigger if exists pl_borrado_masivo on public.patients;
create trigger pl_borrado_masivo after delete on public.patients referencing old table as viejas
  for each statement execute function public.pl_borrado_masivo();
drop trigger if exists pl_borrado_masivo on public.notes;
create trigger pl_borrado_masivo after delete on public.notes referencing old table as viejas
  for each statement execute function public.pl_borrado_masivo();
drop trigger if exists pl_borrado_masivo on public.no_olvidar;
create trigger pl_borrado_masivo after delete on public.no_olvidar referencing old table as viejas
  for each statement execute function public.pl_borrado_masivo();
drop trigger if exists pl_borrado_masivo on public.procedimientos_dia;
create trigger pl_borrado_masivo after delete on public.procedimientos_dia referencing old table as viejas
  for each statement execute function public.pl_borrado_masivo();

-- Efecto en la app publicada (main 1ba7520) para cuentas que no son administrador, con más de 5 filas:
--   «🔥 BORRAR TODO» → la nube no se borra (la app ignora el error y limpia solo el equipo; al recargar vuelve el censo);
--   «Eliminar especialidad» → alert «Error al eliminar: DELETE patients HTTP 400 … Borrado masivo bloqueado…»;
--   «Borrar hechos» / «Borrar procedimientos del día» con red → la app lo registra en consola y no lo reintenta (400 no
--   es reintentable): en la nube siguen y vuelven a aparecer al recargar. Si se pulsó SIN red, la operación queda en la
--   cola (outbox) y en cada envío falla otra vez (4 intentos por envío) hasta que se borre la cola: no daña nada, pero el
--   contador de pendientes no baja. Con ≤ 5 filas todo sigue igual.
-- REVERSA: drop trigger if exists pl_borrado_masivo on public.patients; (ídem notes, no_olvidar, procedimientos_dia);
--          drop function if exists public.pl_borrado_masivo();
