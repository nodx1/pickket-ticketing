"""Local-only PostgreSQL/process primitives for NICE-PA-FAULT-v1 scripts."""

from __future__ import annotations

import asyncio
import subprocess
from dataclasses import dataclass
from multiprocessing.context import BaseContext
from typing import Awaitable, Callable, TypeVar

from sqlalchemy.engine import URL


CONTAINER = "pickket-v2-db"
HOST = "127.0.0.1"
PORT = 5435
DATABASE = "pickket_v2_dev"

T = TypeVar("T")


def container_credentials() -> tuple[str, str]:
    """Read local container credentials without putting a password in argv/output."""
    proc = subprocess.run(
        [
            "docker",
            "inspect",
            "--format",
            "{{range .Config.Env}}{{println .}}{{end}}",
            CONTAINER,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    env: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            env[key] = value
    user = env.get("POSTGRES_USER")
    password = env.get("POSTGRES_PASSWORD")
    if not user or not password:
        raise RuntimeError(f"{CONTAINER} has no POSTGRES_USER/POSTGRES_PASSWORD")
    return user, password


def local_async_url() -> URL:
    user, password = container_credentials()
    return URL.create(
        "postgresql+asyncpg",
        username=user,
        password=password,
        host=HOST,
        port=PORT,
        database=DATABASE,
    )


def local_sync_url() -> URL:
    user, password = container_credentials()
    return URL.create(
        "postgresql+psycopg2",
        username=user,
        password=password,
        host=HOST,
        port=PORT,
        database=DATABASE,
    )


async def rendezvous(parties: int, functions: list[Callable[[], Awaitable[T]]]) -> list[T]:
    """Release async participants only after every real connection is ready."""
    if parties != len(functions) or parties < 2:
        raise ValueError("rendezvous requires one function per party and at least two parties")
    ready = 0
    condition = asyncio.Condition()

    async def participant(function: Callable[[], Awaitable[T]]) -> T:
        nonlocal ready
        async with condition:
            ready += 1
            if ready == parties:
                condition.notify_all()
            else:
                await condition.wait_for(lambda: ready == parties)
        return await function()

    return await asyncio.gather(*(participant(function) for function in functions))


@dataclass(frozen=True, slots=True)
class ChildResult:
    exit_code: int
    killed: bool


def terminate_child_at_checkpoint(
    context: BaseContext,
    target,
    args: tuple,
    checkpoint,
    *,
    timeout: float = 10.0,
) -> ChildResult:
    """Kill a spawned process only after it reports the requested checkpoint.

    The target receives ``checkpoint`` as its first positional argument and
    must call ``checkpoint.set()`` after the durable phase being tested.  This
    is intentionally a real process termination, not an exception raised in
    the test process (F08/F09/F22).
    """
    process = context.Process(target=target, args=(checkpoint, *args))
    process.start()
    if not checkpoint.wait(timeout):
        process.terminate()
        process.join(timeout=timeout)
        raise TimeoutError("child never reached crash checkpoint")
    process.kill()
    process.join(timeout=timeout)
    if process.is_alive():
        process.terminate()
        process.join(timeout=timeout)
        raise TimeoutError("child did not terminate")
    return ChildResult(exit_code=process.exitcode or 0, killed=(process.exitcode or 0) < 0)
