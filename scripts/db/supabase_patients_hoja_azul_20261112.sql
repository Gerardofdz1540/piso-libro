-- ═══════════════════════════════════════════════════════════════════════════════════════
-- Ingresos pintados de azul en la hoja del censo → patients.hoja_azul (12 nov 2026)
--
-- La hoja marca los INGRESOS del día pintando la fila de azul claro (#c9daf8). El programa de la hoja
-- (apps-script/censo-sync.gs, versión 2026.11.12 o posterior) lee ese color y lo guarda en esta columna; la app pinta
-- de azul claro esas camas en el navegador de camas (index.html: _plIngresoHoy). NCX y Urología no se marcan en la app.
--
-- · La escribe SOLO el programa de la hoja. La app nunca la manda (supaUpsertPatient arma la fila con sus columnas).
-- · Con el programa anterior de la hoja queda en false y la app marca solo por fecha de ingreso = hoy.
-- · Debe existir ANTES de pegar el programa nuevo. Si faltara (base restaurada de un respaldo viejo), el programa lo
--   detecta (HTTP 400 al pedirla), sincroniza el censo igual y no manda la columna.
-- · La publicación de Realtime de patients no tiene lista de columnas: la columna nueva viaja sola en los avisos.
--
-- Se puede volver a correr. Aplicado el 12 nov 2026 (migración patients_hoja_azul) y probado con una fila ficticia
-- dentro de una transacción deshecha: alta, marca, borrado (archive_before_delete usa patients%rowtype) → archivada.
-- ═══════════════════════════════════════════════════════════════════════════════════════
alter table public.patients add column if not exists hoja_azul boolean not null default false;
comment on column public.patients.hoja_azul is 'La hoja del censo tiene la fila pintada de azul (ingreso). La escribe solo censo-sync.';
