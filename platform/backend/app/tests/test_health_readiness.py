from unittest.mock import AsyncMock

import pytest

from app.api import health


class _ScalarResult:
    def __init__(self, values: list[str]):
        self._values = values

    def scalars(self):
        return self

    def all(self):
        return self._values


class _Connection:
    def __init__(self, heads: list[str], migration_error: Exception | None = None):
        self._heads = heads
        self._migration_error = migration_error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def execute(self, statement):
        sql = str(statement)
        if "alembic_version" in sql:
            if self._migration_error is not None:
                raise self._migration_error
            return _ScalarResult(self._heads)
        return _ScalarResult([])


class _Engine:
    def __init__(self, heads: list[str], migration_error: Exception | None = None):
        self._heads = heads
        self._migration_error = migration_error

    def connect(self):
        return _Connection(self._heads, self._migration_error)


@pytest.fixture(autouse=True)
def _healthy_redis(monkeypatch):
    monkeypatch.setattr(health, "redis_health_check", AsyncMock(return_value=True))
    monkeypatch.setattr(health, "is_redis_circuit_open", lambda: False)
    monkeypatch.setattr(health, "_expected_alembic_heads", lambda: frozenset({"lvl2idem_0725"}))


@pytest.mark.asyncio
async def test_readiness_accepts_exact_alembic_head(monkeypatch):
    monkeypatch.setattr("app.core.database.engine", _Engine(["lvl2idem_0725"]))

    result = await health._check_readiness()

    assert result["status"] == "ok"
    assert result["migrations"] == "ok"


@pytest.mark.asyncio
async def test_readiness_rejects_missing_alembic_head(monkeypatch):
    monkeypatch.setattr("app.core.database.engine", _Engine(["lvl2gu_mrg_0724"]))

    result = await health._check_readiness()

    assert result["status"] == "degraded"
    assert result["migrations"] == {
        "status": "out_of_date",
        "expected_heads": ["lvl2idem_0725"],
        "database_heads": ["lvl2gu_mrg_0724"],
    }
    response = await health.readiness()
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_readiness_rejects_alembic_table_failure(monkeypatch):
    monkeypatch.setattr(
        "app.core.database.engine",
        _Engine([], migration_error=RuntimeError("alembic_version missing")),
    )

    result = await health._check_readiness()

    assert result["status"] == "degraded"
    assert result["migrations"] == "unavailable"
