#!/bin/sh
set -eu
user=${1:-}
case "$user" in
  ''|*[!a-zA-Z0-9_-]*) echo 'Pass the Linux user running Enve Family.' >&2; exit 1 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
id "$user" >/dev/null 2>&1
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /usr/local/lib/enve-family
install -o root -g root -m 0755 "$source_dir/device-control.py" /usr/local/lib/enve-family/device-control
cat > /etc/systemd/system/enve-family-device-control.socket <<UNIT
[Unit]
Description=Enve device controls
[Socket]
ListenStream=/run/enve-family-device.sock
SocketUser=$user
SocketMode=0600
Accept=yes
RemoveOnStop=true
[Install]
WantedBy=sockets.target
UNIT
cat > /etc/systemd/system/enve-family-device-control@.service <<'UNIT'
[Unit]
Description=Enve device control request
[Service]
ExecStart=/usr/bin/python3 /usr/local/lib/enve-family/device-control --socket
StandardInput=socket
StandardOutput=inherit
StandardError=journal
RuntimeMaxSec=20
ProtectHome=true
ProtectSystem=full
NoNewPrivileges=true
UNIT
# Replace the earlier sudo helper with a service that preserves the app sandbox.
rm -f /etc/sudoers.d/enve-family-device
systemctl daemon-reload
if [ "${ENVE_IMAGE_BUILD:-0}" = 1 ]; then
  systemctl enable enve-family-device-control.socket
else
  systemctl enable --now enve-family-device-control.socket
fi
