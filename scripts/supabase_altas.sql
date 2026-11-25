-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Piso Libro — Altas en Word (.docx) generadas por la app y copiadas a Google Drive (25 nov 2026)
-- PENDIENTE DE APLICAR: pegar completo en Supabase → SQL Editor → Run. Es idempotente.
--
-- Flujo:
--   1) En la tarjeta del paciente, «Alta» arma el .docx con el machote del servicio (en el dispositivo),
--      lo DESCARGA al momento y, con «Guardar en Drive», lo sube al bucket privado «altas» con el JWT
--      del usuario: ruta «<patient_id>/<AAAA-MM-DD>_<exp sin espacios>_<epoch ms>.docx».
--   2) Luego inserta una fila en public.altas_docs (drive_* y error en null).
--   3) apps-script/censo-sync.gs (pasarAltasADrive_, cada 5 min, service_role) toma las filas con
--      drive_file_id null (10 por corrida, las más viejas primero), descarga el objeto, crea el archivo en
--      Drive («Altas · Piso Libro» / «AAAA-MM») y escribe drive_file_id, drive_url y drive_en (o error).
--   4) La tabla está en supabase_realtime: la app ve el enlace de Drive en cuanto aparece.
--
-- Permisos (mismo modelo que scripts/supabase_rls_current.sql):
--   • anon: nada.
--   • authenticated + cuenta ACTIVA (public.pl_is_active()): INSERT y SELECT en altas_docs y en los
--     objetos del bucket «altas». Sin UPDATE ni DELETE desde la app (el documento entregado no se pisa).
--   • service_role (Apps Script): salta RLS; es el único que escribe drive_* / error.
-- Sin datos personales en este archivo.
-- ═══════════════════════════════════════════════════════════════════════════════════════

-- ── 1) Bucket privado «altas» (5 MB por archivo, solo .docx) ──────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('altas', 'altas', false, 5242880,
        array['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2) Tabla public.altas_docs ────────────────────────────────────────────────────────────
create table if not exists public.altas_docs (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,                 -- sin FK: el paciente se archiva y se borra de patients al egresar
  exp text not null default '',
  nombre text not null default '',
  fecha date not null,                      -- fecha del alta (la del documento)
  storage_path text not null unique,        -- objeto en el bucket «altas»
  creado_por text not null default '',      -- etiqueta visible (nombre que muestra la app; la escribe el cliente)
  creado_uid uuid not null default auth.uid(), -- autor VERIFICABLE: lo pone la base y la política de INSERT exige el del token
  creado_en timestamptz not null default now(),
  drive_file_id text,                       -- lo llena el Apps Script
  drive_url text,
  drive_en timestamptz,
  error text,                               -- último error del Apps Script (texto corto, sin datos personales)
  intentos int not null default 0,         -- intentos fallidos del Apps Script; 99 = definitiva (error permanente o >72 h)
  ultimo_intento timestamptz                -- último intento fallido: el Apps Script espera más cada vez (5 min … 6 h)
);
-- Idempotente si la tabla ya existía de una corrida anterior de este archivo (se puede correr dos veces).
-- creado_uid: en una tabla que ya tenía filas NO se puede agregar «not null default auth.uid()» de un jalón (en el
-- SQL Editor auth.uid() es null y las filas viejas quedarían en null → error). Se agrega nullable (las filas viejas
-- quedan sin autor verificable), luego el default, y el «not null» solo si ya no queda ninguna fila en null. Las filas
-- nuevas siempre lo llevan: la política de INSERT exige creado_uid = auth.uid().
alter table public.altas_docs add column if not exists creado_uid uuid;
alter table public.altas_docs alter column creado_uid set default auth.uid();
do $$
begin
  if not exists (select 1 from public.altas_docs where creado_uid is null) then
    alter table public.altas_docs alter column creado_uid set not null;
  end if;
end $$;
alter table public.altas_docs add column if not exists intentos int not null default 0;
alter table public.altas_docs add column if not exists ultimo_intento timestamptz;
comment on table public.altas_docs is
  'Altas (.docx) generadas en la app: bucket «altas» → Google Drive vía apps-script/censo-sync.gs (pasarAltasADrive_).';

-- Cola del Apps Script (drive_file_id null, las más viejas primero) y consulta por paciente en la app.
create index if not exists altas_docs_pendientes_idx on public.altas_docs (creado_en) where drive_file_id is null;
create index if not exists altas_docs_drive_null_idx on public.altas_docs (drive_file_id) where drive_file_id is null;
create index if not exists altas_docs_patient_idx on public.altas_docs (patient_id);

-- ── 3) RLS y grants mínimos ───────────────────────────────────────────────────────────────
alter table public.altas_docs enable row level security;
revoke all on public.altas_docs from anon, authenticated;
grant select, insert on public.altas_docs to authenticated;
grant all on public.altas_docs to service_role;

drop policy if exists altas_docs_insert on public.altas_docs;
drop policy if exists altas_docs_select on public.altas_docs;
drop policy if exists pl_solo_cuentas_activas on public.altas_docs;

-- INSERT: cuenta activa; la fila nace sin datos de Drive (solo el Apps Script los escribe), con el autor
-- verificable = el del token (nadie atribuye un alta a otra cuenta) y su objeto vive bajo la carpeta del
-- propio paciente en el bucket.
create policy altas_docs_insert on public.altas_docs
  for insert to authenticated
  with check (
    (select public.pl_is_active())
    and drive_file_id is null and drive_url is null and drive_en is null and error is null and intentos = 0
    and ultimo_intento is null
    and creado_uid = (select auth.uid())
    and storage_path like patient_id::text || '/%'
  );
create policy altas_docs_select on public.altas_docs
  for select to authenticated
  using ((select public.pl_is_active()));
-- Misma restrictiva que el resto de las tablas de datos (supabase_rls_current.sql).
create policy pl_solo_cuentas_activas on public.altas_docs as restrictive for all to authenticated
  using ((select public.pl_is_active())) with check ((select public.pl_is_active()));
-- UPDATE / DELETE: sin políticas → solo service_role.

-- ── 4) Storage: políticas sobre storage.objects para el bucket «altas» ────────────────────
-- storage.objects ya tiene la restrictiva pl_solo_cuentas_activas (cuentas bloqueadas no leen ni escriben);
-- estas permisivas abren SOLO subir y leer en «altas». Sin UPDATE/DELETE: la app sube con upsert=false.
drop policy if exists altas_obj_insert on storage.objects;
drop policy if exists altas_obj_select on storage.objects;
create policy altas_obj_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'altas' and (select public.pl_is_active()));
create policy altas_obj_select on storage.objects
  for select to authenticated
  using (bucket_id = 'altas' and (select public.pl_is_active()));

-- ── 5) Realtime: la app escucha altas_docs para mostrar el enlace de Drive en vivo ─────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'altas_docs') then
    alter publication supabase_realtime add table public.altas_docs;
  end if;
end $$;

-- ── Verificación rápida ───────────────────────────────────────────────────────────────────
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'altas';
select policyname, cmd, permissive from pg_policies where schemaname = 'public' and tablename = 'altas_docs' order by 1;
select policyname, cmd, permissive from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'altas_%' order by 1;
