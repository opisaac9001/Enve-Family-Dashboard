#!/bin/sh
set -eu

display_user=${ENVE_DISPLAY_USER:?Set ENVE_DISPLAY_USER to the Linux display account.}
driver_root=${ENVE_PVR_ROOT:?Set ENVE_PVR_ROOT to the extracted vendor driver directory.}
config=${ENVE_XORG_CONFIG:?Set ENVE_XORG_CONFIG to the Xorg configuration file.}
url=${ENVE_SERVER_URL:-http://127.0.0.1:4317}
runtime=${RUNTIME_DIRECTORY:-/run/enve-family-vulkan}
display_home=$(getent passwd "$display_user" | cut -d: -f6)
display_uid=$(id -u "$display_user")
display_gid=$(id -g "$display_user")

test -e /dev/dri/renderD128
test -f "$driver_root/usr/lib/libVK_IMG.so"
install -d -m 700 -o "$display_uid" -g "$display_gid" "$runtime/user"
export XAUTHORITY="$runtime/Xauthority"
export DISPLAY=:0
export LD_LIBRARY_PATH="$driver_root/usr/local/lib:$driver_root/usr/lib"
export LIBGL_DRIVERS_PATH="$driver_root/usr/local/lib/dri"

python3 - "$XAUTHORITY" "$display_uid" "$display_gid" "$driver_root" "$runtime" <<'PY'
import json
import os
import secrets
import subprocess
import sys

authority, uid, gid, driver, runtime = sys.argv[1:]
with open(authority, 'w'):
    pass
os.chmod(authority, 0o600)
subprocess.run(['xauth', '-f', authority], input=f'add :0 . {secrets.token_hex(16)}\n',
               text=True, check=True, stdout=subprocess.DEVNULL)
os.chown(authority, int(uid), int(gid))
with open(f'{runtime}/img_icd.json', 'w') as manifest:
    json.dump({'file_format_version': '1.0.0', 'ICD': {
        'library_path': f'{driver}/usr/lib/libVK_IMG.so', 'api_version': '1.3.277'
    }}, manifest)
PY

attempt=0
until curl -fsS "$url/api/setup/status" >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done

/usr/lib/xorg/Xorg :0 -config "$config" \
  -modulepath "$driver_root/usr/lib/xorg/modules,/usr/lib/xorg/modules" \
  -auth "$XAUTHORITY" -nolisten tcp -extension GLX \
  -logfile "$runtime/Xorg.log" vt1 -keeptty &
xpid=$!
trap 'kill "$xpid" 2>/dev/null || true; wait "$xpid" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM

attempt=0
until xrandr --query >/dev/null 2>&1; do
  kill -0 "$xpid"
  attempt=$((attempt + 1))
  [ "$attempt" -lt 10 ] || exit 1
  sleep 1
done
xrandr --output DP-1 --off --output HDMI-1 --primary --preferred

runuser -u "$display_user" -- setpriv --inh-caps=-all --ambient-caps=-all \
  env HOME="$display_home" DISPLAY=:0 XAUTHORITY="$XAUTHORITY" \
  LD_LIBRARY_PATH="$LD_LIBRARY_PATH" LIBGL_DRIVERS_PATH="$LIBGL_DRIVERS_PATH" \
  VK_ICD_FILENAMES="$runtime/img_icd.json" XDG_RUNTIME_DIR="$runtime/user" \
  dbus-run-session -- chromium --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble \
  --user-data-dir="$display_home/.local/share/enve-family-chromium-trial" \
  --ozone-platform=x11 --use-gl=angle --use-angle=vulkan \
  --enable-features=Vulkan,VulkanFromANGLE --ignore-gpu-blocklist \
  --window-position=0,0 --window-size=1920,1200 --kiosk "$url/?kiosk=1"
