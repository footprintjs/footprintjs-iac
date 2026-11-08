"""Entry point for the explicitly local SQLite trial, never production."""
import os
from pathlib import Path
import subprocess
import sys

for name in ("SEO_ENV", "NODE_ENV", "NEO_ENV"):
    if os.environ.get(name, "").strip().lower() == "production":
        raise SystemExit("The footprint-iac Neo fixture refuses production mode.")

directory = Path("/tmp/footprint-iac-neo-seed")
directory.mkdir(mode=0o700, parents=True, exist_ok=True)
# Always use new local fixture paths, never any configured laptop/server store.
os.environ.update({
    "MDS_CONFIG_DB": str(directory / "mds_config.db"),
    "RVTOOLS_DB": str(directory / "rvtools.db"),
    "SEO_CACHE_DB": str(directory / "tool_cache.db"),
})
subprocess.run([
    sys.executable, "/app/py-tools/seed/seed.py", "--only", "sqlite",
    "--db-dir", str(directory), "--quiet",
], check=True)
print("footprint-iac local trial: seeded SQLite only; no InfluxDB or production stores", flush=True)
os.execv(sys.executable, [
    sys.executable, "-m", "uvicorn", "server:app", "--app-dir", "/app/py-tools",
    "--host", "0.0.0.0", "--port", "8000", "--workers", "1",
])
