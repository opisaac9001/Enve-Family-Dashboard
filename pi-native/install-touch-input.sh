#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run this installer as root.' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0644 "$source_dir/udev/99-enve-touchscreen.rules" /etc/udev/rules.d/99-enve-touchscreen.rules
if [ "${ENVE_IMAGE_BUILD:-0}" != 1 ]; then
  udevadm control --reload-rules
  udevadm trigger --subsystem-match=input --action=change
fi
