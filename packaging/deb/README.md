# Universal Checker — desktop app (.deb)

This makes Universal Checker into an app you open the same way as Firefox:
double-click its icon, a window opens (not a browser tab — a real native
window, built with GTK and WebKit), you use it, you close it, it's gone.
Nothing runs in the background while you're not using it, unless you also
set up the always-on service in `../linux-app/` (see "Using both together"
below).

There's still one thing that has to happen on your machine, not on any
server: `build-deb.sh` downloads this project's dependencies to build it
(`pnpm install`), the same as every build step so far in this project. That
part needs your internet connection. What comes out the other end, though,
is a normal `.deb` file — a real installable package, the same kind of thing
you'd get from downloading software from a website. You can keep it, copy it
to another machine with the same Ubuntu version, or reinstall from it later
without rebuilding.

## Build and install

```bash
cd packaging/deb
./build-deb.sh
```

This builds the app and produces `universal-checker_1.0.0_all.deb` in the
project's root folder. Then:

```bash
sudo apt install ./universal-checker_1.0.0_all.deb
```

Use `apt install`, not `dpkg -i` — `apt` automatically fetches anything
that's missing (Node.js, the WebKit GTK library, and so on) from your
existing Ubuntu package sources; `dpkg -i` doesn't.

Once installed, "Universal Checker" is in your application menu like any
other app. No terminal needed from here on.

If your file manager offers a package-installer window when you double-click
a `.deb` file, that works too — same result as the command above.

## Update

After code changes, rebuild and reinstall the same way:
```bash
./build-deb.sh
sudo apt install ./universal-checker_1.0.0_all.deb
```
`apt` treats this as an upgrade of the existing package.

Your Xbox sign-in, webhook setting and other saved server-side state live at
`~/.local/share/universal-checker/data/`, separate from the installed app
files — reinstalling doesn't touch them.

## Uninstall

```bash
sudo apt remove universal-checker
```

## How it behaves

- **Opening it** starts the server if nothing is already running on its
  port, waits for it to be ready, then opens the window. Closing the window
  stops that server again — the same lifecycle as any other desktop app.
- **If the always-on background service is also installed** (see below),
  opening the app finds it already running and just opens a window against
  it, without starting a second copy or stopping it when you close the
  window.
- **Keyboard shortcuts:** Ctrl+R or F5 to reload, F11 to toggle fullscreen,
  Ctrl+Q to close.
- **Port:** 8080 by default. Change it with `UNIVERSAL_CHECKER_PORT` — see
  below.

## Using both together

The `.deb` app here and the always-on service in `../linux-app/` are two
different ways to run the *same* app, and they're designed to coexist:

- Use **only this `.deb`** if you just want to open the app yourself, like
  any other program, and don't need anything running while it's closed.
- Also install **`../linux-app/install.sh`** if you want the Discord bot to
  be able to reach the API even when you don't have the app window open —
  the bot needs a server to talk to at all times, not just while you're
  looking at the app.
- With both installed, the `.deb` launcher notices the background service is
  already running and simply opens a window on it, rather than starting a
  competing second copy.

## Changing the port

Both the build and the app itself default to port 8080. To use a different
port, rebuild with it set:
```bash
UNIVERSAL_CHECKER_PORT=9090 ./build-deb.sh
sudo apt install ./universal-checker_1.0.0_all.deb
```
The launcher reads the same variable at run time too, so if you also use the
always-on service from `../linux-app/` on a non-default port, install that
with the same `UNIVERSAL_CHECKER_PORT` value so both agree.

## Troubleshooting

**"Something else is already using port 8080."** Another program is using
that port. Either close it, or use a different port as shown above.

**A blank or unstyled window.** Check whether the server actually started:
```bash
curl http://127.0.0.1:8080/api/status
```
If that fails, run the app from a terminal instead of the menu icon to see
the actual error:
```bash
/opt/universal-checker/bin/universal-checker
```

**"The GTK Python bindings are missing" / "WebKit2GTK is missing."** `apt
install ./file.deb` should have fetched these automatically; if you used
`dpkg -i` instead, install them yourself:
```bash
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1
```
(On Ubuntu 22.04, use `gir1.2-webkit2-4.0` instead of `-4.1`.)

## Version

`build-deb.sh` labels the package `1.0.0` by default. Override it (for
example after making changes of your own) with:
```bash
UNIVERSAL_CHECKER_VERSION=1.1.0 ./build-deb.sh
```

## Files in this folder

| File | Purpose |
|---|---|
| `build-deb.sh` | Builds the app and assembles the `.deb`. |
| `universal-checker-launcher.py` | The native GTK + WebKit window. Installed as `/opt/universal-checker/bin/universal-checker`. |
| `control` | Package name, version and dependencies. |
| `postinst`, `postrm` | Small scripts `apt` runs after install/removal (refreshing the icon and menu caches). |
