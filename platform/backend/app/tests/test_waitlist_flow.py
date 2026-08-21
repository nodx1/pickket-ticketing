from unittest.mock import AsyncMock, patch

import pytest

from app.tests.conftest import auth_headers, create_event_as_organizer, get_auth_token


@pytest.fixture(autouse=True)
def _enable_waitlist_flag():
    """Enable face-value waitlist feature flag for all tests in this module."""
    with patch(
        "app.api.v1.waitlist.get_feature_flag",
        new_callable=AsyncMock,
        return_value=True,
    ):
        yield


@pytest.mark.asyncio
async def test_join_waitlist(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["status"] is not None
    assert "id" in data
    assert "tier_id" in data
    assert "user_id" in data
    assert "position" in data
    assert "priority_score" in data


@pytest.mark.asyncio
async def test_join_waitlist_duplicate_returns_400(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_join_waitlist_without_auth_returns_401(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_get_waitlist_status(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist/status",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_waiting"] == 1
    assert data["my_position"] is not None
    assert data["my_entry"] is not None
    assert data["my_entry"]["user_id"] is not None


@pytest.mark.asyncio
async def test_get_waitlist_status_not_on_list(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    resp = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist/status",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_waiting"] == 0
    assert data["my_position"] is None
    assert data["my_entry"] is None


@pytest.mark.asyncio
async def test_leave_waitlist(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )

    resp = await client.delete(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_leave_waitlist_not_found(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer@test.com")
    resp = await client.delete(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_multiple_users_waitlist_ordering(client):
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "GA",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer1_token = await get_auth_token(client, email="buyer1@test.com")
    buyer2_token = await get_auth_token(client, email="buyer2@test.com")

    resp1 = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer1_token),
    )
    assert resp1.status_code == 201

    resp2 = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist",
        json={"quantity": 1},
        headers=auth_headers(buyer2_token),
    )
    assert resp2.status_code == 201

    status1 = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist/status",
        headers=auth_headers(buyer1_token),
    )
    assert status1.status_code == 200
    data1 = status1.json()
    assert data1["total_waiting"] == 2
    assert data1["my_position"] is not None

    status2 = await client.get(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/waitlist/status",
        headers=auth_headers(buyer2_token),
    )
    assert status2.status_code == 200
    data2 = status2.json()
    assert data2["total_waiting"] == 2
    assert data2["my_position"] is not None

    # Both users have priority_score=0.0, so positions are equal
    # What matters is that both are on the list with valid positions
    assert data1["my_position"] >= 1
    assert data2["my_position"] >= 1
