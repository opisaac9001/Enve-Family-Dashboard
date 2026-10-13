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

if [ -z "${WLR_RENDERER:-}" ]; then
  hardware_renderer=
  for render_node in /dev/dri/renderD*; do
    if [ -e "$render_node" ]; then
      hardware_renderer=1
      break
    fi
  done
  if [ -z "$hardware_renderer" ]; then
    export WLR_RENDERER=pixman
  fi
fi

export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
low_memory=${ENVE_LOW_MEMORY:-auto}
if [ "$low_memory" = auto ]; then
  memory_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
  if [ "$memory_kb" -le 786432 ]; then low_memory=1; else low_memory=0; fi
fi
set -- --platform=wl --enable-smooth-scrolling=false --enable-page-cache=false
if [ "$low_memory" = 1 ]; then
  set -- "$@" --web-mem-limit=256 --web-check-interval=5 \
    --web-conservative-threshold=0.5 --web-strict-threshold=0.75 \
    --net-mem-limit=64 --net-check-interval=5
fi
launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$launcher_dir/configure-cursor.sh"
exec cage -- sh -c 'launcher_dir=$1; url=$2; shift 2; sh "$launcher_dir/configure-display.sh"; exec cog "$@" "$url/?kiosk=1"' sh "$launcher_dir" "$url" "$@"
