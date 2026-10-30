#!/usr/bin/env python3
"""Vigilante del sistema (27 oct 2026): revisa cada pieza por su última señal de vida en Supabase y termina en ROJO
(GitHub manda el correo de «workflow failed» al dueño) si alguna se atrasó. Solo imprime horas y conteos: nada de
pacientes (la bitácora de GitHub Actions es pública).

  SUPABASE_URL=… SUPABASE_SERVICE_KEY=… python3 scripts/vigilante.py

Límites (horas): el robot de labs corre a las 05:00, 12:30 y 20:07 (hueco máximo 8 h 53 min + la corrida); el del RIS
cada 2 h (respaldo de GitHub cada 4-6 h); la descarga del Doc de indicaciones cada 15 min; el censo cambia varias veces
al día (si nada cambia en 18 h, el script del censo probablemente se detuvo). Además: la última respuesta del worker a
cada disparo de Supabase (winlab_dispatch_log) y que sigan puestas las protecciones de la base (pl_salud_catalogo)."""
import datetime as dt
import json
import os
import re
import sys
import urllib.request

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
AHORA = dt.datetime.now(dt.timezone.utc)

CHEQUEOS = [
    # (nombre, tabla, columna, límite en horas, qué hacer)
    ("Robot de labs (última revisión)", "winlab_match", "checked_at", 11,
     "Revisa la última corrida de winlab-scraper.yml y winlab_dispatch_log en Supabase (disparos de las 05:00, 12:30 y 20:07)."),
    ("Labs guardados", "winlab_labs", "scraped_at", 26,
     "El robot corre pero no guarda labs: revisa su bitácora (login de WinLab, contraseña vencida)."),
    ("Estudios de imagen (RIS)", "ris_estudios", "scraped_at", 10,
     "Revisa la última corrida de ris-scraper.yml (login del RIS, contraseña en rpa_config)."),
    ("Descarga del Doc de indicaciones", "indicaciones_fetch_log", "requested_at", 2,
     "Revisa los trabajos de pg_cron de indicaciones en Supabase."),
    ("Censo (último cambio de un paciente)", "patients", "updated_at", 18,
     "El script del censo (Apps Script «PisoLibro – Sync Censo») pudo detenerse: ábrelo y revisa sus ejecuciones."),
]


def get(path):
    req = urllib.request.Request(URL + path, headers={"apikey": KEY, "Authorization": "Bearer " + KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8") or "null")


def post(path, body):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8") or "null")


def edad_horas(ts):
    s = str(ts).replace("Z", "+00:00").replace(" ", "T")
    if "." in s:
        cabeza, resto = s.split(".", 1)
        zona = resto[next((i for i, c in enumerate(resto) if c in "+-"), len(resto)):]
        s = cabeza + zona
    t = dt.datetime.fromisoformat(s)
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return round((AHORA - t).total_seconds() / 3600, 1)


def revisar_disparos(filas):
    """Último disparo de cada robot desde Supabase (winlab_dispatch_log). El worker responde 200 con dispatched:true o
    already_pending; cualquier otra cosa (401 token, 502 GitHub rechazó: GITHUB_TOKEN vencido, 503 sin token) es ROJO.
    Para el RIS un 404 solo avisa: es el worker viejo sin /api/scrape-ris (el cron de GitHub sigue de respaldo)."""
    errores = 0
    for nombre, filtro in (("Disparo del robot de labs", "not.like.RIS*"), ("Disparo del robot del RIS", "like.RIS*")):
        try:
            # checked_at: ya se recogió la respuesta (winlab_dispatch_collect, cada 15 min); sin status_code = timeout.
            r = get(f"/rest/v1/winlab_dispatch_log?select=ts,reason,status_code,response,error_msg&reason={filtro}"
                    "&checked_at=not.is.null&order=ts.desc&limit=1")
        except Exception as e:
            filas.append((nombre, f"no se pudo leer ({type(e).__name__})", "", "⚠️"))
            continue
        if not r:
            filas.append((nombre, "sin disparos registrados", "", "⚠️" if "RIS" in nombre else "❌"))
            if "RIS" not in nombre:
                errores += 1
                print(f"::error title={nombre}::No hay disparos con respuesta en winlab_dispatch_log.")
            continue
        d = r[0]
        cod, resp = d.get("status_code"), str(d.get("response") or "")
        ok = cod == 200 and ('"dispatched":true' in resp.replace(" ", "") or "already_pending" in resp)
        h = edad_horas(d.get("ts")) if d.get("ts") else None
        estado = (f"HTTP {cod}" if cod is not None else f"sin respuesta ({d.get('error_msg') or '?'})") + f" hace {h} h"
        if ok:
            filas.append((nombre, estado, "HTTP 200", "✅"))
        elif "RIS" in nombre and cod == 404:
            filas.append((nombre, estado, "HTTP 200", "⚠️"))
            print(f"::warning title={nombre}::El worker publicado no tiene /api/scrape-ris (HTTP 404). "
                  "Pega cloudflare-worker/index.js en Cloudflare (worker piso-libro-ai). Mientras, sigue el cron de GitHub.")
        else:
            errores += 1
            filas.append((nombre, estado, "HTTP 200", "❌"))
            print(f"::error title={nombre} falló::{estado}. 401 = token del worker (config.worker_config); "
                  "502/503 = GITHUB_TOKEN del worker vencido o sin permiso actions:write. Ver «Llaves y vencimientos» en el manual.")
    return errores


def revisar_catalogo(filas):
    """Protecciones de la base (pl_salud_catalogo): triggers de notas y pacientes, RLS, políticas y trabajos de pg_cron."""
    try:
        r = post("/rest/v1/rpc/pl_salud_catalogo", {}) or {}
    except Exception as e:
        filas.append(("Protecciones de la base", f"no se pudo revisar ({type(e).__name__})", "", "⚠️"))
        return 0
    faltan = r.get("faltan") or []
    if r.get("ok") and not faltan:
        filas.append(("Protecciones de la base", f"{r.get('revisados', '?')} revisadas", "todas puestas", "✅"))
        return 0
    filas.append(("Protecciones de la base", f"faltan {len(faltan)}", "todas puestas", "❌"))
    print("::error title=Falta una protección de la base::" + "; ".join(str(x) for x in faltan)[:900]
          + ". Revisa los scripts/*.sql del repo (cada uno dice qué instala) antes de seguir usando la app.")
    return 1


RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Pieza (como la reporta pl_reportar_version) → archivo del repo y la constante con su versión.
APPS_SCRIPT = [("censo-sync", "apps-script/censo-sync.gs", "CENSO_SYNC_VERSION", "el script del censo («PisoLibro – Sync Censo»)", 2),
               ("registro", "apps-script/registro-pacientes.gs", "REGISTRO_VERSION", "el script «Registro de pacientes»", 3)]


def version_repo(archivo, constante):
    try:
        with open(os.path.join(RAIZ, archivo), encoding="utf-8") as f:
            m = re.search(r"var\s+" + constante + r"\s*=\s*'([^']+)'", f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def revisar_versiones(filas):
    """Los Apps Script se pegan a mano (hallazgo 58): cada uno reporta su versión una vez al día (config «versiones»).
    Si no coincide con la del repositorio, falta pegarlo; si no reporta en días, quizá se detuvo. Solo avisa (amarillo)."""
    try:
        r = get("/rest/v1/config?select=value&key=eq.versiones")
        vers = (r[0].get("value") if r else None) or {}
    except Exception as e:
        filas.append(("Versiones de los Apps Script", f"no se pudo leer ({type(e).__name__})", "", "⚠️"))
        return
    for pieza, archivo, constante, quien, dias in APPS_SCRIPT:
        esperada = version_repo(archivo, constante)
        d = vers.get(pieza) or {}
        instalada, visto = d.get("version"), d.get("visto")
        h = edad_horas(visto) if visto else None
        nombre = f"Versión de {archivo.split('/')[-1]}"
        if not instalada:
            filas.append((nombre, "aún no la reporta", esperada or "?", "⚠️"))
            print(f"::warning title={nombre}::{quien} todavía no reporta su versión: pega {archivo} del repositorio (versión {esperada}).")
        elif esperada and instalada != esperada:
            filas.append((nombre, f"instalada {instalada}", esperada, "⚠️"))
            print(f"::warning title={nombre} vieja::{quien} tiene la versión {instalada} y el repositorio la {esperada}: pega {archivo}.")
        elif h is not None and h > 24 * dias:
            filas.append((nombre, f"{instalada}, sin reportar hace {h} h", esperada or "?", "⚠️"))
            print(f"::warning title={nombre} sin reportar::{quien} no reporta desde hace {h} h: revisa sus ejecuciones y sus activadores.")
        else:
            filas.append((nombre, instalada, esperada or "?", "✅"))


def main():
    if not URL or not KEY:
        print("::error title=Vigilante::Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY")
        return 1
    filas, errores = [], 0
    for nombre, tabla, col, limite, consejo in CHEQUEOS:
        try:
            r = get(f"/rest/v1/{tabla}?select={col}&{col}=not.is.null&order={col}.desc&limit=1")
            ultimo = r[0][col] if r else None
        except Exception as e:  # sin respuesta: también es una falla
            ultimo, consejo = None, f"No respondió ({type(e).__name__}). " + consejo
        h = edad_horas(ultimo) if ultimo else None
        ok = h is not None and h <= limite
        filas.append((nombre, f"hace {h} h" if h is not None else "sin datos", f"≤ {limite} h", "✅" if ok else "❌"))
        if not ok:
            errores += 1
            print(f"::error title={nombre} atrasado::{'Sin datos' if h is None else f'Última señal hace {h} h'} (límite {limite} h). {consejo}")
    # Tamaño de la base (plan gratuito: 500 MB; al pasarlo Supabase la deja en solo lectura).
    try:
        t = post("/rest/v1/rpc/pl_tamano_base_calc", {}) or {}
        nivel, mb, lim = t.get("nivel", "?"), t.get("db_mb", "?"), t.get("limite_mb", "?")
        marca = "✅" if nivel == "ok" else ("⚠️" if nivel == "aviso" else "❌")
        filas.append(("Tamaño de la base", f"{mb} MB de {lim}", "nivel ok", marca))
        if nivel not in ("ok", "aviso"):
            errores += 1
            print(f"::error title=Base casi llena::{mb} MB de {lim} (nivel {nivel}). Ver «Espacio en la nube» en el manual.")
        elif nivel == "aviso":
            print(f"::warning title=Base creciendo::{mb} MB de {lim}. Ver «Espacio en la nube» en el manual.")
    except Exception as e:
        filas.append(("Tamaño de la base", f"no se pudo leer ({type(e).__name__})", "", "⚠️"))
    errores += revisar_disparos(filas)
    errores += revisar_catalogo(filas)
    revisar_versiones(filas)
    resumen = "### Vigilante del sistema\n\n| Pieza | Última señal | Límite | |\n|---|---|---|---|\n" + "\n".join(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in filas) + "\n"
    print(resumen)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(resumen)
    return 1 if errores else 0


if __name__ == "__main__":
    sys.exit(main())
