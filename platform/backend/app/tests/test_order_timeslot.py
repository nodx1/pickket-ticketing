from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.models.event import Event, EventStatus, SeatTier
from app.models.user import User
from app.schemas.order import OrderCreate
from app.services.order_service import OrderService

from .conftest import auth_headers, create_event_as_organizer, get_auth_token
from .test_purchase import _create_tier

KST = ZoneInfo("Asia/Seoul")


def _slot_pair(event_date: datetime) -> tuple[str, str]:
    slot_start = event_date.astimezone(KST).replace(hour=9, minute=0, second=0, microsecond=0)
    slot_end = slot_start + timedelta(hours=1)
    return slot_start.isoformat(), slot_end.isoformat()


@pytest.mark.asyncio
async def test_purchase_persists_time_slot_on_order(client):
    org_token = await get_auth_token(
        client, "timeslot-org-1@test.com", "Password1!", "Timeslot Org 1", is_organizer=True
    )
    event_date = datetime.now(KST).replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=14)
    event = await create_event_as_organizer(
        client,
        org_token,
        category="exhibition",
        event_date=event_date.isoformat(),
        event_date_end=(event_date + timedelta(hours=8)).isoformat(),
        time_slot_enabled=True,
        time_slot_capacity=2,
        time_slot_duration_minutes=60,
    )
    tier = await _create_tier(client, event["id"], org_token, capacity=10, face_price=20.0)
    slot_start, slot_end = _slot_pair(event_date)

    buyer_token = await get_auth_token(
        client, "timeslot-buyer-1@test.com", "Password1!", "Timeslot Buyer 1"
    )
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={
            "quantity": 1,
            "time_slot_start": slot_start,
            "time_slot_end": slot_end,
        },
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code == 201, purchase_resp.text
    order_id = purchase_resp.json()["order_id"]

    orders_resp = await client.get("/api/v1/orders/my", headers=auth_headers(buyer_token))
    assert orders_resp.status_code == 200
    order = next(item for item in orders_resp.json() if item["id"] == order_id)
    stored_start = datetime.fromisoformat(order["time_slot_start"])
    expected_start = datetime.fromisoformat(slot_start)
    if stored_start.tzinfo is None:
        expected_start = expected_start.replace(tzinfo=None)
    assert stored_start == expected_start

    stored_end = datetime.fromisoformat(order["time_slot_end"])
    expected_end = datetime.fromisoformat(slot_end)
    if stored_end.tzinfo is None:
        expected_end = expected_end.replace(tzinfo=None)
    assert stored_end == expected_end


@pytest.mark.asyncio
async def test_order_service_rejects_when_time_slot_capacity_is_exhausted(db_session):
    event_date = datetime.now(KST).replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=15)
    organizer = User(
        email="timeslot-service-org@test.com",
        hashed_password="x",
        name="Timeslot Service Org",
        is_organizer=True,
    )
    buyer = User(
        email="timeslot-service-buyer@test.com",
        hashed_password="x",
        name="Timeslot Service Buyer",
    )
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Time Slot Service Event",
        slug="test-order-timeslot",
        venue="Test Venue",
        event_date=event_date,
        event_date_end=event_date + timedelta(hours=8),
        bidding_opens_at=event_date - timedelta(days=1),
        bidding_closes_at=event_date + timedelta(days=1),
        total_seats=10,
        min_price=25.0,
        max_price=25.0,
        category="exhibition",
        status=EventStatus.BIDDING_OPEN,
        time_slot_enabled=True,
        time_slot_capacity=2,
        time_slot_duration_minutes=60,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="General",
        capacity=10,
        base_price=25.0,
        face_price=25.0,
        sale_mode="fixed_fcfs",
        sold_count=0,
    )
    db_session.add(tier)
    await db_session.flush()

    slot_start_raw, slot_end_raw = _slot_pair(event_date)
    slot_start = datetime.fromisoformat(slot_start_raw)
    slot_end = datetime.fromisoformat(slot_end_raw)

    service = OrderService(db_session)
    await service.create_order(
        user_id=buyer.id,
        event_id=event.id,
        order_data=OrderCreate(
            tier_id=tier.id,
            quantity=2,
            time_slot_start=slot_start,
            time_slot_end=slot_end,
        ),
        unit_price=25.0,
        total_amount=50.0,
    )

    with pytest.raises(ValueError, match="잔여석 부족"):
        await service.create_order(
            user_id=buyer.id,
            event_id=event.id,
            order_data=OrderCreate(
                tier_id=tier.id,
                quantity=1,
                time_slot_start=slot_start,
                time_slot_end=slot_end,
            ),
            unit_price=25.0,
            total_amount=25.0,
        )


@pytest.mark.asyncio
async def test_event_availability_reflects_booked_time_slot_capacity(client):
    org_token = await get_auth_token(
        client, "timeslot-org-3@test.com", "Password1!", "Timeslot Org 3", is_organizer=True
    )
    event_date = datetime.now(KST).replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=16)
    event = await create_event_as_organizer(
        client,
        org_token,
        category="exhibition",
        event_date=event_date.isoformat(),
        event_date_end=(event_date + timedelta(hours=3)).isoformat(),
        time_slot_enabled=True,
        time_slot_capacity=2,
        time_slot_duration_minutes=60,
    )
    tier = await _create_tier(client, event["id"], org_token, capacity=10, face_price=30.0)
    slot_start, slot_end = _slot_pair(event_date)

    buyer_token = await get_auth_token(
        client, "timeslot-buyer-3@test.com", "Password1!", "Timeslot Buyer 3"
    )
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={
            "quantity": 1,
            "time_slot_start": slot_start,
            "time_slot_end": slot_end,
        },
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code == 201, purchase_resp.text

    availability_resp = await client.get(
        f"/api/v1/events/{event['id']}/availability",
        params={"date": event_date.date().isoformat(), "tier_id": tier["id"]},
    )
    assert availability_resp.status_code == 200, availability_resp.text
    payload = availability_resp.json()
    booked_slot = next(slot for slot in payload["slots"] if slot["start"] == slot_start)
    assert booked_slot["total"] == 2
    assert booked_slot["available"] == 1
