"""Process-local async runner for synchronous Celery tasks.

Celery tasks in this project are synchronous, while database, Redis, and PG
clients are asynchronous. Repeated ``asyncio.run()`` calls create and close a
new event loop for every task invocation. Module-level clients and SQLAlchemy
connection pools then retain resources bound to a closed loop, so a later task
in the same worker process fails with ``Event loop is closed`` or
``attached to a different loop``.

Keep one loop per worker process instead. The lock also makes the helper safe
if a thread-based Celery pool is selected. A forked child never reuses a runner
created by its parent.
"""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

from celery.signals import worker_process_shutdown

T = TypeVar("T")

_runner: asyncio.Runner | None = None
_runner_pid: int | None = None
_runner_lock = threading.Lock()


def _reset_after_fork() -> None:
    """Discard parent-process synchronization state in a forked child."""
    global _runner, _runner_pid, _runner_lock
    _runner = None
    _runner_pid = None
    _runner_lock = threading.Lock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)


def _runner_for_current_process() -> asyncio.Runner:
    global _runner, _runner_pid
    pid = os.getpid()
    if _runner is None or _runner_pid != pid:
        _runner = asyncio.Runner()
        _runner_pid = pid
    return _runner


def run_async(coro: Coroutine[Any, Any, T]) -> T:
    """Run *coro* on the persistent event loop for this worker process."""
    with _runner_lock:
        return _runner_for_current_process().run(coro)


def shutdown_async_runner() -> None:
    """Close the process-local runner during graceful worker shutdown/tests."""
    global _runner, _runner_pid
    with _runner_lock:
        runner = _runner
        _runner = None
        _runner_pid = None
        if runner is not None:
            runner.close()


@worker_process_shutdown.connect
def _on_worker_process_shutdown(**_kwargs: object) -> None:
    shutdown_async_runner()
