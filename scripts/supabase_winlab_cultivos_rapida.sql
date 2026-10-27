-- 27 oct 2026 · aplicado en producción (migración winlab_cultivos_rapida).
-- Aviso de Supabase del 24 oct: «running out of Disk IO Budget». La causa era esta vista: con la tabla intermedia
-- `elems` usada dos veces, Postgres la armaba COMPLETA (todos los reportes de los ~5 000 días de winlab_labs) antes de
-- aplicar el filtro de expediente y fecha que manda la app; cada consulta tardaba > 60 s, escribía ~120 MB de archivo
-- temporal a disco y PostgREST la cortaba a los 8 s (la caja «Cultivos (lab)» no recibía nada). 5 GB de temporales
-- en 2.5 días.
-- Misma salida (mismas columnas, en el mismo orden, mismas reglas de atribución por encabezado), pero calculada fila
-- por fila: el filtro `exp in (…) and fecha >= …` llega al índice winlab_labs_exp_fecha_key y solo se abren los días
-- pedidos. Medido en producción: 1.8 s, sin lectura de disco ni temporales; 147/147 filas idénticas a la vista
-- anterior para el censo y 45 días.
-- Además reconoce el encabezado de paciente en italiano u otro idioma por la celda de sexo de __cells (como el robot,
-- findSexIdx/extractHeaderName): antes solo por las llaves APELLIDOS COMPLETOS/NOMBRE en español.
create or replace view public.winlab_cultivos with (security_invoker = true) as
select w.exp,
       p.cama,
       p.nombre,
       w.fecha,
       case
         when x.texto ~* 'hemocultivo' then 'Hemocultivo'::text
         when x.texto ~* 'urocultivo' or (x.texto ~* 'densidad' and x.texto ~* 'esterasa') then 'Urocultivo'::text
         when x.texto ~* 'peritoneal' then 'Cultivo liquido peritoneal'::text
         else 'Cultivo'::text
       end as tipo,
       x.germen,
       case when x.germen is not null then 'POSITIVO'::text else 'Negativo'::text end as resultado,
       x.texto as texto_origen,
       w.paciente as busqueda
  from public.winlab_labs w
  cross join lateral (
    select t.texto,
           "substring"(t.texto, '(?i)(?:escherichia|klebsiella|candida|staphylococc\w*|streptococc\w*|pseudomonas|enterococc\w*|acinetobacter|proteus|enterobacter|serratia|morganella|citrobacter|stenotrophomonas|salmonella|shigella|haemophilus|providencia)\s+\w+'::text) as germen
      from jsonb_array_elements(w.data -> 'reportes') with ordinality e(rep, ord)
      -- Encabezado del bloque: el último renglón-encabezado antes del reporte. En español por las llaves
      -- APELLIDOS COMPLETOS/NOMBRE; en italiano (u otro idioma) por la celda de sexo de __cells, como el robot.
      left join lateral (
        select hn.nombre as hdr
          from jsonb_array_elements(w.data -> 'reportes') with ordinality h(rep, ord)
          cross join lateral (
            select coalesce(
              case when (h.rep ->> 'NOMBRE') is not null and (h.rep ->> 'NOMBRE') !~ '^\s*\d'
                    and (h.rep ->> 'APELLIDOS COMPLETOS') is not null and (h.rep ->> 'APELLIDOS COMPLETOS') !~ '^\s*\d'
                    and (h.rep ->> 'APELLIDOS COMPLETOS') <> 'INICIO PAGINA'
                   then btrim(coalesce(h.rep ->> 'APELLIDOS COMPLETOS', '') || ' ' || coalesce(h.rep ->> 'NOMBRE', '')) end,
              (select btrim(coalesce(h.rep -> '__cells' ->> (s.i::int - 3), '') || ' ' || coalesce(h.rep -> '__cells' ->> (s.i::int - 2), ''))
                 from jsonb_array_elements_text(case when jsonb_typeof(h.rep -> '__cells') = 'array' then h.rep -> '__cells' else '[]'::jsonb end) with ordinality s(v, i)
                where s.i >= 3
                  and upper(btrim(s.v)) ~ '^(FEMENIN[OA]|MASCULIN[OA]|FEMMIN[A-Z]*|MASCHI[A-Z]*|FEMALE|MALE|DONNA|UOMO|MUJER|HOMBRE|[FM])$'
                  and coalesce(h.rep -> '__cells' ->> (s.i::int - 3), '') !~ '^\s*(\d|$)'
                  and coalesce(h.rep -> '__cells' ->> (s.i::int - 3), '') <> 'INICIO PAGINA'
                order by s.i limit 1)
            ) as crudo
          ) hc
          cross join lateral (
            select upper(translate(regexp_replace(hc.crudo, '\s+', ' ', 'g'), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNAEIOUUN')) as nombre
          ) hn
         where h.ord < e.ord and (h.rep ->> '__hasLink') = 'false' and hc.crudo is not null
         order by h.ord desc
         limit 1
      ) hdr_l on true
      cross join lateral (
        select string_agg(distinct btrim(coalesce(v.value ->> 'estudio', '') || ' ' || coalesce(v.value ->> 'valor', '') || ' ' || coalesce(v.value ->> 'unidad', '') || ' ' || coalesce(v.value ->> 'referencia', '')), ' ') as texto
          from jsonb_array_elements(e.rep -> 'valores') v(value)
      ) t
     where upper(e.rep::text) like '%CULTIVO%'
       and (hdr_l.hdr is null or w.paciente is null or btrim(w.paciente) = ''
            or not exists (select 1
                             from unnest(string_to_array(upper(translate(regexp_replace(w.paciente, '\s+', ' ', 'g'), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNAEIOUUN')), ' ')) tok(tok)
                            where length(tok.tok) >= 3 and position(tok.tok in hdr_l.hdr) = 0))
  ) x
  left join public.patients p on p.exp = w.exp
 where x.germen is not null or x.texto ~* 'desarrollo negativo'
;
