#!/bin/sh
set -eu

url=${ENVE_SERVER_URL:-http://127.0.0.1:4317}
command -v cage >/dev/null 2>&1 || { echo 'Install cage before starting the full display.' >&2; exit 1; }
command -v cog >/dev/null 2>&1 || { echo 'Install cog before starting the full display.' >&2; exit 1; }

attempt=0
until curl -fsS "$url/api/setup/status" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo 'Enve Family server did not start.' >&2
    exit 1
  fi
  sleep 1
done

export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec cage -- sh -c 'sh "$1/configure-display.sh"; exec cog --platform=wl "$2/?kiosk=1"' sh "$launcher_dir" "$url"
