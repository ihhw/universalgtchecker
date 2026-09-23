# Universal Checker — Linux app (always-on background service)

> **Looking for a real double-click desktop app, like Firefox?** See
> [`../deb/`](../deb/) instead — it builds an installable `.deb` that opens
> in its own native window rather than a browser tab, with nothing running
> in the background while it's closed. This folder is for a different need:
> keeping the app (and optionally the Discord bot) reachable at all times,
> even when you don't have a window open — the two can be used together; see
> "Using both together" in `../deb/README.md`.

Turns the project into something that's always available without you having
to remember to start it: a background service that starts automatically when
you log in, plus a launcher that opens it in a browser window. Unlike the
`.deb` app in `../deb/`, this keeps running even after you close the window,
which is what the Discord bot needs to stay reachable.

There's no separate download: this **is** the app. `install.sh` builds it
from the project source and sets it up.

## Install

```bash
cd packaging/linux-app
./install.sh
```

This builds the app, installs it to `~/.local/share/universal-checker/`,
adds "Universal Checker" to your application menu, and sets it up as a
background service (a `systemd --user` unit) that starts each time you log
in. At the end it asks whether to open it now.

Find it afterwards in your application menu, or run:
```bash
~/.local/share/universal-checker/bin/open-app.sh
```

**Note on the browser window.** If you have a Chromium-based browser
installed (Chrome, Chromium, Brave, Edge), the app opens as a plain window
with no tabs or address bar, which looks and feels like a native app. Firefox
doesn't support that mode, so with only Firefox installed it opens as a
normal browser tab instead — still fully functional, just not a separate
window. Chromium is a free option if you want the app-window look:
`sudo apt install chromium-browser`.

## Update

After pulling in code changes, just run `install.sh` again. It rebuilds and
restarts the service. Your Xbox sign-in, webhook setting and saved data are
kept — they live in `~/.local/share/universal-checker/data/`, which
`install.sh` never deletes (only the app code in `.../app/` is replaced).

## Discord bot (optional)

The bot isn't included in `install.sh` because it needs your own bot token.
Set that up first (see the project's main instructions), then:
```bash
./install-bot.sh
```
This also runs it as a background service, using the same project checkout
(its Python virtual environment lives in `artifacts/discord-bot/.venv`).

## Uninstall

```bash
./uninstall.sh
```
Removes the service, the menu icon and the installed files. Your project
source folder and your Discord bot token file are left alone — see the
script's own output for exactly what it removes and what it leaves.

## Run without logging in (optional)

Normally the background service starts when you log in and stops when you
log out. To have it running even while logged out (e.g. right after your
computer boots):
```bash
loginctl enable-linger $USER
```

## Troubleshooting

```bash
systemctl --user status  universal-checker.service   # is it running?
journalctl --user -u universal-checker.service -f    # watch its logs live
```

**Port already in use.** The app uses port 8080 by default. To use a
different one, uninstall first, then reinstall with:
```bash
UNIVERSAL_CHECKER_PORT=9090 ./install.sh
```
If you also use the bot, reinstall it the same way afterwards so it points
at the new port:
```bash
UNIVERSAL_CHECKER_PORT=9090 ./install-bot.sh
```

**Run it by hand instead of as a service**, for debugging:
```bash
~/.local/share/universal-checker/bin/run-server.sh
```
This runs it in the foreground in your terminal, using the same settings and
data folder as the background service (stop the service first with
`systemctl --user stop universal-checker.service` so the two don't compete
for the same port).

## What this isn't

This doesn't package the app as a single Electron/AppImage binary with its
own bundled browser engine. Building one needs internet access to download
Electron, which wasn't available while this was put together. What's here
instead needs only Node.js (already required either way) plus whatever
browser you already have — no extra download, and it already behaves like an
installed app: menu icon, background service, no visible terminal. If you
want a true Electron build later, `npx create-electron-app` (or adding
Electron to this project directly) is the starting point, run from your own
machine where the download will work.

## Files in this folder

| File | Purpose |
|---|---|
| `build-app.sh` | Builds the frontend and server into one self-contained folder (`artifacts/api-server/dist/`: `index.mjs` + `public/`). Only Node.js is needed to run that folder afterwards — no pnpm, no `node_modules`. |
| `install.sh` | Runs the build, installs it, sets up the menu icon and background service. |
| `install-bot.sh` | Optional: sets up the Discord remote-control bot the same way. |
| `uninstall.sh` | Removes everything the two install scripts set up. |
| `*.service.template` | systemd unit templates; `install.sh`/`install-bot.sh` fill in the real paths. |
