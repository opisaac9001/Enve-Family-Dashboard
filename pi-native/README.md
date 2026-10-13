# Enve Family native wall display

This SDL client is the low-memory wall screen for the Enve Family server. It has no browser, web view, X11, or desktop environment. The intended device is one Raspberry Pi Zero 2 W running Raspberry Pi OS Lite, the Node/SQLite server, and this display. Phones use the same server.

## Full-feature Pi trial

The complete calendar, lists, meals, rewards, import, and settings interface can be tried on the same Pi with WPE WebKit instead of Chromium. Install the Raspberry Pi OS `cog`, `cage`, and `wlr-randr` packages, start the Enve server, then run `pi-native/full-kiosk.sh` from a local Pi login session with access to the display and input devices. For boot launch, install `pi-native/systemd/enve-family-full-display.service` and disable `enve-family-display.service`. The full display unit uses the first local console and clears inherited capabilities so WebKit's sandbox can start. The script opens `127.0.0.1` in kiosk mode; first-run setup includes Wi-Fi scanning and an on-screen keyboard. The pointer starts hidden, appears when a mouse moves, and hides again after two seconds without mouse movement. Touch does not show it. Use the existing native display service as the fallback until the full interface has been exercised and measured on the Pi Zero 2 W. Do not enable both displays on the same screen at once. When HDMI and USB-C DisplayPort are both connected, the kiosk uses HDMI for video and disables the extra DisplayPort output so the calendar stays on one screen. USB touch input remains available. Connect the screen before starting the device; reconnecting cables may require restarting the display.

For in-app Wi-Fi connection, run `sudo sh pi-native/install-wifi-permission.sh <Enve Linux user>` once on the device. It grants that user NetworkManager access to scan, create connections, and activate them. The server only exposes Wi-Fi changes to a local setup screen or a signed-in household owner on the device.

To include private remote access in a prepared OS image, run `sudo sh pi-native/install-tailscale.sh <Enve Linux user>` while building the image. It installs Tailscale and enables its service; each household signs in to its own Tailscale account from Enve Settings after first boot. The script can also be run once on an existing Pi installation. Do not put a household Tailscale auth key in a reusable image.

During the trial, check calendar navigation, touch typing, Wi-Fi connection, dim/wake, and account connection. Record memory with `free -h` and `ps -o pid,rss,comm -C node -C cog -C WPEWebProcess -C cage` after boot, while browsing the calendar, and after opening settings. Repeat these checks on the target Pi Zero 2 W and monitor before relying on it.

On a new installation, the native touch setup screen creates the household, people and colors, a no-password, shared, or individual adult sign-in choice, and a light/dark schedule. The screen then shows a day agenda, a seven-day overview, open tasks, a seven-day meal plan, and household lists. Event colors come from the connected calendar when available and otherwise from the household profile. It can complete or skip tasks and check list items, with a touch PIN pad when list edits are protected. It refreshes after actions and every two minutes. It uses the dashboard's light/dark, idle dim, and sleep schedule settings. The full kiosk trial adds Wi-Fi configuration and all web Settings on the Pi.

## Build on the Mac

Install the build packages with Homebrew: `brew install cmake pkg-config sdl2-compat sdl2_ttf curl json-c`. Then run:

```sh
cmake -S pi-native -B pi-native/build -DCMAKE_BUILD_TYPE=Release
cmake --build pi-native/build -j2
pi-native/start.sh
```

The launcher starts the local server, opens touch setup when needed, then starts the display. The display defaults to `http://127.0.0.1:4317`. For a server at another address, set `ENVE_SERVER_URL`. For an existing server that still uses a legacy access key, set `ENVE_ACCESS_KEY` in the process environment. Do not put credentials in a URL or commit them. On the Mac, setup and display open 800 × 480 windows for visual testing.

For a headless screenshot, set `SDL_VIDEODRIVER=dummy` and `ENVE_CAPTURE=/tmp/enve-display.bmp`. The client saves the first loaded frame and exits. `ENVE_START_PAGE=week`, `tasks`, `meals`, or `lists` selects a screen for this check.

## Build on Raspberry Pi OS Lite

Use a 64-bit Raspberry Pi OS Lite image and install Node.js 22.13 or newer for the server's built-in SQLite support. Check `node --version` before starting the server. Install the native build packages:

```sh
sudo apt update
sudo apt install build-essential cmake pkg-config libsdl2-dev libsdl2-ttf-dev libcurl4-openssl-dev libjson-c-dev fonts-dejavu-core
cmake -S pi-native -B pi-native/build -DCMAKE_BUILD_TYPE=Release
cmake --build pi-native/build -j2
```

First run `pi-native/start.sh` from a local terminal with a disposable `DATABASE_PATH` and no external calendar accounts. It starts the server, touch setup, and display in order. KMSDRM uses the Linux display and input devices directly; the display fills the screen. Its pointer starts hidden, appears when a mouse moves, and hides after two seconds of inactivity. Touch hides it immediately. The user running it needs permission to access `/dev/dri` and `/dev/input`. The exact group and seat setup depends on the Pi image and touchscreen, so verify it on the device before creating boot services.

The sample units in `pi-native/systemd/` start the server at boot and the native display when a screen or framebuffer is present. The display unit skips a headless boot. Replace `REPLACE_USER` and `REPLACE_ROOT` in all three units with your Linux username and absolute checkout path before installing them. Adjust the Node binary path in the server unit if needed. The exact touchscreen driver or device-tree overlay depends on the panel model.

For household use, run the launcher with a persistent `DATABASE_PATH`; it binds the server to the home network and creates a private local device key. Choose no password, a shared password or PIN, or individual adult sign-ins on the touch screen. No password allows anyone who can reach the server to view and change household information. Keep port 4317 on the trusted home network. Phones then connect to `http://<Pi-LAN-address>:4317` or to the private HTTPS address you configure for remote access. Configure the current Wi-Fi network in Raspberry Pi OS or through the full kiosk setup.

## Brightness and memory

The display draws a dark overlay after the configured idle time and during the sleep window. If the touchscreen exposes a writable Linux backlight brightness file, set `ENVE_BACKLIGHT` to that file, such as `/sys/class/backlight/<device>/brightness`. The client reads the current brightness, lowers the physical backlight when dimmed or sleeping, and restores it on exit. Without that path, the overlay works but may not reduce the panel's electrical power use. A touch wakes the screen for 15 minutes during its sleep window.

On the Pi, check `free -h` and `ps -o pid,rss,comm -C node -C enve-family-display` after boot, after a calendar refresh, and while the screen is dimmed. Test Google, iCloud, and Outlook refreshes plus photo/PDF imports before relying on the Pi Zero 2 W as the always-on server. The Mac test used roughly 86 MB for Node and 94 MB for this display with a small disposable data set; those are macOS process figures, not Pi measurements.

## Current wall-screen limits

The native screen reads calendar events, tasks, meals, and lists, and supports the task/list actions above. Creating or editing events, tasks, meals, and list entries; account connection; rewards; recipes; weather; photos; and imports use the iPhone or web app. Confirm physical touch, DRM startup, backlight control, and memory headroom on the intended Pi Zero 2 W and monitor.
