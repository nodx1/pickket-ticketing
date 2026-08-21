"""
Extended unit tests for PurchaseService.

Tests the service layer directly (not via HTTP) to cover internal branches
that integration tests miss: validation errors, edge cases, sold-out paths,
multi-session limits, group validation, hold pricing, and finalize_payment
error branches.
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.schemas.purchase import PurchaseResponse
from app.services.purchase_service import (
    PurchaseError,
    PurchaseService,
    _resolve_hold_pricing,
    finalize_payment,
    persist_order_from_hold,
)
from .conftest import TestSession


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tier(**overrides) -> MagicMock:
    """Build a mock SeatTier with sensible defaults."""
    tier = MagicMock(spec=SeatTier)
    tier.id = overrides.get("id", uuid.uuid4())
    tier.event_id = overrides.get("event_id", uuid.uuid4())
    tier.name = overrides.get("name", "GA")
    tier.capacity = overrides.get("capacity", 100)
    tier.sold_count = overrides.get("sold_count", 0)
    tier.base_price = overrides.get("base_price", 50.0)
    tier.face_price = overrides.get("face_price", 50.0)
    tier.sale_mode = overrides.get("sale_mode", "fixed_fcfs")
    tier.fanclub_discount_pct = overrides.get("fanclub_discount_pct", 0.0)
    tier.max_group_size = overrides.get("max_group_size", 4)
    tier.resale_allowed = overrides.get("resale_allowed", True)
    tier.resale_max_price = overrides.get("resale_max_price", 0.0)
    # 🔴 실 SeatTier 는 visibility(NOT NULL, default "public")·is_active(NOT NULL, default True)
    #    를 항상 갖는다. MagicMock 은 자동 속성이라 문자열이 아니어서, 이 둘을 안 세우면
    #    "숨김 티어 구매 차단" 가드가 정당한 티어까지 막는다(2026-08-02 실측 12건).
    #    픽스처가 현실을 반영해야 그 가드를 검증한 것이 된다.
    tier.visibility = overrides.get("visibility", "public")
    tier.is_active = overrides.get("is_active", True)
    return tier


def _make_event(**overrides) -> MagicMock:
    """Build a mock Event with sensible defaults."""
    now = datetime.now(timezone.utc)
    event = MagicMock(spec=Event)
    event.id = overrides.get("id", uuid.uuid4())
    event.status = overrides.get("status", EventStatus.BIDDING_OPEN)
    event.bidding_opens_at = overrides.get(
        "bidding_opens_at", now - timedelta(hours=1)
    )
    event.bidding_closes_at = overrides.get(
        "bidding_closes_at", now + timedelta(hours=24)
    )
    event.artist_id = overrides.get("artist_id", None)
    event.multi_max_wins_per_user = overrides.get("multi_max_wins_per_user", None)
    # Phase 0 채널 gate: 기본 marketplace 포함(모델 default와 동일). self 전용
    # 거부 케이스는 sale_channels=["self"] override로 테스트.
    event.sale_channels = overrides.get("sale_channels", ["self", "marketplace"])
    return event


def _build_service(session=None) -> PurchaseService:
    """Construct a PurchaseService with a mock session."""
    if session is None:
        session = AsyncMock()
    svc = PurchaseService(session)
    return svc


# ===========================================================================
# _resolve_hold_pricing (pure function)
# ===========================================================================


class TestResolveHoldPricing:
    def test_amount_matches_catalog(self):
        tier = _make_tier(face_price=50.0, base_price=50.0)
        unit, total, source = _resolve_hold_pricing(tier, 2, 100.0)
        assert unit == 50.0
        assert total == 100.0
        assert source == "event_amount"

    def test_amount_mismatch_uses_catalog(self):
        tier = _make_tier(face_price=50.0, base_price=50.0)
        unit, total, source = _resolve_hold_pricing(tier, 2, 999.0)
        assert unit == 50.0
        assert total == 100.0
        assert source == "catalog_fallback"

    def test_zero_amount_uses_catalog(self):
        tier = _make_tier(face_price=75.0)
        unit, total, source = _resolve_hold_pricing(tier, 1, 0)
        assert unit == 75.0
        assert total == 75.0
        assert source == "catalog_fallback"

    def test_negative_amount_uses_catalog(self):
        tier = _make_tier(face_price=30.0)
        unit, total, source = _resolve_hold_pricing(tier, 3, -10.0)
        assert unit == 30.0
        assert total == 90.0
        assert source == "catalog_fallback"

    def test_face_price_zero_falls_back_to_base_price(self):
        tier = _make_tier(face_price=0.0, base_price=25.0)
        # face_price is 0, so the or chain picks base_price
        unit, total, source = _resolve_hold_pricing(tier, 2, 0)
        assert unit == 25.0
        assert total == 50.0
        assert source == "catalog_fallback"


# ===========================================================================
# _validate_event_purchasable
# ===========================================================================


class TestValidateEventPurchasable:
    @pytest.mark.asyncio
    async def test_event_not_found(self):
        svc = _build_service()
        svc.event_repo.get = AsyncMock(return_value=None)
        with pytest.raises(PurchaseError, match="Event not found"):
            await svc._validate_event_purchasable(uuid.uuid4())

    @pytest.mark.asyncio
    async def test_event_cancelled(self):
        svc = _build_service()
        event = _make_event(status=EventStatus.CANCELLED)
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="cancelled"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_event_draft_not_purchasable(self):
        svc = _build_service()
        event = _make_event(status=EventStatus.DRAFT)
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="not available for purchase"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_self_only_event_rejected_on_v2(self):
        """Phase 0 채널 gate: self 전용 행사는 v2(marketplace) 구매 거부."""
        svc = _build_service()
        event = _make_event(
            status=EventStatus.BIDDING_OPEN, sale_channels=["self"]
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="마켓플레이스 판매 대상이 아닙니다"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_both_channel_event_allowed_on_v2(self):
        """both 행사(self+marketplace)는 v2 구매 통과."""
        svc = _build_service()
        event = _make_event(
            status=EventStatus.BIDDING_OPEN,
            sale_channels=["self", "marketplace"],
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        result = await svc._validate_event_purchasable(event.id)
        assert result is event

    @pytest.mark.asyncio
    async def test_sales_window_not_open(self):
        svc = _build_service()
        future = datetime.now(timezone.utc) + timedelta(hours=2)
        event = _make_event(
            status=EventStatus.BIDDING_OPEN,
            bidding_opens_at=future,
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="not yet open"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_sales_window_closed(self):
        svc = _build_service()
        past = datetime.now(timezone.utc) - timedelta(hours=2)
        event = _make_event(
            status=EventStatus.BIDDING_OPEN,
            bidding_opens_at=past - timedelta(hours=24),
            bidding_closes_at=past,
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="closed"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_approved_event_auto_transitions(self):
        svc = _build_service()
        event = _make_event(
            status=EventStatus.APPROVED,
            bidding_opens_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        svc.session.execute = AsyncMock()

        result = await svc._validate_event_purchasable(event.id)
        assert result.status == EventStatus.BIDDING_OPEN

    @pytest.mark.asyncio
    async def test_approved_event_before_window_raises(self):
        svc = _build_service()
        event = _make_event(
            status=EventStatus.APPROVED,
            bidding_opens_at=datetime.now(timezone.utc) + timedelta(hours=5),
        )
        svc.event_repo.get = AsyncMock(return_value=event)
        with pytest.raises(PurchaseError, match="not yet open"):
            await svc._validate_event_purchasable(event.id)

    @pytest.mark.asyncio
    async def test_naive_datetime_treated_as_utc(self):
        """Naive datetimes on opens_at / closes_at should be treated as UTC."""
        svc = _build_service()
        # Naive datetimes (no tzinfo)
        event = _make_event(
            status=EventStatus.BIDDING_OPEN,
            bidding_opens_at=datetime.utcnow() - timedelta(hours=1),
            bidding_closes_at=datetime.utcnow() + timedelta(hours=24),
        )
        # Remove tzinfo to simulate naive datetime
        event.bidding_opens_at = event.bidding_opens_at.replace(tzinfo=None)
        event.bidding_closes_at = event.bidding_closes_at.replace(tzinfo=None)
        svc.event_repo.get = AsyncMock(return_value=event)

        result = await svc._validate_event_purchasable(event.id)
        assert result is event


# ===========================================================================
# purchase_fcfs
# ===========================================================================


class TestPurchaseFCFS:
    @pytest.mark.asyncio
    async def test_event_not_purchasable_returns_failure(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(
            side_effect=PurchaseError("Event has been cancelled")
        )
        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert "cancelled" in resp.message

    @pytest.mark.asyncio
    async def test_multi_session_limit_blocks(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event())
        svc._check_multi_session_limit = AsyncMock(
            return_value=(False, "Multi-session limit reached")
        )
        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert "Multi-session" in resp.message

    @pytest.mark.asyncio
    async def test_tier_not_found_returns_failure(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event())
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=None)

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert "Tier not found" in resp.message

    @pytest.mark.asyncio
    async def test_tier_event_mismatch_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        tier = _make_tier(event_id=uuid.uuid4())  # different event
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
        )
        assert resp.success is False
        assert "does not belong" in resp.message

    @pytest.mark.asyncio
    async def test_exceeds_max_group_size_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        tier = _make_tier(event_id=event_id, max_group_size=2)
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=3,
        )
        assert resp.success is False
        assert "maximum group size" in resp.message.lower() or "Exceeds" in resp.message

    @pytest.mark.asyncio
    async def test_per_user_limit_exceeded_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(
            return_value=(False, "Per-user limit exceeded: you already have 4 ticket(s) for this tier (max 4)")
        )

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
        )
        assert resp.success is False
        assert "Per-user limit" in resp.message

    @pytest.mark.asyncio
    async def test_sold_out_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id, capacity=10, sold_count=9)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=2,
        )
        assert resp.success is False
        assert "Not enough seats" in resp.message

    @pytest.mark.asyncio
    async def test_seat_count_mismatch_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=2,
            seat_ids=[uuid.uuid4()],  # 1 seat for 2 quantity
        )
        assert resp.success is False
        assert "일치하지 않습니다" in resp.message

    @pytest.mark.asyncio
    async def test_seat_wrong_tier_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        # Seat belongs to a different tier
        wrong_seat = MagicMock()
        wrong_seat.tier_id = uuid.uuid4()
        svc.seat_repo.get = AsyncMock(return_value=wrong_seat)

        seat_id = uuid.uuid4()
        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
            seat_ids=[seat_id],
        )
        assert resp.success is False
        assert "등급에 속하지 않습니다" in resp.message

    @pytest.mark.asyncio
    async def test_seat_hold_expired_returns_failure(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        # Seat belongs to correct tier but hold verification fails
        valid_seat = MagicMock()
        valid_seat.tier_id = tier.id
        svc.seat_repo.get = AsyncMock(return_value=valid_seat)
        svc.seat_repo.verify_and_mark_sold = AsyncMock(return_value=False)

        seat_id = uuid.uuid4()
        resp = await svc.purchase_fcfs(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
            seat_ids=[seat_id],
        )
        assert resp.success is False
        assert "expired" in resp.message.lower() or "invalid" in resp.message.lower()

    @pytest.mark.asyncio
    async def test_increment_sold_overflow_returns_failure(self):
        """capacity == sold_count 일 때 구매 실패해야 한다."""
        svc = _build_service()
        event_id = uuid.uuid4()
        # sold_count == capacity → remaining == 0
        tier = _make_tier(event_id=event_id, capacity=100, sold_count=100)
        user_id = uuid.uuid4()

        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        resp = await svc.purchase_fcfs(
            user_id=user_id,
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
        )
        assert resp.success is False
        assert "seats" in resp.message.lower() or "remaining" in resp.message.lower()

    @pytest.mark.asyncio
    async def test_successful_fcfs_purchase(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier_id = uuid.uuid4()
        tier = _make_tier(id=tier_id, event_id=event_id, face_price=50.0)
        user_id = uuid.uuid4()

        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        mock_order = MagicMock()
        mock_order.id = uuid.uuid4()
        svc.order_service.create_order = AsyncMock(return_value=mock_order)

        ticket_1 = MagicMock()
        ticket_1.id = uuid.uuid4()
        ticket_2 = MagicMock()
        ticket_2.id = uuid.uuid4()
        svc.ticket_repo.create_batch = AsyncMock(return_value=[ticket_1, ticket_2])
        svc.tier_repo.increment_sold = AsyncMock(return_value=True)

        with patch("app.services.purchase_service.write_audit_log", new_callable=AsyncMock):
            resp = await svc.purchase_fcfs(
                user_id=user_id,
                event_id=event_id,
                tier_id=tier_id,
                quantity=2,
            )

        assert resp.success is True
        assert resp.sale_mode == "fixed_fcfs"
        assert resp.unit_price == 50.0
        assert resp.total_price == 100.0
        assert len(resp.ticket_ids) == 2
        assert resp.order_id == mock_order.id


# ===========================================================================
# purchase_fanclub
# ===========================================================================


class TestPurchaseFanclub:
    @pytest.fixture(autouse=True)
    def _allow_membership(self, monkeypatch):
        """단계4a fanclub 자격 게이트 우회 — 이 클래스는 할인/tier/재고 로직 검증용.
        무자격 차단 자체는 test_fanclub_requires_membership 에서 별도 검증."""
        async def _yes(_self, _user_id, _event_id):
            return True

        monkeypatch.setattr(
            "app.services.fanclub_service.FanclubService.is_member_for_event", _yes
        )

    @pytest.mark.asyncio
    async def test_event_not_purchasable_returns_failure(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(
            side_effect=PurchaseError("Sales window has closed")
        )
        resp = await svc.purchase_fanclub(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert resp.sale_mode == "fanclub_presale"
        assert "closed" in resp.message

    @pytest.mark.asyncio
    async def test_fanclub_discount_applied(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier_id = uuid.uuid4()
        tier = _make_tier(
            id=tier_id,
            event_id=event_id,
            face_price=100.0,
            fanclub_discount_pct=15.0,
        )
        user_id = uuid.uuid4()

        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        mock_order = MagicMock()
        mock_order.id = uuid.uuid4()
        svc.order_service.create_order = AsyncMock(return_value=mock_order)

        mock_ticket = MagicMock()
        mock_ticket.id = uuid.uuid4()
        svc.ticket_repo.create_batch = AsyncMock(return_value=[mock_ticket])
        svc.tier_repo.increment_sold = AsyncMock(return_value=True)

        with patch("app.services.purchase_service.write_audit_log", new_callable=AsyncMock):
            resp = await svc.purchase_fanclub(
                user_id=user_id,
                event_id=event_id,
                tier_id=tier_id,
                quantity=1,
            )

        assert resp.success is True
        assert resp.sale_mode == "fanclub_presale"
        assert resp.unit_price == 85.0  # 100 * (1 - 15/100)
        assert resp.total_price == 85.0

    @pytest.mark.asyncio
    async def test_fanclub_no_discount(self):
        """When fanclub_discount_pct is 0, price equals face_price."""
        svc = _build_service()
        event_id = uuid.uuid4()
        tier_id = uuid.uuid4()
        tier = _make_tier(
            id=tier_id,
            event_id=event_id,
            face_price=60.0,
            fanclub_discount_pct=0.0,
        )

        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        mock_order = MagicMock()
        mock_order.id = uuid.uuid4()
        svc.order_service.create_order = AsyncMock(return_value=mock_order)

        mock_ticket = MagicMock()
        mock_ticket.id = uuid.uuid4()
        svc.ticket_repo.create_batch = AsyncMock(return_value=[mock_ticket])
        svc.tier_repo.increment_sold = AsyncMock(return_value=True)

        with patch("app.services.purchase_service.write_audit_log", new_callable=AsyncMock):
            resp = await svc.purchase_fanclub(
                user_id=uuid.uuid4(),
                event_id=event_id,
                tier_id=tier_id,
                quantity=1,
            )

        assert resp.success is True
        assert resp.unit_price == 60.0

    @pytest.mark.asyncio
    async def test_fanclub_tier_not_found(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event())
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=None)

        resp = await svc.purchase_fanclub(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert resp.sale_mode == "fanclub_presale"
        assert "Tier not found" in resp.message

    @pytest.mark.asyncio
    async def test_fanclub_sold_out(self):
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(event_id=event_id, capacity=5, sold_count=5)
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        resp = await svc.purchase_fanclub(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
        )
        assert resp.success is False
        assert "Not enough seats" in resp.message

    @pytest.mark.asyncio
    async def test_fanclub_multi_session_limit_blocks(self):
        svc = _build_service()
        svc._validate_event_purchasable = AsyncMock(return_value=_make_event())
        svc._check_multi_session_limit = AsyncMock(
            return_value=(False, "Already won maximum sessions")
        )

        resp = await svc.purchase_fanclub(
            user_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            tier_id=uuid.uuid4(),
            quantity=1,
        )
        assert resp.success is False
        assert "Already won" in resp.message

    @pytest.mark.asyncio
    async def test_fanclub_increment_sold_overflow(self):
        """capacity == sold_count 일 때 팬클럽 구매 실패해야 한다."""
        svc = _build_service()
        event_id = uuid.uuid4()
        tier = _make_tier(
            event_id=event_id, face_price=80.0, fanclub_discount_pct=10.0,
            capacity=100, sold_count=100,
        )

        svc._validate_event_purchasable = AsyncMock(return_value=_make_event(id=event_id))
        svc._check_multi_session_limit = AsyncMock(return_value=(True, ""))
        svc.tier_repo.get_for_update = AsyncMock(return_value=tier)
        svc._check_per_user_quantity = AsyncMock(return_value=(True, ""))

        resp = await svc.purchase_fanclub(
            user_id=uuid.uuid4(),
            event_id=event_id,
            tier_id=tier.id,
            quantity=1,
        )
        assert resp.success is False
        assert "seats" in resp.message.lower() or "remaining" in resp.message.lower()


# ===========================================================================
# _validate_group_request (static method)
# ===========================================================================


class TestValidateGroupRequest:
    def test_no_group_id_passes(self):
        tier = _make_tier()
        ok, reason = PurchaseService._validate_group_request(
            group_id=None,
            leader_user_id=uuid.uuid4(),
            member_user_ids=None,
            tier=tier,
        )
        assert ok is True

    def test_no_members_passes(self):
        tier = _make_tier()
        ok, reason = PurchaseService._validate_group_request(
            group_id=uuid.uuid4(),
            leader_user_id=uuid.uuid4(),
            member_user_ids=None,
            tier=tier,
        )
        assert ok is True

    def test_empty_members_passes(self):
        tier = _make_tier()
        ok, reason = PurchaseService._validate_group_request(
            group_id=uuid.uuid4(),
            leader_user_id=uuid.uuid4(),
            member_user_ids=[],
            tier=tier,
        )
        assert ok is True

    def test_valid_group_passes(self):
        leader = uuid.uuid4()
        tier = _make_tier(max_group_size=4)
        ok, reason = PurchaseService._validate_group_request(
            group_id=uuid.uuid4(),
            leader_user_id=leader,
            member_user_ids=[leader, uuid.uuid4()],
            tier=tier,
        )
        assert ok is True


# ===========================================================================
# validate_no_cross_group_purchases (static method)
# ===========================================================================


class TestValidateNoCrossGroup:
    def test_no_overlap_passes(self):
        user_a = uuid.uuid4()
        user_b = uuid.uuid4()
        user_c = uuid.uuid4()
        groups = [
            {
                "group_id": uuid.uuid4(),
                "leader_user_id": user_a,
                "member_user_ids": [user_a, user_b],
            },
            {
                "group_id": uuid.uuid4(),
                "leader_user_id": user_c,
                "member_user_ids": [user_c],
            },
        ]
        ok, reason = PurchaseService.validate_no_cross_group_purchases(groups)
        assert ok is True

    def test_overlap_detected(self):
        shared_user = uuid.uuid4()
        groups = [
            {
                "group_id": uuid.uuid4(),
                "leader_user_id": shared_user,
                "member_user_ids": [shared_user],
            },
            {
                "group_id": uuid.uuid4(),
                "leader_user_id": shared_user,
                "member_user_ids": [shared_user],
            },
        ]
        ok, reason = PurchaseService.validate_no_cross_group_purchases(groups)
        assert ok is False


# ===========================================================================
# finalize_payment — DB-level tests using the test session
# ===========================================================================


class TestFinalizePaymentEdgeCases:
    @pytest.mark.asyncio
    async def test_finalize_missing_order(self, db_session, monkeypatch):
        """finalize_payment with a non-existent order should silently return."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)
        fake_order_id = str(uuid.uuid4())
        # Should not raise
        await finalize_payment(fake_order_id, 50.0, "KRW")

    @pytest.mark.asyncio
    async def test_finalize_amount_mismatch_rejects(self, db_session, monkeypatch):
        """Amount mismatch should NOT mark order as PAID."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)
        now = datetime.now(timezone.utc)

        organizer = User(email="amm-org@test.com", hashed_password="x", name="Org", is_organizer=True)
        buyer = User(email="amm-buyer@test.com", hashed_password="x", name="Buyer")
        db_session.add_all([organizer, buyer])
        await db_session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Mismatch Event",
            slug="test-amount-mismatch",
            venue="Arena",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        db_session.add(event)
        await db_session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="R",
            capacity=100,
            base_price=50.0,
            face_price=50.0,
            sale_mode="fixed_fcfs",
        )
        db_session.add(tier)
        await db_session.flush()

        order = Order(
            id=uuid.uuid4(),
            user_id=buyer.id,
            event_id=event.id,
            tier_id=tier.id,
            order_type=OrderType.PURCHASE,
            status=OrderStatus.PAYMENT_REQUIRED,
            quantity=1,
            unit_price=50.0,
            total_amount=50.0,
            payment_deadline=now + timedelta(minutes=15),
        )
        db_session.add(order)
        await db_session.commit()

        # Try to finalize with wrong amount
        await finalize_payment(str(order.id), 999.0, "KRW")

        async with TestSession() as verify:
            refreshed = await verify.scalar(select(Order).where(Order.id == order.id))
            assert refreshed is not None
            # Order should NOT be PAID
            assert refreshed.status == OrderStatus.PAYMENT_REQUIRED

    @pytest.mark.asyncio
    async def test_finalize_already_paid_is_noop(self, db_session, monkeypatch):
        """Finalizing an already-PAID order should not error."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)
        now = datetime.now(timezone.utc)

        organizer = User(email="dup-org@test.com", hashed_password="x", name="Org", is_organizer=True)
        buyer = User(email="dup-buyer@test.com", hashed_password="x", name="Buyer")
        db_session.add_all([organizer, buyer])
        await db_session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Dup Event",
            slug="test-dup-finalize",
            venue="Arena",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        db_session.add(event)
        await db_session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="S",
            capacity=100,
            base_price=40.0,
            face_price=40.0,
            sale_mode="fixed_fcfs",
        )
        db_session.add(tier)
        await db_session.flush()

        order = Order(
            id=uuid.uuid4(),
            user_id=buyer.id,
            event_id=event.id,
            tier_id=tier.id,
            order_type=OrderType.PURCHASE,
            status=OrderStatus.PAID,  # Already paid
            quantity=1,
            unit_price=40.0,
            total_amount=40.0,
            payment_deadline=now + timedelta(minutes=15),
        )
        db_session.add(order)
        await db_session.commit()

        # Should not raise; already paid so rowcount=0 → early return
        await finalize_payment(str(order.id), 40.0, "KRW")

        async with TestSession() as verify:
            refreshed = await verify.scalar(select(Order).where(Order.id == order.id))
            assert refreshed.status == OrderStatus.PAID


# ===========================================================================
# persist_order_from_hold — edge cases
# ===========================================================================


class TestPersistOrderFromHoldEdgeCases:
    @pytest.mark.asyncio
    async def test_idempotent_skip(self, db_session, monkeypatch):
        """Calling persist_order_from_hold twice with same order_id is idempotent."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)
        now = datetime.now(timezone.utc)

        organizer = User(email="idem-org@test.com", hashed_password="x", name="Org", is_organizer=True)
        buyer = User(email="idem-buyer@test.com", hashed_password="x", name="Buyer")
        db_session.add_all([organizer, buyer])
        await db_session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Idem Event",
            slug="test-idempotent-hold",
            venue="Arena",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        db_session.add(event)
        await db_session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="GA",
            capacity=100,
            base_price=50.0,
            face_price=50.0,
            sale_mode="fixed_fcfs",
            sold_count=0,
        )
        db_session.add(tier)
        await db_session.commit()

        order_id = str(uuid.uuid4())

        # First call
        await persist_order_from_hold(
            order_id=order_id,
            event_id=str(event.id),
            user_id=str(buyer.id),
            tier_id=str(tier.id),
            quantity=1,
            amount=50.0,
        )

        # Second call — should not raise
        await persist_order_from_hold(
            order_id=order_id,
            event_id=str(event.id),
            user_id=str(buyer.id),
            tier_id=str(tier.id),
            quantity=1,
            amount=50.0,
        )

        # Verify only one order exists
        async with TestSession() as verify:
            result = await verify.execute(
                select(Order).where(Order.id == uuid.UUID(order_id))
            )
            orders = list(result.scalars().all())
            assert len(orders) == 1

    @pytest.mark.asyncio
    async def test_missing_tier_raises(self, db_session, monkeypatch):
        """persist_order_from_hold raises ValueError for missing tier."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)

        organizer = User(email="mt-org@test.com", hashed_password="x", name="Org", is_organizer=True)
        buyer = User(email="mt-buyer@test.com", hashed_password="x", name="Buyer")
        db_session.add_all([organizer, buyer])
        await db_session.commit()

        with pytest.raises(ValueError, match="SeatTier not found"):
            await persist_order_from_hold(
                order_id=str(uuid.uuid4()),
                event_id=str(uuid.uuid4()),
                user_id=str(buyer.id),
                tier_id=str(uuid.uuid4()),
                quantity=1,
            )

    @pytest.mark.asyncio
    async def test_seat_with_quantity_gt1_raises(self):
        """seat_id with quantity > 1 raises ValueError."""
        with pytest.raises(ValueError, match="quantity=1"):
            await persist_order_from_hold(
                order_id=str(uuid.uuid4()),
                event_id=str(uuid.uuid4()),
                user_id=str(uuid.uuid4()),
                tier_id=str(uuid.uuid4()),
                quantity=2,
                seat_id=str(uuid.uuid4()),
            )

    @pytest.mark.asyncio
    async def test_zero_quantity_becomes_one(self, db_session, monkeypatch):
        """quantity=0 should be clamped to 1."""
        monkeypatch.setattr("app.core.database.async_session", TestSession)
        now = datetime.now(timezone.utc)

        organizer = User(email="zq-org@test.com", hashed_password="x", name="Org", is_organizer=True)
        buyer = User(email="zq-buyer@test.com", hashed_password="x", name="Buyer")
        db_session.add_all([organizer, buyer])
        await db_session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="ZQ Event",
            slug="test-zero-qty",
            venue="Arena",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        db_session.add(event)
        await db_session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="GA",
            capacity=100,
            base_price=30.0,
            face_price=30.0,
            sale_mode="fixed_fcfs",
            sold_count=0,
        )
        db_session.add(tier)
        await db_session.commit()

        order_id = str(uuid.uuid4())
        await persist_order_from_hold(
            order_id=order_id,
            event_id=str(event.id),
            user_id=str(buyer.id),
            tier_id=str(tier.id),
            quantity=0,  # should be clamped to 1
            amount=0,
        )

        async with TestSession() as verify:
            order = await verify.scalar(select(Order).where(Order.id == uuid.UUID(order_id)))
            assert order is not None
            assert order.quantity == 1
