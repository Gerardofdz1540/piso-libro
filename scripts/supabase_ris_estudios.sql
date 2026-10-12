-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Estudios de imagen (robot RIS "consultas-pisos") → public.ris_estudios (aplicado 12 oct 2026)
-- Lo llena .github/workflows/ris-scraper.yml (rpa/ris-scraper.js) con la service key; la app lo
-- lee por exp del censo y se suscribe por Realtime. Credenciales del visor en public.rpa_config.
-- ═══════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.rpa_config (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.rpa_config enable row level security;   -- solo service role (sin políticas)
-- insert into public.rpa_config (key, value) values ('RIS_URL', '…'), ('RIS_USER', '…'), ('RIS_PASS', '…');

create table if not exists public.ris_estudios (
  id bigserial primary key,
  exp text,                              -- expediente del censo con el que cruzó (por nombre)
  paciente text,                         -- nombre tal como aparece en el RIS
  documento text not null default '',    -- "NÚMERO DE DOCUMENTO" del RIS (PAT…)
  fecha text not null default '',        -- AAAA-MM-DD de llegada
  hora text not null default '',
  sede text,
  estudios text,
  modalidad text not null default '',    -- US, TC, RX, RM…
  procedencia text,
  critico boolean not null default false,
  reporte text,                          -- texto transcrito del reporte (ícono impresora), si existe
  reporte_url text,
  imagen_url text,
  links jsonb,
  scraped_at timestamptz not null default now(),
  unique (documento, fecha, hora, modalidad)
);
alter table public.ris_estudios enable row level security;
create policy "ris_estudios_read" on public.ris_estudios for select to authenticated using (true);
alter table public.ris_estudios replica identity full;
alter publication supabase_realtime add table public.ris_estudios;
