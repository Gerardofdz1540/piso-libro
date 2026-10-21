-- ═══ N6 · notes con REPLICA IDENTITY FULL (20 oct 2026, P0-02 de la revisión integral) ═══════════════════════════
-- SOLO PREPARADO: no se probó contra Realtime (no hay servidor Realtime ni wal_level=logical en la réplica local).
-- Por qué (hallazgo H1, confirmado en producción el 20 oct leyendo realtime.apply_rls, solo SELECT): con REPLICA
-- IDENTITY DEFAULT el WAL de un UPDATE no trae las columnas TOAST (grandes) que NO cambiaron, y Realtime arma el
-- `record` uniendo «columns» con «old_columns» (la identidad del tuple viejo): con DEFAULT esa identidad es solo la
-- PK, así que el evento llega SIN lab_history, checklist o app cuando esas columnas no cambiaron. handleNoteChange las
-- toma como vacías: labs [] en 24 de 47 notas y checklist en 36 de 47 en los otros equipos, y en la 3-161 un guardado
-- posterior subió app = "". Con FULL, Postgres escribe en el WAL el tuple viejo COMPLETO (con el TOAST aplanado),
-- old_columns trae los valores y el `record` sale completo. Ya están en FULL no_olvidar, procedimientos_dia,
-- indicaciones_doc y ris_estudios. (Con RLS, Realtime manda en «old» solo la PK; lo que se arregla es «record».)
-- Por qué va DESPUÉS de N4 (y el bloque de abajo lo exige): con FULL cada UPDATE de notes escribe en el WAL la fila
-- vieja entera además de la nueva; lab_history y checklist son lo más grande de la base, así que el WAL (y lo que
-- Realtime lee y reparte) crece por cada UPDATE. El 77 % de los UPDATE de notes eran reescrituras de labs sin nada
-- nuevo: si FULL entrara antes que pl_zz_sin_cambios, cada una de esas reescrituras costaría el doble de WAL y
-- seguiría saliendo a todos los equipos. Con N4 esas reescrituras ya no son UPDATE (no generan WAL), y FULL solo
-- encarece los cambios reales.
-- Candado: ALTER TABLE … REPLICA IDENTITY toma ACCESS EXCLUSIVE sobre notes (probado en la réplica: pg_locks), pero
-- solo cambia el catálogo (no reescribe la tabla): dura milisegundos. lock_timeout de 5 s para que, si un guardado
-- largo tiene la tabla, la migración falle y se reintente en vez de formar una fila de espera detrás de ella.
-- Se puede volver a correr (fijar FULL dos veces no cambia nada).
-- Reversa (un minuto, sin pérdida de datos):
--   alter table public.notes replica identity default;
-- Verificación: select relreplident from pg_class where oid = 'public.notes'::regclass;   → 'f' (reversa → 'd')
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.notes'::regclass and tgname = 'pl_zz_sin_cambios' and tgenabled <> 'D') then
    raise exception 'N6 va después de N4: falta (o está deshabilitado) el trigger pl_zz_sin_cambios en public.notes (04_sin_cambios.sql)';
  end if;
end $$;
set lock_timeout = '5s';
alter table public.notes replica identity full;
reset lock_timeout;
