-- 27 oct 2026 · aplicado en producción (SQL directo, una vez): quitar de la 🕓 Cronología las líneas que la app escribía
-- sola. Pedido de Gera: «no quiero que pongas nada en las cajitas de manera automática». Desde la versión 2026.10.27-5
-- la app ya no anota novedades (labs críticos, estudios del RIS, cultivos) ni el bloque de ✨ Resumen en la caja; esto
-- borra las que ya estaban guardadas. Resultado: 14 renglones de 10 pacientes; los 153 renglones escritos por la gente
-- quedaron iguales.
--
-- Qué se considera automático:
--   · public.pl_es_auto_entrega(renglón): «dd-mm-aaaa: Labs: …», «dd-mm-aaaa: … (RIS): …», «dd-mm-aaaa: … POSITIVO a …
--     / sin desarrollo / negativo a …» (la misma función con la que pl_entrega_protegida ya rechazaba líneas nuevas);
--   · una línea del RIS que quedó cortada antes de «(RIS)»: «dd-mm-aaaa: CT Thorax^JA_…» (el «^» de la descripción
--     DICOM nunca lo escribe una persona).
-- Cada línea quitada queda en guardia_cortes (motivo «borrado») y en audit_log (diff de la Cronología), así que se puede
-- reponer. pl.entrega_libre=on es el permiso de mantenimiento que ya usan restore_note_from_archive y
-- pl_guardia_a_cronologia para que las protecciones de notes no repongan lo quitado.
do $$
declare r record; quitar text[]; nuevo text; n int := 0; tot int := 0;
begin
  perform set_config('pl.entrega_libre', 'on', true);
  for r in select patient_id, checklist from public.notes
            where coalesce(checklist #>> '{__pl_note_meta,entrega}','') ~ '(^|\n)\s*\d{2}-\d{2}-\d{4}: ' for update loop
    select coalesce(array_agg(btrim(x)), '{}') into quitar
      from unnest(string_to_array(r.checklist #>> '{__pl_note_meta,entrega}', E'\n')) x
     where public.pl_es_auto_entrega(x) or btrim(x) ~ '^\d{2}-\d{2}-\d{4}: [A-Z]{2} \S*\^';
    if cardinality(quitar) = 0 then continue; end if;
    select coalesce(string_agg(x, E'\n' order by o), '') into nuevo
      from unnest(string_to_array(r.checklist #>> '{__pl_note_meta,entrega}', E'\n')) with ordinality u(x, o)
     where not (btrim(x) <> '' and btrim(x) = any(quitar));
    nuevo := btrim(regexp_replace(nuevo, E'\n{3,}', E'\n\n', 'g'), E' \n');
    update public.notes set checklist = jsonb_set(checklist, '{__pl_note_meta,entrega}', to_jsonb(nuevo), true), updated_by = 'quitar-auto-cronologia-27oct'
     where patient_id = r.patient_id;
    insert into public.guardia_cortes (patient_id, lineas, motivo) values (r.patient_id, quitar, 'borrado');
    n := n + 1; tot := tot + cardinality(quitar);
  end loop;
  perform set_config('pl.entrega_libre', 'off', true);
  raise notice 'notas %, renglones quitados %', n, tot;
end $$;

-- Verificación (debe dar quedan_auto = 0):
-- with l as (select unnest(string_to_array(coalesce(checklist->'__pl_note_meta'->>'entrega',''), E'\n')) line from public.notes)
-- select count(*) filter (where public.pl_es_auto_entrega(line) or btrim(line) ~ '^\d{2}-\d{2}-\d{4}: [A-Z]{2} \S*\^') quedan_auto from l;
