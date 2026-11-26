"""Ejecuta todas las pruebas E2E contra el servidor ya iniciado (with_server.py)."""
import subprocess
import sys
from pathlib import Path

here = Path(__file__).parent
failed = 0
for script in ("demo_flow.py", "templates_flow.py"):
    print(f"== {script}", flush=True)
    failed |= subprocess.call([sys.executable, "-I", "-u", str(here / script)])
sys.exit(failed)
