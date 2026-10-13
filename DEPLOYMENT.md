# Always-on family dashboard

Use one server and one SQLite database for the household. Phones and wall displays open that server; they do not keep separate calendars. Changes to local items notify other open devices immediately, and the iPhone app refreshes when it returns to the foreground.

## Hardware in our Orange Pi build

These are the parts used for the 15.3-inch wall display. Amazon prices and availability may change.

| Part | Purpose |
|---|---|
| [Orange Pi Zero 3W, 4 GB](https://www.amazon.com/dp/B0GXYPM431) with heatsink and fan | Runs the Enve server and wall display. |
| [Showscren 15.3-inch 1920 × 1200 touchscreen](https://www.amazon.com/dp/B0GC555YPC) | Wall display. |
| [ZeniKon 1-foot mini-HDMI to mini-HDMI cable](https://www.amazon.com/dp/B0FDB9WCYZ) | Video from the board to the monitor. |
| [Anker 2-in-1 USB-C cable, 6 feet, white](https://www.amazon.com/dp/B0DGLSXGZV) | Intended to power the board and monitor from one charger. |
| [HOTNOW 6-inch USB-C data cable, five-pack](https://www.amazon.com/dp/B0DPN758M2) | Short data cables also used with other test devices. One may carry touch input between the monitor and a USB host port on the board if the ports and cable reach. |

Add a 32 GB microSD card and a suitable USB-C power supply. HDMI carries video but not touch input. The split cable's 140 W rating does not guarantee that a particular charger can power both devices; test video, touch, and shared power before mounting. The Orange Pi Zero 3W needs an OS image made for that board. The Raspberry Pi OS instructions below apply to Raspberry Pi boards only.

The Orange Pi Zero 3W fan on our board normally waits until the CPU reaches 55°C. To have it start at 44°C while leaving the CPU's protective slowdown threshold alone, install [the fan service](pi-native/systemd/enve-orange-fan.service) on an Orange Pi Zero 3W with the same Armbian thermal layout:

```sh
sudo install -m 0644 pi-native/systemd/enve-orange-fan.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now enve-orange-fan.service
```

Check `systemctl status enve-orange-fan.service` and confirm both CPU fan trip points read `44000` under `/sys/class/thermal/thermal_zone0/` and `thermal_zone3/`. The board's kernel still controls the fan and can raise it to full speed when needed. This service is specific to the Zero 3W's current thermal zone layout; do not install it on a Raspberry Pi or a different Orange Pi model.

For people who want to flash a prepared Enve image and set up the household on the screen, see the [image build and validation guide](image/README.md). The Raspberry Pi image recipe is ready for a Linux build and physical trial; a verified downloadable image is not published yet. The Orange Pi image still needs a display-capable base and clean-card testing.

## Target: one Pi for server and display

Use 64-bit Raspberry Pi OS Lite on a Raspberry Pi 4 for a first installation; the Pi Zero 2 W remains the lower-memory target pending a full physical performance test. Run Node 22.13+ and the native [Pi display](pi-native/README.md) on the same board, with one SQLite database on its SD card. The native display connects to the server through `127.0.0.1`; phones connect to the Pi's LAN address. Chromium, X11, and a desktop environment are not part of this setup.

For the full-feature trial, install `cage` and `cog` from Raspberry Pi OS packages and launch [pi-native/full-kiosk.sh](pi-native/full-kiosk.sh) from the Pi's local graphical seat while the Enve server is running. Cog runs the existing complete interface with WPE WebKit inside Cage; it does not use Chromium. This path needs a physical Pi Zero 2 W performance and touch test before replacing the native boot service. The first-run page includes Wi-Fi scan and connect when opened locally on the Pi. The native display remains the low-memory fallback.

Install the server on persistent storage and keep the database, local device key, and calendar tokens in a private `data/` directory. On first boot, `pi-native/start.sh` opens touch setup with no-password, shared sign-in, and individual adult sign-in choices. Keep port 4317 off the public internet. Connect Google and Outlook accounts after the Pi's final address and OAuth redirect URLs are chosen. See `pi-native/README.md` for build packages, launch settings, display schedules, and memory checks.

This arrangement builds and renders on a Mac with a disposable database. On the target Pi, measure RAM, calendar refresh time, touch input, and the screen's backlight interface before relying on it as the always-on household server. Correct any undervoltage warning before judging performance.

## Alternative: separate server and Pi display

If the Pi has insufficient RAM or slow sync/imports, run the server on an always-on machine and point the same native display to its LAN address with `ENVE_SERVER_URL`. The server container includes text recognition for photos and PDFs. The following example uses Docker Compose and can run on Unraid or another Docker host.

1. Copy this project to a persistent directory on the Docker host. Compose creates a persistent `family-data` Docker volume for the SQLite database and account tokens.
2. In that directory, create a private `.env` file containing `ENVE_FAMILY_ACCESS_KEY=` followed by a unique setup key of at least 12 characters. Do not put the key in Git or in a URL.
3. Run `docker compose up -d --build` from that directory. Open `http://<server-LAN-address>:4317` on your home network, enter the setup key, and complete household setup. You can choose no password, a shared sign-in, or individual adult sign-ins. Keep port 4317 off the public internet. The setup key cannot open the dashboard after setup.
4. To move existing local data, download a backup in Settings on the old server and restore it on the new one. The backup excludes calendar account credentials and the parent PIN, so set those up again later.
5. Back up the `family-data` Docker volume regularly. Stop the container or use SQLite's backup API when copying the database file directly.

Build and start the container on the intended host with disposable data before moving a household database.

## Optional: two displays

A second Pi can drive another native display and connect to the first Pi or a separate server. Keep only one server and database; two independent databases would diverge.

## Private access away from home

For private remote access on a Pi, prepare the OS with `sudo sh pi-native/install-tailscale.sh <Enve Linux user>`. This installs Tailscale using its [official Linux installer](https://tailscale.com/docs/install/linux), starts its service, and gives the Enve service user operator permission. Run it while preparing a custom Enve OS image to ship Tailscale pre-installed. Do not join a personal tailnet or embed an auth key in the image: each household connects its own account after first boot. If using an existing OS image, run the same script once on the device. On the wall display, open **Settings → Device & data → Private access away from home**. Connect the Pi to your tailnet with the displayed Tailscale sign-in link or QR code, then select **Enable private access**. Enve starts Tailscale Serve in the background and shows its private HTTPS address. Install Tailscale on each phone and sign in to the same tailnet, then enter that address in the Enve iPhone app or open it in Safari and choose **Share → Add to Home Screen → Open as Web App**. This does not use Tailscale Funnel or open a public port.

Phones need a connection to the server to view fresh data or synchronize changes. The home-screen app keeps its last loaded view and can queue new local events, tasks, list items, and meals while it knows it is offline. Edits and connected-calendar changes require a connection. Keep the server powered on and Tailscale connected on phones for access away from home.

Google and Outlook account setup needs matching OAuth redirect URLs. Configure those after the server location and HTTPS address are settled. See [Google verification preparation](docs/GOOGLE_OAUTH_VERIFICATION.md) before making Google sign-in public.
