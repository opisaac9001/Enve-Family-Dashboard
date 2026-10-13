#!/bin/bash -e

if [ ! -d "${ROOTFS_DIR}" ]; then
  copy_previous
fi
IMG_SUFFIX="-enve-family"
