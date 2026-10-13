# Flashable Enve Family images

Enve needs a different image for each board. The Raspberry Pi Zero 2 W image recipe in this folder builds on Raspberry Pi OS Lite (64-bit) and includes the Enve server, full-screen WebKit display, Wi-Fi setup permission, and Tailscale. It does not include a household database, calendar credentials, Wi-Fi password, Tailscale identity, or a default login password.

## Raspberry Pi Zero 2 W build

On a Debian-based Linux machine with enough free disk space for a pi-gen build, commit the Enve source and run:

```sh
image/build-raspberry-pi.sh /absolute/path/without-spaces/enve-image-build
```

The script checks out the official `arm64` branch of [pi-gen](https://github.com/RPi-Distro/pi-gen), adds the Enve stage, and writes a compressed `.img.xz` under the build directory's `pi-gen/deploy/`. Record both source commits from `build-sources.txt` with any image release. Flash the `.img.xz` with Raspberry Pi Imager's **Use custom** option. The first boot starts Enve on the attached display; complete Wi-Fi and household setup there. The unused Raspberry Pi OS account stays locked so its first-boot account wizard cannot interrupt Enve setup. SSH is disabled. Tailscale is already installed, but the household must connect its own account in **Settings → Device & data**.

The recipe produced a compressed image in an ARM64 Ubuntu build VM on October 12, 2026. Its archive checksum and compression integrity passed, and inspection found the app, Node, Tailscale, and enabled server/display services, with no household data or `.env`. It is not yet a hardware-verified release. Before publishing an image, boot it from a clean SD card on a Pi Zero 2 W, complete first-run setup with touch only, reboot it, and verify Wi-Fi, server, full display, and Tailscale connection. Confirm that the image contains no reused device identity. Measure memory and responsiveness with the intended monitor.

## Orange Pi Zero 3W

The Orange Pi uses its own Armbian base, kernel, PowerVR driver, and Chromium/Vulkan display. The running 4 GB Zero 3W has passed a cold boot at 1920 × 1200; scrolling showed 22–28 FPS with clear text. Live graphics restart still needs further driver work. The Raspberry Pi profile retains WPE WebKit and its own OS image.

The shared installer has explicit board profiles:

| Profile | Boards | Display | Base OS |
| --- | --- | --- | --- |
| `raspberry-pi` | Pi Zero 2 W and Pi 4, 64-bit | WPE WebKit / Cage | Raspberry Pi OS Lite |
| `orange-pi-zero-3w` | Orange Pi Zero 3W, tested with 4 GB RAM | Chromium / Xorg / PowerVR Vulkan | Armbian Debian 13 with the matching vendor kernel |

For an Orange Pi image, first prepare a board-specific Armbian root filesystem with the matching PowerVR DKMS module, firmware, and root-owned userspace driver under `/opt/enve-family-pvr`, as described in [the display instructions](../pi-native/README.md#orange-pi-vulkan-display). Place a clean Enve checkout at `/opt/enve-family`, then run inside that root filesystem:

```sh
ENVE_DEVICE_PROFILE=orange-pi-zero-3w sh /opt/enve-family/image/install-enve.sh
```

The installer selects the Vulkan service and a software fallback, loads the GPU module at boot, and assigns Wi-Fi to NetworkManager. This prevents an Armbian networkd-only base from leaving the in-app scanner unavailable. The Raspberry Pi build stage explicitly selects `raspberry-pi`, so Orange Pi drivers and Chromium are not installed there.

The selected profile is recorded at `/etc/enve-family/device-profile`. Both profiles include the same server, household setup, NetworkManager permissions, and Tailscale support. Never include an existing household database, Wi-Fi credentials, calendar tokens, SSH keys, or Tailscale identity in a reusable image.

A finished Orange Pi flashable image has not yet been built and verified from a clean card. Its root filesystem still needs packaging into the board's own bootable image, followed by clean-card Wi-Fi, touch, GPU, sleep/wake, and Tailscale tests. The Raspberry Pi image also retains its physical verification gate above. Do not flash either board's image onto the other board.
