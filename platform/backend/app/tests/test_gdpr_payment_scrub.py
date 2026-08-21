"""H-22: GDPR account deletion — payment_metadata PII scrub tests.

Covers the gdpr_service.execute_account_deletion() flow added in the
2026-04-21 production-audit remediation (Phase 5.3): JSON fields in
Order.payment_metadata that identify buyer/card should be redacted while
the row itself is preserved for accounting retention.

Pure unit tests — seed DB directly via db_session, no HTTP.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.services.gdpr_service import GDPRService


async def _seed_user(db_session) -> User:
    user = User(
        email=f"gdpr_scrub_{uuid.uuid4().hex[:8]}@test.com",
        name="홍길동",
        hashed_password="dummy",
        is_active=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


async def _seed_event_with_tier(db_session, organizer: User) -> tuple[Event, SeatTier]:
    now = datetime.now(timezone.utc)
    event = Event(
        title="GDPR Test Event",
        slug=f"gdpr-test-event-{uuid.uuid4().hex[:8]}",
        organizer_id=organizer.id,
        status=EventStatus.APPROVED,
        venue="Test Venue",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=200.0,
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)

    tier = SeatTier(
        event_id=event.id,
        name="Standard",
        capacity=100,
        base_price=10000,
        sale_mode="fixed_fcfs",
        face_price=10000,
    )
    db_session.add(tier)
    await db_session.commit()
    await db_session.refresh(tier)
    return event, tier


async def _seed_order(
    db_session,
    *,
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    payment_metadata: dict | None,
) -> Order:
    order = Order(
        user_id=user_id,
        event_id=event_id,
        tier_id=tier_id,
        order_type=OrderType.PURCHASE,
        status=OrderStatus.CONFIRMED,
        quantity=1,
        unit_price=10000,
        total_amount=10000,
        payment_metadata=payment_metadata,
    )
    db_session.add(order)
    await db_session.commit()
    await db_session.refresh(order)
    return order


_PII_META_BLOB = {
    "buyer_name": "홍길동",
    "buyer_email": "gdpr_scrub@test.com",
    "buyer_phone": "010-1234-5678",
    "billing_name": "홍길동",
    "billing_email": "gdpr_scrub@test.com",
    "billing_phone": "010-1234-5678",
    "card_number": "4111-1111-1111-1111",
    "card_holder": "HONG GILDONG",
    "card": "ending in 1111",
    # Non-PII (must survive)
    "pg_provider": "portone",
    "pg_transaction_id": "tx_abc123",
    "amount_paid": 10000,
    "currency": "KRW",
    "paid_at": "2026-04-22T00:00:00+00:00",
}


@pytest.mark.asyncio
async def test_scrubs_payment_metadata_pii_keys(db_session):
    """PII keys in payment_metadata must become '[redacted]' after deletion."""
    user = await _seed_user(db_session)
    organizer = await _seed_user(db_session)
    event, tier = await _seed_event_with_tier(db_session, organizer)
    order = await _seed_order(
        db_session,
        user_id=user.id,
        event_id=event.id,
        tier_id=tier.id,
        payment_metadata=dict(_PII_META_BLOB),
    )
    order.buyer_name = "홍길동"
    order.buyer_email = "gdpr_scrub@test.com"
    order.buyer_phone = "010-1234-5678"
    # 실제 값은 keyed HMAC이지만 삭제 계약은 값의 형식과 무관하게 NULL이어야 한다.
    order.buyer_phone_lookup_hash = "a" * 64
    await db_session.commit()

    service = GDPRService(db_session)
    await service.execute_account_deletion(user.id)

    refreshed = (await db_session.execute(
        select(Order).where(Order.id == order.id)
    )).scalar_one()

    meta = refreshed.payment_metadata
    assert meta is not None, "payment_metadata must not be wiped entirely"
    for k in (
        "buyer_name",
        "buyer_email",
        "buyer_phone",
        "billing_name",
        "billing_email",
        "billing_phone",
        "card_number",
        "card_holder",
        "card",
    ):
        assert meta[k] == "[redacted]", f"{k} should be redacted, got {meta[k]!r}"
    assert refreshed.buyer_name is None
    assert refreshed.buyer_email is None
    assert refreshed.buyer_phone is None
    assert refreshed.buyer_phone_lookup_hash is None


@pytest.mark.asyncio
async def test_preserves_non_pii_payment_metadata(db_session):
    """Accounting/forensic fields must survive anonymization untouched."""
    user = await _seed_user(db_session)
    organizer = await _seed_user(db_session)
    event, tier = await _seed_event_with_tier(db_session, organizer)
    order = await _seed_order(
        db_session,
        user_id=user.id,
        event_id=event.id,
        tier_id=tier.id,
        payment_metadata=dict(_PII_META_BLOB),
    )

    service = GDPRService(db_session)
    await service.execute_account_deletion(user.id)

    refreshed = (await db_session.execute(
        select(Order).where(Order.id == order.id)
    )).scalar_one()

    meta = refreshed.payment_metadata
    assert meta["pg_provider"] == "portone"
    assert meta["pg_transaction_id"] == "tx_abc123"
    assert meta["amount_paid"] == 10000
    assert meta["currency"] == "KRW"
    assert meta["paid_at"] == "2026-04-22T00:00:00+00:00"


@pytest.mark.asyncio
async def test_preserves_order_row(db_session):
    """Order row must remain (legal retention) — identifying fields wiped only."""
    user = await _seed_user(db_session)
    organizer = await _seed_user(db_session)
    event, tier = await _seed_event_with_tier(db_session, organizer)
    order = await _seed_order(
        db_session,
        user_id=user.id,
        event_id=event.id,
        tier_id=tier.id,
        payment_metadata=dict(_PII_META_BLOB),
    )

    service = GDPRService(db_session)
    await service.execute_account_deletion(user.id)

    refreshed = (await db_session.execute(
        select(Order).where(Order.id == order.id)
    )).scalar_one_or_none()

    assert refreshed is not None, "Order must not be hard-deleted"
    assert refreshed.total_amount == 10000
    assert refreshed.status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_handles_empty_metadata(db_session):
    """Orders with payment_metadata=None must not raise."""
    user = await _seed_user(db_session)
    organizer = await _seed_user(db_session)
    event, tier = await _seed_event_with_tier(db_session, organizer)
    order = await _seed_order(
        db_session,
        user_id=user.id,
        event_id=event.id,
        tier_id=tier.id,
        payment_metadata=None,
    )

    service = GDPRService(db_session)
    await service.execute_account_deletion(user.id)  # must not raise

    refreshed = (await db_session.execute(
        select(Order).where(Order.id == order.id)
    )).scalar_one()
    # None or {} is acceptable — the scrub loop is a no-op
    assert refreshed.payment_metadata in (None, {})
