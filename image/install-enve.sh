#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo 'Run as root inside the image.' >&2; exit 1; }
[ -f /opt/enve-family/package-lock.json ] || { echo 'Enve source is missing from the image.' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils network-manager policykit-1 cage cog \
  fonts-dejavu-core poppler-utils tesseract-ocr webp

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
sed -e 's/REPLACE_USER/enve/g' -e 's#REPLACE_ROOT#/opt/enve-family#g' \
  pi-native/systemd/enve-family-full-display.service > /etc/systemd/system/enve-family-display.service
install -m 0644 pi-native/systemd/enve-family-tailscale-operator.service \
  /etc/systemd/system/enve-family-tailscale-operator.service
sh pi-native/install-wifi-permission.sh enve
ENVE_IMAGE_BUILD=1 sh pi-native/install-tailscale.sh enve
systemctl enable NetworkManager enve-family.service enve-family-display.service \
  enve-family-tailscale-operator.service

chown -R root:root /opt/enve-family
chown enve:enve /opt/enve-family/data
chmod 0700 /opt/enve-family/data
