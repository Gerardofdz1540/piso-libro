-- 17 oct 2026 · aplicado en producción (migración ris_estudios_patient_id).
-- A qué paciente del censo asignó el robot RIS cada estudio. Con un expediente repetido en la hoja
-- (dos personas, error de captura) el expediente ya no basta para saber de quién es el estudio.
-- Nullable y sin FK: las filas de patients se archivan/recrean; las filas viejas siguen por nombre.
alter table public.ris_estudios add column if not exists patient_id uuid;
comment on column public.ris_estudios.patient_id is 'patients.id con el que el robot RIS cruzó el estudio (null en filas anteriores al 17-oct-2026)';
