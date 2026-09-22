#!/usr/bin/env python3
"""Store the Jev credential for GUI and CLI use, without shell history or echo.

Run: rtk proxy python3 scripts/local/set-jev-key.py
Requires an interactive terminal. Atomically replaces only the Jev credential;
directory mode 0700 and file mode 0600. Re-run to rotate. Never prints the key.
"""
import getpass
import os
from pathlib import Path
import tempfile

key = getpass.getpass("Jev API key (hidden): ").strip()
if not key.startswith("apikey_") or any(c.isspace() for c in key):
    raise SystemExit("Invalid key format; unchanged")
directory = Path.home() / ".agent-dock" / "credentials"
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
if directory.is_symlink():
    raise SystemExit("Credential directory must not be a symlink")
os.chmod(directory, 0o700)
fd, temporary = tempfile.mkstemp(prefix=".jev-", dir=directory)
try:
    with os.fdopen(fd, "w") as output:
        output.write(key + "\n")
    os.replace(temporary, directory / "jev-api-key")
finally:
    if os.path.exists(temporary): os.unlink(temporary)
print("Jev credential installed (0600); value not displayed.")
