-- 29 oct 2026 · aplicado en producción (migración limpieza_asesor_29oct).
-- Pendientes de los asesores de Supabase:
--  · app_users: las reglas evalúan auth.uid() una vez por consulta y no por fila ((select auth.uid())).
--  · notes: notes_patient_id_key duplicaba la llave primaria (patient_id); el upsert on_conflict=patient_id usa notes_pkey.
--  · Respaldos de emergencia del 9 al 20 oct ya sin uso (nada los referencia: ni vistas, funciones, cron ni llaves foráneas).
--    El respaldo vigente es el nocturno cifrado y respaldo_hora.
alter policy app_users_read on public.app_users using ((id = (select auth.uid())) or (select public.pl_is_admin()));
alter policy app_users_self_update on public.app_users using (id = (select auth.uid())) with check (id = (select auth.uid()));
alter table public.notes drop constraint if exists notes_patient_id_key;
drop table if exists public.notes_backup_20261014, public.respaldo_notes_20261020_0530, public.notes_lab_history_backup_20261009,
  public.respaldo_recuperacion_20261020, public.notes_entrega_respaldo_20261020, public.notes_entrega_respaldo_20261020b,
  public.respaldo_patients_20261020_0530;
