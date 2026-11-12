"""Run the project's Exact CLI without opening a new console on Windows.

Example: python tools/exact-quiet.py test web
"""

import os
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    if len(sys.argv) == 1:
        print("Usage: python tools/exact-quiet.py <exact arguments>", file=sys.stderr)
        return 2

    bun = shutil.which("bun")
    if bun is None:
        print("Bun was not found on PATH.", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parent.parent
    env = os.environ.copy()
    if os.name == "nt":
        cargo = Path(env.get("USERPROFILE", "")) / ".cargo" / "bin"
        if cargo.is_dir():
            env["PATH"] = str(cargo) + os.pathsep + env.get("PATH", "")
        chrome = Path(env.get("PROGRAMFILES", r"C:\Program Files")) / "Google" / "Chrome" / "Application" / "chrome.exe"
        if "CHROME" not in env and chrome.is_file():
            env["CHROME"] = str(chrome)

    result = subprocess.run(
        [bun, str(root / "exact.mjs"), *sys.argv[1:]],
        cwd=root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    sys.stdout.buffer.write(result.stdout)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
