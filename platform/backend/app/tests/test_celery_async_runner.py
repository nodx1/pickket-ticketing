"""Regression tests for the process-local Celery async runner."""

import asyncio
import ast
from pathlib import Path
from types import SimpleNamespace

from app.tasks.async_runner import run_async, shutdown_async_runner


def test_celery_tasks_do_not_create_per_invocation_event_loops():
    """Every sync Celery bridge must use the shared runner, not asyncio.run."""
    tasks_dir = Path(__file__).parents[1] / "tasks"
    violations: list[str] = []
    for path in tasks_dir.glob("*.py"):
        if path.name == "async_runner.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "run"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "asyncio"
            ):
                violations.append(f"{path.name}:{node.lineno}")
    assert violations == []


def test_run_async_reuses_one_event_loop_across_consecutive_tasks():
    """Three sequential task calls in one worker must use the same live loop."""

    async def loop_identity() -> int:
        await asyncio.sleep(0)
        return id(asyncio.get_running_loop())

    shutdown_async_runner()
    try:
        loop_ids = [run_async(loop_identity()) for _ in range(3)]
        assert len(set(loop_ids)) == 1
    finally:
        shutdown_async_runner()


def test_reconciliation_pg_bridges_reuse_worker_event_loop(monkeypatch):
    """Gate A inquiry and void bridges must share one live worker loop.

    This invokes the production reconciliation helpers three times each.  It is
    intentionally behavioral rather than a source-string assertion: replacing
    either bridge with ``asyncio.run`` still executes, but exposes distinct loop
    objects and fails this contract.
    """
    from app.tasks import reconciliation

    observed_loops: list[asyncio.AbstractEventLoop] = []

    class Gateway:
        async def fetch_payment_by_order_id(self, order_id, *, transaction_id=None):
            observed_loops.append(asyncio.get_running_loop())
            return {"TID": transaction_id, "Status": "0"}

        @staticmethod
        def parse_webhook_event(payload):
            return SimpleNamespace(amount=None, status="paid")

        async def void_authorization(self, **kwargs):
            observed_loops.append(asyncio.get_running_loop())
            return SimpleNamespace(voided=True, raw={"status": "cancelled"})

    gateway = Gateway()
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )

    shutdown_async_runner()
    try:
        inquiries = [
            reconciliation._fetch_payment_by_order_sync(
                provider="nicepay",
                order_id="NPA-LOOP-MOID",
                transaction_id="NPA-LOOP-TID",
            )
            for _ in range(3)
        ]
        voids = [
            reconciliation._cancel_payment_sync(
                provider="nicepay",
                payment_id="NPA-LOOP-MOID",
                transaction_id="NPA-LOOP-TID",
                original_amount=1004,
                reason="loop-contract",
            )
            for _ in range(3)
        ]

        assert [result["status"] for result in inquiries] == ["paid"] * 3
        assert voids == [(True, {"status": "cancelled"})] * 3
        assert len(observed_loops) == 6
        assert all(loop is observed_loops[0] for loop in observed_loops)
        assert observed_loops[0].is_closed() is False
    finally:
        shutdown_async_runner()
