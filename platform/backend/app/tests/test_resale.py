"""Tests for the resale marketplace."""

import uuid
from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy import select

from app.models.event import Event
from app.models.ticket import Ticket
from app.services.dynamic_qr_service import generate_qr, verify_qr

from .conftest import (
    TestSession,
    get_auth_token,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _enable_resale_on_event(
    event_id: str, markup_pct: float = 50.0, royalty_pct: float = 10.0
):
    """Enable resale settings directly in the DB for a given event."""
    now = datetime.now(timezone.utc)
    async with TestSession() as session:
        result = await session.execute(select(Event).where(Event.id == uuid.UUID(event_id)))
        event = result.scalar_one()
        event.resale_enabled = True
        event.resale_max_markup_pct = markup_pct
        event.resale_royalty_pct = royalty_pct
        event.resale_opens_at = now - timedelta(hours=1)
        event.resale_closes_at = now + timedelta(days=7)
        await session.commit()


async def _create_tier(client, event_id, token, **overrides):
    """Helper to create a tier on an event and return the tier data."""
    payload = {
        "name": overrides.get("name", "General Admission"),
        "capacity": overrides.get("capacity", 100),
        "base_price": overrides.get("base_price", 50.0),
        "sale_mode": overrides.get("sale_mode", "fixed_fcfs"),
        "face_price": overrides.get("face_price", 50.0),
        "fanclub_discount_pct": overrides.get("fanclub_discount_pct", 0.0),
    }
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Tier creation failed: {resp.text}"
    return resp.json()


async def _purchase_ticket(client, event_id, tier_id, token):
    """Purchase a single ticket, confirm payment, and return the ticket_id."""
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Purchase failed: {resp.text}"
    data = resp.json()
    assert data["success"] is True

    # Confirm payment to activate the ticket (required for resale)
    await confirm_purchase_payment(client, token, data["order_id"])

    return data["ticket_ids"][0]


async def _setup_resale_event(client):
    """Create an event with resale enabled, a tier, and return details."""
    org_token = await get_auth_token(
        client, "resale_org@test.com", "Password1!", "Resale Org", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token, face_price=100.0, base_price=100.0)
    tier_id = tier["id"]
    await _enable_resale_on_event(event_id, markup_pct=50.0, royalty_pct=10.0)
    return org_token, event_id, tier_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_listing_success(client):
    """Create a resale listing for an owned ticket (201)."""
    _, event_id, tier_id = await _setup_resale_event(client)

    seller_token = await get_auth_token(client, "seller1@test.com", "Password1!", "Seller One")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 120.0},
        headers=auth_headers(seller_token),
    )
    assert resp.status_code == 201, f"Listing creation failed: {resp.text}"
    data = resp.json()
    assert data["ticket_id"] == ticket_id
    assert data["asking_price"] == 120.0
    assert data["status"] == "active"
    # Surplus-based recapture on markup (premium = 120 - 100 = 20):
    #   platform_fee   = premium * 10% = 2.0
    #   artist_royalty  = premium * 50% = 10.0
    #   seller_receives = original + premium * 40% = 108.0
    assert data["platform_fee"] == 2.0
    assert data["artist_royalty"] == 10.0
    assert data["seller_receives"] == 108.0


@pytest.mark.asyncio
async def test_create_listing_not_owner(client):
    """Listing a ticket you don't own returns 403."""
    _, event_id, tier_id = await _setup_resale_event(client)

    seller_token = await get_auth_token(client, "seller2@test.com", "Password1!", "Seller Two")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    other_token = await get_auth_token(client, "other2@test.com", "Password1!", "Other User")
    resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 120.0},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_listing_price_over_cap(client):
    """Listing above the max markup cap returns 400."""
    _, event_id, tier_id = await _setup_resale_event(client)

    seller_token = await get_auth_token(client, "seller3@test.com", "Password1!", "Seller Three")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    # Max markup is 50%, so max price = 100 * 1.5 = 150.0
    resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 200.0},
        headers=auth_headers(seller_token),
    )
    assert resp.status_code == 400
    assert "exceeds maximum" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_listing_resale_disabled(client):
    """Listing on an event with resale disabled returns 400."""
    org_token = await get_auth_token(
        client, "resale_org4@test.com", "Password1!", "Resale Org 4", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token, face_price=100.0, base_price=100.0)
    tier_id = tier["id"]
    # Do NOT enable resale

    seller_token = await get_auth_token(client, "seller4@test.com", "Password1!", "Seller Four")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 110.0},
        headers=auth_headers(seller_token),
    )
    assert resp.status_code == 400
    assert "not enabled" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_cancel_listing(client):
    """Cancel an active listing (204) and verify it no longer appears in my listings."""
    _, event_id, tier_id = await _setup_resale_event(client)

    seller_token = await get_auth_token(client, "seller5@test.com", "Password1!", "Seller Five")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    # Create listing
    create_resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 130.0},
        headers=auth_headers(seller_token),
    )
    assert create_resp.status_code == 201
    listing_id = create_resp.json()["id"]

    # Cancel listing
    cancel_resp = await client.delete(
        f"/api/v1/resale/listings/{listing_id}",
        headers=auth_headers(seller_token),
    )
    assert cancel_resp.status_code == 204

    # Verify it's cancelled in my listings
    my_resp = await client.get(
        "/api/v1/resale/my/listings",
        headers=auth_headers(seller_token),
    )
    assert my_resp.status_code == 200
    listings = my_resp.json()
    cancelled = [listing for listing in listings if listing["id"] == listing_id]
    assert len(cancelled) == 1
    assert cancelled[0]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_create_buy_order(client):
    """Create a resale buy order (201)."""
    _, event_id, tier_id = await _setup_resale_event(client)

    buyer_token = await get_auth_token(client, "buyer6@test.com", "Password1!", "Buyer Six")
    resp = await client.post(
        "/api/v1/resale/buy-orders",
        json={"event_id": event_id, "tier_id": tier_id, "max_price": 120.0},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["event_id"] == event_id
    assert data["tier_id"] == tier_id
    assert data["max_price"] == 120.0
    assert data["status"] == "active"


@pytest.mark.asyncio
async def test_market_data(client):
    """Market data endpoint returns asks, bids, and price summaries."""
    _, event_id, tier_id = await _setup_resale_event(client)

    # Create a listing
    seller_token = await get_auth_token(client, "seller7@test.com", "Password1!", "Seller Seven")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)
    await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 130.0},
        headers=auth_headers(seller_token),
    )

    # Create a buy order
    buyer_token = await get_auth_token(client, "buyer7@test.com", "Password1!", "Buyer Seven")
    await client.post(
        "/api/v1/resale/buy-orders",
        json={"event_id": event_id, "tier_id": tier_id, "max_price": 110.0},
        headers=auth_headers(buyer_token),
    )

    # Get market data
    resp = await client.get(f"/api/v1/resale/market/{event_id}/{tier_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["asks"]) == 1
    assert len(data["bids"]) == 1
    assert data["lowest_ask"] == 130.0
    assert data["highest_bid"] == 110.0


@pytest.mark.asyncio
async def test_trade_execution(client):
    """Create listing + buy order where bid >= ask and verify matched state."""
    _, event_id, tier_id = await _setup_resale_event(client)

    # Seller purchases and lists a ticket
    seller_token = await get_auth_token(client, "seller8@test.com", "Password1!", "Seller Eight")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    listing_resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 120.0},
        headers=auth_headers(seller_token),
    )
    assert listing_resp.status_code == 201

    # Buyer places a buy order at or above asking price
    buyer_token = await get_auth_token(client, "buyer8@test.com", "Password1!", "Buyer Eight")
    buy_resp = await client.post(
        "/api/v1/resale/buy-orders",
        json={"event_id": event_id, "tier_id": tier_id, "max_price": 125.0},
        headers=auth_headers(buyer_token),
    )
    assert buy_resp.status_code == 201

    # Execute matching via the service (direct DB)
    async with TestSession() as session:
        from app.services.resale_service import ResaleService

        service = ResaleService(session)
        trades = await service.match_and_execute(
            event_id=uuid.UUID(event_id),
            tier_id=uuid.UUID(tier_id),
        )
        await session.commit()

    assert len(trades) == 1
    trade = trades[0]
    assert trade["ticket_id"] == ticket_id
    assert trade["price"] == 120.0

    # Ownership transfer happens only after payment confirmation.
    async with TestSession() as session:
        result = await session.execute(select(Ticket).where(Ticket.id == uuid.UUID(ticket_id)))
        ticket = result.scalar_one()
        assert ticket.transfer_count == 0
        assert str(ticket.current_owner_id) == trade["seller_id"]

    # Verify the listing is matched and awaiting payment completion.
    my_listings = await client.get(
        "/api/v1/resale/my/listings",
        headers=auth_headers(seller_token),
    )
    matched = [
        listing for listing in my_listings.json() if listing["id"] == listing_resp.json()["id"]
    ]
    assert len(matched) == 1
    assert matched[0]["status"] == "matched"


@pytest.mark.asyncio
async def test_cancel_matched_listing_rejected(client):
    """매칭(MATCHED)된 listing 의 취소 시도는 거부된다 (M-2, Major #6).

    cancel_listing 이 FOR UPDATE 로 행을 잠그고 status==ACTIVE 를 재확인하므로,
    매칭으로 MATCHED 가 된 listing 은 stale ACTIVE 검사로 CANCELLED 를 덮어쓰지
    못한다(lost-update 방지). 매칭 후엔 ACTIVE 가 아니므로 ValueError.
    """
    _, event_id, tier_id = await _setup_resale_event(client)

    seller_token = await get_auth_token(client, "seller-m@test.com", "Password1!", "Seller M")
    ticket_id = await _purchase_ticket(client, event_id, tier_id, seller_token)

    listing_resp = await client.post(
        "/api/v1/resale/listings",
        json={"ticket_id": ticket_id, "asking_price": 120.0},
        headers=auth_headers(seller_token),
    )
    assert listing_resp.status_code == 201
    listing_id = listing_resp.json()["id"]

    buyer_token = await get_auth_token(client, "buyer-m@test.com", "Password1!", "Buyer M")
    buy_resp = await client.post(
        "/api/v1/resale/buy-orders",
        json={"event_id": event_id, "tier_id": tier_id, "max_price": 125.0},
        headers=auth_headers(buyer_token),
    )
    assert buy_resp.status_code == 201

    # 매칭 실행 → listing MATCHED.
    async with TestSession() as session:
        from app.services.resale_service import ResaleService

        service = ResaleService(session)
        await service.match_and_execute(
            event_id=uuid.UUID(event_id), tier_id=uuid.UUID(tier_id)
        )
        await session.commit()

    # 판매자 정보(id) 확보 후 서비스 직접 호출로 취소 시도 → MATCHED 이므로 거부.
    async with TestSession() as session:
        from app.models.user import User
        from app.services.resale_service import ResaleService

        seller = (
            await session.execute(select(User).where(User.email == "seller-m@test.com"))
        ).scalar_one()
        service = ResaleService(session)
        with pytest.raises(ValueError):
            await service.cancel_listing(seller.id, uuid.UUID(listing_id))


@pytest.mark.asyncio
async def test_dynamic_qr_generate_and_verify():
    """QR code generation and immediate verification succeeds."""
    ticket_id = uuid.uuid4()
    secret = "test-secret-key-2026"

    qr_data = generate_qr(ticket_id, secret)
    # Verify immediately (should be within 3 seconds)
    result = verify_qr(qr_data, secret, max_age_seconds=5)
    assert result == ticket_id


@pytest.mark.asyncio
async def test_dynamic_qr_expired():
    """QR code verification fails after the max age window."""
    ticket_id = uuid.uuid4()
    secret = "test-secret-key-2026"

    qr_data = generate_qr(ticket_id, secret)
    # Verify with max_age=0 to simulate expiry
    result = verify_qr(qr_data, secret, max_age_seconds=0)
    assert result is None
