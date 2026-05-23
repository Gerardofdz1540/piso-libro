# PisoLibro — Study Notes

Notas técnicas y hallazgos de la implementación de PisoLibro (app de censo
clínico personal). Documento de referencia para el paper de implementación
(target: JMIR Med Inform / Applied Clin Inform).

---

## Bloque A — Cierre de brecha de seguridad (21 mayo 2026)

### Hallazgo inicial

Auditoría con Supabase Security Advisor detectó exposición pública de
57 registros clínicos vía anon key embebida en bundle público de
GitHub Pages. RLS deshabilitada en tabla `patients`; 10 tablas
adicionales con policies permisivas `USING (true)` para rol anon.

### Remediación aplicada

- DROP de policies `anon_all_*` en las 11 tablas de schema public
- REVOKE ALL para rol anon en TABLES, SEQUENCES, FUNCTIONS
- ALTER DEFAULT PRIVILEGES para futuros objetos
- Snapshots forenses pre/post con verificación SHA-256

---

## Bloque B — Implementación Supabase Auth (22 mayo 2026)

### Cambios técnicos

- **PR #128** mergeado (commit `808e75d`)
- Reemplazo auth casero pl_users → `supabase.auth.signInWithPassword`
- `_sHeaders()` rutea access_token; apikey mantiene anon (requisito PostgREST)
- `persistSession: true` + `autoRefreshToken: true`
- `onAuthStateChange` con switch sobre SIGNED_IN / TOKEN_REFRESHED / SIGNED_OUT
- Diff: +61 / -23 líneas en index.html

- **PR #129** mergeado (commit `8f5fc22`)
- Botones "Mi contraseña" y "Usuarios" ocultos via display:none inline
- Helpers casero (loginSetup, _usersGetAll, _sha256, _usersSave) intactos
  por dependencias detectadas en tiempo de implementación

---

## Auditoría de cierre (22 mayo 2026, 23:10 hrs)

Auditoría completa vía Supabase MCP + SQL directo confirma:

### Estado de seguridad
- 0 ERRORs en Security Advisor
- 0 WARNs de acceso anon (brecha cerrada)
- 11 WARNs `rls_policy_always_true` para rol authenticated (INTENCIONAL)
- 1 WARN `auth_leaked_password_protection` (Pro-only, diferida)

### Estado de performance (hallazgos secundarios)
- 1 WARN `duplicate_index` en `public.notes` (`notes_patient_id_key`
  y `notes_pkey` idénticos)
- 2 INFO `unused_index`: `idx_patients_esp`, `idx_lab_entries_fecha`

### Verificación forense de archive

- `list_tables` MCP reportó 0 rows para `public.archive`
- `SELECT count(*)` directo confirmó 53 rows reales
- Tamaño físico: 1.4 MB (vs 4.4 MB pre-remediation; reducción atribuible
  a VACUUM/compactación, NO a pérdida de datos)

### Migration orfana detectada

La migration `20260522141341 grant_anon_all_tables` aparece registrada
en el historial **POSTERIOR** a la remediation final del Bloque A
(`20260522134408 remediation_2026_05_21_drop_recreated_templates`).

Análisis funcional: el GRANT a rol Postgres sin policies que permitan
acceso es INERTE — RLS sigue bloqueando. Advisor confirma 0 WARNs anon.

Análisis de gobernanza: probablemente aplicada por una sesión paralela
de agente fuera de la ventana de contexto del operador principal.
Constituye ejemplo concreto del patrón "advisor-as-todo loop"
documentado abajo. Pendiente de limpieza explícita en Bloque C.

---

## Hallazgos publicables

### Hallazgo #1 — "Advisor-as-todo loop"

Re-creación sistemática de policies permisivas en tres iteraciones
independientes por agentes LLM. Mecanismo:

1. Estado correcto post-cierre: RLS habilitada sin policies = deny-by-default
2. Supabase Advisor flagea como INFO `rls_enabled_no_policy`
3. Agente interpreta INFO como "warning que silenciar"
4. Agente genera policy mínima que silencia: `USING (true)`
5. Policy funcionalmente equivalente a no tener RLS — silencia advisor
   pero reabre brecha

**Mitigación**: prompts con lista negativa explícita que codifica
"INFO rls_enabled_no_policy es estado intencional, no to-do".

### Hallazgo #2 — "Honest-commit-message rejection"

Agente codificador detectó que el commit message prescrito contenía
afirmaciones no respaldadas por su implementación final ("remove legacy
pl_users" cuando pl_users no fue removido). Sustituyó por mensaje veraz.
Opuesto al "rubber-stamp commit". Replicable con prompts que dan licencia
explícita al agente para reescribir mensajes que detecte como falsos.

### Hallazgo #3 — "Surgical-edit-by-investigator pattern"

Para edits <20 líneas, ejecución directa por el investigador de scripts
Python con verificación inline (`count()` pre-replace, abort si patrón
no único) demostró mejor ratio costo/seguridad que delegación a agente.
Particularmente útil para edits con identificadores únicos contextuales.

### Hallazgo #4 — "Agent assumption drift"

El agente conversacional arrastró durante múltiples turnos un supuesto
no verificado ("GitHub Pages está apagado") originado en una conversación
previa parcialmente recordada. Se propagó a planeación, documentación
intermedia y recomendaciones, hasta que una screenshot del investigador
reveló la discrepancia: Pages había permanecido público durante toda la
sesión, re-deployándose automáticamente con cada merge a main.

**Mitigación operativa**: incluir verificación explícita de TODAS las
superficies de exposición conocidas (hosting, CDN, mirrors, archives) en
auditorías de seguridad. Documentar supuestos como "verified" o "assumed".

### Hallazgo #5 — "Planner-stats unreliability for forensic auditing"

APIs administrativas (incluyendo Supabase MCP `list_tables`) consultan
metadatos del planner Postgres (`pg_class.reltuples`) que se actualizan
asíncronamente vía VACUUM y pueden divergir significativamente de los
counts reales. Confirmado en dos auditorías independientes:

1. Bloque A: tabla `archive` con 4.4 MB y 53 rows reales reportaba 0 rows
2. Bloque B: tabla `archive` con 1.4 MB (post-VACUUM) y 53 rows reales
   reportaba 0 rows desde MCP

**Implicación operativa**: auditorías que dependen exclusivamente de
APIs administrativas pueden subestimar tanto exposición como persistencia
de datos. Forensics requiere `SELECT count(*)` directo además de queries
a metadata.

---

## Estado final del sistema (22 mayo 2026, post-cierre)

### Supabase (vkxplmrzyqlamxpbtmes, free tier)
- Postgres 17.6.1.063, region us-west-2
- Status: ACTIVE_HEALTHY
- 11 tablas en public, todas con RLS habilitada
- 9 migrations registradas (4 originales + 5 del 22 mayo)
- 0 Edge Functions deployed

### Cliente (index.html, 16,286 líneas)
- Login funcional vía Supabase Auth con email + password
- Sesión persistente con localStorage
- Token routing manual a wrappers fetch() existentes
- Botones legacy ocultos (display:none)
- Servida exclusivamente local con `python3 -m http.server 8000`

### GitHub
- main al día (commit final con tag v0.1-auth-implemented)
- GitHub Pages: UNPUBLISHED (al cierre de sesión 22 mayo)
- 2 PRs mergeados en sesión (#128, #129) + 1 docs PR (#130 si aplica)
- ~20 branches remotas obsoletas pendientes de cleanup

---

## Pendientes diferidos a Bloque C

1. Rotación anon + service_role keys (requiere update GitHub Actions secrets)
2. Migración "Mi contraseña" → `supabase.auth.updateUser({password})`
3. Migración "Usuarios" → Supabase Auth Admin via Edge Function
4. Refinamiento policies authenticated_all USING(true) cuando >1 usuario
5. Realtime auth audit (verificar suscripciones tras lockdown)
6. Re-publicación a GitHub Pages post-hardening (puntos 1, 7 y leaked
   password protection como pre-requisitos)
7. Eliminación final de helpers casero (post-2 y 3)
8. Refactor de init() para evitar location.reload() post-login
9. Cleanup de ~20 branches remotas obsoletas en GitHub
10. Upgrade a Supabase Pro plan ($25/mes) — solo si necesitamos
    leaked password protection, PITR, o custom domains
11. Auditoría de presencia en archivos públicos (Wayback Machine,
    archive.today) del estado pre-cierre
12. Cleanup de migration orfana `grant_anon_all_tables` (drop migration
    record o agregar revoke explícito como nueva migration)
13. Drop de duplicate index `notes_patient_id_key` (mantener `notes_pkey`)
14. Drop o uso de unused indexes `idx_patients_esp`, `idx_lab_entries_fecha`

