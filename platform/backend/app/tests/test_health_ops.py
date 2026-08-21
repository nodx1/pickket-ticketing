import json
import time
import uuid

import pytest

from app.core.ops_health import (
    BACKUP_LAST_RESULT_KEY,
    BACKUP_LAST_SUCCESS_KEY,
    BEAT_HEARTBEAT_KEY,
    BEAT_HEARTBEAT_MAX_AGE_SECONDS,
)
from app.core.redis import get_redis
from app.models.user import User
from app.tests.conftest import TestSession, auth_headers, register_user


@pytest.mark.asyncio
async def test_detailed_health_reports_scheduler_and_backup(client, monkeypatch):
    redis = get_redis()
    now = time.time()

    await redis.set(
        BEAT_HEARTBEAT_KEY,
        json.dumps({"status": "ok", "timestamp": now, "recorded_at": "2026-03-13T00:00:00+00:00"}),
    )
    await redis.set(
        BACKUP_LAST_SUCCESS_KEY,
        json.dumps(
            {
                "status": "success",
                "timestamp": now,
                "recorded_at": "2026-03-13T00:00:00+00:00",
                "backup_id": "backup-1",
            }
        ),
    )
    await redis.set(
        BACKUP_LAST_RESULT_KEY,
        json.dumps(
            {
                "status": "success",
                "timestamp": now,
                "recorded_at": "2026-03-13T00:00:00+00:00",
                "backup_id": "backup-1",
            }
        ),
    )

    class _FakeInspect:
        def active(self):
            return {"worker@1": []}

    monkeypatch.setattr(
        "app.core.celery_app.celery_app.control.inspect",
        lambda timeout=2: _FakeInspect(),
    )

    resp = await client.get("/api/v1/health/detailed")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "healthy"
    assert payload["scheduler"]["status"] == "ok"
    assert payload["backup"]["status"] == "ok"
    assert payload["backup"]["backup_id"] == "backup-1"
    assert payload["celery"]["workers"] == 1


@pytest.mark.asyncio
async def test_detailed_health_degrades_when_scheduler_stale(client, monkeypatch):
    redis = get_redis()
    stale_ts = time.time() - BEAT_HEARTBEAT_MAX_AGE_SECONDS - 5

    await redis.set(
        BEAT_HEARTBEAT_KEY,
        json.dumps(
            {
                "status": "ok",
                "timestamp": stale_ts,
                "recorded_at": "2026-03-12T23:00:00+00:00",
            }
        ),
    )

    class _FakeInspect:
        def active(self):
            return {"worker@1": []}

    monkeypatch.setattr(
        "app.core.celery_app.celery_app.control.inspect",
        lambda timeout=2: _FakeInspect(),
    )

    resp = await client.get("/api/v1/health/detailed")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["status"] == "degraded"
    assert payload["scheduler"]["status"] == "stale"


@pytest.mark.asyncio
async def test_detailed_health_forbidden_for_public_clients_in_production(client, monkeypatch):
    monkeypatch.setattr("app.api.v1.health.settings.ENVIRONMENT", "production")

    resp = await client.get("/api/v1/health/detailed")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Forbidden"


@pytest.mark.asyncio
async def test_detailed_health_allows_valid_ops_token_in_production(client, monkeypatch):
    monkeypatch.setattr("app.api.v1.health.settings.ENVIRONMENT", "production")
    monkeypatch.setattr("app.api.v1.health.settings.OPS_HEALTH_TOKEN", "ops-secret")

    resp = await client.get(
        "/api/v1/health/detailed",
        headers={"X-Pickket-Ops-Token": "ops-secret"},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_admin_system_health_requires_admin_role(client):
    data = await register_user(client, email="health-admin@test.com")
    token = data["access_token"]
    user_id = data["user"]["id"]

    async with TestSession() as session:
        user = await session.get(User, uuid.UUID(user_id))
        user.is_admin = True
        await session.commit()

    resp = await client.get(
        "/api/v1/admin/system/health",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_admin_system_health_forbidden_for_non_admin(client):
    data = await register_user(client, email="health-user@test.com")
    token = data["access_token"]
    resp = await client.get(
        "/api/v1/admin/system/health",
        headers=auth_headers(token),
    )
    assert resp.status_code == 403
