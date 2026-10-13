#!/bin/bash -e

install -d -m 0755 "${ROOTFS_DIR}/opt/enve-family"
cp -a files/app/. "${ROOTFS_DIR}/opt/enve-family/"
on_chroot <<'EOF'
sh /opt/enve-family/image/install-enve.sh
EOF
