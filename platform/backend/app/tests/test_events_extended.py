import uuid

import pytest
from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
    make_event_payload,
)


def _email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


@pytest.mark.asyncio
async def test_create_event_success(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("events_ext_org"), is_organizer=True)
    response = await client.post(
        "/api/v1/events/",
        json=make_event_payload(title="Events Extended Create"),
        headers=auth_headers(org_token),
    )
    assert response.status_code == 201
    assert response.json()["title"] == "Events Extended Create"


@pytest.mark.asyncio
async def test_create_event_non_organizer(client: AsyncClient):
    user_token = await get_auth_token(client, email=_email("events_ext_user"), is_organizer=False)
    response = await client.post(
        "/api/v1/events/",
        json=make_event_payload(),
        headers=auth_headers(user_token),
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_list_events(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("events_ext_list_org"), is_organizer=True)
    await create_event_as_organizer(client, org_token, title="Events Extended List")

    response = await client.get("/api/v1/events/")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data["events"], list)
    assert data["total"] >= 1


@pytest.mark.asyncio
async def test_get_event_detail(client: AsyncClient):
    org_token = await get_auth_token(
        client, email=_email("events_ext_detail_org"), is_organizer=True
    )
    created = await create_event_as_organizer(client, org_token, title="Events Extended Detail")

    response = await client.get(f"/api/v1/events/{created['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == created["id"]


@pytest.mark.asyncio
async def test_get_event_not_found(client: AsyncClient):
    response = await client.get(f"/api/v1/events/{uuid.uuid4()}")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_event_owner(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("events_ext_owner"), is_organizer=True)
    created = await create_event_as_organizer(client, org_token, title="Before Owner Update")

    response = await client.patch(
        f"/api/v1/events/{created['id']}",
        json={"title": "After Owner Update"},
        headers=auth_headers(org_token),
    )
    assert response.status_code == 200
    assert response.json()["title"] == "After Owner Update"


@pytest.mark.asyncio
async def test_update_event_not_owner(client: AsyncClient):
    owner_token = await get_auth_token(client, email=_email("events_ext_owner2"), is_organizer=True)
    other_org_token = await get_auth_token(
        client, email=_email("events_ext_other"), is_organizer=True
    )
    created = await create_event_as_organizer(client, owner_token, title="Owner Event")

    response = await client.patch(
        f"/api/v1/events/{created['id']}",
        json={"title": "Should Not Update"},
        headers=auth_headers(other_org_token),
    )
    assert response.status_code in (403, 404)


@pytest.mark.asyncio
async def test_event_with_tiers(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("events_ext_tier_org"), is_organizer=True)
    created = await create_event_as_organizer(client, org_token, title="Tier Event")

    tier_response = await client.post(
        f"/api/v1/events/{created['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 50,
            "base_price": 120.0,
            "sale_mode": "fixed_fcfs",
        },
        headers=auth_headers(org_token),
    )
    assert tier_response.status_code == 201

    tiers_response = await client.get(f"/api/v1/events/{created['id']}/tiers")
    assert tiers_response.status_code == 200
    tiers = tiers_response.json()
    assert len(tiers) == 1
    assert tiers[0]["name"] == "VIP"
