#!/usr/bin/env python3
"""Pruebas sin red del vigilante (27 oct 2026): se reemplazan get/post por respuestas armadas y se revisa qué pieza
queda en rojo. Datos ficticios; no toca Supabase.

  python3 scripts/vigilante_test.py
"""
import contextlib
import datetime as dt
import io
import os
import sys

sys.dont_write_bytecode = True  # sin __pycache__ en el repo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("SUPABASE_URL", "https://ficticio.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "ficticia")
os.environ.pop("GITHUB_STEP_SUMMARY", None)
import vigilante as V  # noqa: E402

V.URL, V.KEY = "https://ficticio.supabase.co", "ficticia"
pasa = falla = 0


def hace(h):
    return (V.AHORA - dt.timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%S.123456+00:00")


VER_CENSO = V.version_repo("apps-script/censo-sync.gs", "CENSO_SYNC_VERSION")
VER_REG = V.version_repo("apps-script/registro-pacientes.gs", "REGISTRO_VERSION")


def escenario(disp_labs=None, disp_ris=None, catalogo=None, frescos=True, versiones=None):
    disp_labs = disp_labs if disp_labs is not None else [{"ts": hace(3), "reason": "cron 05:00 León", "status_code": 200, "response": '{"dispatched":true}'}]
    disp_ris = disp_ris if disp_ris is not None else [{"ts": hace(1), "reason": "RIS cron cada 2 h", "status_code": 200, "response": '{"dispatched": true}'}]
    catalogo = catalogo if catalogo is not None else {"ok": True, "faltan": [], "revisados": 53}

    vers = versiones if versiones is not None else {"censo-sync": {"version": VER_CENSO, "visto": hace(1)}, "registro": {"version": VER_REG, "visto": hace(20)}}

    def get(path):
        if path.startswith("/rest/v1/config"):
            return [{"value": vers}]
        if path.startswith("/rest/v1/winlab_dispatch_log"):
            return disp_ris if "like.RIS*" in path and "not.like" not in path else disp_labs
        col = path.split("select=")[1].split("&")[0]
        return [{col: hace(1 if frescos else 40)}]

    def post(path, body):
        if path.endswith("pl_tamano_base_calc"):
            return {"nivel": "ok", "db_mb": 120, "limite_mb": 500}
        if path.endswith("pl_salud_catalogo"):
            return catalogo
        raise AssertionError(path)

    V.get, V.post = get, post
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = V.main()
    return rc, out.getvalue()


def check(nombre, cond, extra=""):
    global pasa, falla
    if cond:
        pasa += 1
        print("✓ " + nombre)
    else:
        falla += 1
        print("✗ " + nombre + (" :: " + extra[:600] if extra else ""))


rc, out = escenario()
check("V1 todo al día: verde (exit 0), sin ::error", rc == 0 and "::error" not in out and "Protecciones de la base | 53 revisadas" in out, out)

rc, out = escenario(disp_ris=[{"ts": hace(1), "reason": "RIS cron cada 2 h", "status_code": 404, "response": '{"error":"Not Found"}'}])
check("V2 worker viejo sin /api/scrape-ris (404): solo aviso, sigue verde", rc == 0 and "::warning title=Disparo del robot del RIS" in out and "::error" not in out, out)

rc, out = escenario(disp_labs=[{"ts": hace(2), "reason": "cron 12:30 León", "status_code": 502, "response": '{"dispatched":false,"reason":"dispatch_failed"}'}])
check("V3 GitHub rechazó el disparo de labs (502, token vencido): rojo con la pista del GITHUB_TOKEN", rc == 1 and "::error title=Disparo del robot de labs falló::HTTP 502 hace" in out and "GITHUB_TOKEN" in out, out)

rc, out = escenario(disp_labs=[{"ts": hace(2), "reason": "cron 12:30 León", "status_code": 200, "response": '{"dispatched":false,"reason":"already_pending"}'}])
check("V4 ya había una corrida en cola (already_pending): verde", rc == 0 and "::error" not in out, out)

rc, out = escenario(catalogo={"ok": False, "faltan": ["trigger notes.pl_entrega_protegida", "RLS apagado en x"], "revisados": 53})
check("V5 falta una protección de la base: rojo y dice cuál", rc == 1 and "::error title=Falta una protección de la base::trigger notes.pl_entrega_protegida; RLS apagado en x" in out, out)

rc, out = escenario(disp_labs=[{"ts": hace(2), "reason": "cron 05:00 León", "status_code": None, "response": None, "error_msg": "timeout"}])
check("V6b el disparo de labs no tuvo respuesta (timeout del worker): rojo", rc == 1 and "sin respuesta (timeout)" in out, out)

rc, out = escenario(disp_labs=[])
check("V6 sin ningún disparo de labs registrado: rojo", rc == 1 and "::error title=Disparo del robot de labs::" in out, out)

rc, out = escenario(frescos=False)
check("V7 piezas atrasadas (40 h): rojo por cada una", rc == 1 and out.count("atrasado::") == 5, out)

check("V9 la versión de cada Apps Script se lee del repositorio", bool(VER_CENSO) and bool(VER_REG), f"{VER_CENSO} {VER_REG}")

rc, out = escenario(versiones={"censo-sync": {"version": "2026.10.01", "visto": hace(1)}})
check("V10 Apps Script viejo o que nunca reportó: solo aviso amarillo con el archivo a pegar, sigue verde",
      rc == 0 and "::warning title=Versión de censo-sync.gs vieja::" in out and "pega apps-script/censo-sync.gs" in out
      and "::warning title=Versión de registro-pacientes.gs::" in out and "::error" not in out, out)

rc, out = escenario(versiones={"censo-sync": {"version": VER_CENSO, "visto": hace(80)}, "registro": {"version": VER_REG, "visto": hace(20)}})
check("V11 el script del censo no reporta en más de 2 días: aviso (puede estar detenido)", rc == 0 and "censo-sync.gs sin reportar" in out, out)

check("V8 la salida no trae nombres ni expedientes (solo horas y conteos)", all(w not in out for w in ("JUAN", "PEREZ", "26-")), out)

print(f"{pasa} pass · {falla} fail")
sys.exit(1 if falla else 0)
