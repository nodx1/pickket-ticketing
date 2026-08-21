import uuid

import pytest
from sqlalchemy import select

from app.models.allocation import Allocation, AllocationResult
from app.models.anomaly import AnomalyLogModel
from app.models.bid import Bid
from app.models.event import Event, EventStatus
from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
    register_user,
    set_verification_level,
)


def _email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def _create_event_with_bids(
    client,
    *,
    total_seats: int,
    bid_amounts: list[float],
) -> tuple[str, dict, list[dict]]:
    organizer_token = await get_auth_token(
        client, email=_email("alloc_pipe_org"), is_organizer=True
    )
    event = await create_event_as_organizer(
        client,
        organizer_token,
        total_seats=total_seats,
        min_price=10.0,
        max_price=1000.0,
    )

    bidders: list[dict] = []
    for i, amount in enumerate(bid_amounts):
        bidder = await register_user(
            client,
            email=_email(f"alloc_pipe_bidder{i}"),
            password="StrongPass1!",
            name=f"Bidder {i}",
        )
        await set_verification_level(bidder["user"]["id"], level=1)
        response = await client.post(
            f"/api/v1/events/{event['id']}/bids",
            json={"max_willingness_to_pay": amount, "quantity": 1},
            headers=auth_headers(bidder["access_token"]),
        )
        assert response.status_code == 201
        bidders.append(
            {
                "user_id": bidder["user"]["id"],
                "token": bidder["access_token"],
                "bid_amount": amount,
            }
        )

    return organizer_token, event, bidders


@pytest.mark.asyncio
async def test_allocate_basic(client):
    organizer_token, event, _ = await _create_event_with_bids(
        client,
        total_seats=2,
        bid_amounts=[100.0, 130.0, 170.0],
    )

    allocate_response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert allocate_response.status_code == 201

    results_response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert results_response.status_code == 200
    data = results_response.json()
    assert data["total_bids"] == 3
    assert data["total_allocated"] == 2


@pytest.mark.asyncio
async def test_allocate_vcg_prices(client):
    organizer_token, event, _ = await _create_event_with_bids(
        client,
        total_seats=2,
        bid_amounts=[90.0, 120.0, 160.0, 220.0],
    )

    allocate_response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert allocate_response.status_code == 201

    async with TestSession() as session:
        allocation = (
            await session.execute(
                select(Allocation).where(Allocation.event_id == uuid.UUID(event["id"]))
            )
        ).scalar_one()
        winner_rows = (
            await session.execute(
                select(AllocationResult, Bid)
                .join(Bid, Bid.id == AllocationResult.bid_id)
                .where(AllocationResult.allocation_id == allocation.id)
            )
        ).all()

    assert winner_rows
    for alloc_result, bid in winner_rows:
        assert alloc_result.final_price >= 0
        assert alloc_result.vcg_price >= 0
        assert alloc_result.final_price <= bid.max_willingness_to_pay


@pytest.mark.asyncio
async def test_allocate_supply_exceeds_demand(client):
    organizer_token, event, _ = await _create_event_with_bids(
        client,
        total_seats=10,
        bid_amounts=[100.0, 150.0, 200.0],
    )

    allocate_response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert allocate_response.status_code == 201

    results_response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert results_response.status_code == 200
    data = results_response.json()
    assert data["total_bids"] == 3
    assert data["total_allocated"] == 3


@pytest.mark.asyncio
async def test_allocate_idempotent(client):
    organizer_token, event, _ = await _create_event_with_bids(
        client,
        total_seats=2,
        bid_amounts=[110.0, 140.0, 170.0],
    )

    first = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert first.status_code == 201

    second = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert second.status_code == 400


@pytest.mark.asyncio
async def test_allocate_with_anomaly(client):
    organizer_token = await get_auth_token(
        client, email=_email("alloc_pipe_anom_org"), is_organizer=True
    )
    event = await create_event_as_organizer(
        client,
        organizer_token,
        total_seats=3,
        min_price=10.0,
        max_price=1000.0,
    )

    suspicious = await register_user(
        client,
        email=_email("alloc_pipe_anom_user"),
        password="StrongPass1!",
        name="Suspicious User",
    )
    await set_verification_level(suspicious["user"]["id"], level=1)

    async with TestSession() as session:
        session.add(
            AnomalyLogModel(
                user_id=uuid.UUID(suspicious["user"]["id"]),
                event_id=uuid.UUID(event["id"]),
                bid_id=None,
                score=0.9,
                is_blocked=True,
                reasons=["seeded history"],
            )
        )
        await session.commit()

    bid_response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 150.0, "quantity": 4},
        headers=auth_headers(suspicious["access_token"]),
    )
    assert bid_response.status_code == 201

    allocate_response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert allocate_response.status_code == 201

    results_response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert results_response.status_code == 200
    assert results_response.json()["anomalies_blocked"] >= 1


@pytest.mark.asyncio
async def test_allocate_empty_bids(client):
    organizer_token = await get_auth_token(
        client, email=_email("alloc_pipe_empty_org"), is_organizer=True
    )
    event = await create_event_as_organizer(client, organizer_token, total_seats=5)

    async with TestSession() as session:
        event_row = (
            await session.execute(select(Event).where(Event.id == uuid.UUID(event["id"])))
        ).scalar_one()
        event_row.status = EventStatus.BIDDING_OPEN
        await session.commit()

    response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    if isinstance(detail, str):
        assert "no active bids" in detail.lower()
