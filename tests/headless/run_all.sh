#!/usr/bin/env bash
# Sirve el directorio dado en los puertos de prueba y corre todas las suites headless.
#   pw/run_all.sh <dir-con-index.html> [suites...]
set -u
DIR="$1"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
PIDS=()
for p in 8766 8767 8771; do fuser -k "$p/tcp" >/dev/null 2>&1 || true; done
sleep 0.5
for p in 8766 8767 8771; do
  ( cd "$DIR" && exec python3 -m http.server "$p" --bind 127.0.0.1 >/dev/null 2>&1 ) &
  PIDS+=($!)
done
sleep 1
for p in 8766 8767 8771; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/index.html")
  [ "$code" = "200" ] || { echo "servidor $p no responde ($code)"; kill "${PIDS[@]}" 2>/dev/null; exit 3; }
done
SUITES=("$@"); [ ${#SUITES[@]} -eq 0 ] && SUITES=(noCdn mock app_p0 app_import app_winlab app_sync app_ipad app_misc app_ui app_ind app_nota app_offline app_hoja app_fotos app_vp app_admin app_robot app_entrega)
rc=0
for s in "${SUITES[@]}"; do
  echo "=== $s"
  timeout 300 node "$HERE/$s.js" > "${TMPDIR:-/tmp}/suite_$s.log" 2>&1
  grep -E "^(FAIL|CRASH|SCRIPT FAIL)" "${TMPDIR:-/tmp}/suite_$s.log" | head -20
  tail -1 "${TMPDIR:-/tmp}/suite_$s.log" | grep -q " 0 failed" || rc=1
  tail -1 "${TMPDIR:-/tmp}/suite_$s.log"
done
kill "${PIDS[@]}" 2>/dev/null
exit $rc
