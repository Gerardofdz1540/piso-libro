// ==UserScript==
// @name         Piso Libro — WinLab Scan Automático
// @namespace    https://pisocirugiahgl.netlify.app
// @version      1.0
// @description  Un clic en "▶ Scan" y el script recorre TODAS las páginas de WinLab solo, sin intervención.
// @author       piso-libro
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(async function () {
  'use strict';

  const SUPA_URL = "https://vkxplmrzyqlamxpbtmes.supabase.co";
  const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZreHBsbXJ6eXFsYW14cGJ0bWVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTg1MjcsImV4cCI6MjA4NzUzNDUyN30.zChMOiKnxNv3pLyt2Fqi7zUh0ET5rn1a5L6S3RV1Q98";
  const SS  = "__pl_winlab_tm_state";
  const V   = "tm-v1";

  // ── Normalize helper ──────────────────────────────────────────────────
  const N = s => String(s || "").toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();

  // ── State ─────────────────────────────────────────────────────────────
  const loadState = () => { try { return JSON.parse(sessionStorage.getItem(SS) || "null"); } catch { return null; } };
  const saveState = s  => sessionStorage.setItem(SS, JSON.stringify(s));
  const clearState = () => sessionStorage.removeItem(SS);

  // ── Toast ─────────────────────────────────────────────────────────────
  function toast(msg, color, ms) {
    let t = document.getElementById("__pl_tm_toast__");
    if (!t) {
      t = document.createElement("div");
      t.id = "__pl_tm_toast__";
      t.style.cssText = "position:fixed;top:20px;right:20px;z-index:2147483647;padding:14px 20px;border-radius:10px;font:600 13px -apple-system,sans-serif;color:#fff;box-shadow:0 8px 32px rgba(0,0,0,.3);max-width:460px;line-height:1.45;white-space:pre-line;cursor:pointer";
      t.title = "Clic para cerrar";
      t.onclick = () => t.style.display = "none";
      document.body.appendChild(t);
    }
    t.style.background = color || "#0369a1";
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(t._to);
    if (ms) t._to = setTimeout(() => t.style.display = "none", ms);
  }

  // ── Detect WinLab page ────────────────────────────────────────────────
  // Only activates on pages that have patient rows with FEMENINO/MASCULINO
  function isWinLabPage() {
    return Array.from(document.querySelectorAll("table td")).some(td => {
      const t = td.innerText.trim().toUpperCase();
      return t === "FEMENINO" || t === "MASCULINO";
    });
  }

  // ── Jaro-Winkler fuzzy matching ───────────────────────────────────────
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

  function nameSim(s1, s2) {
    const t1 = s1.split(" ").filter(Boolean), t2 = s2.split(" ").filter(Boolean);
    if (!t1.length || !t2.length) return 0;
    const [sh, lo] = t1.length <= t2.length ? [t1, t2] : [t2, t1];
    let tot = 0;
    for (const a of sh) {
      let best = 0;
      for (const b of lo) { const s = jaroWinkler(a, b); if (s > best) best = s; }
      tot += best;
    }
    return tot / lo.length;
  }

  // ── Name extraction (3-strategy cascade) ─────────────────────────────
  function detectHdr(rows) {
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map(c => N(c.innerText));
      const apI = cells.findIndex(c => /^APELLIDO(S)?$/.test(c));
      const noI = cells.findIndex(c => /^NOMBRE(S)?$/.test(c));
      const ptI = cells.findIndex(c => /^PACIENTE(S)?$/.test(c));
      if (apI >= 0 && noI >= 0) return { apIdx: apI, noIdx: noI, ptIdx: -1 };
      if (ptI >= 0) return { apIdx: -1, noIdx: -1, ptIdx: ptI };
    }
    return null;
  }

  const NR = /^[A-Z]{2,}( [A-Z]{2,}){0,3}$/;

  function extractNames(cells, hdr) {
    if (hdr) {
      if (hdr.ptIdx >= 0 && cells[hdr.ptIdx]) return { ap: cells[hdr.ptIdx], no: "" };
      if (hdr.apIdx >= 0 && cells[hdr.apIdx]) return { ap: cells[hdr.apIdx], no: hdr.noIdx >= 0 ? (cells[hdr.noIdx] || "") : "" };
    }
    const sx = cells.findIndex(c => c === "FEMENINO" || c === "MASCULINO");
    if (sx >= 2 && cells[sx - 2]) return { ap: cells[sx - 2], no: cells[sx - 1] || "" };
    const hits = cells.filter(c => NR.test(c) && c.length <= 50);
    if (hits.length >= 2) return { ap: hits[0], no: hits[1] };
    if (hits.length === 1) return { ap: hits[0], no: "" };
    return null;
  }

  // ── Find next-page button ─────────────────────────────────────────────
  function findNextBtn(curPg) {
    const cands = Array.from(document.querySelectorAll('a,input[type="image"],input[type="button"],input[type="submit"],button'));
    const byLbl = cands.find(el => {
      if (el.disabled || el.getAttribute("disabled") === "disabled") return false;
      const t = (el.title || el.alt || el.value || el.innerText || "").trim().toLowerCase();
      const src  = (el.src || "").toLowerCase();
      const href = (el.href || el.getAttribute("href") || "").toLowerCase();
      if (t.includes("siguiente") || t.includes("next") || t === ">" || t === ">>" || t === "»" || t === "›") return true;
      if (src.includes("next") && !src.includes("last")) return true;
      if (href.includes("__dopostback") && (href.includes("next") || href.includes("siguiente"))) return true;
      return false;
    });
    if (byLbl) return byLbl;
    return cands.find(el => (el.innerText || el.value || "").trim() === String(curPg + 1) && !el.disabled) || null;
  }

  // ── Scan the visible page ─────────────────────────────────────────────
  function scanPage(pts, seenPts) {
    const THRESH = 0.72;
    const censoNorm = pts.map(p => ({ pt: p, norm: N(p.nombre) }));

    function findMatch(ap, no) {
      const q = (N(ap) + " " + N(no)).replace(/\s+/g, " ").trim();
      if (!q) return null;
      let best = null, bs = 0;
      for (const c of censoNorm) {
        const s = nameSim(q, c.norm);
        if (s > bs) { bs = s; best = c; }
      }
      return bs >= THRESH ? best : null;
    }

    const rows = Array.from(document.querySelectorAll("table tr"));
    const hdr  = detectHdr(rows);
    let matched = 0, boxes = 0;
    const seen = new Set(seenPts);

    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].cells || []).map(x => N(x.innerText));
      if (cells.length < 2) continue;
      if (!cells.some(c => c === "FEMENINO" || c === "MASCULINO")) continue;
      const names = extractNames(cells, hdr);
      if (!names || !names.ap) continue;
      const match = findMatch(names.ap, names.no);
      if (!match) continue;
      matched++;
      seen.add(match.pt.exp || match.pt.nombre);
      for (let j = i + 1; j < rows.length; j++) {
        const nc = Array.from(rows[j].cells || []).map(x => N(x.innerText));
        if (nc.some(x => x === "FEMENINO" || x === "MASCULINO")) break;
        const hasC = nc.some((txt, idx) => idx >= 2 && idx <= 6 && txt === "C");
        if (!hasC) continue;
        rows[j].querySelectorAll('input[type="checkbox"]').forEach(cb => {
          if (!cb.checked && !cb.disabled) { try { cb.click(); boxes++; } catch (_) {} }
        });
      }
    }

    return { matched, boxes, seen: Array.from(seen) };
  }

  // ── Detect current/total page from body text ──────────────────────────
  function detectPageNums() {
    const body = document.body.innerText;
    for (const pat of [
      /P[aá]g(?:ina)?[.:]?\s*(\d+)\s+de\s+(\d+)/i,
      /Page\s+(\d+)\s+of\s+(\d+)/i,
    ]) {
      const m = body.match(pat);
      if (m && +m[1] > 0 && +m[2] > 0) return { cur: +m[1], tot: +m[2] };
    }
    return { cur: 0, tot: 0 };
  }

  // ── Advance or finish ─────────────────────────────────────────────────
  async function advanceOrFinish(state) {
    const { cur, tot } = detectPageNums();
    const curPg = cur || state.pagesDone;
    const nextBtn = findNextBtn(curPg);

    if (nextBtn && (curPg < tot || tot <= 0)) {
      saveState(state);
      const pgLabel = tot > 0 ? `${curPg}/${tot}` : `${curPg}`;
      toast(
        `[piso-libro ${V}] Pág ${pgLabel}: +${state._lastMatched} pac · +${state._lastBoxes} marcados\n` +
        `Total: ${state.totalMatched} pac · ${state.totalBoxes} marcados\n⏳ Avanzando a pág siguiente…`,
        "#0369a1", 5000
      );
      await new Promise(r => setTimeout(r, 700));
      try { nextBtn.click(); } catch (_) {
        toast("No pude avanzar — haz clic manualmente en > y el script continuará solo.", "#d97706", 20000);
      }
    } else {
      // All pages done — final report
      const miss = state.pts.filter(p => !state.seenPts.includes(p.exp || p.nombre));
      let msg = `[piso-libro ${V}] ✅ LISTO\n${state.pagesDone} pág · ${state.totalMatched} pacientes · ${state.totalBoxes} reportes marcados`;
      if (miss.length) {
        msg += `\n\nSin labs completos hoy (${miss.length}/${state.pts.length}):\n` +
          miss.slice(0, 8).map(p => "  • " + p.nombre.split(" ").slice(0, 3).join(" ")).join("\n");
        if (miss.length > 8) msg += `\n  … y ${miss.length - 8} más`;
      }
      msg += "\n\n👉 Ahora \"Imprime Reportes\"";
      clearState();
      toast(msg, state.totalMatched > 0 ? "#15803d" : "#d97706", 120000);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // ENTRY POINTS
  // ══════════════════════════════════════════════════════════════════════

  // ── A. Auto-continue if there's an active scan session ────────────────
  const state = loadState();
  if (state && state.pts && state.autoMode) {
    if (!isWinLabPage()) {
      // Navigated away from WinLab — abandon gracefully
      clearState();
      return;
    }
    // Wait for WinLab to fully render the table
    await new Promise(r => setTimeout(r, 1500));
    const result = scanPage(state.pts, state.seenPts);
    state.seenPts      = result.seen;
    state.totalMatched = (state.totalMatched || 0) + result.matched;
    state.totalBoxes   = (state.totalBoxes   || 0) + result.boxes;
    state.pagesDone    = (state.pagesDone    || 0) + 1;
    state._lastMatched = result.matched;
    state._lastBoxes   = result.boxes;
    await advanceOrFinish(state);
    return;
  }

  // ── B. Fresh start — inject "▶ Scan" button if WinLab detected ───────
  if (!isWinLabPage()) return;

  const btn = document.createElement("button");
  btn.id = "__pl_scan_btn__";
  btn.textContent = "▶ Scan Piso-Libro";
  btn.style.cssText = [
    "position:fixed", "bottom:24px", "right:24px", "z-index:2147483647",
    "padding:11px 20px", "background:#0369a1", "color:#fff",
    "border:none", "border-radius:9px",
    "font:700 13px -apple-system,sans-serif",
    "cursor:pointer", "box-shadow:0 4px 18px rgba(0,0,0,.25)",
    "transition:background .15s"
  ].join(";");
  btn.onmouseenter = () => btn.style.background = "#0284c7";
  btn.onmouseleave = () => btn.style.background = "#0369a1";

  btn.onclick = async () => {
    btn.textContent = "⏳ Cargando censo…";
    btn.disabled = true;

    // Fetch census from Supabase
    let pts;
    try {
      const r = await fetch(SUPA_URL + "/rest/v1/patients?select=cama,exp,nombre,esp", {
        headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY }
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      pts = await r.json();
    } catch (e) {
      toast("❌ No pude leer el censo: " + e.message, "#dc2626", 15000);
      btn.remove();
      return;
    }
    if (!pts || !pts.length) {
      toast("⚠️ Censo vacío. Importa primero el Excel en piso-libro.", "#d97706", 10000);
      btn.remove();
      return;
    }

    btn.remove();

    // Scan page 1 immediately
    const result = scanPage(pts, []);
    const initState = {
      pts,
      autoMode:     true,
      seenPts:      result.seen,
      totalMatched: result.matched,
      totalBoxes:   result.boxes,
      pagesDone:    1,
      _lastMatched: result.matched,
      _lastBoxes:   result.boxes,
    };

    await advanceOrFinish(initState);
  };

  document.body.appendChild(btn);
})();
