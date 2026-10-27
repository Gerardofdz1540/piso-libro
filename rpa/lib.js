// Funciones puras del scraper (sin dependencia de Playwright/Supabase).
// Separadas para poder testearlas con `node scraper.test.js` sin instalar
// las dependencias pesadas.

export const N = (s) =>
  String(s || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// Fecha "de hoy" en la zona del hospital (León, UTC-6, sin horario de verano), no en la del
// runner: GitHub Actions corre en UTC y la corrida de las 20:00 León caía en el día siguiente,
// partiendo los reportes de un mismo día en dos filas (exp,fecha). Tuneable con WL_TZ.
export const todayISO = (tz = process.env.WL_TZ || "America/Mexico_City", now = new Date()) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch (_) {
    const off = now.getTimezoneOffset() * 60000;
    return new Date(now - off).toISOString().slice(0, 10);
  }
};

const ALLOWED_ESPS = new Set([
  "CG", "CCR", "CT", "CTV", "CPR", "CV", "CMF",
  "CG/GYO", "CG/CV", "GYO/CG", "CV/CG", "URG", "URGENCIAS",
]);
const EXCLUDED_ESPS = new Set([
  "NCX", "URO", "GYO", "TYO", "ONCOCIRUGIA", "ONCO",
  "COLUMNA", "ENDOS", "NEUROCX", "ORTOPEDIA", "TRAUMA",
]);
export function isAllowedEsp(esp) {
  // esp vacío en la hoja ≠ "no buscar": el paciente está en el censo y necesita labs igual.
  // (antes `if (!e) return false` lo dejaba sin labs en silencio, 3 corridas al día)
  // 24 jun 2026 — Gera: "TODOS los pacientes deben tener laboratorios". El censo (tabla
  // `patients`) YA es el piso quirúrgico activo; no hay razón para excluir por servicio.
  // Antes se excluían NCX/URO/TYO/GYO/TRASPLANTES/etc. y esos pacientes quedaban SIN labs
  // en su tarjeta (caso real: 18 pacientes nunca buscados + nombre incompleto). Ahora se
  // procesa TODO el censo con esp no vacío. Los sets ALLOWED_ESPS/EXCLUDED_ESPS se conservan
  // solo como documentación histórica (ya no filtran).
  return true;
}

export function formatDate(date, fmt = "dd/MM/yyyy") {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return fmt.replace("dd", dd).replace("MM", mm).replace("yyyy", yyyy);
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Deduplica records por la clave de conflict (default "exp,fecha"). Si hay
// duplicados (ej. tu censo tiene 2 pacientes con el mismo expediente),
// merge los reportes en una sola fila para evitar el error 21000 de
// Postgres "ON CONFLICT DO UPDATE command cannot affect row a second time".
export function dedupRecords(records, conflictCols = "exp,fecha") {
  const keys = conflictCols.split(",").map((s) => s.trim()).filter(Boolean);
  const map = new Map();
  for (const r of records) {
    const k = keys.map((c) => String(r[c] || "")).join("|");
    if (!map.has(k)) {
      map.set(k, r);
      continue;
    }
    const prev = map.get(k);
    const prevReportes = (prev.data && Array.isArray(prev.data.reportes)) ? prev.data.reportes : [];
    const currReportes = (r.data && Array.isArray(r.data.reportes)) ? r.data.reportes : [];
    const seen = new Set();
    const dedupReportes = [];
    for (const rep of [...prevReportes, ...currReportes]) {
      const sig = JSON.stringify(rep.__cells || rep);
      if (seen.has(sig)) continue;
      seen.add(sig);
      dedupReportes.push(rep);
    }
    const aliases = [
      ...(Array.isArray(prev.data?.aliases) ? prev.data.aliases : [prev.paciente].filter(Boolean)),
      r.paciente,
    ].filter(Boolean);
    map.set(k, {
      ...prev,
      paciente: prev.paciente || r.paciente,
      data: {
        ...(prev.data || {}),
        ...(r.data || {}),
        aliases: Array.from(new Set(aliases)),
        reportes: dedupReportes,
      },
    });
  }
  return Array.from(map.values());
}

// ── Fusión de reportes entre corridas (oct 2026) ──────────────────────────────
// El upsert (exp,fecha) REEMPLAZA la columna `data`: si la corrida de la tarde solo alcanza
// a drillear los 7-8 refertos más nuevos (presupuesto por paciente), los `valores` que la de
// la mañana ya tenía para refertos más viejos desaparecían de la fila y de la tarjeta.
// Estas funciones permiten (a) reutilizar `valores` ya parseados en corridas previas del
// mismo paciente y (b) no volver a drillear esos refertos. Solo se reutilizan valores de
// filas marcadas __target (identificadas como del paciente por nombre+edad), para no
// rescatar valores de homónimos de corridas anteriores.
export function reportKey(rep) {
  return JSON.stringify((rep && rep.__cells) || rep);
}
// rows: filas de winlab_labs ({ data: { reportes } }) o arrays de reportes → Map key → valores.
export function indexParsedReportes(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const reportes = Array.isArray(row) ? row
      : (row && row.data && Array.isArray(row.data.reportes)) ? row.data.reportes : [];
    for (const rep of reportes) {
      if (rep && rep.__target === true && Array.isArray(rep.valores) && rep.valores.length) {
        // Los valores viajan como array (compat); el cultivo parseado y el texto del PDF van en
        // propiedades no enumerables del mismo array para que la reutilización los conserve.
        const v = rep.valores.slice();
        if (rep.cultivo) Object.defineProperty(v, "__cultivo", { value: rep.cultivo, enumerable: false });
        if (rep.cultivo_texto) Object.defineProperty(v, "__cultivo_texto", { value: rep.cultivo_texto, enumerable: false });
        map.set(reportKey(rep), v);
      }
    }
  }
  return map;
}
// Copia `valores` previos a los reportes nuevos del objetivo que aún no los tienen.
export function mergeReportesPreservingValores(reportes, parsedMap) {
  let reused = 0;
  const out = reportes || [];
  if (!parsedMap || !parsedMap.size) return { reportes: out, reused };
  for (const rep of out) {
    if (!rep || rep.__target !== true) continue;
    if (Array.isArray(rep.valores) && rep.valores.length) continue;
    const prev = parsedMap.get(reportKey(rep));
    if (prev) {
      rep.valores = prev; rep.valores_src = "prev"; reused++;
      if (prev.__cultivo && !rep.cultivo) rep.cultivo = prev.__cultivo;
      if (prev.__cultivo_texto && !rep.cultivo_texto) rep.cultivo_texto = prev.__cultivo_texto;
    }
  }
  return { reportes: out, reused };
}

// ¿El referto es un cultivo? (por sus valores de la tabla/PDF: estudio o valor con CULTIVO,
// ANTIBIOGRAMA, DESARROLLO, UFC…). Sirve para re-drillear cultivos sin texto del PDF.
export function looksLikeCultureReport(rep) {
  if (!rep || !Array.isArray(rep.valores)) return false;
  const RE = /CULTIVO|ANTIBIOGRAMA|DESARROLLO|\bUFC\b|MICROORGANISMO|GERMEN|AISLAD/i;
  return rep.valores.some((v) => v && (RE.test(String(v.estudio || "")) || RE.test(String(v.valor || "")) || RE.test(String(v.referencia || "")) || RE.test(String(v.seccion || ""))));
}

// ── Discriminadores de tablas WinLab (funciones puras testeables) ─────
// La pagina ElencoRefertiLite tiene 6+ tablas; debemos elegir solo la de
// resultados, excluyendo el menu superior, el formulario de busqueda, y
// los layouts de spacing que ASP.NET WebForms genera.

// Texto del menu superior global de WinLab.
export function isMenuTableText(rawText) {
  const t = N(rawText);
  return t.includes("INICIO REPORTES AYUDA") || t.includes("HOME REFERTI AIUTO") || t.includes("HOME REPORTS HELP");
}

// Texto del formulario de busqueda Y de la "lista vacia" post-search
// (varios labels juntos). WinLab cambia "BUSCA REPORTES" -> "LISTA REPORTES"
// despues de aplicar filtro, ambos son menu/header, no datos.
export function isFormTableText(rawText) {
  const txt = N(rawText).slice(0, 1500);
  const FORM_MARKERS = [
    "BUSCA REPORTES",
    "LISTA REPORTES",
    "TODAS LAS UNIDADES ORGANIZATIVAS",
    "PACIENTE APELLIDO NOMBRE",
    "FECHA REPORTE DE A",
    "CON RESULTADOS",
    "UNIDAD SOLICITANTE",
    "CODIGO PACIENTE",
    "REPORTES IMPRESOS",
    "FECHA DE TOMA",
    "CODIGO TOMA",
    // Italiano (la interfaz de WinLab cambia de idioma sin aviso)
    "CERCA REFERTI", "ELENCO REFERTI", "TUTTE LE UNITA", "PAZIENTE COGNOME NOME",
    "DATA REFERTO DA A", "CON RISULTATI", "UNITA RICHIEDENTE", "CODICE PAZIENTE",
    "REFERTI STAMPATI", "DATA PRELIEVO", "CODICE RICHIESTA",
  ];
  let hits = 0;
  for (const m of FORM_MARKERS) if (txt.includes(m)) hits++;
  return hits >= 2;
}

// Celdas que NO son datos de un reporte: menú/formulario de WinLab (ES/IT) y, desde oct 2026, la
// PAGINACIÓN con que termina la tabla de resultados: ["Elementos Encontrados : 20", "", "Inicio Página"]
// y ["", "", "", "INICIO PAGINA"] (con enlaces). Esas filas pasaban como reporte con __hasLink, caían
// bajo el bloque del paciente (cama 3-154: 3 "targets", 2 eran paginación) y se drilleaban en vano,
// gastando cupo de WL_DRILLDOWN_MAX. Se compara en MAYÚSCULAS y sin acentos ("Inicio Página" cuenta).
const GARBAGE_CELL_RE = new RegExp([
  "^(LISTA|BUSCA) REPORTES", "TODAS LAS UNIDADES", "^(INICIO|REPORTES|AYUDA|CIERRA)$",
  // menú/formulario en italiano: WinLab a veces pega las palabras ("ELENCOREFERTI", "HOME REFERTI HELP CHIUDI",
  // "TUTTE ENTITA UTENTE"), por eso espacio opcional y UNITA|ENTITA
  "^(ELENCO|CERCA) ?REFERTI", "TUTTE (LE )?(UNITA|ENTITA)", "^HOME REFERTI", "^(HOME|REFERTI|AIUTO|HELP|CHIUDI)$",
  // paginación al pie de la tabla (formas reales en los blobs, ES / IT; en italiano WinLab pega las
  // palabras: "RECORDTROVATI : 4", "SELEZIONATUTTO", "PAGINA 1 DI 2")
  "^(INICIO|FIN) (DE )?PAGINA$", "^ELEMENTOS ?ENCONTRADOS", "^SELECCIONA ?TODO$", "^PAGINA \\d",
  "^(INIZIO|FINE) PAGINA$", "^(ELEMENTI|RECORD) ?TROVATI", "^SELEZIONA ?TUTT[OI]$",
].join("|"));
export function isGarbageCell(c) {
  if (typeof c !== "string") return false;
  const s = c.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
  return !!s && GARBAGE_CELL_RE.test(s);
}

// ¿Una fila con enlace (__hasLink) es de verdad un REPORTE? Los reportes de WinLab siempre traen
// fecha-hora de toma/reporte (dd/mm/aaaa hh:mm) y/o el barcode del referto (≥ 8 dígitos). Las filas
// de paginación ("Inicio Página", "Elementos Encontrados : 20", números de página) también llevan
// enlaces pero no tienen ninguna de las dos cosas → no se drillean ni cuentan como enlaces del
// paciente. Las filas-encabezado de paciente no pasan por aquí (no tienen __hasLink).
const REPORT_DATETIME_RE = /\b\d{2}\/\d{2}\/\d{4}\s+\d{1,2}:\d{2}\b/;
const REPORT_BARCODE_RE = /(^|\D)\d{8,}(\D|$)/;
export function looksLikeReportLinkRow(cells) {
  if (!Array.isArray(cells)) return false;
  return cells.some((c) => {
    const s = String(c ?? "").trim();
    return !!s && (REPORT_DATETIME_RE.test(s) || REPORT_BARCODE_RE.test(s));
  });
}

// Verifica si una "fila" extraida es realmente data o solo metadata
// tecnica (COL_X / __hasLink / __rowIdxInTable). Lo usamos para no
// guardar basura en winlab_labs.
export function isMeaningfulReportRow(row) {
  if (!row || typeof row !== "object") return false;
  const technicalKeys = new Set(["__cells", "__hasLink", "__rowIdxInTable"]);

  // Si __cells tiene >= 2 celdas con contenido real, la fila tiene datos
  // aunque los headers hayan caido en fallback COL_X. __cells contiene el
  // texto crudo de cada <td> — es la fuente mas confiable de si hay data.
  if (Array.isArray(row.__cells) && row.__cells.length > 0) {
    const realCells = row.__cells.filter(
      (c) => c && typeof c === "string" && c.trim() && !isGarbageCell(c)
    );
    if (realCells.length >= 2) return true;
  }

  for (const [key, val] of Object.entries(row)) {
    if (technicalKeys.has(key)) continue;
    if (/^COL_\d+$/.test(key)) continue;          // header generico = no real
    if (val === null || val === undefined || val === "") continue;
    if (typeof val === "string" && isGarbageCell(val)) continue;   // menú/formulario/paginación bajo header real
    return true; // hay al menos 1 campo con data real
  }
  return false;
}

// Normaliza un término de búsqueda para WinLab: MAYÚS + quita acentos de VOCALES pero
// PRESERVA la Ñ. Evidencia (4 jul 2026, datos reales de winlab_labs + logs del Action):
//   - Búsquedas CON acento vocal fallaban ("RODRÍGUEZ" → NINGUN REGISTRO) → WinLab guarda
//     los apellidos sin acentos (el capturista no los teclea). El fix del 24 jun lo arregló.
//   - PERO ese fix también convertía Ñ→N, y la Ñ SÍ se teclea en WinLab: MUÑIZ/CASTAÑEDA/
//     NUÑEZ/GAMIÑO/SALDAÑA matcheaban con Ñ literal ANTES del fix, y DESPUÉS del fix CERO
//     pacientes con Ñ en apellido se capturaron (ZUÑIGA/PIÑON/AVIÑA → NINGUN REGISTRO).
//   → Colación tipo CI_AS: case-insensitive, acento-sensible, Ñ ≠ N.
export function stripAccentsKeepEnie(s) {
  return String(s || "")
    .normalize("NFC")                              // recompone Ñ descompuesta (N + U+0303)
    .toUpperCase()
    .replace(/Ñ/g, "\u0001")                       // proteger la Ñ del NFD-strip
    .normalize("NFD").replace(/[̀-ͯ]/g, "")        // quitar acentos de vocales (Á→A, É→E...)
    .replace(/\u0001/g, "Ñ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Candidatos de búsqueda WinLab (jul 2026) ────────────────────────────────
// La búsqueda primaria (apellidos = últimas 2 palabras) falla en 5 clases reales del censo:
//   a) capturista de WinLab tecleó N en vez de Ñ            → variante Ñ→N
//   b) apellido extranjero de 3 palabras (ZAKHIA EL DOVAIHY) → últimas 3 como cognome
//   c) hoja con nombre INVERTIDO (MARQUEZ VALLEJO JUAN JOSE) → primeras 2 como cognome + resto en nome
//   d) 2 palabras invertidas                                 → swap cognome/nome
//   e) TYPO en el materno en WinLab (NOVELO→NOBELO, V/B)     → paterno-solo + nombre de pila
//      Caso real (nombre ficticio): RUBEN SOLIS NOVELO, 37 días DELICADO, SIN labs con "SOLIS NOVELO" exacto.
//      El match difuso de encabezado (Jaro-Winkler ≥0.88) reconoce NOVELO≈NOBELO al drillear.
// Devuelve candidatos EN ORDEN; el caller intenta el siguiente SOLO si el anterior dio
// "NINGUN REGISTRO" (respuesta rápida, sin drill). Los retries (índice >0) exigen
// identificación POSITIVA del objetivo por encabezado (sin drill a ciegas): las capas de
// identidad (patientHeaderMatches orden-independiente + filtro de nombre de la app)
// garantizan que un candidato "ancho" nunca atribuya labs ajenos. Precisión > recall.
// Abreviaturas que la hoja usa en el NOMBRE de pila y que WinLab guarda completas (oct 2026):
// "FCO. JAVIER" → "FRANCISCO JAVIER", "MA. DEL CARMEN" → "MARIA DEL CARMEN". Solo se expanden
// en `nome` (los apellidos no se abrevian). Caso real: buscar nome="FCO JAVIER" daba NINGUN REGISTRO.
const NOME_ABBREV = { FCO: "FRANCISCO", FCA: "FRANCISCA", MA: "MARIA", J: "JOSE", GPE: "GUADALUPE", GUADPE: "GUADALUPE" };
export function expandNomeAbbrev(nome) {
  return String(nome || "").split(/\s+/).filter(Boolean)
    .map((w) => { const k = w.replace(/\.+$/g, ""); return NOME_ABBREV[k] || k; })
    .join(" ");
}
export function buildSearchCandidates(nombre) {
  // Quitar puntos de abreviatura antes de partir en palabras ("FCO." → "FCO").
  const clean = stripAccentsKeepEnie(String(nombre || "").replace(/\.(?=\s|$)/g, ""));
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  const push = (cognome, nome, tag, opt) => {
    cognome = (cognome || "").trim();
    nome = (opt && opt.raw) ? String(nome || "").trim() : expandNomeAbbrev(nome);
    const key = cognome + "|" + (nome || "");
    if (!cognome) return;
    if (out.some((c) => c.key === key)) return;
    out.push({ key, cognome, nome: (nome || "").trim() || null, tag, sibling: !!(opt && opt.sibling) });
  };

  // Nombre que EMPIEZA con abreviatura (MA GUADALUPE RIOS, FCO JAVIER PEREZ LOPEZ): las 2
  // primeras palabras son el nombre de pila compuesto; lo que sigue son los apellidos. Sin esto
  // "MA GUADALUPE RIOS" se leía como nombre MA + apellidos GUADALUPE RIOS.
  const abbrevLed = parts.length >= 3 && NOME_ABBREV[parts[0]] !== undefined;
  if (parts.length === 2) {
    // "NOMBRE APELLIDO" → apellido en cognome + nombre de pila en nome (fix 24 jun)
    push(parts[1], parts[0], "2-palabras apellido+nombre");
  } else if (abbrevLed) {
    push(parts.slice(2).join(" "), parts.slice(0, 2).join(" "), "nombre abreviado + apellidos");
    // Variante LITERAL ("MA ELISA" sin expandir): WinLab puede tener OTRO registro del mismo
    // paciente con la abreviatura tal cual (caso real 11-oct-2026, nombre ficticio: "MARIA ELISA" traía
    // solo el EGO de urgencias y "MA ELISA" tenía la BH/QS de cirugía). Es "sibling": el caller la busca
    // ADEMÁS de la expandida (no en vez de) y une las filas, exigiendo match del objetivo.
    push(parts.slice(2).join(" "), parts.slice(0, 2).join(" "), "nombre abreviado literal", { raw: true, sibling: true });
    if (parts.length >= 4) push(extractApellidos(clean)[0], null, "apellidos estandar");
  } else {
    push(extractApellidos(clean)[0], null, "apellidos estandar");
  }

  // (a) variante Ñ→N de los candidatos base (capturista tecleó N en WinLab)
  for (const c of [...out]) {
    if (/Ñ/.test(c.cognome) || (c.nome && /Ñ/.test(c.nome))) {
      push(c.cognome.replace(/Ñ/g, "N"), c.nome ? c.nome.replace(/Ñ/g, "N") : null, "variante N-por-Ñ");
    }
  }
  // (b) apellido compuesto de 3 palabras (nombres largos): últimas 3 como cognome
  if (parts.length >= 5) push(parts.slice(-3).join(" "), null, "apellido 3 palabras");
  // (c) nombre invertido en la hoja (APELLIDOS primero): primeras 2 como cognome + resto en nome.
  //     No aplica si empieza con abreviatura de nombre (FCO/MA/J…): ahí el orden es evidente.
  if (parts.length >= 4 && !abbrevLed) push(parts.slice(0, 2).join(" "), parts.slice(2).join(" "), "invertido apellidos-primero");
  // (c2) invertido con apellidos SOLOS (oct 2026, cama 3-160, corrida #441): la hoja traía APELLIDOS
  //      primero y WinLab guarda el nombre de pila de otra forma ("MA DEL ROSARIO", "MA." o un segundo
  //      nombre distinto), así que el filtro txtNome de (c) devolvía NINGÚN REGISTRO. Con los dos primeros
  //      tokens como apellidos y SIN nome, WinLab lista a todos los homónimos de apellido y el encabezado
  //      difuso (MA→MARIA, orden libre) identifica al objetivo; el retry-guard descarta si no aparece.
  //      Nunca drill a ciegas. Va después de (c): primero la búsqueda estrecha, luego la ancha.
  if (parts.length >= 4 && !abbrevLed) push(parts.slice(0, 2).join(" "), null, "invertido apellidos solos");
  // (d) 2 palabras: probar el swap (hoja "APELLIDO NOMBRE")
  if (parts.length === 2) push(parts[0], parts[1], "2-palabras invertido");
  // (e) ÚLTIMO RECURSO: paterno-solo + nombre de pila. Recupera al paciente cuyo MATERNO
  //     está mal escrito/ausente en WinLab (el "SOLIS NOVELO" exacto falla, pero "SOLIS"
  //     + nombre "RUBEN" lo encuentra y el match difuso de encabezado confirma la identidad).
  //     Va AL FINAL: "LOPEZ" solo trae muchos homónimos → el nome estrecha server-side y el
  //     retry-guard (requireTargetMatch) descarta si el objetivo no aparece. Nunca drill ciego.
  if (parts.length >= 3) {
    const paterno = abbrevLed ? parts[2] : (extractApellidos(clean)[1] || parts[parts.length - 2]);
    const nombrePila = abbrevLed ? parts.slice(0, 2).join(" ") : parts[0];
    push(paterno, nombrePila, "paterno-solo + nombre");
    // (f) MATERNO-solo + nombre de pila (oct 2026): el error de dedo también cae en el PATERNO
    //     (cama 3-181, corrida #419: dos letras invertidas en el paterno): TODAS las variantes
    //     anteriores llevan el paterno y WinLab no devuelve nada. Con materno + nombre WinLab sí lista
    //     al paciente y el encabezado difuso (Jaro-Winkler ≥ 0.88 tolera la transposición) confirma la identidad.
    const ap = extractApellidos(clean);
    const materno = (ap[0] && ap[1] && ap[0].startsWith(ap[1] + " ")) ? ap[0].slice(ap[1].length + 1).trim() : null;
    if (materno && materno !== paterno) push(materno, nombrePila, "materno-solo + nombre");
    // Con nombre abreviado y un solo apellido ("MA GUADALUPE RIOS"), probar también el apellido
    // a secas: si WinLab guardó el nombre de otra forma, el retry-guard sigue exigiendo match positivo.
    if (abbrevLed && parts.length === 3) push(parts[2], null, "apellido solo (nombre abreviado)");
  }
  return out;
}

// Candidatos con ALIAS (oct 2026): "nombre en WinLab" que el equipo fija desde la app cuando el
// censo (hoja) y WinLab no coinciden (otro orden, apellido de casada, error de dedo). Los
// candidatos del alias van PRIMERO y se marcan `alias:true`; después los del nombre del censo.
// Formato del alias: "APELLIDOS, NOMBRE" (con coma, como lo lista WinLab y como lo sugiere la app)
// → se busca exactamente así y, de respaldo, paterno + nombre y materno + nombre. Sin coma se lee
// como en el censo (NOMBRE APELLIDOS) y pasa por la escalera normal.
export function buildSearchCandidatesWithAlias(nombre, alias) {
  const base = buildSearchCandidates(nombre);
  const a = stripAccentsKeepEnie(String(alias || "").replace(/\.(?=\s|$|,)/g, ""));
  if (!a) return base;
  let fromAlias = [];
  if (a.includes(",")) {
    const ap = a.split(",")[0].trim(), nm = a.split(",").slice(1).join(" ").trim();
    const nome = nm ? expandNomeAbbrev(nm) : null;
    const push = (cognome, n, tag) => {
      cognome = (cognome || "").trim(); if (!cognome) return;
      const key = cognome + "|" + (n || "");
      if (fromAlias.some((c) => c.key === key)) return;
      fromAlias.push({ key, cognome, nome: n || null, tag: "alias · " + tag, sibling: false, alias: true });
    };
    push(ap, nome, "apellidos + nombre");
    push(ap, null, "apellidos solos");
    const apParts = ap.split(/\s+/).filter(Boolean);
    if (apParts.length >= 2 && nome) { push(apParts[0], nome, "paterno + nombre"); push(apParts.slice(1).join(" "), nome, "materno + nombre"); }
  } else {
    fromAlias = buildSearchCandidates(a).map((c) => ({ ...c, alias: true, tag: "alias · " + c.tag }));
  }
  const seen = new Set(fromAlias.map((c) => c.key));
  return fromAlias.concat(base.filter((c) => !seen.has(c.key)));
}

// Extrae candidatos de "apellido" de un nombre completo.
// Convencion mexicana: "NOMBRE(s) APELLIDO_PATERNO APELLIDO_MATERNO"
// Devuelve array de candidatos en orden de preferencia:
//   1) "APELLIDO_PATERNO APELLIDO_MATERNO" (las 2 ultimas palabras)
//   2) "APELLIDO_PATERNO" (solo penultima)
// Util para fallback cuando codigo paciente no matchea.
export function extractApellidos(nombre) {
  if (!nombre) return [];
  const clean = stripAccentsKeepEnie(nombre);
  const parts = clean.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [];
  const out = [];
  // Las PARTÍCULAS (DE/DEL/LA/LAS/LOS/Y) se agrupan con la palabra que sigue y cuentan como UNA
  // palabra: "MARIA GARCIA DE LA TORRE" → [MARIA, GARCIA, "DE LA TORRE"] → apellidos "GARCIA DE LA
  // TORRE", paterno "GARCIA". Antes solo se absorbía una partícula pegada al paterno y "DE LA TORRE"
  // quedaba como apellidos completos (sin GARCIA) → WinLab, que busca por prefijo, no lo encontraba.
  const PART = { DE: 1, DEL: 1, LA: 1, LAS: 1, LOS: 1, Y: 1 };
  const groups = [];
  let i = 0;
  while (i < parts.length) {
    let g = parts[i]; i++;
    while (i < parts.length && PART[g.split(" ").pop()]) { g += " " + parts[i]; i++; }
    groups.push(g);
  }
  if (groups.length < 2) return groups.length ? [groups[0]] : [];
  out.push(groups.slice(-2).join(" "));
  if (groups.length >= 3 && groups[groups.length - 2]) out.push(groups[groups.length - 2]);
  return Array.from(new Set(out));
}

// ── Match de identidad para targeting de drill-down (jun 2026) ──────────────
// WinLab busca por apellido y devuelve VARIOS pacientes homónimos. El drill-down
// debe clickear SOLO los reportes del paciente objetivo, no los primeros N a ciegas
// (causaba que p.ej. el 4º de 5 "GONZALEZ GONZALEZ" nunca se capturara y el blob
// quedara con labs de otro). Match difuso (Jaro-Winkler) tolera typos de OCR
// (ESEQUIEL≈EZEQUIEL) sin confundir personas distintas (nombre de pila diferente).
export function normNameTokens(name) {
  if (!name) return [];
  const s = String(name).toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\./g, " ").replace(/[^A-Z\s]/g, " ")
    .replace(/\bMA\b/g, "MARIA").replace(/\bJ\b/g, "JOSE").replace(/\bGPE\b/g, "GUADALUPE")
    .replace(/\bFCO\b/g, "FRANCISCO").replace(/\bFCA\b/g, "FRANCISCA");
  return s.split(/\s+/).filter((w) => w.length >= 3 &&
    !["DEL", "LAS", "LOS", "CON", "SIN", "POR", "PARA", "Y", "O"].includes(w));
}
function _jaro(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const dist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false), mb = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - dist), hi = Math.min(i + dist + 1, lb);
    for (let j = lo; j < hi; j++) { if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = true; matches++; break; } }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) { if (!ma[i]) continue; while (!mb[k]) k++; if (a[i] !== b[k]) t++; k++; }
  return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
}
export function jaroWinkler(a, b) {
  const j = _jaro(a, b); if (j < 0.7) return j;
  let p = 0; const l = Math.min(4, a.length, b.length);
  while (p < l && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}
// Pares que difieren SOLO en la vocal final A/O son nombres distintos (ANTONIO/ANTONIA,
// MARIO/MARIA, FRANCISCO/FRANCISCA, ALEJANDRO/ALEJANDRA): Jaro-Winkler los daba ≥0.9 y un
// homónimo del otro sexo pasaba el match de nombre. (oct 2026)
function _isGenderVariant(t1, t2) {
  if (t1.length !== t2.length || t1.length < 4) return false;
  const a = t1[t1.length - 1], b = t2[t2.length - 1];
  return a !== b && "AO".includes(a) && "AO".includes(b) && t1.slice(0, -1) === t2.slice(0, -1);
}
function _tokenMatch(t1, t2) {
  if (t1 === t2) return true;
  if (_isGenderVariant(t1, t2)) return false;
  if (t1.length >= 5 && t2.length >= 5) return jaroWinkler(t1, t2) >= 0.88;
  return false;
}
// ¿TODOS los tokens de `needles` encuentran un token DISTINTO en `haystack` (difuso)?
function _allTokensIn(needles, haystack) {
  const used = new Array(haystack.length).fill(false);
  for (const tk of needles) {
    let hit = false;
    for (let j = 0; j < haystack.length; j++) { if (!used[j] && _tokenMatch(tk, haystack[j])) { used[j] = true; hit = true; break; } }
    if (!hit) return false;
  }
  return true;
}
// ¿el nombre del encabezado corresponde al paciente objetivo? Cotejo SIMÉTRICO (oct 2026):
//   a) TODOS los tokens del censo están en el encabezado (regla original), o
//   b) TODOS los tokens del encabezado están en el censo, cuando el encabezado trae ≥ 3 tokens
//      (2 apellidos + ≥ 1 nombre). Caso real (cama 3-162, oct 2026): censo con TRES nombres de pila
//      (p.ej. "JUAN PABLO ANDRES SOTO MEDINA") y WinLab con solo dos ("SOTO MEDINA, JUAN PABLO"): el
//      tercer nombre no aparece en el encabezado y el paciente caía en "homónimos" sin labs (solo
//      funcionaba con alias puesto a mano).
// Un encabezado de 2 tokens (p.ej. "LOPEZ JUAN") NO usa (b): le falta un apellido y sería demasiado
// ancho. La precisión por token no cambia (variante A/O, Jaro-Winkler ≥0.88 solo con ≥5 letras):
// un nombre de pila distinto sigue siendo otra persona. Precisión > recall.
// patientHeaderMatchKind distingue la coincidencia COMPLETA ("full", regla a) de la PARCIAL ("partial",
// regla b): selectTargetRows trata la parcial con más cautela (ver ahí), porque "SOTO MEDINA, JUAN PABLO"
// también puede ser OTRA persona que no es "JUAN PABLO ANDRES SOTO MEDINA".
export function patientHeaderMatchKind(headerName, targetNombre) {
  const t = normNameTokens(targetNombre), h = normNameTokens(headerName);
  if (!t.length || !h.length) return "";
  if (_allTokensIn(t, h)) return "full";
  return h.length >= 3 && _allTokensIn(h, t) ? "partial" : "";
}
export function patientHeaderMatches(headerName, targetNombre) {
  return !!patientHeaderMatchKind(headerName, targetNombre);
}
// Extrae "APELLIDOS NOMBRE" de una fila-encabezado usando la posición de FEMENINO/MASCULINO
// (mismo método que el bookmarklet): apellidos = cell[sx-2], nombre = cell[sx-1].
// WinLab cambia de idioma sin aviso (11 oct 2026: la interfaz pasó de español a italiano a
// media tarde y dos corridas quedaron en 0/48): la celda de sexo se acepta en ES/IT/EN y, si
// no aparece ninguna palabra conocida, se reconoce la fila-encabezado por su forma:
// [.., APELLIDOS, NOMBRE, <sexo corto>, dd/mm/aaaa (nacimiento)].
export const SEX_CELL_RE = /^(FEMENIN[OA]|MASCULIN[OA]|FEMMIN[A-Z]*|MASCHI[A-Z]*|FEMALE|MALE|DONNA|UOMO|MUJER|HOMBRE|[FM])$/;
export function isSexCell(c) { return SEX_CELL_RE.test(String(c || "").toUpperCase().trim()); }
const BIRTH_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const ALPHA_NAME_RE = /^[A-ZÁÉÍÓÚÜÑ' .-]{2,}$/i;
export function findSexIdx(cells) {
  if (!Array.isArray(cells)) return -1;
  let sx = cells.findIndex(isSexCell);
  if (sx >= 0) return sx;
  // Fallback estructural (idioma desconocido): celda corta alfabética seguida de fecha de
  // nacimiento y precedida por dos celdas de nombre; una fila de reporte trae barcode/fechas-hora.
  for (let i = 2; i < cells.length - 1; i++) {
    const s = String(cells[i] || "").trim();
    if (!s || s.length > 12 || !/^[A-Za-zÀ-ÿ]+$/.test(s)) continue;
    if (!BIRTH_RE.test(String(cells[i + 1] || "").trim())) continue;
    if (!ALPHA_NAME_RE.test(String(cells[i - 1] || "").trim()) || !ALPHA_NAME_RE.test(String(cells[i - 2] || "").trim())) continue;
    return i;
  }
  return -1;
}
export function extractHeaderName(cells) {
  if (!Array.isArray(cells)) return "";
  const sx = findSexIdx(cells);
  if (sx >= 2 && cells[sx - 2]) return String(cells[sx - 2]) + " " + String(cells[sx - 1] || "");
  return "";
}

// ── Guarda de edad para el targeting (oct 2026) ──────────────────────────────
// El nombre NO basta para identificar al paciente: un homónimo de nombre COMPLETO
// (mismos apellidos y nombres) pasa patientHeaderMatches y sus labs acaban en la
// tarjeta equivocada (corrida #386: 8 bloques en 7 camas, p.ej. censo 80 años vs
// WinLab 16). La fila-encabezado trae FECHA DE NAC. (celda siguiente a SEXO); la
// comparamos con `edad` del censo. Si alguno de los dos falta/no se entiende, la
// guarda no aplica (se mantiene el match por nombre), para no perder pacientes.
// IMPORTANTE (corrida #434): la guarda es un DESEMPATE entre homónimos, no un filtro absoluto. Si WinLab
// trae UN SOLO registro con ese nombre (o varios que son el mismo paciente con el año mal escrito), la
// edad NO lo descarta: descartar al único match dejaba al paciente SIN labs (3-151/3-159/3-168/3-181,
// nombre exacto y, aun así, "homónimos"). La edad solo elige cuando hay 2+ personas posibles con ese
// nombre.
export function extractHeaderBirthDate(cells) {
  if (!Array.isArray(cells)) return "";
  const sx = findSexIdx(cells);
  if (sx < 0) return "";
  const m = String(cells[sx + 1] || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[0] : "";
}
export function ageFromBirthDate(ddmmyyyy, today = new Date()) {
  const m = String(ddmmyyyy || "").match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = +m[1], mo = +m[2], y = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900) return null;
  let age = today.getFullYear() - y;
  const tm = today.getMonth() + 1, td = today.getDate();
  if (tm < mo || (tm === mo && td < d)) age--;
  return age >= 0 && age <= 120 ? age : null;
}
// Edad del censo en años: "52", "52a", "52 años". Meses/días ("3m", "20 dias") u otros
// formatos → null (desconocida ⇒ la guarda no aplica a ese paciente).
export function parseCensusAge(edad) {
  const s = String(edad ?? "").trim().toUpperCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const m = s.match(/^(\d{1,3})\s*(A|ANOS|ANO|Y)?\.?$/);
  return m ? parseInt(m[1], 10) : null;
}
// Selecciona las filas (índices) del paciente OBJETIVO: agrupa por fila-encabezado
// FEMENINO/MASCULINO, exige match de nombre (difuso, orden-independiente) y, cuando hay
// edad en el censo y fecha de nacimiento en el encabezado, edad compatible (±tolerance).
// Devuelve también los enlaces totales (para diagnóstico) y los bloques rechazados por edad.
// ¿Dos fechas de nacimiento con el MISMO día y mes pero distinto año? Es la firma de un año mal
// capturado al registrar al paciente otra vez en WinLab (dígitos cambiados 1996→1969, 1968→2006…).
// 01/01 no cuenta: es el comodín que se pone cuando no se conoce la fecha.
export function sameBirthdayOtherYear(a, b) {
  const ma = String(a || "").match(/^(\d{2}\/\d{2})\/(\d{4})$/), mb = String(b || "").match(/^(\d{2}\/\d{2})\/(\d{4})$/);
  if (!ma || !mb) return false;
  return ma[1] === mb[1] && ma[2] !== mb[2] && ma[1] !== "01/01";
}
// ¿Pueden ser el MISMO paciente dos bloques que coinciden por nombre? Sí cuando listan el mismo nombre
// (misma etiqueta "APELLIDOS, NOMBRE") y su fecha de nacimiento es compatible: idéntica, solo cambia el
// año (año mal escrito, 05/03/2006 vs 05/03/1968) o a alguno le falta la fecha. Si el nombre listado
// difiere o la fecha difiere en día/mes (homónimos reales, o 01/01 que es comodín), son 2+ personas
// posibles → la edad decide cuál es el paciente.
export function possiblySameWinlabPerson(a, b) {
  if (!a || !b) return false;
  if (String(a.label || "") !== String(b.label || "")) return false;
  const fa = String(a.fnac || ""), fb = String(b.fnac || "");
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fa) || !/^\d{2}\/\d{2}\/\d{4}$/.test(fb)) return true;   // falta fecha → no se puede separar
  return fa === fb || sameBirthdayOtherYear(fa, fb);
}
export function selectTargetRows(rows, paciente, opts = {}) {
  const tolerance = Number.isFinite(opts.ageTolerance) ? opts.ageTolerance : 2;
  const today = opts.today || new Date();
  const censusAge = parseCensusAge(paciente && paciente.edad);
  const linkIdxs = [], seenNames = [], blocks = [];
  const alias = String((paciente && paciente.alias) || "").trim();
  let cur = null;
  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const hdrName = extractHeaderName(row.__cells);
    if (hdrName) {
      // Nombres que listó WinLab, como "APELLIDOS, NOMBRE" (formato del alias que fija la app).
      const sxi = findSexIdx(row.__cells);
      const seenLabel = sxi >= 2 ? String(row.__cells[sxi - 2] || "").trim() + ", " + String(row.__cells[sxi - 1] || "").trim() : hdrName;
      if (!seenNames.includes(seenLabel)) seenNames.push(seenLabel);
      // El alias ("nombre en WinLab" fijado en la app) también identifica al objetivo.
      const kindN = patientHeaderMatchKind(hdrName, paciente && paciente.nombre);
      const kindA = alias ? patientHeaderMatchKind(hdrName, alias) : "";
      const full = kindN === "full" || kindA === "full";
      const nameOk = full || !!kindN || !!kindA;
      const fnac = extractHeaderBirthDate(row.__cells);
      const hdrAge = nameOk && censusAge != null ? ageFromBirthDate(fnac, today) : null;
      // partial: coincide solo por la regla (b) (encabezado ⊆ censo, a WinLab le falta algún nombre del censo).
      cur = { idx: i, hdrName, label: seenLabel.toUpperCase(), fnac, hdrAge, nameOk, partial: nameOk && !full, ageOk: !(nameOk && hdrAge != null && Math.abs(hdrAge - censusAge) > tolerance), links: [] };
      blocks.push(cur);
    }
    if (row.__hasLink) {
      // Paginación/menú con enlace (sin fecha-hora ni barcode) no es un reporte: ni del paciente ni de nadie.
      if (!looksLikeReportLinkRow(row.__cells)) continue;
      linkIdxs.push(i);
      if (cur) cur.links.push(i);
    }
  }
  // COINCIDENCIA PARCIAL (regla b, oct 2026) con cautela — precisión > recall:
  //   1) solo cuenta si NINGÚN bloque coincide por nombre COMPLETO: con "SOTO MEDINA, JUAN PABLO ANDRES"
  //      en la lista, "SOTO MEDINA, JUAN PABLO" no compite ni como homónimo (antes de la regla b ni
  //      siquiera era candidato, y como "2ª persona" obligaría a la edad a decidir y podría ganar).
  //   2) NO goza de la excepción de registro único (#434, abajo): un encabezado al que le falta un nombre
  //      del censo bien puede ser otra persona, así que si la edad no cuadra se descarta aunque sea el
  //      único bloque. Con edad desconocida (censo en meses/vacío, o sin fecha en WinLab) se acepta.
  if (blocks.some((b) => b.nameOk && !b.partial)) blocks.forEach((b) => { if (b.partial) b.nameOk = false; });
  // UN SOLO PACIENTE → el nombre manda (corrida #434): si todos los bloques que coinciden por nombre
  // pueden ser la MISMA persona (un solo registro, o varios con el año mal escrito), la guarda de edad
  // NO aplica — así el único match no se tira por una edad que no cuadra. Solo cuando hay 2+ personas
  // posibles con ese nombre se usa la edad (abajo) para elegir y rescatar los registros del mismo.
  const nameBlocks = blocks.filter((b) => b.nameOk);
  let multiPerson = false;
  for (let i = 0; i < nameBlocks.length && !multiPerson; i++)
    for (let j = i + 1; j < nameBlocks.length; j++)
      if (!possiblySameWinlabPerson(nameBlocks[i], nameBlocks[j])) { multiPerson = true; break; }
  if (!multiPerson) nameBlocks.forEach((b) => { if (!b.partial) b.ageOk = true; });
  // RESCATE por año mal capturado (oct 2026, cama 3-163): el mismo paciente aparece en WinLab con dos
  // registros del MISMO nombre y la MISMA fecha de nacimiento salvo el año (05/03/1968 y 05/03/2006).
  // La guarda de edad descartaba el registro "joven" y con él los labs nuevos (los de hospitalización
  // se capturaron en el registro equivocado). En los blobs guardados, 6 de 7 pacientes con bloques
  // homónimos descartados tenían exactamente esta firma. Un bloque descartado por edad se rescata si
  // OTRO bloque del mismo nombre (etiqueta idéntica) pasó la guarda y comparte día/mes de nacimiento.
  // Homónimos reales (otra fecha de nacimiento) siguen fuera.
  const accepted = blocks.filter((b) => b.nameOk && b.ageOk);
  const ageRescued = [];
  for (const b of blocks) {
    if (!b.nameOk || b.ageOk) continue;
    const twin = accepted.find((a) => a.label === b.label && sameBirthdayOtherYear(a.fnac, b.fnac));
    if (twin) { b.ageOk = true; ageRescued.push({ idx: b.idx, headerAge: b.hdrAge, censusAge, twinAge: twin.hdrAge, fnac: b.fnac, twinFnac: twin.fnac }); }
  }
  const targetIdxs = [], ageRejected = [];
  let matchedHeader = "", partialMatch = false;
  for (const b of blocks) {
    if (!b.nameOk) continue;
    if (b.ageOk) { for (const i of b.links) targetIdxs.push(i); if (!matchedHeader) { matchedHeader = b.hdrName; partialMatch = !!b.partial; } }
    else ageRejected.push({ idx: b.idx, headerAge: b.hdrAge, censusAge });
  }
  // Edad que NO cuadra en un bloque aceptado (27 oct 2026): con una sola persona con ese nombre en WinLab el nombre manda
  // (#434) y se aceptan sus labs, pero la tarjeta debe avisarlo («WinLab: 61 años · censo: 39»): o la edad del censo está
  // mal, o es otra persona con el mismo nombre completo. Con un rescate por año mal escrito no se avisa.
  const edadNoCuadra = blocks.filter((b) => b.nameOk && b.ageOk && b.hdrAge != null && censusAge != null && Math.abs(b.hdrAge - censusAge) > tolerance
    && !ageRescued.some((r) => r.idx === b.idx)).map((b) => ({ headerAge: b.hdrAge, censusAge }));
  // partialMatch: el objetivo se identificó por coincidencia PARCIAL (WinLab lista menos nombres que el censo).
  return { targetIdxs, linkIdxs, ageRejected, ageRescued, censusAge, tolerance, seenNames: seenNames.slice(0, 8), matchedHeader, partialMatch, edadNoCuadra };
}

// Expediente normalizado para comparar objetivos (WL_TARGET_EXP) con el censo: "26-00001",
// "2600001" y " 26 00001 " son el mismo.
export function normExp(exp) {
  return String(exp || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// Genera variantes del codigo paciente para probar en WinLab. El censo
// guarda formatos como "26-06437" (con guion). WinLab puede esperar
// el numero sin guion ("2606437") o solo la parte numerica final.
export function expVariants(exp) {
  if (!exp) return [];
  const e = String(exp).trim();
  const variants = [e];
  if (e.includes("-")) {
    const noDash = e.replace(/-/g, "");
    if (noDash !== e) variants.push(noDash);
    // Tambien la parte despues del ultimo guion (ej. "06437" de "26-06437")
    const tail = e.split("-").pop();
    if (tail && tail !== e) variants.push(tail);
  }
  return Array.from(new Set(variants));
}

// Texto que indica "no hay reportes para este paciente en el rango".
export function isNoResultsText(rawText) {
  const txt = N(rawText);
  return /NING(U|Ú)N REGISTRO ENCONTRADO/.test(txt) || /NESSUN/.test(txt);
}

// Combinacion: ¿es esta tabla irrelevante para resultados?
export function isIrrelevantTable(rawText) {
  return isMenuTableText(rawText) || isFormTableText(rawText);
}

// ─── Tope de tiempo para operaciones del navegador (27 oct 2026) ─────────────────────────────────────────────────
// Dos corridas se quedaron pasmadas ~55 min tras un error de WinLab («interrupted by another navigation») hasta que
// GitHub las cortó: subPage.close() o ctx.newPage() no respondían y nada les ponía límite. conTope rechaza con
// { atasco: true } si la promesa no termina en `ms` (la promesa original sigue, pero ya nadie la espera).
export function conTope(promesa, ms, etiqueta) {
  let t = null;
  const limite = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(`${etiqueta}: sin respuesta en ${ms} ms`), { atasco: true })), ms);
  });
  return Promise.race([Promise.resolve(promesa), limite]).finally(() => clearTimeout(t));
}

// Errores de navegación pasajeros (la página navegó mientras se usaba): se reintenta una vez tras esperar la carga.
export function esNavegacionPasajera(msg) {
  return /Execution context was destroyed|Target closed|Navigation failed|interrupted by another navigation|frame was detached/i.test(String(msg || ""));
}

// El navegador o su contexto ya no sirven: hay que reiniciarlo (no basta con pasar al siguiente paciente).
export function esNavegadorCaido(msg) {
  return /browser has been closed|context.*has been closed|Target page.*has been closed|Browser.*disconnected/i.test(String(msg || ""));
}

// ─── Privacidad de las bitácoras (27 oct 2026) ───────────────────────────────────────────────────────────────────
// El repositorio es PÚBLICO y las bitácoras de GitHub Actions también: ningún nombre de paciente ni expediente completo
// puede salir ahí. Los robots imprimían nombres del censo y de WinLab/RIS (homónimos, casi-coincidencias, «encontrado
// como»…). Ahora: iniciales y los 3 últimos dígitos del expediente; y una red de seguridad en console.* oculta cualquier
// nombre entre comillas que se escape (texto en mayúsculas con 2 o más palabras).
const _PARTICULAS = new Set(["DE", "DEL", "LA", "LAS", "LOS", "Y"]);
export function iniciales(nombre) {
  const ws = String(nombre || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().split(/[^A-ZÑ]+/).filter((w) => w && !_PARTICULAS.has(w));
  return ws.length ? ws.map((w) => w[0]).join(".") + "." : "(sin nombre)";
}
export function expOculto(exp) {
  const s = String(exp == null ? "" : exp).trim();
  return s ? "…" + s.slice(-3) : "(sin exp)";
}
// Texto entre comillas ("…", «…», '…') que parece un nombre: solo letras, espacios, puntos y comas, en MAYÚSCULAS, con 2
// o más palabras. «exp=1234567» → «exp=…567».
export function sanearLog(texto) {
  return String(texto)
    .replace(/(["«'])([A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ.,]*(?:\s+[A-ZÁÉÍÓÚÜÑ][A-ZÁÉÍÓÚÜÑ.,]*)+)(["»'])/g, (m, a, n, b) => a + iniciales(n) + b)
    .replace(/\bexp=(\S+)/g, (m, e) => "exp=" + expOculto(e));
}
export function instalarLogSeguro(consola = console) {
  if (consola.__logSeguro) return;
  for (const k of ["log", "error", "warn", "info"]) {
    const orig = consola[k].bind(consola);
    consola[k] = (...a) => orig(...a.map((x) => (typeof x === "string" ? sanearLog(x) : x)));
  }
  consola.__logSeguro = true;
}

// Objetivo de una corrida dirigida (WL_TARGET_EXP): «ID-<uuid>» (id del paciente en la base; lo que manda la app desde
// el 27 oct 2026, porque el dato de la corrida es público) o expedientes, separados por comas o espacios.
export function parseObjetivo(texto) {
  const toks = String(texto || "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  const esId = (t) => /^ID-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);
  return { ids: toks.filter(esId).map((t) => t.slice(3).toLowerCase()), exps: toks.filter((t) => !esId(t)).map(normExp).filter(Boolean) };
}

// Firma del contenido de una fila de winlab_labs (27 oct 2026): sin run_id, hora de captura ni contadores de la corrida.
// Si la fila de HOY ya tiene la misma firma en la base, no se reescribe: cada reescritura mandaba un aviso en vivo a
// todos los iPads («🧪 Labs WinLab actualizados») y un repintado, aunque nada hubiera cambiado.
export function firmaFilaLabs(data) {
  const d = data || {};
  return JSON.stringify({ cama: d.cama || null, esp: d.esp || null, reportes: d.reportes || [] });
}
