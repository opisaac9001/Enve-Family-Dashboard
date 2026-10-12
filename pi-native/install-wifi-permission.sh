#!/bin/sh
set -eu

user=${1:-}
case "$user" in
  ''|*[!a-zA-Z0-9_-]*) echo 'Pass the Linux user running Enve Family.' >&2; exit 1 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
id "$user" >/dev/null 2>&1 || { echo 'That Linux user does not exist.' >&2; exit 1; }

cat > /etc/polkit-1/rules.d/49-enve-family-wifi.rules <<EOF
polkit.addRule(function(action, subject) {
  if (subject.user === "$user" && [
    "org.freedesktop.NetworkManager.network-control",
    "org.freedesktop.NetworkManager.settings.modify.system",
    "org.freedesktop.NetworkManager.wifi.scan"
  ].indexOf(action.id) !== -1) return polkit.Result.YES;
});
EOF
chmod 0644 /etc/polkit-1/rules.d/49-enve-family-wifi.rules
