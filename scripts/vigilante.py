#!/usr/bin/env python3
"""Vigilante del sistema (27 oct 2026): revisa cada pieza por su última señal de vida en Supabase y termina en ROJO
(GitHub manda el correo de «workflow failed» al dueño) si alguna se atrasó. Solo imprime horas y conteos: nada de
pacientes (la bitácora de GitHub Actions es pública).

  SUPABASE_URL=… SUPABASE_SERVICE_KEY=… python3 scripts/vigilante.py

Límites (horas): el robot de labs corre a las 05:00, 12:30 y 20:07 (hueco máximo 8 h 53 min + la corrida); el del RIS
cada 2 h (respaldo de GitHub cada 4-6 h); la descarga del Doc de indicaciones cada 15 min; el censo cambia varias veces
al día (si nada cambia en 18 h, el script del censo probablemente se detuvo)."""
import datetime as dt
import json
import os
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
     "El script del censo (Apps Script «Proyecto sin título») pudo detenerse: ábrelo y revisa sus ejecuciones."),
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
    resumen = "### Vigilante del sistema\n\n| Pieza | Última señal | Límite | |\n|---|---|---|---|\n" + "\n".join(f"| {a} | {b} | {c} | {d} |" for a, b, c, d in filas) + "\n"
    print(resumen)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(resumen)
    return 1 if errores else 0


if __name__ == "__main__":
    sys.exit(main())
