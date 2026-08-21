"""Tests for notification endpoints.

Endpoints under /api/v1/notifications/:
  GET   /stream                   - SSE notification stream (skipped: requires real pub/sub)
  GET   /                         - list persisted notifications
  POST  /{notification_id}/read   - mark single notification as read
  POST  /read-all                 - mark all notifications as read
"""

import uuid

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.api.v1.notifications import _get_sse_user
from app.core.security import decode_access_token_payload
from app.services.token_blacklist import blacklist_token
from app.tests.conftest import TestSession, auth_headers, get_auth_token


# ---------------------------------------------------------------------------
# GET /api/v1/notifications/
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_notifications_empty(client):
    """User gets empty notification list when no notifications exist."""
    token = await get_auth_token(client)
    resp = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "notifications" in data
    assert isinstance(data["notifications"], list)
    assert len(data["notifications"]) == 0
    assert "unread_count" in data
    assert data["unread_count"] == 0


@pytest.mark.asyncio
async def test_get_notifications_no_auth(client):
    """Unauthenticated request returns 401 or 403."""
    resp = await client.get("/api/v1/notifications/")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_get_notifications_pagination(client):
    """Notification list supports skip/limit query params."""
    token = await get_auth_token(client)
    resp = await client.get(
        "/api/v1/notifications/?skip=0&limit=10",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "notifications" in data
    assert "unread_count" in data


# ---------------------------------------------------------------------------
# POST /api/v1/notifications/{notification_id}/read
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_notification_read_not_found(client):
    """Marking a non-existent notification returns 404."""
    token = await get_auth_token(client)
    fake_id = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/notifications/{fake_id}/read",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_mark_notification_read_no_auth(client):
    """Mark-read endpoint requires authentication."""
    fake_id = str(uuid.uuid4())
    resp = await client.post(f"/api/v1/notifications/{fake_id}/read")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# POST /api/v1/notifications/read-all
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_all_read_empty(client):
    """Marking all as read when no notifications exist succeeds with count 0."""
    token = await get_auth_token(client)
    resp = await client.post(
        "/api/v1/notifications/read-all",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["updated"] == 0


@pytest.mark.asyncio
async def test_mark_all_read_no_auth(client):
    """Read-all endpoint requires authentication."""
    resp = await client.post("/api/v1/notifications/read-all")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Notification creation via service + endpoint round-trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_notification_create_and_list(client, db_session):
    """Notification created via service appears in the list endpoint."""
    from app.tests.conftest import register_user

    user_data = await register_user(client, email="notif@test.com")
    token = user_data["access_token"]
    user_id = uuid.UUID(user_data["user"]["id"])

    # Create an event so we have a valid event_id for the notification
    org_token = await get_auth_token(
        client,
        email="notiforg@test.com",
        is_organizer=True,
    )
    from app.tests.conftest import create_event_as_organizer

    event = await create_event_as_organizer(client, org_token)
    event_id = uuid.UUID(event["id"])

    # Insert a notification directly via the service
    from app.services.notification_service import NotificationService

    svc = NotificationService(db_session)
    await svc.notify(
        user_id=user_id,
        event_id=event_id,
        type="TEST_NOTIFICATION",
        message="This is a test notification",
    )
    await db_session.commit()

    # Now fetch via API
    resp = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["notifications"]) >= 1
    assert data["unread_count"] >= 1

    notif = data["notifications"][0]
    assert notif["type"] == "TEST_NOTIFICATION"
    assert notif["message"] == "This is a test notification"
    assert notif["is_read"] is False

    # Mark it as read
    notif_id = notif["id"]
    resp2 = await client.post(
        f"/api/v1/notifications/{notif_id}/read",
        headers=auth_headers(token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["ok"] is True

    # Verify unread count decreased
    resp3 = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp3.status_code == 200
    assert resp3.json()["unread_count"] == 0


@pytest.mark.asyncio
async def test_mark_all_read_with_notifications(client, db_session):
    """Mark-all-read updates all unread notifications for the user."""
    from app.tests.conftest import register_user, create_event_as_organizer

    user_data = await register_user(client, email="markall@test.com")
    token = user_data["access_token"]
    user_id = uuid.UUID(user_data["user"]["id"])

    org_token = await get_auth_token(
        client,
        email="markallorg@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = uuid.UUID(event["id"])

    # Insert multiple notifications
    from app.services.notification_service import NotificationService

    svc = NotificationService(db_session)
    for i in range(3):
        await svc.notify(
            user_id=user_id,
            event_id=event_id,
            type="BULK_TEST",
            message=f"Notification {i}",
        )
    await db_session.commit()

    # Verify 3 unread
    resp = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json()["unread_count"] == 3

    # Mark all as read
    resp2 = await client.post(
        "/api/v1/notifications/read-all",
        headers=auth_headers(token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["updated"] == 3

    # Verify 0 unread
    resp3 = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp3.status_code == 200
    assert resp3.json()["unread_count"] == 0


# ---------------------------------------------------------------------------
# SSE stream token hardening
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_stream_token_requires_auth(client):
    resp = await client.post("/api/v1/notifications/stream-token")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_stream_token_is_single_use(client):
    token = await get_auth_token(client, email="stream-single-use@test.com")
    issued = await client.post(
        "/api/v1/notifications/stream-token",
        headers=auth_headers(token),
    )
    assert issued.status_code == 200
    body = issued.json()
    assert isinstance(body.get("token"), str)
    assert body.get("expires_in", 0) > 0

    stream_token = body["token"]
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/v1/notifications/stream",
            "headers": [],
            "query_string": b"",
        }
    )

    async with TestSession() as session:
        user = await _get_sse_user(request=request, stream_token=stream_token, db=session)
    assert user.email == "stream-single-use@test.com"

    async with TestSession() as session:
        with pytest.raises(HTTPException) as exc:
            await _get_sse_user(request=request, stream_token=stream_token, db=session)
    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_stream_rejects_blacklisted_bearer_token(client):
    token = await get_auth_token(client, email="stream-blacklisted@test.com")
    payload = decode_access_token_payload(token)
    assert payload is not None

    await blacklist_token(str(payload["jti"]), payload["exp"])

    resp = await client.get(
        "/api/v1/notifications/stream",
        headers=auth_headers(token),
    )
    assert resp.status_code == 401
