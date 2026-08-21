#!/usr/bin/env bash
set -euo pipefail

echo "Running Alembic migrations (with advisory lock)..."
python - <<'PY'
import os
import subprocess
import sys

try:
    import psycopg2

    database_url = os.environ.get("DATABASE_URL_SYNC", "")
    if not database_url:
        print("FATAL: DATABASE_URL_SYNC is not set", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(database_url)
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT pg_try_advisory_lock(42)")
    acquired = bool(cur.fetchone()[0])

    if acquired:
        print("Advisory lock acquired, running migrations...")
        try:
            result = subprocess.run(
                ["python", "-m", "alembic", "upgrade", "head"],
                check=True,
            )
        finally:
            cur.execute("SELECT pg_advisory_unlock(42)")
    else:
        print("Another instance is running migrations, skipping...")

    cur.close()
    conn.close()
except subprocess.CalledProcessError as exc:
    print(f"FATAL: Migration failed with exit code {exc.returncode}", file=sys.stderr)
    sys.exit(exc.returncode)
except Exception as exc:
    print(f"FATAL: Migration step failed: {exc}", file=sys.stderr)
    sys.exit(1)
PY

echo "Starting uvicorn..."
WORKERS=${WEB_CONCURRENCY:-4}
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers $WORKERS --proxy-headers --timeout-graceful-shutdown 30
