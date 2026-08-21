import uuid

import pytest

from app.services.notification_service import NotificationService
from app.tests.conftest import auth_headers, register_user


async def _create_user(client, email: str) -> tuple[uuid.UUID, str]:
    user_data = await register_user(client, email=email)
    return uuid.UUID(user_data["user"]["id"]), user_data["access_token"]


@pytest.mark.asyncio
async def test_create_notification(client, db_session):
    user_id, _ = await _create_user(client, "notif_create@test.com")
    svc = NotificationService(db_session)
    notif = await svc.create_notification(
        user_id,
        type="test_create",
        message="created",
    )
    await db_session.commit()

    assert notif.id is not None
    assert notif.user_id == user_id
    assert notif.type == "test_create"
    assert notif.is_read is False
    assert notif.is_sent is False


@pytest.mark.asyncio
async def test_get_notifications_latest_first(client, db_session):
    user_id, _ = await _create_user(client, "notif_latest@test.com")
    svc = NotificationService(db_session)
    first = await svc.create_notification(user_id, type="n1", message="first")
    second = await svc.create_notification(user_id, type="n2", message="second")
    await db_session.commit()

    rows = await svc.get_user_notifications(user_id)
    assert len(rows) >= 2
    assert rows[0].id == second.id
    assert rows[1].id == first.id


@pytest.mark.asyncio
async def test_get_unread_only(client, db_session):
    user_id, _ = await _create_user(client, "notif_unread@test.com")
    svc = NotificationService(db_session)
    read_notif = await svc.create_notification(user_id, type="read", message="read")
    await svc.create_notification(user_id, type="unread", message="unread")
    await db_session.flush()
    await svc.mark_as_read(read_notif.id, user_id)
    await db_session.commit()

    rows = await svc.get_user_notifications(user_id, unread_only=True)
    assert len(rows) == 1
    assert rows[0].type == "unread"


@pytest.mark.asyncio
async def test_get_unread_count(client, db_session):
    user_id, _ = await _create_user(client, "notif_count@test.com")
    svc = NotificationService(db_session)
    one = await svc.create_notification(user_id, type="a", message="a")
    await svc.create_notification(user_id, type="b", message="b")
    await svc.mark_as_read(one.id, user_id)
    await db_session.commit()

    count = await svc.get_unread_count(user_id)
    assert count == 1


@pytest.mark.asyncio
async def test_mark_as_read(client, db_session):
    user_id, _ = await _create_user(client, "notif_mark@test.com")
    svc = NotificationService(db_session)
    notif = await svc.create_notification(user_id, type="mark", message="m")
    await db_session.commit()

    ok = await svc.mark_as_read(notif.id, user_id)
    await db_session.commit()
    assert ok is True

    rows = await svc.get_user_notifications(user_id)
    assert rows[0].is_read is True


@pytest.mark.asyncio
async def test_mark_as_read_wrong_user(client, db_session):
    owner_id, _ = await _create_user(client, "notif_owner@test.com")
    other_id, _ = await _create_user(client, "notif_other@test.com")
    svc = NotificationService(db_session)
    notif = await svc.create_notification(owner_id, type="mark_wrong", message="x")
    await db_session.commit()

    ok = await svc.mark_as_read(notif.id, other_id)
    await db_session.commit()
    assert ok is False


@pytest.mark.asyncio
async def test_mark_all_as_read(client, db_session):
    user_id, _ = await _create_user(client, "notif_all@test.com")
    svc = NotificationService(db_session)
    await svc.create_notification(user_id, type="a", message="1")
    await svc.create_notification(user_id, type="b", message="2")
    await db_session.commit()

    marked = await svc.mark_all_as_read(user_id)
    await db_session.commit()
    assert marked == 2
    assert await svc.get_unread_count(user_id) == 0


@pytest.mark.asyncio
async def test_api_list_notifications(client, db_session):
    user_id, token = await _create_user(client, "notif_api_list@test.com")
    svc = NotificationService(db_session)
    await svc.create_notification(user_id, type="api_list", message="hello")
    await db_session.commit()

    resp = await client.get("/api/v1/notifications/", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "notifications" in data
    assert len(data["notifications"]) >= 1


@pytest.mark.asyncio
async def test_api_unread_count(client, db_session):
    user_id, token = await _create_user(client, "notif_api_count@test.com")
    svc = NotificationService(db_session)
    await svc.create_notification(user_id, type="api_count", message="x")
    await db_session.commit()

    resp = await client.get(
        "/api/v1/notifications/unread-count",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["count"] == 1


@pytest.mark.asyncio
async def test_api_mark_read(client, db_session):
    user_id, token = await _create_user(client, "notif_api_read@test.com")
    svc = NotificationService(db_session)
    notif = await svc.create_notification(user_id, type="api_read", message="x")
    await db_session.commit()

    resp = await client.patch(
        f"/api/v1/notifications/{notif.id}/read",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
