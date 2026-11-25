-- 25 nov 2026 · aplicado en producción (migración censo_procedimientos).
-- Procedimientos del día que trae la hoja del censo (sección PROCEDIMIENTOS). Los escribe apps-script/censo-sync.gs
-- (service_role, cada 5 min, upsert por fecha + expediente + nombre normalizado); los copia el registro de pacientes.
-- Sirve para conservar a los operados como seguimiento aunque no hayan estado hospitalizados (EXT, QX, UCIP).
-- Solo service_role: RLS activa sin políticas.
create table if not exists public.censo_procedimientos (
  id bigint generated always as identity primary key,
  fecha date not null,
  cama text not null default '',
  exp text not null,
  nombre text not null default '',
  nombre_norm text not null default '',
  edad text not null default '',
  dx text not null default '',
  esp text not null default '',
  adscrito text not null default '',
  residente text not null default '',
  visto_primero timestamptz not null default now(),
  visto_ultimo timestamptz not null default now(),
  constraint censo_procedimientos_unico unique (fecha, exp, nombre_norm)
);
create index if not exists censo_procedimientos_exp_idx on public.censo_procedimientos (exp);
create index if not exists censo_procedimientos_visto_idx on public.censo_procedimientos (visto_ultimo, id);
alter table public.censo_procedimientos enable row level security;
revoke all on public.censo_procedimientos from anon, authenticated;
comment on table public.censo_procedimientos is 'Sección PROCEDIMIENTOS de la hoja del censo (censo-sync.gs). Seguimiento de operados.';
