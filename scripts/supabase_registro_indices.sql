-- Registro de pacientes para investigación (apps-script/registro-pacientes.gs), 21 oct 2026.
-- Aplicado en producción como migración «registro_indices_cursor».
--
-- El registro lee archive, winlab_labs y ris_estudios por cursor: ordenado por (fecha de captura, id) y paginado por
-- llave (col=gte.v & or=(col.gt.v, and(col.eq.v, id.gt.i))). Sin índice, Postgres leía y descomprimía el JSON de TODAS
-- las filas de winlab_labs antes de ordenar: 3.9 s por página de 100 (PostgREST corta a los 8 s). Con el índice, 26 ms.
-- Solo agrega índices; no cambia datos. Idempotente.
create index if not exists winlab_labs_scraped_at_id_idx on public.winlab_labs (scraped_at, id);
create index if not exists ris_estudios_scraped_at_id_idx on public.ris_estudios (scraped_at, id);
create index if not exists archive_archived_at_id_idx on public.archive (archived_at, id);
