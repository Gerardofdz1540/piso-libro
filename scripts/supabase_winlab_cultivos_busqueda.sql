-- 17 oct 2026 · aplicado en producción (migración winlab_cultivos_busqueda).
-- La vista winlab_cultivos une los cultivos con patients por EXPEDIENTE y repite cada cultivo por cada
-- cama con ese exp; no decía a QUIÉN pertenece. Se agrega al final la columna `busqueda` (el nombre de
-- winlab_labs.paciente, la persona que el robot encontró en WinLab) para que la app solo muestre en una
-- tarjeta los cultivos de esa persona: con un expediente repetido en la hoja, o justo después de
-- corregirlo, los cultivos viejos de la otra persona no aparecen en la tarjeta equivocada.
-- Misma definición que antes (mismas columnas, en el mismo orden) + `busqueda` al final.
create or replace view public.winlab_cultivos with (security_invoker = true) as
 WITH elems AS (
         SELECT w.id,
            w.exp,
            w.fecha,
            w.paciente AS busqueda,
            r.value AS rep,
            r.ord
           FROM winlab_labs w,
            LATERAL jsonb_array_elements(w.data -> 'reportes'::text) WITH ORDINALITY r(value, ord)
        ), headers AS (
         SELECT elems.id,
            elems.ord,
            upper(translate(regexp_replace(btrim((COALESCE(elems.rep ->> 'APELLIDOS COMPLETOS'::text, ''::text) || ' '::text) || COALESCE(elems.rep ->> 'NOMBRE'::text, ''::text)), '\s+'::text, ' '::text, 'g'::text), 'ÁÉÍÓÚÜÑáéíóúüñ'::text, 'AEIOUUNAEIOUUN'::text)) AS hdr_name
           FROM elems
          WHERE (elems.rep ->> '__hasLink'::text) = 'false'::text AND (elems.rep ->> 'NOMBRE'::text) IS NOT NULL AND (elems.rep ->> 'NOMBRE'::text) !~ '^\s*\d'::text AND (elems.rep ->> 'APELLIDOS COMPLETOS'::text) IS NOT NULL AND (elems.rep ->> 'APELLIDOS COMPLETOS'::text) !~ '^\s*\d'::text AND (elems.rep ->> 'APELLIDOS COMPLETOS'::text) <> 'INICIO PAGINA'::text
        ), attributed AS (
         SELECT e.id,
            e.exp,
            e.fecha,
            e.busqueda,
            e.rep,
            ( SELECT h.hdr_name
                   FROM headers h
                  WHERE h.id = e.id AND h.ord < e.ord
                  ORDER BY h.ord DESC
                 LIMIT 1) AS hdr
           FROM elems e
          WHERE upper(e.rep::text) ~~ '%CULTIVO%'::text
        ), culture_reportes AS (
         SELECT a.exp,
            a.fecha,
            p.cama,
            p.nombre,
            a.busqueda,
            ( SELECT string_agg(DISTINCT btrim((((((COALESCE(v.value ->> 'estudio'::text, ''::text) || ' '::text) || COALESCE(v.value ->> 'valor'::text, ''::text)) || ' '::text) || COALESCE(v.value ->> 'unidad'::text, ''::text)) || ' '::text) || COALESCE(v.value ->> 'referencia'::text, ''::text)), ' '::text) AS string_agg
                   FROM jsonb_array_elements(a.rep -> 'valores'::text) v(value)) AS texto
           FROM attributed a
             LEFT JOIN patients p ON p.exp = a.exp
          WHERE a.hdr IS NULL OR a.busqueda IS NULL OR btrim(a.busqueda) = ''::text OR NOT (EXISTS ( SELECT 1
                   FROM unnest(string_to_array(upper(translate(regexp_replace(a.busqueda, '\s+'::text, ' '::text, 'g'::text), 'ÁÉÍÓÚÜÑáéíóúüñ'::text, 'AEIOUUNAEIOUUN'::text)), ' '::text)) tok(tok)
                  WHERE length(tok.tok) >= 3 AND POSITION((tok.tok) IN (a.hdr)) = 0))
        ), parsed AS (
         SELECT culture_reportes.exp,
            culture_reportes.fecha,
            culture_reportes.cama,
            culture_reportes.nombre,
            culture_reportes.busqueda,
            culture_reportes.texto,
            "substring"(culture_reportes.texto, '(?i)(?:escherichia|klebsiella|candida|staphylococc\w*|streptococc\w*|pseudomonas|enterococc\w*|acinetobacter|proteus|enterobacter|serratia|morganella|citrobacter|stenotrophomonas|salmonella|shigella|haemophilus|providencia)\s+\w+'::text) AS germen
           FROM culture_reportes
        )
 SELECT exp,
    cama,
    nombre,
    fecha,
        CASE
            WHEN texto ~* 'hemocultivo'::text THEN 'Hemocultivo'::text
            WHEN texto ~* 'urocultivo'::text OR texto ~* 'densidad'::text AND texto ~* 'esterasa'::text THEN 'Urocultivo'::text
            WHEN texto ~* 'peritoneal'::text THEN 'Cultivo liquido peritoneal'::text
            ELSE 'Cultivo'::text
        END AS tipo,
    germen,
        CASE
            WHEN germen IS NOT NULL THEN 'POSITIVO'::text
            ELSE 'Negativo'::text
        END AS resultado,
    texto AS texto_origen,
    busqueda
   FROM parsed
  WHERE germen IS NOT NULL OR texto ~* 'desarrollo negativo'::text;
