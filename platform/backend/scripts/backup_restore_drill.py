#!/usr/bin/env python3
"""Run a full backup/restore drill inside the backend runtime image."""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import backup as backup_module
import restore as restore_module


def _parse_db_url(url: str) -> dict[str, str]:
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "dbname": (parsed.path or "/dev").lstrip("/"),
        "user": parsed.username or "user",
        "password": parsed.password or "",
    }


def _replace_db_name(url: str, db_name: str) -> str:
    parsed = urlparse(url)
    return parsed._replace(path=f"/{db_name}").geturl()


def _run(cmd: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(cmd, check=True, env=env, cwd=ROOT)


def main() -> int:
    database_url = os.environ.get("DATABASE_URL_SYNC") or os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL_SYNC or DATABASE_URL must be set")

    db_info = _parse_db_url(database_url)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    drill_db = f"{db_info['dbname']}_drill_{stamp}"
    drill_url = _replace_db_name(database_url, drill_db)

    env = os.environ.copy()
    env["PGPASSWORD"] = db_info["password"]

    backup_module.DATABASE_URL_SYNC = database_url
    restore_module.DATABASE_URL_SYNC = drill_url

    backup_id = backup_module.do_backup()
    print(f"[INFO] Backup created: {backup_id}")

    try:
        _run(
            [
                "createdb",
                "-h",
                db_info["host"],
                "-p",
                db_info["port"],
                "-U",
                db_info["user"],
                drill_db,
            ],
            env=env,
        )
        print(f"[INFO] Drill database created: {drill_db}")

        restore_module.do_restore(backup_id=backup_id, latest=False, dry_run=False)
        print("[INFO] Restore finished")

        validation = subprocess.run(
            [
                "psql",
                "-h",
                db_info["host"],
                "-p",
                db_info["port"],
                "-U",
                db_info["user"],
                "-d",
                drill_db,
                "-Atc",
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';",
            ],
            check=True,
            capture_output=True,
            text=True,
            env=env,
            cwd=ROOT,
        )
        table_count = int((validation.stdout or "0").strip() or "0")
        if table_count <= 0:
            raise RuntimeError("backup drill validation failed: no public tables restored")
        print(f"[SUCCESS] Backup restore drill passed with {table_count} public tables")
        return 0
    finally:
        subprocess.run(
            [
                "dropdb",
                "-h",
                db_info["host"],
                "-p",
                db_info["port"],
                "-U",
                db_info["user"],
                "--if-exists",
                drill_db,
            ],
            check=False,
            env=env,
            cwd=ROOT,
        )


if __name__ == "__main__":
    raise SystemExit(main())
