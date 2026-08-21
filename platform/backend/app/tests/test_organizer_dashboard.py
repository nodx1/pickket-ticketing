import uuid

import pytest
from sqlalchemy import select

from app.models.bid import Bid, BidStatus
from app.models.event import Event, EventStatus
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


async def _get_user_id(email: str) -> uuid.UUID:
    async with TestSession() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        return user.id


async def _insert_order(
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    status: OrderStatus,
    quantity: int,
    total_amount: float,
):
    async with TestSession() as session:
        order = Order(
            user_id=user_id,
            event_id=event_id,
            tier_id=None,
            order_type=OrderType.PURCHASE,
            status=status,
            quantity=quantity,
            unit_price=total_amount / quantity,
            total_amount=total_amount,
        )
        session.add(order)
        await session.commit()


async def _insert_bid(
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    status: BidStatus,
    max_price: float = 60.0,
):
    async with TestSession() as session:
        bid = Bid(
            user_id=user_id,
            event_id=event_id,
            max_willingness_to_pay=max_price,
            quantity=1,
            status=status,
        )
        session.add(bid)
        await session.commit()


@pytest.mark.asyncio
async def test_dashboard_empty(client):
    token = await get_auth_token(client, email="org_dash_empty@test.com", is_organizer=True)
    resp = await client.get("/api/v1/organizer/dashboard", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_events"] == 0
    assert data["total_revenue"] == 0.0
    assert data["total_tickets_sold"] == 0
    assert data["total_bids_received"] == 0
    assert data["average_competition_ratio"] == 0.0
    assert data["events_by_status"] == {}


@pytest.mark.asyncio
async def test_dashboard_with_events(client):
    org_email = "org_dash_stats@test.com"
    token = await get_auth_token(client, email=org_email, is_organizer=True)
    event_1 = await create_event_as_organizer(client, token, title="Dash Event 1")
    event_2 = await create_event_as_organizer(client, token, title="Dash Event 2")

    buyer_email = "dash_buyer@test.com"
    await get_auth_token(client, email=buyer_email)
    buyer_id = await _get_user_id(buyer_email)

    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=2,
        total_amount=100.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.PAID,
        quantity=1,
        total_amount=50.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.PENDING,
        quantity=1,
        total_amount=50.0,
    )

    await _insert_bid(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=BidStatus.ACTIVE,
    )
    await _insert_bid(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=BidStatus.CANCELLED,
    )
    await _insert_bid(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=BidStatus.ACTIVE,
    )

    async with TestSession() as session:
        e1 = (
            await session.execute(select(Event).where(Event.id == uuid.UUID(event_1["id"])))
        ).scalar_one()
        e2 = (
            await session.execute(select(Event).where(Event.id == uuid.UUID(event_2["id"])))
        ).scalar_one()
        e1.status = EventStatus.BIDDING_OPEN
        e2.status = EventStatus.ALLOCATED
        await session.commit()

    resp = await client.get("/api/v1/organizer/dashboard", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_events"] == 2
    assert data["total_revenue"] == 150.0
    assert data["total_tickets_sold"] == 3
    assert data["total_bids_received"] == 2
    assert data["average_competition_ratio"] == pytest.approx(0.01, rel=1e-4)
    assert data["events_by_status"]["bidding_open"] == 1
    assert data["events_by_status"]["allocated"] == 1


@pytest.mark.asyncio
async def test_revenue_list(client):
    token = await get_auth_token(client, email="org_revenue_list@test.com", is_organizer=True)
    event_1 = await create_event_as_organizer(client, token, title="Revenue Event 1")
    event_2 = await create_event_as_organizer(client, token, title="Revenue Event 2")

    buyer_email = "revenue_buyer@test.com"
    await get_auth_token(client, email=buyer_email)
    buyer_id = await _get_user_id(buyer_email)

    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=2,
        total_amount=120.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.PAID,
        quantity=1,
        total_amount=40.0,
    )

    resp = await client.get("/api/v1/organizer/revenue", headers=auth_headers(token))
    assert resp.status_code == 200
    rows = resp.json()
    by_event = {row["event_id"]: row for row in rows}
    assert by_event[event_1["id"]]["revenue"] == 120.0
    assert by_event[event_1["id"]]["tickets_sold"] == 2
    assert by_event[event_1["id"]]["refunded_amount"] == 0.0
    assert by_event[event_2["id"]]["revenue"] == 40.0
    assert by_event[event_2["id"]]["tickets_sold"] == 1


@pytest.mark.asyncio
async def test_revenue_with_refund(client):
    token = await get_auth_token(client, email="org_revenue_refund@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Revenue Refund Event")

    buyer_email = "revenue_refund_buyer@test.com"
    await get_auth_token(client, email=buyer_email)
    buyer_id = await _get_user_id(buyer_email)

    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=2,
        total_amount=100.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event["id"]),
        status=OrderStatus.REFUNDED,
        quantity=1,
        total_amount=30.0,
    )

    resp = await client.get("/api/v1/organizer/revenue", headers=auth_headers(token))
    assert resp.status_code == 200
    row = {r["event_id"]: r for r in resp.json()}[event["id"]]
    assert row["revenue"] == 100.0
    assert row["refunded_amount"] == 30.0
    assert row["net_revenue"] == 70.0


@pytest.mark.asyncio
async def test_settlement_all(client):
    token = await get_auth_token(client, email="org_settlement_all@test.com", is_organizer=True)
    event_1 = await create_event_as_organizer(client, token, title="Settlement Event 1")
    event_2 = await create_event_as_organizer(client, token, title="Settlement Event 2")

    buyer_email = "settlement_buyer@test.com"
    await get_auth_token(client, email=buyer_email)
    buyer_id = await _get_user_id(buyer_email)

    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=2,
        total_amount=100.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.PAID,
        quantity=1,
        total_amount=50.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.REFUNDED,
        quantity=1,
        total_amount=20.0,
    )

    resp = await client.get("/api/v1/organizer/settlement", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["gross_revenue"] == 150.0
    assert data["platform_fee"] == 7.5
    # net = gross - platform_fee(5%) - pg_fee(2.5%) - refunds (settlement_generate.py 기준)
    # pg_fee = 150 * 0.025 = 3.75 → net = 150 - 7.5 - 3.75 = 138.75
    assert data["net_settlement"] == 138.75
    assert data["pending_refunds"] == 20.0
    assert data["final_payout"] == 118.75


@pytest.mark.asyncio
async def test_settlement_single_event(client):
    token = await get_auth_token(client, email="org_settlement_one@test.com", is_organizer=True)
    event_1 = await create_event_as_organizer(client, token, title="Settlement Single 1")
    event_2 = await create_event_as_organizer(client, token, title="Settlement Single 2")

    buyer_email = "settlement_one_buyer@test.com"
    await get_auth_token(client, email=buyer_email)
    buyer_id = await _get_user_id(buyer_email)

    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=1,
        total_amount=80.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_1["id"]),
        status=OrderStatus.REFUNDED,
        quantity=1,
        total_amount=10.0,
    )
    await _insert_order(
        user_id=buyer_id,
        event_id=uuid.UUID(event_2["id"]),
        status=OrderStatus.CONFIRMED,
        quantity=1,
        total_amount=200.0,
    )

    resp = await client.get(
        f"/api/v1/organizer/settlement?event_id={event_1['id']}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["gross_revenue"] == 80.0
    assert data["platform_fee"] == 4.0
    # net = gross - platform_fee(5%) - pg_fee(2.5%) - refunds (settlement_generate.py 기준)
    # pg_fee = 80 * 0.025 = 2.0 → net = 80 - 4.0 - 2.0 = 74.0
    assert data["net_settlement"] == 74.0
    assert data["pending_refunds"] == 10.0
    assert data["final_payout"] == 64.0


@pytest.mark.asyncio
async def test_non_organizer_access(client):
    token = await get_auth_token(client, email="normal_user_dash@test.com")
    resp = await client.get("/api/v1/organizer/dashboard", headers=auth_headers(token))
    assert resp.status_code == 403
