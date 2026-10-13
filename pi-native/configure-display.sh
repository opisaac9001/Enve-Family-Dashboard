#!/bin/sh
set -eu

randr=$(command -v wlr-randr || true)
if [ -z "$randr" ] && [ -x "$HOME/.local/bin/wlr-randr" ]; then
  randr="$HOME/.local/bin/wlr-randr"
fi
[ -n "$randr" ] || exit 0

hdmi=
dp=
for status in /sys/class/drm/card*-*/status; do
  [ -f "$status" ] && [ "$(cat "$status")" = connected ] || continue
  connector=${status%/status}
  connector=${connector##*/}
  connector=${connector#card*-}
  case "$connector" in
    HDMI-A-*) hdmi=$connector ;;
    DP-*) dp=$connector ;;
  esac
done

# HDMI and USB-C can expose the same touchscreen as two displays.
if [ -n "$hdmi" ] && [ -n "$dp" ]; then
  "$randr" --output "$dp" --off --output "$hdmi" --pos 0,0
fi
