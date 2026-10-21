# Blindaje de la base · qué aplicar en producción, en qué orden, cómo verificarlo y cómo volver atrás

*20 oct 2026 · paquetes «notas» (N1…N6) y «Bitácora, papelera y operación» (O1…O6), probados JUNTOS.*
*Este archivo lo arma `integrada/armar_integrado.py` desde `integrada/APLICAR_EN_ORDEN.plantilla.md`: las consultas
de verificación se copian tal cual de `verificacion_por_paso.sql`. Para cambiarlo, editar la plantilla.*

Todo se probó en el Postgres 16 local, en una copia nueva de `replica_prod` (huella idéntica a producción), en la base
`b_final` (antes `b_integrada`). En producción no se aplicó nada. Lo único que se hizo ahí fue correr V00 (un SELECT
por el MCP de Supabase, PostgreSQL 17.6): la última vez el 2026-10-20 a las 16:41 UTC, ya con los arreglos de la
revisión (la anterior, a las 15:27). Dio `ok = true`: producción seguía igual que la réplica. Las rutas son relativas
a `scratchpad/db_blindaje/`.

## En corto

- **Orden:** O1 → N1 → N2 → N3 → N4 → N5 → O2 → O3 → O4 → O5 → O6, y al final N6 (solo producción).
- **Incompatibilidad encontrada y arreglada.** `restore_note_from_archive` la redefinían N5 y O2, cada uno a su
  manera. N5 le agrega `restaurada_en` y O2 el relleno desde `_copia_base`. Como O2 va después, borraba lo de N5: en
  la base integrada la protección de N5 quedaba apagada sin aviso (fallaba N5-1). Ahora la función es la unión de
  las dos y está escrita **idéntica, letra por letra**, en `notas/05_restaurada_protegida.sql` y en
  `otros/02_papelera_copia_base.sql` (md5 `2be077c3c0effa5a572eb9601702b61f`, ver V06/V07). Así el orden y volver a correr cualquiera de
  los dos dan la misma función. O2 además asegura la columna con `add column if not exists`, para seguir funcionando
  solo. Los dos runners de los paquetes siguen en verde por separado (ver «Pruebas»).
- **Revisión de datos y de operación (20 oct, tarde): 8 hallazgos, 6 arreglados en la base y 2 que se quedan como
  están (con el porqué).** Todos se reprodujeron antes de tocar nada; cada arreglo tiene su prueba y su mutante.
  1. *N5 · sellos heredados (R1, media).* Cuando corre `pl_restaurada_protegida`, `pl_by_monotono` y
     `pl_checklist_sin_perdidas` ya copiaron a NEW los sellos `by` de OLD. Si alguien corregía una caja en los 10 min
     del reingreso, la nota vacía de la cola heredaba ese sello y la caja contaba como «borrada a propósito»: se
     perdía la corrección y, con menos de 3 cajas, se vaciaba toda la nota. Ahora solo es deliberado un sello que el
     guardado trae **nuevo** (posterior a la restauración y distinto del de OLD). Pruebas N5-13 y N5-14.
  2. *N3 · lápidas viejas (R3, media).* `__lab_deleted` vive para siempre en el checklist y la app no la quita
     cuando la fecha vuelve a llenarse. Una copia vieja borraba así los resultados nuevos de esa fecha. Ahora la
     lápida solo vale si es de ese guardado (no estaba en OLD) o si `__lab_deleted_labs[fecha]` es lo que la base
     tiene hoy. Pruebas N3-8 y N3-9.
  3. *O2 · lo vaciado a propósito revivía en el reingreso (R4, baja).* `restore_note_from_archive` ya no rellena
     desde `_copia_base` una caja que el equipo cambió después de la versión de la base (su sello `by` es más nuevo),
     ni la 🌙 Guardia en ese caso, ni una fecha de labs que borró con «Eliminar labs» (misma regla que N3). Una copia
     atrasada se sigue rellenando como antes. Prueba P2-13. **Límite:** sin sello no se puede saber. La copia de la
     reproducción de los revisores (`rev_datos/r4_o2_vaciado_revive.sql`) no trae el sello que sí pone la app
     (`_touchBy` en `updateField`, index.html:21213), y con ella `pendientes` sigue reviviendo. Es igual que hoy en
     producción con la regla de P1-06.
  4. *O2 · cada alta del robot se guardaba dos veces (baja).* La copia del robot (`noteForArchive_`) no trae
     `cronologia`. Ahora una llave que la copia no trae y que en la base está vacía no cuenta como diferencia. Si la
     base sí tiene Cronología, la copia se agrega: es justo lo que le falta (P2-14 y P2-14b). La propuesta de ignorar
     **toda** llave ausente se descartó, porque una copia `{}` de la app se quedaría sin `_copia_base` y fallaría
     P2-9 (lo mostró el mutante M02n). En producción hoy, 7 de 47 notas tienen Cronología, y las 7 tienen su copia
     idéntica en `cronologia_respaldo` (SELECT del 20 oct).
  5. *N4 · el «touch» de mantenimiento daba UPDATE 0 (baja).* `pl_zz_sin_cambios` ahora respeta
     `pl.entrega_libre`, como los demás triggers, después de limpiar la marca. Pruebas N4-10 y N4-11. Los procesos de
     la base que usan el permiso (`restore_note_from_archive`, `pl_guardia_a_cronologia`) siempre cambian algo, así
     que para ellos no cambia nada.
  6. *R06 borraba `notes.restaurada_en` (baja).* Ahora la columna se queda y la borra R99. Además, las reversas que
     toman candado de tabla (R02, R04–R09, R99) llevan `lock_timeout` de 5 s, como R12.
  7. *N2 · otra cuenta en el MISMO iPad no puede quitar en 15 min un renglón de la Guardia de la primera (baja):
     se queda como está.* `deviceLabel()` (index.html:10536-10544) manda «iPad Safari», «Mac Chrome»… salvo que la
     persona le ponga nombre al equipo. Así, la base no distingue un iPad compartido de dos Mac distintas con la
     misma etiqueta y otra cuenta, que es justo el caso que N2 protege (en producción hay 2 usuarios con la misma
     huella). Se puede corregir cuando cada guardado lleve un id propio del equipo (P1-02, app). Ver el paso 3.
  8. *O4 · «Borrar hechos» y «Vaciar procedimientos» con más de 5 filas se deshacen sin aviso en la app (baja): la
     base se queda como está; el arreglo va en la app.* Ver el paso 9 y «Riesgos y pendientes».
- **Revisado, sin conflicto:**
  - *N4 (`pl.modificado`) con los triggers de O.* Ningún archivo O agrega un BEFORE UPDATE en `notes`, así que
    `pl_zz_sin_cambios` sigue siendo el último antes de `trg_notes_updated`. Los AFTER (`pl_audit` de O1,
    `pl_cronologia_guardar_copia`) no corren cuando se suprime un UPDATE vacío, que es justo lo que se busca. La
    marca no se queda encendida después del guardado, ni siquiera cuando el UPDATE lo hace la restauración de O2 en
    el reingreso (INT-1c, INT-1d).
  - *O1 con N2.* Las dos reglas se complementan. O1 deja una fila de bitácora por equipo (usuario + dispositivo +
    navegador), y N2 trata como ajeno lo de otro equipo **u** otro usuario. Probado con la misma cuenta en iPad y Mac
    y otra persona en el mismo iPad (INT-3a/b/c). Lo propio se puede quitar; lo ajeno de los últimos 15 min, no.
- **Pruebas en la base integrada (`b_final`):** 189 pruebas SQL en verde (14 archivos) + la equivalencia de O5 (4
  ráfagas) + la prueba de la app (node, 4). Mutantes: 51 de 51 de «notas» (sin los 2 de N6), 54 de 54 de «otros» y 7
  de 7 de integración. Cada reversa corre sola sin romper lo demás. Todas juntas dejan la base con la **misma huella
  que producción**.

## Antes de empezar

1. **Correr V00 (precondición, solo lectura).** Tiene que dar `ok = true`: confirma que producción no cambió desde
   que se armó la réplica. Revisa el md5 de las 23 funciones que estas migraciones reemplazan o usan, los triggers
   de `notes`, `patients`, `archive`, `no_olvidar` y `procedimientos_dia`, que no exista ningún objeto nuevo, los
   permisos de O6 y REPLICA IDENTITY DEFAULT. **Si da `false`, no aplicar nada**: la réplica ya no representa a
   producción y hay que volver a probar.
2. **Cómo aplicar.** Cada archivo completo, en su propia transacción (MCP `apply_migration` o el editor SQL). Ninguno
   usa comandos de psql. Recomendado: anteponer `set local lock_timeout = '5s';` dentro de la misma transacción del
   archivo (con `apply_migration` ya lo es; en el editor, con `begin;` … `commit;` alrededor). Los `create trigger`,
   `drop trigger if exists` y `alter table … add column` toman un candado breve sobre la tabla; sin `lock_timeout`,
   un guardado largo los haría esperar y los guardados de la app harían fila detrás. Si se agota, se vuelve a correr
   (todos se pueden volver a correr).
3. **Después de cada archivo**, su consulta Vxx (solo lectura) debe dar `ok = true`, y las de los pasos anteriores
   deben seguir en `true`. La consulta «todas juntas» del final de `verificacion_por_paso.sql` da una fila por paso.
4. **La app no cambia.** Lo que nota la app está en cada paso (sobre todo O4 y O6).

**Verificación V00** (solo lectura; ANTES del paso 1 debe dar `ok = true`):

```sql
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
```

## Lista exacta (en este orden)

> **Aplicado en producción el 20 oct 2026** (migraciones `blindaje_01_audit_por_equipo` … `blindaje_12_replica_full`),
> con un ajuste después del paso 9: `otros/04b_borrado_masivo_solo_censo.sql` (el freno de borrado masivo queda solo en
> `patients` y `notes`). Por ese ajuste, V09 da `false` en producción a propósito.

| # | Archivo | Qué cambia | Verificación | Reversa |
|---|---------|------------|--------------|---------|
| 1 | `otros/01_audit_por_equipo.sql` | `pl_audit`: fusiona solo ediciones del mismo usuario + dispositivo + navegador; sin usuario, nunca | V01 | `reversas/R01_O1_audit_por_equipo.sql` |
| 2 | `notas/01_by_monotono.sql` | trigger `pl_by_monotono`: los sellos `by` de cada caja solo avanzan | V02 | `reversas/R02_N1_by_monotono.sql` |
| 3 | `notas/02_guardia_otro_usuario.sql` | `pl_entrega_protegida`: en la 🌙 Guardia, «otro equipo» también es otro usuario | V03 | `reversas/R03_N2_guardia_otro_usuario.sql` |
| 4 | `notas/03_labs_sin_perdidas.sql` | trigger `notes_preserve_lab_history`: una copia vieja ya no borra fechas de labs | V04 | `reversas/R04_N3_labs_sin_perdidas.sql` |
| 5 | `notas/04_sin_cambios.sql` | `notes_sin_cambios_labs` + `pl_zz_sin_cambios`: una reescritura idéntica no genera UPDATE, Realtime ni bitácora | V05 | `reversas/R05_N4_sin_cambios.sql` |
| 6 | `notas/05_restaurada_protegida.sql` | `notes.restaurada_en` + `pl_restaurada_protegida` + la función unida `restore_note_from_archive` | V06 | `reversas/R06_N5_restaurada_protegida.sql` |
| 7 | `otros/02_papelera_copia_base.sql` | Papelera con `_copia_base`, la misma función unida, `archive_eliminados` | V07 | `reversas/R07_O2_papelera_copia_base.sql` |
| 8 | `otros/03_listas_compartidas.sql` | copia al borrar de No olvidar y Procedimientos; respaldo horario de las listas y de `guard_info` | V08 | `reversas/R08_O3_listas_compartidas.sql` |
| 9 | `otros/04_borrado_masivo.sql` | borrar más de 5 filas de un jalón queda solo para el administrador | V09 | `reversas/R09_O4_borrado_masivo.sql` |
| 10 | `otros/05_alarma_perdidas.sql` | `pl_detectar_perdidas` ve todas las cajas, por equipo, con ventana móvil | V10 | `reversas/R10_O5_alarma_perdidas.sql` |
| 11 | `otros/06_permisos.sql` | quita EXECUTE de historial v1/v2 a la app y de `indicaciones_*` a PUBLIC/anon | V11 | `reversas/R11_O6_permisos.sql` |
| 12 | `notas/06_replica_full.sql` | `notes` en REPLICA IDENTITY FULL (solo producción; exige N4 activo) | V12 | `reversas/R12_N6_replica_full.sql` |

**No aplicar** en producción ningún otro archivo de `notas/` ni de `otros/`: los `*_pruebas.sql`, `bateria_adaptada.sql`,
`05_reproduccion_19oct.sql` (consulta de solo lectura) y `06_app_historial.js` son pruebas.

Cada reversa termina con un SELECT que debe dar `ok = true`. Después de correrla, la Vxx de su paso vuelve a `false` y
las demás siguen en `true`. Las reversas **no borran datos**: las tablas y columnas nuevas, con lo que tengan, se
quedan, también `notes.restaurada_en` (R06 ya no la borra). Borrarlas es `reversas/R99_limpieza_datos.sql`, que es
opcional y se detiene si todavía hay algo que escribe en ellas. Las reversas que quitan triggers o tocan tablas (R02,
R04–R09, R12 y R99) llevan `lock_timeout` de 5 s: si se agota, se vuelven a correr.

## Paso por paso

### 1 · O1 · `otros/01_audit_por_equipo.sql`

`pl_audit` junta en una fila de la bitácora las ediciones seguidas (5 min) de la misma caja. Antes buscaba la fila
solo por usuario, y el iPad atrasado se «tragaba» la versión que la Mac de la misma cuenta acababa de escribir: la
Mac desaparecía del 🕘 y la regla de la Guardia no la protegía. Ahora solo fusiona dentro del mismo usuario +
dispositivo + navegador. Solo cambia una función: sin candados de tabla.

**Verificación V01** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_audit()', array['3d4bcbc765556fb312c7fd231ffc1f15'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V01 · O1 · otros/01_audit_por_equipo.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;
```

**Reversa:** `reversas/R01_O1_audit_por_equipo.sql` (vuelve `pl_audit` a la de producción, md5 `5604b951…`). Si se
revierte solo este paso, fallan sus pruebas e INT-3a, que es justo lo que arregla.

### 2 · N1 · `notas/01_by_monotono.sql`

Trigger `BEFORE UPDATE OF checklist` en `notes`. Una copia vieja ya no puede regresar el sello `by` (quién/cuándo)
de ninguna caja. Con el sello regresado, `pl_entrega_protegida` tomaba por deliberada una escritura atrasada que
resucitaba lo borrado. Un sello de más de 10 min en el futuro (reloj adelantado) no se defiende. Con
`pl.entrega_libre` no hace nada. Crea `pl_sello_t(jsonb)`, que también usa N5.

**Verificación V02** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R02_N1_by_monotono.sql` (quita el trigger y la función; `pl_sello_t` solo si N5 ya no está).
Si se revierte solo este paso, fallan solo sus pruebas.

### 3 · N2 · `notas/02_guardia_otro_usuario.sql`

`pl_entrega_protegida`: en una escritura deliberada de la 🌙 Guardia, lo que otro equipo **u otro usuario** escribió
en los últimos 15 min se respeta (dos residentes en «Mac Chrome» contaban como uno). El usuario sale de `auth.uid()`
en un bloque protegido: con claims vacíos o corruptos queda en null y el guardado no se rompe. Lleva las marcas
`pl.modificado` que lee N4. Solo cambia una función.

**En un iPad compartido** (20 oct 2026, revisión de datos): si otra cuenta borra a propósito un renglón que la primera
escribió hace menos de 15 min, el renglón se repone. Pasa lo mismo que entre equipos distintos (S1b), y no se pierde
nada: el renglón se puede quitar pasados los 15 min, o lo quita su autor. La base no lo puede evitar todavía: la
etiqueta del equipo (`deviceLabel()`, index.html:10536) es genérica («iPad Safari») salvo que se le ponga nombre, así
que un iPad compartido se ve igual que dos equipos con la misma etiqueta. Se resuelve con el id de equipo de P1-02
(app). Mientras tanto, conviene anotarlo en la guía de uso de la Guardia.

**Verificación V03** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
with faltas as (
  select format('función %s: md5 %s', v.f, coalesce(x.m, 'NO EXISTE')) as falta
    from (values ('public.pl_entrega_protegida()', array['1a1fd0080442741748cf3608f42fb8d3'])) v(f, ms)
    left join lateral (select md5(prosrc) as m from pg_proc where oid = to_regprocedure(v.f)) x on true
   where not coalesce(x.m = any (v.ms), false)
)
select 'V03 · N2 · notas/02_guardia_otro_usuario.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;
```

**Reversa:** `reversas/R03_N2_guardia_otro_usuario.sql` (la de producción, md5 `0e4ee94a…`). Si se revierte solo
este paso con N4 puesto, una Guardia revertida por la protección deja de reenviarse al equipo que mandó la copia
vieja, pero no se pierde nada. Fallan N2, N4-3 e INT-3b.

### 4 · N3 · `notas/03_labs_sin_perdidas.sql`

Trigger `BEFORE UPDATE OF lab_history`. Una fecha que ya estaba y no viene en la lista nueva se conserva. Solo se
quita si viene en `checklist.__lab_deleted` del mismo guardado («Eliminar labs»): la lápida no estaba ya en la base, o
`__lab_deleted_labs[fecha]` (lo que la persona veía al borrar) es lo que la base tiene hoy en esa fecha. Una lápida
vieja heredada ya no deja que una copia vieja borre resultados nuevos de esa fecha (revisión de datos, R3). Si un
equipo atrasado vuelve a borrar una fecha que ya tenía lápida y sus labs no son los de hoy, la fecha se queda: no se
pierde nada, y se borra desde un equipo al día. Un null en `__lab_deleted` se ignora. Con `pl.entrega_libre` no
hace nada.

**Verificación V04** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R04_N3_labs_sin_perdidas.sql`. Si se revierte solo este paso, fallan N3, N4-7 e INT-1b (la
nota vacía de la cola vuelve a vaciar los labs).

### 5 · N4 · `notas/04_sin_cambios.sql`

Si un guardado no trae nada nuevo (labs iguales en otro orden u otras marcas de sync, upsert idéntico salvo
`updated_by`), no hay UPDATE, ni evento Realtime, ni fila de bitácora, ni `updated_at` nuevo. Era el 77 % de lo que se
escribía. Si una protección cambió lo que mandó el cliente (marca `pl.modificado`), el UPDATE sí va, para que el
equipo atrasado reciba la fila buena. Con `set_config('pl.entrega_libre','on',true)` (mantenimiento por SQL) no se
suprime nada: el «touch» `update notes set updated_at = now() where …`, que sirve para que `respaldo_hora` vuelva a
copiar una nota o para que Realtime la reenvíe, da UPDATE 1 como siempre (revisión de operación, M1). El bloque
inicial exige N1, N2 y N3 aplicados.

**Verificación V05** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R05_N4_sin_cambios.sql` (quita los dos triggers y vuelve `pl_checklist_sin_perdidas` a la de
producción). Se detiene si N6 está aplicado: correr antes R12. Si se revierte solo este paso, fallan N4 e INT-2.

### 6 · N5 · `notas/05_restaurada_protegida.sql`

`notes.restaurada_en`. Durante 10 min después de un reingreso, un guardado que vacía a la vez 3 o más cajas con
contenido, sin un sello **nuevo** en ese guardado (posterior a la restauración y distinto del que ya tenía la base),
conserva esas cajas (nunca casillas, nunca caja por caja). Un sello que el guardado solo heredó de la base no cuenta.
Así, lo que alguien corrigió en esos 10 min también se conserva frente a la nota vacía de la cola (R1). Incluye
la función **unida** `restore_note_from_archive`. `alter table … add column` sin default: solo catálogo, candado de
milisegundos.

**Verificación V06** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R06_N5_restaurada_protegida.sql`. Si O2 sigue puesto, deja la función de O2 sin
`restaurada_en` (md5 `1ccfd92d…`); si no, la de producción (`e43e4481…`). La columna `notes.restaurada_en`
**se queda** (solo guarda la hora de la última restauración; ya nadie la escribe ni la lee): la borra R99. Si se
revierte solo este paso, fallan N5 e INT-1a.

### 7 · O2 · `otros/02_papelera_copia_base.sql`

Si la app archivó su copia hace menos de 5 min, `archive_before_delete` le agrega `_copia_base` (la nota de la
base), y el reingreso llena con ella las cajas vacías de la copia del equipo. No llena las que el equipo vació **después**
de la versión de la base (su sello `by` es más nuevo), ni la Guardia en ese caso, ni las fechas de labs que borró con
«Eliminar labs» (R4). Si la copia del equipo solo difiere en llaves que no trae y que en la base están vacías (la
copia recién leída del robot del censo no trae `cronologia`), no se agrega `_copia_base`: una alta del robot ya no
guarda la nota dos veces. Si la base sí tiene Cronología, se agrega (M2). Borrar algo de la Papelera deja antes la
fila completa en `archive_eliminados`, que solo lee el administrador. Si no se puede guardar esa copia, el borrado no
se hace. Lleva la misma función unida que N5 (por eso V07 vuelve a revisar su md5).

**Verificación V07** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R07_O2_papelera_copia_base.sql` (vuelve `archive_before_delete` a la de producción y quita el
trigger de la Papelera). Con N5 puesto, la función unida se queda: su parte de `_copia_base` no hace nada sin este
`archive_before_delete`. La tabla `archive_eliminados` se queda (R99). Si se revierte solo este paso, fallan O2 e
INT-1a.

### 8 · O3 · `otros/03_listas_compartidas.sql`

Copia obligatoria, en `borrados_otros`, de cada fila que se borre de No olvidar y de Procedimientos del día. Además,
`pl_respaldo_hora` (cron del minuto 7) copia a `respaldo_hora_otros` lo que cambió de esas dos listas y de
`guard_info`, con 7 días. Si esa parte falla, el respaldo de notas y pacientes de esa hora sí queda.

**Verificación V08** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R08_O3_listas_compartidas.sql` (`pl_respaldo_hora` de producción; quita los triggers). Las
tablas se quedan (R99). Si se revierte solo este paso, falla solo O3.

### 9 · O4 · `otros/04_borrado_masivo.sql`

Trigger por sentencia en `patients`, `notes`, `no_olvidar` y `procedimientos_dia`. Si una cuenta que no es
administrador borra más de 5 filas de un jalón, la sentencia se deshace con un mensaje claro (P0001 → HTTP 400, que
la app no reintenta). Quedan exentos service_role (robots), postgres sin JWT (crons) y `pl.entrega_libre`. En la app,
para cuentas normales: «🔥 BORRAR TODO» ya no borra la nube, «Eliminar especialidad» muestra el error, y «Borrar
hechos» o «Borrar procedimientos del día» con más de 5 se quedan en la nube.

**Pendiente en la app** (20 oct 2026, revisión de datos): con más de 5 filas, «Borrar hechos» (`supaRemoveDoneNoOlvidar`,
index.html:22404-22408) y el vaciado de Procedimientos del día (index.html:25046-25050) solo dejan el 400 en la
consola. La persona ve la lista vacía, y al recargar, o en los otros equipos, vuelven los renglones. No se pierde
nada, pero un borrado legítimo se revierte sin aviso. Arreglo en la app: mostrar el mensaje del 400 («Borrado masivo
bloqueado…») y volver a pintar la lista desde la nube. La base no exime `done = true`, porque O4 está para que un solo
clic no vacíe una lista que comparte todo el piso, y «Borrar hechos» borra los hechos de todos. Además, cualquier
cuenta podría marcar todo como hecho con un PATCH y luego borrarlo con un DELETE.

**Verificación V09** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R09_O4_borrado_masivo.sql`. Si se revierte solo este paso, falla solo O4.

### 10 · O5 · `otros/05_alarma_perdidas.sql`

`pl_detectar_perdidas` (cron «alarma-perdidas») ve todas las cajas del checklist (Cirugías, pase, NPT, casillas…),
agrupa por usuario + dispositivo + navegador y usa una ventana móvil de 2 min. Así vería la ráfaga del 19/10. Agrega
`perdidas_alerta.user_id` y `.ua`.

**Verificación V10** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R10_O5_alarma_perdidas.sql` (la de producción, md5 `0d371120…`). Las columnas se quedan (R99).
Si se revierte solo este paso, fallan O5 y la equivalencia.

### 11 · O6 · `otros/06_permisos.sql`

`pl_historial_caja` (v1) y `_v2` ya no se ejecutan como authenticated: la app usa siempre la v3, comprobado con
node sobre el `index.html` publicado. `indicaciones_fetch` e `indicaciones_collect` ya no se ejecutan para PUBLIC ni
anon, que podían disparar la descarga del Doc. Siguen los crons (postgres) y service_role.

**Verificación V11** (solo lectura; después de aplicar este archivo debe dar `ok = true`):

```sql
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
```

**Reversa:** `reversas/R11_O6_permisos.sql`. Devuelve los permisos en el **mismo orden**, así el ACL queda letra por
letra como en producción. Si se revierte solo este paso, falla solo O6.

### 12 · N6 · `notas/06_replica_full.sql` (solo producción, al final)

`notes` en REPLICA IDENTITY FULL, para que el evento de Realtime traiga la fila completa (hoy llegan sin
`lab_history` ni `checklist` cuando no cambiaron). **No se probó contra Realtime**: localmente no hay Realtime ni
`wal_level=logical`, así que en la base integrada no se aplicó. Exige `pl_zz_sin_cambios` activo, por eso va después
de N4. `lock_timeout` de 5 s dentro del archivo. Conviene aplicarlo cuando alguien pueda mirar la app en dos equipos:
cambiar una caja grande en uno y ver que el otro recibe la nota completa.

**Verificación V12** (solo lectura; después de aplicar N6 debe dar `ok = true` (en la réplica local da `false`: N6 no se aplica)):

```sql
with faltas as (
  select 'notes.relreplident = ' || c.relreplident::text || ' (se esperaba f = FULL)' as falta
    from pg_class c where c.oid = 'public.notes'::regclass and c.relreplident <> 'f'
)
select 'V12 · N6 · notas/06_replica_full.sql' as paso, count(*) = 0 as ok, coalesce(string_agg(falta, ' · '), 'todo en su lugar') as detalle from faltas;
```

Su prueba de catálogo (`notas/06_replica_full_pruebas.sql`, solo lectura y rollback) se puede correr después;
`todo_pruebas.sql` la corre sola si `notes` ya está en FULL.

**Reversa:** `reversas/R12_N6_replica_full.sql` (`replica identity default`, un minuto, sin pérdida de datos).

### Al terminar: todas juntas

Una fila por paso. Con los 11 aplicados: V01…V11 en `true` y V12 en `false` hasta que se aplique N6.

```sql
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
```

## Volver atrás

- **Un solo paso:** su `reversas/Rxx_….sql`. Cada una se probó sola sobre la base integrada con los otros 10 pasos
  puestos: su Vxx pasa a `false`, las otras 10 siguen en `true`, y solo fallan las pruebas que dependen de ese paso
  (las anotadas arriba). R06 y R07 eligen solas la versión de `restore_note_from_archive` según lo que siga
  instalado, y R02, R07 y R08 solo borran `pl_sello_t` o `pl_quien` si nadie más las usa.
- **Todo:** R12, R11, R10, …, R01 (de la última a la primera) y, si ya no se quieren los datos nuevos, R99. Probado:
  la base queda con la **misma huella por objeto que `replica_prod`**, que es idéntica a producción hoy (259 objetos:
  funciones con su ACL, triggers, tablas, columnas, políticas, índices…). `valsql/pruebas.sql` da 28, V00 vuelve a `true` y V01…V12 a `false`.
  Volver a correr las 13 reversas no da errores.

## Pruebas (números)

Para correrlo todo de nuevo: `DB_INTEGRADA=b_final db_blindaje/correr_integrado.sh` (deja `correr_integrado.log`).
Solo las pruebas: `psql … -d b_final -f db_blindaje/todo_pruebas.sql`.

- **Paso a paso** (copia nueva de `replica_prod`). Antes de cada archivo su Vxx daba `false`; después, V01…Vxx
  `true`. En cada paso se corrieron las pruebas de lo ya instalado y la batería de producción: todas en verde en los
  11 pasos.
- **Idempotencia:** volver a correr los 11 deja la misma huella del esquema.
- **Todas juntas** (`todo_pruebas.sql`, 15 archivos en verde):

  | Archivo | Pruebas |
  |---|---|
  | `valsql/pruebas.sql` (🌙 Guardia y 🕓 Cronología, la batería original) | 28 |
  | `notas/bateria_adaptada.sql` | 28 |
  | N1 · N2 · N3 · N4 · N5 | 10 · 5 · 9 · 11 · 14 |
  | O1 · O2 · O3 · O4 · O5 · O6 | 9 · 16 · 13 · 12 · 16 · 9 |
  | `integrada/integracion_pruebas.sql` (INT-1a…d, INT-2a/b, INT-3a/b/c) | 9 |
  | **Total SQL** | **189** (180 + las 9 nuevas de la revisión: N3-8/9, N4-10/11, N5-13/14, P2-13, P2-14, P2-14b) |
  | equivalencia O5 (consulta de la reproducción del 19/10 = `pl_detectar_perdidas`) | 4 ráfagas iguales |
  | `otros/06_app_historial.js` (node, sobre `main-ro/index.html`) | 4 |

- **Sin las migraciones** (copia limpia de `replica_prod`): solo pasan las dos baterías de producción. Las 13 pruebas
  nuevas fallan: prueban algo que hoy no está.
- **Mutantes en la base integrada:** «notas» 51 de 51 (se omiten M6-1 y M6-2 porque N6 no se aplica aquí), «otros» 54
  de 54 y de integración 7 de 7: sin `restaurada_en`, sin `_copia_base`, `pl_zz` que nunca suprime o no limpia la
  marca, `pl_audit` y `pl_entrega_protegida` de producción, y N5 sin marca. La huella queda igual antes y después.
  Los 15 nuevos de la revisión: M3-8/9 (lápida vieja obedecida, lápida previa nunca válida), M4-10/11 (suprime con el
  permiso, permiso antes de limpiar la marca), M5-13a/b y M5-14 (sello heredado cuenta en columnas o en el checklist,
  caja ya editada no se puede vaciar), M02i/j/k/l/o/p (el reingreso revive textos, checklist, labs o Guardia vaciados a
  propósito, obedece una lápida vieja, cualquier sello cuenta) y M02m/n (la copia del robot se duplica; se ignoran
  todas las llaves ausentes).
- **Cada paquete por separado, con los archivos cambiados:** `notas/correr_todo.sh` en verde (53 de 53 mutantes, N6
  incluido) y `otros/correr_todo.sh` en verde (56 de 56 mutantes: 54 de SQL + 2 de la app; sin las migraciones sus 6
  pruebas fallan y la batería pasa). Los logs anteriores quedaron en `*/correr_todo_antes_integracion.log`.
- **Las reproducciones de los revisores** (`rev_datos/`, `revision_operacion/03_…`), en la base con los arreglos:
  R1 conserva las 3 y las 4 cajas, también la corrección de A, y su control sigue protegiendo. R3 conserva el 18/10
  bueno, y su control (la Mac lo vuelve a borrar a propósito) lo quita. M1 da UPDATE 1. R2 (escritura normal, 11
  casos) da lo mismo antes y después. R4 y M2 usan cuerpos que no son los de la app (sin sello; checklist `{}` en vez
  del de la fila): con los cuerpos reales los cubren P2-13 y P2-14.

## Riesgos y pendientes

- **N6 sin probar contra Realtime** (ver el paso 12).
- **V00 dio `true` en producción el 20 oct a las 15:27 UTC**, pero hay que volver a correrlo justo antes del paso 1.
  Si algo cambió desde entonces, da `false` y dice qué.
- Las funciones auxiliares nuevas `pl_sello_t`, `pl_labs_normalizados` y `pl_caja_con_contenido` quedan con EXECUTE
  para PUBLIC (lo de siempre al crear una función). Son puras: no leen tablas, así que llamarlas por `/rpc` no expone
  nada. Si se quiere cerrar: `revoke execute on function … from public, anon;`.
- **App (paquete de arreglos de la app):** (a) avisar del 400 de O4 en «Borrar hechos» y en el vaciado de
  Procedimientos del día, y volver a pintar desde la nube (paso 9); (b) un id de equipo propio por instalación (P1-02),
  para que N2 deje quitar sin espera lo de otra cuenta en el mismo iPad (paso 3); (c) que «+ fecha» y los resultados
  nuevos del robot quiten la fecha de `__lab_deleted` (hoy la base lo resuelve con `__lab_deleted_labs`, R3).
- R4 depende del sello `by` de cada caja. Una copia del equipo sin sello (vieja o de antes de los sellos) se sigue
  rellenando desde la base, igual que con P1-06 sin el arreglo.
- N2: una fila de la bitácora **sin usuario** (robot o SQL) cuenta como ajena para cualquier usuario de la app. Un
  renglón que un mantenimiento por SQL agregue a la Guardia queda protegido 15 min contra el borrado deliberado desde
  la app. No se pierde nada; solo hay que esperar.
- Con la función unida, todo reingreso escribe `restaurada_en`. Si la nota ya existía (rama UPDATE), el UPDATE de la
  restauración siempre va: un evento Realtime y una fila de bitácora con el campo `restaurada_en`, aunque no haya caja
  vacía que llenar. Antes, N4 lo habría suprimido.
- En el entorno donde se probó, la carpeta temporal del Postgres local perdía el permiso de paso entre comandos y el
  servidor caía en el siguiente checkpoint; los runners lo abren mientras corren. Es un detalle de ese entorno de
  pruebas, no de la base.
