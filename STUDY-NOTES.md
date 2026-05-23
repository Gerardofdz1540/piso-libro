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

### Hallazgo publicable #1: "Advisor-as-todo loop"

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

### Hallazgo publicable #2: "Honest-commit-message rejection"

Agente codificador detectó que el commit message prescrito contenía
afirmaciones no respaldadas por su implementación final ("remove legacy
pl_users" cuando pl_users no fue removido). Sustituyó por mensaje veraz.
Opuesto al "rubber-stamp commit". Replicable con prompts que dan licencia
explícita al agente para reescribir mensajes que detecte como falsos.

### Hallazgo publicable #3: "Surgical-edit-by-investigator pattern"

Para edits <20 líneas, ejecución directa por el investigador de scripts
Python con verificación inline (`count()` pre-replace, abort si patrón
no único) demostró mejor ratio costo/seguridad que delegación a agente.
Particularmente útil para edits con identificadores únicos contextuales.

### Hallazgo publicable #4: "Agent assumption drift"

Durante el cierre de Bloque B, el agente conversacional (operando en chat
web con MCP) arrastró durante múltiples turnos un supuesto no verificado
("GitHub Pages está apagado") originado en una conversación previa
parcialmente recordada. Este supuesto se propagó a través de planeación,
documentación intermedia y recomendaciones, sin ser challenged hasta que
una screenshot del investigador reveló la discrepancia: Pages había
permanecido público durante toda la sesión, re-deployándose
automáticamente con cada merge a main.

**Mecanismo**: el agente no tiene mecanismo nativo de "verify before
assume" para estados infraestructurales fuera de sus MCPs activos
(en este caso, MCP de Supabase estaba disponible pero MCP de GitHub
Pages no, generando un punto ciego).

**Mitigación operativa**: incluir en el inventario inicial de cualquier
auditoría de seguridad una verificación explícita de TODAS las superficies
de exposición conocidas (hosting, CDN, mirrors, archives), no solo la
base de datos. Documentar supuestos al planear y marcarlos como
"verified" o "assumed" para auditoría posterior.

**Riesgo concreto durante la sesión**: aunque la brecha de datos quedó
cerrada por RLS en Bloque A, el bundle público de la app con anon key
embebida permaneció accesible durante toda la sesión. El riesgo real
fue bajo (policies anon cerradas, login obligatorio post-PR #128) pero
no cero (brute-force del login sin rate limiting custom, archivado en
Wayback Machine).

---

## Estado final del sistema (22 mayo 2026, post-cierre)

### Supabase (vkxplmrzyqlamxpbtmes, free tier)

- 0 ERRORs en Security Advisor
- 0 WARNs de acceso anon
- 11 WARNs `rls_policy_always_true` para rol authenticated (INTENCIONAL,
  un solo usuario admin)
- 1 WARN `auth_leaked_password_protection` (Pro-only, decisión
  costo-beneficio: no upgrade)

### Cliente (index.html, 16,286 líneas)

- Login funcional vía Supabase Auth con email + password
- Sesión persistente con localStorage
- Token routing manual a wrappers fetch() existentes
- Botones legacy ocultos (display:none)
- Servida exclusivamente local con `python3 -m http.server 8000`

### GitHub

- main al día (commit `9f3dd9b`)
- **GitHub Pages: UNPUBLISHED** (al cierre de sesión 22 mayo)
- 2 PRs mergeados (#128, #129)
- ~20 branches remotas obsoletas pendientes de cleanup (no crítico)

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

