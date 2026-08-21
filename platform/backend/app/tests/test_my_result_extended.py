import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.allocation import Allocation, AllocationResult, AllocationStatus
from app.models.bid import Bid, BidStatus
from app.models.order import Order, OrderStatus, OrderType
from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
    register_user,
)


async def _create_base_users_and_event(client):
    org_token = await get_auth_token(
        client, email=f"mr_org_{uuid.uuid4().hex[:6]}@test.com", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token, title="MyResult Extended")
    winner = await register_user(client, email=f"mr_winner_{uuid.uuid4().hex[:6]}@test.com")
    loser = await register_user(client, email=f"mr_loser_{uuid.uuid4().hex[:6]}@test.com")
    return org_token, event, winner, loser


async def _add_bid_and_allocation(
    *,
    event_id: str,
    winner_user_id: str,
    bid_price: float = 120.0,
    tier_id: str | None = None,
):
    async with TestSession() as session:
        bid = Bid(
            user_id=uuid.UUID(winner_user_id),
            event_id=uuid.UUID(event_id),
            max_willingness_to_pay=bid_price,
            quantity=1,
            tier_id=uuid.UUID(tier_id) if tier_id else None,
            status=BidStatus.WON,
        )
        session.add(bid)
        await session.flush()

        allocation = Allocation(
            event_id=uuid.UUID(event_id),
            status=AllocationStatus.COMPLETED,
            total_bids=1,
            total_allocated=1,
            competition_ratio=1.0,
        )
        session.add(allocation)
        await session.flush()

        result = AllocationResult(
            allocation_id=allocation.id,
            bid_id=bid.id,
            user_id=uuid.UUID(winner_user_id),
            vcg_price=80.0,
            final_price=90.0,
            externality=10.0,
        )
        session.add(result)
        await session.commit()
        return {"bid_id": bid.id, "allocation_id": allocation.id}


@pytest.mark.asyncio
async def test_my_result_winner_has_bid_price(client):
    _, event, winner, _ = await _create_base_users_and_event(client)
    await _add_bid_and_allocation(
        event_id=event["id"],
        winner_user_id=winner["user"]["id"],
        bid_price=135.0,
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(winner["access_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["won"] is True
    assert data["bid_price"] == 135.0


@pytest.mark.asyncio
async def test_my_result_winner_has_order_id(client):
    _, event, winner, _ = await _create_base_users_and_event(client)
    await _add_bid_and_allocation(
        event_id=event["id"],
        winner_user_id=winner["user"]["id"],
    )

    async with TestSession() as session:
        order = Order(
            user_id=uuid.UUID(winner["user"]["id"]),
            event_id=uuid.UUID(event["id"]),
            tier_id=None,
            order_type=OrderType.PURCHASE,
            status=OrderStatus.PAYMENT_REQUIRED,
            quantity=1,
            unit_price=90.0,
            total_amount=90.0,
            payment_deadline=datetime.now(timezone.utc) + timedelta(hours=24),
        )
        session.add(order)
        await session.commit()
        order_id = str(order.id)

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(winner["access_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["order_id"] == order_id
    assert data["payment_deadline"] is not None


@pytest.mark.asyncio
async def test_my_result_winner_no_order(client):
    _, event, winner, _ = await _create_base_users_and_event(client)
    await _add_bid_and_allocation(
        event_id=event["id"],
        winner_user_id=winner["user"]["id"],
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(winner["access_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["won"] is True
    assert data["order_id"] is None


@pytest.mark.asyncio
async def test_my_result_winner_has_tier_name(client):
    org_token, event, winner, _ = await _create_base_users_and_event(client)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP-TIER",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    await _add_bid_and_allocation(
        event_id=event["id"],
        winner_user_id=winner["user"]["id"],
        tier_id=tier["id"],
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(winner["access_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["tier_name"] == "VIP-TIER"


@pytest.mark.asyncio
async def test_my_result_loser_no_extras(client):
    _, event, winner, loser = await _create_base_users_and_event(client)
    await _add_bid_and_allocation(
        event_id=event["id"],
        winner_user_id=winner["user"]["id"],
    )

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(loser["access_token"]),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["won"] is False
    assert data["bid_price"] is None
    assert data["order_id"] is None
    assert data["tier_name"] is None


@pytest.mark.asyncio
async def test_my_result_not_allocated(client):
    _, event, winner, _ = await _create_base_users_and_event(client)

    resp = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(winner["access_token"]),
    )
    assert resp.status_code == 404
    assert "not yet performed" in resp.json()["detail"].lower()
