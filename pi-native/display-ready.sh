#!/bin/sh
for status in /sys/class/drm/card*-*/status; do
  [ -f "$status" ] || continue
  [ "$(cat "$status")" = connected ] && exit 0
done
[ -e /dev/fb0 ] || [ -e /dev/fb1 ]
