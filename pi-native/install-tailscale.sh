#!/bin/sh
set -eu

user=${1:-}
case "$user" in
  ''|*[!a-zA-Z0-9_-]*) echo 'Pass the Linux user running Enve Family.' >&2; exit 1 ;;
esac
[ "$(id -u)" -eq 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
id "$user" >/dev/null 2>&1 || { echo 'That Linux user does not exist.' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'This setup requires systemd.' >&2; exit 1; }

if ! command -v tailscale >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { echo 'Install curl first.' >&2; exit 1; }
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl -fsSL https://tailscale.com/install.sh -o "$installer"
  sh "$installer"
fi

if [ "${ENVE_IMAGE_BUILD:-0}" = 1 ]; then
  systemctl enable tailscaled
  echo 'Tailscale is installed in the image. Device sign-in happens after first boot.'
else
  systemctl enable --now tailscaled
  tailscale set --operator="$user"
  echo 'Tailscale is ready. Connect this device in Enve Family Settings.'
fi
