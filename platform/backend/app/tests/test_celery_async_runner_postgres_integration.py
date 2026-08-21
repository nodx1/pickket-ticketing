"""Real-PostgreSQL regression for repeated Celery async task execution.

Run against the disposable local v2 database (never production)::

    V2_PG_PASSWORD="$(docker exec pickket-v2-db printenv POSTGRES_PASSWORD)"
    RUN_INTEGRATION=1 SECRET_KEY=x \
      DATABASE_URL="postgresql+asyncpg://pickket_v2:${V2_PG_PASSWORD}@127.0.0.1:5435/pickket_v2_dev" \
      .venv/bin/python -m pytest \
      app/tests/test_celery_async_runner_postgres_integration.py -q --no-cov

The production defect succeeds once and fails on a later call because
``asyncio.run`` closes the loop while SQLAlchemy retains its asyncpg pooled
connection. This test deliberately calls the real messaging-task bridge three
times in the same process and executes actual SQL on every call.
"""

import os

import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from app.core.config import settings
from app.core.database import async_session
from app.tasks import messaging_dispatch
from app.tasks.async_runner import shutdown_async_runner


RUN_INTEGRATION = os.getenv("RUN_INTEGRATION") == "1"


@pytest.mark.skipif(not RUN_INTEGRATION, reason="RUN_INTEGRATION=1 required")
def test_messaging_task_db_bridge_succeeds_three_times_in_same_process(monkeypatch):
    """The actual Celery task can reuse pooled asyncpg three times in one process."""
    url = make_url(settings.DATABASE_URL)
    assert url.get_backend_name() == "postgresql"
    assert url.host in {"127.0.0.1", "localhost"}
    assert url.database == "pickket_v2_dev"

    async def probe_database() -> tuple[str, int]:
        async with async_session() as session:
            row = (await session.execute(text("SELECT current_database(), 1"))).one()
            return str(row[0]), int(row[1])

    def probe_dispatch(*, campaign: bool):
        assert campaign is False
        return probe_database()

    monkeypatch.setattr(messaging_dispatch, "_dispatch_batch", probe_dispatch)

    shutdown_async_runner()
    try:
        results = [messaging_dispatch.dispatch_messages.run() for _ in range(3)]
        assert results == [("pickket_v2_dev", 1)] * 3
    finally:
        shutdown_async_runner()
