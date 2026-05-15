# Notas de seguridad — Piso Libro

Estado actual: **Riesgo medio**. La app es funcional pero hay dos cosas
que conviene atender cuando puedas.

## 1. `SUPA_KEY` (anon key) embebida en scripts del navegador

**Dónde está:**
- `scripts/winlab-bookmarklet.js` (línea ~40, constante `K`)
- `scripts/winlab-tampermonkey.user.js` (línea ~16, constante `SUPA_KEY`)
- `.github/workflows/keepalive.yml` (variable `SUPA_KEY`)
- `index.html` (constante `SUPA_KEY`)

**¿Es grave?** No es catastrófico — la `anon key` está diseñada para
exposición pública (es la que usa cualquier cliente web). El riesgo real
viene de combinarla con **RLS permisivas** (ver punto 2).

**Qué hacer si llegas a sospechar abuso:**
1. Supabase Dashboard → Project Settings → API → Reset anon key
2. Reemplazar en los 4 archivos de arriba
3. `git commit` + push
4. Pedir a los residentes que abran la app de nuevo para refrescar el bundle

## 2. RLS permisivas (todos los anon pueden leer/escribir todo)

**Configuración actual:** `scripts/supabase_rls_permissive.sql`
crea policies `USING (true) WITH CHECK (true)` para rol `anon` en todas
las tablas. Esto significa que **cualquiera con la URL+key puede leer
o modificar cualquier registro**.

**Por qué se eligió así:**
La app no usa Supabase Auth (no hay magic links ni JWT). El login en
piso-libro es solo local (validación contra `users` table en frontend).
Hacer policies por usuario requiere primero migrar a Supabase Auth.

**Plan para endurecer (cuando tengas tiempo):**

### Opción A — Lectura pública, escritura por usuario
Permite ver pero no modificar. Requiere mover el login a Supabase Auth.

```sql
-- Ejemplo para tabla patients
DROP POLICY IF EXISTS "piso_libro_full_access_anon" ON public.patients;
CREATE POLICY "patients_read_anon" ON public.patients
  FOR SELECT TO anon USING (true);
CREATE POLICY "patients_write_auth" ON public.patients
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
```

### Opción B — Acceso solo desde dominio fijo
Combinar RLS + restricción de Origin en Supabase Dashboard
(Auth → URL Configuration → Site URL).

### Opción C — Mantener como está
Aceptable si:
- No se filtra la `SUPA_URL` en lugares públicos
- Los datos no incluyen información identificable de pacientes
  (en este caso, **sí los incluye**, así que conviene endurecer)

## 3. Token del Cloudflare Worker

**Ubicación:** Configurado en `Config` de la app (campo `Worker token`).
Se envía como header `X-Piso-Token` en cada extracción de labs.

**Estado:** ✅ Bien — es un secret separado, no está en el código.
El token actual debe coincidir con `WORKER_TOKEN` en Cloudflare Dashboard.

**Rotación:** Si sospechas de filtración:
1. Cloudflare Dashboard → Workers → piso-labs-worker → Settings → Variables
2. Rotar `WORKER_TOKEN`
3. Actualizar en piso-libro → Config → Worker token

## 4. `ANTHROPIC_API_KEY`

✅ Configurada como secret en Cloudflare Dashboard. No expuesta en código.
