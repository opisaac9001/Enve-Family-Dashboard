# Always-on family dashboard

Use one server and one SQLite database for the household. Phones and wall displays open that server; they do not keep separate calendars. Changes to local items notify other open devices immediately, and the iPhone app refreshes when it returns to the foreground.

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

For private remote access, connect the server and each phone to the same Tailscale network. Use Tailscale Serve to provide an HTTPS address for this dashboard, then enter that address in the native iPhone app or open it in Safari and choose **Share → Add to Home Screen → Open as Web App**. Tailscale Serve shares the local service within the private network, without a public port.

Phones need a connection to the server to view fresh data or synchronize changes. The home-screen app keeps its last loaded view and can queue new local events, tasks, list items, and meals while it knows it is offline. Edits and connected-calendar changes require a connection. Keep the server powered on and Tailscale connected on phones for access away from home.

Google and Outlook account setup needs matching OAuth redirect URLs. Configure those after the server location and HTTPS address are settled. See [Google verification preparation](docs/GOOGLE_OAUTH_VERIFICATION.md) before making Google sign-in public.
