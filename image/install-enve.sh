#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'Run as root inside the image.' >&2; exit 1; }
[ -f /opt/enve-family/package-lock.json ] || { echo 'Enve source is missing from the image.' >&2; exit 1; }

profile=${ENVE_DEVICE_PROFILE:-raspberry-pi}
case "$profile" in
  raspberry-pi) ;;
  orange-pi-zero-3w)
    [ -f /opt/enve-family-pvr/usr/lib/libVK_IMG.so ] || {
      echo 'Prepare the Orange Pi PowerVR driver under /opt/enve-family-pvr first.' >&2
      exit 1
    }
    ;;
  *) echo 'Choose raspberry-pi or orange-pi-zero-3w.' >&2; exit 1 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils network-manager polkitd cage cog wlr-randr \
  fonts-dejavu-core poppler-utils tesseract-ocr webp python3 sudo

if [ "$profile" = orange-pi-zero-3w ]; then
  apt-get install -y chromium xserver-xorg-core xserver-xorg-input-libinput \
    x11-xserver-utils xauth dbus-user-session python3 netplan.io libxcb-dri2-0
fi

node_version=22.22.0
node_archive="node-v${node_version}-linux-arm64.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}"
node_dir=$(mktemp -d)
trap 'rm -rf "$node_dir"' EXIT HUP INT TERM
curl -fsSL "$node_url/$node_archive" -o "$node_dir/$node_archive"
curl -fsSL "$node_url/SHASUMS256.txt" -o "$node_dir/SHASUMS256.txt"
(cd "$node_dir" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$node_dir/$node_archive" -C /usr/local --strip-components=1

if ! id enve >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/enve-family --shell /bin/bash enve
fi
for group in video render input; do
  getent group "$group" >/dev/null || groupadd --system "$group"
  usermod -a -G "$group" enve
done

cd /opt/enve-family
/usr/local/bin/npm ci --omit=dev
install -d -m 0700 -o enve -g enve /opt/enve-family/data
sed -e 's/REPLACE_USER/enve/g' -e 's#REPLACE_ROOT#/opt/enve-family#g' \
  -e 's#/usr/bin/node#/usr/local/bin/node#g' \
  pi-native/systemd/enve-family.service > /etc/systemd/system/enve-family.service
if [ "$profile" = raspberry-pi ]; then
  display_service=enve-family-display.service
else
  display_service=enve-family-vulkan-display.service
  install -d /usr/local/lib/enve-family /etc/enve-family
  install -m 0755 pi-native/x11-vulkan-kiosk.sh /usr/local/lib/enve-family/x11-vulkan-kiosk.sh
  install -m 0644 pi-native/x11-orange-pi.conf /etc/enve-family/orange-pi-xorg.conf
  sed 's/REPLACE_USER/enve/g' pi-native/systemd/enve-family-vulkan-display.service \
    > /etc/systemd/system/enve-family-vulkan-display.service
  printf 'pvrsrvkm\n' > /etc/modules-load.d/enve-pvr.conf
  install -d /etc/systemd/system/enve-family-full-display.service.d
  cat > /etc/systemd/system/enve-family-full-display.service.d/software.conf <<'EOF'
[Service]
Environment=WLR_RENDERER=pixman
Environment=WLR_DRM_DEVICES=/dev/dri/card0
EOF
  cat > /etc/netplan/99-enve-wifi-manager.yaml <<'EOF'
network:
  version: 2
  wifis:
    wlan0:
      renderer: NetworkManager
EOF
  chmod 0600 /etc/netplan/99-enve-wifi-manager.yaml
  netplan generate
fi
fallback_service=enve-family-display.service
[ "$profile" = raspberry-pi ] || fallback_service=enve-family-full-display.service
sed -e 's/REPLACE_USER/enve/g' -e 's#REPLACE_ROOT#/opt/enve-family#g' \
  pi-native/systemd/enve-family-full-display.service > "/etc/systemd/system/$fallback_service"
install -d /etc/enve-family
printf '%s\n' "$profile" > /etc/enve-family/device-profile
install -m 0644 pi-native/systemd/enve-family-tailscale-operator.service \
  /etc/systemd/system/enve-family-tailscale-operator.service
sh pi-native/install-wifi-permission.sh enve
ENVE_IMAGE_BUILD=1 sh pi-native/install-device-control.sh enve
ENVE_IMAGE_BUILD=1 sh pi-native/install-touch-input.sh
ENVE_IMAGE_BUILD=1 sh pi-native/install-tailscale.sh enve
systemctl enable NetworkManager enve-family.service "$display_service" \
  enve-family-tailscale-operator.service

chown -R root:root /opt/enve-family
chown enve:enve /opt/enve-family/data
chmod 0700 /opt/enve-family/data
