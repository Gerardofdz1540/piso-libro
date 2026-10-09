# Piso Libro — Manual de operación (explicado fácil)

Este documento explica, paso a paso y sin tecnicismos, cómo está armada la app
y qué hacer cuando algo falla. Si solo tienes 1 minuto: lee "¿Qué hace cada
pieza?" y "Si los laboratorios no llegan".

## ¿Qué hace cada pieza?

Imagina una fábrica con cuatro máquinas que trabajan solas:

1. **La app** (lo que abres en el navegador): https://pisolibro.pages.dev
   Cada vez que alguien fusiona un cambio en la rama `main` de GitHub, la app
   se vuelve a publicar sola en menos de un minuto.
2. **La hoja del censo** (Google Sheets). Un pequeño programa (Apps Script)
   la lee cada 5 minutos y copia los pacientes a la base de datos. Si cambias
   una cama en la hoja, en 5 minutos la app lo refleja, con su nota intacta.
3. **El robot de laboratorios** (GitHub Actions, carpeta `rpa/`). Tres veces al
   día entra a WinLab, busca a cada paciente del censo, descarga sus
   laboratorios y los guarda en la base de datos. Horarios (hora de León):
   04:07, 13:15 y 20:07.
4. **La base de datos** (Supabase). Guarda pacientes, notas, laboratorios y la
   papelera. Solo se puede entrar con usuario y contraseña de la app.

## Una sola dirección para todos

Todo el equipo debe usar **https://pisolibro.pages.dev**. Las direcciones
viejas (GitHub Pages, Netlify) sirven versiones antiguas que borran datos de
los laboratorios. Si alguien tiene la app "instalada" en el teléfono desde
otra dirección, que la borre y la vuelva a instalar desde esta.

## Paso a paso: actualizar el programa de la hoja (Apps Script)

Hay que hacerlo **cada vez** que cambie el archivo `apps-script/censo-sync.gs`
en GitHub (el aviso lo da el PR). Son 2 minutos:

1. Abre en GitHub el archivo
   `https://github.com/Gerardofdz1540/piso-libro/blob/main/apps-script/censo-sync.gs`.
2. Pulsa el botón **Raw** (arriba a la derecha del archivo). Se abre texto
   plano. Selecciona todo (`Ctrl+A`) y copia (`Ctrl+C`).
3. Abre la hoja del censo en Google Sheets.
4. Menú **Extensiones → Apps Script**. Se abre el editor.
5. En la lista de la izquierda pulsa `Código.gs`. En el cuadro grande
   selecciona todo (`Ctrl+A`), borra, y pega (`Ctrl+V`) lo que copiaste.
6. Pulsa el icono de **guardar** (disquete) o `Ctrl+S`.
7. Arriba, en el selector de función (dice `doSync` o similar), elige
   **`createTriggers`** y pulsa **▶ Ejecutar**. Si Google pide permisos:
   **Revisar permisos → tu cuenta → Permitir**.
8. Para comprobar: elige **`checkLabsFreshness`**, pulsa **▶ Ejecutar** y
   abre **Ver → Registros**. Debe decir la hora del último laboratorio
   descargado.

Listo. A partir de ahora, si el robot de laboratorios se detiene más de un
día, recibes un correo con las instrucciones para reactivarlo.

## Paso a paso: borrar ramas viejas en GitHub

Las ramas son "copias de trabajo" que ya se fusionaron y solo estorban.

1. Entra a https://github.com/Gerardofdz1540/piso-libro/branches
2. En cada rama de la lista de abajo, pulsa el icono de **bote de basura**
   que está a la derecha:
   - `claude/unify-trunk`
   - `claude/app-p0-quickwins`
   - `claude/scraper-p0-incremental`
   - `claude/apps-script-archive-move`
   - `claude/app-winlab-labs`
   - `claude/scraper-age-guard`
   - `feature/winlab-auto-sync` (solo después del paso de Cloudflare de abajo)
3. No borres `main`.

## Paso a paso: decirle a Cloudflare que `main` es la rama de producción

Hoy Cloudflare publica la app en producción porque el deploy "se disfraza" de
la rama vieja `feature/winlab-auto-sync`. Para dejarlo limpio:

1. Entra a https://dash.cloudflare.com → **Workers & Pages** → proyecto
   **pisolibro**.
2. Pestaña **Settings → Builds & deployments** (o "Configuración →
   Compilaciones e implementaciones").
3. En **Production branch** escribe `main` y guarda.
4. Avísame y cambio una línea del archivo `.github/workflows/deploy-pages.yml`
   (`--branch=feature/winlab-auto-sync` → `--branch=main`). Hasta entonces,
   NO borres la rama `feature/winlab-auto-sync`.

## Si los laboratorios no llegan

1. Abre https://github.com/Gerardofdz1540/piso-libro/actions/workflows/winlab-scraper.yml
2. Mira la lista de corridas. Cada día debe haber tres (04:07, 13:15 y 20:07
   hora de León). Un círculo verde es éxito; rojo es error.
3. Si arriba aparece un aviso amarillo que dice **"This scheduled workflow is
   disabled"**: pulsa **Enable workflow**. (GitHub apaga el robot si el
   repositorio pasa 60 días sin cambios; el robot ya se "mantiene despierto"
   solo, pero por si acaso.)
4. Para lanzarlo a mano: botón **Run workflow** (a la derecha) → **Run
   workflow**. Tarda 30–60 minutos. En la app, el botón "Labs" también lo
   dispara con clic derecho.
5. Si la corrida está en rojo, abre la corrida, pulsa el paso rojo y copia las
   últimas líneas del registro; mándamelas y lo reviso. Nunca pegues ahí
   nombres de pacientes en mensajes públicos.

## Si un paciente desapareció del censo

1. En la app, abre la pestaña **Papelera**.
2. Pulsa **☁️ Cargar desde nube**. Aparecen los pacientes que salieron del
   censo (por egreso, por el Excel o por la hoja), cada uno con su nota.
3. Pulsa **↩ Restaurar** en el paciente. Vuelve al censo con su nota.

## Si algo sale muy mal con las notas de laboratorio

El 9 de octubre de 2026 se hizo una limpieza de valores erróneos (pH y
hemoglobina de orina guardados como sangre). Antes de tocar nada se guardó una
copia completa en la tabla `notes_lab_history_backup_20261009` de Supabase.
Para volver a como estaba, en Supabase → SQL Editor:

```sql
update notes n set lab_history = b.lab_history
from notes_lab_history_backup_20261009 b where b.patient_id = n.patient_id;
```

## ¿Dónde vive cada cosa en el repositorio?

| Carpeta / archivo | Qué es |
|---|---|
| `index.html` | Toda la app (un solo archivo) |
| `apps-script/censo-sync.gs` | El programa de la hoja del censo (se pega a mano en Google) |
| `rpa/` | El robot de laboratorios (WinLab → Supabase) |
| `.github/workflows/winlab-scraper.yml` | Los horarios y la configuración del robot |
| `.github/workflows/deploy-pages.yml` | Cómo se publica la app en Cloudflare |
| `cloudflare-worker/` | El ayudante de IA (extraer labs de PDF, disparar el robot) |
| `scripts/supabase_rls_current.sql` | La configuración de seguridad vigente de la base de datos |
| `scripts/SECURITY_NOTES.md` | Qué llaves existen y qué hacer si se filtra alguna |
