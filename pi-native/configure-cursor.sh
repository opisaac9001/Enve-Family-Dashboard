#!/bin/sh
cursor_mode=${ENVE_CURSOR_MODE:-auto}
if [ "$cursor_mode" = auto ]; then
  cursor_mode=hidden
  for input_device in /dev/input/event*; do
    [ -e "$input_device" ] || continue
    properties=$(udevadm info --query=property --name="$input_device" 2>/dev/null || true)
    printf '%s\n' "$properties" | grep -qx 'ID_INPUT_MOUSE=1' || continue
    if printf '%s\n' "$properties" | grep -Eq '^(ID_INPUT_TOUCHSCREEN|LIBINPUT_IGNORE_DEVICE)=1$'; then
      continue
    fi
    cursor_mode=visible
    break
  done
fi
if [ "$cursor_mode" = hidden ]; then
  export XCURSOR_THEME=enve-hidden
  export XCURSOR_PATH="$launcher_dir/cursors"
fi
