# Flashable Enve Family images

Enve needs a different image for each board. The Raspberry Pi Zero 2 W image recipe in this folder builds on Raspberry Pi OS Lite (64-bit) and includes the Enve server, full-screen WebKit display, Wi-Fi setup permission, and Tailscale. It does not include a household database, calendar credentials, Wi-Fi password, Tailscale identity, or a default login password.

## Raspberry Pi Zero 2 W build

On a Debian-based Linux machine with enough free disk space for a pi-gen build, commit the Enve source and run:

```sh
image/build-raspberry-pi.sh /absolute/path/without-spaces/enve-image-build
```

The script checks out the official `arm64` branch of [pi-gen](https://github.com/RPi-Distro/pi-gen), adds the Enve stage, and writes a compressed `.img.xz` under the build directory's `pi-gen/deploy/`. Record both source commits from `build-sources.txt` with any image release. Flash the `.img.xz` with Raspberry Pi Imager's **Use custom** option. The first boot starts Enve on the attached display; complete Wi-Fi and household setup there. The unused Raspberry Pi OS account stays locked so its first-boot account wizard cannot interrupt Enve setup. SSH is disabled. Tailscale is already installed, but the household must connect its own account in **Settings → Device & data**.

This recipe has not yet produced a hardware-verified release image. Before publishing an image, boot it from a clean SD card on a Pi Zero 2 W, complete first-run setup with touch only, reboot it, and verify Wi-Fi, server, full display, and Tailscale connection. Confirm that the image contains no private data or reused device identity. Measure memory and responsiveness with the intended monitor.

## Orange Pi Zero 3W

The Orange Pi needs a separate board-specific base image. [Armbian's current Zero 3W board configuration](https://github.com/armbian/build/blob/main/config/boards/orangepizero3w.conf) declares no supported video output, so its minimal image cannot yet be used as a proven wall-display release. The Orange Pi image remains pending a display-capable base and a clean-card test on the 15.3-inch monitor. Do not flash the Raspberry Pi image to an Orange Pi.
