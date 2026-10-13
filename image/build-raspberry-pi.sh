#!/bin/bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=${1:-}
if [ -z "$build_dir" ]; then
  echo 'Usage: image/build-raspberry-pi.sh /absolute/linux/build/directory' >&2
  exit 1
fi
if [ "$(uname -s)" != Linux ]; then
  echo 'Build this image on a Linux host. Raspberry Pi Imager can flash the result from a Mac.' >&2
  exit 1
fi
case "$build_dir" in
  /*) ;;
  *) echo 'Use an absolute build directory.' >&2; exit 1 ;;
esac
case "$build_dir" in
  *' '*) echo 'The build directory cannot contain spaces.' >&2; exit 1 ;;
esac
[ ! -e "$build_dir" ] || { echo 'The build directory already exists.' >&2; exit 1; }
[ -z "$(git -C "$root" status --porcelain)" ] || { echo 'Commit or set aside local changes before building an image.' >&2; exit 1; }

sudo apt-get update
sudo apt-get install -y coreutils quilt parted qemu-user-static debootstrap zerofree zip \
  dosfstools e2fsprogs libcap2-bin grep rsync xz-utils file git curl bc gpg pigz xxd \
  arch-test bmap-tools kmod

mkdir -p "$build_dir"
git clone --depth 1 --branch arm64 https://github.com/RPi-Distro/pi-gen.git "$build_dir/pi-gen"
cp -a "$root/image/raspberry-pi/stage" "$build_dir/enve-stage"
mkdir -p "$build_dir/enve-stage/01-enve/files/app"
git -C "$root" archive HEAD | tar -x -C "$build_dir/enve-stage/01-enve/files/app"
rm "$build_dir/pi-gen/stage2/EXPORT_IMAGE"
rm "$build_dir/pi-gen/export-image/01-user-rename/00-packages"
rm "$build_dir/pi-gen/export-image/01-user-rename/01-run.sh"
cat > "$build_dir/pi-gen/config" <<EOF
IMG_NAME='enve-family-raspberry-pi'
PI_GEN_RELEASE='Enve Family'
RELEASE='trixie'
DEPLOY_COMPRESSION='xz'
STAGE_LIST='stage0 stage1 stage2 $build_dir/enve-stage'
ENABLE_CLOUD_INIT=0
ENABLE_SSH=0
FIRST_USER_NAME='pi'
EOF
printf 'Enve commit: %s\npi-gen commit: %s\n' \
  "$(git -C "$root" rev-parse HEAD)" \
  "$(git -C "$build_dir/pi-gen" rev-parse HEAD)" > "$build_dir/build-sources.txt"

cd "$build_dir/pi-gen"
sudo ./build.sh
printf 'Image output: %s\n' "$build_dir/pi-gen/deploy"
