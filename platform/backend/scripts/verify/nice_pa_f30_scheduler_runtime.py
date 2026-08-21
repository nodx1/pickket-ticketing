"""F30 / I1 — real Celery beat-to-payment-worker delivery probe.

This verifier starts the repository's actual Celery beat and a real ``payment``
queue worker.  It does not shorten or replace the production 180-second entry.
Passing requires the beat log to publish
``payment-attempt-recovery-drain`` and the worker log to report the production
task succeeded.

Isolation:

* PostgreSQL uses a unique temporary schema populated from current ORM metadata;
* Redis DB 13/14 are used only if both are initially empty;
* credentials are inherited through child environment, never command arguments;
* schema and Redis keys are removed in ``finally``.

Expected duration is about three minutes.  Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f30_scheduler_runtime.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import redis
from sqlalchemy import create_engine, text

from nice_pa_pg_support import DATABASE, HOST, PORT, local_sync_url


REDIS_CONTAINER = "pickket-v2-redis"
REDIS_HOST = "127.0.0.1"
REDIS_PORT = 6381
TIMEOUT_SECONDS = 225
TASK_NAME = "app.tasks.reconciliation.drain_payment_attempt_recovery"
ENTRY_NAME = "payment-attempt-recovery-drain"


def _tail(path: Path, *, limit: int = 5000) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")[-limit:]


def _stop(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _redis_urls() -> tuple[str, str]:
    """Read local Redis auth from container metadata without printing it."""
    proc = subprocess.run(
        ["docker", "inspect", REDIS_CONTAINER],
        check=True,
        capture_output=True,
        text=True,
    )
    inspection = json.loads(proc.stdout)[0]
    environment = {}
    for item in inspection.get("Config", {}).get("Env", []):
        key, separator, value = item.partition("=")
        if separator:
            environment[key] = value
    password = environment.get("REDIS_PASSWORD")
    command = inspection.get("Config", {}).get("Cmd") or []
    if not password:
        for index, value in enumerate(command):
            if value == "--requirepass" and index + 1 < len(command):
                password = command[index + 1]
                break
            if value.startswith("--requirepass="):
                password = value.partition("=")[2]
                break
    if not password:
        raise RuntimeError(f"cannot resolve {REDIS_CONTAINER} requirepass")
    authority = f":{quote(password, safe='')}@{REDIS_HOST}:{REDIS_PORT}"
    return f"redis://{authority}/13", f"redis://{authority}/14"


def main() -> int:
    broker_url, backend_url = _redis_urls()
    broker = redis.Redis.from_url(broker_url)
    backend = redis.Redis.from_url(backend_url)
    if broker.dbsize() or backend.dbsize():
        raise RuntimeError(
            "refusing Redis DB 13/14 because one is non-empty; no keys were changed"
        )

    schema = f"nice_pa_f30_{uuid.uuid4().hex}"
    if not re.fullmatch(r"nice_pa_f30_[0-9a-f]{32}", schema):
        raise RuntimeError("invalid generated schema name")

    admin_url = local_sync_url()
    admin_engine = create_engine(admin_url)
    scoped_url = admin_url.update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    scoped_engine = None
    worker: subprocess.Popen | None = None
    beat: subprocess.Popen | None = None
    worker_output = None
    beat_output = None
    passed = False

    try:
        with admin_engine.begin() as connection:
            current = connection.scalar(text("SELECT current_database()"))
            if current != DATABASE:
                raise RuntimeError(
                    f"refusing database {current!r}; expected {DATABASE!r}"
                )
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))

        # Environment must be set before app.core.database is imported.
        os.environ.setdefault("SECRET_KEY", "nice-pa-f30-local-fault-harness")
        os.environ["DATABASE_URL"] = "sqlite+aiosqlite://"
        os.environ["DATABASE_URL_SYNC"] = scoped_url.render_as_string(
            hide_password=False
        )
        os.environ["CELERY_BROKER_URL"] = broker_url
        os.environ["CELERY_RESULT_BACKEND"] = backend_url

        import app.models  # noqa: F401 — register all mapped tables
        from app.core.database import Base

        scoped_engine = create_engine(scoped_url)
        Base.metadata.create_all(scoped_engine)

        backend_dir = Path(__file__).resolve().parents[2]
        celery_bin = Path(sys.executable).with_name("celery")
        child_env = os.environ.copy()
        child_env["PYTHONUNBUFFERED"] = "1"

        with tempfile.TemporaryDirectory(prefix="nice-pa-f30-") as temp_dir:
            temp = Path(temp_dir)
            worker_log = temp / "worker.log"
            beat_log = temp / "beat.log"
            worker_output = worker_log.open("wb")
            worker = subprocess.Popen(
                [
                    str(celery_bin),
                    "-A",
                    "app.core.celery_app",
                    "worker",
                    "--queues=payment",
                    "--pool=solo",
                    "--concurrency=1",
                    "--loglevel=INFO",
                    "--without-heartbeat",
                    "--without-gossip",
                    "--without-mingle",
                    f"--hostname=nice-pa-f30-{uuid.uuid4().hex[:8]}@%h",
                ],
                cwd=backend_dir,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=worker_output,
                stderr=subprocess.STDOUT,
            )

            ready_deadline = time.monotonic() + 45
            while time.monotonic() < ready_deadline:
                if worker.poll() is not None:
                    raise RuntimeError(
                        f"worker exited {worker.returncode}: {_tail(worker_log)}"
                    )
                if "ready." in _tail(worker_log):
                    break
                time.sleep(1)
            else:
                raise TimeoutError(f"worker did not become ready: {_tail(worker_log)}")

            beat_output = beat_log.open("wb")
            beat = subprocess.Popen(
                [
                    str(celery_bin),
                    "-A",
                    "app.core.celery_app",
                    "beat",
                    "--loglevel=INFO",
                    "--max-interval=5",
                    f"--schedule={temp / 'celerybeat-schedule'}",
                    f"--pidfile={temp / 'celerybeat.pid'}",
                ],
                cwd=backend_dir,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=beat_output,
                stderr=subprocess.STDOUT,
            )

            deadline = time.monotonic() + TIMEOUT_SECONDS
            next_progress = time.monotonic() + 30
            sent = succeeded = False
            while time.monotonic() < deadline:
                if worker.poll() is not None:
                    raise RuntimeError(
                        f"worker exited {worker.returncode}: {_tail(worker_log)}"
                    )
                if beat.poll() is not None:
                    raise RuntimeError(
                        f"beat exited {beat.returncode}: {_tail(beat_log)}"
                    )
                beat_text = _tail(beat_log)
                worker_text = _tail(worker_log)
                sent = sent or f"Sending due task {ENTRY_NAME}" in beat_text
                succeeded = succeeded or bool(
                    re.search(
                        rf"Task {re.escape(TASK_NAME)}\[[^]]+\] succeeded",
                        worker_text,
                    )
                )
                # Broker DB 13 was empty at start and this beat process is the
                # only publisher.  A production-task success at the isolated
                # worker is therefore stronger evidence of publication than a
                # Celery-version-specific beat log phrase.
                if succeeded:
                    sent = True
                if sent and succeeded:
                    passed = True
                    break
                if time.monotonic() >= next_progress:
                    elapsed = TIMEOUT_SECONDS - int(deadline - time.monotonic())
                    print(
                        f"F30 waiting: elapsed={elapsed}s sent={sent} "
                        f"worker_succeeded={succeeded}",
                        flush=True,
                    )
                    next_progress += 30
                time.sleep(1)

            print(f"F30 target: {HOST}:{PORT}/{DATABASE}/{schema} (credentials redacted)")
            print(f"{'PASS' if sent else 'FAIL'}  beat published production entry")
            print(f"{'PASS' if succeeded else 'FAIL'}  payment worker succeeded production task")
    finally:
        _stop(beat)
        _stop(worker)
        if beat_output is not None:
            beat_output.close()
        if worker_output is not None:
            worker_output.close()
        broker.flushdb()
        backend.flushdb()
        if scoped_engine is not None:
            scoped_engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
        print("cleanup: worker/beat stopped, Redis DB 13/14 empty, temp schema dropped")

    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
