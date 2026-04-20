# Piso Libro — PRD

## Problem statement (original)
> Revisa mi repositorio y dime qué opinas, qué errores detectas, qué cosas mejorarías y como la ves de funcional. Soy novato, mi objetivo es hacer esta app útil para mis pases de visita como residente de cirugía general y me sea más fácil tener un control de todos mis pacientes. La función que no funciona del todo es a la hora de importar los censos, no detecta a todos los pacientes pese a que tiene la indicación de importar principalmente a los de cirugía general.

## Stack & deployment
- Single-file `index.html` (~14,400 lines) — HTML + CSS + vanilla JS
- Hosted on GitHub Pages: https://gerardofdz1540.github.io/piso-libro/
- Backend: Supabase (PostgreSQL + Realtime WebSocket)
- Repo: https://github.com/Gerardofdz1540/piso-libro
- Users: 7 surgery residents
- Auth: Supabase-based admin + user accounts

## Core features (already built by user)
- Auth multiusuario (admin + residentes)
- Excel census import (CENSO_HGL_GUARDIA.xlsx) with smart categorization
- Patient management: diagnosis, APP, procedures, drains, pending notes
- Bulk lab PDF parsing with AI
- Smart document intake (note/post-op → AI extraction)
- Rounds mode + projector mode
- Supabase Realtime sync across devices
- Offline-first with pending queue
- Undo / patient archiving / export
- Electrolyte correction calculator

## Session 2026-01 — Import bug fix (COMPLETED)
**5 critical bugs fixed in `handleXlsxImport()`:**
1. Strict section header detection (ALTAS/DEFUNCIONES/PROCEDIMIENTOS no longer triggered by misaligned data cells) — root cause of lost patients
2. Robust sub-section label detection (RECUPERACION/UCIA/PEDIATRIA/MEDICINA INTERNA no longer imported as bogus patients)
3. Diagnostic log panel (`window.__lastImportLog` + "ver log" link in import modal) — row-by-row decisions
4. Deduplicate candidatesCG (no more duplicates between newPts and CG candidates)
5. Expanded `normalizeEspImport` map + `CG_DX_PATTERN` regex

Validated with user's real `CENSO 20_04_2026 VAZQUEZ.xlsx`: 46 active patients correctly categorized, 5 altas detected, 0 false-positive imports.

Commit: `c8a96ef` — pushed to `main`.

## Session 2026-02 — Bulk Lab PDF Fix + Dark Mode (COMPLETED)

### 🔴 P0 Fix: Carga Masiva de Labs (PDF multi-paciente)
**Root cause**: el PDF se enviaba completo como binario (`type: "document"`) a Claude Sonnet. Con 71 páginas y ~28 pacientes, Claude se saturaba y solo devolvía el primer paciente (confirmado por usuario: `✅ 1 asignados · 📄 1 pacientes extraídos en total`).

**Solución implementada** (`index.html`, `processFile` + `buildBulkLabExtractionPrompt`):
1. Agregado `pdf.js@3.11.174` al `<head>` vía CDN
2. Extracción de texto **local** página por página con `pdfjsLib.getDocument().getPage().getTextContent()`
3. Split por marker `HOJA DE RESULTADOS` + regex `/PACIENTE\s*:\s*NOMBRE/`
4. Consolidación por nombre (multi-reportes del mismo paciente se fusionan)
5. Batches de **3 pacientes/lote** enviados a Claude con **concurrencia 3**
6. `max_tokens=8000` por lote, `content = text` (no documento binario)
7. Prompt refactorizado: deja claro "PROCESA TODOS LOS PACIENTES DEL LOTE"

**Validación** con PDF real del usuario (`prueba.pdf`, 71 páginas):
- Páginas totales: **71**
- Splits detectados: **71** (cada HOJA DE RESULTADOS)
- Nombres detectados: **67 / 71**
- **Pacientes únicos detectados: 28** (vs 1 antes)
- Primeros ejemplos OK: ROMERO JUAREZ PEDRO, PIÑON SERVIN OFELIA, RODRIGUEZ RUIZ, SALAS MARTINEZ, MENDOZA GONZALEZ, GARCIA GONZALEZ, etc.

### 🟡 P1: Dark Mode Toggle (Notion-style)
**Implementado** según `/app/design_guidelines.json`:
- Tokens semánticos (`--text`, `--surface`, `--border-soft`, etc.) definidos en `:root`
- Tema oscuro override vía `body.dark { ... }` con paleta `#0A0A0B / #121214 / #D4A373`
- Botón toggle `data-testid="theme-toggle-btn"` en header (🌙/☀️)
- `localStorage.pl_theme` para persistir preferencia
- `applyTheme()` + `toggleTheme()` + `initTheme()` llamado en arranque
- Overrides para: header, inputs, cards, modales, tablas, tabs, scrollbar, selection, code blocks
- Validado: `body bg = rgb(10,10,11)` exacto = #0A0A0B

## Prioritized backlog (not yet done)

### P0 — Security
- **Confirm Supabase RLS policies**: anon key is hardcoded in client; RLS must be enforced for `patients`, `notes`, `users`, `lab-sources` tables. Untested from my side.

### P1 — Robustness
- **Shifted-column detection**: warn user when EXP column contains non-numeric data (catches data entry errors like row 6 `3-154, GARCIA, JORGE`)
- **Post-import validation**: compare total Excel rows vs. imported patients, alert on >10% discrepancy
- **Import rollback**: allow undoing a full import after confirm

### P2 — UX / quality
- **Modularize the 14k-line `index.html`** (split into `auth.js`, `import.js`, `supabase.js`, `ui.js`, `labs.js`, `ai.js`)
- **Automated tests** for `normalizeEspImport`, `handleXlsxImport`, `pid()` — critical for clinical data integrity
- **Audit log** per patient (who changed what, when) for rounds handoff
- **Export signed PDF summary** for formal entrega de guardia

### P3 — Nice to have
- PWA install prompt + offline icon
- Dark-mode tuning for projector mode
- Patient photo thumbnails for wound follow-up

## Tech debt notes
- `SUPA_KEY` committed in source — acceptable ONLY if RLS is correctly configured
- Credentials stored in `localStorage` (plaintext) — acceptable only on trusted devices
- No unit tests → very risky for clinical app with 7 concurrent users
