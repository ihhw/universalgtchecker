#!/usr/bin/env python3
"""
Universal Checker desktop launcher.

Opens the app in its own native window (GTK3 + WebKit2) instead of a browser
tab. If the background service from packaging/linux-app/install.sh is
already running, this attaches to it and leaves it running when the window
closes. Otherwise it starts the bundled server itself and stops it again
when the window closes -- the same on-demand lifecycle as a normal desktop
app (open it, use it, close it, it's gone).
"""
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_ENTRY = os.path.normpath(os.path.join(APP_DIR, "..", "app", "index.mjs"))
DATA_DIR = os.path.join(
    os.environ.get("XDG_DATA_HOME", os.path.join(os.path.expanduser("~"), ".local", "share")),
    "universal-checker", "data",
)
ICON_PATH = "/usr/share/icons/hicolor/256x256/apps/universal-checker.png"
PORT = int(os.environ.get("UNIVERSAL_CHECKER_PORT", "8080"))
URL = f"http://127.0.0.1:{PORT}/"


def port_is_open(port: int, host: str = "127.0.0.1", timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def server_is_healthy(url: str, timeout: float = 0.5) -> bool:
    try:
        with urllib.request.urlopen(url + "api/status", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def wait_for_server(url: str, seconds: float = 20) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if server_is_healthy(url):
            return True
        time.sleep(0.2)
    return False


def fatal(message: str) -> None:
    sys.stderr.write("Universal Checker: " + message + "\n")
    try:
        # Best-effort GUI dialog; falls back to the stderr message above if
        # GTK isn't available (e.g. this is exactly the "not installed" case).
        import gi  # noqa: PLC0415

        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk  # noqa: PLC0415

        dialog = Gtk.MessageDialog(
            flags=0, message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.OK, text="Universal Checker",
        )
        dialog.format_secondary_text(message)
        dialog.run()
        dialog.destroy()
    except Exception:
        pass
    sys.exit(1)


def ensure_server() -> tuple[subprocess.Popen | None, bool]:
    """Returns (process_we_own_or_None, we_started_it)."""
    if port_is_open(PORT):
        if server_is_healthy(URL):
            return None, False
        fatal(
            f"Something else is already using port {PORT}.\n"
            "Set UNIVERSAL_CHECKER_PORT to a different port and try again."
        )

    if shutil.which("node") is None:
        fatal("Node.js was not found. Install it, then try again.")
    if not os.path.exists(SERVER_ENTRY):
        fatal(f"App files are missing:\n{SERVER_ENTRY}\nReinstall the package.")

    os.makedirs(DATA_DIR, exist_ok=True)
    env = dict(os.environ)
    env["NODE_ENV"] = "production"
    env["PORT"] = str(PORT)
    proc = subprocess.Popen(
        ["node", SERVER_ENTRY], cwd=DATA_DIR, env=env, start_new_session=True,
    )
    if not wait_for_server(URL):
        proc.terminate()
        fatal("The server did not start in time.")
    return proc, True


def main() -> None:
    try:
        import gi
    except ImportError:
        fatal(
            "The GTK Python bindings are missing. Install them with:\n"
            "sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1"
        )
        return

    gi.require_version("Gtk", "3.0")
    try:
        gi.require_version("WebKit2", "4.1")
    except ValueError:
        try:
            gi.require_version("WebKit2", "4.0")
        except ValueError:
            fatal(
                "WebKit2GTK is missing. Install it with:\n"
                "sudo apt install gir1.2-webkit2-4.1\n"
                "(or gir1.2-webkit2-4.0 on older versions of Ubuntu)"
            )
            return
    from gi.repository import Gtk, WebKit2, GLib, Gdk

    proc, owns_server = ensure_server()

    win = Gtk.Window(title="Universal Checker")
    win.set_default_size(1180, 780)
    if os.path.exists(ICON_PATH):
        win.set_icon_from_file(ICON_PATH)

    webview = WebKit2.WebView()
    webview.load_uri(URL)
    win.add(webview)

    def on_key_press(_widget, event):
        ctrl = bool(event.state & Gdk.ModifierType.CONTROL_MASK)
        if ctrl and event.keyval in (Gdk.KEY_r, Gdk.KEY_R):
            webview.reload()
            return True
        if event.keyval == Gdk.KEY_F5:
            webview.reload()
            return True
        if event.keyval == Gdk.KEY_F11:
            gdk_win = win.get_window()
            if gdk_win and (gdk_win.get_state() & Gdk.WindowState.FULLSCREEN):
                win.unfullscreen()
            else:
                win.fullscreen()
            return True
        if ctrl and event.keyval in (Gdk.KEY_q, Gdk.KEY_Q):
            win.close()
            return True
        return False

    win.connect("key-press-event", on_key_press)

    def cleanup(*_args):
        if owns_server and proc is not None and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM)
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        Gtk.main_quit()

    win.connect("destroy", cleanup)
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()
