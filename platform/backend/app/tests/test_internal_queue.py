"""Level2 B2-2 anonymous go→v2 queue flip regression tests."""

import uuid

import pytest

from app.api.v1 import queue as queue_api
from app.core.config import settings
from app.services import queue_service
from app.services.queue_service import QueueStatus
from app.tests.conftest import create_event_as_organizer, get_auth_token


_SECRET = "test-go-webhook-secret"
_HEADERS = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _queue_internal_auth(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False)


async def _seed_event(client, suffix: str) -> str:
    token = await get_auth_token(
        client,
        email=f"queue-internal-{suffix}@example.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(
        client,
        token,
        title=f"Internal Queue {suffix}",
    )
    return event["id"]


class _FakeQueue:
    instances: list["_FakeQueue"] = []

    def __init__(self, event_id):
        self.event_id = str(event_id)
        self.max_active: int | None = None
        self.calls: list[tuple[str, str]] = []
        self.__class__.instances.append(self)

    async def configure_max_active(self, max_active: int) -> None:
        self.max_active = max_active

    async def join(self, session_token: str) -> QueueStatus:
        self.calls.append(("join", session_token))
        return QueueStatus(
            position=4,
            total_waiting=12,
            is_active=False,
            estimated_wait_seconds=9,
        )

    async def get_status(self, session_token: str) -> QueueStatus:
        self.calls.append(("status", session_token))
        return QueueStatus(
            position=0,
            total_waiting=3,
            is_active=True,
            estimated_wait_seconds=0,
            token="admission-token",
        )

    async def leave(self, session_token: str) -> bool:
        self.calls.append(("leave", session_token))
        return True


@pytest.fixture
def fake_queue(monkeypatch):
    _FakeQueue.instances = []
    monkeypatch.setattr(queue_api, "QueueService", _FakeQueue)
    return _FakeQueue


@pytest.mark.asyncio
async def test_internal_anonymous_join_delegates_without_sale_status_gate(
    client,
    fake_queue,
):
    event_id = await _seed_event(client, "join")
    session_token = "anonymous-session-0001"

    response = await client.post(
        f"/api/v1/internal/events/{event_id}/queue/join",
        headers=_HEADERS,
        json={
            "session_token": session_token,
            "max_concurrent": 37,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "position": 4,
        "total_waiting": 12,
        "is_active": False,
        "estimated_wait_seconds": 9,
        "token": None,
    }
    queue = fake_queue.instances[-1]
    assert queue.event_id == event_id
    assert queue.max_active == 37
    assert queue.calls == [("join", session_token)]


@pytest.mark.asyncio
async def test_internal_queue_requires_service_auth_and_valid_token(client):
    event_id = await _seed_event(client, "auth")
    path = f"/api/v1/internal/events/{event_id}/queue/join"

    unauthenticated = await client.post(
        path,
        json={
            "session_token": "anonymous-session-0002",
            "max_concurrent": 100,
        },
    )
    assert unauthenticated.status_code == 401

    invalid = await client.post(
        path,
        headers=_HEADERS,
        json={"session_token": "../bad", "max_concurrent": 100},
    )
    assert invalid.status_code == 422


@pytest.mark.asyncio
async def test_internal_queue_rejects_unknown_event_before_redis(client, fake_queue):
    unknown_event = uuid.uuid4()
    response = await client.post(
        f"/api/v1/internal/events/{unknown_event}/queue/join",
        headers=_HEADERS,
        json={
            "session_token": "anonymous-session-0003",
            "max_concurrent": 100,
        },
    )

    assert response.status_code == 404
    assert fake_queue.instances == []


@pytest.mark.asyncio
async def test_internal_status_and_leave_are_event_scoped(client, fake_queue):
    event_a = await _seed_event(client, "scope-a")
    event_b = await _seed_event(client, "scope-b")
    session_token = "anonymous-session-0004"

    status = await client.get(
        f"/api/v1/internal/events/{event_b}/queue/status",
        headers=_HEADERS,
        params={"session_token": session_token},
    )
    assert status.status_code == 200, status.text
    assert status.headers["cache-control"] == "no-store, no-cache, must-revalidate"
    assert status.json()["is_active"] is True
    assert fake_queue.instances[-1].event_id == event_b
    assert fake_queue.instances[-1].calls == [("status", session_token)]

    left = await client.post(
        f"/api/v1/internal/events/{event_a}/queue/leave",
        headers=_HEADERS,
        json={"session_token": session_token},
    )
    assert left.status_code == 200, left.text
    assert left.json() == {"success": True}
    assert fake_queue.instances[-1].event_id == event_a
    assert fake_queue.instances[-1].calls == [("leave", session_token)]


@pytest.mark.asyncio
async def test_event_max_concurrent_is_persisted_for_later_queue_instances(
    monkeypatch,
):
    class _Redis:
        values: dict[str, str] = {}

        async def set(self, key, value):
            self.values[str(key)] = str(value)
            return True

        async def get(self, key):
            return self.values.get(str(key))

    redis = _Redis()
    monkeypatch.setattr(queue_service, "get_redis", lambda: redis)
    event_id = uuid.uuid4()

    writer = queue_service.QueueService(event_id)
    await writer.configure_max_active(23)
    reader = queue_service.QueueService(event_id)
    await reader._load_configured_max_active()

    assert reader._max_active == 23
