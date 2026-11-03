-- 2 nov 2026 · aplicado en producción (migración pl_version_filas).
-- Versión por fila en winlab_labs y ris_estudios para las «descargas por diferencia» de la app (index.html,
-- _dcConsulta). Supabase avisó que el proyecto pasaba la transferencia del plan (5 GB/mes): cada recarga de la app bajaba
-- completas las filas de WinLab de 4 días (≈8 MB) aunque nada hubiera cambiado. Ahora la app pide primero la lista
-- id + updated_at (unos KB) y solo baja las filas cuya versión no tiene.
--
-- Por qué una columna nueva y no scraped_at: el robot de WinLab usa UN scraped_at por corrida y, dentro de la misma
-- corrida, puede reescribir la misma fila (expediente repetido, lote reintentado) con otro contenido y el mismo sello;
-- una copia tomada entre las dos escrituras se quedaría vieja. updated_at lo pone la base en CADA escritura
-- (clock_timestamp: distinto en cada fila aunque vayan en la misma transacción), así que una fila cambiada siempre
-- trae versión nueva. notes ya tenía su updated_at (trg_notes_updated).
--
-- Sin reescribir las tablas: add column con default now() (estable) es solo catálogo en Postgres 11+; las filas que ya
-- existían quedan con la hora de la migración. Nada más cambia: los robots no mandan updated_at (el trigger lo pone),
-- las vistas existentes no lo ven y la app vieja no lo pide.
-- Reversa (un minuto, sin pérdida): drop trigger pl_fila_version on public.winlab_labs; drop trigger pl_fila_version on
-- public.ris_estudios; alter table … drop column updated_at (la app nueva vuelve sola a la consulta completa).

alter table public.winlab_labs add column if not exists updated_at timestamptz not null default now();
alter table public.ris_estudios add column if not exists updated_at timestamptz not null default now();

create or replace function public.pl_fila_version()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := clock_timestamp();
  return new;
end
$fn$;
revoke all on function public.pl_fila_version() from public, anon, authenticated;

drop trigger if exists pl_fila_version on public.winlab_labs;
create trigger pl_fila_version before insert or update on public.winlab_labs
  for each row execute function public.pl_fila_version();
drop trigger if exists pl_fila_version on public.ris_estudios;
create trigger pl_fila_version before insert or update on public.ris_estudios
  for each row execute function public.pl_fila_version();

-- El chequeo diario de protecciones (pl_salud_catalogo) también revisa estos dos triggers: ver
-- scripts/supabase_salud_catalogo.sql (migración pl_salud_catalogo_v4).
