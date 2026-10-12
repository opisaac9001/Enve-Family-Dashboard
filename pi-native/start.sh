#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
DATABASE_PATH=${DATABASE_PATH:-"$root/data/family.sqlite"}
ENVE_DEVICE_KEY_PATH=${ENVE_DEVICE_KEY_PATH:-"$(dirname -- "$DATABASE_PATH")/.device-key"}
HOST=${HOST:-0.0.0.0}
ENVE_SERVER_URL=${ENVE_SERVER_URL:-"http://127.0.0.1:${PORT:-4317}"}
ENVE_BIN_DIR=${ENVE_BIN_DIR:-pi-native/build}
if [ "$(uname -s)" = Linux ]; then
  SDL_VIDEODRIVER=${SDL_VIDEODRIVER:-kmsdrm}
  export SDL_VIDEODRIVER
fi
export DATABASE_PATH ENVE_DEVICE_KEY_PATH HOST ENVE_SERVER_URL

"${ENVE_NODE_BIN:-node}" server.js &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT INT TERM

attempt=0
until curl -fsS "$ENVE_SERVER_URL/api/setup/status" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Enve server did not start" >&2
    exit 1
  fi
  sleep 1
done

"$ENVE_BIN_DIR/enve-family-setup"
"$ENVE_BIN_DIR/enve-family-display"
