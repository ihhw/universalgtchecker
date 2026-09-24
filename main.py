"""Universal GT Checker — multi-platform username availability checker."""
from __future__ import annotations

import importlib.util as _importlib_util
import subprocess as _bootstrap_subprocess
import sys as _bootstrap_sys


def _ensure_http_dependency() -> None:
    if any(_importlib_util.find_spec(name) is not None for name in ("curl_cffi", "tls_client", "requests")):
        return
    try:
        _bootstrap_subprocess.run(
            [_bootstrap_sys.executable, "-m", "pip", "install", "requests"],
            check=True,
            stdout=_bootstrap_subprocess.DEVNULL,
            stderr=_bootstrap_subprocess.DEVNULL,
        )
    except Exception as exc:
        raise SystemExit("Needs the Python 'requests' package and could not install it automatically.") from exc


_ensure_http_dependency()
del _ensure_http_dependency

import os
import time
from pathlib import Path

from checkers.discord import discord_main


RESET = "\033[0m"
RED = "\033[91m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
GREY = "\033[90m"
WHITE = "\033[97m"

APP_TITLE = "Universal GT Checker"


def enable_ansi() -> None:
    if os.name == "nt":
        os.system("")
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.GetStdHandle(-11)
            m = ctypes.c_uint32()
            if k.GetConsoleMode(h, ctypes.byref(m)):
                k.SetConsoleMode(h, m.value | 0x0004)
            k.SetConsoleTitleW(APP_TITLE)
        except Exception:
            pass


def clear() -> None:
    os.system("cls" if os.name == "nt" else "clear")


def banner() -> None:
    print(RED + "=" * 62)
    print("           Universal GT Checker")
    print("=" * 62 + RESET)


def main():
    enable_ansi()

    while True:
        clear()
        banner()
        print()
        print(f"  {WHITE}Select a platform to check:{RESET}")
        print()
        print("  [1] Discord username checker")
        print()
        print("  [0] Exit")
        print()
        choice = input("  Select: ").strip()

        if choice == "0":
            return
        if choice == "1":
            discord_main()


if __name__ == "__main__":
    main()
