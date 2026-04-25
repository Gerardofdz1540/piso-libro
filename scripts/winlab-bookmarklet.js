/* ═══════════════════════════════════════════════════════════════════════
   Piso Libro — Bookmarklet WinLab (v8 — fuzzy match + header detection)
   ═══════════════════════════════════════════════════════════════════════
   SOLO marca reportes de pacientes de Cirugía General y subespecialidades:
     CG, CCR (coloproctología), CV (vascular), CPR (plástica),
     CT (tórax), CTV (toracovascular), CMF (maxilofacial), URO (urología),
     CG/GYO, CG/CV (mixtas con CG)
   Excluye: NCX (neurocx), TYO (trauma/orto), GYO (gineco),
     ONCOCIRUGÍA, ENDOS (endoscopía), COLUMNA, Pediatría, Med Interna, etc.

   Cambios v8:
   - Extracción de nombre: 3 estrategias en cascada:
       1) Encabezados <th>/<td> con APELLIDO/NOMBRE/PACIENTE
       2) Offset relativo a marcador de sexo (FEMENINO/MASCULINO) — fallback
       3) Escaneo de celdas con patrón de nombre (solo mayúsculas A-Z)
   - Fuzzy matching con Jaro-Winkler + similitud por tokens:
       • Tolera errores tipográficos (GARSIA ↔ GARCIA)
       • Invariante al orden (APELLIDO NOMBRE ↔ NOMBRE APELLIDO)
       • Sin filtro de longitud mínima — acepta apellidos cortos (Gil, Paz)
   - Matching contra el censo completo; luego filtra por especialidad CG

   Para instalar:
   1. Copia TODO el código desde "javascript:" hasta la última ");".
   2. Crea un favorito nuevo en Firefox/Chrome.
   3. Ponle nombre: "📋 Sync censo WinLab (CG)".
   4. Pega el código en el campo URL.
   5. Guarda.

   Cómo usarlo:
   1. Abre WinLab → Reportes → Lista.
   2. Espera que carguen los resultados.
   3. Clic al bookmark.
   4. Toast mostrará algo tipo:
      "✅ 18 de 22 pacientes CG encontrados · 🚫 24 no-CG ignorados"
   5. Clic en "Imprime Reportes" → descarga PDF.
   6. Arrastra el PDF a piso-libro → Carga Masiva de Labs.
   ═══════════════════════════════════════════════════════════════════════ */

javascript:(async()=>{
  const SUPA_URL="https://vkxplmrzyqlamxpbtmes.supabase.co";
  const SUPA_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZreHBsbXJ6eXFsYW14cGJ0bWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTg1MjcsImV4cCI6MjA4NzUzNDUyN30.zChMOiKnxNv3pLyt2Fqi7zUh0ET5rn1a5L6S3RV1Q98";

  // Whitelist de especialidades de Cirugía General y subespecialidades
  const CG_ESPS = new Set([
    "CG", "CCR", "CV", "CPR", "CT", "CTV", "CMF", "URO",
    "CG/GYO", "CG/CV", "GYO/CG", "CV/CG"
  ]);
  const isCG = esp => {
    const e = String(esp || "").toUpperCase().trim();
    if (!e) return false;
    if (CG_ESPS.has(e)) return true;
    // Acepta cualquier combinación que incluya CG
    if (/(^|[\/\s])CG([\/\s]|$)/.test(e)) return true;
    return false;
  };

  // ── Toast helper ─────────────────────────────────────────────────────
  const toast = (msg, color) => {
    let t = document.getElementById("__pl_toast__");
    if (!t) {
      t = document.createElement("div");
      t.id = "__pl_toast__";
      t.style.cssText = "position:fixed;top:20px;right:20px;z-index:99999;padding:14px 20px;border-radius:10px;font-family:-apple-system,sans-serif;font-size:14px;font-weight:600;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.25);max-width:440px;line-height:1.4;white-space:pre-line";
      document.body.appendChild(t);
    }
    t.style.background = color || "#0369a1";
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._to);
    t._to = setTimeout(() => t.style.display = "none", 10000);
  };

  toast("⏳ Leyendo censo de piso-libro…", "#0369a1");

  // ── 1. Fetch active census from Supabase ────────────────────────────
  let ptsAll;
  try {
    const r = await fetch(SUPA_URL + "/rest/v1/patients?select=cama,exp,nombre,esp", {
      headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    ptsAll = await r.json();
  } catch(e) {
    toast("❌ No pude leer el censo de Supabase: " + e.message, "#dc2626");
    return;
  }
  if (!ptsAll || !ptsAll.length) {
    toast("⚠️ El censo de piso-libro está vacío. Importa primero el Excel.", "#d97706");
    return;
  }

  // ── 1.5 FILTRO CRÍTICO: solo Cirugía General y subespecialidades ────
  const pts = ptsAll.filter(p => isCG(p.esp));
  const nonCGCount = ptsAll.length - pts.length;
  if (!pts.length) {
    toast("⚠️ No hay pacientes de Cirugía General en el censo.\n\nTodos son de otras especialidades (" + ptsAll.length + " pacientes). Revisa la columna ESP del censo.", "#d97706");
    return;
  }
  toast("🔍 " + pts.length + " pacientes CG · 🚫 " + nonCGCount + " no-CG ignorados\nBuscando en WinLab…", "#0369a1");

  // ── 2. String normalization ──────────────────────────────────────────
  // Uppercase + strip diacritics (Ñ→N, Á→A, etc.) + collapse whitespace
  const N = s => String(s || "").toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();

  // ── 3. Jaro-Winkler similarity (pure JS, no dependencies) ───────────
  // Handles typos and character transpositions within tokens.
  function jaro(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    if (!la || !lb) return 0;
    const dist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
    const ma = new Uint8Array(la), mb = new Uint8Array(lb);
    let matches = 0;
    for (let i = 0; i < la; i++) {
      const lo = Math.max(0, i - dist), hi = Math.min(i + dist + 1, lb);
      for (let j = lo; j < hi; j++) {
        if (!mb[j] && a[i] === b[j]) { ma[i] = mb[j] = 1; matches++; break; }
      }
    }
    if (!matches) return 0;
    let t = 0, k = 0;
    for (let i = 0; i < la; i++) {
      if (!ma[i]) continue;
      while (!mb[k]) k++;
      if (a[i] !== b[k]) t++;
      k++;
    }
    return (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
  }

  function jaroWinkler(a, b) {
    const j = jaro(a, b);
    let p = 0;
    const l = Math.min(4, a.length, b.length);
    while (p < l && a[p] === b[p]) p++;
    return j + p * 0.1 * (1 - j);
  }

  // ── 4. Token-aware fuzzy similarity ─────────────────────────────────
  // Splits both strings into tokens (no minimum length — accepts "GIL", "PAZ").
  // Each token in the shorter set is matched to its best partner in the longer
  // set via Jaro-Winkler, making the score order-invariant:
  //   "GARCIA JUAN" ↔ "JUAN GARCIA"  →  ~1.0
  //   "GARSIA LOPEZ" ↔ "GARCIA LOPEZ" → ~0.94
  function nameSim(str1, str2) {
    const t1 = str1.split(" ").filter(Boolean);
    const t2 = str2.split(" ").filter(Boolean);
    if (!t1.length || !t2.length) return 0;
    const [sh, lo] = t1.length <= t2.length ? [t1, t2] : [t2, t1];
    let total = 0;
    for (const a of sh) {
      let best = 0;
      for (const b of lo) { const s = jaroWinkler(a, b); if (s > best) best = s; }
      total += best;
    }
    // Normalize by the longer token count to penalize unmatched extra tokens
    return total / lo.length;
  }

  // ── 5. Census lookup (all patients) ─────────────────────────────────
  // Match against ptsAll first, then check the winner's specialty.
  // This avoids false negatives caused by a typo steering us to a non-CG record.
  const MATCH_THRESHOLD = 0.72;
  const censoAll = ptsAll.map(p => ({ pt: p, norm: N(p.nombre) }));

  function findBestMatch(ap, no) {
    const query = (N(ap) + " " + N(no)).replace(/\s+/g, " ").trim();
    if (!query) return null;
    let best = null, bestScore = 0;
    for (const c of censoAll) {
      const s = nameSim(query, c.norm);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return bestScore >= MATCH_THRESHOLD ? best : null;
  }

  // ── 6. Dynamic column detection from table headers ───────────────────
  // Looks for <th> or <td> cells labeled APELLIDO(S), NOMBRE(S), PACIENTE(S).
  // Returns an object with found column indices, or null if not found.
  function detectHeaderCols(rows) {
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map(c => N(c.innerText));
      const apIdx = cells.findIndex(c => /^APELLIDO(S)?$/.test(c));
      const noIdx = cells.findIndex(c => /^NOMBRE(S)?$/.test(c));
      const ptIdx = cells.findIndex(c => /^PACIENTE(S)?$/.test(c));
      if (apIdx >= 0 && noIdx >= 0) return { apIdx, noIdx, ptIdx: -1 };
      if (ptIdx >= 0) return { apIdx: -1, noIdx: -1, ptIdx };
    }
    return null;
  }

  // Pattern: one or more uppercase ASCII words, no digits, length ≤ 50
  const NAME_RE = /^[A-Z]{2,}( [A-Z]{2,}){0,3}$/;

  // ── 7. Resilient name extraction (3-strategy cascade) ───────────────
  function extractNames(cells, hdr) {
    // Strategy 1: header-mapped columns (most reliable when headers exist)
    if (hdr) {
      if (hdr.ptIdx >= 0 && cells[hdr.ptIdx]) return { ap: cells[hdr.ptIdx], no: "" };
      if (hdr.apIdx >= 0 && cells[hdr.apIdx]) {
        return { ap: cells[hdr.apIdx], no: hdr.noIdx >= 0 ? (cells[hdr.noIdx] || "") : "" };
      }
    }
    // Strategy 2: sex-marker relative offset (original heuristic — fast and reliable
    // for the standard WinLab layout: [...] APELLIDOS NOMBRES SEXO [...])
    const sxIdx = cells.findIndex(c => c === "FEMENINO" || c === "MASCULINO");
    if (sxIdx >= 2 && cells[sxIdx - 2]) {
      return { ap: cells[sxIdx - 2], no: cells[sxIdx - 1] || "" };
    }
    // Strategy 3: scan all cells for name-like content (all-caps A-Z words, no digits)
    const hits = cells.filter(c => NAME_RE.test(c) && c.length <= 50);
    if (hits.length >= 2) return { ap: hits[0], no: hits[1] };
    if (hits.length === 1) return { ap: hits[0], no: "" };
    return null;
  }

  // ── 8. Scan WinLab table rows ────────────────────────────────────────
  const allRows = Array.from(document.querySelectorAll("table tr"));
  const hdr = detectHeaderCols(allRows);
  let matched = 0, missed = [], checkedBoxes = 0, nonCGSkipped = 0;
  const seenPts = new Set();

  for (let i = 0; i < allRows.length; i++) {
    const cells = Array.from(allRows[i].cells || []).map(c => N(c.innerText));
    if (cells.length < 2) continue;
    // Only process rows that contain a sex marker (FEMENINO / MASCULINO)
    if (!cells.some(c => c === "FEMENINO" || c === "MASCULINO")) continue;

    const extracted = extractNames(cells, hdr);
    if (!extracted || !extracted.ap) continue;

    const match = findBestMatch(extracted.ap, extracted.no);
    if (!match) {
      missed.push((extracted.ap + " " + extracted.no).trim());
      continue;
    }
    // The winner decides the specialty — skip if not CG
    if (!isCG(match.pt.esp)) { nonCGSkipped++; continue; }

    matched++;
    seenPts.add(match.pt.exp || match.pt.nombre);

    // Mark all report checkboxes for this patient (rows until next sex marker)
    for (let j = i + 1; j < allRows.length; j++) {
      const nxtCells = Array.from(allRows[j].cells || []).map(c => N(c.innerText));
      if (nxtCells.some(c => c === "FEMENINO" || c === "MASCULINO")) break;
      const cb = allRows[j].querySelector('input[type="checkbox"]');
      if (cb && !cb.checked) { cb.click(); checkedBoxes++; }
    }
  }

  // ── 9. Report ────────────────────────────────────────────────────────
  const missingFromWinlab = pts
    .filter(p => !seenPts.has(p.exp || p.nombre))
    .map(p => p.nombre).slice(0, 6);
  let msg = `✅ ${matched} pacientes CG encontrados\n📋 ${checkedBoxes} reportes marcados\n🚫 ${nonCGSkipped} pacientes no-CG ignorados en WinLab\n`;
  if (nonCGCount > 0) msg += `🚫 ${nonCGCount} pacientes no-CG ignorados del censo\n`;
  if (missingFromWinlab.length) {
    msg += `\n⚠️ CG sin labs hoy (${pts.length - matched}/${pts.length}):\n`
      + missingFromWinlab.map(n => "  • " + n.split(" ").slice(0, 3).join(" ")).join("\n");
    if (pts.length - matched > missingFromWinlab.length)
      msg += `\n  … y ${pts.length - matched - missingFromWinlab.length} más`;
  }
  msg += `\n\n👉 Ahora "Imprime Reportes"`;
  toast(msg, matched ? "#15803d" : "#d97706");
})();
