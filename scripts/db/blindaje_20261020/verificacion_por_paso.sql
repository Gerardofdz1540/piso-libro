-- ═══ Verificación por paso de la aplicación integrada (20 oct 2026) ═══════════════════════════════════════════
-- GENERADO por integrada/armar_integrado.py: no editar a mano (los md5 salen del texto de cada migración).
-- Por qué: después de aplicar cada archivo en producción hay que saber, con SOLO LECTURA, que quedó lo que se probó
-- en la réplica: el md5(prosrc) de cada función (Postgres guarda el cuerpo tal cual, así que es el mismo que dio la
-- réplica), sus triggers, columnas, tablas y permisos. Cada consulta da UNA fila: ok = true después de aplicar ese
-- paso (y de ahí en adelante), ok = false antes; «detalle» dice qué falta. La última consulta corre las 12 juntas.
-- Se pueden correr por el MCP de Supabase (execute_sql) o el editor SQL: no escriben nada.
-- restore_note_from_archive: la unida (N5 = O2) tiene md5 2be077c3c0effa5a572eb9601702b61f; V07 acepta también 1ccfd92db56cbab72b478fd7311cbe34
-- (la de O2 sin restaurada_en, que solo existe si se revirtió N5 y O2 sigue).

-- V00 · PRECONDICIÓN: correr ANTES del paso 1. ok = true ⇒ producción no cambió desde que se armó la réplica
-- (mismo md5 que la réplica en las 23 funciones que estas migraciones reemplazan o usan, mismos triggers en las 5
-- tablas, ninguno de los objetos nuevos, permisos de O6 y REPLICA IDENTITY como hoy). Si da false, NO aplicar: la
-- réplica ya no representa a producción y hay que volver a probar. Después del paso 1 da false (a propósito).
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_audit()', array['5604b95110fee8c8d3a63deca43d2840']),
            ('public.pl_entrega_protegida()', array['0e4ee94af6b63a630f0efdac969cdc14']),
            ('public.pl_checklist_sin_perdidas()', array['deed7c8c437a4e13404444993ef0eb50']),
            ('public.restore_note_from_archive(uuid)', array['e43e448119a3e499e77e05092040359e']),
            ('public.archive_before_delete()', array['ddc902b91132962833a8ccac9776784f']),
            ('public.pl_respaldo_hora()', array['44e66b43269ce1f9befa4006cfd058f2']),
            ('public.pl_detectar_perdidas()', array['0d3711209f5c7baacca6bea7eab200cf']),
            ('public.pl_is_admin()', array['0cc419e27a5cf9c0e17e5a70d1fe8c68']),
            ('public.pl_is_active()', array['ec83379d8e3364c2393084b8d3462961']),
            ('public.pl_same_person(text,text)', array['472b5538d1582acabc5cc5f6f8a3cea8']),
            ('public.pl_es_auto_entrega(text)', array['205c120b9635978eba9d38d83d967bdd']),
            ('public.pl_guardia_gemelo(text,text)', array['718ea5d6eb4796810bf11be5f03e5a65']),
            ('public.pl_json_texto(text)', array['24b43f7b0e1e01638b72d2f31b8eddc6']),
            ('public.pl_guardia_a_cronologia()', array['c2902118cbc0dc02db280795b2f768a7']),
            ('public.patients_restore_note_after_insert()', array['51ae3422c0ea83adfd634b69dd9007c5']),
            ('public.update_timestamp()', array['301a884953d37769916294bb60562e05']),
            ('public.pl_cronologia_reponer()', array['47bab91e913c25163c71401d99af79ce']),
            ('public.pl_cronologia_guardar_copia()', array['9aea137a795b2c14f581a98d58af51d4']),
            ('public.pl_historial_caja(uuid,text,integer)', array['f27c2afe12b83b28c41dd4c409b1f403']),
            ('public.pl_historial_caja_v2(uuid,text,integer)', array['5b7d4585b2a48c900415275dde641736']),
            ('public.pl_historial_caja_v3(uuid,text,integer)', array['aeaef688e094d98c9096d98587754111']),
            ('public.indicaciones_fetch()', array['906efbfe422412b5c1d28dd1fe32e8c8']),
            ('public.indicaciones_collect()', array['7fa68a08beb16ec49da785f165facbee'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select 'permisos (anon/authenticated/service_role): ' || s.t as falta
    from (select string_agg(format('%s:%s/%s/%s', u.f, has_function_privilege('anon', u.f, 'execute'),
                 has_function_privilege('authenticated', u.f, 'execute'), has_function_privilege('service_role', u.f, 'execute')), ' ' order by u.i) as t
            from unnest(array['public.pl_historial_caja(uuid,text,integer)', 'public.pl_historial_caja_v2(uuid,text,integer)',
                              'public.pl_historial_caja_v3(uuid,text,integer)', 'public.indicaciones_fetch()', 'public.indicaciones_collect()'])
                 with ordinality u(f, i)) s
   where s.t is distinct from 'public.pl_historial_caja(uuid,text,integer):f/t/t public.pl_historial_caja_v2(uuid,text,integer):f/t/t public.pl_historial_caja_v3(uuid,text,integer):f/t/t public.indicaciones_fetch():t/t/t public.indicaciones_collect():t/t/t'
  union all
  select 'notes.relreplident = ' || c.relreplident::text || ' (se esperaba d = DEFAULT)' as falta
    from pg_class c where c.oid = 'public.notes'::regclass and c.relreplident <> 'd'
  union all
  select format('triggers de %s: %s (se esperaba %s)', v.t, coalesce(nullif(x.l, ''), '(ninguno)'), coalesce(nullif(v.l, ''), '(ninguno)')) as falta
    from (values ('archive', ''),
            ('no_olvidar', 'pl_audit_no_olvidar'),
            ('notes', 'notes_archive_before_delete,pl_audit_notes,pl_checklist_sin_perdidas,pl_cronologia_guardar_copia,pl_cronologia_reponer,pl_entrega_protegida,trg_notes_updated'),
            ('patients', 'patients_archive_before_delete,patients_restore_note_after_insert,patients_suppress_redundant_updates,pl_audit_patients,trg_patients_updated'),
            ('procedimientos_dia', 'pl_audit_procedimientos_dia')) v(t, l)
    left join lateral (select coalesce(string_agg(g.tgname, ',' order by g.tgname), '') as l from pg_trigger g
                        where g.tgrelid = to_regclass('public.' || v.t) and not g.tgisinternal) x on true
   where x.l is distinct from v.l
  union all
  select 'ya existe ' || v.o as falta
    from (values ('función nueva pl_sello_t(jsonb)', to_regprocedure('public.pl_sello_t(jsonb)') is not null),
            ('función nueva pl_by_monotono()', to_regprocedure('public.pl_by_monotono()') is not null),
            ('función nueva notes_preserve_lab_history()', to_regprocedure('public.notes_preserve_lab_history()') is not null),
            ('función nueva pl_labs_normalizados(jsonb)', to_regprocedure('public.pl_labs_normalizados(jsonb)') is not null),
            ('función nueva notes_sin_cambios_labs()', to_regprocedure('public.notes_sin_cambios_labs()') is not null),
            ('función nueva pl_zz_sin_cambios()', to_regprocedure('public.pl_zz_sin_cambios()') is not null),
            ('función nueva pl_caja_con_contenido(jsonb)', to_regprocedure('public.pl_caja_con_contenido(jsonb)') is not null),
            ('función nueva pl_restaurada_protegida()', to_regprocedure('public.pl_restaurada_protegida()') is not null),
            ('función nueva pl_quien()', to_regprocedure('public.pl_quien()') is not null),
            ('función nueva pl_archive_eliminados()', to_regprocedure('public.pl_archive_eliminados()') is not null),
            ('función nueva pl_borrados_otros()', to_regprocedure('public.pl_borrados_otros()') is not null),
            ('función nueva pl_respaldo_hora_otros()', to_regprocedure('public.pl_respaldo_hora_otros()') is not null),
            ('función nueva pl_borrado_masivo()', to_regprocedure('public.pl_borrado_masivo()') is not null),
            ('función nueva pl_ck_perdidos(text,text,text,text)', to_regprocedure('public.pl_ck_perdidos(text,text,text,text)') is not null),
            ('tabla nueva archive_eliminados', to_regclass('public.archive_eliminados') is not null),
            ('tabla nueva borrados_otros', to_regclass('public.borrados_otros') is not null),
            ('tabla nueva respaldo_hora_otros', to_regclass('public.respaldo_hora_otros') is not null),
            ('columna nueva notes.restaurada_en', exists (select 1 from pg_attribute where attrelid = 'public.notes'::regclass and attname = 'restaurada_en' and not attisdropped)),
            ('columna nueva perdidas_alerta.user_id', exists (select 1 from pg_attribute where attrelid = 'public.perdidas_alerta'::regclass and attname = 'user_id' and not attisdropped)),
            ('columna nueva perdidas_alerta.ua', exists (select 1 from pg_attribute where attrelid = 'public.perdidas_alerta'::regclass and attname = 'ua' and not attisdropped))) v(o, hay)
   where v.hay
)
select 'V00 · precondición · producción sigue como la réplica' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V01 · O1 · otros/01_audit_por_equipo.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_audit()', array['3d4bcbc765556fb312c7fd231ffc1f15'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V01 · O1 · otros/01_audit_por_equipo.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V02 · N1 · notas/01_by_monotono.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_sello_t(jsonb)', array['4dabad62c234b90921b47e2359524e31']),
            ('public.pl_by_monotono()', array['190f490a20f6206c0b314c685482a993'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'pl_by_monotono', 'public.pl_by_monotono()', 'BEFORE UPDATE OF checklist ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V02 · N1 · notas/01_by_monotono.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V03 · N2 · notas/02_guardia_otro_usuario.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_entrega_protegida()', array['1a1fd0080442741748cf3608f42fb8d3'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V03 · N2 · notas/02_guardia_otro_usuario.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V04 · N3 · notas/03_labs_sin_perdidas.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.notes_preserve_lab_history()', array['6b0323a79551abb71dda45c2d80ef472'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'notes_preserve_lab_history', 'public.notes_preserve_lab_history()', 'BEFORE UPDATE OF lab_history ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V04 · N3 · notas/03_labs_sin_perdidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V05 · N4 · notas/04_sin_cambios.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_checklist_sin_perdidas()', array['fcfc3b11befb50ecf1c876cb6aa090f5']),
            ('public.pl_labs_normalizados(jsonb)', array['0f42129d95c2872e4a5ab3290ccb9e28']),
            ('public.notes_sin_cambios_labs()', array['c22822d4b0c8927915bb6cd88f19a3d7']),
            ('public.pl_zz_sin_cambios()', array['886353a7f620eb5a5532916c72ed00dd'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'notes_sin_cambios_labs', 'public.notes_sin_cambios_labs()', 'BEFORE UPDATE OF lab_history ON public.notes FOR EACH ROW'),
            ('notes', 'pl_zz_sin_cambios', 'public.pl_zz_sin_cambios()', 'BEFORE UPDATE ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V05 · N4 · notas/04_sin_cambios.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V06 · N5 · notas/05_restaurada_protegida.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.restore_note_from_archive(uuid)', array['2be077c3c0effa5a572eb9601702b61f']),
            ('public.pl_caja_con_contenido(jsonb)', array['25fdd5424646350a8b27b5ef878f3db9']),
            ('public.pl_restaurada_protegida()', array['14015655d96d5fc7c63ecc01a2fe07de'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'pl_restaurada_protegida', 'public.pl_restaurada_protegida()', 'BEFORE UPDATE ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('columna %s.%s %s', v.t, v.c, v.ty) as falta
    from (values ('notes', 'restaurada_en', 'timestamp with time zone')) v(t, c, ty)
   where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || v.t) and a.attname = v.c
                       and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = v.ty)
)
select 'V06 · N5 · notas/05_restaurada_protegida.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V07 · O2 · otros/02_papelera_copia_base.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_quien()', array['11516cb157314cf0dcc025a381451fb1']),
            ('public.archive_before_delete()', array['ea0696cafd8c417f2ca640aefbf8f341']),
            ('public.pl_archive_eliminados()', array['b7ea4c553b53ae7aa6331c4a28fc7df7']),
            ('public.restore_note_from_archive(uuid)', array['2be077c3c0effa5a572eb9601702b61f', '1ccfd92db56cbab72b478fd7311cbe34'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('archive', 'pl_archive_eliminados', 'public.pl_archive_eliminados()', 'BEFORE DELETE ON public.archive FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('tabla %s con RLS' || case when v.pol then ' y su política de lectura del administrador' else ' (sin políticas)' end, v.t) as falta
    from (values ('archive_eliminados', true)) v(t, pol)
   where not exists (select 1 from pg_class c where c.oid = to_regclass('public.' || v.t) and c.relrowsecurity)
      or exists (select 1 from pg_policies q where q.schemaname = 'public' and q.tablename = v.t) is distinct from v.pol
)
select 'V07 · O2 · otros/02_papelera_copia_base.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V08 · O3 · otros/03_listas_compartidas.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_borrados_otros()', array['1daf9f2c0492338af2134cbddac6cbb3']),
            ('public.pl_respaldo_hora_otros()', array['05695bec0f5814e594a11a08323b92e2']),
            ('public.pl_respaldo_hora()', array['32db72649db3a273cf0ed5deed713ad5'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('no_olvidar', 'pl_borrados_otros', 'public.pl_borrados_otros()', 'BEFORE DELETE ON public.no_olvidar FOR EACH ROW'),
            ('procedimientos_dia', 'pl_borrados_otros', 'public.pl_borrados_otros()', 'BEFORE DELETE ON public.procedimientos_dia FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('tabla %s con RLS' || case when v.pol then ' y su política de lectura del administrador' else ' (sin políticas)' end, v.t) as falta
    from (values ('borrados_otros', true), ('respaldo_hora_otros', false)) v(t, pol)
   where not exists (select 1 from pg_class c where c.oid = to_regclass('public.' || v.t) and c.relrowsecurity)
      or exists (select 1 from pg_policies q where q.schemaname = 'public' and q.tablename = v.t) is distinct from v.pol
)
select 'V08 · O3 · otros/03_listas_compartidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V09 · O4 · otros/04_borrado_masivo.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_borrado_masivo()', array['73e814214b2d1d16ab982dc03b17cb4b'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('patients', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.patients REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('notes', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.notes REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('no_olvidar', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.no_olvidar REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('procedimientos_dia', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.procedimientos_dia REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V09 · O4 · otros/04_borrado_masivo.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V10 · O5 · otros/05_alarma_perdidas.sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_ck_perdidos(text,text,text,text)', array['64d4e3400a54928b1e2653dc28f99f67']),
            ('public.pl_detectar_perdidas()', array['9c8a6a8b3ee4ca5101e5aba302d1a2ef'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('columna %s.%s %s', v.t, v.c, v.ty) as falta
    from (values ('perdidas_alerta', 'user_id', 'uuid'), ('perdidas_alerta', 'ua', 'text')) v(t, c, ty)
   where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || v.t) and a.attname = v.c
                       and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = v.ty)
)
select 'V10 · O5 · otros/05_alarma_perdidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V11 · O6 · otros/06_permisos.sql
with faltas as (
  select 'permisos (anon/authenticated/service_role): ' || s.t as falta
    from (select string_agg(format('%s:%s/%s/%s', u.f, has_function_privilege('anon', u.f, 'execute'),
                 has_function_privilege('authenticated', u.f, 'execute'), has_function_privilege('service_role', u.f, 'execute')), ' ' order by u.i) as t
            from unnest(array['public.pl_historial_caja(uuid,text,integer)', 'public.pl_historial_caja_v2(uuid,text,integer)',
                              'public.pl_historial_caja_v3(uuid,text,integer)', 'public.indicaciones_fetch()', 'public.indicaciones_collect()'])
                 with ordinality u(f, i)) s
   where s.t is distinct from 'public.pl_historial_caja(uuid,text,integer):f/f/t public.pl_historial_caja_v2(uuid,text,integer):f/f/t public.pl_historial_caja_v3(uuid,text,integer):f/t/t public.indicaciones_fetch():f/t/t public.indicaciones_collect():f/t/t'
)
select 'V11 · O6 · otros/06_permisos.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- V12 · N6 · notas/06_replica_full.sql
with faltas as (
  select 'notes.relreplident = ' || c.relreplident::text || ' (se esperaba f = FULL)' as falta
    from pg_class c where c.oid = 'public.notes'::regclass and c.relreplident <> 'f'
)
select 'V12 · N6 · notas/06_replica_full.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;

-- Todas juntas (una fila por paso, en el orden de aplicación):
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_audit()', array['3d4bcbc765556fb312c7fd231ffc1f15'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V01 · O1 · otros/01_audit_por_equipo.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_sello_t(jsonb)', array['4dabad62c234b90921b47e2359524e31']),
            ('public.pl_by_monotono()', array['190f490a20f6206c0b314c685482a993'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'pl_by_monotono', 'public.pl_by_monotono()', 'BEFORE UPDATE OF checklist ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V02 · N1 · notas/01_by_monotono.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_entrega_protegida()', array['1a1fd0080442741748cf3608f42fb8d3'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V03 · N2 · notas/02_guardia_otro_usuario.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.notes_preserve_lab_history()', array['6b0323a79551abb71dda45c2d80ef472'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'notes_preserve_lab_history', 'public.notes_preserve_lab_history()', 'BEFORE UPDATE OF lab_history ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V04 · N3 · notas/03_labs_sin_perdidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_checklist_sin_perdidas()', array['fcfc3b11befb50ecf1c876cb6aa090f5']),
            ('public.pl_labs_normalizados(jsonb)', array['0f42129d95c2872e4a5ab3290ccb9e28']),
            ('public.notes_sin_cambios_labs()', array['c22822d4b0c8927915bb6cd88f19a3d7']),
            ('public.pl_zz_sin_cambios()', array['886353a7f620eb5a5532916c72ed00dd'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'notes_sin_cambios_labs', 'public.notes_sin_cambios_labs()', 'BEFORE UPDATE OF lab_history ON public.notes FOR EACH ROW'),
            ('notes', 'pl_zz_sin_cambios', 'public.pl_zz_sin_cambios()', 'BEFORE UPDATE ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V05 · N4 · notas/04_sin_cambios.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.restore_note_from_archive(uuid)', array['2be077c3c0effa5a572eb9601702b61f']),
            ('public.pl_caja_con_contenido(jsonb)', array['25fdd5424646350a8b27b5ef878f3db9']),
            ('public.pl_restaurada_protegida()', array['14015655d96d5fc7c63ecc01a2fe07de'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('notes', 'pl_restaurada_protegida', 'public.pl_restaurada_protegida()', 'BEFORE UPDATE ON public.notes FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('columna %s.%s %s', v.t, v.c, v.ty) as falta
    from (values ('notes', 'restaurada_en', 'timestamp with time zone')) v(t, c, ty)
   where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || v.t) and a.attname = v.c
                       and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = v.ty)
)
select 'V06 · N5 · notas/05_restaurada_protegida.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_quien()', array['11516cb157314cf0dcc025a381451fb1']),
            ('public.archive_before_delete()', array['ea0696cafd8c417f2ca640aefbf8f341']),
            ('public.pl_archive_eliminados()', array['b7ea4c553b53ae7aa6331c4a28fc7df7']),
            ('public.restore_note_from_archive(uuid)', array['2be077c3c0effa5a572eb9601702b61f', '1ccfd92db56cbab72b478fd7311cbe34'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('archive', 'pl_archive_eliminados', 'public.pl_archive_eliminados()', 'BEFORE DELETE ON public.archive FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('tabla %s con RLS' || case when v.pol then ' y su política de lectura del administrador' else ' (sin políticas)' end, v.t) as falta
    from (values ('archive_eliminados', true)) v(t, pol)
   where not exists (select 1 from pg_class c where c.oid = to_regclass('public.' || v.t) and c.relrowsecurity)
      or exists (select 1 from pg_policies q where q.schemaname = 'public' and q.tablename = v.t) is distinct from v.pol
)
select 'V07 · O2 · otros/02_papelera_copia_base.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_borrados_otros()', array['1daf9f2c0492338af2134cbddac6cbb3']),
            ('public.pl_respaldo_hora_otros()', array['05695bec0f5814e594a11a08323b92e2']),
            ('public.pl_respaldo_hora()', array['32db72649db3a273cf0ed5deed713ad5'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('no_olvidar', 'pl_borrados_otros', 'public.pl_borrados_otros()', 'BEFORE DELETE ON public.no_olvidar FOR EACH ROW'),
            ('procedimientos_dia', 'pl_borrados_otros', 'public.pl_borrados_otros()', 'BEFORE DELETE ON public.procedimientos_dia FOR EACH ROW')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
  union all
  select format('tabla %s con RLS' || case when v.pol then ' y su política de lectura del administrador' else ' (sin políticas)' end, v.t) as falta
    from (values ('borrados_otros', true), ('respaldo_hora_otros', false)) v(t, pol)
   where not exists (select 1 from pg_class c where c.oid = to_regclass('public.' || v.t) and c.relrowsecurity)
      or exists (select 1 from pg_policies q where q.schemaname = 'public' and q.tablename = v.t) is distinct from v.pol
)
select 'V08 · O3 · otros/03_listas_compartidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_borrado_masivo()', array['73e814214b2d1d16ab982dc03b17cb4b'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('trigger %s en %s', v.n, v.t) as falta
    from (values ('patients', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.patients REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('notes', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.notes REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('no_olvidar', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.no_olvidar REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT'),
            ('procedimientos_dia', 'pl_borrado_masivo', 'public.pl_borrado_masivo()', 'AFTER DELETE ON public.procedimientos_dia REFERENCING OLD TABLE AS viejas FOR EACH STATEMENT')) v(t, n, f, d)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || v.t) and g.tgname = v.n and g.tgenabled <> 'D'
                       and g.tgfoid = to_regprocedure(v.f) and pg_get_triggerdef(g.oid) like '%' || v.d || '%')
)
select 'V09 · O4 · otros/04_borrado_masivo.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_ck_perdidos(text,text,text,text)', array['64d4e3400a54928b1e2653dc28f99f67']),
            ('public.pl_detectar_perdidas()', array['9c8a6a8b3ee4ca5101e5aba302d1a2ef'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
  union all
  select format('columna %s.%s %s', v.t, v.c, v.ty) as falta
    from (values ('perdidas_alerta', 'user_id', 'uuid'), ('perdidas_alerta', 'ua', 'text')) v(t, c, ty)
   where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || v.t) and a.attname = v.c
                       and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = v.ty)
)
select 'V10 · O5 · otros/05_alarma_perdidas.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select 'permisos (anon/authenticated/service_role): ' || s.t as falta
    from (select string_agg(format('%s:%s/%s/%s', u.f, has_function_privilege('anon', u.f, 'execute'),
                 has_function_privilege('authenticated', u.f, 'execute'), has_function_privilege('service_role', u.f, 'execute')), ' ' order by u.i) as t
            from unnest(array['public.pl_historial_caja(uuid,text,integer)', 'public.pl_historial_caja_v2(uuid,text,integer)',
                              'public.pl_historial_caja_v3(uuid,text,integer)', 'public.indicaciones_fetch()', 'public.indicaciones_collect()'])
                 with ordinality u(f, i)) s
   where s.t is distinct from 'public.pl_historial_caja(uuid,text,integer):f/f/t public.pl_historial_caja_v2(uuid,text,integer):f/f/t public.pl_historial_caja_v3(uuid,text,integer):f/t/t public.indicaciones_fetch():f/t/t public.indicaciones_collect():f/t/t'
)
select 'V11 · O6 · otros/06_permisos.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
union all
(with faltas as (
  select 'notes.relreplident = ' || c.relreplident::text || ' (se esperaba f = FULL)' as falta
    from pg_class c where c.oid = 'public.notes'::regclass and c.relreplident <> 'f'
)
select 'V12 · N6 · notas/06_replica_full.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas)
order by 1;
