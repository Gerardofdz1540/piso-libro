#!/usr/bin/env bash
# Sirve el directorio dado en tres puertos libres y corre las suites headless (todas o las indicadas).
#   tests/headless/run_all.sh <dir-con-index.html> [suites...]
# Motor: BROWSER=chromium (por defecto) | webkit | firefox (ver _browser.js).
# Puertos: se eligen libres en cada corrida (ya no hay fuser -k ni puertos fijos: dos baterías pueden
# convivir) y se exportan como PL_PORT_A/B/C y PL_BASE_URL_A (mock), PL_BASE_URL_B (noCdn) y
# PL_BASE_URL (las demás). Sin esas variables cada suite usa su puerto de siempre (8766/8767/8771).
set -u
DIR="$1"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
LOGS="${TMPDIR:-/tmp}"
read -r PL_PORT_A PL_PORT_B PL_PORT_C < <(python3 -c '
import socket
s = [socket.socket() for _ in range(3)]
for x in s: x.bind(("127.0.0.1", 0))
print(*[x.getsockname()[1] for x in s])
for x in s: x.close()')
export PL_PORT_A PL_PORT_B PL_PORT_C
export PL_BASE_URL_A="http://127.0.0.1:$PL_PORT_A" PL_BASE_URL_B="http://127.0.0.1:$PL_PORT_B" PL_BASE_URL="http://127.0.0.1:$PL_PORT_C"
PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null' EXIT
for p in "$PL_PORT_A" "$PL_PORT_B" "$PL_PORT_C"; do
  ( cd "$DIR" && exec python3 -m http.server "$p" --bind 127.0.0.1 >/dev/null 2>&1 ) &
  PIDS+=($!)
done
for p in "$PL_PORT_A" "$PL_PORT_B" "$PL_PORT_C"; do
  code=000
  for _ in $(seq 1 50); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/index.html")
    [ "$code" = "200" ] && break
    sleep 0.2
  done
  [ "$code" = "200" ] || { echo "servidor $p no responde ($code)"; exit 3; }
done
echo "motor ${BROWSER:-chromium} · puertos $PL_PORT_A $PL_PORT_B $PL_PORT_C · logs $LOGS/suite_<suite>.log"
SUITES=("$@"); [ ${#SUITES[@]} -eq 0 ] && SUITES=(version_check noCdn mock app_p0 app_import app_winlab app_sync app_censo_rt app_ipad app_misc app_ui app_ind app_nota app_offline app_hoja app_fotos app_vp app_admin app_robot app_entrega app_pen app_labkeep app_cajas app_cxocr app_pencil app_expdup app_guardia app_espacio app_hotfix_carga app_labs_masivo app_ris app_labs_atrib app_clin app_sync2 app_botones)
rc=0
for s in "${SUITES[@]}"; do
  echo "=== $s"
  timeout 300 node "$HERE/$s.js" > "$LOGS/suite_$s.log" 2>&1
  grep -E "^(FAIL|CRASH|SCRIPT FAIL)" "$LOGS/suite_$s.log" | head -20
  tail -1 "$LOGS/suite_$s.log" | grep -q " 0 failed" || rc=1
  tail -1 "$LOGS/suite_$s.log"
done
exit $rc
